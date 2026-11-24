/**
 * The Rolldown-backed implementation of {@link CellBundlerPort}.
 *
 * Decision source: GitHub Issue #7 — "Implement: Cell compiler MVP for a single
 * React entry"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/7), downstream of
 * #6's compiler boundary (https://github.com/Mang-X/forguncy-react-workspace/issues/6),
 * which names Vite+/Rolldown as the bundler half this package may use rather
 * than becoming a second resolver.
 *
 * Three groups of decisions are load-bearing, each the answer to one acceptance
 * criterion:
 *
 * 1. **A virtual entry shim, not a rewritten entry.** The authored module is
 *    never transformed to add an export. A generated shim imports it as a
 *    namespace and binds `default ?? App` — the `App`-binding entry shape #5
 *    records — so authored source reaches the artifact byte-for-byte and an
 *    entry may use either export style. The shim's `IMPORT_IS_UNDEFINED`
 *    warnings are also the only build-time signal that an entry exports
 *    *neither* name; when both fire, the build refuses rather than shipping a
 *    binding of `void 0`.
 * 2. **One IIFE, no chunk loading.** `format: "iife"` with `codeSplitting: false`
 *    produces exactly one script whose export lands on
 *    `CellBundlingRequest.componentBinding`, the name the generated wrapper
 *    references. `transform.jsx: "react-jsx"` routes authored JSX through
 *    `react/jsx-runtime`, which the host-bridge plan then intercepts, so no
 *    React implementation is bundled; `experimental.attachDebugInfo: "none"`
 *    keeps `//#region` comments — which embed module ids and would make output
 *    machine-dependent — out of the code. Since #158 those values are not written
 *    here: `core`'s `CELL_BUNDLER_BUILD_OPTIONS` is the one definition, read by both
 *    of this bundler's passes and by the probe build, and `platform: "browser"` is
 *    stated explicitly rather than left to Rolldown's format-derived default.
 * 3. **Plans wire the resolver, and the report feeds #6's audits.** Bare
 *    specifiers are consulted against `planHostBridge` first (the page's own
 *    modules win) and `planExtensionExternals` second; an interception is loaded
 *    as a `\0`-virtual CommonJS module, the `moduleType` the platform's own
 *    generated modules are written in. Findings the artifact audits cannot see
 *    from the output report alone are translated into #6's diagnostic
 *    vocabulary and returned in `BundledCellModule.diagnostics`. One such
 *    finding is reported directly here: an installed package (resolved under
 *    `node_modules`) that the bundler inlined with no `DependencyDecision`
 *    covering it. #4 requires every non-workspace dependency to map to
 *    `host | inline | extension | replace`; `auditInlinedPackages` cannot see
 *    this case because a package with no decision is skipped there (workspace
 *    source legitimately has none, #14), so the bundler's own module ids —
 *    which distinguish workspace source from an installed package via
 *    {@link resolvesIntoNodeModules} — are what make the report possible.
 *
 * What is deliberately *not* here: the two plan vocabularies are not collapsed
 * into #6's. A mapping finding ("this table row cannot be honoured") and an
 * artifact finding ("this artifact breaks a guarantee") are two findings, not
 * two spellings of one — `core`'s vocabulary comments pin that split — so only
 * the subset whose statement is literally about the produced artifact is
 * translated, arm by arm, in {@link translateHostFinding} and
 * {@link translateExtensionFinding}.
 *
 * ## The split (#170)
 *
 * This file is the port's runner and states the contract above; the two cohesive
 * halves it was split along are siblings:
 *
 * - `rolldown-bundler-hooks.ts` — the virtual modules, the interception resolver and
 *   the v1 resource/asset inlining hooks, shared by both passes;
 * - `rolldown-bundler-report.ts` — installed-package attribution and the translation of
 *   plan findings into #6's vocabulary.
 *
 * Both passes live here because the preflight's claim is about the build: keeping them
 * in one file is what makes "the same resolver, no code generation" visible in one
 * place. The dependency runs one way (this file → hooks and report), so nothing is
 * circular.
 */

import path from "node:path";

import {
  cellBundlerInputOptions,
  cellBundlerOutputOptions,
  describeReportedError,
  hasReportedErrors,
  stripAnsi,
} from "@forguncy-react-workspace/core";
import { rolldown, type OutputAsset, type OutputChunk } from "rolldown";
// `scan` is Rolldown's analysis-only entry: it runs the resolve and transform
// stages and stops, with no `renderChunk` and no `generateBundle`. That is the
// whole point of using it here rather than `rolldown()` + `generate()` — see
// {@link resolveEntrySpecifiersWithRolldown}.
import { scan } from "rolldown/experimental";

import type {
  BundledCellModule,
  CellBundlerPort,
  CellBundlingRequest,
  CellResolveRequest,
} from "./artifact.ts";
import { findDependencyDecision, packageNameOfSpecifier } from "./specifier.ts";
import type { CellArtifactDiagnostic } from "./diagnostics.ts";
import { createCellArtifactDiagnostic, dedupeCellArtifactDiagnostics } from "./diagnostics.ts";
import { CELL_RUNTIME_BINDING_ID } from "./runtime-binding.ts";
import { CELL_ASSET_INLINE_LIMIT_BYTES, CellResourcePolicyError, isRegularFile } from "./cell-resources.ts";
import { createInterceptionResolver, createResourceState, resolveCellSpecifier, resolveResourceModule } from "./rolldown-bundler-hooks.ts";
import type { ResourceResolutionState } from "./rolldown-bundler-hooks.ts";
import {
  byCodeThenSubject,
  inlinedPackageNames,
  inlinedPackageSizesOf,
  resolvesIntoNodeModules,
  translateExtensionFinding,
  translateHostFinding,
} from "./rolldown-bundler-report.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CreateRolldownCellBundlerOptions {
  /**
   * The directory relative entries resolve against.
   *
   * One option only: everything else the build needs arrives per call in the
   * {@link CellBundlingRequest}, so a bundler instance is stateless between
   * builds and two of them cannot contaminate each other.
   */
  readonly dir: string;
  /**
   * The project's module-resolution aliases, as `registry.resolve.alias` (#97).
   *
   * The second project-scope option, and the distinction from `CellBundlingRequest` is what
   * makes it one: `dir` is here for the same reason it is — an alias set describes *this
   * project*, not *this build*, so two builds of one project share it while two projects
   * cannot contaminate each other. Anything that varies per Cell stays on the request.
   *
   * Optional, and the absent state is meaningful rather than a default: omitting it means the
   * caller stated no aliases, which is what a #6 caller with a bare `CompileCellInput` has. A
   * default here would be the "implicit second set of defaults" #97 forbids.
   *
   * Absolute targets, which is what `normalizeResolveConfig` produces. Rolldown *throws* on a
   * relative replacement (measured: `resolve.alias: { "@/lib": "./srclib" }` fails the build
   * outright), so a caller building this map by hand must resolve against `dir` first.
   */
  readonly alias?: Readonly<Record<string, string>>;
}

/**
 * Creates the bundler half of `compileCell`.
 *
 * Returned by a factory rather than exported as an instance so `compileCell`
 * stays ignorant of Rolldown and the contract tests can keep injecting their
 * fixture port.
 */
export function createRolldownCellBundler(options: CreateRolldownCellBundlerOptions): CellBundlerPort {
  return {
    bundle: request => bundleWithRolldown(options.dir, request, options.alias),
    resolveEntrySpecifiers: request => resolveEntrySpecifiersWithRolldown(options.dir, request, options.alias),
  };
}

// ---------------------------------------------------------------------------
// The preflight
// ---------------------------------------------------------------------------

/**
 * The entry's bare specifiers, analysed through the same resolver the build uses
 * and **without generating any code**.
 *
 * This is a preflight, and both halves of that sentence are load-bearing.
 *
 * **No code generation.** `rolldown()` + `generate()` was the first implementation
 * and it was wrong: `generate()` renders chunks and bundles them, which is exactly
 * the work the preflight exists to avoid. A stage probe makes the difference
 * explicit — `scan` runs `resolve` and `transform`; `generate` additionally runs
 * `renderChunk` and `generateBundle`. So a `generate()`-based pass would mean the
 * cycle was still discovered *after* Rolldown had bundled once, and a failure from
 * that pass would return `bundler-failure` before the structured cycle diagnostic
 * could be emitted. `scan` is the analysis-only entry, and it is what makes the
 * refusal genuinely pre-bundling rather than merely pre-`bundle()`.
 *
 * **The same resolver.** Correctness depends on running the same interception
 * machinery as the build — see {@link createInterceptionResolver}. With the
 * decisions applied, a `host`-decided package resolves to the plan's virtual module,
 * so the local source is not traversed and an uninstalled host package does not fail
 * resolution. Without them the pass would walk real `node_modules`, report a
 * superset, and refuse compiles the build would have completed.
 *
 * `scan` returns nothing, so the specifiers are collected from the plugin hooks it
 * does run. `resolveId` sees every specifier the graph asks for, bare ones
 * included, which is the set #14's audit traces its closure from.
 */
async function resolveEntrySpecifiersWithRolldown(
  dir: string,
  request: CellResolveRequest,
  alias: Readonly<Record<string, string>> | undefined,
): Promise<readonly string[]> {
  const resolvedEntry = path.resolve(dir, request.entry);
  if (!isRegularFile(resolvedEntry)) {
    throw new Error(`The entry "${request.entry}" does not exist at ${resolvedEntry}.`);
  }

  const resolver = createInterceptionResolver(request.dependencies, request.extensionMappings);
  const virtualModules = new Map<string, string>();
  // The preflight inlines no resource (it generates no code), but it does *classify* them, so a
  // stylesheet that references an oversized image is refused before the build rather than after.
  const resources = createResourceState(dir, request.assetInlineLimitBytes ?? CELL_ASSET_INLINE_LIMIT_BYTES);

  try {
    await scan({
      input: resolvedEntry,
      ...cellBundlerInputOptions(),
      ...rolldownAliasOptions(alias),
      plugins: [
        {
          name: "cell-compiler-entry-specifier-scan",
          async resolveId(source, importer, options) {
            return resolveCellSpecifier(this, resolver, virtualModules, source, importer, options, resources);
          },
          load(id) {
            const resourceModule = resolveResourceModule(resources, id);
            if (resourceModule !== undefined) return resourceModule;
            const source = virtualModules.get(id);
            return source === undefined ? null : source;
          },
        },
      ],
    });
  } catch (error) {
    // A resource refusal keeps its structured code rather than becoming `bundler-failure`: the
    // caller can act on "outside the v1 support set" and cannot act on "the bundler failed".
    //
    // The recorded list is checked as well as the error's type because Rolldown wraps a hook's
    // thrown error in its own build error on the way out; the plugin already recorded the
    // refusal before throwing, so the finding survives the wrapping.
    if (resources.refusals.length > 0) throw new CellResourcePolicyError(resources.refusals);
    if (error instanceof CellResourcePolicyError) throw error;
    // The same reduction the build path applies, and for the same reason: this
    // message becomes a `bundler-failure` diagnostic's `detail`, which lands in CI
    // logs that get diffed, so Rolldown's ANSI framing and source frames must not
    // travel with it.
    throw new Error(describeBuildFailure(error));
  }

  // Sorted so the audit's input is deterministic like every other report field.
  return [...resolver.referencedSpecifiers].sort();
}

// ---------------------------------------------------------------------------
// Virtual module ids
// ---------------------------------------------------------------------------

/**
 * The id the generated entry shim is registered under.
 *
 * Fixed and path-free: the shim exists per build, is never read from disk, and
 * warnings attributed to this exact id are how {@link assertEntryComponentBinding}
 * tells "this entry has no component" apart from "this entry's own imports are
 * mistyped" — the latter names the authored file, not the shim.
 */
const CELL_ENTRY_SHIM_ID = "cell-entry-shim.js";

/**
 * The shim source: default-export-first, else the named `App` #5's resolution
 * order falls back to.
 *
 * Both names are read deliberately. #5 established that entries use either
 * style, and a shim that picked one would silently compile the other into
 * `undefined`; reading both lets the missing-name warnings distinguish "neither
 * exists" from either normal case.
 */
function renderEntryShim(resolvedEntry: string): string {
  // Forward slashes on purpose: the specifier is embedded in a generated
  // import, and every rolldown resolver accepts `/` on Windows while `\` is
  // not universally read as a path separator inside a specifier.
  const entrySpecifier = resolvedEntry.split(path.sep).join("/");
  return [
    `import * as __fgcCellEntryModule from ${JSON.stringify(entrySpecifier)};`,
    `const __fgcCellEntryComponent = __fgcCellEntryModule.default ?? __fgcCellEntryModule.App;`,
    `export default __fgcCellEntryComponent;`,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Failure descriptions
// ---------------------------------------------------------------------------

/**
 * Turns an escaped bundler failure into one clean message.
 *
 * `compileCell`'s catch builds the `bundler-failure` diagnostic from whatever
 * the thrown error says, so this message *is* the structured diagnostic's
 * content: reported errors reduce to `message (file:line:column)` lines, and
 * anything unstructured passes through stripped rather than raw.
 */
function describeBuildFailure(error: unknown): string {
  if (hasReportedErrors(error) && error.errors.length > 0) {
    return error.errors.map(entry => describeReportedError(entry, { message: stripAnsi })).join("\n");
  }
  if (error instanceof Error) return stripAnsi(error.message);
  return stripAnsi(String(error));
}

// ---------------------------------------------------------------------------
// Alias options
// ---------------------------------------------------------------------------

/**
 * The `resolve.alias` half of the Rolldown options, or nothing when the project declared none.
 *
 * Spread rather than always passing `resolve`, and the difference is a claim rather than
 * tidiness: an empty `resolve.alias` object is *stated* and means "match nothing", while an
 * absent `resolve` key means the caller said nothing at all. Collapsing them would make the
 * compiler's own configuration indistinguishable from a project's, which is the "implicit
 * default" #97 forbids — and the distinction is observable in the report a reviewer reads,
 * because `resolve: { alias: {} }` in a diff reads as a decision somebody made.
 *
 * ## Why the alias is a build option and not a plugin
 *
 * Rolldown offers three ways to do this, and only one keeps the preflight and the build
 * agreeing — which is the property `resolveCellSpecifier` exists to protect:
 *
 * - **`resolve.alias`** (used here) applies inside Rolldown's own resolver, after the plugin
 *   `resolveId` hooks. Measured: an id the interception hook claims still resolves to the
 *   interposed module with a matching alias present, so the host bridge and the extension
 *   externals keep precedence and the alias answers only what they left alone. It also works
 *   identically under `scan`, which is what the pre-bundle specifier pass runs — measured, and
 *   that is the fact this whole choice turns on.
 * - **`viteAliasPlugin`** from `rolldown/experimental` wraps the alias in a plugin. It would
 *   put a second plugin in both passes' `plugins` arrays, and its ordering against the
 *   interception hook would be a thing to get right rather than a thing that is right.
 * - **Rewriting specifiers in this compiler's own `resolveId`** would make this package a
 *   resolver for aliases, which #6 forbids, and would put the rule in a different place from
 *   the one the dev server applies.
 *
 * The alias set is validated against both engines' rules before it reaches here
 * (`normalizeResolveConfig`), so the subset that arrives is exactly the subset Vite and
 * Rolldown agree on.
 */
function rolldownAliasOptions(
  alias: Readonly<Record<string, string>> | undefined,
): { readonly resolve?: { readonly alias: Readonly<Record<string, string>> } } {
  return alias === undefined ? {} : { resolve: { alias } };
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

interface CapturedLog {
  readonly code: string;
  readonly id: string;
  readonly message: string;
}

/**
 * Refuses an entry that offers no component for the shim to bind.
 *
 * Detection runs on the shim's own warnings rather than on parsed exports: the
 * two `IMPORT_IS_UNDEFINED` warnings are rolldown telling us it evaluated both
 * `default` and `App` against the entry's namespace and found nothing — the
 * authoritative answer to "does a component exist", from the same resolution
 * the artifact will run at, with no second parser to disagree with it. One
 * warning is normal (entries legitimately use either export style); both mean
 * the build would succeed and hand the cell a binding of `void 0`, which #6's
 * error model asks to refuse structurally instead.
 */
function assertEntryComponentBinding(logs: readonly CapturedLog[], entry: string): void {
  const missing = new Set<string>();
  for (const log of logs) {
    if (log.code !== "IMPORT_IS_UNDEFINED" || log.id !== CELL_ENTRY_SHIM_ID) continue;
    const match = /Import `([^`]+)`/.exec(stripAnsi(log.message));
    if (match?.[1] !== undefined) missing.add(match[1]);
  }
  if (missing.has("default") && missing.has("App")) {
    throw new Error(
      `The entry "${entry}" exports neither a default export nor a named "App" export, so there is no component for the ReactCellType entry to bind.`,
    );
  }
}

async function bundleWithRolldown(
  dir: string,
  request: CellBundlingRequest,
  alias: Readonly<Record<string, string>> | undefined,
): Promise<BundledCellModule> {
  const resolvedEntry = path.resolve(dir, request.entry);
  if (!isRegularFile(resolvedEntry)) {
    // Refused before the build rather than left to the bundler's
    // UNRESOLVED_ENTRY wording: the caller gets the entry as authored and the
    // path it was resolved to, with no frame to strip.
    throw new Error(`The entry "${request.entry}" does not exist at ${resolvedEntry}.`);
  }

  const decisions = request.dependencies;
  const shimSource = renderEntryShim(resolvedEntry);
  const logs: CapturedLog[] = [];
  const virtualModules = new Map<string, string>();
  // One resolver, shared with the pre-bundle specifier pass, so the two cannot
  // disagree about what the entry imports — see `createInterceptionResolver`.
  // The project's mapping set rides along for the same reason: both passes must
  // consult the table the caller selected, not `core`'s shipped default.
  const resolver = createInterceptionResolver(request.dependencies, request.extensionMappings);
  const fallThroughResolutions = resolver.fallThroughResolutions;
  const referencedPackages = resolver.referencedPackages;
  const hostFindings = resolver.hostFindings;
  const extensionFindings = resolver.extensionFindings;
  resolver.primeDiagnostics();
  // The resource ledger (#98). One per build, read below; the modules it registers load from
  // `virtualModules` like every other generated module, so the bundler has nothing extra to know.
  const resources: ResourceResolutionState = createResourceState(
    dir,
    request.assetInlineLimitBytes ?? CELL_ASSET_INLINE_LIMIT_BYTES,
  );

  let build: Awaited<ReturnType<typeof rolldown>> | undefined;
  let output: (OutputChunk | OutputAsset)[];
  try {
    build = await rolldown({
      input: CELL_ENTRY_SHIM_ID,
      onLog: (_level, log) => {
        // Collected, not forwarded: the build's warnings are read here (entry
        // shape); the report and the audits speak for everything else.
        logs.push({ code: log.code ?? "", id: log.id ?? "", message: log.message });
      },
      ...cellBundlerInputOptions(),
      ...rolldownAliasOptions(alias),
      plugins: [
        {
          name: "cell-compiler-rolldown-bundler",
          async resolveId(source, importer, options) {
            if (source === CELL_ENTRY_SHIM_ID) return CELL_ENTRY_SHIM_ID;
            // The same resolution the preflight runs — see `resolveCellSpecifier` for why
            // it is shared rather than written here a second time, and why the runtime
            // binding's own façade import is resolved inside it.
            return resolveCellSpecifier(this, resolver, virtualModules, source, importer, options, resources);
          },
          load(id) {
            if (id === CELL_ENTRY_SHIM_ID) return shimSource;
            const resourceModule = resolveResourceModule(resources, id);
            if (resourceModule !== undefined) return resourceModule;
            const source = virtualModules.get(id);
            return source === undefined ? null : source;
          },
        },
      ],
    });
    ({ output } = await build.generate(cellBundlerOutputOptions(request.componentBinding)));
  } catch (error) {
    if (resources.refusals.length > 0) throw new CellResourcePolicyError(resources.refusals);
    // The resource refusal keeps its code — see `resolveResourceSpecifier`.
    if (error instanceof CellResourcePolicyError) throw error;
    throw new Error(describeBuildFailure(error));
  } finally {
    await build?.close();
  }

  assertEntryComponentBinding(logs, request.entry);

  const entryChunk = output.find(candidate => candidate.type === "chunk" && candidate.isEntry);
  if (entryChunk === undefined || entryChunk.type !== "chunk") {
    throw new Error(`The bundler produced no entry chunk for "${request.entry}".`);
  }

  const emittedAssets = output
    .filter(candidate => candidate !== entryChunk)
    .map(candidate => candidate.fileName)
    .sort();
  const externalImports = [...entryChunk.imports].sort();
  const moduleIds = Object.keys(entryChunk.modules);
  const inlinedPackages = inlinedPackageNames(moduleIds);
  const inlinedPackageSizes = inlinedPackageSizesOf(entryChunk.modules);
  // Bare specifiers whose resolved module actually landed in the entry chunk
  // and whose id sits under `node_modules` after symlink resolution. Sorted for
  // byte-stable reports; the decision loop and `auditInlinedPackages` both read
  // this list so exact-subpath precedence survives the fold into package names.
  // Keys are compared with both separators normalized: on Windows the chunk
  // reports backslash paths while `this.resolve` may hand back either form.
  const moduleIdSet = new Set(moduleIds.flatMap(id => [id, id.replace(/\\/g, "/")]));
  const inlinedSpecifiers = [...fallThroughResolutions.entries()]
    .filter(([specifier, resolvedId]) => {
      const normalized = resolvedId.replace(/\\/g, "/");
      if (!resolvesIntoNodeModules(resolvedId)) {
        return false;
      }
      if (moduleIdSet.has(normalized)) {
        return true;
      }
      // An installed package's *entry* module can be absent from the chunk even though its code
      // was inlined: a barrel whose re-exports the bundler folded in leaves the entry itself
      // tree-shaken, while the submodules it re-exported are in `entryChunk.modules`. Measured on
      // `es-toolkit`: `dist/index.mjs` is not in the chunk, `dist/math/clamp.mjs` and
      // `dist/math/sumBy.mjs` are. Requiring the resolved entry id alone therefore reported no
      // specifier for a package that was plainly inlined, and #102's stale-evidence fault found
      // the consequence — a withheld `inline` decision compiled the package in and reported
      // nothing, so the build served evidence the lock had already withdrawn.
      //
      // The package's presence in the chunk is the same fact at the grain the decision is keyed
      // at, so it is the fallback. Exact-subpath precedence is preserved: the *specifier* is what
      // is reported, so `findDependencyDecision` still sees `pkg/subpath` rather than the folded
      // package root.
      return inlinedPackages.includes(packageNameOfSpecifier(specifier));
    })
    .map(([specifier]) => specifier)
    .sort();

  const translated: (CellArtifactDiagnostic | undefined)[] = [];
  for (const finding of [...hostFindings.values()].sort((a, b) =>
    byCodeThenSubject({ code: a.code, subject: a.specifier }, { code: b.code, subject: b.specifier }),
  )) {
    translated.push(translateHostFinding(finding, inlinedPackages, referencedPackages));
  }
  for (const finding of [...extensionFindings.values()].sort(byCodeThenSubject)) {
    translated.push(translateExtensionFinding(finding));
  }
  // Every installed bare specifier the bundler inlined must have a decision
  // that covers *that specifier*. Looking up the folded package root would
  // lose exact-subpath precedence: `{ inline, "sneaky-dep/subpath" }` covers
  // `sneaky-dep/subpath` but not `sneaky-dep`, and vice versa. Workspace
  // source legitimately has no decision (#14); `inlinedSpecifiers` already
  // excludes it because its resolved id sits outside `node_modules`.
  for (const specifier of inlinedSpecifiers) {
    if (findDependencyDecision(decisions, specifier) !== undefined) continue;
    translated.push(
      createCellArtifactDiagnostic("unresolved-dependency-decision", specifier, {
        detail: `The bundle inlined "${specifier}" from an installed dependency, but no dependency decision covers it.`,
      }),
    );
  }
  const diagnostics = dedupeCellArtifactDiagnostics(
    translated.filter((diagnostic): diagnostic is CellArtifactDiagnostic => diagnostic !== undefined),
  );

  return {
    code: entryChunk.code,
    externalImports,
    inlinedPackages,
    inlinedPackageSizes,
    inlinedSpecifiers,
    emittedAssets,
    // Whether the generated binding made it into this graph. The wrapper needs it to decide
    // whether it may reference the artifact-scope props variable (#83); the binding module's
    // id is registered exactly when `resolveCellSpecifier` took its `runtime-binding` arm, so
    // the presence of the module is the answer rather than a search of the output text.
    runtimeBindingGenerated: virtualModules.has(CELL_RUNTIME_BINDING_ID),
    resources: resources.resources,
    // Sorted for a byte-stable report, like every other list here: #7's determinism
    // criterion covers the whole result, and #14's audit orders a closure from this
    // set, so an unordered report would not change the verdict while an unordered
    // *list* would still be a report that differs between runs.
    referencedSpecifiers: [...resolver.referencedSpecifiers].sort(),
    diagnostics,
  };
}
