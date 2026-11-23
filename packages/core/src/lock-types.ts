/**
 * The project-local dependency decision lock, `fgc.lock.json` — the model.
 *
 * Decision source: GitHub Issue #8 — "Spec: reproducible dependency decisions
 * and `fgc.lock.json`". Governing architecture Specs: #4, which defines the four
 * strategies, and #5, which is where the Forguncy target a runtime claim is about
 * was converted into observed facts.
 *
 * Why the lock exists: npm compatibility cannot be captured by a hand-maintained
 * adapter registry, and letting an Agent re-decide every package on every run is
 * not reproducible. The lock is the middle path — a reviewable record of
 * decisions already made for *this* project.
 *
 * What this module is: the document shape, what each record has to carry, the
 * per-profile evidence policy, and the canonical form. It owns no filesystem and
 * no evaluation — reading and writing the file is `dependency-resolver`'s job,
 * and deciding whether a record is still usable is `lock-freshness.ts`.
 *
 * Two properties are load-bearing for review:
 *
 * - **Determinism.** Canonical ordering, a fixed key order and no timestamps mean
 *   identical decisions produce identical bytes, so a real strategy change is the
 *   only thing that shows up as a diff.
 * - **Portability.** Every recorded reference is a URL or a repository-relative
 *   path, and an absolute machine path *anywhere* in the document — including
 *   inside a fingerprint — is a validation failure rather than a style nit: it
 *   makes the decision unreproducible on another machine and in CI.
 */

import type { ArchitectureDecisionSource } from "./governance.ts";
import {
  DEPENDENCY_LOCK_DECISION,
  formatGoverningSpecReferenceLine,
  GOVERNING_ARCHITECTURE_DECISIONS,
} from "./governance.ts";
import { isArtifactObservedRejectionCode } from "./rejection.ts";
import type { TechnicalRejectionCode } from "./rejection.ts";
import type { RuntimeContractTarget } from "./runtime-contract.ts";
import { RUNTIME_CONTRACT_TARGET } from "./runtime-contract.ts";
import type { DependencyDecision } from "./strategy.ts";
import { requiresRealRuntimeValidation } from "./strategy.ts";

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Every Spec a change to this module has to cite: the architecture decisions
 * first, then the lock Spec built on them.
 *
 * Composed from the records `core` owns rather than from a second copy of them,
 * so a consumer has one place to look and the two lists cannot drift.
 */
export const LOCK_GOVERNING_DECISIONS: readonly ArchitectureDecisionSource[] = [
  ...GOVERNING_ARCHITECTURE_DECISIONS,
  DEPENDENCY_LOCK_DECISION,
];

/** The line a PR body, plan or report describing this model carries. */
export const LOCK_GOVERNING_SPEC_REFERENCE_LINE = formatGoverningSpecReferenceLine(LOCK_GOVERNING_DECISIONS);

export const FGC_LOCK_FILE_NAME = "fgc.lock.json";

/**
 * Bumped whenever the on-disk shape changes incompatibly. An unknown version is
 * an explicit failure rather than a best-effort read: silently accepting a
 * future document would let a newer tool's decisions go unvalidated here.
 */
export const FGC_LOCK_SCHEMA_VERSION = 1;

export const SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS: readonly number[] = [1];

// ---------------------------------------------------------------------------
// Target identity (#5)
// ---------------------------------------------------------------------------

/**
 * The Forguncy identity a runtime claim is about.
 *
 * Derived from the verified target contract (#5) instead of being declared
 * afresh, because a lock that can name "Forguncy 12" in its own vocabulary will
 * eventually name a version the contract probe never measured.
 *
 * `hostReactVersion` is part of the identity because a `host` decision is a claim
 * about the global a specific product build injects: whether the mapped module
 * still has the identity and peer range the cell expects is decided by the host
 * React version, not by the product version string alone.
 */
export interface ForguncyTargetIdentity {
  readonly product: string;
  readonly productVersion: string;
  readonly productBuild: string;
  readonly hostReactVersion: string;
}

export function forguncyTargetIdentity(
  target: RuntimeContractTarget = RUNTIME_CONTRACT_TARGET,
): ForguncyTargetIdentity {
  return {
    product: target.product,
    productVersion: target.productVersion,
    productBuild: target.productBuild,
    hostReactVersion: target.hostReactVersion,
  };
}

/**
 * Field-by-field comparison, deliberately not object identity: a lock record is
 * deserialized from JSON and can never share an object with the live contract.
 */
export function matchesForguncyTargetIdentity(
  recorded: ForguncyTargetIdentity,
  current: ForguncyTargetIdentity,
): boolean {
  return (
    recorded.product === current.product &&
    recorded.productVersion === current.productVersion &&
    recorded.productBuild === current.productBuild &&
    recorded.hostReactVersion === current.hostReactVersion
  );
}

/**
 * The install graph a probe resolved against, as content identities rather than versions.
 *
 * Decision source: GitHub Issue #94 — "Probe 身份：采集真实安装图、补丁和实际构建工具版本"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/94
 *
 * Why digests and not a resolved-version map: the question a stale record has to answer is
 * "would this probe see the same files if it ran now", and that is a property of the whole
 * resolution — a transitive bump, an `overrides` entry, a patch applied to a dependency the
 * record never names. Recording the versions of the packages a decision *mentions* cannot answer
 * it, which is the hole #94 found: `resolvedVersion` was unchanged while the artifact was not.
 *
 * **Scope, stated so the invalidation is predictable.** The digests cover the lockfile the
 * resolution came from, the declared patch set, and the project configuration that affects
 * resolution. They are deliberately **conservative**: a change to a dependency no probed package
 * can reach still invalidates, because deciding reachability is the bundler's answer and this
 * layer does not re-derive it. Narrowing to the reachable subgraph is a later optimisation, not a
 * licence to guess here.
 *
 * **Portable by construction.** Every digest is over file *content*; no path — and certainly no
 * absolute path — is part of the input. The same real inputs in two directories therefore compose
 * the same identity, which is what lets a lock written on one machine be judged on another.
 *
 * **A `null` component is unknown, and unknown is stale** (`lock-freshness.ts`). It is never
 * "immaterial": an identity that cannot say which install graph it used cannot confirm the
 * evidence still holds, and a lock whose whole purpose is reproducibility must not be the one
 * place that guesses in favour of the newer claim.
 */
export interface InstallGraphIdentity {
  /**
   * Content digest of the package manager lockfile the install came from, e.g. `sha256:1f0c…`.
   *
   * `null` when the project has no lockfile this toolchain recognizes. Null is not "no install
   * graph" — it is "this probe cannot say which install graph it used". Such a project can still
   * be probed; it cannot have its probe evidence *verified*, and freshness says so.
   */
  readonly lockfile: string | null;
  /**
   * Content digest of the declared patch set: the declarations *and* the patch files they name.
   *
   * Both halves are needed. The declarations say which patches apply; the file contents say what
   * they do, and a patch edited without a re-install is exactly the change a declaration-only
   * digest would miss.
   */
  readonly patches: string | null;
  /**
   * Content digest of the project configuration that affects resolution — `pnpm-workspace.yaml`
   * (overrides, catalogs, workspace globs, patch declarations) and the manifest's package-manager
   * field.
   *
   * Separate from the lockfile because the two move independently: a config edited without a
   * re-install leaves a lockfile that describes a resolution nobody has any more.
   */
  readonly configuration: string | null;
  /**
   * Digest of what the package manager actually **installed**, from its own on-disk record — or
   * `null` when the manager writes no such record this toolchain can read.
   *
   * **Why a fourth component, when `lockfile` and `configuration` already describe the inputs.**
   * Review showed that inputs cannot confirm a result: the effective install is decided partly by
   * *install-time* parameters that reach no digest at all. npm derives its `omit` default from
   * `process.env.NODE_ENV`, `--omit=optional` is a CLI flag, and neither is written to
   * `package-lock.json` or `.npmrc`. Measured end to end, on a real npm project: a default install
   * puts `@rolldown/binding-win32-x64-msvc` on disk while `npm install --omit=optional` does not,
   * and the two runs produce a **byte-identical** `package-lock.json` — so every earlier component
   * composed the same digest and a warm probe cache answered for a tree that had changed.
   *
   * The manager's own record is the answer because it is a fact about the *result* rather than
   * about the request, and it is what the probe actually measured:
   *
   * - pnpm writes `node_modules/.modules.yaml`, whose `included` records which dependency classes
   *   were installed (`--no-optional` flips `optionalDependencies` to `false`) and whose
   *   `nodeLinker` records the layout. Both are portable — measured: plain booleans and an enum,
   *   with no machine path.
   * - npm writes `node_modules/.package-lock.json`, the materialized entry set.
   *
   * **`null` means unknown, and unknown is stale** — the same rule every other component follows.
   * One consequence is deliberate rather than overlooked: npm's entry set names the *platform*
   * binding it installed, so the digest differs between a Windows and a Linux install of the same
   * project. That is the honest answer, because those really are different installs, and a record
   * measured on one cannot describe the other.
   *
   * **Optional, for the read path's sake**, exactly as `ToolchainIdentity.rolldown` and the other
   * post-hoc fields are: a record written before this component existed has no such key, and a
   * required annotation would assert one the parser does not guarantee. Freshness reads an absent
   * value as `unknown` through `?? null`, so the weaker type costs no verification strength — such a
   * record is stale rather than passable.
   */
  readonly installedTree?: string | null;
}

/**
 * The toolchain that produced a record's technical evidence.
 *
 * **Every component is an identity of the *actual* thing used, not of a declared string.** The
 * defect #94 closes: a probe resolved a different transitive dependency, applied a patch, or ran
 * a different Rolldown, and the record still reported `fresh` — because the only thing compared
 * was `vite-plus` as *spelled* in the project's manifest, and a manifest is a request rather than
 * an install result. Two projects that both write `"vite-plus": "0.3.2"` can run different
 * bundlers, and one can carry a patched transitive dependency the other does not.
 *
 * `rolldown` and `node` are **unknown when `null`**, and unknown is stale rather than immaterial
 * (`toolchain-unknown`). `vitePlus` keeps its older, weaker reading — see its own note — because
 * #8 allowed a record to declare that version genuinely immaterial, and re-reading that
 * declaration as "unknown" would silently re-open every record that made it.
 */
export interface ToolchainIdentity {
  /**
   * Vite+ version, e.g. `0.3.2`.
   *
   * Read from the **installed** `vite-plus` manifest rather than from the declaring manifest's
   * range: `"^0.3.2"` and `"0.3.2"` name different installed tools, and only the installed one
   * says what ran. `null` when it is not installed where the project resolves.
   *
   * The one component whose `null` may mean "genuinely immaterial" rather than "unknown": #8 asks
   * for the toolchain "when material", and a record that declares it immaterial is not re-opened
   * by a Vite+ upgrade. `validateProbedWith` states when that declaration is legal.
   */
  readonly vitePlus: string | null;
  /**
   * The Rolldown version the bundler actually ran, e.g. `1.2.9`.
   *
   * Resolved as `rolldown` **from the project**, which is the module a build imports — not the
   * copy Vite+ carries internally. Those are different tools with independent versions, and
   * conflating them is the error this field exists to make impossible: upgrading one is not
   * upgrading the other, and a record measured through the project's Rolldown says nothing about
   * a build that goes through Vite+'s.
   *
   * Optional for the read path's sake, exactly as {@link installGraph} is: a record written before
   * this axis existed has no key here, and the type must not assert one the parser does not
   * guarantee. Freshness reads an **absent** value the same way it reads `null` — unknown, hence
   * `toolchain-unknown` — so the weaker annotation costs no verification strength.
   */
  readonly rolldown?: string | null;
  /**
   * The exact Node version the probe ran under, e.g. `24.21.0`. Optional for {@link rolldown}'s
   * reason.
   *
   * **Exact, not the major line**, and this component was the major until review round 8. The
   * argument for the major was that only a major changes resolution while patch and minor lines are
   * bugfix-only — and that argument is false, because a resolver bugfix *is* a resolution change.
   * The counterexample is Node's own and it is about the primitive this toolchain calls: 23.6.0
   * carries `module: fix async resolution error within the sync findPackageJSON`
   * (nodejs/node#56382), a **minor** release within one major, and `package-locator.ts` resolves
   * every identity through exactly that function. Under the major reading, 23.5.x and 23.6.0 both
   * record `"23"`, so a package graph that moved between them left every toolchain axis reporting
   * "unchanged".
   *
   * The cost is real and deliberate: CI pins `node-version: "24"`, which resolves to whatever the
   * newest 24.x is, so a runner that picks up a new patch reports `toolchain-changed` and re-probes
   * a record that would have been fine. That is a false *stale* — it costs one measurement — and it
   * is the direction this axis has chosen over a false *fresh* at every review round.
   *
   * `rolldown` and `vitePlus` are exact for the same reason rather than the opposite one: a bundler
   * patch changes emitted bytes, which is exactly what a size measurement is about.
   */
  readonly node?: string | null;
  /**
   * The install graph the probe resolved against.
   *
   * Optional so a record written before this axis existed still parses: the read path treats an
   * **absent** key exactly as it treats `null`, i.e. unknown, and reports `install-graph-unknown`
   * rather than refusing the document — #8's migration contract, and the same shape
   * `imports` and `artifactEvidence` already take. A required field would be a type asserting a
   * key a prior toolchain's lock does not have, so every consumer would read `undefined` where
   * the annotation promised an object.
   */
  readonly installGraph?: InstallGraphIdentity | null;
}

// ---------------------------------------------------------------------------
// Probe evidence
// ---------------------------------------------------------------------------

export const PROBE_STATUSES = ["not-run", "passed", "failed"] as const;
export type ProbeStatus = (typeof PROBE_STATUSES)[number];

/**
 * Probe evidence, recorded as inputs rather than as a timestamp.
 *
 * A `Date` would make the lock non-deterministic and would still not answer the
 * question that matters ("was the probe run against the thing we have now?"), so
 * freshness is computed from the fingerprint and the recorded identities.
 */
export interface LockProbeEvidence {
  readonly status: ProbeStatus;
  /**
   * Identity of the probe inputs the lock does *not* model separately.
   *
   * Deliberately not a fingerprint of everything the probe saw. The resolved
   * version, the Forguncy target and the toolchain each have their own field on
   * this record and their own freshness reason, so folding them in here would
   * report one change twice — and it would silently defeat `versionIndependent`:
   * an upgrade that flag permits would still move a fingerprint containing the
   * version, so the record would go stale anyway and the flag would mean nothing.
   *
   * What belongs here is the rest of the probe's declared inputs: the entry, the
   * probe id, the probe configuration, and any bundler input no other field
   * captures.
   *
   * The contract is that the value is a deterministic function of those inputs
   * and can therefore be *recomputed without re-running the probe*. That is what
   * lets `LockEnvironment.probeFingerprints` be compared against it, and why an
   * entry or configuration change is detectable while every version in the
   * record still matches. Composing it is the probe engine's job (#17); this
   * module only requires that both sides compose it the same way, and only over
   * the inputs listed above. Required once a probe has run, null while `status`
   * is `not-run`.
   */
  readonly fingerprint: string | null;
  /**
   * Rule 2 of #8: set `true` only when the probe was *explicitly shown* to be
   * version-independent. Otherwise an exact package version change invalidates
   * this evidence rather than being assumed harmless.
   */
  readonly versionIndependent: boolean;
}

// ---------------------------------------------------------------------------
// Evidence links
// ---------------------------------------------------------------------------

export const DECISION_EVIDENCE_KINDS = ["spec-issue", "probe", "pull-request", "runtime-observation"] as const;
export type DecisionEvidenceKind = (typeof DECISION_EVIDENCE_KINDS)[number];

/**
 * A link to the evidence a decision rests on.
 *
 * #8's acceptance criteria require a strategy change to link to probe/decision
 * evidence. A link is a URL or a repository-relative path — see
 * `isEvidenceReference`.
 */
export interface DecisionEvidenceLink {
  readonly kind: DecisionEvidenceKind;
  readonly reference: string;
}

// ---------------------------------------------------------------------------
// Profile-specific evidence
// ---------------------------------------------------------------------------

/**
 * Which of the four strategies an `extension` record was validated against.
 *
 * Only the parts the decision itself does not already carry: `libraryId` and
 * `globalName` live on `ExtensionDependencyDecision`, so repeating them here
 * would create two sources of truth in one record.
 */
export interface ExtensionEvidence {
  /** Extension package version, when one is knowable. */
  readonly version: string | null;
  /**
   * Content identity when a version is not authoritative (a packaged upload, or a
   * ref in the extension repository). Never a machine path.
   */
  readonly identity: string | null;
}

/**
 * The exact candidate a *technical* rejection is about.
 *
 * Recorded because a bundling failure is a property of one artifact: without the
 * version, "this package cannot be inlined" silently becomes a permanent verdict
 * that survives every upgrade that might have fixed it. An architectural
 * rejection needs none of this — the capability belongs to Forguncy whatever
 * version the package is.
 */
export interface RejectedCandidateEvidence {
  readonly version: string;
}

export interface LockRecordMetadata {
  /**
   * Cell target the decision applies to, or null when it applies to every target.
   *
   * Present because #4 defines a strategy as a decision per (package, cell
   * target) pair, not as a property of the package: the same package can
   * legitimately be `inline` in one cell and `host`-mapped in another. Nullable
   * so the lock stays usable before Cell target declarations land (#26).
   */
  readonly cellTarget: string | null;
  /**
   * The named bindings the probe's synthetic entry imported, in canonical (sorted, deduplicated)
   * order; null when it kept the whole namespace.
   *
   * Recorded for two reasons, and **neither of them authorizes a rejection** (#77 revision 13:
   * no probe run files the cap verdict, because the probe's build and the compiler's do not share
   * a resolution graph and the surface is a caller's declaration anyway):
   *
   * - It is one of the fingerprint's declared inputs, so `status` has to read it back to rebuild
   *   the fingerprint the record was measured under. Without it a named-surface record would be
   *   rebuilt as a namespace run and report `probe-fingerprint-changed` for a measurement that
   *   had not moved.
   * - It makes the record's own size evidence interpretable: a namespace probe's number leans
   *   over what a Cell carries, a named one leans under. A reader weighing the estimate needs to
   *   know which it is; the estimate itself is never disqualifying.
   *
   * Optional, not required, and the read path is why: `inspectLockRecord` accepts an **absent**
   * key as the namespace surface, and `parseFgcLockDocument` casts the parsed JSON without
   * normalizing it. A required field would therefore be a type claiming a key that a lock
   * written before #77 does not have — the annotation would assert more than the read path
   * guarantees, and every consumer would be reading `undefined` where the type promised
   * `string[] | null`. Stating it as optional keeps the two in agreement, and the three spellings
   * of "the whole namespace" (absent, `undefined`, `null`) all mean one thing.
   *
   * The fingerprint composition omits the key entirely for that state, so such a record still
   * recomposes to the bytes it was written with.
   */
  readonly imports?: readonly string[] | null;
  /**
   * Exact resolved version of the package in this workspace.
   *
   * Null for every `replace` record, which by rule 4 of #8 keeps no dependency:
   * recording a version there would imply the package is still installed for the
   * cell. A technical rejection records the candidate it rejected in
   * `rejectedCandidate` instead.
   */
  readonly resolvedVersion: string | null;
  readonly probe: LockProbeEvidence;
  /**
   * The runtime this evidence was validated against, or null when it has not
   * been validated in one yet.
   *
   * Null is a state rather than a gap: a locally probed decision awaiting its
   * first real-page check is exactly this, and `resolveLockDecision` reports it
   * as `not-validated` instead of verified. Its presence *is* the runtime claim,
   * and validation ties it to a passing probe, so the claim cannot be made from
   * a probe that failed or never ran.
   */
  readonly target: ForguncyTargetIdentity | null;
  /** Toolchain used for the technical probe, when material. */
  readonly probedWith: ToolchainIdentity | null;
  /** `extension` records only; null for every other strategy. */
  readonly extension: ExtensionEvidence | null;
  /** Technical rejections only; null everywhere else. */
  readonly rejectedCandidate: RejectedCandidateEvidence | null;
  /**
   * Why this strategy, required exactly when #4's semantics require a written
   * justification (`extension`, `replace`) and null otherwise.
   */
  readonly rationale: string | null;
  /** Never empty: a decision with no evidence is a decision nobody can re-check. */
  readonly evidence: readonly DecisionEvidenceLink[];
}

/**
 * A lock record: a dependency decision (#4) plus the provenance that lets it be
 * invalidated (#8).
 *
 * Intersected rather than re-declared on purpose — the lock cannot drift from
 * the decision model, and `validateDependencyDecisionShape` applies unchanged.
 */
export type LockedDependencyDecision = DependencyDecision & LockRecordMetadata;

export interface FgcLockDocument {
  readonly schemaVersion: number;
  readonly decisions: readonly LockedDependencyDecision[];
}

export function createEmptyFgcLock(): FgcLockDocument {
  return { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [] };
}

// ---------------------------------------------------------------------------
// Evidence policy (#8 rules 2, 3 and 4)
// ---------------------------------------------------------------------------

/**
 * What kind of claim a record is making.
 *
 * Keyed by profile rather than by strategy because `replace` is two different
 * things wearing one strategy name: an ownership conflict is a fact about the
 * capability, while a bundling failure is a fact about one artifact. Treating
 * them alike is what turns a technical rejection into a permanent cache.
 *
 * - `resolved-dependency` — `host`, `inline` and `extension`: the package reaches
 *   the generated graph, so the record has to survive both the package and the
 *   target moving.
 * - `architectural-rejection` — the capability belongs to Forguncy (#4, rule 5
 *   of #8). It does not expire with a version bump, because no version of the
 *   package can move the capability to the other side of the ownership boundary.
 * - `technical-rejection` — the right role, the wrong artifact. Re-evaluated when
 *   the candidate, the toolchain or the target moves, because any of them can
 *   turn the failure into a success.
 */
export const LOCK_EVIDENCE_PROFILES = [
  "resolved-dependency",
  "architectural-rejection",
  "technical-rejection",
  "artifact-rejection",
] as const;
export type LockEvidenceProfile = (typeof LOCK_EVIDENCE_PROFILES)[number];

/**
 * Which probe outcome a profile's evidence is.
 *
 * Named for the outcome rather than for "how much evidence", because the profiles
 * want different outcomes and the difference is semantic:
 *
 * - `none` — no probe belongs to this record at all.
 * - `passed` — the record is usable once a probe passes. A failed or missing
 *   probe is still a legitimate record — an Agent should be able to see the
 *   attempt — so it is recorded and evaluates as stale rather than being refused
 *   when it is written. A failure is history; only success is compatibility.
 * - `not-passed` — a rejection's evidence is a probe that did *not* succeed.
 *   `not-run` is allowed, because a rejection can come from reading the
 *   package's requirements rather than from a bundle attempt, and freshness
 *   reports it as unverified. `passed` is refused: a record cannot both reject a
 *   candidate and hold a probe that accepted it.
 *
 * `passed` covers two profiles with opposite conclusions, and that is the point rather than a
 * conflation: a `resolved-dependency` record *adopts* the package a passing probe describes,
 * while an `artifact-rejection` record rejects a different document — the composed Cell — that
 * the probe never builds. In both cases the package itself passed, so requiring anything else
 * would make the expected state (a good package that produces a too-large Cell) unrecordable.
 */
export const LOCK_PROBE_REQUIREMENTS = ["none", "passed", "not-passed"] as const;
export type LockProbeRequirement = (typeof LOCK_PROBE_REQUIREMENTS)[number];

export interface LockEvidencePolicy {
  readonly profile: LockEvidenceProfile;
  /** A different Forguncy target invalidates this record's evidence. */
  readonly invalidatedByTargetChange: boolean;
  /** Which probe outcome the record's evidence is. */
  readonly probeRequirement: LockProbeRequirement;
  /** The package appears in the generated dependency graph (rule 4 of #8). */
  readonly participatesInCompilation: boolean;
}

export const LOCK_EVIDENCE_POLICY: Readonly<Record<LockEvidenceProfile, LockEvidencePolicy>> = {
  "resolved-dependency": {
    profile: "resolved-dependency",
    invalidatedByTargetChange: true,
    probeRequirement: "passed",
    participatesInCompilation: true,
  },
  "architectural-rejection": {
    profile: "architectural-rejection",
    // The capability cannot be moved by a product upgrade, so there is nothing
    // in the runtime to invalidate this. Its evidence is the ownership decision.
    invalidatedByTargetChange: false,
    probeRequirement: "none",
    participatesInCompilation: false,
  },
  "technical-rejection": {
    profile: "technical-rejection",
    // A product upgrade can fix a bundling failure, so the rejection is tied to
    // the target it was observed under.
    invalidatedByTargetChange: true,
    probeRequirement: "not-passed",
    participatesInCompilation: false,
  },
  "artifact-rejection": {
    profile: "artifact-rejection",
    // The package's own probe **passed** — the rejection is about the composed Cell, which no
    // probe builds (#77 revision 14). Its evidence is `artifactEvidence`: the measured
    // `codeCharacters` against the cap the compile used.
    //
    // Tied to the target because the Cell is compiled for one: a different host React, or a
    // different product build, composes a different artifact.
    invalidatedByTargetChange: true,
    probeRequirement: "passed",
    // False for the same reason as the other rejections: a `replace` keeps no dependency for the
    // compiled cell, so this package does not appear in its graph. What *is* compiled is the
    // replacement, under its own record.
    participatesInCompilation: false,
  },
};

/**
 * Technical rejections that cannot be confirmed without a real Forguncy runtime.
 *
 * The profile default — "a bundling failure is reproducible locally" — is true
 * for the artifact-shaped failures, and false for the three below, which are
 * observations of the host: which module identity a global actually has, whether
 * a global name collides with the host's, and whether a runtime API the package
 * needs exists at all. A record citing one of these without naming the target it
 * was observed under would claim a runtime fact it never observed, so validation
 * requires the target for exactly these codes.
 *
 * The split is a judgement per code rather than a property of `replace`, and
 * later Specs (#12 extension externals, #17 probe engine) may refine it — hence
 * a named list instead of logic buried in a validator.
 */
export const RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES: readonly TechnicalRejectionCode[] = [
  "host-module-identity-mismatch",
  "global-namespace-collision",
  "runtime-api-unavailable",
];

/**
 * Whether the record has to name the Forguncy target its evidence is about.
 *
 * Deliberately narrow, and narrow is the point. For a resolved dependency a
 * target is a *verification claim*, and its absence is a state —
 * `not-validated` — not a shape error. Requiring the field there made the states
 * the model exists to express unpresentable: a locally probed record awaiting its
 * runtime check, and a record whose probe failed or has not run, could not be
 * written to a real lock file at all, so `not-validated`, `probe-failed` and
 * `probe-never-run` only ever existed in hand-built test objects.
 *
 * The one place the field remains a shape requirement is a rejection that only a
 * runtime can observe: without a target the record would claim a runtime fact it
 * never saw. Which codes those are is {@link RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES}.
 */
export function requiresTargetIdentity(record: LockedDependencyDecision): boolean {
  return (
    record.strategy === "replace" &&
    record.rejection.kind === "technical" &&
    RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES.includes(record.rejection.code)
  );
}

/**
 * Whether the strategy's real-runtime checks are still owed for this record.
 *
 * Delegates to #4 instead of restating its answer: `strategy.ts` already declares
 * `realRuntimeRequired: true` for every strategy, and a second table deciding the
 * same question is exactly how the two drift apart. `inline` is included, which
 * is the point — an inlined bundle is still executed by the runtime it was built
 * for, so a green local probe is never on its own a compatibility claim.
 *
 * `replace` is the one divergence, and it is not a disagreement: #4's
 * `realRuntimeRequired` for `replace` is a check on the *replacement*, which
 * carries its own record. This record compiles nothing, so it owes no runtime
 * check of its own.
 */
export function requiresRuntimeValidation(record: LockedDependencyDecision): boolean {
  return record.strategy === "replace" ? false : requiresRealRuntimeValidation(record.strategy);
}

/**
 * The evidence profile of a decision that has not been recorded yet.
 *
 * Extracted from {@link lockEvidenceProfileOf} so a caller holding a #4 decision but
 * no lock record — the selection audit in `selection-policy.ts` — can ask #8 which
 * probe outcome the decision owes, instead of keeping a second copy of this mapping.
 * The two would drift, and the drift would be invisible: a record written under one
 * answer and evaluated under the other looks like a fresh decision.
 */
export function lockEvidenceProfileForDecision(decision: DependencyDecision): LockEvidenceProfile {
  if (decision.strategy !== "replace") {
    return "resolved-dependency";
  }
  if (decision.rejection.kind === "architectural") {
    return "architectural-rejection";
  }
  // A technical rejection splits by *what observed it*: a probe reports the package's own
  // failure, while a compose reports the Cell's size. The two want different probe outcomes —
  // `not-passed` and `passed` respectively — so the split has to happen here, where the code is
  // known, rather than in a validator that would have to special-case the policy back.
  return isArtifactObservedRejectionCode(decision.rejection.code) ? "artifact-rejection" : "technical-rejection";
}

export function lockEvidenceProfileOf(record: LockedDependencyDecision): LockEvidenceProfile {
  return lockEvidenceProfileForDecision(record);
}

export function lockEvidencePolicyFor(record: LockedDependencyDecision): LockEvidencePolicy {
  return LOCK_EVIDENCE_POLICY[lockEvidenceProfileOf(record)];
}

// ---------------------------------------------------------------------------
// Projection onto #4's decision model
// ---------------------------------------------------------------------------

/**
 * The lock record reduced to the decision the compiler is allowed to see.
 *
 * The compiler's input is `DependencyDecision[]` (#6), and lock metadata is not
 * part of that contract. Projecting explicitly rather than passing the whole
 * record stops a compiler from starting to depend on `probe` or `evidence`
 * fields that exist for invalidation, not for bundling.
 */
export function dependencyDecisionOf(record: LockedDependencyDecision): DependencyDecision {
  switch (record.strategy) {
    case "inline":
      return { strategy: "inline", packageName: record.packageName };
    case "host":
      return { strategy: "host", packageName: record.packageName, globalName: record.globalName };
    case "extension":
      return {
        strategy: "extension",
        packageName: record.packageName,
        libraryId: record.libraryId,
        globalName: record.globalName,
      };
    case "replace":
      return {
        strategy: "replace",
        packageName: record.packageName,
        rejection: record.rejection,
        ...(record.alternatives === undefined ? {} : { alternatives: record.alternatives }),
        ...(record.supersededBy === undefined ? {} : { supersededBy: record.supersededBy }),
      };
  }
}

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export function isSupportedFgcLockSchemaVersion(version: unknown): version is number {
  return typeof version === "number" && SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS.includes(version);
}

/**
 * Fails explicitly on an unknown schema version — the read path must not guess.
 */
export function assertSupportedFgcLockSchemaVersion(version: number): void {
  if (!isSupportedFgcLockSchemaVersion(version)) {
    throw new FgcLockSchemaVersionError(version);
  }
}

export class FgcLockSchemaVersionError extends Error {
  readonly schemaVersion: number;

  constructor(schemaVersion: number) {
    super(
      `${FGC_LOCK_FILE_NAME} declares unsupported schema version ${String(schemaVersion)}; this toolchain supports ${SUPPORTED_FGC_LOCK_SCHEMA_VERSIONS.join(", ")}. Migrate the lock deliberately rather than reading it on a best-effort basis.`,
    );
    this.name = "FgcLockSchemaVersionError";
    this.schemaVersion = schemaVersion;
  }
}
