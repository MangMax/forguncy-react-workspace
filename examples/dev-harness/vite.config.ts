import { defineConfig } from "vite-plus";

import forguncyConfig from "./forguncy.config.ts";
import { defineForguncyViteConfig } from "@forguncy-react-workspace/dev-harness";

/**
 * `vp dev` in this example: the harness, the config, and nothing else.
 *
 * Decision sources: GitHub Issues
 * - #125 — "feat(dev-harness): 提供 defineForguncyViteConfig 顶层配置助手，消除业务项目
 *   vite.config.ts 样板拼装"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/125)
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23)
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22)
 *
 * ## What this file used to do, and why it no longer does
 *
 * It used to call `harnessHostModulePlan()` and assemble `plugins`, `resolve.alias`/`dedupe` and
 * `optimizeDeps.include` by hand. Every one of those lines was a rule from the harness contract,
 * and a project that dropped one did not get an error — it got a loop that renders but resets
 * `useState` on every edit, or one whose first `import ... from "react"` fails because the CJS
 * host package was never pre-bundled. `defineForguncyViteConfig` now owns that assembly, so this
 * file states only what this example decided.
 *
 * ## The config file is *imported*, not loaded
 *
 * That is #26's rule and it is why the harness takes a config *object*: under Vite+ this file
 * imports `forguncy.config.ts` itself, so Vite loads it with the very runtime it already uses for
 * its own config. Handing the harness a path would make it load the file a second time, creating
 * the second config runtime #26 forbids and letting the plugin and the build disagree about which
 * config was in effect.
 *
 * ## Overrides still win
 *
 * The helper takes a second argument for anything conventional Vite configuration this project
 * wants, and a project's `resolve.alias` entries keep precedence over the host plan — a patched
 * React or a local fork can still be pointed at here. This example needs none of it today, so the
 * call is one line.
 *
 * A green `vp dev` here is **`local` evidence only**: it says the config assembled and the Cell
 * source was served, not that the designer accepts the source or that the artifact behaves on a
 * real page (#6/#7/#20/#25).
 */
export default defineConfig(defineForguncyViteConfig({ config: forguncyConfig }));
