/**
 * #6650 L0: the managed-sync convergence harness, quarantined.
 *
 * One isolated Postgres brain behind PgBouncer in transaction mode, reached by
 * every child process through a TCP proxy in this file that adds
 * GBRAIN_TEST_CONVERGENCE_LATENCY_MS (default 50) of round-trip latency to the
 * pooled URL and to the direct URL (GBRAIN_DIRECT_DATABASE_URL). The managed
 * fixture is 200 notes plus one large, child-heavy page (a facts fence and a
 * long timeline). Three chaos rounds, each on a new commit, while a writer
 * rewrites 5% of the notes through the coordinator (`gbrain put`):
 *
 *   1. the resident `gbrain serve` owner is SIGKILLed at a publication fault
 *      point while it runs a delegated catch-up;
 *   2. a `--no-delegate` sync client is SIGKILLed at a publication fault point
 *      in its own consumer;
 *   3. a new serve is SIGKILLed at a publication fault point and the
 *      delegating client is SIGKILLed with it.
 *
 * Production never installs a fault hook, so the killed processes are the real
 * `src/cli.ts serve` / `sync` entry points started with the hook-installing
 * preload test/fixtures/convergence-fault-kill.ts (the persistence gate's seam,
 * `fault-points.ts`). With GBRAIN_TEST_CONVERGENCE_PGBOUNCER_CONTAINER set, a
 * fourth round restarts that PgBouncer container under a running drain.
 *
 * Recovery is a fresh serve (what a supervisor restarts) and at most three
 * `gbrain sync --no-pull` runs, with no operator step; only exit 0 with outcome
 * `synced` counts. The oracle tests then assert, each as its own test named by
 * the persistence gate's violation class so a run names exactly which ones
 * fail: disk == database for every page; no request blocks the checkpoint or a
 * root; every non-committed terminal request is superseded (the page's current
 * content hash equals the file's) or carries a registered error code; the
 * cursor reached HEAD; the large page loses no fence fact or timeline entry and
 * duplicates no fact; a killed client's heartbeat never keeps the next sync
 * from delegating to the live serve; no sync after an owner kill stalls past
 * `OWNER_KILL_STALL_BOUND_S`. Timeline duplicates and elapsed times (with the
 * longest stall each sync printed) are measured and printed as `[convergence]`
 * lines.
 *
 * Every random choice (fault points, their nth hit, which notes the writer
 * rewrites) comes from GBRAIN_TEST_CONVERGENCE_SEED (default 6650), so a
 * failure reproduces. Run it with `bun run test:convergence` and
 * GBRAIN_PGBOUNCER_URL / GBRAIN_PGBOUNCER_DIRECT_URL; scripts/persistence/README.md
 * ("Managed-sync convergence harness") has the setup. It is skipped unless
 * GBRAIN_TEST_CONVERGENCE=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import postgres from '#postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { contentHash } from '../src/core/utils.ts';
import { CODES } from '../src/core/error-registry.ts';
import { CONSUMER_LIVE_MS, CONSUMER_RENEWAL_MS } from '../src/core/persistence/consumer-heartbeat.ts';
import type { FaultPoint } from '../src/core/persistence/fault-points.ts';
import { PUBLICATION_CEILING_DEFAULT_MS, publicationLeaseMs } from '../src/core/persistence/publication-deadline.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { withEnv } from './helpers/with-env.ts';
import type { ViolationClass } from '../scripts/persistence/model.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const FAULT_PRELOAD = join(REPO_ROOT, 'test/fixtures/convergence-fault-kill.ts');
const SEED = Number(process.env.GBRAIN_TEST_CONVERGENCE_SEED ?? '6650');
const LATENCY_MS = Number(process.env.GBRAIN_TEST_CONVERGENCE_LATENCY_MS ?? '50');
const pooledTarget = process.env.GBRAIN_PGBOUNCER_URL;
const directTarget = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
const enabled = process.env.GBRAIN_TEST_CONVERGENCE === '1';
if (enabled && !(pooledTarget && directTarget)) {
  throw new Error('GBRAIN_TEST_CONVERGENCE=1 needs GBRAIN_PGBOUNCER_URL (transaction-mode PgBouncer) and GBRAIN_PGBOUNCER_DIRECT_URL (the Postgres behind it).');
}
const describeConvergence = enabled ? describe : describe.skip;

const SOURCE = 'workspace';
const NOTES = 200;
const BIG = 'companies/acme-example';
/**
 * The publication seams a managed sync import crosses. Its pages are already in
 * Git, so the file-publication pair (`before_publication`/`after_publication`)
 * never fires for it; `lane:applied` is the bulk group's applied-but-not-
 * committed point, once per group.
 */
const FAULT_POINTS = ['publication:before_commit', 'publication:after_commit', 'lane:applied'] as const satisfies readonly FaultPoint[];
const MAX_RECOVERY_RUNS = 3;
/** Oracle tests are named by the persistence gate's violation class (scripts/persistence/model.ts) they would report. */
const as = (violation: ViolationClass, title: string): string => `[${violation}] ${title}`;
/**
 * The longest a sync may sit with no progress after an owner was killed: the
 * window in which a dead owner's heartbeat still reads live, one renewal
 * interval for the survivor to notice, and slack for a slow group. Waiting out
 * a publication lease (`publicationLeaseMs`, 365 s by default) blows it.
 */
const OWNER_KILL_STALL_BOUND_S = (CONSUMER_LIVE_MS + CONSUMER_RENEWAL_MS + 30_000) / 1000;

/** mulberry32: a fixed seed gives the same fault plan and writer targets on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(SEED);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
const between = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
/** A seeded fault inside a round that imports about `pages` pages: per-page seams land in its first 60%, the group seam in its first three groups. */
const planFault = (pages: number) => { const point = pick(FAULT_POINTS); return { point, nth: point === 'lane:applied' ? between(1, 3) : between(8, Math.floor(pages * 0.6)) }; };
const LOG_DIR = process.env.GBRAIN_TEST_CONVERGENCE_LOG_DIR;
function keepLog(name: string, text: string): void { if (LOG_DIR) { mkdirSync(LOG_DIR, { recursive: true }); writeFileSync(join(LOG_DIR, name), text); } }

/** A TCP proxy that delays every chunk by half the configured round trip in each direction, preserving order. */
class LatencyProxy {
  private server: Server;
  private sockets = new Set<Socket>();
  port = 0;
  constructor(private target: { host: string; port: number }, private oneWayMs: number) {
    this.server = createServer(client => this.accept(client));
  }
  async listen(): Promise<void> {
    await new Promise<void>(done => this.server.listen(0, '127.0.0.1', done));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('latency proxy has no port');
    this.port = address.port;
  }
  private delayed(from: Socket, to: Socket): void {
    const queue: { at: number; chunk: Buffer }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = () => {
      timer = undefined;
      const now = performance.now();
      while (queue.length && queue[0].at <= now) { const { chunk } = queue.shift()!; if (!to.destroyed) to.write(chunk); }
      if (queue.length) timer = setTimeout(drain, Math.max(0, queue[0].at - performance.now()));
    };
    from.on('data', (chunk: Buffer) => {
      queue.push({ at: performance.now() + this.oneWayMs, chunk });
      if (!timer) timer = setTimeout(drain, this.oneWayMs);
    });
    from.on('end', () => { const close = () => (queue.length ? setTimeout(close, this.oneWayMs) : to.end()); close(); });
  }
  private accept(client: Socket): void {
    const upstream = createConnection(this.target);
    for (const socket of [client, upstream]) {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
    }
    this.delayed(client, upstream);
    this.delayed(upstream, client);
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(done => this.server.close(() => done()));
  }
}

let home: string, repo: string, database: string;
let admin: ReturnType<typeof postgres> | undefined;
let engine: PostgresEngine | undefined;
let pooledProxy: LatencyProxy | undefined, directProxy: LatencyProxy | undefined;
let pooledUrl: string, directUrl: string;
const serves: StdioServe[] = [];
const log: string[] = [];
const elapsed: Record<string, number> = {};
let recoveryRuns: { code: number; ms: number; envelope: Record<string, unknown> | null; err: string }[] = [];
let writerResults: { slug: string; attempts: number; code: number }[] = [];
let calibration: string[] = [];
/** Longest stall each sync that ran after an owner kill printed, by round. */
const ownerKillStalls: Record<string, number> = {};
/** Every sync client's stderr, and the PIDs this run SIGKILLed. */
const syncErrs: Record<string, string> = {};
const killedPids = new Set<number>();
let round3Err = '';
const fired: Record<string, string | null> = {};
const PGBOUNCER_CONTAINER = process.env.GBRAIN_TEST_CONVERGENCE_PGBOUNCER_CONTAINER;

function note(line: string): void { log.push(line); console.error(`[convergence] ${line}`); }
function git(...args: string[]): string { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commitAll(message: string): string { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); }

function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  return keylessBrainEnv(process.env, home, {
    DATABASE_URL: pooledUrl, GBRAIN_DATABASE_URL: undefined, GBRAIN_DIRECT_DATABASE_URL: directUrl,
    GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: SOURCE, GBRAIN_SWEEP: '0', GBRAIN_HOOKS: undefined,
    GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_SKILL_NAG: '1', GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS: '300',
    GBRAIN_SYNC_NO_DELEGATE: undefined, GBRAIN_TEST_CONVERGENCE_FAULT: undefined,
    ...extra,
  });
}

interface Fault { point: string; nth: number; marker: string; operation: string }
function faultArgs(fault?: Fault): { preload: string[]; env: Record<string, string | undefined> } {
  if (!fault) return { preload: [], env: {} };
  return { preload: ['--preload', FAULT_PRELOAD], env: { GBRAIN_TEST_CONVERGENCE_FAULT: JSON.stringify(fault) } };
}

/** One stdio MCP session against a spawned `gbrain serve`; the serve is the host's resident persistence owner. */
class StdioServe {
  readonly child: ChildProcess;
  stderr = '';
  exited: Promise<number | null>;
  private nextId = 1;
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();
  private buf = '';
  constructor(fault?: Fault) {
    const { preload, env } = faultArgs(fault);
    this.child = spawn(process.execPath, ['--no-env-file', ...preload, join(REPO_ROOT, 'src/cli.ts'), 'serve'], { cwd: REPO_ROOT, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(done => this.child.once('exit', code => done(code)));
    this.child.stderr!.on('data', (d: Buffer) => { this.stderr += d.toString('utf8'); });
    this.child.stdin!.on('error', () => {});
    this.child.stdout!.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, idx).trim(); this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg.id as number | undefined;
          if (id !== undefined && this.pending.has(id)) { this.pending.get(id)!(msg); this.pending.delete(id); }
        } catch { /* serve chatter */ }
      }
    });
    serves.push(this);
  }
  get pid(): number { return this.child.pid!; }
  get alive(): boolean { return this.child.exitCode === null && this.child.signalCode === null; }
  request(method: string, params: Record<string, unknown>, timeoutMs = 240_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((done, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, msg => { clearTimeout(t); done(msg); });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async start(): Promise<void> {
    await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'convergence', version: '1' } });
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await until(async () => (await engine!.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM persistence_consumers WHERE pid=$1 AND kind='serve' AND renewed_at > now() - interval '30 seconds'`, [this.pid]))[0].n > 0,
      `serve ${this.pid} heartbeat`, 120_000);
  }
  async stop(): Promise<void> {
    if (!this.alive) return;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 10_000);
    await this.exited; clearTimeout(timer);
  }
}

interface SyncRun { proc: ReturnType<typeof Bun.spawn>; result: Promise<{ code: number; out: string; err: string; ms: number }> }
function startSync(args: string[], fault?: Fault, timeoutMs = 900_000): SyncRun {
  const { preload, env } = faultArgs(fault);
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, '--no-env-file', ...preload, join(REPO_ROOT, 'src/cli.ts'), 'sync', '--source', SOURCE, ...args], {
    cwd: REPO_ROOT, env: childEnv(env), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  const result = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    .then(([out, err, code]) => ({ code, out, err, ms: performance.now() - started }))
    .finally(() => clearTimeout(timer));
  return { proc, result };
}
/** The longest `stalled Ns` progress line a sync printed: how long it waited on a predecessor's leftovers. */
function worstStall(err: string): number { return Math.max(0, ...[...err.matchAll(/stalled (\d+)s/g)].map(m => Number(m[1]))); }
function lastJson(out: string): Record<string, unknown> | null {
  for (const line of out.trim().split('\n').reverse()) { try { return JSON.parse(line) as Record<string, unknown>; } catch { /* not the envelope */ } }
  return null;
}

async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 300_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------- fixture

function noteText(i: number, version: string): string {
  return `---\ntype: concept\ntitle: Note ${i} Example\n---\n\n${version} body for note ${i}, an observation about widget-co and acme-example.\n\n${'Supporting detail sentence. '.repeat(8 + (i % 5))}\n`;
}
function writeNote(i: number, version: string): void { writeFileSync(join(repo, 'notes', `note-${String(i).padStart(4, '0')}.md`), noteText(i, version)); }

function bigPage(facts: number, timeline: number, version: string): string {
  const day = (n: number) => new Date(Date.UTC(2018, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
  const paragraphs = Array.from({ length: 30 }, (_, i) => `Section ${i} (${version}): acme-example ${'expanded with a steady stream of synthetic operating detail. '.repeat(6)}`);
  const rows = Array.from({ length: facts }, (_, i) =>
    `| ${i + 1} | Synthetic claim ${i + 1} about acme-example | fact | 0.9 | world | medium | ${day(i)} |  | fixture |  |`);
  const bullets = Array.from({ length: timeline }, (_, i) => `- **${day(i)}** | Synthetic event ${i + 1} at acme-example`);
  return [
    '---', 'type: company', 'title: Acme Example', '---', '', '# Acme Example', '', ...paragraphs.flatMap(p => [p, '']),
    '## Facts', '', '<!--- gbrain:facts:begin -->',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
    '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
    ...rows, '<!--- gbrain:facts:end -->', '', '<!-- timeline -->', '', ...bullets, '',
  ].join('\n');
}
function writeBig(facts: number, timeline: number, version: string): void { writeFileSync(join(repo, `${BIG}.md`), bigPage(facts, timeline, version)); }

// ---------------------------------------------------------------- oracle reads

function diskPages(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) out.set(relative(repo, full).replace(/\.md$/, ''), readFileSync(full, 'utf8'));
    }
  };
  walk(repo);
  return out;
}
function fileHash(slug: string, content: string): string {
  const parsed = parseMarkdown(content, `${slug}.md`);
  return contentHash({ title: parsed.title, type: parsed.type, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: parsed.frontmatter, tags: [...parsed.tags].sort() });
}
async function dbPages(): Promise<Map<string, string | null>> {
  const rows = await engine!.executeRaw<{ slug: string; content_hash: string | null }>(
    'SELECT slug, content_hash FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [SOURCE]);
  return new Map(rows.map(r => [r.slug, r.content_hash]));
}
async function diskDbMismatches(): Promise<string[]> {
  const disk = diskPages(), db = await dbPages(), out: string[] = [];
  for (const [slug, content] of disk) {
    if (!db.has(slug)) out.push(`${slug}: file exists, no live page`);
    else if (db.get(slug) !== fileHash(slug, content)) out.push(`${slug}: page content_hash differs from the file`);
  }
  for (const slug of db.keys()) if (!disk.has(slug)) out.push(`${slug}: live page, no file`);
  return out;
}
/**
 * The large page's child rows against its file. Facts are keyed by fence row, so
 * loss, duplication and strays are all problems. Timeline rows are judged for
 * loss only; duplicate and stray timeline rows come back as a measured count,
 * because derived timeline rows are never pruned (a known defect outside #6650).
 */
async function childRowProblems(): Promise<{ problems: string[]; timelineDuplicates: number; timelineStrays: number }> {
  const content = diskPages().get(BIG);
  if (!content) return { problems: [`${BIG}: no file`], timelineDuplicates: 0, timelineStrays: 0 };
  const out: string[] = [];
  const expectedTimeline = [...content.matchAll(/^- \*\*(\d{4}-\d{2}-\d{2})\*\* \| (.+)$/gm)].map(m => `${m[1]}|${m[2]}`);
  const timeline = await engine!.executeRaw<{ key: string; n: number }>(
    `SELECT t.date::text || '|' || t.summary AS key, count(*)::int AS n FROM timeline_entries t JOIN pages p ON p.id=t.page_id
      WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL AND t.event_page_id IS NULL GROUP BY 1`, [SOURCE, BIG]);
  const have = new Map(timeline.map(r => [r.key, r.n]));
  const lostTimeline = expectedTimeline.filter(k => !have.has(k));
  const dupTimeline = timeline.filter(r => r.n > 1);
  const extraTimeline = timeline.filter(r => !expectedTimeline.includes(r.key));
  if (lostTimeline.length) out.push(`timeline: ${lostTimeline.length} of ${expectedTimeline.length} file entries missing (first: ${lostTimeline[0]})`);
  const expectedFacts = parseFactsFence(content).facts.map(f => `${f.rowNum}|${f.claim}`);
  const facts = await engine!.executeRaw<{ key: string; n: number }>(
    `SELECT row_num::text || '|' || fact AS key, count(*)::int AS n FROM facts
      WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL GROUP BY 1`, [SOURCE, BIG]);
  const haveFacts = new Map(facts.map(r => [r.key, r.n]));
  const lostFacts = expectedFacts.filter(k => !haveFacts.has(k));
  const dupFacts = facts.filter(r => r.n > 1);
  const extraFacts = facts.filter(r => !expectedFacts.includes(r.key));
  if (lostFacts.length) out.push(`facts: ${lostFacts.length} of ${expectedFacts.length} fence rows missing (first: ${lostFacts[0]})`);
  if (dupFacts.length) out.push(`facts: ${dupFacts.length} rows duplicated (first: ${dupFacts[0].key} x${dupFacts[0].n})`);
  if (extraFacts.length) out.push(`facts: ${extraFacts.length} rows not in the fence (first: ${extraFacts[0].key})`);
  return { problems: out, timelineDuplicates: dupTimeline.reduce((n, r) => n + r.n - 1, 0), timelineStrays: extraTimeline.length };
}

// ---------------------------------------------------------------- the concurrent writer

/**
 * Rewrites each target note once through the coordinator (`gbrain put`) as a
 * correct client does: an unsettled attempt (exit 10, a lost owner) retries
 * with the same request id; a terminal refusal (a page the pending catch-up
 * has not imported yet refuses `source_changed`) retries with a new one.
 */
async function runWriter(slugs: string[], stop: () => boolean): Promise<void> {
  for (const [k, slug] of slugs.entries()) {
    let requestId = randomUUID();
    const content = `---\ntype: concept\ntitle: ${slug.split('/')[1]} rewritten\n---\n\nWriter rewrite ${k} of ${slug} through the coordinator.\n`;
    let attempts = 0, code = -1;
    while (attempts < 20) {
      attempts++;
      const proc = Bun.spawn([process.execPath, '--no-env-file', join(REPO_ROOT, 'src/cli.ts'), 'put', slug, '--source-id', SOURCE, '--force', '--request-id', requestId, '--wait-ms', '10000'], {
        cwd: REPO_ROOT, env: childEnv(), stdin: new Blob([content]), stdout: 'pipe', stderr: 'pipe',
      });
      const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      code = exit;
      keepLog(`writer-${slug.replace('/', '_')}-${attempts}.log`, `exit ${exit}\n${out}\n${err}`);
      if (exit === 0) break;
      const terminal = /\((conflict|failed|cancelled)\)/.test(err);
      note(`writer ${slug} attempt ${attempts} exit ${exit}${terminal ? ' (terminal; next attempt uses a new request id)' : ''}: ${err.trim().split('\n').slice(-1)[0] ?? ''}`);
      if (terminal) requestId = randomUUID();
      await Bun.sleep(3000);
    }
    writerResults.push({ slug, attempts, code });
    if (stop()) break;
    await Bun.sleep(between(200, 1500));
  }
}

// ---------------------------------------------------------------- scenario

// Runs on every invocation, harness enabled or not: the calibration the chaos run's verdicts rest on.
describe('convergence harness calibration (#6650 L0)', () => {
  test('the owner-kill stall bound is below the default publication lease it exists to catch', () => {
    expect(OWNER_KILL_STALL_BOUND_S * 1000).toBeLessThan(publicationLeaseMs(PUBLICATION_CEILING_DEFAULT_MS));
  });
  test('a seed reproduces its fault plan and writer targets', () => {
    const draw = (seed: number) => { const next = prng(seed); return Array.from({ length: 16 }, next); };
    expect(draw(SEED)).toEqual(draw(SEED));
    expect(draw(SEED)).not.toEqual(draw(SEED + 1));
  });
});

describeConvergence('managed sync converges after owner, client and writer chaos (#6650 L0)', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(directTarget!);
    home = mkdtempSync(join(tmpdir(), 'gb-conv-'));
    mkdirSync(join(home, '.gbrain'));
    database = `gbrain_test_convergence_${randomUUID().replaceAll('-', '')}`;
    admin = postgres(directTarget!, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const direct = new URL(directTarget!); direct.pathname = `/${database}`;
    const pooled = new URL(pooledTarget!); pooled.pathname = `/${database}`;
    pooledProxy = new LatencyProxy({ host: pooled.hostname, port: Number(pooled.port) || 5432 }, LATENCY_MS / 2);
    directProxy = new LatencyProxy({ host: direct.hostname, port: Number(direct.port) || 5432 }, LATENCY_MS / 2);
    await Promise.all([pooledProxy.listen(), directProxy.listen()]);
    const viaPooled = new URL(pooled); viaPooled.hostname = '127.0.0.1'; viaPooled.port = String(pooledProxy.port); viaPooled.searchParams.set('prepare', 'false');
    const viaDirect = new URL(direct); viaDirect.hostname = '127.0.0.1'; viaDirect.port = String(directProxy.port);
    pooledUrl = viaPooled.toString(); directUrl = viaDirect.toString();
    engine = new PostgresEngine();
    await withEnv({ GBRAIN_HOME: home, GBRAIN_DIRECT_DATABASE_URL: undefined }, async () => {
      await engine!.connect({ database_url: direct.toString(), poolSize: 4 });
      await engine!.initSchema();
    });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: pooledUrl, embedding_disabled: true }));

    repo = mkdtempSync(join(tmpdir(), 'gb-conv-repo-'));
    git('init', '-q'); git('config', 'user.email', 'example@example.invalid'); git('config', 'user.name', 'Example');
    mkdirSync(join(repo, 'notes')); mkdirSync(join(repo, 'companies'));
    for (let i = 0; i < NOTES; i++) writeNote(i, 'Initial');
    writeBig(120, 400, 'v0');
    commitAll('fixture');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine!.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [SOURCE, repo]);
      await claimWorktree(engine!, SOURCE, repo);
      await engine!.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    });
    note(`seed=${SEED} latency=${LATENCY_MS}ms round trip via proxies (pooled -> ${pooled.host}, direct -> ${direct.host})`);

    // Phase 0: a fault-free import, so the oracle is calibrated before any chaos.
    let started = performance.now();
    const baseline = await startSync(['--no-pull', '--no-delegate', '--json']).result;
    elapsed.baseline_import_ms = performance.now() - started;
    if (baseline.code !== 0) throw new Error(`baseline sync exited ${baseline.code}\n${baseline.out}\n${baseline.err}`);
    const baselineRows = await childRowProblems();
    calibration = [...await diskDbMismatches(), ...baselineRows.problems,
      ...(baselineRows.timelineDuplicates || baselineRows.timelineStrays ? [`timeline: ${baselineRows.timelineDuplicates} duplicate and ${baselineRows.timelineStrays} stray rows after a fault-free import`] : [])];
    note(`phase 0: fault-free import of ${NOTES + 1} pages in ${(elapsed.baseline_import_ms / 1000).toFixed(1)}s; oracle calibration problems: ${calibration.length}`);

    // The chaos plan, drawn from the seed before anything runs.
    const plan = [NOTES + 41, NOTES / 2 + 1, Math.ceil((NOTES + 40) / 3) + 1].map((pages, i) => ({ round: i + 1, ...planFault(pages) }));
    const writerTargets = [...new Set(Array.from({ length: 40 }, () => between(0, NOTES - 1)))].slice(0, Math.round((NOTES + 40) * 0.05))
      .map(i => `notes/note-${String(i).padStart(4, '0')}`);
    note(`plan: ${plan.map(p => `round ${p.round} ${p.point} #${p.nth}`).join('; ')}; writer rewrites ${writerTargets.length} notes`);
    let chaosDone = false;
    const writer = runWriter(writerTargets, () => chaosDone);
    const marker = (round: number) => join(home, `fault-${round}.json`);
    const record = (round: number) => {
      const at = existsSync(marker(round)) ? readFileSync(marker(round), 'utf8') : null;
      fired[`round ${round} ${plan[round - 1].point} #${plan[round - 1].nth}`] = at;
      if (at) killedPids.add((JSON.parse(at) as { pid: number }).pid);
    };
    const chaosStarted = performance.now();

    // Round 1: rewrite every note, add 40, grow the large page; the resident serve dies mid-catch-up.
    for (let i = 0; i < NOTES; i++) writeNote(i, 'Round one');
    for (let i = NOTES; i < NOTES + 40; i++) writeNote(i, 'Added');
    writeBig(160, 500, 'v1');
    commitAll('round one');
    started = performance.now();
    const s1 = new StdioServe({ ...plan[0], marker: marker(1), operation: 'submit_job' });
    await s1.start();
    const c1 = startSync(['--no-pull', '--json']);
    await Promise.race([s1.exited, c1.result]);
    const r1 = await c1.result;
    syncErrs.round1 = r1.err; ownerKillStalls['round 1 (serve killed mid-catch-up)'] = worstStall(r1.err);
    keepLog('round1-client.log', `${r1.out}\n${r1.err}`); keepLog('round1-serve.log', s1.stderr);
    record(1);
    note(`round 1: serve ${s1.alive ? 'survived' : `killed (${existsSync(marker(1)) ? readFileSync(marker(1), 'utf8') : 'no marker'})`}; client exit ${r1.code} in ${(r1.ms / 1000).toFixed(1)}s, worst stall ${worstStall(r1.err)}s: ${r1.err.trim().split('\n').slice(-2).join(' / ')}`);
    await s1.stop();
    elapsed.round1_ms = performance.now() - started;

    // Round 2: rewrite half the notes and the large page; a --no-delegate client dies in its own consumer.
    for (let i = 0; i < NOTES; i += 2) writeNote(i, 'Round two');
    writeBig(180, 560, 'v2');
    commitAll('round two');
    started = performance.now();
    const r2 = await startSync(['--no-pull', '--no-delegate', '--json'], { ...plan[1], marker: marker(2), operation: 'submit_job' }).result;
    keepLog('round2-client.log', `${r2.out}\n${r2.err}`); syncErrs.round2 = r2.err;
    record(2);
    note(`round 2: client exit ${r2.code} (${existsSync(marker(2)) ? `killed ${readFileSync(marker(2), 'utf8')}` : 'no fault fired'}) in ${(r2.ms / 1000).toFixed(1)}s, worst stall ${worstStall(r2.err)}s`);
    elapsed.round2_ms = performance.now() - started;

    // Round 3: rewrite a third and the large page; a new serve dies at its fault point and the delegating client dies with it.
    for (let i = 1; i < NOTES + 40; i += 3) writeNote(i, 'Round three');
    writeBig(200, 620, 'v3');
    commitAll('round three');
    started = performance.now();
    const s2 = new StdioServe({ ...plan[2], marker: marker(3), operation: 'submit_job' });
    await s2.start();
    const c3 = startSync(['--no-pull', '--json']);
    await Promise.race([s2.exited, c3.result]);
    if (!s2.alive) { c3.proc.kill('SIGKILL'); killedPids.add(c3.proc.pid); }
    const r3 = await c3.result;
    syncErrs.round3 = round3Err = r3.err; ownerKillStalls['round 3 (after the round-2 client kill)'] = worstStall(r3.err);
    keepLog('round3-client.log', `${r3.out}\n${r3.err}`); keepLog('round3-serve.log', s2.stderr);
    record(3);
    note(`round 3: serve ${s2.alive ? 'survived' : `killed (${existsSync(marker(3)) ? readFileSync(marker(3), 'utf8') : 'no marker'})`}; client exit ${r3.code}${c3.proc.signalCode ? ` (${c3.proc.signalCode})` : ''} in ${(r3.ms / 1000).toFixed(1)}s, worst stall ${worstStall(r3.err)}s; ${r3.err.split('\n').find(l => /live write owner|owns this host's writes/.test(l))?.trim() ?? 'no delegation line'}`);
    await s2.stop();
    elapsed.round3_ms = performance.now() - started;

    // Round 4, only with a named PgBouncer container: restart the pooler under a running drain once it has committed 20 pages.
    if (PGBOUNCER_CONTAINER) {
      for (let i = 2; i < NOTES; i += 4) writeNote(i, 'Round four');
      commitAll('round four');
      started = performance.now();
      const [{ at }] = await engine!.executeRaw<{ at: string }>('SELECT now()::text AS at');
      const c4 = startSync(['--no-pull', '--no-delegate', '--json']);
      let restarted = false;
      const restart = until(async () => (await engine!.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM persistence_requests WHERE state='committed' AND completed_at > $1::timestamptz AND operation='submit_job'`, [at]))[0].n >= 20, 'twenty committed round-four pages', 600_000)
        .then(() => { execFileSync('docker', ['restart', '-t', '0', PGBOUNCER_CONTAINER], { stdio: 'ignore' }); restarted = true; });
      const r4 = await c4.result;
      await restart.catch(error => note(`round 4: no restart (${(error as Error).message})`));
      keepLog('round4-client.log', `${r4.out}\n${r4.err}`); syncErrs.round4 = r4.err;
      fired[`round 4 docker restart ${PGBOUNCER_CONTAINER} after 20 commits`] = restarted ? 'restarted' : null;
      note(`round 4: pooler ${restarted ? 'restarted mid-drain' : 'not restarted'}; client exit ${r4.code} in ${(r4.ms / 1000).toFixed(1)}s, worst stall ${worstStall(r4.err)}s: ${r4.err.trim().split('\n').slice(-1)[0] ?? ''}`);
      elapsed.round4_ms = performance.now() - started;
    }
    chaosDone = true;
    await writer;
    elapsed.chaos_ms = performance.now() - chaosStarted;
    note(`writer: ${writerResults.map(w => `${w.slug}=${w.code}${w.attempts > 1 ? `/${w.attempts}` : ''}`).join(' ')}`);

    // Recovery: a fresh resident serve and at most three plain syncs, no operator step.
    const recoveryStarted = performance.now();
    const s3 = new StdioServe();
    await s3.start();
    for (let run = 1; run <= MAX_RECOVERY_RUNS; run++) {
      const r = await startSync(['--no-pull', '--json']).result;
      const envelope = lastJson(r.out);
      recoveryRuns.push({ code: r.code, ms: r.ms, envelope, err: r.err });
      keepLog(`recovery-${run}-client.log`, `${r.out}\n${r.err}`); syncErrs[`recovery ${run}`] = r.err;
      ownerKillStalls[`recovery run ${run}`] = worstStall(r.err);
      note(`recovery run ${run}: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s outcome=${String(envelope?.outcome ?? envelope?.sync_status ?? envelope?.error ?? 'none')}`);
      if (r.code === 0 && envelope?.outcome === 'synced') break;
    }
    elapsed.recovery_ms = performance.now() - recoveryStarted;
    keepLog('recovery-serve.log', s3.stderr);
    note(`elapsed: ${Object.entries(elapsed).map(([k, ms]) => `${k.replace(/_ms$/, '')} ${(ms / 1000).toFixed(1)}s`).join(', ')}; recovery took ${recoveryRuns.length} sync run(s)`);
  }, 3_600_000);

  afterAll(async () => {
    for (const serve of serves) await serve.stop().catch(() => {});
    try { await engine?.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); } catch { /* best effort */ }
    await engine?.disconnect().catch(() => {});
    await pooledProxy?.close().catch(() => {});
    await directProxy?.close().catch(() => {});
    if (admin) {
      try { if (database) await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await admin.end(); }
    }
    for (const dir of [home, repo]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('the oracle is calibrated: a fault-free import satisfies it', () => {
    expect(calibration).toEqual([]);
  });

  test(as('wedge', "a killed client's stale heartbeat never keeps ownership from a live serve"), () => {
    const deadOwners = Object.entries(syncErrs).flatMap(([run, err]) => [...err.matchAll(/the live write owner on this host is a (\w+) process \(PID (\d+)\)/g)]
      .filter(m => killedPids.has(Number(m[2]))).map(m => `${run}: ${m[0]}`));
    expect({ delegatedToLiveServe: /running the managed catch-up inside it as this CLI's writer/.test(round3Err), deadOwners })
      .toEqual({ delegatedToLiveServe: true, deadOwners: [] });
  });

  test(as('wedge', 'recovery after an owner kill does not wait out the publication lease'), () => {
    note(`worst stall after an owner kill (bound ${OWNER_KILL_STALL_BOUND_S}s): ${Object.entries(ownerKillStalls).map(([k, v]) => `${k} ${v}s`).join(', ')}`);
    expect(Object.entries(ownerKillStalls).filter(([, stall]) => stall > OWNER_KILL_STALL_BOUND_S)).toEqual([]);
  });

  test('every planned fault fired, so the chaos actually happened', () => {
    expect(Object.entries(fired).filter(([, at]) => at === null).map(([fault]) => fault)).toEqual([]);
  });

  test(as('wedge', `a plain sync succeeds within ${MAX_RECOVERY_RUNS} runs after the chaos, with no operator step`), () => {
    const last = recoveryRuns.at(-1);
    expect({ code: last?.code, outcome: last?.envelope?.outcome }).toEqual({ code: 0, outcome: 'synced' });
  });

  test(as('projection_drift', 'disk == database for every page'), async () => {
    expect(await diskDbMismatches()).toEqual([]);
  });

  test(as('wedge', 'no request blocks the checkpoint or a root'), async () => {
    const open = await engine!.executeRaw<{ request_id: string; slug: string; state: string; recovery: boolean; blocked_reason: string | null }>(
      `SELECT request_id::text, slug, state, recovery IS NOT NULL AS recovery, blocked_reason FROM persistence_requests
        WHERE state IN ('queued','running','recovering') OR recovery IS NOT NULL ORDER BY sequence`);
    const worktrees = await engine!.executeRaw<{ id: string; state: string }>(`SELECT id::text, state FROM persistence_worktrees WHERE state<>'active'`);
    expect({ open, worktrees }).toEqual({ open: [], worktrees: [] });
  });

  test(as('untyped_error', 'every non-committed terminal request is superseded or carries a registered error code'), async () => {
    const rows = await engine!.executeRaw<{ request_id: string; slug: string; state: string; error_code: string | null; operation: string }>(
      `SELECT request_id::text, slug, state, error_code, operation FROM persistence_requests WHERE state IN ('conflict','failed','cancelled') ORDER BY sequence`);
    const disk = diskPages(), db = await dbPages();
    const unexplained = rows.filter(row => {
      const content = disk.get(row.slug);
      const superseded = content !== undefined && db.get(row.slug) === fileHash(row.slug, content);
      return !superseded && !(row.error_code && row.error_code in CODES);
    });
    note(`terminal non-committed requests: ${rows.length} (${[...new Set(rows.map(r => `${r.state}:${r.error_code}`))].join(', ') || 'none'})`);
    expect(unexplained).toEqual([]);
  });

  test(as('wedge', 'the cursor reached HEAD'), async () => {
    const [source] = await engine!.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [SOURCE]);
    expect(source.last_commit).toBe(git('rev-parse', 'HEAD'));
  });

  test(as('lost_write', 'the large page keeps every fence fact exactly once and loses no timeline entry'), async () => {
    const { problems, timelineDuplicates, timelineStrays } = await childRowProblems();
    note(`large page timeline (measured, not asserted): ${timelineDuplicates} duplicate rows, ${timelineStrays} rows not in the file`);
    expect(problems).toEqual([]);
  });
});
