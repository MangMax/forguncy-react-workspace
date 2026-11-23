/**
 * The public surface of `@forguncy-react-workspace/mcp-sync` (#159).
 *
 * Only names another workspace package, an example, or the dependency-selection Skill
 * imports are exported here. Everything else this package used to export is still reachable
 * from `./internal`, which no other package may import; the full projection and the
 * package-scope note live there.
 *
 * Governing architecture Spec Issue(s): #4, #5, #6, #12, #19
 *
 * `package-boundaries.test.ts` pins this list in both directions — the source read (types)
 * and the run-time namespace (values) — so adding a name here is a deliberate surface change.
 */

export { cellTargetLabel } from "./target.ts";
export type { SyncCellInput } from "./target.ts";
export { planCellSyncTargets, resolveCellSyncTargets } from "./registry-target.ts";
export type { CellSyncTargetPlan } from "./registry-target.ts";
export { FORGUNCY_SYNC_PORT_METHODS } from "./port.ts";
export type { ForguncySyncPort } from "./port.ts";
export { fingerprintArtifact } from "./fingerprint.ts";
export type { CellDivergence, CellOverwritePolicy, CellWriteAction, DeployedCellState } from "./divergence.ts";
export { formatCellSyncPlan, planCellSync, planSetCellsDispatch } from "./sync-plan.ts";
export type { CellSyncPlan } from "./sync-plan.ts";
export { deployedStateOfRead, executeCellSync, executeCellSyncBatch } from "./executor.ts";
export type { CellSyncBatchReport, CellSyncRun } from "./executor.ts";
