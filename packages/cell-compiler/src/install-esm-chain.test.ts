/**
 * ESM 回归：从真实安装包跑通 probe → audit → record → status → Cell 编译 (#90).
 *
 * Decision source: GitHub Issue #90 — "ESM 回归：从真实安装包跑通 probe → record → status → Cell 编译"
 * (https://github.com/MangMax/forguncy-react-workspace/issues/90), downstream of #89 (the locator
 * fix this regression has to keep working through the whole chain), #16 (the Skill/scripts split),
 * #17 (the probe engine), #8 (the lock the flow records into), #4/#14 (the decisions the compiler
 * consumes).
 *
 * ## What this file actually executes
 *
 * Everything below is the real chain, not a rehearsal of it:
 *
 * 1. `__fixtures__/install-esm` is a project whose dependency graph is produced by `pnpm install
 *    --offline` in a **temporary copy** — real virtual store, real per-package links, real
 *    realpath'd package directories. A hand-written `node_modules` tree would answer
 *    `findPackageJSON` without proving anything a pnpm layout does.
 * 2. The Skill's CLI is spawned (`probe`, `record`, `status`) against that project. Nothing here
 *    reaches into `packages/dependency-resolver` to skip a step.
 * 3. The exact `fgc.lock.json` the CLI wrote is read back with the public resolver API
 *    (`readFgcLock` → `resolveInstalledVersions` → `probeLockEnvironment` →
 *    `auditLockDecisionConformance` → `localCompilationDependencies`), planned through
 *    `planCellCompile`, and compiled by `compileCell` with the real Rolldown port.
 * 4. The emitted artifact is **evaluated** in `node:vm` and the component's return value is
 *    compared, so "the fixture functions ran" is an observation rather than a banner match.
 *
 * ## The two shapes this file pinned a defect around
 *
 * Both were found by running the chain, and both were unrecordable before this ticket:
 *
 * - **An exact subpath decision.** The probe's `environment.packageName` is the *package* (#17
 *   resolves the manifest the request belongs to), while the decision may name the published
 *   subpath the Cell imports. `auditSelectionDecision` compared the two spellings verbatim and
 *   refused every subpath record — even though the CLI had just built that exact subpath entry.
 *   The audit now compares the package each name belongs to; `selection-policy.test.ts` pins
 *   both directions.
 * - **A subpath-only package** (`exports: { "./only": … }`, no `"."`). `export-metadata` asked the
 *   manifest about the *root* entry and reported `ssr-or-server-only-without-browser-build` for
 *   the subpath it had successfully built, making the package look server-only and unrecordable.
 *   The step now answers the question about the entry the build imports;
 *   `export-metadata.test.ts` pins root, named-subpath and unexported-subpath requests.
 *
 * ## What is deliberately not claimed
 *
 * AGENTS.md rules 6 and 7. A green run here is **local** evidence: it proves compilation,
 * assembly and sandboxed evaluation on this toolchain, not Forguncy runtime compatibility. That
 * is why the chain test also asserts the **deployment** gate (`compilationDependencies`) still
 * withholds every record — a probe without a real page cannot close the runtime gate, and a
 * test that reported otherwise would be fabricating evidence.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createContext, Script } from "node:vm";

import type { DependencyDecision, FgcLockDocument, LockEnvironment } from "@forguncy-react-workspace/core";
import { loadForguncyConfig } from "@forguncy-react-workspace/core";
import {
  auditLockDecisionConformance,
  compilationDependencies,
  composeProbeFingerprint,
  conformanceErrors,
  localCompilationDependencies,
  probeLockEnvironment,
  readFgcLock,
  recordedPackageNames,
  resolveInstalledVersions,
} from "@forguncy-react-workspace/dependency-resolver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileCell } from "./artifact.ts";
import type { CompileCellOutcome } from "./artifact.ts";
import { CELL_ENTRY_COMPONENT_BINDING } from "./entry.ts";
import { createRolldownCellBundler } from "./rolldown-bundler.ts";
import { planCellCompile } from "./registry-plan.ts";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..");
const CLI = join(
  REPOSITORY_ROOT,
  ".agents",
  "skills",
  "forguncy-react-dependency-selection",
  "scripts",
  "select_dependency.mjs",
);
const FIXTURE_ROOT = join(HERE, "__fixtures__", "install-esm");

/** A real install plus several Rolldown builds per case. */
const CASE_TIMEOUT_MS = 180_000;

/** The Cell the project config declares, and the entry the chain compiles. */
const CELL_ID = "esm";

/**
 * Every specifier the Cell's module graph reaches, under the name the lock records it by.
 *
 * The last two are the transitive pair: the entry imports `fgc-fixture-transitive` only, and
 * `fgc-fixture-transitive-dep` reaches the bundle through that import. Both are listed because
 * both are bare specifiers the bundle inlines, and #4 requires a decision for each.
 */
const CHAIN_DECISIONS: readonly string[] = [
  "@fgc-fixture/scoped-esm",
  "fgc-fixture-browser-cond",
  "fgc-fixture-hidden",
  "fgc-fixture-import-only",
  "fgc-fixture-sub/extra",
  "fgc-fixture-subpath-only/only",
  "fgc-fixture-transitive",
  "fgc-fixture-transitive-dep",
];

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the Skill's CLI as a child process — the only way to observe its exit code and bytes. */
async function cli(args: readonly string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: REPOSITORY_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function json<T = Record<string, unknown>>(result: CommandResult): T {
  return JSON.parse(result.stdout) as T;
}

/**
 * Spawns the package manager.
 *
 * Bare `pnpm` on both platforms: Node resolves the Windows shim on this toolchain (measured),
 * and the CI setup step puts the same command on `PATH`. No pnpm version is pinned — the
 * fixtures are `file:` links, and their layout is what any isolated linker produces.
 */
async function install(root: string): Promise<void> {
  try {
    const { stdout, stderr } = await run("pnpm", ["install", "--offline", "--ignore-scripts"], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    // Logged rather than asserted: pnpm's peer/deprecation warnings are informational and vary
    // by version, and the failure of interest is at the process level.
    console.info(`pnpm install: ${stdout.trim().split("\n").at(-1) ?? "done"}${stderr.trim().length > 0 ? `\n${stderr}` : ""}`);
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw new Error(
      `pnpm install failed for the install-level fixture. This test is meant to run offline from local file: fixtures only.\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`,
    );
  }
}

/** A project root: a temporary copy of the committed fixture, installed for real. */
async function installedProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fgc-install-esm-"));
  await cp(FIXTURE_ROOT, root, {
    recursive: true,
    // The committed fixture is a project source tree; it carries no install and must not.
    filter: source => !source.split(/[\\/]/).includes("node_modules"),
  });
  await install(root);
  return root;
}

/**
 * Clears what a CLI run writes, so each case starts from "no decision recorded yet".
 *
 * `.fgc/` is kept: it is the probe cache and scratch space, not project state, and clearing it
 * would re-run the same measurements for every case. `fgc.lock.json` and `fgc-evidence/` are the
 * observable outputs, so they are what a "nothing was written" assertion reads.
 */
async function resetProject(root: string): Promise<void> {
  await rm(join(root, "fgc.lock.json"), { force: true });
  await rm(join(root, "fgc-evidence"), { recursive: true, force: true });
  await rm(join(root, "decisions"), { recursive: true, force: true });
}

/** The decision file an Agent hands to `audit` / `record`. The script never fills these in. */
async function writeDecision(root: string, packageName: string): Promise<string> {
  const directory = join(root, "decisions");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${packageName.replace(/[@/]/g, "_")}.json`);
  await writeFile(
    path,
    `${JSON.stringify({ packageName, role: "cell-local-ui", strategy: "inline" }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

interface LockRecord {
  readonly packageName: string;
  readonly strategy: string;
  readonly resolvedVersion: string | null;
  readonly target: unknown;
  readonly probe: { readonly status: string; readonly fingerprint: string | null };
  readonly evidence: readonly { readonly kind: string; readonly reference: string }[];
}

async function readLock(root: string): Promise<{ decisions: readonly LockRecord[] }> {
  return JSON.parse(await readFile(join(root, "fgc.lock.json"), "utf8")) as {
    decisions: readonly LockRecord[];
  };
}

/** Every file under `root` as `relativePath:sha256`. Sorted, so a comparison diffs. */
async function snapshot(root: string): Promise<readonly string[]> {
  const lines: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        lines.push(
          `${relative(root, absolute).split("\\").join("/")}:${createHash("sha256").update(bytes).digest("hex")}`,
        );
      }
      // A symlink is skipped rather than followed: the installed graph is full of them, and
      // `readFile` on a linked directory is an error rather than a file to hash.
    }
  }
  await walk(root);
  return lines.sort();
}

/**
 * The file names in a directory, or `[]` when it does not exist — so a "nothing new was
 * written" assertion reads the same whether the directory is present or absent.
 */
async function fileNames(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch {
    return [];
  }
}

/** Without the install, and without the directories the CLI is expected to write. */
async function projectSourceSnapshot(root: string): Promise<readonly string[]> {
  const lines = await snapshot(root);
  return lines.filter(
    line =>
      !line.startsWith("node_modules/") &&
      !line.startsWith("decisions/") &&
      !line.startsWith(".fgc/") &&
      !line.startsWith("fgc.lock.json") &&
      !line.startsWith("fgc-evidence/"),
  );
}

/**
 * The decisions the compiler may act on, from the lock the CLI wrote — the documented local
 * projection (`localCompilationDependencies`), which enforces freshness but does not pretend a
 * probe established a real runtime.
 *
 * The probe fingerprints are **recomposed** from the record's own declared inputs (entry = the
 * record's package name, the CLI's default; no cap, no named surface), which makes the freshness
 * check an independent recomputation rather than a copy of the record.
 */
async function decisionsFromLock(root: string): Promise<{
  readonly lock: FgcLockDocument;
  readonly environment: LockEnvironment;
  readonly dependencies: readonly DependencyDecision[];
}> {
  const lock = await readFgcLock(root);
  const conformance = auditLockDecisionConformance(lock, {});
  expect(
    conformanceErrors(conformance).map(diagnostic => diagnostic.code),
    "the lock the chain wrote has to conform to the strategy contract",
  ).toEqual([]);

  // The installed versions are what a freshness check compares against the record. Read here —
  // through the same `resolveInstalledVersions` the lock's own environment uses — so the chain is
  // proven to resolve the fixture package the record names from this project's install graph, and
  // not only through the CLI's copy of the same question.
  const { versions }
    = await resolveInstalledVersions(root, recordedPackageNames(lock));
  expect(Object.keys(versions).sort()).toEqual(recordedPackageNames(lock));
  const probeFingerprints: Record<string, string> = {};
  for (const record of lock.decisions) {
    probeFingerprints[record.packageName] = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: record.packageName,
    }).fingerprint;
  }
  const environment = await probeLockEnvironment(root, { lock, probeFingerprints });

  const projection = localCompilationDependencies(lock, environment);
  expect(projection.withheld, "a fresh inline record is not withheld on the local projection").toEqual([]);
  return { lock, environment, dependencies: projection.dependencies };
}

/** Compiles one declared Cell through the project's own registry and the real Rolldown port. */
async function compileDeclaredCell(
  root: string,
  dependencies: readonly DependencyDecision[],
  options: { readonly cellId?: string } = {},
): Promise<CompileCellOutcome> {
  const registry = await loadForguncyConfig({ root, requireEntryFiles: true });
  const plan = planCellCompile({ registry, cellId: options.cellId ?? CELL_ID, dependencies });
  return compileCell(plan.input, {
    bundler: createRolldownCellBundler({ dir: root }),
    extensionMappings: plan.extensionMappings,
    ...(plan.output?.codeBudgetCharacters === undefined
      ? {}
      : { codeBudgetCharacters: plan.output.codeBudgetCharacters }),
  });
}

function diagnosticSummary(outcome: Extract<CompileCellOutcome, { readonly status: "rejected" }>): string {
  return outcome.diagnostics
    .map(diagnostic => `${diagnostic.code} [${diagnostic.subject}]: ${diagnostic.message}`)
    .join("\n");
}

/** A page's React, reduced to what the entry wrapper touches. */
function reactStub(): Record<string, unknown> {
  return {
    version: "19.2.7",
    Fragment: Symbol.for("react.fragment"),
    createElement: (type: unknown, props: Record<string, unknown> | null) => ({ type, props: props ?? {} }),
  };
}

/** Evaluates an artifact in an isolated `vm` context and returns its sandbox. */
function evaluate(code: string): Record<string, unknown> {
  const sandbox: Record<string, unknown> = { React: reactStub() };
  sandbox.globalThis = sandbox;
  new Script(code, { filename: "cell-artifact.js" }).runInContext(createContext(sandbox));
  return sandbox;
}

/** The component the artifact binds. Calling it is what makes the assertion about what ran. */
function componentOf(sandbox: Readonly<Record<string, unknown>>): () => Record<string, string> {
  const component = sandbox[CELL_ENTRY_COMPONENT_BINDING];
  if (typeof component !== "function") {
    throw new Error(`The artifact did not bind a function to ${CELL_ENTRY_COMPONENT_BINDING}.`);
  }
  return component as () => Record<string, string>;
}

/**
 * The expected return value, one per imported entry.
 *
 * The values are the fixtures' own strings, so a wrong branch (the Node-only export, a wrong
 * subpath, a package that failed to inline) produces a different object rather than a missing
 * marker.
 */
const EXPECTED_CELL_RESULT = {
  importOnly: "import-only-esm",
  hiddenManifest: "hidden-manifest",
  subpathOnly: "declared-subpath-only",
  declaredSubpath: "declared-subpath",
  scoped: "@fgc-fixture/scoped-esm",
  transitive: "outer+transitive-dep",
  browserBranch: "browser-branch",
} as const;

/**
 * The committed fixtures, captured before any case runs.
 *
 * Every command in this file reads `FIXTURE_ROOT` indirectly — the temporary project is a copy
 * of it — so "the commands did not rewrite their inputs" is asserted once, over everything that
 * ran, rather than per case where it would be re-stated three times and drift.
 */
let fixtureSnapshotBefore: readonly string[] = [];

beforeAll(async () => {
  fixtureSnapshotBefore = await snapshot(FIXTURE_ROOT);
});

afterAll(async () => {
  expect(fixtureSnapshotBefore.length, "the fixture snapshot must not be empty").toBeGreaterThan(0);
  expect(await snapshot(FIXTURE_ROOT), "the committed install-level fixtures must not be rewritten").toEqual(
    fixtureSnapshotBefore,
  );
});

describe("install-level ESM chain (#90)", () => {
  it(
    "records the exact lock the CLI wrote and compiles the Cell it describes, executing real return values",
    async () => {
      const root = await installedProject();
      try {
        // -- 1. The probe questions, per entry ------------------------------------------------
        //
        // Each is a shape #89 had to locate: import-only, a hidden (nameless) nested manifest, a
        // subpath-only package, a scoped package, an exact published subpath, a transitive
        // graph, and a browser/Node conditional export.
        const importOnly = await cli(["probe", "--project", root, "fgc-fixture-import-only"]);
        expect(importOnly.code, importOnly.stderr).toBe(0);
        expect(json<{ packageName: string; resolvedVersion: string }>(importOnly)).toMatchObject({
          packageName: "fgc-fixture-import-only",
          resolvedVersion: "1.0.0",
        });

        const hidden = await cli(["probe", "--project", root, "fgc-fixture-hidden"]);
        expect(hidden.code, hidden.stderr).toBe(0);
        expect(json<{ resolvedVersion: string }>(hidden).resolvedVersion).toBe("5.0.2");

        const subpathOnly = await cli(["probe", "--project", root, "fgc-fixture-subpath-only/only"]);
        expect(subpathOnly.code, subpathOnly.stderr).toBe(0);
        const subpathOnlyReport = json<{
          assessment: { status: string };
          validation: readonly { step: string; outcome: string }[];
          facts: readonly { name: string; value: unknown }[];
        }>(subpathOnly);
        // The defect this ticket fixed, asserted on the report: the step that judges browser
        // entries is about the entry the build imports, so a subpath-only package is not
        // reported as server-only for the subpath it publishes.
        expect(subpathOnlyReport.assessment.status).toBe("supports-deployment");
        expect(subpathOnlyReport.validation.find(step => step.step === "export-metadata")?.outcome).toBe("passed");
        expect(subpathOnlyReport.facts.find(fact => fact.name === "exports.probed-entry")?.value).toBe("./only");
        expect(subpathOnlyReport.facts.find(fact => fact.name === "exports.browser-resolvable")?.value).toBe(true);

        // The browser condition: the probe resolved the browser entry, not the Node one.
        const browserConditional = await cli(["probe", "--project", root, "fgc-fixture-browser-cond"]);
        expect(browserConditional.code, browserConditional.stderr).toBe(0);
        const browserConditionalReport = json<{ facts: readonly { name: string; value: unknown }[] }>(
          browserConditional,
        );
        expect(browserConditionalReport.facts.find(fact => fact.name === "runtime.entry-paths")?.value).toEqual([
          "browser/index.js",
        ]);

        // The transitive walk: probing the parent reports the dependency it reaches through a
        // pnpm nested link — the #89 realpath case one level into the graph.
        const transitive = await cli(["probe", "--project", root, "fgc-fixture-transitive"]);
        expect(transitive.code, transitive.stderr).toBe(0);
        const transitiveReport = json<{ facts: readonly { name: string; value: unknown }[] }>(transitive);
        expect(transitiveReport.facts.find(fact => fact.name === "graph.packages-scanned")?.value).toEqual(
          expect.arrayContaining(["fgc-fixture-transitive@6.0.0", "fgc-fixture-transitive-dep@1.0.0"]),
        );

        // -- 2. record, then read the lock back ------------------------------------------------
        for (const packageName of CHAIN_DECISIONS) {
          const decision = await writeDecision(root, packageName);
          const recorded = await cli(["record", "--project", root, "--decision", decision]);
          expect(recorded.code, `${packageName}: ${recorded.stderr}`).toBe(0);
          const payload = json<{ recorded: boolean; problems?: readonly string[] }>(recorded);
          expect(payload.recorded, `${packageName}: ${JSON.stringify(payload.problems ?? [])}`).toBe(true);
        }

        const lock = await readLock(root);
        expect(lock.decisions.map(record => record.packageName).sort()).toEqual([...CHAIN_DECISIONS].sort());
        for (const record of lock.decisions) {
          // A passing record cites the probe it rests on, and the citation is the report the
          // run produced — `status` re-verifies its bytes against the content address.
          expect(record.probe.status).toBe("passed");
          // The evidence is about the *entry* the record names; that is what makes the record
          // and the compile consume the same artifact.
          expect(record.probe.fingerprint).toContain(`entry=${JSON.stringify(record.packageName)}`);
          expect(record.evidence.some(link => link.kind === "probe")).toBe(true);
          // No hook was supplied, so no runtime claim may have been recorded (AGENTS.md rule 6).
          expect(record.target).toBeNull();
        }

        // -- 3. status: fresh immediately, not "not installed" and not stale -------------------
        const status = await cli(["status", "--project", root]);
        expect(status.code, status.stderr).toBe(0);
        const statusPayload = json<{
          decisions: readonly {
            packageName: string;
            freshness: string;
            stalenessReasons: readonly string[];
            unresolvedEvidence: readonly string[];
            alteredEvidence: readonly string[];
          }[];
        }>(status);
        expect(statusPayload.decisions).toHaveLength(CHAIN_DECISIONS.length);
        for (const decision of statusPayload.decisions) {
          expect(decision.packageName, "status reports the record it assessed").toBeDefined();
          expect(decision.freshness, `${decision.packageName}: ${decision.stalenessReasons.join(", ")}`).toBe("fresh");
          expect(decision.stalenessReasons).toEqual([]);
          expect(decision.unresolvedEvidence).toEqual([]);
          expect(decision.alteredEvidence).toEqual([]);
        }

        // -- 4. the resolver projection, from the exact file on disk ---------------------------
        const { lock: parsedLock, environment, dependencies } = await decisionsFromLock(root);
        expect(dependencies.map(decision => decision.packageName).sort()).toEqual([...CHAIN_DECISIONS].sort());
        expect(dependencies.every(decision => decision.strategy === "inline")).toBe(true);

        // The deployment gate still says no: every record is fresh, but none was validated on a
        // real page, so `compilationDependencies` withholds each one. A local green run is not a
        // Forguncy runtime claim (rules 6-7), and this assertion is the test saying so.
        const deployment = compilationDependencies(parsedLock, environment);
        expect(deployment.dependencies).toEqual([]);
        expect(deployment.withheld).toHaveLength(CHAIN_DECISIONS.length);
        expect(deployment.withheld.every(entry => entry.reason === "not-verified")).toBe(true);

        // -- 5. compile, then execute ----------------------------------------------------------
        const outcome = await compileDeclaredCell(root, dependencies);
        expect(
          outcome.status,
          outcome.status === "rejected" ? diagnosticSummary(outcome) : "",
        ).toBe("compiled");
        if (outcome.status !== "compiled") return;

        const code = outcome.artifact.code;
        expect(outcome.artifact.frontendLibraries).toEqual([]);
        // The artifact is flat and self-contained: every fixture was inlined, none survives as an
        // import, and the Node-only branch never entered the browser build.
        expect(code).not.toContain("node-only-branch");
        expect(code).not.toContain("readFileSync");
        expect(code).not.toMatch(/require\(["']node:/);
        // The browser branch's own text is present, so the value assertion below is not a
        // coincidence of an empty bundle.
        expect(code).toContain("browser-branch");

        const result = componentOf(evaluate(code))();
        expect(result).toEqual(EXPECTED_CELL_RESULT);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "refuses an undeclared subpath instead of widening a root decision, and writes no false record",
    async () => {
      const root = await installedProject();
      try {
        await resetProject(root);

        // The package root IS decided, and the package itself publishes `./extra`. The
        // undeclared `./private` file exists on disk beside the published ones — the exact shape
        // an `exports` map exists to hide.
        const rootDecision = await writeDecision(root, "fgc-fixture-sub");
        const recordedRoot = await cli(["record", "--project", root, "--decision", rootDecision]);
        expect(recordedRoot.code, recordedRoot.stderr).toBe(0);
        expect((await readLock(root)).decisions.map(record => record.packageName)).toEqual(["fgc-fixture-sub"]);
        const lockBefore = await readFile(join(root, "fgc.lock.json"), "utf8");
        // The evidence the accepted root decision created, before the refused attempt. A refusal
        // leaves this set unchanged: it must not create evidence for a decision nobody accepted.
        const evidenceBefore = await fileNames(join(root, "fgc-evidence"));

        // The probe itself must fail at the build step: identity resolves (the manifest is the
        // package's), and only the bundler — resolving under the conditions compilation uses —
        // can say the specifier is not published (#89's split, exercised through the CLI here).
        const probed = await cli(["probe", "--project", root, "fgc-fixture-sub/private"]);
        expect(probed.code, probed.stderr).toBe(0);
        const probedReport = json<{
          assessment: { status: string };
          validation: readonly { step: string; outcome: string }[];
          rejectionFindings: readonly { signal: string }[];
        }>(probed);
        expect(probedReport.assessment.status).toBe("supports-rejection-only");
        expect(probedReport.validation.find(step => step.step === "build")?.outcome).toBe("failed");
        expect(probedReport.rejectionFindings.map(finding => finding.signal)).toContain(
          "ssr-or-server-only-without-browser-build",
        );

        // So `record` refuses, and nothing is written: the lock is byte-identical and no evidence
        // file was created for a decision nobody accepted.
        const decision = await writeDecision(root, "fgc-fixture-sub/private");
        const recorded = await cli(["record", "--project", root, "--decision", decision]);
        expect(recorded.code).not.toBe(0);
        expect(recorded.stderr).toMatch(/Refused to record/);
        expect(recorded.stderr).toMatch(/Nothing was written/);
        expect(await readFile(join(root, "fgc.lock.json"), "utf8")).toBe(lockBefore);
        expect(await fileNames(join(root, "fgc-evidence"))).toEqual(evidenceBefore);

        // And the compile side: a root decision does not authorize the unexported subpath. The
        // bundler refuses it even though the package's root decision is in hand.
        const { dependencies } = await decisionsFromLock(root);
        const rejected = await compileDeclaredCell(root, dependencies, { cellId: "unexported" });
        expect(rejected.status).toBe("rejected");
        if (rejected.status !== "rejected") return;
        const summary = diagnosticSummary(rejected);
        expect(summary).toContain("bundler-failure");
        expect(summary).toContain("fgc-fixture-sub/private");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "fails a missing package without writing a record and without touching the project sources",
    async () => {
      const root = await installedProject();
      try {
        await resetProject(root);
        const sourceBefore = await projectSourceSnapshot(root);

        const decision = await writeDecision(root, "fgc-fixture-not-installed-anywhere");
        const recorded = await cli(["record", "--project", root, "--decision", decision]);
        expect(recorded.code).not.toBe(0);
        // The failure names the install graph, which is the one thing absent — not a build
        // failure and not a rejected decision.
        expect(recorded.stderr).toMatch(/Cannot probe "fgc-fixture-not-installed-anywhere"/);
        expect(recorded.stderr).toMatch(/nothing in the install graph resolves to that name/);
        expect(existsSync(join(root, "fgc.lock.json"))).toBe(false);
        expect(existsSync(join(root, "fgc-evidence"))).toBe(false);

        // The commands read the project and its fixtures; they must not write them. `decisions/`
        // is the caller's own file and `.fgc/` is the probe's scratch space, so both are
        // excluded — everything else is byte-identical.
        expect(await projectSourceSnapshot(root)).toEqual(sourceBefore);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    CASE_TIMEOUT_MS,
  );
});
