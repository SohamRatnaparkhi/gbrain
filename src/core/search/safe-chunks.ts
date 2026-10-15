import type { ChunkInput, PageReadScope } from '../types.ts';
import { jsonRowBatches } from '../batch-rows.ts';

/** First markdown index built from the strict full-body fence sanitizer. */
export const SAFE_FENCE_CHUNKER_VERSION = 4;

const PROTECTED_MARKER = '<!--- gbrain:(facts|takes):(begin|end) -->';

export function hasProtectedBody(text: string): boolean {
  return new RegExp(PROTECTED_MARKER).test(text);
}

/** Expression and aliases are internal SQL, never caller-supplied values. */
export function protectedTextFilter(expression: string): string {
  return `COALESCE(${expression}, '') ~ '${PROTECTED_MARKER}'`;
}

/** Fixed SQL aliases only. Check full bodies because fragments can lose markers. */
export function protectedBodyFilter(alias: string): string {
  return `(${protectedTextFilter(`${alias}.compiled_truth`)} OR ${protectedTextFilter(`${alias}.timeline`)})`;
}

/** A body-only write cannot certify old fragments, even after fence removal. */
export function bodyWriteChunkVersion(compiledTruth: string, timeline: string): string {
  return `CASE WHEN pages.compiled_truth IS NOT DISTINCT FROM ${compiledTruth}
    AND pages.timeline IS NOT DISTINCT FROM ${timeline} THEN pages.chunker_version
    WHEN pages.chunker_version < 0 OR ${protectedBodyFilter('pages')}
      OR ${protectedTextFilter(compiledTruth)} OR ${protectedTextFilter(timeline)} THEN -1
    ELSE LEAST(COALESCE(pages.chunker_version, 0), ${SAFE_FENCE_CHUNKER_VERSION - 1}) END`;
}

export function requiresSafeChunks(scope?: PageReadScope): boolean {
  return scope?.requireSafeChunks ?? scope?.excludePrivate ?? false;
}

/** Every user sees projections only from the current canonical revision. */
export function currentTextProjectionFilter(alias: string): string {
  return `(${alias}.text_projection_revision = ${alias}.knowledge_revision) IS TRUE`;
}

/** A page of any kind chunked before the fence; remote reads withhold it until it is re-sealed. */
export function belowSafeChunkFence(chunkerVersion: number | null | undefined): boolean {
  return (chunkerVersion ?? 0) < SAFE_FENCE_CHUNKER_VERSION;
}

/** Older fragments lack trustworthy provenance, even if markers were removed later. */
export function safeChunksFilter(alias: string): string {
  return `COALESCE(${alias}.chunker_version, 0) >= ${SAFE_FENCE_CHUNKER_VERSION}`;
}

/**
 * Preserve an existing seal for an embedding-only refresh of the exact chunk
 * snapshot. Additions, removals and textual metadata changes invalidate before
 * the first mutation, including partial failures outside an import transaction.
 * Both engines canonicalize chunk_text before calling, and persist/hash those
 * same bytes. Identity and enum fields retain their existing rejection policy.
 *
 * One statement per encoded batch of the incoming set (`jsonRowBatches`), so a
 * large page is compared without one whole-page JSON document; each statement
 * also checks for stored chunks missing from the complete incoming index set.
 * The caller stops at the first statement that invalidates (RETURNING id).
 */
export function* chunkWriteInvalidations(pageId: number, chunks: ChunkInput[]): Generator<{ sql: string; params: unknown[] }> {
  const metadata = ['language', 'symbol_name', 'symbol_type', 'start_line', 'end_line', 'parent_symbol_path', 'doc_comment', 'symbol_name_qualified'] as const;
  const sql = `UPDATE pages SET chunker_version = -1 WHERE id = $1 AND (
      NOT (${safeChunksFilter('pages')})
      OR EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = $1 AND cc.chunk_index <> ALL($3::int[]))
      OR EXISTS (
        SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) AS incoming(
          chunk_index int, chunk_text text, chunk_source text, modality text,
          language text, symbol_name text, symbol_type text, start_line int,
          end_line int, parent_symbol_path text[], doc_comment text, symbol_name_qualified text)
        LEFT JOIN content_chunks cc ON cc.page_id = $1 AND cc.chunk_index = incoming.chunk_index
        WHERE cc.id IS NULL
          OR cc.chunk_text IS DISTINCT FROM incoming.chunk_text
          OR cc.chunk_source IS DISTINCT FROM incoming.chunk_source
          OR cc.modality IS DISTINCT FROM COALESCE(incoming.modality, 'text')
          ${metadata.map(key => `OR cc.${key} IS DISTINCT FROM COALESCE(incoming.${key}, cc.${key})`).join('\n          ')}
      )) RETURNING id`;
  const indices = chunks.map(chunk => chunk.chunk_index);
  const batches = jsonRowBatches(chunks, chunk => Object.fromEntries(
    ['chunk_index', 'chunk_text', 'chunk_source', 'modality', ...metadata].map(key => [key, chunk[key as keyof ChunkInput] ?? null])));
  let sent = false;
  for (const batch of batches) {
    sent = true;
    yield { sql, params: [pageId, batch, indices] };
  }
  if (!sent) yield { sql, params: [pageId, '[]', indices] };
}

/**
 * A stored row whose vector provably describes its own text (#4246), the only
 * rows a content-keyed rebuild moves to a new index. `col` is a quoted column.
 */
export function movableChunkSql(col: string): string {
  return `(${col} IS NOT NULL AND embedded_text_hash IS NOT DISTINCT FROM md5(chunk_text))`;
}
