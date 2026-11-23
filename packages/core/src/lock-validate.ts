/**
 * The rules `fgc.lock.json` has to satisfy — shape, semantics, portability and parsing.
 *
 * Decision source: GitHub Issue #8 — "Spec: reproducible dependency decisions
 * and `fgc.lock.json`". Governing architecture Specs: #4, which defines the four
 * strategies, and #5, which is where the Forguncy target a runtime claim is about
 * was converted into observed facts.
 *
 * Split out of `lock.ts` by #162, under the shape-stabilisation Spec #152: the model
 * (types, the evidence policy and the schema version) lives in `lock-types.ts`, and the
 * canonical form lives in `lock-canonical.ts`. The checks run here are the ones the read
 * path relies on, so they stay in one module where the order between them is visible.
 */

import { compareCodeUnits } from "./code-units.ts";
import { citesDecision, OWNERSHIP_AND_DEPENDENCY_DECISION } from "./governance.ts";
import { isPlainRecord } from "./guards.ts";
import { canonicalizeImports, isCanonicallyOrdered } from "./lock-canonical.ts";
import type {
  FgcLockDocument,
  LockedDependencyDecision,
  LockEvidencePolicy,
  ProbeStatus,
} from "./lock-types.ts";
import {
  assertSupportedFgcLockSchemaVersion,
  DECISION_EVIDENCE_KINDS,
  FGC_LOCK_FILE_NAME,
  isSupportedFgcLockSchemaVersion,
  lockEvidencePolicyFor,
  PROBE_STATUSES,
  requiresRuntimeValidation,
  requiresTargetIdentity,
  SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS,
} from "./lock-types.ts";
import { containsMachineSpecificPath } from "./portability.ts";
import { ARCHITECTURAL_REJECTION_CODES, TECHNICAL_REJECTION_CODES } from "./rejection.ts";
import {
  isReadableSubjectCompileDecision,
  strategySemantics,
  validateDependencyDecisionShape,
} from "./strategy.ts";
import type { DependencyStrategy } from "./strategy.ts";

export class FgcLockValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[], context = FGC_LOCK_FILE_NAME) {
    super(`Invalid ${context}:\n- ${problems.join("\n- ")}`);
    this.name = "FgcLockValidationError";
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Portability
// ---------------------------------------------------------------------------

/**
 * Every absolute or machine-specific path anywhere in the document.
 *
 * The rule itself is `portability.ts`'s `containsMachineSpecificPath` (#154): the lock and a
 * committed configuration must give one value one verdict, so the pattern set lives there and
 * this scan is the lock's use of it. Exported as a document-wide scan rather than only as a
 * field check so the portability guarantee holds for the whole shape, including fields added
 * later.
 */
export function findMachineSpecificPaths(value: unknown): readonly string[] {
  const found = new Set<string>();

  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (containsMachineSpecificPath(node)) {
        found.add(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const item of Object.values(node)) {
        visit(item);
      }
    }
  };

  visit(value);
  return [...found].sort(compareCodeUnits);
}

/**
 * A path that means the same thing on every machine: relative, no drive, no home
 * directory, no `..` escape out of the repository, and no absolute path hidden
 * inside it.
 */
export function isRepositoryRelativeReference(reference: string): boolean {
  const value = reference.trim();
  if (value.length === 0) {
    return false;
  }
  // A URI scheme means it is not a relative path, whatever else it is.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return false;
  }
  if (containsMachineSpecificPath(value)) {
    return false;
  }
  return !value.split(/[\\/]/).includes("..");
}

export function isEvidenceUrl(reference: string): boolean {
  return /^https?:\/\/\S+$/.test(reference.trim());
}

export function isEvidenceReference(reference: string): boolean {
  return isEvidenceUrl(reference) || isRepositoryRelativeReference(reference);
}
// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isKnownStrategy(value: unknown): value is DependencyStrategy {
  return value === "host" || value === "inline" || value === "extension" || value === "replace";
}

/**
 * Structural problems with untrusted input, before any typed access.
 *
 * Complete on purpose, and that completeness is the whole point: the semantic
 * pass reads fields with `.trim()`, `.kind`, `.length` and friends, so any field
 * this misses becomes a native `TypeError` thrown out of the parser instead of a
 * `FgcLockValidationError` naming the record. A missing field is therefore a
 * problem here even when `null` would be legal: the file is generated and
 * reviewed, so an absent key means the writer was wrong, and "must declare null"
 * is a better message than reading it as absent-and-fine.
 */
export function inspectFgcLockDocument(input: unknown): readonly string[] {
  if (!isPlainRecord(input)) {
    return [`${FGC_LOCK_FILE_NAME} must contain a JSON object.`];
  }

  const problems: string[] = [];
  const { schemaVersion, decisions } = input;

  if (typeof schemaVersion !== "number") {
    problems.push(`${FGC_LOCK_FILE_NAME} must declare a numeric \`schemaVersion\`.`);
  } else if (!isSupportedFgcLockSchemaVersion(schemaVersion)) {
    problems.push(
      `Unsupported schema version ${String(schemaVersion)}; this toolchain supports ${SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS.join(", ")}.`,
    );
  }

  if (!Array.isArray(decisions)) {
    problems.push(`${FGC_LOCK_FILE_NAME} must declare a \`decisions\` array.`);
    return problems;
  }

  decisions.forEach((record, index) => {
    problems.push(...inspectLockRecord(record, `decisions[${index}]`));
  });

  return problems;
}

function inspectString(problems: string[], source: Record<string, unknown>, field: string, where: string): void {
  if (typeof source[field] !== "string") {
    problems.push(`${where} must declare \`${field}\` as a string.`);
  }
}

function inspectNullableString(
  problems: string[],
  source: Record<string, unknown>,
  field: string,
  where: string,
): void {
  const value = source[field];
  if (value !== null && typeof value !== "string") {
    problems.push(`${where} must declare \`${field}\` as a string or null.`);
  }
}

function inspectStringArrayOrAbsent(
  problems: string[],
  source: Record<string, unknown>,
  field: string,
  where: string,
): void {
  const value = source[field];
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    problems.push(`${where} must declare \`${field}\` as an array of strings when it is present.`);
  }
}

function inspectOptionalObject(
  problems: string[],
  source: Record<string, unknown>,
  field: string,
  where: string,
  inspect: (value: Record<string, unknown>, where: string) => readonly string[],
): void {
  const value = source[field];
  if (value === null) {
    return;
  }
  if (!isPlainRecord(value)) {
    problems.push(`${where} must declare \`${field}\` as an object or null.`);
    return;
  }
  problems.push(...inspect(value, `${where}.${field}`));
}

function inspectLockRecord(record: unknown, where: string): readonly string[] {
  if (!isPlainRecord(record)) {
    return [`${where} must be an object.`];
  }

  const problems: string[] = [];

  inspectString(problems, record, "packageName", where);
  if (typeof record.packageName === "string" && record.packageName.trim().length === 0) {
    problems.push(`${where} must name the package it decides about.`);
  }

  inspectNullableString(problems, record, "cellTarget", where);
  if (typeof record.cellTarget === "string" && record.cellTarget.trim().length === 0) {
    problems.push(`${where} must either name a cell target or record null for "applies to every target".`);
  }

  // `imports` is inspected on its own rather than through `inspectStringArrayOrAbsent`, because
  // null is a *meaning* here — the namespace surface — and that helper rejects it. The two
  // spellings of "no named surface" are an absent key (a lock written before #77) and an explicit
  // null (what the merge writes); both are valid, and the rejected forms are an empty array, which
  // would compose a fingerprint carrying a surface no build ever used, a blank name, and — since
  // revision 13 — a non-canonical spelling (unsorted, or with duplicates).
  if (record.imports !== undefined && record.imports !== null) {
    if (!Array.isArray(record.imports) || record.imports.some(item => typeof item !== "string")) {
      problems.push(`${where} must declare \`imports\` as an array of strings, or null for the whole namespace.`);
    } else if (record.imports.length === 0) {
      problems.push(
        `${where} records an empty \`imports\` array. An empty surface is the namespace probe, which this field spells as null — an empty array would compose a fingerprint carrying a surface no build ever used.`,
      );
    } else if (record.imports.some(name => name.trim().length === 0)) {
      problems.push(`${where} records a blank binding name in \`imports\`; every entry must name an imported binding.`);
    } else {
      // The surface is set-like — the fingerprint sorts it — so two spellings of one surface must
      // not be two byte sequences in a committed lock. This is a *validation* rather than a
      // silent canonicalization, matching how the lock treats decision and evidence order: the
      // reader is told to serialize, instead of the document being quietly reordered under a
      // reviewer. `canonicalizeImports` is the one definition both this and the serializer use,
      // so the accepted spelling cannot drift from the produced one.
      // `?? []` cannot fire here — the branch above already returned for an empty array — but the
      // helper is total by design, so its `null` return has to be narrowed for the caller rather
      // than asserted away.
      const canonical = canonicalizeImports(record.imports) ?? [];
      if (canonical.join("\u0000") !== record.imports.join("\u0000")) {
        problems.push(
          `${where} records \`imports\` as [${record.imports.join(", ")}], which is not the canonical spelling [${canonical.join(", ")}]. The surface is a set: serialize through \`serializeFgcLock\` (or record through \`recordDependencyDecision\`) so two spellings of one surface cannot be two lock bytes.`,
        );
      }
    }
  }

  // The compile evidence, shape-checked here rather than only in the typed semantic pass (#77
  // round 5, P2). `inspectLockRecord` runs over *untrusted* JSON, so a malformed value has to
  // become an `FgcLockValidationError` finding rather than a native throw: an explicit
  // `"artifactEvidence": null` would otherwise pass the structural phase and then blow up when the
  // semantic pass destructures it. Only the shape is checked here; whether the evidence belongs to
  // the cited code, and whether its numbers state the rejection, is the semantic pass's job.
  if (record.artifactEvidence !== undefined) {
    const evidence: unknown = record.artifactEvidence;
    if (!isPlainRecord(evidence)) {
      problems.push(
        `${where} must declare \`artifactEvidence\` as an object describing the compiles it rests on, or omit it.`,
      );
    } else {
      if (typeof evidence.compileFingerprint !== "string") {
        problems.push(`${where} must declare \`artifactEvidence.compileFingerprint\` as a string, or omit \`artifactEvidence\`.`);
      }
      for (const field of ["subjectRenderedCharacters", "codeCharacters", "budgetCharacters"]) {
        const value = evidence[field];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          problems.push(`${where} must declare \`artifactEvidence.${field}\` as a non-negative finite character count.`);
        }
      }
      // The subject's own decision is validated as the discriminated union it is (#77 revision 17),
      // not merely for the presence of a `strategy` string. This is the untrusted-JSON pass, so a
      // hand-edited `replace` — the one state the writer refuses to produce because the package is
      // not in that Cell — has to be refused here rather than reaching the semantic pass and
      // replaying to an artifact that never contained the subject.
      // The **read-side** rule, deliberately weaker than the writer's (#77 revision 18). Revision
      // 16's own `record` persisted `{"strategy":"replace"}` through its normal writer, so a
      // schema-v1 lock carrying that value has to stay loadable — refusing it here would fail the
      // parse and the record would never reach freshness — the failure the read contract exists to
      // prevent. Freshness reports it unreplayable instead.
      if (!isReadableSubjectCompileDecision(evidence.subjectDecision)) {
        problems.push(
          `${where} must declare \`artifactEvidence.subjectDecision\` as \`{"strategy":"inline"}\` or a \`host\`/\`extension\` object with its \`globalName\` (and \`libraryId\`), or omit \`artifactEvidence\`.`,
        );
      }
    }
  }

  inspectNullableString(problems, record, "resolvedVersion", where);
  inspectNullableString(problems, record, "rationale", where);

  if (!isKnownStrategy(record.strategy)) {
    problems.push(`${where} must declare one of the four dependency strategies.`);
  } else if (record.strategy === "host") {
    inspectString(problems, record, "globalName", where);
  } else if (record.strategy === "extension") {
    inspectString(problems, record, "globalName", where);
    inspectString(problems, record, "libraryId", where);
  } else if (record.strategy === "replace") {
    problems.push(...inspectRejection(record.rejection, `${where}.rejection`));
    inspectStringArrayOrAbsent(problems, record, "alternatives", where);
    if (record.supersededBy !== undefined && !isKnownStrategy(record.supersededBy)) {
      problems.push(`${where} must declare \`supersededBy\` as one of the four dependency strategies.`);
    }
  }

  if (!isPlainRecord(record.probe)) {
    problems.push(`${where} must record probe evidence, even when no probe has run.`);
  } else {
    problems.push(...inspectProbe(record.probe, `${where}.probe`));
  }

  inspectOptionalObject(problems, record, "target", where, inspectTarget);
  inspectOptionalObject(problems, record, "probedWith", where, inspectToolchain);
  inspectOptionalObject(problems, record, "extension", where, inspectExtension);
  inspectOptionalObject(problems, record, "rejectedCandidate", where, inspectRejectedCandidate);

  if (!Array.isArray(record.evidence)) {
    problems.push(`${where} must record an \`evidence\` array linking the decision to its probe/decision evidence.`);
  } else {
    record.evidence.forEach((link, index) => {
      const evidenceWhere = `${where}.evidence[${index}]`;
      if (!isPlainRecord(link)) {
        problems.push(`${evidenceWhere} must be an object.`);
        return;
      }
      inspectString(problems, link, "kind", evidenceWhere);
      inspectString(problems, link, "reference", evidenceWhere);
    });
  }

  return problems;
}

function inspectProbe(probe: Record<string, unknown>, where: string): readonly string[] {
  const problems: string[] = [];

  if (typeof probe.status !== "string" || !PROBE_STATUSES.includes(probe.status as ProbeStatus)) {
    problems.push(`${where} must record a probe status of ${PROBE_STATUSES.join(", ")}.`);
  }
  inspectNullableString(problems, probe, "fingerprint", where);
  if (typeof probe.versionIndependent !== "boolean") {
    problems.push(`${where} must declare \`versionIndependent\` as a boolean.`);
  }

  return problems;
}

function inspectRejection(rejection: unknown, where: string): readonly string[] {
  if (!isPlainRecord(rejection)) {
    return [`${where} must be an object describing why the package was rejected.`];
  }

  const problems: string[] = [];

  if (rejection.kind !== "architectural" && rejection.kind !== "technical") {
    problems.push(`${where} must declare \`kind\` as "architectural" or "technical".`);
  } else if (typeof rejection.code === "string") {
    // A code from the other family would make the record claim both answers at
    // once, which is the one distinction #4 exists to keep apart.
    const family = rejection.kind === "architectural" ? ARCHITECTURAL_REJECTION_CODES : TECHNICAL_REJECTION_CODES;
    if (!(family as readonly string[]).includes(rejection.code)) {
      problems.push(`${where} must declare a rejection code from the ${rejection.kind} family.`);
    }
  } else {
    problems.push(`${where} must declare \`code\` as a string.`);
  }

  inspectString(problems, rejection, "summary", where);
  inspectString(problems, rejection, "remediation", where);
  inspectStringArrayOrAbsent(problems, rejection, "evidence", where);

  return problems;
}

function inspectTarget(target: Record<string, unknown>, where: string): readonly string[] {
  const problems: string[] = [];
  for (const field of ["product", "productVersion", "productBuild", "hostReactVersion"]) {
    inspectString(problems, target, field, where);
  }
  return problems;
}

/**
 * The toolchain object, as a lock record or a probe report spells it.
 *
 * `vitePlus` is required-as-nullable; the components #94 added are checked only when **present**,
 * because a record written by the previous toolchain does not have them. Requiring them here would
 * refuse such a document at parse time, and #8's migration contract is that an older lock stays
 * **readable and stale** rather than unreadable — the staleness axis reports
 * `install-graph-unknown`, which is the actionable answer, and a parser error is not.
 *
 * `installGraph` is inspected structurally when present so a typo'd or non-string component is
 * caught here rather than reaching the freshness comparison, where a non-string would compare
 * unequal to a string digest and report `install-graph-changed` — a staleness claim the evidence
 * does not support, since the record is malformed rather than moved.
 */
function inspectToolchain(toolchain: Record<string, unknown>, where: string): readonly string[] {
  const problems: string[] = [];
  inspectNullableString(problems, toolchain, "vitePlus", where);
  for (const field of ["rolldown", "node"]) {
    if (toolchain[field] !== undefined) {
      inspectNullableString(problems, toolchain, field, where);
    }
  }
  const installGraph = toolchain["installGraph"];
  if (installGraph === undefined || installGraph === null) {
    return problems;
  }
  if (!isPlainRecord(installGraph)) {
    problems.push(`${where} must declare \`installGraph\` as an object or null.`);
    return problems;
  }
  // `installedTree` is checked only when present, like the toolchain fields above: a record written
  // before this component existed has no key for it, and the read path must keep accepting such a
  // document as **readable and stale** rather than refusing it (#8's migration contract).
  for (const field of ["lockfile", "patches", "configuration"]) {
    inspectNullableString(problems, installGraph, field, `${where}.installGraph`);
  }
  if (installGraph["installedTree"] !== undefined) {
    inspectNullableString(problems, installGraph, "installedTree", `${where}.installGraph`);
  }
  return problems;
}

function inspectExtension(extension: Record<string, unknown>, where: string): readonly string[] {
  const problems: string[] = [];
  inspectNullableString(problems, extension, "version", where);
  inspectNullableString(problems, extension, "identity", where);
  return problems;
}

function inspectRejectedCandidate(candidate: Record<string, unknown>, where: string): readonly string[] {
  const problems: string[] = [];
  inspectString(problems, candidate, "version", where);
  return problems;
}

/**
 * The lock's own contract: schema version, required metadata, the evidence each
 * profile owes, portable references, canonical ordering, and unique keys.
 *
 * Shape first, and shape alone when the document fails it: the rules below read
 * typed fields, and running them over a document that is not that shape is how a
 * `.trim()` on `undefined` escapes the parser as a `TypeError`. A structurally
 * broken file is reported as broken rather than half-interpreted.
 *
 * Decision-field semantics (a host global must be named, an architectural
 * rejection may not list package alternatives, …) stay in
 * `validateDependencyDecisionShape`, so #4's rules have one implementation.
 */
export function validateFgcLockDocument(input: FgcLockDocument): readonly string[] {
  const structural = inspectFgcLockDocument(input);
  if (structural.length > 0) {
    return structural;
  }
  return validateFgcLockDocumentRules(input);
}

function validateFgcLockDocumentRules(lock: FgcLockDocument): readonly string[] {
  const problems: string[] = [];

  if (!isSupportedFgcLockSchemaVersion(lock.schemaVersion)) {
    problems.push(
      `Unsupported schema version ${String(lock.schemaVersion)}; this toolchain supports ${SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS.join(", ")}.`,
    );
  }

  const seenKeys = new Set<string>();

  lock.decisions.forEach((record, index) => {
    const where = `decisions[${index}] ("${record.packageName}")`;
    const key = `${record.packageName}\u0000${record.cellTarget ?? ""}`;

    if (seenKeys.has(key)) {
      problems.push(
        `${where} duplicates an existing decision for the same package and cell target. Keep one record per (package, cell target) pair and let the strategy change show up as an ordinary diff.`,
      );
    }
    seenKeys.add(key);

    if (record.cellTarget !== null && record.cellTarget.trim().length === 0) {
      problems.push(`${where} must either name a cell target or record null for "applies to every target".`);
    }

    for (const problem of validateDependencyDecisionShape(record)) {
      problems.push(`${where}: ${problem}`);
    }

    const policy = lockEvidencePolicyFor(record);

    problems.push(...validateVersions(where, record));
    problems.push(...validateProbe(where, record, policy));
    problems.push(...validateTarget(where, record, policy));
    problems.push(...validateProbedWith(where, record));
    problems.push(...validateExtension(where, record));
    problems.push(...validateRejectedCandidate(where, record));
    problems.push(...validateRationale(where, record));
    problems.push(...validateEvidence(where, record));
  });

  if (!isCanonicallyOrdered(lock.decisions)) {
    problems.push(
      "Decisions are not in canonical order (package name, then cell target). Serialize through `serializeFgcLock` so identical decisions produce identical bytes.",
    );
  }

  for (const path of findMachineSpecificPaths(lock)) {
    problems.push(
      `"${path}" contains a machine-specific absolute path. Use a URL or a repository-relative path so the decision is reproducible on another machine and in CI.`,
    );
  }

  return problems;
}

function validateVersions(where: string, record: LockedDependencyDecision): readonly string[] {
  const problems: string[] = [];
  const { resolvedVersion, strategy } = record;

  if (resolvedVersion !== null && resolvedVersion.trim().length === 0) {
    problems.push(`${where} must record the exact resolved version, or null when the package is not resolved.`);
  }

  if (strategy === "replace" && resolvedVersion !== null) {
    problems.push(
      `${where} is a \`replace\` decision, which keeps no dependency for the compiled cell; record resolvedVersion as null and let \`rejectedCandidate\`/\`alternatives\` describe what was rejected.`,
    );
  }

  if (strategy !== "replace" && resolvedVersion === null) {
    problems.push(
      `${where} records strategy "${strategy}" without the exact resolved version, so a later upgrade could not be detected as staleness.`,
    );
  }

  return problems;
}

function validateProbe(
  where: string,
  record: LockedDependencyDecision,
  policy: LockEvidencePolicy,
): readonly string[] {
  const problems: string[] = [];
  const { status, fingerprint, versionIndependent } = record.probe;

  if (!PROBE_STATUSES.includes(status)) {
    problems.push(`${where} must record a probe status of ${PROBE_STATUSES.join(", ")}.`);
    return problems;
  }

  if (status === "not-run" && fingerprint !== null) {
    problems.push(`${where} has no probe run, so it must not carry a probe fingerprint.`);
  }

  if (status !== "not-run" && (fingerprint === null || fingerprint.trim().length === 0)) {
    problems.push(
      `${where} claims a "${status}" probe without a fingerprint of what it ran against; without it the evidence cannot be invalidated when its inputs change.`,
    );
  }

  if (versionIndependent && status === "not-run") {
    problems.push(
      `${where} marks a probe version-independent without a probe run. Version independence is a property of a measured probe, not an assumption.`,
    );
  }

  if (policy.probeRequirement === "none" && status !== "not-run") {
    problems.push(
      `${where} is a "${policy.profile}" record, whose evidence is the decision itself; a probe run here would claim a measurement that this profile does not make.`,
    );
  }

  // A rejection's evidence is a probe that did not succeed. A `passed` probe
  // beside it would mean the record both rejected and accepted the same
  // candidate, and the current shape would carry that into the lock and evaluate
  // it as verified — so it is refused rather than interpreted.
  if (policy.probeRequirement === "not-passed" && status === "passed") {
    problems.push(
      `${where} is a "${policy.profile}" record, whose evidence is a probe that did not pass; status "passed" contradicts the rejection. Record the failure, or record the strategy the package actually resolved to.`,
    );
  }

  return problems;
}

function validateTarget(
  where: string,
  record: LockedDependencyDecision,
  policy: LockEvidencePolicy,
): readonly string[] {
  const problems: string[] = [];
  const { target } = record;

  if (target !== null) {
    if (target.product.trim().length === 0 || target.productVersion.trim().length === 0 || target.productBuild.trim().length === 0) {
      problems.push(`${where} must name the product, version and build its runtime evidence is about.`);
    }
    if (target.hostReactVersion.trim().length === 0) {
      problems.push(`${where} must name the host React version its runtime evidence is about.`);
    }
  }

  // A target means "this evidence was observed under that runtime", which is a
  // compatibility claim only for the records that make one. For a technical
  // rejection it is the opposite — the failure is the evidence — so the passing
  // probe is asked for only where the record claims compatibility.
  if (requiresRuntimeValidation(record) && target !== null && record.probe.status !== "passed") {
    problems.push(
      `${where} names a Forguncy target while its probe is "${record.probe.status}". Runtime compatibility cannot be claimed from a probe that has not passed; record target as null until the probe passes against it.`,
    );
  }

  // Nothing was observed, so there is no runtime the evidence belongs to.
  if (policy.probeRequirement === "none" && target !== null) {
    problems.push(
      `${where} is a "${policy.profile}" record whose evidence is the decision itself, so it cannot name a runtime it was observed under; record target as null.`,
    );
  }

  if (requiresTargetIdentity(record) && target === null) {
    problems.push(
      `${where} uses strategy "${record.strategy}"${
        record.strategy === "replace" ? ` and rejection code "${record.rejection.code}"` : ""
      }, whose evidence is a property of the Forguncy runtime; the record must name the target it was observed under.`,
    );
  }

  return problems;
}

function validateProbedWith(where: string, record: LockedDependencyDecision): readonly string[] {
  const { probedWith, probe } = record;

  if (probedWith !== null && probedWith.vitePlus !== null && probedWith.vitePlus.trim().length === 0) {
    return [`${where} must either name the Vite+ version used for the probe or record null.`];
  }

  if (probedWith !== null && probe.status === "not-run") {
    return [
      `${where} records a toolchain for a probe that never ran. Either run the probe or record probedWith as null.`,
    ];
  }

  // #8 asks for the toolchain "when material", so the version may be null — but
  // once a probe has run the identity itself cannot be absent, or a Vite+ upgrade
  // could never invalidate this evidence and the record would be verified for
  // ever. A probe that never ran has no toolchain to record.
  if (probe.status !== "not-run" && probedWith === null) {
    return [
      `${where} records a "${probe.status}" probe without the toolchain it ran under. Record probedWith, and record vitePlus as null there only when its version is genuinely immaterial.`,
    ];
  }

  return [];
}

function validateExtension(where: string, record: LockedDependencyDecision): readonly string[] {
  const { extension, strategy } = record;

  if (strategy !== "extension") {
    return extension === null
      ? []
      : [`${where} records extension evidence on a "${strategy}" decision; extension identity belongs to \`extension\` records only.`];
  }

  if (extension === null) {
    return [`${where} is an \`extension\` decision and must record the extension version or identity it consumes.`];
  }

  if (extension.version === null && extension.identity === null) {
    return [
      `${where} must record the extension version or a content identity; an \`extension\` decision that names neither cannot be re-checked when the extension changes.`,
    ];
  }

  return [];
}

function validateRejectedCandidate(where: string, record: LockedDependencyDecision): readonly string[] {
  const { rejectedCandidate, strategy } = record;

  if (strategy !== "replace") {
    return rejectedCandidate === null
      ? []
      : [`${where} records a rejected candidate on a "${strategy}" decision; only a rejection has one.`];
  }

  if (record.rejection.kind === "architectural") {
    return rejectedCandidate === null
      ? []
      : [
          `${where} is an architectural rejection: the capability belongs to Forguncy whatever version the package is, so recording a rejected candidate version would tie an ownership conflict to a release.`,
        ];
  }

  // A compile-observed rejection is about **one** composed Cell and that Cell's configured cap
  // (#77 round 5, P1). `cellTarget: null` is not "unspecified" in this lock — it is the fallback
  // record for every Cell — so accepting it here would let one Cell's size observation become
  // "replace this package everywhere". Required only when the record carries the compile evidence
  // revision 15 introduced: a pre-revision-15 record has none, and refusing it would make an
  // existing lock unreadable instead of stale (`assessArtifactEvidenceFreshness` reports
  // `artifact-compile-unknown` for exactly that shape).
  if (record.artifactEvidence !== undefined && record.cellTarget === null) {
    return [
      `${where} records compile evidence for a "${record.rejection.kind === "technical" ? record.rejection.code : ""}" rejection without naming the Cell it measured. A composed Cell and its cap belong to one Cell target, and a null target is the record that applies to every Cell — so this would turn one Cell's size verdict into a rejection of the package everywhere. Name the Cell, or drop the compile evidence.`,
    ];
  }

  if (rejectedCandidate === null || rejectedCandidate.version.trim().length === 0) {
    return [
      `${where} is a technical rejection and must record the exact version of the candidate that failed; without it, one observed bundling failure becomes a permanent verdict on every future version.`,
    ];
  }

  return [];
}

function validateRationale(where: string, record: LockedDependencyDecision): readonly string[] {
  const requiresJustification = strategySemantics(record.strategy).requiresJustification;
  const { rationale } = record;

  if (requiresJustification && (rationale === null || rationale.trim().length === 0)) {
    return [
      `${where} uses strategy "${record.strategy}", which #4 requires a written justification for; fill \`rationale\` so the PR diff explains the strategy choice.`,
    ];
  }

  if (!requiresJustification && rationale !== null && rationale.trim().length === 0) {
    return [`${where} must either explain the strategy choice in \`rationale\` or record null.`];
  }

  return [];
}

function validateEvidence(where: string, record: LockedDependencyDecision): readonly string[] {
  const problems: string[] = [];
  const { evidence, probe } = record;

  if (evidence.length === 0) {
    problems.push(
      `${where} records no evidence. A strategy change must link the probe or decision it rests on, or it cannot be reviewed.`,
    );
    return problems;
  }

  for (const link of evidence) {
    if (!DECISION_EVIDENCE_KINDS.includes(link.kind)) {
      problems.push(`${where} references evidence of unknown kind "${String(link.kind)}".`);
    }
    if (!isEvidenceReference(link.reference)) {
      problems.push(
        `${where} references "${link.reference}", which is neither an http(s) URL nor a repository-relative path.`,
      );
    }
  }

  const hasProbeLink = evidence.some(link => link.kind === "probe" || link.kind === "runtime-observation");
  if (probe.status !== "not-run" && !hasProbeLink) {
    problems.push(
      `${where} claims a "${probe.status}" probe but links no \`probe\` or \`runtime-observation\` evidence to it.`,
    );
  }

  // Rule 5 of #8: an architectural conflict comes from #4, so the record has to
  // be traceable to the ownership decision rather than to a bundle experiment.
  if (record.strategy === "replace" && record.rejection.kind === "architectural") {
    const citesOwnership = evidence.some(link => citesDecision(link.reference, OWNERSHIP_AND_DEPENDENCY_DECISION));
    if (!citesOwnership) {
      problems.push(
        `${where} is an architectural rejection but links no evidence citing ${OWNERSHIP_AND_DEPENDENCY_DECISION.url}. Rule 5 of #8 routes these conflicts to the ownership decision in #4, so the record has to name it.`,
      );
    }
  }

  return problems;
}

export function assertFgcLockDocument(lock: FgcLockDocument): void {
  const problems = validateFgcLockDocument(lock);
  if (problems.length > 0) {
    throw new FgcLockValidationError(problems);
  }
}

/**
 * Throws unless the document is structurally sound, judging no rule.
 *
 * Exported because canonicalization *assumes* the shape — `[...lock.decisions]`,
 * `[...record.evidence]` — so a writer that canonicalizes before validating
 * throws a native `TypeError` from the canonicalizer instead of reporting a
 * broken document. Shape first, canonical form second, rules third; a canonical
 * order this has no opinion about, which is why it is not just
 * `assertFgcLockDocument`.
 */
export function assertFgcLockDocumentShape(input: unknown): void {
  const problems = inspectFgcLockDocument(input);
  if (problems.length > 0) {
    throw new FgcLockValidationError(problems);
  }
}

/**
 * Parse a lock file's text into a validated document.
 *
 * Structural checks run first so a malformed file reports what is wrong instead
 * of throwing from deep inside validation. An unsupported `schemaVersion` fails
 * here — the read path never silently accepts a shape it does not understand.
 */
export function parseFgcLockDocument(text: string): FgcLockDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new FgcLockValidationError([`${FGC_LOCK_FILE_NAME} is not valid JSON: ${(error as Error).message}`]);
  }

  // A declared-but-unsupported version fails with its own error type, so a
  // migration path can catch it specifically and refuse to read on a guess.
  if (isPlainRecord(parsed) && typeof parsed.schemaVersion === "number") {
    assertSupportedFgcLockSchemaVersion(parsed.schemaVersion);
  }

  const structural = inspectFgcLockDocument(parsed);
  if (structural.length > 0) {
    throw new FgcLockValidationError(structural);
  }

  const lock = parsed as FgcLockDocument;
  assertFgcLockDocument(lock);
  return lock;
}
