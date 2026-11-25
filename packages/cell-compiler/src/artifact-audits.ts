/**
 * The audits the artifact boundary runs over a bundler report and a composed Cell.
 *
 * Decision source: GitHub Issue #6 — "Spec: generated ReactCellType artifact and
 * compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6). These checks decide
 * whether a bundle is a legal Cell artifact; assembly and the `compileCell` orchestration
 * that apply them stay in `artifact-assembly.ts` and `artifact.ts`.
 *
 * Split out of `artifact.ts` by #162, under the shape-stabilisation Spec #152.
 */

import {
  CELL_CODE_BUDGET_MEASUREMENT,
  CELL_USER_SCOPE_BINDINGS,
  assertCellCodeBudget,
  classifyCellCodeSize,
  validateDependencyDecisionShape,
} from "@forguncy-react-workspace/core";
import type { CellUserScopeBinding, DependencyDecision } from "@forguncy-react-workspace/core";

import { CELL_ARTIFACT_BANNER } from "./artifact-assembly.ts";
import type { CellInlinedResource } from "./cell-resources.ts";
import type { CellArtifactDiagnostic } from "./diagnostics.ts";
import { createCellArtifactDiagnostic } from "./diagnostics.ts";
import { findDependencyDecision, isSourceSpecifier, packageNameOfSpecifier } from "./specifier.ts";
import { auditCellSource } from "./source-guard.ts";

// The specifier primitives (`specifier.ts`) and the resource ledger (`cell-resources.ts`) are
// imported here and *not* re-exported (#157). They used to be forwarded "so a caller that imported
// them from here keeps working", and no such caller exists: the barrel names them from their own
// modules, and every consumer inside this package imports the defining module. A second door into
// the same four functions is one more name to keep in step, for nobody.

/**
 * The bindings a `host` dependency may be mapped onto.
 *
 * `injected-parameter` are the `new Function` arguments the runtime passes, and
 * `page-global` are page-level names such as `ReactDOM` the runtime itself uses.
 * `wrapper-local` and `extension-global` are deliberately absent: the first is
 * created inside the cell's own generated closure, the second belongs to the
 * `extension` strategy and reaching it as `host` would skip both the
 * `libraryId` reference and the readiness guarantee.
 */
const HOST_IDENTITY_KINDS: readonly CellUserScopeBinding["kind"][] = ["injected-parameter", "page-global"];

function subjectOf(decision: DependencyDecision): string {
  return decision.packageName.trim().length > 0 ? decision.packageName : "<unnamed package>";
}

// ---------------------------------------------------------------------------
// Decision audit
// ---------------------------------------------------------------------------

/**
 * Audits the decision list itself.
 *
 * The shape checks come from `core` rather than being reimplemented: a decision
 * record that is internally inconsistent is #4's problem, and the compiler's only
 * job is to translate that verdict into a code the artifact-level report can
 * branch on. The translation is per strategy because the fix differs — an
 * extension with no global is a mapping problem, a host with no global is a
 * mapping problem of a different kind, and a replacement with no recorded
 * rejection is an unresolved decision.
 */
export function auditDependencyDecisions(dependencies: readonly DependencyDecision[]): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];
  const byPackage = new Map<string, DependencyDecision[]>();

  for (const decision of dependencies) {
    const name = decision.packageName;
    const existing = byPackage.get(name);
    if (existing === undefined) byPackage.set(name, [decision]);
    else existing.push(decision);
  }

  for (const [packageName, decisions] of byPackage) {
    if (decisions.length > 1 && packageName.trim().length > 0) {
      diagnostics.push(
        createCellArtifactDiagnostic("unresolved-dependency-decision", packageName, {
          detail: `${decisions.length} decisions target this package (${decisions.map(item => item.strategy).join(", ")}), so there is no single strategy to compile against.`,
        }),
      );
    }
  }

  for (const decision of dependencies) {
    const subject = subjectOf(decision);

    for (const problem of validateDependencyDecisionShape(decision)) {
      diagnostics.push(
        createCellArtifactDiagnostic(diagnosticCodeForStrategy(decision.strategy), subject, { detail: problem }),
      );
    }

    if (decision.strategy === "host") {
      const binding = CELL_USER_SCOPE_BINDINGS.find(candidate => candidate.name === decision.globalName);
      if (binding === undefined) {
        diagnostics.push(
          createCellArtifactDiagnostic("duplicate-host-mapping", subject, {
            detail: `The global "${decision.globalName}" is not one of the names the runtime contract verified as visible inside a cell, so the artifact would reference a global that may never exist.`,
          }),
        );
      } else if (!HOST_IDENTITY_KINDS.includes(binding.kind)) {
        // Being a verified *name* is not the same as being a runtime *identity*.
        // `props`, `useState` and `render` are wrapper-locals the generated
        // function creates per render, so mapping a dependency onto one would
        // replace a module with something that does not exist outside this cell's
        // own closure.
        diagnostics.push(
          createCellArtifactDiagnostic("duplicate-host-mapping", subject, {
            detail: `The global "${decision.globalName}" is verified inside a cell, but it is a "${binding.kind}" rather than a host runtime identity a dependency can be mapped onto.`,
          }),
        );
      }
    }
  }

  diagnostics.push(...auditHostGlobalClaims(dependencies));
  return diagnostics;
}

function diagnosticCodeForStrategy(
  strategy: DependencyDecision["strategy"],
): "unresolved-dependency-decision" | "missing-extension-mapping" | "duplicate-host-mapping" {
  switch (strategy) {
    case "extension":
      return "missing-extension-mapping";
    case "host":
      return "duplicate-host-mapping";
    case "replace":
    case "inline":
      return "unresolved-dependency-decision";
  }
}

/**
 * Reports two packages claiming one host global.
 *
 * Separate from the single-decision check because the problem is only visible
 * across decisions: each record is valid on its own, and the artifact still ends
 * up with one global serving two module identities.
 */
function auditHostGlobalClaims(dependencies: readonly DependencyDecision[]): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];
  const claimants = new Map<string, string[]>();

  for (const decision of dependencies) {
    if (decision.strategy !== "host") continue;
    const globalName = decision.globalName.trim();
    if (globalName.length === 0) continue;
    const existing = claimants.get(globalName);
    if (existing === undefined) claimants.set(globalName, [decision.packageName]);
    else if (!existing.includes(decision.packageName)) existing.push(decision.packageName);
  }

  for (const [globalName, packages] of claimants) {
    if (packages.length > 1) {
      diagnostics.push(
        createCellArtifactDiagnostic("duplicate-host-mapping", globalName, {
          detail: `${packages.length} packages map to this host global (${packages.join(", ")}), so they would share one module identity.`,
        }),
      );
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Bundler report audit
// ---------------------------------------------------------------------------

/**
 * Reports every specifier the bundler left external.
 *
 * The decision, not the bundler, says what should have happened instead, so the
 * diagnostic code is chosen from the strategy. This is the mapping that makes the
 * difference between "your bundler is misconfigured" and "your dependency
 * decision is wrong" visible in the report.
 */
export function auditExternalImports(
  externalImports: readonly string[],
  dependencies: readonly DependencyDecision[],
): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];

  for (const specifier of externalImports) {
    const decision = findDependencyDecision(dependencies, specifier);

    if (decision === undefined) {
      // A file path left external is not a missing decision; it is workspace
      // source the bundler failed to flatten, so sending the caller to the
      // dependency layer would point at the wrong fix. The check is exact for
      // relative and absolute specifiers; see `isSourceSpecifier`.
      diagnostics.push(
        isSourceSpecifier(specifier)
          ? createCellArtifactDiagnostic("source-level-import-remains", specifier, {
              detail: `"${specifier}" is workspace source, which is inlined like any other source file, but the bundler left it external.`,
            })
          : createCellArtifactDiagnostic("unresolved-dependency-decision", specifier, {
              detail: `The bundler could not flatten "${specifier}" and no decision covers it.`,
            }),
      );
      continue;
    }

    switch (decision.strategy) {
      case "extension":
        diagnostics.push(
          createCellArtifactDiagnostic("missing-extension-mapping", decision.packageName, {
            detail: `"${specifier}" is decided \`extension\` but reached the artifact as a source import, so no extension global was referenced in its place.`,
          }),
        );
        break;
      case "replace":
        if (decision.rejection.kind === "architectural") {
          diagnostics.push(
            createCellArtifactDiagnostic("platform-conflicting-dependency", decision.packageName, {
              detail: `"${specifier}" was architecturally rejected (${decision.rejection.code}) and still reaches the artifact. ${decision.rejection.remediation}`,
            }),
          );
        } else {
          diagnostics.push(
            createCellArtifactDiagnostic("source-level-import-remains", specifier, {
              detail: `"${specifier}" was rejected as a technical bundling failure (${decision.rejection.code}) but is still imported. ${decision.rejection.remediation}`,
            }),
          );
        }
        break;
      case "host":
        diagnostics.push(
          createCellArtifactDiagnostic("source-level-import-remains", specifier, {
            detail: `"${specifier}" is decided \`host\` and must be referenced through the global "${decision.globalName}"; a surviving import is resolved by nothing at runtime.`,
          }),
        );
        break;
      case "inline":
        diagnostics.push(
          createCellArtifactDiagnostic("source-level-import-remains", specifier, {
            detail: `"${specifier}" is decided \`inline\` but was left external instead of being flattened into the Cell code.`,
          }),
        );
        break;
    }
  }

  return diagnostics;
}

/**
 * Reports packages flattened into the artifact that should not have been.
 *
 * The bundled set is the only place these failures are visible: a bundle that
 * works looks identical to one that carries a second React, an inlined copy of a
 * library the page is also about to load as an extension, or a package the
 * resolver rejected. All three only become real at runtime, which is why they are
 * checked here rather than left to the platform.
 */
export function auditInlinedPackages(
  inlinedPackages: readonly string[],
  dependencies: readonly DependencyDecision[],
  inlinedSpecifiers?: readonly string[],
): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];

  // Specifier-level provenance when present: each bare specifier keeps its
  // exact-subpath identity so `findDependencyDecision` can apply exact-first
  // precedence. Package names fall back for fixture bundlers that only report
  // package roots, and for packages in the set that no specifier covers.
  const specifierPackageNames = new Set(
    (inlinedSpecifiers ?? []).map(specifier => packageNameOfSpecifier(specifier)),
  );
  const leftoverPackages = inlinedPackages.filter(name => !specifierPackageNames.has(name));
  const subjects = [...(inlinedSpecifiers ?? []), ...leftoverPackages];

  for (const subject of subjects) {
    const decision = findDependencyDecision(dependencies, subject);
    if (decision === undefined) continue;

    switch (decision.strategy) {
      case "host":
        diagnostics.push(
          createCellArtifactDiagnostic("duplicate-host-mapping", decision.packageName, {
            detail: `The bundle contains its own copy of a package decided \`host\`, so the artifact carries a second module identity for the global "${decision.globalName}".`,
          }),
        );
        break;
      case "extension":
        diagnostics.push(
          createCellArtifactDiagnostic("missing-extension-mapping", decision.packageName, {
            detail: `The bundle contains its own copy of a package decided \`extension\`, so the artifact ignores the extension global "${decision.globalName}" the page is told to load and carries a duplicate instead.`,
          }),
        );
        break;
      case "replace":
        if (decision.rejection.kind === "architectural") {
          diagnostics.push(
            createCellArtifactDiagnostic("platform-conflicting-dependency", decision.packageName, {
              detail: `The package was architecturally rejected (${decision.rejection.code}) and was bundled anyway. ${decision.rejection.remediation}`,
            }),
          );
        } else {
          diagnostics.push(
            createCellArtifactDiagnostic("unresolved-dependency-decision", decision.packageName, {
              detail: `The decision for "${decision.packageName}" is \`replace\` because it failed as an artifact (${decision.rejection.code}), yet the bundle contains it. There is no usable decision for the package as it appears here. ${decision.rejection.remediation}`,
            }),
          );
        }
        break;
      case "inline":
        // Exactly what should have happened.
        break;
    }
  }

  return diagnostics;
}

export function auditEmittedAssets(emittedAssets: readonly string[]): readonly CellArtifactDiagnostic[] {
  return emittedAssets.map(asset =>
    createCellArtifactDiagnostic("unsupported-runtime-asset", asset, {
      detail: `The bundler emitted "${asset}" beside the Cell code. A ReactCellType cell is one script, so there is nowhere for a sibling asset to be loaded from.`,
    }),
  );
}

/**
 * Audits the inlined resource ledger for an entry the artifact could not have inlined (#98).
 *
 * The ledger is produced by the same reader that generated the module text, so every entry that
 * reached here *should* carry a `data:` URI. This check is the audit rather than the producer's
 * promise, and the distinction is the point of the issue's "every inlined asset URL is traceable"
 * criterion: a reader that inlined nothing and one that inlined everything both produce an
 * artifact, and only the ledger plus an audit can tell them apart.
 *
 * It is a pure function over the report, so the compiler does not re-parse base64 to run it.
 */
export function auditInlinedResourceUrls(resources: readonly CellInlinedResource[]): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];
  for (const resource of resources) {
    if (resource.kind === "style") {
      // A stylesheet's own references were rewritten by the reader, which refuses rather than
      // leaving one behind. The ledger carries their counts rather than their URLs, so there is
      // nothing here to re-check without re-reading the stylesheet the artifact already embeds.
      continue;
    }
    if (!resource.dataUri.startsWith("data:")) {
      diagnostics.push(
        createCellArtifactDiagnostic("rejected-cell-asset", resource.fileName, {
          detail: `The inlined asset "${resource.fileName}" is not reported as a data: URI, so the artifact would carry an untraceable external reference. A Cell is one script with no sibling files and no runtime directory; rebuild through the compiler so the asset is inlined.`,
        }),
      );
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Source and budget audit
// ---------------------------------------------------------------------------

/**
 * Runs both source checks over a composed artifact.
 *
 * Shared by assembly and verification on purpose. The two callers differ only in
 * what they can say about *where* a construct came from — assembly knows which
 * part of the artifact it composed, verification only has the finished string —
 * so the origin is a function of the offset rather than a reason to write the
 * checks twice. Two copies would be two places for the wording or the code to
 * drift, which is exactly what makes a report disagree with itself.
 *
 * One audit call, not two, because both checks need the same parse and an artifact
 * can be megabytes of minified bundle.
 */
export function auditArtifactSource(
  composedCode: string,
  originOf: (index: number) => string,
): readonly CellArtifactDiagnostic[] {
  const diagnostics: CellArtifactDiagnostic[] = [];
  const audit = auditCellSource(composedCode);

  for (const finding of audit.findings) {
    diagnostics.push(
      createCellArtifactDiagnostic("rejected-cell-source-construct", finding.specifier ?? finding.match, {
        detail: `Found ${finding.occurrences} time(s) in ${originOf(finding.index)}, at line ${finding.line}. ReactCellType rejects it with: "${finding.platformMessage}"`,
        location: `line ${finding.line}`,
      }),
    );
  }

  for (const dynamicImport of audit.dynamicImports) {
    diagnostics.push(
      createCellArtifactDiagnostic("unsupported-runtime-asset", dynamicImport.match, {
        detail: `Found ${dynamicImport.occurrences} dynamic import call(s) in ${originOf(dynamicImport.index)}, at line ${dynamicImport.line}. The platform validator does not reject these, so nothing downstream will catch one that survives into production.`,
        location: `line ${dynamicImport.line}`,
      }),
    );
  }

  return diagnostics;
}

/**
 * Attributes an offset in a composed artifact to the part it came from.
 *
 * By offset rather than by comparing line counts: the composed source has a
 * header line before the bundle, so line arithmetic would be off by one in
 * exactly the case the origin matters most. A test covers it by asserting that a
 * construct near the bundle's end is still attributed to the bundle.
 *
 * ## The prefix length is an input, not a constant (#185)
 *
 * Before the auto-height injection this function computed the bundle's start as
 * "banner + newline", which was exact only because nothing else sat between the
 * banner and the bundle. The composed artifact is now
 * `banner + livePropsDeclaration? + styleInstaller? + autoHeight? + bundle + wrapper`,
 * so the bundle's start is the banner plus *whatever prefix this assembly emitted* —
 * and the prefix lengths are passed in rather than re-derived here, because the
 * alternative (measuring the patch source again) is a second spelling of
 * assembly's composition that can drift away from it. Assembly knows exactly what
 * it emitted; this function's job is only the arithmetic.
 *
 * Everything before the bundle — the live-props declaration, the style installer,
 * the injection — is reported as "the generated artifact header", which is the
 * honest granularity: they are all compiler-emitted wiring rather than the Cell's
 * bundle or its entry wrapper, and a diagnostic about one of them is a compiler
 * bug report either way.
 */
export function artifactOriginOf(bundledCode: string, prefixLength = 0): (index: number) => string {
  const bundleStart = CELL_ARTIFACT_BANNER.length + 1 + prefixLength;
  const bundleEnd = bundleStart + bundledCode.length;
  return index => {
    if (index < bundleStart) return "the generated artifact header";
    if (index < bundleEnd) return "bundled dependency code";
    return "the generated entry wrapper";
  };
}

/**
 * Checks a composed artifact against the caller's budget, saying *which measured
 * band* the size falls in.
 *
 * Decision source: GitHub Issue #21 —
 * "Research: measure ReactCellType generated-code budget and performance envelope"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/21). Before #21 this
 * function reported only "over budget", which is the one thing a caller can act on
 * and the least useful thing it could say: a 600 KiB artifact and a 4 MiB one are
 * both "over" a 512 KiB budget and are not remotely the same decision.
 *
 * The band comes from `core`'s measured record rather than from a second table
 * here. `core` owns the measurement (#21) and `cell-compiler` takes it as
 * configuration — the same division the package's other Specs use, and the reason
 * the measurement is not restated: two copies would drift, and the drift would be
 * invisible because both would look plausible.
 *
 * The code stays `cell-code-budget-exceeded`, because that is #6's public
 * vocabulary and a downstream consumer branches on it. What changed is that the
 * detail now names the band and the measured cost, so a caller that sees this
 * diagnostic can tell "worth a look" from "get an extension" without re-deriving
 * the thresholds.
 */
export function auditCodeBudget(code: string, budget: number | undefined): readonly CellArtifactDiagnostic[] {
  if (budget === undefined) return [];

  // The budget is validated, not trusted, and the guard is `core`'s rather than a
  // second copy here: the probe's `size` step compares a cap too, so one contract
  // for "what may a programmatic cap be" is what keeps the two from disagreeing
  // about a value the caller supplied once. See `assertCellCodeBudget` for why an
  // unvalidated one fails in the most confusing direction available.
  assertCellCodeBudget(budget);

  if (code.length <= budget) return [];

  const verdict = classifyCellCodeSize(code.length);
  const { write, browserEntry } = verdict.definition.representativeMeasurements;

  // Two different situations produce this diagnostic and they need different
  // advice, which is why the guidance is chosen rather than copied from the band:
  //
  // - The artifact is large by measurement (`review` or above). The band's own
  //   guidance is the right advice.
  // - The artifact is inside the measured ordinary range and the *budget* is what
  //   is tight. Printing the inline band's "no review needed" next to a hard
  //   rejection would have the diagnostic contradict itself, and would send the
  //   caller looking for a problem in an artifact the measurement says is fine.
  //
  // The second case is the one where the two concepts must not be conflated, so it
  // says what is actually true of this rejection: the budget is a hard cap, and the
  // band is an advisory classification that a raised cap does not start reporting.
  //
  // The claim is scoped to *this* check, and that scoping is load-bearing. This
  // function returns one diagnostic among several that `assembleCellArtifact`
  // collects, so an artifact can carry a budget rejection beside an unrelated one —
  // reproduced with an unflattened inline import: a tight budget yields
  // `[source-level-import-remains, cell-code-budget-exceeded]`, and raising the
  // budget yields `[source-level-import-remains]` and the compile is *still*
  // rejected. Saying a raised budget "accepts the artifact outright" would be false
  // in exactly that case, and would send the caller away believing the build is
  // clean. Nothing here knows whether other diagnostics exist, so the honest form is
  // conditional: this rejection goes, anything else stands.
  const guidance = verdict.withinInlineBand
    ? `The artifact is inside the measured ordinary range (${verdict.band}, ceiling ` +
      `${String(verdict.definition.maxCharacters)} characters), so this rejection is the configured budget's ` +
      `rather than a cost the measurement found. Raising the budget removes this budget rejection; any other ` +
      `artifact diagnostic still applies. Bands are an advisory classification, not a severity this diagnostic ` +
      `re-reports once a size is allowed.`
    : verdict.definition.guidance;

  return [
    createCellArtifactDiagnostic("cell-code-budget-exceeded", "Cell artifact", {
      detail:
        `The composed artifact is ${code.length} characters against a configured budget of ${budget}. ` +
        `The measurement is taken on the composed artifact because that is what is written into the cell. ` +
        `Measured band: ${verdict.band} (#21). Those figures were taken against ` +
        `${CELL_CODE_BUDGET_MEASUREMENT.target}, which is not the build this project targets, so they are ` +
        `a carried-forward reference rather than a measurement of this target: at this band's own measured ` +
        `points the designer write took ${String(write.ms)} ms at ${String(write.characters)} characters ` +
        `(${write.artifact}) and the browser's first cell entry took ${String(browserEntry.ms)} ms at ` +
        `${String(browserEntry.characters)} characters (${browserEntry.artifact}). ${guidance}`,
      // The measurement travels with the diagnostic so it has exactly one producer (#77 round 5).
      // A caller that wants to record this rejection has to take these numbers — it cannot type its
      // own, which is what makes the recorded evidence compiler-origin rather than attested.
      //
      // Deliberately just the two figures: the *identity* of the compile is composed one level up,
      // where the entry's source and the decision set are in hand (see
      // `composeCellCompileFingerprint`). Composing it here would mean deriving the entry source
      // from the composed artifact, which no longer exists as a separate input.
      budgetEvidence: {
        budgetCharacters: budget,
        codeCharacters: code.length,
      },
    }),
  ];
}
