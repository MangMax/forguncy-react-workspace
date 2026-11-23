/**
 * `@forguncy-react-workspace/dependency-resolver` — turning recorded dependency
 * decisions into something a compiler and an Agent can act on.
 *
 * Decision source: GitHub Issue #8 — "Spec: reproducible dependency decisions
 * and `fgc.lock.json`" —
 * https://github.com/Mang-X/forguncy-react-workspace/issues/8
 *
 * Governing architecture Spec Issues:
 * - #4 — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * What is implemented here:
 *
 * - the lock as a project artifact — read (with migration), write, upsert,
 *   remove, exact-key and target-preferring lookup (`lock-store`);
 * - the projection onto compilation, which hands the compiler verified decisions
 *   only (`lock-store`), plus the clearly local-only projection
 *   (`localCompilationDependencies`) — freshness enforced, real-runtime
 *   validation deliberately relaxed while `target` is honestly null, never a
 *   shipping path;
 * - the exact installed versions the staleness rules compare against, read out of
 *   the workspace install graph (`install-graph`);
 * - the update API an Agent or probe flow records through, which merges a
 *   measurement into a record instead of replacing the record (`decision-recording`);
 * - conformance auditing against the facts a lock cannot contain — the target's
 *   host globals (#9) and the verified extension catalog (#12)
 *   (`decision-conformance`);
 * - the deterministic dependency probe engine that produces the evidence a
 *   lock record cites (`probe/*`): nine protocol steps, one canonical
 *   `ProbeReport`, a recomputable fingerprint and a file cache under
 *   `.fgc/probe-cache/` (#17).
 *
 * The decision model, its validation, its canonical form and its freshness rules are owned by
 * `core` (#8), and are imported from there. This package used to re-export them as a compatibility
 * proxy; #157 deleted that block, because #105's reference scan and #126's audit both measured no
 * consumer of the copy and every remaining importer already names `core`. A second door onto the
 * same names is a second surface to keep in step for nobody, and it is what made "narrow the root
 * entry" impossible to start.
 *
 * What is *not* implemented here: the Agent-driven library selection that decides
 * a strategy in the first place (`Implement: Forguncy React dependency-selection
 * Agent Skill` #18). Composing a probe fingerprint is #17's; selecting a package
 * from a probe's assessment remains the Agent's job.
 */

export {
  compilationDependencies,
  fgcLockPath,
  findExactLockDecision,
  localCompilationDependencies,
  readFgcLock,
  recordedPackageNames,
  removeLockDecision,
  upsertLockDecision,
  writeFgcLock,
} from "./lock-store.ts";
export type {
  CompilationDependencies,
  CompilationDependencyOptions,
  LocalCompilationDependencyOptions,
  WithheldCompilationDependency,
} from "./lock-store.ts";

export { resolveInstalledVersions } from "./install-graph.ts";
export type {
  InstalledVersions,
  UnresolvedInstalledPackage,
  UnresolvedInstalledPackageReason,
} from "./install-graph.ts";

// The identity a probe ran under: the installed install graph and the tools that actually ran
// (#94). Exported because it is the one answer to "what did this evidence measure against", and
// the probe engine, the cache, the CLI's `status` and the dev harness all read it from here rather
// than each reading a version of their own.
export {
  readInstallGraphIdentity,
  readToolchainIdentity,
  RECOGNIZED_LOCKFILE_NAMES,
  WORKSPACE_CONFIG_FILE,
} from "./install-identity.ts";

// Where an installed package lives, asked of the host rather than of a private
// `exports` walk (#89). Exported because it is the one answer to "which artifact
// does this name name" that both the lock's version map and the probe's identity
// step are built on, and a consumer checking either independently should be able
// to ask the same question rather than re-derive it.
export { locatePackage } from "./package-locator.ts";
export type {
  LocatedPackage,
  PackageLocation,
  PackageLocationFailureReason,
} from "./package-locator.ts";

export {
  mergeDependencyDecisionUpdate,
  recordDependencyDecision,
  recordDependencyDecisions,
} from "./decision-recording.ts";
export type {
  DependencyDecisionUpdate,
  RecordedDependencyDecision,
  RecordedDependencyDecisions,
} from "./decision-recording.ts";

export {
  auditLockDecisionConformance,
  conformanceErrors,
  CONFORMANCE_PROBLEM_CODES,
  DEFAULT_HOST_BRIDGE_MANIFEST,
  extensionCatalogForMappings,
  extensionCatalogOfNormalized,
  JSX_RUNTIME_MODULE_IDS,
  PRESET_PROVIDED_HOST_GLOBALS,
  validateLockDecisionConformance,
} from "./decision-conformance.ts";
export type {
  ConformanceDiagnostic,
  ConformanceOptions,
  ConformanceProblemCode,
  ConformanceSeverity,
  ExtensionCatalog,
  HostBridgeManifest,
  HostBridgeMapping,
  PresetProvidedGlobal,
  VerifiedExtensionMapping,
} from "./decision-conformance.ts";

// ---------------------------------------------------------------------------
// The dependency probe engine (#17)
// ---------------------------------------------------------------------------

export {
  PROBE_CACHE_MISS_REASONS,
  PROBE_CACHE_OUTCOMES,
  probeLockEnvironment,
  probeRunLockEvidence,
  ProbeIdentityError,
  runDependencyProbe,
} from "./probe/probe-engine.ts";
export type {
  DependencyProbeResult,
  ProbeCacheDecision,
  ProbeCacheMissReason,
  ProbeCacheOutcome,
  ProbeLockEnvironmentOptions,
  PreSmokeReport,
  RuntimeSmokeHook,
  RuntimeSmokeResult,
  ResolvedPackageIdentity,
  RunDependencyProbeOptions,
} from "./probe/probe-engine.ts";

// `PROBE_ANALYSIS_REVISION` is exported beside the composer because `local.ts` projects the whole
// of `probe/fingerprint.ts` (#157), and a name reachable there but not here would make the
// projection a second public surface rather than a projection of this one.
export { composeProbeFingerprint, PROBE_ANALYSIS_REVISION } from "./probe/fingerprint.ts";
export type { ComposedProbeFingerprint, ComposeProbeFingerprintInput } from "./probe/fingerprint.ts";

export { createFileProbeCache, PROBE_CACHE_DIRECTORY, probeCacheRelativePath } from "./probe/cache.ts";
export type { ProbeCache } from "./probe/cache.ts";

export { BUILD_CONFIGURATION_FINGERPRINT, entrySource, probeEntryPath, runCandidateBuild } from "./probe/build.ts";
export type { CandidateBuildOptions, CandidateBuildResult } from "./probe/build.ts";

export { findNodeOnlySpecifiers, observeNodeBuiltins } from "./probe/node-scan.ts";
export type { NodeScanObservation } from "./probe/node-scan.ts";

// Which files a browser build can reach, and what a package's source actually says.
// Exported because both are answers a consumer may want to re-check independently of
// a probe report — the reachability rule is what makes a "no Node builtins" finding
// mean "not in the artifact" rather than "not in any file the package ships".
export {
  ACTIVE_EXPORT_CONDITIONS,
  FALLBACK_BROWSER_FIELDS,
  resolveBrowserEntryPaths,
  resolveSelfReferenceSubpath,
  selfReferenceResolver,
} from "./probe/browser-entry.ts";
export type { BrowserEntryResolution } from "./probe/browser-entry.ts";

export {
  analyzeModuleSource,
  collectReachableSourceFiles,
  isRelativeSpecifier,
  maskComments,
  sourceWithoutComments,
} from "./probe/module-source.ts";
export type {
  CommentRange,
  ImportReference,
  ImportReferenceKind,
  ModuleSourceAnalysis,
  PackageSourceFile,
  ReachableSourceResult,
  SelfReferenceResolver,
} from "./probe/module-source.ts";

export { observeExportMetadata } from "./probe/export-metadata.ts";
export type { ExportMetadataObservation } from "./probe/export-metadata.ts";

export { observeArtifact } from "./probe/artifact-scan.ts";
export type { ArtifactScanObservation } from "./probe/artifact-scan.ts";

export { observeAssets } from "./probe/asset-inventory.ts";
export type { AssetInventoryObservation } from "./probe/asset-inventory.ts";

export { observeRuntimePatterns } from "./probe/runtime-pattern-scan.ts";
export type { RuntimePatternObservation } from "./probe/runtime-pattern-scan.ts";

export { measureArtifactSize, observeSize } from "./probe/size.ts";
export type { ArtifactSize, SizeEstimateBias, SizeObservation } from "./probe/size.ts";

export {
  buildProbeEnvironment,
  defaultProbeTarget,
  normalizeSourceReference,
  resolvePackageIdentity,
} from "./probe/identity.ts";

export { describeBuildFailureLines, portableText, stripAnsi } from "./probe/scan-utils.ts";
