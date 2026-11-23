/**
 * The compiler boundary: a normal module entry in, a platform artifact out.
 *
 * Decision source: GitHub Issue #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6).
 *
 * Governing architecture Specs: #4, whose ownership boundary the decision audits
 * enforce, and #5, the verified ReactCellType target whose entry shapes this boundary
 * emits.
 *
 * #6 describes the boundary as "input is a normal module entry plus resolved
 * dependency decisions" and "output is a platform artifact, not a generic web
 * bundle", and then says the compiler should "use Vite+/Rolldown/tsdown
 * capabilities rather than inventing a separate module resolver". Those two
 * sentences together are why `CellBundlerPort` exists: the actual module
 * resolution and code generation are a bundler's job, and this package's job is
 * everything that makes the result a *Cell artifact* rather than a web bundle —
 * assembly, the entry wrapper, the metadata, the guarantees and the error model.
 *
 * So `compileCell` does not name a bundler, and this module contains no resolver.
 * It takes the bundler's report and decides whether it produced a legal artifact,
 * which is a different question from whether it produced a working bundle:
 *
 * - a bundler can succeed and leave an `import` behind, and only the decisions
 *   say whether that import should have been inlined or mapped to a host global;
 * - a bundler can succeed and emit a sibling chunk, which is a legitimate web
 *   bundle and an illegal Cell artifact;
 * - a bundler can succeed after inlining a package that implements a
 *   Forguncy-owned capability, which is a platform conflict no bundler can see.
 *
 * The real Forguncy confirmation of the result is deliberately *not* claimed
 * here. #7's validation plan performs it downstream, and AGENTS.md rule 7 forbids
 * reporting a local green build as runtime compatibility. See
 * `guarantees.ts` for which promises that leaves outstanding.
 *
 * Split by #162, under the shape-stabilisation Spec #152: assembly lives in
 * `artifact-assembly.ts` and the artifact audits in `artifact-audits.ts`.
 */

import type {
  CellEntryKind,
  DependencyDecision,
  FrontendLibraryReference,
  NormalizedExtensionMappings,
} from "@forguncy-react-workspace/core";

import { assembleCellArtifact, CELL_ARTIFACT_BANNER } from "./artifact-assembly.ts";
import { auditArtifactSource } from "./artifact-audits.ts";
import type { CellInlinedResource } from "./cell-resources.ts";
import { formatCellResourceLedger, isCellResourcePolicyError } from "./cell-resources.ts";
import type { CellArtifactDiagnostic } from "./diagnostics.ts";
import {
  createCellArtifactDiagnostic,
  dedupeCellArtifactDiagnostics,
  formatCellArtifactDiagnostics,
} from "./diagnostics.ts";
import { CELL_ENTRY_COMPONENT_BINDING } from "./entry.ts";
import {
  auditFrontendLibraries,
  collectFrontendLibraries,
  FRONTEND_LIBRARIES_FIELD_NAME,
  frontendLibraryIds,
} from "./frontend-libraries.ts";
import { auditWorkspaceSource, formatWorkspaceSourceAudit } from "./workspace-source-audit.ts";
import type {
  WorkspaceGraph,
  WorkspaceSourceAudit,
  WorkspaceSourceDiagnostic,
} from "./workspace-source.ts";

export { assembleCellArtifact, CELL_ARTIFACT_BANNER };

// ---------------------------------------------------------------------------
// The finalized public interfaces
// ---------------------------------------------------------------------------

/**
 * The compiler's output.
 *
 * `frontendLibraries` is the only metadata it carries, which is #6's decision
 * rather than an omission: everything else a consumer needs is either in the code
 * or already known to the platform. It is also the reason `mcp-sync` can take the
 * artifact without a translation step — there is nothing to translate.
 */
/**
 * The artifact a compile produced, with whatever per-package attribution the bundler reported.
 *
 * One constructor for both outcomes, so the compiled and rejected paths cannot hand back documents
 * that differ in anything but the diagnostics.
 */
function artifactOf(
  code: string,
  frontendLibraries: readonly FrontendLibraryReference[],
  module: BundledCellModule,
): CompileCellResult {
  return {
    code,
    frontendLibraries,
    ...(module.inlinedPackageSizes === undefined ? {} : { inlinedPackageSizes: module.inlinedPackageSizes }),
    ...(module.resources === undefined ? {} : { inlinedResources: module.resources }),
  };
}

export interface CompileCellResult {
  /** The single logical Cell artifact: one script, no runtime chunk loading. */
  readonly code: string;
  /** The frontend libraries ReactCellType must resolve before this cell's entry runs. */
  readonly frontendLibraries: readonly FrontendLibraryReference[];
  /**
   * What each flattened package contributed to `code`, in rendered characters.
   *
   * Carried on the artifact because it is a fact *about* the artifact and nothing else can recover
   * it: the composed string is flat, so which package accounts for which characters is only known
   * while the module graph is. A size verdict needs it to say *why* the Cell is over its cap rather
   * than only that it is, and recomputing it by recompiling without a package does not work — the
   * bundler resolves the bare import from `node_modules` regardless of the decision set.
   *
   * Absent when the bundler reported no modules (a fixture port), which is not an error: a caller
   * that needs attribution then has none, and says so rather than guessing.
   */
  readonly inlinedPackageSizes?: readonly InlinedPackageSize[];
  /**
   * The stylesheets and static assets inlined into `code`, with their byte and character cost
   * (#98).
   *
   * The character budget is one number, so a Cell that is 400 KiB of base64 needs this ledger to
   * say so rather than forcing a reader to decode the artifact. Reported separately from
   * `inlinedPackageSizes` because they answer different questions — package attribution is about
   * *whose* code it is, and this is about *inlined payload* — and merging them would make a
   * package named after an asset looking like a dependency decision nobody made.
   */
  readonly inlinedResources?: readonly CellInlinedResource[];
}

/**
 * What a bundler hands back.
 *
 * Deliberately a *report* as much as a payload. A bundle is opaque once it is a
 * string, so the three facts that decide whether it is a legal Cell artifact
 * cannot be recovered from `code` afterwards without re-parsing it — and #6's
 * acceptance criteria explicitly require the artifact to be passable to
 * `mcp-sync` "without additional semantic transformation".
 *
 * One obligation is not written in this type because it cannot be: `code` must
 * bind the entry's component to `CELL_ENTRY_COMPONENT_BINDING`. That is what
 * `CellBundlingRequest.componentBinding` is for, and the two are the same value by
 * construction.
 */
/**
 * One flattened package's rendered share of the artifact's characters.
 *
 * `exactSpecifier` is set when the modules were reached under a subpath (`pkg/subpath`), null when
 * they are the package root's own files. The split exists because the compiler preserves
 * exact-subpath precedence: `findDependencyDecision` checks the exact specifier before the package
 * root, so crediting a subpath's bytes to the root decision would attribute them to a decision that
 * did not govern them. A consumer deciding which record owns a share must prefer the exact entry.
 */
export interface InlinedPackageSize {
  readonly packageName: string;
  readonly exactSpecifier: string | null;
  readonly renderedCharacters: number;
}

export interface BundledCellModule {
  /** The artifact body: one script, no runtime chunk loading. */
  readonly code: string;
  /** Specifiers the bundler left external rather than flattening. Every one is a violation. */
  readonly externalImports?: readonly string[];
  /** Packages the bundler flattened into `code`. */
  readonly inlinedPackages?: readonly string[];
  /**
   * Rendered characters each flattened package contributed, as the bundler accounted them.
   *
   * The attribution basis for a size verdict: `auditCodeBudget` measures the whole composed Cell,
   * which shows the Cell is over its cap but not *which* package put it there. Grouping the
   * module-level `renderedLength` answers that from one compile, and is the only sound way to — a
   * "compile it again without this package and subtract" differential measures nothing, because
   * dropping a decision does not remove the code the bundler resolves from `node_modules`.
   */
  readonly inlinedPackageSizes?: readonly InlinedPackageSize[];
  /**
   * Bare specifiers the bundler actually inlined from installed packages.
   *
   * Package names fold `sneaky-dep` and `sneaky-dep/subpath` into one entry,
   * which destroys the exact-subpath precedence `findDependencyDecision` relies
   * on. Specifier-level provenance lets each decision lookup use the real bare
   * specifier. Optional because fixture bundlers only report package names.
   */
  readonly inlinedSpecifiers?: readonly string[];
  /** Files the bundler emitted next to `code`. Any entry breaks the single-artifact contract. */
  readonly emittedAssets?: readonly string[];
  /**
   * The stylesheets and static assets the bundler inlined into `code` (#98).
   *
   * A report, not an input: the artifact is one flat string, so which assets it carries and how
   * many characters each cost cannot be recovered from `code` afterwards. The ledger is what lets
   * a caller answer "how much of this Cell is inlined assets" without re-parsing base64.
   *
   * Absent for a fixture port, which inlines nothing — the same convention as every other
   * optional report field here.
   */
  readonly resources?: readonly CellInlinedResource[];
  /**
   * The bare specifiers this build's interception resolver saw, sorted.
   *
   * The build-side half of the agreement the pre-bundle pass rests on: `resolveEntrySpecifiers` and
   * `bundle` run the *same* resolver, and the preflight's whole claim is that the specifiers it
   * audits are the specifiers the build resolves. That claim cannot be checked from the artifact —
   * an intercepted specifier leaves no trace in `code` — so the build reports its set and
   * `preflight.test.ts` compares the two. It is a superset of the entry file's own imports, and
   * deliberately so: the resolver records every bare specifier any module in the graph asked for.
   *
   * **Not an input to #14's workspace audit.** That audit's `entryModuleIds` are the preflight's
   * return value (`compileCell` hands them over), which is what makes the audit a pre-bundle check
   * rather than a description of what was already built; an earlier revision of this comment said
   * the audit traced from this field, which was never true (#157 corrected it).
   *
   * Optional because a fixture bundler has no module graph to report, and a comparison against a
   * fixture is then not made rather than made against an empty set — #14's rule that an absent
   * input is not an empty one.
   */
  readonly referencedSpecifiers?: readonly string[];
  /**
   * Findings in #6's vocabulary that only the build could observe.
   *
   * Optional because the report fields above cover most artifact violations on
   * their own, and a fixture port has nothing to add. The real port uses it for
   * the conditions no output field can express — a decision that contradicts a
   * mapping table, an artifact reading an extension module no decision declares
   * — reported here rather than smuggled in from the plans' own vocabularies,
   * which are about mappings rather than artifacts and stay separate (#7's
   * bundler documents which plan codes translate and which do not).
   */
  readonly diagnostics?: readonly CellArtifactDiagnostic[];
  /**
   * Whether this module graph imports the runtime façade, so a binding was generated.
   *
   * The entry wrapper has to refresh the artifact-scope props variable on every `App` call
   * (#83), and it may only do that when the binding — which declares the variable — is in
   * the graph. Reporting it from the build is the only honest source: inferring it from
   * `code` would be a substring check, and assuming it would put a free identifier in an
   * artifact that has no declaration for it, which is a `ReferenceError` at the first
   * render. Optional and absent means "no binding", so a fixture port that reports nothing
   * gets the wrapper a façade-free Cell should have.
   */
  readonly runtimeBindingGenerated?: boolean;
}

export interface CellBundlingRequest {
  readonly entry: string;
  readonly dependencies: readonly DependencyDecision[];
  /**
   * The project's normalized extension mapping set (#85), when the project has one.
   *
   * Carried in the request for the same reason `dependencies` is: the resolver hook
   * that answers a bare import is a *resolution decision*, and the two passes this
   * compile runs must see the same table. The normalized result is passed through as
   * it was loaded — no stage re-reads `EXTENSION_EXTERNAL_MAPPINGS` or re-merges project
   * rows, so "which extension provides this import" has one answer per compile.
   *
   * Absent means "the caller did not state the project's set", which is the same state
   * as a project whose config said nothing: the built-in table applies (`#85`'s
   * `builtin-default`). It never means "fall back to inlining": an import the selected
   * table intercepts is either answered by the extension global or reported, and an
   * import it does not intercept is left to ordinary resolution, where the artifact
   * audits decide whether that is legal.
   */
  readonly extensionMappings?: NormalizedExtensionMappings;
  /**
   * The identifier the bundle must bind the entry's component to, so the generated
   * wrapper can reference it.
   *
   * Carried in the request rather than left implicit on purpose. The wrapper and
   * the bundle are produced by different halves of the pipeline, and the one thing
   * that must agree between them is this name; a bundler that has to go and read a
   * constant to discover it is one refactor away from disagreeing. For an IIFE
   * output this is the `output.name` — literally "bind the entry to this
   * identifier".
   */
  readonly componentBinding: string;
  /**
   * The largest static asset the bundler may inline, in bytes (#98).
   *
   * On the request rather than on the bundler instance because it is a property of *this compile*
   * — a probe run may measure a different threshold than the deployment build — while the
   * bundler instance is shared by every Cell of one project.
   *
   * Absent means the v1 default (`CELL_ASSET_INLINE_LIMIT_BYTES`), which is also Vite's default
   * `assetsInlineLimit`. Never silently unbounded: an oversized asset is a refusal, not an
   * emitted sibling file.
   */
  readonly assetInlineLimitBytes?: number;
}

/**
 * The bare specifiers the entry's module graph contains, without generating code.
 *
 * A separate call from {@link CellBundlerPort.bundle} because of *when* it is needed
 * rather than what it computes: #14 requires a reachable workspace cycle to fail
 * "before bundling rather than to be resolved by whichever traversal happens to run
 * first", and the cycle is only visible once the entry's imports are known. Asking
 * the bundler for the graph first is what lets that refusal happen before any code
 * is generated — a bundler that could only answer after building would make the
 * ordering requirement unsatisfiable, not merely slower.
 *
 * `dependencies` is carried, and that is not a convenience: interception *is* a
 * resolution decision. A `host`- or `extension`-decided package resolves to the
 * plan's virtual module instead of to `node_modules`, which both keeps the local
 * source from being traversed and keeps an uninstalled host package from failing
 * resolution. A pass without the decisions would report a different specifier set
 * than the build — the exact disagreement this preflight exists to avoid.
 *
 * `componentBinding` is the one field genuinely absent, because nothing is bound:
 * binding is what `bundle` does.
 */
export interface CellResolveRequest {
  readonly entry: string;
  readonly dependencies: readonly DependencyDecision[];
  /**
   * The same normalized mapping set the later build receives.
   *
   * The preflight's whole claim is that the specifiers it audits are the specifiers the
   * build resolves, and an `extension`-decided import resolves to the plan's virtual
   * module only when the *same* table produced the plan. A preflight that consulted the
   * built-in table while the build consulted the project's would resolve two different
   * graphs — and the disagreement would only be visible as a compile that passed the
   * preflight and failed the build, or vice versa.
   */
  readonly extensionMappings?: NormalizedExtensionMappings;
  /**
   * The inline limit this compile's static assets are measured against (#98).
   *
   * Carried on the resolve request as well as the bundling request because the preflight has to
   * refuse an oversized asset *before* bundling: it is the same option, read by both passes, so
   * the two cannot disagree about which assets are legal.
   */
  readonly assetInlineLimitBytes?: number;
}

/**
 * The module-resolution and code-generation half of the pipeline.
 *
 * A port rather than a concrete dependency because #6 mandates Vite+/Rolldown
 * while forbidding this package from becoming a second resolver. #7 supplies the
 * implementation; the contract tests supply a fixture, which is what makes the
 * boundary testable before the bundler exists.
 */
export interface CellBundlerPort {
  readonly bundle: (request: CellBundlingRequest) => Promise<BundledCellModule>;
  /**
   * The entry's bare specifiers, resolved but not built. **Optional.**
   *
   * It exists for one caller: a compile that was given a workspace graph, where
   * #14's two fatal findings have to be observable *before* anything is built — see
   * {@link compileCell}. Without a graph there is no workspace audit to run, so a
   * port that only implements `bundle` is complete for every #6 caller, and
   * requiring the method would have changed that public boundary for no runtime
   * benefit.
   *
   * Optional is not a licence to fall back silently. When a graph *is* supplied and
   * this method is absent, {@link compileCell} refuses the compile with
   * `bundler-failure` rather than auditing after the build: the pre-bundle guarantee
   * is mandatory exactly when a workspace graph makes it meaningful, and a quiet
   * fallback would reintroduce the defect the split exists to prevent.
   */
  readonly resolveEntrySpecifiers?: (request: CellResolveRequest) => Promise<readonly string[]>;
}

/**
 * The compiler's input, exactly as #6 pins it: "a normal module entry plus
 * resolved dependency decisions".
 *
 * Deliberately not widened. Every extra field the compiler needs in order to
 * *run* — the bundler, the entry shape, the metric budget — lives in
 * {@link CompileCellOptions} instead, so this interface keeps meaning what the
 * Spec says it means and adding a knob cannot quietly change the boundary.
 */
export interface CompileCellInput {
  /** A normal module entry. Ordinary React/TypeScript; the artifact is the compiler's problem. */
  readonly entry: string;
  /** One resolved decision per non-source dependency. */
  readonly dependencies: readonly DependencyDecision[];
}

export interface CompileCellOptions {
  /**
   * The module-resolution and code-generation half of the pipeline.
   *
   * Required, not optional: without it there is nothing to compile, and making it
   * optional would leave the caller to discover at run time that compilation
   * cannot happen.
   */
  readonly bundler: CellBundlerPort;
  /** Which #5 entry shape to expose. Defaults to a function `App` binding. */
  readonly entryKind?: CellEntryKind;
  /**
   * The caller's cell code budget, in characters, measured on the composed
   * artifact. No default is applied: #5 found no hard platform limit, so the
   * compiler refusing a size on its own authority would be inventing policy that
   * belongs to the budget Issue.
   */
  readonly codeBudgetCharacters?: number;
  /**
   * The project's extension mapping set, exactly as `registry.extensionMappings`
   * normalized it (#85).
   *
   * This is the only channel by which a project's own rows reach the compile. Take it
   * from the registry — or from {@link CellCompilePlan.extensionMappings}, which is the
   * same object — rather than assembling a list here: #85's normalization is what ran
   * the per-row and cross-row guards against the built-in table, and a re-merged list
   * would be a second answer to "which extensions does this project declare".
   *
   * The set is forwarded to both the pre-bundle pass and the build (see
   * {@link CellResolveRequest} and {@link CellBundlingRequest}) so the two consult one
   * table. The compiler's own audits are unchanged by it: `frontendLibraries` is still
   * derived from the *decisions*, and a decision that disagrees with the row it selects
   * is rejected from the plan's own finding rather than from a second check here.
   *
   * Absent keeps the pre-#85 behaviour — the built-in table — which is the same state a
   * project config that never mentions `extensions` normalizes to.
   */
  readonly extensionMappings?: NormalizedExtensionMappings;
  /**
   * The workspace graph this compile resolves against, when the project has one.
   *
   * Take it from {@link loadPnpmWorkspaceGraph} — `(await loadPnpmWorkspaceGraph({ root })).graph` —
   * which reads it from the project's own `pnpm-workspace.yaml` and member manifests.
   * The parameter's whole point is that the compiler is handed the *real* Vite+/pnpm
   * graph rather than a hand-written one, which is the criterion #14 moved to #15.
   *
   * Pass the **raw graph**, not the loader's index: the audit indexes it itself, so
   * a graph whose own coherence is broken (a duplicated name, a machine-specific
   * directory) reports that finding as part of the same result instead of having it
   * silently dropped. The loader returns both together for exactly this reason.
   *
   * Absent means "the caller did not state a graph", and the workspace audit then
   * abstains exactly as #14 requires — no claim is made about workspace packages,
   * which is the #6 behaviour rather than a claim that none are involved. Passing
   * the graph does **not** change how modules resolve: the bundler still resolves
   * through `node_modules`, and this option adds an *audit* of the result, never a
   * second resolver (#6 forbids one).
   */
  readonly workspace?: WorkspaceGraph;
  /**
   * The largest static asset one Cell may inline, in bytes (#98).
   *
   * Forwarded to the bundler's own request, so the preflight and the build measure the same
   * assets against the same threshold. Absent means the v1 default.
   */
  readonly assetInlineLimitBytes?: number;
}

/**
 * Compilation either produced an artifact or did not.
 *
 * Not `CompileCellResult | diagnostics`: a caller that has to test whether
 * `code` is present will eventually forget, and the failure mode of forgetting is
 * writing an empty cell.
 *
 * `workspace` is present only when the caller supplied a graph *and* the audit ran
 * to completion. It is a separate field rather than more `CellArtifactDiagnostic`s
 * because #14's vocabulary is a different one and the two must not be collapsed:
 * `workspace-source.ts` states that wiring the audit into artifact assembly would
 * "decide by accident" how the two vocabularies compose, and the answer chosen here
 * is that they do not — an artifact diagnostic says the *artifact* breaks a #6
 * guarantee, while a workspace diagnostic says something about the *project's*
 * declarations. A caller reading one report sees both without one being restated in
 * the other's terms.
 */
export type CompileCellOutcome =
  | {
      readonly status: "compiled";
      readonly artifact: CompileCellResult;
      readonly entryKind: CellEntryKind;
      /** #14's audit of the graph this compile was given, when one was given. */
      readonly workspace?: WorkspaceSourceAudit;
    }
  | {
      readonly status: "rejected";
      readonly diagnostics: readonly CellArtifactDiagnostic[];
      /**
       * The composed artifact the rejection is about, when one was composed.
       *
       * A rejection means "this artifact does not qualify", so for the artifact audits the document
       * exists — and a caller recording the verdict needs *it* rather than a re-derivation, since
       * an identity over the bytes is only meaningful if it is an identity over these bytes. Absent
       * on the paths #14 requires to fail **before** bundling (a workspace cycle), where no
       * artifact was composed and there is nothing to hand back.
       *
       * Not a change to what a rejection *is*: the diagnostics remain the finding, and this is the
       * evidence under it.
       */
      readonly artifact?: CompileCellResult;
      /**
       * The workspace audit that caused the rejection, when one did.
       *
       * Set on the paths #14 requires to fail *before* bundling. Present so a caller
       * does not have to re-run the audit to read the finding that stopped the
       * build; absent when the rejection came from the artifact audits, which keep
       * using the artifact vocabulary alone.
       */
      readonly workspace?: WorkspaceSourceAudit;
    };

// ---------------------------------------------------------------------------
// Verification and serialization
// ---------------------------------------------------------------------------

/**
 * Re-checks an artifact that was assembled somewhere else, or read back out.
 *
 * This is the weaker half of the contract and it is important not to oversell it:
 * `CompileCellResult` carries no entry metadata, so nothing here can confirm which
 * entry shape the code exposes. What it can confirm is that the artifact is
 * canonical and carries no refused construct — the two properties a diff and a
 * reviewer depend on.
 */
export function verifyCellArtifact(artifact: CompileCellResult): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];

  if (!artifact.code.startsWith(CELL_ARTIFACT_BANNER)) {
    diagnostics.push(
      createCellArtifactDiagnostic("non-canonical-artifact-metadata", "code", {
        detail:
          "The artifact does not begin with the generated-artifact banner, so it was edited after generation or produced by something other than this compiler.",
      }),
    );
  }

  diagnostics.push(...auditFrontendLibraries(artifact.frontendLibraries));

  // Nothing here can say which part of the artifact a construct came from: the
  // result carries no provenance. The wording is one sentence rather than two
  // because the honest answer for this caller is "the artifact".
  diagnostics.push(...auditArtifactSource(artifact.code, () => "the artifact"));

  return dedupeCellArtifactDiagnostics(diagnostics);
}

/**
 * The canonical serialization of a result.
 *
 * Exists so "deterministic" is a property a test can assert rather than a word in
 * a guarantee. Key order is written out instead of relied upon, and the trailing
 * newline makes the string a well-formed file.
 */
export function serializeCompileCellResult(artifact: CompileCellResult): string {
  const canonical = {
    code: artifact.code,
    [FRONTEND_LIBRARIES_FIELD_NAME]: artifact.frontendLibraries.map(library => ({
      libraryId: library.libraryId,
    })),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

/**
 * A report block for a CI log or a PR body, including which promises remain unproven.
 *
 * ## Why the workspace audit is printed here
 *
 * A workspace rejection carries `diagnostics: []` **by design** — #14's vocabulary is
 * not #6's, so a cycle or an intercepting decision is reported through `workspace`
 * rather than restated as a `CellArtifactDiagnostic`. That decision is only useful if
 * the finding reaches a reader, and this function is the package's standard reporting
 * path. Formatting `outcome.diagnostics` alone printed
 * `Compilation rejected with 0 diagnostic(s):` — the structured diagnostic existed in
 * memory and reached nobody, which would have undermined the very path this seam
 * adds.
 *
 * So whenever a workspace audit is present it is printed in full, on both outcomes.
 * On a *compiled* outcome that is the point rather than a bonus: the non-fatal
 * findings (`workspace-package-in-frontend-libraries`, a transitive dependency with
 * no decision) are exactly the ones a reader has to act on, and an artifact that
 * compiles is where they are easiest to miss.
 *
 * A `WorkspaceSourceAudit` with nothing wrong still prints its summary lines, which is
 * `formatWorkspaceSourceAudit`'s own contract — "no diagnostics" must not be readable
 * as "the declared sharing was verified".
 */
export function formatCompileCellOutcome(outcome: CompileCellOutcome): string {
  const workspace = outcome.workspace === undefined ? [] : ["", formatWorkspaceSourceAudit(outcome.workspace)];

  if (outcome.status === "compiled") {
    const ids = frontendLibraryIds(outcome.artifact.frontendLibraries);
    const resources = outcome.artifact.inlinedResources ?? [];
    return [
      `Compiled Cell artifact: ${outcome.artifact.code.length} characters, entry shape "${outcome.entryKind}".`,
      `${FRONTEND_LIBRARIES_FIELD_NAME}: ${ids.join(", ") || "(none)"}`,
      // Printed on every compiled artifact, not only on a resource-carrying one: a reader asking
      // "how much of this Cell is inlined assets" has to be able to see the answer is none.
      formatCellResourceLedger(resources),
      "Real Forguncy runtime validation is not established by a local compile.",
      ...workspace,
    ].join("\n");
  }

  // The counts are reported per vocabulary rather than summed, because they are not
  // the same kind of finding and a caller branching on either needs to see which one
  // stopped the build. #6's diagnostics are empty on a pre-bundle rejection by design.
  const artifactDiagnostics = `Compilation rejected with ${outcome.diagnostics.length} diagnostic(s):\n${formatCellArtifactDiagnostics(outcome.diagnostics)}`;
  return [artifactDiagnostics, ...workspace].join("\n");
}

// ---------------------------------------------------------------------------
// The boundary function
// ---------------------------------------------------------------------------

function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The request fields both bundler passes carry, built once.
 *
 * The pre-bundle pass and the build must be handed the same entry, decisions, extension
 * mapping set and asset inline limit. Spelling that spread twice is how the two passes
 * would eventually disagree, and a disagreement is exactly what the preflight exists to
 * rule out. `componentBinding` is added by `bundle` alone, because only the build binds a
 * component.
 */
function bundlingRequest(input: CompileCellInput, options: CompileCellOptions): CellResolveRequest {
  return {
    entry: input.entry,
    dependencies: input.dependencies,
    ...(options.extensionMappings === undefined ? {} : { extensionMappings: options.extensionMappings }),
    ...(options.assetInlineLimitBytes === undefined
      ? {}
      : { assetInlineLimitBytes: options.assetInlineLimitBytes }),
  };
}

/**
 * The public entry point.
 *
 * Bundler failure is converted into a diagnostic rather than rethrown: #6's error
 * model exists so a caller never has to interpret an opaque build string, and an
 * escaping exception is exactly that string.
 *
 * ## The workspace seam (#14 / #15)
 *
 * When the caller supplies `options.workspace`, `#14`'s audit runs over this compile
 * and its result rides on the outcome as `workspace`. The seam has three parts, and
 * the *order* is the part that matters.
 *
 * **1. A pre-bundle pass establishes what the cell imports.** The entry's specifiers
 * are resolved but not built (`CellBundlerPort.resolveEntrySpecifiers`), and the
 * audit's user-facing checks run against them. This happens *first* because two of
 * the findings below have to stop the compile before any code is generated.
 *
 * **2. Two findings are fatal, and both are fatal before bundling.**
 *
 * - *A reachable workspace cycle.* #14 requires it to fail "before bundling rather
 *   than to be resolved by whichever traversal happens to run first". The bundler
 *   will happily inline a cyclic graph — ESM permits cycles — so the output looks
 *   fine and the ordering it picked is invisible in the result. Nothing downstream
 *   can catch it, and a bundler failure racing it could hide the structured
 *   diagnostic entirely.
 * - *A dependency decision that can intercept workspace source.* This one is
 *   subtle enough to spell out. The bundler consults the host-bridge and
 *   extension-externals plans *during resolution*, so a decision naming a module id
 *   that a mapping also claims lets `interceptionFor` replace the import with a
 *   virtual runtime module **before** Rolldown ever resolves the local source. The
 *   artifact then contains no workspace import and no inlined workspace package, so
 *   every artifact-side audit passes — while the local package the cell actually
 *   imported was silently discarded. A local package named `antd` beside a `host`
 *   decision for `antd` is the working example. #14's output semantics are exactly
 *   what that violates, and only a check made *before* resolution can see it.
 *
 * **3. Everything else is reported, not fatal.** The remaining workspace findings
 * that mean "this artifact has a runtime dependency on another workspace package"
 * are already fatal from the output side: a workspace import the bundler left
 * external reaches `auditExternalImports` as an unresolved decision, and a workspace
 * package named in `frontendLibraries` trips that audit directly. Reporting those
 * twice as two rejections would state one condition in two vocabularies, which is
 * what `workspace-source.ts` records as the thing to avoid.
 *
 * **The audit still never resolves anything.** The graph is an *input to an audit*,
 * not a second resolver: modules resolve through the bundler and `node_modules`, and
 * removing the option changes no artifact byte. #6 forbids a second module resolver,
 * and a graph that quietly redirected resolution would be exactly that.
 */
export async function compileCell(
  input: CompileCellInput,
  options: CompileCellOptions,
): Promise<CompileCellOutcome> {
  // The pre-bundle pass runs **only** when a graph was supplied, because it exists
  // for one purpose: making #14's two fatal findings observable before anything is
  // built. With no graph there is no workspace audit to run and nothing for the
  // preflight to decide — so a graph-less #6 compile takes exactly the path it took
  // before this seam existed: one `bundle()` and no analysis pass.
  let entrySpecifiers: readonly string[] | undefined;
  if (options.workspace !== undefined) {
    const resolveEntrySpecifiers = options.bundler.resolveEntrySpecifiers;
    // A graph was supplied, so the pre-bundle guarantee is mandatory — and a port
    // without the capability is refused rather than quietly audited after the build.
    // That is the bound on the method being optional: optional preserves the
    // graph-less boundary, and this makes the guarantee binding exactly when a
    // workspace graph makes it meaningful. Falling back here would restore the defect
    // the split exists to prevent — a cycle discovered only after Rolldown bundled.
    if (resolveEntrySpecifiers === undefined) {
      return {
        status: "rejected",
        diagnostics: [
          createCellArtifactDiagnostic("bundler-failure", input.entry, {
            detail:
              "A workspace graph was supplied, so the entry's specifiers must be resolved before bundling — but this bundler port implements no `resolveEntrySpecifiers`. #14 requires a reachable workspace cycle to fail before bundling, which cannot be decided without it. Use a port that provides the method, or omit `workspace`.",
          }),
        ],
      };
    }

    try {
      entrySpecifiers = await resolveEntrySpecifiers(bundlingRequest(input, options));
    } catch (error) {
      // A resource refusal is a finding about the Cell's *source*, not a bundler fault, so it
      // keeps its own code and its remediation. Reducing it to `bundler-failure` would tell the
      // caller to fix the bundler when the fix is in the stylesheet.
      if (isCellResourcePolicyError(error)) {
        return { status: "rejected", diagnostics: error.diagnostics };
      }
      return {
        status: "rejected",
        diagnostics: [
          createCellArtifactDiagnostic("bundler-failure", input.entry, {
            detail: `The bundler could not resolve the entry: ${describeThrown(error)}`,
          }),
        ],
      };
    }

    const preflight = auditWorkspaceSource({
      workspace: options.workspace,
      dependencies: input.dependencies,
      entryModuleIds: entrySpecifiers,
      frontendLibraries: collectFrontendLibraries(input.dependencies).libraries,
    });

    if (preflight.diagnostics.some(isPreBundleFatalWorkspaceDiagnostic)) {
      return {
        status: "rejected",
        // Empty on purpose: #14's vocabulary is not #6's, so a workspace finding is
        // reported through `workspace` rather than restated as a
        // `CellArtifactDiagnostic` whose `breaksGuarantees` would have to name a #6
        // guarantee it is not about. Nothing was built, so there is nothing for the
        // artifact vocabulary to describe either.
        diagnostics: [],
        // The whole audit, not only the fatal findings: a caller reading a rejection
        // should see everything wrong with the graph, not just the one thing that
        // stopped it. This is the audit the post-build step would have produced, minus
        // the two inputs only the output can supply.
        workspace: preflight,
      };
    }
  }

  let module: BundledCellModule;
  try {
    module = await options.bundler.bundle({
      ...bundlingRequest(input, options),
      // The one thing the two halves of the pipeline must agree on, handed over
      // rather than assumed.
      componentBinding: CELL_ENTRY_COMPONENT_BINDING,
    });
  } catch (error) {
    if (isCellResourcePolicyError(error)) {
      return { status: "rejected", diagnostics: error.diagnostics };
    }
    return {
      status: "rejected",
      diagnostics: [
        createCellArtifactDiagnostic("bundler-failure", input.entry, {
          detail: `The bundler reported: ${describeThrown(error)}`,
        }),
      ],
    };
  }

  // The post-build audit, over the same graph, now with what the build actually
  // produced. It re-runs the preflight checks (they cannot newly fail) and adds the
  // two that need the output: what the bundler left external, and the metadata that
  // will be written.
  //
  // `entrySpecifiers` is defined whenever `options.workspace` is — the pre-bundle
  // block above sets both together — so the pair is read from one narrowing rather
  // than two independent `undefined` checks that could drift apart.
  const workspace =
    options.workspace === undefined || entrySpecifiers === undefined
      ? undefined
      : auditWorkspaceForCompile(input, options.workspace, module, entrySpecifiers);

  const outcome = assembleCellArtifact({
    module,
    dependencies: input.dependencies,
    ...(options.entryKind === undefined ? {} : { entryKind: options.entryKind }),
    ...(options.codeBudgetCharacters === undefined
      ? {}
      : { codeBudgetCharacters: options.codeBudgetCharacters }),
  });

  return workspace === undefined ? outcome : { ...outcome, workspace };
}

/**
 * The workspace findings that stop a compile *before* any code is generated.
 *
 * Two codes, and each is here because nothing downstream can catch it — see
 * `compileCell`'s header for the full argument. `circular-workspace-dependency` is
 * #14's own "fail before bundling" requirement; a decision that can intercept
 * workspace source is invisible the moment resolution replaces the import, so the
 * artifact audits that would otherwise be the safety net cannot see it at all.
 *
 * A named predicate rather than an inline list so a future fatal code has one place
 * to be added, and so the *reason* each is fatal is documented where it is enforced.
 */
function isPreBundleFatalWorkspaceDiagnostic(diagnostic: WorkspaceSourceDiagnostic): boolean {
  return (
    diagnostic.code === "circular-workspace-dependency" ||
    diagnostic.code === "workspace-package-decided-as-dependency"
  );
}

/**
 * `#14`'s audit, with this compile's inputs.
 *
 * Every input is taken from something the build already established rather than
 * asked of the caller a second time:
 *
 * - the graph is the caller's `options.workspace`, read from the project's own
 *   manifest by `loadPnpmWorkspaceGraph`;
 * - the entry's module ids are the bundler's, from the pre-bundle pass;
 * - the external imports are the bundler's own report, so the audit sees what
 *   actually survived rather than what was authored;
 * - `frontendLibraries` is derived from the decisions by the same function assembly
 *   uses, so the metadata the audit checks and the metadata the artifact carries are
 *   one computation.
 *
 * The graph is handed over *raw* rather than pre-indexed, which is deliberate: the
 * audit indexes it itself, so a graph whose own coherence is broken (a duplicated
 * name, a machine-specific directory) reports that as part of this same result.
 * Passing an already-indexed graph would silently drop exactly those findings.
 */
function auditWorkspaceForCompile(
  input: CompileCellInput,
  workspace: WorkspaceGraph,
  module: BundledCellModule,
  entrySpecifiers: readonly string[],
): WorkspaceSourceAudit {
  return auditWorkspaceSource({
    workspace,
    dependencies: input.dependencies,
    externalImports: module.externalImports ?? [],
    frontendLibraries: collectFrontendLibraries(input.dependencies).libraries,
    entryModuleIds: entrySpecifiers,
  });
}
