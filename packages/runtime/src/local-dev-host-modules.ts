/**
 * Host module resolution in local mode, moved verbatim from `local-dev.ts` (#160).
 *
 * `local-dev.ts` remains that contract's module doc and the home of the sections it keeps; this
 * file holds the projection of #9's `HOST_BRIDGE_MAPPINGS` and every lookup, derivation and
 * guard built on it.
 */

import {
  DEPENDENCY_STRATEGIES,
  HOST_BRIDGE_DEFERRED_MODULES,
  HOST_BRIDGE_MAPPINGS,
  hostBridgeInterceptedModuleIds,
  hostBridgeModuleIds,
  RUNTIME_CONTRACT_TARGET,
  RUNTIME_CONTRACT_TARGET_FIELDS_NOT_BROWSER_OBSERVED,
} from "@forguncy-react-workspace/core/browser";
import type { HostBridgeDeferredModule, HostBridgeMapping } from "@forguncy-react-workspace/core/browser";

import { isNonEmptyString, LocalDevRuntimeContractError } from "./local-dev.ts";

// ---------------------------------------------------------------------------
// Host module resolution in local mode
// ---------------------------------------------------------------------------

/**
 * The table the local resolutions derive from.
 *
 * Recorded as the *name* rather than as a copy, so a reader can check the claim
 * "one table, two projections" by following one identifier.
 */
export const LOCAL_DEV_HOST_MAPPING_SOURCE = "HOST_BRIDGE_MAPPINGS";

/**
 * How a locally-resolved module id is supplied.
 *
 * `unsupported` exists so that "we have no local stand-in" is a value rather than
 * an absence. A module id that simply has no entry would be indistinguishable
 * from one nobody thought about, and #9's own deferred-module list exists for the
 * same reason.
 */
export const LOCAL_DEV_LOCAL_RESOLUTION_KINDS = ["npm-package", "project-shim", "unsupported"] as const;

export type LocalDevLocalResolutionKind = (typeof LOCAL_DEV_LOCAL_RESOLUTION_KINDS)[number];

/**
 * The recorded version fields the local process may be checked against.
 *
 * Both are read off the pinned target rather than stored again: `localDevRecordedVersion` is the
 * only way to obtain a value here, which means a version cannot be typed into a resolution row
 * and drift away from the contract it is supposed to be equal to.
 *
 * **Whether a field was observed in a browser is the contract's answer, not this list's.**
 * `localDevVersionFieldIsBrowserObserved` reads
 * `RUNTIME_CONTRACT_TARGET_FIELDS_NOT_BROWSER_OBSERVED`, which is empty on `12.0.102.0`: the
 * React, ReactDOM and Babel versions were read from real generated pages on that build, so a row
 * comparing a locally installed package against these values is comparing against a
 * browser-observed number. On `12.0.101.0` the same fields were established only from the shipped
 * runtime source and that list named them; the helper, not a comment, is what told a consumer the
 * difference then. #116's review is why the distinction is machine-readable: the re-base moved the
 * target while these fields kept values recorded on an older build, and a comment saying so would
 * not stop a consumer from reading them as re-verified.
 */
export const LOCAL_DEV_VERSION_FIELDS = ["hostReactVersion", "hostReactDomVersion"] as const;

export type LocalDevVersionField = (typeof LOCAL_DEV_VERSION_FIELDS)[number];

/** The value the pinned target records for a version field. The only source of an expected version. */
export function localDevRecordedVersion(field: LocalDevVersionField): string {
  return RUNTIME_CONTRACT_TARGET[field];
}

/**
 * Whether a version field's value was observed in a real browser on the target's own build.
 *
 * The consumer-facing half of the contract's provenance: a row that wants to say "this number is
 * verified for the build we ship against" asks here. On `12.0.102.0` it answers `true` for every
 * field this package compares, because the page reported them; on a build where the browser
 * observation is missing it answers `false` rather than the consumer having to know that a re-base
 * left the value in place.
 */
export function localDevVersionFieldIsBrowserObserved(field: LocalDevVersionField): boolean {
  return !RUNTIME_CONTRACT_TARGET_FIELDS_NOT_BROWSER_OBSERVED.includes(field);
}

export interface LocalDevModuleResolution {
  /**
   * The `#9` mapping row this projects.
   *
   * Must be a row `HOST_BRIDGE_MAPPINGS` actually contains. The row's module ids
   * are taken from the table (see `localDevModuleIdsOf`) rather than repeated
   * here, so a row that grows a subpath grows in this projection too, and the
   * coverage guard only has to police the direction a derivation cannot: a
   * resolution naming a row that does not exist.
   */
  readonly specifier: string;
  readonly resolution: LocalDevLocalResolutionKind;
  /**
   * The package or shim path the ids resolve to locally. Required unless
   * `unsupported`.
   *
   * A `project-shim` names the module or file the project supplies instead of a
   * package, which is why this is one field rather than a package name beside a
   * path: the harness resolves both the same way, and `localDevAlignmentChecks`
   * simply finds no installed version to compare for a shim.
   */
  readonly localPackage?: string;
  /**
   * The recorded field the local package's version is checked against, when one
   * exists.
   *
   * Absent is a statement rather than an oversight, which is why
   * {@link alignmentUnchecked} becomes required when it is: for `react-dom` the
   * bridge's lock has no field (see the row's note), and for `antd` no version was
   * ever recorded.
   */
  readonly checkedVersionField?: LocalDevVersionField;
  /** Required whenever no field can check this row's alignment. */
  readonly alignmentUnchecked?: string;
  readonly note: string;
}

/**
 * The local resolution for each of #9's host mappings.
 *
 * One row per bridge row. The `react-dom` row is the one worth reading in full:
 * it projects a row whose subpath #9 narrows to a `verified-member-view`, and
 * locally that narrowing does not happen — which makes the local loop *more
 * permissive* than the page in one specific place. Recording it is the point;
 * a harness that quietly reproduced the narrowing would be testing generated code
 * that #23 is not responsible for, and a harness that ignored the difference would
 * let a cell call `hydrateRoot` successfully forever.
 */
export const LOCAL_DEV_MODULE_RESOLUTIONS: readonly LocalDevModuleResolution[] = [
  {
    specifier: "react",
    resolution: "npm-package",
    localPackage: "react",
    checkedVersionField: "hostReactVersion",
    note: "The substitution that makes the local loop meaningful at all: cell UI running against React 19.2.7 locally is exercising the same hooks and the same JSX semantics the page will run. It is not evidence that the page's React object is the one the cell gets — #5 owns that, and only a page can show it.",
  },
  {
    specifier: "react-dom",
    resolution: "npm-package",
    localPackage: "react-dom",
    checkedVersionField: "hostReactDomVersion",
    note: "`react-dom/client` rides on this row exactly as it does in #9's table, and the version field is deliberately not the one #9's lock uses. The two questions differ: #9 asks whether the *page's* object is the one the artifact was compiled against, and `ForguncyTargetIdentity` carries only `hostReactVersion` for that; this row asks whether the package installed locally is the version the target ships, and #5's target record answers that for ReactDOM too. So the local check is one field richer than the lock's, and the reason is that no lock is involved. The narrowing #9 generates for the subpath has no local analogue and is deliberately not reproduced: locally `hydrateRoot` is simply present, while on the page it is refused with `host-member-not-verified` until #5 observes it. A local render is therefore *more permissive* here than the page, and must never be read as a stronger result.",
  },
  {
    specifier: "antd",
    resolution: "npm-package",
    localPackage: "antd",
    alignmentUnchecked:
      "#5 established that the `antd` global exists (`typeof antd === \"object\"`) and recorded no version for it, so there is no field to compare against. A local render therefore establishes that the cell's own use of the antd API is well formed, and nothing about the version, the theme, or the component set the page ships. Adding a version check would mean inventing the number to compare with.",
    note: "This is also the one bridge row whose global #5 measured as *conditionally* present — a cell that did not declare the AntDesign preset saw `antd === undefined` on the same page as a cell that did. Locally the package is always there, so the absent-antd branch of a cell is the branch the local loop will never take.",
  },
  {
    specifier: "react/jsx-runtime",
    resolution: "npm-package",
    localPackage: "react",
    alignmentUnchecked:
      "The JSX runtime ships inside the React package and has no version field of its own; it is the same substitution as the `react` row, and the alignment check for that row covers it.",
    note: "The published JSX runtime, never #9's generated adapter. The adapter exists because no page object has `react/jsx-runtime`'s shape; locally the published module does, and using it is what makes `vp dev` exercise the *cell's* keyed lists against a real runtime — which is the only way a keyed-list mistake in cell source surfaces during development. It follows, and this is the sentence to keep, that `vp dev` says nothing about the adapter: the adapter's evidence is its own regression suite plus a real page, and a green local render must not be read as adapter validation.",
  },
];

/**
 * The model the rows above are an instance of.
 *
 * The two `false`/`true` members are the ones a reviewer has to be able to check,
 * which is why they are data rather than a comment. `runsGeneratedBridgeModules`
 * is the load-bearing one: the generated module for a mapped import exists to bind
 * a page global, or to run the adapter that stands in for one, and locally there
 * is no page — so wiring the compiler's interpositions into Vite would not be a
 * resolution at all, it would be a failure deferred to the first import. The same
 * reasoning is why the mapping is reused as a *table* and not as generated source.
 */
export const LOCAL_DEV_HOST_RESOLUTION_MODEL = {
  mapsFrom: LOCAL_DEV_HOST_MAPPING_SOURCE,
  reusesTheHostBridgeMappingTable: true,
  secondMappingTable: false,
  runsGeneratedBridgeModules: false,
  resolvesToPublishedPackages: true,
  note: "The compile path and the dev path ask the same question of the same row — which module id is host-provided — and then answer it differently on purpose: the artifact binds the page's object, and the dev harness resolves the published package. Keeping one table is what stops a row being added for one path and forgotten in the other.",
} as const;

/**
 * Whether a member of a caller-supplied list can be read, and why not when it cannot.
 *
 * The lists a caller supplies reach this module through a cast from a JSON config,
 * so a member can be anything at all.
 *
 * These are **plain booleans, not `value is HostBridgeMapping` predicates**, and that
 * distinction is the whole point. A `value is X` guard is a promise about the complete
 * declared type, and checking one field does not make one: an earlier version of these
 * helpers tested `specifier` and then returned `value is LocalDevModuleResolution`, so
 * the compiler stopped objecting about fields nothing had looked at, and
 * `{ specifier: "react", moduleIds: 42 }` sailed past a guard whose name said the
 * whole row was sound. A boolean claims nothing beyond itself, so a reader that has
 * been through one still has to say which fields it uses — which is the honest
 * position, because these checks cover what the readers touch and not the whole type.
 *
 * Each check therefore covers exactly the fields its readers use, **and every reason a
 * member can fail one is also a reason the loud path reports it** — the guard for
 * resolution rows, `localDevModuleIdsOf` for bridge rows. Otherwise a member the
 * derivations skip would go missing with nothing saying so, which is worse than the
 * crash it replaced.
 */
function localDevBridgeRowProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "it is not a row at all";
  const row = value as { specifier?: unknown; moduleIds?: unknown };

  if (!isNonEmptyString(row.specifier)) return "it names no specifier";

  // `hostBridgeModuleIds` spreads this, so a non-list is a throw and a list holding
  // something that is not a module id is a worklist entry no module can match.
  if (row.moduleIds === undefined) return undefined;
  if (!Array.isArray(row.moduleIds)) return "its moduleIds is not a list";
  if (!row.moduleIds.every(entry => isNonEmptyString(entry))) {
    return "its moduleIds carries something that is not a module id";
  }
  return undefined;
}

/** The tolerant half of the check above, for the derivations that have to survive a broken table. */
function canReadBridgeRow(value: unknown): boolean {
  return localDevBridgeRowProblem(value) === undefined;
}

function localDevResolutionRowProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "it is not a row at all";
  const row = value as Record<string, unknown>;

  if (!isNonEmptyString(row.specifier)) return "it names no specifier";

  // The kind decides which set the row lands in, so an unrecognised one cannot be
  // treated as resolvable: every value except `unsupported` used to be, which is how a
  // row that resolved by nothing at all came back with a clean audit.
  const kind = row.resolution;
  if (!isNonEmptyString(kind) || !(LOCAL_DEV_LOCAL_RESOLUTION_KINDS as readonly string[]).includes(kind)) {
    return `its resolution "${String(kind)}" is not one of ${LOCAL_DEV_LOCAL_RESOLUTION_KINDS.join(", ")}`;
  }

  if (row.localPackage !== undefined && !isNonEmptyString(row.localPackage)) {
    return "its localPackage is not a package name";
  }

  // `localDevRecordedVersion` indexes the pinned target with this, so an unrecognised
  // field yields `undefined` where the type promises a version — a comparison that
  // silently never matches.
  if (row.checkedVersionField !== undefined) {
    if (
      !isNonEmptyString(row.checkedVersionField) ||
      !(LOCAL_DEV_VERSION_FIELDS as readonly string[]).includes(row.checkedVersionField)
    ) {
      // A string prints as itself so the message reads as a quotation of the row; anything else
      // is shown in its JSON form rather than as `[object Object]`.
      const declared =
        typeof row.checkedVersionField === "string"
          ? row.checkedVersionField
          : (JSON.stringify(row.checkedVersionField) ?? "");
      return `its checkedVersionField "${declared}" is not one of ${LOCAL_DEV_VERSION_FIELDS.join(", ")}`;
    }
  }

  if (row.alignmentUnchecked !== undefined && !isNonEmptyString(row.alignmentUnchecked)) {
    return "its alignmentUnchecked is not an explanation";
  }

  return undefined;
}

/** The tolerant half of the check above. */
function canReadResolutionRow(value: unknown): boolean {
  return localDevResolutionRowProblem(value) === undefined;
}

/** What to call a resolution row in a finding, or `undefined` when its name is not usable either. */
function localDevResolutionSubject(resolution: unknown): string | undefined {
  if (typeof resolution === "object" && resolution !== null) {
    const specifier = (resolution as { specifier?: unknown }).specifier;
    if (isNonEmptyString(specifier)) return `"${specifier}"`;
  }
  return undefined;
}

/**
 * The package or shim path a row resolves to, or `undefined` when it names none.
 *
 * One accessor for the field that turns a declared kind into an actual stand-in, because
 * `localPackage` is `unknown` in a table that arrived by cast: a reader that reached for it
 * directly would be assuming a shape nothing had checked, which is what
 * {@link localDevResolutionRowProblem} exists to prevent.
 */
function localDevResolutionTarget(resolution: LocalDevModuleResolution): string | undefined {
  const target = resolution.localPackage;
  return isNonEmptyString(target) ? target : undefined;
}

/**
 * Whether a row makes the claim {@link localDevResolvableModuleIds} is a list of.
 *
 * Two conditions, and the second is the one this exists for. A row has to declare a
 * stand-in — `unsupported` is the kind whose whole content is that it declares none — *and*
 * name the thing it resolves to. Being readable is not the same as resolving: the guard
 * refuses a row that declares a stand-in and names none ("there is nothing to resolve"), so
 * a worklist built out of readability alone listed a module id beside a finding that said
 * nothing resolves it. The claim and the list are now the same statement.
 */
function standsInForModuleId(resolution: LocalDevModuleResolution): boolean {
  return resolution.resolution !== "unsupported" && localDevResolutionTarget(resolution) !== undefined;
}

/**
 * The installed package a row's version can be compared against, or `undefined` when there is none.
 *
 * Narrower than {@link localDevResolutionTarget} on purpose, and the difference is the kind:
 * `npm-package` names a package the project's tree installs, which is the only thing "the
 * installed version equals the version #5's target ships" can be asked about. A `project-shim`
 * names a module or file the project supplies *instead of* a package — the row's own
 * `localPackage` doc says so — and there is no installed version of a source file to compare
 * against a host version. Reading the shared accessor alone derived
 * `Version checks: ./react-shim.ts===19.2.7`, and a matching key in `installedVersions`
 * produced a `local-dev-host-version-mismatch` for a shim.
 *
 * A shim stands in for a module id and does not carry a package-version check, so it belongs in
 * {@link localDevResolvableModuleIds} and not in {@link localDevAlignmentChecks} — which is why
 * this is a second accessor rather than a filter on the first.
 */
function localDevAlignmentTarget(resolution: LocalDevModuleResolution): string | undefined {
  return resolution.resolution === "npm-package" ? localDevResolutionTarget(resolution) : undefined;
}

/**
 * Why a row's kind and its substitution fields disagree, or `undefined` when they agree.
 *
 * One question — what does this row say stands in for the module id it names, and what does that
 * claim let it be asked? — with the three ways a row can contradict its own answer. All three
 * were review findings, in successive rounds:
 *
 * - it declares a stand-in and names none, so there is nothing to resolve;
 * - it declares none (`unsupported`) and carries a substitution's fields anyway, which are
 *   then read by nothing. Leaving them unread is not neutral: a project that names a package
 *   on such a row expects the local loop to use it, and the one reader that did pick them up
 *   derived a comparison the row's kind denies — the audit printed `Declared without a local
 *   stand-in: react` beside `Version checks: react===19.2.7`, and a mismatching
 *   `installedVersions.react` produced a `local-dev-host-version-mismatch` for a package
 *   nothing stands in for;
 * - it declares a `project-shim` and carries `checkedVersionField`, which is a package-version
 *   field on a row whose target is a module or file. A shim does stand in for a module id, so
 *   it is not `unsupported` and not refused for naming nothing — what it cannot do is name an
 *   installed version, and `alignmentUnchecked` is the field for saying why none exists.
 *
 * {@link standsInForModuleId} and {@link localDevAlignmentTarget} are the same questions asked
 * positively, which is why the guard and the derivations share the accessors rather than each
 * reading `localPackage` for itself.
 */
function localDevSubstitutionProblem(resolution: LocalDevModuleResolution): string | undefined {
  const target = localDevResolutionTarget(resolution);
  const versionField = resolution.checkedVersionField;

  if (resolution.resolution === "unsupported") {
    const stale = [
      target === undefined ? undefined : `localPackage "${target}"`,
      versionField === undefined ? undefined : `checkedVersionField "${versionField}"`,
    ].filter((field): field is string => field !== undefined);

    return stale.length === 0
      ? undefined
      : `is "unsupported", so nothing stands in for it, and still carries ${stale.join(" and ")} — fields that are read by nothing, because there is no substitution to resolve or to compare`;
  }

  if (target === undefined) {
    return `is "${resolution.resolution}" and names no package, so there is nothing to resolve`;
  }

  if (resolution.resolution === "project-shim" && versionField !== undefined) {
    return `is "project-shim" and carries checkedVersionField "${versionField}", and a shim is a module or file the project supplies: there is no installed version of it to compare against #5's recorded target. State why no comparison exists in alignmentUnchecked instead`;
  }

  return undefined;
}

/**
 * Whether the audit can read a decision's strategy and the package it names.
 *
 * Those are the two members the audit uses: `strategy` to find the `extension` rows,
 * and `packageName` as the key that matches a decision to its choice — and as the
 * subject of any finding about it. A member failing this is left out of the coverage
 * question in both directions rather than read anyway, because a decision that names no
 * package would otherwise reach the report as a finding about `undefined`, and one whose
 * strategy is not a strategy cannot be classified at all.
 *
 * What is deliberately *not* duplicated here is the record's own shape: `core` owns that
 * (`validateDependencyDecisionShape`), and a local finding about it would report one
 * mistake twice. This module validates the vocabulary it invents — the extension choices
 * are #22's own, so `local-dev-extension-choice-malformed` is theirs — and for a record
 * another module owns it checks only that its own two reads are safe. That is the same
 * boundary the audit declares for containers, applied to a member: the reader says what
 * it used and stops, rather than re-deriving a verdict it is not the owner of.
 */
export function canReadDecision(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const decision = value as { strategy?: unknown; packageName?: unknown };
  return (
    isNonEmptyString(decision.strategy) &&
    (DEPENDENCY_STRATEGIES as readonly string[]).includes(decision.strategy) &&
    isNonEmptyString(decision.packageName)
  );
}

/**
 * The bridge row a local resolution projects, or `undefined`.
 *
 * The non-throwing half of {@link localDevModuleIdsOf}, and the split is the
 * point rather than an accident: a **guard** has to fail loudly on a row that does
 * not exist, while a **report** has to survive the same input long enough to
 * describe it. Anything derived after the coverage guard therefore goes through
 * here, or an orphan resolution row turns into an exception and takes the rest of
 * the audit with it.
 *
 * `undefined` rather than a default, for the reason
 * {@link findLocalDevModuleIdResolution} returns one: a specifier the table does
 * not carry has no bridge row, and inventing one would make an orphan look
 * covered.
 *
 * A row that cannot be read is also not returned — {@link canReadBridgeRow} says
 * which rows those are — so `undefined` covers two situations, "no row names this
 * specifier" and "a row names it and is not readable", and this return type does not
 * distinguish them. {@link localDevModuleIdsOf} is where the difference is said in
 * words, because a reader sent to look for a missing row that is right there is no
 * closer to a fix than one sent to repair a row it was told is missing.
 */
export function findLocalDevBridgeRow(
  specifier: string,
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): HostBridgeMapping | undefined {
  return mappings.find(candidate => canReadBridgeRow(candidate) && candidate.specifier === specifier);
}

/**
 * Why no usable bridge row was found for a specifier, in words.
 *
 * The two situations above call for different sentences, so the guard asks for one of
 * them by name instead of reporting both as absence. Which rows are unreadable is read
 * off {@link localDevBridgeRowProblem}, the same check the derivations filter with, so
 * a row cannot be refused by one and accepted by the other.
 *
 * A row that is neither absent nor unreadable cannot reach here, because
 * {@link findLocalDevBridgeRow} would have returned it. Rows that share a specifier are
 * read in table order and the first readable one decides, which is the same row the
 * lookup would have returned.
 */
function localDevNoUsableBridgeRow(specifier: string, mappings: readonly HostBridgeMapping[]): string {
  const named = (mappings as readonly unknown[]).filter(
    candidate =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { specifier?: unknown }).specifier === specifier,
  );
  const problem = named.map(localDevBridgeRowProblem).find(reason => reason !== undefined);
  if (problem === undefined) {
    return `The local resolution rows name "${specifier}", which is not a row of the host bridge mapping table.`;
  }
  return `The local resolution rows name "${specifier}", and the host bridge row that carries it cannot be read: ${problem}. Every module id that row intercepts is unaccounted for while it stays that way, so its module ids cannot be taken from it.`;
}

/**
 * Every module id a resolution row covers, read from the bridge table.
 *
 * The loud reader: `undefined` from {@link findLocalDevBridgeRow} stops the run, and
 * the message says which of the two reasons it stopped for. A row whose `moduleIds` is
 * not a list is refused here by name rather than by `hostBridgeModuleIds` spreading a
 * number, which is what the refusal has to say to be about the table instead of about
 * the run.
 */
export function localDevModuleIdsOf(
  specifier: string,
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): readonly string[] {
  const mapping = findLocalDevBridgeRow(specifier, mappings);
  if (mapping === undefined) {
    throw new LocalDevRuntimeContractError("mapping-coverage", localDevNoUsableBridgeRow(specifier, mappings));
  }
  return hostBridgeModuleIds(mapping);
}

/**
 * The module ids of a row, or none when the row does not exist.
 *
 * The tolerant form, used by every derivation the audit performs *after* the
 * coverage guard. An orphan row contributes no module ids rather than a fabricated
 * one: the guard is what reports that the row exists, and these lists are the
 * harness's worklist, which cannot contain a module id nothing resolves.
 *
 * A row that cannot be read contributes nothing either, and for the same reason
 * rather than by accident. The guard refuses a table containing one — that refusal is
 * what `local-dev-mapping-coverage` carries — and the audit continues past it with the
 * finding recorded, so a derivation reached with a broken row in hand is one whose
 * caller has already been told. Throwing here would replace that finding with a stack
 * trace in the middle of a list, which is the failure this pair was split to prevent.
 */
function moduleIdsOfExistingRow(
  specifier: string,
  mappings: readonly HostBridgeMapping[],
): readonly string[] {
  const mapping = findLocalDevBridgeRow(specifier, mappings);
  return mapping === undefined ? [] : hostBridgeModuleIds(mapping);
}

/**
 * Refuse a projection that does not cover the bridge table exactly.
 *
 * Both directions, because "not in the set" is not "is its complement" (#14's
 * first review finding): a module id the table intercepts and this projection
 * omits is a module the dev harness would silently leave to the ordinary npm path
 * while the artifact binds it to a page global; a module id this projection names
 * and the table does not intercept is a resolution that promises to stand in for
 * something that was never decided.
 *
 * The guard takes the table as a parameter for the reason #9's guards do: a
 * project that extends the table has to extend the projection in the same change,
 * and that has to fail loudly rather than at the first unresolved import.
 *
 * Both tables arrive through a cast from a JSON config, so a member can be anything
 * at all, and each member is checked before anything is read off it. That ordering is
 * the check's own value: `hostBridgeModuleIds` spreads `moduleIds`, so a row carrying
 * `42` there would end the run in a `TypeError` from inside the spread, and a
 * resolution row whose `resolution` is not one of the three kinds would pass every
 * question below it — it neither says `unsupported` nor names no package nor lacks a
 * version field — and then drop out of both the resolvable and the unsupported list,
 * leaving a clean audit with nothing to say the row existed. A member that cannot be
 * read is refused here, where there is one check to change, rather than read around.
 */
export function assertLocalDevResolutionsCoverHostBridge(
  resolutions: readonly LocalDevModuleResolution[] = LOCAL_DEV_MODULE_RESOLUTIONS,
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): void {
  for (const mapping of mappings) {
    const problem = localDevBridgeRowProblem(mapping);
    if (problem !== undefined) {
      throw new LocalDevRuntimeContractError(
        "mapping-coverage",
        `A row of the host bridge mapping table cannot be read: ${problem}, so the module ids it intercepts are unaccounted for. The table is refused rather than read around.`,
      );
    }
  }

  for (const resolution of resolutions) {
    const problem = localDevResolutionRowProblem(resolution);
    if (problem !== undefined) {
      const named = localDevResolutionSubject(resolution);
      throw new LocalDevRuntimeContractError(
        "mapping-coverage",
        `${named === undefined ? "A local resolution row" : `The local resolution row ${named}`} cannot be read: ${problem}. Its kind is what decides which module ids it stands in for, so a row like that would resolve by nothing and say nothing about it.`,
      );
    }
  }

  const intercepted = new Set(hostBridgeInterceptedModuleIds(mappings));
  const covered = new Set<string>();

  for (const resolution of resolutions) {
    // Throws when the row does not exist, which is the other half of the check.
    const moduleIds = localDevModuleIdsOf(resolution.specifier, mappings);
    for (const moduleId of moduleIds) {
      if (covered.has(moduleId)) {
        throw new LocalDevRuntimeContractError(
          "mapping-coverage",
          `Module id "${moduleId}" is resolved by more than one local resolution row, so which package it loads would depend on row order.`,
        );
      }
      covered.add(moduleId);
    }

    // What the row says stands in for its module id, and whether its own fields agree with
    // that answer. Both ways of disagreeing stop the run, because both leave the harness
    // without an answer it can act on.
    const substitution = localDevSubstitutionProblem(resolution);
    if (substitution !== undefined) {
      throw new LocalDevRuntimeContractError(
        "mapping-coverage",
        `Local resolution "${resolution.specifier}" ${substitution}.`,
      );
    }

    if (resolution.checkedVersionField === undefined && resolution.alignmentUnchecked === undefined) {
      throw new LocalDevRuntimeContractError(
        "mapping-coverage",
        `Local resolution "${resolution.specifier}" neither checks a version field nor says why none can check it, so its alignment reads as verified while nothing verified it.`,
      );
    }
  }

  const missing = [...intercepted].filter(moduleId => !covered.has(moduleId));
  if (missing.length > 0) {
    throw new LocalDevRuntimeContractError(
      "mapping-coverage",
      `The host bridge intercepts ${missing.join(", ")}, and the local resolution table has no row for it. A module the artifact binds to a page global must say what the dev harness resolves instead, or the local loop silently tests a different module.`,
    );
  }

  const orphans = [...covered].filter(moduleId => !intercepted.has(moduleId));
  if (orphans.length > 0) {
    throw new LocalDevRuntimeContractError(
      "mapping-coverage",
      `The local resolution table resolves ${orphans.join(", ")}, which the host bridge does not intercept, so it stands in for a module no decision covers.`,
    );
  }
}

/**
 * A module id the dev harness can stand in for.
 *
 * Tolerant of an orphan resolution row, because this is one of the lists the
 * audit derives after the coverage guard has run: a row whose specifier the table
 * does not carry contributes nothing here, and
 * `local-dev-mapping-coverage` is what says so. Reporting the orphan *and* handing
 * back a worklist the harness cannot act on are different jobs.
 *
 * A row whose kind is not one of the three is left out for the same reason: which list
 * it belongs in is decided by that kind, and nothing here may decide "resolvable" for a
 * row that resolved by nothing. The guard refuses such a row by name, so leaving it out
 * here is not the last word about it.
 *
 * A row that declares a stand-in and names none is left out too, and this is the list
 * where that matters most: {@link standsInForModuleId} is the same condition the guard
 * refuses such a row with, so the worklist cannot claim a stand-in beside a finding that
 * says there is nothing to resolve. It is the second reading of one rule, not a second
 * rule — the row is refused by name and reported as `local-dev-mapping-coverage`, and this
 * list simply does not claim what that finding denies. It is deliberately in *neither*
 * list rather than moved to {@link localDevUnsupportedModuleIds}: "nothing stands in for
 * this" is a statement the row did not make, and reporting it as one would be a second
 * finding about one mistake, in a different code, with different advice.
 */
export function localDevResolvableModuleIds(
  resolutions: readonly LocalDevModuleResolution[] = LOCAL_DEV_MODULE_RESOLUTIONS,
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): readonly string[] {
  return resolutions
    .filter(canReadResolutionRow)
    .filter(standsInForModuleId)
    .flatMap(resolution => moduleIdsOfExistingRow(resolution.specifier, mappings));
}

/** A module id the table intercepts and no local resolution covers. Tolerant, for the reason above. */
export function localDevUnsupportedModuleIds(
  resolutions: readonly LocalDevModuleResolution[] = LOCAL_DEV_MODULE_RESOLUTIONS,
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): readonly string[] {
  return resolutions
    .filter(canReadResolutionRow)
    .filter(resolution => resolution.resolution === "unsupported")
    .flatMap(resolution => moduleIdsOfExistingRow(resolution.specifier, mappings));
}

/**
 * The bridge rows whose local substitution carries a version check.
 *
 * A substitution is what makes the comparison mean anything, and a substitution of a *package*
 * is what makes it answerable, which is why the target comes from
 * {@link localDevAlignmentTarget} rather than from {@link standsInForModuleId}: a row can stand
 * in for a module id with a shim and still have no installed version to compare. Filtering on the
 * broader predicate derived `Version checks: ./react-shim.ts===19.2.7` and, given a matching key
 * in `installedVersions`, a `local-dev-host-version-mismatch` about a source file.
 *
 * A `project-shim` that carries `checkedVersionField` at all is refused by the guard, so the two
 * readers agree: this list is the installed packages whose version can be compared, and the guard
 * says when a row asks for that comparison without having one to make. The expected values are
 * still read off #5's pinned target and never stored.
 */
export function localDevAlignmentChecks(
  resolutions: readonly LocalDevModuleResolution[] = LOCAL_DEV_MODULE_RESOLUTIONS,
): readonly LocalDevAlignmentExpectation[] {
  return resolutions
    .filter(canReadResolutionRow)
    .flatMap(resolution => {
      const field = resolution.checkedVersionField;
      const packageName = localDevAlignmentTarget(resolution);
      if (field === undefined || packageName === undefined) return [];
      return [
        {
          specifier: resolution.specifier,
          localPackage: packageName,
          field,
          expected: localDevRecordedVersion(field),
        },
      ];
    });
}

export interface LocalDevAlignmentExpectation {
  readonly specifier: string;
  readonly localPackage: string;
  readonly field: LocalDevVersionField;
  /** #5's recorded value, obtained through {@link localDevRecordedVersion} and never stored. */
  readonly expected: string;
}

/** The bridge rows the local resolution table covers, in table order. */
export function localDevResolvedBridgeRows(
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): readonly HostBridgeMapping[] {
  return mappings.filter(mapping =>
    LOCAL_DEV_MODULE_RESOLUTIONS.some(resolution => resolution.specifier === mapping.specifier),
  );
}

export interface LocalDevModuleIdResolution {
  /** The exact module id asked about, which is not necessarily a row's specifier. */
  readonly moduleId: string;
  /** The row that intercepts it. */
  readonly specifier: string;
  readonly resolution: LocalDevModuleResolution;
}

/**
 * How one module id resolves locally, by exact id.
 *
 * The lookup a caller actually needs, and the reason it exists is visible in #9's
 * own table: `react-dom/client` and `react/jsx-dev-runtime` are module ids that are
 * *not* row specifiers, so a row-keyed lookup answers "no row" for two ids the
 * bridge does intercept. Asking by module id is what makes the projection usable
 * per import.
 *
 * `undefined` rather than a default, and that is the load-bearing part: an id the
 * bridge does not intercept has no local resolution, and returning "the ordinary
 * npm path will handle it" would be exactly the assumption that hides a bridged
 * import — the two cases look identical from inside a module graph and are not the
 * same statement.
 *
 * Two members are asked, and each is asked only after the check that covers what is
 * read off it: {@link canReadBridgeRow} decides whether a row can say which ids it
 * intercepts at all, and {@link canReadResolutionRow} whether a row can say what stands
 * in for the one it names. So `undefined` here also covers "a row that could not be
 * read", and this return type does not distinguish it from "no row" — which is the
 * deliberate boundary, because the answer that would matter, "the ordinary npm path
 * will handle it", must not be handed out on the strength of a row nobody could read.
 * {@link assertLocalDevResolutionsCoverHostBridge} is what refuses such a table; a
 * caller that needs the two told apart has to have run it.
 */
export function findLocalDevModuleIdResolution(
  moduleId: string,
  resolutions: readonly LocalDevModuleResolution[] = LOCAL_DEV_MODULE_RESOLUTIONS,
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): LocalDevModuleIdResolution | undefined {
  const mapping = mappings.find(
    candidate => canReadBridgeRow(candidate) && hostBridgeModuleIds(candidate).includes(moduleId),
  );
  if (mapping === undefined) return undefined;

  const resolution = resolutions.find(
    candidate => canReadResolutionRow(candidate) && candidate.specifier === mapping.specifier,
  );
  if (resolution === undefined) return undefined;

  return { moduleId, specifier: mapping.specifier, resolution };
}

/**
 * #9's deferred modules, surfaced because the local loop has a specific blind spot
 * about them.
 *
 * They are absent from the mapping table, so they are absent from the resolution
 * projection too — and that is correct. What is not obvious is the *consequence*:
 * locally an `import dayjs from "dayjs"` simply resolves through the ordinary npm
 * path and works, because nothing has told Vite otherwise. On the page, no bridge
 * row binds that import either, and #9 deferred the row rather than deciding it.
 * So the import works in both places for different reasons, and a local render
 * establishes nothing about which way #9 will eventually resolve it.
 */
export function localDevDeferredHostModules(): readonly HostBridgeDeferredModule[] {
  return HOST_BRIDGE_DEFERRED_MODULES;
}

