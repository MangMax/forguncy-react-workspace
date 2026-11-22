/**
 * The pure prop-key contract: the two key tuples a production Cell can name.
 *
 * Decision sources: GitHub Issues
 * - #5 — "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/5), which observed the keys.
 * - #82 — "修复 Runtime：在生产 Cell 入口自动安装 Host Provider"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/82), whose generated binding
 *   is the first *production* consumer of these names.
 * - #124 — "refactor(runtime,core): 隔离 Cell 生产超薄运行时与工具链契约表"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/124), which separated this
 *   module out.
 *
 * ## Why these two tuples live in their own module
 *
 * They used to be derived inside `runtime-contract.ts`, next to the prose and evidence that
 * explain them (`CELL_PROPS_KEY_ORDER`, `CELL_FORGUNCY_FACADE`, every execution fact and every
 * open question). That file is a *record* — it is read by the compiler, the probes and the
 * documentation — but the production runtime façade needs only the keys themselves. A
 * statically imported record is a whole module in a Cell's module graph, and a compiled Cell
 * artifact is one flat script: importing the evidence tables to read two tuples put contract
 * prose into every production Cell.
 *
 * So the tuples moved here and `runtime-contract.ts` now *uses* them. There is still exactly
 * one source of truth for the order and the membership; what changed is how much of the
 * record a consumer has to load to read it. `runtime-contract.test.ts` keeps asserting that
 * these values are what `CELL_PROPS_KEY_ORDER`/`CELL_FORGUNCY_FACADE` expose, so the
 * separation cannot become a second, drifting definition.
 *
 * This module imports nothing, deliberately: a leaf with no dependency cannot reintroduce the
 * evidence chain it was separated from, and `@forguncy-react-workspace/core/cell-props` is
 * the subpath the production runtime binds to.
 */

/**
 * The base `props` keys the ReactCellType runtime injects, in injection order.
 *
 * Order is observable and part of the contract: `Forguncy`, then `Permissions`, then
 * configured `properties[].propertyName`, then `ImageContext`.
 */
export const CELL_PROPS_BASE_KEYS = ["Forguncy", "Permissions", "ServerCommands", "ImageContext"] as const;

/**
 * The members of the `props.Forguncy` handle, in the order #5 read them.
 *
 * Membership is the confirmed set; the façade exposes nine of these fourteen through
 * `forguncyMember` and three others through dedicated members for reasons its registry
 * records.
 */
export const CELL_FORGUNCY_PROP_KEYS = [
  "ConvertDateToOADate",
  "ConvertOADateToDate",
  "ConvertToCssColor",
  "DataSourceCompareType",
  "DataSourceRelationType",
  "Permissions",
  "exposeMethod",
  "getCurrentUser",
  "getPermissions",
  "getUploadLimit",
  "hasPermission",
  "logIn",
  "logOut",
  "uploadFiles",
] as const;

/** A base `props` key the runtime always injects, as #5 pinned it. */
export type CellPropKey = (typeof CELL_PROPS_BASE_KEYS)[number];

/** A member of the `props.Forguncy` handle, as #5 pinned the key list. */
export type ForguncyPropMember = (typeof CELL_FORGUNCY_PROP_KEYS)[number];
