/**
 * The host bridge's plan: what a decision list asks of the bridge, and what is wrong with it.
 *
 * Decision source: GitHub Issue #9 — "Spec: host module bridge for React,
 * ReactDOM, antd and built-in globals"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/9), downstream of #6
 * "generated ReactCellType artifact and compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6).
 *
 * Split out of `host-bridge.ts` (#170) along the seam between *planning* and the two
 * halves the plan is built from: the generated source it catalogs
 * ({@link ./host-bridge-modules.ts}) and the findings it reports
 * ({@link ./host-bridge-diagnostics.ts}). This module is the only one of the three that
 * reads a decision list.
 *
 * Two corrections to the plan's contract were made after #9 landed, and they are
 * Issue #52 — "host bridge plan — explicit-empty decisions, and whether the plan may
 * be wired"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/52): an explicitly empty
 * input is now classified as `stated`, and {@link HostBridgePlan.wireable} refuses a
 * plan whose mapping information contradicts itself. Both are parity with #12's
 * sibling plan rather than a second opinion on the rule; the reasoning sits on the
 * fields it constrains.
 */

import {
  assertHostBridgeContract,
  CELL_PRESET_LIBRARIES,
  findHostBridgeModuleMapping,
  hostBridgeAdapterMappings,
  hostBridgeGlobalIsAlwaysAvailable,
  hostBridgeGlobalMappings,
  hostBridgeModuleIds,
  hostBridgeShapeFor,
  HOST_BRIDGE_MAPPINGS,
  HostBridgeContractError,
} from "@forguncy-react-workspace/core";
import type {
  CellPresetLibrary,
  DependencyDecision,
  HostBridgeMapping,
  HostBridgeMappingKind,
  HostBridgeModuleShape,
} from "@forguncy-react-workspace/core";

import { findDependencyDecision } from "./specifier.ts";
import type { HostBridgeDiagnostic } from "./host-bridge-diagnostics.ts";
import { createHostBridgeDiagnostic, formatHostBridgeDiagnostics } from "./host-bridge-diagnostics.ts";
import { renderHostBridgeModule } from "./host-bridge-modules.ts";

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface HostBridgeInterception {
  /** The mapping row the interception came from. */
  readonly specifier: string;
  /** The exact module id intercepted. One interception covers one id. */
  readonly moduleId: string;
  readonly kind: HostBridgeMappingKind;
  /**
   * What the interposed module promises for this id.
   *
   * A row can promise different things per id — `react-dom` binds the host object,
   * its subpath gets a narrowed view — so this is the shape the source was generated
   * for, and it is what a reviewer checks against #9's mapping bullets.
   */
  readonly shape: HostBridgeModuleShape;
  readonly mapping: HostBridgeMapping;
  /** The source the bundler loads in place of the dependency. */
  readonly source: string;
  /**
   * Whether the dependency's own implementation must be absent from the artifact.
   *
   * Read off the mapping rather than off the decision, because the reason differs
   * by kind and both reasons are about the mapping: a `host-global` row means the
   * page already has this module, so a bundled copy is a second implementation of
   * something that exists; an adapter row means the *published* module would carry
   * its own React, which is the duplicate the adapter exists to avoid. Either way
   * the flag is the answer to #9's first acceptance criterion at the planning
   * level.
   */
  readonly bundledForbidden: boolean;
}

export interface HostBridgePlan {
  /**
   * Every module id the bridge *could* intercept, with the source for its shape.
   *
   * The table, projected. A catalog entry is a capability, not a decision: it says
   * what the bridge would generate if the artifact asked for that module through
   * the host. Consult it to answer "what does the bridge know how to do".
   */
  readonly catalog: readonly HostBridgeInterception[];
  /**
   * The catalog entries this artifact actually activates — what a resolver hook may
   * be wired from, and only when {@link HostBridgePlan.wireable} is `true`.
   *
   * Separate from {@link catalog} because a mapping says *how* a `host` decision
   * compiles, never that a package must be `host`. Wiring the catalog in wholesale
   * would make the presence of a row override an `inline`/`extension`/`replace`
   * decision and intercept a module the artifact deliberately carries its own copy
   * of, which is the policy this contract exists to avoid.
   *
   * Empty whenever {@link HostBridgePlan.wireable} is `false` — a plan that may not be
   * wired from never hands back a list to wire, so this array is not the field to test
   * to decide whether wiring is allowed. The converse does not hold: a known-empty
   * artifact is `wireable` with an empty `interceptions`, because "the answer is
   * nothing" and "the answer is unknown" are different answers (see
   * {@link HostBridgePlan.activation}). Branch on `wireable`, read this array for what
   * to wire.
   */
  readonly interceptions: readonly HostBridgeInterception[];
  /**
   * Whether the caller supplied enough input to know what this artifact activates.
   *
   * `unstated` means neither `decisions` nor `referencedSpecifiers` was given, so
   * `interceptions` is empty because the answer is unknown — not because the
   * artifact activates nothing. A caller may not wire resolver hooks from an
   * `unstated` plan.
   *
   * An explicitly empty `decisions` or `referencedSpecifiers` is *stated*, not
   * unstated: a caller that knows there are no decisions has answered the question,
   * and reading that as "unknown" would make a known-empty artifact indistinguishable
   * from an unspecified one.
   */
  readonly activation: HostBridgeActivation;
  /**
   * Whether {@link interceptions} may be wired from at all.
   *
   * `false` for problems of two kinds, and the field is one boolean rather than a
   * conjunction a caller has to remember because the failure mode of forgetting half of
   * it is a resolver wired to something no guarantee covers:
   *
   * - `activation === "unstated"` — the caller did not say what the artifact uses, so
   *   there is nothing to wire *from*;
   * - the mapping information contradicts itself — so what is in the list cannot be
   *   trusted even though the artifact is fully specified. Two ways that happens: two
   *   rows claim one module id, or a table guard and a decision audit each leave
   *   "what does this import resolve to" with two answers.
   *
   * The second kind needs its own statement because a diagnostic is advice. The case
   * that makes it necessary: two rows claiming one module id, where a `host` decision
   * naming that id would otherwise satisfy the activation predicate for *both* of them
   * and put two different generated sources for one id into a wireable list.
   * `host-mapping-conflict` is reported either way, but a caller that wires first and
   * reports later would be resolving the import by table order — the state the guard
   * exists to prevent. A contradictory mapping therefore has no wireable outcome,
   * whatever the caller does with the diagnostics.
   *
   * The bound on the rule: a `host` decision with no mapping at all
   * (`host-mapping-missing`) is a *truthful absence* rather than a contradiction — the
   * artifact does have imports, and the rows that do exist are precisely known — so it
   * must not block wiring.
   */
  readonly wireable: boolean;
  readonly diagnostics: readonly HostBridgeDiagnostic[];
}

export type HostBridgeActivation = "stated" | "unstated";

export interface PlanHostBridgeOptions {
  readonly mappings?: readonly HostBridgeMapping[];
  /**
   * The decisions the artifact is compiled against.
   *
   * Used for two things, and both need it: which bridged modules the artifact
   * actually contains, and which of them a bare `host` claim has no mapping for.
   * An explicit empty array is a caller saying the artifact has none — which is
   * *stated*, and is the reason this stays `undefined` when omitted rather than
   * being defaulted here.
   */
  readonly decisions?: readonly DependencyDecision[];
  /**
   * Specifiers the artifact references, when the caller knows them.
   *
   * The second half of "which bridged modules this cell actually uses". A bare
   * import can reach the bridge without a decision row, and a diagnostic about a
   * module an artifact never mentions is a false positive a caller then has to
   * explain away.
   */
  readonly referencedSpecifiers?: readonly string[];
  /**
   * The preset the cell declares, when known.
   *
   * The input that turns a preset-conditional mapping's absence into a *build*
   * diagnostic instead of a runtime surprise — for the imports the cell actually
   * uses. Omitting it is not the same as declaring `None`: it means the caller did
   * not tell the bridge what the cell declares, and the bridge then reports nothing
   * rather than guessing.
   */
  readonly cellPreset?: CellPresetLibrary["name"];
}

/**
 * What the compilation path does with the bridge, plus what is wrong with it.
 *
 * Built by walking the mapping table — and then each row's declared module ids,
 * because that is the granularity #9 writes its mapping list at. Adding a row adds
 * one interception per id it intercepts, each carrying the source generated for its
 * own shape; there is no second list to keep in step.
 */
export function planHostBridge(options: PlanHostBridgeOptions = {}): HostBridgePlan {
  const mappings = options.mappings ?? HOST_BRIDGE_MAPPINGS;
  const diagnostics: HostBridgeDiagnostic[] = [];

  // The table's own coherence first. `core`'s guard throws rather than reporting,
  // because an incoherent table is a programming error; here the throw is
  // converted so a caller doing a dry run gets a plan plus a diagnostic instead of
  // an exception that skips the rest of the audit.
  try {
    assertHostBridgeContract(mappings);
  } catch (error) {
    diagnostics.push(
      createHostBridgeDiagnostic(
        "host-mapping-conflict",
        "bridge-mapping-table",
        error instanceof HostBridgeContractError ? error.message : String(error),
      ),
    );
  }

  const catalog: HostBridgeInterception[] = [];
  for (const mapping of mappings) {
    for (const moduleId of hostBridgeModuleIds(mapping)) {
      const shape = hostBridgeShapeFor(mapping, moduleId);
      if (shape === undefined) continue;

      // Rendering is the other half of "a dry run returns a plan, not an exception".
      // The contract guard above catches a malformed row, but some malformed rows are
      // also unrenderable — an adapter with no delegate throws while generating, not
      // while validating — so a failure here is a diagnostic and a skipped entry
      // rather than an exception that discards the rest of the audit.
      let source: string;
      try {
        source = renderHostBridgeModule(mapping, moduleId);
      } catch (error) {
        diagnostics.push(
          createHostBridgeDiagnostic(
            "host-mapping-conflict",
            moduleId,
            `The mapping for this module id cannot be rendered: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        continue;
      }

      catalog.push({
        specifier: mapping.specifier,
        moduleId,
        kind: mapping.kind,
        shape,
        mapping,
        source,
        bundledForbidden: true,
      });
    }
  }

  // A duplicated claim would make the plan's interception order decide the result,
  // which is the same failure `host-mapping-conflict` reports for the table; the
  // guard above already covers it, and this keeps the check meaningful when a
  // caller passes a table it built itself.
  const seen = new Map<string, string>();
  for (const interception of catalog) {
    const owner = seen.get(interception.moduleId);
    if (owner !== undefined && owner !== interception.specifier) {
      diagnostics.push(
        createHostBridgeDiagnostic(
          "host-mapping-conflict",
          interception.moduleId,
          `Both "${owner}" and "${interception.specifier}" intercept this module id, so which source is used would depend on table order.`,
        ),
      );
    }
    seen.set(interception.moduleId, interception.specifier);
  }

  // `undefined` stays `undefined`: an explicitly empty list is a caller that answered
  // "what does this artifact use" with "nothing", which is a different answer from not
  // having been asked. Pre-defaulting the array here is what used to erase that
  // distinction, so the supplied-ness is threaded into `hostBridgeUsage` instead.
  const decisions = options.decisions;
  const usage = hostBridgeUsage(decisions, options.referencedSpecifiers, mappings);

  diagnostics.push(...auditHostBridgeDecisions(decisions ?? [], mappings));
  diagnostics.push(...auditHostBridgePresetReadiness(mappings, options.cellPreset, usage));

  // Whether the mapping information the interceptions are *derived from* names exactly
  // one source per module id. Three producers report `host-mapping-conflict` — the table
  // guard, the duplicate scan above, and a row that cannot be rendered — and what they
  // have in common is that the table cannot be trusted to answer "what does this import
  // resolve to". Two rows claiming one id answer it twice; an unrenderable row answers
  // it with a table that does not describe itself. A resolver wired from a list built on
  // either would be picking one by table order.
  //
  // Keyed on the code rather than on the specific producer because the three are
  // interchangeable as far as this question goes. Every other code is deliberately
  // absent, and each for its own reason: `host-mapping-missing` says there is *no*
  // mapping, so a module's absence from the list is truthful rather than contradictory;
  // `host-adapter-not-used` is about how a JSX runtime id is provided, not about a
  // bridged import; `host-module-duplicated` is about a module the artifact deliberately
  // carries a copy of. None of the three leaves a live interception with two possible
  // sources.
  const mappingInformationIsCoherent = !diagnostics.some(
    diagnostic => diagnostic.code === "host-mapping-conflict",
  );

  // Decided once, so "what is wired" and "what is checked" cannot disagree about what
  // the artifact contains — the state in which a diagnostic is reported for a module
  // the plan does not intercept, or a hook is wired for one the audit never examined.
  const wireable = usage.state === "stated" && mappingInformationIsCoherent;
  const interceptions = wireable
    ? catalog.filter(interception => usage.activated.has(interception.moduleId))
    : [];

  return { catalog, interceptions, activation: usage.state, wireable, diagnostics };
}

export interface HostBridgeUsage {
  readonly state: HostBridgeActivation;
  /**
   * The module ids the bridge is asked to intercept, and the only ones a resolver
   * hook may be wired from.
   */
  readonly activated: ReadonlySet<string>;
  /**
   * The module ids whose *host global* the artifact relies on.
   *
   * A superset of {@link activated}, and not the same question — conflating the two
   * is what made the first version of the preset audit wrong in both directions:
   *
   * - a `host` decision activates the bridge *and* depends on the page providing the
   *   global;
   * - a reference to a gated module with **no** decision does not activate anything
   *   (nothing has said the page provides it, so a hook would be overriding an
   *   unresolved import) but it *is* a real preset question, because the artifact uses
   *   the import either way;
   * - a reference **overridden** by a non-`host` decision depends on nothing: the
   *   artifact carries its own copy, its own extension global, or its own alternative,
   *   and must not be told to declare a preset it deliberately does not use.
   */
  readonly presetDependent: ReadonlySet<string>;
}

/**
 * What this artifact asks of the bridge, and of the host's preset chains.
 *
 * `unstated` when neither input was supplied: the answer is unknown, and the caller is
 * told so rather than handed an empty activation that reads like a decision. Supplied —
 * even supplied empty — is `stated`, because "the caller said there is nothing" and
 * "the caller did not say" are the two answers `activation` exists to separate.
 *
 * Takes the mapping table for the same reason the catalog does. A project-supplied row
 * has to participate in activation and in the preset audit, not merely appear in the
 * catalog — a caller that extends the table and then finds its row invisible to every
 * reference would be looking at a capability the bridge refuses to use.
 */
function hostBridgeUsage(
  decisions: readonly DependencyDecision[] | undefined,
  referencedSpecifiers: readonly string[] | undefined,
  mappings: readonly HostBridgeMapping[],
): HostBridgeUsage {
  if (referencedSpecifiers === undefined && decisions === undefined) {
    return { state: "unstated", activated: new Set(), presetDependent: new Set() };
  }

  const adapterModuleIds = new Set(hostBridgeAdapterMappings(mappings).flatMap(hostBridgeModuleIds));
  const activated = new Set<string>();
  const presetDependent = new Set<string>();

  for (const decision of decisions ?? []) {
    // A JSX runtime id is not a `host` strategy — the resolver requires `replace`
    // for it, because the published module would carry its own React — so the adapter
    // is activated by the id being reached, and a decision naming one is what a
    // compiler would otherwise act on.
    if (decision.strategy === "host") {
      activated.add(decision.packageName);
      presetDependent.add(decision.packageName);
    } else if (adapterModuleIds.has(decision.packageName)) {
      activated.add(decision.packageName);
    }
  }

  for (const specifier of referencedSpecifiers ?? []) {
    if (adapterModuleIds.has(specifier)) {
      activated.add(specifier);
      continue;
    }

    if (findHostBridgeModuleMapping(specifier, mappings) === undefined) continue;

    // The governing decision is found the way the compile boundary finds it: a
    // `react-dom` decision governs an import of `react-dom/client`. Using an exact
    // comparison here would leave the very module id the source imports
    // unactivated — the subpath would be in the catalog and never wired.
    const governing = findDependencyDecision(decisions ?? [], specifier);

    if (governing === undefined) {
      // A reference alone never activates a host-global mapping: without a `host`
      // decision nothing says the page provides the module, and wiring a hook would
      // override whatever the decision layer is going to say about it. It is still a
      // real preset question, because the artifact imports it either way.
      presetDependent.add(specifier);
      continue;
    }

    if (governing.strategy === "host") {
      activated.add(specifier);
      presetDependent.add(specifier);
    }
    // Any other governing strategy carries its own copy, its own global, or its own
    // alternative: neither activated nor dependent on a host global.
  }

  return { state: "stated", activated, presetDependent };
}

/**
 * A decision list against the mapping table.
 *
 * Four questions, each a way a decision and a mapping can disagree:
 *
 * - a `host` decision for a module the table cannot bind;
 * - a `host` decision whose `globalName` is not the one the row it selects binds, which
 *   leaves "what does this import resolve to" with two answers — the decision's global
 *   and the row's;
 * - a JSX runtime id resolved by a page global, when only the adapter has the
 *   module's shape;
 * - a bridged module that the decision bundles anyway, which is the duplicated
 *   identity #9's first acceptance criterion is about.
 */
function auditHostBridgeDecisions(
  decisions: readonly DependencyDecision[],
  mappings: readonly HostBridgeMapping[],
): readonly HostBridgeDiagnostic[] {
  const diagnostics: HostBridgeDiagnostic[] = [];
  const adapterModuleIds = new Set(hostBridgeAdapterMappings(mappings).flatMap(hostBridgeModuleIds));

  for (const decision of decisions) {
    const packageName = decision.packageName;
    const mapping = findHostBridgeModuleMapping(packageName, mappings);
    const providesModule = decision.strategy === "host" || decision.strategy === "inline" || decision.strategy === "extension";

    if (adapterModuleIds.has(packageName) && providesModule) {
      diagnostics.push(
        createHostBridgeDiagnostic(
          "host-adapter-not-used",
          packageName,
          `The decision is \`${decision.strategy}\`, which claims the module is provided, but this module id is bridged by the generated JSX runtime adapter — no page object has its shape.`,
        ),
      );
    }

    if (decision.strategy === "host") {
      // An adapter row is not a missing mapping — the module *is* bridged, by
      // generated code rather than by a global — so it is reported once above, as
      // `host-adapter-not-used`, and not again here.
      const bridgedByAdapter = mapping !== undefined && mapping.kind === "jsx-runtime-adapter";
      const bindsThisId = mapping !== undefined && hostBridgeModuleIds(mapping).includes(packageName);

      if (mapping === undefined) {
        diagnostics.push(
          createHostBridgeDiagnostic(
            "host-mapping-missing",
            packageName,
            `The decision is \`host\` and the bridge has no mapping for this module id, so it would compile to a reference nothing supplies.`,
          ),
        );
      } else if (!bridgedByAdapter && !bindsThisId) {
        diagnostics.push(
          createHostBridgeDiagnostic(
            "host-mapping-missing",
            packageName,
            `The mapping for this module covers ${hostBridgeModuleIds(mapping).join(", ")} and not this exact id.`,
          ),
        );
      } else if (mapping.kind === "host-global" && mapping.globalName !== decision.globalName) {
        // The state the extension path refuses for the same reason: the row the decision
        // selects binds one page global and the decision names another, so "what does
        // this import resolve to" has two answers. The generated module would read the
        // row's global while the lock records the decision's, and the mismatch is
        // invisible in the artifact — a later audit sees a `host` decision naming a
        // global that *does* exist, so it has nothing to object to. The plan is where
        // the disagreement is still visible, which is why it is reported here and why it
        // makes the plan non-wireable.
        //
        // The owner is overridden, because the code's static rule names the mapping
        // table — true of the table-level origin and false of this one. Here the row is
        // correct and the *decision* is the input that has to change, so the rule's
        // `bridge-mapping` would send an Agent to edit a row that is already right.
        // `fixableByMapping: false` says the same thing in the other direction: no table
        // edit repairs this, which is what keeps a caller from going to look for a row
        // to add.
        diagnostics.push(
          createHostBridgeDiagnostic(
            "host-mapping-conflict",
            packageName,
            `The decision names the global "${decision.globalName}" while the mapping row for this module binds "${mapping.globalName}", so the compiled module and the recorded decision would disagree about which page object the import resolves to.`,
            { fixOwner: "dependency-decision", fixableByMapping: false },
          ),
        );
      }
    }

    if (decision.strategy === "inline" && mapping !== undefined && mapping.kind === "host-global") {
      // Scoped to identity-sensitive rows, which is the same line the resolver's
      // `auditHostInlineConflict` draws and for the same reason: a mapping says how a
      // `host` decision compiles, never that the package must be `host`. For a module
      // whose identity is not load-bearing there is nothing shared to split, so a
      // cell-local copy is a legitimate choice — reporting it would turn the presence
      // of a table row into a policy.
      if (mapping.identitySensitive === true) {
        diagnostics.push(
          createHostBridgeDiagnostic(
            "host-module-duplicated",
            packageName,
            `The artifact would carry its own copy of a module decided \`host\` and mapped to "${mapping.globalName}". For an identity-sensitive module this is not a size decision: #5 verified one React object per page whose identity hooks and context dispatch through, so a second copy is observable from every cell.`,
          ),
        );
      }
    }
  }

  return diagnostics;
}

/**
 * Whether the cell's declared preset makes the globals the cell's bridged imports need.
 *
 * Two conditions, and both are needed to keep this from becoming a false positive:
 *
 * - the caller said which preset the cell declares (otherwise the bridge abstains
 *   rather than guessing), and
 * - the artifact actually relies on that mapping's global, as
 *   {@link HostBridgeUsage.presetDependent} defines it — which excludes, in
 *   particular, a module some other decision deliberately bundles.
 *
 * Only the preset-conditional rows. A global recorded as `always` is the generated
 * module's business — it refuses at the point the import is evaluated — and its
 * absence is not a per-cell configuration fact.
 */
function auditHostBridgePresetReadiness(
  mappings: readonly HostBridgeMapping[],
  cellPreset: CellPresetLibrary["name"] | undefined,
  usage: HostBridgeUsage,
): readonly HostBridgeDiagnostic[] {
  if (cellPreset === undefined) return [];

  const preset = CELL_PRESET_LIBRARIES.find(candidate => candidate.name === cellPreset);
  if (preset === undefined) {
    // A preset name the runtime contract does not record is a configuration error
    // about the cell, not about an import, so it is reported whether or not the
    // caller said what the artifact uses.
    return [
      createHostBridgeDiagnostic(
        "host-mapping-missing",
        "cell-preset",
        `The cell declares preset "${cellPreset}", which is not one of the presets the runtime contract records.`,
      ),
    ];
  }

  // "The caller did not say what this cell uses" is not "this cell uses nothing".
  if (usage.state === "unstated") return [];

  const diagnostics: HostBridgeDiagnostic[] = [];
  for (const mapping of hostBridgeGlobalMappings(mappings)) {
    if (hostBridgeGlobalIsAlwaysAvailable(mapping)) continue;
    if (!hostBridgeModuleIds(mapping).some(moduleId => usage.presetDependent.has(moduleId))) continue;
    if (preset.providesGlobals.includes(mapping.globalName)) continue;
    diagnostics.push(
      createHostBridgeDiagnostic(
        "host-global-missing",
        mapping.specifier,
        `The cell declares preset "${preset.name}", which does not install "${mapping.globalName}", and the artifact relies on it. #5 records this global's absence as a supported state rather than a broken page, so the generated module binds it as-is and the cell meets an undefined value at the point of use.`,
      ),
    );
  }
  return diagnostics;
}

/** A report block for a CI log or a PR body. */
export function formatHostBridgePlan(plan: HostBridgePlan): string {
  // Which of the two reasons applies is the difference between "tell me what this cell
  // uses" and "your mapping table is broken", so the report names it rather than
  // saying only that wiring was refused.
  const wiring = plan.wireable
    ? "allowed"
    : plan.activation === "unstated"
      ? "refused (no decisions and no reference list were supplied, so the answer is unknown)"
      : "refused (the mapping information contradicts itself)";
  return [
    `Host bridge catalog: ${plan.catalog.length} module id(s): ${plan.catalog.map(entry => entry.moduleId).join(", ")}`,
    `Activations: ${plan.activation}`,
    `Wiring: ${wiring}`,
    `Active interceptions: ${plan.interceptions.map(entry => `${entry.moduleId} (${entry.shape})`).join(", ") || "(none)"}`,
    plan.diagnostics.length === 0
      ? "No bridge diagnostics."
      : `${plan.diagnostics.length} bridge diagnostic(s):\n${formatHostBridgeDiagnostics(plan.diagnostics)}`,
  ].join("\n");
}
