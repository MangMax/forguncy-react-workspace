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
  LOCAL_DEV_ERROR_SURFACING,
  LOCAL_DEV_FORBIDDEN_PATTERNS,
  LOCAL_DEV_GOVERNING_DECISIONS,
  LOCAL_DEV_LOOP_STAGES,
  assertLocalDevExtensionChoicesAreDeclared,
  assertLocalDevProviderIsMock,
} from "./local-dev.ts";
export type { LocalDevExtensionChoice } from "./local-dev.ts";
export {
  LOCAL_DEV_BOUNDARIES,
  formatLocalDevValidationDistinction,
  localDevRealRuntimeOwedChecks,
} from "./local-dev-claims.ts";
export {
  LOCAL_DEV_DIAGNOSTIC_RULES,
  createLocalDevDiagnostic,
  formatLocalDevDiagnostic,
} from "./local-dev-diagnostics.ts";
export type { LocalDevDiagnostic } from "./local-dev-diagnostics.ts";
export { auditLocalDevConfiguration, formatLocalDevAudit } from "./local-dev-audit.ts";
export type { LocalDevAudit } from "./local-dev-audit.ts";
export {
  LOCAL_DEV_MODULE_RESOLUTIONS,
  LOCAL_DEV_VERSION_FIELDS,
  findLocalDevModuleIdResolution,
  localDevAlignmentChecks,
  localDevVersionFieldIsBrowserObserved,
} from "./local-dev-host-modules.ts";
export type { LocalDevVersionField } from "./local-dev-host-modules.ts";
export { runtimeFacade } from "./cell-runtime.ts";
export { installRuntimeFacadeProvider } from "./provider.ts";
export { createMockDataSource, createMockRuntimeFacadeProvider } from "./mock-provider.ts";
export type { MockRuntimeFacadeOptions } from "./mock-provider.ts";
export { resolveCellFixtureOptions } from "./cell-fixture.ts";
export type { CellFixtureContext } from "./cell-fixture.ts";
