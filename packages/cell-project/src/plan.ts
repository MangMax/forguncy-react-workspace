/**
 * `plan`: what a sync *would* do, decided locally and written nowhere.
 *
 * Decision source: GitHub Issue #99 (https://github.com/MangMax/forguncy-react-workspace/issues/99),
 * composing #97's build entry with #19's plan (#20's target resolution).
 *
 * ## Two modes, and why the offline one is not a weaker version of the connected one
 *
 * - **Offline** (`planProject`) compiles the Cells, audits the lock, resolves every target from
 *   the registry, and reports what the config declares. It makes no call of any kind — so it can
 *   run in CI, in a fresh clone, and in an Agent with no designer.
 * - **Connected** (`planProjectAgainstPort`) additionally *reads* the designer: the project's
 *   extension listing and each target Cell's current content. It still writes nothing. That read
 *   is the only thing that can answer "would this overwrite a designer's cell", which is why it is
 *   a separate function rather than a flag that quietly changes what `plan` means.
 *
 * Every write decision is `planCellSync`'s — the divergence classification, the extension audit,
 * the write gate and the mutation payload all come from `mcp-sync` (#19). This module assembles
 * the inputs the plan needs and reports them; it must never answer "may this be written" itself,
 * because that would be a second, weaker copy of the conflict protection.
 *
 * ## What a plan deliberately cannot establish
 *
 * A plan says nothing about whether the designer *accepts* the write — that is the sync's answer —
 * and nothing about runtime behaviour on the generated page. `planAgainstPort` reports the
 * pre-mutation read it made and the gate the plan produced; the write itself is #20's flow, and
 * a green plan is `local` evidence (AGENTS.md rules 6–7).
 */

import type { CellRegistry, DependencyDecision, ExtensionLibraryListing } from "@forguncy-react-workspace/core";
import {
  cellTargetLabel,
  deployedStateOfRead,
  formatCellSyncPlan,
  planCellSyncTargets,
  planSetCellsDispatch,
  resolveCellSyncTargets,
} from "@forguncy-react-workspace/mcp-sync";
import type {
  CellDivergence,
  CellOverwritePolicy,
  CellSyncPlan,
  CellSyncTargetPlan,
  CellWriteAction,
  DeployedCellState,
  ForguncySyncPort,
} from "@forguncy-react-workspace/mcp-sync";

import { cellLockOf, deploymentWithheldOf } from "./project.ts";
import type { CellBindingsReport, ProjectBuild } from "./build.ts";
import { requireCompiledCells } from "./compiled-cells.ts";
import type { CompiledCell } from "./compiled-cells.ts";

// Re-exported so the package's surface is unchanged: the refusal a caller catches is still the one
// this package has always raised, now declared beside the guard that throws it (#157).
export { ProjectPlanError } from "./compiled-cells.ts";

/** One Cell's planned sync, in the report's vocabulary. */
export interface PlannedCellSync {
  readonly cellId: string;
  readonly label: string;
  readonly writeAction: CellWriteAction;
  readonly gate: CellSyncPlan["gate"];
  readonly fingerprint: string;
  /** The library references the artifact carries, and whether the project's rows back them. */
  readonly frontendLibraries: readonly string[];
  readonly extensionVerification: {
    readonly verification: CellSyncPlan["extensionVerification"]["verification"];
    readonly expected: readonly string[];
    readonly references: readonly string[];
    readonly problems: readonly { readonly code: string; readonly message: string; readonly fixOwner: string }[];
  };
  /** In offline mode this describes the assumed target. Check targetStateRead for actual reads. */
  readonly divergence: CellDivergence;
  /** Whether `planSetCellsDispatch` would issue a `setCells` call. The one answer permission-bearing. */
  readonly wouldWrite: boolean;
  readonly heldBecause: string | null;
  readonly diagnostics: readonly { readonly code: string; readonly message: string; readonly fixOwner: string }[];
  /**
   * The host bindings this Cell declared itself authoritative for (#178), carried through from
   * the build verbatim. `undefined` is the pass-through default — the config declared no
   * `bindings` block, and every binding field is left untouched by whatever consumes the plan.
   * The plan only *reports* it: which fields a sync may write is #179's decision, and this
   * module must never answer that itself.
   */
  readonly bindings: CellBindingsReport | undefined;
  /** True when the target state was actually read (connected mode) rather than assumed blank. */
  readonly targetStateRead: boolean;
  /** What the deployment gate (#8) still withholds for this Cell. Never blocks a build. */
  readonly deploymentWithheld: readonly {
    readonly packageName: string;
    readonly strategy: string;
    readonly reason: string;
    readonly stalenessReasons: readonly string[];
    /** Why the deployment gate withheld it on the runtime axis, when that is the reason. */
    readonly realRuntimeValidation?: string;
  }[];
}

/** The plan's report. */
export interface ProjectSyncPlanReport {
  readonly root: string;
  /** `offline` made no call; `connected` read the listing and each target, and wrote nothing. */
  readonly mode: "offline" | "connected";
  /** Where the read came from, in connected mode — a description the caller supplied. */
  readonly portDescription: string | null;
  readonly hasLock: boolean;
  readonly cells: readonly PlannedCellSync[];
  /** Targets whose gate is `ready` and whose dispatch would issue a write. */
  readonly writable: readonly string[];
  /** Targets a sync would hold, with the reason — never a write that happens to be skipped. */
  readonly held: readonly { readonly cellId: string; readonly reason: string }[];
}

/** A plan in memory, with the compiler's artifacts so a caller can execute it. */
export interface ProjectPlan {
  readonly project: ProjectBuild;
  readonly plans: readonly { readonly cellId: string; readonly plan: CellSyncPlan }[];
  readonly report: ProjectSyncPlanReport;
}

export interface PlanProjectOptions {
  /**
   * What to do about a target that already holds content this flow did not write.
   *
   * Defaults to `mcp-sync`'s own policy (`preserve-designer-edits`), which refuses rather than
   * overwrites. `force` is expressible because a caller inspecting a conflict may want to see what
   * the write would carry — and in offline mode nothing is written either way; the policy only
   * decides what the plan *says*.
   */
  readonly overwrite?: CellOverwritePolicy;
}

/** The compiled artifacts a plan needs, or a refusal naming the Cells that did not compile. */
function requireArtifacts(build: ProjectBuild): readonly CompiledCell[] {
  return requireCompiledCells(build, (rejected, total) => {
    const detail = rejected
      .map(cell => {
        const codes = [
          ...cell.outcome.diagnostics.map(diagnostic => diagnostic.code),
          ...(cell.outcome.workspace?.diagnostics.map(diagnostic => diagnostic.code) ?? []),
        ];
        return `${cell.cellId}: ${codes.join(", ") || "(no named diagnostic)"}`;
      })
      .join("; ");
    return `Cannot plan a sync: ${rejected.length} of ${total} Cell(s) did not compile (${detail}). Run the build and read its report; nothing was planned for the Cells that did compile, because a partial plan is a plan to deploy a partial project.`;
  });
}

function decisionsOf(build: ProjectBuild, cellId: string): readonly DependencyDecision[] {
  return cellLockOf(build.project, cellId).decisions;
}

function reportOf(
  build: ProjectBuild,
  plan: CellSyncPlan,
  cellId: string,
  targetStateRead: boolean,
): PlannedCellSync {
  const dispatch = planSetCellsDispatch(plan);
  // The build's own per-Cell entry carries the declaration whether or not the cell compiled,
  // and `requireArtifacts` has already guaranteed every entry compiled — so the lookup cannot
  // miss; a missing one is a drifted project, not an undeclared Cell.
  const bindings = build.report.cells.find(cell => cell.cellId === cellId)?.bindings;
  return {
    cellId,
    label: cellTargetLabel(plan.target),
    writeAction: plan.writeAction,
    gate: plan.gate,
    fingerprint: plan.fingerprint,
    frontendLibraries: plan.extensionVerification.references,
    extensionVerification: {
      verification: plan.extensionVerification.verification,
      expected: plan.extensionVerification.expected,
      references: plan.extensionVerification.references,
      problems: plan.extensionVerification.diagnostics.map(diagnostic => ({
        code: diagnostic.code,
        message: diagnostic.message,
        fixOwner: diagnostic.fixOwner,
      })),
    },
    divergence: targetStateRead
      ? plan.divergence
      : {
          ...plan.divergence,
          detail: "The plan assumes a blank target. The target was not read.",
        },
    // `dispatch.kind === "issue"` is the only permission-bearing answer `mcp-sync` mints
    // (#19): the plan's payload is a report shape, and the executor is the only writer.
    wouldWrite: dispatch.kind === "issue",
    heldBecause: dispatch.kind === "issue" ? null : describeHold(dispatch.reason, plan),
    diagnostics: plan.diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      message: diagnostic.message,
      fixOwner: diagnostic.fixOwner,
    })),
    targetStateRead,
    bindings,
    deploymentWithheld: deploymentWithheldOf(build.project, cellId).map(entry => ({
      packageName: entry.packageName,
      strategy: entry.strategy,
      reason: entry.reason,
      stalenessReasons: entry.reason === "not-verified" ? entry.stalenessReasons : [],
      ...(entry.reason === "not-verified" ? { realRuntimeValidation: entry.realRuntimeValidation } : {}),
    })),
  };
}

/**
 * A hold's reason, in the plan's own words plus what it is about.
 *
 * The vocabulary is `mcp-sync`'s `CELL_SYNC_HOLD_REASONS` (#19); this only adds the sentence a
 * reader needs beside it. `nothing-to-write` is the artifact-side absence and `gate-refused`
 * covers every blocking diagnostic, so neither is widened here into a diagnosis of its own —
 * `diagnostics` below carries the findings and their remediation.
 */
function describeHold(reason: string, plan: CellSyncPlan): string {
  switch (reason) {
    case "already-identical":
      return "the target already holds this artifact, so the mutation is not issued and the run would report `unchanged`";
    case "target-diverged":
      return `the target holds content this flow did not write (${plan.divergence.kind}: ${plan.divergence.detail}), so the write is refused rather than overwriting a designer's cell`;
    case "gate-refused":
      return "the plan's gate refused before the mutation; the diagnostics below name each blocking finding and its remediation";
    case "nothing-to-write":
      return "the artifact is not compiler output, so it has no deployment representation at all";
    default:
      return reason;
  }
}

/** Runs the shared plan over every compiled Cell, with one deployed state per target. */
function planAll(
  build: ProjectBuild,
  deployed: (cellId: string) => DeployedCellState,
  listings: readonly ExtensionLibraryListing[] | undefined,
  options: PlanProjectOptions,
  targetStateRead: (cellId: string) => boolean,
): ProjectPlan {
  const artifacts = requireArtifacts(build);
  const registry = build.project.registry;

  // Targets are resolved through the registry, together, before any plan exists: a project whose
  // config maps two Cells to one destination must fail as a whole rather than produce N-1 plans
  // and one silent overwrite (`mcp-sync`'s own guard, not restated here).
  resolveCellSyncTargets(
    registry,
    artifacts.map(cell => cell.cellId),
  );

  const plans = planCellSyncTargets(
    registry,
    artifacts.map((cell): CellSyncTargetPlan => ({
      cellId: cell.cellId,
      artifact: cell.artifact,
      decisions: decisionsOf(build, cell.cellId),
      deployed: deployed(cell.cellId),
      ...(listings === undefined ? {} : { listings }),
      ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
    })),
  );

  const reports = plans.map((plan, index) => {
    const cellId = artifacts[index]?.cellId ?? plan.target.cell;
    return reportOf(build, plan, cellId, targetStateRead(cellId));
  });

  const report: ProjectSyncPlanReport = {
    root: build.project.root,
    mode: listings === undefined ? "offline" : "connected",
    portDescription: null,
    hasLock: build.project.hasLock,
    cells: reports,
    writable: reports.filter(cell => cell.wouldWrite).map(cell => cell.cellId),
    held: reports
      .filter(cell => !cell.wouldWrite)
      .map(cell => ({ cellId: cell.cellId, reason: cell.heldBecause ?? "held" })),
  };

  return { project: build, plans: plans.map((plan, index) => ({ cellId: artifacts[index]?.cellId ?? plan.target.cell, plan })), report };
}

/**
 * Plans a sync with no call of any kind.
 *
 * Every target is planned as if it were blank, which is what an offline process can honestly say.
 * The plan's own diagnostics still run — extension references are audited against the project's
 * rows, and the artifact's provenance is checked — so an offline plan is a real inspection of what
 * *would* be written, not a placeholder. What it cannot say is whether the target is free.
 */
export function planProject(build: ProjectBuild, options: PlanProjectOptions = {}): ProjectPlan {
  const blank: DeployedCellState = { kind: "read", code: "" };
  return planAll(
    build,
    () => blank,
    undefined,
    options,
    () => false,
  );
}

export interface PlanAgainstPortOptions extends PlanProjectOptions {
  readonly port: ForguncySyncPort;
  /** How the port should be described in the report — e.g. a recording port, or a designer URL. */
  readonly portDescription?: string;
}

/**
 * Plans a sync against a live port, reading and writing nothing else.
 *
 * The two reads are `mcp-sync`'s own: the extension listing, and each target's current content.
 * Neither is a write, and the plan that comes out of them is the same plan a sync would execute —
 * which is what makes this an inspection rather than a forecast. A caller that then calls `sync`
 * is trusting the read it just made, exactly as `executeCellSync` does; the executor re-reads per
 * target for that reason, and this function does not claim its answer survives the interval.
 */
export async function planProjectAgainstPort(build: ProjectBuild, options: PlanAgainstPortOptions): Promise<ProjectPlan> {
  const artifacts = requireArtifacts(build);
  const registry = build.project.registry;

  const listings = await options.port.listFrontendLibraries({});
  const deployed = new Map<string, DeployedCellState>();
  const read = new Set<string>();
  for (const cell of artifacts) {
    const target = targetOf(registry, cell.cellId);
    const state = await options.port.readCellSource({ pageName: target.pageName, cell: target.cell });
    // `mcp-sync`'s mapping, not a copy of it (#157): `sync` classifies the same read through this
    // function, and two spellings of "blank is writable, occupied is designer work" would let a plan
    // describe a write the sync then refuses — or the reverse.
    deployed.set(cell.cellId, deployedStateOfRead(state));
    read.add(cell.cellId);
  }

  const planned = planAll(
    build,
    cellId => deployed.get(cellId) ?? { kind: "read", code: "" },
    listings,
    options,
    cellId => read.has(cellId),
  );

  return {
    ...planned,
    report: {
      ...planned.report,
      mode: "connected",
      portDescription: options.portDescription ?? "caller-supplied port",
    },
  };
}

/** A Cell's declared destination, through the one registry that answers it. */
function targetOf(registry: CellRegistry, cellId: string): { readonly pageName: string; readonly cell: string } {
  const cell = registry.require(cellId);
  return { pageName: cell.target.pageName, cell: cell.target.cell };
}

/** The plan as lines a terminal or a PR body can carry. */
export function formatProjectSyncPlan(report: ProjectSyncPlanReport): string {
  const lines: string[] = [
    `Project: ${report.root}`,
    `Mode: ${report.mode}${report.portDescription === null ? " (no designer contacted, nothing written)" : ` (read from ${report.portDescription}; nothing written)`}`,
    `Lock: ${report.hasLock ? "recorded decisions present" : "none"}`,
    "",
  ];

  for (const cell of report.cells) {
    lines.push(
      `Cell ${cell.cellId} -> ${cell.label}: ${cell.wouldWrite ? "WOULD WRITE" : "held"}${cell.gate === "ready" ? "" : ` (gate: ${cell.gate})`}`,
    );
    if (cell.heldBecause !== null) {
      lines.push(`  hold: ${cell.heldBecause}`);
    }
    if (cell.frontendLibraries.length > 0) {
      lines.push(`  frontendLibraries: ${cell.frontendLibraries.join(", ")} (verification: ${cell.extensionVerification.verification})`);
    }
    if (!cell.targetStateRead) {
      lines.push("  target state: assumed blank — this plan did not read the target, so it cannot say whether the write would overwrite anything");
    }
    if (cell.bindings !== undefined) {
      lines.push(
        `  bindings: ${cell.bindings.declaredFields.length === 0 ? "declared, taking over nothing" : `managed ${cell.bindings.declaredFields.join("/")}`} — every undeclared field is pass-through and stays untouched`,
      );
    }
    for (const problem of cell.extensionVerification.problems) {
      lines.push(`  EXTENSION ${problem.code} (fix owner: ${problem.fixOwner}): ${problem.message}`);
    }
    for (const diagnostic of cell.diagnostics) {
      lines.push(`  ${diagnostic.code} (fix owner: ${diagnostic.fixOwner}): ${diagnostic.message}`);
    }
    for (const entry of cell.deploymentWithheld) {
      lines.push(
        `  deployment-gate ${entry.packageName} (${entry.strategy}): withheld — ${entry.reason}${
          entry.realRuntimeValidation === undefined ? "" : ` [runtime: ${entry.realRuntimeValidation}]`
        }${entry.stalenessReasons.length === 0 ? "" : ` [${entry.stalenessReasons.join(", ")}]`}`,
      );
    }
    lines.push("");
  }

  lines.push(
    report.held.length === 0
      ? "Every declared Cell would be written."
      : `${report.held.length} Cell(s) would be held; a sync would report each one rather than writing it.`,
  );
  lines.push(
    "This plan is local evidence: it says what a sync would attempt, not that a designer accepts it or that the page behaves. Runtime validation is a real Forguncy run.",
  );
  return lines.join("\n");
}

/** The plan's per-step detail, for a caller that wants `mcp-sync`'s own rendering. */
export function formatPlannedCellSteps(plan: ProjectPlan): string {
  return plan.plans.map(entry => formatCellSyncPlan(entry.plan)).join("\n");
}
