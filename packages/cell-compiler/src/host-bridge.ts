/**
 * The compilation projection of #9's host module bridge.
 *
 * Decision source: GitHub Issue #9 — "Spec: host module bridge for React,
 * ReactDOM, antd and built-in globals"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/9), which is itself
 * downstream of:
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 * - #6 "generated ReactCellType artifact and compiler boundary"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/6
 *
 * `core` owns *which* import is bound to which host identity and *why*. This
 * module owns what the compilation path does with that: the source handed to the
 * bundler in place of a dependency, and the diagnostics the bridge reports about a
 * decision list.
 *
 * Three things here are deliberate, and each is the answer to one of #9's
 * acceptance criteria:
 *
 * 1. **The interception is keyed on the specifier and the generated module is a
 *    pure function of the mapping.** No function in this module takes authored
 *    source as an argument, so there is no code path that could rewrite one (#9:
 *    "Standard source imports remain unchanged") and no place for a
 *    package-specific AST rule to live (#9: "without hardcoding package-specific
 *    AST rewrites"). {@link planHostBridge} derives its interception set by
 *    walking the mapping table, so a new row is the whole of the change.
 * 2. **A required global fails through a structured error, not through
 *    `undefined`.** #5 records `React` and `ReactDOM` as `always` available, so
 *    their absence means the artifact is running somewhere that is not the pinned
 *    target — a state worth failing on with a code an Agent can branch on, rather
 *    than one whose symptom appears wherever the value is first used.
 * 3. **A preset-conditional global does not throw.** #5 measured two cells on one
 *    page disagreeing about the same preset global, so absence is a supported
 *    state. It is reported at build time, when the cell's own preset is known, and
 *    at runtime it stays `undefined` exactly as #5 says it will be.
 *
 * Scope note: this module generates the interposed modules and audits a decision
 * list against the table. Every runtime check lives inside the generated module for
 * the id that needs it — there is deliberately no separate per-artifact entry guard
 * (#164: the per-module checks already fail with `host-global-missing`, and an exact
 * `React.version` comparison at cell entry would break deployed Cells on harmless
 * host patch upgrades). It does not drive a bundler, assemble an artifact, or emit a
 * diagnostic into #6's artifact report — wiring the bridge into the compile boundary
 * is the compiler MVP's job (#7), and asserting a bridge diagnostic through
 * `CellArtifactDiagnostic` would put two vocabularies in one report before anyone has
 * decided how they compose.
 *
 * Two corrections to the plan's contract were made after #9 landed, and they are
 * Issue #52 — "host bridge plan — explicit-empty decisions, and whether the plan may
 * be wired"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/52): an explicitly empty
 * input is now classified as `stated`, and {@link HostBridgePlan.wireable} refuses a
 * plan whose mapping information contradicts itself. Both are parity with #12's
 * sibling plan rather than a second opinion on the rule; the reasoning sits on the
 * fields it constrains.
 *
 * ## The split (#170)
 *
 * This file is the projection's entry point and states the contract above; the three
 * cohesive halves it was split along are siblings:
 *
 * - `host-bridge-modules.ts` — the generated source, a pure function of a mapping row
 *   and a module id;
 * - `host-bridge-diagnostics.ts` — the finding's shape, its vocabulary over `core`'s
 *   rule table, and the line a report prints;
 * - `host-bridge-plan.ts` — the plan, the only one of the four that reads a decision
 *   list.
 *
 * The dependency runs one way (entry → plan → modules and diagnostics), so nothing here
 * is circular. Every name this entry used to declare is re-exported below, so an
 * importer of `./host-bridge.ts` — and every name `./internal` projects from it — sees
 * the surface it always did.
 */

import type { JSX_RUNTIME_ADAPTER_EXPORTS } from "@forguncy-react-workspace/core";

export { HOST_BRIDGE_GENERATED_BANNER } from "./host-bridge-modules.ts";
export {
  renderHostBridgeAdapterModule,
  renderHostBridgeGlobalModule,
  renderHostBridgeModule,
} from "./host-bridge-modules.ts";

export {
  createHostBridgeDiagnostic,
  formatHostBridgeDiagnostic,
  formatHostBridgeDiagnostics,
  hostBridgeDiagnosticRule,
} from "./host-bridge-diagnostics.ts";
export type { CreateHostBridgeDiagnosticOptions, HostBridgeDiagnostic } from "./host-bridge-diagnostics.ts";

export { formatHostBridgePlan, planHostBridge } from "./host-bridge-plan.ts";
export type {
  HostBridgeActivation,
  HostBridgeInterception,
  HostBridgePlan,
  HostBridgeUsage,
  PlanHostBridgeOptions,
} from "./host-bridge-plan.ts";

/** The JSX runtime exports a generated adapter must define, re-exported for tests. */
export type HostBridgeAdapterExportName = (typeof JSX_RUNTIME_ADAPTER_EXPORTS)[number];
