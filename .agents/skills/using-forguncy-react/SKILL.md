---
name: using-forguncy-react
description: 活字格 ReactCellType 项目上手入口。用于新建或接入 Forguncy React Cell 项目，以及在已有项目中本地开发、构建、预览同步计划、同步到设计器或验证真实页面。
---

# 使用 Forguncy React Workspace

面向活字格 `ReactCellType` 的 React / TypeScript / Vite+ 项目入口。先判定架构边界、按需路由到专项 Skill，再识别当前环境与项目状态并按已实现命令推进。

**活字格负责应用，React 负责单元格内的局部 UI**。[架构规格 #4](https://github.com/MangMax/forguncy-react-workspace/issues/4)

- 活字格负责：应用/页面路由、跨 Cell 共享状态、业务数据源、服务端命令、权限/认证、页面生命周期与跨 Cell 通信。属于活字格的能力直接交回宿主，属于架构边界问题，不用换包解决。
- React Cell 负责：单元格局部 UI 与交互状态、表单、图表、地图、Canvas/WebGL/3D、拖拽、动画、编辑器等。
- Workspace 共享包属于**源码**，编译时摊平进各消费 Cell，不作为运行时共享模块，也不进入 `frontendLibraries`；跨 Cell 共享状态交给活字格页面或前端扩展。

## 1. 先按任务路由到专项 Skill

动手改配置或写代码前，先判断请求是否属于专项工作；属于则按需加载对应 Skill 并遵循其流程，本入口不复写专项细节：

- **引入或评估外部依赖，处理缺失、失效或过期的依赖决策** → 加载 `forguncy-react-dependency-selection`。预览 CLI 并未提供这套脚本的独立运行环境，当前从已安装依赖的源码仓库运行专项脚本，再按专项指引定位要探测的业务项目。
- **制作、更新或排障活字格前端扩展包 ZIP（`manifest.json` + `bundle.js` + `types.d.ts`），或 `missing-extension` 需新建扩展** → 加载 `forguncy-frontend-library`。
- **常规 Cell 上手、本地开发、构建、计划、同步与真机验证** → 继续本入口。

## 2. 识别当前上下文

先确认项目目录，再判断可用的工具和连接。以下条件可同时成立。

| 上下文状态 | 判定与下一步 |
| --- | --- |
| **已有项目**（存在 `forguncy.config.{ts,mts,mjs,js}`） | 从该配置所在的项目目录执行所需步骤。 |
| **无项目** | 在源码仓库从 `examples/consumer-project/` 跑通流程。试用独立 CLI 时，按 [README 的两文件示例](https://github.com/MangMax/forguncy-react-workspace#试用全局-cli) 创建 `forguncy.config.mjs` 和 `App.tsx`，再运行 `fgc-cell build` 和 `fgc-cell plan`。 |
| **源码仓库** | 按根 README 安装 workspace 依赖，从项目目录使用已有的 `pnpm build` / `plan` / `sync` 脚本。 |
| **独立项目** | 用 `fgc-cell --help` 确认 CLI。缺少 CLI 时，按根 README 从维护者提供的 `.tgz` 全局安装。试用包仅提供 CLI。使用仓库工具包或 `vp dev` 时，从源码 workspace 的示例开始。 |
| **无设计器连接**（无已授权设计器会话或 `--port` 模块） | 仅执行本地开发（若可用）、`build` 与离线 `plan`，到此为止并如实报告未连接设计器；不编造 `--port` 跑 `sync`，不宣称真机兼容。 |

## 3. 已有项目标准工作流

仅使用当前已实现的命令，参数细节以 `fgc-cell --help` 和仓库 `README.md` 为准：

1. **本地开发（仓库/已配 Vite+ harness 项目）**：在项目目录运行 `vp dev`。
   - 开发与构建共用同一 Cell 入口源码，不建 `.dev.tsx` 孪生文件；本地页面数据通过 `fixture` 提供。
   - 配置别名或本地加载前端扩展时，查根 README 对应章节。
2. **记录依赖决策（新增或变更外部包时）**：按上面的专项入口记录决策，再构建。
3. **本地构建（纯离线）**：运行 `fgc-cell build`（或 `pnpm build`）。
   - 默认在 `.fgc/build/` 生成自包含 IIFE 脚本与 `manifest.json`，无需连接设计器。
   - 产物仅作检查与审阅；`sync` 会从源码重新编译，不复用磁盘旧产物。
4. **只读计划（不写入）**：
   - 无设计器：`fgc-cell plan`（离线编译、审计锁与目标，不写文件）。
   - 有授权端口：`fgc-cell plan --port ./mcp-port.mjs`（读取设计器扩展清单与目标 Cell 当前内容，仍不写入）。同步前核对计划指向的项目、目标和变更。端口模块由调用方提供，见 `examples/consumer-project/README.md`。
5. **显式同步（唯一写设计器的命令，#19）**：运行 `fgc-cell sync --port ./mcp-port.mjs`。
   - 默认单向同步且保护设计器人手修改，发现漂移时直接拒绝（`refused`）；仅在用户明确确认后才按 `fgc-cell --help` 使用 `--restore` 或 `--restore-all`。
   - 相同产物再次同步返回 `unchanged` 属正常幂等结果。
6. **真实活字格验证**：打开 `sync` 输出的页面 locator，实测本次改动涉及的渲染和交互，记录设计器或运行时版本及结果。

遇到报错时先读诊断的 `code`、`remediation`、`fixOwner`，按仓库 `README.md`「常见失败与恢复」处置；保持由工具链生成锁与产物，不手写 `fgc.lock.json` 或手改构建输出。

## 4. 证据边界与汇报口径

本地与 CI 全绿不等于活字格运行时兼容。汇报结果时必须按证据等级分开说明：

- **本地证据**：`vp dev`、`fgc-cell build`、离线 `fgc-cell plan`（仅证明本地挂载、编译与本地审计）。
- **连接/流程证据**：`fgc-cell plan --port`（只读）、mock port 演练。
- **真实活字格验证**：真实设计器执行 `sync --port` 并在生成页面实测。

凡未执行的验证（如缺少设计器连接或未在真实页面打开）必须明确标注“未执行”及原因。

## 5. 权威资料与缺失路径回退

优先读取当前环境中的事实源：`fgc-cell --help`、仓库根目录 `README.md`、`AGENTS.md`、`examples/consumer-project/README.md`。

试用 CLI 尚未提供 Skill 安装入口。在仓库外缺少文档或专项 Skill 时，从以下仓库查找：

- 主仓库：`https://github.com/MangMax/forguncy-react-workspace`
  - 命令、配置与排障：`README.md`、`examples/consumer-project/README.md`
  - 架构与本地开发规则：`AGENTS.md`
  - 两个专项技能及配套脚本：`.agents/skills/forguncy-react-dependency-selection/`、`.agents/skills/forguncy-frontend-library/`
  - CLI 试用包打包脚本：`scripts/pack-cli.mjs`
- 前端扩展包技能源仓库：`https://github.com/MangMax/forguncy-frontend-library`
