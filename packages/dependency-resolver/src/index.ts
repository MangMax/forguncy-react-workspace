/**
 * The public surface of `@forguncy-react-workspace/dependency-resolver` (#159).
 *
 * Only names another workspace package, an example, or the dependency-selection Skill
 * imports are exported here. Everything else this package used to export is still reachable
 * from `./internal`, which no other package may import; the full projection and the
 * package-scope note live there.
 *
 * `package-boundaries.test.ts` pins this list in both directions — the source read (types)
 * and the run-time namespace (values) — so adding a name here is a deliberate surface change.
 */

export {
  compilationDependencies,
  fgcLockPath,
  findExactLockDecision,
  localCompilationDependencies,
  readFgcLock,
  recordedPackageNames,
  upsertLockDecision,
  writeFgcLock,
} from "./lock-store.ts";
export type { WithheldCompilationDependency } from "./lock-store.ts";
export { resolveInstalledVersions } from "./install-graph.ts";
export { readToolchainIdentity } from "./install-identity.ts";
export { mergeDependencyDecisionUpdate, recordDependencyDecision } from "./decision-recording.ts";
export {
  auditLockDecisionConformance,
  conformanceErrors,
  extensionCatalogOfNormalized,
  validateLockDecisionConformance,
} from "./decision-conformance.ts";
export type { ExtensionCatalog } from "./decision-conformance.ts";
export {
  ProbeIdentityError,
  probeLockEnvironment,
  probeRunLockEvidence,
  runDependencyProbe,
} from "./probe/probe-engine.ts";
export { composeProbeFingerprint } from "./probe/fingerprint.ts";
