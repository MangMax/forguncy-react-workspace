/**
 * A batch of declared Cells: resolve them all, then run each through the executor.
 *
 * Split out of `executor.ts` (#169). The single-target flow lives in `sync-execution.ts`;
 * this module is only about running that flow more than once, and about reporting what a
 * batch did when one target stops it.
 *
 * Decision sources: #19's flow, #20's execution of it, #93's partial-success record, and #87's
 * rule that a batch's mappings default to the registry's own table.
 */

import type { CellRegistry } from "@forguncy-react-workspace/core";

import { resolveCellSyncTargets } from "./registry-target.ts";
import type { CellSyncTargetPlan } from "./registry-target.ts";
import { isSyncTransportError } from "./sync-failure.ts";
import type { SyncTransportError } from "./sync-failure.ts";
import { cellTargetLabel } from "./target.ts";
import type { CellTarget } from "./target.ts";
import type { ForguncySyncPort } from "./port.ts";
import { executeCellSync } from "./sync-execution.ts";
import type { CellSyncRun } from "./sync-run.ts";

// ---------------------------------------------------------------------------
// A batch
// ---------------------------------------------------------------------------

/**
 * One target's sync in a batch: a declared Cell id, an artifact, and the port.
 *
 * Nothing observable about the project is accepted — no `deployed`, no `listings`.
 * {@link executeCellSync} reads both itself, per target, so a batch cannot be handed a
 * snapshot from the start of the run (which by the second target would already be stale) and
 * cannot be handed a fabricated one. The type makes that structural rather than a rule:
 * there is no field for a caller to put an observation in.
 *
 * `mappings` and `overwrite` remain, because they are configuration rather than
 * observations: a table to audit against, and a policy decision the caller owns.
 */
export interface ExecuteCellSyncTargetOptions extends Omit<CellSyncTargetPlan, "deployed" | "listings"> {
  readonly port: ForguncySyncPort;
}

/**
 * Read and execute a batch of declared Cells.
 *
 * The batch's targets are resolved — and their uniqueness re-asserted across all of
 * them — *before* any read or write, so a project where two ids claim one destination
 * fails as a whole instead of writing N-1 Cells and one overwrite. That is
 * `resolveCellSyncTargets`'s rule, and running it here is what keeps the executor from
 * being a path around it.
 *
 * Each target then goes through {@link executeCellSync}, which reads that target and the
 * project's extension listing immediately before planning it. The reads are per target
 * rather than once for the batch on purpose: a listing taken at the start would be a weaker
 * claim by the time the last Cell was written, and the whole point of `before mutation` is
 * that it is *before this one*.
 *
 * ## Partial success (#93)
 *
 * A thrown transport failure used to end this function with no record of what the earlier
 * targets had already written. It still throws — a batch is not a place to swallow a stack —
 * but the throw is a {@link SyncBatchTransportError} carrying the per-target
 * {@link CellSyncBatchReport}, so "target 1 landed, target 2 is unknown, target 3 was never
 * attempted" survives the failure. Use {@link executeCellSyncBatch} directly when the caller
 * wants the report without an exception, or wants the `continue` policy.
 */
export async function executeCellSyncTargets(
  registry: CellRegistry,
  plans: readonly ExecuteCellSyncTargetOptions[],
  options: ExecuteCellSyncBatchOptions = {},
): Promise<readonly CellSyncRun[]> {
  const report = await executeCellSyncBatch(registry, plans, {
    // Preserve the function's historical contract: a transport failure always throws. The
    // policy only decides whether the *remaining* targets were attempted before the throw.
    onTransportFailure: "stop",
    onFailedRun: "continue",
    ...options,
  });
  if (report.failures.length > 0) throw new SyncBatchTransportError(report);
  return report.runs;
}

export const CELL_SYNC_BATCH_FAILURE_POLICIES = ["stop", "continue"] as const;

/**
 * Whether a batch keeps going after a failure.
 *
 * Two policies rather than one boolean because "stop" is not the only defensible answer and
 * the caller is the one who knows: a deploy pipeline usually wants to stop before writing more
 * Cells onto a project it cannot validate, while a diagnostic run wants every target's outcome
 * in one pass. Either way the report keeps the earlier outcomes — the policy chooses what
 * happens *next*, never what is reported about what already happened.
 */
export type CellSyncBatchFailurePolicy = (typeof CELL_SYNC_BATCH_FAILURE_POLICIES)[number];

export interface ExecuteCellSyncBatchOptions {
  /**
   * What to do after a target's sync throws a {@link SyncTransportError}.
   *
   * Defaults to `stop`: a transport failure is the one case where the next target's write may
   * be built on a project whose state nobody established.
   */
  readonly onTransportFailure?: CellSyncBatchFailurePolicy;
  /**
   * Whether a run that finished as `failed` stops the batch.
   *
   * Defaults to `continue`, which is the executor's historical behaviour: a resolved failure
   * (non-zero errors, a declined save, no locator) is a *result*, and the next target can
   * still be attempted. A caller that treats the project as unusable after any failed run can
   * ask for `stop`.
   */
  readonly onFailedRun?: CellSyncBatchFailurePolicy;
}

export type CellSyncBatchStopReason = "transport-failure" | "failed-run";

/** The target a batch outcome belongs to, identified the way the caller named it. */
export interface CellSyncBatchTargetRef {
  readonly index: number;
  readonly cellId: string;
  readonly target: CellTarget;
}

export type CellSyncBatchOutcome =
  | (CellSyncBatchTargetRef & { readonly kind: "run"; readonly run: CellSyncRun })
  | (CellSyncBatchTargetRef & { readonly kind: "transport-failure"; readonly error: SyncTransportError })
  | (CellSyncBatchTargetRef & {
      readonly kind: "not-attempted";
      readonly reason: CellSyncBatchStopReason;
      /** The target whose outcome stopped the batch. */
      readonly stoppedAtIndex: number;
      readonly stoppedAtCellId: string;
    });

/**
 * One batch's per-target record.
 *
 * `outcomes` is the complete list, one entry per requested target and in request order, so a
 * caller can render "landed / failed / never attempted" without re-reading `runs` and
 * `failures` side by side. `runs` and `failures` are the same facts grouped for code that
 * branches on them, and `mutatedTargets`/`uncertainTargets` are the two answers a recovery
 * decision actually needs: what this batch changed, and what it may have changed.
 */
export interface CellSyncBatchReport {
  readonly onTransportFailure: CellSyncBatchFailurePolicy;
  readonly onFailedRun: CellSyncBatchFailurePolicy;
  readonly outcomes: readonly CellSyncBatchOutcome[];
  readonly runs: readonly CellSyncRun[];
  readonly failures: readonly SyncTransportError[];
  /** Targets whose Cell or project this batch is known to have changed. */
  readonly mutatedTargets: readonly CellTarget[];
  /** Targets whose `setCells` call failed, so whether they changed is unknown. */
  readonly uncertainTargets: readonly CellTarget[];
  /** True when at least one target was never attempted because an earlier one stopped the batch. */
  readonly stoppedEarly: boolean;
}

/**
 * A batch that stopped on a transport failure, with everything the earlier targets did.
 *
 * A subclass rather than a plain `Error` so `instanceof` still distinguishes it, and with
 * `report` as the field rather than a message summary: the per-target facts are structured and
 * a caller recovering from this should not have to parse prose to find which Cells landed.
 */
export class SyncBatchTransportError extends Error {
  readonly code = "sync-batch-transport-failure";
  readonly report: CellSyncBatchReport;

  constructor(report: CellSyncBatchReport) {
    const first = report.failures[0];
    super(
      `${report.failures.length} target(s) failed during a batch${
        first === undefined ? "" : ` (first: ${cellTargetLabel(first.target)} at ${first.stage}/${first.operation})`
      }; ${report.mutatedTargets.length} target(s) were confirmed written, ${report.uncertainTargets.length} have an unknown write state, and ${report.outcomes.filter(outcome => outcome.kind === "not-attempted").length} were not attempted. The report carries each target's outcome.`,
      { cause: first },
    );
    this.name = "SyncBatchTransportError";
    this.report = report;
  }
}

/**
 * Read and execute a batch, reporting every target instead of stopping at the first throw.
 *
 * The batch is resolved once, up front, by the same guarded resolver
 * {@link executeCellSyncTargets} uses. Resolution failures still throw before anything is
 * read or written: they are request-level mistakes with no partial project to describe.
 *
 * Each target's run is either a {@link CellSyncRun} (including a `failed` one) or a
 * {@link SyncTransportError}. Both are outcomes, not exceptions, so a caller gets the whole
 * batch's state in one pass — and a policy decides whether the next target is attempted.
 */
export async function executeCellSyncBatch(
  registry: CellRegistry,
  plans: readonly ExecuteCellSyncTargetOptions[],
  options: ExecuteCellSyncBatchOptions = {},
): Promise<CellSyncBatchReport> {
  const onTransportFailure = options.onTransportFailure ?? "stop";
  const onFailedRun = options.onFailedRun ?? "continue";

  // Resolve the whole batch up front: an unresolvable or colliding request throws here,
  // before any read or write has happened, so there is no partially-written project to
  // reason about. `resolveCellSyncTargets` is the guarded path — it re-asserts registry
  // uniqueness and the batch's own distinctness — and it is called *once* for the batch so
  // the cross-member check sees every claim.
  const resolved = resolveCellSyncTargets(
    registry,
    plans.map(plan => plan.cellId),
  );

  const outcomes: CellSyncBatchOutcome[] = [];
  const runs: CellSyncRun[] = [];
  const failures: SyncTransportError[] = [];
  const mutatedTargets: CellTarget[] = [];
  const uncertainTargets: CellTarget[] = [];

  let stoppedAt: { readonly index: number; readonly cellId: string; readonly reason: CellSyncBatchStopReason } | undefined;

  for (const [index, planOptions] of plans.entries()) {
    const resolvedTarget = resolved[index];
    if (resolvedTarget === undefined) {
      // Unreachable: the resolver returns one entry per input.
      throw new Error(`No resolved target for Cell ${planOptions.cellId}.`);
    }
    const ref: CellSyncBatchTargetRef = {
      index,
      cellId: planOptions.cellId,
      target: resolvedTarget.target,
    };

    if (stoppedAt !== undefined) {
      outcomes.push({
        ...ref,
        kind: "not-attempted",
        reason: stoppedAt.reason,
        stoppedAtIndex: stoppedAt.index,
        stoppedAtCellId: stoppedAt.cellId,
      });
      continue;
    }

    try {
      const run = await executeCellSync({
        target: ref.target,
        artifact: planOptions.artifact,
        decisions: planOptions.decisions,
        port: planOptions.port,
        // The project's normalized mapping set, unless the caller supplied one explicitly (#87) —
        // the same rule `planCellSyncTargets` applies, for the same reason: the batch's registry is
        // the one place this run knows what `compileCell` planned the artifact against.
        mappings: planOptions.mappings ?? registry.extensionMappings.mappings,
        ...(planOptions.overwrite === undefined ? {} : { overwrite: planOptions.overwrite }),
      });
      runs.push(run);
      outcomes.push({ ...ref, kind: "run", run });

      if (
        run.status === "written" ||
        ((run.status === "unchanged" || run.status === "failed") && run.mutated)
      ) {
        mutatedTargets.push(ref.target);
      }
      if (run.status === "failed" && onFailedRun === "stop") {
        stoppedAt = { index, cellId: ref.cellId, reason: "failed-run" };
      }
    } catch (error) {
      // Only a structured transport failure is an outcome. Anything else here is a bug in the
      // executor or the plan — a caller-supplied `mappings` table that throws, say — and
      // turning it into a per-target record would report a programming error as a designer
      // failure. So it propagates.
      if (!isSyncTransportError(error)) throw error;
      failures.push(error);
      outcomes.push({ ...ref, kind: "transport-failure", error });
      if (error.mutation.state === "written") mutatedTargets.push(ref.target);
      if (error.mutation.state === "unknown-write-state") uncertainTargets.push(ref.target);
      if (onTransportFailure === "stop") {
        stoppedAt = { index, cellId: ref.cellId, reason: "transport-failure" };
      }
    }
  }

  return {
    onTransportFailure,
    onFailedRun,
    outcomes,
    runs,
    failures,
    mutatedTargets,
    uncertainTargets,
    stoppedEarly: outcomes.some(outcome => outcome.kind === "not-attempted"),
  };
}
