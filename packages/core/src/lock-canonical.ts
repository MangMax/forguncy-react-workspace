/**
 * The canonical form of `fgc.lock.json` — the exact bytes a lock file should contain.
 *
 * Decision source: GitHub Issue #8 — "Spec: reproducible dependency decisions
 * and `fgc.lock.json`". Governing architecture Specs: #4, which defines the four
 * strategies, and #5, which is where the Forguncy target a runtime claim is about
 * was converted into observed facts.
 *
 * Split out of `lock.ts` by #162, under the shape-stabilisation Spec #152: the model
 * (types, the evidence policy and the schema version) lives in `lock-types.ts`, and the
 * rules (shape inspection, semantic validation and parsing) live in `lock-validate.ts`.
 */

import { createCanonicalizer } from "./canonical.ts";
import { compareCodeUnits } from "./code-units.ts";
import type { DecisionEvidenceLink, FgcLockDocument, LockedDependencyDecision } from "./lock-types.ts";

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

/**
 * Canonical decision order: package name, then cell target.
 *
 * A null cell target sorts before any named target, so the target-independent
 * record for a package always reads first.
 */
export function compareLockDecisions(a: LockedDependencyDecision, b: LockedDependencyDecision): number {
  return compareCodeUnits(a.packageName, b.packageName) || compareCodeUnits(a.cellTarget ?? "", b.cellTarget ?? "");
}

/**
 * Canonical order for evidence links: kind, then reference.
 *
 * Exported because a *writer* that merges new evidence into an existing record has
 * to produce the same order this serializer does, or the record it returns is not
 * the record on disk. Sharing the comparator is what keeps that true; a second
 * copy in the writer would be a second definition of "canonical", and the two
 * would only have to disagree once.
 */
export function compareEvidenceLinks(a: DecisionEvidenceLink, b: DecisionEvidenceLink): number {
  return compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.reference, b.reference);
}

/**
 * Field order for the serialized document.
 *
 * Listed fields come first, in this order, so a record reads as identity →
 * strategy → strategy-specific detail → evidence. Anything unlisted falls in
 * alphabetically afterwards, which keeps a future field deterministic without
 * requiring an edit here.
 */
const LOCK_KEY_ORDER: readonly string[] = [
  "schemaVersion",
  "decisions",
  "packageName",
  "cellTarget",
  "strategy",
  "resolvedVersion",
  "globalName",
  "libraryId",
  "rejection",
  "alternatives",
  "supersededBy",
  "probe",
  "target",
  "probedWith",
  "extension",
  "rejectedCandidate",
  "rationale",
  "evidence",
  "status",
  "fingerprint",
  "versionIndependent",
  "product",
  "productVersion",
  "productBuild",
  "hostReactVersion",
  "vitePlus",
  // #94's toolchain components, in the order a reader wants them: the tools that ran, then the
  // graph they resolved against.
  "rolldown",
  "node",
  "installGraph",
  "lockfile",
  "patches",
  "configuration",
  "installedTree",
  "version",
  "identity",
  "kind",
  "code",
  "summary",
  "remediation",
  "reference",
];

/**
 * The document's canonical walk, in the order above.
 *
 * Shared with the probe report through {@link createCanonicalizer} rather than copied: the two
 * differ only in which keys they list, and a second copy of the recursive walk is a second
 * definition of "canonical" that only has to disagree once.
 */
const canonicalizeValue = createCanonicalizer(LOCK_KEY_ORDER);

export function isCanonicallyOrdered(decisions: readonly LockedDependencyDecision[]): boolean {
  for (let index = 1; index < decisions.length; index += 1) {
    if (compareLockDecisions(decisions[index - 1]!, decisions[index]!) >= 0) {
      return false;
    }
  }
  return true;
}

/**
 * The canonical spelling of a declared import surface: sorted, deduplicated, or `null`.
 *
 * The field is a **set** — `imports: ["add", "clamp"]` and `["clamp", "add"]` name one surface,
 * and the probe fingerprint already sorts them into one input — so the lock has to store one
 * byte sequence for it or #8's "deterministic and reviewable" guarantee is false for a document
 * that is otherwise fully ordered. `canonicalizeFgcLock` applies this, `inspectLockRecord`
 * rejects a document that has not, and the recording API writes it, so all three agree by
 * construction rather than by three copies of a sort.
 *
 * An empty array is the namespace surface, which this format spells as `null`: returning `null`
 * here means a caller cannot write the one spelling the lock's own validator refuses.
 */
export function canonicalizeImports(imports: readonly string[] | null | undefined): readonly string[] | null {
  if (imports === null || imports === undefined) {
    return null;
  }
  const unique = [...new Set(imports)].sort();
  return unique.length === 0 ? null : unique;
}

/**
 * The canonical document: decisions in canonical order, evidence links sorted, and each
 * declared import surface in set spelling.
 *
 * Sorting matters for the same reason each time — an Agent that lists the same things in a
 * different order must not produce a diff.
 */
export function canonicalizeFgcLock(lock: FgcLockDocument): FgcLockDocument {
  return {
    schemaVersion: lock.schemaVersion,
    decisions: [...lock.decisions]
      .sort(compareLockDecisions)
      .map(record => ({
        ...record,
        evidence: [...record.evidence].sort(compareEvidenceLinks),
        // Omitted entirely for the namespace surface, so a record written before this field
        // existed still serializes without the key — the same reason the fingerprint omits it.
        ...(record.imports == null ? {} : { imports: canonicalizeImports(record.imports) }),
      })),
  };
}

/**
 * The exact bytes a lock file should contain.
 *
 * Always canonicalizes, so calling this on any decision set yields review-ready
 * output, and serializing an already-serialized document is a no-op.
 */
export function serializeFgcLock(lock: FgcLockDocument, options: { readonly indent?: number } = {}): string {
  const canonical = canonicalizeValue(canonicalizeFgcLock(lock));
  return `${JSON.stringify(canonical, null, options.indent ?? 2)}\n`;
}
