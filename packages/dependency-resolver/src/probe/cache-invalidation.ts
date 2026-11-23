/**
 * Whether a stored probe report may answer this run, and why it may not (#161).
 *
 * Split mechanically out of `probe-engine.ts`; the reasoning is the moved comments' own.
 */
import type {
  ForguncyTargetIdentity,
  ProbeReport,
  ToolchainIdentity,
} from "@forguncy-react-workspace/core";
import { matchesForguncyTargetIdentity } from "@forguncy-react-workspace/core";

import type { ResolvedPackageIdentity } from "./identity.ts";

/**
 * Why a stored report could not answer this run — the readable invalidation reason #95 asks for.
 *
 * The vocabulary mirrors `core`'s `LockStalenessReason` names deliberately, because the two
 * answers describe the same facts one layer apart: the lock asks "is this *record* still about
 * my install", the cache asks "is this *report* still about my install". A reader who learns one
 * list can read the other.
 *
 * `no-cached-report` is the only reason that does not name a difference: nothing was stored
 * under the composed fingerprint, which is the ordinary first-run answer (and also the answer
 * for an unreadable or fingerprint-mismatched file, which the cache treats identically by
 * design — it never throws for bad state).
 */
export const PROBE_CACHE_MISS_REASONS = [
  "no-cached-report",
  "package-name-changed",
  "package-version-changed",
  "toolchain-changed",
  "toolchain-unknown",
  "install-graph-changed",
  "install-graph-unknown",
  "forguncy-target-changed",
  "runtime-smoke-requested",
] as const;
export type ProbeCacheMissReason = (typeof PROBE_CACHE_MISS_REASONS)[number];

/**
 * Why a cached report may not answer *this* run, or null when it may.
 *
 * The lock fingerprint deliberately excludes package version, toolchain and
 * target (#8 tracks those staleness dimensions separately), so the cache cannot
 * inherit that exclusion: a hit under the same fingerprint still has to describe
 * the artifact and environment now in front of the engine. `entry` is part of
 * the fingerprint but is overridable, so two packages can share one fingerprint
 * — the cached environment must still name *this* package before it answers.
 *
 * Smoke mode is checked in both directions: a supplied hook always re-probes
 * (the cached report may never have collected runtime evidence), and a hookless
 * run only accepts a cached report whose `runtime-smoke` is `skipped` — a
 * hook-bearing report would otherwise leak runtime facts/risks/rejections into
 * a run that explicitly did not perform runtime smoke.
 *
 * **Returning the reason rather than a boolean is #95's first acceptance criterion.** A
 * re-probe is the correct outcome, but a caller that only learns "not from cache" cannot tell an
 * ordinary first run from an invalidation, and the one that matters — the root version held at
 * `a@1.0.0` while a transitive moved — has to be *readable*. The checks are ordered so the most
 * specific fact wins: identity first (nothing else matters if it is a different package), then
 * version, then the toolchain and the install graph separately (different fixes: upgrade versus
 * re-install), then the target, then run mode.
 */
export function cacheInvalidationReason(
  cached: ProbeReport,
  identity: ResolvedPackageIdentity,
  toolchain: ToolchainIdentity,
  target: ForguncyTargetIdentity | null,
  runtimeSmokeRequested: boolean,
): { readonly reason: ProbeCacheMissReason; readonly detail: string } | null {
  // A supplied hook always re-probes, and this check comes first because it is the one reason that
  // is not a difference: the run mode itself forbids reusing a stored report. The mirror case
  // (below, after the toolchain comparison) is checked separately — a hookless run must never
  // accept a stored report that carries runtime evidence — so neither direction of the isolation
  // depends on the other.
  if (runtimeSmokeRequested) {
    return {
      reason: "runtime-smoke-requested",
      detail:
        "A runtime-smoke hook was supplied for this run, and a cached report is never storage for runtime evidence: the hook has to execute again here, and its result is never inherited from an earlier run.",
    };
  }
  if (cached.environment.packageName !== identity.packageName) {
    return {
      reason: "package-name-changed",
      detail: `The cached report describes "${cached.environment.packageName}", not "${identity.packageName}"; the two composed one fingerprint through an overridden entry, and a report about one package cannot answer a probe of another.`,
    };
  }
  if (cached.environment.packageVersion !== identity.packageVersion) {
    return {
      reason: "package-version-changed",
      detail: `The cached report measured "${identity.packageName}@${cached.environment.packageVersion}" and "${identity.packageVersion}" is installed now; the artifact changed, so its measurement no longer describes this install.`,
    };
  }
  // The whole toolchain, not only `vitePlus` (#94). Comparing one component let a cached report
  // answer a run that had upgraded Rolldown, moved to another Node, or — the case that matters
  // most — installed a different transitive graph or a patch, because none of those moved the one
  // string being compared. A cache hit is a claim that the stored report describes *this* run, so
  // every component the report records has to agree.
  //
  // The two reasons are separated because the fixes differ: a moved tool or install graph needs a
  // re-probe, while a component this run cannot establish needs `install` (or a project layout
  // this toolchain can read) before any measurement would mean anything.
  const toolchainProblem = toolchainIdentityProblem(cached.environment.toolchain, toolchain);
  if (toolchainProblem !== null) {
    return toolchainProblem;
  }
  const cachedSmoke = cached.validation.find(entry => entry.step === "runtime-smoke");
  if (cachedSmoke?.outcome !== "skipped") {
    return {
      reason: "runtime-smoke-requested",
      detail:
        "The stored report carries runtime evidence (`runtime-smoke` did not skip) and this run requested none, so answering from it would hand this run a runtime result it never asked for.",
    };
  }
  const cachedTarget = cached.environment.target;
  if (target === null || cachedTarget === null) {
    if (cachedTarget !== target) {
      return {
        reason: "forguncy-target-changed",
        detail:
          target === null
            ? "The cached report was measured against a named Forguncy target and this run names none; a target-scoped observation cannot answer a run that has no target."
            : "This run names a Forguncy target and the cached report was measured against none; the observation is not about this target.",
      };
    }
    return null;
  }
  if (!matchesForguncyTargetIdentity(cachedTarget, target)) {
    return {
      reason: "forguncy-target-changed",
      detail: `The cached report was measured against a different Forguncy target (${cachedTarget.productBuild} ${cachedTarget.productVersion}) than this run (${target.productBuild} ${target.productVersion}).`,
    };
  }
  return null;
}

/**
 * Whether two toolchain identities describe the same install and the same tools — and, when they
 * do not, which half moved.
 *
 * Field-by-field rather than by object identity, for the reason `matchesForguncyTargetIdentity`
 * gives: one side is deserialized from a cached JSON document and can never share an object with
 * the live value.
 *
 * **An absent component is not equal to a present one**, and the direction is deliberate: a cached
 * report written before #94 records no `rolldown`, `node` or `installGraph`, so it compares unequal
 * and the run re-probes. Reading "the cache does not say" as "the cache agrees" is exactly how a
 * warm `.fgc/probe-cache/` would keep serving evidence the new identity exists to invalidate.
 *
 * **`unknown` on both sides is *not* agreement either**, and that is a second, separate case. The
 * strict components (`rolldown`, `node`, and every `installGraph` digest) are the ones that decide
 * what the measured artifact *is*; when a run cannot establish them, a cache hit would claim the
 * stored report describes *this* run on the strength of two identical silences. Measured: a project
 * with no recognizable lockfile records `{lockfile: null, patches: null, configuration: null}` on
 * the first probe, and after a transitive dependency moved in `node_modules` with the root package
 * version unchanged, the second run compared equal and served the stale report — the exact defect
 * #94 exists to remove.
 *
 * `vitePlus` keeps its #8 reading and is the one exception: `null` there is a *declaration* that the
 * version is immaterial (see `ToolchainIdentity`), which is a positive statement rather than a
 * silence, so two such declarations do agree. Every other component must be *known and equal* to
 * produce a hit; a strict component unknown on either side forces a re-probe, which costs a build
 * and never serves evidence the install no longer supports.
 */
function toolchainIdentityProblem(
  cached: ToolchainIdentity,
  current: ToolchainIdentity,
): { readonly reason: ProbeCacheMissReason; readonly detail: string } | null {
  const nullable = (value: string | null | undefined): string | null => value ?? null;

  // `vitePlus`: nullable agreement, including two immateriality declarations.
  if (nullable(cached.vitePlus) !== nullable(current.vitePlus)) {
    return {
      reason: "toolchain-changed",
      detail: `The cached report was measured with vite-plus ${nullable(cached.vitePlus) ?? "(none declared)"} and this run has ${nullable(current.vitePlus) ?? "(none declared)"}.`,
    };
  }

  // Strict string components: both sides must *know* the value and agree on it.
  for (const component of ["rolldown", "node"] as const) {
    const a = nullable(cached[component]);
    const b = nullable(current[component]);
    if (a === null || b === null) {
      return {
        reason: "toolchain-unknown",
        detail:
          a === null
            ? `The cached report does not record which ${component} version produced it, and this run cannot confirm the measurement still describes the tool that bundles now. Re-run the probe (and re-record the decision) to store an identified measurement.`
            : `This run cannot establish which ${component} version is running, so it cannot show the cached report describes this toolchain. Check the installation, then re-probe.`,
      };
    }
    if (a !== b) {
      return {
        reason: "toolchain-changed",
        detail: `The cached report was measured with ${component} ${a} and this run has ${b}; a different tool emits a different artifact, so its measurement does not describe this one.`,
      };
    }
  }

  // The install graph: absent, unknown, or unequal all force a re-probe.
  const cachedGraph = cached.installGraph ?? null;
  const currentGraph = current.installGraph ?? null;
  if (cachedGraph === null) {
    return {
      reason: "install-graph-unknown",
      detail:
        "The cached report records no install-graph identity, so it cannot show it measured the tree that is installed now. Re-run the probe to store an identified measurement.",
    };
  }
  if (currentGraph === null) {
    return {
      reason: "install-graph-unknown",
      detail:
        "This run cannot establish the install-graph identity (no recognizable lockfile, or an install this toolchain cannot attribute), so a cache hit could not show the stored report describes this install. Run `install`, then re-probe.",
    };
  }
  // Every component of the graph, `installedTree` included. Leaving it out is not a smaller
  // comparison, it is the *original* defect restored: the warm cache is what actually answers a
  // repeat run, so a component the cache ignores is a component that cannot invalidate anything.
  // Measured — with only `installedTree` differing (the real `npm install --omit=optional` shape),
  // the second run returned the first run's report with `fromCache: true`. The freshness axis in
  // `core` compares the same four components; the two lists are kept in step deliberately, and this
  // one is the one that governs.
  for (const component of ["lockfile", "patches", "configuration", "installedTree"] as const) {
    const a = nullable(cachedGraph[component]);
    const b = nullable(currentGraph[component]);
    // A digest either side cannot establish means "cannot say", and #94 requires that to be
    // non-fresh rather than excused. Even two `null`s: both runs failing to identify the install
    // graph is not the same as both runs having identified the same one.
    if (a === null || b === null) {
      return {
        reason: "install-graph-unknown",
        detail:
          a === null
            ? `The cached report does not record the install graph's ${component} digest, so it cannot show it measured this tree. Re-run the probe to store an identified measurement.`
            : `This run cannot establish the install graph's ${component} digest, so it cannot show the cached report measured this tree. Run \`install\`, then re-probe.`,
      };
    }
    if (a !== b) {
      return {
        reason: "install-graph-changed",
        detail: `The installed graph moved (${component}: ${a} → ${b}) while the probed package's own version is unchanged, so the cached report measured a tree that is no longer installed. Re-run the probe to measure this one.`,
      };
    }
  }
  return null;
}
