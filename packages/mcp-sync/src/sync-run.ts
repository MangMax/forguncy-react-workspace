/**
 * What a run produced, and the two reads a caller can make on their own.
 *
 * Split out of `executor.ts` (#169): the run's result vocabulary, the read mapping, and the
 * read-back that turns an uncertain write into a confirmed one. Nothing here decides
 * *whether* to write — that is `sync-plan.ts` — and nothing here executes the flow, which is
 * `sync-execution.ts`; this module is the shape of the answer plus the reads that answer it.
 *
 * Decision sources: #19's flow, #20's execution of it, and #93's retry rule ("read back rather
 * than guess").
 */

import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

import type { SyncDiagnostic } from "./diagnostics.ts";
import { classifyCellDivergence } from "./divergence.ts";
import type { CellDivergence, DeployedCellState } from "./divergence.ts";
import type { ForguncySyncPort, GeneratedPage, ReadCellSourceResult } from "./port.ts";
import type { CellSyncPlan, CellSyncRefusalDispatch } from "./sync-plan.ts";
import {
  mutationAbsentByReadBack,
  mutationHeldOtherContent,
  mutationUnknown,
  mutationWrittenByReadBack,
} from "./sync-failure.ts";
import type { SyncMutationState, SyncProjectSaveState } from "./sync-failure.ts";
import type { SyncRunSteps } from "./sync-run-steps.ts";
import type { CellTarget } from "./target.ts";

// ---------------------------------------------------------------------------
// What a read established
// ---------------------------------------------------------------------------

/**
 * A read performed by the executor, and what it means for the plan.
 *
 * Two fields rather than one because they answer different questions: the raw
 * {@link ReadCellSourceResult} is what the adapter returned, and the
 * {@link DeployedCellState} is what the plan classifies. Keeping both means a
 * reviewer can see what the product actually said when a conflict is reported,
 * instead of inferring it from a classification.
 */
export interface CellReadOutcome {
  readonly result: ReadCellSourceResult;
  readonly state: DeployedCellState;
}

/**
 * Translate what the product returned into what the plan classifies.
 *
 * The one place the product's three states and this contract's three states meet, so
 * the mapping exists once. It is deliberately a total function on the product's
 * result rather than a chain of `if`s at the call site: `blank` must become `read`
 * with an empty code (the target is genuinely vacant and writable), `occupied` must
 * become `occupied` (designer work, refused), and only a `react-cell` may become a
 * `read` with a real code. A reader that got this wrong in either direction would
 * either overwrite a designer's cell or refuse every fresh one.
 */
export function deployedStateOfRead(result: ReadCellSourceResult): DeployedCellState {
  switch (result.kind) {
    case "blank":
      return { kind: "read", code: "" };
    case "occupied":
      return { kind: "occupied", detail: result.code };
    case "react-cell":
      return { kind: "read", code: result.code, frontendLibraries: result.frontendLibraries };
  }
}

// ---------------------------------------------------------------------------
// What a run produced
// ---------------------------------------------------------------------------

export const CELL_SYNC_RUN_STATUSES = ["written", "unchanged", "refused", "failed"] as const;

export type CellSyncRunStatus = (typeof CELL_SYNC_RUN_STATUSES)[number];

/**
 * The result of executing one target's sync.
 *
 * Four statuses, and the split between `unchanged` and `refused` is the point of this shape.
 * The previous version reported both as `held`, which conflated "the write was not needed"
 * with "the write was forbidden": they call for different next actions — a refusal has to be
 * looked at by a person, an unchanged target is a finished sync — and a caller told the same
 * status for a skip as for a conflict would go looking for a conflict that is not there. The
 * plan's own vocabulary keeps both as *holds* (`CELL_SYNC_HOLD_REASONS`), because at that
 * layer "the dispatch did not issue" is the one fact; the run's status is where the two
 * consequences separate.
 *
 * A discriminated union rather than a status plus optional fields, for the reason
 * `sync-plan.ts` gives about `CellSyncWrite`: the four carry different things, and a shape
 * that could hold all of them would let a caller read the wrong one.
 *
 * `runtime` is present on `written` and on `unchanged` and **absent from `refused` and
 * `failed`**. On `written` it means the deployment happened; on `unchanged` it means the
 * deployment was already there and *this* run still checked the project and generated the
 * page. It is a required field on both rather than an optional one, so neither "written with
 * nothing to open" nor "unchanged with nothing verified" is representable — and it is
 * deliberately not carried on `refused`, because there is no deployment to locate.
 */
export type CellSyncRun =
  | {
      readonly status: "written";
      readonly target: CellTarget;
      readonly plan: CellSyncPlan;
      /**
       * The locator the flow produced.
       *
       * Present exactly when the write landed, the project was checked and the page
       * generated — the three conditions the caller needs before opening a browser.
       */
      readonly runtime: GeneratedPage;
      readonly steps: SyncRunSteps;
      readonly divergence: CellDivergence;
      readonly diagnostics: readonly SyncDiagnostic[];
    }
  | {
      /**
       * The target already held this artifact, so nothing was written.
       *
       * A skip, not a refusal: the plan's dispatch held for `already-identical`, and the
       * run still performed the validation half of the flow.
       */
      readonly status: "unchanged";
      readonly target: CellTarget;
      readonly plan: CellSyncPlan;
      /**
       * The locator **this** run's generation produced.
       *
       * Required rather than optional, and it is the run's own: a skip says the Cell is
       * already correct, not that the project was checked or the page generated. Reusing a
       * previous run's locator here would claim a verification this run did not perform,
       * and the failure — an `unchanged` run reported as verified while generation failed —
       * is exactly what a browser-verification step would then act on.
       */
      readonly runtime: GeneratedPage;
      readonly steps: SyncRunSteps;
      readonly divergence: CellDivergence;
      /**
       * This run changed project state even though it wrote no Cell.
       *
       * True exactly when the save step persisted a project the product reported dirty. It
       * is the same question {@link CellSyncRun}'s `failed` variant asks, and it is here for
       * the same reason: "nothing was written" is a claim about the Cell, not about the
       * project, and a caller deciding whether it may discard a backup needs the project's
       * answer rather than the Cell's.
       */
      readonly mutated: boolean;
      readonly diagnostics: readonly SyncDiagnostic[];
    }
  | {
      readonly status: "refused";
      readonly target: CellTarget;
      readonly plan: CellSyncPlan;
      /**
       * The plan's own answer for why nothing was sent.
       *
       * Narrowed to a *refusing* hold rather than the full {@link CellSyncDispatch}: a run
       * is `refused` precisely because the dispatch held for a reason that stops the flow,
       * so a caller should not have to re-check what this type already knows — and a
       * `already-identical` dispatch is not assignable here, which is what keeps the skip
       * from being reported as a refusal.
       */
      readonly dispatch: CellSyncRefusalDispatch;
      readonly steps: SyncRunSteps;
      readonly diagnostics: readonly SyncDiagnostic[];
    }
  | {
      readonly status: "failed";
      readonly target: CellTarget;
      readonly plan: CellSyncPlan;
      readonly steps: SyncRunSteps;
      /**
       * What failed, in the sync's own vocabulary. Never empty.
       *
       * A *resolved* failure — a declined save, a non-zero error count, a generation with no
       * locator — is reported this way. A call that *rejects* is thrown as a
       * {@link SyncTransportError}, because a stack is the only thing that helps for a
       * transport problem (see `step-outcomes.ts`); the resolved case and the thrown case
       * deliberately do not share a shape, so "a call failed" is never read as "the product
       * answered something unusable".
       */
      readonly diagnostics: readonly SyncDiagnostic[];
      /**
       * This run changed project state before it failed.
       *
       * Two ways that happens, and both count: the Cell write landed, or the project
       * reported unsaved changes and the save persisted them. Carried so a caller knows
       * whether the project was changed before deciding what to do next — a run that failed
       * at the error check left a Cell written, a run that failed after a save left the
       * project persisted, and a run that failed to assemble left nothing.
       */
      readonly mutated: boolean;
      /**
       * What is known about the Cell mutation itself (#93).
       *
       * `mutated` answers "was any project state changed?"; this answers the narrower and
       * more actionable "does the target hold this artifact, and how is that known?". A caller
       * retrying the same input needs the second: `written` means the retry will take the
       * `unchanged` path and issue no write, while `not-written` means it will write once.
       */
      readonly mutation: SyncMutationState;
      /**
       * Whether the project was persisted, and why not when it was not (#93).
       *
       * Separate from `mutation` because a Cell write and a project save are different
       * mutations: a run can leave a written Cell unpersisted, and a caller deciding whether
       * the project on disk is current needs that answer.
       */
      readonly projectSave: SyncProjectSaveState;
    };

// ---------------------------------------------------------------------------
// Reading a target
// ---------------------------------------------------------------------------

/**
 * Read the target and turn it into the plan's input.
 *
 * A convenience over the port rather than a second policy: it performs the read #19's
 * step 3 requires and maps the product's answer through {@link deployedStateOfRead}, so
 * a caller that has a port does not hand-write the three-way mapping. It exists because
 * the alternative is every caller doing it, and the two ways to get it wrong (treating
 * a blank Cell as unread, or an occupied one as blank) are both silent.
 */
export async function readCellState(
  port: ForguncySyncPort,
  target: CellTarget,
): Promise<CellReadOutcome> {
  const result = await port.readCellSource({ pageName: target.pageName, cell: target.cell });
  return { result, state: deployedStateOfRead(result) };
}

// ---------------------------------------------------------------------------
// Confirming an uncertain write (#93)
// ---------------------------------------------------------------------------

export interface ConfirmCellWriteOptions {
  readonly port: ForguncySyncPort;
  readonly target: CellTarget;
  readonly artifact: CompileCellResult;
}

/**
 * What a read of the target says about an earlier write whose outcome was not acknowledged.
 *
 * Two facts, because they answer different questions: {@link CellWriteConfirmation.mutation}
 * is the attempt-level answer ("did the artifact land?"), and `divergence` is the plan-level
 * one ("what will a retry do about it?"). They are not the same value: a Cell holding a
 * designer's edit is `not-written` as a mutation — this artifact is not there — while a retry
 * will *refuse* rather than overwrite it, and a caller that collapsed the two would read the
 * refusal as a fresh write.
 */
export interface CellWriteConfirmation {
  readonly mutation: SyncMutationState;
  readonly divergence: CellDivergence;
}

/**
 * Read the target back and say, from the Cell itself, whether an uncertain write landed.
 *
 * This is the "read back rather than guess" half of #93's retry rule. It is a separate export
 * because recovery is not always an immediate retry: a caller may want to report what happened
 * before deciding, and the executor's retry path would read the same Cell again anyway. The
 * read is the *only* evidence used — no remembered acknowledgement, no timestamps — so the
 * answer is a property of the project at this moment.
 *
 * A read that rejects is **not** turned into `unknown-write-state` here: the rejection is a
 * transport failure with a stack, and swallowing it into a state value would leave the caller
 * unable to tell "the target does not hold it" from "nobody could look". Callers that need the
 * latter catch the rejection and keep their existing `unknown-write-state`; that is the honest
 * composition, and the batch's failure record is the same shape.
 */
export async function confirmCellWriteOutcome(options: ConfirmCellWriteOptions): Promise<CellWriteConfirmation> {
  const { port, target, artifact } = options;
  const { state } = await readCellState(port, target);
  const divergence = classifyCellDivergence(state, artifact);

  switch (divergence.kind) {
    case "identical":
      return {
        mutation: mutationWrittenByReadBack(
          "The read found the target holding this artifact's source and library references.",
        ),
        divergence,
      };
    case "vacant":
    case "previous-generation":
      return {
        mutation: mutationAbsentByReadBack(
          "The read found no copy of this artifact in the target, so the write did not land.",
        ),
        divergence,
      };
    case "unverifiable":
      return {
        mutation: mutationUnknown(
          "The target could not be read after the uncertain write, so its content is still unknown.",
        ),
        divergence,
      };
    // Everything else is content that is not this artifact: designer work, an edit after
    // generation, or a damaged marker. The write did not land, and — unlike the plain
    // `vacant` case — a retry will refuse to overwrite what is there. Both facts are on the
    // result rather than folded into a single "not written".
    default:
      return {
        mutation: mutationHeldOtherContent(
          `The read found content that is not this artifact (${divergence.kind}), so the uncertain write did not land and a retry will refuse to overwrite it unless the target is resolved.`,
        ),
        divergence,
      };
  }
}
