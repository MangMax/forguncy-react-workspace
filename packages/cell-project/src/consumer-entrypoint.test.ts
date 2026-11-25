/**
 * The consumer entrypoint, executed end to end against a real project (#99).
 *
 * Decision source: GitHub Issue #99
 * (https://github.com/MangMax/forguncy-react-workspace/issues/99), whose acceptance criteria are
 * that a clean consumer project can develop locally, build sync-ready artifacts, plan read-only,
 * and sync explicitly — through public entrypoints, without assembling a port, a decision, a
 * target or a workspace graph by hand.
 *
 * ## Why this runs against a scratch copy and records with the real Skill
 *
 * Every stage here *writes* — `record` writes `fgc.lock.json` and `fgc-evidence/`, `build` writes
 * the output directory — and a test that dirtied the committed example would be a test that has to
 * be undone. So each case copies the example's own config and Cell source into a temp directory
 * under its git-ignored `.fgc/`, and runs the Skill's real `record` there. Nothing is hand-written
 * as evidence: the probe measures the installed `es-toolkit` and the lock cites the report.
 *
 * ## What the recording port is, and what a green run of it means
 *
 * `syncProject` takes a `ForguncySyncPort`; the port below answers the way a designer would and
 * records every write it is handed. That makes the *flow* — read, plan, gate, mutate, save, check,
 * generate — observable without a Forguncy install. It is **not** runtime validation: the port is
 * a prediction, and AGENTS.md rules 6–7 keep that separate from the real-designer run #107 owns.
 * The plan-only case goes further and uses a port that throws on every write, so "plan wrote
 * nothing" is asserted by the port rather than by reading the source.
 */

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { HOST_BRIDGE_MAPPINGS } from "@forguncy-react-workspace/core";
import type { ForguncySyncPort } from "@forguncy-react-workspace/mcp-sync";

import {
  buildProject,
  compileProject,
  formatProjectBuildReport,
  formatProjectSyncPlan,
  formatProjectSyncReport,
  hostDefaultsOf,
  loadCellProject,
  planProject,
  planProjectAgainstPort,
  syncProject,
} from "./index.ts";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..");
const EXAMPLE_ROOT = join(REPOSITORY_ROOT, "examples", "consumer-project");
const SKILL_CLI = join(
  REPOSITORY_ROOT,
  ".agents",
  "skills",
  "forguncy-react-dependency-selection",
  "scripts",
  "select_dependency.mjs",
);
const CLI = join(HERE, "cli.ts");

/** A real compile plus a real probe; the probe builds `es-toolkit` through Rolldown. */
const CASE_TIMEOUT_MS = 180_000;

/** The scratch roots this file created, removed once at the end. */
const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A temp copy of the example, inside its own tree so bare imports still resolve.
 *
 * Under `.fgc/` — which is git-ignored — because Node's and Rolldown's resolution walk up from the
 * scratch root to the example's `node_modules`, and the install-graph identity walk finds the
 * repository's lockfile the same way. A copy in `os.tmpdir()` would resolve neither without
 * rebuilding the install.
 */
function scratchProject(name: string): string {
  mkdirSync(join(EXAMPLE_ROOT, ".fgc"), { recursive: true });
  const root = mkdtempSync(join(EXAMPLE_ROOT, ".fgc", `${name}-`));
  scratchRoots.push(root);

  cpSync(join(EXAMPLE_ROOT, "forguncy.config.ts"), join(root, "forguncy.config.ts"));
  cpSync(join(EXAMPLE_ROOT, "cells"), join(root, "cells"), { recursive: true });
  cpSync(join(EXAMPLE_ROOT, "dependencies"), join(root, "dependencies"), { recursive: true });
  return root;
}

/** The Skill's `record`, as the Agent would run it: a child process writing real files. */
async function recordInlineDecision(root: string): Promise<void> {
  await run(
    process.execPath,
    [SKILL_CLI, "record", "--project", root, "--decision", join(root, "dependencies", "es-toolkit.decision.json")],
    { cwd: REPOSITORY_ROOT, maxBuffer: 32 * 1024 * 1024 },
  );
}

/** A port that answers like a designer and keeps what it was asked to write. */
function recordingPort(): {
  readonly port: ForguncySyncPort;
  readonly writes: { readonly pageName: string; readonly cell: string; readonly code: string }[];
} {
  const writes: { pageName: string; cell: string; code: string }[] = [];

  const port: ForguncySyncPort = {
    listFrontendLibraries: async () => [],
    // The Cell is empty until this run writes it; afterwards it reports exactly the code that was
    // written, which is what makes the second run `unchanged` rather than a second write.
    readCellSource: async request => {
      const written = [...writes].reverse().find(entry => entry.pageName === request.pageName && entry.cell === request.cell);
      return written === undefined
        ? { kind: "blank" }
        : { kind: "react-cell", code: written.code, frontendLibraries: [], bindingProps: {} };
    },
    setCells: async request => {
      for (const cell of request.cells) {
        writes.push({ pageName: request.pageName, cell: cell.cell, code: cell.cellTypeProps.code });
      }
    },
    getProjectSaveStatus: async () => ({ containsUnsavedChanges: false }),
    saveProject: async () => ({ saved: true }),
    checkProjectErrors: async () => ({ errorCount: 0 }),
    generatePageAsync: async request => ({
      pageName: request.pageName,
      pageUrl: `http://localhost/Forguncy/${encodeURIComponent(request.pageName)}`,
    }),
  };

  return { port, writes };
}

/** A port that fails the test if anything tries to write. Plan must never call these. */
function readOnlyPort(): ForguncySyncPort {
  const refuse = (operation: string) => async (): Promise<never> => {
    throw new Error(`plan called ${operation}, which is a write. A plan must make no remote write.`);
  };
  return {
    listFrontendLibraries: async () => [],
    readCellSource: async () => ({ kind: "blank" }),
    setCells: refuse("setCells"),
    getProjectSaveStatus: async () => ({ containsUnsavedChanges: false }),
    saveProject: refuse("saveProject"),
    checkProjectErrors: refuse("checkProjectErrors"),
    generatePageAsync: refuse("generatePageAsync"),
  };
}

/** A port whose target already holds designer work this flow did not write. */
function divergedPort(): ForguncySyncPort {
  const port = recordingPort().port;
  return {
    ...port,
    readCellSource: async () => ({ kind: "occupied", code: "a designer's own cell content" }),
  };
}

describe("a consumer project loads through one answer, not seven packages' internals", () => {
  it("carries the project-declared extension row and the bridge's host rows", async () => {
    const root = scratchProject("load");
    await recordInlineDecision(root);

    const project = await loadCellProject({ root });

    // The mapping row is the project's, and the built-in table is unchanged: the point of #85's
    // input is that a consumer supplies a row without editing the tool.
    expect(project.registry.extensionMappings.projectMappings.map(row => row.packageName)).toEqual(["@example/chart-panel"]);
    expect(HOST_BRIDGE_MAPPINGS.some(row => row.specifier === "@example/chart-panel")).toBe(false);

    // `react` is supplied by the target's bridge rather than recorded, because there is no package
    // for a project to select: the page provides it. This is the row that makes a React Cell
    // compile at all.
    expect(project.hostDefaults).toEqual(
      expect.arrayContaining([expect.objectContaining({ packageName: "react", globalName: "React" })]),
    );
    expect(project.cells[0]?.decisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ packageName: "react", strategy: "host" })]),
    );

    // The lock is produced by the Skill, and the projection reads it. Asserted after a real
    // `record` rather than against a committed file: the example does not commit one, because a
    // record's install-graph identity is this machine's (see the example's `package.json`).
    expect(project.hasLock).toBe(true);
    expect(project.lock.decisions.map(record => record.packageName)).toEqual(["es-toolkit"]);
  }, CASE_TIMEOUT_MS);

  it("does not let the bridge decide a package the project recorded", async () => {
    // The union's rule, stated as a case rather than as a comment: a recorded decision always
    // wins over the bridge's default, because the lock is what a reader has to keep current. A
    // project that decided a package #9's table could serve as `host` must compile against its own
    // choice — otherwise re-recording a decision would quietly do nothing.
    const root = scratchProject("decided-host");
    await recordInlineDecision(root);

    const lockPath = join(root, "fgc.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { decisions: Record<string, unknown>[] };
    const record = lock.decisions.find(decision => decision.packageName === "es-toolkit")!;
    // Repurpose the record into the shape a project-level `antd` decision would have: the bridge
    // has a row for `antd`, and a record for it must take precedence over that row.
    record.packageName = "antd";
    record.strategy = "host";
    record.globalName = "antd";
    record.resolvedVersion = null;

    const defaults = hostDefaultsOf({ lock: lock as never });
    expect(defaults.map(entry => entry.packageName)).not.toContain("antd");
    // The control: the bridge still supplies the rows the lock says nothing about.
    expect(defaults.map(entry => entry.packageName)).toContain("react");
  }, CASE_TIMEOUT_MS);
});

describe("build → plan → sync, through the public entrypoints", () => {
  it("records, builds a sync-ready artifact, and keeps a repeated build byte-identical", async () => {
    const root = scratchProject("chain");
    await recordInlineDecision(root);

    const first = await buildProject({ root });
    expect(first.cells.map(cell => cell.status)).toEqual(["compiled"]);
    const cell = first.cells[0]!;
    expect(cell.artifact).not.toBeNull();
    expect(cell.artifact!.frontendLibraries).toEqual([]);
    // The v1 resource pipeline (#98) is part of the same build: the stylesheet and the asset are
    // inlined, and the manifest names them rather than leaving a reader to decode the artifact.
    expect(cell.artifact!.resources.map(resource => resource.kind).sort()).toEqual(["asset", "style"]);
    expect(cell.decisions).toEqual(expect.arrayContaining([{ packageName: "es-toolkit", strategy: "inline", source: "lock" }]));

    // The inlined package's code is *in* the artifact: `sumBy` and `clamp` come from es-toolkit and
    // the Cell's own source cannot compute them otherwise.
    const code = readFileSync(join(first.outDir!, cell.artifact!.file), "utf8");
    expect(code).toContain("sumBy");
    expect(code).not.toContain("@example/chart-panel");

    const manifest = readFileSync(first.manifestPath!, "utf8");
    const second = await buildProject({ root });
    expect(second.cells[0]!.artifact!.fingerprint).toBe(cell.artifact!.fingerprint);
    expect(readFileSync(second.manifestPath!, "utf8")).toBe(manifest);

    // A non-empty extension reference is what makes the sync's extension audit a live check rather
    // than a vacuous one: this Cell's decisions imply no library, and an artifact claiming one would
    // be refused before any write. The `extension` *strategy* path (a mapped package imported by a
    // Cell) is exercised by `examples/extension-custom`'s chain and by `mcp-sync`'s own suite; this
    // assertion pins the consumer project's half — the project row is present and unclaimed here.
    expect(first.extensionMappings.map(row => row.packageName)).toEqual(["@example/chart-panel"]);
    expect(cell.artifact!.frontendLibraries).toEqual([]);

    // A source edit reaches the same entrypoint and moves the artifact, which is what makes the
    // fingerprint above a claim about the build rather than a constant. A *visible* string changes:
    // an added comment is stripped by the bundler and would prove nothing.
    const appPath = join(root, "cells", "sales-overview", "src", "App.tsx");
    writeFileSync(
      appPath,
      readFileSync(appPath, "utf8").replace("本月销售概览", "本月销售概览（改）"),
      "utf8",
    );
    const edited = await buildProject({ root });
    expect(edited.cells[0]!.status).toBe("compiled");
    expect(edited.cells[0]!.artifact!.fingerprint).not.toBe(cell.artifact!.fingerprint);
  }, CASE_TIMEOUT_MS);

  it("plans offline without writing, and plans against a port without any write call", async () => {
    const root = scratchProject("plan");
    await recordInlineDecision(root);
    const build = await compileProject({ root, write: false });

    const offline = planProject(build);
    expect(offline.report.mode).toBe("offline");
    expect(offline.report.cells.map(cell => cell.wouldWrite)).toEqual([true]);
    expect(offline.report.cells[0]!.targetStateRead).toBe(false);
    // `plan` compiled in memory, so it left no build output behind. The `.fgc/` directory itself
    // exists because `record`'s probe cache lives there (#17) — that is the Skill's, not a build.
    expect(existsSync(join(root, ".fgc", "build"))).toBe(false);

    const connected = await planProjectAgainstPort(build, { port: readOnlyPort(), portDescription: "read-only test port" });
    expect(connected.report.mode).toBe("connected");
    expect(connected.report.cells[0]!.targetStateRead).toBe(true);
    // The plan as a whole is still a plan: `planSetCellsDispatch` is what decides a write, and no
    // port call was made by the assertion above.
    expect(connected.report.cells[0]!.wouldWrite).toBe(true);

    expect(formatProjectSyncPlan(offline.report)).toContain("offline");
    expect(formatProjectBuildReport(await buildProject({ root, write: false }))).toContain("compiled");
  }, CASE_TIMEOUT_MS);

  it("syncs only when called, reports `unchanged` on a retry, and keeps a diverged target refused", async () => {
    const root = scratchProject("sync");
    await recordInlineDecision(root);
    const build = await compileProject({ root, write: false });

    const { port, writes } = recordingPort();
    const first = await syncProject(build, { port, portDescription: "recording port" });
    expect(first.cells.map(cell => cell.status)).toEqual(["written"]);
    expect(writes).toHaveLength(1);
    // `runtimePageUrl` percent-encodes the page name, which is the platform's URL shape rather
    // than this contract's: the locator carries the page, not the label a person reads.
    expect(first.cells[0]!.runtimeUrl).toContain(encodeURIComponent("销售看板"));

    const second = await syncProject(build, { port, portDescription: "recording port" });
    expect(second.cells.map(cell => cell.status)).toEqual(["unchanged"]);
    // The retry wrote nothing: the target already holds this artifact, and the run reports the
    // locator while saying so (#92's unchanged route).
    expect(writes).toHaveLength(1);

    const refused = await syncProject(build, { port: divergedPort(), portDescription: "diverged target" });
    expect(refused.cells.map(cell => cell.status)).toEqual(["refused"]);
    expect(refused.cells[0]!.diagnostics.map(diagnostic => diagnostic.code)).toContain("cell-diverged");

    expect(formatProjectSyncReport(first)).toContain("written");
  }, CASE_TIMEOUT_MS);
});

describe("an invalidated lock decision is reported, not silently compiled through", () => {
  it("withholds a record whose installed version moved", async () => {
    const root = scratchProject("stale");
    await recordInlineDecision(root);

    const lockPath = join(root, "fgc.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
      decisions: { packageName: string; resolvedVersion: string | null }[];
    };
    const record = lock.decisions.find(decision => decision.packageName === "es-toolkit");
    expect(record).toBeDefined();
    // A lock whose recorded version is not the installed one. Editing the *record* in a scratch
    // tree is how this case produces the stale state without installing a second version; the
    // committed example is never touched.
    record!.resolvedVersion = "0.0.0-not-installed";
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

    const build = await compileProject({ root, write: false });
    const cell = build.report.cells[0]!;
    const withheld = cell.withheld.find(entry => entry.packageName === "es-toolkit");
    expect(withheld).toBeDefined();
    expect(withheld!.reason).toBe("not-verified");
    // The reason is `package-version-changed`, and the report may also carry the local boundary's
    // `probe-fingerprint-unknown` — the projection cannot recompose a fingerprint, so it says so
    // rather than pretending the axis matched. A membership assertion keeps this case about the
    // observable axis it introduced.
    expect(withheld!.stalenessReasons).toContain("package-version-changed");
    expect(cell.decisions.some(decision => decision.packageName === "es-toolkit")).toBe(false);
  }, CASE_TIMEOUT_MS);
});

/** Runs the shipped CLI as a child process — the command entrypoints, not only the functions. */
async function cli(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("the shipped commands run without a wrapper", () => {
  it("builds and plans from a clean project with no remote call, and refuses sync without a port", async () => {
    const root = scratchProject("cli");
    await recordInlineDecision(root);

    const built = await cli(["build", "--project", root, "--json"], root);
    expect(built.code, built.stderr).toBe(0);
    const builtReport = JSON.parse(built.stdout) as { command: string; cells: { status: string; artifact: { file: string } }[] };
    expect(builtReport.command).toBe("build");
    expect(builtReport.cells[0]!.status).toBe("compiled");
    expect(existsSync(join(root, ".fgc", "build", builtReport.cells[0]!.artifact.file))).toBe(true);

    const planned = await cli(["plan", "--project", root, "--json"], root);
    expect(planned.code, planned.stderr).toBe(0);
    const plannedReport = JSON.parse(planned.stdout) as { command: string; mode: string };
    expect(plannedReport.command).toBe("plan");
    expect(plannedReport.mode).toBe("offline");

    // `sync` has no default port: an authorized designer connection is the caller's, and requiring
    // one is what makes "sync without a designer" unexpressible rather than a silent no-op.
    const unsynced = await cli(["sync", "--project", root], root);
    expect(unsynced.code).not.toBe(0);
    expect(unsynced.stderr).toContain("--port");

    // A typo in a policy flag is refused rather than silently leaving the default in place.
    const badPolicy = await cli(["plan", "--project", root, "--overwrite", "please"], root);
    expect(badPolicy.code).not.toBe(0);
    expect(badPolicy.stderr).toContain('"preserve-designer-edits" or "force"');
  }, CASE_TIMEOUT_MS);
});
