import { defineConfig } from "vite-plus";

import { defineForguncyViteConfig } from "@forguncy-react-workspace/dev-harness";

import forguncyConfig from "./forguncy.config.ts";

/**
 * `vp dev` in this project: the harness, the config, and nothing else.
 *
 * Decision sources: GitHub Issues
 * - #99 — "消费入口：提供无需内部 API 拼装的最小业务项目与 build/sync 命令"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/99), whose acceptance criteria
 *   require the same Cell source to run locally and compile for Forguncy;
 * - #125 — "feat(dev-harness): 提供 defineForguncyViteConfig 顶层配置助手"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/125), the helper this file is;
 * - #23/#22 — the loop and its contract.
 *
 * ## Why this is four lines
 *
 * Everything a harness config must contain — Fast Refresh first, the host-module substitutions,
 * `dedupe`, `optimizeDeps.include` — is a rule of the loop, not a decision this project makes.
 * `defineForguncyViteConfig` owns that assembly so a project states only what it chose; the failure
 * mode of a hand-assembled config is green (HMR quietly degrading to a page reload, or a CJS host
 * package never pre-bundled), which is why it is not left to each project.
 *
 * ## The config file is *imported*, not loaded
 *
 * That is #26's rule: under Vite+ this file imports `forguncy.config.ts` itself, so Vite loads it
 * with the runtime it already uses for its own config. Handing the harness a path would be the
 * second config runtime #26 forbids, and would let the dev server and `fgc-cell build` disagree
 * about which config was in effect — the one disagreement this example exists to rule out.
 *
 * There are no `extensionChoices` here, and their absence is deliberate rather than an omission:
 * this project declares a mapping row but no `extension` *decision*, so there is no package the
 * local loop would have to substitute or refuse. A project that records an `extension` decision
 * must declare one of #22's two branches, and the dev server refuses to start without it.
 *
 * A green `vp dev` is **`local` evidence only**: it says the config assembled and the Cell source
 * was served, not that the designer accepts the source or that the artifact behaves on a page.
 */
export default defineConfig(defineForguncyViteConfig({ config: forguncyConfig }));
