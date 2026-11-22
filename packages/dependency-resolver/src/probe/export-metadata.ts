/**
 * The `export-metadata` step: which entry point a browser build would consume.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (this step records "the `exports`/`module`/`browser`/
 * `types` entries and peer ranges, i.e. which entry point a browser build would
 * actually consume", and only this step may observe
 * `ssr-or-server-only-without-browser-build`), #5 (the browser-first artifact the
 * entry question is about).
 *
 * The one rejection this step can file — `ssr-or-server-only-without-browser-build`
 * — is answered from the manifest alone, which is deliberate: a package with no
 * browser entry has no browser artifact to build, so running the build first would
 * only re-discover the same absence with worse diagnostics. When `exports` exists
 * it is authoritative (a strict map can hide every other field), and the package
 * is browser-resolvable when the `browser` field is set *or* the exports map
 * resolves under browser conditions. Without `exports`, the classic
 * `browser` → `module` → `main` order decides. Fields pointing only at
 * `.mjs`/`.js`/`.cjs` or bare directories count; a field that only points at
 * `.node` or explicitly browser-excluded entries does not.
 *
 * Positive signals from this step (`browser-first-esm-distribution`,
 * `shipped-typescript-declarations`, …) are recorded as **facts only**. A positive
 * signal can never accept a candidate (`SELECTION_SIGNAL_FAMILY_SEMANTICS`), so
 * filing it as a finding would put a preference next to measurements; the Agent
 * reads the fact.
 */

import type { ProbeFact, ProbeRejectionFinding, ProbeRisk, ProbeValidationEntry } from "@forguncy-react-workspace/core";

import { ACTIVE_EXPORT_CONDITIONS, isPortablePackagePath } from "./browser-entry.ts";
import type { ResolvedPackageIdentity } from "./identity.ts";
import { compareStrings } from "./scan-utils.ts";

export interface ExportMetadataObservation {
  readonly facts: readonly ProbeFact[];
  readonly risks: readonly ProbeRisk[];
  readonly rejectionFindings: readonly ProbeRejectionFinding[];
  readonly validation: ProbeValidationEntry;
}

export interface ExportMetadataOptions {
  /**
   * The specifier the build will import; defaults to the package name (the root entry).
   *
   * A subpath (`pkg/sub`) asks the question about that published entry. It is the same input
   * the build step already takes, passed through so the two steps read one entry rather than
   * the build asking about `pkg/sub` while this one answers about `pkg`.
   */
  readonly entry?: string;
}

/** Entry fields a browser resolver would consult, in precedence order when `exports` is absent. */
const FALLBACK_BROWSER_FIELDS = ["browser", "module", "main"] as const;

/**
 * The exports-map key a specifier names: `.` for the package itself, `./<rest>` for a published
 * subpath.
 *
 * Read from the specifier rather than from the manifest because the manifest is what is being
 * asked — deriving the key from it would let a nonexistent subpath silently fall back to the
 * root entry, which is the "root decision widens support" widening #90 has to leave refused.
 * A specifier that belongs to another package cannot reach here (the identity step refuses
 * it), so it answers `.` rather than inventing a key.
 */
function exportsKeyForRequest(packageName: string, entry: string): string {
  const prefix = `${packageName}/`;
  return entry.startsWith(prefix) && entry.length > prefix.length ? `./${entry.slice(prefix.length)}` : ".";
}

/**
 * The value an exports map publishes for one key.
 *
 * Exact key first, then the longest matching `./prefix/*` pattern — Node's own precedence,
 * restated here as the same rule rather than as a preference for a particular package layout.
 * `undefined` means the map does not publish the key at all; the caller must not substitute
 * the root entry for it.
 */
function exportsTargetForKey(exportsMap: Record<string, unknown>, key: string): unknown {
  if (key in exportsMap) return exportsMap[key];
  const patterns = Object.keys(exportsMap)
    .filter(pattern => pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1)))
    .sort((a, b) => b.length - a.length);
  const pattern = patterns[0];
  return pattern === undefined ? undefined : exportsMap[pattern];
}



function isSubpathExports(exportsValue: unknown): boolean {
  if (exportsValue === null || typeof exportsValue !== "object" || Array.isArray(exportsValue)) {
    return false;
  }
  return Object.keys(exportsValue as Record<string, unknown>).some(key => key.startsWith("."));
}

/**
 * Whether an exports target resolves to something a browser can execute.
 *
 * Strings resolve *if they name an executable file*; arrays resolve if any alternative
 * does; a subpath map is tried at `.` then `*`; a conditions map tries the browser-first
 * order. `null` is an explicit exclusion and never resolves.
 *
 * The executable check on a string is not decoration: a conditions map may point its
 * `browser` condition at a native addon (`{ browser: "./addon.node", import: "./real.js" }`),
 * and counting that as browser-resolvable asserted that a browser build has an entry
 * while naming a file no browser can load. `module-source.test.ts` keeps this function
 * and `resolveBrowserEntryPaths` in agreement over a table of shapes, which is what
 * caught it — the two had disagreed, and the disagreement let a package be reported
 * browser-resolvable while the scanner reached zero files and drew its conclusion from
 * an empty set.
 */
function exportsTargetResolvesBrowser(target: unknown): boolean {
  if (typeof target === "string") {
    // An absolute, escaping or scheme-prefixed target cannot name a file inside the
    // package, so it is not an entry — the same judgement `browser-entry.ts` makes, and
    // the two have to agree or this step reports a resolvable entry the scanner cannot
    // reach a single file from.
    if (!isPortablePackagePath(target)) return false;
    return fieldLooksExecutable(target);
  }
  if (target === null) return false;
  if (Array.isArray(target)) {
    // Any executable alternative answers "is there a browser entry" affirmatively, which
    // is the question this function asks. `browser-entry.ts` asks the *narrower* "which
    // file" and takes the first executable alternative, so for
    // `["./addon.node", "./real.js"]` it names `real.js` while this reports resolvable —
    // different questions, consistent answers, which is what the agreement table in
    // `module-source.test.ts` asserts.
    return target.some(entry => exportsTargetResolvesBrowser(entry));
  }
  if (typeof target !== "object") return false;
  const record = target as Record<string, unknown>;
  if (Object.keys(record).some(key => key.startsWith("."))) {
    const subpath = record["."] ?? record["*"];
    return subpath !== undefined && exportsTargetResolvesBrowser(subpath);
  }
  // Key order, not a preference ranking — the same rule `browser-entry.ts` implements, from
  // the same set, so the two steps cannot agree with each other while both disagreeing with
  // Node. See `ACTIVE_EXPORT_CONDITIONS` for the measured evidence.
  for (const [condition, value] of Object.entries(record)) {
    if (ACTIVE_EXPORT_CONDITIONS.has(condition)) {
      return exportsTargetResolvesBrowser(value);
    }
  }
  return false;
}

function exportsResolveForBrowser(exportsField: unknown, exportsKey: string = "."): boolean {
  const isRoot = exportsKey === ".";
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    // A bare string / array form publishes the root only, so it cannot answer a subpath.
    return isRoot && exportsTargetResolvesBrowser(exportsField);
  }
  if (exportsField === null || typeof exportsField !== "object") {
    return false;
  }
  if (isSubpathExports(exportsField)) {
    const map = exportsField as Record<string, unknown>;
    if (!isRoot) {
      const target = exportsTargetForKey(map, exportsKey);
      return target !== undefined && exportsTargetResolvesBrowser(target);
    }
    const root = exportsTargetForKey(map, ".");
    if (root === undefined) {
      // A subpath map with no root entry: the package root itself may be
      // absent while `./feature` entries exist. With no entry named, the root
      // is what is being asked about, and it publishes nothing.
      return false;
    }
    return exportsTargetResolvesBrowser(root);
  }
  // Conditions map at the top level (exports: { browser: …, require: … }). This form
  // publishes the root only, so there is no subpath answer to give from it.
  return isRoot && exportsTargetResolvesBrowser(exportsField);
}

/**
 * True when a manifest entry string names a file a browser could execute.
 *
 * The query is stripped **before** the extension is tested, so this agrees with
 * `browser-entry.ts`'s `looksExecutable`, which does the same. Both orderings have to
 * match or the two steps disagree about a manifest like `{ ".": "./a.node?x" }`:
 * `browser-entry` strips the query and finds no usable entry while this called it
 * executable, which is the "browser-resolvable verdict, zero files scanned" shape the
 * agreement table in `module-source.test.ts` exists to catch.
 */
function fieldLooksExecutable(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.replace(/\?.*$/, "").trim();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith(".node")) return false;
  return true;
}

/** True when the `browser` field exists and maps something to `false` for the root entry. */
function browserFieldExcludesRoot(manifest: Readonly<Record<string, unknown>>): boolean {
  const browser = manifest["browser"];
  if (browser === null || typeof browser !== "object" || Array.isArray(browser)) {
    return false;
  }
  const record = browser as Record<string, unknown>;
  const rootKeys = ["./index.js", "./index.mjs", "./index.cjs", ".", "./"];
  return rootKeys.some(key => record[key] === false);
}

function peerRangesOf(manifest: Readonly<Record<string, unknown>>): readonly string[] {
  const peers = manifest["peerDependencies"];
  if (peers === null || typeof peers !== "object" || Array.isArray(peers)) {
    return [];
  }
  return Object.entries(peers as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, range]) => `${name}@${range}`)
    .sort(compareStrings);
}

/**
 * Reads the manifest's published entry points and derives what this step may
 * observe. Pure: the identity (and therefore the manifest) already resolved.
 *
 * ## Which entry the question is about (#90)
 *
 * `identity.packageName` is the package the probe located — the *manifest's* identity — while
 * `entry` is the specifier the build actually imports, and the two differ whenever the caller
 * probes a published subpath (`pkg/sub`). This step's browser-resolvability question is
 * "does the specifier the Cell will import have a browser entry", so it is asked about the
 * entry, not about the package root. Asking about the root was wrong in both directions and
 * both were reachable from a normal modern package:
 *
 * - a **subpath-only** package (`exports: { "./only": … }`, no `"."`) was reported
 *   `ssr-or-server-only-without-browser-build` — a `supports-rejection-only` assessment — for
 *   the entry it just successfully probed, which made every such package unrecordable;
 * - a package whose root is Node-only while a published subpath is browser-safe had the same
 *   rejection filed against the subpath that has a browser entry.
 *
 * `entry` is optional so the step stays pure and callable from its own tests: absent means
 * "the package root", which is exactly the default the build step uses for the specifier.
 *
 * ## Why this did not bump `PROBE_ANALYSIS_REVISION`
 *
 * The revision exists so a cached report cannot answer a run whose scanner behaves differently.
 * This change is keyed on the **entry**, which is already a fingerprint input, and it leaves a
 * root report byte-identical (the new `exports.probed-entry` fact is only emitted when an entry
 * is named). A subpath run's fingerprint was previously composed but its report could never
 * become lock evidence: the audit refused the decision for the `supports-rejection-only`
 * assessment this step produced. So there is no recorded citation a stale cache entry could
 * answer, and bumping would instead invalidate every existing record's fingerprint — including
 * one whose runtime validation was performed on a real page and must not be re-recorded locally.
 */
export function observeExportMetadata(
  identity: ResolvedPackageIdentity,
  options: ExportMetadataOptions = {},
): ExportMetadataObservation {
  const manifest = identity.manifest;
  const facts: ProbeFact[] = [];
  const risks: ProbeRisk[] = [];
  const rejectionFindings: ProbeRejectionFinding[] = [];

  const entry = options.entry ?? identity.packageName;
  const exportsKey = exportsKeyForRequest(identity.packageName, entry);
  const subject = exportsKey === "." ? "the package root" : `the "${entry}" entry`;

  const hasExports = "exports" in manifest;
  const exportsField = manifest["exports"];
  const browserField = manifest["browser"];
  const typesField = manifest["types"] ?? manifest["typings"];

  // `exports` is authoritative when present, so a `browser` field does **not** rescue
  // a package whose exports map hides every browser entry. It used to: the condition
  // was `exportsResolveForBrowser(exportsField) || browserField !== undefined`, and
  // that `||` contradicted this module's own header ("when `exports` exists it is
  // authoritative"). The consequence surfaced once the scanners became
  // reachability-bounded: `{ exports: { ".": { node: "./index.js" } }, browser: {
  // "./lib/x.js": "./x.browser.js" } }` with `node:fs` in `index.js` was reported
  // browser-resolvable here while the entry resolution (correctly) named no
  // browser-executable root, so the dependency step reached zero files and drew its
  // conclusion from an empty set. The two steps now agree, which is what the shared
  // condition order and the agreement test in `module-source.test.ts` exist for.
  //
  // The object form of `browser` is a *path substitution* map, not a new entry: it
  // remaps a request that resolution already found. It therefore cannot create a
  // browser entry where `exports` publishes none, and a string `browser` is ignored
  // for the same reason — `exports` wins outright in both cases.
  //
  // #90: when the caller probes a published subpath, the question is about *that* subpath —
  // `exports["./sub"]` — rather than about `exports["."]`. A subpath-only package has no `"."`
  // at all, so asking the root reported the very entry the build just consumed as having no
  // browser entry.
  const browserResolvable = hasExports
    ? exportsResolveForBrowser(exportsField, exportsKey)
    : FALLBACK_BROWSER_FIELDS.some(field => fieldLooksExecutable(manifest[field])) &&
      !(typeof browserField === "object" && browserFieldExcludesRoot(manifest));

  facts.push({
    step: "export-metadata",
    name: "exports.map.present",
    value: hasExports,
  });
  if (hasExports) {
    facts.push({
      step: "export-metadata",
      name: "exports.browser-resolvable",
      value: browserResolvable,
    });
  } else {
    const presentFields = FALLBACK_BROWSER_FIELDS.filter(field => field in manifest);
    facts.push({
      step: "export-metadata",
      name: "exports.fallback-fields",
      value: presentFields,
    });
    facts.push({
      step: "export-metadata",
      name: "exports.browser-resolvable",
      value: browserResolvable,
    });
  }
  facts.push({
    step: "export-metadata",
    name: "exports.browser-field-present",
    value: browserField !== undefined,
  });
  facts.push({
    step: "export-metadata",
    name: "exports.types-present",
    value: typesField !== undefined,
  });

  const peers = peerRangesOf(manifest);
  if (peers.length > 0) {
    facts.push({
      step: "export-metadata",
      name: "peerDependencies.ranges",
      value: peers,
    });
  }

  // When the probe is about a published subpath, the key it was asked about is recorded as its
  // own fact: without it a reader holding `exports.browser-resolvable: true` on a subpath-only
  // package cannot tell which entry that answer is about (the package has no root entry at all),
  // and a report cached under a fingerprint that does not differ per entry would be
  // indistinguishable from a root probe of the same package.
  if (exportsKey !== ".") {
    facts.push({
      step: "export-metadata",
      name: "exports.probed-entry",
      value: exportsKey,
    });
  }

  // The step's one rejection: no browser entry means no browser artifact, and
  // that is decidable from the manifest alone (its `observedFrom` is
  // `package-manifest`). A package excluded only through the `browser` field's
  // object form is the same fact under a different spelling.
  const entryPhrase = exportsKey === "." ? "" : ` for ${subject}`;
  if (!browserResolvable) {
    rejectionFindings.push({
      signal: "ssr-or-server-only-without-browser-build",
      step: "export-metadata",
      summary: `"${identity.packageName}@${identity.packageVersion}" publishes no browser-resolvable entry${entryPhrase}, so a client cell has nothing to execute.`,
      evidence: [
        hasExports
          ? "exports-map-does-not-resolve-for-browser"
          : `entry-fields:${FALLBACK_BROWSER_FIELDS.filter(field => field in manifest).join(",") || "none"}`,
        `package:${identity.packageName}@${identity.packageVersion}`,
      ],
    });
  }

  const validation: ProbeValidationEntry = {
    step: "export-metadata",
    outcome: "passed",
    detail: browserResolvable
      ? `Read the published entry fields; a browser build has an entry point to consume${entryPhrase}.`
      : `Read the published entry fields; no browser-resolvable entry was found${entryPhrase} and the absence itself is recorded as a rejection finding.`,
    diagnostics: [],
  };

  return { facts, risks, rejectionFindings, validation };
}
