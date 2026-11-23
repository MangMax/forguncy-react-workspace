/**
 * `build`: every declared Cell compiled, the artifacts and a manifest written locally.
 *
 * Decision source: GitHub Issue #99 (https://github.com/MangMax/forguncy-react-workspace/issues/99).
 *
 * ## What it does not do
 *
 * It makes **no remote call**, reads no designer, and starts no Forguncy process. Building and
 * deploying are separate verbs in #97's own wording, and a build that could touch a project just
 * by being run would make a mistyped `sync` unnecessary to do damage. The only files it writes are
 * under the project's own output directory (`.fgc/build` by default, git-ignored).
 *
 * ## Why the artifact is written as the compiler produced it
 *
 * The bytes written are the compiler's `code`, unmodified. Stamping the sync marker is
 * `mcp-sync`'s job at the write boundary (#19's plan assembles it); doing it here would put a
 * deployment identity into a build output that nothing deployed. `sync` compiles from the same
 * source rather than trusting a file on disk, so the manifest is a *report*, not an input.
 *
 * ## What the report says about the lock
 *
 * Each Cell's entry carries the local projection's verdict — the decisions it compiled with, the
 * records withheld for a reason this process can see, the records kept whose evidence only a page
 * can judge, and what a deployment gate would add. That last list is reported and never applied:
 * a locally recorded decision has no real-page validation, so a strict deployment projection
 * withholds every record, and a build that did the same would refuse every project that has not
 * yet been through #107's gate.
 */

import { buildCellProject } from "@forguncy-react-workspace/cell-compiler";
import type {
  BuiltCell,
  CellDependencies,
  CellProjectBuild,
  CellProjectWorkspace,
} from "@forguncy-react-workspace/cell-compiler";
import type { CellEntryKind, DependencyDecision } from "@forguncy-react-workspace/core";
import { compareCodeUnits } from "@forguncy-react-workspace/core";
import { fingerprintArtifact } from "@forguncy-react-workspace/mcp-sync";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { cellLockOf, loadCellProject, projectExtensionMappings } from "./project.ts";
import type { LoadedCellProject, ProjectExtensionMapping } from "./project.ts";

/** Where a build writes when the caller names no directory. Relative to the project root. */
export const DEFAULT_BUILD_OUT_DIR = ".fgc/build";

/** The manifest a build leaves beside its artifacts. */
export const BUILD_MANIFEST_FILE_NAME = "manifest.json";

/** One inlined resource, reduced to what a manifest reader needs. */
export type ManifestResource =
  | { readonly kind: "style"; readonly fileName: string; readonly cssCharacters: number; readonly assetBytes: number }
  | { readonly kind: "asset"; readonly fileName: string; readonly mediaType: string; readonly bytes: number };

/** What one compiled Cell's artifact is, as a manifest records it. */
export interface ManifestArtifact {
  /** File name inside the output directory. */
  readonly file: string;
  /** Characters of generated code — the unit #21's budget is expressed in. */
  readonly characters: number;
  /** `mcp-sync`'s artifact identity, over the canonical `{ code, frontendLibraries }` pair. */
  readonly fingerprint: string;
  /** The `libraryId`s the page must resolve before this Cell's entry runs. */
  readonly frontendLibraries: readonly string[];
  readonly resources: readonly ManifestResource[];
}

/** One diagnostic, in the three fields a reader acts on. */
export interface BuildDiagnosticReport {
  readonly code: string;
  readonly subject: string;
  readonly message: string;
  readonly remediation: string;
  readonly fixOwner: string;
}

/** A withheld lock record, as the report states it. */
export interface WithheldDecisionReport {
  readonly packageName: string;
  readonly strategy: string;
  readonly reason: string;
  readonly stalenessReasons: readonly string[];
  readonly realRuntimeValidation?: string;
}

/** A deployment-gate withholding: the two branches differ, and a report says which it is. */
export interface DeploymentWithheldReport {
  readonly packageName: string;
  readonly strategy: string;
  readonly reason: "not-verified" | "replace-cache";
  /** Empty for `replace-cache`, which carries no staleness axis. */
  readonly stalenessReasons: readonly string[];
  readonly realRuntimeValidation?: string;
}

/** A lock record kept, whose evidence this process could not evaluate. */
export interface UnobservableDecisionReport {
  readonly packageName: string;
  readonly strategy: string;
  readonly stalenessReasons: readonly string[];
}

/** One declared Cell's outcome, as the build report carries it. */
export interface ProjectCellBuildReport {
  readonly cellId: string;
  readonly target: BuiltCell["target"];
  readonly status: "compiled" | "rejected";
  readonly artifact: ManifestArtifact | null;
  readonly diagnostics: readonly BuildDiagnosticReport[];
  /** The dependency decisions the compile was handed: recorded ones, and the bridge's host rows. */
  readonly decisions: readonly {
    readonly packageName: string;
    readonly strategy: string;
    /** `lock` when a record decided it; `host-bridge` when #9's table answered an undecided import. */
    readonly source: "lock" | "host-bridge";
  }[];
  /** Records the local projection withheld, and for which locally-judged reason. */
  readonly withheld: readonly WithheldDecisionReport[];
  /** Records kept whose only staleness is on an axis only a page or a probe can answer. */
  readonly unobservable: readonly UnobservableDecisionReport[];
  /** Lock conformance errors — the compiler refuses these records outright. */
  readonly conformanceErrors: readonly { readonly subject: string; readonly code: string; readonly detail: string }[];
  /** What a deployment gate (#8's runtime axis) would additionally withhold. Reported, not applied. */
  readonly deploymentWithheld: readonly DeploymentWithheldReport[];
}

/** The build's report: what was built, where, and what the lock said about it. */
export interface ProjectBuildReport {
  readonly root: string;
  /** Absolute output directory, or null when the build wrote nothing. */
  readonly outDir: string | null;
  readonly manifestPath: string | null;
  readonly wroteFiles: boolean;
  /** Whether a pnpm workspace graph was found and audited (#14). */
  readonly workspaceAudited: boolean;
  /** The alias set the build resolved through, from the project config (#97). */
  readonly alias: Readonly<Record<string, string>>;
  /** The project-declared extension rows — never the built-in table alone (#85/#87). */
  readonly extensionMappings: readonly ProjectExtensionMapping[];
  readonly hasLock: boolean;
  readonly cells: readonly ProjectCellBuildReport[];
}

export interface BuildProjectOptions {
  /** Absolute project root. */
  readonly root: string;
  /** Output directory, relative to the root. Defaults to {@link DEFAULT_BUILD_OUT_DIR}. */
  readonly outDir?: string;
  /** `false` compiles in memory only. `plan` uses this so inspection cannot leave files behind. */
  readonly write?: boolean;
  /** Whether and where to read the pnpm workspace graph (#14/#97). */
  readonly workspace?: CellProjectWorkspace;
  /** Which #5 entry shape to expose. Defaults to a function `App` binding. */
  readonly entryKind?: CellEntryKind;
  /** Verify declared entries exist on disk while normalizing. Defaults to `true`. */
  readonly requireEntryFiles?: boolean;
}

/** A build in memory: the project, the compiler's unreduced result, and the report. */
export interface ProjectBuild {
  readonly project: LoadedCellProject;
  /** The #97 result, unreduced — a deployment verb needs each artifact, not only its summary. */
  readonly build: CellProjectBuild;
  readonly report: ProjectBuildReport;
}

/** A Cell id made safe for a file name, without losing its identity in the manifest's `cellId`. */
function artifactFileName(cellId: string): string {
  return `${cellId.replace(/[^A-Za-z0-9._-]+/g, "_")}.js`;
}

/** The compiler's inlined-resource ledger, reduced to the manifest's shape. */
function manifestResources(cell: BuiltCell): readonly ManifestResource[] {
  if (cell.outcome.status !== "compiled") {
    return [];
  }
  return (cell.outcome.artifact.inlinedResources ?? [])
    .map((resource): ManifestResource =>
      resource.kind === "style"
        ? {
            kind: "style",
            fileName: resource.fileId.split(/[\\/]/).pop() ?? resource.fileId,
            cssCharacters: resource.cssCharacters,
            assetBytes: resource.assetBytes,
          }
        : {
            kind: "asset",
            fileName: resource.fileName,
            mediaType: resource.mediaType,
            bytes: resource.bytes,
          },
    )
    // Sorted, because the compiler's ledger is a discovery order: the CSS `url(...)` asset and the
    // directly imported one are found by whichever module resolved first, and two builds of one
    // unchanged project must produce the same manifest (#97's determinism, applied to the report).
    //
    // Code units, not `localeCompare` (#155): a locale-sensitive order puts `a` before `B` and `Ä`
    // among the `a`s, so the same project would write two manifests on two machines — the one thing
    // a manifest exists to rule out.
    .sort((left, right) =>
      left.kind === right.kind
        ? compareCodeUnits(left.fileName, right.fileName)
        : compareCodeUnits(left.kind, right.kind),
    );
}

function artifactOf(cell: BuiltCell, fileName: string): ManifestArtifact | null {
  if (cell.outcome.status !== "compiled") {
    return null;
  }
  const artifact = cell.outcome.artifact;
  return {
    file: fileName,
    characters: artifact.code.length,
    fingerprint: fingerprintArtifact(artifact),
    frontendLibraries: artifact.frontendLibraries.map(reference => reference.libraryId),
    resources: manifestResources(cell),
  };
}

function diagnosticsOf(cell: BuiltCell): readonly BuildDiagnosticReport[] {
  if (cell.outcome.status !== "rejected") {
    return [];
  }
  const workspaceDiagnostics = (cell.outcome.workspace?.diagnostics ?? []).map(diagnostic => ({
    code: diagnostic.code,
    subject: diagnostic.subject,
    message: diagnostic.message,
    remediation: diagnostic.remediation,
    fixOwner: diagnostic.fixOwner,
  }));
  return [
    ...cell.outcome.diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      subject: diagnostic.subject,
      message: diagnostic.message,
      remediation: diagnostic.remediation,
      fixOwner: diagnostic.fixOwner,
    })),
    ...workspaceDiagnostics,
  ];
}

/** The lock's view of one Cell, in the report's vocabulary. */
function lockViewOf(project: LoadedCellProject, cellId: string): Pick<
  ProjectCellBuildReport,
  "decisions" | "withheld" | "unobservable" | "conformanceErrors" | "deploymentWithheld"
> {
  const lock = cellLockOf(project, cellId);
  return {
    decisions: [
      ...project.hostDefaults.map(entry => ({
        packageName: entry.packageName,
        strategy: "host" as const,
        source: "host-bridge" as const,
      })),
      ...lock.decisions.map(decision => ({
        packageName: decision.packageName,
        strategy: decision.strategy,
        // A recorded decision that agrees with the bridge is still the lock's: the lock is what a
        // reader has to keep current, and labelling it "host-bridge" would hide that obligation.
        source: "lock" as const,
      })),
    ].filter((entry, index, all) => all.findIndex(candidate => candidate.packageName === entry.packageName) === index),
    withheld: lock.projection.withheld.map(entry => ({
      packageName: entry.packageName,
      strategy: entry.strategy,
      reason: entry.reason,
      stalenessReasons: entry.stalenessReasons,
    })),
    unobservable: lock.projection.unobservableEvidence.map(entry => ({
      packageName: entry.packageName,
      strategy: entry.strategy,
      stalenessReasons: entry.stalenessReasons,
    })),
    conformanceErrors: lock.projection.conformanceErrors.map(error => ({
      subject: error.subject,
      code: error.code,
      detail: error.detail,
    })),
    deploymentWithheld: lock.deploymentWithheld.map(entry => ({
      packageName: entry.packageName,
      strategy: entry.strategy,
      reason: entry.reason,
      // `replace-cache` is a rejection kept as a decision cache, so it carries no staleness axis
      // and no runtime claim; the union says so and a report must not invent either.
      stalenessReasons: entry.reason === "not-verified" ? entry.stalenessReasons : [],
      ...(entry.reason === "not-verified" ? { realRuntimeValidation: entry.realRuntimeValidation } : {}),
    })),
  };
}

/**
 * The manifest's canonical serialization.
 *
 * No timestamp and no machine path, so two builds of one unchanged project produce the same bytes
 * — the property that makes a manifest comparable rather than merely readable (#97's determinism).
 */
function serializeManifest(report: ProjectBuildReport): string {
  const manifest = {
    schemaVersion: 1,
    generator: "@forguncy-react-workspace/cell-project",
    cells: report.cells.map(cell => ({
      cellId: cell.cellId,
      target: cell.target,
      status: cell.status,
      artifact: cell.artifact,
      diagnostics: cell.diagnostics,
    })),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Compiles the project in memory, optionally writing the output directory.
 *
 * The decisions each Cell receives are its own local projection — per Cell, because #4 defines a
 * strategy per `(packageName, cellTarget)` and one shared list cannot express a project where two
 * Cells treat one package differently.
 */
export async function compileProject(options: BuildProjectOptions): Promise<ProjectBuild> {
  const project = await loadCellProject(options);
  const dependencies: CellDependencies = (cellId: string): readonly DependencyDecision[] =>
    cellLockOf(project, cellId).decisions;

  const build = await buildCellProject({
    registry: project.registry,
    dependencies,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.entryKind === undefined ? {} : { entryKind: options.entryKind }),
  });

  const write = options.write ?? true;
  const outDir = write ? resolve(project.root, options.outDir ?? DEFAULT_BUILD_OUT_DIR) : null;
  const manifestPath = outDir === null ? null : join(outDir, BUILD_MANIFEST_FILE_NAME);

  const cells: ProjectCellBuildReport[] = build.cells.map(cell => {
    const fileName = artifactFileName(cell.cellId);
    return {
      cellId: cell.cellId,
      target: cell.target,
      status: cell.outcome.status,
      artifact: artifactOf(cell, fileName),
      diagnostics: diagnosticsOf(cell),
      ...lockViewOf(project, cell.cellId),
    };
  });

  const report: ProjectBuildReport = {
    root: project.root,
    outDir,
    manifestPath,
    wroteFiles: outDir !== null,
    workspaceAudited: build.workspaceAudited,
    alias: build.alias,
    extensionMappings: projectExtensionMappings(project),
    hasLock: project.hasLock,
    cells,
  };

  if (outDir !== null) {
    await mkdir(outDir, { recursive: true });
    // The artifacts first, the manifest last: a manifest naming a file this run failed to write
    // would be worse than no manifest at all.
    await Promise.all(
      build.cells.map(async (cell, index) => {
        const summary = cells[index];
        if (summary === undefined || summary.artifact === null || cell.outcome.status !== "compiled") {
          return;
        }
        await writeFile(join(outDir, summary.artifact.file), cell.outcome.artifact.code, "utf8");
      }),
    );
    await writeFile(join(outDir, BUILD_MANIFEST_FILE_NAME), serializeManifest(report), "utf8");
  }

  return { project, build, report };
}

/** `build`: compile every Cell, write the artifacts and the manifest, and make no remote call. */
export async function buildProject(options: BuildProjectOptions): Promise<ProjectBuildReport> {
  return (await compileProject({ write: true, ...options })).report;
}

/** The report as lines a terminal or a PR body can carry. */
export function formatProjectBuildReport(report: ProjectBuildReport): string {
  const lines: string[] = [
    `Project: ${report.root}`,
    `Output: ${report.outDir ?? "(not written)"}`,
    `Workspace graph audited: ${report.workspaceAudited ? "yes" : "no — project is not a pnpm workspace member"}`,
    `Aliases: ${Object.keys(report.alias).length === 0 ? "(none)" : Object.entries(report.alias).map(([find, target]) => `${find} -> ${target}`).join(", ")}`,
    `Project extension rows: ${
      report.extensionMappings.length === 0
        ? "(none declared; the built-in table is all a compile sees)"
        : report.extensionMappings.map(row => `${row.packageName} -> ${row.libraryId} (global ${row.globalName})`).join(", ")
    }`,
    `Lock: ${report.hasLock ? "recorded decisions present" : "no fgc.lock.json — every imported package must be a workspace source, a host module or undecided"}`,
    "",
  ];

  for (const cell of report.cells) {
    lines.push(`Cell ${cell.cellId} -> ${cell.target.pageName}!${cell.target.cell}: ${cell.status}`);
    if (cell.artifact !== null) {
      lines.push(
        `  artifact ${cell.artifact.file}: ${cell.artifact.characters} chars, fingerprint ${cell.artifact.fingerprint.slice(0, 16)}…`,
      );
      if (cell.artifact.frontendLibraries.length > 0) {
        lines.push(`  frontendLibraries: ${cell.artifact.frontendLibraries.join(", ")}`);
      }
      if (cell.artifact.resources.length > 0) {
        lines.push(
          `  inlined resources: ${cell.artifact.resources
            .map(resource =>
              resource.kind === "style"
                ? `style ${resource.fileName} (${resource.cssCharacters} css chars, ${resource.assetBytes} asset bytes)`
                : `asset ${resource.fileName} (${resource.mediaType}, ${resource.bytes} bytes)`,
            )
            .join("; ")}`,
        );
      }
    }
    for (const decision of cell.decisions) {
      lines.push(
        `  decision ${decision.packageName}: ${decision.strategy}${decision.source === "host-bridge" ? " (from #9's host bridge — undecided by this project)" : ""}`,
      );
    }
    for (const entry of cell.withheld) {
      lines.push(
        `  WITHHELD ${entry.packageName} (${entry.strategy}): ${entry.reason}${entry.stalenessReasons.length === 0 ? "" : ` — ${entry.stalenessReasons.join(", ")}`}`,
      );
    }
    for (const entry of cell.unobservable) {
      lines.push(
        `  local-boundary ${entry.packageName} (${entry.strategy}): ${entry.stalenessReasons.join(", ")} cannot be judged here; the compiler applies them and a green build is not evidence about this record`,
      );
    }
    for (const error of cell.conformanceErrors) {
      lines.push(`  CONFORMANCE ${error.subject}: [${error.code}] ${error.detail}`);
    }
    for (const diagnostic of cell.diagnostics) {
      lines.push(`  ${diagnostic.code} (${diagnostic.subject}, fix owner: ${diagnostic.fixOwner}): ${diagnostic.message}`);
      lines.push(`    fix: ${diagnostic.remediation}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
