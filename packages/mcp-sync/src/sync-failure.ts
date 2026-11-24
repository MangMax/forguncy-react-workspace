/**
 * What a failed sync attempt knows about the state it left behind.
 *
 * Decision source: GitHub Issue #93 — "MCP 恢复：覆盖写入后保存、检查、生成失败的安全重试"
 * (https://github.com/MangX/forguncy-react-workspace/issues/93), which builds on #92's
 * `unchanged` path (https://github.com/MangX/forguncy-react-workspace/issues/92) and #19's
 * flow (https://github.com/MangX/forguncy-react-workspace/issues/19).
 *
 * ## The problem this module states rather than hides
 *
 * A sync is several designer calls in a fixed order, and the flow's own safety says a
 * transport failure is a thrown error rather than a manufactured diagnostic — the stack is
 * the only thing that helps for a connection problem (see `step-outcomes.ts`). But a caller
 * recovering from one needs two more facts than a stack can carry:
 *
 * 1. **Which step failed**, in the flow's own vocabulary, so "retry" is not a guess about
 *    what to retry.
 * 2. **What the attempt already changed**, which is *not* a boolean. The write either never
 *    happened, was acknowledged, or — the dangerous case — was sent and its outcome is
 *    unknown because the call itself failed. Reporting the last one as either success or
 *    failure is how a retry either duplicates a write or overwrites a Cell it should have
 *    read first.
 *
 * So a transport failure is still thrown (the stack stays reachable through `cause`), but it
 * is thrown as a {@link SyncTransportError} carrying the stage, the port operation, the
 * structured {@link SyncMutationState}, the project-persistence state, and the step snapshot
 * as of the failure. The retry itself is deliberately **not** automatic: there is no retry
 * loop in this package, because "retry same input" is safe only when the target is re-read
 * first, and {@link SyncTransportError} tells a caller exactly when that matters.
 *
 * ## Why `unknown-write-state` is its own state
 *
 * `setCells` is the only mutating call, and a rejected `setCells` is the one failure whose
 * effect this process cannot observe. The product may have applied the write and failed on
 * the response, or may never have received it. Two wrong answers are available and both are
 * common: assume success (report a locator for an unverified page) or assume failure (replay
 * the write over a Cell a designer may have edited in between). `unknown-write-state` names
 * the actual knowledge, and `confirmCellWriteOutcome` in `sync-run.ts` is the read-back that
 * turns it into one of the two confirmed states before a caller retries.
 */

import type { McpSyncStepId } from "./capability-surface.ts";
import type { SyncRunStepStatus } from "./sync-run-steps.ts";
import type { ForguncySyncPortMethod } from "./port.ts";
import { cellTargetLabel } from "./target.ts";
import type { CellTarget } from "./target.ts";

// ---------------------------------------------------------------------------
// What is known about the mutation
// ---------------------------------------------------------------------------

export const SYNC_MUTATION_STATES = ["not-written", "written", "unknown-write-state"] as const;

/**
 * How a sync attempt's mutation stands, as of the moment it stopped.
 *
 * The three states are about **this attempt's write**, not about whether the target holds
 * *some* artifact:
 *
 * - `not-written` — the attempt did not issue a `setCells` that is known to have landed. It
 *   was either stopped before the write or the target was read back and does not hold this
 *   artifact.
 * - `written` — the Cell holds this artifact. `evidence` says how that is known, and the two
 *   values are not interchangeable: `write-acknowledged` is the adapter's acknowledgement of
 *   *this* attempt's call, while `read-back-identical` is a subsequent read and can be true on
 *   a run that never wrote (the `unchanged` path).
 * - `unknown-write-state` — a `setCells` call was issued and failed before its outcome was
 *   acknowledged, so neither of the above is known. A retry must read the target first
 *   (`confirmCellWriteOutcome`) rather than replay the write blindly.
 *
 * Read this as the answer to "may I safely retry the same input?": `not-written` and
 * `written` may, because the retry re-reads and either writes once or skips; the
 * `unknown-write-state` needs a read-back first, which the retry performs anyway but a caller
 * reporting the failure should say so.
 */
export type SyncMutationState =
  | {
      readonly state: "not-written";
      /**
       * Why nothing is known to have been written.
       *
       * `write-step-not-reached` is the flow stopping before `setCells`; `read-back-holds-no-artifact`
       * is a subsequent read that found a vacant or earlier-generation Cell; and
       * `read-back-holds-other-content` is a read that found something this artifact is not,
       * which includes designer work a retry will refuse to overwrite.
       */
      readonly evidence: "write-step-not-reached" | "read-back-holds-no-artifact" | "read-back-holds-other-content";
      readonly detail: string;
    }
  | {
      readonly state: "written";
      readonly evidence: "write-acknowledged" | "read-back-identical";
      readonly detail: string;
    }
  | {
      readonly state: "unknown-write-state";
      readonly detail: string;
    };

/** The mutation state of a run that never reached the write. */
export function mutationNotWritten(detail: string): SyncMutationState {
  return { state: "not-written", evidence: "write-step-not-reached", detail };
}

/** The mutation state of a read that found no copy of this artifact in the target. */
export function mutationAbsentByReadBack(detail: string): SyncMutationState {
  return { state: "not-written", evidence: "read-back-holds-no-artifact", detail };
}

/** The mutation state of a target a read found holding something other than this artifact. */
export function mutationHeldOtherContent(detail: string): SyncMutationState {
  return { state: "not-written", evidence: "read-back-holds-other-content", detail };
}

/** The mutation state of a write the adapter acknowledged. */
export function mutationWrittenByAcknowledgedWrite(detail: string): SyncMutationState {
  return { state: "written", evidence: "write-acknowledged", detail };
}

/** The mutation state of a read that found the artifact already present. */
export function mutationWrittenByReadBack(detail: string): SyncMutationState {
  return { state: "written", evidence: "read-back-identical", detail };
}

/** The mutation state of a write whose effect the failed call did not establish. */
export function mutationUnknown(detail: string): SyncMutationState {
  return { state: "unknown-write-state", detail };
}

/** One sentence for a report line or a diagnostic, without inventing certainty. */
export function describeSyncMutationState(state: SyncMutationState): string {
  switch (state.state) {
    case "not-written":
      return `no write is known to have landed (${state.evidence}): ${state.detail}`;
    case "written":
      return `the target holds this artifact (${state.evidence}): ${state.detail}`;
    case "unknown-write-state":
      return `the setCells call failed and its outcome is unknown: ${state.detail}`;
  }
}

// ---------------------------------------------------------------------------
// What is known about project persistence
// ---------------------------------------------------------------------------

/**
 * Whether this attempt persisted the project, and why not when it did not.
 *
 * Separate from {@link SyncMutationState} because they are different mutations: a Cell write
 * can land while the project is left unsaved, and `getProjectSaveStatus` can fail without any
 * save having been attempted. `unknown` is the state a thrown save call leaves behind — the
 * product may have written the file and failed on the answer — and it is deliberately not
 * spelled `declined`, which is the product's own `saved: false`.
 */
export type SyncProjectSaveState = "not-required" | "persisted" | "declined" | "unknown";

// ---------------------------------------------------------------------------
// The failing stage
// ---------------------------------------------------------------------------

/**
 * The steps a transport call can fail at, in flow order.
 *
 * Narrowed to the steps the executor actually performs through the port. A failure cannot
 * belong to `resolve-cell-target` or `return-runtime-locator`: the first is repository
 * configuration and the second is the result type, so neither has a call to reject. Typing
 * the list as `satisfies readonly McpSyncStepId[]` keeps the names in the flow's vocabulary
 * rather than inventing a parallel one.
 */
export const SYNC_FAILURE_STAGES = [
  "verify-extension-metadata",
  "read-target-state",
  "write-cell-source",
  "save-project-if-required",
  "check-project-errors",
  "generate-page",
] as const satisfies readonly McpSyncStepId[];

export type SyncFailureStage = (typeof SYNC_FAILURE_STAGES)[number];

/** The step snapshot carried on a failure, in flow order. */
export interface SyncFailureStepSnapshot {
  readonly stepId: McpSyncStepId;
  readonly order: number;
  readonly status: SyncRunStepStatus;
  readonly detail?: string;
}

export interface SyncTransportFailureDetails {
  readonly stage: SyncFailureStage;
  /** Which port method rejected. Finer than the step, and the call a caller retries. */
  readonly operation: ForguncySyncPortMethod;
  readonly target: CellTarget;
  readonly mutation: SyncMutationState;
  readonly projectSave: SyncProjectSaveState;
  /** What the flow had done when the call failed, so a retry starts from a known point. */
  readonly steps: readonly SyncFailureStepSnapshot[];
  /**
   * A sentence a recovery step can act on, beyond the stack.
   *
   * Stated on the failure rather than derived by every caller because the answer is a rule of
   * this flow, not a property of an exception.
   */
  readonly retryGuidance: string;
}

/** The error code every transport failure carries, so a catch can branch without `instanceof`. */
export const SYNC_TRANSPORT_FAILURE_CODE = "sync-transport-failure";

/**
 * A designer call that rejected, with the flow's knowledge of what the attempt changed.
 *
 * **The original error is `cause`.** The stack is preserved rather than flattened into a
 * message, which is the same rule `step-outcomes.ts` states for why a rejected call is not a
 * diagnostic: a transport problem is diagnosed from the stack. The message repeats the cause
 * message so a log line is still useful, but recovery code should read `cause`.
 *
 * A class rather than a plain object because it *is* an error: `throw`ing it keeps the
 * executor's existing contract ("a rejected port call propagates"), while the fields make
 * "which stage, and may I retry?" answerable without parsing text.
 */
export class SyncTransportError extends Error {
  readonly code = SYNC_TRANSPORT_FAILURE_CODE;
  readonly stage: SyncFailureStage;
  readonly operation: ForguncySyncPortMethod;
  readonly target: CellTarget;
  readonly mutation: SyncMutationState;
  readonly projectSave: SyncProjectSaveState;
  readonly steps: readonly SyncFailureStepSnapshot[];
  readonly retryGuidance: string;

  constructor(details: SyncTransportFailureDetails, cause: unknown) {
    super(
      `Sync failed at ${details.stage} (${details.operation}) for ${cellTargetLabel(details.target)}: ${messageOf(cause)}`,
      { cause },
    );
    this.name = "SyncTransportError";
    this.stage = details.stage;
    this.operation = details.operation;
    this.target = details.target;
    this.mutation = details.mutation;
    this.projectSave = details.projectSave;
    this.steps = details.steps;
    this.retryGuidance = details.retryGuidance;
  }
}

/**
 * Recognise a {@link SyncTransportError} even after a boundary re-wrapped it.
 *
 * The `code` check is why this is not only `instanceof`: a library that copies an error (or a
 * different realm) loses the prototype, and a recovery path that silently stopped recognising
 * the structured failure would fall back to treating an unknown write as safe to replay.
 */
export function isSyncTransportError(value: unknown): value is SyncTransportError {
  if (value instanceof SyncTransportError) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly code?: unknown; readonly stage?: unknown; readonly mutation?: unknown };
  return (
    candidate.code === SYNC_TRANSPORT_FAILURE_CODE &&
    typeof candidate.stage === "string" &&
    typeof candidate.mutation === "object" &&
    candidate.mutation !== null
  );
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/** A report block for a CI log, a PR body or a recovery prompt. */
export function formatSyncTransportFailure(error: SyncTransportError): string {
  return [
    `Sync transport failure: ${cellTargetLabel(error.target)} at ${error.stage} (${error.operation})`,
    `Mutation: ${describeSyncMutationState(error.mutation)}`,
    `Project persistence: ${error.projectSave}`,
    `Retry: ${error.retryGuidance}`,
    `Cause: ${messageOf(error.cause)}`,
  ].join("\n");
}
