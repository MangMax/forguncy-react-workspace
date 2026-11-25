/**
 * `@forguncy-react-workspace/cell-project` — the consumer entrypoint #99 asks for.
 *
 * Decision sources: GitHub Issues
 * - #99 — "消费入口：提供无需内部 API 拼装的最小业务项目与 build/sync 命令"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/99), this package,
 * - #97 — "构建入口：统一 Cell registry、别名与生产构建配置的消费路径"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/97), whose entry `build` calls,
 * - #19/#20/#93 — the sync contract, executor and retry-safe reporting `sync` calls,
 *
 * downstream of #4, #8 and #26.
 *
 * ## The three verbs, and the rule they share
 *
 * ```
 * build  — compile every Cell, write artifacts + manifest, make NO remote call
 * plan   — decide what a sync would do; offline (no call) or connected (reads, still writes nothing)
 * sync   — the only verb that writes, and only through a port the caller supplies
 * ```
 *
 * Nothing here resolves a dependency, measures a probe, decides an ownership question or writes a
 * mutation payload. Each of those has exactly one owner in this workspace, and a consumer
 * entrypoint that re-derived one of them would be the second copy that drifts. What this package
 * owns is the *composition* — loading the project once, handing the same registry/decisions/
 * artifacts to every verb — and the report shapes that let an Agent act without reading seven
 * packages' internals.
 *
 * ## What it deliberately does not do
 *
 * - **No MCP client.** An authorized designer connection is the caller's. `sync` takes a
 *   `ForguncySyncPort`; the CLI takes `--port <module>`. A built-in transport would be a second
 *   client next to the one #20 measured, and the first thing it would enable is a sync nobody
 *   authorized.
 * - **No dev server.** Local development is `vp dev` in the project, assembled by
 *   `defineForguncyViteConfig` (#125) against the *same* `forguncy.config.ts` this package reads.
 *   The same Cell source therefore compiles here and is served there, with no `.dev` twin.
 * - **No runtime claim.** A green build, plan or recording-port sync is `local` evidence. Real
 *   Forguncy validation is a designer run against `RUNTIME_CONTRACT_TARGET` — AGENTS.md rules 6–7.
 *
 * ## The one decision it does supply, and why it is not a selection
 *
 * A React Cell imports `react`, and #9's bridge binds that specifier to the page's global before
 * Node resolution runs — so there is no package for a project to *select*, and a lock that
 * recorded `{ strategy: "host", packageName: "react" }` would be restating a fact about the page.
 * `loadCellProject` therefore supplies the bridge's `host` rows for packages the lock does not
 * decide ({@link hostDefaultsOf}), and a recorded decision always wins. This is what lets a
 * consumer project compile from a lock that only records the packages it actually chose.
 */

export {
  cellLockOf,
  deploymentTargetIdentity,
  deploymentWithheldOf,
  hostDefaultsOf,
  loadCellProject,
  projectExtensionMappings,
  unobservableReasonsOf,
} from "./project.ts";
export type {
  HostDefault,
  LoadCellProjectOptions,
  LoadedCellProject,
  ProjectCellLock,
  ProjectExtensionMapping,
} from "./project.ts";

export {
  BUILD_MANIFEST_FILE_NAME,
  buildProject,
  compileProject,
  DEFAULT_BUILD_OUT_DIR,
  formatProjectBuildReport,
} from "./build.ts";
export type {
  BuildDiagnosticReport,
  BuildProjectOptions,
  CellBindingsReport,
  ManifestArtifact,
  ManifestResource,
  ProjectBuild,
  ProjectBuildReport,
  ProjectCellBuildReport,
  UnobservableDecisionReport,
  WithheldDecisionReport,
} from "./build.ts";

export {
  formatPlannedCellSteps,
  formatProjectSyncPlan,
  planProject,
  planProjectAgainstPort,
  ProjectPlanError,
} from "./plan.ts";
export type {
  PlanAgainstPortOptions,
  PlannedCellSync,
  PlanProjectOptions,
  ProjectPlan,
  ProjectSyncPlanReport,
} from "./plan.ts";

export { formatProjectSyncReport, syncProject } from "./sync.ts";
export type { ProjectSyncReport, SyncProjectOptions, SyncedCellReport } from "./sync.ts";
