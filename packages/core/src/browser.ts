/**
 * `@forguncy-react-workspace/core/browser` — the same architecture decisions, on
 * a dependency graph a browser can actually load.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), which surfaces
 *   the problem, under
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), whose local
 *   loop runs Cell source in a browser, and
 * - #27 — "Spec: typed Forguncy runtime facade for application-owned capabilities"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/27), whose façade
 *   is the surface a Cell author calls and therefore has to be loadable in one.
 *
 * ## The defect this entry exists to fix
 *
 * `index.ts` re-exports `cell-registry.ts` and `config-loader.ts`, and those two
 * read the project off disk — `node:fs`, `node:path`, `node:crypto`, `node:url`,
 * destructured at module scope. A barrel re-export is not a declaration: importing
 * *any* name from `core` evaluates every module it re-exports, so those four
 * builtins entered the graph of every consumer of `core`, including a browser one.
 *
 * Both half-pipelines then failed, in ways that look like something else:
 *
 * - **Local dev.** Vite substitutes a `Proxy` for an externalized builtin whose
 *   `get` trap throws, and the interop line it emits for a named import reads a
 *   property immediately — so the *module graph failed to initialise* with
 *   `Module "node:fs" has been externalized for browser compatibility`. Verified in
 *   a real browser against a real `vp dev` server, not inferred.
 * - **Compilation.** The bundler left `node:fs` and friends unresolved, and #4
 *   requires every non-source dependency to carry a decision, so `compileCell`
 *   refused the artifact with four `unresolved-dependency-decision` diagnostics.
 *
 * The consequence was worse than a broken build: `@forguncy-react-workspace/runtime`
 * — the façade #27/#29 mandate and `examples/runtime-facade` is written against —
 * could not be used by any Cell at all, locally or on the page, even though nothing
 * about the façade needs the filesystem.
 *
 * ## Why a subpath and not a lazy `import()` inside the node-only modules
 *
 * The alternative was to keep one entry and defer the filesystem reads to call
 * time. It fixes the browser only by leaving the *artifact* problem in place: a
 * dynamic `import("node:fs")` is exactly what #6 forbids in Cell output, and the
 * compiler's source guard refuses it, so the compile path would still reject the
 * façade. Removing the edge is the fix that makes both halves work, and it is why
 * this is a separate module graph rather than a change in load order.
 *
 * ## Why the two entries cannot disagree
 *
 * `index.ts` (the node entry) is `export *` of this module plus the node-only modules, so
 * browser/node parity holds by construction: there is no second list of browser-safe names
 * to forget. `browser.test.ts` still checks what a construction cannot give for free —
 * nothing here is outside the root entry's names, and no module in this entry's transitive
 * graph imports a `node:` builtin, which is the property the whole file exists for and the
 * one a future edit is most likely to break: a single new `import { existsSync }` in a safe
 * module would otherwise silently re-break both halves.
 *
 * ## What it is not
 *
 * It is not a browser-safety claim about the *whole* system: `cell-registry` and
 * `config-loader` are genuinely node-side (they read, hash and import files) and
 * stay that way. Nothing here moves a decision — the same tables, guards and
 * contracts are re-exported — so a consumer reaching for `core/browser` is choosing
 * a graph, not a different answer.
 */

// The browser-safe surface of `.`: every name the root entry keeps from a browser-safe module.
// The four modules this projection does not carry are named by `browser.test.ts`, which asserts
// their `node:` contact rather than this comment: `cell-registry` and `config-loader` read the
// project off disk, `resolve-config` resolves alias targets with `node:path`, and
// `cell-compile-fingerprint` hashes with `node:crypto`.
export { APPLICATION_OWNERSHIP_INVARIANT, concernsOwnedBy, isApplicationOwned } from "./ownership.ts";
export type { OwnershipConcernId } from "./ownership.ts";
export { isArtifactObservedRejectionCode } from "./rejection.ts";
export {
  APPLICATION_OWNED_ROLES,
  PLATFORM_CONFLICT_RULES,
  assessDependencyRole,
  isPlatformConflict,
} from "./platform-conflicts.ts";
export type { DependencyRole, PlatformConflictAssessment } from "./platform-conflicts.ts";
export { packageNameOfSpecifier } from "./specifier.ts";
export { createDiagnosticFields, defineDiagnosticVocabulary } from "./diagnostics.ts";
export { defineDecisionProvenance } from "./provenance.ts";
export {
  DEPENDENCY_STRATEGIES,
  DEPENDENCY_STRATEGY_SEMANTICS,
  checksForLevel,
  validateDependencyDecisionShape,
} from "./strategy.ts";
export type {
  ArtifactBudgetEvidence,
  DependencyCheckLevel,
  DependencyDecision,
  DependencyStrategy,
  ExtensionDependencyDecision,
} from "./strategy.ts";
export {
  EXTENSION_EXTERNALS_DECISION,
  GOVERNING_ARCHITECTURE_DECISIONS,
  HOST_BRIDGE_DECISION,
  OWNERSHIP_AND_DEPENDENCY_DECISION,
  RUNTIME_CONTRACT_DECISION,
  citesDecision,
  citesEveryArchitectureDecision,
} from "./governance.ts";
export type { ArchitectureDecisionSource } from "./governance.ts";
export {
  CELL_DATA_SOURCE_CONTRACT,
  CELL_ENTRY_SHAPES,
  CELL_FORGUNCY_FACADE,
  CELL_FORGUNCY_PROP_KEYS,
  CELL_PRESET_LIBRARIES,
  CELL_PROPS_BASE_KEYS,
  CELL_PROPS_KEY_ORDER,
  CELL_RUNTIME_BINDING_CONTRACT,
  CELL_RUNTIME_BINDING_HOST_NAMES,
  CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR,
  CELL_SERVER_COMMANDS_CONTRACT,
  CELL_SOURCE_VALIDATION_MECHANISM,
  CELL_USER_SCOPE_BINDINGS,
  FRONTEND_LIBRARY_REFERENCE_CONTRACT,
  FRONTEND_LIBRARY_REFERENCE_EXAMPLE,
  RUNTIME_CONTRACT_TARGET,
  RUNTIME_CONTRACT_TARGET_FIELDS_NOT_BROWSER_OBSERVED,
  RUNTIME_CONTRACT_TARGET_FIELD_SOURCES,
  RUNTIME_EVIDENCE_CHANNELS,
  cellSourceValidationVisitsAstKey,
  cellUserScopeBinding,
  emitCellEntryShapes,
  findCellEntryShape,
  findCellHostRuntimeFact,
  findCellSourceRejection,
  openRuntimeContractQuestions,
} from "./runtime-contract.ts";
export type {
  CellEntryKind,
  CellPresetLibrary,
  CellSourceRejectionId,
  CellUserScopeBinding,
  FrontendLibraryReference,
  RuntimeContractTarget,
  RuntimeEvidenceChannel,
} from "./runtime-contract.ts";
export {
  HOST_BRIDGE_DEFERRED_MODULES,
  HOST_BRIDGE_DIAGNOSTIC_RULES,
  HOST_BRIDGE_MAPPINGS,
  HostBridgeContractError,
  JSX_RUNTIME_ADAPTER_EXPORTS,
  assertHostBridgeContract,
  findHostBridgeModuleMapping,
  hostBridgeAdapterMappings,
  hostBridgeBindingFor,
  hostBridgeGlobalIsAlwaysAvailable,
  hostBridgeGlobalMappings,
  hostBridgeInterceptedModuleIds,
  hostBridgeModuleIds,
  hostBridgeShapeFor,
  packageNameOfModuleId,
} from "./host-bridge.ts";
export type {
  HostBridgeAdapterMapping,
  HostBridgeDeferredModule,
  HostBridgeDiagnosticCode,
  HostBridgeDiagnosticRule,
  HostBridgeFixOwner,
  HostBridgeGlobalMapping,
  HostBridgeMapping,
  HostBridgeMappingKind,
  HostBridgeModuleShape,
} from "./host-bridge.ts";
export {
  EXTENSION_EXTERNAL_DIAGNOSTIC_CODES,
  EXTENSION_EXTERNAL_MAPPINGS,
  EXTENSION_GLOBAL_READ_TIMING,
  EXTENSION_LIBRARY_REFERENCE_FIELD_NAME,
  ExtensionExternalContractError,
  assertExtensionExternalContract,
  auditExtensionLibraryMetadata,
  createExtensionExternalDiagnostic,
  extensionExternalDiagnosticRule,
  extensionInterceptedModuleIds,
  extensionMappingForPackage,
  extensionModuleIds,
  findExtensionExternalMapping,
  formatExtensionExternalDiagnostics,
} from "./extension-externals.ts";
export type {
  ExtensionExternalDiagnostic,
  ExtensionExternalDiagnosticCode,
  ExtensionExternalMapping,
  ExtensionLibraryListing,
} from "./extension-externals.ts";
export { normalizeExtensionMappings } from "./extension-mappings-config.ts";
export type { NormalizedExtensionMappings } from "./extension-mappings-config.ts";
export { compareCodeUnits } from "./code-units.ts";
export { isPlainRecord } from "./guards.ts";
export { createCanonicalizer } from "./canonical.ts";
export {
  DECISION_EVIDENCE_KINDS,
  FGC_LOCK_FILE_NAME,
  FGC_LOCK_SCHEMA_VERSION,
  LOCK_EVIDENCE_POLICY,
  createEmptyFgcLock,
  dependencyDecisionOf,
  forguncyTargetIdentity,
  lockEvidenceProfileForDecision,
  lockEvidenceProfileOf,
  matchesForguncyTargetIdentity,
} from "./lock-types.ts";
export {
  canonicalizeFgcLock,
  canonicalizeImports,
  compareEvidenceLinks,
  compareLockDecisions,
  serializeFgcLock,
} from "./lock-canonical.ts";
export {
  FgcLockValidationError,
  assertFgcLockDocument,
  assertFgcLockDocumentShape,
  findMachineSpecificPaths,
  isRepositoryRelativeReference,
  parseFgcLockDocument,
  validateFgcLockDocument,
} from "./lock-validate.ts";
export type {
  DecisionEvidenceLink,
  ExtensionEvidence,
  FgcLockDocument,
  ForguncyTargetIdentity,
  InstallGraphIdentity,
  LockProbeEvidence,
  LockedDependencyDecision,
  ProbeStatus,
  RejectedCandidateEvidence,
  ToolchainIdentity,
} from "./lock-types.ts";
export {
  assessLockDecision,
  findLockDecision,
  lockDecisionBlockers,
  lockRecordIdentity,
  resolveLockDecision,
} from "./lock-freshness.ts";
export type {
  ArtifactCompileSnapshot,
  LockDecisionQuery,
  LockEnvironment,
  LockRealRuntimeValidation,
  LockStalenessReason,
} from "./lock-freshness.ts";
export {
  REPLACEMENT_SIGNAL_REJECTIONS,
  SELECTION_SIGNALS,
  SELECTION_SIGNAL_FAMILY_SEMANTICS,
  replacementRejectionFor,
} from "./selection-signals.ts";
export type { SelectionSignalId } from "./selection-signals.ts";
export {
  PROBE_ASSESSMENT_STATUSES,
  PROBE_DEPLOYMENT_REQUIRED_STEPS,
  PROBE_REPORT_SCHEMA_VERSION,
  PROBE_STEP_IDS,
  assertProbeReport,
  assessProbeReport,
  canonicalizeProbeReport,
  findForbiddenProbeKeys,
  parseProbeReport,
  probeStepObservesSignal,
  probeStepOrder,
  probeStepsObserving,
  serializeProbeReport,
  validateProbeReport,
} from "./probe-protocol.ts";
export type {
  ProbeAssessment,
  ProbeEnvironment,
  ProbeFact,
  ProbeRejectionFinding,
  ProbeReport,
  ProbeRisk,
  ProbeStepId,
  ProbeValidationEntry,
} from "./probe-protocol.ts";
export {
  ARCHITECTURAL_REJECTION_PROBE_STATUS,
  CONDITIONAL_SELECTION_STAGES,
  NO_PACKAGE_ADAPTER_REGISTRY_INVARIANT,
  REPAIR_RECIPE_CONDITIONS,
  SELECTION_ACCEPTANCE_CRITERIA,
  SELECTION_BRANCHES,
  SELECTION_GOVERNING_SPEC_REFERENCE_LINE,
  SELECTION_STAGES,
  SPEC_PROVING_CASES,
  auditSelectionDecision,
  branchForOwnership,
  evaluateRepairRecipe,
  isOwnershipGateFirst,
  lockProbeStatusForAssessment,
  stagesSkippedOnEarlyExit,
} from "./selection-policy.ts";
export { TARGET_LOCATOR_FINALIZATION, defineForguncyConfig, isConfigRecord } from "./forguncy-config.ts";
export type { ForguncyConfig } from "./forguncy-config.ts";
export {
  CELL_CODE_BUDGET_DECISION,
  CELL_CODE_BUDGET_MEASUREMENT,
  assertCellCodeBudget,
  classifyCellCodeSize,
} from "./cell-code-budget.ts";
export {
  CELL_ASSET_INLINE_LIMIT_BYTES,
  cellResourceQueryRefusal,
  cellUnsupportedAssetRefusal,
  classifyCellResource,
  effectiveCellResourceQuery,
  formatCellAssetDataUri,
  formatCellCssRefusalDetail,
  formatCellResourceSupportMatrix,
  isCellCssFile,
  isCellCssModuleFile,
  isCellResourcePath,
  queryHasRejectedResourceParameter,
  rewriteCellCssReferences,
  splitCellSpecifierQuery,
} from "./cell-assets.ts";
export type {
  CellCssViolation,
  CellResourceFileProbe,
  CellResourceRefusal,
  CellResourceRefusalCode,
} from "./cell-assets.ts";
export {
  buildConfigurationFingerprintInput,
  cellBundlerInputOptions,
  cellBundlerOutputOptions,
} from "./cell-bundler-options.ts";
