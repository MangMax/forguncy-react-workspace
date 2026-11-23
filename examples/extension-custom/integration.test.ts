/**
 * One project extension, through every stage that has to agree about it (#87).
 *
 * Decision source: GitHub Issue #87 — "扩展集成：让 Skill、锁文件、本地替代与 MCP 校验消费同一项目映射"
 * (https://github.com/MangMax/forguncy-react-workspace/issues/87), under parent Epic #81.
 *
 * ## What this file is, and what it deliberately is not
 *
 * It runs the **chain** against this example's own committed config and Cell source — no
 * test-only config, no hand-written mapping constant:
 *
 * ```
 * record (Skill CLI)                     → fgc.lock.json + fgc-evidence/
 *   status (Skill CLI)                   → the record's freshness, by cellTarget
 *     dev substitute / real-runtime-only → the module the dev server would serve
 *       compileCell                      → the artifact, its frontendLibraries, its global
 *         planCellSync / executeCellSync → the recorded-port sync's gate
 * ```
 *
 * Each hop is *executed*, not asserted about: `record` is a child process writing real files,
 * `compileCell` runs Rolldown, and the sync is driven through a recording port so both the
 * payload it would write and whether it would write it are observable. The measurements are
 * `local` evidence and nothing more — AGENTS.md rules 6–7. A green run here establishes that
 * the stages agree about one mapping set; it does not establish that the extension exists,
 * that a Forguncy page publishes its global, or that a designer accepts the artifact. #88
 * owns that half, and the version/identity axes that only a page can answer are reported
 * rather than claimed.
 *
 * ## Why the cells come in pairs
 *
 * #87's third plan item asks for two Cells where the *same package* is `inline` in one and
 * `extension` in another, with the exact `cellTarget` taking precedence over the `null`
 * fallback. This project therefore declares two: `chartPanel` (whose record is the
 * `cellTarget: null` `extension` one) and `chartPanelInline` (whose record is an `inline`
 * override). The precedence is read off the stages that resolve it — `status` per record and
 * the compiler per Cell — rather than off a re-implementation of `findLockDecision`.
 *
 * ## Fixtures
 *
 * The chart-kit npm package is **not installed in this example**, deliberately (see
 * `package.json`): a compile that reaches `compiled` did so through the project's mapping,
 * and a dev substitution cannot have resolved a package that is not on disk. The two cases
 * that *are* about the npm copy install one in their scratch tree and say why — a substitute
 * that names a package can only be tested against one that resolves, and the
 * `real-runtime-only` guard is only meaningful when the copy is reachable and still unloaded.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { compileCell, createRolldownCellBundler, planCellCompile } from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult, CompileCellOutcome } from "@forguncy-react-workspace/cell-compiler";
import {
  createCellRegistry,
  dependencyDecisionOf,
  findLockDecision,
  loadForguncyConfig,
  parseFgcLockDocument,
  RUNTIME_CONTRACT_TARGET,
} from "@forguncy-react-workspace/core";
import type { DependencyDecision, LockedDependencyDecision } from "@forguncy-react-workspace/core";
import {
  extensionSubstitutionModuleSource,
  extensionSubstitutions,
  ExtensionSubstituteError,
  installedToolchain,
  LOCAL_DEV_UNOBSERVABLE_STALENESS_REASONS,
  projectLocalDecisions,
} from "@forguncy-react-workspace/dev-harness";
import type { ExtensionSubstitution } from "@forguncy-react-workspace/dev-harness";
import { extensionCatalogOfNormalized, readFgcLock, resolveInstalledVersions } from "@forguncy-react-workspace/dependency-resolver/local";
import {
  executeCellSync,
  planCellSync,
} from "@forguncy-react-workspace/mcp-sync";
import type { ForguncySyncPort } from "@forguncy-react-workspace/mcp-sync";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..");
const CLI = join(
  REPOSITORY_ROOT,
  ".agents",
  "skills",
  "forguncy-react-dependency-selection",
  "scripts",
  "select_dependency.mjs",
);

/** The extension this example maps, as the committed config states it. */
const CHART_KIT = {
  packageName: "@example/chart-kit",
  libraryId: "example-chart-kit",
  globalName: "ExampleChartKit",
} as const;

/** The two Cells this file runs the chain over. */
const EXTENSION_CELL = "chartPanel";
const INLINE_CELL = "chartPanelInline";

/** A real Rolldown compile and a real `record` probe; the probe builds the package. */
const CASE_TIMEOUT_MS = 180_000;

/** The scratch roots this file created, removed once at the end. */
const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The `extensions` block the scratch project commits, byte-identical to this example's row.
 *
 * Written as a source string rather than copied from the committed file because the two Cells
 * are added beside it — the config *shape* is the same and its single mapping row is the same
 * row, which is what makes a `record` here an exercise of the committed example's mapping.
 */
const EXTENSIONS_BLOCK = [
  "  extensions: {",
  "    mappings: [",
  "      {",
  `        packageName: ${JSON.stringify(CHART_KIT.packageName)},`,
  `        libraryId: ${JSON.stringify(CHART_KIT.libraryId)},`,
  `        globalName: ${JSON.stringify(CHART_KIT.globalName)},`,
  '        metadataSource: "verified-catalog",',
  '        metadataReference: "MangMax/forguncy-react-library#example-chart-kit",',
  '        verificationRule: "The catalog indexes the vendor modules the extension contains behind one global. #88 confirms this id and global against `api.app.listFrontendLibraries` on a real project.",',
  '        verifiedBy: ["product-documentation"],',
  '        note: "A project row, not a repository row: the built-in table is unchanged.",',
  "      },",
  "    ],",
  "  },",
].join("\n");

/**
 * A scratch project carrying this example's config row and Cell source.
 *
 * Created rather than run in place because every stage of the chain *writes* — `record` writes
 * `fgc.lock.json` and `fgc-evidence/` — and a test that dirtied a committed example would be a
 * test that has to be undone. The root lives under the example's git-ignored `.fgc/`, which is
 * also what makes its ancestor walk find this workspace's installed packages.
 *
 * ## Why the npm copy is a *parameter* rather than an option
 *
 * `record` probes the package (`resolvePackageIdentity`), so a chain that cannot install it
 * cannot record it — measured, on the first version of this file, which left it out and got
 * "Cannot probe … nothing in the install graph resolves to that name" from every case.
 *
 * The copy is installed for *every* case, and the compile assertions do not become weaker for
 * it: `planCellCompile` hands the compile the project's normalized mappings, and the constructor
 * intercepts the specifier before node resolution runs. So an artifact that reads
 * `globalThis[<globalName>]` and declares one library reference is still evidence that the row
 * answered the import — an npm copy in the tree is what the mapping is *protecting the artifact
 * from*, and its marker reappearing would be the failure.
 */
function scratchProject(name: string): string {
  mkdirSync(join(HERE, ".fgc"), { recursive: true });
  const root = mkdtempSync(join(HERE, ".fgc", `${name}-`));
  scratchRoots.push(root);

  writeFileSync(
    join(root, "forguncy.config.ts"),
    [
      'import { defineForguncyConfig } from "@forguncy-react-workspace/core";',
      "",
      "export default defineForguncyConfig({",
      '  runtime: { forguncyVersion: "12.0.100", projectAlias: "extension-custom-e2e" },',
      EXTENSIONS_BLOCK,
      "  cells: {",
      `    ${EXTENSION_CELL}: { entry: "./src/App.tsx", target: { pageName: "销售看板", cell: "B2" } },`,
      `    ${INLINE_CELL}: { entry: "./src/Inline.tsx", target: { pageName: "销售看板", cell: "C3" } },`,
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  mkdirSync(join(root, "src"), { recursive: true });
  // The committed authored source, byte for byte: the chain's point is that it is untouched
  // ordinary React that imports the package by name.
  writeFileSync(join(root, "src", "App.tsx"), readFileSync(join(HERE, "src", "App.tsx")), "utf8");
  // The second Cell imports the *same package* and reads a member only the npm copy exports, so
  // a substitution or mapping leaking into this Cell's resolution would show in its artifact.
  writeFileSync(
    join(root, "src", "Inline.tsx"),
    [
      'import { CHAR_KIT_NPM_MARKER } from "@example/chart-kit";',
      "",
      "export function App() {",
      "  return <i>{CHAR_KIT_NPM_MARKER}</i>;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  // The copy `record` probes and the two negative cases are about. `CHAR_KIT_NPM_COPY_MARKER`
  // exists only here, which is what makes "the npm copy did not reach the artifact" checkable.
  installPackage(
    root,
    CHART_KIT.packageName,
    "1.0.0",
    [
      'export const CHAR_KIT_NPM_MARKER = "CHART_KIT_NPM_COPY_MARKER";',
      'export function createChart() { return "npm-chart"; }',
      'export function renderChart() { return "npm-rendered"; }',
      "",
    ].join("\n"),
  );

  return root;
}

/**
 * A self-contained scratch project outside the monorepo, with its own pnpm install layout.
 *
 * `scratchProject` above lives under `HERE/.fgc/` so `compileCell` can walk up to the workspace's
 * installed React, which means its hand-crafted `node_modules/@example/chart-kit` sits beneath the
 * repository's `pnpm-lock.yaml` without belonging to it. #94's attribution check rightly reports
 * that layout as `install-graph-unknown`. For the local-projection boundary test — which exercises
 * `record` → `projectLocalDecisions` without compiling a Cell — creating the project under
 * `os.tmpdir()` with its own `pnpm-lock.yaml`, `.modules.yaml` and `.pnpm` store gives the install
 * graph a single, valid root so only the genuinely unobservable axes remain on `unobservableEvidence`.
 */
function standaloneScratchProject(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `extension-custom-${name}-`));
  scratchRoots.push(root);

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: `extension-custom-${name}`, private: true, type: "module" }, null, 2),
    "utf8",
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

  const nodeModules = join(root, "node_modules");
  mkdirSync(join(nodeModules, ".pnpm", "probe-package@1.0.0", "node_modules", "probe-package"), {
    recursive: true,
  });
  writeFileSync(
    join(nodeModules, ".pnpm", "probe-package@1.0.0", "node_modules", "probe-package", "package.json"),
    JSON.stringify({ name: "probe-package", version: "1.0.0" }),
    "utf8",
  );
  mkdirSync(join(nodeModules, ".pnpm", "node_modules"), { recursive: true });
  writeFileSync(
    join(nodeModules, ".modules.yaml"),
    [
      "included:",
      "  dependencies: true",
      "  devDependencies: true",
      "  optionalDependencies: true",
      "nodeLinker: isolated",
      "hoistPattern:",
      '  - "*"',
      "publicHoistPattern: []",
      "",
    ].join("\n"),
    "utf8",
  );

  // Plain default export (no workspace import) so `loadForguncyConfig` resolves cleanly outside the
  // monorepo tree while keeping the exact same runtime/extensions/cells document shape.
  writeFileSync(
    join(root, "forguncy.config.ts"),
    [
      "export default {",
      '  runtime: { forguncyVersion: "12.0.100", projectAlias: "extension-custom-e2e" },',
      EXTENSIONS_BLOCK,
      "  cells: {",
      `    ${EXTENSION_CELL}: { entry: "./src/App.tsx", target: { pageName: "销售看板", cell: "B2" } },`,
      `    ${INLINE_CELL}: { entry: "./src/Inline.tsx", target: { pageName: "销售看板", cell: "C3" } },`,
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );

  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "App.tsx"), readFileSync(join(HERE, "src", "App.tsx")), "utf8");
  writeFileSync(
    join(root, "src", "Inline.tsx"),
    [
      'import { CHAR_KIT_NPM_MARKER } from "@example/chart-kit";',
      "",
      "export function App() {",
      "  return <i>{CHAR_KIT_NPM_MARKER}</i>;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  installPackage(
    root,
    CHART_KIT.packageName,
    "1.0.0",
    [
      'export const CHAR_KIT_NPM_MARKER = "CHART_KIT_NPM_COPY_MARKER";',
      'export function createChart() { return "npm-chart"; }',
      'export function renderChart() { return "npm-rendered"; }',
      "",
    ].join("\n"),
  );

  return root;
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the Skill CLI as a child process — the only way to see what it wrote and whether it exited. */
async function cli(args: readonly string[]): Promise<CliResult> {
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

function json<T = Record<string, unknown>>(result: CliResult): T {
  return JSON.parse(result.stdout) as T;
}

/** A decision file, written outside the project's source tree so the probe never scans it. */
function decisionFile(root: string, label: string, contents: Record<string, unknown>): string {
  const path = join(root, `decision-${label}.json`);
  writeFileSync(path, JSON.stringify(contents, null, 2), "utf8");
  return path;
}

/** The `record` decision the chain needs: the full extension claim, with a content identity. */
function extensionDecision(): Record<string, unknown> {
  return {
    packageName: CHART_KIT.packageName,
    role: "cell-local-ui",
    strategy: "extension",
    libraryId: CHART_KIT.libraryId,
    globalName: CHART_KIT.globalName,
    extensionVersion: "1.0.0",
    extensionIdentity: "sha256:chart-kit-fixture",
    rationale:
      "Fixture record for #87's chain: the shared instance the extension would publish is not something a bundled copy can stand in for.",
  };
}

/** The `record` decision for the inline Cell: the same package, decided differently. */
function inlineDecision(): Record<string, unknown> {
  return {
    packageName: CHART_KIT.packageName,
    role: "cell-local-ui",
    strategy: "inline",
    rationale: "This Cell has no shared instance to lose, so it carries its own copy.",
  };
}

/** Records the extension decision, asserting the CLI accepted it. */
async function recordExtensionDecision(root: string): Promise<void> {
  const recorded = await cli([
    "record",
    "--project",
    root,
    "--no-cache",
    "--decision",
    decisionFile(root, "extension", extensionDecision()),
  ]);
  expect(recorded.code, recorded.stderr).toBe(0);
}

/** A package stub in the scratch root, so a `record` probe can resolve and build it. */
function installPackage(root: string, name: string, version: string, source: string): void {
  const segments = name.split("/");
  const pkg = join(root, "node_modules", ...segments);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name, version, type: "module", main: "index.js" }),
    "utf8",
  );
  writeFileSync(join(pkg, "index.js"), source, "utf8");
}

/** The record `record` wrote, by `(packageName, cellTarget)`. */
function lockedRecord(root: string, cellTarget: string | null): LockedDependencyDecision {
  const lock = parseFgcLockDocument(readFileSync(join(root, "fgc.lock.json"), "utf8"));
  const record = findLockDecision(lock, { packageName: CHART_KIT.packageName, cellTarget });
  if (record === null) {
    throw new Error(`No record for ${CHART_KIT.packageName} at cellTarget ${String(cellTarget)}.`);
  }
  return record;
}

/** The compiler-facing decision for one Cell, resolved the way the lock's own reader resolves it. */
function effectiveDecision(root: string, cellTarget: string | null): DependencyDecision {
  return dependencyDecisionOf(lockedRecord(root, cellTarget));
}

/** Compiles one declared Cell through the registry's plan. */
async function compileCellOf(root: string, cellId: string, cellTarget: string | null): Promise<CompileCellOutcome> {
  const registry = await loadForguncyConfig({ root });
  const plan = planCellCompile({
    registry,
    cellId,
    dependencies: [effectiveDecision(root, cellTarget)],
  });
  return compileCell(plan.input, {
    bundler: createRolldownCellBundler({ dir: registry.root }),
    extensionMappings: plan.extensionMappings,
  });
}

/** The artifact of a compile this file requires to have succeeded. */
function compiledArtifact(outcome: CompileCellOutcome, root: string): CompileCellResult {
  expect(outcome.status, `compile of ${root} did not compile: ${JSON.stringify(outcome.status === "rejected" ? outcome.diagnostics : [])}`).toBe("compiled");
  if (outcome.status !== "compiled") {
    throw new Error("unreachable: asserted compiled above");
  }
  return outcome.artifact;
}

/** A listing row the extension's own bundle would produce, for the sync's verification step. */
const CONFIRMED_LISTING = {
  id: CHART_KIT.libraryId,
  name: "Example Chart Kit for ReactCellType",
  globalName: CHART_KIT.globalName,
  exists: true,
  typeDefinitionAvailable: true,
} as const;

// ---------------------------------------------------------------------------
// record → status
// ---------------------------------------------------------------------------

describe("#87 chain, stage 1: the Skill records against the project's own mappings", () => {
  it("records a custom project extension, and `status` reports each Cell's record separately", async () => {
    const root = scratchProject("record-status");

    // Before #87 the CLI's default catalog was `core`'s built-in table, so this exact decision
    // was refused `extension-library-not-verified` in a project whose compiler accepted it. The
    // record only exists if conformance passed against the project's rows.
    await recordExtensionDecision(root);

    const inline = await cli([
      "record",
      "--project",
      root,
      "--cell",
      INLINE_CELL,
      "--no-cache",
      "--decision",
      decisionFile(root, "inline", inlineDecision()),
    ]);
    expect(inline.code, inline.stderr).toBe(0);

    // One package, two records, one of them target-specific — the pair #87 asks for.
    expect(lockedRecord(root, null).strategy).toBe("extension");
    expect(lockedRecord(root, INLINE_CELL).strategy).toBe("inline");

    // `status` reads back the same two records, in the lock's own order, with freshness judged
    // per record — including the two axes no local process can observe.
    const status = await cli(["status", "--project", root]);
    const payload = json<{
      decisions: readonly {
        packageName: string;
        strategy: string;
        cellTarget: string | null;
        freshness: string;
        stalenessReasons: readonly string[];
        realRuntimeValidation: string;
      }[];
    }>(status);

    expect(payload.decisions.map(entry => [entry.cellTarget, entry.strategy])).toEqual([
      [null, "extension"],
      [INLINE_CELL, "inline"],
    ]);

    const extensionStatus = payload.decisions.find(entry => entry.cellTarget === null)!;
    expect(extensionStatus.freshness).toBe("stale");
    // Reported, not hidden: an extension's version and identity come from a page, which is
    // what #88 supplies. "fresh" here would be the compatibility claim #87 forbids.
    expect(extensionStatus.stalenessReasons).toEqual(
      expect.arrayContaining(["extension-version-unknown", "extension-identity-unknown"]),
    );
    expect(extensionStatus.realRuntimeValidation).toBe("not-validated");
  }, CASE_TIMEOUT_MS);

  it("refuses an extension this project does not map, keeping the config as the fix owner", async () => {
    // The negative half of stage 1: the catalog is the project's set, so a package it does not
    // map is refused — which is what keeps "reads the project's mappings" from meaning
    // "accepts anything". The package itself is installed, so the refusal can only be about the
    // *declaration*: a probe failure would be a different reason and is not what is asserted.
    const root = scratchProject("record-undeclared");
    installPackage(root, "@example/undeclared-kit", "1.0.0", "export function chart() { return null; }\n");

    const recorded = await cli([
      "record",
      "--project",
      root,
      "--no-cache",
      "--decision",
      decisionFile(root, "undeclared", {
        ...extensionDecision(),
        packageName: "@example/undeclared-kit",
        libraryId: "example-undeclared-kit",
        globalName: "ExampleUndeclaredKit",
      }),
    ]);

    expect(recorded.code).not.toBe(0);
    // The CLI reports refusals two ways: a JSON `problems` array for the acceptance checks, and
    // a stderr line for an input it could not read. Both are asserted on, because "refused" is
    // only useful if the reader is told which document to edit.
    const reported = `${recorded.stdout}\n${recorded.stderr}`;
    expect(reported).toContain("extension-library-not-verified");
    expect(existsSync(join(root, "fgc.lock.json"))).toBe(false);
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// record → dev substitute / real-runtime-only
// ---------------------------------------------------------------------------

/** The substitutions the plugin would build for a mounted Cell, through the same three inputs. */
async function harnessSubstitutions(root: string, choices: readonly LocalDevExtensionChoice[]): Promise<readonly ExtensionSubstitution[]> {
  const registry = await loadForguncyConfig({ root });
  // The plugin passes the audit's answer here; with no decisions to mismatch, `[]` is that
  // answer, and the parameter is required so a caller cannot wire from choices alone.
  return extensionSubstitutions(choices, registry.root, [], registry.extensionMappings.mappings);
}

describe("#87 chain, stage 2: the dev harness resolves the same package from the same rows", () => {
  it("accepts a choice for a package only the project maps, and names the npm copy it stands in", async () => {
    // The substitution that used to throw: `extensionSubstitutions` looked the package up in
    // `core`'s built-in table, which does not carry `@example/chart-kit`, so a project row the
    // compiler resolves was "not interceptable" to the dev server. The fixture installs the
    // substitute so the target is a real directory rather than the unavailable branch.
    const root = scratchProject("dev-substitute");
    await recordExtensionDecision(root);

    const substitutions = await harnessSubstitutions(root, [
      {
        packageName: CHART_KIT.packageName,
        mode: "substitute",
        kind: "npm-package",
        resolvesTo: CHART_KIT.packageName,
        justification: "The extension's identity is the page's; locally any implementation exercises the Cell's UI.",
      },
    ]);

    expect(substitutions.map(substitution => substitution.moduleId)).toEqual([CHART_KIT.packageName]);
    expect(substitutions[0]?.target.kind).toBe("package");
  }, CASE_TIMEOUT_MS);

  it("never resolves a `real-runtime-only` package to an npm copy, even when one is installed", async () => {
    // #87's third acceptance criterion. The npm copy is installed *on purpose*: without it the
    // assertion would pass for a harness that could simply not find one.
    const root = scratchProject("dev-real-runtime");
    await recordExtensionDecision(root);

    const [substitution] = await harnessSubstitutions(root, [
      {
        packageName: CHART_KIT.packageName,
        mode: "real-runtime-only",
        reason: "The extension publishes one global per page, and no npm copy reproduces that.",
        consequence: "Nothing local exercises the shared global.",
      },
    ]);

    expect(substitution, "the choice must produce a substitution, not be dropped").toBeDefined();
    expect(substitution!.target.kind).toBe("unavailable");
    if (substitution!.target.kind !== "unavailable") {
      throw new Error("unreachable: asserted unavailable above");
    }
    expect(substitution!.target.reason).toContain("real-runtime validation");

    // The generated module is what the browser gets, and it throws rather than re-exporting.
    const source = extensionSubstitutionModuleSource(substitution!);
    expect(source).toContain("throw new Error");
    expect(source).not.toContain("export * from");
  }, CASE_TIMEOUT_MS);

  it("refuses a substitute that was never installed, instead of resolving the original package", async () => {
    // The undeclared-substitute case #87's fifth plan item names: the project row exists, the
    // choice names a package that does not. The function reports it as an `unavailable` target
    // whose text says which of the three fixes applies — never a silent fallback to npm.
    const root = scratchProject("dev-undeclared-substitute");
    await recordExtensionDecision(root);

    const [substitution] = await harnessSubstitutions(root, [
      {
        packageName: CHART_KIT.packageName,
        mode: "substitute",
        kind: "npm-package",
        resolvesTo: "@example/not-installed-substitute",
        justification: "names a package nobody installed",
      },
    ]);

    expect(substitution!.target.kind).toBe("unavailable");
    if (substitution!.target.kind !== "unavailable") {
      throw new Error("unreachable: asserted unavailable above");
    }
    expect(substitution!.target.reason).toContain("not installed in the project's own tree");
  }, CASE_TIMEOUT_MS);

  it("does not apply a stale choice, even though the project still maps the package", async () => {
    // A choice is the local half of a dependency *decision*. When the lock moves the package to
    // another strategy — here, an `inline` record replaces the `extension` one — the choice
    // describes a decision that no longer exists. The audit reports it
    // (`local-dev-extension-choice-unmatched`) and `extensionSubstitutions` drops it before any
    // id is claimed, because applying it would serve a substitute while the compiler bundles
    // the real package — the dev/compiler drift this layer exists to prevent.
    //
    // The unmatched list is passed explicitly rather than recomputed: the plugin hands it
    // `unmatchedExtensionChoicePackages(audit)`, and the required parameter is what makes a
    // caller unable to wire from choices alone.
    const root = scratchProject("dev-stale-choice");
    await recordExtensionDecision(root);
    const registry = await loadForguncyConfig({ root });

    const substitutions = extensionSubstitutions(
      [
        {
          packageName: CHART_KIT.packageName,
          mode: "substitute",
          kind: "npm-package",
          resolvesTo: CHART_KIT.packageName,
          justification: "describes a decision the lock has since replaced",
        },
      ],
      registry.root,
      [CHART_KIT.packageName],
      registry.extensionMappings.mappings,
    );

    expect(substitutions).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("refuses a choice for a package no mapping row intercepts, loudly, at startup", async () => {
    // The other "loud" branch: the project declares *no* row for the package, so there is no
    // extension for a substitute to stand in. Thrown rather than skipped, because skipping
    // would leave the id resolving through npm — the outcome the choice exists to prevent.
    const root = scratchProject("dev-unmapped-choice");
    let refusal: unknown;
    try {
      await harnessSubstitutions(root, [
        {
          packageName: "@example/unmapped-kit",
          mode: "substitute",
          kind: "npm-package",
          resolvesTo: "@example/unmapped-kit",
          justification: "no row declares this package",
        },
      ]);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(ExtensionSubstituteError);
    expect(String((refusal as Error).message)).toContain("extensions.mappings");
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// record → compileCell
// ---------------------------------------------------------------------------

describe("#87 chain, stage 3: the two Cells compile from their own decisions", () => {
  it("compiles the extension Cell from the page global and the inline Cell from its own import", async () => {
    const root = scratchProject("compile-pair");
    await recordExtensionDecision(root);
    const inline = await cli([
      "record",
      "--project",
      root,
      "--cell",
      INLINE_CELL,
      "--no-cache",
      "--decision",
      decisionFile(root, "inline", inlineDecision()),
    ]);
    expect(inline.code, inline.stderr).toBe(0);

    // The extension Cell: `@example/chart-kit` is not installed anywhere the bundler can reach,
    // so reaching `compiled` proves the project row answered the import.
    const extensionArtifact = compiledArtifact(await compileCellOf(root, EXTENSION_CELL, null), root);
    expect(extensionArtifact.frontendLibraries).toEqual([{ libraryId: CHART_KIT.libraryId }]);
    expect(extensionArtifact.code).toContain(`globalThis[${JSON.stringify(CHART_KIT.globalName)}]`);

    // The inline Cell: the same package, no library reference and no global — the exact
    // `cellTarget` record taking precedence over the `null` fallback, observed at the compiler.
    const inlineArtifact = compiledArtifact(await compileCellOf(root, INLINE_CELL, INLINE_CELL), root);
    expect(inlineArtifact.frontendLibraries).toEqual([]);
    expect(inlineArtifact.code).not.toContain(CHART_KIT.globalName);
  }, CASE_TIMEOUT_MS);

  it("keeps the extension record and names the axes no local process can check", async () => {
    // #87's sixth plan item, asserted rather than left to a docstring: the projection *keeps*
    // the extension decision — withholding it would let the Cell resolve through npm — and
    // reports what it could not observe instead of claiming a pass.
    const root = standaloneScratchProject("projection-boundary");
    await recordExtensionDecision(root);

    const registry = await loadForguncyConfig({ root });
    const { versions } = await resolveInstalledVersions(root, [CHART_KIT.packageName]);
    const projection = projectLocalDecisions({
      lock: await readFgcLock(root),
      cellTarget: null,
      // What this process can truthfully observe: the installed version, the toolchain it runs
      // on and the contract it measured. The three axes only a page can answer stay **absent**,
      // which the projection reports as unknown rather than invents.
      resolvedVersions: versions,
      target: RUNTIME_CONTRACT_TARGET,
      toolchain: await installedToolchain(root),
      extensionCatalog: extensionCatalogOfNormalized(registry.extensionMappings),
    });

    expect(projection.conformanceErrors).toEqual([]);
    expect(projection.withheld).toEqual([]);
    expect(projection.decisions.map(decision => decision.packageName)).toEqual([CHART_KIT.packageName]);
    expect(projection.unobservableEvidence.map(entry => entry.packageName)).toEqual([CHART_KIT.packageName]);
    // The axis list is the report's own vocabulary, and every reason on it has to be one this
    // process could not have evaluated — otherwise the record would belong in `withheld`.
    expect(
      projection.unobservableEvidence[0]?.stalenessReasons.every(reason =>
        LOCAL_DEV_UNOBSERVABLE_STALENESS_REASONS.includes(reason),
      ),
    ).toBe(true);
    expect(projection.unobservableEvidence[0]?.stalenessReasons).toEqual(
      expect.arrayContaining(["extension-version-unknown", "extension-identity-unknown"]),
    );
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// record → recorded-port sync
// ---------------------------------------------------------------------------

/** A port that answers from a real listing and records every write it is handed. */
function recordingPort(listings: readonly { readonly id: string; readonly globalName: string }[]) {
  const written: unknown[] = [];

  const port: ForguncySyncPort = {
    listFrontendLibraries: async () => listings,
    readCellSource: async () => ({ kind: "blank" }),
    setCells: async request => {
      written.push(request);
    },
    getProjectSaveStatus: async () => ({ containsUnsavedChanges: false }),
    saveProject: async () => ({ saved: true }),
    checkProjectErrors: async () => ({ errorCount: 0 }),
    generatePageAsync: async request => ({
      pageName: request.pageName,
      pageUrl: `http://localhost/Forguncy/${request.pageName}`,
    }),
  };

  return { port, written };
}

/** The registry a sync resolves its target *and* its mapping set from, built from the config. */
function registryOf(root: string) {
  return createCellRegistry(
    {
      runtime: { forguncyVersion: "12.0.100", projectAlias: "extension-custom-e2e" },
      extensions: {
        mappings: [
          {
            packageName: CHART_KIT.packageName,
            libraryId: CHART_KIT.libraryId,
            globalName: CHART_KIT.globalName,
            metadataSource: "verified-catalog",
            metadataReference: "MangMax/forguncy-react-library#example-chart-kit",
            verificationRule: "fixture",
            verifiedBy: ["product-documentation"],
            note: "project row",
          },
        ],
      },
      cells: { [EXTENSION_CELL]: { entry: "./src/App.tsx", target: { pageName: "销售看板", cell: "B2" } } },
    },
    { root, requireEntryFiles: false },
  );
}

describe("#87 chain, stage 4: the sync verifies the artifact against the project's mappings", () => {
  it("plans and writes the extension Cell, carrying the project row's library reference", async () => {
    const root = scratchProject("sync-write");
    await recordExtensionDecision(root);
    const artifact = compiledArtifact(await compileCellOf(root, EXTENSION_CELL, null), root);
    const decision = effectiveDecision(root, null);

    const plan = planCellSync({
      target: { pageName: "销售看板", cell: "B2" },
      artifact,
      decisions: [decision],
      deployed: { kind: "read", code: "" },
      listings: [CONFIRMED_LISTING],
      // What `planCellSyncTargets` supplies automatically from the registry; passed explicitly
      // here because this describe calls the planner directly, which is the path that has no
      // registry to read it from.
      mappings: registryOf(root).extensionMappings.mappings,
    });

    expect(plan.extensionVerification.references).toEqual([CHART_KIT.libraryId]);
    expect(plan.extensionVerification.expected).toEqual([CHART_KIT.libraryId]);
    expect(plan.extensionVerification.verification).toBe("stated");
    expect(plan.extensionVerification.diagnostics).toEqual([]);
    expect(plan.gate).toBe("ready");

    const { port, written } = recordingPort([CONFIRMED_LISTING]);
    const run = await executeCellSync({
      target: { pageName: "销售看板", cell: "B2" },
      artifact,
      decisions: [decision],
      port,
      mappings: registryOf(root).extensionMappings.mappings,
    });
    expect(run.status).toBe("written");
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written[0])).toContain(CHART_KIT.libraryId);
  }, CASE_TIMEOUT_MS);

  it("refuses the write when the same artifact is audited against core's table instead", async () => {
    // The sync-side half of #87's defect, kept as a positive statement of what the fix prevents:
    // with no project mappings, the project's row is invisible, the artifact's reference is
    // `unbacked`, and the gate refuses *before* the mutation. That is why
    // `planCellSyncTargets`/`executeCellSyncTargets` default to the registry's rows.
    const root = scratchProject("sync-core-fallback");
    await recordExtensionDecision(root);
    const artifact = compiledArtifact(await compileCellOf(root, EXTENSION_CELL, null), root);

    const { port, written } = recordingPort([CONFIRMED_LISTING]);
    const run = await executeCellSync({
      target: { pageName: "销售看板", cell: "B2" },
      artifact,
      decisions: [effectiveDecision(root, null)],
      port,
      // Deliberately omitted: `core`'s table, which carries no row for this package.
    });

    expect(run.status).toBe("refused");
    expect(written).toHaveLength(0);
    // The project's row is what binds the decision; without it `planExtensionExternals`
    // cannot map the `extension` decision to an interception at all, which is the finding
    // whose fix owner is the dependency decision. The library *reference* comparison still
    // agrees — both sides derive from the decision — so this is the code that refuses.
    expect(run.diagnostics.map(diagnostic => diagnostic.code)).toContain("extension-decision-unusable");
  }, CASE_TIMEOUT_MS);

  it("refuses a missing or invalid real library list before writing, and keeps the divergence guard", async () => {
    // #87's fourth and fifth acceptance criteria together, on one fixture: an empty listing
    // refuses the write, and — separately — a designer-edited target is still refused even
    // when the extensions verify. "Keeping conflict protection" is not about the extension gate.
    const root = scratchProject("sync-refused");
    await recordExtensionDecision(root);
    const artifact = compiledArtifact(await compileCellOf(root, EXTENSION_CELL, null), root);
    const mappings = registryOf(root).extensionMappings.mappings;

    // (a) The listing is empty — a *stated* answer that the project has no such library — so
    // #12's metadata audit reports the identity as unverified and nothing is written. (An
    // omitted listing would be `unstated` instead, and is likewise a refusal; this fixture
    // exercises the state a real `listFrontendLibraries` can actually return.)
    const unverified = recordingPort([]);
    const unverifiedRun = await executeCellSync({
      target: { pageName: "销售看板", cell: "B2" },
      artifact,
      decisions: [effectiveDecision(root, null)],
      port: unverified.port,
      mappings,
    });
    expect(unverifiedRun.status).toBe("refused");
    expect(unverified.written).toHaveLength(0);
    // Reported through `planExtensionExternals`' metadata axis rather than as a bare
    // reference mismatch: an empty listing is a *statement* that the project has no
    // extensions, so #12's own audit reports the identity as unverified, which the sync
    // translates to the code whose fix owner is the extension package.
    expect(unverifiedRun.diagnostics.map(diagnostic => diagnostic.code)).toContain("missing-extension");

    // (b) A valid listing, but the target already holds something this flow did not write.
    const diverged = recordingPort([CONFIRMED_LISTING]);
    const divergedPort: ForguncySyncPort = {
      ...diverged.port,
      readCellSource: async () => ({ kind: "occupied", code: "a designer's own cell content" }),
    };
    const divergedRun = await executeCellSync({
      target: { pageName: "销售看板", cell: "B2" },
      artifact,
      decisions: [effectiveDecision(root, null)],
      port: divergedPort,
      mappings,
    });
    expect(divergedRun.status).toBe("refused");
    expect(diverged.written).toHaveLength(0);
    expect(divergedRun.diagnostics.map(diagnostic => diagnostic.code)).toContain("cell-diverged");
    expect(divergedRun.plan.extensionVerification.diagnostics).toEqual([]);
  }, CASE_TIMEOUT_MS);
});
