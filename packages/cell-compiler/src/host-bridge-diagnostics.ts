/**
 * The host bridge's build-time diagnostic vocabulary and its formatting.
 *
 * Decision source: GitHub Issue #9 — "Spec: host module bridge for React,
 * ReactDOM, antd and built-in globals"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/9), downstream of #6
 * "generated ReactCellType artifact and compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6).
 *
 * Split out of `host-bridge.ts` (#170) along the seam between *reporting* a bridge
 * finding and *planning* one: this module owns the finding's shape, its shared
 * vocabulary over `core`'s rule table, and the line a report prints. Nothing here
 * reads a mapping or a decision, so the planning half can be read without the error
 * model in the way and vice versa.
 */

import {
  defineDiagnosticVocabulary,
  HOST_BRIDGE_DIAGNOSTIC_RULES,
} from "@forguncy-react-workspace/core";
import type {
  HostBridgeDiagnosticCode,
  HostBridgeDiagnosticRule,
  HostBridgeFixOwner,
} from "@forguncy-react-workspace/core";

/**
 * One bridge finding.
 *
 * `detail` carries the offending value and `code` comes from `core`'s shared
 * vocabulary, so the same code can be reported at build time and thrown at
 * runtime. `member` is separate from `detail` because it is the one part of a
 * message a caller may want to branch on without parsing.
 *
 * `fixOwner` and `fixableByMapping` are overrides, present only when this
 * occurrence answers differently from the code's static rule. They exist because
 * `host-mapping-conflict` covers two origins — a table that contradicts itself, and
 * a decision that contradicts the row it selects — and those two have different
 * owners. Without the override, `formatHostBridgeDiagnostic` would send an Agent to
 * the mapping table for a problem whose bad input is the dependency decision, which
 * is exactly the misdirection the field is meant to prevent: a diagnostic is
 * actionable only if its owner is true of this occurrence.
 */
export interface HostBridgeDiagnostic {
  readonly code: HostBridgeDiagnosticCode;
  readonly specifier: string;
  readonly detail: string;
  readonly member?: string;
  /** This occurrence's owner, when it differs from the code's static rule. */
  readonly fixOwner?: HostBridgeFixOwner;
  /** This occurrence's mapping-fixability, when it differs from the code's static rule. */
  readonly fixableByMapping?: boolean;
}

export interface CreateHostBridgeDiagnosticOptions {
  readonly member?: string;
  readonly fixOwner?: HostBridgeFixOwner;
  readonly fixableByMapping?: boolean;
}

/**
 * The shared vocabulary, closed over `core`'s bridge rules and this module's shape.
 *
 * This variant differs from the artifact/workspace/sync ones in two ways the factory takes
 * as parameters: the subject field is called `specifier`, and the line names the rule's
 * label rather than restating its sentence. Its instance also carries the occurrence's
 * overrides, which is why it is built here rather than through `createDiagnosticFields`.
 */
interface HostBridgeDiagnosticInstanceOptions extends CreateHostBridgeDiagnosticOptions {
  /** The occurrence's offending value, which this shape carries as its own field. */
  readonly detail: string;
}

const HOST_BRIDGE_VOCABULARY = defineDiagnosticVocabulary<
  HostBridgeDiagnosticCode,
  HostBridgeDiagnosticRule,
  HostBridgeDiagnostic,
  HostBridgeDiagnosticInstanceOptions
>({
  rules: HOST_BRIDGE_DIAGNOSTIC_RULES,
  instance: input => ({
    code: input.code,
    specifier: input.subject,
    detail: input.options.detail,
    ...(input.options.member === undefined ? {} : { member: input.options.member }),
    ...(input.options.fixOwner === undefined ? {} : { fixOwner: input.options.fixOwner }),
    ...(input.options.fixableByMapping === undefined ? {} : { fixableByMapping: input.options.fixableByMapping }),
  }),
  subjectOf: diagnostic => diagnostic.specifier,
  format: (diagnostic, rule) => {
    const fixOwner = diagnostic.fixOwner ?? rule.fixOwner;
    return `${diagnostic.specifier}: [${diagnostic.code}] ${rule.label} — ${diagnostic.detail} (fix owner: ${fixOwner})`;
  },
  emptyReport: "No bridge diagnostics.",
});

/**
 * Builds a finding, with an occurrence's overrides when it has any.
 *
 * The fourth parameter is a **union** rather than the options object it became in the
 * commit that added the overrides, because this function is exported from the package
 * root and `member?: string` was its public fourth parameter before that. A caller
 * written against the old signature must keep working: as a `string` it still means the
 * member name, and only an object is read as overrides. Replacing the parameter outright
 * would have accepted the old call at runtime while silently dropping the member — the
 * failure being invisible is what makes it worse than a type error, and a package's
 * root export is not a place to break callers over an internal tidy-up.
 */
export function createHostBridgeDiagnostic(
  code: HostBridgeDiagnosticCode,
  specifier: string,
  detail: string,
  memberOrOptions: string | CreateHostBridgeDiagnosticOptions = {},
): HostBridgeDiagnostic {
  const options: HostBridgeDiagnosticInstanceOptions =
    typeof memberOrOptions === "string" ? { member: memberOrOptions, detail } : { ...memberOrOptions, detail };

  return HOST_BRIDGE_VOCABULARY.create(code, specifier, options);
}

/** The rule behind a diagnostic, so a report can print guidance without the code. */
export function hostBridgeDiagnosticRule(code: HostBridgeDiagnosticCode) {
  return HOST_BRIDGE_VOCABULARY.rule(code);
}

/**
 * One line per diagnostic, including what to do about it.
 *
 * The owner is read off the occurrence first, because an occurrence may know its
 * own owner where the code's rule can only state the common one — see
 * {@link HostBridgeDiagnostic.fixOwner}.
 */
export function formatHostBridgeDiagnostic(diagnostic: HostBridgeDiagnostic): string {
  return HOST_BRIDGE_VOCABULARY.format(diagnostic);
}

export function formatHostBridgeDiagnostics(diagnostics: readonly HostBridgeDiagnostic[]): string {
  return diagnostics.map(formatHostBridgeDiagnostic).join("\n");
}
