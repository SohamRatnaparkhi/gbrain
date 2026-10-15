/**
 * The doctor check registry (refactor wave 1, W4 doctor): every entry
 * `gbrain doctor` runs, in run order. The order is the output order of
 * `gbrain doctor --json` and is pinned by the W0 registry golden
 * (test/doctor-registry-golden.test.ts); categories come only from
 * src/core/doctor-categories.ts (test/doctor-registry.test.ts fails on an
 * uncategorized entry name or emitted check).
 *
 * Execution groups, in order:
 *   1. Filesystem-first entries: run with or without an engine and under
 *      `--fast`. The resolver-health entry applies `--fix` before it scans.
 *   2. The connection lane: the synthesized `connection` check when there is
 *      no engine, then STOP when `--fast` or no engine.
 *   3. The live connection check, then STOP when it failed.
 *   4. DB entries: each reads `connectedEngine(ctx)`.
 *
 * To add a check: put a `{ name, emits, run }` entry in the topic module
 * under ./checks/, add it here at the position its output should take, and
 * categorize every emitted name in src/core/doctor-categories.ts.
 */

import { resolverHealthEntry, retrievalReflexEntry, skillConformanceEntry } from './checks/skill-group.ts';
import {
  bootstrapChecksEntry,
  memorableRelayEntry,
  connectorsEntry,
  minionsMigrationEntry,
} from './checks/local-runtime.ts';
import { supervisorEntry } from './checks/supervisor-health.ts';
import {
  stubGuardEntry,
  extractionBacklogsEntry,
  homeDirInWorktreeEntry,
  defaultSourcePathEntry,
} from './checks/local-audits.ts';
import {
  pgliteDataDirEntry,
  offlineConnectionEntry,
  dbChecksGateEntry,
  connectionEntry,
  connectionGateEntry,
} from './checks/db-connection.ts';
import {
  pgvectorEntry,
  rlsEntry,
  schemaVersionEntry,
  rlsEventTriggerEntry,
  embeddingsEntry,
} from './checks/schema-health.ts';
import { embeddingStateEntry } from './checks/embedding-state.ts';
import {
  embeddingProviderEntry,
  alternativeProvidersEntry,
  embeddingQueryPrefixEntry,
  embeddingColumnRegistryEntry,
  embeddingEnvOverrideEntry,
  embeddingKeySourceEntry,
} from './checks/embedding-health.ts';
import { projectionResidentEntry } from './checks/projection-readiness.ts';
import {
  graphCoverageEntry,
  orphanRatioEntry,
  staleMentionsEntry,
  timelineHistoryEntry,
} from './checks/graph-health.ts';
import { extractionDateGroundingEntry } from './checks/ranking-extraction.ts';
import {
  integrityEntry,
  jsonbIntegrityEntry,
  whoknowsEntry,
  crossModalEntry,
  markdownBodyEntry,
} from './checks/data-integrity.ts';
import { contentSanityEntry, quarantineEntry, frontmatterEntry } from './checks/content-quality.ts';
import {
  evalCaptureEntry,
  contradictionsEntry,
  factsExtractionEntry,
  effectiveDateEntry,
  salienceEntry,
} from './checks/knowledge-health.ts';
import { queueHealthEntry, indexAuditEntry, imageAssetsEntry } from './checks/queue-assets.ts';
import { imageEmbeddingCoverageEntry } from './checks/image-embedding-coverage.ts';
import { globalMaintenanceTimeoutsEntry } from './checks/global-maintenance-timeouts.ts';
import { legacyJobAuthorityEntry } from './checks/legacy-job-authority.ts';
import { legacyTokenGrantsEntry } from './checks/legacy-token-grants.ts';
import { grantNewOpsEntry } from './checks/grant-new-ops.ts';
import { syncFreshnessEntry, searchModeEntry } from './checks/sync-search.ts';
import { persistenceConsumersEntry, serveBuildDriftEntry } from './checks/persistence-consumers.ts';
import { gitConvergenceEntry } from './checks/git-convergence.ts';
import { retrievalFeedbackEntry } from './checks/retrieval-feedback.ts';
import { transcriptSecretExposureEntry } from './checks/transcript-secrets.ts';
import { autoChronicleEntry } from './checks/auto-chronicle.ts';
import { factsDrainEntry } from './checks/facts-drain.ts';
import { factTakeVectorsEntry } from './checks/vector-coverage.ts';
import { decideHealthEntry } from './checks/decide.ts';
import { supersessionCalibrationEntry } from './checks/supersession-calibration.ts';
import { unlinkedFactsEntry } from './checks/unlinked-facts.ts';
import { edgeValidityEntry } from './checks/edge-validity.ts';
import { coreMemoryEntry } from './checks/core-memory.ts';
import { plannerStatsEntry } from './checks/planner-stats.ts';
import { revisionBackfillEntry } from './checks/revision-backfill.ts';
import { trustTiersEntry } from './checks/trust-tiers.ts';
import { trustScanEntry } from './checks/trust-scan.ts';
import { trustSourcesUnclaimedEntry } from './checks/trust-sources-unclaimed.ts';
import { harnessWiringDoctorEntry } from './checks/harness-wiring.ts';
import { agentContractEntry } from './checks/agent-contract.ts';
import { chatFallbackChainEntry } from './checks/chat-fallback.ts';
import { providerConsentEntry } from './checks/provider-consent.ts';
import { behaviorChangesEntry } from './checks/behavior-changes.ts';
import { fenceIntegrityEntry } from './checks/fence-integrity.ts';
import { ghostPagesEntry } from './checks/ghost-pages.ts';
import { managedSyncMovementEntry } from './checks/managed-sync-movement.ts';
import { atomHeldFailedEntry } from './checks/atom-holds.ts';
import { extractionInputTruncatedEntry } from './checks/extraction-input.ts';
import {
  persistenceCapacityEntry,
  terminalFailuresEntry,
  persistenceCompactionEntry,
  schemaPackConsistencyEntry,
} from './checks/ops-sections.ts';
import { STOP_DOCTOR, type DoctorContext, type DoctorEntry, type DoctorTier } from './context.ts';
import {
  BUDGET_EXPIRED, DoctorBudgetError, budgetExpired, type BudgetExpired, ENTRY_BUDGET_KEY, ENTRY_BUDGET_MS_DEFAULT, budgetUnknownCheck, deadlineEngine, entryRunsAt,
  opsNotApplicableCheck, raceBudget,
} from './budget.ts';
import type { Check } from '../doctor.ts';
import { infoCheck } from './check-fix.ts';
import { withGitListingCache } from '../../core/git-visible-files.ts';

export const DOCTOR_CHECK_REGISTRY: readonly DoctorEntry[] = [
  resolverHealthEntry,
  retrievalReflexEntry,
  skillConformanceEntry,
  bootstrapChecksEntry,
  memorableRelayEntry,
  connectorsEntry,
  minionsMigrationEntry,
  supervisorEntry,
  stubGuardEntry,
  extractionBacklogsEntry,
  homeDirInWorktreeEntry,
  defaultSourcePathEntry,
  embeddingKeySourceEntry,
  providerConsentEntry,
  harnessWiringDoctorEntry,
  agentContractEntry,
  pgliteDataDirEntry,
  projectionResidentEntry,
  offlineConnectionEntry,
  dbChecksGateEntry,
  connectionEntry,
  connectionGateEntry,
  // #6696 B1: ops sections first (`tier: 'ops'`), so a default run answers them before the slower checks.
  persistenceCapacityEntry,
  terminalFailuresEntry,
  managedSyncMovementEntry,
  persistenceCompactionEntry,
  serveBuildDriftEntry,
  schemaPackConsistencyEntry,
  embeddingStateEntry,
  pgvectorEntry,
  rlsEntry,
  schemaVersionEntry,
  rlsEventTriggerEntry,
  embeddingsEntry,
  embeddingProviderEntry,
  alternativeProvidersEntry,
  embeddingQueryPrefixEntry,
  embeddingColumnRegistryEntry,
  embeddingEnvOverrideEntry,
  supersessionCalibrationEntry,
  chatFallbackChainEntry,
  behaviorChangesEntry,
  graphCoverageEntry,
  orphanRatioEntry,
  staleMentionsEntry,
  timelineHistoryEntry,
  extractionDateGroundingEntry,
  integrityEntry,
  jsonbIntegrityEntry,
  whoknowsEntry,
  crossModalEntry,
  markdownBodyEntry,
  contentSanityEntry,
  quarantineEntry,
  frontmatterEntry,
  evalCaptureEntry,
  contradictionsEntry,
  factsExtractionEntry,
  effectiveDateEntry,
  salienceEntry,
  queueHealthEntry,
  globalMaintenanceTimeoutsEntry,
  legacyJobAuthorityEntry,
  legacyTokenGrantsEntry,
  grantNewOpsEntry,
  indexAuditEntry,
  imageAssetsEntry,
  imageEmbeddingCoverageEntry,
  syncFreshnessEntry,
  gitConvergenceEntry,
  decideHealthEntry,
  unlinkedFactsEntry,
  edgeValidityEntry,
  autoChronicleEntry,
  factsDrainEntry,
  factTakeVectorsEntry,
  plannerStatsEntry,
  retrievalFeedbackEntry,
  transcriptSecretExposureEntry,
  revisionBackfillEntry,
  trustTiersEntry,
  trustScanEntry,
  trustSourcesUnclaimedEntry,
  coreMemoryEntry,
  persistenceConsumersEntry,
  atomHeldFailedEntry,
  extractionInputTruncatedEntry,
  ghostPagesEntry,
  fenceIntegrityEntry,
  searchModeEntry,
];

const CONNECTION_LANE: ReadonlySet<DoctorEntry> = new Set([offlineConnectionEntry, dbChecksGateEntry, connectionEntry, connectionGateEntry]);

/** Every check name the registry can emit (the `--only` vocabulary). */
export function doctorCheckNames(): Set<string> {
  return new Set(DOCTOR_CHECK_REGISTRY.flatMap((e) => e.emits));
}

/** #6696 B1: every check an ops-tier entry can emit (what `--tier ops` and `run_doctor` `tier: ops` report). */
export function opsCheckNames(): Set<string> {
  return new Set(DOCTOR_CHECK_REGISTRY.filter((e) => e.tier === 'ops').flatMap((e) => e.emits));
}

/** `--only a,b` / `--only=a,b` (repeatable) → the requested check names, or null when absent. */
export function parseOnlyChecks(args: readonly string[]): Set<string> | null {
  const raw: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--only' && i + 1 < args.length) raw.push(args[++i]);
    else if (args[i].startsWith('--only=')) raw.push(args[i].slice('--only='.length));
  }
  if (raw.length === 0) return null;
  return new Set(raw.flatMap((r) => r.split(',')).map((n) => n.trim()).filter(Boolean));
}

/** True when any requested check is a DB check (after the DB-checks early stop) or a declared engine check of a pre-gate entry. */
export function onlyNeedsEngine(only: ReadonlySet<string>): boolean {
  const gate = DOCTOR_CHECK_REGISTRY.indexOf(dbChecksGateEntry);
  return DOCTOR_CHECK_REGISTRY.some((e, i) => (i > gate ? e.emits : e.engineChecks ?? []).some((n) => only.has(n)));
}

function selected(entry: DoctorEntry, only: ReadonlySet<string> | null | undefined): boolean {
  return !only || CONNECTION_LANE.has(entry) || entry.emits.some((n) => only.has(n));
}

/** `--only`: keep the requested checks; a requested check that produced nothing says why. */
function onlyResult(checks: Check[], only: ReadonlySet<string>, stopped: boolean): Check[] {
  const missing = [...only].filter((n) => !checks.some((c) => c.name === n));
  const kept = checks.filter((c) => only.has(c.name) || (stopped && missing.length > 0 && c.name === 'connection'));
  for (const name of missing) {
    kept.push(stopped
      ? { name, status: 'warn', message: 'Not run: the database checks stopped early (see the connection check).', fix_unavailable_reason: 'check_errored' }
      : infoCheck(name, 'No finding: this check does not apply to this brain right now.', 'not_applicable'));
  }
  return kept;
}

/**
 * Run the registry in order. A STOP_DOCTOR result ends the run with the checks
 * gathered so far; a completed run finishes the DB-checks progress phase.
 * Under `--only`, entries that emit none of the requested checks are skipped
 * (the connection lane always runs so its early stops still hold). The run is
 * one `withGitListingCache` scope, so entries that list the same source
 * checkout share one `git ls-files` per listing.
 *
 * #6696 B1: `ctx.tier` selects entries (`entryRunsAt`; the connection lane runs
 * at every tier). Each entry runs under its budget: the per-entry budget
 * (`doctor.entry_budget_ms`) clipped to the overall deadline, or under `--tier
 * ops` the overall deadline alone with raw reads bounded on the server
 * (`deadlineEngine`). An entry past its budget reports each check it emits as
 * an unknown; an ops entry that is not applicable on PGLite reports
 * `not_applicable`. Every check carries its entry's `elapsed_ms`.
 */
export function runDoctorRegistry(ctx: DoctorContext): Promise<Check[]> {
  return withGitListingCache(async () => {
    const tier = ctx.tier ?? 'standard';
    // Under ops every entry, the connection lane included, reads through the deadline-bound engine.
    if (tier === 'ops' && ctx.engine && ctx.deadline) ctx.engine = deadlineEngine(ctx.engine, ctx.deadline);
    const checks: Check[] = [];
    let entryBudgetMs: number | null = null;
    for (const entry of DOCTOR_CHECK_REGISTRY) {
      if (!selected(entry, ctx.only)) continue;
      if (!CONNECTION_LANE.has(entry) && !entryRunsAt(entry.tier, tier)) continue;
      const started = Date.now();
      const emitted = entry.emits.filter((n) => !ctx.only || ctx.only.has(n));
      if (tier === 'ops' && entry.opsPglite === 'not_applicable' && ctx.engine?.kind === 'pglite') {
        checks.push(...emitted.map(opsNotApplicableCheck));
        continue;
      }
      if (entryBudgetMs === null && ctx.engine && !ctx.fastMode && !ctx.connectionFailed && DOCTOR_CHECK_REGISTRY.indexOf(entry) > DOCTOR_CHECK_REGISTRY.indexOf(connectionGateEntry)) {
        entryBudgetMs = await readEntryBudget(ctx);
      }
      const budgetMs = entryBudget(ctx, tier, CONNECTION_LANE.has(entry) ? null : entryBudgetMs, started);
      if (budgetMs !== null && budgetMs <= 0) {
        checks.push(...emitted.map((n) => budgetUnknownCheck(n, 0, ctx.deadline?.budgetMs ?? 0)));
        continue;
      }
      const run = entry.run(ctx)
        .catch((error: unknown): BudgetExpired => { if (error instanceof DoctorBudgetError) return BUDGET_EXPIRED; throw error; });
      const result = budgetMs === null ? await run : await raceBudget(run, budgetMs);
      const elapsed = Date.now() - started;
      if (budgetExpired(result)) {
        checks.push(...emitted.map((n) => budgetUnknownCheck(n, elapsed, budgetMs ?? ctx.deadline?.budgetMs ?? 0)));
        continue;
      }
      if (result === STOP_DOCTOR) {
        // A connect the deadline ended: every check this tier would have run is unknown, so the report says what it does not know.
        if (ctx.connectError instanceof DoctorBudgetError) {
          const at = DOCTOR_CHECK_REGISTRY.indexOf(entry);
          for (const later of DOCTOR_CHECK_REGISTRY.slice(at + 1)) {
            if (CONNECTION_LANE.has(later) || !entryRunsAt(later.tier, tier) || !selected(later, ctx.only)) continue;
            checks.push(...later.emits.filter((n) => !ctx.only || ctx.only.has(n)).map((n) => budgetUnknownCheck(n, ctx.connectError instanceof DoctorBudgetError ? ctx.connectError.elapsedMs : 0, ctx.deadline?.budgetMs ?? 0)));
          }
        }
        return ctx.only ? onlyResult(checks, ctx.only, true) : checks;
      }
      const pastDeadline = ctx.deadline?.deadlineAt != null && Date.now() >= ctx.deadline.deadlineAt;
      checks.push(...result.map((c) => {
        if (pastDeadline && c.details?.health === 'unknown' && c.details.reason === undefined) {
          const unknown = budgetUnknownCheck(c.name, elapsed, ctx.deadline!.budgetMs ?? 0);
          return { ...unknown, details: { ...unknown.details, cause: c.message } };
        }
        return c.elapsed_ms === undefined ? { ...c, elapsed_ms: elapsed } : c;
      }));
    }
    ctx.progress.finish();
    return ctx.only ? onlyResult(checks, ctx.only, false) : checks;
  });
}

/** The time this entry may take: the per-entry budget (not under ops) clipped to the overall deadline; null: unbounded. */
function entryBudget(ctx: DoctorContext, tier: DoctorTier, perEntry: number | null, now: number): number | null {
  const overall = ctx.deadline?.deadlineAt != null ? ctx.deadline.deadlineAt - now : null;
  const own = tier === 'ops' ? null : perEntry;
  if (overall === null) return own;
  return own === null ? overall : Math.min(own, overall);
}

/** `doctor.entry_budget_ms` (a positive integer), else the default; an unreadable config keeps the default. */
async function readEntryBudget(ctx: DoctorContext): Promise<number> {
  try {
    const raw = await ctx.engine!.getConfig(ENTRY_BUDGET_KEY);
    const n = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : ENTRY_BUDGET_MS_DEFAULT;
  } catch {
    return ENTRY_BUDGET_MS_DEFAULT;
  }
}
