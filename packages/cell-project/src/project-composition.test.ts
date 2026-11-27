/**
 * `cell-project`'s three verbs answer from their dependencies' own rules.
 *
 * Decision source: GitHub Issue #157
 * (https://github.com/MangMax/forguncy-react-workspace/issues/157): the orchestration layer uses
 * what its dependencies already export, and the "refuse when a Cell was rejected" guard exists
 * once.
 *
 * ## The cases, and what each one pins
 *
 * - **The per-Cell lock view lists each package once, with today's labels.** A bridge row the lock
 *   does not decide is `host-bridge`; a recorded decision is `lock`. The union is assembled from
 *   the lock's own lookups rather than from an after-the-fact dedupe, so a package that appears in
 *   both inputs must not appear twice.
 * - **`plan` classifies a read target the way `sync` does.** Both must answer "blank → writable"
 *   and "occupied → held/refused" from the same mapping, because a plan that disagreed with the
 *   sync it describes would be the second copy of the conflict rule.
 * - **Both refusals keep their own message.** `plan` and `sync` refuse a rejected compile through
 *   one shared guard, but a reader is told which verb refused: "Cannot plan a sync" names the
 *   diagnostic codes, "Cannot sync" says nothing was read or written.
 *
 * ## Evidence label
 *
 * A real compile through the real bundler, and mock ports. `local` evidence only (AGENTS.md rules
 * 6–7): no designer is contacted, so nothing here is a Forguncy runtime claim.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ForguncySyncPort } from "@forguncy-react-workspace/mcp-sync";
import { readToolchainIdentity } from "@forguncy-react-workspace/dependency-resolver/local";

import {
  buildProject,
  compileProject,
  loadCellProject,
  planProject,
  planProjectAgainstPort,
  ProjectPlanError,
  syncProject,
} from "./index.ts";
import type { ProjectBuild } from "./index.ts";

/**
 * Every case here runs a real project build (registry, install-graph read, Rolldown compile), so
 * Vitest's 5 s default is a budget for a unit test, not for this. Measured on Windows under the full
 * parallel suite: the file took 20.8 s and one case timed out at exactly 5000 ms while passing in
 * isolation, which is a budget that is too small rather than a behaviour that broke — the same
 * reasoning as the dev-harness integration suites' `vi.setConfig`.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..");
const EXAMPLE_ROOT = join(REPOSITORY_ROOT, "examples", "consumer-project");

/** A real Rolldown compile of a trivial Cell; no probe runs, so the budget is generous. */
const CASE_TIMEOUT_MS = 120_000;

const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A project with one Cell and no dependencies at all.
 *
 * Under the example's own `.fgc/` so a Cell that imports an installed package still resolves it
 * through the example's `node_modules`; `write: false` compiles leave no build output behind.
 */
function trivialProject(name: string, appSource: string): string {
  mkdirSync(join(EXAMPLE_ROOT, ".fgc"), { recursive: true });
  const root = mkdtempSync(join(EXAMPLE_ROOT, ".fgc", `${name}-`));
  scratchRoots.push(root);

  mkdirSync(join(root, "cells", "plain", "src"), { recursive: true });
  writeFileSync(join(root, "cells", "plain", "src", "App.ts"), appSource, "utf8");
  writeFileSync(
    join(root, "forguncy.config.ts"),
    [
      "export default {",
      '  runtime: { forguncyVersion: "12.0.102", projectAlias: "trivial" },',
      "  cells: {",
      '    plain: { entry: "./cells/plain/src/App.ts", target: { pageName: "Page", cell: "A1" } },',
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

/** A Cell that imports nothing: it compiles with no dependency decision at all. */
const PLAIN_APP = "export function App() {\n  return null;\n}\n";

/** A Cell that imports an installed package the project recorded no decision for. */
const UNCOVERED_APP = 'import { sumBy } from "es-toolkit";\n\nexport function App() {\n  return sumBy([1, 2]);\n}\n';

/** A port whose target read is supplied per case; every write is refused loudly. */
function portReading(read: () => Promise<{ kind: "blank" } | { kind: "occupied"; code: string } | { kind: "react-cell"; code: string; frontendLibraries: readonly { libraryId: string }[], bindingProps: {} }>): ForguncySyncPort {
  const refuse = (operation: string) => async (): Promise<never> => {
    throw new Error(`the test expected no write, but ${operation} was called`);
  };
  return {
    listFrontendLibraries: async () => [],
    readCellSource: read,
    setCells: refuse("setCells"),
    getProjectSaveStatus: async () => ({ containsUnsavedChanges: false }),
    saveProject: refuse("saveProject"),
    checkProjectErrors: refuse("checkProjectErrors"),
    generatePageAsync: refuse("generatePageAsync"),
  };
}

describe("the per-Cell lock view lists each package once, with today's labels", () => {
  it("does not measure the toolchain when the project has no recorded decisions", async () => {
    const project = await loadCellProject({ root: trivialProject("no-decisions", PLAIN_APP) });

    expect(project.hasLock).toBe(false);
    expect(project.toolchain).toBeNull();
  });

  it("reports every bridge row as `host-bridge`, exactly once", async () => {
    const root = trivialProject("lock-view", PLAIN_APP);
    const report = await buildProject({ root, write: false });

    const decisions = report.cells[0]!.decisions;
    const names = decisions.map(decision => decision.packageName);
    // The control: the union is non-empty, so a uniqueness assertion is about something.
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    // Nothing is recorded, so every row is the bridge's — and labelled as such, because a reader
    // of the report must be able to tell what this project has to keep current.
    expect(decisions.every(decision => decision.source === "host-bridge")).toBe(true);
    expect(decisions.every(decision => decision.strategy === "host")).toBe(true);
    expect(names).toEqual(expect.arrayContaining(["react", "react-dom", "antd"]));
  });

  it("lists a package the bridge also maps once, labelled `lock`", async () => {
    // The one case where the two inputs overlap: `antd` has a bridge row *and* a recorded
    // decision. Today's label is `lock`, and it must stay `lock` — a reader has to keep the record
    // current, and calling it `host-bridge` would hide that obligation.
    //
    // The record is written to be *kept* rather than withheld: freshness is judged against this
    // project's own toolchain, read the way the build reads it, so the only thing this case varies
    // is which input a package came from.
    const root = trivialProject("lock-view-recorded", PLAIN_APP);
    const toolchain = await readToolchainIdentity(root);
    writeFileSync(
      join(root, "fgc.lock.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          decisions: [
            {
              packageName: "antd",
              cellTarget: null,
              strategy: "host",
              resolvedVersion: "5.0.0",
              globalName: "antd",
              probe: { status: "passed", fingerprint: "probe=inline-bundle;entry=antd", versionIndependent: true },
              target: null,
              probedWith: toolchain,
              extension: null,
              rejectedCandidate: null,
              rationale: null,
              evidence: [
                { kind: "probe", reference: "fgc-evidence/antd.json" },
                { kind: "spec-issue", reference: "https://github.com/MangMax/forguncy-react-workspace/issues/9" },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const report = await buildProject({ root, write: false });
    const antdRows = report.cells[0]!.decisions.filter(decision => decision.packageName === "antd");

    expect(antdRows).toHaveLength(1);
    expect(antdRows[0]!.source).toBe("lock");
    expect(antdRows[0]!.strategy).toBe("host");
    // The control: the bridge's other rows are still reported, so the single `antd` row is about
    // the overlap rather than about the union having collapsed to the lock alone.
    expect(report.cells[0]!.decisions.map(decision => decision.packageName)).toContain("react");
    // `readToolchainIdentity` walks the whole install tree for `installedTree`, so this case pays
    // that once on top of the compile; the suite default is shorter than that under load.
  }, CASE_TIMEOUT_MS);
});

describe("plan classifies a read target the way sync does", () => {
  let build: ProjectBuild;

  beforeAll(async () => {
    const root = trivialProject("plan-state", PLAIN_APP);
    build = await compileProject({ root, write: false });
    expect(build.report.cells[0]!.status).toBe("compiled");
  }, CASE_TIMEOUT_MS);

  it("plans a blank target as a write, and an occupied one as a hold", async () => {
    const blank = await planProjectAgainstPort(build, {
      port: portReading(async () => ({ kind: "blank" })),
      portDescription: "blank",
    });
    expect(blank.report.cells[0]!.wouldWrite).toBe(true);
    expect(blank.report.cells[0]!.heldBecause).toBeNull();
    expect(blank.report.cells[0]!.divergence.kind).toBe("vacant");

    const occupied = await planProjectAgainstPort(build, {
      port: portReading(async () => ({ kind: "occupied", code: "a designer's own cell" })),
      portDescription: "occupied",
    });
    expect(occupied.report.cells[0]!.wouldWrite).toBe(false);
    expect(occupied.report.cells[0]!.divergence.kind).toBe("foreign-code");
    // The hold's *reason* is the gate's, and the divergence is reported beside it: the gate refuses
    // on the blocking diagnostic, and `divergence` names what was found. Both must be present,
    // because a reader told only "gate-refused" could not tell a designer's cell from a broken one.
    expect(occupied.report.cells[0]!.heldBecause).toContain("the plan's gate refused");
    expect(occupied.report.cells[0]!.diagnostics.map(diagnostic => diagnostic.code)).toContain("cell-diverged");
  }, CASE_TIMEOUT_MS);

  it("holds a target that already holds this artifact, as sync reports it unchanged", async () => {
    // The same content `sync` would have written: the artifact plus the sync marker the flow
    // assembles. Taken from a recording run rather than composed here, so this case reads the
    // real written form.
    const writes: string[] = [];
    const recording: ForguncySyncPort = {
      ...portReading(async () => ({ kind: "blank" })),
      readCellSource: async () =>
        writes.length === 0 ? { kind: "blank" } : { kind: "react-cell", code: writes[0]!, frontendLibraries: [], bindingProps: {} },
      setCells: async request => {
        for (const cell of request.cells) {
          writes.push(cell.cellTypeProps.code);
        }
      },
      getProjectSaveStatus: async () => ({ containsUnsavedChanges: false }),
      saveProject: async () => ({ saved: true }),
      checkProjectErrors: async () => ({ errorCount: 0 }),
      generatePageAsync: async request => ({ pageName: request.pageName, pageUrl: "http://localhost/Forguncy" }),
    };

    const written = await syncProject(build, { port: recording, portDescription: "recording" });
    expect(written.cells.map(cell => cell.status)).toEqual(["written"]);

    const planned = await planProjectAgainstPort(build, { port: recording, portDescription: "recording" });
    expect(planned.report.cells[0]!.wouldWrite).toBe(false);
    expect(planned.report.cells[0]!.divergence.kind).toBe("identical");
    expect(planned.report.cells[0]!.heldBecause).toContain("the target already holds this artifact");
  }, CASE_TIMEOUT_MS);
});

describe("both verbs refuse a rejected compile through one guard, each in its own words", () => {
  let rejected: ProjectBuild;

  beforeAll(async () => {
    const root = trivialProject("refusals", UNCOVERED_APP);
    rejected = await compileProject({ root, write: false });
    expect(rejected.report.cells[0]!.status).toBe("rejected");
  }, CASE_TIMEOUT_MS);

  it("plan names the diagnostic codes and points at the build report", () => {
    let message = "";
    try {
      planProject(rejected);
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectPlanError);
      message = (error as Error).message;
    }

    expect(message).toContain("Cannot plan a sync: 1 of 1 Cell(s) did not compile");
    expect(message).toContain("plain: unresolved-dependency-decision");
    expect(message).toContain("nothing was planned for the Cells that did compile");
  });

  it("sync says nothing was read and nothing was written", async () => {
    let message = "";
    try {
      await syncProject(rejected, { port: portReading(async () => ({ kind: "blank" })) });
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectPlanError);
      message = (error as Error).message;
    }

    expect(message).toContain("Cannot sync: 1 of 1 Cell(s) did not compile");
    expect(message).toContain("Nothing was read and nothing was written");
  });
});
