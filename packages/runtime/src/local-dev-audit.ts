/**
 * Auditing a local configuration, moved verbatim from `local-dev.ts` (#160).
 *
 * `local-dev.ts` remains that contract's module doc and the home of the sections it keeps; this
 * file holds the single pass that turns a local configuration into findings and worklists.
 */

import { HOST_BRIDGE_MAPPINGS, packageNameOfSpecifier } from "@forguncy-react-workspace/core/browser";
import type { DependencyDecision, HostBridgeMapping } from "@forguncy-react-workspace/core/browser";

import type { RuntimeFacadeHostBindings } from "./contract.ts";
import {
  assertLocalDevMockSuppliesEveryBaseProp,
  localDevChoiceSubject,
  localDevExtensionChoiceProblem,
} from "./local-dev.ts";
import { localDevRealRuntimeOwedChecks } from "./local-dev-claims.ts";
import { createLocalDevDiagnostic, formatLocalDevDiagnostics } from "./local-dev-diagnostics.ts";
import type { LocalDevDiagnostic } from "./local-dev-diagnostics.ts";
import {
  assertLocalDevResolutionsCoverHostBridge,
  canReadDecision,
  LOCAL_DEV_MODULE_RESOLUTIONS,
  localDevAlignmentChecks,
  localDevDeferredHostModules,
  localDevResolvableModuleIds,
  localDevUnsupportedModuleIds,
} from "./local-dev-host-modules.ts";
import type {
  LocalDevAlignmentExpectation,
  LocalDevModuleResolution,
} from "./local-dev-host-modules.ts";
import type { LocalDevExtensionChoice } from "./local-dev.ts";
import type { LocalDevOwedCheck } from "./local-dev-claims.ts";

// ---------------------------------------------------------------------------
// Auditing a local configuration
// ---------------------------------------------------------------------------

export interface LocalDevAuditInput {
  readonly resolutions?: readonly LocalDevModuleResolution[];
  readonly mappings?: readonly HostBridgeMapping[];
  /** The decisions the project's lock carries, when the caller knows them. */
  readonly decisions?: readonly DependencyDecision[];
  /**
   * What the project decided about each of its `extension` dependencies.
   *
   * Both of #22's branches arrive here — a substitute and a `real-runtime-only`
   * acknowledgement are the same field with different modes — because a project that
   * chose the second branch is not missing a value, and an input shape that could not
   * express its choice would report a recorded decision as an omission.
   *
   * The declared type is the contract; the list is still inspected at runtime rather
   * than trusted, because a project config read from JSON reaches the audit through
   * a cast. Each package may appear **at most once**: two entries for one package are
   * two readings of one decision, and the audit refuses the pair instead of letting
   * the array's order pick a branch.
   */
  readonly extensionChoices?: readonly LocalDevExtensionChoice[];
  /** The versions the local process actually resolved, keyed by package name. */
  readonly installedVersions?: Readonly<Record<string, string>>;
  /** The mock host surface, when one is configured. */
  readonly mockBindings?: RuntimeFacadeHostBindings;
  /**
   * The specifiers the cell source references, when the caller knows them.
   *
   * Omitting it means "the caller did not say", not "the cell references nothing":
   * with no list there is nothing to say about deferred modules, and the audit
   * reports nothing rather than reporting a clean result for a question it did not
   * ask.
   */
  readonly referencedSpecifiers?: readonly string[];
  /**
   * The aliases the project's `vite.config.ts` declares, when the caller knows them.
   *
   * Compared against {@link LocalDevAuditInput.projectAlias} to find an overlap, which is the one
   * way a project alias can be silently overridden locally. The values are opaque here: this audit
   * compares *keys*, because whether two patterns overlap is a question about Vite's matching rule
   * and the caller (the harness) already reads that rule to filter its own host aliases. Passing
   * only the keys would be narrower than the truth, since an overlap is a prefix relation on either
   * side of the pair.
   */
  readonly userAliasKeys?: readonly string[];
  /**
   * Project keys a `RegExp` alias in `vite.config.ts` was measured to shadow, with the pattern that
   * did it.
   *
   * Separate from {@link LocalDevAuditInput.userAliasKeys} because a pattern cannot be compared as a
   * string without losing its meaning: `^@APP\/SHARED(?=\/|$)/i`, `^other|@app\/shared/` and
   * `^@app\/\x73hared` all match `@app/shared/thing` and none of them reads as `@app/shared`. The
   * caller therefore runs the pattern against the specifiers the alias can match and reports the
   * verdict; this audit only names it, which is why `pattern` is carried verbatim — the message
   * has to quote something the developer can find in their own file.
   */
  readonly userAliasPatterns?: readonly { readonly key: string; readonly pattern: string }[];
  /**
   * The project's own aliases, as `registry.resolve.alias` carries them (#97).
   *
   * Only the keys matter to this audit; the values are for the report.
   */
  readonly projectAlias?: Readonly<Record<string, string>>;
}

export interface LocalDevAudit {
  readonly diagnostics: readonly LocalDevDiagnostic[];
  /**
   * The module ids the harness can stand in for.
   *
   * A row contributes here only when it makes that claim: it declares a stand-in and names
   * the package or shim path it resolves to ({@link standsInForModuleId}). Readable is not
   * the claim, so a row the guard refused for naming nothing to resolve is absent here even
   * though the row is present in the table.
   */
  readonly resolvable: readonly string[];
  /**
   * The module ids whose row declares no local stand-in (`unsupported`).
   *
   * Not the complement of {@link resolvable} when a table is broken: a row that declares a
   * stand-in and names none contributes to *neither* list, because "nothing stands in for
   * this module" is a statement that row did not make. `local-dev-mapping-coverage` is the
   * one report about it, and it names the row rather than the module ids it would have
   * covered.
   */
  readonly unresolved: readonly string[];
  /** The version comparisons the harness has to make, with #5's expected values. */
  readonly alignment: readonly LocalDevAlignmentExpectation[];
  /**
   * The packages the project deliberately left to real-runtime validation.
   *
   * Separate from {@link diagnostics} because it is not a problem: it is the list of
   * dependencies the local loop provably cannot exercise, which a report has to be
   * able to print without calling them findings.
   */
  readonly realRuntimeOnly: readonly string[];
  /** Everything the local loop cannot establish, for a report. */
  readonly owed: readonly LocalDevOwedCheck[];
}

/**
 * Everything wrong with a local configuration, in one pass.
 *
 * Built the way #9's `planHostBridge` is, and for the same reason: a configuration
 * error should come back as a finding the caller can print, not as an exception
 * that abandons the rest of the audit. So the table guards are called and their
 * throws converted, and the checks that need a caller-supplied input abstain when
 * it was not supplied rather than treating "not stated" as "empty".
 *
 * The no-throw promise covers the *whole* function, not only the guards it calls
 * explicitly, and that is a stronger statement than it looks: an input bad enough
 * to trip the coverage guard is exactly the input the derivations below still have
 * to survive, which is why they go through `moduleIdsOfExistingRow` rather than
 * through `localDevModuleIdsOf`. A report that throws while describing a problem has
 * replaced its own diagnostic with a stack trace.
 *
 * The scope of that promise, stated exactly, because two earlier wordings claimed
 * more than the code did. It covers the **members** of every caller-supplied list.
 * Those lists arrive from a JSON config through a cast, so a member can be anything:
 * `extensionChoices` members go through `localDevExtensionChoiceProblem`, which takes
 * `unknown` and answers with a finding; `resolutions` and `mappings` members are put
 * through a shape predicate before any helper reads a field off them; `decisions` and
 * `referencedSpecifiers` members are skipped when they do not carry the one field the
 * reader touches, since a value that is not a decision or not a specifier cannot
 * answer the question being asked of it.
 *
 * What it does not cover is a **container** whose own declared type is violated —
 * `extensionChoices: 42`, `resolutions: null`, `installedVersions: null` — where
 * iteration or indexing fails before there is any member to inspect. That boundary is
 * the declared type's job, and the audit names it rather than pretending to a totality
 * it could only have by re-declaring every input as `unknown`.
 */
export function auditLocalDevConfiguration(input: LocalDevAuditInput = {}): LocalDevAudit {
  const resolutions = input.resolutions ?? LOCAL_DEV_MODULE_RESOLUTIONS;
  const mappings = input.mappings ?? HOST_BRIDGE_MAPPINGS;
  const diagnostics: LocalDevDiagnostic[] = [];

  try {
    assertLocalDevResolutionsCoverHostBridge(resolutions, mappings);
  } catch (error) {
    diagnostics.push(
      createLocalDevDiagnostic(
        "local-dev-mapping-coverage",
        "local-resolution-table",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  const unsupported = localDevUnsupportedModuleIds(resolutions, mappings);
  for (const moduleId of unsupported) {
    diagnostics.push(
      createLocalDevDiagnostic(
        "local-dev-no-local-stand-in",
        moduleId,
        "This module id is bridged for the page and has no local stand-in, so nothing exercises it during development.",
      ),
    );
  }

  // Deferred modules are reached through the ordinary npm path locally, which is
  // why the finding is about what a local render proves rather than about
  // resolution failing.
  const deferred = localDevDeferredHostModules();
  for (const specifier of input.referencedSpecifiers ?? []) {
    // A member that is not a string is not a specifier, so it cannot be a deferred
    // module either: the question this loop asks has the answer "no" for it, and
    // saying so by skipping is the only reading that neither throws nor invents a
    // finding about a value the audit has no vocabulary for.
    if (typeof specifier !== "string") continue;
    const packageName = packageNameOfSpecifier(specifier);
    const deferredModule = deferred.find(candidate => candidate.specifier === packageName);
    if (deferredModule === undefined) continue;
    diagnostics.push(
      createLocalDevDiagnostic(
        "local-dev-deferred-host-module",
        specifier,
        `#9 deferred this mapping rather than deciding it (${deferredModule.reason} What it still requires: ${deferredModule.requires}) It resolves locally through the ordinary npm path, so a local render says nothing about how it will bind on the page.`,
      ),
    );
  }

  // Two properties of the declaration list, both checked before anything reads it:
  // every entry has to be a decision, and no package may carry two.
  //
  // Neither check trusts the declared type. A config read from JSON arrives as
  // `unknown` and the cast that turns it into `LocalDevExtensionChoice[]` is the
  // caller's, so every member is inspected before it is touched — and an entry the
  // validator rejects never becomes a map key, which is what stops the duplicate
  // check from being the place a number gets used as a package name.
  const wellFormedChoices: LocalDevExtensionChoice[] = [];
  const reportedChoices = new Set<string>();
  for (const choice of input.extensionChoices ?? []) {
    const problem = localDevExtensionChoiceProblem(choice);
    if (problem === undefined) {
      wellFormedChoices.push(choice);
      continue;
    }
    const subject = localDevChoiceSubject(choice);
    reportedChoices.add(subject);
    diagnostics.push(
      createLocalDevDiagnostic(
        "local-dev-extension-choice-malformed",
        subject,
        `The declared choice is not a decision: ${problem}. An entry that has learned the vocabulary but not the content is an omission, so it is reported as one rather than counted as the branch it names.`,
      ),
    );
  }

  const choiceOccurrences = new Map<string, number>();
  for (const choice of wellFormedChoices) {
    choiceOccurrences.set(choice.packageName, (choiceOccurrences.get(choice.packageName) ?? 0) + 1);
  }

  const declaredChoices = new Map<string, LocalDevExtensionChoice>();
  for (const choice of wellFormedChoices) {
    const occurrences = choiceOccurrences.get(choice.packageName) ?? 0;
    if (occurrences > 1) {
      if (reportedChoices.has(choice.packageName)) continue;
      reportedChoices.add(choice.packageName);
      diagnostics.push(
        createLocalDevDiagnostic(
          "local-dev-extension-choice-duplicated",
          choice.packageName,
          `Declared ${occurrences} times. Neither entry is used: with both present, which branch applies would depend on the order of the list, so the decision is reported as unresolved rather than resolved by position.`,
        ),
      );
      continue;
    }
    declaredChoices.set(choice.packageName, choice);
  }

  // The other direction of the same coverage question, and only when the caller
  // stated the decisions at all: a choice whose package the decision list does not
  // carry as `extension` is the local half of a decision that no longer exists —
  // what is left behind when a package moves from `extension` to `inline`. Checked as
  // a pair with the loop below, for the reason the resolution table is checked both
  // ways: "every extension decision has a choice" and "every choice has an extension
  // decision" are different statements, and asking only the first reads as a pass for
  // a record that disagrees with itself. No `decisions` means the caller did not say,
  // so the cross-check abstains rather than guessing.
  if (input.decisions !== undefined) {
    const extensionDecisions = new Set(
      input.decisions
        .filter(canReadDecision)
        .filter(decision => decision.strategy === "extension")
        .map(decision => decision.packageName),
    );
    for (const choice of declaredChoices.values()) {
      if (extensionDecisions.has(choice.packageName)) continue;
      diagnostics.push(
        createLocalDevDiagnostic(
          "local-dev-extension-choice-unmatched",
          choice.packageName,
          "A choice is the local half of a dependency decision, and no decision in the supplied list carries this package as an `extension` — the decision moved to another strategy, or it is gone. The entry is used for nothing and nothing else would report it, so it is surfaced here rather than left for someone to trust later.",
        ),
      );
    }
  }

  const realRuntimeOnly: string[] = [];
  for (const decision of input.decisions ?? []) {
    // A member whose strategy is not a string cannot be an `extension` decision, so
    // it has no local half to check and nothing to contribute to the coverage
    // question. Same reading as a non-string specifier above. A member that names no
    // package is left out with it: `packageName` is both the key this loop matches
    // choices by and the subject of the findings it raises, so reading a decision that
    // lacks one would put `undefined` in a report. What that leaves uncovered is the
    // record's own shape, which is `core`'s question (`validateDependencyDecisionShape`)
    // rather than this audit's — and a local finding about it would report one mistake
    // twice, once here and once from the validator that owns it.
    if (!canReadDecision(decision)) continue;
    if (decision.strategy !== "extension") continue;
    // The package already carries a finding about the choice it declared, so saying
    // "no choice is declared" next to it would be a second finding for one mistake.
    if (reportedChoices.has(decision.packageName)) continue;

    const choice = declaredChoices.get(decision.packageName);
    if (choice === undefined) {
      diagnostics.push(
        createLocalDevDiagnostic(
          "local-dev-extension-needs-substitute",
          decision.packageName,
          "The decision is `extension` and no local choice is declared, so the cell cannot be exercised locally as written. Declaring a substitute records why the published package or shim is an acceptable stand-in; declaring `real-runtime-only` records that validation happens on the page instead.",
        ),
      );
      continue;
    }

    if (choice.mode === "real-runtime-only") {
      realRuntimeOnly.push(choice.packageName);
      diagnostics.push(
        createLocalDevDiagnostic(
          "local-dev-extension-real-runtime-only",
          choice.packageName,
          `Recorded as needing real-runtime validation: ${choice.reason} Consequently ${choice.consequence}`,
        ),
      );
    }
  }

  // #97 round 4: a `vite.config.ts` alias that overlaps a project alias silently wins locally.
  //
  // Vite applies the user's `resolve.alias` **before** a plugin's `resolveId`, and the project
  // aliases are applied in the harness plugin's `resolveId` — so a user alias naming an overlapping
  // id rewrites the import first. The Cell build reads `registry.resolve.alias` and never sees
  // `vite.config.ts`, so both paths succeed and resolve one import to different files.
  //
  // The overlap is **symmetric**: either key being a prefix of the other (on a `/` boundary) is
  // enough, because any specifier both match goes to the user's entry. Measured for a project alias
  // `@/ui -> ./ui`: `vite.config.ts`'s `@/ui -> /local` wins for `@/ui/thing`, and so does its
  // deeper `@/ui/thing -> /sub` — the second is the case a one-directional check misses.
  //
  // The caller supplies the user's keys already read by Vite's own matching rule, so this does not
  // re-derive one: `runtime` may not depend on Vite, and a second copy of that rule is what took
  // three review rounds to get right in the harness.
  const projectAlias = input.projectAlias ?? {};
  for (const [moduleId, target] of Object.entries(projectAlias)) {
    // Two inputs, two questions. A **string** key is compared here, because reproducing Vite's
    // prefix rule is what `runtime` may not do (three review rounds went into the harness's copy of
    // it), so the harness hands over strings and this comparison is plain string work.
    //
    // A **RegExp** cannot be reduced to a string that keeps its meaning — `^@APP\/SHARED(?=\/|$)/i`
    // and `^other|@app\/shared/` both evade any literal or prefix comparison — so the harness runs
    // the pattern itself against the specifiers this alias can match and hands over only the keys it
    // actually shadows. That answer is a fact rather than a re-derivation, and this audit only has to
    // report it, naming the pattern the way the developer wrote it.
    const overlappingPattern = (input.userAliasPatterns ?? []).find(entry => entry.key === moduleId);
    if (overlappingPattern !== undefined) {
      diagnostics.push(
        createLocalDevDiagnostic(
          "local-dev-project-alias-shadowed",
          moduleId,
          `\`vite.config.ts\` declares a pattern alias ${JSON.stringify(overlappingPattern.pattern)} that matches "${moduleId}", which \`forguncy.config.ts\` already resolves to ${JSON.stringify(target)}. Vite applies its own aliases before the harness resolver, so the local loop would use the Vite target while the Cell build uses ${JSON.stringify(target)}. Remove the overlapping entry, or replace it with a plain string alias if that is what it means.`,
        ),
      );
      continue;
    }

    const overlapping = (input.userAliasKeys ?? []).find(
      key => key === moduleId || key.startsWith(`${moduleId}/`) || moduleId.startsWith(`${key}/`),
    );
    if (overlapping === undefined) continue;
    diagnostics.push(
      createLocalDevDiagnostic(
        "local-dev-project-alias-shadowed",
        moduleId,
        `\`vite.config.ts\` declares an alias "${overlapping}" that overlaps "${moduleId}", which \`forguncy.config.ts\` already resolves to ${JSON.stringify(target)}. Vite applies its own aliases before the harness resolver, so the local loop would use the Vite target while the Cell build uses ${JSON.stringify(target)}. Remove the overlapping entry, or rename one of the two.`,
      ),
    );
  }

  const alignment = localDevAlignmentChecks(resolutions);
  const installed = input.installedVersions;
  if (installed !== undefined) {
    for (const expectation of alignment) {
      const actual = installed[expectation.localPackage];
      if (actual === undefined || actual === expectation.expected) continue;
      diagnostics.push(
        createLocalDevDiagnostic(
          "local-dev-host-version-mismatch",
          expectation.localPackage,
          `Resolved ${actual}, and #5 recorded ${expectation.field} as ${expectation.expected} for this target.`,
        ),
      );
    }
  }

  if (input.mockBindings !== undefined) {
    try {
      assertLocalDevMockSuppliesEveryBaseProp(input.mockBindings);
    } catch (error) {
      diagnostics.push(
        createLocalDevDiagnostic(
          "local-dev-mock-surface-incomplete",
          "cell-props",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  return {
    diagnostics,
    resolvable: localDevResolvableModuleIds(resolutions, mappings),
    unresolved: unsupported,
    alignment,
    realRuntimeOnly,
    owed: localDevRealRuntimeOwedChecks(),
  };
}

/** A report block for a CI log, a terminal or a PR body. */
export function formatLocalDevAudit(audit: LocalDevAudit): string {
  return [
    `Local dev resolvable module ids: ${audit.resolvable.join(", ") || "(none)"}`,
    // A statement about what the rows declared, which is the stronger claim this audit can
    // make: a table the guard refused is reported by its findings, and a row that resolved
    // by nothing is one of them rather than an entry in a list. "No module id lacks a local
    // stand-in" would have been the stronger sentence and an unsayable one — it asserted
    // something about every module id, beside a finding that denied it for one of them.
    audit.unresolved.length === 0
      ? "No bridged module id is declared without a local stand-in."
      : `Declared without a local stand-in: ${audit.unresolved.join(", ")}`,
    audit.alignment.length === 0
      ? "No version check is available."
      : `Version checks: ${audit.alignment.map(entry => `${entry.localPackage}===${entry.expected}`).join(", ")}`,
    audit.realRuntimeOnly.length === 0
      ? "No dependency is recorded as real-runtime-only."
      : `Left to real-runtime validation by decision: ${audit.realRuntimeOnly.join(", ")}`,
    audit.diagnostics.length === 0
      ? "No local dev diagnostics."
      : `${audit.diagnostics.length} local dev diagnostic(s):\n${formatLocalDevDiagnostics(audit.diagnostics)}`,
  ].join("\n");
}

