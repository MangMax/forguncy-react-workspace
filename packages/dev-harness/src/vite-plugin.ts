/**
 * The dev harness's Vite plugin: it turns a project's declared Cells into a running
 * React dev server.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), and its Spec,
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), under
 * - #26 "project configuration and React Cell target declarations"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/26
 *
 * ## What this plugin is, in one sentence
 *
 * It takes the Cells a project already declared and serves them as ordinary React, so a
 * developer edits the *artifact's* source and sees the result without a Forguncy sync.
 *
 * Everything it needs already exists and is reused rather than re-derived:
 *
 * - the **Cell** comes from `virtual:forguncy/cell/<id>` (`vite-plugin-fgc`, #28), which
 *   honours `cells.<id>.entry` and refuses an entry that exposes no component, naming the
 *   exports it does have. This plugin never resolves an entry path itself — that would be a
 *   second answer to "which file is this Cell", and the two would come apart the first time
 *   a config was validated differently;
 * - the **host substitutions** come from #9's bridge table via `runtime`'s projection
 *   (`host-modules.ts`), so the dev server and the artifact agree about what the page
 *   provides;
 * - the **mock** comes from the Cell's own `fixture` (#28's contract, consumed by
 *   `mount.ts`), resolved through the façade's provider port (#27).
 *
 * ## One object, and why
 *
 * {@link devHarness} returns the whole plugin: the hooks that describe the project (`name`,
 * `configResolved`) and the ones that serve it (`config`, `resolveId`, `load`,
 * `transformIndexHtml`). It is deliberately not split into a "data half" and a "hooks half" —
 * see the function's own docstring for the draft that made that mistake and the silent failure
 * it produced.
 *
 * ## What is refused rather than guessed
 *
 * - **No Cell declared.** An empty `cells` map is legal in the config (a project may have
 *   none yet), but it leaves the harness with nothing to mount, so it says so instead of
 *   serving a blank page that reads like a broken Cell.
 * - **An unknown `cellId`.** Resolved through `registry.require`, so the failure names the
 *   ids that do exist.
 * - **A bridged id the harness has no copy of.** It is still aliased — to a module that throws
 *   the explanation at the import site (`unavailableHostModuleSource`) — so the failure lands on
 *   the `import` that needs the package instead of blocking configuration for a whole project,
 *   and the id can never quietly take the ordinary npm path.
 */

import react from "@vitejs/plugin-react-swc";

// `ForguncyConfigError` only, because the harness never normalizes a config itself: it composes
// `forguncy()` (#28) and reads the registry that plugin produced. `createCellRegistry` and
// `isCellRegistry` were imported here in an earlier draft that normalized the config in this
// file, which would have been a second answer to a question the Cell seam already answers.
import { ForguncyConfigError, RUNTIME_CONTRACT_TARGET } from "@forguncy-react-workspace/core";
import type { CellRegistry, ForguncyConfig, RegisteredCell } from "@forguncy-react-workspace/core";
import type { LocalDevExtensionChoice } from "@forguncy-react-workspace/runtime";
import {
  createLocalDevDiagnostic,
  localDevVersionFieldIsBrowserObserved,
} from "@forguncy-react-workspace/runtime";
import {
  extensionCatalogOfNormalized,
  resolveInstalledVersions,
} from "@forguncy-react-workspace/dependency-resolver/local";
import { cellVirtualModuleId, forguncy } from "@forguncy-react-workspace/vite-plugin-fgc";

import {
  projectAliasShadowKeys,
  projectAliasTarget,
  readAliasEntries,
  unclaimedHostAliases,
  undeclaredAliasPatterns,
} from "./alias-audit.ts";
import type { AliasEntry } from "./alias-audit.ts";
import { createDevCellResourcePolicy } from "./cell-assets.ts";

import {
  extensionSubstitutionModuleId,
  extensionSubstitutionModuleOf,
  extensionSubstitutionModuleSource,
  extensionSubstitutions,
  substitutionForModuleId,
} from "./extension-substitutions.ts";
import type { ExtensionSubstitution } from "./extension-substitutions.ts";
import {
  hostModuleAliases,
  hostModuleDedupePackages,
  hostPackageVersionMismatches,
  unavailableHostModuleOf,
  unavailableHostModuleSource,
} from "./host-modules.ts";
import type { HostPackageVersionMismatch } from "./host-modules.ts";
import {
  auditHarnessConfiguration,
  blockingLocalDevFindings,
  BlockingLocalDevFindingError,
  formatHarnessAudit,
  readProjectDependencyDecisions,
  unmatchedExtensionChoicePackages,
} from "./local-dev-audit.ts";
import {
  formatLocalDecisionProjection,
  installedToolchain,
  projectLocalDecisions,
} from "./local-decision-projection.ts";

/** The DOM element the mount script renders into. */
export const HARNESS_MOUNT_ELEMENT_ID = "forguncy-cell-root";

export interface DevHarnessOptions {
  /**
   * The project's `forguncy.config.ts`, already loaded by the host.
   *
   * An object rather than a path, for #28's reason, which applies here unchanged: under
   * Vite+ the project's `vite.config.ts` imports `forguncy.config.ts` directly, so Vite
   * loads it with the very runtime it uses for its own config. Making the plugin load the
   * file again would create the second config runtime #26 forbids, and would let the plugin
   * and the Vite build disagree about which config was in effect.
   */
  readonly config: ForguncyConfig | CellRegistry;
  /**
   * The Cell to mount.
   *
   * Omitted means the project's first declared Cell, which is the common case for a
   * single-Cell example and keeps `vp dev` free of arguments.
   */
  readonly cellId?: string;
  /**
   * Mock props for the mounted Cell, merged over the fixture's `cellProps`.
   *
   * For seeing a state a fixture does not encode — a denied permission, an empty list —
   * without editing the fixture each time. The values go through the mock's own provider
   * options, so a key #5 never verified is refused there rather than here.
   *
   * Deliberately not a way to supply `ServerCommands` or data sources: those are call
   * shapes rather than values (#27), and the merge is shallow and JSON-shaped. A command
   * belongs in the fixture, where it is typed and where its absence is a recorded decision.
   */
  readonly props?: Partial<Record<string, unknown>>;
  /**
   * What the project decided about each of its `extension` dependencies, in local development.
   *
   * The second half of #23's plan step 5, and the reason it is a *declaration from the project*
   * rather than something the harness works out: `runtime`'s `LOCAL_DEV_STRATEGY_HANDLINGS`
   * records that an `extension` package has no local equivalent the harness could infer — its
   * module identity or its cross-cell singleton semantics are the reason it is an `extension` —
   * so the two branches #22 allows are both statements only the project can make. A substitute
   * carries a justification; a `real-runtime-only` acknowledgement carries a reason *and* a
   * consequence, because the second answers "what will I not be able to see".
   *
   * Supplied here rather than in `forguncy.config.ts`, and the boundary is #26's: the project
   * config is deployment state, while this is a local-development decision that says nothing
   * about the artifact. A project with no `extension` dependency omits it and gets an audit that
   * reports no findings.
   *
   * An `extension` dependency with no entry here is a **blocking** finding, not a warning:
   * `local-dev-extension-needs-substitute` carries `blocksLocalDevelopment: true`, and the
   * harness enforces that at server start — see `configureServer` in the implementation. That is
   * deliberately stricter than the version mismatch beside it, which warns, and the asymmetry is
   * the contract's rather than this package's.
   */
  readonly extensionChoices?: readonly LocalDevExtensionChoice[];
  /** Verify declared entries exist on disk while normalizing. Defaults to `true`. */
  readonly requireEntryFiles?: boolean;
}

/**
 * The plugin's own view of itself, typed structurally like `vite-plugin-fgc`'s.
 *
 * Structural rather than Vite's `Plugin` type so this package does not pin the toolchain
 * version: any host accepting the Vite plugin shape (`name` plus lifecycle hooks) can load it,
 * which is what `vite-plugin-fgc` does for the same reason and what lets a test drive the hooks
 * directly. The members are exactly the hooks this harness implements and no more — a wider
 * interface would be a claim about hooks nothing here defines.
 */
export interface DevHarnessVitePlugin {
  readonly name: string;
  /** Claims the generated entry before Vite's own resolver decides it is a missing file. */
  readonly enforce: "pre";
  /** The registry and the mounted Cell, once the host has revealed its project root. */
  readonly api: {
    registry(): CellRegistry | undefined;
    mountedCell(): RegisteredCell | undefined;
  };
  configResolved(config: {
    readonly root: string;
    readonly plugins: readonly { readonly name: string }[];
    /**
     * The user's own alias settings, read to detect a shadowing alias (#97).
     *
     * `unknown` rather than a typed alias shape, matching `config()`: the value has to be read with
     * `readAliasPatterns` anyway (Vite accepts two forms and normalizes a trailing slash), and
     * typing it here would invite a caller to trust the shape instead of that reader.
     */
    readonly resolve?: { readonly alias?: unknown };
  }): void;
  /**
   * Audits the project's local-dev configuration once, and refuses the server on a blocking finding.
   *
   * Dev-only by construction: Vite calls this hook when a dev server is created and never during
   * a build, which is exactly the scope of the audit. Wiring the audit into `buildStart` instead
   * would be the tempting choice — it also runs once, for the client environment, in dev — but it
   * runs on the *build* path too, and a `real-runtime-only` acknowledgement or a missing
   * substitute is not a reason to refuse a production compile. Verified rather than assumed: a
   * throw here rejects `createServer`, and a throw in `buildStart` does not distinguish the two.
   */
  configureServer(): Promise<void>;
  /**
   * The host-substitution aliases, the dedupe list and the optimizer inclusions.
   *
   * Takes the user's config because the aliases have to be filtered against it: Vite merges this
   * result *over* the project's config, so an unconditional alias here would silently replace a
   * project's own. See {@link unclaimedHostAliases}.
   *
   * Deliberately no `plugins` member: see {@link REACT_FAST_REFRESH_PLUGIN_NAME} for why a
   * plugin cannot supply one, and {@link reactFastRefresh} for what a project does instead.
   */
  config(userConfig: { readonly resolve?: { readonly alias?: unknown } }): {
    readonly resolve: { readonly alias: Readonly<Record<string, string>>; readonly dedupe: readonly string[] };
    readonly optimizeDeps: { readonly include: readonly string[] };
    /**
     * The v1 asset inline limit (#98), so a `vite build` of the harness inlines the same assets
     * the Cell compiler does rather than emitting a file the artifact would refuse.
     */
    readonly build: { readonly assetsInlineLimit: number };
  };
  /**
   * Claims the harness entry URL path, an unserved host substitution, and every declared
   * extension substitute or unsimulatable extension dependency.
   *
   * The extension half is #23's plan step 5 as *enforcement* rather than a report: before this,
   * a project's `extensionChoices` were audited and then ignored, so a declared shim was never
   * consulted and a `real-runtime-only` acknowledgement still executed an npm copy. Both are
   * measured in `extension-substitutions.ts`'s docstring. Exact-id matching and a virtual module,
   * because that is the only mechanism of the four tried that reaches the browser — see the same
   * docstring for the three that do not, and why an alias would over-claim subpaths.
   */
  resolveId(
    this: { readonly resolve: ResolveIdContext["resolve"] },
    id: string,
  ): Promise<string | null> | string | null;
  /** Generates the mount module, or an explanation, or `null` for ids this plugin does not own. */
  load(id: string): Promise<string | null> | string | null;
  /**
   * Rewrites a plain stylesheet's `url(...)` references to inline `data:` URIs, or refuses the
   * sheet with the reason and the direction (#98).
   *
   * A `transform` hook rather than part of {@link load}: Vite's own CSS pipeline owns loading and
   * composing a stylesheet, and reimplementing that here would be the second answer to a question
   * Vite already answers on the compiled side.
   */
  transform(
    code: string,
    id: string,
  ): Promise<{ readonly code: string; readonly map: null } | null> | { readonly code: string; readonly map: null } | null;
  /**
   * Adds the mount node and the entry script to the page.
   *
   * Returns Vite's tag-injection form rather than a rewritten HTML string, so the harness never
   * has to find an insertion point in the project's own template. See the implementation for the
   * silent-green failure the string form caused.
   */
  transformIndexHtml(): {
    readonly html: string;
    readonly tags: readonly {
      readonly tag: string;
      readonly attrs: Readonly<Record<string, string>>;
      readonly injectTo: "body";
    }[];
  };
}

/**
 * The slice of a Vite plugin context the project-alias claim needs.
 *
 * Structural rather than imported, like every other host type in this file: the plugin is typed
 * against the Vite plugin *contract* so nothing here pins a toolchain version. `resolve` is
 * declared because a project alias is finished by the host's own resolver — the target may be a
 * directory, may need an extension, and may itself be claimed by another plugin — so the claim
 * asks the host to resolve the rewritten id rather than returning a bare path.
 */
interface ResolveIdContext {
  resolve(
    id: string,
    importer: string | undefined,
    options: { readonly skipSelf: boolean },
  ): Promise<{ readonly id: string } | null>;
}

export const DEV_HARNESS_PLUGIN_NAME = "forguncy-dev-harness";

/**
 * The plugin name React Fast Refresh registers under, which is what makes it detectable.
 *
 * `@vitejs/plugin-react-swc` names its transform `vite:react-swc`, and detecting it by name is
 * the only way to tell "Fast Refresh is wired" from "the Cell is being transformed by some other
 * JSX transform" — the two look identical from inside a module's source, since Oxc's JSX
 * transform also emits `jsxDEV`. That similarity is exactly why this constant and
 * {@link formatFastRefreshWarning} exist: the failure mode is a *green* one.
 */
export const REACT_FAST_REFRESH_PLUGIN_NAME = "vite:react-swc";

/**
 * React Fast Refresh, for a project to put in its own `plugins` array.
 *
 * ## Why this is exported rather than installed by the harness
 *
 * The harness cannot wire it, and the reason is a Vite behaviour worth recording because it is
 * silent: **plugins returned from a plugin's `config()` hook are never registered.** Vite
 * collects `userPlugins` and then calls `runConfigHook` over *that array*; the hook's return
 * value is merged into the config object, but the final `resolved.plugins` is still the array
 * built before the hook ran. Verified against Vite 8.3.0's source and with a real server: an
 * inner plugin returned from `config()` appears in neither `server.config.plugins` nor
 * `transformRequest`'s output.
 *
 * The first draft of this plugin returned `plugins: [react()]` from its `config()` hook with a
 * comment claiming Fast Refresh. The comment was wrong in the most expensive way: the Cell still
 * rendered, `jsxDEV` was still present (from Oxc), and only the *state preservation* was
 * missing — so `useState` reset on every edit and the loop was a full page reload wearing HMR's
 * name. A silent degradation, which is what {@link formatFastRefreshWarning} is for.
 *
 * So the project adds it, which is ordinary Vite usage, and it needs no extra dependency:
 * re-exporting the plugin means a project imports both from this package.
 *
 * ## Why Fast Refresh, rather than Vite's default
 *
 * Vite's built-in JSX transform (Oxc) rewrites a module without registering it with React's
 * refresh runtime, so editing a Cell's source replaces the module and React remounts the
 * subtree — the page keeps running, but every `useState` in the edited component resets. Fast
 * Refresh is what makes an edit preserve state, which is the difference between iterating on a
 * form or a chart and re-navigating to the same state after every keystroke.
 *
 * This is a `local`-only concern and it adds no claim: it changes the *loop*, not the artifact.
 * The compiled Cell carries no refresh runtime, and `dev-harness-example.test.ts` asserts that
 * the artifact built from this same source has none.
 */
export function reactFastRefresh(): readonly unknown[] {
  return react();
}

/**
 * The message a missing Fast Refresh produces, or `undefined` when it is wired.
 *
 * Phrased as a warning rather than a refusal, for the reason `LOCAL_DEV_DIAGNOSTIC_RULES` gives
 * about version mismatches: the loop still *works* — the Cell renders, HMR still updates it — so
 * refusing to start would trade a degraded loop for no loop. What must not happen is the silent
 * version, where a developer concludes that HMR cannot preserve state and works around a
 * limitation that is really a missing line in their config.
 *
 * It names the fix in code, because the fix is one line and the reader is the person who can add
 * it. It also says what is *not* broken, so nobody goes looking for a bug in the harness.
 */
export function formatFastRefreshWarning(pluginNames: readonly string[]): string | undefined {
  if (pluginNames.includes(REACT_FAST_REFRESH_PLUGIN_NAME)) {
    return undefined;
  }

  return [
    "React Fast Refresh is not wired, so this loop runs on Vite's default JSX transform.",
    "",
    "What that means: the Cell renders and HMR still updates it, but editing a component remounts it, so every useState in the edited component resets. Nothing is broken and nothing is misconfigured in the harness — Fast Refresh is a plugin this project has to add itself.",
    "",
    "To enable it, put the one this package re-exports next to the harness in your vite.config.ts:",
    "",
    '  import { devHarness, reactFastRefresh } from "@forguncy-react-workspace/dev-harness";',
    "  export default defineConfig({ plugins: [reactFastRefresh(), devHarness({ config: forguncyConfig })] });",
    "",
    "The harness cannot add it for you: Vite ignores `plugins` returned from a plugin's `config()` hook, so returning it from there would look wired and do nothing.",
  ].join("\n");
}

/**
 * The URL path the generated page script is served at.
 *
 * A URL path rather than the `virtual:`-style specifier the Cell seam uses, and the reason is
 * mechanical rather than a preference: Vite's HTML pipeline handles a `<script src>` by
 * resolving that URL through the module graph, and it does not resolve an `@id/`-style virtual
 * id there — the request falls through to the SPA fallback, so the page silently loads HTML as
 * JavaScript. A path this plugin's own `resolveId`/`load` claim end to end is what Vite can
 * serve to a browser. Verified against a real dev server, not assumed.
 *
 * Still a *path* and not a file, so the page carries no machine path — the same rule #28 applies
 * to the Cell entry, and for the same reason: a committed template or a pasted log must not
 * embed one developer's directory layout.
 */
export const HARNESS_ENTRY_URL_PATH = "/@forguncy-dev-harness/entry.js";

/** The ids the dev server must serve from this package's own copies. */
export function harnessHostModulePlan(): {
  readonly aliases: Readonly<Record<string, string>>;
  readonly dedupe: readonly string[];
} {
  return { aliases: hostModuleAliases(), dedupe: hostModuleDedupePackages() };
}

/**
 * The message a version mismatch produces, or `undefined` when the install matches.
 *
 * Exported so a test asserts the wording and a caller can decide where it goes. Not a gate
 * on the loop: #22's own diagnostic rule records that this condition does not block local
 * development (`blocksLocalDevelopment: false`), because refusing to start would be the
 * harness deciding that a difference it cannot weigh matters more than the developer's
 * time. It is reported because a Cell developed against a different React version is not
 * evidence about this target, and the two fixes — a stale install, a newer host — differ.
 */
export function formatHostVersionWarning(
  mismatches: readonly HostPackageVersionMismatch[] = hostPackageVersionMismatches(),
): string | undefined {
  if (mismatches.length === 0) {
    return undefined;
  }

  const unobservedFields = mismatches
    .map(mismatch => mismatch.field)
    .filter(field => !localDevVersionFieldIsBrowserObserved(field));
  const unobserved = new Set(unobservedFields);

  return [
    "The dev harness's own install is not at the version recorded for this target:",
    ...mismatches.map(mismatch =>
      unobserved.has(mismatch.field)
        ? `  - ${mismatch.packageName}: installed ${mismatch.installed ?? "(absent)"}, target records ${mismatch.field} = ${mismatch.expected} (read from the shipped runtime source; not observed in a browser on this build)`
        : `  - ${mismatch.packageName}: installed ${mismatch.installed ?? "(absent)"}, target records ${mismatch.field} = ${mismatch.expected}`,
    ),
    "",
    unobservedFields.length > 0
      ? `The carried value(s) above (${[...new Set(unobservedFields)].join(", ")}) were read from the shipped runtime source, not from a running page on this build, so a mismatch here is a difference from a carried-forward number rather than a difference from an observation.`
      : "",
    "Local UI feedback still works, and it is not evidence about this target: a Cell developed against a different React version says nothing about the page. Align this package's dependency or re-probe the target (#5).",
  ]
    .filter(line => line !== "")
    .join("\n");
}

/**
 * The generated page script.
 *
 * Generated rather than authored as a file so the Cell id travels with the mount call and
 * the browser half stays a pure function a test can call directly. The import specifier is
 * the Cell's *virtual module id*, so #28's guards (`unknown-cell-id`,
 * `entry-outside-project-root`, "no component export") fire here as they do for any other
 * consumer instead of being re-implemented.
 *
 * The Cell module is imported and handed to `mountCell` whole, which is what keeps this
 * file free of any assumption about how a Cell exports its component: `mount.ts` reads
 * `cell.Cell`, `cell.fixture` and `cell.cellId`, and #28's generated module is what
 * guarantees those names mean what the harness thinks.
 */
function generateEntryModule(cell: RegisteredCell, overlay: Readonly<Record<string, unknown>> | undefined): string {
  const hasOverlay = overlay !== undefined && Object.keys(overlay).length > 0;

  // The whole message is built here and JSON-encoded once. Interpolating an encoded value *into*
  // a quoted literal is how the first draft produced `... so Cell "salesSummary" has nowhere ...`
  // — valid prose, invalid JavaScript, and a page that fails to parse for a reason nothing in the
  // message explains.
  const missingNodeMessage =
    `The dev harness mount node #${HARNESS_MOUNT_ELEMENT_ID} is not in the page, so Cell "${cell.id}" has nowhere to render. ` +
    `The harness plugin adds it in transformIndexHtml; a page template that removed it would do this.`;

  return [
    `// Generated by ${DEV_HARNESS_PLUGIN_NAME} for Cell "${cell.id}". Do not edit.`,
    `import { mountCell } from "@forguncy-react-workspace/dev-harness/mount";`,
    `import * as cell from ${JSON.stringify(cellVirtualModuleId(cell.id))};`,
    ``,
    `const element = document.getElementById(${JSON.stringify(HARNESS_MOUNT_ELEMENT_ID)});`,
    `if (element === null) {`,
    `  throw new Error(${JSON.stringify(missingNodeMessage)});`,
    `}`,
    ``,
    `const mounted = mountCell(cell, {`,
    `  element,`,
    ...(cell.fixturePath === undefined ? [] : [`  fixturePath: ${JSON.stringify(cell.fixturePath)},`]),
    // The overlay travels into the mount call so it is merged into the *mock's options*, where
    // `mock-provider` validates which keys are legal — not passed beside them, which would route
    // it around the check that keeps a mock no wider than the host.
    ...(hasOverlay ? [`  propsOverlay: ${JSON.stringify(overlay)},`] : []),
    `});`,
    ``,
    `// On the global for the browser console and for a targeted test, so what the loop`,
    `// installed can be inspected without a debug branch in authored source.`,
    `globalThis.__forguncyDevHarness = mounted;`,
    ``,
    `export default mounted;`,
  ].join("\n");
}

/**
 * The harness as a Vite plugin.
 *
 * One function, not a "data half" plus a "hooks half", and the reason is a mistake this file
 * made in its first draft: the data half looked like a complete plugin (it has `name`,
 * `configResolved` and `transformIndexHtml`), so an example wired it up, the page rendered its
 * mount node and a script tag — and the script tag 404'd into the SPA fallback, because the
 * module hooks lived in the other function. A plugin that *looks* finished and silently serves
 * HTML as JavaScript is worse than one that is obviously incomplete, so the two are one object
 * and the only way to get the mount is to get the module graph with it.
 *
 * `enforce: "pre"` because the generated entry has to be claimed before Vite's own
 * `vite:resolve` decides it is a missing file — the id is a URL path with nothing behind it.
 */
export function devHarness(options: DevHarnessOptions): DevHarnessVitePlugin {
  const requireEntryFiles = options.requireEntryFiles ?? true;
  // Only `dedupe` is read here: the aliases are derived inside `config()`, because they have to
  // be filtered against the user's own alias settings, which are not available until then.
  const { dedupe } = harnessHostModulePlan();
  let registry: CellRegistry | undefined;
  let mounted: RegisteredCell | undefined;

  // The Cell seam (#28), created once and *delegated to* rather than merely asked for its
  // registry. Its `resolveId`/`load` are what turn `virtual:forguncy/cell/<id>` into the Cell's
  // module, and this plugin's generated entry imports that id — so a harness that composed only
  // its `configResolved` would resolve the Cell to nothing and fail with Vite's "failed to
  // resolve ... Does the file exist?" instead of with the seam's own diagnostics. One instance,
  // not one per hook call, so it holds one registry.
  const cells = forguncy({ config: options.config, requireEntryFiles });

  // The v1 resource policy (#98). One instance, stateless, shared by `load` and `transform` so a
  // stylesheet and the asset it references are judged by the same rules the compiler applies.
  const resourcePolicy = createDevCellResourcePolicy();

  // The declared `extensionChoices`, resolved once against the project root. Held rather than
  // recomputed, so the ids `resolveId` claims and the modules `load` generates come from one list —
  // the same discipline `host-modules.ts` follows for the bridge table, and for the same reason: a
  // second derivation is a second place for the answer to differ.
  //
  // Populated in `configResolved`, because the project root is not known until the host reveals it.
  // Before then it is `undefined`, and `resolveId` answering `null` for every extension id is the
  // honest state: there is no project to read a declaration from yet.
  let substitutions: readonly ExtensionSubstitution[] | undefined;

  /**
   * The keys of the project's own `vite.config.ts` aliases, read in `configResolved`.
   *
   * Held rather than recomputed so the audit and any later reader see one extraction. Populated
   * with Vite's own matching rule (`readAliasPatterns`), because that rule is the whole reason the
   * comparison is meaningful — see the hook for why this package does the reading rather than
   * `runtime`.
   */
  let userAliasKeys: string[] | undefined;

  /**
   * Project keys a `RegExp` alias shadows, paired with the pattern that does it.
   *
   * A separate list from {@link userAliasKeys} because the audit treats the two differently: a
   * string key is compared by reproducing Vite's prefix rule (which `runtime` may not own), while a
   * pattern is judged by the result of running it — so the verdict travels as data rather than as
   * something the audit re-derives.
   */
  let userAliasPatterns: { key: string; pattern: string }[] | undefined;

  /**
   * The patterns the *project itself* declared, captured in `config()` before anything is merged.
   *
   * A separate slot from {@link userAliasPatterns} because the two hold different things: this is
   * the raw `readAliasPatterns` output as the project wrote it, and it is what proves an entry's
   * origin. Reading origin from the merged list instead means reading it from the **text** — and a
   * pattern that names `@vite/` is indistinguishable that way, so a project could write one alias
   * mentioning `@vite/` that also matches its own id and opt itself out of the audit (review's
   * round-7 counter-example, reproduced).
   */
  let declaredAliasEntries: readonly AliasEntry[] | undefined;

  return {
    name: DEV_HARNESS_PLUGIN_NAME,
    enforce: "pre",

    api: {
      registry: () => registry,
      mountedCell: () => mounted,
    },

    configResolved(config) {
      // The plugin list is final here — every plugin's `config()` has been merged by now — so this
      // is the first (and only) place the loop can honestly report whether React Fast Refresh is
      // wired. Asking anywhere else would report a missing plugin for a project that added it,
      // which is the kind of false warning that teaches people to ignore warnings.
      const fastRefreshWarning = formatFastRefreshWarning(config.plugins.map(plugin => plugin.name));
      if (fastRefreshWarning !== undefined) {
        // The same channel as the version warning, and for the same reason: it is a startup
        // notice about the loop, not output of the Cell.
        process.stderr.write(`${fastRefreshWarning}\n`);
      }

      // The nested plugin is handed the same config value, so nothing is normalized twice:
      // whichever of the two runs `configResolved` first owns the registry, and the harness
      // reads the same normalized object either way.
      cells.configResolved(config);
      registry = cells.api.registry();
      if (registry === undefined) {
        return;
      }

      // The project's own `vite.config.ts` aliases, read once and held for the audit below.
      //
      // This is the earliest hook that can read them alongside a registry: the registry exists only
      // after `configResolved`, and `config.resolve.alias` is final by the same point. The *keys*
      // are extracted here with `readAliasPatterns` — Vite's own matching rule, including its
      // trailing-slash normalization and its `RegExp` branch — because `runtime` may not depend on
      // Vite and a second reproduction of that rule is exactly what took three review rounds to get
      // right in this file.
      //
      // What the overlap *means* is decided in `runtime`'s audit, not here: whether it blocks is
      // `LOCAL_DEV_DIAGNOSTIC_RULES[code].blocksLocalDevelopment`, so a rule the contract marks
      // blocking cannot be downgraded by this package omitting it.
      //
      // A `RegExp` `find` is **not** reduced to an approximate string. An earlier version passed
      // `pattern.source` and let the audit compare it literally, which was wrong in the dangerous
      // direction: `^@app\/shared(?=\/|$)` becomes the string `@app/shared(?=/|$)`, which is neither
      // equal to the project key nor a `/`-prefix of it, so a pattern that Vite really does apply to
      // `@app/shared/thing` sailed through and the dev/build split returned — measured. This is a
      // blocking gate, so a missed detection is a correctness failure, not a missed warning, and
      // "fails safe" is not a direction that exists here.
      //
      // Instead the pattern is **evaluated** against the specifiers a project alias can match (see
      // {@link projectAliasShadowKeys}), so a real overlap is detected and a pattern that provably
      // cannot match one is left alone. `runtime` stays free of RegExp: it receives strings, exactly
      // as before, and its comparison is unchanged.
      // Captured in a local because the narrowing above (`registry === undefined` returns) does not
      // survive into the callback, and a non-null assertion here would be the same lie the guard
      // above exists to prevent.
      const projectAlias = registry.resolve.alias;
      const declaredEntriesForSubtraction = declaredAliasEntries ?? [];
      // The shadow audit compares *keys and patterns*, which are the `find` half of these entries;
      // the `replacement` half is what the subtraction below needs and is kept there.
      const declared = declaredEntriesForSubtraction.map(entry => entry.find);
      userAliasKeys = [];
      userAliasPatterns = [];
      for (const pattern of declared) {
        if (typeof pattern !== "string" && !(pattern instanceof RegExp)) {
          continue;
        }
        if (typeof pattern === "string") {
          userAliasKeys.push(pattern);
          continue;
        }
        userAliasPatterns.push(...projectAliasShadowKeys(pattern, projectAlias));
      }

      // Anything in the **final** alias set that this harness did not declare is a contribution
      // from somewhere the snapshot cannot see, and Vite's resolver will use it before the
      // harness's own `resolveId`.
      //
      // The snapshot in `config()` is necessary but not sufficient, and the reason is ordering:
      // this plugin declares `enforce: "pre"`, Vite's `config` hooks run sequentially, and an
      // ordinary or `post` user plugin still merges into the config *after* the snapshot was
      // taken. Measured before this check, with no RegExp involved — a plugin whose `config()`
      // returns `{ resolve: { alias: { "@app/shared/thing": "/local-copy" } } }` made Vite resolve
      // `@app/shared/thing` to `/local-copy/thing` while production used `./shared/thing`, and the
      // audit saw nothing to refuse.
      //
      // The subtraction is by **identity of contribution**, not by text: everything the project
      // declared, everything this harness's own host aliases are (which is `hostModuleAliases()`
      // — the same source `config()` emits, so it is known rather than guessed), and Vite's
      // injected `@vite/` entries. What is left is a later plugin's, and it is refused rather than
      // ignored because a plugin that silently changes local resolution is precisely the
      // unsupported-Vite-plugin behaviour #97 asks to be reported.
      const latePluginAliases = undeclaredAliasPatterns(config.resolve?.alias, declaredEntriesForSubtraction);
      if (latePluginAliases.length > 0) {
        // Refused whatever they overlap, not only a project alias. The overlap case is the
        // correctness problem, but an alias this audit cannot account for is a plugin changing
        // local resolution by a route the artifact never sees — and #97 asks for unsupported Vite
        // plugin behaviour to be *reported* rather than silently accepted. Declaring the alias in
        // `vite.config.ts` is the supported way to have one, and that declaration is in the snapshot.
        const report = [
          `The local dev harness refused to start: ${latePluginAliases.length} alias(es) reached \`resolve.alias\` from a Vite plugin, which this harness cannot account for.`,
          ...latePluginAliases.map(
            entry =>
              `  ${entry}: a plugin added this after the harness read the project's own aliases, so it can change what a Cell resolves locally while the Cell build keeps using \`forguncy.config.ts\`. Declare it in \`vite.config.ts\` if the project means it, or remove the plugin.`,
          ),
        ].join("\n");

        throw new BlockingLocalDevFindingError(
          latePluginAliases.map(entry =>
            createLocalDevDiagnostic(
              "local-dev-project-alias-shadowed",
              entry,
              `A Vite plugin added the alias ${JSON.stringify(entry)} to \`resolve.alias\` after this harness read the project's own aliases, and neither Vite nor this harness contributed it.`,
            ),
          ),
          report,
        );
      }

      if (options.cellId !== undefined) {
        mounted = registry.require(options.cellId);
        return;
      }

      const [first] = registry.cells;
      if (first === undefined) {
        throw new ForguncyConfigError(
          [
            {
              code: "config-missing-cells",
              path: "cells",
              message:
                "The dev harness has no Cell to mount: this project's config declares none. Add one under `cells` (see Spec #26), or pass `cellId` explicitly — `vp dev`'s whole purpose here is to run one Cell's source.",
            },
          ],
          DEV_HARNESS_PLUGIN_NAME,
        );
      }
      mounted = first;
    },

    async configureServer() {
      // #23's plan step 5, executed. `runtime` owns every rule here — which branches an
      // `extension` choice may take, what makes one incomplete, and which findings block local
      // development — so this hook reads the project's two declarations, hands them to the audit,
      // and splits the answer by the contract's own `blocksLocalDevelopment` flag. Nothing below
      // decides what a problem is.
      //
      // `registry === undefined` means `configResolved` never ran, which only happens outside a
      // Vite server, and the audit has no lock path to read without it. Returning is the honest
      // answer there: a hook that invented a default would audit a path it was never told about.
      if (registry === undefined) {
        return;
      }

      // The lock, projected onto the Cell this server mounts, and the projection is not optional.
      //
      // A lock decision is keyed by `(packageName, cellTarget)`, because #4 defines a strategy per
      // *pair* — the same package may be `inline` in one Cell and `extension` in another. The audit
      // has no `cellTarget` parameter, so handing it the whole lock lets another Cell's record decide
      // this one: a mounted Cell with an `inline` override would still be substituted or refused
      // because of a target-independent `extension` record, while the compiler inlines. Review found
      // it, and it is the same dev/compiler drift as the stale-choice defect, reached from the other
      // side — that one applied a decision the lock no longer had, this one applies a decision the
      // mounted Cell does not have.
      //
      // `mounted` is assigned in `configResolved`, which Vite runs before this hook — measured, not
      // assumed, and `local-dev-audit-server.test.ts` exercises the ordering by mounting a Cell.
      const lock = await readProjectDependencyDecisions(registry.runtime.dependencyLockPathAbsolute);

      // And the lock is then put through the *validity* projection the compiler applies before it
      // will compile a dependency — the second half of the same defect. `compileCell` refuses an
      // artifact whose decision the compiler withheld (`unresolved-dependency-decision`), so a
      // harness that acted on such a record could render a Cell locally while the identical source
      // refuses to compile: a green local render for an artifact that cannot exist.
      //
      // `projectLocalDecisions` runs the compiler's own conformance audit and local projection, and
      // splits the result by axis. Axes a local process can judge decide; the two it cannot
      // (`extension-*`, which only a page's `listFrontendLibraries` answer supplies, and
      // `probe-fingerprint-*`, whose composer reaches a bundler) are reported as a boundary instead
      // of silently withholding. Withholding on those would drop every `extension` record, the
      // harness would see no `extension` strategy, and a Cell importing one would resolve silently
      // through npm — the first defect this work closed, restored. The module's docstring has the
      // measurement.
      //
      // The three axes this process *can* judge are supplied from what it actually knows, and the
      // first version of this call got that wrong in a way worth recording: it passed `target: null`
      // and `toolchain: null` as placeholders, which the projection correctly read as "unknown" —
      // manufacturing `forguncy-target-changed` and `toolchain-unknown` on records that were
      // perfectly valid, and so withholding decisions the compiler accepts. `null` in a freshness
      // axis means *unknown*, never *don't check*, which is the same asymmetry
      // `local-dev-audit.ts` records for `decisions` versus `referencedSpecifiers`.
      const projection = projectLocalDecisions({
        lock,
        cellTarget: mounted?.id ?? null,
        resolvedVersions: (await resolveInstalledVersions(
          registry.root,
          lock.decisions.map(record => record.packageName),
        )).versions,
        // `RUNTIME_CONTRACT_TARGET` is the measured contract, which is what a record's own `target`
        // was written against — and comparing them is exactly what the freshness rule is for, so a
        // record recorded against a different build is reported rather than assumed fine. The
        // project's `runtime.forguncyVersion` is checked against it rather than substituted for it:
        // it names a version, not a build, so it cannot answer a comparison that asks for the build.
        target: RUNTIME_CONTRACT_TARGET,
        // The project's install graph, with `vitePlus` read through this package's own resolution
        // because that is the tool actually driving the loop (#94). `registry.root` is the graph
        // the Cells resolve in, which is the graph a record describes — and the one #94 exists
        // for, since it can move while every version a record names stays put.
        toolchain: await installedToolchain(registry.root),
        // The project's own mapping set, from the registry — not `core`'s built-in table (#87).
        //
        // `registry.extensionMappings` is the one normalization exit #85 built and #86 threaded into
        // the compiler, so this is the *same* set `compileCell` plans from. Auditing against
        // `core`'s table instead made a custom project extension a blocking conformance error here
        // while the compiler compiled it, which is exactly the "the dev server refuses what the
        // bundler accepts" split #87 exists to remove. Projected through the shared
        // `extensionCatalogOfNormalized`, so `moduleIds` widen exactly as they do for the compiler.
        extensionCatalog: extensionCatalogOfNormalized(registry.extensionMappings),
      });

      const audit = auditHarnessConfiguration({
        decisions: projection.decisions,
        extensionChoices: options.extensionChoices ?? [],
        ...(userAliasKeys === undefined ? {} : { userAliasKeys }),
        ...(userAliasPatterns === undefined ? {} : { userAliasPatterns }),
        projectAlias: registry.resolve.alias,
      });

      // Built *here*, from the audit's own answer about which choices matched, and the ordering is
      // load-bearing rather than tidy. The first version built these in `configResolved` from
      // `options.extensionChoices` alone, before any decision was read — so a stale choice (a
      // package the lock has since moved from `extension` to `inline`) was still applied:
      // `resolveId` served the substitute while the compiler followed the lock and bundled the real
      // package. Review found it, and it is the dev/compiler drift this whole layer exists to
      // prevent, arriving through the layer itself.
      //
      // Throwing here rather than at `resolveId` is deliberate for the same reason as before: a
      // choice naming a package the extension table does not intercept is a configuration error the
      // reader can fix, and reporting it at startup puts it beside the other startup findings
      // instead of inside whichever module import happened to be first.
      substitutions = extensionSubstitutions(
        options.extensionChoices ?? [],
        registry.root,
        unmatchedExtensionChoicePackages(audit),
        // The project's own rows, once normalized (#87): a choice for a custom extension is only
        // meaningful against the table the compiler resolves it through. See
        // `extension-substitutions.ts` for the refusal this replaced.
        registry.extensionMappings.mappings,
      );

      const lockFindings = formatLocalDecisionProjection(projection);
      const lockRefuses = projection.conformanceErrors.length > 0;

      const auditReport = formatHarnessAudit(audit);
      const report =
        lockFindings.length === 0
          ? auditReport
          : `${auditReport}\n\nLock decisions, projected the way the compiler projects them:\n${lockFindings}`;
      const blocking = blockingLocalDevFindings(audit);

      if (blocking.length > 0 || lockRefuses) {
        // Refusal carries the report, and *only* the refusal does.
        //
        // The first version wrote the report to stderr here as well, on the reasoning that a
        // blocking run should still show the full picture. That printed everything twice —
        // measured against a real `vp dev`: the report appeared once from the write below and
        // again inside this message, which Vite prints itself when a hook rejects. Two identical
        // copies of a six-line report, one after the other, in the one output a developer is
        // already unhappy to be reading.
        //
        // So the two paths are now exclusive and each prints once. The report is the message
        // because the alternative — "1 local dev diagnostic", with the finding somewhere else —
        // sends the reader to a second command for the remediation and the fix owner they need
        // now. It carries the distinction as well, so a blocked start is not the one path that
        // drops the local-versus-real caveat.
        throw new BlockingLocalDevFindingError(
          blocking,
          `The local dev harness refused to start: ${blocking.length} finding(s) that this project's configuration has to resolve first.\n${report}`,
        );
      }

      // The non-blocking path, and the common one. To stderr for the reason the version and Fast
      // Refresh warnings go there: this is output *about* the loop, and a page that carried it
      // would read as the Cell's own.
      process.stderr.write(`${report}\n`);
    },

    config(userConfig) {
      // The project's own alias patterns, captured **here** — the one hook that sees them before
      // anything is merged into them.
      //
      // By `configResolved` the list is a merge of three sources: what the project wrote, what Vite
      // injects (`/^\/?@vite\/env/`), and what this plugin returns below. The shadow audit needs
      // the first and must not judge the other two, and reading the origin from the *text* cannot
      // do it: a pattern naming `@vite/` is indistinguishable by content, so a project could write
      // one alias that mentions `@vite/` and also matches its own project id, and the check would
      // skip it (review's round-7 counter-example, reproduced). Here the list contains only what
      // the project declared, so no inference is needed at all.
      declaredAliasEntries = readAliasEntries(userConfig.resolve?.alias);

      // No `plugins` here, and that is the whole point of `formatFastRefreshWarning`: Vite
      // ignores plugins returned from a `config()` hook, so a `react()` returned here would be a
      // line that reads as Fast Refresh and does nothing. See `reactFastRefresh` for the
      // verified mechanism and for what a project does instead.
      //
      // `resolve.alias` *is* emitted here, but only for the ids the project has not claimed —
      // and that filter is a review finding, not a first-draft nicety. The harness used to return
      // every host alias unconditionally while also exporting `harnessHostModulePlan()` for the
      // project to spread into its own config, which reads as belt-and-braces and is actually a
      // silent override: Vite merges a `config()` result with `mergeConfig(conf, res)`, and
      // object-form `resolve.alias` merges key-by-key with the *later* value winning, so this
      // hook — which runs after the user's config — replaced every entry it named. A project that
      // deliberately pointed `react` at a patched build found its alias silently ignored, which
      // is exactly the failure the example's comment claimed the split prevented. Verified
      // against Vite 8.3.0 with a real server: a user `react` alias came back as the plugin's.
      //
      // Keeping the aliases here (rather than deleting them and making the project responsible)
      // is deliberate: a project that never calls `harnessHostModulePlan()` still gets a working
      // harness, which is the common case and the one a bare `devHarness({ config })` should
      // serve. The filter is what makes the export an *override* rather than a duplicate.
      //
      // `dedupe` and `optimizeDeps.include` need no such filter: both are arrays, and Vite
      // concatenates array config values instead of replacing them (verified: a user
      // `dedupe: ["user-pkg"]` beside this hook's yields both), so they cannot drop a project's
      // entries.
      return {
        resolve: {
          alias: unclaimedHostAliases(userConfig.resolve?.alias),
          // Covers the ids the bridge deliberately leaves unaliased — `react-dom/server` is
          // the case that matters — so a second copy cannot reach the same page.
          dedupe,
        },
        // The compiler's inline limit, not Vite's default coincidence: both are 4096 today, and
        // stating it here is what keeps a change on either side from silently splitting the two
        // paths. See `cell-assets.ts` in `core` for the one declaration.
        build: {
          assetsInlineLimit: resourcePolicy.assetsInlineLimit,
        },
        optimizeDeps: {
          // The host packages are *included* — forced through the optimizer — and that is the
          // opposite of what this harness did in its first draft, which excluded them on the
          // reasoning that a pre-bundled copy would be a different module instance from the one
          // the alias binds. That reasoning was backwards, and the failure it caused is worth
          // recording: `react`'s published entry is CommonJS, so an excluded package is served to
          // the browser raw, with no interop — and the first `import { createElement } from
          // "react"` dies with "does not provide an export named 'createElement'", a message about
          // React that is really about the optimizer being switched off.
          //
          // Pre-bundling is what *creates* the single instance: the optimizer resolves the
          // alias, interops the CJS package once, and every importer gets that one module.
          // Excluding a package is for sources that must not be pre-bundled (a plugin's own
          // virtual modules, a package with side effects at import time), which is not this case.
          include: [...dedupe],
        },
      };
    },

    async resolveId(this: { readonly resolve: ResolveIdContext["resolve"] }, id) {
      // Returned as itself rather than `\0`-prefixed: this id is served to a browser, and a
      // resolved id beginning with NUL tells the rest of Vite "never look this up on disk".
      // The id is a URL path this plugin owns end to end, so claiming it here is enough —
      // there is no file behind it to shadow.
      if (id === HARNESS_ENTRY_URL_PATH) {
        return id;
      }
      // An unserved host substitution: recognised here and loaded below, so the failure it
      // describes happens at the authored `import` rather than in Vite's resolver with a
      // message about a missing dependency.
      if (unavailableHostModuleOf(id) !== undefined) {
        return `\0${id}`;
      }
      // A declared `extension` choice, answered here rather than by the ordinary npm path. Exact
      // match only — see `substitutionForModuleId` for why the alias rule would over-claim, and
      // `extension-substitutions.ts` for the four mechanisms measured and rejected before this one.
      const substitution = substitutions === undefined ? undefined : substitutionForModuleId(id, substitutions);
      if (substitution !== undefined) {
        return extensionSubstitutionModuleId(substitution.moduleId);
      }
      // The project's own `resolve.alias` block (#97), applied here so the dev server and the
      // artifact resolve a project alias to the same file. Last of the claims, and that position is
      // load-bearing: the host bridge and the extension substitutions own their ids, and
      // `resolve-config.ts` refuses a project alias naming a bridged id precisely so the two
      // engines' opposite orderings — Vite's alias before a plugin's `resolveId`, Rolldown's
      // interception hook before its `resolve.alias` — cannot make them diverge. See
      // `projectAliasTarget` for why this is a `resolveId` claim rather than a Vite alias.
      if (registry !== undefined) {
        const rewritten = projectAliasTarget(id, registry.resolve.alias);
        if (rewritten !== undefined) {
          // Handed back to Vite to finish rather than returned as a bare path: the target may be a
          // directory, may need an extension resolved, or may itself be claimed by another plugin,
          // and all of that is what Vite's own resolution is for.
          const resolved = await this.resolve(rewritten, undefined, { skipSelf: true });
          // `.id` rather than the result object: this hook answers with an id, and Vite's own
          // resolution carries the extension and folder-index work a bare concatenation does not.
          return resolved === null ? rewritten : resolved.id;
        }
      }
      // Everything else, including the Cell's own `virtual:forguncy/cell/<id>`, is the Cell
      // seam's business. Delegated rather than re-implemented: the seam owns the guards
      // (`unknown-cell-id`, `entry-outside-project-root`, "no component export"), and a second
      // answer here would be exactly the drift this plugin exists to avoid.
      return cells.resolveId(id);
    },

    async load(id) {
      // Resource imports (#98) first: a stylesheet or static asset is a file on disk, and the
      // compiler inlines it — so local development must answer it with the same content rather
      // than with Vite's more permissive default. `null` means "not a resource; carry on".
      const resource = await resourcePolicy.load(id);
      if (resource !== null) {
        return resource;
      }

      const unavailable = unavailableHostModuleOf(id.startsWith("\0") ? id.slice(1) : id);
      if (unavailable !== undefined) {
        return unavailableHostModuleSource(unavailable);
      }

      // A generated substitution module, for one of the declared choices. Looked up through the
      // same list `resolveId` claimed from, so a module that served without being claimed — or the
      // reverse — is not a state this plugin can reach.
      const substituted = extensionSubstitutionModuleOf(id);
      if (substituted !== undefined) {
        const substitution = substitutionForModuleId(substituted, substitutions ?? []);
        if (substitution === undefined) {
          throw new Error(
            `The dev harness generated a substitution module for "${substituted}", which no declared choice in this project answers for. The resolver and this hook read one list; a mismatch means one of them was edited alone.`,
          );
        }
        return extensionSubstitutionModuleSource(substitution);
      }

      if (id !== HARNESS_ENTRY_URL_PATH) {
        return cells.load(id);
      }
      if (mounted === undefined) {
        throw new Error(
          "The dev harness entry was requested before its Cell was resolved, so there is nothing to mount. That means `configResolved` did not run, which only happens outside a Vite server.",
        );
      }
      return generateEntryModule(mounted, options.props);
    },

    transform(code: string, id: string) {
      return resourcePolicy.transform(code, id);
    },

    transformIndexHtml() {
      const warning = formatHostVersionWarning();
      if (warning !== undefined) {
        // To stderr rather than into the page: the page is what a developer is looking at when
        // they are looking at the Cell, and a warning printed there would be read as part of the
        // Cell's own output. stderr is where Vite's other startup notices go.
        process.stderr.write(`${warning}\n`);
      }

      // The mount node, then the module that fills it — returned as *tags* for Vite to inject
      // rather than spliced into the HTML string, and that is a review finding rather than a
      // style preference.
      //
      // The first version did `html.replace("</body>", ...)`, which is a no-op for any template
      // whose closing body tag is absent, upper-case, or formatted with whitespace inside it —
      // and every one of those is valid HTML. The server still started and the page still
      // served, so the failure was a *green* one: no mount node, no entry script, a blank page,
      // and nothing in the output to say why. That is precisely the silent-green shape this
      // package exists to avoid, so it was the wrong mechanism even though it worked for the
      // example's own template.
      //
      // `injectTo: "body"` is Vite's own answer and it needs no closing tag to exist: verified
      // against Vite 8.3.0 with a real server and a template whose `</body>` was omitted
      // entirely — both tags were still injected, appended after the existing content. It also
      // means the harness never rewrites the project's HTML, so a template's own formatting
      // survives untouched.
      //
      // The element id comes from this module rather than from the template, so a project's
      // `index.html` cannot disagree with the generated script about where the Cell renders.
      //
      // Annotated rather than inferred: without the type, TypeScript widens the two different
      // `attrs` shapes into a union whose members each carry the *other's* keys as `undefined`,
      // which does not satisfy the interface's `Record<string, string>`.
      const tags: readonly {
        readonly tag: string;
        readonly attrs: Readonly<Record<string, string>>;
        readonly injectTo: "body";
      }[] = [
        { tag: "div", attrs: { id: HARNESS_MOUNT_ELEMENT_ID }, injectTo: "body" },
        { tag: "script", attrs: { type: "module", src: HARNESS_ENTRY_URL_PATH }, injectTo: "body" },
      ];

      return { html: "", tags };
    },
  };
}

