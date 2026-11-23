/**
 * The one definition of the Rolldown build options a Cell artifact is built with.
 *
 * Decision source: GitHub Issue #158
 * (https://github.com/MangMax/forguncy-react-workspace/issues/158), under the parent spec #152
 * (https://github.com/MangMax/forguncy-react-workspace/issues/152). Before this module, the
 * options existed in three places: `dependency-resolver`'s probe build wrote the `rolldown()`
 * and `generate()` calls, `cell-compiler`'s bundler wrote them again for both of its passes, and
 * `probe/build-configuration.ts` recorded a third copy as the probe fingerprint's bundler input.
 * The probe pinned `platform: "browser"`; the compiler left it to Rolldown's default. None of the
 * three could observe that the others were still the same decision.
 *
 * ## Why `core`, and why plain data
 *
 * `core` is the package both consumers already depend on and the only one with no Rolldown
 * dependency of its own, so deriving the probe's options, the compiler's options and the
 * fingerprint from here adds no bundler to either graph — importantly, the fingerprint composer
 * is exported from `dependency-resolver/local`, which must stay loadable without one (#157).
 * The definition is plain data rather than a constructed Rolldown options object for the same
 * reason: `core` may not import `rolldown`, and the fingerprint must be recomputable from
 * declared inputs alone (#8), which a value that only existed inside a build call would not be.
 *
 * ## `platform` is stated, not defaulted
 *
 * Rolldown's `platform` default is format-derived: `node` for `cjs` output and `browser` for every
 * other format. The probe's output format is `iife`, so the compiler's omission and the probe's
 * explicit pin produced the same answer — measured on `rolldown@1.3.3` before unifying: a package
 * with a `browser` manifest field resolved to its browser file and a package with `main` +
 * `module` resolved to its `module` entry under both, with byte-identical output, and the same
 * held for an `exports` map with `node`/`browser`/`default` conditions. So this is one definition
 * with no exception to record, and the compiler now states `browser` too rather than inheriting
 * it. That removes the latent failure a shared definition exists to prevent: a future compiler
 * that emitted `cjs` would silently re-resolve under `node` while the fingerprint still said
 * `browser`. The fingerprint value does not change — it already recorded `browser`.
 *
 * The definitions below are the *declared* inputs, so a change to any value invalidates recorded
 * probe evidence (#8 rule 2) exactly as before.
 */

/**
 * The build options every Cell artifact shares, split by the Rolldown call that consumes them.
 *
 * `input` is deliberately absent: it is the only option that differs between the probe's
 * synthetic entry, the compiler's entry shim and the pre-bundle scan, so it belongs to the caller.
 */
export interface CellBundlerBuildOptions {
  /** Rolldown's resolution platform, stated rather than left to the format-derived default. */
  readonly platform: "browser";
  /** The `rolldown()` transform stage: authored JSX routed through `react/jsx-runtime`. */
  readonly transform: { readonly jsx: "react-jsx" };
  /** The `rolldown()` experimental stage. */
  readonly experimental: { readonly attachDebugInfo: "none" };
  /** The `generate()` stage: one IIFE script, no chunk loading. */
  readonly output: { readonly format: "iife"; readonly codeSplitting: false };
}

/**
 * The declared build inputs a probe's fingerprint covers.
 *
 * `platform: "browser"` rather than the format-derived default, for the reason in this module's
 * header: the pin is a decision, and a decision left implicit is one a refactor can change while
 * the value it was supposed to invalidate stays put.
 *
 * `transform.jsx: "react-jsx"` routes authored JSX through `react/jsx-runtime`, which the
 * host-bridge plan then intercepts, so no React implementation is bundled;
 * `experimental.attachDebugInfo: "none"` keeps `//#region` comments — which embed module ids and
 * would make output machine-dependent — out of the code.
 */
export const CELL_BUNDLER_BUILD_OPTIONS: CellBundlerBuildOptions = {
  // Resolution-time pin: the probe's entire question is "does this resolve
  // for a browser", and leaving `platform` to Rolldown's format-derived
  // default would re-evaluate under a different format while the fingerprint
  // stayed the same.
  platform: "browser",
  transform: { jsx: "react-jsx" },
  experimental: { attachDebugInfo: "none" },
  output: { format: "iife", codeSplitting: false },
};

/**
 * The `rolldown()` input options, as the probe and the compiler spread them beside their own
 * `input`, `onLog` and plugins.
 */
export function cellBundlerInputOptions(): {
  readonly platform: "browser";
  readonly transform: { readonly jsx: "react-jsx" };
  readonly experimental: { readonly attachDebugInfo: "none" };
} {
  return {
    platform: CELL_BUNDLER_BUILD_OPTIONS.platform,
    transform: CELL_BUNDLER_BUILD_OPTIONS.transform,
    experimental: CELL_BUNDLER_BUILD_OPTIONS.experimental,
  };
}

/**
 * The `generate()` output options for one build.
 *
 * `name` is the one output value the build itself decides — the probe's fixed
 * `FgcProbeCandidate` or the compiler's `componentBinding` — so it is a parameter rather than
 * part of the definition. Everything else comes from the shared definition.
 */
export function cellBundlerOutputOptions(name: string): {
  readonly format: "iife";
  readonly codeSplitting: false;
  readonly name: string;
} {
  return {
    format: CELL_BUNDLER_BUILD_OPTIONS.output.format,
    codeSplitting: CELL_BUNDLER_BUILD_OPTIONS.output.codeSplitting,
    name,
  };
}

/**
 * The definition as the probe fingerprint records it.
 *
 * `LockProbeEvidence.fingerprint` stores a record of strings, so `codeSplitting` is stringified
 * here once rather than by every reader; the key set and values are the ones every recorded
 * fingerprint in every `fgc.lock.json` was composed from, and must not change unless an option
 * actually does.
 */
export function buildConfigurationFingerprintInput(): Readonly<Record<string, string>> {
  return {
    format: CELL_BUNDLER_BUILD_OPTIONS.output.format,
    codeSplitting: String(CELL_BUNDLER_BUILD_OPTIONS.output.codeSplitting),
    jsx: CELL_BUNDLER_BUILD_OPTIONS.transform.jsx,
    platform: CELL_BUNDLER_BUILD_OPTIONS.platform,
    attachDebugInfo: CELL_BUNDLER_BUILD_OPTIONS.experimental.attachDebugInfo,
  };
}
