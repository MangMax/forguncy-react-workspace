/**
 * The public surface of `@forguncy-react-workspace/vite-plugin-fgc` (#159).
 *
 * Only names another workspace package, an example, or the dependency-selection Skill
 * imports are exported here. Everything else this package used to export is still reachable
 * from `./internal`, which no other package may import; the implementation and the
 * package-scope note live in `./plugin.ts`, which `./internal` projects in full.
 *
 * `package-boundaries.test.ts` pins this list in both directions — the source read (types)
 * and the run-time namespace (values) — so adding a name here is a deliberate surface change.
 */

export { cellVirtualModuleId, forguncy } from "./plugin.ts";
