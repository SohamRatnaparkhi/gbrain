/**
 * Bare gbrain vs gbrain + HydraDB cloud memory on LongMemEval_s, through the
 * real `query` op (so the cloud arm in applyQueryArms runs exactly as shipped).
 *
 * Each question's haystack is its own gbrain source, so the local search and
 * the cloud arm (scoped server-side by source) see one question's sessions.
 * Brain A holds every session and mirrors them to one HydraDB database. Brain
 * B, a second device on the same database, holds only the most recent
 * `--local-share` of each haystack. Four conditions, recall_any/all@k over the
 * gold evidence sessions. Per brain: bare, + HydraDB as shipped (spare rows),
 * and two composition strategies computed from the same local rows and the
 * same HydraDB ranking (reserve 30% of rows, page-level RRF); plus HydraDB alone.
 *
 *   OPENROUTER_API_KEY=… HYDRA_DB_API_KEY=… bun evals/cloud-memory/ab.ts \
 *     --dataset ~/.cache/gbrain-eval/longmemeval/longmemeval_s.json \
 *     --ids evals/longmemeval/dev-slice-seed42.txt [--limit-questions N] [--local-share 0.3] [--k 10] [--keep] [--out file.json]
 *
 * Paid and slow: OpenRouter embeds every session (text-embedding-3-small), and
 * HydraDB ingest is rate-limited. The database is deleted at the end unless --keep.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runEmbedCore } from '../../src/commands/embed.ts';
import { handleToolCall } from '../../src/mcp/server.ts';
import { HYDRADB_CONFIG, HydraDBError, hydraRequest, queryHydra, type HydraConnection } from '../../src/core/hydradb.ts';
import { mirrorBrain } from '../../src/core/hydradb-mirror.ts';
import { haystackToPages, type LongMemEvalQuestion } from '../../src/eval/longmemeval/adapter.ts';
import { buildSlugToRawMap, scoreRecall, type SlugToRawMap } from '../../src/eval/longmemeval/metrics.ts';
import type { SearchResult } from '../../src/core/types.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const datasetPath = arg('--dataset')!;
const idsPath = arg('--ids')!;
const limitQuestions = Number(arg('--limit-questions') ?? Infinity);
const localShare = Number(arg('--local-share') ?? 0.3);
const k = Number(arg('--k') ?? 10);
const keep = process.argv.includes('--keep');
const outPath = arg('--out') ?? 'cloud-memory-ab.json';
const brainsDir = arg('--brains-dir');
const reuse = process.argv.includes('--reuse');
const log = (...m: unknown[]) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...m);

const ids = readFileSync(idsPath, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const byId = new Map((JSON.parse(readFileSync(datasetPath, 'utf8')) as LongMemEvalQuestion[]).map(q => [q.question_id, q]));
const questions = ids.map(id => byId.get(id)).filter((q): q is LongMemEvalQuestion => !!q).slice(0, limitQuestions);
const sourceOf = (q: LongMemEvalQuestion) => `lme-${q.question_id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)}`;

/** The most recent `share` of a haystack's pages (dates when present, else haystack order). */
function recentPages(q: LongMemEvalQuestion): Set<string> {
  const pages = haystackToPages(q).map((p, i) => ({ slug: p.slug, at: q.haystack_dates?.[i] ?? String(i).padStart(6, '0') }));
  const keepN = Math.max(1, Math.ceil(pages.length * localShare));
  return new Set([...pages].sort((a, b) => a.at.localeCompare(b.at)).slice(-keepN).map(p => p.slug));
}

/** A brain of the selected questions' haystacks; with --brains-dir it persists, and a populated one is reused as is. */
async function brain(name: string, only?: (q: LongMemEvalQuestion) => Set<string>): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect(brainsDir ? { database_path: `${brainsDir}/${name}` } as never : {});
  await engine.initSchema();
  const [{ n: held }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages');
  if (held > 0) { log(`  reusing ${held} pages in ${brainsDir}/${name}`); return engine; }
  for (const [n, q] of questions.entries()) {
    const sourceId = sourceOf(q);
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [sourceId]);
    const keepSlugs = only?.(q);
    for (const p of haystackToPages(q)) {
      if (keepSlugs && !keepSlugs.has(p.slug)) continue;
      await importFromContent(engine, p.slug, p.content, { sourceId, noEmbed: true });
    }
    if ((n + 1) % 10 === 0 || n + 1 === questions.length) log(`  imported ${n + 1}/${questions.length}`);
  }
  const embedded = await runEmbedCore(engine, { stale: true });
  log(`  embedded: ${JSON.stringify(embedded).slice(0, 160)}`);
  return engine;
}

/** `fn`, retried while HydraDB rate-limits (429) or fails transiently (5xx). */
async function patiently<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof HydraDBError && (e.status === 429 || e.status >= 500)) || attempt >= 20) throw e;
      await Bun.sleep(5_000);
    }
  }
}

/** Every knowledge id the database holds: what the mirror actually sent. */
async function cloudIds(conn: HydraConnection): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const d = await patiently(() => hydraRequest<{ sources?: Array<{ id: string }>; pagination?: { has_next?: boolean } }>(conn, 'POST', '/context/list',
      { json: { database: conn.database, type: 'knowledge', page, page_size: 100 } }));
    ids.push(...(d?.sources ?? []).map(x => x.id));
    if (!d?.pagination?.has_next) return ids;
  }
}

/** Wait until every sent id reports completed or failed; a missing status or an error is still pending. Returns stragglers after 45 min. */
async function waitIndexed(conn: HydraConnection, docIds: string[]): Promise<number> {
  let pending = docIds;
  const start = Date.now();
  while (pending.length) {
    const still: string[] = [];
    for (let i = 0; i < pending.length; i += 10) {
      const batch = pending.slice(i, i + 10);
      const qs = batch.map(id => `ids=${encodeURIComponent(id)}`).join('&');
      const data = await patiently(() => hydraRequest<{ statuses?: Array<{ id: string; indexing_status: string }> }>(conn, 'GET', `/context/status?database=${conn.database}&${qs}`))
        .catch(() => null);
      // `graph_creation` is past text indexing: the passage is searchable, the graph lane comes later.
      const done = new Set((data?.statuses ?? []).filter(x => ['completed', 'failed', 'graph_creation'].includes(x.indexing_status)).map(x => x.id));
      for (const id of batch) if (!done.has(id)) still.push(id);
    }
    pending = still;
    log(`  indexing: ${docIds.length - pending.length}/${docIds.length} done (${Math.round((Date.now() - start) / 1000)}s)`);
    if (!pending.length) return 0;
    if (Date.now() - start > 45 * 60_000) { log(`  proceeding with ${pending.length} still indexing after 45 min`); return pending.length; }
    await Bun.sleep(30_000);
  }
  return 0;
}

interface Row { question_id: string; question_type: string; condition: string; recall_any: boolean; recall_all: boolean;
  gold_total: number; gold_found: number; cloud_rows: number; gold_via_cloud: number; ms: number }

/** One row of a ranked list: the page it names and whether HydraDB supplied it. */
interface Item { slug: string | undefined; cloud: boolean }

const RRF_K = 60;
const distinct = (items: Item[]) => [...new Set(items.map(i => i.slug).filter((s): s is string => !!s))];

function score(q: LongMemEvalQuestion, condition: string, items: Item[], ms: number): Row {
  const slugToRaw: SlugToRawMap = buildSlugToRawMap(q);
  const raw: string[] = [];
  const viaCloud = new Set<string>();
  for (const it of items.slice(0, k)) {
    for (const id of (it.slug ? slugToRaw.get(it.slug) : undefined) ?? []) {
      raw.push(id);
      if (it.cloud) viaCloud.add(id);
    }
  }
  const s = scoreRecall(raw, q.answer_session_ids, k);
  return { question_id: q.question_id, question_type: q.question_type, condition, recall_any: s.recall_any_hit, recall_all: s.recall_all_hit,
    gold_total: s.gold_total, gold_found: s.gold_found, cloud_rows: items.slice(0, k).filter(i => i.cloud).length,
    gold_via_cloud: q.answer_session_ids.filter(g => viaCloud.has(g)).length, ms: Math.round(ms) };
}

/** Cloud passages not already among the local pages take the lowest `share` of the k rows (the temporal fact reserve rule). */
function reserve(local: Item[], cloud: Item[], share: number): Item[] {
  const have = new Set(distinct(local));
  const fresh = cloud.filter(c => c.slug && !have.has(c.slug)).slice(0, Math.ceil(k * share));
  return [...local.slice(0, k - fresh.length), ...fresh];
}

/** Page-level reciprocal rank fusion of the local and cloud rankings. */
function fuse(local: Item[], cloud: Item[]): Item[] {
  const localSlugs = distinct(local);
  const scores = new Map<string, number>();
  localSlugs.forEach((s, i) => scores.set(s, (scores.get(s) ?? 0) + 1 / (RRF_K + i + 1)));
  distinct(cloud).forEach((s, i) => scores.set(s, (scores.get(s) ?? 0) + 1 / (RRF_K + i + 1)));
  const held = new Set(localSlugs);
  return [...scores].sort((x, y) => y[1] - x[1]).slice(0, k).map(([slug]) => ({ slug, cloud: !held.has(slug) }));
}

async function queryOp(engine: PGLiteEngine, q: LongMemEvalQuestion, cloud: boolean, titleToSlug: Map<string, string>): Promise<{ items: Item[]; ms: number }> {
  await engine.setConfig(HYDRADB_CONFIG.primary, cloud ? 'true' : 'false');
  const t0 = performance.now();
  const results = await handleToolCall(engine, 'query', { query: q.question, source_id: sourceOf(q), limit: k, expand: false, use_cache: false }) as SearchResult[];
  const ms = performance.now() - t0;
  return { items: results.map(r => ({ slug: r.slug ?? r.page_slug ?? titleToSlug.get(r.title), cloud: r.result_type === 'cloud' })), ms };
}

async function runAll(brains: Array<{ name: string; engine: PGLiteEngine }>, titleToSlug: Map<string, string>): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [n, q] of questions.entries()) {
    const t0 = performance.now();
    const hits = await queryHydra(conn, q.question, { sources: [sourceOf(q)], maxResults: k, timeoutMs: 15_000 });
    const cloudMs = performance.now() - t0;
    const cloud: Item[] = hits.map(h => ({ slug: h.slug, cloud: true }));
    rows.push(score(q, 'HydraDB alone', cloud, cloudMs));
    const wide = await queryHydra(conn, q.question, { maxResults: 100, timeoutMs: 15_000 });
    rows.push(score(q, 'HydraDB alone (unscoped top-100, source filtered locally)', wide.filter(h => h.sourceId === sourceOf(q)).map(h => ({ slug: h.slug, cloud: true })), 0));
    for (const { name, engine } of brains) {
      const bare = await queryOp(engine, q, false, titleToSlug);
      const built = await queryOp(engine, q, true, titleToSlug);
      rows.push(score(q, `${name} bare`, bare.items, bare.ms));
      rows.push(score(q, `${name} + HydraDB (primary)`, built.items, built.ms));
      rows.push(score(q, `${name} + HydraDB (reserve 30%)`, reserve(bare.items, cloud, 0.3), bare.ms + cloudMs));
      rows.push(score(q, `${name} + HydraDB (RRF fusion)`, fuse(bare.items, cloud), bare.ms + cloudMs));
    }
    if ((n + 1) % 10 === 0 || n + 1 === questions.length) log(`  scored ${n + 1}/${questions.length}`);
  }
  return rows;
}

function summarize(rows: Row[]) {
  const by = new Map<string, Row[]>();
  for (const r of rows) by.set(r.condition, [...(by.get(r.condition) ?? []), r]);
  return [...by].map(([condition, rs]) => {
    const ms = rs.map(r => r.ms).sort((a, b) => a - b);
    return {
      condition, n: rs.length,
      recall_any: +(rs.filter(r => r.recall_any).length / rs.length).toFixed(3),
      recall_all: +(rs.filter(r => r.recall_all).length / rs.length).toFixed(3),
      gold_session_recall: +(rs.reduce((n, r) => n + r.gold_found, 0) / rs.reduce((n, r) => n + r.gold_total, 0)).toFixed(3),
      questions_with_cloud_rows: rs.filter(r => r.cloud_rows > 0).length,
      gold_found_via_cloud: rs.reduce((n, r) => n + r.gold_via_cloud, 0),
      p50_ms: ms[Math.floor(ms.length / 2)], p95_ms: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))],
    };
  });
}

/** Paired per-question comparison on recall_any: questions only `b` answers vs only `a`. */
function paired(rows: Row[], a: string, b: string) {
  const get = (c: string) => new Map(rows.filter(r => r.condition === c).map(r => [r.question_id, r.recall_any]));
  const A = get(a), B = get(b);
  let gains = 0, losses = 0;
  for (const [id, x] of A) { const y = B.get(id); if (y && !x) gains++; if (!y && x) losses++; }
  return { from: a, to: b, gains, losses };
}

configureGateway({ embedding_model: 'openrouter:openai/text-embedding-3-small', embedding_dimensions: 1536, env: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY! } } as never);
const apiKey = process.env.HYDRA_DB_API_KEY!;
const database = arg('--database') ?? `gbrain_eval_lme_${randomBytes(4).toString('hex')}`;
const conn: HydraConnection = { database, apiKey };
log(`${questions.length} questions, local share ${localShare}, k=${k}, HydraDB database ${database}`);

const started = Date.now();
log('brain A: every session');
const a = await brain('a');
log('brain B: recent sessions only');
const b = await brain('b', recentPages);
const titleToSlug = new Map<string, string>();
const allPages = await a.executeRaw<{ slug: string; title: string; source_id: string }>('SELECT slug, title, source_id FROM pages WHERE deleted_at IS NULL');
for (const p of allPages) titleToSlug.set((p.title || p.slug).replace(/[\\/\x00-\x1f]/g, ' ').slice(0, 120), p.slug);

try {
  let mirrored: { sent: number; withheld: number } | null = null;
  let unindexed = 0;
  if (!reuse) {
    await hydraRequest(conn, 'POST', '/databases', { json: { database } }).catch((e) => { if (!(e instanceof HydraDBError && e.status === 409)) throw e; });
    for (let i = 0; ; i++) {
      const s = await hydraRequest<{ infra?: { ready_for_ingestion?: boolean } }>(conn, 'GET', '/databases/status', { query: { database } }).catch(() => null);
      if (s?.infra?.ready_for_ingestion) break;
      if (i > 60) throw new Error('database never became ready');
      await Bun.sleep(5_000);
    }
    await a.setConfig(HYDRADB_CONFIG.database, database);
    log('mirroring brain A to HydraDB');
    await patiently(() => mirrorBrain(a, conn));
  }
  // The listing trails ingestion: wait until it stops growing, then for every listed id to be searchable.
  let sent = await cloudIds(conn);
  for (let grew = true; grew;) {
    await Bun.sleep(60_000);
    const next = await cloudIds(conn);
    grew = next.length > sent.length;
    sent = next;
    log(`  HydraDB lists ${sent.length} of ${allPages.length} pages`);
  }
  mirrored = { sent: sent.length, withheld: allPages.length - sent.length };
  unindexed = await waitIndexed(conn, sent);
  for (const engine of [a, b]) await engine.setConfig(HYDRADB_CONFIG.database, database);
  const A = 'A (all sessions local)';
  const B = `B (recent ${Math.round(localShare * 100)}% local)`;
  const rows = await runAll([{ name: A, engine: a }, { name: B, engine: b }], titleToSlug);
  const report = {
    dataset: 'LongMemEval_s', ids: idsPath, questions: questions.length, sessions: allPages.length, local_share: localShare, k, database, mirrored, unindexed,
    elapsed_min: +((Date.now() - started) / 60000).toFixed(1),
    summary: summarize(rows),
    paired: [
      paired(rows, `${A} bare`, `${A} + HydraDB (primary)`), paired(rows, `${A} bare`, `${A} + HydraDB (RRF fusion)`),
      paired(rows, `${B} bare`, `${B} + HydraDB (primary)`), paired(rows, `${B} bare`, `${B} + HydraDB (reserve 30%)`),
      paired(rows, `${B} bare`, `${B} + HydraDB (RRF fusion)`), paired(rows, `${A} bare`, 'HydraDB alone'),
      paired(rows, `${A} bare`, `${B} + HydraDB (RRF fusion)`),
    ],
    rows,
  };
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.table(report.summary);
  console.table(report.paired);
} finally {
  if (!keep) await hydraRequest(conn, 'DELETE', '/databases', { query: { database } }).then(() => log(`deleted ${database}`), (e) => log(`delete failed: ${e.message}`));
  await a.disconnect();
  await b.disconnect();
}
