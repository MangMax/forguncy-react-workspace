# Forguncy React Workspace

面向**活字格 ReactCellType** 的 React / TypeScript / Vite+ 工程化工具链。

> **活字格负责“应用”，React 负责“单元格内的局部 UI”。**
> Forguncy owns the application. React owns the island.

## 先看这里：现在能做什么

- 用普通 React 工程开发 Cell，`vp dev` 本地即时看到效果，不需要同步到活字格。
- 用 `pnpm build` 编译出自包含的 Cell 脚本与 `manifest.json`，**不连接**任何活字格工程。
- 用 `pnpm plan` 离线检查“一次同步会做什么”；接上授权端口后只读检查设计器，仍然不写。
- 用 `pnpm sync -- --port ...` 显式同步；这是**唯一**会写设计器的命令。
- 依赖选型由 Skill 驱动确定性 probe，并把决策记进 `fgc.lock.json`，不靠猜测。

**当前阶段（如实说明）**：项目仍处于 **v0.1 架构验证阶段**，不是可直接用于生产的完整工具链。本地开发、构建、只读计划、mock-port 同步与 CI 已经接通；运行时契约的 pinned 目标仍是 **`12.0.101.0`**，针对 **`12.0.102.0`** 的重新测量与最终真机 gate **[#107]** 仍然欠着。**本地与 CI 全绿不是活字格运行时兼容证明**；在 [#107] 通过前，本仓库不宣称端到端真机验收。

- 总路线与依赖关系：[#3]（v0.1 Epic）
- 消费入口与本文示例：[#99]
- 最终真机 gate：[#107]

[#3]: https://github.com/MangMax/forguncy-react-workspace/issues/3
[#99]: https://github.com/MangMax/forguncy-react-workspace/issues/99
[#106]: https://github.com/MangMax/forguncy-react-workspace/issues/106
[#107]: https://github.com/MangMax/forguncy-react-workspace/issues/107

## 快速上手（可执行）

这一节里的命令都来自真实的消费入口：`examples/consumer-project` 加上公开的 `@forguncy-react-workspace/cell-project`。**除第 0 步外，所有命令都在 `examples/consumer-project` 下执行**。示例只依赖仓库内已安装的 workspace 包，不需要任何未发布的 npm 版本。

前置条件：

- Node **≥ 24**（仓库 `engines`）
- pnpm **11.18**（仓库 `packageManager`）
- 想跑 `sync` 时，还需要一个**已授权的活字格设计器连接**，以及一个导出 `ForguncySyncPort` 的端口模块（见第 5 步）

<!-- quickstart:start -->

### 0. 安装依赖（仓库根目录）

```bash
# 工作目录：仓库根目录
pnpm install --frozen-lockfile
```

`pnpm install` 会把 workspace 里的包全部链接好。之后的命令都切到示例项目：

```bash
# 工作目录：仓库根目录
cd examples/consumer-project
```

### 1. 本地开发：不需要活字格

```bash
# 工作目录：examples/consumer-project
vp dev
```

`vp dev` 把 `cells/sales-overview/src/App.tsx` 当作普通 React 挂载，用 `cells/sales-overview/fixture.ts` 作为页面数据的 mock provider，并提供 HMR。编辑 Cell 源码即可看到更新，**不需要**同步到活字格。

它**不是**活字格模拟器。`vp dev` 的绿色结果属于 `local` 证据，不能证明设计器接受源码、页面生命周期正确、权限或跨 Cell 隔离成立。

### 2. 记录依赖决策

```bash
# 工作目录：examples/consumer-project
pnpm record
```

`record` 运行依赖选型 Skill 的确定性半边：对已安装的 `es-toolkit` 跑 probe，把 `inline` 决策写入：

- `fgc.lock.json`
- `fgc-evidence/`
- `.fgc/probe-cache/`

`fgc.lock.json` 与 `fgc-evidence/` 都是 **git-ignored** 的，因为记录里的 `installGraph` 是“执行它的这台机器”的测量；换一台机器本来就该重新 record。仓库里提交的是决策**输入** `dependencies/es-toolkit.decision.json`，这是评审能在 diff 里判断的那一半。

仓库在 `.agents/skills/` 下安装了 Skill，支持 Agent Skills 的工具会**自动发现**它们；本文不维护第二份 Skill 清单。让 Agent 选库时，应当走 Skill 的 `probe` → `audit` → `record`，而不是手写 `fgc.lock.json`。

### 3. 本地构建 Cell 产物

```bash
# 工作目录：examples/consumer-project
pnpm build
```

构建是纯本地的，**不连接、不写入**任何活字格工程。产物写到示例项目自己的输出目录：

- `examples/consumer-project/.fgc/build/salesOverview.js` —— 一个自包含的 IIFE，CSS 与 `badge.png` 都已内联
- `examples/consumer-project/.fgc/build/manifest.json` —— 每个 Cell 的目标、字符数、fingerprint、资源与诊断

终端会看到类似输出（字符数、fingerprint 以实际为准）：

```text
Cell salesOverview -> 销售看板!B2: compiled
  artifact salesOverview.js: 65823 chars, fingerprint c4f60e5eaa859bc4…
  decision react: host (from #9's host bridge — undecided by this project)
  decision es-toolkit: inline
```

构建产物是**报告与检查对象**。`sync` 会从源码重新编译，而不是信任磁盘上某次 build 留下的文件。

### 4. 只读计划：先看会发生什么

```bash
# 工作目录：examples/consumer-project
pnpm plan
pnpm plan -- --port ./mcp-port.mjs
```

- `pnpm plan`：**offline**。编译、审计 lock、解析目标，不联系任何人、不写任何文件。可以在 CI、全新 clone、没有设计器的 Agent 里运行。
- `pnpm plan -- --port ./mcp-port.mjs`：**connected**。读取设计器的前端库清单与每个目标 Cell 的当前内容，然后给出与一次真实 `sync` 相同的计划；它**仍然不写**。

`mcp-port.mjs` 是**你自己的**端口模块，示例不附带真实设计器连接。模块默认导出（或命名导出 `port`）一个 `ForguncySyncPort`，包含 7 个方法：`listFrontendLibraries`、`readCellSource`、`setCells`、`getProjectSaveStatus`、`saveProject`、`checkProjectErrors`、`generatePageAsync`。具体形状见 [`examples/consumer-project/README.md`](examples/consumer-project/README.md)。

### 5. 显式同步：唯一会写的命令

```bash
# 工作目录：examples/consumer-project
pnpm sync -- --port ./mcp-port.mjs
```

`sync` 没有默认端口：授权连接属于调用方（Agent 的 MCP 会话或项目自己的适配器），所以必须用 `--port` 指名。缺参数是用法错误，**不会**退化成一次看起来像部署的静默 dry run。

一次 `sync` 的流程是：重新编译 → 读取清单与目标 → 计划并拒绝冲突 → `setCells` → `saveProject` → 检查项目错误 → `generatePageAsync`。成功时会打印可打开的页面 locator。

同一份产物再次同步会报告 `unchanged`，且不重复写入 —— 这是正常结果，不是失败。

### 6. 验证边界

```bash
# 工作目录：examples/consumer-project
pnpm plan -- --port ./mcp-port.mjs
```

先确认计划仍然是预期的那一个，再打开 `sync` 打印的 locator 看页面。**真正的兼容性验收是 #107**：一个独立 Agent 在真实活字格设计器与生成页面上完成新业务 Cell、权限/数据/命令、跨 Cell 隔离与失败恢复。在它通过前：

- 本地 `vp dev`、`build`、offline `plan` 都是 `local` 证据；
- `record` / probe 是构建输入证据；
- `plan --port` 与 mock-port `sync` 是流程证据；
- 只有真实页面能证明“活字格接受并正确运行”。

<!-- quickstart:end -->

## 项目配置：`forguncy.config.ts`

一个消费项目只有一个声明文件。它说明 Cell 是什么、产物去哪、目标页面和单元格是谁：

```ts
import { defineForguncyConfig } from "@forguncy-react-workspace/core";

export default defineForguncyConfig({
  runtime: { forguncyVersion: "12.0.101", projectAlias: "consumer-example" },
  extensions: {
    mappings: [
      {
        packageName: "@example/chart-panel",
        libraryId: "example-chart-panel",
        globalName: "ExampleChartPanel",
        // …
      },
    ],
  },
  cells: {
    salesOverview: {
      entry: "./cells/sales-overview/src/App.tsx",
      fixture: "./cells/sales-overview/fixture.ts",
      target: { pageName: "销售看板", cell: "B2" },
    },
  },
});
```

几个关键点：

- `cells.<id>.target` 把 Cell 映射到活字格的 `页面名 + 单元格`。`pnpm plan` / `sync` 都通过同一个 registry 解析目标；两个 Cell 不能声明同一个目的地。
- `cells.<id>.entry` 既是 `vp dev` 挂载的文件，也是编译器打包的文件 —— 没有 `.dev.tsx` 孪生文件。
- `cells.<id>.fixture` 只用于本地开发，是页面数据的 mock。
- `runtime.forguncyVersion` 是**记录**的目标版本，不是运行时检查；写在这里不代表已经连上那个版本的活字格。
- `extensions.mappings` 是**项目自己的**扩展行。它不会修改工具内置表；行里的 `libraryId` / `globalName` 必须来自真实的 `listFrontendLibraries`，不能凭猜填写。

## 依赖策略

第三方依赖按实际运行方式分成四种策略：

| 策略 | 含义 |
| --- | --- |
| `host` | 由活字格 / ReactCellType 宿主提供，例如页面上的 React、ReactDOM、antd。项目不需要安装 React；宿主桥接会在 Node 解析之前接管这些模块名。 |
| `inline` | 直接打包进当前 Cell 产物。兼容的现代浏览器库默认走这里。 |
| `extension` | 由活字格前端扩展提供。适合需要共享模块身份、跨 Cell 单例/缓存，或明确复用的大型依赖。 |
| `replace` | 当前库不适合该运行环境，换一个更现代、更适合浏览器 / ESM 的替代方案，而不是维护一个永久适配器。 |

`host` / `inline` / `extension` 是三种**可部署**策略，`replace` 是对“这个包不该进入 Cell”的答复。

### workspace 共享源码不是运行时模块

Cell 可以按名字导入 `@app/consumer-ui` 这样的 workspace 包。编译器会把它的源码**摊平**进每个消费它的 Cell 产物 —— 不产生共享的运行时模块：

- 两个 Cell 各自带一份代码；
- 包里的 React Context 只属于那个 Cell；
- 模块级状态是 per-Cell 的；
- workspace 包不会出现在 `frontendLibraries`，也不参与依赖策略决策。

因此，**跨 Cell 的状态必须交给页面或扩展提供的模块**，不能靠一个 workspace 包“共享”。同理，不要在 Cell 里重建应用路由、第二套全局业务 Store、权限系统或第二份业务数据源 —— 这些属于活字格。

依赖策略的判断顺序是先归属、再选包：如果能力属于活字格（页面路由、跨 Cell 业务状态、权限、数据源），就应当交回宿主；只有属于单元格局部 UI 的能力才进入选型。工具不会用“某个包能跑”来覆盖归属结论。

## CSS 与静态资源：v1 的封闭支持集合

普通的 `import "./panel.css"`、`import logo from "./logo.svg"`，在 `vp dev` 与 Cell 产物里**含义相同**：资源被内联进那个自包含脚本，不生成兄弟文件、不在运行时猜目录、不暗中请求 CDN。

| 写法 | v1 结论 |
| --- | --- |
| `import "./x.css"`（普通 CSS） | ✅ 注入以样式内容哈希为 key 的 `<style data-forguncy-cell-style="…">` |
| 普通 CSS 里指向同级小图片/字体的 `url(…)` | ✅ 重写成 `data:` URI（上限内） |
| `import url from "./x.png"` 等静态资源默认导入 | ✅ 默认导出是 `data:` URI（上限内） |
| `*.module.css`（CSS Modules） | ❌ 明确拒绝：v1 不提供与 Vite 一致的自动作用域实现 |
| CSS `@import` / `image-set()` | ❌ 拒绝：前者是样式级联解析，后者可以绕过 `url()` 引用文件 |
| `http:` / `https:` / `//` / 以 `/` 开头的远程或绝对 URL | ❌ 拒绝：产物不能暗中联网，也不知道页面目录 |
| `?raw` / `?url` / `?inline` / `?worker` / `?sharedworker` | ❌ 拒绝：每个 query 都对应一个单文件编译器未实现的 Vite 变换 |
| Worker / `.wasm` / 其它二进制资源 | ❌ 拒绝 |
| 超过内联上限的资源（默认 4096 字节） | ❌ 拒绝，并报告实测字节数与上限 |

拒绝是**结构化诊断**（`rejected-cell-asset`），带 `extension` / `replace` 方向。需要被页面共享、被扩展加载、或本来就是二进制的资源，应当放进活字格前端扩展；只是太大或格式不合适，就换一个 v1 能内联的方案。

**选择器不会自动作用域**。普通 CSS 和 Vite 下一样是全局的，请给 Cell 根元素加自己的 class 前缀（示例用 `.sales-overview`）。CSS Modules 能做到自动作用域，但 v1 明确拒绝它 —— 这是选择，不是遗漏。

样式生命周期由产物里的小安装器管理：同一个 Cell 重复求值不会追加第二个 `<style>`；两个 Cell 各有自己的 id，卸载一个不会删掉另一个仍在用的样式。

## 证据等级：别把本地绿当成兼容

这个仓库区分四种证据，**不能互相替代**：

| 等级 | 来源 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| **Local** | `vp dev`、`pnpm build`、offline `pnpm plan` | Cell 源码能被本地 React 挂载；能被编译器打包；资源能内联；lock 与 workspace 图能通过本地审计 | 设计器接受源码、页面生命周期、权限、跨 Cell 隔离、扩展加载 |
| **Probe** | `pnpm record`（Skill 的 `probe` / `audit` / `status`） | 已安装包在确定性 probe 下的构建事实；决策记录可复现 | 包在活字格页面上的行为；真实运行时兼容 |
| **Compile / DOM / Mock-port** | `pnpm plan -- --port`、recording-port 的 `pnpm sync -- --port`、测试里的 DOM 求值 | 完整同步流程可走通；编译产物在 DOM 中可求值；计划能读取目标并拒绝冲突 | 真实设计器接受了调用；生成页面真的渲染 |
| **Real Forguncy Runtime** | [#107] 的真机 gate：真实设计器 + 生成页面 | 页面/路由/权限/数据/命令/跨 Cell 隔离/扩展身份与加载顺序/页面离开重入 | —— |

CI 跑的是前三类。**CI 绿不等于真机兼容**，本地绿也不等于 CI 绿，更不等于 #107。仓库在报告里刻意把“本地能编译”和“部署 gate 会扣下什么”分开打印，就是为了避免把前者读成后者。

## 常见失败与恢复

所有修复都应当**先读诊断里的 `code`、`message`、`remediation` 和 `fixOwner`**，再动手。不要在不理解原因时使用 `force`。

### 1. 缺包，或依赖没有决策

- **症状 / code**：`build` 或 `plan` 报 `unresolved-dependency-decision`。
- **原因**：Cell 导入了一个包，但没有任何单一可用决策（`host` / `inline` / `extension`），或者包根本没有安装。
- **恢复**：
  1. 先让包在项目里可解析：在 `examples/consumer-project` 下 `pnpm add <package>`；
  2. 让 Agent 用 Skill 对它跑 `probe` → `audit` → `record`，生成 `fgc.lock.json`；
  3. 如果这个能力其实属于活字格，删掉导入，把能力交回宿主。
- **不要**手写 `fgc.lock.json`，也不要为了“先跑起来”把包写进 `frontendLibraries`。

### 2. 缺 `extensions.mappings`，或扩展对不上

- **症状 / code**：
  - 编译期：`missing-extension-mapping`；
  - 同步期：`extension-decision-unusable`（由 `extension-mapping-missing` 翻译而来）、`missing-extension`、`extension-identity-mismatch`。
- **原因**：依赖被决定为 `extension`，但项目没有映射行；或页面上的扩展 id / global / bundle / types 与映射不一致。
- **恢复**：
  1. 在 `forguncy.config.ts` 的 `extensions.mappings` 里补一行，`libraryId` 与 `globalName` 必须来自真实的 `api.app.listFrontendLibraries`；
  2. 在页面上安装/上传与映射一致的扩展版本；
  3. 如果这个包不需要共享模块身份，让 Skill 重新评估为 `inline` 或 `replace`。
- **不要**编造 `libraryId`，也不要通过改生成代码绕过扩展审计。

### 3. lock 过期

- **症状 / code**：`build` 报告某条记录 `WITHHELD`，`stalenessReasons` 包含：
  - `package-version-changed`：安装版本与记录不一致；
  - `toolchain-changed`：编译器工具链变了；
  - `install-graph-changed`：安装图（lockfile / patches / 配置 / 安装树）变了；
  - `forguncy-target-changed`：目标契约版本变了。
- **恢复**：重新运行 `pnpm record`，让它用当前机器重新测量；然后审阅 `fgc-evidence/` 的差异。报告里的 `pnpm record` 就是命名的修复方式。
- **注意**：`probe-fingerprint-unknown` 是**本地边界**，不是“已通过”。本地进程组合不出 probe 指纹，所以它被保留并报告，而不是被悄悄当成新鲜。真实页面/探针才能回答的那部分仍然欠着。

### 4. 人工改过 Cell：`cell-diverged`

- **症状 / code**：`sync` 报告 `refused`，诊断 `cell-diverged`。
- **原因**：目标 Cell 当前内容不是上次 sync 写入的生成代码，而是设计器里的人手修改。直接覆盖会毁掉仓库无法重建的工作。
- **恢复**：
  1. 先读目标 Cell；
  2. 如果改动应当保留，把它移回仓库源码，再重新 `build` / `sync`；
  3. 如果只是实验，在活字格里清空或还原该 Cell，再同步。
- `--overwrite force` 是**需要人明确决定**的检查选项：接上端口时，`pnpm plan -- --port <module> --overwrite force` 可以看到“如果强制写，会写什么”；`mcp-sync` 的 API 也提供该策略。CLI 的 `pnpm sync` **没有**默认的盲写开关，本文不建议为了绕过 `cell-diverged` 而改默认策略。
- **不要**直接编辑生成代码。

### 5. 重复同步一直 `unchanged`

- **症状**：第二次 `pnpm sync` 报 `unchanged`，没有写入。
- **含义**：目标已经持有与当前编译产物完全一致的 fingerprint。这是成功结果，不是错误。
- **如果不符合预期**：
  1. 确认 `forguncy.config.ts` 里的 `target` 确实是你想写的页面/单元格；
  2. 确认源码改动确实进入了这次编译（`pnpm build` 的 fingerprint 应变化）；
  3. 再跑一次 `pnpm sync -- --port ...`。
- **不要**为了强制“看起来写了”而改生成代码或伪造 fingerprint。

### 6. 写入后保存 / 检查 / 生成失败（#92 / #93）

- **症状 / code**：
  - `project-errors-after-sync`：写入后项目报错；
  - `runtime-generation-failed`：页面生成没有返回 locator；
  - transport failure：报告 `stage` / `operation` / `mutationState`，并可能把目标列入 `uncertain`。
- **恢复**：
  1. 按诊断修复项目本身（配置、权限、扩展、生成条件）；
  2. **原样重跑** `pnpm sync -- --port ...`。执行器会在写每个目标前重新读取它的当前内容，所以已经落地的写入会被识别为 `unchanged`，失败或未尝试的目标才会重试；
  3. 读报告里的 `mutated` / `uncertain` 判断哪些目标已经改变。
- **不要**手改生成代码，也不要因为一次 transport failure 就假设“没写进去”。报告会明确说它是否知道写入状态。

## 本地开发里的 `extension` 依赖

`extension` 依赖需要共享模块身份或跨 Cell 单例语义，本地把它解析成本机 npm 包会产生“渲染正确但结论错误”的结果。因此 `vite.config.ts` 必须为每个 `extension` 依赖声明一个分支：

- `substitute`：本地用某个已安装包或项目 shim 替代，并写明理由；
- `real-runtime-only`：承认它只能留给真实运行验证，本地解析到一个**抛出异常**的模块，绝不静默退回 npm 副本。

`vp dev` 启动时会审计这份声明，遇到**未声明**的 `extension` 依赖会直接拒绝启动。完整的匹配、过期与本地边界规则见 [`AGENTS.md`](AGENTS.md) 和 [`examples/consumer-project/README.md`](examples/consumer-project/README.md)。

## 模块别名

想在 Cell 里写 `import { Button } from "@/ui"` 这类短路径时，别名写在 **`forguncy.config.ts`** 的 `resolve.alias` 里，不写在 `vite.config.ts` 里：

```ts
export default defineForguncyConfig({
  cells: { /* … */ },
  resolve: {
    alias: {
      "@/ui": "./src/ui",
      "@app/shared": "./packages/shared",
    },
  },
});
```

原因很实际：Cell 产物是一个自包含 IIFE，生产构建直接驱动 Rolldown，读不到 `vite.config.ts` 里的别名。写在项目配置里，`vp dev` 与 Cell 构建才读同一份对象。

别名只支持字符串 key / 字符串目标的**封闭子集**；正则、裸包名目标、绝对路径、项目根、宿主桥接 id（如 `react`）等都会明确报错，而不是“本地生效、产物不生效”。`vite.config.ts` 里可以有本地临时别名，但不能与项目别名重叠，否则 `vp dev` 会拒绝启动。

## 仓库协作方式

本仓库采用 **Issue-first / PR-first**：

- 设计与技术 Spec 放在 GitHub Issues；
- 实施计划与依赖关系放在 Issues / Epic Issues；
- 代码通过关联 Issue 的 Pull Request 提交；
- 不在仓库里维护 `specs/`、`plans/` 文档树；
- 未经过真实活字格运行验证的能力，不宣称为已兼容；
- 本地检查与真实运行验证必须分开报告。

仓库安装的 Skill 位于 `.agents/skills/`，支持 Agent Skills 的工具会自动发现；本 README 与 `AGENTS.md` 都不维护重复的 Skill 注册清单。

## 进一步阅读

- [`examples/consumer-project/README.md`](examples/consumer-project/README.md)：示例项目每一块对应哪个契约、每个命令对外部世界做什么。
- [`AGENTS.md`](AGENTS.md)：架构与依赖规则、`vp dev` 的本地边界、Agent 必须遵守的约束。
- [Issue #3](https://github.com/MangMax/forguncy-react-workspace/issues/3)：v0.1 总 Epic 与任务依赖。
- [Issue #99](https://github.com/MangMax/forguncy-react-workspace/issues/99)：本文 Quickstart 所依赖的消费入口。
- [Issue #106](https://github.com/MangMax/forguncy-react-workspace/issues/106)：本文档票。
- [Issue #107](https://github.com/MangMax/forguncy-react-workspace/issues/107)：最终真机消费方验收。
