/**
 * `@forguncy-react-workspace/runtime/cell` — the production Cell entry, and nothing else.
 *
 * Decision source: GitHub Issue #124 — "refactor(runtime,core): 隔离 Cell 生产超薄运行时与
 * 工具链契约表，防止元数据打入 Cell 产物"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/124), under #21's single-Cell budget.
 *
 * `index.ts` is the whole package because the package has three audiences: a Cell calls
 * `runtimeFacade()`, `dev-harness` reads `local-dev.ts`, and tests read `capabilities.ts`. A
 * compiled Cell needs the first and must not carry the other two — the local-dev contract alone
 * is about 2,600 lines of contract prose, and the capability registry is another 892. So the compiler's
 * generated binding imports *this* entry (`runtime-binding.ts` embeds its resolved id) and no
 * other. `index.ts` stays the complete surface, so nothing outside a Cell artifact changes.
 *
 * The re-export is `export *` deliberately: a hand-copied name list would drift the first time
 * `cell-runtime.ts` gained a member, and this entry's contract is exactly "everything the
 * production runtime exports". The reason it is safe to be generous *here* — where the root
 * entry cannot be — is that `cell-runtime.ts` reaches no registry, no mock and no local-dev
 * contract; what it exports is already the runtime.
 */
export * from "./cell-runtime.ts";
