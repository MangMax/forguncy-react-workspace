/**
 * What one executed step did, and how a run's step list is built.
 *
 * Split out of `executor.ts` (#169). The vocabulary has two consumers that must not import
 * each other: `sync-failure.ts` carries a step snapshot on every thrown
 * {@link SyncTransportError}, and `sync-run.ts` carries the same step list on every run
 * outcome. Keeping the three types here — rather than beside either consumer — is what keeps
 * the module graph acyclic while both still speak the flow's own step ids.
 *
 * Decision sources: #19's flow and its order, #20's execution of it, and #93's step snapshot
 * on a failed attempt.
 */

import { findMcpSyncStep } from "./capability-surface.ts";
import type { McpSyncStepId } from "./capability-surface.ts";

// ---------------------------------------------------------------------------
// What one step did
// ---------------------------------------------------------------------------

/**
 * Whether a step ran.
 *
 * `skipped` is a *deliberate* non-run with a reason — a clean project needs no save, and an
 * unchanged target needs no write — and it is separate from `not-reached`, which is a step
 * the flow never got to because an earlier one stopped it. Reporting the two together would
 * make "we chose not to save" read as "the sync died before saving", and would describe an
 * unchanged run as a truncated one.
 */
export type SyncRunStepStatus = "ran" | "skipped" | "not-reached" | "blocked";

export interface SyncRunStep {
  readonly stepId: McpSyncStepId;
  readonly order: number;
  readonly status: SyncRunStepStatus;
  /** Why it did not run, when it did not. */
  readonly detail?: string;
}

/** One executed step's status, in flow order. */
export type SyncRunSteps = readonly SyncRunStep[];

/** The steps a run performs, in the flow's own order, built once for every outcome. */
export function runSteps(
  performed: ReadonlyMap<McpSyncStepId, SyncRunStepStatus>,
  detail: ReadonlyMap<McpSyncStepId, string> = new Map(),
): SyncRunSteps {
  return [...performed.entries()].map(([stepId, status]) => {
    const step = findMcpSyncStep(stepId);
    const why = detail.get(stepId);
    return { stepId, order: step.order, status, ...(why === undefined ? {} : { detail: why }) };
  });
}
