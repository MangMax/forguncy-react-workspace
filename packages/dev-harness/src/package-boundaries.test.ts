import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A package's `src/` may only import what its `dependencies` declare.
 *
 * Decision source: GitHub Issue #23 —
 * https://github.com/Mang-X/forguncy-react-workspace/issues/23, where the rule was broken and a
 * review found it.
 *
 * ## The defect, and why a comment could not have caught it
 *
 * `local-decision-projection.ts` began importing `@forguncy-react-workspace/dependency-resolver/local`
 * from `src/` while that package sat in `devDependencies`. The harness plugin loads through a
 * project's `vite.config.ts`, so a production or filtered install that omits devDependencies would
 * fail while *loading the config* — before Vite starts, with a module-resolution error that names
 * the harness rather than the missing package.
 *
 * The `package.json` comment above the entry said the opposite of what was true by then: "`src/`
 * must not import this package; a test may". A comment is a claim nothing checks, and this one was
 * written by the same change that broke it — which is the argument for asserting the rule rather
 * than restating it.
 *
 * ## What is asserted, in both directions
 *
 * 1. **Every workspace package `src/` imports is a `dependencies` entry.** A `devDependencies`-only
 *    import is the defect above; a missing entry entirely is worse, since it only works while some
 *    other package's install happens to hoist it.
 * 2. **Nothing in `devDependencies` is reachable from `src/`.** The same rule stated from the other
 *    side, so a transitive path cannot slip past by importing a module that is not the dependency's
 *    own entry — `dependency-resolver/local` is exactly that shape, a subpath the package name
 *    lookup would miss if the check only compared names.
 *
 * ## Scope, and why it is not every package
 *
 * `dev-harness` is where the rule was broken and where the cost is paid, because its `src/` is
 * loaded into *another project's* config graph. The check is written over the workspace so it covers
 * any package, and the scan is over relative imports so it does not need a resolver — the same
 * technique `dependency-resolver-local.test.ts` and `relative-import-extension.test.ts` use for
 * graphs a bundler would otherwise be needed to inspect.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "..", "..", "..");

/** The workspace packages, by directory name, with their manifests. */
function workspacePackages(): readonly {
  readonly directory: string;
  readonly name: string;
  readonly dependencies: ReadonlySet<string>;
  readonly devDependencies: ReadonlySet<string>;
  readonly exports: Readonly<Record<string, string>>;
}[] {
  const packagesRoot = join(repositoryRoot, "packages");
  return readdirSync(packagesRoot)
    .filter(entry => statSync(join(packagesRoot, entry)).isDirectory())
    .map(entry => {
      const manifestPath = join(packagesRoot, entry, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        exports?: Record<string, string>;
      };
      return {
        directory: join(packagesRoot, entry),
        name: manifest.name,
        dependencies: new Set(Object.keys(manifest.dependencies ?? {})),
        devDependencies: new Set(Object.keys(manifest.devDependencies ?? {})),
        exports: manifest.exports ?? {},
      };
    });
}

/** The bare package names `src/` imports, including subpath entries and type-only imports. */
function bareImportsIn(srcDirectory: string): ReadonlySet<string> {
  const found = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "node_modules" && !entry.startsWith(".")) {
          visit(path);
        }
        continue;
      }
      // Tests are excluded on purpose, and it is the whole distinction the rule turns on: a test may
      // import a devDependency, `src/` may not. This is the sentence the stale comment got wrong.
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
        continue;
      }
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/from\s+"([^".][^"]*)"/g)) {
        const specifier = match[1]!;
        // A workspace package's subpath resolves to its own package name: `@scope/name/sub` is
        // provided by `@scope/name`. Scoped names have two segments, everything else one.
        const segments = specifier.split("/");
        found.add(specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!);
      }
    }
  };
  visit(join(srcDirectory, "src"));
  return found;
}

describe("a package's `src/` imports only what its `dependencies` declare", () => {
  it("declares every package `src/` reaches, and reaches no devDependency", () => {
    const packages = workspacePackages();
    // The control: the scan found the workspace, so a passing assertion is about these packages
    // rather than about an empty list.
    expect(packages.length).toBeGreaterThan(5);

    const problems: string[] = [];
    let sawAWiredImport = false;

    for (const pkg of packages) {
      const imported = bareImportsIn(pkg.directory);
      for (const name of imported) {
        // Only workspace packages are this rule's business: a published dependency's placement is
        // decided by `fgc.lock.json` and #4's strategy table, not by this test.
        if (!name.startsWith("@forguncy-react-workspace/")) {
          continue;
        }
        // A package's own name is not a boundary violation, and it appears here from *generated
        // source* rather than from an import: `vite-plugin.ts` emits modules whose text contains
        // `from "@forguncy-react-workspace/dev-harness/mount"`, and this scan reads files as text.
        // Telling code from string content by pattern is not a solved problem — `cell-compiler`'s
        // `source-guard.ts` says so and uses a real parser for the same reason — so this check
        // excludes the case it cannot read correctly rather than reporting a false violation.
        if (name === pkg.name) {
          continue;
        }
        sawAWiredImport = true;
        if (pkg.devDependencies.has(name)) {
          problems.push(`${pkg.name}: src/ imports ${name}, which is a devDependency`);
          continue;
        }
        if (!pkg.dependencies.has(name)) {
          problems.push(`${pkg.name}: src/ imports ${name}, which is not declared in dependencies`);
        }
      }
    }

    // The control for the check itself: at least one package's `src/` imports a workspace package,
    // so "no problems" is the result of comparing something. Without this the test would pass for a
    // scanner that found no imports at all.
    expect(sawAWiredImport, "no workspace import was found, so the rule was never exercised").toBe(true);
    expect(problems).toEqual([]);
  });

  it("finds the harness's own resolver edge, so the check is about a live dependency", () => {
    // The case that motivated this file, asserted positively: without it, the test above could pass
    // for a package whose `src/` imports nothing at all — and it is the specific edge a reviewer had
    // to find by hand, so it is worth naming where it is now checked.
    const harness = workspacePackages().find(pkg => pkg.name === "@forguncy-react-workspace/dev-harness");
    expect(harness, "the dev-harness package is missing from the workspace scan").toBeDefined();

    const imported = bareImportsIn(harness!.directory);
    expect(imported).toContain("@forguncy-react-workspace/dependency-resolver");
    expect(harness!.dependencies).toContain("@forguncy-react-workspace/dependency-resolver");
    expect(harness!.devDependencies).not.toContain("@forguncy-react-workspace/dependency-resolver");
  });

  it("keeps the resolver's conformance audit independent of the compiler's plan", () => {
    // #52's validation plan asks for this to be asserted rather than assumed. The reason the
    // host-bridge plan's `wireable` field cannot change the resolver's audit is structural:
    // `decision-conformance.ts` derives `DEFAULT_HOST_BRIDGE_MANIFEST` from `core`'s
    // `HOST_BRIDGE_MAPPINGS`, and `core` is the only workspace package the resolver may reach.
    // So the plan is not merely unused here — it is unreachable, and a change that made the
    // audit consume the plan would have to break the package boundary to do it.
    const resolver = workspacePackages().find(pkg => pkg.name === "@forguncy-react-workspace/dependency-resolver");
    expect(resolver, "the dependency-resolver package is missing from the workspace scan").toBeDefined();

    const imported = [...bareImportsIn(resolver!.directory)].filter(name =>
      name.startsWith("@forguncy-react-workspace/"),
    );
    expect(imported).toEqual(["@forguncy-react-workspace/core"]);
  });
});

/**
 * The surface each package presents to the workspace (#159).
 *
 * Decision source: GitHub Issue #159 — "refactor: narrow every package root entry; test-only
 * exports move to `./internal`" (https://github.com/Mang-X/forguncy-react-workspace/issues/159),
 * under the shape-stabilisation Spec #152.
 *
 * ## Why the pin, and why `./internal`
 *
 * A barrel re-export is not a declaration: a name can stay public long after its last consumer
 * disappeared, and every internal change then reads as a breaking one. #159 fixes each root entry
 * to what another workspace package, an example, or the dependency-selection Skill actually names,
 * and keeps the rest reachable only through `./internal` — an entry no other package may import.
 *
 * Both lists are ratchets, in the shape `cell-project`'s `consumer-surface.test.ts` established:
 * adding a public name is one deliberate edit here, reviewed with the API change it represents.
 * `cell-project` is absent because its own entry is already pinned by that test.
 *
 * The names are read two ways, because they fail differently: the source read (following
 * `export *`) sees types, which are erased at run time; the dynamic import sees the values a
 * consumer actually receives. A name that survives one and not the other is a broken export, not
 * a surface change.
 */
const SURFACE_PACKAGES = [
  "@forguncy-react-workspace/core",
  "@forguncy-react-workspace/cell-compiler",
  "@forguncy-react-workspace/dependency-resolver",
  "@forguncy-react-workspace/dev-harness",
  "@forguncy-react-workspace/mcp-sync",
  "@forguncy-react-workspace/runtime",
  "@forguncy-react-workspace/vite-plugin-fgc",
] as const;

interface PinnedSurface {
  readonly values: readonly string[];
  readonly types: readonly string[];
}

const PINNED_SURFACE: Readonly<Record<(typeof SURFACE_PACKAGES)[number], PinnedSurface>> = {

  "@forguncy-react-workspace/core": {
    values: [
      "APPLICATION_OWNED_ROLES",
      "APPLICATION_OWNERSHIP_INVARIANT",
      "ARCHITECTURAL_REJECTION_PROBE_STATUS",
      "CELL_ASSET_INLINE_LIMIT_BYTES",
      "CELL_CODE_BUDGET_DECISION",
      "CELL_CODE_BUDGET_MEASUREMENT",
      "CELL_DATA_SOURCE_CONTRACT",
      "CELL_ENTRY_SHAPES",
      "CELL_FORGUNCY_FACADE",
      "CELL_FORGUNCY_PROP_KEYS",
      "CELL_PRESET_LIBRARIES",
      "CELL_PROPS_BASE_KEYS",
      "CELL_PROPS_KEY_ORDER",
      "CELL_RUNTIME_BINDING_CONTRACT",
      "CELL_RUNTIME_BINDING_HOST_NAMES",
      "CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR",
      "CELL_SERVER_COMMANDS_CONTRACT",
      "CELL_SOURCE_VALIDATION_MECHANISM",
      "CELL_USER_SCOPE_BINDINGS",
      "CONDITIONAL_SELECTION_STAGES",
      "DECISION_EVIDENCE_KINDS",
      "DEPENDENCY_STRATEGIES",
      "DEPENDENCY_STRATEGY_SEMANTICS",
      "EXTENSION_EXTERNALS_DECISION",
      "EXTENSION_EXTERNAL_DIAGNOSTIC_CODES",
      "EXTENSION_EXTERNAL_MAPPINGS",
      "EXTENSION_GLOBAL_READ_TIMING",
      "EXTENSION_LIBRARY_REFERENCE_FIELD_NAME",
      "ExtensionExternalContractError",
      "FGC_LOCK_FILE_NAME",
      "FGC_LOCK_SCHEMA_VERSION",
      "FRONTEND_LIBRARY_REFERENCE_CONTRACT",
      "FRONTEND_LIBRARY_REFERENCE_EXAMPLE",
      "FgcLockValidationError",
      "ForguncyConfigError",
      "GOVERNING_ARCHITECTURE_DECISIONS",
      "HOST_BRIDGE_DECISION",
      "HOST_BRIDGE_DEFERRED_MODULES",
      "HOST_BRIDGE_DIAGNOSTIC_RULES",
      "HOST_BRIDGE_MAPPINGS",
      "HostBridgeContractError",
      "JSX_RUNTIME_ADAPTER_EXPORTS",
      "LOCK_EVIDENCE_POLICY",
      "NO_PACKAGE_ADAPTER_REGISTRY_INVARIANT",
      "OWNERSHIP_AND_DEPENDENCY_DECISION",
      "PLATFORM_CONFLICT_RULES",
      "PROBE_ASSESSMENT_STATUSES",
      "PROBE_DEPLOYMENT_REQUIRED_STEPS",
      "PROBE_REPORT_SCHEMA_VERSION",
      "PROBE_STEP_IDS",
      "REPAIR_RECIPE_CONDITIONS",
      "REPLACEMENT_SIGNAL_REJECTIONS",
      "RUNTIME_CONTRACT_DECISION",
      "RUNTIME_CONTRACT_TARGET",
      "RUNTIME_CONTRACT_TARGET_FIELDS_NOT_BROWSER_OBSERVED",
      "RUNTIME_CONTRACT_TARGET_FIELD_SOURCES",
      "RUNTIME_EVIDENCE_CHANNELS",
      "SELECTION_ACCEPTANCE_CRITERIA",
      "SELECTION_BRANCHES",
      "SELECTION_GOVERNING_SPEC_REFERENCE_LINE",
      "SELECTION_SIGNALS",
      "SELECTION_SIGNAL_FAMILY_SEMANTICS",
      "SELECTION_STAGES",
      "SPEC_PROVING_CASES",
      "TARGET_LOCATOR_FINALIZATION",
      "assertCellCodeBudget",
      "assertDistinctTargetClaims",
      "assertExtensionExternalContract",
      "assertFgcLockDocument",
      "assertFgcLockDocumentShape",
      "assertHostBridgeContract",
      "assertProbeReport",
      "assertUniqueTargets",
      "assessDependencyRole",
      "assessLockDecision",
      "assessProbeReport",
      "auditExtensionLibraryMetadata",
      "auditSelectionDecision",
      "branchForOwnership",
      "buildConfigurationFingerprintInput",
      "canonicalizeFgcLock",
      "canonicalizeImports",
      "canonicalizeProbeReport",
      "cellBundlerInputOptions",
      "cellBundlerOutputOptions",
      "cellResourceQueryRefusal",
      "cellSourceValidationVisitsAstKey",
      "cellUnsupportedAssetRefusal",
      "cellUserScopeBinding",
      "checksForLevel",
      "citesDecision",
      "citesEveryArchitectureDecision",
      "classifyCellCodeSize",
      "classifyCellResource",
      "compareCodeUnits",
      "compareEvidenceLinks",
      "compareLockDecisions",
      "composeCellCompileFingerprint",
      "concernsOwnedBy",
      "createCanonicalizer",
      "createCellRegistry",
      "createDiagnosticFields",
      "createEmptyFgcLock",
      "createExtensionExternalDiagnostic",
      "defineDecisionProvenance",
      "defineDiagnosticVocabulary",
      "defineForguncyConfig",
      "dependencyDecisionOf",
      "describeReportedError",
      "describeValue",
      "effectiveCellResourceQuery",
      "emitCellEntryShapes",
      "evaluateRepairRecipe",
      "extensionExternalDiagnosticRule",
      "extensionInterceptedModuleIds",
      "extensionMappingForPackage",
      "extensionModuleIds",
      "findCellEntryShape",
      "findCellHostRuntimeFact",
      "findCellSourceRejection",
      "findExtensionExternalMapping",
      "findForbiddenProbeKeys",
      "findForguncyConfigFile",
      "findHostBridgeModuleMapping",
      "findLockDecision",
      "findMachineSpecificPaths",
      "forguncyTargetIdentity",
      "formatCellAssetDataUri",
      "formatCellCssRefusalDetail",
      "formatCellResourceSupportMatrix",
      "formatExtensionExternalDiagnostics",
      "hasReportedErrors",
      "hostBridgeAdapterMappings",
      "hostBridgeBindingFor",
      "hostBridgeGlobalIsAlwaysAvailable",
      "hostBridgeGlobalMappings",
      "hostBridgeInterceptedModuleIds",
      "hostBridgeModuleIds",
      "hostBridgeShapeFor",
      "isApplicationOwned",
      "isArtifactObservedRejectionCode",
      "isCellCssFile",
      "isCellCssModuleFile",
      "isCellRegistry",
      "isCellResourcePath",
      "isConfigRecord",
      "isOwnershipGateFirst",
      "isPlainRecord",
      "isPlatformConflict",
      "isRepositoryRelativeReference",
      "loadForguncyConfig",
      "lockDecisionBlockers",
      "lockEvidenceProfileForDecision",
      "lockEvidenceProfileOf",
      "lockProbeStatusForAssessment",
      "lockRecordIdentity",
      "matchesForguncyTargetIdentity",
      "normalizeExtensionMappings",
      "normalizeResolveConfig",
      "openRuntimeContractQuestions",
      "packageNameOfModuleId",
      "packageNameOfSpecifier",
      "parseFgcLockDocument",
      "parseProbeReport",
      "probeStepObservesSignal",
      "probeStepOrder",
      "probeStepsObserving",
      "queryHasRejectedResourceParameter",
      "replacementRejectionFor",
      "resolveLockDecision",
      "rewriteCellCssReferences",
      "serializeFgcLock",
      "serializeProbeReport",
      "splitCellSpecifierQuery",
      "stagesSkippedOnEarlyExit",
      "stripAnsi",
      "validateDependencyDecisionShape",
      "validateFgcLockDocument",
      "validateProbeReport",
    ],
    types: [
      "ArchitectureDecisionSource",
      "ArtifactBudgetEvidence",
      "ArtifactCompileSnapshot",
      "CellCssViolation",
      "CellEntryKind",
      "CellPresetLibrary",
      "CellRegistry",
      "CellResourceFileProbe",
      "CellResourceRefusal",
      "CellResourceRefusalCode",
      "CellSourceRejectionId",
      "CellUserScopeBinding",
      "DecisionEvidenceLink",
      "DependencyCheckLevel",
      "DependencyDecision",
      "DependencyRole",
      "DependencyStrategy",
      "ExtensionDependencyDecision",
      "ExtensionEvidence",
      "ExtensionExternalDiagnostic",
      "ExtensionExternalDiagnosticCode",
      "ExtensionExternalMapping",
      "ExtensionLibraryListing",
      "FgcLockDocument",
      "ForguncyConfig",
      "ForguncyConfigModuleLoader",
      "ForguncyTargetIdentity",
      "FrontendLibraryReference",
      "HostBridgeAdapterMapping",
      "HostBridgeDeferredModule",
      "HostBridgeDiagnosticCode",
      "HostBridgeDiagnosticRule",
      "HostBridgeFixOwner",
      "HostBridgeGlobalMapping",
      "HostBridgeMapping",
      "HostBridgeMappingKind",
      "HostBridgeModuleShape",
      "InstallGraphIdentity",
      "LockDecisionQuery",
      "LockEnvironment",
      "LockProbeEvidence",
      "LockRealRuntimeValidation",
      "LockStalenessReason",
      "LockedDependencyDecision",
      "NormalizedExtensionMappings",
      "NormalizedResolveConfig",
      "OwnershipConcernId",
      "PlatformConflictAssessment",
      "ProbeAssessment",
      "ProbeEnvironment",
      "ProbeFact",
      "ProbeRejectionFinding",
      "ProbeReport",
      "ProbeRisk",
      "ProbeStatus",
      "ProbeStepId",
      "ProbeValidationEntry",
      "RegisteredCell",
      "RejectedCandidateEvidence",
      "RuntimeContractTarget",
      "RuntimeEvidenceChannel",
      "SelectionSignalId",
      "ToolchainIdentity",
    ],
  },
  "@forguncy-react-workspace/cell-compiler": {
    values: [
      "ARTIFACT_CONTRACT_DECISION",
      "CELL_ARTIFACT_BANNER",
      "buildCellProject",
      "canonicalizeFrontendLibraries",
      "compileCell",
      "createRolldownCellBundler",
      "frontendLibraryIds",
      "frontendLibraryReference",
      "packageNameOfSpecifier",
      "planCellCompile",
      "planExtensionExternals",
      "resolveCellResource",
      "serializeCompileCellResult",
      "verifyCellArtifact",
    ],
    types: [
      "BuiltCell",
      "CellDependencies",
      "CellProjectBuild",
      "CellProjectWorkspace",
      "CompileCellOutcome",
      "CompileCellResult",
    ],
  },
  "@forguncy-react-workspace/dependency-resolver": {
    values: [
      "ProbeIdentityError",
      "auditLockDecisionConformance",
      "compilationDependencies",
      "composeProbeFingerprint",
      "conformanceErrors",
      "extensionCatalogOfNormalized",
      "fgcLockPath",
      "findExactLockDecision",
      "localCompilationDependencies",
      "mergeDependencyDecisionUpdate",
      "probeLockEnvironment",
      "probeRunLockEvidence",
      "readFgcLock",
      "readToolchainIdentity",
      "recordDependencyDecision",
      "recordedPackageNames",
      "resolveInstalledVersions",
      "runDependencyProbe",
      "upsertLockDecision",
      "validateLockDecisionConformance",
      "writeFgcLock",
    ],
    types: [
      "ExtensionCatalog",
      "WithheldCompilationDependency",
    ],
  },
  "@forguncy-react-workspace/dev-harness": {
    values: [
      "CellResourceRefusedError",
      "ExtensionSubstituteError",
      "LOCAL_DEV_UNOBSERVABLE_STALENESS_REASONS",
      "createDevCellResourcePolicy",
      "defineForguncyViteConfig",
      "extensionSubstitutionModuleSource",
      "extensionSubstitutions",
      "installedToolchain",
      "projectLocalDecisions",
    ],
    types: [
      "ExtensionSubstitution",
    ],
  },
  "@forguncy-react-workspace/mcp-sync": {
    values: [
      "FORGUNCY_SYNC_PORT_METHODS",
      "cellTargetLabel",
      "deployedStateOfRead",
      "executeCellSync",
      "executeCellSyncBatch",
      "fingerprintArtifact",
      "formatCellSyncPlan",
      "planCellSync",
      "planCellSyncTargets",
      "planSetCellsDispatch",
      "resolveCellSyncTargets",
    ],
    types: [
      "CellDivergence",
      "CellOverwritePolicy",
      "CellSyncBatchReport",
      "CellSyncPlan",
      "CellSyncRun",
      "CellSyncTargetPlan",
      "CellWriteAction",
      "DeployedCellState",
      "ForguncySyncPort",
      "SyncCellInput",
    ],
  },
  "@forguncy-react-workspace/runtime": {
    values: [
      "LOCAL_DEV_BOUNDARIES",
      "LOCAL_DEV_DIAGNOSTIC_RULES",
      "LOCAL_DEV_ERROR_SURFACING",
      "LOCAL_DEV_FORBIDDEN_PATTERNS",
      "LOCAL_DEV_GOVERNING_DECISIONS",
      "LOCAL_DEV_LOOP_STAGES",
      "LOCAL_DEV_MODULE_RESOLUTIONS",
      "LOCAL_DEV_RUNTIME_DECISION",
      "LOCAL_DEV_VERSION_FIELDS",
      "RUNTIME_FACADE_DECISION",
      "assertLocalDevExtensionChoicesAreDeclared",
      "assertLocalDevProviderIsMock",
      "auditLocalDevConfiguration",
      "createLocalDevDiagnostic",
      "createMockDataSource",
      "createMockRuntimeFacadeProvider",
      "findLocalDevModuleIdResolution",
      "formatLocalDevAudit",
      "formatLocalDevDiagnostic",
      "formatLocalDevValidationDistinction",
      "installRuntimeFacadeProvider",
      "localDevAlignmentChecks",
      "localDevRealRuntimeOwedChecks",
      "localDevVersionFieldIsBrowserObserved",
      "resolveCellFixtureOptions",
      "runtimeFacade",
    ],
    types: [
      "CellFixtureContext",
      "LocalDevAudit",
      "LocalDevDiagnostic",
      "LocalDevExtensionChoice",
      "LocalDevVersionField",
      "MockRuntimeFacadeOptions",
      "RuntimeFacadeProvider",
    ],
  },
  "@forguncy-react-workspace/vite-plugin-fgc": {
    values: [
      "cellVirtualModuleId",
      "forguncy",
    ],
    types: [],
  },};

/** The exported names of a barrel, following `export *` re-exports. */
function exportedNames(file: string, seen = new Set<string>()): readonly string[] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const source = readFileSync(file, "utf8");
  const names = new Set<string>();

  for (const match of source.matchAll(/^[ \t]*export\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*"([^"]+)"/gm)) {
    for (const part of (match[1] ?? "").split(",")) {
      // `type X` is a type-only binding; `X as Y` exports Y.
      const name =
        part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop()
          ?.trim() ?? "";
      if (name.length > 0) {
        names.add(name);
      }
    }
  }

  for (const match of source.matchAll(/^[ \t]*export\s+\*\s+from\s*"([^"]+)"/gm)) {
    for (const name of exportedNames(resolve(dirname(file), match[1] ?? ""), seen)) {
      names.add(name);
    }
  }

  for (const match of source.matchAll(
    /^[ \t]*export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    if (match[1] !== undefined) {
      names.add(match[1]);
    }
  }

  return [...names].sort();
}

/** Every source file under `directory`, excluding installs, build output and the discovery mirror. */
function workspaceSourceFiles(directory: string, found: string[] = []): readonly string[] {
  for (const entry of readdirSync(directory)) {
    if (["node_modules", ".git", ".fgc", "dist", ".claude"].includes(entry)) {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      workspaceSourceFiles(path, found);
      continue;
    }
    if (/\.(ts|tsx|mjs|js)$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

describe("every package's root entry is exactly its consumed surface", () => {
  it("exports the pinned values and types", async () => {
    const packages = workspacePackages();

    for (const name of SURFACE_PACKAGES) {
      const pkg = packages.find(candidate => candidate.name === name);
      expect(pkg, `${name} is missing from the workspace scan`).toBeDefined();
      const entry = pkg!.exports["."];
      expect(entry, `${name} declares no root export`).toBeDefined();
      const file = join(pkg!.directory, entry!);
      const pinned = PINNED_SURFACE[name];

      // The control: the source read found a real surface, so a mismatch below is about the list
      // rather than about a parser that found nothing.
      expect(exportedNames(file).length, `${name}'s root entry`).toBe(pinned.values.length + pinned.types.length);
      expect(exportedNames(file), `${name}'s root entry`).toEqual([...pinned.values, ...pinned.types].sort());

      const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      expect(Object.keys(module).sort(), `${name}'s root entry at run time`).toEqual([...pinned.values].sort());
    }
  });
});

describe("a package's ./internal entry is reachable only from its own tests", () => {
  it("declares ./internal for every surface package", () => {
    const packages = workspacePackages();

    for (const name of SURFACE_PACKAGES) {
      const pkg = packages.find(candidate => candidate.name === name);
      expect(pkg, `${name} is missing from the workspace scan`).toBeDefined();
      const internal = pkg!.exports["./internal"];
      expect(internal, `${name} declares no ./internal entry`).toBeDefined();
      expect(() => readFileSync(join(pkg!.directory, internal!), "utf8"), `${name}'s ./internal file`).not.toThrow();
    }
  });

  it("is imported by that package's tests and by nothing else", () => {
    const packages = workspacePackages();
    const problems: string[] = [];
    let internalImports = 0;

    for (const root of [
      join(repositoryRoot, "packages"),
      join(repositoryRoot, "examples"),
      join(repositoryRoot, ".agents"),
    ]) {
      for (const file of workspaceSourceFiles(root)) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/(?:from\s+|import\(\s*)"(@forguncy-react-workspace\/[^/"]+)\/internal"/g)) {
          internalImports += 1;
          const name = match[1]!;
          const pkg = packages.find(candidate => candidate.name === name);
          if (pkg === undefined) {
            problems.push(`${file} imports ./internal of ${name}, which is not a workspace package`);
            continue;
          }
          const inside = file.startsWith(pkg.directory + "\\") || file.startsWith(pkg.directory + "/");
          if (!inside) {
            problems.push(`${file} imports ${name}/internal from outside the package`);
            continue;
          }
          if (!/\.test\.tsx?$/.test(file)) {
            problems.push(`${file} imports ${name}/internal but is not a test`);
          }
        }
      }
    }

    // The control: at least one package's own tests reach its `./internal` entry, so "no problems"
    // is the result of checking something.
    expect(internalImports, "no ./internal import was found, so the rule was never exercised").toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
