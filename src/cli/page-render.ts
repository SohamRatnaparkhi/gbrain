/**
 * Large pages (Wave A): how `gbrain get` renders get_page, locally and over
 * the thin client.
 *
 * A whole page prints as its markdown, as it always has. A partial response
 * (body none / outline / window) prints only what it carries, and says on
 * stderr that it is partial and how to read on, so `gbrain get > file` never
 * writes part of a page as if it were all of it.
 *
 * The thin client asks for the whole page. A host that cannot send it in one
 * response refuses with page_too_large_for_inline; the client then pages the
 * round-trip markdown (view: 'markdown') to its end, checks the total size and
 * sha256 the host reported, and prints it, or fails without printing.
 */
import { createHash } from 'node:crypto';
import { serializeMarkdown } from '../core/markdown.ts';

/** Window size the thin client asks for while paging a whole page. */
export const REMOTE_PAGE_WINDOW_BYTES = 512 * 1024;
const MAX_RESTARTS = 3;

type GetPageResult = Record<string, any>;

function partialNote(r: GetPageResult): string {
  const size = r.size ?? {};
  const total = typeof size.total_bytes === 'number' ? `${size.total_bytes} bytes` : 'unknown size';
  if (r.window && typeof r.window.byte_start === 'number') {
    const next = r.next_cursor ? ` Read on: gbrain get ${r.slug} --cursor ${r.next_cursor}` : '';
    return `[gbrain] partial page: bytes ${r.window.byte_start}-${r.window.byte_end} of ${total} (lines ${r.window.line_start}-${r.window.line_end}).${next}`;
  }
  return `[gbrain] partial page (${r.body}, ${total}): no page body was printed. Whole page: gbrain get ${r.slug} --body full`;
}

function renderOutline(r: GetPageResult): string {
  const o = r.outline;
  const lines = [`# ${r.title ?? r.slug} — ${r.size?.total_bytes ?? '?'} bytes, ${r.size?.total_lines ?? '?'} lines, revision ${r.revision}`];
  for (const e of o?.entries ?? []) {
    const label = e.heading !== undefined ? `${'#'.repeat(e.level ?? 1)} ${e.heading ?? '(before first heading)'}` : e.first_line ?? '';
    const dates = e.date_min ? ` [${e.date_min}${e.date_max && e.date_max !== e.date_min ? `..${e.date_max}` : ''}]` : '';
    lines.push(`L${e.line_start}-${e.line_end}\t${e.byte_end - e.byte_start}B\t${label}${dates}`);
  }
  if (o?.next_from_index !== undefined) lines.push(`… ${o.total_entries - o.next_from_index} more entries: --outline-from ${o.next_from_index}`);
  return lines.join('\n') + '\n';
}

/** stdout text for one get_page result; partial responses add a stderr note. */
export function formatGetPage(r: GetPageResult): string {
  if (r.error === 'ambiguous_slug') {
    return `Ambiguous slug. Did you mean:\n${r.candidates.map((c: string) => `  ${c}`).join('\n')}\n`;
  }
  if (typeof r.body !== 'string') {
    return serializeMarkdown(r.frontmatter || {}, r.compiled_truth || '', r.timeline || '', { type: r.type, title: r.title, tags: r.tags || [] });
  }
  process.stderr.write(partialNote(r) + '\n');
  if (r.window) return r.window.text;
  if (r.outline) return renderOutline(r);
  return `revision: ${r.revision}\nsize: ${r.size?.total_bytes ?? '?'} bytes, ${r.size?.total_lines ?? '?'} lines\n` +
    (r.chunks ? `chunks: ${r.chunks.total} (${r.chunks.embedded} embedded)\n` : '');
}

/** The canonical code of a tool error: a thin-client RemoteMcpError's detail, or an in-process OperationError (a legacy wire value moves the code to canonical). */
export function remoteErrorCode(e: unknown): string | undefined {
  const err = e as { detail?: { code?: string; canonical_code?: string }; canonical?: string; code?: unknown } | null;
  if (err?.detail && typeof err.detail === 'object') return err.detail.canonical_code ?? err.detail.code;
  return err?.canonical ?? (typeof err?.code === 'string' ? err.code : undefined);
}

/** True when a get_page call named no body mode, selector or round-trip flag: the caller wants the page as it is. */
export function wantsWholePage(params: Record<string, unknown>): boolean {
  return ['body', 'lines', 'bytes', 'around_chunk_id', 'cursor', 'include_content', 'content_only'].every(k => params[k] === undefined);
}

/**
 * Page a whole page's round-trip markdown through windows. Restarts from the
 * top when the page changes mid-read; throws rather than return a short or
 * unverified body.
 */
export async function readWholePageMarkdown(
  call: (params: Record<string, unknown>) => Promise<GetPageResult>,
  params: Record<string, unknown>,
): Promise<{ markdown: string; revision: string; windows: number }> {
  const base = { slug: params.slug, ...(params.source_id !== undefined ? { source_id: params.source_id } : {}), body: 'window', view: 'markdown' };
  for (let attempt = 0; attempt <= MAX_RESTARTS; attempt++) {
    const parts: Buffer[] = [];
    let r = await call({ ...base, max_bytes: REMOTE_PAGE_WINDOW_BYTES });
    const { revision, size } = r;
    let windows = 1;
    let changed = false;
    for (;;) {
      if (!r.window || typeof r.window.byte_start !== 'number' || !size || typeof size.sha256 !== 'string') {
        throw new Error(`get_page did not return a markdown window for ${String(params.slug)}; the page was not printed.`);
      }
      parts.push(Buffer.from(r.window.text, 'utf8'));
      if (!r.next_cursor) break;
      try {
        r = await call({ ...base, cursor: r.next_cursor });
      } catch (e) {
        if (remoteErrorCode(e) !== 'revision_changed') throw e;
        changed = true;
        break;
      }
      if (r.revision !== revision) { changed = true; break; }
      windows++;
    }
    if (changed) continue;
    const whole = Buffer.concat(parts);
    if (whole.length !== size.total_bytes || createHash('sha256').update(whole).digest('hex') !== size.sha256) {
      throw new Error(`The paged copy of ${String(params.slug)} does not match the size and sha256 the host reported; the page was not printed.`);
    }
    return { markdown: whole.toString('utf8'), revision, windows };
  }
  throw new Error(`${String(params.slug)} kept changing while it was being read (${MAX_RESTARTS + 1} attempts); the page was not printed. Try again.`);
}
