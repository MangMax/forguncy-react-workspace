/**
 * The report half of the Rolldown-backed bundler: what a build's module graph says about
 * installed packages, and how the two plans' findings are translated into the artifact's
 * vocabulary.
 *
 * Decision source: GitHub Issue #7 — "Implement: Cell compiler MVP for a single
 * React entry"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/7), downstream of #6's
 * compiler boundary (https://github.com/Mang-X/forguncy-react-workspace/issues/6).
 *
 * Split out of `rolldown-bundler.ts` (#170) along the seam between *producing* a build
 * and *reporting* on one: nothing here calls Rolldown, and nothing here holds per-pass
 * state. Every function is a pure function of a finished chunk's module graph or of one
 * plan finding, which is what lets the build path be read as the sequence of stages it
 * is.
 *
 * What is deliberately *not* here: the two plan vocabularies are not collapsed into
 * #6's. A mapping finding ("this table row cannot be honoured") and an artifact finding
 * ("this artifact breaks a guarantee") are two findings, not two spellings of one —
 * `core`'s vocabulary comments pin that split — so only the subset whose statement is
 * literally about the produced artifact is translated, arm by arm, in
 * {@link translateHostFinding} and {@link translateExtensionFinding}.
 */

import { realpathSync } from "node:fs";
import path from "node:path";

import type { ExtensionExternalDiagnostic } from "@forguncy-react-workspace/core";
import { compareCodeUnits } from "@forguncy-react-workspace/core";

import type { InlinedPackageSize } from "./artifact.ts";
import { packageNameOfSpecifier } from "./specifier.ts";
import type { CellArtifactDiagnostic } from "./diagnostics.ts";
import { createCellArtifactDiagnostic } from "./diagnostics.ts";
import type { HostBridgeDiagnostic } from "./host-bridge.ts";

// ---------------------------------------------------------------------------
// Installed-package attribution
// ---------------------------------------------------------------------------

const NODE_MODULES_MARKER = "node_modules/";

/**
 * The package a module id was flattened from, or `undefined` for anything that
 * did not come from an installed dependency.
 *
 * The *last* `node_modules/` segment wins, which is what makes pnpm's layout
 * (`…/.pnpm/react@19.2.7/node_modules/react/index.js`) and a hoisted layout
 * (`…/node_modules/react/index.js`) answer the same, and what keeps a virtual
 * interception id (`\0cell-host:react/jsx-runtime`) from answering at all.
 *
 * The folding itself is `core`'s one package-name rule (#156); this function only
 * finds where in the path the package name starts. Splitting on the marker and then
 * folding keeps a scoped package (`@scope/pkg/sub`) and a bare one (`react/sub`) on the
 * same rule the rest of the repository uses, rather than on a second one written here.
 */
function packageNameOfModuleId(moduleId: string): string | undefined {
  const normalized = moduleId.replace(/\\/g, "/");
  const at = normalized.lastIndexOf(NODE_MODULES_MARKER);
  if (at < 0) return undefined;
  const rest = normalized.slice(at + NODE_MODULES_MARKER.length).replace(/\/$/, "");
  const [first] = rest.split("/");
  if (first === undefined || first.length === 0) return undefined;
  return packageNameOfSpecifier(rest);
}

export function inlinedPackageNames(moduleIds: readonly string[]): string[] {
  const packages = new Set<string>();
  for (const moduleId of moduleIds) {
    const packageName = packageNameOfModuleId(moduleId);
    if (packageName !== undefined) packages.add(packageName);
  }
  // Sorted so the report is byte-stable like the code is: #7's determinism
  // criterion covers the whole compile result, not only its largest field.
  return [...packages].sort();
}

/**
 * Rendered characters contributed by each installed package that landed in this chunk.
 *
 * The bundler already accounts per module (`renderedLength`), so this is a grouping of what it
 * reported rather than a second measurement — and it is the only sound basis for attribution. #77
 * round 6 initially tried to obtain it by recompiling the Cell *without* the subject's decision and
 * subtracting, which is **degenerate**: dropping a decision does not remove the package's code,
 * because the bundler still resolves the bare import from `node_modules` (measured: 14971
 * characters either way). Measuring what a package actually contributes requires asking the module
 * graph, which is exactly this.
 *
 * Sorted by name so the report is byte-stable, like the code and `inlinedPackages`.
 */
export function inlinedPackageSizesOf(modules: Record<string, { readonly renderedLength: number }>): readonly InlinedPackageSize[] {
  const sizes = new Map<string, { packageName: string; exactSpecifier: string | null; renderedCharacters: number }>();
  for (const [moduleId, module] of Object.entries(modules)) {
    const packageName = packageNameOfModuleId(moduleId);
    if (packageName === undefined) continue;
    // Attributed by the specifier that *resolved* to this module, not only by its package root.
    // The compiler preserves exact-subpath precedence everywhere else — `findDependencyDecision`
    // checks the exact specifier before the package root, and `inlinedSpecifiers` exists so
    // `pkg/subpath` is not folded into `pkg` — so reporting a subpath's bytes under the root would
    // credit a decision that did not govern them (#77 round 7).
    const exactSpecifier = exactSubpathOf(moduleId, packageName);
    const key = `${packageName}\u0000${exactSpecifier ?? ""}`;
    const entry = sizes.get(key) ?? { packageName, exactSpecifier, renderedCharacters: 0 };
    entry.renderedCharacters += module.renderedLength;
    sizes.set(key, entry);
  }
  return [...sizes.values()].sort(
    (a, b) => compareCodeUnits(a.packageName, b.packageName) || compareCodeUnits(a.exactSpecifier ?? "", b.exactSpecifier ?? ""),
  );
}

/**
 * The subpath a module under `node_modules/<packageName>` came from, or null for the package root.
 *
 * Derived from the module's own path rather than from the specifier that imported it, because the
 * specifier is not available at this level: the module graph reports resolved ids, and two
 * different specifiers can resolve into one package. So this answers "which subpath does this file
 * belong to", which is enough for the *subpath* half of the split and deliberately not offered as
 * a claim about which import reached it.
 */
function exactSubpathOf(moduleId: string, packageName: string): string | null {
  const normalized = moduleId.replace(/\\/g, "/");
  const marker = `${NODE_MODULES_MARKER}${packageName}/`;
  const at = normalized.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = normalized.slice(at + marker.length);
  const segments = rest.split("/").filter(segment => segment.length > 0);
  // A file directly inside the package directory is the package root; anything under a
  // subdirectory is a subpath. `dist/index.js` is the root's build output, not an imported
  // `dist` subpath, which is why the entry file's own directory is not treated as a subpath.
  if (segments.length === 0) return null;
  const [first] = segments;
  if (first === "dist" || first === "lib" || first === "src" || first === "esm" || first === "cjs") {
    return null;
  }
  return segments.length > 1 ? first! : null;
}

/**
 * Whether a module id resolves, after following symlinks, to a real path under
 * `node_modules`.
 *
 * The line between "installed package" and "workspace source reached through a
 * `node_modules` symlink": #14's workspace packages are source and need no
 * `DependencyDecision`, while an installed package without one must be refused
 * (#4). Rolldown normally resolves symlinks to real paths — so workspace source
 * already answers `false` here — but the `realpathSync` call is deliberate
 * defence against a `preserveSymlinks` configuration that would leave the
 * module id under `node_modules` while the real file lives elsewhere.
 */
export function resolvesIntoNodeModules(moduleId: string): boolean {
  try {
    return realpathSync(moduleId).split(path.sep).join("/").includes(NODE_MODULES_MARKER);
  } catch {
    // A module id that cannot be resolved to a real path is judged on its own
    // text: if it says `node_modules`, treat it as installed rather than
    // silently accepting a package the decision layer never saw.
    return moduleId.split(path.sep).join("/").includes(NODE_MODULES_MARKER);
  }
}

// ---------------------------------------------------------------------------
// Plan consultation and translation
// ---------------------------------------------------------------------------

/**
 * The bridge's findings, translated into the artifact's vocabulary — or
 * dropped, with the reason written at the arm.
 *
 * The split core insists on is visible here: a bridge diagnostic is about a
 * mapping, and `duplicate-host-mapping` is about a produced artifact, so an arm
 * may only translate when the finding's statement is literally true of the
 * artifact. `host-module-duplicated` is the clearest case — "the decision
 * contradicts the table" is the mapping's finding, but "this artifact carries a
 * second copy of an identity-sensitive module" is the artifact's, and it is
 * only reportable when the copy is actually in `inlinedPackages`.
 */
export function translateHostFinding(
  finding: HostBridgeDiagnostic,
  inlinedPackages: readonly string[],
  referencedPackages: ReadonlySet<string>,
): CellArtifactDiagnostic | undefined {
  // Whether the artifact actually carries the package the finding names —
  // imported (and so bound into the artifact) or inlined. This is the line
  // between an artifact-true statement and a decision-layer one for the arms
  // below: a conflict between decisions the entry never imports binds none of
  // this artifact's globals, so reporting it here would claim a guarantee
  // break the artifact does not commit.
  const packageInArtifact =
    referencedPackages.has(packageNameOfSpecifier(finding.specifier)) ||
    inlinedPackages.includes(finding.specifier);
  switch (finding.code) {
    case "host-module-duplicated":
      if (!inlinedPackages.includes(finding.specifier)) return undefined;
      return createCellArtifactDiagnostic("duplicate-host-mapping", finding.specifier, {
        detail: finding.detail,
      });
    case "host-mapping-conflict":
      // An incoherent table cannot vouch for any identity it binds — but only
      // for the identities this artifact binds: see `packageInArtifact` above
      // and the vocabulary rule in this function's header comment.
      if (!packageInArtifact) return undefined;
      return createCellArtifactDiagnostic("duplicate-host-mapping", finding.specifier, {
        detail: finding.detail,
      });
    case "host-mapping-missing":
    case "host-adapter-not-used":
      // Mapping-level findings whose artifact-visible consequences — a
      // surviving import, an inlined copy — #6's report-field audits already
      // report when they occur. Translating them here as well would state one
      // condition twice under two codes, which is the confusion core's
      // vocabulary comment warns about; an *unused* bad decision breaks no
      // guarantee of the artifact.
      return undefined;
    case "host-global-missing":
    case "host-global-incompatible":
    case "host-member-not-verified":
      // Runtime codes: they describe a page evaluated without the global, not
      // a built artifact, and no plan emits them for a build. The arms exist
      // so a future code cannot silently fall through an implicit `undefined`.
      return undefined;
  }
}

/**
 * The extension plan's findings, translated the same way and by the same rule.
 *
 * `extension-mapping-missing` and `extension-mapping-conflict` are both
 * artifact-level statements of "this `extension` decision has no usable
 * mapping" — the artifact would reference a library identity the table does
 * not verify — which is exactly #12's `missing-extension-mapping`.
 * `extension-not-declared` is the artifact reading a mapped extension module
 * that no decision declares: the generated module would read a global
 * `frontendLibraries` never names, so from the artifact's side the dependency
 * arrived without a usable decision.
 */
export function translateExtensionFinding(finding: ExtensionExternalDiagnostic): CellArtifactDiagnostic | undefined {
  switch (finding.code) {
    case "extension-mapping-missing":
    case "extension-mapping-conflict":
    case "extension-library-unverified":
    case "extension-global-mismatch":
      return createCellArtifactDiagnostic("missing-extension-mapping", finding.subject, {
        detail: finding.detail,
      });
    case "extension-not-declared":
      return createCellArtifactDiagnostic("unresolved-dependency-decision", finding.subject, {
        detail: finding.detail,
      });
    case "extension-bundle-missing":
    case "extension-types-missing":
    case "extension-global-missing":
      // Runtime codes about a page that did not load the extension; no plan
      // emits them for a build. Kept explicit so the switch stays exhaustive.
      return undefined;
  }
}

export function byCodeThenSubject(
  a: { readonly code: string; readonly subject: string },
  b: { readonly code: string; readonly subject: string },
): number {
  return compareCodeUnits(a.code, b.code) || compareCodeUnits(a.subject, b.subject);
}
