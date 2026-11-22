/**
 * The project's own extension mappings, end to end (#86).
 *
 * Decision source: GitHub Issue #86 — "扩展编译：将项目 mappings 贯通预扫描、Rolldown
 * 拦截和产物元数据"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/86), under parent Epic #81.
 *
 * #85 built the config input and its one normalization (`core`'s
 * `normalizeExtensionMappings`); this file is the half that proves the compiler *uses*
 * it. The chain asserted here is the whole wiring path, not a hand-written shortcut:
 *
 *   forguncy.config.ts → `loadForguncyConfig` → `registry.extensionMappings`
 *     → `planCellCompile` → `compileCell({ extensionMappings })`
 *       → `CellResolveRequest` / `CellBundlingRequest`
 *         → `createInterceptionResolver` → `planExtensionExternals({ mappings })`
 *
 * Everything below runs against the table that chain produced. No test here edits
 * `core`'s `EXTENSION_EXTERNAL_MAPPINGS`, and none of the custom packages is installed
 * under the repository — so a compile that succeeds did so by interposing the mapping's
 * generated module, never by finding an npm implementation by ordinary resolution.
 *
 * What a green compile here is *not* evidence for, per AGENTS.md rules 6–7: the
 * extension exists, the page publishes its global, or a real Forguncy runtime accepts
 * the result. The identity used is the `examples/extension-custom` placeholder #85 wrote
 * for this path; #88 is where it is confirmed against a real `listFrontendLibraries`
 * listing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dirname as pathDirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";

import {
  createCellRegistry,
  EXTENSION_EXTERNAL_MAPPINGS,
  ForguncyConfigError,
  loadForguncyConfig,
  normalizeExtensionMappings,
} from "@forguncy-react-workspace/core";
import type {
  DependencyDecision,
  ExtensionExternalMapping,
  NormalizedExtensionMappings,
} from "@forguncy-react-workspace/core";
import { afterAll, describe, expect, it } from "vitest";

import { compileCell } from "./artifact.ts";
import type { CompileCellOutcome } from "./artifact.ts";
import { CELL_ENTRY_COMPONENT_BINDING } from "./entry.ts";
import { createRolldownCellBundler } from "./rolldown-bundler.ts";
import { planCellCompile } from "./registry-plan.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const here = pathDirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..", "..", "..");
const extensionCustomExampleRoot = join(repositoryRoot, "examples", "extension-custom");

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "forguncy-extension-mappings-"));

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/** One fixture directory per test; files are written relative to it. */
function fixture(name: string, files: Readonly<Record<string, string>>): string {
  const dir = path.join(fixtureRoot, name);
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return dir;
}

// The custom extension's identity, copied from `examples/extension-custom`'s committed
// config rather than invented here. It is intentionally *not* in `core`'s table.
const CHART_KIT = {
  packageName: "@example/chart-kit",
  libraryId: "example-chart-kit",
  globalName: "ExampleChartKit",
} as const;

const CHART_KIT_DECISION: DependencyDecision = {
  strategy: "extension",
  packageName: CHART_KIT.packageName,
  libraryId: CHART_KIT.libraryId,
  globalName: CHART_KIT.globalName,
};

/**
 * A project row as a committed config would state it, in the shape #85's reader
 * accepts. `moduleIds` is the sibling-package half: one row can stand in for more
 * than one npm import, and all of them share one `libraryId`.
 */
function projectRow(
  overrides: Partial<ExtensionExternalMapping> & Pick<ExtensionExternalMapping, "packageName" | "libraryId" | "globalName">,
): Record<string, unknown> {
  return {
    metadataSource: "verified-catalog",
    metadataReference: "MangMax/forguncy-react-library",
    verificationRule: "A verified catalog entry whose id and global the listing confirms.",
    verifiedBy: ["product-documentation"],
    note: "a project row, which the built-in table does not carry",
    ...overrides,
  };
}

/** A project config whose only rows are the given ones (built-ins still merge in). */
function configWithRows(rows: readonly Record<string, unknown>[]): unknown {
  return { cells: {}, extensions: { mappings: rows } };
}

/** #85's normalized set for a project config, or a failure that prints the diagnostics. */
function normalizedOrThrow(config: unknown): NormalizedExtensionMappings {
  const result = normalizeExtensionMappings(config);
  if (!result.ok) {
    throw new Error(
      `Expected this config to normalize:\n${result.diagnostics
        .map(diagnostic => `${diagnostic.path}: [${diagnostic.code}] ${diagnostic.message}`)
        .join("\n")}`,
    );
  }
  return result.mappings;
}

/** The normalized set for the custom chart-kit row alone. */
function chartKitMappings(): NormalizedExtensionMappings {
  return normalizedOrThrow(
    configWithRows([
      projectRow({
        packageName: CHART_KIT.packageName,
        libraryId: CHART_KIT.libraryId,
        globalName: CHART_KIT.globalName,
      }),
    ]),
  );
}

async function compile(
  dir: string,
  entry: string,
  mappings: NormalizedExtensionMappings | undefined,
  dependencies: readonly DependencyDecision[],
  options: { readonly workspace?: { readonly packages: readonly [] } } = {},
): Promise<CompileCellOutcome> {
  return compileCell(
    { entry, dependencies },
    {
      bundler: createRolldownCellBundler({ dir }),
      ...(mappings === undefined ? {} : { extensionMappings: mappings }),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    },
  );
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/** The page's React, reduced to what the fixtures touch. */
function reactStub(): Record<string, unknown> {
  return {
    version: "19.2.7",
    Fragment: Symbol.for("react.fragment"),
    createElement: (type: unknown, props: Record<string, unknown> | null) => ({ type, props: props ?? {} }),
    useState: (initial: unknown) => [initial, () => undefined],
  };
}

/** The object a page that loaded the custom extension would publish. */
function chartKitFacade(): Record<string, unknown> {
  return {
    createChart: () => "chart",
    renderChart: () => "rendered",
  };
}

function runArtifact(code: string, globals: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const sandbox: Record<string, unknown> = { ...globals };
  sandbox.globalThis = sandbox;
  new Script(code, { filename: "cell-artifact.js" }).runInContext(createContext(sandbox));
  return sandbox;
}

interface Rendered {
  readonly type: unknown;
  readonly props: { readonly children?: unknown };
}

function componentFrom(sandbox: Readonly<Record<string, unknown>>): () => Rendered {
  const component = sandbox[CELL_ENTRY_COMPONENT_BINDING];
  if (typeof component !== "function") {
    throw new Error(`The artifact did not bind a function to ${CELL_ENTRY_COMPONENT_BINDING}.`);
  }
  return component as () => Rendered;
}

/** The text an element's single `children` value carries, for the self-check entries. */
function textOf(element: Rendered): string {
  return typeof element.props.children === "string" ? element.props.children : JSON.stringify(element.props.children);
}

/** Every string a (stubbed) element tree carries, depth-first, for nested fixtures. */
function renderedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(renderedText).join("");
  if (typeof value === "object" && value !== null && "props" in value) {
    const props = (value as Rendered).props as { readonly children?: unknown };
    return renderedText(props.children);
  }
  return "";
}

function codesOf(outcome: CompileCellOutcome): readonly string[] {
  return outcome.status === "rejected" ? outcome.diagnostics.map(diagnostic => diagnostic.code) : [];
}

// ---------------------------------------------------------------------------
// The committed example, through the registry seam
// ---------------------------------------------------------------------------

describe("`examples/extension-custom` compiles from its committed config (#86)", () => {
  it("carries the registry's normalized set on the compile plan", async () => {
    // The wiring path's first hop. `planCellCompile` must hand over the *registry's*
    // object rather than re-derive one, or the compile would plan against a table the
    // config loader never validated.
    const registry = await loadForguncyConfig({ root: extensionCustomExampleRoot });
    const plan = planCellCompile({ registry, cellId: "chartPanel", dependencies: [CHART_KIT_DECISION] });

    expect(plan.extensionMappings).toBe(registry.extensionMappings);
    expect(plan.extensionMappings.source).toBe("project-extended");
    expect(plan.extensionMappings.projectMappings.map(row => row.packageName)).toEqual([CHART_KIT.packageName]);
  });

  it("compiles the example's authored import from the page global, with one library reference", async () => {
    // The acceptance criterion end to end: a non-built-in extension, declared only by a
    // project config, compiles with `core`'s table untouched. `@example/chart-kit` is not
    // installed anywhere the bundler can reach, so reaching `compiled` proves the hook
    // answered it before node resolution ran.
    const registry = await loadForguncyConfig({ root: extensionCustomExampleRoot });
    const plan = planCellCompile({ registry, cellId: "chartPanel", dependencies: [CHART_KIT_DECISION] });
    const outcome = await compileCell(plan.input, {
      bundler: createRolldownCellBundler({ dir: registry.root }),
      extensionMappings: plan.extensionMappings,
    });

    expect(EXTENSION_EXTERNAL_MAPPINGS.map(row => row.packageName)).not.toContain(CHART_KIT.packageName);

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    expect(outcome.artifact.frontendLibraries).toEqual([{ libraryId: CHART_KIT.libraryId }]);
    // The generated module is what replaced the npm import: it names the mapped global
    // and reads it while its own body runs.
    expect(outcome.artifact.code).toContain(`globalThis["${CHART_KIT.globalName}"]`);

    const sandbox = runArtifact(outcome.artifact.code, {
      React: reactStub(),
      [CHART_KIT.globalName]: chartKitFacade(),
    });
    const element = componentFrom(sandbox)();
    // The example's self-check lives in a nested `<output>`; the fixture wrote its
    // markup so a compile that bound the wrong global renders `imports=fail`.
    expect(element.type).toBe("section");
    expect(renderedText(element)).toContain("imports=pass");
  });
});

// ---------------------------------------------------------------------------
// One table for the preflight and the build
// ---------------------------------------------------------------------------

const NAMED_CHART_KIT_ENTRY = `import { createChart, renderChart } from "@example/chart-kit";

export function App() {
  return <i>{\`\${typeof createChart}|\${typeof renderChart}\`}</i>;
}
`;

describe("the preflight and the build consult one mapping table (#86)", () => {
  it("resolves the same specifiers in both passes, and refuses without the set", async () => {
    // The preflight's claim is that it audits what the build resolves. Both passes are
    // handed the same request shape here; the custom import is uninstalled, so a pass
    // that fell back to `core`'s table could not resolve it at all. Equality of the
    // reported specifier sets is the observable form of "same module identity".
    const dir = fixture("preflight-build", { "App.jsx": NAMED_CHART_KIT_ENTRY });
    const mappings = chartKitMappings();
    const port = createRolldownCellBundler({ dir });

    const prescan = await port.resolveEntrySpecifiers?.({
      entry: "App.jsx",
      dependencies: [CHART_KIT_DECISION],
      extensionMappings: mappings,
    });
    const bundled = await port.bundle({
      entry: "App.jsx",
      dependencies: [CHART_KIT_DECISION],
      componentBinding: CELL_ENTRY_COMPONENT_BINDING,
      extensionMappings: mappings,
    });

    expect(prescan).toContain(CHART_KIT.packageName);
    expect(bundled.referencedSpecifiers).toContain(CHART_KIT.packageName);
    expect(prescan).toEqual([...(bundled.referencedSpecifiers ?? [])].sort());

    // Through `compileCell`, with a workspace graph so the pre-bundle pass actually
    // runs: compiled means the preflight resolved the custom import with the same
    // table the build uses.
    const withMapping = await compile(dir, "App.jsx", mappings, [CHART_KIT_DECISION], {
      workspace: { packages: [] },
    });
    expect(withMapping.status).toBe("compiled");

    // Without the project's set, the same compile must fail. It does not silently
    // become an inline of the package: the import is left external and the artifact
    // audit reports the extension decision with no usable mapping. (The preflight
    // itself treats an unresolved bare import as external rather than fatal, which is
    // why the rejection code is the artifact's, not `bundler-failure` — either answer
    // is loud, and neither accepts the artifact.)
    const withoutMapping = await compile(dir, "App.jsx", undefined, [CHART_KIT_DECISION], {
      workspace: { packages: [] },
    });
    expect(withoutMapping.status).toBe("rejected");
    expect(codesOf(withoutMapping)).toContain("missing-extension-mapping");
  });
});

// ---------------------------------------------------------------------------
// Import shapes through the real bundler
// ---------------------------------------------------------------------------

/** The npm implementation a missed interception would silently inline instead. */
const DECOY_NPM_MARKER = "NPM_IMPLEMENTATION_MARKER";

function decoyChartKit(): Readonly<Record<string, string>> {
  return {
    "node_modules/@example/chart-kit/package.json": JSON.stringify({
      name: "@example/chart-kit",
      version: "1.0.0",
      main: "index.js",
    }),
    "node_modules/@example/chart-kit/index.js": `module.exports = { createChart: function () { return "${DECOY_NPM_MARKER}"; }, renderChart: function () { return "${DECOY_NPM_MARKER}"; } };\n`,
  };
}

const DEFAULT_IMPORT_ENTRY = `import chartKit from "@example/chart-kit";

export function App() {
  return <i>{typeof chartKit.createChart}</i>;
}
`;

const NAMESPACE_IMPORT_ENTRY = `import * as chartKit from "@example/chart-kit";

export function App() {
  return <i>{\`\${typeof chartKit.createChart}|\${typeof chartKit.renderChart}\`}</i>;
}
`;

describe("default, named and namespace imports execute the page object, never an npm copy (#86)", () => {
  it("answers all three shapes from the mapped global", async () => {
    // A decoy npm implementation is installed under the fixture. That is the point:
    // if the mapping were missed, the build would resolve the decoy by ordinary
    // lookup and still compile — the silent-inline failure #12 forbids. The absence
    // of the marker proves the generated module is what the artifact carries, and the
    // sandbox evaluation proves it reads the mapped page object.
    const dir = fixture("import-shapes", {
      "App.jsx": NAMED_CHART_KIT_ENTRY,
      "Default.jsx": DEFAULT_IMPORT_ENTRY,
      "Namespace.jsx": NAMESPACE_IMPORT_ENTRY,
      ...decoyChartKit(),
    });
    const mappings = chartKitMappings();

    for (const [entry, expected] of [
      ["App.jsx", "function|function"],
      ["Default.jsx", "function"],
      ["Namespace.jsx", "function|function"],
    ] as const) {
      const outcome = await compile(dir, entry, mappings, [CHART_KIT_DECISION]);

      expect(outcome.status).toBe("compiled");
      if (outcome.status !== "compiled") continue;
      expect(outcome.artifact.frontendLibraries).toEqual([{ libraryId: CHART_KIT.libraryId }]);
      // The npm copy is not in this artifact — neither its marker nor its module id.
      expect(outcome.artifact.code).not.toContain(DECOY_NPM_MARKER);

      const sandbox = runArtifact(outcome.artifact.code, {
        React: reactStub(),
        [CHART_KIT.globalName]: chartKitFacade(),
      });
      expect(textOf(componentFrom(sandbox)())).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// One library, several module ids
// ---------------------------------------------------------------------------

describe("several module ids of one library produce one canonical reference (#86)", () => {
  it("deduplicates the reference and orders libraries canonically and stably", async () => {
    // One row covers two npm imports (its `moduleIds`), and a second library is there
    // to make the *order* observable: canonicalization sorts by library id and drops
    // duplicates, so `acme-charts` must appear once even though two decisions name it,
    // and before `zeta-lib` because it sorts first by code point.
    const rows = [
      projectRow({
        packageName: "@acme/charts",
        moduleIds: ["@acme/charts-core"],
        libraryId: "acme-charts",
        globalName: "AcmeCharts",
      }),
      projectRow({
        packageName: "@acme/zeta",
        libraryId: "zeta-lib",
        globalName: "ZetaLib",
      }),
    ];
    const mappings = normalizedOrThrow(configWithRows(rows));

    const decisions: readonly DependencyDecision[] = [
      { strategy: "extension", packageName: "@acme/charts", libraryId: "acme-charts", globalName: "AcmeCharts" },
      { strategy: "extension", packageName: "@acme/charts-core", libraryId: "acme-charts", globalName: "AcmeCharts" },
      { strategy: "extension", packageName: "@acme/zeta", libraryId: "zeta-lib", globalName: "ZetaLib" },
    ];

    const dir = fixture("shared-library", {
      "App.jsx": `import { createChart } from "@acme/charts";
import { chartOptions } from "@acme/charts-core";
import { zeta } from "@acme/zeta";

export function App() {
  return <i>{\`\${typeof createChart}|\${typeof chartOptions}|\${typeof zeta}\`}</i>;
}
`,
      "node_modules/@acme/charts/package.json": JSON.stringify({
        name: "@acme/charts",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/@acme/charts/index.js": `module.exports = { createChart: function () { return "${DECOY_NPM_MARKER}"; } };\n`,
      "node_modules/@acme/charts-core/package.json": JSON.stringify({
        name: "@acme/charts-core",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/@acme/charts-core/index.js": `module.exports = { chartOptions: function () { return "${DECOY_NPM_MARKER}"; } };\n`,
      "node_modules/@acme/zeta/package.json": JSON.stringify({
        name: "@acme/zeta",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/@acme/zeta/index.js": `module.exports = { zeta: function () { return "${DECOY_NPM_MARKER}"; } };\n`,
    });

    const first = await compile(dir, "App.jsx", mappings, decisions);
    const again = await compile(dir, "App.jsx", mappings, decisions);

    expect(first.status).toBe("compiled");
    expect(again.status).toBe("compiled");
    if (first.status !== "compiled" || again.status !== "compiled") return;

    expect(first.artifact.frontendLibraries).toEqual([
      { libraryId: "acme-charts" },
      { libraryId: "zeta-lib" },
    ]);
    // Same inputs, same bytes and same metadata — the stability half of the criterion.
    expect(again.artifact.code).toBe(first.artifact.code);
    expect(again.artifact.frontendLibraries).toEqual(first.artifact.frontendLibraries);
    expect(first.artifact.code).not.toContain(DECOY_NPM_MARKER);

    const sandbox = runArtifact(first.artifact.code, {
      React: reactStub(),
      AcmeCharts: {
        createChart: () => "chart",
        chartOptions: () => "options",
      },
      ZetaLib: { zeta: () => "zeta" },
    });
    expect(textOf(componentFrom(sandbox)())).toBe("function|function|function");
  });
});

// ---------------------------------------------------------------------------
// Negative cases: refuse, or report where to fix — never silently inline
// ---------------------------------------------------------------------------

function configDiagnosticsOf(config: unknown): readonly { readonly code: string; readonly path: string; readonly message: string }[] {
  try {
    createCellRegistry(config, { root: join(fixtureRoot, "negative-config"), requireEntryFiles: false });
  } catch (error) {
    if (error instanceof ForguncyConfigError) return error.diagnostics;
    throw error;
  }
  throw new Error("Expected the config to be refused.");
}

describe("a bad mapping fails before compilation, with the config path that produced it (#86)", () => {
  it("refuses two project rows that claim one module id", () => {
    const diagnostics = configDiagnosticsOf(
      configWithRows([
        projectRow({ packageName: "@acme/a", libraryId: "acme-a", globalName: "AcmeA" }),
        projectRow({ packageName: "@acme/b", moduleIds: ["@acme/a"], libraryId: "acme-b", globalName: "AcmeB" }),
      ]),
    );

    expect(diagnostics.map(diagnostic => diagnostic.code)).toContain("extension-mapping-conflict");
    expect(diagnostics.find(diagnostic => diagnostic.code === "extension-mapping-conflict")?.path).toBe(
      "extensions.mappings",
    );
  });

  it("refuses a row with no global, with no library id, and with a host-bound global", () => {
    // Three rows, three different repairs, one round trip: #85's normalization reports
    // each at its own row path, and none of them reaches a bundler.
    const noGlobal = projectRow({ packageName: "@acme/no-global", libraryId: "acme-no-global", globalName: "" });
    const noLibrary = projectRow({ packageName: "@acme/no-library", libraryId: "", globalName: "AcmeNoLibrary" });
    const hostCollision = projectRow({
      packageName: "@acme/react-named",
      libraryId: "acme-react-named",
      globalName: "React",
    });

    const diagnostics = configDiagnosticsOf(configWithRows([noGlobal, noLibrary, hostCollision]));

    const paths = diagnostics.filter(diagnostic => diagnostic.code === "invalid-extension-mapping").map(diagnostic => diagnostic.path);
    expect(paths).toEqual(["extensions.mappings[0]", "extensions.mappings[1]", "extensions.mappings[2]"]);

    const messages = diagnostics.map(diagnostic => diagnostic.message).join("\n");
    expect(messages).toContain("`globalName` must be a non-empty string");
    expect(messages).toContain("`libraryId` must be a non-empty string");
    // The host-owned-identity half of "never claim a page identity someone else binds".
    // `React` is refused by the platform's reserved list before #9's host table is
    // consulted, and the message names the claimed global either way.
    expect(messages).toContain('the global "React"');
    expect(messages).toContain("reserves this name");
  });
});

describe("an incoherent table handed to the compile refuses instead of picking a row (#86)", () => {
  it("reports the conflict and does not silently inline the decoy npm copy", async () => {
    // A caller can hand `compileCell` a set its own normalization would have refused
    // (a stale cache, a forged object). The plan is non-wireable in that state, so no
    // interception is chosen by table order — and the artifact must not come back
    // `compiled` with the npm copy inlined either.
    const conflicting: NormalizedExtensionMappings = {
      mappings: [
        {
          packageName: "@example/chart-kit",
          libraryId: "example-chart-kit",
          globalName: "ExampleChartKit",
          metadataSource: "verified-catalog",
          metadataReference: "acme/forguncy-library",
          verificationRule: "first claim",
          verifiedBy: ["product-documentation"],
          note: "first row",
        },
        {
          packageName: "@example/chart-kit-alt",
          moduleIds: ["@example/chart-kit"],
          libraryId: "example-chart-kit-alt",
          globalName: "ExampleChartKitAlt",
          metadataSource: "verified-catalog",
          metadataReference: "acme/forguncy-library",
          verificationRule: "second claim for the same module id",
          verifiedBy: ["product-documentation"],
          note: "second row",
        },
      ],
      projectMappings: [],
      source: "project-only",
      includesBuiltinMappings: false,
      builtinMappings: [],
    };

    const dir = fixture("conflicting-table", {
      "App.jsx": NAMED_CHART_KIT_ENTRY,
      ...decoyChartKit(),
    });

    const outcome = await compile(dir, "App.jsx", conflicting, [CHART_KIT_DECISION]);

    expect(outcome.status).toBe("rejected");
    // The plan's own conflict, translated into the artifact vocabulary. The import
    // fell through to the installed decoy, and the inlined-copy audit says so as well;
    // either way the compile never claims success over an npm implementation.
    expect(codesOf(outcome)).toContain("missing-extension-mapping");
  });
});

describe("an undeclared subpath is not bridged (#86)", () => {
  it("refuses to inline the subpath behind the package's extension decision", async () => {
    // The mapping intercepts exactly what it lists. `@example/chart-kit/deep` is not
    // listed, so it resolves to the npm package — and the decision still says the
    // package is an extension. That is an artifact carrying its own copy behind a
    // global, which must be reported, not accepted.
    const dir = fixture("undeclared-subpath", {
      "App.jsx": `import { value } from "@example/chart-kit/deep";

export function App() {
  return <i>{value}</i>;
}
`,
      "node_modules/@example/chart-kit/package.json": JSON.stringify({
        name: "@example/chart-kit",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/@example/chart-kit/deep.js": `module.exports = { value: "${DECOY_NPM_MARKER}" };\n`,
    });
    const mappings = chartKitMappings();

    const outcome = await compile(dir, "App.jsx", mappings, [CHART_KIT_DECISION]);

    expect(outcome.status).toBe("rejected");
    expect(codesOf(outcome)).toContain("missing-extension-mapping");
    expect(outcome.status === "rejected" ? outcome.diagnostics[0]?.subject : undefined).toBe(CHART_KIT.packageName);
  });
});

describe("a decision without a usable library or global is refused (#86)", () => {
  it("reports a decision that names a library the project row does not", async () => {
    // The metadata half of "one table": `frontendLibraries` is derived from the
    // decision, and the artifact would tell the page to load a library the row never
    // binds. The plan compares the two and the compile refuses.
    const dir = fixture("decision-wrong-library", { "App.jsx": NAMED_CHART_KIT_ENTRY });
    const mappings = chartKitMappings();
    const decision: DependencyDecision = {
      strategy: "extension",
      packageName: CHART_KIT.packageName,
      libraryId: "wrong-library",
      globalName: CHART_KIT.globalName,
    };

    const outcome = await compile(dir, "App.jsx", mappings, [decision]);

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(codesOf(outcome)).toContain("missing-extension-mapping");
    expect(outcome.diagnostics.map(diagnostic => diagnostic.message).join("\n")).toContain("wrong-library");
  });

  it("reports a decision that names no library id", async () => {
    const dir = fixture("decision-no-library", { "App.jsx": NAMED_CHART_KIT_ENTRY });
    const mappings = chartKitMappings();
    const decision: DependencyDecision = {
      strategy: "extension",
      packageName: CHART_KIT.packageName,
      libraryId: "",
      globalName: CHART_KIT.globalName,
    };

    const outcome = await compile(dir, "App.jsx", mappings, [decision]);

    expect(outcome.status).toBe("rejected");
    expect(codesOf(outcome)).toContain("missing-extension-mapping");
  });
});

describe("a page without the extension global fails by name at runtime (#86)", () => {
  it("throws the structured extension-global-missing error, not an empty namespace", async () => {
    // Compilation is legitimate: the mapping says the page will publish the global.
    // Whether the page *did* is the runtime's question, and this is what the generated
    // module answers when it did not.
    const dir = fixture("runtime-missing-global", { "App.jsx": NAMESPACE_IMPORT_ENTRY });
    const mappings = chartKitMappings();

    const outcome = await compile(dir, "App.jsx", mappings, [CHART_KIT_DECISION]);

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;

    // No `ExampleChartKit` in the sandbox — the page never loaded the library.
    let thrown: Record<string, unknown> | undefined;
    try {
      runArtifact(outcome.artifact.code, { React: reactStub() });
    } catch (error) {
      thrown = error as Record<string, unknown>;
    }

    expect(thrown?.code).toBe("extension-global-missing");
    expect(thrown?.libraryId).toBe(CHART_KIT.libraryId);
    expect(thrown?.globalName).toBe(CHART_KIT.globalName);
  });
});
