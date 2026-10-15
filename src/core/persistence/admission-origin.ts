/**
 * #6696 (A5): who a write is for. `interactive` writes are the user's own
 * (`remember`, `put_page`, `edit_page` from the CLI or an MCP client, an
 * operator's `gbrain sync`, an approved `gbrain repair`); everything else is
 * `background` (maintenance, conversation facts, autopilot cycle phases,
 * autopilot catch-up syncs, minion jobs). Trusted host-side callers set the
 * origin explicitly: `OperationContext.admissionOrigin` at the CLI and MCP
 * entry points and the persistence owner's verified IPC dispatch, or a
 * `withAdmissionOrigin` scope around a command (`gbrain sync`, its delegated
 * run on the owner, `gbrain repair`; `runCycle` scopes itself background).
 * A caller that sets nothing is background. It is never inferred from
 * `ctx.remote`: an autopilot phase writes with `remote: true` too.
 *
 * Near a cumulative cap (`persistence.capacity.background_pause_pct`, default
 * 80 percent, of a principal's or the brain's request ids or receipt bytes) a
 * background admission refuses `write_capacity_backpressure` before any
 * receipt exists, so the rest stays free for interactive writes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { opError, type OperationError } from '../ops/contract.ts';
import type { SqlEngine } from './model.ts';
import { CAPACITY_VERIFY } from './capacity-verify.ts';

export type AdmissionOrigin = 'interactive' | 'background';
export const ADMISSION_ORIGINS: readonly AdmissionOrigin[] = ['interactive', 'background'];
export const BACKGROUND_PAUSE_KEY = 'persistence.capacity.background_pause_pct';
export const DEFAULT_BACKGROUND_PAUSE_SHARE = 0.8;
/** What a paused admission's doctor finding names as paused. */
export const BACKGROUND_PRODUCERS = ['managed maintenance', 'conversation facts', 'autopilot cycle phases', 'autopilot catch-up sync', 'minion jobs'] as const;

const scope = new AsyncLocalStorage<AdmissionOrigin>();

/** Runs `fn` with every admission inside it attributed to `origin` (a background scope wins over an inner interactive caller). */
export function withAdmissionOrigin<T>(origin: AdmissionOrigin, fn: () => T): T {
  return scope.run(scope.getStore() === 'background' ? 'background' : origin, fn);
}

/** The origin an admission is charged to: a surrounding background scope, else the explicit origin, else the scope, else background. */
export function resolveAdmissionOrigin(explicit?: AdmissionOrigin): AdmissionOrigin {
  const surrounding = scope.getStore();
  if (surrounding === 'background') return 'background';
  return explicit ?? surrounding ?? 'background';
}

export function isAdmissionOrigin(value: unknown): value is AdmissionOrigin {
  return value === 'interactive' || value === 'background';
}

/** The pause line as a share of each cumulative cap (0 < share <= 1); the setting is a percent (80), and a share (0.8) reads the same. */
export async function readBackgroundPauseShare(engine: SqlEngine): Promise<number> {
  const [row] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1', [BACKGROUND_PAUSE_KEY]);
  const value = row ? Number(row.value) : DEFAULT_BACKGROUND_PAUSE_SHARE;
  if (!Number.isFinite(value) || value <= 0 || value > 100) return DEFAULT_BACKGROUND_PAUSE_SHARE;
  return value > 1 ? value / 100 : value;
}

/**
 * The refusal of a background admission past the pause line; nothing was
 * submitted. Request ids are never freed, so past the line on ids the only fix
 * is the host's config raise; receipt bytes also free as receipts compact.
 */
export function backgroundPaused(scopeKey: string, resource: 'lifetime_ids' | 'terminal_bytes', used: number, limit: number, share: number,
  configKey: string, value: number, context: { what?: string; alternative?: string } = {}): OperationError {
  const raise = `gbrain config set ${configKey} ${value}`;
  return opError('write_capacity_backpressure',
    `${context.what ?? 'Background writes are paused'}: ${scopeKey} ${resource} is at ${used} of ${limit}, past the ${Math.round(share * 100)}% pause line (${BACKGROUND_PAUSE_KEY}).`,
    `Nothing was submitted; interactive writes keep the rest of ${configKey}. ${context.alternative ? `${context.alternative} ` : ''}${resource === 'lifetime_ids'
      ? `Request ids are never freed, so background work resumes only after the brain host runs ${raise} (covers about one more year; undo with gbrain config unset ${configKey}).`
      : `Background work resumes as retained receipts compact, or at once after the brain host runs ${raise} (covers about one more year; undo with gbrain config unset ${configKey}).`}`,
    { reason: resource, detail: configKey.slice('persistence.limits.'.length), docs: 'docs/guides/write-refusals.md#write_capacity_backpressure',
      fix: { argv: ['gbrain', 'config', 'set', configKey, String(value)], consent: [], actor: 'host_admin', requires_exclusive: false,
        why: resource === 'lifetime_ids' ? 'Request ids are permanent, so only a larger cap moves the pause line; the raise is reversible.'
          : 'The raise moves the pause line at once and is reversible; compaction frees reserved bytes only as receipts age out of the retention window.',
        verify: CAPACITY_VERIFY, docs: 'docs/guides/concurrent-writes.md#quota-near-exhaustion' } });
}
