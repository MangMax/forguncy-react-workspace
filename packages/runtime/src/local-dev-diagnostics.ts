/**
 * The local dev diagnostics vocabulary, moved verbatim from `local-dev.ts` (#160).
 *
 * `local-dev.ts` remains that contract's module doc and the home of the sections it keeps; this
 * file holds the rule table every local finding is composed from and the formatter for it.
 */

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export const LOCAL_DEV_DIAGNOSTIC_CODES = [
  "local-dev-mapping-coverage",
  "local-dev-no-local-stand-in",
  "local-dev-deferred-host-module",
  "local-dev-extension-choice-malformed",
  "local-dev-extension-choice-duplicated",
  "local-dev-extension-choice-unmatched",
  "local-dev-extension-needs-substitute",
  "local-dev-extension-real-runtime-only",
  "local-dev-host-version-mismatch",
  "local-dev-mock-surface-incomplete",
  "local-dev-project-alias-shadowed",
] as const;

export type LocalDevDiagnosticCode = (typeof LOCAL_DEV_DIAGNOSTIC_CODES)[number];

/** Which side of the local configuration has to act. Never omitted: a code is not a dead end. */
export type LocalDevFixOwner = "host-bridge-mapping" | "project-configuration" | "local-install" | "dependency-decision";

export interface LocalDevDiagnosticRule {
  readonly code: LocalDevDiagnosticCode;
  readonly label: string;
  /** One sentence stating the condition, without the offending value. */
  readonly states: string;
  readonly remediation: string;
  readonly fixOwner: LocalDevFixOwner;
  /**
   * Whether the condition blocks local development.
   *
   * `false` for the ones a local loop can carry on around — a deferred module
   * resolves either way, and a version mismatch is worth knowing about but does
   * not stop a render. The distinction is what lets the harness warn instead of
   * refusing, and a report say which of the two a code is.
   */
  readonly blocksLocalDevelopment: boolean;
}

export const LOCAL_DEV_DIAGNOSTIC_RULES: Readonly<Record<LocalDevDiagnosticCode, LocalDevDiagnosticRule>> = {
  "local-dev-mapping-coverage": {
    code: "local-dev-mapping-coverage",
    label: "The local resolution table and the host bridge table disagree",
    states: "A module id one table covers and the other does not.",
    remediation:
      "Add the missing row, or remove the extra one. Either table moving without the other means the dev harness and the artifact resolve the same import differently, which is the drift #22's third acceptance criterion exists to prevent.",
    fixOwner: "host-bridge-mapping",
    blocksLocalDevelopment: true,
  },
  "local-dev-no-local-stand-in": {
    code: "local-dev-no-local-stand-in",
    label: "A bridged module has no local stand-in",
    states: "A bridge row is marked `unsupported` for local development.",
    remediation:
      "Supply a substitute, or accept that this import cannot be exercised locally. The one option that is not available is approximating it: a stand-in nobody declared is a local-only pass waiting to happen.",
    fixOwner: "project-configuration",
    blocksLocalDevelopment: false,
  },
  "local-dev-deferred-host-module": {
    code: "local-dev-deferred-host-module",
    label: "A referenced module is a host global whose bridge row is deferred",
    states: "The cell references a module #9 named as a future built-in and did not map.",
    remediation:
      "Expect it to resolve locally through the ordinary npm path and to be undecided on the page. Adding the row requires the evidence #9 recorded as missing — a version, and an answer for a cell that did not declare the preset — so this is not a diagnostic a local change can close.",
    fixOwner: "host-bridge-mapping",
    blocksLocalDevelopment: false,
  },
  "local-dev-extension-choice-malformed": {
    code: "local-dev-extension-choice-malformed",
    label: "A declared `extension` choice is not a decision",
    states: "A choice in the project's list is missing a part its branch requires.",
    remediation:
      "Fill in the part the finding names — the two branches ask for different fields, so the fix is to complete the one that was chosen. A choice that has learned the vocabulary but not the content is still an omission: an acknowledgement with a `consequence` left empty does not say what the local loop cannot exercise, and a substitute with no `resolvesTo` does not say what it stands in. The list is inspected without trusting its declared type, so a value that is not a choice at all reaches the same finding rather than a stack trace.",
    fixOwner: "dependency-decision",
    blocksLocalDevelopment: true,
  },
  "local-dev-extension-choice-duplicated": {
    code: "local-dev-extension-choice-duplicated",
    label: "One `extension` package carries more than one local choice",
    states: "Two or more well-formed choices name the same package.",
    remediation:
      "Keep exactly one entry and delete the rest. A package has one decision, so a second entry is not a second decision: with both present, the branch that applies would depend on their order in the list, and reversing the list would move the package between `substitute` and `real-runtime-only` without anyone editing a decision. Neither entry is used, because picking one would be the harness deciding something the project stated twice.",
    fixOwner: "dependency-decision",
    blocksLocalDevelopment: true,
  },
  "local-dev-extension-choice-unmatched": {
    code: "local-dev-extension-choice-unmatched",
    label: "A declared `extension` choice matches no `extension` decision",
    states: "A choice names a package the supplied decision list does not carry as `extension`.",
    remediation:
      "Delete the entry, or restore the decision it described. A choice is the local half of a dependency decision, so when a package moves to another strategy — `extension` to `inline`, say — its choice is left describing a decision that no longer exists. Both directions are checked for the same reason the local resolution table is: `every extension decision has a choice` and `every choice has an extension decision` are different statements, and a check that asks only the first reports a pass for a record that disagrees with itself. Only asked when the caller supplied the decisions; with none, the audit has nothing to match against and abstains.",
    fixOwner: "dependency-decision",
    blocksLocalDevelopment: false,
  },
  "local-dev-extension-needs-substitute": {
    code: "local-dev-extension-needs-substitute",
    label: "An `extension` dependency has no declared local choice",
    states: "A dependency decision is `extension` and the project declared no choice for it.",
    remediation:
      "Declare one of the two branches: a substitute with its justification, or a `real-runtime-only` acknowledgement with its reason and its consequence. A harness cannot choose for the project — whether the singleton semantics the cell relies on are exercised locally is not a fact it can observe — but silence is not a choice either. A choice that was declared and is incomplete is reported as `local-dev-extension-choice-malformed` instead, because the fix there is to complete the branch rather than to pick one.",
    fixOwner: "dependency-decision",
    blocksLocalDevelopment: true,
  },
  "local-dev-extension-real-runtime-only": {
    code: "local-dev-extension-real-runtime-only",
    label: "An `extension` dependency is deliberately left to real-runtime validation",
    states: "The project recorded a `real-runtime-only` choice for this package.",
    remediation:
      "Nothing to fix — this is the second of the two branches #22 allows, and it is deliberately non-blocking. It is reported rather than dropped so the audit's output distinguishes a decision from an omission, and so whoever reads it knows which dependency the local loop cannot exercise at all.",
    fixOwner: "dependency-decision",
    blocksLocalDevelopment: false,
  },
  "local-dev-host-version-mismatch": {
    code: "local-dev-host-version-mismatch",
    label: "The locally installed package is not the recorded host version",
    states: "The resolved version of a substituted package differs from the one #5 recorded.",
    remediation:
      "Align the local install with the recorded version, or re-probe the target (#5) if the page has moved. Do not relax the comparison: the check exists because a cell developed against a different React version is not evidence about this target, and the two failures — a stale lock and a newer host — have different fixes.",
    fixOwner: "local-install",
    blocksLocalDevelopment: false,
  },
  "local-dev-mock-surface-incomplete": {
    code: "local-dev-mock-surface-incomplete",
    label: "The mock host surface omits a prop the host always injects",
    states: "A base prop key #5 records on every cell is missing from the mock.",
    remediation:
      "Declare the key, with `undefined` as its value if that is the truth. #5 records all four keys present on every cell, so a cell that reads one locally would be reading something the mock invented by omission.",
    fixOwner: "project-configuration",
    blocksLocalDevelopment: true,
  },
  "local-dev-project-alias-shadowed": {
    code: "local-dev-project-alias-shadowed",
    label: "A `vite.config.ts` alias claims an id the project declared in `forguncy.config.ts`",
    states: "A user Vite alias matches a module id a project alias resolves, so it rewrites the import before the project alias is consulted.",
    remediation:
      "Remove the overlapping `vite.config.ts` alias, or rename the project alias. Vite applies its own `resolve.alias` *before* a plugin's `resolveId` (measured), which is where the project alias is applied, so the local loop would resolve the id to the Vite target while the Cell build resolves it to `forguncy.config.ts`. That is the dev/production split #97 exists to remove, and it is silent: both paths succeed and disagree. An alias that does not overlap a project alias is unaffected and stays allowed.",
    fixOwner: "project-configuration",
    blocksLocalDevelopment: true,
  },
};

export interface LocalDevDiagnostic {
  readonly code: LocalDevDiagnosticCode;
  /** What the finding is about: a module id, a package name, or a configuration area. */
  readonly subject: string;
  readonly detail: string;
}

export function createLocalDevDiagnostic(
  code: LocalDevDiagnosticCode,
  subject: string,
  detail: string,
): LocalDevDiagnostic {
  return { code, subject, detail };
}

/** One line per diagnostic, including what to do about it and whether it blocks. */
export function formatLocalDevDiagnostic(diagnostic: LocalDevDiagnostic): string {
  const rule = LOCAL_DEV_DIAGNOSTIC_RULES[diagnostic.code];
  return `${diagnostic.subject}: [${diagnostic.code}] ${rule.label} — ${diagnostic.detail} (fix owner: ${rule.fixOwner}${rule.blocksLocalDevelopment ? ", blocks local development" : ""})`;
}

export function formatLocalDevDiagnostics(diagnostics: readonly LocalDevDiagnostic[]): string {
  return diagnostics.map(formatLocalDevDiagnostic).join("\n");
}

