/**
 * The declared build inputs a probe's fingerprint covers.
 *
 * Decision source: GitHub Issue #157
 * (https://github.com/MangMax/forguncy-react-workspace/issues/157), under #152's "the probe
 * fingerprint composer is available on the lightweight `/local` entry".
 *
 * ## Why this is its own module
 *
 * It is plain data, and it used to sit in `probe/build.ts` beside that module's `rolldown`
 * import. The composer (`probe/fingerprint.ts`) reads it, so every consumer of a fingerprint
 * evaluated `probe/build.ts` — and therefore `rolldown` — even though nothing about composing a
 * fingerprint runs a build. That is the same edge #23 removed from `dependency-resolver/local`
 * one level up, arriving through the constant instead of through a re-export.
 *
 * Splitting it out is what lets the composer live on `/local`: the projection exports
 * `probe/fingerprint.ts`, which now reaches only this leaf. `build.ts` imports the constant and
 * re-exports it, so the barrel's surface and every existing caller are unchanged — and
 * `dependency-resolver-local.test.ts` walks `/local`'s closure to keep `rolldown` out of it.
 *
 * The value is unchanged, which is load-bearing rather than incidental: it is one of the declared
 * inputs `LockProbeEvidence.fingerprint` covers, so every recorded fingerprint in every
 * `fgc.lock.json` is composed from these exact bytes (#8 rule 2).
 */

/**
 * The declared inputs of the build half of a probe — what `LockProbeEvidence.fingerprint`
 * must cover so a change here invalidates recorded evidence.
 *
 * Kept as data (rather than only applied inside `runCandidateBuild`) because the
 * fingerprint composes it without running a build: #8 requires the fingerprint to
 * be recomputable from declared inputs alone, and a configuration that only
 * existed inside a function body would not be.
 */
export const BUILD_CONFIGURATION_FINGERPRINT: Readonly<Record<string, string>> = {
  format: "iife",
  codeSplitting: "false",
  jsx: "react-jsx",
  platform: "browser",
  attachDebugInfo: "none",
};
