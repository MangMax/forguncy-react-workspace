/**
 * The local Vite+ development runtime's contract: what a local dev loop may do,
 * what it may claim, and how it stays wired to the same host decisions the
 * compile path uses.
 *
 * Decision source: GitHub Issue #22 — "Spec: local Vite+ development runtime for
 * React Cells"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/22), which is
 * downstream of:
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 * - #9 "host module bridge for React, ReactDOM, antd and built-in globals"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/9
 * - #27 "typed Forguncy runtime facade for application-owned capabilities"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/27
 *
 * #22's Problem section states the tension this module has to resolve: requiring
 * a full Forguncy sync/generate cycle for every UI change "would keep the
 * feedback loop much slower than a normal React project", and then, in the same
 * breath, "without pretending a simulator can fully replace real Forguncy
 * validation". A local harness is therefore useful exactly to the extent that it
 * is *honest about what it is not* — and the honesty has to be structural rather
 * than a paragraph, because the failure mode is silent: a cell that renders
 * locally and breaks on the page looks identical, during development, to a cell
 * that renders locally and works.
 *
 * So this module's subject is not the harness. It is the boundary and the wiring:
 *
 * 1. **Which half of #22's workflow may claim anything, and at what level.** The
 *    loop is recorded stage by stage, each stage carrying `core`'s own
 *    `DependencyCheckLevel` and a required statement of what it does *not*
 *    establish. Exactly the last stage is `real-runtime`. That is AGENTS.md's
 *    "a green local build is not runtime compatibility" turned into a data
 *    shape rather than a rule someone has to remember.
 * 2. **What the local runtime is not allowed to reproduce** (#22's
 *    Non-responsibilities), each entry naming either the #4 concern it protects
 *    or the contract that actually owns the behaviour locally replaced.
 * 3. **How the host surface is derived rather than duplicated.** #22 requires
 *    that "host dependency mapping is reusable between compiler and dev runtime
 *    instead of maintaining two unrelated maps", so this module holds a
 *    *projection* of #9's `HOST_BRIDGE_MAPPINGS`: one row per bridge row, none
 *    invented, none silently missing, and nothing that runs the generated bridge
 *    module — because that module's whole job is to bind a page global, and
 *    locally there is no page.
 * 4. **What a mock may and may not be.** The project-supplied surface is #27's
 *    `RuntimeFacadeHostBindings`, so there is one vocabulary for "what a cell can
 *    reach" rather than a second mock-only one; and a mock narrower than the host
 *    is refused as loudly as a mock wider than it.
 *
 * Scope note: this module decides what the local loop *is allowed to be and to
 * claim*, and audits a local configuration for the gaps. It does not implement
 * the harness or mount anything (#23), generate a Cell artifact (#6/#7), choose a
 * dependency strategy (#4/#16), or synchronise through MCP (#19/#20). Every
 * record below is either a citation of an upstream decision or an explicit
 * statement about this local process; the two are kept visually apart on purpose.
 */

import {
  CELL_PROPS_BASE_KEYS,
  CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR,
  defineDecisionProvenance,
  DEPENDENCY_STRATEGIES,
  GOVERNING_ARCHITECTURE_DECISIONS,
  HOST_BRIDGE_DECISION,
} from "@forguncy-react-workspace/core/browser";
import type {
  ArchitectureDecisionSource,
  DependencyCheckLevel,
  DependencyStrategy,
} from "@forguncy-react-workspace/core/browser";

import { LOCAL_DEV_RUNTIME_DECISION, RUNTIME_FACADE_DECISION } from "./provenance.ts";
import type { RuntimeFacadeHostBindings, RuntimeFacadeProvider } from "./contract.ts";

// ---------------------------------------------------------------------------
// The loop, and which half of it may claim anything
// ---------------------------------------------------------------------------

export const LOCAL_DEV_LOOP_STAGE_IDS = [
  "edit-cell-source",
  "local-dev-server",
  "local-ui-feedback",
  "compile-artifact",
  "mcp-sync",
  "forguncy-page-validation",
] as const;

export type LocalDevLoopStageId = (typeof LOCAL_DEV_LOOP_STAGE_IDS)[number];

export interface LocalDevLoopStage {
  readonly id: LocalDevLoopStageId;
  /** The step, in #22's own workflow wording. */
  readonly step: string;
  /** The command that performs it, when this repository already has one. */
  readonly command?: string;
  /**
   * The level of evidence this stage produces.
   *
   * `core`'s `DependencyCheckLevel`, reused rather than re-spelled: #4 already
   * decided that a check is `local` or `real-runtime`, and a second vocabulary
   * for the same distinction is precisely how a green local build gets reported
   * as runtime compatibility (#4's own docstring says so).
   */
  readonly claimLevel: DependencyCheckLevel;
  /** What running this stage does establish. */
  readonly establishes: string;
  /**
   * What it does not, stated per stage.
   *
   * Required and non-empty for every stage, including the `local` ones. The
   * interesting omissions are not the real-runtime stage's; they are the local
   * ones' — a dev server that renders a cell says nothing about whether the
   * platform will accept the source, and a stage record that only lists what it
   * proves is the one that gets over-read.
   */
  readonly doesNotEstablish: string;
  /** Who owns the evidence this stage cannot produce, when it cannot. Required when `claimLevel` is `real-runtime`. */
  readonly evidenceOwner?: string;
}

/**
 * #22's developer workflow, as six stages and two levels.
 *
 * `edit-cell-source` and `local-ui-feedback` are separate stages rather than one
 * because the edit is where #22's "reuse the same authored source" requirement
 * bites: a stage list that fused them would leave no place to say that the source
 * being edited is the artifact's source and not a harness copy.
 */
export const LOCAL_DEV_LOOP_STAGES: readonly LocalDevLoopStage[] = [
  {
    id: "edit-cell-source",
    step: "edit React/TS source",
    claimLevel: "local",
    establishes: "That a change was made to the file the Cell artifact is generated from.",
    doesNotEstablish:
      "That the edited source is acceptable to the platform. #5 records the designer refusing `import` and `export` declarations outright, so the ordinary shape of an authored module is not the shape the designer will write.",
  },
  {
    id: "local-dev-server",
    step: "start the local dev server",
    command: "vp dev",
    claimLevel: "local",
    establishes: "That the Cell entry mounts as a normal React tree in a normal Vite process.",
    doesNotEstablish:
      "Anything about the host. There is no page, no ReactCellType runtime and no frontend-library loader in this process, so a served module graph says nothing about what the page will have.",
  },
  {
    id: "local-ui-feedback",
    step: "HMR / local UI feedback",
    claimLevel: "local",
    establishes:
      "That the Cell's own UI, local interaction state, forms and visualisation behave as the source says they should, against the versions the project installed.",
    doesNotEstablish:
      "That the same UI behaves that way on the page. The substituted host modules are the published packages at #5's recorded versions where a version was recorded at all, and a preset-conditional global may legitimately be absent on a real cell.",
  },
  {
    id: "compile-artifact",
    step: "compile the Cell artifact",
    command: "vp run -r build",
    claimLevel: "local",
    establishes:
      "#4's `local` checks for the artifact: bundling succeeds, no second copy of a host-owned identity is carried, and the artifact's own guarantees hold against the generated output.",
    doesNotEstablish:
      "That the artifact runs on the target. AGENTS.md requires these to be reported separately, and every strategy in #4 carries at least one `real-runtime` check that no local build can discharge.",
  },
  {
    id: "mcp-sync",
    step: "MCP sync",
    claimLevel: "local",
    establishes: "That the sync call was made and what it wrote, whichever surface #19/#20 settles on.",
    doesNotEstablish:
      "That the Forguncy project accepted it. The zero-project-errors check exists only inside a real project, which is why #20 carries `status:needs-validation` and why the clean-checkout gate is #25's rather than a local step.",
    evidenceOwner: "#19 / #20 (one-way MCP sync contract and implementation)",
  },
  {
    id: "forguncy-page-validation",
    step: "real Forguncy validation at integration checkpoints",
    claimLevel: "real-runtime",
    establishes:
      "The evidence this repository treats as compatibility: the cell renders in a real page, its declared libraries resolve, and its dependency strategy's `real-runtime` checks are exercised.",
    doesNotEstablish:
      "That a *different* cell on a different page behaves the same way — #5 records that preset globals are captured per render instant and that cell entry order is not layout order, so each page is its own observation.",
    evidenceOwner: "#20 / #25 (MCP sync and the clean-checkout end-to-end gate)",
  },
];

/**
 * Refuse a stage list that lets the local half of the loop close on a real claim.
 *
 * Four checks, and the third is the one worth having: a list that marked an early
 * stage `real-runtime` would be claiming that a local process produced page
 * evidence, which is the single reporting error this repository spends the most
 * words preventing.
 *
 * 1. every stage states something it establishes and something it does not;
 * 2. every `real-runtime` stage names the Issue that owns that evidence;
 * 3. exactly one stage is `real-runtime`, and it is the last — so the loop cannot
 *    terminate in a local claim and have that read as validation;
 * 4. the local dev server stage is present and is `local`.
 */
export function assertLocalDevLoopStagesAreAdmissible(
  stages: readonly LocalDevLoopStage[] = LOCAL_DEV_LOOP_STAGES,
): void {
  if (stages.length === 0) {
    throw new LocalDevRuntimeContractError("loop-stage-not-admissible", "The local dev loop has no stages.");
  }

  for (const stage of stages) {
    if (stage.establishes.trim().length === 0) {
      throw new LocalDevRuntimeContractError(
        "loop-stage-not-admissible",
        `Loop stage "${stage.id}" establishes nothing, so it is not a stage.`,
      );
    }
    if (stage.doesNotEstablish.trim().length === 0) {
      throw new LocalDevRuntimeContractError(
        "loop-stage-not-admissible",
        `Loop stage "${stage.id}" states nothing it fails to establish. A stage record that only lists what it proves is the one that gets over-read.`,
      );
    }
    if (stage.claimLevel === "real-runtime" && stage.evidenceOwner === undefined) {
      throw new LocalDevRuntimeContractError(
        "loop-stage-not-admissible",
        `Loop stage "${stage.id}" produces real-runtime evidence and names no owner for it, so nothing says where that evidence comes from.`,
      );
    }
  }

  const realRuntime = stages.filter(stage => stage.claimLevel === "real-runtime");
  if (realRuntime.length !== 1 || stages[stages.length - 1]?.claimLevel !== "real-runtime") {
    throw new LocalDevRuntimeContractError(
      "loop-stage-not-admissible",
      `Exactly one loop stage may produce real-runtime evidence and it must be the last; this list has ${realRuntime.length} (${realRuntime.map(stage => stage.id).join(", ") || "none"}).`,
    );
  }

  const devServer = stages.find(stage => stage.id === "local-dev-server");
  if (devServer === undefined || devServer.claimLevel !== "local") {
    throw new LocalDevRuntimeContractError(
      "loop-stage-not-admissible",
      "The local dev server stage is missing or is not marked `local`, so the loop's fastest stage is claiming more than a local process can.",
    );
  }
}

/** The one stage in the loop that can produce compatibility evidence. */
export function localDevRealRuntimeStage(stages: readonly LocalDevLoopStage[] = LOCAL_DEV_LOOP_STAGES): LocalDevLoopStage {
  const stage = stages.find(candidate => candidate.claimLevel === "real-runtime");
  if (stage === undefined) {
    throw new LocalDevRuntimeContractError(
      "loop-stage-not-admissible",
      "The local dev loop records no real-runtime stage, so nothing in it produces compatibility evidence.",
    );
  }
  return stage;
}

// ---------------------------------------------------------------------------
// The mock host surface
// ---------------------------------------------------------------------------

/**
 * The type a project supplies as its mock host surface.
 *
 * #27's `RuntimeFacadeHostBindings`, named rather than described, because #27 says
 * its mock/provider boundary exists so that "#22/#23 can supply mocks for the same
 * surface" — and a second, harness-only mock vocabulary would be exactly the
 * "second code path" #27's `host-branching` pattern refuses.
 */
export const LOCAL_DEV_MOCK_SURFACE_SOURCE = "RuntimeFacadeHostBindings";

export const LOCAL_DEV_MOCK_SURFACE = {
  source: LOCAL_DEV_MOCK_SURFACE_SOURCE,
  /**
   * The only provider kind a local harness may install.
   *
   * A `host` provider reads the bindings a live ReactCellType runtime injects, and
   * `vp dev` is by definition the process that does not have one. So a `host`
   * provider here is not a stricter configuration, it is a category error — which
   * is why the guard refuses it by name rather than failing later on a missing key.
   */
  providerKind: "mock",
  /** Every base prop key #5 injects on every cell, in its recorded order. */
  requiredCellPropKeys: CELL_PROPS_BASE_KEYS,
  /** Where the parameter knowledge for `props.ServerCommands` lives. */
  serverCommandParametersDeclaredBy: "the project, as ServerCommandBindings<Commands>",
  /** Whether the surface is checked by the type system rather than by convention. */
  typedByTypeScript: true,
  note: "A mock is required to be neither narrower nor wider than the host. Narrower means a cell reads a base prop locally that nothing injected, so the local pass depends on the mock's convenience; wider means a cell calls a capability the page does not have. Presence covers the first half — the keys #5 always injects are required to exist, with `undefined` as a legitimate value because the value is the project's claim, not this contract's.",
} as const;

/**
 * Refuse a mock narrower than the host.
 *
 * Presence only, deliberately. #5 records that `Permissions` can come back empty
 * and that a configured permission has been observed as an empty snapshot, so
 * requiring a *value* here would make legal host states unrepresentable locally.
 * What is not legal is a missing key: the runtime injects all four on every cell,
 * so a mock without one would let a cell read `undefined` locally and a real value
 * on the page.
 */
export function assertLocalDevMockSuppliesEveryBaseProp(
  bindings: RuntimeFacadeHostBindings,
  requiredKeys: readonly string[] = CELL_PROPS_BASE_KEYS,
): void {
  const supplied = new Set(Object.keys(bindings.cellProps));
  const missing = requiredKeys.filter(key => !supplied.has(key));

  if (missing.length > 0) {
    throw new LocalDevRuntimeContractError(
      "mock-surface-incomplete",
      `The mock host surface omits ${missing.join(", ")}, which #5 records the runtime injecting on every cell. A cell reading one of them would see \`undefined\` locally and a value on the page.`,
    );
  }
}

/**
 * Refuse a provider that is not a mock.
 *
 * The check is on the discriminant rather than on the shape, because both provider
 * kinds satisfy the same `bindings` type by design — that is #27's
 * substitutability requirement — so nothing else can distinguish them.
 */
export function assertLocalDevProviderIsMock(provider: RuntimeFacadeProvider): void {
  if (provider.kind !== LOCAL_DEV_MOCK_SURFACE.providerKind) {
    throw new LocalDevRuntimeContractError(
      "provider-is-not-a-mock",
      `The local harness was handed a "${provider.kind}" provider. A host provider reads bindings a live ReactCellType runtime injects, and the local dev process does not have one — so this is a configuration error rather than a stricter setup.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Dependency decisions under local development
// ---------------------------------------------------------------------------

export const LOCAL_DEV_DECISION_HANDLINGS = [
  "host-substitution",
  "bundled-verbatim",
  "local-substitute-required",
  "no-stand-in-needed",
] as const;

export type LocalDevDecisionHandling = (typeof LOCAL_DEV_DECISION_HANDLINGS)[number];

export interface LocalDevStrategyHandling {
  readonly strategy: DependencyStrategy;
  readonly localHandling: LocalDevDecisionHandling;
  /** What the project has to declare for this strategy to resolve locally. */
  readonly requiresFromTheProject?: string;
  /** What a local run of this strategy's dependency does establish. */
  readonly localClaim: string;
  /** What it does not, and where that evidence lives. */
  readonly realRuntimeClaimedBy: string;
}

/**
 * One handling per strategy, and the list is derived from `core`'s tuple rather
 * than written out, so a fifth strategy cannot be added without someone having to
 * answer "what does this do locally".
 *
 * `extension` is the entry #22 names explicitly ("surface dependency decisions so
 * `extension` packages can either use an explicit local shim/npm source or be
 * marked as requiring real-runtime validation"). Both halves of that sentence are a
 * `LocalDevExtensionChoice`, and it is the only entry that can leave a local
 * configuration *incomplete* rather than merely inexact: the harness cannot invent
 * a substitute, because the reason the package is an `extension` in the first place
 * is that its module identity or its cross-cell singleton semantics matter. So the
 * project declares one of the two branches, and an undeclared package is reported as
 * an omission — which is a different finding from a declared `real-runtime-only`, and
 * has to stay different or the report teaches people to ignore it.
 */
export const LOCAL_DEV_STRATEGY_HANDLINGS: readonly LocalDevStrategyHandling[] = [
  {
    strategy: "host",
    localHandling: "host-substitution",
    localClaim:
      "That the cell's own code is well formed against the published module, at the version #5 recorded where a version was recorded.",
    realRuntimeClaimedBy: "The page, through #5's evidence and #4's `real-runtime` checks for `host`.",
  },
  {
    strategy: "inline",
    localHandling: "bundled-verbatim",
    localClaim:
      "The strongest of the four: the dev server loads the very package the artifact will inline, so a local render exercises the real dependency rather than a substitute.",
    realRuntimeClaimedBy:
      "The page, where the inlined copy actually executes — #4's `real-runtime` check for `inline` is exactly that the bundle runs in a real cell.",
  },
  {
    strategy: "extension",
    localHandling: "local-substitute-required",
    requiresFromTheProject:
      "Exactly one of two recorded choices per package (`LocalDevExtensionChoice`): a local substitute — the published package or a project shim — with its justification, or a `real-runtime-only` acknowledgement saying why no stand-in is used and what stays unexercised. Exactly one, because the two are exclusive readings of the same decision.",
    localClaim:
      "Only that the cell compiles and renders against whatever the substitute is. Nothing about the extension: not its global name in this project, not its version, and not whether the ReactCellType reference resolves at load time. Under `real-runtime-only` the local claim is narrower still — the dependency is not exercised at all.",
    realRuntimeClaimedBy:
      "#13 (the extension PoC) and #12's contract, which own the `frontendLibraries` reference and the load-time global.",
  },
  {
    strategy: "replace",
    localHandling: "no-stand-in-needed",
    localClaim:
      "That the rejection record is well formed. What resolves locally is the replacement's own decision, which carries its own handling from this table.",
    realRuntimeClaimedBy:
      "The page, for whichever strategy the replacement took; #16 owns the selection and #4's `real-runtime` check for `replace` is that the replacement satisfies the original requirement in a real page.",
  },
];

/**
 * Refuse a handling list that does not answer for every strategy, exactly once.
 *
 * Derived coverage both ways: a strategy with no handling is a local configuration
 * nobody has thought about, and two handlings for one strategy would make the
 * answer depend on list order.
 */
export function assertLocalDevStrategyHandlingsCoverStrategies(
  handlings: readonly LocalDevStrategyHandling[] = LOCAL_DEV_STRATEGY_HANDLINGS,
): void {
  const seen = new Set<DependencyStrategy>();

  for (const handling of handlings) {
    if (seen.has(handling.strategy)) {
      throw new LocalDevRuntimeContractError(
        "strategy-handling-coverage",
        `Strategy "${handling.strategy}" has more than one local handling, so what a local run establishes for it would depend on list order.`,
      );
    }
    seen.add(handling.strategy);
  }

  const missing = DEPENDENCY_STRATEGIES.filter(strategy => !seen.has(strategy));
  if (missing.length > 0) {
    throw new LocalDevRuntimeContractError(
      "strategy-handling-coverage",
      `Strategies ${missing.join(", ")} have no local handling, so nothing says what a local run of one establishes.`,
    );
  }

  const extra = [...seen].filter(strategy => !(DEPENDENCY_STRATEGIES as readonly string[]).includes(strategy));
  if (extra.length > 0) {
    throw new LocalDevRuntimeContractError(
      "strategy-handling-coverage",
      `The local handling table answers for ${extra.join(", ")}, which is not one of #4's strategies.`,
    );
  }
}

/** The handling for a strategy. */
export function localDevHandlingForStrategy(strategy: DependencyStrategy): LocalDevStrategyHandling {
  const handling = LOCAL_DEV_STRATEGY_HANDLINGS.find(candidate => candidate.strategy === strategy);
  if (handling === undefined) {
    throw new LocalDevRuntimeContractError(
      "strategy-handling-coverage",
      `Strategy "${strategy}" has no local handling.`,
    );
  }
  return handling;
}

/**
 * What the project decided about an `extension` dependency in local development.
 *
 * #22 asks for exactly two outcomes, and the type is the pair rather than a single
 * record because the second outcome is a *decision* and not a missing field:
 * "an `extension` package can either use an explicit local shim/npm source or be
 * marked as requiring real-runtime validation". A model with only a substitute
 * makes the second branch unrepresentable, and the consequence is specific — every
 * project that deliberately left the dependency to real-runtime validation would be
 * reported as if it had forgotten to configure something, and a diagnostic that
 * cannot tell a decision from an omission teaches people to ignore it.
 *
 * Both members carry prose the harness cannot supply on the project's behalf. A
 * bare "use npm instead" would be the harness deciding that a deployment difference
 * does not matter, and the project is the only party that knows whether the
 * singleton semantics its cell relies on are exercised locally.
 *
 * A package appears in this list at most once. Two entries for one package are not
 * two decisions — they are two mutually exclusive readings of one, and keeping
 * either would make the audit's answer depend on the order of the array: reversing
 * the list would move the package between `substitute` and `real-runtime-only`
 * without anyone editing a decision. A duplicate is refused rather than resolved,
 * because resolving it would be the harness picking one of two things the project
 * stated.
 */
export const LOCAL_DEV_EXTENSION_CHOICE_MODES = ["substitute", "real-runtime-only"] as const;

export type LocalDevExtensionChoiceMode = (typeof LOCAL_DEV_EXTENSION_CHOICE_MODES)[number];

/**
 * The two ways a project can stand in for an extension global locally.
 *
 * A const tuple rather than a union written out in one place only, for the same
 * reason the modes are one: the validator has to be able to name the set at
 * runtime, and a union that exists only in the type checker cannot be checked
 * against a JSON project config.
 */
export const LOCAL_DEV_EXTENSION_SUBSTITUTE_KINDS = ["npm-package", "project-shim"] as const;

export type LocalDevExtensionSubstituteKind = (typeof LOCAL_DEV_EXTENSION_SUBSTITUTE_KINDS)[number];

/** The project stands the extension global in for locally. */
export interface LocalDevExtensionSubstitute {
  /** The package whose decision is `extension`. */
  readonly packageName: string;
  readonly mode: "substitute";
  readonly kind: LocalDevExtensionSubstituteKind;
  /** What the substitute resolves to locally. */
  readonly resolvesTo: string;
  /** Why this is an acceptable stand-in for local UI work. */
  readonly justification: string;
}

/**
 * The project accepts that this dependency cannot be exercised locally.
 *
 * `consequence` is required and separate from `reason` because the two answer
 * different questions: *why* the extension has no local equivalent, and *what the
 * developer will not be able to see*. The second is what a teammate needs, and it is
 * the one an acknowledgement written in a hurry leaves out.
 */
export interface LocalDevExtensionRealRuntimeOnly {
  readonly packageName: string;
  readonly mode: "real-runtime-only";
  /** Why no local stand-in is used. */
  readonly reason: string;
  /** What this leaves unexercised, stated for whoever reads the audit next. */
  readonly consequence: string;
}

export type LocalDevExtensionChoice = LocalDevExtensionSubstitute | LocalDevExtensionRealRuntimeOnly;

/**
 * A string with content, read without touching the value.
 *
 * Every string member of a choice goes through this rather than being compared
 * directly, because the input reaches the validator from `unknown`: a JSON project
 * config is parsed before it is typed, so a field the type calls `string` can be a
 * number at runtime, and `.trim()` on a number is a throw. Checking the type before
 * reading the value is what makes the validator total.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * What to call a choice in a finding, when its own name may not be usable.
 *
 * A malformed entry is exactly the one whose `packageName` cannot be trusted — it
 * may be missing, a number, or the entry may be `null` — so a finding about it
 * cannot be keyed on the name it was supposed to have. The placeholder keeps the
 * finding addressable without naming a package that was never named.
 */
export function localDevChoiceSubject(choice: unknown): string {
  if (typeof choice === "object" && choice !== null) {
    const packageName = (choice as { packageName?: unknown }).packageName;
    if (isNonEmptyString(packageName)) return packageName;
  }
  return "(an unnamed extension choice)";
}

/**
 * What is missing from an `extension` choice, or `undefined` when it is a decision.
 *
 * A validator rather than a boolean, so the audit can say *which* part of the
 * declaration is absent. An acknowledgement with an empty `reason` is not a
 * decision with a terse author, it is an omission that has learned the vocabulary.
 *
 * Takes `unknown` on purpose, and inspects before it reads. The declared type on
 * {@link LocalDevAuditInput} is the contract, but a config read from JSON is
 * `unknown` until something has checked it, and the cast that turns it into
 * `LocalDevExtensionChoice` belongs to the caller. Trusting that cast is how "the
 * audit never throws" gets broken by a number where a string was expected, so the
 * two members that select the branch — `packageName` and `mode` — are checked as
 * strings first, and the branch is taken on the checked value rather than on the
 * union, because falling off a `switch` reads as "no problem", which is the exact
 * silent pass this validator exists to prevent.
 */
export function localDevExtensionChoiceProblem(choice: unknown): string | undefined {
  if (typeof choice !== "object" || choice === null) return "it is not a choice at all";
  const declared = choice as Record<string, unknown>;

  if (!isNonEmptyString(declared.packageName)) return "it names no package";

  const mode = declared.mode;
  if (!isNonEmptyString(mode)) return "it selects neither branch";
  if (!(LOCAL_DEV_EXTENSION_CHOICE_MODES as readonly string[]).includes(mode)) {
    return `the mode "${mode}" is not one of the two branches #22 allows`;
  }

  // Past this point the branch is known, so only its own fields remain — and each
  // is still checked before it is touched, for the same reason.
  if (mode === "substitute") {
    const kind = declared.kind;
    if (!isNonEmptyString(kind) || !(LOCAL_DEV_EXTENSION_SUBSTITUTE_KINDS as readonly string[]).includes(kind)) {
      return `the substitute kind "${String(kind)}" is not one of the two #22 allows`;
    }
    if (!isNonEmptyString(declared.resolvesTo)) return "the substitute names nothing to resolve to";
    if (!isNonEmptyString(declared.justification)) return "the substitute gives no justification";
    return undefined;
  }

  if (!isNonEmptyString(declared.reason)) return "the acknowledgement gives no reason";
  if (!isNonEmptyString(declared.consequence)) {
    return "the acknowledgement states no consequence, so nothing says what it leaves unexercised";
  }
  return undefined;
}

/**
 * Refuse an `extension` choice that is not a decision, or a package that has two.
 *
 * The structural defence behind #22's two valid branches: without the first check,
 * `real-runtime-only` could be reached by writing the mode and nothing else, and the
 * repository would have traded one unrepresentable state for one that is
 * representable but empty. The second check is the same argument one level up — two
 * entries for one package make the branch depend on the order of the list, so the
 * pair is refused rather than resolved.
 */
export function assertLocalDevExtensionChoicesAreDeclared(
  choices: readonly LocalDevExtensionChoice[] = [],
): void {
  const declared = new Set<string>();
  for (const choice of choices) {
    const problem = localDevExtensionChoiceProblem(choice);
    if (problem !== undefined) {
      throw new LocalDevRuntimeContractError(
        "extension-choice-not-declared",
        `The local choice for "${localDevChoiceSubject(choice)}" is not a decision: ${problem}.`,
      );
    }

    if (declared.has(choice.packageName)) {
      throw new LocalDevRuntimeContractError(
        "extension-choice-duplicated",
        `The package "${choice.packageName}" carries more than one local choice. A package has one decision, so a second entry is not a second decision — with both present, which branch applies would depend on the order of the list. Declare exactly one.`,
      );
    }
    declared.add(choice.packageName);
  }
}

// ---------------------------------------------------------------------------
// Error surfacing
// ---------------------------------------------------------------------------

/** Where a cell's failure appears while developing locally. */
export const LOCAL_DEV_ERROR_SURFACES = [
  "uncaught-render-error",
  "vite-hmr-overlay",
  "typecheck",
  "terminal",
] as const;

export type LocalDevErrorSurface = (typeof LOCAL_DEV_ERROR_SURFACES)[number];

/**
 * What the harness may and may not do about a cell's failures.
 *
 * The record is a pair on purpose. #22's fourth acceptance criterion asks that UI
 * errors be "visible through normal browser/Vite tooling", and the way to violate
 * it while looking helpful is to add an error boundary that renders a fallback: the
 * failure stops being an uncaught error anyone notices and becomes a cell that
 * renders the wrong thing. The contrast with production is what makes the choice
 * legible rather than a matter of taste — #5 records that on the page a failing
 * cell renders `null` into its own root and writes to `console.error`, so the
 * local loop's job is to be *louder* than production, not to model it.
 *
 * `forguncyBehaviour` is read off `core` rather than paraphrased, so the contrast
 * cannot be restated incorrectly in one place and correctly in another.
 */
export const LOCAL_DEV_ERROR_SURFACING = {
  surfaces: LOCAL_DEV_ERROR_SURFACES,
  installsErrorBoundary: false,
  catchesCellErrors: false,
  /** Production behaviour the local loop deliberately does not reproduce. */
  forguncyBehaviour: CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR.behavior,
  forguncyRendersErrorTextInCell: CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR.rendersErrorTextInCell,
  note: "Modeling production would mean rendering `null` and writing to `console.error`, which is precisely the outcome a development loop exists to avoid. A harness that installed a boundary would reproduce the silence without reproducing the reason for it.",
} as const;

/** The local and production failure behaviours side by side, for a report or a doc. */
export function localDevFailureContrast(): { readonly local: string; readonly forguncy: string } {
  return {
    local:
      "A cell's failure is left to propagate: the error reaches the browser console, the Vite HMR overlay and the terminal, and it is never converted into a rendered fallback.",
    forguncy: CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR.behavior,
  };
}

// ---------------------------------------------------------------------------
// Authoring patterns the local loop must not reward
// ---------------------------------------------------------------------------

export const LOCAL_DEV_FORBIDDEN_PATTERN_IDS = [
  "local-only-source-branch",
  "global-installed-for-convenience",
  "mock-wider-than-the-host",
  "swallowed-render-error",
  "second-local-component",
] as const;

export type LocalDevForbiddenPatternId = (typeof LOCAL_DEV_FORBIDDEN_PATTERN_IDS)[number];

export interface LocalDevForbiddenPattern {
  readonly id: LocalDevForbiddenPatternId;
  /** The construct to look for, described so a reviewer or a future lint can match it. */
  readonly lookFor: string;
  readonly reason: string;
  readonly use: string;
}

export const LOCAL_DEV_FORBIDDEN_PATTERNS: readonly LocalDevForbiddenPattern[] = [
  {
    id: "local-only-source-branch",
    lookFor: "A branch on the environment inside Cell source: `if (import.meta.env.DEV)`, `if (isLocal)`, or a flag threaded in from the harness.",
    reason:
      "#22 requires the same authored source to be reused, with no separate local-only implementation, and #27 already records host-branching as the pattern that turns a mock from a stand-in into a second code path. A branch on the environment is the same mistake with the sign flipped: the branch that only runs locally is the one that never runs on the page.",
    use: "Install a mock provider and keep one code path. The provider is selected by the harness, and authored source never learns which one it got.",
  },
  {
    id: "global-installed-for-convenience",
    lookFor: "The harness assigning a host name onto `globalThis` or `window` so authored source can reach it without an import.",
    reason:
      "Two ways to be wrong, and the second is the nastier one. #5 records that `ForguncyReactHelper` is an injected parameter and deliberately *not* a window property, so a harness global can make a name reachable that the page does not expose. And for a name the page *does* install — `antd`, `dayjs` — it teaches a pattern whose only justification is that the platform happens to provide it, which is exactly what #4's `host` strategy is supposed to be a decision about rather than an assumption. The compile path binds module ids, not globals, so a global-reading cell is also a cell the bridge cannot bind.",
    use: "Import the module and let the tables decide what it resolves to: #9's mapping on the page, this projection's published package locally.",
  },
  {
    id: "mock-wider-than-the-host",
    lookFor: "A mock that supplies a capability #5 never recorded — a navigation function, a business-state store, an auth helper.",
    reason:
      "#5's user-scope and props records are the whole surface a cell can reach, and #27's capability registry admits only what those records back. A mock that adds something makes a cell that cannot work on the page render perfectly locally, and it does so on the one class of capability — application-owned navigation, state and permissions — where #4 says the cell must not implement it itself.",
    use: "Keep the mock to `RuntimeFacadeHostBindings`. A capability that is missing there is a capability the cell does not have, and #27's registry is where adding one is argued.",
  },
  {
    id: "swallowed-render-error",
    lookFor: "An error boundary, a `try`/`catch` around the mount, or a fallback element installed by the harness.",
    reason:
      "#5 records that on the page a failing cell renders `null` into its own root and writes to `console.error`. Modelling that locally would reproduce the silence without reproducing the reason for it, and #22's fourth acceptance criterion asks for the opposite: errors visible through the browser's and Vite's own tooling. A swallowed error is also the failure this whole module is about — a cell that is broken and green.",
    use: "Let it throw. `LOCAL_DEV_ERROR_SURFACING` records the channels it should reach.",
  },
  {
    id: "second-local-component",
    lookFor: "A `.dev.tsx` twin of a Cell, a harness-only wrapper component, or a storybook-style reimplementation of the entry.",
    reason:
      "#22's responsibilities end with \"reuse the same authored source; no separate local-only component implementation\". A twin is worse than a branch because it stays plausible: it renders, it looks right, and it drifts from the artifact's source one edit at a time with nothing failing.",
    use: "Mount the Cell entry itself. If the entry cannot be mounted, that is a fact about the entry worth fixing rather than working around.",
  },
];

// ---------------------------------------------------------------------------
// Guards' error type
// ---------------------------------------------------------------------------

export const LOCAL_DEV_CONTRACT_ERROR_CODES = [
  "boundary-not-admissible",
  "loop-stage-not-admissible",
  "mapping-coverage",
  "strategy-handling-coverage",
  "extension-choice-not-declared",
  "extension-choice-duplicated",
  "claim-not-local",
  "mock-surface-incomplete",
  "provider-is-not-a-mock",
] as const;

export type LocalDevContractErrorCode = (typeof LOCAL_DEV_CONTRACT_ERROR_CODES)[number];

/** Thrown by the guards above. Distinct from the diagnostic vocabulary on purpose. */
export class LocalDevRuntimeContractError extends Error {
  readonly code: LocalDevContractErrorCode;

  constructor(code: LocalDevContractErrorCode, message: string) {
    super(message);
    this.name = "LocalDevRuntimeContractError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Non-goals
// ---------------------------------------------------------------------------

export const LOCAL_DEV_NON_GOALS = [
  "Reproduce the Forguncy designer. #22's first non-goal, and the reason the six boundaries above exist as records rather than as a paragraph: a pixel- or lifecycle-accurate clone would have to decide questions #5 left open.",
  "Implement every Forguncy API offline. The local surface is #27's confirmed capability set and nothing else, so a capability the harness cannot serve is a capability the cell does not have.",
  "Replace real runtime validation. #20 owns it and #25 gates v0.1 on it; the local loop cannot discharge a single `real-runtime` check from `#4`'s table, which `localDevRealRuntimeOwedChecks` prints rather than assumes.",
  "Validate the generated host bridge. The interposed modules and the JSX runtime adapter are compiler output (#7) with their own evidence; the dev harness resolves the published packages instead, so a green local render says nothing about them.",
] as const;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Every Spec a change to the local dev contract has to cite.
 *
 * The architecture decisions first, then the three downstream Specs this module
 * is built on: #9 because the host mapping table is reused rather than replaced,
 * #27 because the mock surface is its provider port, and #22 itself.
 *
 * Kept separate from `RUNTIME_GOVERNING_DECISIONS` rather than added to it, and
 * for the same reason `core` keeps `GOVERNING_ARCHITECTURE_DECISIONS` short: that
 * list is the *façade* Spec's answer to "which architecture Spec governs #27", and
 * folding #22 into it would relabel a dev-runtime Spec as part of the façade's
 * contract.
 */
export const LOCAL_DEV_GOVERNING_DECISIONS: readonly ArchitectureDecisionSource[] = [
  ...GOVERNING_ARCHITECTURE_DECISIONS,
  HOST_BRIDGE_DECISION,
  RUNTIME_FACADE_DECISION,
  LOCAL_DEV_RUNTIME_DECISION,
];

/**
 * The local dev contract's derived constants, from the local dev record and the governing
 * list above rather than restated per constant (#156).
 */
const LOCAL_DEV_PROVENANCE = defineDecisionProvenance(LOCAL_DEV_RUNTIME_DECISION, LOCAL_DEV_GOVERNING_DECISIONS);

export const LOCAL_DEV_GOVERNING_SPEC_REFERENCE_LINE = LOCAL_DEV_PROVENANCE.governingSpecReferenceLine;
