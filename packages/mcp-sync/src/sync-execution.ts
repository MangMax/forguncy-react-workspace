/**
 * #19's flow, executed against a designer session.
 *
 * Decision source: GitHub Issue #19 — "Spec: one-way MCP sync from generated
 * artifacts to Forguncy ReactCellType"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/19) and the
 * implementation Issue #20 —
 * "Implement: MCP sync for generated Cell code and extension references"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/20).
 *
 * ## What this module is, and what it is not
 *
 * `sync-plan.ts` decides *whether* a Cell may be written and assembles the payload;
 * this module *runs the flow* — read, verify, write, save, check, generate — against
 * whatever {@link ForguncySyncPort} it is handed. Both halves are needed and neither
 * is the other: a plan alone never touches a designer, and an executor that decided
 * its own policy would be a second copy of the rules the plan exists to enforce.
 *
 * It is still not a *transport*. The port is an interface; which MCP session, which
 * URL, which retry policy is the adapter's, and #20's evidence about the designer's
 * wire shape lives in the adapter rather than here. That split is what keeps this
 * module testable without a Forguncy install and keeps the adapter's mapping honest:
 * a call this module makes is a call some evidence named.
 *
 * ## The ordering, and why it is executed rather than described
 *
 * #19's flow is a sequence with safety consequences, and every one of them is a
 * *before* or *after* the single mutation:
 *
 * 1. verify the extension metadata from the listing **before** the write;
 * 2. read the target **before** the write, so a probable designer edit is found while
 *    it can still stop the write;
 * 3. write the Cell — only when the plan's own dispatch says `issue`;
 * 4. save the project **only if** it has unsaved changes;
 * 5. check the project's errors **after** the write;
 * 6. generate the page **after** the errors are known to be zero;
 * 7. return the runtime locator.
 *
 * Steps 4–7 are also what an `unchanged` run performs, and that is deliberate rather than
 * an exception to the order: steps 1–2 established there is nothing to write, and steps
 * 5–6 are the *validation* half of the flow, which a skip does not make unnecessary. What
 * an `unchanged` run does not do is step 3, and the save step is a read-only decision on
 * that path — the project is not dirty from a write that did not happen, and the step says
 * `skipped` rather than saving a clean project.
 *
 * Steps 1–2 are the executor's own calls, and that placement is the design: it reads the
 * extension listing and the target's current state through the port *immediately* before
 * planning, so "before mutation" means *at this moment* rather than *per the caller*. The
 * options type has no field for either observation, so a stale or fabricated read is not
 * expressible — the alternative, accepting a caller's `deployed`, would let a run write over
 * a Cell a designer had edited since the caller looked, and would call that a verified sync.
 * Step 3 is the only mutating call, and it is reachable only through `planSetCellsDispatch`:
 * handing the plan's payload straight to the port does not compile, which is what makes "the
 * payload is not the permission" a check rather than a convention.
 *
 * `planCellSync` still takes a required `deployed`, and deliberately: planning is a pure
 * function of a state someone supplies (a dry run, a review, a test) and has to stay
 * callable with one. Reading is the executor's obligation, not the planner's.
 *
 * ## What it will not do
 *
 * - **It will not write when the plan refused.** A refused or unassemblable plan produces
 *   a {@link CellSyncRun} whose `status` is `refused`, and the run stops before the write.
 *   The steps after it are `not-reached`: nothing about them is wrong, the flow simply did
 *   not get there, and there is no deployment to verify.
 * - **It will not read "nothing to write" as "nothing to verify".** A target that already
 *   holds this artifact is the one hold that is not a refusal. The run reports `unchanged`,
 *   issues no `setCells`, and *does* run the save-status read, the error check and the
 *   generation — because the Cell already holding this artifact says nothing about whether
 *   the project has errors or whether the page still generates. A caller that asked for a
 *   deployment locator gets one whether or not the write was needed.
 *
 *   The locator an `unchanged` run returns is **this run's**, never a previous run's: the
 *   step that produced it is on `steps`, and a generation that fails on this path fails the
 *   run rather than falling back to a stale URL. That is why the locator is a required field
 *   of the `unchanged` variant and of `written`, and absent from `refused` — its presence is
 *   the verification result, so "unchanged, but nothing was verified" is not expressible.
 * - **It will not hide a save it performed.** The save step is the one thing an `unchanged`
 *   run can still do to the project, and it is the caller's to know about: `mutated` is on
 *   the `unchanged` variant as well as on `failed`, because "nothing was written" is a claim
 *   about the *Cell* and not about the project. A skip that persisted the project and
 *   reported only `unchanged` would tell a caller nothing had changed while the project had
 *   just been written to disk.
 * - **It will not save unconditionally.** #20 measured that a `setCells` write leaves
 *   `containsUnsavedChanges: true`, so the save is required after a write — but it is
 *   requested as "save if the project says it is dirty", not "always save", because
 *   the second would make a clean project's state depend on sync running. On the `unchanged`
 *   path the same read is what keeps a clean project clean: the step reports `skipped` rather
 *   than saving, because sync's own write is not what made anything dirty.
 * - **It will not report a failed run as a successful one.** A non-zero error count
 *   or a generation with no locator produces `status: "failed"` with the diagnostic
 *   that says why; the locator is only present when the flow reached generation *and*
 *   it succeeded.
 * - **It will not swallow a transport failure.** A rejected port call is a thrown
 *   error, not a manufactured diagnostic: the stack is the only thing that helps for
 *   a transport problem, and manufacturing a finding would lose it. See
 *   `step-outcomes.ts` for the same rule stated on the other side.
 *
 * Split out of `executor.ts` (#169) so the flow's execution, its result vocabulary
 * (`sync-run.ts`) and its reporting (`sync-report.ts`) sit in separate modules.
 */

import {
  assertMcpSyncFlowIsCoherent,
  unestablishedSyncCapabilities,
} from "./capability-surface.ts";
import type { McpSyncStepId } from "./capability-surface.ts";
import { createSyncDiagnostic } from "./diagnostics.ts";
import type { SyncDiagnostic } from "./diagnostics.ts";
import { planCellSync, planSetCellsDispatch } from "./sync-plan.ts";
import type { PlanCellSyncOptions } from "./sync-plan.ts";
import { outcomeOfPageGeneration, outcomeOfProjectErrorCheck } from "./step-outcomes.ts";
import {
  isSyncTransportError,
  mutationNotWritten,
  mutationUnknown,
  mutationWrittenByAcknowledgedWrite,
  mutationWrittenByReadBack,
  SyncTransportError,
} from "./sync-failure.ts";
import type {
  SyncFailureStage,
  SyncFailureStepSnapshot,
  SyncMutationState,
  SyncProjectSaveState,
} from "./sync-failure.ts";
import { cellTargetLabel } from "./target.ts";
import type { CellTarget } from "./target.ts";
import type {
  ForguncySyncPort,
  ForguncySyncPortMethod,
  GeneratedPage,
} from "./port.ts";
import { readCellState } from "./sync-run.ts";
import type { CellSyncRun } from "./sync-run.ts";
import { runSteps } from "./sync-run-steps.ts";
import type { SyncRunStepStatus } from "./sync-run-steps.ts";

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Everything the executor needs to plan and then execute one target's sync.
 *
 * Deliberately **without** `deployed` or `listings`. Both are things #19 requires to be
 * true *at the moment of the write* — the target's current state, and the project's
 * installed extensions — and a caller-supplied copy of either is a value nobody just
 * observed. An executor that trusted them could be handed a stale `{ kind: "read", code: "" }`
 * for a Cell a designer had since edited, or a fabricated listing, and would write anyway;
 * "the caller says it read this" is not what `before mutation` means. So the executor reads
 * both through the port itself, immediately before planning, and the types make the
 * bypass unrepresentable rather than discouraged.
 *
 * That is why the plan's own `PlanCellSyncOptions` keeps its required `deployed`: planning
 * is a pure function of a state someone supplies (a dry run, a review, a test), and it must
 * stay callable with one. The read is the *executor's* obligation, not the planner's.
 *
 * `mappings` remains accepted because it is configuration — a table to audit against, not
 * an observation of the project.
 */
export interface ExecuteCellSyncOptions extends Omit<PlanCellSyncOptions, "deployed" | "listings"> {
  readonly port: ForguncySyncPort;
}

// ---------------------------------------------------------------------------
// A failing call, reported with what the attempt knows (#93)
// ---------------------------------------------------------------------------

/**
 * The run's bookkeeping while it executes, plus the two facts a thrown failure needs.
 *
 * A small mutable carrier rather than extra return values, because the failure path is a
 * `throw`: it has to be assembled at the call site that catches, and that site needs the whole
 * snapshot, not the one step it was on.
 *
 * `mutation` is the *live* answer and is updated by the step that changes it — the write
 * before it is issued (`unknown-write-state`), the acknowledgement after (`written`). That
 * ordering is the point: if the adapter throws, the state recorded is the one that was true
 * while the call was in flight, not a guess made after it failed.
 */
interface RunProgress {
  readonly performed: Map<McpSyncStepId, SyncRunStepStatus>;
  readonly details: Map<McpSyncStepId, string>;
  mutation: SyncMutationState;
  projectSave: SyncProjectSaveState;
}

/** The step snapshot a thrown failure carries, in flow order. */
function snapshotOf(progress: RunProgress): readonly SyncFailureStepSnapshot[] {
  return runSteps(progress.performed, progress.details).map(step => ({ ...step }));
}

/**
 * Run one port call, converting a rejection into a {@link SyncTransportError}.
 *
 * The alternatives are both wrong here and #93 is about the one that is not obvious. Rethrowing
 * the bare cause keeps the stack but loses "which stage" and "may I retry?", so every caller
 * re-derives the flow's rules; manufacturing a diagnostic loses the stack and reports a
 * transport problem as a product answer. So the cause is preserved as `cause` — the stack is
 * still the thing to read — and the structured facts are added beside it.
 *
 * `retryGuidance` is chosen per state rather than composed from a template, because the
 * sentences differ in *what a caller must do*, and a state that needed a read-back first being
 * described as "just retry" is the defect this exists to prevent.
 */
async function guardedCall<T>(
  progress: RunProgress,
  target: CellTarget,
  stage: SyncFailureStage,
  operation: ForguncySyncPortMethod,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    // A failure that is already structured is rethrown as-is: it came from a guarded call, and
    // re-wrapping it would replace the state captured while the call was in flight with the
    // state this outer frame can see, which is one layer less informed.
    if (isSyncTransportError(cause)) throw cause;
    throw new SyncTransportError(
      {
        stage,
        operation,
        target,
        mutation: progress.mutation,
        projectSave: progress.projectSave,
        steps: snapshotOf(progress),
        retryGuidance: retryGuidanceFor(progress.mutation),
      },
      cause,
    );
  }
}

/**
 * What a caller may do next, given what this attempt is known to have changed.
 *
 * Three sentences, one per state, and they are not variations of one another: the
 * `unknown-write-state` case is the only one where retrying without looking is unsafe, and
 * saying so is the whole reason the state exists.
 */
function retryGuidanceFor(mutation: SyncMutationState): string {
  switch (mutation.state) {
    case "not-written":
      return "Nothing is known to have been written, so the same input can be retried; the retry reads the target again before it writes. If the failure is not transient, fix it first — see the cause's stack.";
    case "written":
      return "The target holds this artifact, so retrying the same input takes the `unchanged` path: it re-reads the target, issues no write, and finishes the steps that had not completed. Do not edit the Cell first unless that is the change you intend.";
    case "unknown-write-state":
      return "The write's outcome is unknown, so read the target back (`confirmCellWriteOutcome`) before retrying. A retry re-reads and will not overwrite a Cell that diverged in between, but do not report the write as landed until a read confirms it.";
  }
}

/**
 * Execute one target's sync: read the project's live state, plan it, then run the flow.
 *
 * The order is load-bearing and it is why this function is the safe entry point:
 *
 * 1. **read** the installed extensions (`listFrontendLibraries`) and the target Cell's
 *    current state (`readCellSource`) through the port;
 * 2. **plan** from exactly what was just read;
 * 3. **execute** what the plan permits.
 *
 * Steps 1 and 2 are not separable by a caller — the options type has no `deployed` or
 * `listings` to supply — so "the extensions were verified before the mutation" and "the
 * target's current state was read before the mutation" are properties of the code path
 * rather than claims about a caller's diligence. A caller cannot hand this function a stale
 * read, and cannot skip the read: there is nowhere to put one.
 *
 * The plan is then consulted before any mutating call, so a refused or skipped target never
 * reaches `setCells`. A resolved-but-unusable post-mutation result fails the run rather than
 * being returned as a success: see the module docstring.
 *
 * ## Recovery (#93)
 *
 * A rejected port call throws a {@link SyncTransportError} carrying the failing stage and the
 * structured mutation state, so a caller can retry the *exact same input* safely. Nothing here
 * retries by itself: the executor never loops, and it never rolls back or re-writes. The retry
 * is a second call to this function, which re-reads the target (step 1b) — that is what makes
 * "a designer edited the Cell between the failure and the retry" a `refused` run rather than a
 * silent overwrite.
 */
export async function executeCellSync(options: ExecuteCellSyncOptions): Promise<CellSyncRun> {
  // The flow's own coherence before anything is executed: a run over a registry that
  // contradicts itself would be a confident answer to the wrong question, and this is
  // the same guard `planCellSync` runs so the two cannot disagree about the flow.
  assertMcpSyncFlowIsCoherent();

  const { port, target } = options;

  const performed = new Map<McpSyncStepId, SyncRunStepStatus>();
  const details = new Map<McpSyncStepId, string>();
  const progress: RunProgress = {
    performed,
    details,
    // The flow has not reached the write yet, and the failure path needs a state even before
    // the first call: a `listFrontendLibraries` rejection happens with nothing attempted.
    mutation: mutationNotWritten("The flow stopped before the write step was reached."),
    projectSave: "not-required",
  };

  // Step 1a: the project's installed extensions, read now. Unconditional: the plan is what
  // decides whether an artifact's references matter, and it can only decide that against a
  // real listing.
  performed.set("resolve-cell-target", "ran");
  const listings = await guardedCall(progress, target, "verify-extension-metadata", "listFrontendLibraries", () =>
    port.listFrontendLibraries({}),
  );

  // Step 1b: the target's live state, read now, through the one three-way translation the
  // product requires. Reading through the port rather than accepting a caller's value is
  // what makes `before mutation` mean *at this moment* instead of *per the caller*.
  //
  // Re-read on every call, which is what makes a retry safe: a target a designer edited
  // between a failure and the retry is classified from *that* edit, not from the first
  // attempt's read, so the retry refuses rather than overwriting it.
  const { state: deployed } = await guardedCall(
    progress,
    target,
    "read-target-state",
    "readCellSource",
    () => readCellState(port, target),
  );

  // Step 2: the plan, from exactly what was just read.
  const plan = planCellSync({ ...options, deployed, listings });

  // The capabilities the flow needs. Read before executing rather than reported after
  // a failure: an empty result is the precondition for running at all, and #20's own
  // handover comment says exactly this — check it before executing, not after.
  const unestablished = unestablishedSyncCapabilities();
  if (unestablished.length > 0) {
    // Unreachable with the shipped registry (every required capability is
    // established as of #20), and written as a refusal rather than an assumption so a
    // future operation that loses its evidence stops the run here instead of sending a
    // write whose validation cannot complete.
    for (const step of plan.steps) performed.set(step.stepId, "blocked");
    return {
      status: "failed",
      target,
      plan,
      steps: runSteps(performed, details),
      diagnostics: plan.diagnostics.filter(diagnostic => diagnostic.code === "sync-capability-unestablished"),
      mutated: false,
      mutation: mutationNotWritten("No designer call was made, because the flow cannot be executed end to end."),
      projectSave: "not-required",
    };
  }

  // Both pre-mutation checks ran, in the two lines above the plan. The plan models the
  // "no listing supplied" state for dry runs; this entry point cannot reach it, which is
  // why the statuses are unconditional here.
  performed.set("verify-extension-metadata", "ran");
  performed.set("read-target-state", "ran");

  const dispatch = planSetCellsDispatch(plan);
  if (dispatch.kind === "hold") {
    // The skip is the one hold that does not stop the flow: the target already holds this
    // artifact, so the write is unnecessary — which says nothing about whether the project
    // is valid or whether the page still generates. So it runs the same validation half the
    // written path does, and reports `unchanged` rather than `refused`, because a caller
    // that conflated the two would go looking for a conflict that is not there.
    if (dispatch.reason === "already-identical") {
      // `skipped`, not `not-reached`: the flow did not die before the write, it chose not to
      // make one. The two are different answers — `SyncRunStepStatus` exists to keep "we
      // chose not to" from reading as "the sync stopped here" — and a step list that reported
      // this as `not-reached` would describe an unchanged run as a truncated one.
      performed.set("write-cell-source", "skipped");
      details.set("write-cell-source", "The target already holds this artifact, so nothing was written.");
      // A read found the artifact present, so the mutation state is known — and its evidence
      // says `read-back-identical`, which is a different claim from a write this run made.
      progress.mutation = mutationWrittenByReadBack(
        "The pre-write read found the target already holding this artifact.",
      );

      const completion = await completeSyncFlow({ ...progress, target, port, wroteCell: false });
      if (completion.kind === "failed") {
        return {
          status: "failed",
          target,
          plan,
          steps: runSteps(performed, details),
          diagnostics: completion.diagnostics,
          mutated: completion.mutated,
          mutation: completion.mutation,
          projectSave: completion.projectSave,
        };
      }

      return {
        status: "unchanged",
        target,
        plan,
        // This run's own locator. A skip is not a licence to reuse an earlier run's URL:
        // generation ran here, and its failure above would have failed the run.
        runtime: completion.runtime,
        steps: runSteps(performed, details),
        divergence: plan.divergence,
        // Whether the save step persisted the project. Not implied by the status: a run can
        // be `unchanged` and still have written to disk.
        mutated: completion.mutated,
        diagnostics: plan.diagnostics,
      };
    }

    // Every other hold stops the flow where it is, and there is no deployment to locate.
    // The steps after the write are `not-reached` rather than `blocked`: nothing is wrong
    // with them, the flow simply did not get there.
    performed.set("write-cell-source", "not-reached");
    performed.set("save-project-if-required", "not-reached");
    performed.set("check-project-errors", "not-reached");
    performed.set("generate-page", "not-reached");
    performed.set("return-runtime-locator", "not-reached");
    return {
      status: "refused",
      target,
      plan,
      // The dispatch is narrowed by its own type: `already-identical` is not assignable
      // here, so this branch cannot report the skip as a refusal.
      dispatch,
      steps: runSteps(performed, details),
      diagnostics: plan.diagnostics,
    };
  }

  // Step 4: the write. The only mutating call, and it can only be reached with the
  // request the dispatch minted — the port's parameter type makes any other value a
  // compile error at this call site.
  //
  // The state is set to `unknown-write-state` *before* the call, not after it fails, so a
  // rejection is reported as what was true while it was in flight: the call was issued and
  // its outcome is not established. Setting it after a successful return is the only way it
  // becomes `written`.
  progress.mutation = mutationUnknown(
    "The `setCells` call was issued and the adapter has not yet reported whether the product applied it.",
  );
  await guardedCall(progress, target, "write-cell-source", "setCells", () => port.setCells(dispatch.request));
  progress.mutation = mutationWrittenByAcknowledgedWrite(
    "The adapter's `setCells` call resolved, so the product acknowledged the write.",
  );
  performed.set("write-cell-source", "ran");

  const completion = await completeSyncFlow({ ...progress, target, port, wroteCell: true });
  if (completion.kind === "failed") {
    return {
      status: "failed",
      target,
      plan,
      steps: runSteps(performed, details),
      diagnostics: completion.diagnostics,
      mutated: completion.mutated,
      mutation: completion.mutation,
      projectSave: completion.projectSave,
    };
  }

  return {
    status: "written",
    target,
    plan,
    runtime: completion.runtime,
    steps: runSteps(performed, details),
    divergence: plan.divergence,
    // The plan's diagnostics only. The read-only steps' outcomes are on `steps`, and
    // repeating them here would make a caller read two lists for one run.
    diagnostics: plan.diagnostics,
  };
}

/**
 * The validation half of the flow: save if the project is dirty, check its errors, generate
 * the page, and hand back the locator.
 *
 * Extracted so the written and the unchanged paths cannot disagree about it. They differ in
 * exactly one input — whether this run wrote the Cell — and the point of the extraction is
 * that the difference stays that small: a second copy of the error gate or of the generation
 * call is where one path would quietly stop checking something.
 *
 * `wroteCell` decides one thing only, and it is the honest one: whether the run's own
 * mutation is what the project is being asked to persist. A save the product declines is
 * reported either way, because the safety rule is about the project being left unpersisted
 * rather than about who made it dirty — and `mutated` answers the caller's actual question,
 * "was anything changed before I decide what to do next?", so a run that persisted the
 * project reports it even though it never touched a Cell.
 *
 * ## Failures here are of two kinds, and they are not interchangeable (#93)
 *
 * A call that **rejects** is thrown as a {@link SyncTransportError} with the stage, the
 * operation and the state as of the failure. A call that **resolves with an unusable answer**
 * — `saved: false`, a non-zero count, no locator — returns a `failed` result. The first means
 * "the product did not answer", the second "the product answered and the answer is bad"; a
 * caller recovering from one takes a different next step, so they must not look the same.
 *
 * `progress.projectSave` is updated before each save attempt so a thrown save reports what is
 * known: the save was issued and its effect on disk is unknown, rather than "not saved".
 */
async function completeSyncFlow(options: {
  readonly performed: Map<McpSyncStepId, SyncRunStepStatus>;
  readonly details: Map<McpSyncStepId, string>;
  readonly target: CellTarget;
  readonly port: ForguncySyncPort;
  readonly wroteCell: boolean;
  readonly mutation: SyncMutationState;
  readonly projectSave: SyncProjectSaveState;
}): Promise<
  | { readonly kind: "completed"; readonly runtime: GeneratedPage; readonly mutated: boolean }
  | {
      readonly kind: "failed";
      readonly diagnostics: readonly SyncDiagnostic[];
      readonly mutated: boolean;
      readonly mutation: SyncMutationState;
      readonly projectSave: SyncProjectSaveState;
    }
> {
  const { port, target, performed, details, wroteCell } = options;

  // The carrier the guarded calls below need. It is seeded from the caller's snapshot and its
  // `projectSave` is what a thrown save reports; `mutation` never changes in this half, because
  // nothing here writes a Cell, but it is carried so a rejected call reports the run's real
  // mutation state rather than a default.
  const progress: RunProgress = {
    performed,
    details,
    mutation: options.mutation,
    projectSave: options.projectSave,
  };

  // Step 5: the save, conditional on the product's own answer. #20 measured that a
  // `setCells` write leaves `containsUnsavedChanges: true`, so the check is what turns
  // #19's conditional save into a decision rather than a guess. On the unchanged path the
  // same rule applies to the same read: the write did not happen, so this is the *project's*
  // dirtiness rather than sync's, and "save when the project says it is dirty" is still the
  // rule — an unconditional save would make a clean project's state depend on sync running.
  // The save decision starts as `unknown`: if the status read itself rejects, whether the
  // project needed persisting was never established. A clean answer moves it to
  // `not-required`; a save then moves it to `persisted` or `declined`.
  progress.projectSave = "unknown";
  const saveStatus = await guardedCall(progress, target, "save-project-if-required", "getProjectSaveStatus", () =>
    port.getProjectSaveStatus({}),
  );
  let persisted = false;
  if (saveStatus.containsUnsavedChanges) {
    // Set before the call: a save that rejects may have written the file, so `unknown` is the
    // only honest state for it. A resolved `saved: false` moves it to `declined` below.
    progress.projectSave = "unknown";
    const saved = await guardedCall(progress, target, "save-project-if-required", "saveProject", () =>
      port.saveProject(),
    );
    performed.set("save-project-if-required", "ran");
    if (!saved.saved) {
      progress.projectSave = "declined";
      // A save the product declined. Reported through the project-state owner because
      // the project — not sync and not the extension — is what is left unpersisted. It
      // fails the run on both paths: a skip is not a reason to let an unpersisted project
      // through, and the gate is the same one.
      details.set("save-project-if-required", "The product was asked to save and did not.");
      performed.set("check-project-errors", "not-reached");
      performed.set("generate-page", "not-reached");
      performed.set("return-runtime-locator", "not-reached");
      return {
        kind: "failed",
        diagnostics: [
          createSyncDiagnostic("project-errors-after-sync", cellTargetLabel(target), {
            detail: wroteCell
              ? "`api.app.saveProject` reported `saved: false` after the Cell was written, so the project was mutated but not persisted."
              : "`api.app.saveProject` reported `saved: false` while the project reported unsaved changes, so the project was left unpersisted.",
          }),
        ],
        // `declined` is not persistence; the Cell write, if any, still landed.
        mutated: wroteCell,
        mutation: progress.mutation,
        projectSave: progress.projectSave,
      };
    }
    persisted = true;
    progress.projectSave = "persisted";
  } else {
    progress.projectSave = "not-required";
    performed.set("save-project-if-required", "skipped");
    details.set(
      "save-project-if-required",
      wroteCell
        ? "The project reported no unsaved changes after the write."
        : "The project reported no unsaved changes, so there was nothing for this run to persist.",
    );
  }

  // Step 6: the project's errors, and #19's gate — non-zero fails the sync. Checked
  // *before* generation so a broken project is reported instead of being generated and
  // handed to a browser step as if it were working. On the unchanged path this is the whole
  // point of continuing: the Cell being already correct does not mean the project builds.
  const errors = await guardedCall(progress, target, "check-project-errors", "checkProjectErrors", () =>
    port.checkProjectErrors(),
  );
  const errorOutcome = outcomeOfProjectErrorCheck(errors, target, wroteCell);
  if (errorOutcome.kind === "failed") {
    performed.set("check-project-errors", "ran");
    performed.set("generate-page", "not-reached");
    performed.set("return-runtime-locator", "not-reached");
    return {
      kind: "failed",
      diagnostics: [errorOutcome.diagnostic],
      mutated: wroteCell || persisted,
      mutation: progress.mutation,
      projectSave: progress.projectSave,
    };
  }
  performed.set("check-project-errors", "ran");

  // Step 7: generate, and step 8: hand back the locator.
  const runtime = await guardedCall(progress, target, "generate-page", "generatePageAsync", () =>
    port.generatePageAsync({ pageName: target.pageName }),
  );
  const generationOutcome = outcomeOfPageGeneration(runtime);
  performed.set("generate-page", "ran");
  if (generationOutcome.kind === "failed") {
    performed.set("return-runtime-locator", "not-reached");
    return {
      kind: "failed",
      diagnostics: [generationOutcome.diagnostic],
      mutated: wroteCell || persisted,
      mutation: progress.mutation,
      projectSave: progress.projectSave,
    };
  }
  performed.set("return-runtime-locator", "ran");

  // `wroteCell || persisted`: the write, or a save this run performed. The caller reports it
  // either way, because both change project state.
  return { kind: "completed", runtime, mutated: wroteCell || persisted };
}
