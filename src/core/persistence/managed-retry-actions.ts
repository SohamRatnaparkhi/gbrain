/**
 * The next action for each managed failure a `--retry-failed` run does not retry because another cursor key holds it
 * (#6696 C3). A failure recorded before runs kept their options cannot name them, so "rerun with the same options"
 * was a command nobody could run. Each row is classified instead:
 *
 * - `resumable`: the row recorded its options, or an option set reproduces its cursor key exactly (this run's options
 *   with and without the source's configured strategy and `--full`, or the options another cursor of the source
 *   recorded; the key is a digest, so a match is those options). The command is a `replay` when an unfinished run
 *   holds the key and a `fresh_discovery` (a new run from HEAD under those options, which clears the key's failures
 *   when it completes) when none does.
 * - `orphaned`: the existing orphan repair names it (`classifyManagedSyncOrphans`): preview, then apply.
 * - `unresolved`: nothing selects it now. A run whose request is still in flight is shown by `sync status`; otherwise a
 *   current run of the source completing supersedes the option-less cursor, and the orphan repair then retires it.
 *
 * Read-only.
 */
import type { SyncOpts } from '../../commands/sync.ts';
import type { BrainEngine } from '../engine.ts';
import { currentCompanyBrainSync } from '../company-brain/profile.ts';
import { checkpointRetryCommand } from './checkpoint-validation.ts';
import { digest } from './digest.ts';
import { classifyManagedSyncOrphans } from './managed-sync-orphans.ts';
import { managedSyncAuthority } from './sync-authority.ts';
import { managedCursorKey } from './sync-cursor-key.ts';
import { resolveManagedSyncContext } from './sync-discovery.ts';
import type { ManagedSyncFailure } from './sync-failures.ts';
import type { SyncCursorOptions } from './sync-prepare.ts';
import { syncCursorOptions } from './sync-slices.ts';

export type ManagedRetryClass = 'resumable' | 'orphaned' | 'unresolved';
export type ManagedRetryLabel = 'replay' | 'fresh_discovery' | 'orphan_repair' | 'pending_request' | 'after_current_run';
export interface ManagedRetryAction { class: ManagedRetryClass; label: ManagedRetryLabel; command: string; failures: ManagedSyncFailure[] }

/** One action per distinct command, in the order the rows first need it. */
export async function managedRetryActions(engine: BrainEngine, opts: SyncOpts, failures: ManagedSyncFailure[]): Promise<ManagedRetryAction[]> {
  if (!failures.length) return [];
  const context = await resolveManagedSyncContext(engine, opts);
  const { sourceId, incarnation } = context;
  const authority = await managedSyncAuthority(engine, sourceId, incarnation, opts.repoPath ?? context.root);
  const company = currentCompanyBrainSync(sourceId);
  const unfinished = new Set((await engine.executeRaw<{ key: string }>(`SELECT fingerprint AS key FROM op_checkpoints WHERE op='managed-sync'
    AND fingerprint=ANY($1::text[]) AND COALESCE(completed_keys->0->>'done','false')<>'true'`, [[...new Set(failures.map(f => f.cursor_key))]])).map(row => row.key));
  const recorded = await engine.executeRaw<{ options: SyncCursorOptions }>(`SELECT DISTINCT completed_keys->0->'syncOptions' AS options FROM op_checkpoints
    WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 AND completed_keys->0->>'incarnation'=$2 AND completed_keys->0->'syncOptions' IS NOT NULL`, [sourceId, incarnation]);
  const base = syncCursorOptions(opts);
  const configured = typeof context.source.config?.strategy === 'string' ? context.source.config.strategy : null;
  const candidates = company ? [] : [...[...new Set([base.strategy, configured, null])].flatMap(strategy => [false, true].map(full => ({ ...base, strategy, full }))),
    ...recorded.map(row => row.options)];
  const byKey = new Map(candidates.map(options => [managedCursorKey(incarnation, authority, company, options), options]));
  const { orphans, retained } = await classifyManagedSyncOrphans(engine, [sourceId]);
  const orphanKind = new Map(orphans.map(orphan => [orphan.cursor_key, orphan.kind]));
  const pending = new Set(retained.filter(row => row.why === 'pending_request_live').map(row => row.cursor_key));
  const actions = new Map<string, ManagedRetryAction>();
  for (const failure of failures) {
    const key = failure.cursor_key;
    const options = failure.syncOptions ?? byKey.get(key);
    const [cls, label, command]: [ManagedRetryClass, ManagedRetryLabel, string] = orphanKind.get(key) === 'unfinished_cursor' || (!options && orphanKind.has(key))
      ? ['orphaned', 'orphan_repair', `gbrain repair managed-sync-orphans --source ${sourceId}`]
      : options ? ['resumable', unfinished.has(key) ? 'replay' : 'fresh_discovery',
        checkpointRetryCommand({ sourceId, processingOptions: failure.processingOptions, syncOptions: options, repoPath: opts.repoPath })]
        : pending.has(key) ? ['unresolved', 'pending_request', `gbrain sync status --source ${sourceId} --json`]
          : ['unresolved', 'after_current_run', `gbrain sync --source ${sourceId} --no-pull`];
    const id = digest({ label, command });
    const action = actions.get(id) ?? { class: cls, label, command, failures: [] };
    action.failures.push(failure);
    actions.set(id, action);
  }
  return [...actions.values()];
}

/** The human line for one action: count, class, what the command does, then the command last. */
export function formatManagedRetryAction(action: ManagedRetryAction): string {
  const sourceId = action.failures[0]!.source_id;
  const what: Record<ManagedRetryLabel, string> = {
    replay: 'resumable (replay of the unfinished run under its recorded options)',
    fresh_discovery: 'resumable (fresh discovery, not a replay: no unfinished run holds them; a new run from HEAD under the failed run\'s options clears them when it completes)',
    orphan_repair: 'safely orphaned (nothing current can resume them; preview the repair, then apply it with the hash it prints)',
    pending_request: 'unresolved (their run predates recorded options and its request is still in flight; this shows it)',
    after_current_run: `unresolved (their run predates recorded options and no current option set selects it; once a current run of this source completes, gbrain repair managed-sync-orphans --source ${sourceId} retires them)`,
  };
  return `${action.failures.length} ${what[action.label]}: ${action.command}`;
}
