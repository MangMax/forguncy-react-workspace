/**
 * The Rolldown plugin half of {@link CellBundlerPort}: virtual modules, the interception
 * resolver, and the v1 resource/asset inlining hooks.
 *
 * Decision source: GitHub Issue #7 — "Implement: Cell compiler MVP for a single
 * React entry"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/7), downstream of
 * #6's compiler boundary (https://github.com/Mang-X/forguncy-react-workspace/issues/6),
 * which names Vite+/Rolldown as the bundler half this package may use rather
 * than becoming a second resolver.
 *
 * Split out of `rolldown-bundler.ts` (#170) along the seam between *resolving and
 * loading modules* and *running a build*: nothing here calls `rolldown()` or `scan()`,
 * renders a chunk, or turns a failure into a diagnostic. Everything is per-pass state
 * created by whichever pass is running, so a build cannot see a previous build's
 * ledger or interceptions — which is why the state objects are factories rather than
 * module-level constants.
 *
 * Both passes share these functions on purpose. The preflight's whole claim is that
 * the specifiers it audits are the specifiers the build resolves; two copies of this
 * logic would eventually disagree, and the disagreement would be invisible because
 * each copy is self-consistent.
 */

import path from "node:path";

import type {
  DependencyDecision,
  ExtensionExternalDiagnostic,
  NormalizedExtensionMappings,
} from "@forguncy-react-workspace/core";
import {
  CELL_RUNTIME_BINDING_CONTRACT,
  cellResourceQueryRefusal,
  queryHasRejectedResourceParameter,
  splitCellSpecifierQuery,
} from "@forguncy-react-workspace/core";
import type { PluginContext, ResolveIdExtraOptions } from "rolldown";

import { packageNameOfSpecifier } from "./specifier.ts";
import type { ExtensionExternalsPlan } from "./extension-externals.ts";
import { planExtensionExternals } from "./extension-externals.ts";
import type { HostBridgeDiagnostic, HostBridgePlan } from "./host-bridge.ts";
import { planHostBridge } from "./host-bridge.ts";
import { CELL_RUNTIME_BINDING_ID, renderRuntimeBindingModule } from "./runtime-binding.ts";
import { CellResourcePolicyError, isCellResourceFile, resolveCellResource } from "./cell-resources.ts";
import type { CellInlinedResource, CellResourceRefusal, CellResourceResolution } from "./cell-resources.ts";

// ---------------------------------------------------------------------------
// Interception
// ---------------------------------------------------------------------------

/**
 * One intercepted specifier, as the pair (virtual module id, source to load).
 *
 * Two shapes rather than one, because the runtime binding is the first interception whose
 * source is not a pure function of the mapping: it has to carry the *resolved* façade
 * specifier, which only a plugin hook can obtain. `runtime-binding` names the bare
 * specifier to resolve; `source` carries text that is already final.
 */
type Interception =
  | { readonly kind: "source"; readonly id: string; readonly source: string; readonly moduleType: "commonjs" }
  | {
      readonly kind: "runtime-binding";
      readonly id: string;
      /** What authored source wrote, and what the interception matched. */
      readonly facadeSpecifier: string;
      /** The entry the generated module imports (#124); resolved separately below. */
      readonly bindingSpecifier: string;
      readonly moduleType: "esm";
    };

interface InterceptionResolver {
  readonly interceptionFor: (specifier: string, importer: string | undefined) => Interception | undefined;
  readonly referencedSpecifiers: Set<string>;
  readonly referencedPackages: Set<string>;
  readonly fallThroughResolutions: Map<string, string>;
  readonly hostFindings: Map<string, HostBridgeDiagnostic>;
  readonly extensionFindings: Map<string, ExtensionExternalDiagnostic>;
  /** Consulted once with no references, so a plan-level finding cannot hide. */
  readonly primeDiagnostics: () => void;
}

/**
 * The interception machinery, shared by the pre-bundle pass and the build.
 *
 * Extracted rather than duplicated because the two must agree exactly: the
 * preflight's whole claim is that the specifiers it audits are the specifiers the
 * build resolves. Two copies of this logic would eventually disagree — and the
 * disagreement would be invisible, because each copy is self-consistent.
 *
 * The plan caches and finding maps are per-call state, so one build cannot see
 * another's interceptions. `referencedSpecifiers` is the set the report needs; the
 * caller reads it after the pass that populated it.
 *
 * ## The three branches, and why the third needs the importer
 *
 * The host bridge and the extension externals are keyed on the specifier alone: an
 * authored `import ... from "react"` means the page object wherever it appears. The
 * runtime binding (#82) is the first interception that is **not** keyed on the specifier
 * alone, because the module it generates imports the very package it replaces. Without
 * the `importer` argument the generated module would be intercepted by its own branch —
 * a cycle that resolves to a module importing itself — so the binding is skipped for
 * importers that are generated (`\0`-prefixed), and the binding's own import is resolved
 * by the caller to the real façade.
 *
 * That resolution cannot happen here: it needs Rolldown's `this.resolve`, which exists
 * only inside a plugin hook. So the branch reports the specifier it needs resolved and the
 * *callers* do it, through {@link resolveCellSpecifier} — one implementation, two call
 * sites, which is the same rule this function exists to enforce.
 */
export function createInterceptionResolver(
  decisions: readonly DependencyDecision[],
  extensionMappings: NormalizedExtensionMappings | undefined,
): InterceptionResolver {
  // Every bare specifier resolved at all, intercepted or not. This is the set #14's
  // workspace audit traces its closure from, so it must include the ones the plans
  // *did* intercept — a workspace package the host bridge claimed is still a module
  // the cell imports, and omitting it would make the closure smaller than reality.
  const referencedSpecifiers = new Set<string>();
  // Every bare specifier that fell through interception, paired with the resolved
  // module id Rolldown would have used anyway. Provenance so the report can name
  // the real bare specifier (`sneaky-dep/subpath`) instead of the folded package
  // root (`sneaky-dep`), preserving exact-subpath decision precedence.
  const fallThroughResolutions = new Map<string, string>();
  const referencedPackages = new Set<string>();
  const hostFindings = new Map<string, HostBridgeDiagnostic>();
  const extensionFindings = new Map<string, ExtensionExternalDiagnostic>();
  const hostPlans = new Map<string, HostBridgePlan>();
  const extensionPlans = new Map<string, ExtensionExternalsPlan>();

  function consultHostPlan(referencedSpecifiers: readonly string[]): HostBridgePlan {
    const plan = planHostBridge({ decisions, referencedSpecifiers });
    for (const finding of plan.diagnostics) hostFindings.set(`${finding.code} ${finding.specifier}`, finding);
    return plan;
  }

  function consultExtensionPlan(referencedSpecifiers: readonly string[]): ExtensionExternalsPlan {
    // The project's own set, passed through exactly as #85 normalized it. Never
    // re-read or re-merged here: a bundler that fell back to `core`'s table while the
    // caller had project rows would answer a mapped import from the wrong catalog —
    // and, when the package happened to be installed, silently inline the npm copy
    // instead. `undefined` is "the caller stated no set", which is the built-in
    // default, not a licence to skip the plan.
    const plan = planExtensionExternals({
      decisions,
      referencedSpecifiers,
      ...(extensionMappings === undefined ? {} : { mappings: extensionMappings.mappings }),
    });
    for (const finding of plan.diagnostics) extensionFindings.set(`${finding.code} ${finding.subject}`, finding);
    return plan;
  }

  function interceptionFor(specifier: string, importer: string | undefined): Interception | undefined {
    referencedPackages.add(packageNameOfSpecifier(specifier));
    referencedSpecifiers.add(specifier);

    // The runtime binding (#82), and the one branch that is skipped rather than taken for
    // a generated importer. Its own module imports this same specifier, so intercepting
    // that import would make the binding import itself; the skip is what leaves the
    // binding's own import to ordinary resolution — to the façade's real source, in the
    // same place the authored import lands.
    //
    // Deliberately before the two plan branches, and that ordering is not arbitrary: the
    // façade is workspace source (#14) with no dependency decision, so neither plan claims
    // it. Putting the branch last would still work today and would silently stop working
    // the day a table row named the façade — which is exactly the kind of latent ordering
    // dependence the two branches below document themselves for.
    if (specifier === CELL_RUNTIME_BINDING_CONTRACT.facadeSpecifier) {
      if (importer !== undefined && isGeneratedModuleId(importer)) return undefined;
      return {
        kind: "runtime-binding",
        id: CELL_RUNTIME_BINDING_ID,
        facadeSpecifier: specifier,
        bindingSpecifier: CELL_RUNTIME_BINDING_CONTRACT.bindingSpecifier,
        moduleType: "esm",
      };
    }

    let hostPlan = hostPlans.get(specifier);
    if (hostPlan === undefined) {
      hostPlan = consultHostPlan([specifier]);
      hostPlans.set(specifier, hostPlan);
    }
    // The page's own modules first: a host row and an extension row naming the same
    // specifier must resolve to the page object, never to a second copy behind an
    // extension global.
    //
    // `wireable` as well as `stated`, matching the extension branch below: a table
    // whose mappings contradict themselves yields an empty interception list either
    // way, so this is not a behaviour change — but stating the rule here is what keeps
    // the two branches from drifting into looking like they answer different questions.
    if (hostPlan.activation === "stated" && hostPlan.wireable) {
      const host = hostPlan.interceptions.find(candidate => candidate.moduleId === specifier);
      if (host !== undefined) {
        return {
          kind: "source",
          id: `${HOST_VIRTUAL_PREFIX}${specifier}`,
          source: host.source,
          moduleType: "commonjs",
        };
      }
    }

    let extensionPlan = extensionPlans.get(specifier);
    if (extensionPlan === undefined) {
      extensionPlan = consultExtensionPlan([specifier]);
      extensionPlans.set(specifier, extensionPlan);
    }
    // `wireable` rather than merely `stated`: a decision that contradicts the mapping
    // row must not be interposed behind a global the row does not agree on — the
    // import stays ordinary, the plan's finding travels through `diagnostics`, and
    // the artifact is refused in the same vocabulary an unwired extension import is.
    if (extensionPlan.activation === "stated" && extensionPlan.wireable) {
      const extension = extensionPlan.interceptions.find(candidate => candidate.moduleId === specifier);
      if (extension !== undefined) {
        return {
          kind: "source",
          id: `${EXTENSION_VIRTUAL_PREFIX}${specifier}`,
          source: extension.source,
          moduleType: "commonjs",
        };
      }
    }
    return undefined;
  }

  return {
    interceptionFor,
    referencedSpecifiers,
    referencedPackages,
    fallThroughResolutions,
    hostFindings,
    extensionFindings,
    primeDiagnostics: () => {
      // Consulted once with no references: decision-vs-mapping contradictions are
      // reported even when the entry imports nothing bare, so a broken decision
      // cannot hide behind an entry that never exercises it.
      consultHostPlan([]);
      consultExtensionPlan([]);
    },
  };
}

/**
 * Whether a module id names a virtual module rather than a file on disk.
 *
 * The three interposed modules this package registers are `\0`-prefixed — the host bridge,
 * the extension externals and the runtime binding — which is the convention that
 * distinguishes "a module we composed" from "a module that exists" without a list of ids to
 * keep in step. `runtime-binding.ts`'s header relies on the same prefix, so the two modules
 * agree about it by convention rather than by importing a shared constant.
 *
 * The entry shim is deliberately *not* in this set: its id is a plain `cell-entry-shim.js`,
 * and it is never an importer of the façade, so the one decision this predicate serves does
 * not arise for it. Widening the predicate to cover it would mean the shim's id could no
 * longer be the stable, path-free string `assertEntryComponentBinding` matches warnings
 * against.
 */
function isGeneratedModuleId(id: string): boolean {
  return id.startsWith("\0");
}

/**
 * What {@link resolveCellSpecifier} hands back: an interception to load, or nothing.
 *
 * A named type rather than `ResolveIdResult`, because `moduleType` is the one field this
 * compiler needs and Rolldown's `PartialResolvedId` does not declare it — it is a
 * `SourceDescription` field. Naming the shape keeps the two facts visible: the id and the
 * module type travel together, and the module type is either `"commonjs"` for the two
 * plans' `module.exports` modules or `"esm"` for the runtime binding, which is genuinely
 * ESM. The assignability to Rolldown's own result type is the hook's business, not this
 * function's, and is what it was before this extraction.
 */
type CellSpecifierResolution = { readonly id: string; readonly moduleType: "commonjs" | "esm" };

/**
 * The `resolveId` half of both passes' plugin, so the two cannot drift.
 *
 * Extracted for the reason {@link createInterceptionResolver} is: the preflight's claim is
 * that the specifiers it audits are the ones the build resolves, and a fix applied to one
 * hook and not the other is exactly how that stops being true. The runtime binding is where
 * it nearly happened — its own façade import has to be resolved with `this.resolve`, which
 * exists only inside a hook, so writing that resolution in one hook and not the other would
 * have left the preflight auditing a specifier set the build does not produce.
 *
 * `this.resolve` is passed in rather than reached for, because it exists only on a plugin
 * context and this function is not a hook. Everything else the hook needs is closed over.
 *
 * `moduleType` is set per interception rather than uniformly, and the values describe what
 * each generated source *is*: the host bridge's and the extension externals' are
 * `module.exports = …`, so `"commonjs"` — the interop the extension unit tests exercise
 * through a real build, so an authored `import { x }` and a namespace import each enumerate
 * the interposed module correctly — while the runtime binding's is `import` / `export *`.
 *
 * Scope note on that field, because it is easy to read as more than it is: the value was
 * measured not to change this build's output — the binding compiles and runs identically
 * with `"commonjs"` — so `"esm"` is a truthful label rather than a load-bearing setting.
 * It is stated per interception anyway, because a label that happens not to matter today is
 * exactly the kind that becomes wrong without anyone noticing once a Rolldown version
 * starts honouring it.
 */
export async function resolveCellSpecifier(
  context: PluginContext,
  resolver: InterceptionResolver,
  virtualModules: Map<string, string>,
  source: string,
  importer: string | undefined,
  options: ResolveIdExtraOptions,
  resources?: ResourceResolutionState,
): Promise<CellSpecifierResolution | null> {
  if (!isBareSpecifier(source)) {
    // A relative/absolute resource import (#98) is resolved by the bundler exactly as any other
    // file — this branch only *asks* the bundler where it landed, then decides whether the
    // resolved file is a resource this compiler inlines. Doing it here rather than in a second
    // `resolveId` plugin is what keeps "which file is this import" answered once.
    if (resources !== undefined) {
      const resource = await resolveResourceSpecifier(context, resources, virtualModules, source, importer, options);
      if (resource !== undefined) return resource;
    }
    return null;
  }
  const interception = resolver.interceptionFor(source, importer);
  if (interception === undefined) {
    // A **bare** resource import — `import "antd/dist/reset.css"` or a package's own
    // `pkg/logo.svg` — is a file like any other once resolved, so it takes the same path the
    // relative branch above does. Checked before the fall-through bookkeeping because a resource
    // is inlined by this compiler and has no package decision to audit.
    if (resources !== undefined) {
      const resource = await resolveResourceSpecifier(context, resources, virtualModules, source, importer, options);
      if (resource !== undefined) return resource;
    }
    // Record where Rolldown's own resolution lands, so a specifier that simply is not
    // installed is still reported as referenced rather than dropped — the audit decides
    // what that means, not this pass.
    const resolved = await context.resolve(source, importer, { ...options, skipSelf: true });
    if (resolved !== null && resolved.external !== true) {
      resolver.fallThroughResolutions.set(source, resolved.id);
    }
    return null;
  }

  if (interception.kind === "runtime-binding") {
    // The binding's own import of the façade must resolve to the façade's real source,
    // which means resolving it *here*, against the importer that asked for it — the
    // authored module — rather than against the `\0` id that has no directory. Resolving
    // it against the binding's id is the bug this arm exists to prevent: Rolldown then
    // falls back to the process cwd, and from a directory that has no link to the façade
    // the import goes external, which ships an artifact naming an undefined IIFE
    // parameter.
    // Two resolutions, because the generated module imports a different entry than the one the
    // Cell wrote (#124): the authored specifier is the package barrel, and the module this
    // binding *is* must import the package's production entry. Resolving the barrel and then
    // importing it is what shipped the local-dev contract into every artifact, so both are
    // resolved here and the one the binding embeds is `bindingSpecifier`'s.
    const resolvedFacade = await context.resolve(interception.facadeSpecifier, importer, {
      ...options,
      skipSelf: true,
    });
    if (resolvedFacade === null || resolvedFacade.external === true) {
      // Thrown rather than left to fall through, and the distinction matters: falling
      // through would resolve the authored import by ordinary means — the façade's source
      // is inlined, no binding is generated — and produce an artifact that compiles and
      // then fails at its first façade call with `provider-not-installed`. That is the
      // exact defect #82 exists to remove, so an unresolvable façade must not be able to
      // reproduce it silently. Both passes convert a thrown error into a
      // `bundler-failure` diagnostic, which names this message.
      throw new Error(
        `The Cell imports "${interception.facadeSpecifier}", which could not be resolved from "${importer ?? "the entry"}", so the generated runtime binding has nothing to install from. Install the façade as a dependency of the project the Cell is compiled in.`,
      );
    }
    const resolvedBinding = await context.resolve(interception.bindingSpecifier, importer, {
      ...options,
      skipSelf: true,
    });
    if (resolvedBinding === null || resolvedBinding.external === true) {
      throw new Error(
        `The Cell imports "${interception.facadeSpecifier}", whose generated runtime binding needs its production entry "${interception.bindingSpecifier}", which could not be resolved from "${importer ?? "the entry"}". The package declares that subpath; a link that does not provide it cannot produce a production Cell artifact.`,
      );
    }
    virtualModules.set(interception.id, renderRuntimeBindingModule(resolvedBinding.id));
    return { id: interception.id, moduleType: interception.moduleType };
  }

  virtualModules.set(interception.id, interception.source);
  return { id: interception.id, moduleType: interception.moduleType };
}

// ---------------------------------------------------------------------------
// Resources (#98)
// ---------------------------------------------------------------------------

/**
 * The resources one pass inlined, plus the refusals it accumulated (#98).
 *
 * Per-pass rather than per-bundler for the same reason the interception resolver is: a build must
 * not see a previous build's ledger, so the object is created by whichever pass is running and
 * read by that same pass.
 */
export interface ResourceResolutionState {
  /** The directory report paths are relative to, so the ledger is portable across machines. */
  readonly dir: string;
  readonly inlineLimitBytes: number;
  readonly resources: CellInlinedResource[];
  readonly refusals: CellResourceRefusal[];
  /** One resource per resolved module id, so a CSS file imported twice is inlined once. */
  readonly byModuleId: Map<string, CellResourceResolution>;
}

export function createResourceState(dir: string, inlineLimitBytes: number): ResourceResolutionState {
  return {
    dir,
    inlineLimitBytes,
    resources: [],
    refusals: [],
    byModuleId: new Map(),
  };
}

/**
 * Resolves a relative/absolute import and, when it is a resource, compiles it inline.
 *
 * ## Why the bundler resolves first
 *
 * A resource `import "./x.css"` is an ordinary file import with an unusual payload. Asking
 * `context.resolve` first is what keeps this module out of the resolution business: extensions,
 * directory indexes, aliases and package `exports` are all answered by the bundler, and this
 * function only inspects the *resolved file* it is handed. A compiler that resolved `./x` to
 * `./x.css` itself would be the second resolver #6 forbids.
 *
 * ## Why a refusal throws
 *
 * Rolldown has no "resolve, but with a structured finding" return. A refusal has to leave the
 * hook somehow, and the two options are (a) return nothing, which falls through to ordinary
 * resolution and produces an artifact with a broken import, or (b) throw. (b) is chosen and the
 * throw travels as {@link CellResourcePolicyError}, which both passes catch and reduce to their
 * own diagnostics — the same error-into-diagnostic conversion `compileCell` already performs for
 * `bundler-failure`, but preserving the actionable code.
 */
async function resolveResourceSpecifier(
  context: PluginContext,
  state: ResourceResolutionState,
  virtualModules: Map<string, string>,
  source: string,
  importer: string | undefined,
  options: ResolveIdExtraOptions,
): Promise<CellSpecifierResolution | undefined> {
  if (source.startsWith("\0")) return undefined;
  const { path: barePath, query } = splitCellSpecifierQuery(source);
  // A Vite resource query is refused for *any* file, not only a resource extension: `worker.js`
  // has an ordinary `.js` extension and is still a runtime asset the compiled Cell cannot serve.
  // The sentence is `core`'s (#153), so the same import refused locally reads identically here.
  const queryRefusal = cellResourceQueryRefusal(source, query, importer);
  if (queryRefusal !== undefined && query !== undefined && queryHasRejectedResourceParameter(query)) {
    state.refusals.push(queryRefusal);
    throwResourceRefusal([queryRefusal]);
  }

  // A `.svg` imported without a query is a resource; a `./data.json` is not, and must not pay for
  // an extra `this.resolve` on every relative import in hot bundles.
  if (!isCellResourceFile(barePath)) return undefined;

  const resolved = await context.resolve(source, importer, { ...options, skipSelf: true });
  if (resolved === null || resolved.external === true) return undefined;

  const cached = state.byModuleId.get(resolved.id);
  if (cached !== undefined) {
    if (!cached.ok) throwResourceRefusal([cached.refusal]);
    virtualModules.set(cached.moduleId, cached.source);
    return { id: cached.moduleId, moduleType: "esm" };
  }

  const outcome = await resolveCellResource({
    importer,
    fileId: resolved.id,
    inlineLimitBytes: state.inlineLimitBytes,
  });
  state.byModuleId.set(resolved.id, outcome);

  if (!outcome.ok) {
    state.refusals.push(outcome.refusal);
    throwResourceRefusal([outcome.refusal]);
  }

  // The ledger's path is project-relative: an absolute path would make the same build's report
  // differ between machines, which is a determinism claim the artifact contract makes.
  state.resources.push({ ...outcome.resource, fileId: portableResourcePath(state.dir, outcome.resource.fileId) });
  virtualModules.set(outcome.moduleId, outcome.source);
  return { id: outcome.moduleId, moduleType: "esm" };
}

/**
 * The module text for a resource id, or `undefined` when the id is not one this pass inlined.
 *
 * `moduleType: "js"` is not decoration. Rolldown infers a module's type from its *file extension*
 * before the load hook runs, and 1.3.x removed CSS bundling outright — so a `.css` module whose
 * `load` returns JavaScript is still handed to the CSS pipeline and fails with `[UNSUPPORTED_FEATURE]
 * Bundling CSS is no longer supported`. The generated module is JavaScript, so it says so.
 */
export function resolveResourceModule(
  state: ResourceResolutionState,
  moduleId: string,
): { readonly code: string; readonly moduleType: "js"; readonly moduleSideEffects: "no-treeshake" } | undefined {
  for (const outcome of state.byModuleId.values()) {
    if (outcome.ok && outcome.moduleId === moduleId) {
      return { code: outcome.source, moduleType: "js", moduleSideEffects: "no-treeshake" };
    }
  }
  return undefined;
}

function throwResourceRefusal(refusals: readonly CellResourceRefusal[]): never {
  throw new CellResourcePolicyError(refusals);
}

/** A resource's report path: relative to the build root, with `/` separators. */
function portableResourcePath(dir: string, fileId: string): string {
  const relative = path.relative(dir, fileId);
  return (relative.length === 0 ? path.basename(fileId) : relative).split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Virtual module ids
// ---------------------------------------------------------------------------

/** The `\0` prefix a host-bridge interception is registered under. */
export const HOST_VIRTUAL_PREFIX = "\0cell-host:";

/** The `\0` prefix an extension-externals interception is registered under. */
export const EXTENSION_VIRTUAL_PREFIX = "\0cell-ext:";

// ---------------------------------------------------------------------------
// Specifier classification
// ---------------------------------------------------------------------------

/**
 * Whether a specifier names a package the mapping tables could know.
 *
 * Path-like specifiers are never consulted against the plans: a table row is a
 * package name, so the answer for `./App` is already decided by ordinary
 * resolution, and asking the plans would only collect findings about decisions
 * the specifier cannot have.
 */
function isBareSpecifier(source: string): boolean {
  if (source.startsWith("\0")) return false;
  if (source.startsWith(".") || source.startsWith("/")) return false;
  if (source.startsWith("data:") || source.startsWith("file:")) return false;
  return !path.isAbsolute(source);
}
