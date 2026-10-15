/**
 * #6696 C4: a managed sync whose checkpoint committed and whose manifest is exhausted still runs a tail (projection
 * statistics, link extraction) that admits nothing. The in-pass governor read that tail as `no_admission` and stopped a
 * finished run `blocked`, blaming the pooler. The pass now stamps drain step `finish` and emits `managed_sync.finish`
 * once the checkpoint commits; the tail runs under its own budget, and a pass stuck in admission still stops.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncResult } from '../src/commands/sync.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { stampDrainStep } from '../src/core/persistence/drain-step.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runDrain, type StallProbe } from '../src/core/persistence/sync-drain.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { withEnv } from './helpers/with-env.ts';

const empty: StallProbe = { blockedHead: async () => null, fingerprint: async () => null, head: async () => null };
const synced: SyncResult = { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 1, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [],
  managedCursor: { index: 1, total: 1 } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('in-pass governor: the tail after a committed checkpoint', () => {
  test('a tail longer than the no-progress window ends synced, not blocked/no_admission', async () => {
    const result = await runDrain({ governMs: 10, noProgressMs: 80, probe: empty, pass: async (signal, onProgress) => {
      onProgress({ phase: 'managed_sync.page_committed', bankedFiles: 1, total: 1 });
      stampDrainStep('finish', signal);
      onProgress({ phase: 'managed_sync.finish', bankedFiles: 1, total: 1 });
      await sleep(300);
      return synced;
    } });
    expect(result.drain).toMatchObject({ outcome: 'synced', passes: 1 });
  });

  test('a tail past its own budget stops no_progress at step finish, never no_admission', async () => {
    const result = await runDrain({ governMs: 10, noProgressMs: 40, finishMs: 120, probe: empty, pass: (signal, onProgress) => {
      stampDrainStep('finish', signal);
      onProgress({ phase: 'managed_sync.finish', bankedFiles: 1, total: 1 });
      return new Promise<SyncResult>(() => undefined);
    } });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'no_progress', in_pass: true, step: 'finish' } });
    expect(result.drain!.stall!.stalled_seconds).toBeGreaterThanOrEqual(0);
  });

  test('a pass stuck in admission still stops no_admission inside the no-progress window', async () => {
    const started = Date.now();
    const result = await runDrain({ governMs: 10, noProgressMs: 80, finishMs: 60_000, probe: empty, pass: signal => {
      stampDrainStep('admission', signal);
      return new Promise<SyncResult>(() => undefined);
    } });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'no_admission', step: 'admission' } });
  });
});

const home = mkdtempSync(join(tmpdir(), 'gbrain-finish-tail-'));
let engine: BrainEngine;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; }, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

test('a real managed run whose link tail outlasts the no-progress window ends synced (PGLite)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const id = `tail-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < 2; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nSee [[notes/n${1 - i}]] for acme-example.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const count = engine.countStalePagesForExtraction.bind(engine);
  let slowed = false;
  engine.countStalePagesForExtraction = async opts => { if (!slowed) { slowed = true; await sleep(5_000); } return count(opts); };
  const phases: string[] = [];
  const drainStartedAt = Date.now();
  try {
    const result = await runDrain({ governMs: 20, noProgressMs: 2_500, pass: (signal, onProgress) =>
      performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, signal, drainStartedAt, onProgress: e => { phases.push(e.phase); onProgress(e); } }) });
    expect(slowed).toBe(true);
    expect(result.drain).toMatchObject({ outcome: 'synced', written: 2, remaining: 0 });
    expect(result.status).toBe('first_sync');
    expect(phases).toContain('managed_sync.finish');
  } finally {
    engine.countStalePagesForExtraction = count;
  }
}), 120_000);
