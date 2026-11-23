/**
 * "Every declared Cell compiled, or nothing is planned or synced" — once, for both verbs.
 *
 * Decision source: GitHub Issue #157
 * (https://github.com/MangMax/forguncy-react-workspace/issues/157), under #152: the guard that
 * refuses a rejected compile exists in one place, with a type-guard filter rather than an
 * `as Extract` cast at each call site.
 *
 * ## Why the guard is shared and the sentences are not
 *
 * `plan` and `sync` must agree on *whether* they may proceed — a plan over a half-built project
 * describes a sync of Cells that do not exist, and a sync over one would write a partial project —
 * so the decision is one function. They must not agree on *what a reader is told*: a refusal from
 * `plan` names the diagnostic codes and says nothing was planned, while one from `sync` says
 * nothing was read and nothing was written. Each verb supplies its own sentence, and the guard
 * supplies the fact.
 *
 * ## Why a type guard rather than a cast
 *
 * The rejected branch of `CompileCellOutcome` is a different shape from the compiled one, so a
 * caller that filtered by `status` and then cast was asserting something the compiler could not
 * check — and a future outcome status would make the cast silently wrong. `isCompiledCell` narrows
 * the outcome itself, so the artifact each verb needs is typed where it is read.
 */

import type { BuiltCell, CompileCellOutcome, CompileCellResult } from "@forguncy-react-workspace/cell-compiler";

import type { ProjectBuild } from "./build.ts";

/** The compiled branch of a Cell's outcome. */
type CompiledOutcome = Extract<CompileCellOutcome, { status: "compiled" }>;

/** The rejected branch of a Cell's outcome. */
type RejectedOutcome = Extract<CompileCellOutcome, { status: "rejected" }>;

/** A Cell that compiled, with the artifact a deployment verb needs. */
export interface CompiledCell {
  readonly cellId: string;
  readonly artifact: CompileCellResult;
}

/** A Cell that did not compile, with the diagnostics a refusal names. */
export interface RejectedCell {
  readonly cellId: string;
  readonly outcome: RejectedOutcome;
}

function isCompiledCell(cell: BuiltCell): cell is BuiltCell & { readonly outcome: CompiledOutcome } {
  return cell.outcome.status === "compiled";
}

function isRejectedCell(cell: BuiltCell): cell is BuiltCell & { readonly outcome: RejectedOutcome } {
  return cell.outcome.status === "rejected";
}

/**
 * Every Cell's artifact, or a refusal composed by the calling verb.
 *
 * `refuse` receives the rejected Cells and the project's Cell count, and returns the sentence the
 * verb reports — so the two messages stay verb-specific while the guard itself cannot diverge.
 */
export function requireCompiledCells(
  build: ProjectBuild,
  refuse: (rejected: readonly RejectedCell[], total: number) => string,
): readonly CompiledCell[] {
  const rejected = build.build.cells.filter(isRejectedCell).map(cell => ({ cellId: cell.cellId, outcome: cell.outcome }));
  if (rejected.length > 0) {
    // A plan or sync over a half-built project would describe Cells that do not exist. The build
    // report is what reports the failures — this refuses, and says which one to read.
    throw new ProjectPlanError(refuse(rejected, build.build.cells.length));
  }
  return build.build.cells
    .filter(isCompiledCell)
    .map(cell => ({ cellId: cell.cellId, artifact: cell.outcome.artifact }));
}

/** A refusal raised before any target is planned or written. */
export class ProjectPlanError extends Error {
  readonly code = "project-plan-refused";
  constructor(message: string) {
    super(message);
    this.name = "ProjectPlanError";
  }
}
