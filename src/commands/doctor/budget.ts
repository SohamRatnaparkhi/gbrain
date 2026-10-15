/**
 * #6696 B1: doctor tiers and budgets.
 *
 * `--tier ops|standard|deep` selects which registry entries run (see
 * `DoctorTier` in ./context.ts); `--budget-ms <n>` is one absolute end-to-end
 * deadline that starts before the CLI connects (default 4000 for `ops`, none
 * for the other tiers). Every entry also has its own budget
 * (`doctor.entry_budget_ms`, default 15000; the remaining overall time when
 * that is shorter).
 *
 * An entry past its budget reports each check it emits with the shared unknown
 * convention: `status: 'warn'`, `details.health: 'unknown'`,
 * `details.reason: 'budget'`, `details.exact: false`, `elapsed_ms`. Under
 * `--tier ops` the entry reads through `deadlineEngine`, whose raw statements
 * carry the absolute deadline to the server (a transaction-local
 * `statement_timeout` recomputed after the pool wait, and an abort of the pool
 * wait itself at the deadline), so no doctor backend outlives the report.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { opError } from '../../core/ops/contract.ts';
import type { Check, DoctorReport } from '../doctor.ts';
import { agentFix } from './check-fix.ts';
import type { DoctorTier } from './context.ts';

export const DOCTOR_TIERS: readonly DoctorTier[] = ['ops', 'standard', 'deep'];
/** Default `--budget-ms` for `--tier ops`; the other tiers have no overall deadline unless one is given. */
export const OPS_BUDGET_MS_DEFAULT = 4000;
/** Config key and default of the per-entry budget (standard and deep tiers; ops entries use the overall deadline). */
export const ENTRY_BUDGET_KEY = 'doctor.entry_budget_ms';
export const ENTRY_BUDGET_MS_DEFAULT = 15_000;

/** The deadline of one doctor run: `deadlineAt` is absolute epoch ms, null without an overall budget. */
export interface DoctorDeadline {
  startedAt: number;
  budgetMs: number | null;
  deadlineAt: number | null;
}

/** Thrown (and caught by the runner) when a read starts after the deadline passed. */
export class DoctorBudgetError extends Error {
  readonly code = 'doctor_budget';
  constructor(readonly elapsedMs: number) {
    super(`The doctor budget ran out after ${elapsedMs} ms.`);
    this.name = 'DoctorBudgetError';
  }
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return undefined;
}

/** `--tier <t>` (default `standard`); an unknown value is `invalid_params` naming the valid tiers. */
export function parseDoctorTier(args: readonly string[]): DoctorTier {
  const raw = flagValue(args, '--tier');
  if (raw === undefined) return 'standard';
  if ((DOCTOR_TIERS as readonly string[]).includes(raw)) return raw as DoctorTier;
  throw opError('invalid_params', `Unknown doctor tier: ${raw}`, `Valid tiers: ${DOCTOR_TIERS.join(', ')}.`,
    { fix: { argv: ['gbrain', 'doctor', '--tier', 'ops', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'The ops tier answers the operational questions (capacity, failures, embedding, sync, compaction, serve build) in seconds.' } });
}

/** `--budget-ms <n>` (a positive integer), else the tier default. */
export function parseBudgetMs(args: readonly string[], tier: DoctorTier): number | null {
  const raw = flagValue(args, '--budget-ms');
  if (raw === undefined) return tier === 'ops' ? OPS_BUDGET_MS_DEFAULT : null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw opError('invalid_params', `--budget-ms must be a positive integer number of milliseconds (got ${raw}).`, 'Example: --budget-ms 4000.');
  }
  return n;
}

/** The deadline of a run starting now (call it before connecting). */
export function startDoctorDeadline(args: readonly string[], now = Date.now()): DoctorDeadline {
  const budgetMs = parseBudgetMs(args, parseDoctorTier(args));
  return { startedAt: now, budgetMs, deadlineAt: budgetMs === null ? null : now + budgetMs };
}

/** Whether a registry entry runs at `tier` (`standard` includes `ops`; `deep` includes both). */
export function entryRunsAt(entryTier: DoctorTier | undefined, tier: DoctorTier): boolean {
  const own = entryTier ?? 'standard';
  if (tier === 'ops') return own === 'ops';
  if (tier === 'standard') return own !== 'deep';
  return true;
}

/**
 * The engine an ops entry reads through: every raw statement carries the
 * absolute deadline (server-side bound recomputed after the pool wait; the pool
 * wait aborts at the deadline). A statement that would start after the deadline
 * is not sent. PGLite has one in-process connection and no other session to wait
 * on, so it is returned as it is.
 */
export function deadlineEngine(engine: BrainEngine, deadline: DoctorDeadline): BrainEngine {
  const deadlineAt = deadline.deadlineAt;
  if (deadlineAt === null || engine.kind !== 'postgres') return engine;
  return new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[], opts?: { signal?: AbortSignal; timeoutMs?: number }) => {
      const left = deadlineAt - Date.now();
      if (left <= 0) throw new DoctorBudgetError(Date.now() - deadline.startedAt);
      const signal = opts?.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left);
      return target.executeRaw(sql, params, { signal, timeoutMs: Math.min(left, opts?.timeoutMs ?? left), deadlineAt });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

const EXPIRED: unique symbol = Symbol('doctor_budget_expired');

/** Resolves `work`, or `EXPIRED` once `ms` passes (the work keeps running; its result is dropped). */
export async function raceBudget<T>(work: Promise<T>, ms: number): Promise<T | typeof EXPIRED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof EXPIRED>((resolve) => { timer = setTimeout(() => resolve(EXPIRED), Math.max(0, ms)); });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export { EXPIRED as BUDGET_EXPIRED };
export type BudgetExpired = typeof EXPIRED;

/** Whether a raced result is the budget's expiry marker. */
export function budgetExpired(value: unknown): value is BudgetExpired {
  return value === EXPIRED;
}

/** One check an entry could not finish within its budget, in the shared unknown convention. */
export function budgetUnknownCheck(name: string, elapsedMs: number, budgetMs: number): Check {
  return {
    name, status: 'warn', elapsed_ms: elapsedMs,
    message: `Not finished within the doctor budget (${budgetMs} ms). Health is unknown, not clear; rerun this check alone: gbrain doctor --only ${name} --json`,
    details: { health: 'unknown', reason: 'budget', exact: false, elapsed_ms: elapsedMs, budget_ms: budgetMs },
    fix: agentFix(['gbrain', 'doctor', '--only', name, '--json'], 'Runs only this check, without the deadline of a full run; read-only.', name),
  };
}

/** An ops section skipped by design on PGLite: info, so the ops report stays complete. */
export function opsNotApplicableCheck(name: string): Check {
  return {
    name, status: 'ok', severity: 'info', readiness_state: 'not_applicable', elapsed_ms: 0,
    message: 'Not applicable to the ops tier on PGLite (it reads only counters, config and catalog there); run gbrain doctor for this check.',
    details: { health: 'not_applicable', reason: 'pglite_ops_tier', exact: true },
  };
}

/** Whether a check is an over-budget unknown (the ops report's `unknown_sections`). */
export function isBudgetUnknown(check: Pick<Check, 'details'>): boolean {
  return check.details?.health === 'unknown' && check.details?.reason === 'budget';
}

/** #6696 B1: what the report says about the run's tier and deadline (`--tier` / `--budget-ms` given). */
export interface DoctorRunSummary { tier: DoctorTier; startedAt: number; budgetMs: number | null }

export function tierFields(checks: Check[], run: DoctorRunSummary): Pick<DoctorReport, 'tier' | 'complete' | 'unknown_sections' | 'elapsed_ms' | 'budget_ms'> {
  const unknown = checks.filter((c) => c.status !== 'ok' && c.details?.health === 'unknown').map((c) => c.name);
  return { tier: run.tier, complete: unknown.length === 0, unknown_sections: unknown, elapsed_ms: Date.now() - run.startedAt, budget_ms: run.budgetMs };
}

/** The run summary a report carries: only when the caller chose a tier or a budget, so default output keeps its shape. */
export function doctorRunSummary(args: readonly string[], deadline: DoctorDeadline): DoctorRunSummary | undefined {
  if (!args.some((a) => a === '--tier' || a.startsWith('--tier=') || a === '--budget-ms' || a.startsWith('--budget-ms='))) return undefined;
  return { tier: parseDoctorTier(args), startedAt: deadline.startedAt, budgetMs: deadline.budgetMs };
}
