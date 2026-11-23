/**
 * Issue #102 — the consumer entrypoint's output, *executed*, not described.
 *
 * Decision source: GitHub Issue #102
 * (https://github.com/MangMax/forguncy-react-workspace/issues/102), under parent #81 and downstream
 * of #99 (the consumer entrypoint this file starts from), #100 (dedup) and #101 (cross-platform).
 *
 * ## Evidence label: `local / happy-dom / mock MCP port` — **not** Forguncy runtime validation
 *
 * Every assertion in this file is local evidence in the vocabulary of #4 and AGENTS.md rules 6–7:
 *
 * - the compiler and the Skill CLI run for real, in this checkout;
 * - the emitted single-file artifact is evaluated in a real DOM (`happy-dom`) and rendered with
 *   the real React the host provides;
 * - the designer is a `ForguncySyncPort` this file supplies, so a green sync says the *flow*
 *   agreed with the artifacts, never that a designer accepted the calls.
 *
 * Nothing here opens a Forguncy page, so nothing here is a claim about the platform's validator,
 * its page lifecycle or its real browser. That gate is #107, and a green run of this file must not
 * be read as passing it.
 *
 * ## Why the cases start at the public entrypoint
 *
 * The failure #102 exists to catch is a *wiring* defect: local development works, the same source
 * compiles, and then the production artifact throws or renders nothing. A test that stubbed the
 * compiler, hand-wrote an artifact, or called a private `packages/*\/src` module could not see
 * that class of defect — it would be testing the stub. So every case below:
 *
 * - stages an ordinary consumer project from `examples/consumer-project` in a scratch root;
 * - runs the **real** dependency Skill (`record`) as a child process;
 * - compiles through `@forguncy-react-workspace/cell-project`'s public `compileProject` /
 *   `buildProject` / `planProject` / `syncProject`;
 * - evaluates the resulting `code` string exactly as the page would.
 *
 * The only imports from this repository are public package entrypoints (`./index.ts` is this
 * package's own barrel, `@forguncy-react-workspace/mcp-sync` for the port type), and the DOM
 * harness below is test scaffolding, not a replacement for any production assembly step.
 *
 * ## What the fault-injection cases are for
 *
 * A regression that only checks strings can pass for every one of the four defect classes #102
 * names. Each `describe` below therefore *breaks* one piece of wiring and asserts that the run
 * fails loudly, in the production vocabulary, rather than rendering a plausible empty UI or
 * reporting a stale artifact as current:
 *
 * | class | what is broken | the assertion |
 * | --- | --- | --- |
 * | (a) missing façade provider / host bridge | the page supplies no `useDataSource` / no props | render throws a `RuntimeFacadeResolutionError` with a stable `code` |
 * | (b) dropped `extensions.mappings` | the project row is removed after recording | compile rejects with `missing-extension-mapping`; plan/sync refuse |
 * | (c) stale probe cache / moved install graph | the recorded version is not installed | compile rejects with `unresolved-dependency-decision`; plan/sync refuse |
 * | (d) partial write + manual designer edit | `setCells` lands then the ack fails; then a designer edits | retry is `unchanged` with no second `setCells`; the edit is `refused`/`cell-diverged` |
 */

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Window } from "happy-dom";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ForguncySyncPort } from "@forguncy-react-workspace/mcp-sync";

import {
  buildProject,
  compileProject,
  planProject,
  planProjectAgainstPort,
  ProjectPlanError,
  syncProject,
} from "./index.ts";
import type { ProjectBuild } from "./index.ts";

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

/** A real compile plus a real probe; the probe builds `es-toolkit` through Rolldown. */
const CASE_TIMEOUT_MS = 240_000;

/** The scratch roots this file created, removed once at the end. */
const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The consumer project, staged
// ---------------------------------------------------------------------------

/**
 * A temp copy of the example, inside its own tree so bare imports still resolve.
 *
 * Under `.fgc/` — which is git-ignored and skipped by the repository-wide scans — because Node's
 * and Rolldown's resolution walk up from the scratch root to the example's `node_modules`, and the
 * install-graph identity walk finds the repository's lockfile the same way. A copy in `os.tmpdir()`
 * would resolve neither without rebuilding the install.
 */
function scratchRoot(name: string): string {
  mkdirSync(join(EXAMPLE_ROOT, ".fgc"), { recursive: true });
  const root = mkdtempSync(join(EXAMPLE_ROOT, ".fgc", `${name}-`));
  scratchRoots.push(root);
  return root;
}

/** The Skill's `record`, as the Agent would run it: a child process writing real files. */
async function record(root: string, decisionPath: string, extra: readonly string[] = []): Promise<void> {
  await run(
    process.execPath,
    [SKILL_CLI, "record", "--project", root, "--decision", decisionPath, ...extra],
    { cwd: REPOSITORY_ROOT, maxBuffer: 32 * 1024 * 1024 },
  );
}

/**
 * The example's own config and Cells, plus a second declared Cell for the two-Cell cases.
 *
 * The second Cell is a copy of the first with a different heading and a different colour in its
 * stylesheet. That is deliberate rather than cosmetic: the style registry keys by the CSS text, so
 * two Cells sharing one stylesheet would share one `<style>` element and the "separate style ids"
 * criterion would have nothing to observe. Everything else — the workspace package, `es-toolkit`,
 * the façade, the CSS + PNG pipeline — is the example's own source.
 */
function stageConsumerProject(): string {
  const root = scratchRoot("main");
  cpSync(join(EXAMPLE_ROOT, "dependencies"), join(root, "dependencies"), { recursive: true });
  cpSync(join(EXAMPLE_ROOT, "cells"), join(root, "cells"), { recursive: true });

  // The second Cell: the same source, one visible string changed and one colour changed.
  const secondary = join(root, "cells", "sales-secondary");
  cpSync(join(root, "cells", "sales-overview"), secondary, { recursive: true });
  const secondaryApp = join(secondary, "src", "App.tsx");
  writeFileSync(secondaryApp, readFileSync(secondaryApp, "utf8").replace("本月销售概览", "副销售看板"), "utf8");
  const secondaryCss = join(secondary, "src", "cell.css");
  writeFileSync(secondaryCss, readFileSync(secondaryCss, "utf8").replace("#1d4ed8", "#b45309"), "utf8");

  const template = readFileSync(join(EXAMPLE_ROOT, "forguncy.config.ts"), "utf8");
  // Inserted *after* the example's own Cell so `cells[0]` stays the project's primary Cell and the
  // second one is the addition, rather than the other way round.
  const anchor = '      target: { pageName: "销售看板", cell: "B2" },\n    },';
  const config = template.replace(
    anchor,
    [
      anchor,
      "    salesSecondary: {",
      '      entry: "./cells/sales-secondary/src/App.tsx",',
      '      target: { pageName: "销售看板", cell: "C3" },',
      "    },",
    ].join("\n"),
  );
  if (config === template) {
    throw new Error("The staged config did not gain its second Cell; the anchor moved.");
  }
  writeFileSync(join(root, "forguncy.config.ts"), config, "utf8");
  return root;
}

/** A copy of a staged root, so one `record` can back several independent faults. */
function copyRoot(source: string, name: string): string {
  const root = scratchRoot(name);
  cpSync(source, root, { recursive: true });
  return root;
}

/**
 * A project outside the monorepo, with its own install layout.
 *
 * The extension record is a *measurement*: `record` stores the install-graph identity it probed
 * under, and `loadCellProject` refuses a record whose identity this process cannot confirm (#94).
 * A scratch root nested under `examples/consumer-project/.fgc` has no install of its own, so its
 * probe records `lockfile: null` and the record is (correctly) withheld as
 * `install-graph-unknown`. This project supplies the two files pnpm's reader needs —
 * `pnpm-lock.yaml` and `node_modules/.modules.yaml` — and a `vite-plus` stub, so the record's
 * toolchain and install-graph axes are observable and the extension case tests the mapping path
 * rather than the install-attribution boundary. The same layout is what
 * `examples/extension-custom/integration.test.ts` uses for its projection test.
 */
function standaloneRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `fgc-102-${name}-`));
  scratchRoots.push(root);
  return root;
}

/** A package stub in a project's own `node_modules`, so Node and Rolldown can resolve it. */
function installPackage(root: string, name: string, version: string, source: string): void {
  const packageRoot = join(root, "node_modules", ...name.split("/"));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name, version, type: "module", main: "index.js" }, null, 2),
    "utf8",
  );
  writeFileSync(join(packageRoot, "index.js"), source, "utf8");
}

/**
 * A project whose Cell imports a non-built-in mapped package, with a stub npm copy installed.
 *
 * The stub is what `record` probes — the extension decision is a claim about a package, and the
 * Skill measures it. At execution time the page global is the only thing that answers the import;
 * the stub's marker must therefore never reach the artifact, which the execution case asserts.
 */
function stageExtensionProject(): string {
  const root = standaloneRoot("extension");

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "consumer-extension", version: "0.0.0", private: true, type: "module" }, null, 2),
    "utf8",
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

  // The layout record the install-graph identity reads, and a virtual store with one slot so the
  // store exists rather than being guessed at.
  mkdirSync(join(root, "node_modules", ".pnpm", "probe-package@1.0.0", "node_modules", "probe-package"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "node_modules", ".pnpm", "probe-package@1.0.0", "node_modules", "probe-package", "package.json"),
    JSON.stringify({ name: "probe-package", version: "1.0.0" }),
    "utf8",
  );
  mkdirSync(join(root, "node_modules", ".pnpm", "node_modules"), { recursive: true });
  writeFileSync(
    join(root, "node_modules", ".modules.yaml"),
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

  // `readToolchainIdentity` resolves the project's own `vite-plus`, so the stub has to be the
  // version the repository installs: the `record` this fixture runs and the `status` that follows
  // both read the toolchain from *this* project, and a stub at another version would make the two
  // disagree about the axis for a reason that is about the fixture rather than about the case.
  installPackage(root, "vite-plus", "1.7.0", "export {};\n");

  writeFileSync(join(root, "forguncy.config.ts"), standaloneExtensionConfig(true), "utf8");

  for (const [cell, marker] of [
    ["chart-a", "a"],
    ["chart-b", "b"],
  ] as const) {
    const source = join(root, "cells", cell, "src");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "App.tsx"),
      [
        'import { sharedCount } from "@example/chart-panel";',
        "",
        "export function App() {",
        `  const value = sharedCount();`,
        `  return <output data-extension-cell="${marker}" data-shared-count={String(value)}>共享计数 {value}</output>;`,
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  // The npm copy `record` probes. `sharedCount` exists only here, so the artifact's own output
  // proves the page global was read rather than this file being inlined.
  installPackage(
    root,
    "@example/chart-panel",
    "1.0.0",
    'export const CHART_PANEL_NPM_COPY_MARKER = "npm-copy-marker";\nexport function sharedCount() { return "npm-copy"; }\n',
  );

  writeFileSync(
    join(root, "chart-panel.decision.json"),
    JSON.stringify(
      {
        packageName: "@example/chart-panel",
        role: "cell-local-ui",
        strategy: "extension",
        libraryId: "example-chart-panel",
        globalName: "ExampleChartPanel",
        extensionVersion: "1.0.0",
        extensionIdentity: "sha256:chart-panel-fixture",
        rationale:
          "The extension publishes one shared page object; a bundled copy would be a second module identity.",
      },
      null,
      2,
    ),
    "utf8",
  );

  return root;
}

/** The diagnostics a rejected Cell carries, flattened for a readable assertion. */
function diagnosticCodes(build: ProjectBuild, index = 0): readonly string[] {
  const cell = build.build.cells[index];
  if (cell === undefined || cell.outcome.status !== "rejected") {
    throw new Error(`Expected Cell #${index} to be rejected; it is ${cell?.outcome.status ?? "missing"}.`);
  }
  return [
    ...cell.outcome.diagnostics.map(diagnostic => diagnostic.code),
    ...(cell.outcome.workspace?.diagnostics.map(diagnostic => diagnostic.code) ?? []),
  ];
}

/** One compiled Cell's code, with a named refusal when the build did not produce one. */
function artifactCode(build: ProjectBuild, index = 0): string {
  const cell = build.build.cells[index];
  if (cell === undefined || cell.outcome.status !== "compiled") {
    throw new Error(
      `Expected Cell #${index} to compile; it was rejected with ${diagnosticCodes(build, index).join(", ") || "(no named diagnostic)"}.`,
    );
  }
  return cell.outcome.artifact.code;
}

/** A build that every case in a describe already required to be compiled. */
function expectCompiled(build: ProjectBuild): void {
  for (const [index, cell] of build.build.cells.entries()) {
    if (cell.outcome.status !== "compiled") {
      const summary = build.report.cells[index];
      throw new Error(
        `Cell #${index} (${cell.cellId}) did not compile: ${JSON.stringify(
          {
            diagnostics: summary?.diagnostics ?? [],
            decisions: summary?.decisions ?? [],
            withheld: summary?.withheld ?? [],
            unobservable: summary?.unobservable ?? [],
            conformanceErrors: summary?.conformanceErrors ?? [],
          },
          null,
          2,
        )}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The DOM, real React, and the traps a happy path must leave empty
// ---------------------------------------------------------------------------

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let flushSync: typeof import("react-dom").flushSync;
let domWindow: Window;

/**
 * A DOM node in happy-dom's own type world.
 *
 * Deliberately not `HTMLElement`: happy-dom's classes are structurally different from `lib.dom`'s
 * (they carry their own event and element types), and mixing the two is a type error that says
 * nothing about the test. ReactDOM is handed the real node through one explicit cast, where the
 * page would hand it the browser's node; everywhere else the harness keeps happy-dom's types.
 */
type PageElement = ReturnType<typeof domWindow.document.createElement>;

/** A DOM surface that answers queries — a document, an element, a fragment. */
interface PageQuery {
  querySelectorAll(selector: string): ArrayLike<PageElement>;
}

/** Every element matching `selector`, in document order. */
function queryAll(root: PageQuery, selector: string): PageElement[] {
  return Array.from(root.querySelectorAll(selector));
}

/** The React shape React.createElement accepts for an artifact's untyped `App` export. */
type ArtifactComponent = React.FunctionComponent<Record<string, unknown>>;

/** `createElement` for the artifact's `App`, which the harness only knows structurally. */
function renderArtifact(component: unknown, props: unknown): React.ReactElement {
  return React.createElement(component as ArtifactComponent, props as Record<string, unknown>);
}

/**
 * Errors the happy path must not produce.
 *
 * Three traps rather than one, because the issue names three kinds and a `<style>`/`<img>` failure
 * is invisible to two of them:
 *
 * - `consoleErrors` — anything the artifact logged through `console.error` (a swallowed command
 *   failure, a React warning);
 * - `uncaught` — an uncaught throw or unhandled rejection, from React's `reportError` or a promise;
 * - `resourceErrors` — an `error` event whose target is an element, so a failed resource load is a
 *   failure rather than a stray event nobody reads.
 */
const consoleErrors: string[] = [];
const uncaught: unknown[] = [];
const resourceErrors: string[] = [];

/** Make the happy-dom window the process's DOM, as a page does before a Cell script runs. */
function installDomGlobals(window: Window): void {
  const names = [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLIFrameElement",
    "DocumentFragment",
    "Text",
    "Comment",
    "Event",
    "MouseEvent",
    "CustomEvent",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "MutationObserver",
    "location",
    "history",
    "localStorage",
    "sessionStorage",
  ];
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of names) {
    const value = (window as unknown as Record<string, unknown>)[name];
    if (value === undefined) continue;
    try {
      Object.defineProperty(globals, name, { value, configurable: true, writable: true });
    } catch {
      // A non-configurable host global (e.g. a newer Node's `navigator`) keeps its own value; the
      // harness only needs the DOM names ReactDOM and the artifact read.
    }
  }
  try {
    Object.defineProperty(globals, "self", { value: window, configurable: true, writable: true });
  } catch {
    // Same as above.
  }
}

beforeAll(async () => {
  domWindow = new Window({ url: "https://page.example/forguncy" });
  installDomGlobals(domWindow);

  React = await import("react");
  (domWindow as unknown as Record<string, unknown>).React = React;
  ({ createRoot } = await import("react-dom/client"));
  ({ flushSync } = await import("react-dom"));

  domWindow.addEventListener(
    "error",
    event => {
      const typed = event as unknown as { target?: { tagName?: unknown } | null; error?: unknown; message?: unknown };
      const tagName = typeof typed.target?.tagName === "string" ? typed.target.tagName.toUpperCase() : undefined;
      if (tagName !== undefined && ["IMG", "LINK", "SCRIPT"].includes(tagName)) {
        resourceErrors.push(`${tagName} failed to load`);
        return;
      }
      uncaught.push(typed.error ?? typed.message ?? "window error");
    },
    true,
  );
  domWindow.addEventListener("unhandledrejection", event => {
    uncaught.push((event as unknown as { reason?: unknown }).reason ?? "unhandled rejection");
  });
}, CASE_TIMEOUT_MS);

beforeEach(() => {
  consoleErrors.length = 0;
  uncaught.length = 0;
  resourceErrors.length = 0;
  domWindow.document.body.innerHTML = "";
  for (const style of queryAll(domWindow.document.head, "style[data-forguncy-cell-style]")) {
    style.remove();
  }
  delete (domWindow as unknown as Record<string, unknown>).__forguncyCellStyleRegistry;
  delete (domWindow as unknown as Record<string, unknown>).ExampleChartPanel;
});

/** The happy path's terminal assertion: nothing was logged, thrown or failed to load. */
function expectCleanPage(): void {
  expect(consoleErrors, "the artifact logged a console error").toEqual([]);
  expect(uncaught, "an exception or rejection escaped the page").toEqual([]);
  expect(resourceErrors, "a resource failed to load").toEqual([]);
}

interface HostProfile {
  readonly label: string;
  /** Whether the page grants `Orders.Read`, which the Cell renders as an alert when false. */
  readonly granted: boolean;
  /** The rows the `Sales` hook answers; empty produces the Cell's `empty` self-check verdict. */
  readonly rows: readonly unknown[];
  readonly totalCount: number;
  /** Every command payload this Cell's host closure was handed. */
  readonly commands: unknown[];
  /** Every data-source call this Cell's hook answered. */
  readonly dataSources: { readonly name: string; readonly options: unknown }[];
}

interface HostBridge {
  readonly props: unknown;
  readonly useDataSource: unknown;
}

/**
 * A page host bridge built from one Cell's own values.
 *
 * The values are distinct per Cell so a provider that leaked across Cells is observable: the
 * permissions differ, the data-source answer differs and the command log is per closure.
 */
function hostBridgeFor(profile: HostProfile): HostBridge {
  const permissions = profile.granted ? { "Orders.Read": true } : {};
  const props = {
    Forguncy: {
      hasPermission: (name: string) => name === "Orders.Read" && profile.granted,
      getPermissions: () => permissions,
    },
    Permissions: permissions,
    ServerCommands: {
      GetSalesReport: async (payload: unknown) => {
        profile.commands.push(payload);
        return { errorCode: 0, errorMessage: "OK", marker: profile.label };
      },
    },
    ImageContext: { label: profile.label },
  };
  const useDataSource = (name: string, options?: unknown) => {
    profile.dataSources.push({ name, options });
    return { data: profile.rows, totalCount: profile.totalCount, loading: false, error: null };
  };
  return { props, useDataSource };
}

/** A profile constructor keeps each case's expectations readable. */
function hostProfile(overrides: Partial<HostProfile> & Pick<HostProfile, "label">): HostProfile {
  return {
    granted: true,
    rows: [
      { 月份: "6月", 销售额: 3120 },
      { 月份: "5月", 销售额: 2870 },
      { 月份: "4月", 销售额: 2450 },
    ],
    totalCount: 240,
    commands: [],
    dataSources: [],
    ...overrides,
  };
}

interface MountedArtifact {
  readonly container: PageElement;
  readonly root: ReturnType<typeof createRoot>;
  /** Errors React reported for this root (no error boundary is installed). */
  readonly uncaught: readonly unknown[];
  /** Console errors this artifact's own evaluation logged. */
  readonly consoleErrors: readonly string[];
  unmount(): void;
}

/**
 * Evaluate one emitted artifact the way the platform does, then render it into the DOM.
 *
 * The wrapper below supplies exactly the two wrapper-locals a ReactCellType Cell sees — `props`
 * and `useDataSource` — and the page object as `globalThis`. Everything else is the artifact's
 * own script: the generated runtime binding installs the façade provider from those values, the
 * host bridge reads `globalThis.React`, the extension module reads its page global, and the style
 * installer writes into `document`.
 *
 * `new Function` (rather than `eval`) keeps the artifact's `var`/`function` declarations inside
 * one evaluation scope, which is the per-Cell scope `CELL_SOURCE_EXECUTION_MODEL` records.
 */
function mountArtifact(code: string, host: HostBridge, key: string): MountedArtifact {
  const localConsole: string[] = [];
  const localUncaught: unknown[] = [];
  const trapConsole = {
    error: (...args: unknown[]) => {
      const line = args
        .map(argument => {
          if (!(argument instanceof Error)) return String(argument);
          const code = (argument as { code?: unknown }).code;
          return `${argument.name}${typeof code === "string" ? ` [${code}]` : ""}: ${argument.message}`;
        })
        .join(" ");
      localConsole.push(line);
      // The page-wide trap the happy path's terminal assertion reads, as well as this evaluation's
      // own log: an artifact's `console.error` is exactly what these cases must not swallow.
      consoleErrors.push(line);
    },
    warn: () => undefined,
    info: () => undefined,
    log: () => undefined,
    debug: () => undefined,
  };

  const factory = new Function(
    "window",
    "document",
    "globalThis",
    "React",
    "console",
    "props",
    "useDataSource",
    `${code}\n;return typeof App === "function" ? App : undefined;`,
  ) as (
    window: unknown,
    document: unknown,
    globalObject: unknown,
    react: unknown,
    console: unknown,
    props: unknown,
    useDataSource: unknown,
  ) => unknown;

  const App = factory(
    domWindow,
    domWindow.document,
    domWindow,
    React,
    trapConsole,
    host.props,
    host.useDataSource,
  );
  if (typeof App !== "function") {
    throw new Error(`The artifact "${key}" exposed no App binding.`);
  }

  const container = domWindow.document.createElement("div");
  container.setAttribute("data-artifact-key", key);
  domWindow.document.body.appendChild(container);

  const root = createRoot(container as unknown as Element, {
    onUncaughtError: (error: unknown) => {
      localUncaught.push(error);
    },
    onCaughtError: (error: unknown) => {
      localUncaught.push(error);
    },
  });

  flushSync(() => root.render(renderArtifact(App, host.props)));

  return {
    container,
    root,
    uncaught: localUncaught,
    consoleErrors: localConsole,
    unmount: () => root.unmount(),
  };
}

/** The first element under `root` whose text content contains `text`. */
function findByText(root: PageQuery, selector: string, text: string): PageElement | undefined {
  return queryAll(root, selector).find(element => (element.textContent ?? "").includes(text));
}

/** Dispatch a real bubbling click through React's own listener, flushed as a discrete event. */
function click(element: PageElement): void {
  type DispatchEvent = Parameters<PageElement["dispatchEvent"]>[0];
  const MouseEventConstructor = (domWindow as unknown as {
    MouseEvent: new (type: string, init?: object) => DispatchEvent;
  }).MouseEvent;
  flushSync(() => {
    element.dispatchEvent(new MouseEventConstructor("click", { bubbles: true, cancelable: true }));
  });
}

/** A macrotask boundary, so every `await` in a command path has drained. */
function drainMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** The Cell style elements the artifacts installed, in document order. */
function styleElements(): readonly PageElement[] {
  return queryAll(domWindow.document, "style[data-forguncy-cell-style]");
}

// ---------------------------------------------------------------------------
// The staged builds, created once
// ---------------------------------------------------------------------------

interface MainStage {
  readonly root: string;
  readonly build: ProjectBuild;
}

interface ExtensionStage {
  readonly root: string;
  readonly build: ProjectBuild;
  readonly droppedBuild: ProjectBuild;
}

let main: MainStage;
let extension: ExtensionStage;
let staleBuild: ProjectBuild;

beforeAll(async () => {
  // 1. The example, plus a second Cell, recorded with the real Skill and compiled through the
  //    public entrypoint. `write: false` keeps this stage's root free of build output so the plan
  //    case below can assert that planning writes nothing.
  const mainRoot = stageConsumerProject();
  await record(mainRoot, join(mainRoot, "dependencies", "es-toolkit.decision.json"));
  const mainBuild = await compileProject({ root: mainRoot, write: false });
  expectCompiled(mainBuild);
  main = { root: mainRoot, build: mainBuild };

  // 2. A project-declared, non-built-in extension: recorded once, compiled with its mapping, and
  //    compiled again with the mapping row dropped. The second compile reuses the recorded lock, so
  //    the only difference between the two runs is the project's own mapping row.
  const extensionRoot = stageExtensionProject();
  await record(extensionRoot, join(extensionRoot, "chart-panel.decision.json"), ["--no-cache"]);
  const extensionBuild = await compileProject({ root: extensionRoot, write: false });
  expectCompiled(extensionBuild);

  writeFileSync(join(extensionRoot, "forguncy.config.ts"), standaloneExtensionConfig(false), "utf8");
  const droppedBuild = await compileProject({ root: extensionRoot, write: false });
  extension = { root: extensionRoot, build: extensionBuild, droppedBuild };

  // 3. The recorded package version is no longer the installed one. That is the observable half of
  //    the "stale evidence" fault class: a lock record that no longer describes this tree. The
  //    probe-fingerprint and install-graph axes have their own regressions (#94/#95); this case
  //    pins the consumer entrypoint's answer — the build must not serve what the projection
  //    withdrew.
  const staleRoot = copyRoot(mainRoot, "stale");
  const lockPath = join(staleRoot, "fgc.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    decisions: { packageName: string; resolvedVersion: string | null }[];
  };
  const esToolkitRecord = lock.decisions.find(decision => decision.packageName === "es-toolkit");
  if (esToolkitRecord === undefined) {
    throw new Error("The staged lock has no es-toolkit record, so the stale-evidence case cannot run.");
  }
  esToolkitRecord.resolvedVersion = "0.0.0-not-installed";
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  staleBuild = await compileProject({ root: staleRoot, write: false });
}, CASE_TIMEOUT_MS);

/**
 * The extension project's config, with or without its project mapping row.
 *
 * A plain default export rather than `defineForguncyConfig`: this project lives outside the
 * workspace so it can own its install graph, and a workspace import would make it a member of a
 * graph it is deliberately not part of. The document shape is #26's either way.
 */
function standaloneExtensionConfig(withMappings: boolean): string {
  const mapping = [
    "  extensions: {",
    "    mappings: [",
    "      {",
    '        packageName: "@example/chart-panel",',
    '        libraryId: "example-chart-panel",',
    '        globalName: "ExampleChartPanel",',
    '        metadataSource: "verified-catalog",',
    '        metadataReference: "MangMax/forguncy-react-library#example-chart-panel",',
    '        verificationRule: "A project row: the page global is what the artifact reads.",',
    '        verifiedBy: ["product-documentation"],',
    '        note: "Staged for Issue #102.",',
    "      },",
    "    ],",
    "  },",
  ].join("\n");
  return [
    "export default {",
    '  runtime: { forguncyVersion: "12.0.101", projectAlias: "consumer-extension" },',
    ...(withMappings ? [mapping] : []),
    "  cells: {",
    '    chartA: { entry: "./cells/chart-a/src/App.tsx", target: { pageName: "销售看板", cell: "B2" } },',
    '    chartB: { entry: "./cells/chart-b/src/App.tsx", target: { pageName: "销售看板", cell: "C3" } },',
    "  },",
    "};",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The happy path: the emitted artifact executes
// ---------------------------------------------------------------------------

describe("local / happy-dom / mock MCP port — the emitted artifact executes in a page", () => {
  it("local: reads the data source, permission and command through the façade's first calls", async () => {
    const profile = hostProfile({ label: "sales" });
    const host = hostBridgeFor(profile);
    const mounted = mountArtifact(artifactCode(main.build), host, "sales");

    try {
      // The façade's first calls on a live page: `useDataSource` and `hasPermission`.
      expect(profile.dataSources).toEqual([{ name: "Sales", options: { top: 3 } }]);
      expect(mounted.container.querySelector(".sales-alert")).toBeNull();
      // `pass` is the self-check's verdict only when the source answered rows of the shape this
      // Cell expects; an empty or absent answer is `empty`, never `pass`.
      expect(mounted.container.querySelector("[data-consumer-self-check]")?.getAttribute("data-consumer-self-check")).toBe("pass");
      expect(mounted.container.textContent ?? "").toContain("自检通过：比较了 3 行");

      // The command path, from a real click through React's listener.
      const exportButton = findByText(mounted.container, "button", "导出报表");
      expect(exportButton).toBeDefined();
      click(exportButton!);
      await drainMicrotasks();
      expect(profile.commands).toEqual([{ top: 3 }]);

      expectCleanPage();
      expect(mounted.uncaught).toEqual([]);
      expect(mounted.consoleErrors).toEqual([]);
    } finally {
      mounted.unmount();
    }
  }, CASE_TIMEOUT_MS);

  it("local: inlines es-toolkit and the workspace UI package, and applies CSS + the PNG in the DOM", async () => {
    const profile = hostProfile({ label: "sales" });
    const mounted = mountArtifact(artifactCode(main.build), hostBridgeFor(profile), "sales");

    try {
      const text = mounted.container.textContent ?? "";
      // `sumBy` (es-toolkit) computes the total; `clamp` and the formatter come from the two
      // packages the Cell imports. A missing package would leave the Cell unable to produce them.
      expect(text).toContain("¥8,440.00");
      // `@app/consumer-ui`'s `Panel` and `formatMoney` are workspace source flattened into the
      // artifact; their rendered output is what proves the source ran rather than a string match.
      expect(text).toContain("本月销售概览");
      expect(text).toContain("收起");

      // The workspace package never appears in `frontendLibraries` — it is source, not a runtime
      // module (#14). The determinism case below reads the written manifest for the same claim.
      const report = main.build.report.cells[0]!;
      expect(report.artifact?.frontendLibraries).toEqual([]);

      // The stylesheet was installed into the document, and its asset reference is a data URI that
      // decodes to the committed PNG's bytes.
      const styles = styleElements();
      expect(styles).toHaveLength(1);
      const css = styles[0]?.textContent ?? "";
      expect(css).toContain(".sales-overview");
      expect(css).toContain("data:image/png;base64,");
      expect(css).not.toContain("./badge.png");

      const badge = queryAll(mounted.container, "img.sales-badge")[0];
      expect(badge).toBeDefined();
      const source = badge!.getAttribute("src") ?? "";
      expect(source.startsWith("data:image/png;base64,")).toBe(true);
      const decoded = Buffer.from(source.slice("data:image/png;base64,".length), "base64");
      const committed = readFileSync(join(EXAMPLE_ROOT, "cells", "sales-overview", "src", "badge.png"));
      expect([...decoded]).toEqual([...committed]);

      // The DOM applies it: the badge's box carries the rounded border from the stylesheet.
      const computed = domWindow.getComputedStyle(badge!);
      expect(["0.5rem", "8px"]).toContain(computed.borderRadius || computed.getPropertyValue("border-radius"));

      expectCleanPage();
      expect(mounted.uncaught).toEqual([]);
    } finally {
      mounted.unmount();
    }
  }, CASE_TIMEOUT_MS);
  it("local: the console trap observes the Cell's own logged command failure", async () => {
    // A control for the trap `expectCleanPage` reads. The Cell logs a refused command through
    // `console.error` and renders on — exactly the shape a happy-path run must never hide. The
    // command is removed from the page's record, so the façade's own `server-command-not-configured`
    // refusal is what the Cell logs.
    const profile = hostProfile({ label: "sales" });
    const host = hostBridgeFor(profile);
    (host.props as { ServerCommands: unknown }).ServerCommands = {};
    const mounted = mountArtifact(artifactCode(main.build), host, "console-trap");

    try {
      const exportButton = findByText(mounted.container, "button", "导出报表");
      expect(exportButton).toBeDefined();
      click(exportButton!);
      await drainMicrotasks();

      expect(mounted.consoleErrors.join("\n")).toContain("server-command-not-configured");
      expect(consoleErrors.join("\n")).toContain("server-command-not-configured");
      // The trap's observation is the test: the render itself did not throw, so only the console
      // side can tell a swallowed failure from a working command.
      expect(mounted.uncaught).toEqual([]);
    } finally {
      mounted.unmount();
    }
  }, CASE_TIMEOUT_MS);

  it("local: the resource trap observes a failed element load", () => {
    // The other half of the same control. A `data:` URI cannot fail, so the happy path's empty
    // `resourceErrors` would be vacuous without showing that the trap fires on an element error.
    const image = domWindow.document.createElement("img");
    domWindow.document.body.appendChild(image);
    const EventConstructor = (domWindow as unknown as {
      Event: new (type: string) => Parameters<PageElement["dispatchEvent"]>[0];
    }).Event;
    image.dispatchEvent(new EventConstructor("error"));

    expect(resourceErrors).toEqual(["IMG failed to load"]);
    image.remove();
    resourceErrors.length = 0;
  });
});

describe("local / happy-dom / mock MCP port — two Cells coexist without leaking", () => {
  it("local: keeps props, state and styles apart, and never deletes another Cell's style", async () => {
    const profileA = hostProfile({ label: "A", granted: true });
    const profileB = hostProfile({ label: "B", granted: false, rows: [], totalCount: 0 });

    const a = mountArtifact(artifactCode(main.build, 0), hostBridgeFor(profileA), "A");
    const b = mountArtifact(artifactCode(main.build, 1), hostBridgeFor(profileB), "B");

    try {
      // Isolated host values: A is allowed and sees rows, B is denied and sees none. A shared
      // provider would hand one Cell the other's props — the failure #83's runtime regression and
      // this layer both exist to catch.
      expect(a.container.querySelector(".sales-alert")).toBeNull();
      expect(b.container.querySelector(".sales-alert")?.textContent).toContain("没有 Orders.Read 权限");
      expect(a.container.querySelector("[data-consumer-self-check]")?.getAttribute("data-consumer-self-check")).toBe("pass");
      expect(b.container.querySelector("[data-consumer-self-check]")?.getAttribute("data-consumer-self-check")).toBe("empty");
      expect(a.container.textContent ?? "").toContain("本月销售概览");
      expect(b.container.textContent ?? "").toContain("副销售看板");

      // Isolated local state: clicking one Cell's counter moves only that Cell.
      const counterA = findByText(a.container, "button", "交互计数");
      const counterB = findByText(b.container, "button", "交互计数");
      expect(counterA).toBeDefined();
      expect(counterB).toBeDefined();
      click(counterA!);
      click(counterA!);
      expect(counterA!.textContent).toContain("交互计数 2");
      expect(counterB!.textContent).toContain("交互计数 0");

      // Separate style ids, both in the document, each with its own colour.
      const styles = styleElements();
      expect(styles).toHaveLength(2);
      const ids = styles.map(style => style.getAttribute("data-forguncy-cell-style"));
      expect(new Set(ids).size).toBe(2);
      const css = styles.map(style => style.textContent ?? "").join("\n");
      expect(css).toContain("#1d4ed8");
      expect(css).toContain("#b45309");

      // Dropping one Cell must not remove the other's styles: the registry is reference-counted
      // and keyed, and an unmount of one artifact is not a release of the other.
      b.unmount();
      expect(styleElements()).toHaveLength(2);

      const registry = (domWindow as unknown as {
        __forguncyCellStyleRegistry?: { release(styleId: string): number };
      }).__forguncyCellStyleRegistry;
      expect(registry).toBeDefined();
      const firstId = ids[0];
      expect(firstId).toBeDefined();
      registry!.release(firstId!);
      const survivingIds = styleElements().map(style => style.getAttribute("data-forguncy-cell-style"));
      expect(survivingIds).toHaveLength(1);
      expect(survivingIds[0]).not.toBe(firstId);

      expectCleanPage();
      expect(a.uncaught).toEqual([]);
      expect(b.uncaught).toEqual([]);
    } finally {
      a.unmount();
    }
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// A project-declared extension, resolved through the page global
// ---------------------------------------------------------------------------

describe("local / happy-dom / mock MCP port — a project extension resolves through its page global", () => {
  it("local: both Cells read the same page object, so shared identity is observable", () => {
    // The page publishes one object and one closure. If each Cell bundled its own copy, or read a
    // different global, the two calls could not advance one counter.
    let count = 0;
    (domWindow as unknown as Record<string, unknown>).ExampleChartPanel = {
      sharedCount: () => {
        count += 1;
        return count;
      },
    };

    const a = mountArtifact(artifactCode(extension.build, 0), hostBridgeFor(hostProfile({ label: "A" })), "chart-a");
    const b = mountArtifact(artifactCode(extension.build, 1), hostBridgeFor(hostProfile({ label: "B" })), "chart-b");

    try {
      expect(a.container.querySelector("[data-extension-cell='a']")?.getAttribute("data-shared-count")).toBe("1");
      expect(b.container.querySelector("[data-extension-cell='b']")?.getAttribute("data-shared-count")).toBe("2");

      // The npm copy is not in the artifact: the mapping answered the import, and the stub's
      // marker would be the defect the extension strategy exists to prevent.
      const code = artifactCode(extension.build);
      expect(code).toContain("ExampleChartPanel");
      expect(code).not.toContain("npm-copy-marker");

      // The artifact tells the page which library to load before its entry runs. The manifest
      // reports the canonical `libraryId` list, not the reference records.
      expect(extension.build.report.cells[0]!.artifact?.frontendLibraries).toEqual(["example-chart-panel"]);

      expectCleanPage();
      expect(a.uncaught).toEqual([]);
      expect(b.uncaught).toEqual([]);
    } finally {
      a.unmount();
      b.unmount();
    }
  }, CASE_TIMEOUT_MS);

  it("local: fails cleanly, with a structured code, when the page global is missing", () => {
    delete (domWindow as unknown as Record<string, unknown>).ExampleChartPanel;

    let failure: unknown;
    try {
      mountArtifact(artifactCode(extension.build, 0), hostBridgeFor(hostProfile({ label: "A" })), "chart-a");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeDefined();
    const structured = failure as { code?: unknown; name?: unknown; message?: unknown };
    expect(structured.name).toBe("ExtensionExternalError");
    expect(structured.code).toBe("extension-global-missing");
    expect(String(structured.message)).toContain("ExampleChartPanel");
    expect(String(structured.message)).toContain("example-chart-panel");
    // Nothing rendered: the failure happened while the artifact's own module body ran, not later
    // at the first use, so there is no stub UI to mistake for a working Cell.
    expect(domWindow.document.querySelector("[data-extension-cell='a']")).toBeNull();
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// The three verbs, end to end
// ---------------------------------------------------------------------------

/** A port that records instead of connecting. It never contacts a designer. */
function recordingDesignerPort(): {
  readonly port: ForguncySyncPort;
  readonly writes: { readonly pageName: string; readonly cell: string; readonly code: string; readonly frontendLibraries: readonly { readonly libraryId: string }[] }[];
} {
  const cells = new Map<string, { code: string; frontendLibraries: readonly { libraryId: string }[] }>();
  const writes: { pageName: string; cell: string; code: string; frontendLibraries: readonly { libraryId: string }[] }[] = [];
  const keyOf = (pageName: string, cell: string) => `${pageName}\u0000${cell}`;

  const port: ForguncySyncPort = {
    listFrontendLibraries: async () => [],
    readCellSource: async request => {
      const found = cells.get(keyOf(request.pageName, request.cell));
      return found === undefined
        ? { kind: "blank" }
        : { kind: "react-cell", code: found.code, frontendLibraries: found.frontendLibraries };
    },
    setCells: async request => {
      for (const cell of request.cells) {
        const entry = {
          pageName: request.pageName,
          cell: cell.cell,
          code: cell.cellTypeProps.code,
          frontendLibraries: cell.cellTypeProps.frontendLibraries,
        };
        cells.set(keyOf(request.pageName, cell.cell), {
          code: entry.code,
          frontendLibraries: entry.frontendLibraries,
        });
        writes.push(entry);
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

/** A port that fails the test if a plan tries to write, so "plan writes nothing" is asserted. */
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

describe("local / mock MCP port — build, plan and sync from the public entrypoint", () => {
  it("local: a repeated build is byte-identical and a plan writes nothing", async () => {
    const buildRoot = copyRoot(main.root, "build");
    const first = await buildProject({ root: buildRoot });
    expect(first.cells.map(cell => cell.status)).toEqual(["compiled", "compiled"]);
    const firstManifest = readFileSync(first.manifestPath ?? "", "utf8");

    const firstBytes = first.cells
      .map(cell => readFileSync(join(first.outDir ?? "", cell.artifact?.file ?? ""), "utf8"))
      .join("\u0000");

    const second = await buildProject({ root: buildRoot });
    expect(second.cells.map(cell => cell.artifact?.fingerprint)).toEqual(
      first.cells.map(cell => cell.artifact?.fingerprint),
    );
    expect(readFileSync(second.manifestPath ?? "", "utf8")).toBe(firstManifest);
    // The shared workspace package is source, not a runtime module: the manifest never names it.
    expect(firstManifest).not.toContain("@app/consumer-ui");
    const secondBytes = second.cells
      .map(cell => readFileSync(join(second.outDir ?? "", cell.artifact?.file ?? ""), "utf8"))
      .join("\u0000");
    expect(secondBytes).toBe(firstBytes);

    // A plan over a fresh in-memory compile makes no call and leaves no output behind.
    const planRoot = copyRoot(main.root, "plan");
    const inMemory = await compileProject({ root: planRoot, write: false });
    const offline = planProject(inMemory);
    expect(offline.report.mode).toBe("offline");
    expect(offline.report.cells.map(cell => cell.wouldWrite)).toEqual([true, true]);
    expect(existsSync(join(planRoot, ".fgc", "build"))).toBe(false);

    const connected = await planProjectAgainstPort(inMemory, {
      port: readOnlyPort(),
      portDescription: "read-only test port",
    });
    expect(connected.report.mode).toBe("connected");
    expect(connected.report.cells.map(cell => cell.targetStateRead)).toEqual([true, true]);
    expect(connected.report.cells.map(cell => cell.wouldWrite)).toEqual([true, true]);
    expect(existsSync(join(planRoot, ".fgc", "build"))).toBe(false);
  }, CASE_TIMEOUT_MS);

  it("local: syncs only when called, and a retry reports unchanged without a second setCells", async () => {
    const { port, writes } = recordingDesignerPort();

    const first = await syncProject(main.build, { port, portDescription: "recording port" });
    expect(first.cells.map(cell => cell.status)).toEqual(["written", "written"]);
    expect(writes).toHaveLength(2);
    // The written payload is the stamped artifact plus the canonical library references.
    expect(writes.every(write => write.code.includes("Generated by @forguncy-react-workspace/cell-compiler"))).toBe(true);
    expect(writes.every(write => Array.isArray(write.frontendLibraries))).toBe(true);
    expect(first.cells[0]!.runtimeUrl).toContain(encodeURIComponent("销售看板"));

    const second = await syncProject(main.build, { port, portDescription: "recording port" });
    expect(second.cells.map(cell => cell.status)).toEqual(["unchanged", "unchanged"]);
    expect(writes).toHaveLength(2);
    expect(second.stoppedEarly).toBe(false);
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Fault injection: the four defect classes #102 names
// ---------------------------------------------------------------------------

describe("local / happy-dom — fault injection (a): a missing host bridge is loud", () => {
  it("local: render fails with a structured provider code instead of an empty Cell", () => {
    const host = hostBridgeFor(hostProfile({ label: "sales" }));
    const code = artifactCode(main.build);

    // The page forgot its `useDataSource` wrapper-local — the first façade call a Cell makes.
    const withoutHook = mountArtifactExpectingFailure(code, { ...host, useDataSource: undefined }, "missing-hook");
    expect(withoutHook.container.querySelector(".sales-overview")).toBeNull();

    // The page supplied the hook but no props: the handle `hasPermission` reads is absent.
    const withoutProps = mountArtifactExpectingFailure(code, { props: undefined, useDataSource: host.useDataSource }, "missing-props");
    expect(withoutProps.container.querySelector(".sales-overview")).toBeNull();

    for (const failure of [withoutHook.failure, withoutProps.failure]) {
      const structured = failure as { code?: unknown; name?: unknown };
      expect(structured.name).toBe("RuntimeFacadeResolutionError");
      expect(structured.code).toBe("provider-binding-missing");
    }
  }, CASE_TIMEOUT_MS);
});

/** Mount an artifact, returning the structured failure the page produced rather than throwing. */
function mountArtifactExpectingFailure(
  code: string,
  host: HostBridge,
  key: string,
): { readonly container: PageElement; readonly failure: unknown } {
  const localUncaught: unknown[] = [];
  const trapConsole = { error: () => undefined, warn: () => undefined, info: () => undefined, log: () => undefined, debug: () => undefined };
  const factory = new Function(
    "window",
    "document",
    "globalThis",
    "React",
    "console",
    "props",
    "useDataSource",
    `${code}\n;return typeof App === "function" ? App : undefined;`,
  ) as (window: unknown, document: unknown, globalObject: unknown, react: unknown, console: unknown, props: unknown, useDataSource: unknown) => unknown;

  let failure: unknown;
  try {
    const App = factory(domWindow, domWindow.document, domWindow, React, trapConsole, host.props, host.useDataSource);
    if (typeof App !== "function") throw new Error(`The artifact "${key}" exposed no App binding.`);
    const container = domWindow.document.createElement("div");
    container.setAttribute("data-artifact-key", key);
    domWindow.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element, {
      onUncaughtError: (error: unknown) => {
        localUncaught.push(error);
      },
    });
    try {
      flushSync(() => root.render(renderArtifact(App, host.props)));
    } catch (error) {
      localUncaught.push(error);
    }
    failure = localUncaught[0];
    return { container, failure };
  } catch (error) {
    failure = error;
    const container = domWindow.document.createElement("div");
    return { container, failure };
  }
}

describe("local / mock MCP port — fault injection (b): a dropped mapping refuses", () => {
  it("local: compile rejects with a structured diagnostic, and plan/sync refuse rather than pass", async () => {
    const codes = diagnosticCodes(extension.droppedBuild, 0);
    expect(codes).toContain("missing-extension-mapping");
    // The report says the Cell is rejected and produced no artifact; it did not silently bundle
    // the npm copy into something shippable.
    expect(extension.droppedBuild.report.cells[0]!.status).toBe("rejected");
    expect(extension.droppedBuild.report.cells[0]!.artifact).toBeNull();
    // The project row is gone from the report, which is what makes the failure attributable.
    expect(extension.droppedBuild.report.extensionMappings).toEqual([]);
    expect(extension.build.report.extensionMappings.map(row => row.packageName)).toEqual(["@example/chart-panel"]);

    expect(() => planProject(extension.droppedBuild)).toThrow(ProjectPlanError);
    expect(() => planProject(extension.droppedBuild)).toThrow(/missing-extension-mapping/);

    const { port, writes } = recordingDesignerPort();
    await expect(syncProject(extension.droppedBuild, { port })).rejects.toBeInstanceOf(ProjectPlanError);
    await expect(syncProject(extension.droppedBuild, { port })).rejects.toThrow(/did not compile/);
    // Nothing was sent: the refusal happened before any read or write.
    expect(writes).toHaveLength(0);
  }, CASE_TIMEOUT_MS);
});

describe("local / mock MCP port — fault injection (c): stale evidence refuses", () => {
  it("local: a moved installed version withholds the record and the build refuses to serve it", async () => {
    // The projection names the observable axis rather than silently dropping the record.
    const withheld = staleBuild.report.cells[0]!.withheld.find(entry => entry.packageName === "es-toolkit");
    expect(withheld).toBeDefined();
    expect(withheld!.reason).toBe("not-verified");
    expect(withheld!.stalenessReasons).toContain("package-version-changed");
    expect(staleBuild.report.cells[0]!.decisions.some(decision => decision.packageName === "es-toolkit")).toBe(false);

    // With no decision, the bundler's own report says the installed package is uncovered, and the
    // compile is rejected — the artifact is not produced from stale evidence.
    const codes = diagnosticCodes(staleBuild, 0);
    expect(codes).toContain("unresolved-dependency-decision");
    expect(staleBuild.report.cells[0]!.status).toBe("rejected");
    expect(staleBuild.report.cells[0]!.artifact).toBeNull();

    expect(() => planProject(staleBuild)).toThrow(ProjectPlanError);
    expect(() => planProject(staleBuild)).toThrow(/unresolved-dependency-decision/);
    const { port, writes } = recordingDesignerPort();
    await expect(syncProject(staleBuild, { port })).rejects.toThrow(/did not compile/);
    expect(writes).toHaveLength(0);
  }, CASE_TIMEOUT_MS);
});

describe("local / mock MCP port — fault injection (d): partial write, retry, and a designer edit", () => {
  it("local: a write whose ack fails is retried as unchanged, and a later edit is refused", async () => {
    const cells = new Map<string, { code: string; frontendLibraries: readonly { libraryId: string }[] }>();
    const writes: { pageName: string; cell: string }[] = [];
    let failNextWrite = true;
    const keyOf = (pageName: string, cell: string) => `${pageName}\u0000${cell}`;

    const port: ForguncySyncPort = {
      listFrontendLibraries: async () => [],
      readCellSource: async request => {
        const found = cells.get(keyOf(request.pageName, request.cell));
        return found === undefined
          ? { kind: "blank" }
          : { kind: "react-cell", code: found.code, frontendLibraries: found.frontendLibraries };
      },
      setCells: async request => {
        for (const cell of request.cells) {
          cells.set(keyOf(request.pageName, cell.cell), {
            code: cell.cellTypeProps.code,
            frontendLibraries: cell.cellTypeProps.frontendLibraries,
          });
          writes.push({ pageName: request.pageName, cell: cell.cell });
        }
        if (failNextWrite) {
          // The designer applied the write and the acknowledgement was lost: the dangerous case
          // #93's `unknown-write-state` names.
          failNextWrite = false;
          throw new Error("simulated transport failure after the write landed");
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

    // First attempt: the write is sent, lands, and the ack fails. The batch stops before target 2.
    const first = await syncProject(main.build, { port, portDescription: "failing-then-recording" });
    expect(first.cells.map(cell => cell.status)).toEqual(["transport-failure", "not-attempted"]);
    expect(first.cells[0]!.transportFailure?.mutationState).toBe("unknown-write-state");
    expect(first.stoppedEarly).toBe(true);
    expect(writes).toHaveLength(1);

    // Retry: target 1 re-reads as identical and issues no second write; target 2 is written.
    const retry = await syncProject(main.build, { port, portDescription: "failing-then-recording" });
    expect(retry.cells.map(cell => cell.status)).toEqual(["unchanged", "written"]);
    expect(retry.stoppedEarly).toBe(false);
    expect(writes).toHaveLength(2);
    expect(writes[0]!.cell).toBe("B2");
    expect(writes[1]!.cell).toBe("C3");

    // A designer then edits the first Cell's generated code, leaving the marker in place. The
    // marker's hash no longer matches, so the next sync refuses rather than overwriting the edit.
    const firstTargetKey = keyOf("销售看板", "B2");
    const edited = cells.get(firstTargetKey);
    expect(edited).toBeDefined();
    cells.set(firstTargetKey, { ...edited!, code: `${edited!.code}\n// designer edit\n` });

    const refused = await syncProject(main.build, { port, portDescription: "designer-edited" });
    expect(refused.cells.map(cell => cell.status)).toEqual(["refused", "unchanged"]);
    expect(refused.cells[0]!.diagnostics.map(diagnostic => diagnostic.code)).toContain("cell-diverged");
    expect(writes).toHaveLength(2);
  }, CASE_TIMEOUT_MS);
});
