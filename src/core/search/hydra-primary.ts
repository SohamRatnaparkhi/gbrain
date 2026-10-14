/**
 * HydraDB as this brain's search backend (`gbrain cloud primary on`, set by
 * connect): `hybridSearchCached` returns HydraDB's ranking instead of the
 * local pipeline's.
 *
 * Each hit resolves to this brain's own page row under the caller's full read
 * policy (pageReadFilter + buildVisibilityClause: source, private, safe chunks,
 * trust, deleted, archived, quarantine), anchored on the page chunk its passage
 * overlaps most, so every later stage reads a normal row. A hit for a page this
 * brain does not hold (another device's) becomes a `cloud` row unless the
 * caller has a trust floor; a held page the caller may not read is dropped.
 * Filters HydraDB cannot apply, and any HydraDB error or slow answer, return
 * null: the caller searches locally.
 */
import type { BrainEngine } from '../engine.ts';
import type { PageType, SearchResult } from '../types.ts';
import { isConfigTruthy } from '../config.ts';
import { warnOncePerProcess } from '../utils.ts';
import { HYDRADB_CONFIG, queryHydra, resolveHydraConnection, type HydraConnection } from '../hydradb.ts';
import { pageKey, pageReadability, pageReadFilter } from './read-policy-sql.ts';
import { buildVisibilityClause } from './sql-ranking.ts';
import type { HybridSearchOpts } from './hybrid.ts';
import { UNTIMED } from './stage-timings.ts';

const PRIMARY_TIMEOUT_MS = 2_500;

/** Options that narrow results in ways HydraDB's query cannot express. */
const LOCAL_ONLY_OPTS = ['offset', 'type', 'types', 'exclude_slugs', 'exclude_slug_prefixes', 'include_slug_prefixes', 'language',
  'symbolKind', 'nearSymbol', 'afterDate', 'beforeDate', 'since', 'until', 'embeddingColumn'] as const;

interface ChunkRow { page_id: number; slug: string; source_id: string; title: string; type: string;
  chunk_id: number; chunk_index: number; chunk_text: string; chunk_source: SearchResult['chunk_source'] }

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

async function readableChunks(engine: BrainEngine, refs: Array<{ sourceId: string; slug: string }>, opts: HybridSearchOpts | undefined): Promise<Map<string, ChunkRow[]>> {
  const params: unknown[] = [refs.map(r => r.sourceId), refs.map(r => r.slug)];
  const filter = pageReadFilter('p', opts, params);
  const rows = await engine.executeRaw<ChunkRow>(
    `SELECT p.id AS page_id, p.slug, p.source_id, p.title, p.type, cc.id AS chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source
     FROM pages p
     JOIN sources s ON s.id = p.source_id
     JOIN unnest($1::text[], $2::text[]) AS refs(source_id, slug) ON p.source_id = refs.source_id AND p.slug = refs.slug
     JOIN content_chunks cc ON cc.page_id = p.id AND cc.chunk_source IN ('compiled_truth', 'timeline')
     WHERE ${filter} ${buildVisibilityClause('p', 's', { excludePrivate: opts?.excludePrivate, requireSafeChunks: opts?.requireSafeChunks, minTrust: opts?.minTrust, suppressFlagged: opts?.suppressFlagged })}`,
    params);
  const byPage = new Map<string, ChunkRow[]>();
  for (const row of rows) byPage.set(pageKey(row.source_id, row.slug), [...(byPage.get(pageKey(row.source_id, row.slug)) ?? []), row]);
  return byPage;
}

export async function hydraPrimarySearch(engine: BrainEngine, query: string, opts: HybridSearchOpts | undefined, limit: number): Promise<SearchResult[] | null> {
  if (LOCAL_ONLY_OPTS.some(k => { const v = opts?.[k]; return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== 0 && v !== ''; })
    || opts?.crossModal === 'image') return null;
  if (!isConfigTruthy(await engine.getConfig(HYDRADB_CONFIG.primary))) return null;
  const conn = await resolveHydraConnection(engine);
  if (!conn) return null;
  return (opts?._timings ?? UNTIMED).stage('hydradb', () => rankFromHydra(engine, conn, query, opts, limit));
}

async function rankFromHydra(engine: BrainEngine, conn: HydraConnection, query: string, opts: HybridSearchOpts | undefined, limit: number): Promise<SearchResult[] | null> {
  try {
    const sources = opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : undefined);
    const hits = (await queryHydra(conn, query, { sources, maxResults: limit * 2, timeoutMs: PRIMARY_TIMEOUT_MS }))
      .filter(h => !sources || sources.includes(h.sourceId));
    const held = await pageReadability(engine, hits.map(h => ({ slug: h.slug, source_id: h.sourceId })), opts);
    const chunks = await readableChunks(engine, hits, opts);
    const seen = new Set<string>();
    const rows: SearchResult[] = [];
    for (const hit of hits) {
      const key = pageKey(hit.sourceId, hit.slug);
      const candidates = chunks.get(key);
      if (candidates) {
        const passage = words(hit.text);
        const best = candidates.map(c => ({ c, n: [...words(c.chunk_text)].filter(w => passage.has(w)).length })).reduce((a, b) => (b.n > a.n ? b : a)).c;
        if (seen.has(`${best.chunk_id}`)) continue;
        seen.add(`${best.chunk_id}`);
        rows.push({ slug: best.slug, page_id: best.page_id, title: best.title, type: best.type as PageType, chunk_text: best.chunk_text,
          chunk_source: best.chunk_source, chunk_id: best.chunk_id, chunk_index: best.chunk_index, score: 0, stale: false, source_id: best.source_id });
      } else if (!held.has(key) && !opts?.minTrust && !seen.has(key)) {
        seen.add(key);
        rows.push({ result_type: 'cloud', slug: `cloud/${hit.slug}`, page_id: 0, title: hit.title, type: 'note', chunk_text: hit.text,
          chunk_source: 'compiled_truth', chunk_id: 0, chunk_index: 0, score: 0, stale: false, source_id: hit.sourceId } as SearchResult);
      }
      if (rows.length >= limit) break;
    }
    rows.forEach((r, i) => { r.score = 1 / (i + 1); });
    opts?.onMeta?.({ vector_enabled: false, detail_resolved: opts.detail ?? null, expansion_applied: false, degraded: [], retrieved_count: rows.length });
    return rows;
  } catch (e) {
    warnOncePerProcess('hydradb-primary-fallback', `[gbrain] HydraDB search unavailable (${(e as Error).message}); searching this brain locally.`);
    return null;
  }
}
