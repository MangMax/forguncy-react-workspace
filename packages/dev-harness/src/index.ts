/**
 * The public surface of `@forguncy-react-workspace/dev-harness` (#159).
 *
 * Only names another workspace package, an example, or the dependency-selection Skill
 * imports are exported here. Everything else this package used to export is still reachable
 * from `./internal`, which no other package may import; the full projection and the
 * package-scope note live there.
 *
 * `package-boundaries.test.ts` pins this list in both directions — the source read (types)
 * and the run-time namespace (values) — so adding a name here is a deliberate surface change.
 */

export { defineForguncyViteConfig } from "./vite-config.ts";
export { CellResourceRefusedError, createDevCellResourcePolicy } from "./cell-assets.ts";
export {
  LOCAL_DEV_UNOBSERVABLE_STALENESS_REASONS,
  installedToolchain,
  projectLocalDecisions,
} from "./local-decision-projection.ts";
export {
  ExtensionSubstituteError,
  extensionSubstitutionModuleSource,
  extensionSubstitutions,
} from "./extension-substitutions.ts";
export type { ExtensionSubstitution } from "./extension-substitutions.ts";
