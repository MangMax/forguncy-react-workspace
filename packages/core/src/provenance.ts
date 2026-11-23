/**
 * The one decision-provenance derivation.
 *
 * Four packages each hand-wrote the same four constants from a Spec record — the short
 * reference, the repo-qualified reference, the governing line, and the citation
 * patterns — and none of them used `core`'s own `qualifiedDecisionReference`, so the
 * qualified spelling was restated four times. This module derives all four from the
 * record, so a package declares the record and nothing else.
 *
 * Decision source: GitHub Issue #156 — "refactor(core): shared package-name,
 * diagnostic-vocabulary and provenance helpers"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/156), under
 * #152 "spec: stabilise the current shape — single answers, single copies, narrow
 * surfaces" (https://github.com/Mang-X/forguncy-react-workspace/issues/152).
 *
 * ## What is derived and what stays the package's own
 *
 * Derived: everything that is a function of the record alone — `reference`,
 * `qualifiedReference`, and `citationPatterns`. The governing line is a function of a
 * *list*, so it is derived only when the package supplies one; a decision that is cited
 * rather than governing (the workspace-graph implementation Issue) has no line, and
 * inventing one would claim it governs a contract it does not.
 *
 * Not derived: the governing list itself. Which Specs govern a package is a decision, and
 * a helper that guessed it would be the second answer to "which architecture Spec governs
 * this" that the per-package modules exist to give once.
 */

import type { ArchitectureDecisionSource } from "./governance.ts";
import {
  citationPatternsFor,
  decisionReference,
  formatGoverningSpecReferenceLine,
  qualifiedDecisionReference,
} from "./governance.ts";

/** The four constants a package's provenance module derives from its Spec record. */
export interface DecisionProvenance {
  /** The record itself, so a caller does not have to reach for the package's other constant. */
  readonly decision: ArchitectureDecisionSource;
  /** Short form, e.g. `#14`. */
  readonly reference: string;
  /** Repo-qualified short form, for a reference that travels outside this repository. */
  readonly qualifiedReference: string;
  /**
   * The line a PR body, plan or report describing the contract carries.
   *
   * Absent when the caller supplied no governing list: a cited record is not a governing
   * one, and a line naming only itself would misstate that.
   */
  readonly governingSpecReferenceLine?: string;
  /** Patterns a document must match to count as citing the contract. */
  readonly citationPatterns: readonly RegExp[];
}

/**
 * Derives a Spec record's reference, qualified reference, governing line and citation patterns.
 *
 * `governing` is the ordered list the line is composed from — the architecture decisions
 * first, then the package's own, which is the order every provenance module already used.
 * Omit it for a record that is cited rather than governing; the overloads make the line
 * required exactly when a list was supplied, so a caller cannot read it as possibly absent
 * when it cannot be.
 */
export function defineDecisionProvenance(
  decision: ArchitectureDecisionSource,
  governing: readonly ArchitectureDecisionSource[],
): DecisionProvenance & { readonly governingSpecReferenceLine: string };
export function defineDecisionProvenance(
  decision: ArchitectureDecisionSource,
  governing?: readonly ArchitectureDecisionSource[],
): DecisionProvenance;
export function defineDecisionProvenance(
  decision: ArchitectureDecisionSource,
  governing?: readonly ArchitectureDecisionSource[],
): DecisionProvenance {
  return {
    decision,
    reference: decisionReference(decision),
    qualifiedReference: qualifiedDecisionReference(decision),
    ...(governing === undefined
      ? {}
      : { governingSpecReferenceLine: formatGoverningSpecReferenceLine(governing) }),
    citationPatterns: citationPatternsFor(decision),
  };
}
