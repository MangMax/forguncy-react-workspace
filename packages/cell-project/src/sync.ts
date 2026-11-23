/**
 * `sync`: the one verb that writes, and the only one that needs a designer.
 *
 * Decision source: GitHub Issue #99 (https://github.com/MangMax/forguncy-react-workspace/issues/99),
 * executing #19's flow through #20's executor and #93's retry-safe reporting.
 *
 * ## Why this takes a port instead of connecting
 *
 * An authorized MCP connection is the caller's: the Agent's session, or a project-owned adapter
 * that knows its own URL and credentials. A library that opened one itself would be a second
 * transport next to the one #20 measured, and — worse — a `sync` that could start a Forguncy
 * process or dial a designer nobody authorized. So this module takes a `ForguncySyncPort` and
 * nothing else, and the CLI's `--port <module>` is the seam a project hands one in through.
 *
 * ## Everything that protects a target is `mcp-sync`'s
 *
 * The batch executor re-reads the listing and every target immediately before planning it, so a
 * retry after a failed attempt is classified from the target's *current* content (#93); the plan
 * refuses a diverged cell (`cell-diverged`) and refuses to overwrite designer work under the
 * default `preserve-designer-edits` policy; the extension references are audited against the
 * project's own rows (#87). This module supplies the artifacts, the per-Cell decisions and the
 * registry, then reports the batch's per-target outcome. It does not re-decide any of that, and
 * it never turns a held write into a sent one.
 *
 * ## What a written run still does not establish
 *
 * That the designer accepted the calls. It says nothing about runtime behaviour on the generated
 * page — opening the locator does, and a green `sync` is not Forguncy runtime validation
 * (AGENTS.md rules 6–7). `formatProjectSyncReport` prints the locator when there is one for the
 * same reason `mcp-sync`'s own report does.
 */

import { cellTargetLabel, executeCellSyncBatch } from "@forguncy-react-workspace/mcp-sync";
import type {
  CellSyncBatchReport,
  CellSyncRun,
  ForguncySyncPort,
  SyncCellInput,
} from "@forguncy-react-workspace/mcp-sync";

import { cellLockOf } from "./project.ts";
import type { ProjectBuild } from "./build.ts";
import { requireCompiledCells } from "./compiled-cells.ts";

/** One target's outcome, in the report's vocabulary. */
export interface SyncedCellReport {
  readonly cellId: string;
  readonly label: string;
  readonly status: CellSyncRun["status"] | "transport-failure" | "not-attempted";
  /** True when this run changed the Cell or the project. */
  readonly mutated: boolean;
  /** The run's diagnostics, when it produced any. */
  readonly diagnostics: readonly { readonly code: string; readonly message: string; readonly fixOwner: string }[];
  /** The locator to open, present on `written` and `unchanged`. */
  readonly runtimeUrl: string | null;
  /** Present on `transport-failure`: what the failure knows about whether the write landed (#93). */
  readonly transportFailure: {
    readonly stage: string;
    readonly operation: string;
    readonly mutationState: string;
  } | null;
}

/** What one explicit sync did. */
export interface ProjectSyncReport {
  readonly root: string;
  readonly portDescription: string;
  /** Targets this batch is known to have changed. */
  readonly mutated: readonly string[];
  /** Targets whose write state is unknown after a transport failure (#93). */
  readonly uncertain: readonly string[];
  readonly stoppedEarly: boolean;
  readonly cells: readonly SyncedCellReport[];
}

export interface SyncProjectOptions {
  readonly port: ForguncySyncPort;
  /** How to describe the port in the report — a designer URL, or "recording port". */
  readonly portDescription?: string;
  /**
   * What to do after a target throws a transport failure.
   *
   * Defaults to `stop`: a failure leaves the project in a state nobody established, and the next
   * target's write would be built on it. `continue` exists for a diagnostic run, and either way
   * the report keeps what already happened.
   */
  readonly onTransportFailure?: "stop" | "continue";
  /** Whether a resolved failure (a refusal, a declined save) stops the batch. Defaults to `continue`. */
  readonly onFailedRun?: "stop" | "continue";
}

/**
 * The compiled artifacts a sync writes, or a refusal naming the Cells that did not compile.
 *
 * The guard is `compiled-cells.ts`'s, shared with `plan` (#157); only the sentence is this verb's,
 * because "nothing was read and nothing was written" is a claim about a sync and not about a plan.
 */
function compiledCells(build: ProjectBuild): readonly { readonly cellId: string; readonly artifact: SyncCellInput["artifact"] }[] {
  return requireCompiledCells(
    build,
    (rejected, total) =>
      `Cannot sync: ${rejected.length} of ${total} Cell(s) did not compile (${rejected
        .map(cell => cell.cellId)
        .join(", ")}). Nothing was read and nothing was written. Run the build and read its report.`,
  );
}

const NO_DIAGNOSTICS: readonly { readonly code: string; readonly message: string; readonly fixOwner: string }[] = [];

/**
 * One target's outcome, from whichever of the batch's three shapes it has.
 *
 * The three are the executor's own (#93): a run, a structured transport failure, and a target an
 * earlier outcome stopped the batch from reaching. Collapsing them into one status would lose the
 * distinction between "this failed" and "this never started", which is the whole point of the
 * report the retry logic reads.
 *
 * `mutated` exists on three of the four run statuses and means "this run changed project state" —
 * on `written` the write itself, on `unchanged`/`failed` a save that persisted a dirty project.
 * A `refused` run changed nothing by definition, and the union says so rather than requiring a
 * field that would always be false.
 */
function outcomeOf(outcome: CellSyncBatchReport["outcomes"][number]): SyncedCellReport {
  const cellId = outcome.cellId;

  if (outcome.kind === "run") {
    const run = outcome.run;
    return {
      cellId,
      label: cellTargetLabel(run.target),
      status: run.status,
      mutated: "mutated" in run ? run.mutated : false,
      diagnostics: run.diagnostics.map(diagnostic => ({
        code: diagnostic.code,
        message: diagnostic.message,
        fixOwner: diagnostic.fixOwner,
      })),
      runtimeUrl: run.status === "written" || run.status === "unchanged" ? run.runtime.pageUrl : null,
      transportFailure: null,
    };
  }

  if (outcome.kind === "transport-failure") {
    return {
      cellId,
      label: cellTargetLabel(outcome.error.target),
      status: "transport-failure",
      // A transport failure does not know whether it landed. `mutation.state === "written"` is the
      // one case where it does, and it is already counted in the batch's `mutatedTargets`.
      mutated: outcome.error.mutation.state === "written",
      diagnostics: NO_DIAGNOSTICS,
      runtimeUrl: null,
      transportFailure: {
        stage: outcome.error.stage,
        operation: outcome.error.operation,
        mutationState: outcome.error.mutation.state,
      },
    };
  }

  return {
    cellId,
    label: cellTargetLabel(outcome.target),
    status: "not-attempted",
    mutated: false,
    diagnostics: NO_DIAGNOSTICS,
    runtimeUrl: null,
    transportFailure: null,
  };
}

/**
 * Executes the sync: reads, plans, writes, and reports — one explicit call, one batch.
 *
 * The batch is the executor's, so every target is read and planned individually and immediately
 * before its write (#19's "before mutation" means before *this* mutation). A registry with two
 * ids claiming one destination, or a Cell this project does not declare, throws before anything is
 * read or written.
 */
export async function syncProject(build: ProjectBuild, options: SyncProjectOptions): Promise<ProjectSyncReport> {
  const cells = compiledCells(build);
  const registry = build.project.registry;

  const report = await executeCellSyncBatch(
    registry,
    cells.map(cell => ({
      cellId: cell.cellId,
      artifact: cell.artifact,
      // The Cell's own local projection, per Cell: #4 defines a strategy per
      // `(packageName, cellTarget)`, and the artifact was compiled against exactly this list.
      decisions: cellLockOf(build.project, cell.cellId).decisions,
      port: options.port,
    })),
    {
      ...(options.onTransportFailure === undefined ? {} : { onTransportFailure: options.onTransportFailure }),
      ...(options.onFailedRun === undefined ? {} : { onFailedRun: options.onFailedRun }),
    },
  );

  return {
    root: build.project.root,
    portDescription: options.portDescription ?? "caller-supplied port",
    mutated: report.mutatedTargets.map(cellTargetLabel),
    uncertain: report.uncertainTargets.map(cellTargetLabel),
    stoppedEarly: report.stoppedEarly,
    cells: report.outcomes.map(outcome => outcomeOf(outcome)),
  };
}

/** The report as lines a terminal or a PR body can carry. */
export function formatProjectSyncReport(report: ProjectSyncReport): string {
  const lines: string[] = [
    `Project: ${report.root}`,
    `Port: ${report.portDescription}`,
    "",
  ];

  for (const cell of report.cells) {
    lines.push(`Cell ${cell.cellId} -> ${cell.label}: ${cell.status}${cell.mutated ? " (project changed)" : ""}`);
    if (cell.runtimeUrl !== null) {
      lines.push(`  locator: ${cell.runtimeUrl}`);
    }
    for (const diagnostic of cell.diagnostics) {
      lines.push(`  ${diagnostic.code} (fix owner: ${diagnostic.fixOwner}): ${diagnostic.message}`);
    }
    if (cell.transportFailure !== null) {
      lines.push(
        `  transport failure at ${cell.transportFailure.stage}/${cell.transportFailure.operation}: mutation state "${cell.transportFailure.mutationState}". Re-read the target before retrying — the executor does this itself, which is why a retry is safe.`,
      );
    }
    lines.push("");
  }

  if (report.mutated.length > 0) {
    lines.push(`Changed: ${report.mutated.join(", ")}`);
  }
  if (report.uncertain.length > 0) {
    lines.push(`Unknown write state after a transport failure: ${report.uncertain.join(", ")} — re-read before retrying #93.`);
  }
  if (report.stoppedEarly) {
    lines.push("The batch stopped early: a later target was never attempted.");
  }
  lines.push(
    "A run establishes that the designer accepted these calls. Runtime behaviour on the generated page is verified by opening the locator — a green sync is not Forguncy runtime validation.",
  );
  return lines.join("\n");
}
