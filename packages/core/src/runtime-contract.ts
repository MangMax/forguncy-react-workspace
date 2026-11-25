/**
 * The verified ReactCellType target/runtime contract.
 *
 * Decision source: GitHub Issue #5 — "Research: establish the ReactCellType
 * target/runtime contract on Forguncy 12.0.100"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/5).
 *
 * Repository rules put Specs in Issues and forbid a duplicated `specs/` tree, so
 * the evidence lives in that Issue. This module exists because a prose comment is
 * not reproducible project state: the artifact Spec (#6), the compiler (#7) and
 * the Agent dependency-selection flow (#18) need to *assert* these facts rather
 * than remember them.
 *
 * Every fact names the channel it was observed through. `RuntimeEvidenceChannel`
 * deliberately has no "assumption" / "expected" / "likely" member, so a claim that
 * was never observed cannot be recorded here without inventing an evidence
 * channel. Questions that are genuinely still open live in
 * `RUNTIME_CONTRACT_UNKNOWNS` instead of being guessed into the contract.
 *
 * Read the evidence channels as follows:
 *
 * - `product-runtime-source` — read from the shipped runtime script of the
 *   product, not from a summary of it.
 * - `product-documentation` — read from the API documentation the product itself
 *   serves to its AI surface.
 * - `designer-api` — produced by executing a designer operation against a real
 *   project.
 * - `generated-runtime-browser` — observed in a real browser against the
 *   generated dev site.
 *
 * Scope note: this module states the *target's* behaviour. It deliberately does
 * not decide the generated artifact's shape (#6), measure the code budget (#21),
 * or describe local development (#22).
 */

// The two key tuples the production runtime needs live in their own leaf module (#124), so a
// Cell artifact can read them without loading this file's evidence record. This module is their
// consumer, not their owner, and it re-exports them unchanged.
import { CELL_FORGUNCY_PROP_KEYS, CELL_PROPS_BASE_KEYS } from "./cell-props.ts";
import type { ArchitectureDecisionSource } from "./governance.ts";
import { RUNTIME_CONTRACT_DECISION } from "./governance.ts";

export type RuntimeEvidenceChannel = (typeof RUNTIME_EVIDENCE_CHANNELS)[number];

/**
 * The evidence vocabulary.
 *
 * Exported as data rather than only as a type so the invariant guard and any
 * future lint share one definition, the same way `DEPENDENCY_STRATEGIES` is
 * shared in `strategy.ts`. There is deliberately no "assumption" / "expected" /
 * "likely" member: a claim that was never observed cannot be recorded without
 * inventing a channel, and the guard rejects a channel outside this list.
 */
export const RUNTIME_EVIDENCE_CHANNELS = [
  "product-runtime-source",
  "product-documentation",
  "designer-api",
  "generated-runtime-browser",
] as const;

// ---------------------------------------------------------------------------
// Pinned target
// ---------------------------------------------------------------------------

/**
 * The exact target the contract was established against.
 *
 * Pinned rather than described, because a contract without a version is a
 * claim about "Forguncy" in the abstract, and Forguncy ships its own React and
 * transpiler per version.
 *
 * ## Which version, and how the re-bases were measured
 *
 * The target was established against `12.0.100.0` (#5), re-based on `12.0.101.0` and then on
 * `12.0.102.0` — the version actually in use. Each rebase is **measured, not renamed**, and the
 * measurements are on #120; each field's basis is in
 * {@link RUNTIME_CONTRACT_TARGET_FIELD_SOURCES}, which is data a consumer can read rather than a
 * paragraph it has to trust.
 *
 * Re-measured on `12.0.102.0` (live designer session and real generated page, 2026-11-22/23):
 * `productVersion` and `productBuild` from the installed assembly; the plugin GUID, its resource
 * paths and its script size; the designer operations this contract's flows make; and — this time
 * in a **real browser** against generated pages — `React.version`, `ReactDOM.version` and
 * `Babel.version`. That closes the observation `12.0.101.0` left open: the versions were read
 * from the shipped runtime source on that build, so `generated-runtime-browser` was removed from
 * `evidence` there and carried as an open question rather than left over from #5's `12.0.100.0`
 * run. On `12.0.102.0` the page itself reported the same three values, so that channel is back in
 * `evidence` and {@link RUNTIME_CONTRACT_TARGET_FIELDS_NOT_BROWSER_OBSERVED} is empty.
 *
 * A build whose browser observation had *not* been made must keep `generated-runtime-browser` out
 * of `evidence` and name its version fields in that list; `12.0.101.0` is the recorded example of
 * that state, and `12.0.102.0` is the first re-base where it does not apply.
 */
export interface RuntimeContractTarget {
  readonly product: string;
  readonly productVersion: string;
  readonly productBuild: string;
  readonly hostReactVersion: string;
  readonly hostReactDomVersion: string;
  readonly browserTranspiler: string;
  readonly browserTranspilerVersion: string;
  readonly reactCellTypePluginGuid: string;
  readonly decision: ArchitectureDecisionSource;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

export const RUNTIME_CONTRACT_TARGET: RuntimeContractTarget = {
  product: "Forguncy",
  productVersion: "12.0.102.0",
  productBuild: "12.0.102.0+5fc2e42710b205ebfa26ce76403e2134810f04cd",
  hostReactVersion: "19.2.7",
  hostReactDomVersion: "19.2.7",
  browserTranspiler: "Babel standalone",
  browserTranspilerVersion: "7.29.4",
  reactCellTypePluginGuid: "96205a31-0c2e-4b98-9ce5-6555088e6cbd",
  decision: RUNTIME_CONTRACT_DECISION,
  // `product-runtime-source` because the plugin's shipped resources were read on this build;
  // `designer-api` because the designer operations were executed against it;
  // `generated-runtime-browser` because `React.version`, `ReactDOM.version` and `Babel.version`
  // were read from real generated pages on it. Not #5's list: this one is #120's `12.0.102.0`
  // re-measurement.
  evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
};

/** A field of {@link RUNTIME_CONTRACT_TARGET} that states something about the product. */
export type RuntimeContractTargetField = Exclude<keyof RuntimeContractTarget, "decision" | "evidence">;

/** One field's basis, as something a consumer can read rather than infer from a comment. */
export interface RuntimeContractTargetFieldSource {
  /**
   * The product build whose session produced the value.
   *
   * Equal to `RUNTIME_CONTRACT_TARGET.productVersion` when the value was measured here, and an
   * older build when it was carried forward. A consumer that must not present a field as
   * verified on the current build asks this rather than reading prose.
   */
  readonly observedOn: string;
  /** The channels that produced the value, for this field specifically. */
  readonly evidence: readonly RuntimeEvidenceChannel[];
  /**
   * Present exactly when `observedOn` is not the current `productVersion`, so a field cannot be
   * carried forward without that being stated here rather than implied by a mismatch.
   */
  readonly carriedForward?: true;
}

/**
 * Field-level provenance for {@link RUNTIME_CONTRACT_TARGET}.
 *
 * Why this is data and not a paragraph: `packages/runtime/src/local-dev.ts` reads
 * `RUNTIME_CONTRACT_TARGET.hostReactDomVersion` as the version the target ships and compares
 * the locally installed package against it, so a re-base that left a carried-forward value
 * there would hand that consumer a number it never checked. #116's review called this the
 * defect a comment cannot fix, and this is the machine-readable half of the fix: the target's
 * own `evidence` no longer claims the channel that was not exercised, and this table says per
 * field which build each value came from and through which channel.
 *
 * Total over the product-stating fields, asserted — a new field on the target that nobody gives
 * a source is the same unbacked claim this table exists to prevent.
 */
export const RUNTIME_CONTRACT_TARGET_FIELD_SOURCES: Readonly<
  Record<RuntimeContractTargetField, RuntimeContractTargetFieldSource>
> = {
  product: { observedOn: "12.0.102.0", evidence: ["designer-api"] },
  productVersion: { observedOn: "12.0.102.0", evidence: ["designer-api"] },
  productBuild: { observedOn: "12.0.102.0", evidence: ["designer-api"] },
  // Read from the plugin's shipped `react-vendor.production.min.js` **and** from a running page
  // (`React.version` / `ReactDOM.version` in a real browser) on this build.
  hostReactVersion: { observedOn: "12.0.102.0", evidence: ["product-runtime-source", "generated-runtime-browser"] },
  hostReactDomVersion: { observedOn: "12.0.102.0", evidence: ["product-runtime-source", "generated-runtime-browser"] },
  // Read from the plugin's shipped `babel.min.js` (version string 7.29.4) and from `Babel.version`
  // in a running page on this build.
  browserTranspiler: { observedOn: "12.0.102.0", evidence: ["product-runtime-source", "generated-runtime-browser"] },
  browserTranspilerVersion: { observedOn: "12.0.102.0", evidence: ["product-runtime-source", "generated-runtime-browser"] },
  // The GUID the plugin's resources are served under — unchanged from 12.0.100.0, and re-read
  // on this build from the resource URLs themselves.
  reactCellTypePluginGuid: { observedOn: "12.0.102.0", evidence: ["product-runtime-source", "designer-api"] },
};

/**
 * The target fields this build's evidence does **not** come from a browser observation.
 *
 * A separate list because these are the fields a machine consumer reads as "what the page
 * actually runs" (`LOCAL_DEV_VERSION_FIELDS` in the runtime package, and #5's React/ReactDOM
 * numbers). It is **empty on `12.0.102.0`**: `React.version`, `ReactDOM.version` and
 * `Babel.version` were read from real generated pages on this build, so every version field the
 * contract states is browser-observed here. The list stays exported rather than deleted because
 * the distinction is a property of a *re-base*, not of this build: a future build whose browser
 * observation is missing must name its fields here again, and consumers already branch on it.
 */
export const RUNTIME_CONTRACT_TARGET_FIELDS_NOT_BROWSER_OBSERVED: readonly RuntimeContractTargetField[] = [];

/** Short header for reports, PR bodies and diagnostics. */
export function describeRuntimeContractTarget(target: RuntimeContractTarget = RUNTIME_CONTRACT_TARGET): string {
  return `${target.product} ${target.productVersion} (${target.productBuild}) — host React ${target.hostReactVersion}, browser ${target.browserTranspiler} ${target.browserTranspilerVersion}`;
}

// ---------------------------------------------------------------------------
// Execution model
// ---------------------------------------------------------------------------

export interface CellSourceExecutionModel {
  /** How the cell source is transformed before it runs. */
  readonly transformCall: string;
  readonly transformPresets: readonly string[];
  /**
   * Transforms that are *not* applied. Their absence is the reason TypeScript
   * annotations, module syntax and un-transpiled language features cannot rely
   * on the platform to be lowered.
   */
  readonly missingTransforms: readonly string[];
  /** How the transformed source is bound to the host. */
  readonly hostBindingCall: string;
  /** The `new Function` parameters, in the order the runtime passes them. */
  readonly injectedParameters: readonly string[];
  /** How user source is additionally nested inside the function body. */
  readonly userCodeNesting: string;
  /** `new Function` gives each cell its own function scope. */
  readonly perCellCompilationScope: boolean;
  /** Declarations at the top level of a cell do not become page globals. */
  readonly topLevelDeclarationsReachGlobalThis: boolean;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

export const CELL_SOURCE_EXECUTION_MODEL: CellSourceExecutionModel = {
  transformCall: 'Babel.transform(source, { presets: ["react"] })',
  transformPresets: ["react"],
  missingTransforms: ["typescript", "preset-env", "module (import/export lowering)"],
  hostBindingCall:
    'new Function("React", "antd", "echarts", "dayjs", "ForguncyReactHelper", "__useDataSource", "__props", compiled + returnExpression)',
  injectedParameters: ["React", "antd", "echarts", "dayjs", "ForguncyReactHelper", "__useDataSource", "__props"],
  userCodeNesting:
    "an arrow IIFE inside the function body, which also declares props, useState, useEffect, useMemo, useRef, useCallback, useDataSource, DataSourceCompareType, DataSourceRelationType, __renderResult and render",
  perCellCompilationScope: true,
  topLevelDeclarationsReachGlobalThis: false,
  evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
};

// ---------------------------------------------------------------------------
// Host runtime across cells
// ---------------------------------------------------------------------------

export type CellHostRuntimeFactId =
  | "single-react-instance-per-page"
  | "shared-global-this"
  | "one-react-root-per-cell"
  | "context-does-not-cross-cells"
  | "initialisation-order-is-not-layout-order"
  | "unmount-clears-the-cell-root";

/**
 * A fact about the page the cells live in, rather than about one cell's source.
 *
 * These are the facts a downstream consumer needs in order to reason about *more
 * than one* cell at once.
 *
 * Two different kinds of locality are easy to conflate here, and this module keeps
 * them apart on purpose. Component state, hooks and React Context are local to a
 * cell *because* every cell is its own React root (`one-react-root-per-cell`,
 * `context-does-not-cross-cells`). JavaScript module identity is **not** covered by
 * that: page-global identity stays page-global, which is why
 * `FRONTEND_LIBRARY_RUNTIME_SEMANTICS.globalsArePageWide` is true and why
 * `strategy.ts` selects `extension` whenever shared module identity or a cross-cell
 * singleton is required. What is local to a cell is an *inlined copy* of a
 * dependency, and that locality comes from the per-cell `new Function` scope
 * (`CELL_SOURCE_EXECUTION_MODEL.perCellCompilationScope`), not from the React root.
 */
export interface CellHostRuntimeFact {
  readonly id: CellHostRuntimeFactId;
  readonly statement: string;
  /**
   * How to re-run the observation. Kept because these facts are the kind that a
   * later Forguncy version can silently change.
   */
  readonly howToObserve: string;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * The verified multi-cell host runtime behaviour.
 *
 * `generated-runtime-browser` here means the fact was produced by executing
 * probes on a page holding two or three React cells and reading the result back
 * out of the live document — not by reading the product source and reasoning
 * about it.
 */
export const CELL_HOST_RUNTIME_SEMANTICS: readonly CellHostRuntimeFact[] = [
  {
    id: "single-react-instance-per-page",
    statement:
      "Every cell receives the same host React object: there is one React instance for the whole page, not one per cell.",
    howToObserve:
      "Stamp a property on React from one cell and read it back from a second cell's entry; the second cell observes the first cell's stamp.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    id: "shared-global-this",
    statement:
      "All cells on a page share one globalThis, so state published on a page global is visible to every cell.",
    howToObserve:
      "Have each cell append to a page-level array on globalThis and compare the accumulated length at each entry execution.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    id: "one-react-root-per-cell",
    statement:
      "Each cell owns its own container element and its own ReactDOM root; cells are sibling roots rather than branches of one page-wide root.",
    howToObserve:
      "After the page settles, count the distinct elements carrying a __reactContainer$ property: one per React cell.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    id: "context-does-not-cross-cells",
    statement:
      "A React context provided inside one cell is not visible to another cell, even though both cells share the same React object and can reference the same context object.",
    howToObserve:
      "Publish a context on globalThis from cell A, provide a non-default value inside cell A, and read that same context object from cell B: cell B sees the default value.",
    evidence: ["generated-runtime-browser"],
  },
  {
    id: "initialisation-order-is-not-layout-order",
    statement: "Cell entry execution order is not the layout order of the cells on the page.",
    howToObserve:
      "Record an execution marker from every cell and compare the recorded order with the cell addresses; on the probe page the order was A, C, B for cells laid out at columns 1, 25 and 13.",
    evidence: ["generated-runtime-browser"],
  },
  {
    id: "unmount-clears-the-cell-root",
    statement: "Teardown renders null into the cell's own root instead of unmounting a shared page root.",
    howToObserve:
      "Not executed: read from the runtime teardown path. Observing it needs a live page navigation while watching a cell root.",
    evidence: ["product-runtime-source"],
  },
];

export function findCellHostRuntimeFact(id: CellHostRuntimeFactId): CellHostRuntimeFact {
  const fact = CELL_HOST_RUNTIME_SEMANTICS.find(candidate => candidate.id === id);
  if (!fact) {
    throw new Error(`Unknown ReactCellType host runtime fact "${id}".`);
  }
  return fact;
}

// ---------------------------------------------------------------------------
// Entry shapes
// ---------------------------------------------------------------------------

export type CellEntryKind =
  | "app-function-declaration"
  | "app-async-function-declaration"
  | "app-variable-assignment"
  | "app-arrow-assignment"
  | "app-class-component"
  | "render-call"
  | "top-level-element-variable"
  | "whole-source-expression"
  | "no-entry";

export interface CellEntryShape {
  readonly id: CellEntryKind;
  /** The source shape, described the way a generator would emit it. */
  readonly shape: string;
  /** Accepted by `api.page.setCells` against a real project. */
  readonly acceptedAtWriteTime: boolean;
  /** An element actually mounted in the generated runtime page. */
  readonly renderedAtRuntime: boolean;
  /** Set when the shape is accepted but does not work, or works but is not an entry. */
  readonly note?: string;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * The entry shapes a generator may emit, and the two it may not.
 *
 * `app-async-function-declaration` is the trap: the platform's write-time
 * validator accepts it, and React 19 then refuses it at runtime. A generator
 * that only validates against the designer API will ship a blank cell.
 */
export const CELL_ENTRY_SHAPES: readonly CellEntryShape[] = [
  {
    id: "app-function-declaration",
    shape: "function App(props) { ... }",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    evidence: ["designer-api", "generated-runtime-browser"],
  },
  {
    id: "app-variable-assignment",
    shape: "var App = function (props) { ... };",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    evidence: ["designer-api", "generated-runtime-browser"],
  },
  {
    id: "app-arrow-assignment",
    shape: "const App = (props) => <div />;",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    evidence: ["designer-api", "generated-runtime-browser"],
  },
  {
    id: "app-class-component",
    shape: "class App extends React.Component { render() { ... } }",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    evidence: ["designer-api", "generated-runtime-browser"],
  },
  {
    id: "app-async-function-declaration",
    shape: "async function App(props) { ... }",
    acceptedAtWriteTime: true,
    renderedAtRuntime: false,
    note: "Accepted by the write-time validator, then rejected by React 19 at runtime with minified error #482 (\"an async Client Component\"). Do not emit.",
    evidence: ["designer-api", "generated-runtime-browser"],
  },
  {
    id: "render-call",
    shape: "render(<div />);",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    note: "Requires no App binding at all; this is the documented alternative entry.",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    id: "top-level-element-variable",
    shape: "const element = <div />;",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    id: "whole-source-expression",
    shape: "<div />",
    acceptedAtWriteTime: true,
    renderedAtRuntime: true,
    note: "Only when the trimmed source starts with `<` or `(`; the platform re-compiles the whole source as one expression.",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    id: "no-entry",
    shape: "const x = 1;",
    acceptedAtWriteTime: true,
    renderedAtRuntime: false,
    note: "Accepted and silently renders nothing, with no console error. A generator bug that drops the entry therefore fails silently in production.",
    evidence: ["designer-api", "generated-runtime-browser"],
  },
];

export interface CellEntryResolutionStep {
  readonly order: number;
  readonly mechanism: string;
  /** The ordering itself is read from the runtime source; each mechanism was executed separately. */
  readonly orderingEvidence: RuntimeEvidenceChannel;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * Which mechanism wins when a source satisfies more than one of them.
 *
 * Ordering is a property of the runtime implementation, so it is recorded from
 * the source rather than inferred from which shapes happened to render.
 */
export const CELL_ENTRY_RESOLUTION_ORDER: readonly CellEntryResolutionStep[] = [
  {
    order: 1,
    mechanism: "A render(value) call wins: the recorded render result is returned as the element.",
    orderingEvidence: "product-runtime-source",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    order: 2,
    mechanism: "Otherwise an App binding is wrapped as React.createElement(App, props).",
    orderingEvidence: "product-runtime-source",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    order: 3,
    mechanism: "Otherwise a top-level element binding is used as the element.",
    orderingEvidence: "product-runtime-source",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    order: 4,
    mechanism:
      "Otherwise, when the trimmed source starts with `<` or `(`, the whole source is compiled again as a single expression.",
    orderingEvidence: "product-runtime-source",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    order: 5,
    mechanism: "Otherwise the cell stays empty and no error is logged.",
    orderingEvidence: "product-runtime-source",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
];

export function findCellEntryShape(id: CellEntryKind): CellEntryShape {
  const shape = CELL_ENTRY_SHAPES.find(candidate => candidate.id === id);
  if (!shape) {
    throw new Error(`Unknown ReactCellType entry shape "${id}".`);
  }
  return shape;
}

/** Entry shapes that validate but do not work. A generator must never emit these. */
export function nonWorkingCellEntryShapes(): readonly CellEntryShape[] {
  return CELL_ENTRY_SHAPES.filter(shape => !shape.renderedAtRuntime);
}

/**
 * The entry shapes a generator may emit: they satisfy the platform's write-time
 * validator *and* actually mount. `no-entry` is excluded even though it is
 * accepted, because it describes the absence of a shape rather than one.
 */
export function emitCellEntryShapes(): readonly CellEntryShape[] {
  return CELL_ENTRY_SHAPES.filter(shape => shape.acceptedAtWriteTime && shape.renderedAtRuntime);
}

// ---------------------------------------------------------------------------
// Rejected source
// ---------------------------------------------------------------------------

export type CellSourceRejectionId =
  | "import-declaration"
  | "export-declaration"
  | "react-use"
  | "use-action-state"
  | "use-optimistic"
  | "use-form-status"
  | "typescript-annotation"
  | "top-level-await"
  | "top-level-return"
  | "duplicate-top-level-declaration"
  | "runtime-import-call-not-rejected";

export interface CellSourceRejection {
  readonly id: CellSourceRejectionId;
  /**
   * Which validation pass rejects it. `preview` compiles the wrapped source;
   * `babel` parses the raw source. Both surface through the same designer error.
   */
  readonly stage: "preview" | "babel" | "none";
  /** The platform's own wording, verbatim where it is a fixed message. */
  readonly message: string;
  /**
   * True when the platform caps or repeats the message, so the recorded string is
   * one observed sample rather than a constant.
   */
  readonly messageVaries: boolean;
  /** Whether this construct is refused, rather than merely unstyled. */
  readonly rejected: boolean;
  readonly note: string;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * The source restrictions the target enforces itself, with its own wording.
 *
 * A compiler should reproduce these messages rather than invent its own, because
 * the same code is rejected again when it reaches the platform.
 *
 * `runtime-import-call-not-rejected` is recorded as a *rejection record* because
 * it belongs in the same decision table, but its `rejected` flag is false: the
 * platform validator does not reject `import()`. The "no runtime chunk loading"
 * rule is a bundler/artifact requirement (#6, #7), not a platform prohibition,
 * and conflating the two would make a later reader believe the platform will
 * catch it.
 */
export const CELL_SOURCE_REJECTIONS: readonly CellSourceRejection[] = [
  {
    id: "import-declaration",
    stage: "preview",
    message: "ReactCellType does not support import statements. Use the provided global variables instead.",
    messageVaries: false,
    rejected: true,
    note: "Fixed message constant in the runtime. Design-time rejection; the cell is never written.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "export-declaration",
    stage: "preview",
    message:
      "ReactCellType does not support export statements. Define App, element, or call render(value) instead.",
    messageVaries: false,
    rejected: true,
    note: "Fixed message constant; also the shortest statement of the accepted entry shapes.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "react-use",
    stage: "preview",
    message:
      "React.use is not supported in ReactCellType user code. Use stable client-side hooks such as React.useState and React.useEffect.",
    messageVaries: false,
    rejected: true,
    note: "Fixed message constant. Rejected by name, so it cannot be worked around with an alias.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "use-action-state",
    stage: "preview",
    message: "useActionState is not supported in ReactCellType user code.",
    messageVaries: false,
    rejected: true,
    note: "Recorded from the runtime's message table, and rejected verbatim by a live designer on 12.0.102.0 (#120).",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "use-optimistic",
    stage: "preview",
    message: "useOptimistic is not supported in ReactCellType user code.",
    messageVaries: false,
    rejected: true,
    note: "Recorded from the runtime's message table, and rejected verbatim by a live designer on 12.0.102.0 (#120).",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "use-form-status",
    stage: "preview",
    message: "useFormStatus is not supported in ReactCellType user code.",
    messageVaries: false,
    rejected: true,
    note: "Recorded from the runtime's message table, and rejected verbatim by a live designer on 12.0.102.0 (#120).",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "typescript-annotation",
    stage: "babel",
    message: 'unknown: Unexpected token, expected "," (1:18)',
    messageVaries: true,
    rejected: true,
    note: "Babel parse error with the offending position and a code frame; the position varies with the source.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "top-level-await",
    stage: "preview",
    message: "unknown: Unexpected reserved word 'await'. (2:10)",
    messageVaries: true,
    rejected: true,
    note: "Reported against the wrapped source, so the frame exposes the IIFE nesting.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "top-level-return",
    stage: "babel",
    message: "unknown: 'return' outside of function. (1:0)",
    messageVaries: true,
    rejected: true,
    note: "The raw source is parsed as a program, so a top-level return is not a legal way to return an element.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "duplicate-top-level-declaration",
    stage: "babel",
    message: "unknown: Identifier 'App' has already been declared. (2:9)",
    messageVaries: true,
    rejected: true,
    note: "Any duplicate top-level declaration is refused, not only App.",
    evidence: ["product-runtime-source", "designer-api"],
  },
  {
    id: "runtime-import-call-not-rejected",
    stage: "none",
    message: "none — the validator does not reject a dynamic import() call expression",
    messageVaries: false,
    rejected: false,
    note: "Accepted at write time and the element still renders; the call simply fails if it is ever executed. Treat as a bundler requirement, not a platform guarantee.",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
];

/**
 * How the platform reports a rejected source, so a compiler can match the wording.
 *
 * ## The envelope changed between `12.0.100.0` and `12.0.101.0`
 *
 * This is a measured drift (#120), and it is why the field is a list rather than one string:
 *
 * ```text
 * 12.0.100.0: Invalid AI-generated object 'ReactCellTypeCellType': ReactCellType 代码验证失败 [<stage>]：<message>
 * 12.0.101.0: api.page.setCells 调用失败：校验失败：ReactCellType.code：代码验证失败 [<stage>]：<message>
 * 12.0.102.0: api.page.setCells 调用失败：校验失败：ReactCellType.code：代码验证失败 [<stage>]：<message>
 * ```
 *
 * The **inner** wording is unchanged — each message below was produced verbatim on the builds its
 * own `evidence` names — and `<stage>` is still `preview` or `babel` with the same distribution.
 * What moved
 * between `12.0.100.0` and `12.0.101.0` is the frame around it: the object-name form is gone, the
 * call and the property are named instead, and the rejection now arrives wrapped in the failing
 * call's own error. `12.0.102.0` reproduces the `12.0.101.0` frame **verbatim**, so it joins that
 * entry's `versions` rather than getting a template of its own.
 *
 * Both frames are recorded because both were measured, and because a consumer that hard-codes one
 * frame silently stops matching on the other. {@link RUNTIME_CONTRACT_TARGET} names which build
 * is current, and {@link CELL_SOURCE_REJECTION_ENVELOPE.templates} keeps the older frame as
 * history rather than deleting it — a compiler matching only the current one is correct, and a
 * tool reading an older session's output needs to know what it is looking at.
 */
export const CELL_SOURCE_REJECTION_ENVELOPE = {
  /**
   * The frames a rejected source can arrive in, newest first, each tagged with the builds it
   * was observed on. `<stage>` and `<message>` are the placeholders; see `stageTags`.
   */
  templates: [
    {
      versions: ["12.0.102.0", "12.0.101.0"],
      template: "api.page.setCells 调用失败：校验失败：ReactCellType.code：代码验证失败 [<stage>]：<message>",
    },
    {
      versions: ["12.0.100.0"],
      template: "Invalid AI-generated object 'ReactCellTypeCellType': ReactCellType 代码验证失败 [<stage>]：<message>",
    },
  ] as const,
  stageTags: ["preview", "babel"],
  evidence: ["designer-api"] as readonly RuntimeEvidenceChannel[],
};

/**
 * What happens when a rejected source reaches the runtime anyway.
 *
 * Recorded from the runtime source, not executed: the designer refused every
 * rejected sample, so no rejected source could be mounted to observe.
 */
export const CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR = {
  behavior: "the cell's root is rendered with null and the error is written to console.error",
  rendersErrorTextInCell: false,
  note: "Unrelated to frontend-library failures, which do render their message in the cell.",
  evidence: ["product-runtime-source"] as readonly RuntimeEvidenceChannel[],
};

export function findCellSourceRejection(id: CellSourceRejectionId): CellSourceRejection {
  const rejection = CELL_SOURCE_REJECTIONS.find(candidate => candidate.id === id);
  if (!rejection) {
    throw new Error(`Unknown ReactCellType source rejection "${id}".`);
  }
  return rejection;
}

/** Only the constructs the target actually refuses. */
export function rejectedCellSourceConstructs(): readonly CellSourceRejection[] {
  return CELL_SOURCE_REJECTIONS.filter(rejection => rejection.rejected);
}

// ---------------------------------------------------------------------------
// How the target decides what to refuse
// ---------------------------------------------------------------------------

/**
 * The mechanism behind `CELL_SOURCE_REJECTIONS`, as opposed to its messages.
 *
 * Decision source: GitHub Issue #5 — see `CELL_SOURCE_REJECTIONS` above for the
 * messages. This record exists because the messages cannot answer a question a
 * consumer has to answer: *may I look for these constructs in raw source text?*
 *
 * A message like "React.use is not supported" is equally consistent with a name
 * match over the whole file and with a syntax-node check, and the two disagree
 * exactly where it matters — a string, template literal or comment that contains
 * the same characters. A consumer that guesses "textual" refuses artifacts the
 * platform accepts, which is worse than not checking locally at all: it blocks
 * correct output and teaches the caller to disable the check.
 *
 * Read from the shipped plugin resource of the ReactCellType cell type
 * (`Resources/ReactCellTypeCellType.js` under plugin
 * `96205a31-0c2e-4b98-9ce5-6555088e6cbd`), so the answer is observed rather than
 * inferred. The answer is: syntax nodes, never text. `AST_TRAVERSAL_SKIPPED_KEYS`
 * is the load-bearing detail — the walk does not descend into comment or token
 * properties at all, so a construct that exists only inside a comment cannot be
 * refused by it.
 */
export interface CellSourceValidationMechanism {
  /** The parse the checks run through. */
  readonly parseCall: string;
  /** The scope the declaration check parses in. */
  readonly declarationSourceType: string;
  /** Declaration node types refused outright. */
  readonly refusedDeclarationNodeTypes: readonly string[];
  /** Any node type starting with this prefix is refused as an export declaration. */
  readonly refusedDeclarationNodeTypePrefix: string;
  /** How the call check wraps the source before parsing it. */
  readonly reactCallCheckWrap: string;
  /**
   * The node type the callee check visits.
   *
   * Recorded because it is a boundary a consumer gets wrong by assuming "a call":
   * `new useFormStatus()` is a `NewExpression`, which this check never sees, so
   * refusing it locally would refuse something the platform accepts.
   */
  readonly refusedCalleeNodeType: string;
  /** Bare callee identifiers refused when called. */
  readonly refusedBareCalleeNames: readonly string[];
  /** Objects whose non-computed members are refused when called. */
  readonly refusedMemberCalleeObjects: readonly string[];
  /** Member names refused on every object in {@link refusedMemberCalleeObjects}. */
  readonly refusedMemberNames: readonly string[];
  /** The member name refused on `React` alone. */
  readonly refusedReactOnlyMemberNames: readonly string[];
  /**
   * AST keys the walk does not descend into. Comments and tokens are here, which
   * is the whole reason text inside a comment can never be refused.
   */
  readonly skippedAstKeys: readonly string[];
  /**
   * A parse failure is swallowed by the declaration check rather than reported,
   * because the same failure is reported later, from the transform step.
   */
  readonly ignoresParseFailure: boolean;
  readonly note: string;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

export const CELL_SOURCE_VALIDATION_MECHANISM: CellSourceValidationMechanism = {
  parseCall: 'Babel.transform(source, { presets: ["react"], ast: true, code: false, sourceType })',
  declarationSourceType: "module",
  refusedDeclarationNodeTypes: ["ImportDeclaration"],
  refusedDeclarationNodeTypePrefix: "Export",
  reactCallCheckWrap: "(() => {\n<source>\n})();",
  refusedCalleeNodeType: "CallExpression",
  refusedBareCalleeNames: ["useActionState", "useOptimistic", "useFormStatus"],
  refusedMemberCalleeObjects: ["React", "ReactDOM"],
  refusedMemberNames: ["useActionState", "useOptimistic", "useFormStatus"],
  refusedReactOnlyMemberNames: ["use"],
  // Comments and tokens are skipped, so nothing inside them is ever visited.
  skippedAstKeys: ["loc", "start", "end", "leadingComments", "trailingComments", "innerComments", "tokens"],
  ignoresParseFailure: true,
  note: "Both checks walk parsed syntax nodes, so a string, template literal or comment that merely contains the same characters is not refused. Three boundaries follow from the node types and are easy to get wrong: the callee check visits `CallExpression` only, so `new useFormStatus()` is not refused; a computed member (`React[\"use\"]()`) is not refused; and `import(...)` is a call rather than a declaration, which is why the validator does not reject it.",
  evidence: ["product-runtime-source"],
};

/**
 * AST keys the target's own walk never descends into.
 *
 * Exported as a predicate rather than left to a consumer to re-derive from the
 * array, so "the target does not see comments" is asserted in one place.
 */
export function cellSourceValidationVisitsAstKey(key: string): boolean {
  return !CELL_SOURCE_VALIDATION_MECHANISM.skippedAstKeys.includes(key);
}

// ---------------------------------------------------------------------------
// Names visible inside user code
// ---------------------------------------------------------------------------

/** Where a name comes from, and therefore what it can be assumed to be. */
export type CellBindingAvailability =
  | "always"
  | "after-the-declared-preset-resolves"
  | "only-on-window";

export interface CellUserScopeBinding {
  readonly name: string;
  readonly kind: "injected-parameter" | "wrapper-local" | "extension-global" | "page-global";
  readonly availableInCellSource: CellBindingAvailability;
  /** Is the name also a property of the page's `window`? */
  readonly onWindow: CellBindingAvailability | "never";
  readonly note?: string;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * The names a cell source may reference without importing them.
 *
 * This is the whole `host` mapping surface: anything not listed here has to be
 * `inline`d or supplied by an `extension`. The distinction between
 * `injected-parameter` and `wrapper-local` is not cosmetic — the runtime passes
 * the first set as `new Function` arguments, so their values are captured at the
 * moment the cell renders, while the second set is created per render.
 */
export const CELL_USER_SCOPE_BINDINGS: readonly CellUserScopeBinding[] = [
  {
    name: "React",
    kind: "injected-parameter",
    availableInCellSource: "always",
    onWindow: "always",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "antd",
    kind: "injected-parameter",
    availableInCellSource: "after-the-declared-preset-resolves",
    onWindow: "after-the-declared-preset-resolves",
    note: "The AntDesign preset is the persisted default when `libraries` is omitted, so this is usually available — but see the per-render-instant caveat.",
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    name: "dayjs",
    kind: "injected-parameter",
    availableInCellSource: "after-the-declared-preset-resolves",
    onWindow: "after-the-declared-preset-resolves",
    note: "Loaded as a dependency of the AntDesign preset, not as a preset of its own.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "echarts",
    kind: "injected-parameter",
    availableInCellSource: "after-the-declared-preset-resolves",
    onWindow: "after-the-declared-preset-resolves",
    note: "Only loaded when the cell declares the ECharts preset; the runtime asserts the global exists before rendering.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "ForguncyReactHelper",
    kind: "injected-parameter",
    availableInCellSource: "always",
    onWindow: "never",
    note: "Available as a parameter but is NOT a window property; reading it through `window` fails.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "props",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "useDataSource",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "DataSourceCompareType",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "DataSourceRelationType",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "render",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "useState",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "useEffect",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "useMemo",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "useRef",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "useCallback",
    kind: "wrapper-local",
    availableInCellSource: "always",
    onWindow: "never",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "ReactDOM",
    kind: "page-global",
    availableInCellSource: "always",
    onWindow: "always",
    note: "Not injected as a parameter, but present as a page global; the runtime itself mounts cells with it.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
];

export function cellUserScopeBinding(name: string): CellUserScopeBinding | undefined {
  return CELL_USER_SCOPE_BINDINGS.find(binding => binding.name === name);
}

// ---------------------------------------------------------------------------
// Ambient page/browser globals
// ---------------------------------------------------------------------------

/**
 * A name that exists on a real Forguncy page outside any cell scope.
 *
 * Deliberately separate from {@link CELL_USER_SCOPE_BINDINGS}: membership there is
 * what `artifact-audits.ts` reads as permission to map a `host` *dependency* onto a
 * global, and nothing here is a module identity a package may assume. `document` is
 * the working example — a dependency mapped onto `document` would be nonsense, yet
 * the compile-time auto-height injection (#185) legitimately references it as an
 * ambient browser global. The two tables answer different questions: user-scope
 * bindings are "what a cell's *module* may resolve to", these are "what a cell's
 * *generated runtime code* may name without importing anything".
 */
export interface CellBrowserHostGlobal {
  readonly name: string;
  readonly note: string;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * The ambient globals a generated artifact may reference, with their evidence.
 *
 * Kept deliberately short: every entry is a name the compile-time auto-height patch
 * (#185, Epic #184) references, verified on the live 12.0.102.0 page or inherent to
 * the browser environment the artifact is only ever evaluated in. A name belongs
 * here only when generated code needs it *and* it is not already a user-scope
 * binding — `React` is a user-scope binding, so it is not repeated here.
 *
 * `Forguncy` is the one platform-owned entry, and it is distinct from
 * `props.Forguncy`: the props member is the facade handle injected per render, while
 * the bare global is the host application object whose `Plugin.CellTypeHelper`
 * registry the platform itself populates. #176 measured the props member; the bare
 * global's registry shape was measured on the live page for this record — see
 * {@link REACTCELLTYPE_CREATE_CONTENT_CONTRACT}.
 */
export const CELL_BROWSER_HOST_GLOBALS: readonly CellBrowserHostGlobal[] = [
  {
    name: "Forguncy",
    note: "The host application object, a page global independent of the per-render `props.Forguncy` facade handle. `Forguncy.Plugin.CellTypeHelper._registedCellTypes` is the cell-type registry the platform populates as plugin scripts load; the auto-height patch reaches the ReactCellType constructor through it.",
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "document",
    note: "The browser document of the page the artifact is evaluated on. Never a host-dependency identity — see this table's header for why membership must not extend `CELL_USER_SCOPE_BINDINGS`.",
    evidence: ["generated-runtime-browser"],
  },
  {
    name: "MutationObserver",
    note: "Browser constructor used to follow SPA-later-mounted cell containers. Observed constructible and firing against `document.documentElement` on the live dev site (the same run that measured the containers below), not merely assumed ambient.",
    evidence: ["generated-runtime-browser"],
  },
  {
    name: "setInterval",
    note: "Browser timer the patch polls the cell-type registry with — load-bearing for the external-library form, an invariant guard for the injected artifact (see `auto-height.ts`'s header for why the race differs). The exact poll-then-clear pattern was exercised on the live dev site: fires on cadence, stops on `clearInterval`.",
    evidence: ["generated-runtime-browser"],
  },
  {
    name: "clearInterval",
    note: "The `setInterval` pair; stops the registry poll once the constructor is patched or the attempt budget is exhausted. Verified in the same exercise as `setInterval` — a two-fire poll stopped exactly at two.",
    evidence: ["generated-runtime-browser"],
  },
];

export function cellBrowserHostGlobal(name: string): CellBrowserHostGlobal | undefined {
  return CELL_BROWSER_HOST_GLOBALS.find(entry => entry.name === name);
}

// ---------------------------------------------------------------------------
// The ReactCellType container contract
// ---------------------------------------------------------------------------

/**
 * How the official ReactCellType builds its outermost container, and why generated
 * artifacts patch it.
 *
 * Decision source: Epic #184 — "ReactCellType 高度自适应沉淀为 cell-compiler 内置能力"
 * (https://github.com/MangMax/forguncy-react-workspace/issues/184) and its Ticket 1
 * #185, downstream of #5 whose plugin read this record extends.
 *
 * Every fact below was confirmed on the live 12.0.102.0 in the probe recorded at
 * `packages/mcp-sync/scripts/probe-autoh-evidence-185.mjs` (evidence JSON beside it),
 * which is what the `generated-runtime-browser` channel on the entries means:
 *
 * - **[SRC]** the shipped plugin resource
 *   (`Plugins/96205a31-0c2e-4b98-9ce5-6555088e6cbd/Resources/ReactCellTypeCellType.js`)
 *   builds the container as `$("<div style='width: 100%;height: 100%'/>")` — jQuery,
 *   hardcoded `height: 100%` — then sets `div.attr("id", this.ID)` and returns the
 *   jQuery object. The class registers through
 *   `Forguncy.Plugin.CellTypeHelper.registerCellType("ReactCellType.ReactCellTypeCellType, ReactCellType", ReactCellTypeCellType)`.
 * - **[RT]** on a generated page, `_registedCellTypes[key]` is an array whose `[0]`
 *   carries exactly `{ cellTypeCtor, match }`, `cellTypeCtor.prototype.createContent`
 *   is a function, and the mounted container's id matched `/^r\d+c\d+p$/`
 *   (`r0c0p` for a cell anchored at A1). The blank tail was measured rather than
 *   asserted: the unpatched container reported 32px against a content extent of
 *   ~58.6px (tall content clipped), and after applying the patch the container
 *   tracked the content exactly (blank tail 0).
 *
 * The jQuery reliance is real and deliberately recorded: the prototype patch calls
 * `.css()`/`.addClass()` on whatever the original `createContent` returns, wrapped in
 * a `try/catch` that degrades to native behaviour rather than blocking the render.
 * If a future build returns a plain element the patch becomes a no-op on the
 * prototype path — and the position-independent repair/observer paths, which use
 * native `style`/`classList`, are the reason that degradation stays adaptive rather
 * than broken.
 */
export const REACTCELLTYPE_CREATE_CONTENT_CONTRACT = {
  /** The registry key `registerCellType` is called with, verbatim from the plugin source. */
  registryKey: "ReactCellType.ReactCellTypeCellType, ReactCellType",
  /** The entry shape at `_registedCellTypes[key][0]`, as measured on the live page. */
  entryKeys: ["cellTypeCtor", "match"] as const,
  /** The prototype member the patch wraps. */
  createContentMember: "createContent",
  /** The container the unpatched plugin builds: jQuery, hardcoded width/height 100%. */
  unpatchedContainerInlineStyle: "width: 100%;height: 100%",
  /**
   * The position-independent id pattern the container carries.
   *
   * `this.ID` is assigned by the platform's own cell instantiation, and the measured
   * value for a cell at A1 was `r0c0p` — row, column, `p` suffix. The patch's repair
   * and observer passes key on this pattern precisely so no cell id is ever
   * hardcoded: the same artifact adapts at any grid position.
   */
  containerIdPattern: "^r\\d+c\\d+p$",
  /**
   * The marker class the patch adds, so its repair/observer passes never re-apply
   * and a second cell's patch short-circuits.
   */
  markerClass: "fgc-reactcell-autoh",
  /** The prototype guard property that makes re-patching a no-op page-wide. */
  patchedGuard: "__reactCellAutoHeightPatched",
  note: "The blank tail is measured fact, not motive: on 12.0.102.0 an unpatched short-content cell reported a 32px container over a 58.6px content extent, and the patched container tracked the content exactly. The three mechanisms (prototype wrap, repair pass, MutationObserver) are complementary rather than redundant — the wrap serves cells instantiated after it lands, the repair pass the ones that already exist, the observer the ones the SPA mounts later.",
  evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

// ---------------------------------------------------------------------------
// Preset libraries
// ---------------------------------------------------------------------------

export interface CellPresetLibrary {
  readonly name: "None" | "AntDesign" | "ECharts";
  /** Host globals this preset makes available to the whole page. */
  readonly providesGlobals: readonly string[];
  /** Scripts loaded before those globals exist, in load order. */
  readonly scriptChain: readonly string[];
  /** Submitted to `Forguncy.LoadModule` instead of a script URL, when applicable. */
  readonly runtimeModule?: string;
  /** Persisted when the cell does not specify `libraries`. */
  readonly isPersistedDefault: boolean;
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * Preset library chains.
 *
 * `None` is the important one: it is the only way to get a cell that does not
 * pull antd, and the only reliable way to prove a cell has no host library
 * dependency.
 */
export const CELL_PRESET_LIBRARIES: readonly CellPresetLibrary[] = [
  {
    name: "None",
    providesGlobals: [],
    scriptChain: [],
    isPersistedDefault: false,
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
  {
    name: "AntDesign",
    providesGlobals: ["dayjs", "antd"],
    scriptChain: [
      "Resources/dayjs/dayjs.min.js",
      "Resources/antd/antd.zh-cn.js",
      "Resources/antd/antd.min.js",
      "Resources/antd/reset.css",
    ],
    isPersistedDefault: true,
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
  },
  {
    name: "ECharts",
    providesGlobals: ["echarts"],
    scriptChain: [],
    runtimeModule: "chart",
    isPersistedDefault: false,
    evidence: ["product-runtime-source", "generated-runtime-browser"],
  },
];

/**
 * The preset the platform persists when a cell omits `libraries`.
 *
 * Derived rather than restated: "the default is AntDesign" is a property of the
 * preset record above, so writing the name a second time would create a value
 * that can drift away from its own evidence.
 */
export function persistedDefaultCellPreset(): CellPresetLibrary {
  const preset = CELL_PRESET_LIBRARIES.find(candidate => candidate.isPersistedDefault);
  if (!preset) {
    throw new Error("No ReactCellType preset library is marked as the persisted default.");
  }
  return preset;
}

export const CELL_PRESET_LIBRARY_DEFAULT = persistedDefaultCellPreset().name;

export function findCellPresetLibrary(name: CellPresetLibrary["name"]): CellPresetLibrary {
  const preset = CELL_PRESET_LIBRARIES.find(candidate => candidate.name === name);
  if (!preset) {
    throw new Error(`Unknown ReactCellType preset library "${name}".`);
  }
  return preset;
}

// ---------------------------------------------------------------------------
// Props and platform bridge
// ---------------------------------------------------------------------------

/**
 * The base `props` contract: the keys the runtime always injects, in the order it
 * injects them.
 *
 * The order is observable and therefore worth pinning: a generator that snapshots
 * `Object.keys(props)` in a fixture sees the base keys first, then configured
 * properties, then `ImageContext`. The key list lives on the record itself so it
 * cannot drift away from its evidence.
 */
export const CELL_PROPS_KEY_ORDER = {
  /** Always present, in this order, before any configured property. See `cell-props.ts`. */
  baseKeys: CELL_PROPS_BASE_KEYS,
  description:
    "Forguncy, then Permissions, then configured properties[].propertyName, then ImageContext; event handlers and configured permissions are injected before properties",
  evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

/**
 * Re-exported from `cell-props.ts` (#124), not redefined here.
 *
 * The tuple moved so a production Cell can import it without loading this evidence record;
 * the name stays on this module because it is part of `core`'s existing public surface.
 */
export { CELL_PROPS_BASE_KEYS };

export const CELL_FORGUNCY_FACADE = {
  /** The runtime API surface exposed to a cell as `props.Forguncy`. See `cell-props.ts`. */
  keys: CELL_FORGUNCY_PROP_KEYS,
  description: "the cell's handle on Forguncy-owned capabilities, injected as props.Forguncy",
  evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

/** Re-exported from `cell-props.ts` (#124), not redefined here. */
export { CELL_FORGUNCY_PROP_KEYS };

export const CELL_SERVER_COMMANDS_CONTRACT = {
  /** Only the names listed in `availableServerCommands` are present. */
  shape: "a record of command name to async function",
  /**
   * The reserved result keys. Every other key on a result is one of the
   * command's own named returns.
   */
  resultKeys: ["errorCode", "errorMessage"] as const,
  /** Calling a name that was not configured is a plain TypeError, not a platform error. */
  unconfiguredNameType: "undefined",
  unconfiguredCallOutcome: "TypeError: <name> is not a function",
  namedReturnsAreExtraKeys: true,
  evidence: ["product-runtime-source", "product-documentation", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

/** Derived from {@link CELL_SERVER_COMMANDS_CONTRACT}. */
export const CELL_SERVER_COMMAND_RESULT_KEYS = CELL_SERVER_COMMANDS_CONTRACT.resultKeys;

export const CELL_DATA_SOURCE_CONTRACT = {
  resultFieldsExecuted: ["data", "totalCount", "loading", "error", "reload"],
  resultFieldsDocumented: ["data", "totalCount", "loading", "error", "reload"],
  /** A name that was never declared is an error state, not a thrown exception. */
  unknownSourceOutcome: "the hook returns an error state whose message contains the data source name",
  pageSizeCountsAreServerSide: true,
  evidence: ["product-runtime-source", "product-documentation", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

// ---------------------------------------------------------------------------
// The `props.Forguncy` member call shapes
// ---------------------------------------------------------------------------

/**
 * The signatures #176 measured for the `props.Forguncy` facade members, on
 * Forguncy `12.0.102.0` against a live generated page.
 *
 * Until now the contract pinned only the *names* on `props.Forguncy` (#5) and the
 * shapes of two bridges (`ServerCommands`, `useDataSource`). #176 executed every
 * member in a real browser against a generated page carrying probe bindings, so
 * this table is what #177's typed facade reads when it decides how strongly it
 * may type a member. Anything the probe could not settle stays an open question
 * in `RUNTIME_CONTRACT_UNKNOWNS` rather than being guessed here.
 *
 * Two kinds of typing strength appear in `shape`:
 *
 * - **exact**: the runtime callsite was executed and the value shape was read off
 *   the live object. These are strong enough for a facade to expose them
 *   verbatim.
 * - **passthrough**: the member is a thin wrapper over a `Forguncy.*` host global
 *   whose own signature the runtime source states but #176 did not exercise
 *   end-to-end. The shape is still the answer to "what does the cell see", but a
 *   caller dependent on host behaviour the wrapper forwards (navigation,
 *   side-effects) is reading the host's contract, not this one.
 */
export const CELL_FORGUNCY_FACADE_MEMBER_SHAPES = {
  "props.Forguncy.getCurrentUser": {
    shape: "() => { UserName, FullName, Email, Role, HasPicture, PictureUrl }",
    shapeKind: "exact",
    signedInSample: {
      UserName: "Administrator",
      FullName: "Administrator",
      Email: "example@example.com",
      Role: "Administrator",
      HasPicture: false,
      PictureUrl: "/Forguncy/Resources/Images/SiteBuiltInImages/DefaultCurrentUser.png",
    },
    note: "Reads `Forguncy.Page.getUserInfo()` and computes `PictureUrl` from `UserName`/`HasPicture`. With no signed-in user the underlying userInfo fields are undefined and `PictureUrl` falls back to the built-in default avatar; the exact signed-out shape was not separately executed.",
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.Forguncy.logIn": {
    shape: "() => void — arity 0",
    shapeKind: "passthrough",
    forwardsTo: "Forguncy.AccountEx_ForApi.navigateToLogin()",
    redirectsToLoginPage: true,
    note: "The wrapper passes no arguments through. Calling it navigates the browser to the login page; it does not return a promise of a session. The redirect target is the host's navigation decision, not the cell's.",
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.Forguncy.logOut": {
    shape: "(navigateToHomePage) => void — arity 1",
    shapeKind: "passthrough",
    forwardsTo: "Forguncy.logOut(navigateToHomePage)",
    note: "Forwards the single `navigateToHomePage` argument verbatim. The redirect and session teardown are the host's; the cell sees only a fire-and-forget call.",
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.Forguncy.uploadFiles": {
    shape: "(files, options?) => Promise<{ files: [{ filePath, fileName, downloadUrl }], attachmentValue: string }>",
    shapeKind: "exact",
    acceptsShapes: ["single File", "Array<File>", "FileList"],
    optionsShape: "{ uploadFolder?: string }",
    validationErrors: {
      emptyFile: "不能上传空文件。",
      extensionMismatch: "上传的文件 <name> 的类型不正确。",
      exceedsSize: "上传的文件 <name> 的大小超出了限制, 最大上传文件的大小为 <sizeLimit> MB。",
      exceedsCount: "The number of selected files exceeds the maximum upload file count.",
    },
    attachmentValueFormat: "<filePath>|<filePath>|…| — pipe-separated, trailing pipe",
    filePathFormat: "<uuid>_<originalName> (or `<uploadFolder>/<uuid>_<originalName>` when uploadFolder is supplied)",
    noArgsOutcome: "resolves `{ files: [], attachmentValue: \"\" }` rather than rejecting",
    emptyArrayOutcome: "resolves the same empty result without a network call",
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.Forguncy.getUploadLimit": {
    shape: "() => { extensionFilter, accept, sizeLimit, maxUploadFileCount }",
    shapeKind: "exact",
    units: {
      sizeLimit: "megabytes — the runtime validates `sizeLimit * 1024 * 1024 < file.size`",
      maxUploadFileCount: "count of files per call",
    },
    defaultsWhenUnset: { sizeLimit: 0, maxUploadFileCount: 0 },
    zeroMeansUnlimited: true,
    acceptEqualsExtensionFilter: true,
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.Forguncy.exposeMethod": {
    shape: "(methodName, method) => void",
    shapeKind: "exact",
    invalidInputOutcome: "silently returns without throwing when `methodName` is falsy or `method` is not a function",
    overwriteSemantics: "re-registering the same name replaces the previous method; the latest registration wins",
    invocationPath: "Forguncy host reaches the cell through `page.getCell(<cellName>).getCellType().ExecuteMethod(name, methodParameters)`",
    invocationResultShape: "{ Result: <method-return-value> } — a Promise return is awaited before being placed on Result",
    invocationParameterShapes: "each entry is unwrapped as `parameterValue` or `ParameterValue` when either key is present, otherwise the entry is passed through verbatim",
    invocationErrors: {
      emptyName: "ReactCellType ExecuteMethod requires an exposed method name.",
      unregisteredName: "ReactCellType exposed method was not found: <name>",
    },
    scope: "host-invokable cell method exposure — not a cross-cell pub/sub channel. The page, a page command, or another cell with a reference can invoke it; the cell itself does not subscribe to other cells through this surface.",
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.Forguncy.hasPermission": {
    shape: "(name) => boolean",
    shapeKind: "exact",
    falsyInputOutcome: "returns false for `''`, `null` and `undefined` rather than throwing",
    unknownPermissionOutcome: "returns false for a name the cell did not declare",
    caseSensitivity: "case-sensitive — `'probe176.permission'` does not match `'Probe176.Permission'`",
    reads: "the permission snapshot captured when the cell initialized; it does not consult the host per call",
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.Forguncy.getPermissions": {
    shape: "() => { [name]: boolean }",
    shapeKind: "exact",
    returnsCopy: true,
    copyNote: "each call returns a fresh shallow object; mutating it does not affect the snapshot other callers see",
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.Forguncy.Permissions": {
    shape: "the same snapshot object as `props.Permissions` — identity equality holds",
    shapeKind: "exact",
    identityEqualsPropsPermissions: true,
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.Forguncy.ConvertToCssColor": {
    shape: "(color: string) => string",
    shapeKind: "exact",
    behavior: {
      sixDigitHex: "passed through verbatim (`#FF0000` → `#FF0000`)",
      eightDigitHexByteOrder: "the 8-digit form is **alpha-leading** (`#AARRGGBB`, the ARGB ordering the host's CLR colour model uses) — `#80FF0000` places `FF` at the red position, which is what `rgba(255,0,0,0.50)` confirms. #177 pinned the byte order from the three measured cases; a `#RRGGBBAA` reading contradicts all three.",
      eightDigitHexFullAlpha: "alpha `FF` is dropped (`#FFFF0000` → `#FF0000`)",
      eightDigitHexPartialAlpha: "converted to `rgba(r,g,b,a)` with the alpha quantized to two decimals (`#80FF0000` → `rgba(255,0,0,0.50)`)",
      eightDigitHexZeroAlpha: "converted to `rgba(r,g,b,0.00)` (`#00FF0000` → `rgba(255,0,0,0.00)`)",
      rgbFunctionalString: "passed through verbatim",
      namedColor: "passed through verbatim",
      emptyString: "returned as `''`",
      nonStringInput: "throws `TypeError: n.startsWith is not a function` — the host assumes a string",
    },
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.Forguncy.ConvertDateToOADate": {
    shape: "(date: Date) => number",
    shapeKind: "exact",
    epochBehavior: "the OLE Automation epoch `1899-12-30T00:00:00Z` does not map to 0 because the conversion runs in the local timezone — observed `0.33730324074074075` for that input on a UTC+8 host",
    arithmeticRefinement:
      "#177 derived the exact arithmetic from the probe's two data points: the conversion reinterprets the date's **local wall-clock components as UTC** and measures days since `1899-12-30` in that space. The noon measurement (`46023.833333333336` for a UTC-noon input) is what rules out the naive epoch-milliseconds formula, which misses by the local-timezone offset on every non-UTC host; `inv(0)` = local midnight `1899-12-30` (`1899-12-29T15:54:17.000Z` in UTC on a UTC+8 LMT host) confirms the inverse. The round-trip is exact to the millisecond because the two directions are strict inverses in wall-clock space.",
    roundtripWithinMs: "a `ConvertDateToOADate` → `ConvertOADateToDate` round-trip is exact to the millisecond",
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.Forguncy.ConvertOADateToDate": {
    shape: "(oadate: number) => Date",
    shapeKind: "exact",
    zeroBehavior: "`0` does not produce the OLE Automation epoch — it produces the local-timezone-adjusted instant (`1899-12-29T15:54:17.000Z` on a UTC+8 host)",
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.Forguncy.DataSourceCompareType": {
    shape: "enum object keyed by name with numeric values",
    shapeKind: "exact",
    members: {
      EqualsTo: 0, NotEqualsTo: 1, GreaterThan: 2, GreaterThanOrEqualsTo: 3,
      LessThan: 4, LessThanOrEqualsTo: 5, BeginsWith: 6, NotBeginWith: 7,
      EndsWith: 8, NotEndWith: 9, Contains: 10, NotContains: 11, In: 12, NotIn: 13,
    },
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.Forguncy.DataSourceRelationType": {
    shape: "enum object keyed by name with numeric values",
    shapeKind: "exact",
    members: { And: 0, Or: 1 },
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
} as const;

/**
 * The base-prop members that are not part of `props.Forguncy` but ride the same
 * injection. Measured on the same probe so the props surface is fully typed.
 */
export const CELL_PROPS_SURFACE_SHAPES = {
  "props.ImageContext": {
    shape: "a plain object mapping image name to URL; `{}` when the cell declares no image data sources",
    emptyWhenNoImageDataSources: true,
    populatedBy: "cellParam.ImageDataSource — populated only when the cell declares image bindings",
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.PageProperties": {
    shape: "a Proxy that forwards reads to `Forguncy.Page.getPropertyValue(name)`",
    readsLive: true,
    evidence: ["product-runtime-source"] as readonly RuntimeEvidenceChannel[],
  },
  "props.properties-declared": {
    shape: "the declared property's `propertyValue` is evaluated as a formula and `props.<name>` is the result; changes reach the cell through `SetPropertyValue`",
    changeSemantics: "a change re-renders the existing tree without re-executing the cell entry — observed `execCount` unchanged while `appCalls` incremented",
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
  "props.event-handler-functions": {
    shape: "for each declared `eventHandlers[i].eventName` the runtime assigns `props[eventName] = (...args) => void`",
    firingSemantics: "calling the function gathers positional args into an object keyed by `eventArgs[].name` and hands it to `executeCustomCommandObject` against the persisted `EventHandler` command tree",
    designerPreviewNoOp: "the function is a no-op in the designer preview",
    evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
} as const;

// ---------------------------------------------------------------------------
// `cellTypeProps` write schema
// ---------------------------------------------------------------------------

/**
 * What `setCells` accepts and what `getCells` returns for each binding field of a
 * `ReactCellType` cell, measured by writing and reading probe cells on
 * `12.0.102.0`. This is the schema #178 writes and #179 verifies, so the field
 * names below are the names the platform persists — camelCase in the wire JSON
 * even though the CLR types are PascalCase.
 *
 * Two things matter for every field.
 *
 * - **Round-trip shape**: `setCells` accepts both camelCase and PascalCase input
 *   (Json.NET is case-insensitive on deserialization), but `getCells` always
 *   reads back camelCase. A writer that wants byte-identical round-trips writes
 *   camelCase.
 * - **Strictness**: unknown keys on an element are silently dropped on write
 *   rather than rejected. Element entries that are not objects at all (a string,
 *   a number) fail the whole write with a Json.NET deserialization error.
 */
export const CELL_TYPE_PROPS_WRITE_SCHEMA = {
  code: {
    wireKey: "code",
    shape: "string — the cell source, required",
    evidence: ["designer-api"] as readonly RuntimeEvidenceChannel[],
  },
  properties: {
    wireKey: "properties",
    elementType: "ReactCellType.ReactProperty",
    roundTrippedKeys: ["propertyName", "propertyValue", "exampleValue"],
    droppedKeys: ["displayName", "propertyType", "defaultValue", "editorType", "category", "description", "required"],
    propertyValueFormulaRewrite: "a bare cell reference is rewritten to a page-qualified formula on write (`=A1` round-trips as `='<pageName>'!A1`)",
    emptyArrayDropped: true,
    nullDropped: true,
    elementNonObjectError: "Error converting value <x> to type 'ReactCellType.ReactProperty'",
    evidence: ["designer-api"] as readonly RuntimeEvidenceChannel[],
  },
  eventHandlers: {
    wireKey: "eventHandlers",
    elementType: "ReactCellType.ReactEventHandler",
    roundTrippedKeys: ["eventName", "eventArgs", "eventHandler"],
    eventArgsKeys: ["name"],
    eventHandlerShape: "the command tree is stored verbatim under `eventHandler` — arbitrary JSON keys round-trip unchanged. The runtime reads it as the `executeCustomCommandObject` argument, so the merge strategy #179 needs is: **read `eventHandlers[i].eventHandler` wholesale and preserve it untouched on sync**",
    droppedKeys: ["displayName", "description", "parameters"],
    nullCommandDropped: "an entry whose `eventHandler` is `null` round-trips with the key omitted entirely",
    emptyObjectCommandRoundTrips: "`eventHandler: {}` is preserved as `{}`",
    emptyArrayDropped: true,
    nullDropped: true,
    elementNonObjectError: "Error converting value <x> to type 'ReactCellType.ReactEventHandler'",
    evidence: ["designer-api"] as readonly RuntimeEvidenceChannel[],
  },
  dataSources: {
    wireKey: "dataSources",
    elementType: "ReactCellType.DataSourceProperty",
    roundTrippedKeys: ["dataSourceName", "dataSource"],
    dataSourceShape: "{ tableName, bindingInfos: [{ bindingInfo: { tableName, columnName }, columnName }], formulaNullQueryPolicy }",
    droppedKeys: ["name", "displayName", "bindingType", "type"],
    missingBindingInfosOutcome: "an entry without the full `dataSourceName` + `dataSource.bindingInfos` shape round-trips as `null` — the deserializer produces the empty object but the serializer omits all-empty entries",
    emptyArrayDropped: true,
    elementNonObjectError: "Error converting value <x> to type 'ReactCellType.DataSourceProperty'",
    evidence: ["designer-api"] as readonly RuntimeEvidenceChannel[],
  },
  permissions: {
    wireKey: "permissions",
    elementType: "ReactCellType.ReactPermission",
    roundTrippedKeys: ["name", "allowRoles"],
    missingNameOutcome: "an entry without `name` round-trips with the key omitted",
    emptyArrayDropped: true,
    elementNonObjectError: "Error converting value <x> to type 'ReactCellType.ReactPermission'",
    evidence: ["designer-api"] as readonly RuntimeEvidenceChannel[],
  },
  availableServerCommands: {
    wireKey: "availableServerCommands",
    elementType: "ReactCellType.AvailableServerCommand",
    roundTrippedKeys: ["name"],
    existenceValidation: "none — the platform persists a command name that no server command defines; calling it at runtime is a plain TypeError on the record",
    emptyArrayDropped: true,
    elementNonObjectError: "Error converting value <x> to type 'ReactCellType.AvailableServerCommand'",
    evidence: ["designer-api"] as readonly RuntimeEvidenceChannel[],
  },
  uploadLimit: {
    wireKey: "uploadLimit",
    roundTrippedKeys: ["extensionFilter", "sizeLimit", "maxUploadFileCount"],
    defaultsWhenUnwritten: { extensionFilter: ".jpg, .jpeg, .png, .gif, .bmp, .xlsx, .docx, .doc, .xls, .pdf", sizeLimit: 0, maxUploadFileCount: 0 },
    nullDropped: "writing `uploadLimit: null` removes the object entirely",
    evidence: ["designer-api"] as readonly RuntimeEvidenceChannel[],
  },
  libraries: {
    wireKey: "libraries",
    acceptedInputs: ["string (`\"AntDesign\"`, `\"ECharts\"`, `\"AntDesign,ECharts\"`, `\"None\"`)", "integer bitmask (0/1/2/3)"],
    roundTripForm: "comma-separated string with a space after the comma — `AntDesign, ECharts` for bitmask 3",
    defaultWhenUnwritten: "AntDesign",
    evidence: ["designer-api"] as readonly RuntimeEvidenceChannel[],
  },
  frontendLibraries: {
    wireKey: "frontendLibraries",
    elementKeys: ["libraryId"],
    emptyArrayDropped: true,
    evidence: ["designer-api", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
  },
} as const;

// ---------------------------------------------------------------------------
// Frontend libraries
// ---------------------------------------------------------------------------

/** The persisted shape of one `cellTypeProps.frontendLibraries` entry. */
export interface FrontendLibraryReference {
  /** The stable `id` returned by `api.app.listFrontendLibraries`, not a display name or file name. */
  readonly libraryId: string;
}

export const FRONTEND_LIBRARY_REFERENCE_CONTRACT = {
  /** The only field a reference carries. */
  fieldName: "libraryId",
  /** Where the value has to come from. */
  fieldSource: "api.app.listFrontendLibraries[].id",
  example: { libraryId: "<api.app.listFrontendLibraries[].id>" },
  evidence: ["product-documentation", "designer-api", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

/** Derived from {@link FRONTEND_LIBRARY_REFERENCE_CONTRACT}. */
export const FRONTEND_LIBRARY_REFERENCE_EXAMPLE: FrontendLibraryReference =
  FRONTEND_LIBRARY_REFERENCE_CONTRACT.example;

export const FRONTEND_LIBRARY_RUNTIME_SEMANTICS = {
  loadedThrough: "Forguncy.ensureFrontendLibrariesLoaded(libraryIds)",
  /**
   * A cell's own entry runs only after that cell's declared libraries resolve.
   * This is the guarantee a generator may rely on.
   */
  perCellReadinessAwaited: true,
  /**
   * Once loaded, an extension global is a page-level `window` property, so other
   * cells can observe it even though they never declared it.
   */
  globalsArePageWide: true,
  /**
   * Not guaranteed. Two cells declaring the same libraries in opposite order
   * produced one page-level load order, and the second cell observed that order
   * rather than its own.
   */
  loadOrderGuaranteed: false,
  /**
   * Not guaranteed. A cell can render while another cell's declared libraries are
   * still in flight, so a cell must not assume a library it did not declare is
   * present.
   */
  crossCellReadinessGuaranteed: false,
  /**
   * Host globals are bound as `new Function` parameters at the moment the cell
   * renders, so two cells on one page can legitimately observe different
   * snapshots of the same global.
   */
  presetGlobalsBoundPerRenderInstant: true,
  /** A library that fails to load renders its error message inside the cell. */
  failedLoadRendersMessageInCell: true,
  evidence: [
    "product-runtime-source",
    "product-documentation",
    "designer-api",
    "generated-runtime-browser",
  ] as readonly RuntimeEvidenceChannel[],
};

// ---------------------------------------------------------------------------
// The generated runtime binding
// ---------------------------------------------------------------------------

/**
 * What a generated artifact must do so that a Cell calling the runtime façade works.
 *
 * Decision source: GitHub Issue #82 — "修复 Runtime：在生产 Cell 入口自动安装 Host
 * Provider"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/82), which is where the
 * requirement's two halves meet: `#27/#29`'s façade states the *shape* a generated
 * binding has to satisfy (`host-provider.ts`), and
 * `RUNTIME_FACADE_PACKAGING_POLICY.compilerOwnsImportLowering` leaves emitting it to the
 * artifact/compiler boundary.
 *
 * ## Why the contract is here rather than in the compiler
 *
 * Every field below is a *name* that two independently-written modules have to agree on:
 * the package specifier an authored `import` uses, and the two members the generated
 * binding calls on it. That is the same kind of fact `HOST_BRIDGE_MAPPINGS` carries —
 * "which import is bound to which identity" — and this module is where that kind of fact
 * lives. Hard-coding them in `cell-compiler` would work until the façade renamed a
 * member, at which point the binding would silently stop installing and the Cell would
 * fail at its first façade call with the very error #82 exists to remove.
 *
 * ## What each name is, and what makes it the right one
 *
 * - `facadeSpecifier` is the specifier authored source writes. It is a *workspace* source
 *   dependency (#14), not a published one: the compiler flattens it into each Cell like
 *   any other source file, which is what makes the façade's single per-Cell provider slot
 *   correct (`RUNTIME_FACADE_PACKAGING_POLICY.perCellDuplicateAllowed`).
 * - `installMember` and `createProviderMember` are the two members the binding calls.
 *   Both are exported from the façade's public barrel — the binding re-exports that barrel
 *   wholesale, so a name the barrel does not carry would break authored source that
 *   imports it.
 * - `bindingSpecifier` is the entry the *generated* module imports. It is a subpath rather
 *   than `facadeSpecifier` because the binding used to import the whole package barrel, and
 *   a flattening compiler carries every statically imported module into the artifact — so
 *   every production Cell was shipping the local-dev and mock contracts it never calls.
 * - `hostNames` are the *free identifiers* the binding's source references. They are not
 *   imports: `props` and `useDataSource` are wrapper-locals the platform's own arrow IIFE
 *   declares before placing the cell source
 *   ({@link CELL_SOURCE_EXECUTION_MODEL}`.userCodeNesting`), so they are in scope where
 *   the binding module's body runs and are unreachable from anywhere else — which is
 *   precisely why the binding has to be generated inside the Cell rather than shipped in
 *   the package (`host-provider.ts`'s argument).
 *
 * ## The timing, and what it does not decide
 *
 * `installTiming` states the one ordering requirement the artifact can satisfy: the
 * binding module's body runs when the artifact is evaluated, which is before the
 * platform's `App` binding is ever called and therefore before any façade call.
 *
 * #83 separated two questions that this timing used to leave folded together. The
 * *install* is still once per artifact evaluation, but the *props it reads* are live:
 * {@link CELL_RUNTIME_BINDING_CONTRACT.livePropsVariable} names a binding the compiler
 * declares at artifact scope and the entry wrapper assigns on every `App` call, so a
 * re-render re-invokes `App` with new props (`property-change-re-render`') without
 * re-evaluating the modules and the provider still answers with them. That is the
 * second branch of `artifact-re-evaluated-per-render`, and #83's executed regression
 * (`runtime-lifecycle.test.ts`) is what established that it was broken before: the
 * provider was built from a `props` snapshot, so every façade call after a prop change
 * returned the first evaluation's values, silently.
 *
 * What is still not decidable from this repository is which branch the platform
 * takes — whether the artifact is re-evaluated (`presetGlobalsBoundPerRenderInstant`
 * and `property-change-re-render` suggest it may be) or `App` is re-invoked. The
 * artifact is now correct under either branch; #84 is where the product's actual
 * behaviour is observed.
 *
 * ## What the contract deliberately does not require
 *
 * There is no teardown member. The binding installs and never uninstalls, and that is
 * recorded here rather than left to be inferred from an absent field: a requirement
 * stated in prose that no generated code meets is worse than no requirement, because a
 * reader takes it as a description of what ships. Whether a teardown is needed is a
 * lifecycle question, and #83's execution settled the part it could: the slot is per
 * copy, an older evaluation keeps its own provider after a newer one installs, and
 * dropping one Cell does not disturb another (`runtime-lifecycle.test.ts`). What
 * cannot be proved locally — whether teardown reaches the artifact at all — remains
 * #84's, per `CELL_HOST_RUNTIME_SEMANTICS`' `unmount-clears-the-cell-root`.
 */
export const CELL_RUNTIME_BINDING_CONTRACT = {
  /**
   * The specifier authored source imports the façade by.
   *
   * The *only* specifier the compiler may intercept for this purpose, and the same one
   * `RUNTIME_FACADE_DECISION` documents: one package, one address.
   */
  facadeSpecifier: "@forguncy-react-workspace/runtime",
  /**
   * The entry the *generated binding* imports.
   *
   * A second field rather than a suffix appended to `facadeSpecifier`, because the two are
   * different facts: `facadeSpecifier` is what authored source writes and what the compiler
   * intercepts, and this is what the module it emits imports. They were equal until #124, and
   * keeping them as one value is what would make the binding quietly revert to importing the
   * whole package barrel.
   *
   * The subpath is the package's production runtime (#124): `cell-runtime.ts` alone, with no
   * `local-dev.ts`, no mock provider and no capability registry. The binding re-exports what it
   * imports, so a Cell that imports `runtimeFacade` by name still gets it — and the artifact no
   * longer carries the toolchain that produces the same names for other audiences.
   */
  bindingSpecifier: "@forguncy-react-workspace/runtime/cell",
  /** The member the binding calls to install the provider. */
  installMember: "installRuntimeFacadeProvider",
  /** The member the binding calls to build a provider from the Cell's own values. */
  createProviderMember: "createHostRuntimeFacadeProvider",
  /**
   * The `createHostRuntimeFacadeProvider` input fields, as the binding fills them.
   *
   * `cellProps` and `useDataSource` under the port's own member names
   * (`RUNTIME_FACADE_PORT_CHANNEL_MEMBERS`), so a channel the port renames cannot leave
   * the generated binding addressing the old one.
   */
  providerInput: { cellProps: "cellProps", useDataSource: "useDataSource" },
  /**
   * The free identifiers the binding's generated source references.
   *
   * Both are `wrapper-local` names `CELL_USER_SCOPE_BINDINGS` verifies as available in
   * cell source (`props` and `useDataSource`), which is what makes it legal for generated
   * code to name them without importing anything. A generator that emitted a third name
   * would be inventing an address — `RUNTIME_FACADE_FORBIDDEN_PATTERNS`'
   * `second-address-for-a-cell-binding`.
   */
  hostNames: ["props", "useDataSource"] as const,
  /**
   * The artifact-scope binding the entry wrapper assigns on every `App` call.
   *
   * A generated name rather than one the platform provides: the binding module's body
   * runs once, at artifact evaluation, but the entry wrapper (`entry.ts`) is called on
   * every render. So the two halves need one binding they both can name, declared at
   * artifact scope — which is exactly what the IIFE the bundler emits already is.
   *
   * This is what makes a re-render see new props without a re-evaluated module: the
   * provider reads {@link CELL_RUNTIME_BINDING_CONTRACT.livePropsVariable} instead of a
   * snapshot of the wrapper-local `props`, and the wrapper refreshes it before placing
   * the element. It is an artifact-internal name, not a host address, which is why it
   * is *not* one of `hostNames`: no template may read it as a free identifier, only
   * through the declaration both generated modules share.
   */
  livePropsVariable: "__fgcCellProps",
  /**
   * When the binding installs, stated as the ordering guarantee a generator can meet.
   *
   * "The artifact's own module evaluation" rather than "per render": the binding is a
   * module in the artifact's graph, so its body runs once when the artifact is evaluated,
   * and the platform calls the `App` binding afterwards. Installing later would leave the
   * first façade call unserved, which is the defect.
   */
  installTiming: "when the generated artifact is evaluated, before the platform calls its App binding",
  note: "The provider is built from the Cell's own `props` and `useDataSource` and is never read from a page global: #5 records both as values the runtime injects, and `props` is not a window property at all.",
  evidence: ["product-runtime-source", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

/** Derived from {@link CELL_RUNTIME_BINDING_CONTRACT}. */
export const CELL_RUNTIME_BINDING_HOST_NAMES = CELL_RUNTIME_BINDING_CONTRACT.hostNames;

// ---------------------------------------------------------------------------
// Cell code budget
// ---------------------------------------------------------------------------

/**
 * What was measured about cell source size.
 *
 * No hard limit was found, so no limit is claimed. The transpiler notice is the
 * one real cost: it is emitted at `console.error` level, which is why the
 * project's "console Error count === 0" gate is a *budget* gate and not just a
 * correctness gate. Turning this into a policy number is #21's decision, not
 * this module's.
 */
export const CELL_SOURCE_SIZE_OBSERVATIONS = {
  hardCharacterLimit: null,
  largestAcceptedSourceCharacters: 2097214,
  transpilerNoticeObservedAtCharacters: 2097214,
  transpilerNoticeNotObservedAtCharacters: 524350,
  transpilerNoticeConsoleLevel: "error",
  transpilerNoticeMessage:
    "[BABEL] Note: The code generator has deoptimised the styling of undefined as it exceeds the max of 500KB.",
  note: "The threshold is the browser transpiler's, reported as 500KB; the platform itself accepted a source roughly four times that.",
  evidence: ["designer-api", "generated-runtime-browser"] as readonly RuntimeEvidenceChannel[],
};

// ---------------------------------------------------------------------------
// Open questions
// ---------------------------------------------------------------------------

export interface RuntimeContractUnknown {
  readonly id: string;
  readonly question: string;
  readonly whyOpen: string;
  /** The Issue expected to settle it, when one owns the question. */
  readonly ownedBy?: string;
}

/**
 * Questions the contract probe could not settle.
 *
 * Recorded in code rather than only in the Issue so that a consumer of this
 * module cannot mistake an open question for a decided one.
 */
export const RUNTIME_CONTRACT_UNKNOWNS: readonly RuntimeContractUnknown[] = [
  {
    id: "shared-top-level-identifier",
    question: "May two cells declare the same top-level identifier?",
    whyOpen: "Each probe cell used a distinct name. The per-cell compilation scope implies yes, but this was not executed.",
  },
  {
    id: "property-change-component-state-survival",
    question: "Does a property change preserve React component state inside the cell?",
    whyOpen: "#176 settled the entry-vs-render half: `SetPropertyValue` re-renders the existing tree without re-executing the cell entry. What it did not measure is whether `useState` inside the component survives that re-render — that depends on whether the host produces a new element type per render or reuses the factory, which the probe did not isolate.",
    ownedBy: "#6",
  },
  {
    id: "artifact-teardown-observability",
    question:
      "Does the host's cell teardown reach the artifact — does the generated module ever observe an unmount signal?",
    whyOpen:
      "The re-render-vs-re-execute question this record used to carry is settled: #176 measured `SetPropertyValue` re-rendering the existing tree without re-executing the cell entry, and the artifact's wrapper refreshes its props reader on every `App` call, so a re-render sees fresh props either way. What is still not observable from this repository is the other half the original question bundled in — whether teardown reaches the artifact at all (`unmount-clears-the-cell-root` is read from the product source, not executed), which is why no teardown was added.",
    ownedBy: "#84",
  },
  {
    id: "absolute-source-ceiling",
    question: "Is there any absolute ceiling on cell source size?",
    whyOpen: "None found up to 2,097,214 characters; larger sources were not attempted and designer memory pressure was out of scope.",
    ownedBy: "#21",
  },
  {
    id: "permission-snapshot-empty",
    question: "Can props.Permissions come back empty for a configured permission?",
    whyOpen: "One early run reported an empty snapshot; a dedicated isolation run with the same configuration returned the expected value in three of three cells, so the observation is unreproduced. #176 re-confirmed the populated path on `12.0.102.0`.",
  },
  {
    id: "load-order-stability",
    question: "Is page-level frontend library load order stable across cells in general?",
    whyOpen: "One conflicting-order sample. The safe reading is already recorded as loadOrderGuaranteed: false.",
  },
  {
    id: "permission-refresh-without-reload",
    question: "Does the permission snapshot refresh when the signed-in user's roles change?",
    whyOpen: "Not exercised.",
  },
  {
    id: "signed-out-user-shape",
    question: "What does `props.Forguncy.getCurrentUser()` return when no user is signed in?",
    whyOpen: "#176 measured the signed-in shape on the dev site (which auto-signs Administrator in). The signed-out path needs either an anonymous-access page or a logged-out browser, neither of which the probe set up.",
    ownedBy: "#177",
  },
  {
    id: "logOut-redirect-observability",
    question: "Where does `props.Forguncy.logOut(navigateToHomePage)` actually navigate, and does `false` suppress the navigation?",
    whyOpen: "The wrapper forwards the argument to `Forguncy.logOut` verbatim; the host's redirect matrix is not part of the ReactCellType plugin source and was not exercised in a browser because logging out would end the probe session.",
    ownedBy: "#177",
  },
  {
    id: "image-context-populated-shape",
    question: "What keys and value shapes does `props.ImageContext` carry when the cell declares image data sources?",
    whyOpen: "The probe cell declared no image data sources, so `ImageContext` was the empty object — the empty-path shape is confirmed, the populated path is read from the runtime source (`{ [name]: src-url }`) but not executed.",
    ownedBy: "#177",
  },
  {
    id: "event-handler-executeCustomCommandObject-error-shape",
    question: "What does the cell observe when a configured event-handler command fails at runtime?",
    whyOpen: "#176 measured the firing semantics end-to-end but did not force a server-side failure. The runtime wraps the call in no cell-visible error surface — failures are the host's command pipeline's, not the cell's.",
    ownedBy: "#177",
  },
];

export function openRuntimeContractQuestions(ownedBy?: string): readonly RuntimeContractUnknown[] {
  return ownedBy === undefined
    ? RUNTIME_CONTRACT_UNKNOWNS
    : RUNTIME_CONTRACT_UNKNOWNS.filter(unknown => unknown.ownedBy === ownedBy);
}
