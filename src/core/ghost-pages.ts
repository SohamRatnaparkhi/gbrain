/**
 * #6696 B5: ghost pages, one classifier.
 *
 * A ghost is a live page whose canonical file is gone: `liveFileDrift` returns
 * reason `canonical_file_missing` for it on the source's canonical owner host
 * (`prepareFileTarget` refuses every coordinated write to it with that detail,
 * and no sync can import a file that is not there). Declared db_only pages,
 * never-filed derive-phase pages, read-only mirror and unbound-source pages
 * publish to the database only and are never ghosts; a deleted page is not one
 * either. `undeclared_db_only_pages` (doctor) stays a separate audit.
 *
 * The scan is bounded for large brains: the live pages of a source are read in
 * id order (at most `SCAN_LIMIT`), the recorded canonical path of each is
 * resolved exactly as `prepareFileTarget` does and stat'ed, and only the pages
 * whose file is absent and which are not database-only by declaration run the
 * full `liveFileDrift` check (at most `candidateLimit` of them). `inspected`,
 * `truncated` and `exact` say how much of the brain the answer covers.
 *
 * Off the owner host the source is `not_applicable` (`not_owner_host`); a
 * missing or unreadable root (`storage_unavailable`) or a stat error, an
 * invalid gbrain.yml or a check that ends in any other reason
 * (`ambiguous_storage`) make it `unknown`, never a count of zero.
 *
 * Readers: doctor `ghost_pages`, `gbrain pages ghosts` and `gbrain repair
 * ghost-pages` (`scanGhostSource`, `ghostPageNow`), and the read-scope MCP
 * health op (`readGhostPages`, counts only for remote callers).
 */
import { statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from './engine.ts';
import type { PageSnapshot } from './page-state/types.ts';
import { resolveSourceLocalFilePath, sourceGitScope } from './markdown.ts';
import { recordedPathFromFileUri, scannerSlugRootMode } from './write-through.ts';
import { isOpPageSlug } from './ops/context.ts';
import { existingLocalHostId } from './persistence/identity.ts';
import { getWorktreeBinding } from './persistence/ownership.ts';
import { sourceMirrorReadOnly } from './persistence/mirror-read-only.ts';
import { publishesDatabaseOnly } from './persistence/page-prepare.ts';
import { liveFileDrift } from './persistence/drift-conflicts.ts';

export interface GhostPage { source_id: string; slug: string; path: string; revision: string; page_id: number }
export interface GhostPagesSummary {
  status: 'known' | 'unknown';
  /** 'not_owner_host' | 'not_applicable' | 'storage_unavailable' | 'ambiguous_storage' */
  reason?: string;
  /** Ghosts found among inspected pages. */
  count: number;
  by_source: Array<{ source_id: string; count: number; status: 'known' | 'unknown' | 'not_applicable'; reason?: string }>;
  /** Bounded by `sampleLimit`. */
  samples: GhostPage[];
  inspected: number;
  truncated: boolean;
  exact: boolean;
}

/** The canonical owner the scan ran under; the repair binds its approval to it. */
export interface GhostOwner { host_id: string; worktree_id: string; owner_epoch: string; source_incarnation: string }

export interface GhostSourceScan {
  source_id: string;
  status: 'known' | 'unknown' | 'not_applicable';
  reason?: string;
  ghosts: GhostPage[];
  /** Live pages the existence pre-filter examined. */
  inspected: number;
  /** Pages expected to own a canonical file (present, ghost, or not yet confirmed): the mass-delete valve's population. */
  file_backed: number;
  /** Pages whose recorded canonical file is absent and that publish no database-only exception. */
  candidates: number;
  truncated: boolean;
  owner?: GhostOwner;
}

export const GHOST_SAMPLE_LIMIT = 5;
/** Candidates `readGhostPages` (doctor, health) confirms per source. */
export const GHOST_CHECK_LIMIT = 200;
/** Live pages the pre-filter reads per source. */
export const GHOST_SCAN_LIMIT = 250_000;
const BATCH = 10_000;

interface PageRow { id: number; slug: string; source_path: string | null; source_uri: string | null }
type SourceContext = { ok: true; root: string; owner: GhostOwner; mode: Awaited<ReturnType<typeof scannerSlugRootMode>>; gitScope: string[] | null }
  | { ok: false; status: 'unknown' | 'not_applicable'; reason: string };

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');

async function sourceContext(engine: BrainEngine, sourceId: string): Promise<SourceContext> {
  const hostId = existingLocalHostId();
  const binding = await getWorktreeBinding(engine, sourceId, hostId);
  if (!binding) return { ok: false, status: 'not_applicable', reason: 'not_applicable' };
  if (!hostId || !binding.local_path || binding.owner_host_id !== hostId || binding.state !== 'active') {
    return { ok: false, status: 'not_applicable', reason: 'not_owner_host' };
  }
  if (await sourceMirrorReadOnly(engine, sourceId)) return { ok: false, status: 'not_applicable', reason: 'mirror_read_only' };
  const root = join(binding.local_path, binding.relative_path);
  try {
    if (!statSync(root).isDirectory()) return { ok: false, status: 'unknown', reason: 'storage_unavailable' };
  } catch {
    return { ok: false, status: 'unknown', reason: 'storage_unavailable' };
  }
  return { ok: true, root, mode: await scannerSlugRootMode(engine, sourceId, root), gitScope: sourceGitScope(root),
    owner: { host_id: hostId, worktree_id: binding.worktree_id, owner_epoch: String(binding.owner_epoch), source_incarnation: binding.source_incarnation } };
}

/** The path `prepareFileTarget` compares, resolved the same way (recorded source path, captured file URI, then the slug path). */
function canonicalPath(context: Extract<SourceContext, { ok: true }>, page: Pick<PageRow, 'slug' | 'source_path' | 'source_uri'>): string {
  const captured = recordedPathFromFileUri(page.source_uri, context.root);
  return resolveSourceLocalFilePath(context.root, page.source_path, page.slug, page.source_path ? context.mode : undefined, context.gitScope)
    ?? (captured ? join(context.root, captured) : join(context.root, `${page.slug}.md`));
}

/** The existence pre-filter: `present`, `database_only`, a `candidate` at its source-relative path, or `ambiguous`. */
function prefilter(context: Extract<SourceContext, { ok: true }>, page: PageRow): { kind: 'present' | 'database_only' | 'ambiguous' } | { kind: 'candidate'; path: string } {
  if (!isOpPageSlug(page.slug)) return { kind: 'database_only' };
  const path = canonicalPath(context, page);
  try {
    statSync(path);
    return { kind: 'present' };
  } catch (error) {
    if (!missing(error)) return { kind: 'ambiguous' };
  }
  try {
    if (publishesDatabaseOnly(context.root, page.slug, { page: { deleted_at: null, source_path: page.source_path, source_uri: page.source_uri } })) return { kind: 'database_only' };
  } catch {
    return { kind: 'ambiguous' };
  }
  return { kind: 'candidate', path: relative(context.root, path).split(sep).join('/') };
}

/** The full check of one candidate: `ghost` with its revision, `not_ghost`, or `unknown` with the classifier's reason. */
async function confirm(engine: BrainEngine, context: Extract<SourceContext, { ok: true }>, sourceId: string, slug: string):
  Promise<{ kind: 'ghost'; ghost: GhostPage } | { kind: 'not_ghost'; reason: string } | { kind: 'unknown'; reason: string }> {
  const snapshot: PageSnapshot | null = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot || snapshot.page.deleted_at) return { kind: 'not_ghost', reason: 'page_missing' };
  const live = await liveFileDrift(engine, sourceId, slug, snapshot);
  if (live.reason === 'canonical_file_missing') {
    return { kind: 'ghost', ghost: { source_id: sourceId, slug, path: relative(context.root, canonicalPath(context, { slug, source_path: snapshot.page.source_path ?? null,
      source_uri: snapshot.page.source_uri ?? null })).split(sep).join('/'), revision: snapshot.revision, page_id: Number(snapshot.page.id) } };
  }
  if (['agrees', 'file_database_drift', 'database_only', 'page_missing'].includes(live.reason)) return { kind: 'not_ghost', reason: live.reason };
  return { kind: 'unknown', reason: live.reason === 'not_owner_host' ? 'not_owner_host' : 'ambiguous_storage' };
}

/**
 * One source's ghosts in page-id order. `candidateLimit` bounds the full checks (default `GHOST_CHECK_LIMIT`);
 * anything past it, or past `GHOST_SCAN_LIMIT` live pages, sets `truncated`.
 */
export async function scanGhostSource(engine: BrainEngine, sourceId: string, opts: { candidateLimit?: number } = {}): Promise<GhostSourceScan> {
  const limit = opts.candidateLimit ?? GHOST_CHECK_LIMIT;
  const context = await sourceContext(engine, sourceId);
  const scan: GhostSourceScan = { source_id: sourceId, status: 'known', ghosts: [], inspected: 0, file_backed: 0, candidates: 0, truncated: false };
  if (!context.ok) return { ...scan, status: context.status, reason: context.reason };
  scan.owner = context.owner;
  let after = 0;
  let unchecked = 0;
  for (;;) {
    const rows = await engine.executeRaw<PageRow>(`SELECT id, slug, source_path, source_uri FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL AND id > $2 ORDER BY id LIMIT ${BATCH}`, [sourceId, after]);
    for (const row of rows) {
      if (scan.inspected >= GHOST_SCAN_LIMIT) { scan.truncated = true; break; }
      scan.inspected++;
      const verdict = prefilter(context, row);
      if (verdict.kind === 'present') { scan.file_backed++; continue; }
      if (verdict.kind === 'database_only') continue;
      if (verdict.kind === 'ambiguous') return { ...scan, status: 'unknown', reason: 'ambiguous_storage' };
      scan.candidates++;
      if (scan.candidates > limit) { scan.truncated = true; unchecked++; continue; }
      const result = await confirm(engine, context, sourceId, row.slug);
      if (result.kind === 'unknown') return { ...scan, status: result.reason === 'not_owner_host' ? 'not_applicable' : 'unknown', reason: result.reason };
      if (result.kind === 'ghost') scan.ghosts.push(result.ghost);
      else if (result.reason === 'agrees' || result.reason === 'file_database_drift') scan.file_backed++;
    }
    if (rows.length < BATCH || scan.inspected >= GHOST_SCAN_LIMIT) break;
    after = Number(rows[rows.length - 1]!.id);
  }
  scan.file_backed += scan.ghosts.length + unchecked;
  return scan;
}

/**
 * One page, checked now under the current owner: the ghost it still is (same classifier as the scan), or why not.
 * The repair re-runs it before each soft delete and inside the preparer.
 */
export async function ghostPageNow(engine: BrainEngine, sourceId: string, slug: string):
  Promise<{ ghost: GhostPage; owner: GhostOwner } | { ghost: null; reason: string; owner?: GhostOwner }> {
  const context = await sourceContext(engine, sourceId);
  if (!context.ok) return { ghost: null, reason: context.reason };
  const result = await confirm(engine, context, sourceId, slug);
  return result.kind === 'ghost' ? { ghost: result.ghost, owner: context.owner } : { ghost: null, reason: result.reason, owner: context.owner };
}

/** Every selected (default: every active) source's ghost count, bounded samples and coverage; the doctor and health reader. */
export async function readGhostPages(engine: BrainEngine, opts: { sourceIds?: string[]; sampleLimit?: number }): Promise<GhostPagesSummary> {
  const sourceIds = opts.sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
  const scans: GhostSourceScan[] = [];
  for (const sourceId of sourceIds) scans.push(await scanGhostSource(engine, sourceId));
  const unknown = scans.find(scan => scan.status === 'unknown');
  const known = scans.filter(scan => scan.status === 'known');
  const offOwner = scans.some(scan => scan.reason === 'not_owner_host');
  const count = scans.reduce((sum, scan) => sum + scan.ghosts.length, 0);
  const truncated = scans.some(scan => scan.truncated);
  const status = unknown || (!known.length && offOwner) ? 'unknown' : 'known';
  const reason = unknown?.reason ?? (!known.length ? (offOwner ? 'not_owner_host' : 'not_applicable') : undefined);
  return { status, ...(reason ? { reason } : {}), count,
    by_source: scans.map(scan => ({ source_id: scan.source_id, count: scan.ghosts.length, status: scan.status, ...(scan.reason ? { reason: scan.reason } : {}) })),
    samples: scans.flatMap(scan => scan.ghosts).slice(0, opts.sampleLimit ?? GHOST_SAMPLE_LIMIT),
    inspected: scans.reduce((sum, scan) => sum + scan.inspected, 0), truncated,
    exact: status === 'known' && !truncated && !offOwner && !unknown };
}
