/**
 * Multi-Cell isolation, live props, and teardown — executed artifacts, one realm.
 *
 * Decision source: GitHub Issue #83 — "验证并修复 Runtime：多 Cell 隔离、props 更新与卸载生命周期"
 * (https://github.com/MangMax/forguncy-react-workspace/issues/83), under #81 and on
 * #82's execution seam (`runtime-binding.test.ts`, whose `runCellArtifact` this file
 * follows).
 *
 * ## What this file is for, and what it refuses to assume
 *
 * #82 proved that *one* artifact installs a host provider and delegates through it.
 * Everything it left open is about *more than one*: two separately compiled Cells
 * rendered in the same JS realm, a re-render under new props without a re-evaluated
 * module, an async command callback that resolves while another Cell renders, and
 * teardown. #83's Spec is explicit that none of those may be *claimed* from the
 * module-slot audit alone: the slot is per copy, but "per copy" is a statement about
 * packaging (the façade is flattened per Cell, #14), not about whether two copies in
 * one realm behave. So every assertion here executes a real compiled artifact and
 * compares the values the façade returned, exactly as #83's first acceptance
 * criterion demands.
 *
 * ## Why two *separately compiled* Cells, not the same code twice
 *
 * The suspected failure is a *shared* slot: if the runtime module were hoisted to a
 * page global (or if a Cell could reach another Cell's copy), whichever Cell installed
 * last would answer for both. Two evaluations of one artifact cannot show that, because
 * one artifact always carries one copy. Compiling A and B separately — each inlining
 * its own copy of the workspace façade (#14) — is what makes "A reads B's props"
 * observable at all.
 *
 * ## The host values are traceable, and composed inside the sandbox realm
 *
 * Each Cell's host stub records its calls into a **per-Cell** array captured in the
 * stub's own closure, and stamps every recording with the Cell's key. That is what
 * makes a cross-Cell call visible rather than merely suspicious: a Cell whose façade
 * resolved to the other Cell's provider lands its call in the other Cell's array,
 * under the other Cell's data-source name and permission. The values are composed by
 * a script that runs *in* the context for the reason #82 recorded: the façade refuses
 * a permission map whose prototype is not a plain record's, so a host literal built in
 * the test realm would be refused by the façade's own correct check and read as a
 * defect.
 *
 * ## Local evidence only
 *
 * These are `local` checks in #4's vocabulary. They do not establish what a real
 * Forguncy page does — in particular whether the platform re-evaluates the artifact per
 * render or re-invokes `App` with new props is `RUNTIME_CONTRACT_UNKNOWNS`'
 * `artifact-re-evaluated-per-render`, still owed to #84. Both branches are exercised
 * here so the artifact is correct under either; the branch that cannot be settled
 * locally is named in the final describe block rather than presented as compatibility.
 * AGENTS.md rules 6–7 apply.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, Script } from "node:vm";

import { findCellHostRuntimeFact, openRuntimeContractQuestions } from "@forguncy-react-workspace/core";
import type { DependencyDecision } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

import { compileCell } from "./artifact.ts";
import type { CompileCellOutcome } from "./artifact.ts";
import { createRolldownCellBundler } from "./rolldown-bundler.ts";

const repositoryRoot = join(process.cwd());
/**
 * A directory the façade actually resolves from.
 *
 * The scratch entries have to live somewhere with a workspace link to
 * `@forguncy-react-workspace/runtime`; `examples/dev-harness` is such a project (its
 * `node_modules` links the runtime package), and the compiler is pointed at the
 * scratch directory rather than at the example. Writing into a temp directory *outside*
 * the workspace would make the façade unresolvable, and #82's `resolveCellSpecifier`
 * correctly refuses that rather than falling back to an unbound import.
 */
const scratchParent = join(repositoryRoot, "examples", "dev-harness");

/** `react` is `host`, so #9's bridge binds the page object; the façade is workspace source. */
const DEPENDENCIES: readonly DependencyDecision[] = [
  { strategy: "host", packageName: "react", globalName: "React" },
];

interface CellSpec {
  /** Distinguishes this Cell in every recorded host call. */
  readonly key: string;
  /** Its own data source name, permission name and command name. */
  readonly dataSource: string;
  readonly permission: string;
  readonly command: string;
}

const CELL_A: CellSpec = {
  key: "A",
  dataSource: "SalesA",
  permission: "A.Read",
  command: "CommandA",
};

const CELL_B: CellSpec = {
  key: "B",
  dataSource: "SalesB",
  permission: "B.Write",
  command: "CommandB",
};

/** One host profile, as values that are handed to the render. */
interface HostProfile {
  readonly key: string;
  readonly permissionName: string;
  readonly permissionGranted: boolean;
  readonly imageMarker: string;
  readonly rowMarker: string;
  readonly totalCount: number;
  readonly commandMarker: string;
}

/**
 * The host stub for one Cell, composed in the sandbox realm.
 *
 * Every recorded call carries `profile.key` from this stub's own closure, so a
 * delegation that reached the *other* Cell's provider is visible as a call filed under
 * the wrong key rather than as a difference nobody can attribute.
 *
 * `useDataSource` is the one host value that is a wrapper-local *hook*, not a prop:
 * it arrives through the binding's `useDataSource` channel, which is why the profile
 * does not carry it.
 */
function hostProfileScript(profile: HostProfile, commandName: string): string {
  const literals = {
    key: JSON.stringify(profile.key),
    permissionName: JSON.stringify(profile.permissionName),
    granted: JSON.stringify(profile.permissionGranted),
    imageMarker: JSON.stringify(profile.imageMarker),
    rowMarker: JSON.stringify(profile.rowMarker),
    totalCount: JSON.stringify(profile.totalCount),
    commandName: JSON.stringify(commandName),
    commandMarker: JSON.stringify(profile.commandMarker),
  };
  // Wrapped in an IIFE so two profile scripts in one realm do not collide on `const`
  // names: each run is a separate top-level script, and a top-level `const` is a
  // lexical binding of the context's global scope, not of the script.
  return `
(globalThis.__HOST_CALLS__ = globalThis.__HOST_CALLS__ || {});
(function () {
const calls = (globalThis.__HOST_CALLS__[${literals.key}] = { dataSources: [], commands: [] });
const permissions = (function () { const map = {}; map[${literals.permissionName}] = ${literals.granted}; return map; })();
const handle = {
  hasPermission: function (name) { return name === ${literals.permissionName} && ${literals.granted}; },
  getPermissions: function () { return permissions; },
};
const commands = (function () {
  const record = {};
  record[${literals.commandName}] = function (payload) {
    calls.commands.push([${literals.key}, payload]);
    return Promise.resolve({ errorCode: 0, errorMessage: "OK", marker: ${literals.commandMarker} });
  };
  return record;
})();
globalThis.__HOST_PROPS__ = {
  Forguncy: handle,
  Permissions: permissions,
  ServerCommands: commands,
  ImageContext: { marker: ${literals.imageMarker} },
};
globalThis.__HOST_HOOK__ = function (dataSourceName, options) {
  calls.dataSources.push([${literals.key}, dataSourceName, options]);
  return { data: [{ 月份: ${literals.rowMarker} }], totalCount: ${literals.totalCount}, loading: false, error: null };
};
})();
`;
}

/** A replacement profile, composed in the realm so the façade's prototype check passes. */
function nextPropsScript(profile: HostProfile): string {
  return `
globalThis.__NEXT_PROPS__ = {
  Forguncy: {
    hasPermission: function (name) { return name === ${JSON.stringify(profile.permissionName)} && ${JSON.stringify(profile.permissionGranted)}; },
    getPermissions: function () { const map = {}; map[${JSON.stringify(profile.permissionName)}] = ${JSON.stringify(profile.permissionGranted)}; return map; },
  },
  Permissions: (function () { const map = {}; map[${JSON.stringify(profile.permissionName)}] = ${JSON.stringify(profile.permissionGranted)}; return map; })(),
  ServerCommands: {
    ${profile.key === CELL_A.key ? CELL_A.command : CELL_B.command}: function (payload) {
      (globalThis.__NEXT_CALLS__ = globalThis.__NEXT_CALLS__ || []).push([${JSON.stringify(profile.key)}, payload]);
      return Promise.resolve({ errorCode: 0, errorMessage: "OK", marker: ${JSON.stringify(profile.commandMarker)} });
    },
  },
  ImageContext: { marker: ${JSON.stringify(profile.imageMarker)} },
};
`;
}

function cellSourceFor(spec: CellSpec): string {
  return `
import { runtimeFacade } from "@forguncy-react-workspace/runtime";

export function App() {
  const facade = runtimeFacade();
  const summary = facade.useDataSource(${JSON.stringify(spec.dataSource)}, { top: 2 });
  const granted = facade.hasPermission(${JSON.stringify(spec.permission)});
  const permissions = facade.getPermissions();
  const image = facade.cellProp("ImageContext");
  return (
    <section data-cell={${JSON.stringify(spec.key)}}>
      <span data-rows>{JSON.stringify(summary.data)}</span>
      <span data-total>{String(summary.totalCount)}</span>
      <span data-granted>{String(granted)}</span>
      <span data-permissions>{JSON.stringify(permissions)}</span>
      <span data-image>{JSON.stringify(image)}</span>
      <button
        type="button"
        onClick={() => {
          void facade.invokeServerCommand(${JSON.stringify(spec.command)}, { from: ${JSON.stringify(spec.key)} });
        }}
      >
        run
      </button>
    </section>
  );
}
`;
}

function compileCellSource(spec: CellSpec, directory: string): Promise<CompileCellOutcome> {
  const entry = join(directory, `${spec.key}.tsx`);
  writeFileSync(entry, cellSourceFor(spec));
  return compileCell(
    { entry, dependencies: [...DEPENDENCIES] },
    { bundler: createRolldownCellBundler({ dir: directory }) },
  );
}

function compiledCode(outcome: CompileCellOutcome): string {
  if (outcome.status !== "compiled") {
    throw new Error(
      `Expected the Cell to compile; it was rejected with:\n${outcome.diagnostics
        .map(diagnostic => `  - ${diagnostic.code}: ${diagnostic.message}`)
        .join("\n")}`,
    );
  }
  return outcome.artifact.code;
}

// ---------------------------------------------------------------------------
// Executing artifacts in one realm
// ---------------------------------------------------------------------------

interface CellElement {
  readonly type: unknown;
  readonly props: Readonly<Record<string, unknown>>;
}

/**
 * One artifact evaluation: the `App` the platform resolves, its own host call log, and
 * a render entry point.
 *
 * `render` closes over this evaluation's own `App` and performs no re-evaluation, which
 * is exactly the "the platform evaluated the artifact once and re-invokes App" branch.
 * `renderWithProps` is the same entry with a fresh props object supplied by the page —
 * the property-change branch — and it is what #83's second acceptance criterion is about.
 */
interface MountedEvaluation {
  readonly key: string;
  readonly render: () => unknown;
  readonly renderWithProps: (propsName: string) => unknown;
  readonly logged: readonly unknown[];
  readonly resolutionErrorCode: () => string | undefined;
}

const REACT_STUB = `
globalThis.React = {
  version: "19.2.7",
  Fragment: Symbol.for("react.fragment"),
  createElement: function (type, props) { return { type: type, props: props || {} }; },
  useState: function (initial) { return [initial, function () {}]; },
  useEffect: function () {},
  useMemo: function (factory) { return factory(); },
  useRef: function (value) { return { current: value }; },
  useCallback: function (callback) { return callback; },
};
`;

interface PageRealm {
  readonly context: ReturnType<typeof createContext>;
  readonly sandbox: Record<string, unknown>;
  readonly logged: readonly unknown[];
  /** Runs one sandbox script, composed by this file — never by the Cell. */
  readonly run: (source: string, filename: string) => void;
}

function createPageRealm(): PageRealm {
  const logged: unknown[] = [];
  const sandbox: Record<string, unknown> = {
    console: {
      error: (...args: unknown[]) => {
        logged.push(args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
      },
      log: () => undefined,
      warn: () => undefined,
    },
  };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  new Script(REACT_STUB, { filename: "page-react.js" }).runInContext(context);
  return {
    context,
    sandbox,
    logged,
    run: (source, filename) => {
      new Script(source, { filename }).runInContext(context);
    },
  };
}

/**
 * Evaluates one compiled artifact the way `CELL_SOURCE_EXECUTION_MODEL` records.
 *
 * The arrow IIFE declares the wrapper-locals from the page's `globalThis` values and
 * returns the `App` binding, so two evaluations in one realm get separate function
 * scopes — the per-Cell compilation scope, not a page-wide variable. (`props` and
 * `useDataSource` are free identifiers inside the artifact for the recorded reason: they
 * are wrapper-locals and `props` is never a window property.)
 */
function evaluateArtifact(realm: PageRealm, code: string, key: string): MountedEvaluation {
  // `return App` rather than a synthetic `React.createElement(...)` binding, and that
  // fidelity is load-bearing here: `CELL_ENTRY_RESOLUTION_ORDER` resolves the `App`
  // binding *from the cell source*, and the generated entry wrapper is part of it. A
  // harness that called a synthetic App of its own would never execute the wrapper's
  // live-props assignment, so the props-update case would pass or fail for a reason that
  // has nothing to do with the artifact. (The two fixtures above always use the default
  // `app-function-declaration` shape, so `App` is declared in the artifact's own scope.)
  const wrapper = [
    `(function () {`,
    `  const props = globalThis.__HOST_PROPS__;`,
    `  const useDataSource = globalThis.__HOST_HOOK__;`,
    code,
    `  return App;`,
    `})()`,
  ].join("\n");

  const App = new Script(wrapper, { filename: `cell-artifact-${key}.js` }).runInContext(
    realm.context,
  ) as (props: unknown) => CellElement;

  /**
   * The Cell's own props object, as it was when this evaluation ran.
   *
   * Each Cell in a real page holds its own props; the harness's single
   * `__HOST_PROPS__` slot is overwritten when the *next* Cell's page script runs, and
   * passing that overwritten value back to this evaluation would hand A B's props — a
   * harness artifact rather than a Cell defect. Rendering therefore defaults to the
   * object this evaluation captured, and only the explicit props-replacement case passes
   * a different one.
   */
  const capturedProps = realm.sandbox.__HOST_PROPS__;

  let lastError: unknown;
  const renderWithPropsValue = (props: unknown): unknown => {
    const element = App(props);
    const component = element.type as (props: unknown) => unknown;
    try {
      return expandTree(component(element.props));
    } catch (error) {
      lastError = error;
      throw error;
    }
  };
  const renderWithProps = (propsName: string): unknown =>
    renderWithPropsValue((realm.sandbox as Record<string, unknown>)[propsName]);

  return {
    key,
    render: () => renderWithPropsValue(capturedProps),
    renderWithProps,
    logged: realm.logged,
    resolutionErrorCode: () => {
      const code = (lastError as { code?: unknown } | undefined)?.code;
      return typeof code === "string" ? code : undefined;
    },
  };
}

/** Function components are invoked by hand, as React would; the page contributes no element here. */
function expandTree(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(child => expandTree(child));
  if (typeof node !== "object" || node === null || !("type" in node) || !("props" in node)) {
    return node;
  }
  const element = node as CellElement;
  if (typeof element.type === "function") {
    return expandTree((element.type as (props: unknown) => unknown)(element.props));
  }
  return { type: element.type, props: { ...element.props, children: expandTree(element.props.children) } };
}

function flattenText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) flattenText(item, out);
    return out;
  }
  if (typeof node === "object" && node !== null && "props" in node) {
    flattenText((node as CellElement).props.children, out);
  }
  return out;
}

function findElements(node: unknown, hasProp: string, out: CellElement[] = []): CellElement[] {
  if (Array.isArray(node)) {
    for (const item of node) findElements(item, hasProp, out);
    return out;
  }
  if (typeof node === "object" && node !== null && "type" in node && "props" in node) {
    const element = node as CellElement;
    if (element.props[hasProp] !== undefined) out.push(element);
    findElements(element.props.children, hasProp, out);
  }
  return out;
}

function renderedText(node: unknown): string {
  return flattenText(node).join("|");
}

interface HostCallLog {
  readonly dataSources: readonly (readonly [string, string, unknown])[];
  readonly commands: readonly (readonly [string, unknown])[];
}

function hostCallsOf(realm: PageRealm, key: string): HostCallLog {
  const all = (realm.sandbox.__HOST_CALLS__ ?? {}) as Record<string, HostCallLog>;
  return all[key] ?? { dataSources: [], commands: [] };
}

function nextCalls(realm: PageRealm): readonly (readonly [string, unknown])[] {
  const calls = (realm.sandbox.__NEXT_CALLS__ as readonly (readonly [string, unknown])[] | undefined) ?? [];
  return calls;
}

/**
 * Compiles the two Cells once per file and hands out fresh codes plus a cleanup handle.
 *
 * Compiling is the expensive half of every case here, and each case evaluates the same
 * two compiled artifacts with its own host profiles — so the compile happens once, in a
 * scratch directory removed when the file finishes.
 */
async function compileAB(): Promise<{ codeA: string; codeB: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(scratchParent, ".tmp-lifecycle-"));
  try {
    const [a, b] = await Promise.all([
      compileCellSource(CELL_A, dir),
      compileCellSource(CELL_B, dir),
    ]);
    return {
      codeA: compiledCode(a),
      codeB: compiledCode(b),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Two separately compiled Cells in one realm
// ---------------------------------------------------------------------------

describe("two separately compiled Cells in one JS realm", () => {
  it("returns each Cell's own host values, interleaved and repeated", async () => {
    const { codeA, codeB, cleanup } = await compileAB();
    try {
      const realm = createPageRealm();
      realm.run(hostProfileScript(profileA1(), CELL_A.command), "page-host-a1.js");
      const mountedA = evaluateArtifact(realm, codeA, "A");

      realm.run(hostProfileScript(profileB1(), CELL_B.command), "page-host-b1.js");
      const mountedB = evaluateArtifact(realm, codeB, "B");

      const textA = renderedText(mountedA.render());
      const textB = renderedText(mountedB.render());
      // Render A again after B: the second A render must still resolve A's provider.
      const textAAgain = renderedText(mountedA.render());

      expect(textA).toContain("A-row-A1");
      expect(textA).toContain('"A.Read":true');
      expect(textA).toContain("A-image-A1");
      expect(textB).toContain("B-row-B1");
      expect(textB).toContain('"B.Write":true');
      expect(textB).toContain("B-image-B1");
      expect(textAAgain).toContain("A-row-A1");

      // The data-source calls are the traceable half: each Cell reached its own host
      // closure, with its own data-source name. A cross-Cell provider would file the call
      // under the other key and the other name.
      expect(hostCallsOf(realm, "A").dataSources).toEqual([
        ["A", "SalesA", { top: 2 }],
        ["A", "SalesA", { top: 2 }],
      ]);
      expect(hostCallsOf(realm, "B").dataSources).toEqual([["B", "SalesB", { top: 2 }]]);
    } finally {
      cleanup();
    }
  });

  it("does not let one Cell's host binding answer the other's permission or command calls", async () => {
    const { codeA, codeB, cleanup } = await compileAB();
    try {
      const realm = createPageRealm();
      realm.run(hostProfileScript(profileA1(), CELL_A.command), "page-host-a1.js");
      const mountedA = evaluateArtifact(realm, codeA, "A");
      realm.run(hostProfileScript(profileB1(), CELL_B.command), "page-host-b1.js");
      const mountedB = evaluateArtifact(realm, codeB, "B");

      const textA = renderedText(mountedA.render());
      const textB = renderedText(mountedB.render());

      // A asks about `A.Read` and B about `B.Write`. If either façade resolved the other's
      // provider, the profile it reached would answer `false` for the name it asked.
      expect(textA).toContain('"A.Read":true');
      expect(textB).toContain('"B.Write":true');
      expect(textA).not.toContain("B.Write");
      expect(textB).not.toContain("A.Read");

      // Command records are the other per-Cell address. Both buttons are fired, one after
      // the other, and each payload must land in its own Cell's log.
      fireRunButton(mountedA.render());
      fireRunButton(mountedB.render());
      await drainMicrotasks();

      expect(hostCallsOf(realm, "A").commands).toEqual([["A", { from: "A" }]]);
      expect(hostCallsOf(realm, "B").commands).toEqual([["B", { from: "B" }]]);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Props replacement without re-evaluating the artifact
// ---------------------------------------------------------------------------

describe("a re-render under new props without re-evaluating the artifact", () => {
  it("reads the new props, not the ones installed when the artifact was evaluated", async () => {
    const { codeA, cleanup } = await compileAB();
    try {
      const realm = createPageRealm();
      realm.run(hostProfileScript(profileA1(), CELL_A.command), "page-host-a1.js");
      const mounted = evaluateArtifact(realm, codeA, "A");

      expect(renderedText(mounted.render())).toContain('"A.Read":true');
      expect(renderedText(mounted.render())).toContain("A-image-A1");

      // The page replaces the props and re-renders the existing instance. The artifact's
      // modules are **not** re-evaluated — this is the `artifact-re-evaluated-per-render`
      // branch in which the platform keeps one App closure and passes new props.
      realm.run(nextPropsScript(profileA2()), "page-host-a2.js");
      const after = renderedText(mounted.renderWithProps("__NEXT_PROPS__"));

      expect(after).toContain('"A.Read":false');
      expect(after).toContain("A-image-A2");

      // The async command path is the interesting one: a handler invoked *after* the prop
      // change must reach the new command record rather than the first evaluation's one.
      fireRunButton(mounted.renderWithProps("__NEXT_PROPS__"));
      await drainMicrotasks();
      expect(nextCalls(realm)).toEqual([["A", { from: "A" }]]);
      expect(hostCallsOf(realm, "A").commands).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("keeps the async result inside this Cell when another Cell renders meanwhile", async () => {
    const { codeA, codeB, cleanup } = await compileAB();
    try {
      const realm = createPageRealm();
      realm.run(hostProfileScript(profileA1(), CELL_A.command), "page-host-a1.js");
      const mountedA = evaluateArtifact(realm, codeA, "A");
      realm.run(hostProfileScript(profileB1(), CELL_B.command), "page-host-b1.js");
      const mountedB = evaluateArtifact(realm, codeB, "B");

      const treeA = mountedA.render();
      fireRunButton(treeA);

      // B renders while A's command promise is still pending. The resolution must not
      // reach through B's provider.
      const treeB = mountedB.render();
      await drainMicrotasks();

      expect(hostCallsOf(realm, "A").commands).toEqual([["A", { from: "A" }]]);
      expect(hostCallsOf(realm, "B").commands).toEqual([]);
      expect(renderedText(treeB)).toContain("B-row-B1");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Teardown and error paths
// ---------------------------------------------------------------------------

describe("teardown and failure of one Cell", () => {
  it("leaves a surviving Cell working, and does not clear its provider", async () => {
    const { codeA, codeB, cleanup } = await compileAB();
    try {
      const realm = createPageRealm();
      realm.run(hostProfileScript(profileA1(), CELL_A.command), "page-host-a1.js");
      const mountedA = evaluateArtifact(realm, codeA, "A");
      realm.run(hostProfileScript(profileB1(), CELL_B.command), "page-host-b1.js");
      const mountedB = evaluateArtifact(realm, codeB, "B");

      expect(renderedText(mountedA.render())).toContain("A-row-A1");

      // The recorded teardown renders null into the Cell's own root; the generated binding
      // installs and never uninstalls, so dropping A must not reach any shared state. Rendering
      // B afterwards — and A once more, as a stale handle would — both still resolve their own
      // providers.
      expect(renderedText(mountedB.render())).toContain("B-row-B1");
      expect(renderedText(mountedA.render())).toContain("A-row-A1");
      expect(hostCallsOf(realm, "A").dataSources).toHaveLength(2);
      expect(hostCallsOf(realm, "B").dataSources).toEqual([["B", "SalesB", { top: 2 }]]);
    } finally {
      cleanup();
    }
  });

  it("reports A's broken host without polluting B's provider", async () => {
    const { codeA, codeB, cleanup } = await compileAB();
    try {
      const realm = createPageRealm();
      // A's page is wired wrong: the handle it reaches permissions through is absent.
      realm.run(hostProfileScript(profileA1(), CELL_A.command) + "\ndelete globalThis.__HOST_PROPS__.Forguncy;", "page-host-broken-a.js");
      const mountedA = evaluateArtifact(realm, codeA, "A");

      realm.run(hostProfileScript(profileB1(), CELL_B.command), "page-host-b1.js");
      const mountedB = evaluateArtifact(realm, codeB, "B");

      expect(() => mountedA.render()).toThrowError(/provider does not carry "Forguncy"/);
      expect(mountedA.resolutionErrorCode()).toBe("provider-binding-missing");

      // B is untouched: the failure stayed in A's copy, and B's render still delegates.
      expect(renderedText(mountedB.render())).toContain("B-row-B1");
      expect(hostCallsOf(realm, "B").dataSources).toEqual([["B", "SalesB", { top: 2 }]]);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Re-evaluation (HMR / remount) and multiple evaluations
// ---------------------------------------------------------------------------

describe("re-evaluation and multiple instances", () => {
  it("serves the fresh props on an HMR-style re-evaluation", async () => {
    const { codeA, cleanup } = await compileAB();
    try {
      const realm = createPageRealm();
      realm.run(hostProfileScript(profileA1(), CELL_A.command), "page-host-a1.js");
      const first = evaluateArtifact(realm, codeA, "A");
      expect(renderedText(first.render())).toContain("A-row-A1");

      // A module re-evaluation (the artifact form of an HMR pass) installs again with the
      // values the page holds *now*. Installing the same provider kind is what makes this
      // normal rather than an environment conflict.
      realm.run(hostProfileScript(profileA2(), CELL_A.command), "page-host-a2.js");
      const second = evaluateArtifact(realm, codeA, "A");
      expect(renderedText(second.render())).toContain("A-row-A2");

      // The previously evaluated copy is still a separate copy with its own slot: nothing
      // about the re-evaluation cleared the older instance's provider.
      expect(renderedText(first.render())).toContain("A-row-A1");
    } finally {
      cleanup();
    }
  });

  it("keeps two evaluations of one compiled artifact separate", async () => {
    const { codeA, cleanup } = await compileAB();
    try {
      const realm = createPageRealm();
      // Each evaluation gets its own host profile key, so the two logs are attributable:
      // this case is about two *evaluations* of one artifact, and a shared key would make
      // a call filed under the wrong one indistinguishable from a call filed twice.
      realm.run(hostProfileScript(profileA1(), CELL_A.command), "page-host-a1.js");
      const first = evaluateArtifact(realm, codeA, "A");

      realm.run(hostProfileScript(profileA3(), CELL_A.command), "page-host-a3.js");
      const second = evaluateArtifact(realm, codeA, "A3");

      expect(renderedText(first.render())).toContain("A-row-A1");
      expect(renderedText(second.render())).toContain("A-row-A3");

      // The artifact string is the same and the rendered values are not, so each
      // evaluation carries its own copy of the façade and its own slot — the per-cell
      // scope `CELL_SOURCE_EXECUTION_MODEL.perCellCompilationScope` records is what does
      // it. A shared slot would have handed whichever was installed last to both.
      expect(hostCallsOf(realm, "A").dataSources).toEqual([["A", "SalesA", { top: 2 }]]);
      expect(hostCallsOf(realm, "A3").dataSources).toEqual([["A3", "SalesA", { top: 2 }]]);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Not settled locally — owed to #84
// ---------------------------------------------------------------------------

describe("lifecycle questions left to real Forguncy validation (#84)", () => {
  it("records what a local run cannot decide, against the contract that owns it", () => {
    // Nothing here re-runs Forguncy. It asserts *where* the remaining questions are
    // recorded, so this file's green run cannot be read as an answer to them:
    //
    // 1. Which branch the platform takes on a property change — re-evaluating the artifact
    //    or re-invoking `App` — is `RUNTIME_CONTRACT_UNKNOWNS.artifact-re-evaluated-per-render`,
    //    now owned by #84. Both branches are exercised above, so the artifact is correct
    //    either way; only the observation is missing.
    // 2. Whether teardown reaches the artifact at all. `unmount-clears-the-cell-root` is
    //    recorded with `product-runtime-source` evidence — read from the runtime source, not
    //    executed — which is exactly why the binding installs no teardown and this file only
    //    proves that dropping one instance does not disturb another.
    // 3. One `new Function` evaluation serving two simultaneously rendered instances of one
    //    artifact: `one-react-root-per-cell` makes that shape unavailable on a recorded page,
    //    so the evaluation — not the React root — is this file's isolation unit.
    const questionsOwnedByRealValidation = openRuntimeContractQuestions("#84").map(unknown => unknown.id);
    expect(questionsOwnedByRealValidation).toContain("artifact-re-evaluated-per-render");
    expect(findCellHostRuntimeFact("unmount-clears-the-cell-root").evidence).toEqual([
      "product-runtime-source",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by the cases above
// ---------------------------------------------------------------------------

function profileA1(): HostProfile {
  return {
    key: "A",
    permissionName: "A.Read",
    permissionGranted: true,
    imageMarker: "A-image-A1",
    rowMarker: "A-row-A1",
    totalCount: 120,
    commandMarker: "A-command-A1",
  };
}

/** A new props object for the same Cell: same names, different values. */
function profileA2(): HostProfile {
  return {
    key: "A",
    permissionName: "A.Read",
    permissionGranted: false,
    imageMarker: "A-image-A2",
    rowMarker: "A-row-A2",
    totalCount: 60,
    commandMarker: "A-command-A2",
  };
}

/** A third profile for the *same* Cell: a second evaluation of one compiled artifact. */
function profileA3(): HostProfile {
  return {
    key: "A3",
    permissionName: "A.Read",
    permissionGranted: true,
    imageMarker: "A-image-A3",
    rowMarker: "A-row-A3",
    totalCount: 30,
    commandMarker: "A-command-A3",
  };
}

function profileB1(): HostProfile {
  return {
    key: "B",
    permissionName: "B.Write",
    permissionGranted: true,
    imageMarker: "B-image-B1",
    rowMarker: "B-row-B1",
    totalCount: 240,
    commandMarker: "B-command-B1",
  };
}

function fireRunButton(tree: unknown): void {
  const button = findElements(tree, "onClick").find(element =>
    flattenText(element.props.children).includes("run"),
  );
  expect(button).toBeDefined();
  if (button === undefined) return;
  (button.props.onClick as () => void)();
}

/** A macrotask boundary, so every `await` in the command path has drained. */
function drainMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
