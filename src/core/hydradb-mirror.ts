/**
 * Mirror the brain into its connected HydraDB database (hydradb.ts).
 *
 * What leaves the machine is exactly what gbrain already hands an embedding
 * provider: the page's fence-aware chunk projection (markdown-chunks.ts), so
 * private fact rows, held fence rows and private keys are gone, and
 * embed-skipped or quarantined pages project to nothing; secrets the scanner
 * finds are redacted on top. A private page or an empty projection is removed
 * from the cloud instead, as is every page soft-deleted since the last run.
 *
 * Pages walk the `(updated_at, slug)` keyset behind the delta commit-lag
 * horizon; the cursor advances after each batch lands, so an interrupted or
 * failed run resumes where it stopped. Bound: a page soft-deleted and then
 * purged (72h) while every run failed stays in the cloud until
 * `gbrain cloud disconnect --purge-cloud`.
 */

import type { BrainEngine } from './engine.ts';
import type { Page } from './types.ts';
import type { ProgressReporter } from './progress.ts';
import { horizonIso, toMicroIso } from './context/delta-cursor.ts';
import { prepareFenceAwareMarkdownChunks } from './markdown-chunks.ts';
import { isPrivatePage } from './search/private-visibility.ts';
import { redactFindings } from './secret-scan.ts';
import { HYDRADB_CONFIG, hydraDocId, hydraDocMetadata, hydraRequest, resolveHydraConnection, type HydraConnection } from './hydradb.ts';
import { pageKey } from './search/read-policy-sql.ts';
import { registerBackgroundWorkDrainer } from './background-work.ts';

const BATCH = 50;
/** HydraDB rejects the whole ingest request when one item's additional_metadata exceeds 1 KiB. */
const MAX_METADATA_BYTES = 1024;

export interface MirrorReport {
  upserted: number;
  removed: number;
  /** Pages whose identity is too long for HydraDB metadata; never mirrored. */
  skipped: number;
}

interface PageRef { source_id: string; slug: string }

/**
 * The text gbrain would embed for `page`, minus code-fence chunks that repeat
 * the prose, with every secret the scanner finds redacted: unlike an embedding
 * call, the cloud keeps the text (same rule as the Memorable relay).
 */
async function projection(engine: BrainEngine, page: Page): Promise<string> {
  if (isPrivatePage(page)) return '';
  const chunks = await prepareFenceAwareMarkdownChunks(engine, page.source_id, page.slug, page);
  const text = chunks.filter((c) => c.chunk_source !== 'fenced_code').map((c) => c.chunk_text).join('\n\n').trim();
  return redactFindings(text, { highEntropy: true }).text;
}

/**
 * Pages go up as markdown files: HydraDB chunks a file's text, while an
 * `app_knowledge` item of a type it has no connector parser for is chunked as
 * its serialized JSON. The title leads the body because files carry none.
 */
async function ingest(conn: HydraConnection, pages: Array<{ page: Page; text: string }>): Promise<void> {
  if (!pages.length) return;
  const form = new FormData();
  form.set('type', 'knowledge');
  form.set('database', conn.database);
  form.set('upsert', 'true');
  for (const { page, text } of pages) {
    const title = page.title || page.slug;
    form.append('documents', new Blob([`# ${title}\n\n${text}\n`], { type: 'text/markdown' }), `${title.replace(/[\\/\x00-\x1f]/g, ' ').slice(0, 120)}.md`);
  }
  form.set('document_metadata', JSON.stringify(pages.map(({ page }) => ({
    id: hydraDocId(page.source_id, page.slug),
    additional_metadata: hydraDocMetadata(page.source_id, page.slug),
  }))));
  await hydraRequest(conn, 'POST', '/context/ingest', { form });
}

async function remove(conn: HydraConnection, refs: PageRef[]): Promise<void> {
  if (!refs.length) return;
  await hydraRequest(conn, 'DELETE', '/context', {
    json: { database: conn.database, type: 'knowledge', ids: refs.map((r) => hydraDocId(r.source_id, r.slug)) },
  });
}

/** Upload each page's projection, or remove the page from the cloud when it projects to nothing. */
async function sync(engine: BrainEngine, conn: HydraConnection, pages: Page[], report: MirrorReport): Promise<void> {
  const upserts: Array<{ page: Page; text: string }> = [];
  const removals: PageRef[] = [];
  for (const page of pages) {
    if (Buffer.byteLength(JSON.stringify(hydraDocMetadata(page.source_id, page.slug))) > MAX_METADATA_BYTES) {
      report.skipped++;
      continue;
    }
    const text = await projection(engine, page);
    if (text) upserts.push({ page, text });
    else removals.push(page);
  }
  await ingest(conn, upserts);
  await remove(conn, removals);
  report.upserted += upserts.length;
  report.removed += removals.length;
}

export async function mirrorBrain(engine: BrainEngine, conn: HydraConnection,
  opts: { full?: boolean; progress?: ProgressReporter; signal?: AbortSignal } = {}): Promise<MirrorReport> {
  const report: MirrorReport = { upserted: 0, removed: 0, skipped: 0 };
  const horizon = horizonIso();

  const deletedSince = await engine.getConfig(HYDRADB_CONFIG.deletedSince);
  if (deletedSince) {
    const gone = await engine.executeRaw<PageRef>(
      `SELECT source_id, slug FROM pages WHERE deleted_at > $1::text::timestamptz AND deleted_at <= $2::text::timestamptz`,
      [deletedSince, horizon]);
    for (let i = 0; i < gone.length; i += BATCH) await remove(conn, gone.slice(i, i + BATCH));
    report.removed += gone.length;
  }
  await engine.setConfig(HYDRADB_CONFIG.deletedSince, horizon);

  const saved = opts.full ? null : await engine.getConfig(HYDRADB_CONFIG.pagesCursor);
  let cursor = saved ? JSON.parse(saved) as { updatedAt: string; slug: string } : null;
  opts.progress?.start('cloud.mirror');
  for (;;) {
    opts.signal?.throwIfAborted();
    const pages = await engine.listPages({ ...(cursor ? { updatedAfterKeyset: cursor } : {}), sort: 'updated_asc', limit: BATCH });
    const due = pages.map((page) => ({ page, at: page.updated_at_iso ?? new Date(page.updated_at).toISOString() }))
      .filter(({ at }) => toMicroIso(at) <= horizon);
    if (!due.length) break;
    await sync(engine, conn, due.map(({ page }) => page), report);
    const last = due[due.length - 1]!;
    cursor = { updatedAt: last.at, slug: last.page.slug };
    await engine.setConfig(HYDRADB_CONFIG.pagesCursor, JSON.stringify(cursor));
    opts.progress?.tick(due.length);
    if (due.length < pages.length || pages.length < BATCH) break;
  }
  opts.progress?.finish(`${report.upserted} mirrored, ${report.removed} removed`);
  await engine.setConfig(HYDRADB_CONFIG.lastPushAt, new Date().toISOString());
  return report;
}

/**
 * Push on write: the persistence consumer reports each committed page write
 * (service.ts onSettled); writes coalesce for PUSH_DEBOUNCE_MS and the pages
 * go up as they are now (deleted ones are removed). Only a connected brain
 * pushes. A failed push is left to the cursor mirror and the cycle phase,
 * which resend everything after their cursor.
 */
const PUSH_DEBOUNCE_MS = 300;
const queued = new Map<BrainEngine, { refs: Map<string, PageRef>; timer: ReturnType<typeof setTimeout> }>();
const pushing = new Set<Promise<void>>();

export function scheduleCloudPush(engine: BrainEngine, ref: PageRef): void {
  const entry = queued.get(engine) ?? { refs: new Map<string, PageRef>(), timer: setTimeout(() => flushCloudPush(engine), PUSH_DEBOUNCE_MS) };
  entry.timer.unref?.();
  entry.refs.set(pageKey(ref.source_id, ref.slug), { source_id: ref.source_id, slug: ref.slug });
  queued.set(engine, entry);
}

function flushCloudPush(engine: BrainEngine): void {
  const entry = queued.get(engine);
  if (!entry) return;
  queued.delete(engine);
  clearTimeout(entry.timer);
  const run = (async () => {
    const conn = await resolveHydraConnection(engine);
    if (!conn) return;
    const pages: Page[] = [];
    const gone: PageRef[] = [];
    for (const ref of entry.refs.values()) {
      const page = await engine.getPage(ref.slug, { sourceId: ref.source_id });
      if (page) pages.push(page);
      else gone.push(ref);
    }
    await sync(engine, conn, pages, { upserted: 0, removed: 0, skipped: 0 });
    await remove(conn, gone);
  })().catch(() => undefined);
  pushing.add(run);
  void run.finally(() => pushing.delete(run));
}

registerBackgroundWorkDrainer({
  name: 'cloud-push',
  order: 6,
  async drain(timeoutMs, mode) {
    if (mode === 'exit') for (const engine of [...queued.keys()]) flushCloudPush(engine);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...pushing]), new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
    clearTimeout(timer);
    return { unfinished: pushing.size };
  },
});
