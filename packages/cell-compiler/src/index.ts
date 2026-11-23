/**
 * The public surface of `@forguncy-react-workspace/cell-compiler` (#159).
 *
 * Only names another workspace package, an example, or the dependency-selection Skill
 * imports are exported here. Everything else this package used to export is still reachable
 * from `./internal`, which no other package may import; the full projection and the
 * package-scope note live there.
 *
 * Governing architecture Spec Issue(s): #4, #5, #6
 *
 * `package-boundaries.test.ts` pins this list in both directions — the source read (types)
 * and the run-time namespace (values) — so adding a name here is a deliberate surface change.
 */

export { ARTIFACT_CONTRACT_DECISION } from "./provenance.ts";
export { canonicalizeFrontendLibraries, frontendLibraryIds, frontendLibraryReference } from "./frontend-libraries.ts";
export { planExtensionExternals } from "./extension-externals.ts";
export { CELL_ARTIFACT_BANNER, compileCell, serializeCompileCellResult, verifyCellArtifact } from "./artifact.ts";
export type { CompileCellOutcome, CompileCellResult } from "./artifact.ts";
export { packageNameOfSpecifier } from "./specifier.ts";
export { resolveCellResource } from "./cell-resources.ts";
export { createRolldownCellBundler } from "./rolldown-bundler.ts";
export { planCellCompile } from "./registry-plan.ts";
export { buildCellProject } from "./build-cell-project.ts";
export type { BuiltCell, CellDependencies, CellProjectBuild, CellProjectWorkspace } from "./build-cell-project.ts";
