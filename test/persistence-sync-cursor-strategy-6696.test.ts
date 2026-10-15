import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { managedSyncCursorKey, performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

// #6696 C1: `sync --all` passes the source's configured strategy while a single-source CLI run, autopilot's cycle and a
// serve-delegated run pass none, so the same source got two cursor keys (two unfinished cursors that could not resume each
// other). Strategy normalization picks the configured strategy for a run without --strategy, for fresh cursors only: an
// unfinished cursor written under the old (un-normalized) key keeps resuming under that key, so the requests it already
// admitted (their intent.cursorKey) still match their cursor.
//
// Regression guarded: the normalization done in one caller only (the keys keep diverging), or applied to a live cursor
// (its queued requests are fenced out by the cursor they no longer match).

const home = mkdtempSync(join(tmpdir(), 'gbrain-cursor-strategy-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
async function fixture(engine: BrainEngine, config: Record<string, unknown>) {
  const id = `strategy-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(root, `${name}.md`), `---\ntitle: ${name}\n---\nA durable observation named ${name} at fund-a.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, JSON.stringify(config)]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return id;
}
const isolated = (fn: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
  for (const engine of engines) await fn(engine);
});
const cursors = async (engine: BrainEngine, id: string) => engine.executeRaw<{ key: string; done: string | null; strategy: string | null }>(
  "SELECT fingerprint AS key,completed_keys->0->>'done' AS done,completed_keys->0->'syncOptions'->>'strategy' AS strategy FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [id]);
const refused = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state IN ('failed','conflict','cancelled')", [id]))[0]!.n;
// What each caller passes: the single-source CLI, the cycle and a delegated run pass no strategy; `sync --all` passes the configured one.
const single = (sourceId: string): SyncOpts => ({ sourceId, noPull: true, noEmbed: true, explicitProcessing: [] } as SyncOpts);
const all = (sourceId: string): SyncOpts => ({ ...single(sourceId), strategy: 'markdown' });

test('a single-source run and a `sync --all` run of a source configured with a strategy select one cursor key', async () => isolated(async engine => {
  const id = await fixture(engine, { strategy: 'markdown' });
  expect(await managedSyncCursorKey(engine, single(id))).toBe(await managedSyncCursorKey(engine, all(id)));
  expect(await performManagedSync(engine, single(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  expect((await performManagedSync(engine, all(id))).status).toBe('first_sync');
  expect(await cursors(engine, id)).toEqual([expect.objectContaining({ strategy: 'markdown' })]);
  expect(await refused(engine, id)).toBe(0);
}), 120_000);

test('an unfinished cursor under the old key (no strategy) finishes under that key; the next fresh run is normalized', async () => isolated(async engine => {
  const id = await fixture(engine, {});
  // A cursor written while the source had no strategy configured (the key an older binary computed for this source).
  expect(await performManagedSync(engine, single(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  const [legacy] = await cursors(engine, id);
  expect(legacy).toMatchObject({ strategy: null });
  await engine.executeRaw(`UPDATE sources SET config='{"strategy":"markdown"}'::jsonb WHERE id=$1`, [id]);
  expect(await managedSyncCursorKey(engine, single(id))).toBe(legacy!.key);
  expect((await performManagedSync(engine, single(id))).status).toBe('first_sync');
  expect(await cursors(engine, id)).toEqual([{ key: legacy!.key, done: 'true', strategy: null }]);
  expect(await refused(engine, id)).toBe(0);
  // Finished: a fresh run takes the normalized key, and `sync --all` agrees with it.
  expect(await managedSyncCursorKey(engine, single(id))).not.toBe(legacy!.key);
  expect(await managedSyncCursorKey(engine, single(id))).toBe(await managedSyncCursorKey(engine, all(id)));
}), 120_000);

test('an explicit --strategy that differs from the configured one keeps its own key', async () => isolated(async engine => {
  const id = await fixture(engine, { strategy: 'markdown' });
  expect(await managedSyncCursorKey(engine, { ...single(id), strategy: 'auto' })).not.toBe(await managedSyncCursorKey(engine, single(id)));
}), 120_000);
