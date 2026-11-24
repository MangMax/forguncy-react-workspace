/**
 * The flow, executed — the entry point `index.ts`, `internal.ts`, this package's tests and its
 * real-designer scripts import (#169).
 *
 * The implementation used to live in this one 1,309-line module. It is now split along the
 * seams it already had, and this file is the stable name for them so nothing outside the split
 * has to change:
 *
 * - `sync-execution.ts` — the single-target flow: read, plan, write, then the validation half
 *   (save, error check, generate), plus the transport-failure carrier a thrown call needs.
 * - `sync-batch.ts` — a batch of declared Cells: resolve all of them, run each, record every
 *   outcome including the ones a stop left unattempted.
 * - `sync-run.ts` — the run's result vocabulary, the product-read mapping and the read-back
 *   that confirms an uncertain write (#93).
 * - `sync-run-steps.ts` — what one executed step did, and the step list both a run and a
 *   thrown failure carry.
 * - `sync-report.ts` — a run and a batch as text.
 *
 * Re-exported here rather than reimplemented, so the split is invisible to every importer and
 * the module graph stays acyclic: the only module that names these siblings is this barrel,
 * and no sibling imports it.
 *
 * Decision sources: GitHub Issue #19 — "Spec: one-way MCP sync from generated artifacts to
 * Forguncy ReactCellType" (https://github.com/Mang-X/forguncy-react-workspace/issues/19), the
 * implementation Issue #20, and #93's retry-safe reporting.
 */

export { executeCellSync } from "./sync-execution.ts";
export type { ExecuteCellSyncOptions } from "./sync-execution.ts";

export {
  CELL_SYNC_BATCH_FAILURE_POLICIES,
  executeCellSyncBatch,
  executeCellSyncTargets,
  SyncBatchTransportError,
} from "./sync-batch.ts";
export type {
  CellSyncBatchFailurePolicy,
  CellSyncBatchOutcome,
  CellSyncBatchReport,
  CellSyncBatchStopReason,
  CellSyncBatchTargetRef,
  ExecuteCellSyncBatchOptions,
  ExecuteCellSyncTargetOptions,
} from "./sync-batch.ts";

export { CELL_SYNC_RUN_STATUSES, confirmCellWriteOutcome, deployedStateOfRead, readCellState } from "./sync-run.ts";
export type {
  CellReadOutcome,
  CellSyncRun,
  CellSyncRunStatus,
  CellWriteConfirmation,
  ConfirmCellWriteOptions,
} from "./sync-run.ts";

export type { SyncRunStep, SyncRunStepStatus, SyncRunSteps } from "./sync-run-steps.ts";

export { formatCellSyncBatchReport, formatCellSyncRun, formatCellSyncRuns } from "./sync-report.ts";
