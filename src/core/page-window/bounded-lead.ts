/**
 * Large pages (Wave A): leads, snippets and synopses read a bounded prefix,
 * never the whole body. A helper that shows 160-240 characters of a page
 * (exact-slug and alias snippets, relational synopses, the reflex pointer
 * synopsis, the entity card summary, entity-name leads, think anchor rows)
 * reads at most BOUNDED_PREFIX_BYTES of the stored body (fan-out SQL selects
 * `left(compiled_truth, 65536)`), and sanitizes only that prefix
 * (boundedProjectedPrefix in document.ts).
 *
 * Withdrawals: the forget overlay only rewrites facts-fence rows, so a raw
 * prefix with no `gbrain:facts:begin` marker is already what the overlaid
 * body starts with. A prefix that holds a facts fence is replaced by the
 * prefix of the overlaid body, read once per page through the batched
 * snapshot read (the same overlay readPageSnapshot applies), so a withdrawn
 * world fact never shows in a lead. A page the snapshot read no longer
 * returns, or a snapshot read that fails, gets an empty lead (fail closed:
 * a lead is decoration, so the row stays and only its text is withheld).
 */
import type { BrainEngine } from '../engine.ts';
import { pageSnapshotKey } from '../page-snapshot-batch.ts';
import { safeSplitIndex } from '../text-safe.ts';
import { BOUNDED_PREFIX_BYTES, boundedProjectedPrefix } from './document.ts';

/** SQL for the bounded raw prefix a fan-out query selects instead of the whole column (fixed column names only). */
export function boundedPrefixSql(column: string): string {
  return `left(${column}, ${BOUNDED_PREFIX_BYTES})`;
}

/** The first `maxBytes` UTF-8 bytes of a raw body, cut on a code point; nothing is sanitized. */
export function boundedRawPrefix(body: string | null | undefined, maxBytes: number = BOUNDED_PREFIX_BYTES): string {
  if (typeof body !== 'string') return '';
  let prefix = body.length > maxBytes ? body.slice(0, safeSplitIndex(body, maxBytes)) : body;
  while (Buffer.byteLength(prefix, 'utf8') > maxBytes) {
    prefix = prefix.slice(0, safeSplitIndex(prefix, Math.floor(prefix.length * 0.9)));
  }
  return prefix;
}

/** Whether a raw prefix must be re-read with the withdrawal overlay before it is shown. */
export function prefixNeedsOverlay(prefix: string | null | undefined): boolean {
  return typeof prefix === 'string' && prefix.includes('gbrain:facts:begin');
}

/**
 * Bounds each row's `compiled_truth` to the raw prefix and, for rows whose
 * prefix holds a facts fence, replaces it with the prefix of the
 * withdrawal-overlaid body (one batched snapshot read for all of them).
 * Returns new row objects; the input rows are not mutated.
 */
export async function overlaidBoundedRows<T extends { slug: string; source_id: string; compiled_truth: string | null }>(
  engine: Pick<BrainEngine, 'readPageSnapshotsBatch'>,
  rows: readonly T[],
): Promise<T[]> {
  const bounded = rows.map(row => ({ ...row, compiled_truth: row.compiled_truth == null ? null : boundedRawPrefix(row.compiled_truth) }));
  const pending = [...new Map(bounded.filter(row => prefixNeedsOverlay(row.compiled_truth))
    .map(row => [pageSnapshotKey(row.source_id, row.slug), { slug: row.slug, sourceId: row.source_id }])).values()];
  if (pending.length === 0) return bounded;
  const overlaid = new Map<string, string>();
  try {
    for (let rest = pending; rest.length > 0;) {
      const batch = await engine.readPageSnapshotsBatch(rest);
      for (const [key, snapshot] of batch.snapshots) overlaid.set(key, boundedRawPrefix(snapshot.page.compiled_truth));
      rest = rest.slice(Math.max(1, batch.covered));
    }
  } catch {
    overlaid.clear();
  }
  return bounded.map(row => prefixNeedsOverlay(row.compiled_truth)
    ? { ...row, compiled_truth: overlaid.get(pageSnapshotKey(row.source_id, row.slug)) ?? '' }
    : row);
}

/** One page's overlaid raw prefix: the snapshot body when the raw prefix holds a facts fence, else the raw prefix. */
export async function overlaidBoundedPrefix(
  engine: Pick<BrainEngine, 'readPageSnapshotsBatch'>,
  page: { slug: string; source_id: string; compiled_truth: string | null },
): Promise<string> {
  const [row] = await overlaidBoundedRows(engine, [page]);
  return row?.compiled_truth ?? '';
}

/** One page's sanitized, credential-projected lead text: the bounded overlaid prefix through boundedProjectedPrefix. */
export async function projectedLead(
  engine: Pick<BrainEngine, 'readPageSnapshotsBatch'>,
  page: { slug: string; source_id: string; compiled_truth: string | null },
): Promise<string> {
  return boundedProjectedPrefix(await overlaidBoundedPrefix(engine, page));
}
