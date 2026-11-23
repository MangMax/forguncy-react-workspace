/**
 * The public surface of `@forguncy-react-workspace/core` (#159).
 *
 * Only names another workspace package, an example, or the dependency-selection Skill
 * imports are exported here. Everything else this package used to export is still reachable
 * from `./internal`, which no other package may import; the full projection and the
 * package-scope note live there.
 *
 * `package-boundaries.test.ts` pins this list in both directions — the source read (types)
 * and the run-time namespace (values) — so adding a name here is a deliberate surface change.
 */

// The browser-safe half is projected wholesale, so `./browser` and `.` cannot disagree
// about which browser-safe names exist: `.` re-exports that entry, never a second list.
export * from "./browser.ts";

// The node-only modules: they read the project off disk, or hash with `node:crypto`.
export { normalizeResolveConfig } from "./resolve-config.ts";
export type { NormalizedResolveConfig } from "./resolve-config.ts";
export {
  ForguncyConfigError,
  assertDistinctTargetClaims,
  assertUniqueTargets,
  createCellRegistry,
  isCellRegistry,
} from "./cell-registry.ts";
export type { CellRegistry, RegisteredCell } from "./cell-registry.ts";
export { findForguncyConfigFile, loadForguncyConfig } from "./config-loader.ts";
export type { ForguncyConfigModuleLoader } from "./config-loader.ts";
export { composeCellCompileFingerprint } from "./cell-compile-fingerprint.ts";
