/**
 * The public surface of `@forguncy-react-workspace/runtime` (#159).
 *
 * Only names another workspace package, an example, or the dependency-selection Skill
 * imports are exported here. Everything else this package used to export is still reachable
 * from `./internal`, which no other package may import; the full projection and the
 * package-scope note live there.
 *
 * Governing architecture Spec Issue(s): #4, #5, #9, #22, #27
 *
 * `package-boundaries.test.ts` pins this list in both directions — the source read (types)
 * and the run-time namespace (values) — so adding a name here is a deliberate surface change.
 */

export { LOCAL_DEV_RUNTIME_DECISION, RUNTIME_FACADE_DECISION } from "./provenance.ts";
export type { RuntimeFacadeProvider } from "./contract.ts";
export {
  LOCAL_DEV_BOUNDARIES,
  LOCAL_DEV_DIAGNOSTIC_RULES,
  LOCAL_DEV_ERROR_SURFACING,
  LOCAL_DEV_FORBIDDEN_PATTERNS,
  LOCAL_DEV_GOVERNING_DECISIONS,
  LOCAL_DEV_LOOP_STAGES,
  LOCAL_DEV_MODULE_RESOLUTIONS,
  LOCAL_DEV_VERSION_FIELDS,
  assertLocalDevExtensionChoicesAreDeclared,
  assertLocalDevProviderIsMock,
  auditLocalDevConfiguration,
  createLocalDevDiagnostic,
  findLocalDevModuleIdResolution,
  formatLocalDevAudit,
  formatLocalDevDiagnostic,
  formatLocalDevValidationDistinction,
  localDevAlignmentChecks,
  localDevRealRuntimeOwedChecks,
  localDevVersionFieldIsBrowserObserved,
} from "./local-dev.ts";
export type {
  LocalDevAudit,
  LocalDevDiagnostic,
  LocalDevExtensionChoice,
  LocalDevVersionField,
} from "./local-dev.ts";
export { runtimeFacade } from "./cell-runtime.ts";
export { installRuntimeFacadeProvider } from "./provider.ts";
export { createMockDataSource, createMockRuntimeFacadeProvider } from "./mock-provider.ts";
export type { MockRuntimeFacadeOptions } from "./mock-provider.ts";
export { resolveCellFixtureOptions } from "./cell-fixture.ts";
export type { CellFixtureContext } from "./cell-fixture.ts";
