/**
 * The durable cursor key of a managed sync run, and the one boundary that picks it (#6696 C1).
 *
 * The key digests the source incarnation, the writer principal and authority, a company approval and the run's
 * cursor-selecting options (`syncCursorOptions`). `sync --all` passes a source's configured strategy while a
 * single-source CLI run, the cycle, a serve-delegated run and a sync job pass none, so one source used to get two keys:
 * two unfinished cursors that could not resume each other. `selectManagedCursor` runs inside `runManagedSync` (every
 * managed caller crosses it) and `managedSyncCursorKey`: a run without `--strategy` selects its cursor with the
 * configured strategy, for fresh cursors only. When an unfinished cursor is held under the key the run's raw options
 * select (written before this rule, or before the strategy was configured), the run resumes it under that key, so the
 * requests it already admitted (their `intent.cursorKey`) keep matching their cursor.
 */
import type { SyncOpts } from '../../commands/sync.ts';
import type { BrainEngine } from '../engine.ts';
import type { currentCompanyBrainSync } from '../company-brain/profile.ts';
import { digest } from './digest.ts';
import type { SyncAuthority } from './sync-authority.ts';
import type { ManagedSyncContext } from './sync-discovery.ts';
import type { SyncCursorOptions } from './sync-prepare.ts';
import { syncCursorOptions } from './sync-slices.ts';

type CompanySync = ReturnType<typeof currentCompanyBrainSync>;

export function managedCursorKey(incarnation: string, authority: SyncAuthority, company: CompanySync, syncOptions: SyncCursorOptions): string {
  return digest({ source: incarnation, principal: authority.writer.principal, authority, ...(company ? { company: { receiptId: company.receiptId, planDigest: company.plan.plan_digest } } : {}),
    options: syncOptions });
}

/** The options, cursor-selecting options and key a managed run uses; `opts.strategy` is the configured one when the key was normalized. */
export async function selectManagedCursor(engine: Pick<BrainEngine, 'executeRaw'>, input: { opts: SyncOpts; context: Pick<ManagedSyncContext, 'incarnation' | 'source'>;
  authority: SyncAuthority; company: CompanySync }): Promise<{ opts: SyncOpts; syncOptions: SyncCursorOptions; key: string }> {
  const { opts, context, authority, company } = input;
  const raw = syncCursorOptions(opts);
  const rawKey = managedCursorKey(context.incarnation, authority, company, raw);
  const configured = context.source.config?.strategy;
  if (company || opts.strategy || typeof configured !== 'string' || !configured) return { opts, syncOptions: raw, key: rawKey };
  const live = await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1 AND COALESCE(completed_keys->0->>'done','false')<>'true'", [rawKey]);
  if (live.length) return { opts, syncOptions: raw, key: rawKey };
  const normalized = { ...opts, strategy: configured as SyncOpts['strategy'] };
  const syncOptions = syncCursorOptions(normalized);
  return { opts: normalized, syncOptions, key: managedCursorKey(context.incarnation, authority, company, syncOptions) };
}
