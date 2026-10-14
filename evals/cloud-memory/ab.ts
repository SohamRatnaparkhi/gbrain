/** Live LongMemEval comparison through the shipped query operation. See README.md. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { LongMemEvalQuestion } from '../../src/eval/longmemeval/adapter.ts';
import type { SearchResult } from '../../src/core/types.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const datasetPath = arg('--dataset'), idsPath = arg('--ids'), out = arg('--out');
if (!datasetPath || !idsPath || !out || !process.env.HYDRA_DB_API_KEY || !process.env.OPENROUTER_API_KEY) {
  throw new Error('Provide --dataset, --ids and --out; set HYDRA_DB_API_KEY and OPENROUTER_API_KEY. Only the selected public benchmark corpus is uploaded.');
}
const k = Number(arg('--k') ?? 10), share = Number(arg('--local-share') ?? 0.3), repeats = Number(arg('--repeats') ?? 3);
if (!Number.isInteger(k) || k < 1 || !Number.isInteger(repeats) || repeats < 1 || share <= 0 || share >= 1) throw new Error('Invalid k, repeats or local-share.');
let bytes = readFileSync(datasetPath);
const datasetHash = createHash('sha256').update(bytes).digest('hex');
const wanted = readFileSync(idsPath, 'utf8').trim().split(/\s+/);
const dataset = JSON.parse(bytes.toString()) as LongMemEvalQuestion[];
const questions = wanted.map(id => dataset.find(q => q.question_id === id));
if (new Set(wanted).size !== wanted.length || questions.some(q => !q)) throw new Error('Every unique selected id must exist in the dataset.');
// Retain only the selected complete haystacks, not the 277 MB dataset and its parsed copy.
const selected = JSON.parse(JSON.stringify(questions)) as LongMemEvalQuestion[];
dataset.length = 0; questions.length = 0; bytes = Buffer.alloc(0);
const workspace = arg('--work-dir');
if (workspace) {
  mkdirSync(workspace, { recursive: true });
  const manifest = join(workspace, 'manifest.json');
  const identity = JSON.stringify({ dataset_sha256: datasetHash, ids: wanted, share, embedding_model: 'openrouter:openai/text-embedding-3-small' });
  if (existsSync(manifest) && readFileSync(manifest, 'utf8') !== identity) throw new Error('Existing work-dir contains a different benchmark corpus or embedding configuration.');
  writeFileSync(manifest, identity);
}
const scratch = mkdtempSync(join(tmpdir(), 'gbrain-hydra-benchmark-'));
process.env.GBRAIN_HOME = scratch; process.env.GBRAIN_NON_INTERACTIVE = '1';
const key = process.env.HYDRA_DB_API_KEY;
delete process.env.HYDRA_DB_API_KEY; // Importing local fixtures must not schedule background cloud writes.
const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { configureGateway, embedQuery } = await import('../../src/core/ai/gateway.ts');
const { importFromContent } = await import('../../src/core/import-file.ts');
const { runEmbedCore } = await import('../../src/commands/embed.ts');
const { dispatchToolCall } = await import('../../src/mcp/dispatch.ts');
const { HYDRADB_CONFIG, hydraRequest, HydraDBError } = await import('../../src/core/hydradb.ts');
const { mirrorBrain } = await import('../../src/core/hydradb-mirror.ts');
const { haystackToPages } = await import('../../src/eval/longmemeval/adapter.ts');
const { buildSlugToRawMap, scoreRecall } = await import('../../src/eval/longmemeval/metrics.ts');
const { drainAllBackgroundWorkForCliExit } = await import('../../src/core/background-work.ts');
const embeddingModel = 'openrouter:openai/text-embedding-3-small';
configureGateway({ embedding_model: embeddingModel, embedding_dimensions: 1536,
  env: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } } as never);
const sourceOf = (q: LongMemEvalQuestion) => 'lme-' + createHash('sha256').update(q.question_id).digest('hex').slice(0, 20);
const a = new PGLiteEngine(), b = new PGLiteEngine();
const conn = { database: 'gbrain_bench_' + randomUUID().replaceAll('-', '').slice(0, 12), apiKey: key, baseUrl: process.env.HYDRA_DB_BASE_URL };
const logger = { info() {}, warn() {}, error() {} };
const log = (message: string) => console.error(`[benchmark] ${message}`);
interface Row { question_id: string; question_type: string; condition: string; repeat: number; backend: string;
  recall_any: boolean; recall_all: boolean; gold_found: number; gold_total: number; latency_ms: number; returned: number; degraded: unknown }
const rows: Row[] = [];
let created = false, pages = 0, partialPages = 0;
const started = Date.now();
try {
  await embedQuery('A synthetic benchmark authentication probe.'); // fail before loading the corpus if the baseline key is unusable
  for (const [name, engine] of [['a', a], ['b', b]] as const) { await engine.connect(workspace ? { database_path: join(workspace, name) } : {}); await engine.initSchema(); }
  for (const [i, q] of selected.entries()) {
    const sourceId = sourceOf(q), sessions = haystackToPages(q);
    const recent = new Set(sessions.map((p, n) => ({ slug: p.slug, date: q.haystack_dates?.[n] ?? String(n).padStart(6, '0') }))
      .sort((x, y) => x.date.localeCompare(y.date)).slice(-Math.max(1, Math.ceil(sessions.length * share))).map(p => p.slug));
    for (const engine of [a, b]) await engine.executeRaw('INSERT INTO sources(id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [sourceId]);
    for (const p of sessions) {
      if (!await a.getPage(p.slug, { sourceId })) await importFromContent(a, p.slug, p.content, { sourceId, noEmbed: true }); pages++;
      if (recent.has(p.slug)) { if (!await b.getPage(p.slug, { sourceId })) await importFromContent(b, p.slug, p.content, { sourceId, noEmbed: true }); partialPages++; }
    }
    log(`Imported ${i + 1}/${selected.length} questions (${pages} full, ${partialPages} recent-session pages).`);
  }
  for (const [name, engine] of [['full', a], ['recent', b]] as const) {
    log(`Embedding ${name} local brain using ${embeddingModel}.`);
    const result = await runEmbedCore(engine, { stale: true });
    log(`Embedding receipt: ${JSON.stringify(result)}`);
    const [coverage] = await engine.executeRaw<{ total: number; embedded: number }>(
      'SELECT count(*)::int AS total, count(embedding)::int AS embedded FROM content_chunks');
    if (!coverage || !coverage.total || coverage.total !== coverage.embedded) throw new Error('Incomplete local embeddings; refusing an unfair keyless baseline.');
  }
  await drainAllBackgroundWorkForCliExit();
  process.env.HYDRA_DB_API_KEY = key;
  await hydraRequest(conn, 'POST', '/databases', { json: { database: conn.database } }); created = true;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const r = await hydraRequest<{ infra?: { ready_for_ingestion?: boolean } }>(conn, 'GET', '/databases/status', { query: { database: conn.database } });
    if (r.infra?.ready_for_ingestion) break;
    if (Date.now() > deadline) throw new Error('HydraDB database provisioning timed out.');
    await Bun.sleep(1000);
  }
  if (workspace) writeFileSync(join(workspace, 'live-cloud.json'), JSON.stringify({ database: conn.database, base_url: conn.baseUrl, created_at: new Date().toISOString() }));
  log(`Mirroring ${pages} pages into a disposable database; waiting for indexed completion.`);
  const originalFetch = globalThis.fetch; let statusPolls = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const at = performance.now(), url = new URL(String(input));
    try { const response = await originalFetch(input as string, init);
      if (url.pathname === '/context/status' && ++statusPolls % 10 === 0) {
        const body = await response.clone().json() as { data?: { statuses?: Array<{ indexing_status: string; error_code?: string }> } };
        const statuses = body.data?.statuses ?? [];
        log('Index states: ' + JSON.stringify(Object.fromEntries([...new Set(statuses.map(s => s.indexing_status))].map(state => [state, statuses.filter(s => s.indexing_status === state).length]))));
        const codes = statuses.map(s => s.error_code).filter(c => typeof c === 'string' && /^[A-Z][A-Z0-9_-]{0,31}$/.test(c)); if (codes.length) log('Index error codes: ' + JSON.stringify([...new Set(codes)]));
      }
      if (url.hostname.endsWith('.hydradb.com')) log(`${init?.method ?? 'GET'} ${url.pathname}: ${response.status}, ${Math.round(performance.now() - at)}ms`); return response; }
    catch (error) { if (url.hostname.endsWith('.hydradb.com')) log(`${init?.method ?? 'GET'} ${url.pathname} failed after ${Math.round(performance.now() - at)}ms`); throw error; }
  }) as typeof fetch;
  const mirrored = await mirrorBrain(a, conn, { full: true, progress: { start() {}, tick(n: number) { log(`Indexed another ${n} pages.`); }, finish() {} } as never });
  if (mirrored.upserted !== pages || mirrored.skipped) throw new Error(`Incomplete cloud backfill: ${JSON.stringify(mirrored)}`);
  for (const engine of [a, b]) {
    await engine.setConfig(HYDRADB_CONFIG.database, conn.database);
    if (conn.baseUrl) await engine.setConfig(HYDRADB_CONFIG.baseUrl, conn.baseUrl);
  }
  const titleMaps = new Map<PGLiteEngine, Map<string, string>>();
  // Cloud-only hits keep the mirror title; resolve it through the full corpus, never through gold labels.
  const titleMap = new Map<string, string>();
  for (const page of await a.executeRaw<{ title: string; slug: string }>('SELECT title, slug FROM pages')) {
    titleMap.set((page.title || page.slug).replace(/[\\/\x00-\x1f]/g, ' ').slice(0, 120), page.slug);
  }
  titleMaps.set(a, titleMap); titleMaps.set(b, titleMap);
  for (const [i, q] of selected.entries()) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const arms = [{ condition: 'Full local · GBrain hybrid', engine: a, cloud: false },
        { condition: 'Full local · HydraDB fast', engine: a, cloud: true },
        { condition: `Recent ${Math.round(share * 100)}% local · GBrain hybrid`, engine: b, cloud: false },
        { condition: `Recent ${Math.round(share * 100)}% local · HydraDB fast`, engine: b, cloud: true }];
      if ((i + repeat) % 2) arms.reverse(); // balance which backend warms first
      for (const arm of arms) {
        await arm.engine.setConfig(HYDRADB_CONFIG.primary, String(arm.cloud));
        const t0 = performance.now();
        const r = await dispatchToolCall(arm.engine, 'query', { query: q.question, source_id: sourceOf(q), limit: k,
          expand: false, use_cache: false, autocut: false, fields: 'full', snippet_chars: 0 },
          { remote: false, transport: 'http', sourceId: sourceOf(q), config: { engine: 'pglite' } as never, logger });
        const latency = performance.now() - t0;
        if (r.isError) throw new Error(`query failed: ${r.content[0]?.text}`);
        const hits = JSON.parse(r.content[0]!.text) as SearchResult[];
        const meta = r._meta?.retrieval as { backend?: string; vector_enabled?: boolean; degraded?: unknown } | undefined;
        if (!arm.cloud && !meta?.vector_enabled) throw new Error('Local baseline did not use vector retrieval.');
        const map = buildSlugToRawMap(q);
        const raw = hits.slice(0, k).flatMap(h => map.get(h.slug?.replace(/^cloud\//, '') ?? '') ?? map.get(titleMaps.get(arm.engine)!.get(h.title) ?? '') ?? []);
        const score = scoreRecall(raw, q.answer_session_ids, k);
        rows.push({ question_id: q.question_id, question_type: q.question_type, condition: arm.condition, repeat,
          backend: meta?.backend ?? 'local', recall_any: score.recall_any_hit, recall_all: score.recall_all_hit,
          gold_found: score.gold_found, gold_total: score.gold_total, latency_ms: Math.round(latency), returned: hits.length, degraded: meta?.degraded ?? [] });
      }
    }
    log(`Scored ${i + 1}/${selected.length} questions.`);
  }
  const conditions = [...new Set(rows.map(r => r.condition))];
  const summary = conditions.map(condition => {
    const rs = rows.filter(r => r.condition === condition), first = rs.filter(r => r.repeat === 0);
    const times = rs.map(r => r.latency_ms).sort((x, y) => x - y);
    return { condition, questions: first.length, measurements: rs.length,
      recall_any_at_k: first.filter(r => r.recall_any).length / first.length,
      recall_all_at_k: first.filter(r => r.recall_all).length / first.length,
      gold_session_recall: first.reduce((n, r) => n + r.gold_found, 0) / first.reduce((n, r) => n + r.gold_total, 0),
      p50_ms: times[Math.floor(times.length / 2)], p95_ms: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))],
      cloud_fallbacks: rs.filter(r => condition.includes('HydraDB') && r.backend !== 'hydradb').length };
  });
  writeFileSync(out, JSON.stringify({ dataset: 'LongMemEval_s cleaned', dataset_sha256: datasetHash,
    selected_ids: wanted, question_types: Object.fromEntries([...new Set(selected.map(q => q.question_type))].map(type => [type, selected.filter(q => q.question_type === type).length])),
    k, repeats, local_share: share, full_pages: pages, recent_pages: partialPages, embedding_model: embeddingModel,
    hydradb_mode: 'fast', query_expansion: false, semantic_cache: false, reader_accuracy_measured: false,
    elapsed_seconds: Math.round((Date.now() - started) / 1000), mirror: mirrored, summary, rows }, null, 2) + '\n');
  console.table(summary);
} finally {
  await drainAllBackgroundWorkForCliExit();
  if (created) await hydraRequest(conn, 'DELETE', '/databases', { query: { database: conn.database } });
  if (workspace) rmSync(join(workspace, 'live-cloud.json'), { force: true });
  await a.disconnect(); await b.disconnect(); rmSync(scratch, { recursive: true, force: true });
}
