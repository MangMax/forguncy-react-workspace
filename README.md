# Forguncy React Workspace

面向**活字格 ReactCellType** 的 React / TypeScript / Vite+ 工程化工具链。

> **活字格负责“应用”，React 负责“单元格内的局部 UI”。**
> Forguncy owns the application. React owns the island.

## 现在能做什么

- `vp dev`：用普通 React 工程开发 Cell，本地即时看到效果，不需要同步到活字格。
- `pnpm build`：编译自包含的 Cell 脚本与 `manifest.json`，**不连接**任何活字格工程。
- `pnpm plan`：离线检查“一次同步会做什么”；接上授权端口后只读检查设计器，**仍然不写**。
- `pnpm sync -- --port ...`：显式同步，是**唯一**会写设计器的命令。
- 依赖选型由 Skill 驱动确定性 probe，决策记进 `fgc.lock.json`，不靠猜测。

**当前阶段（如实说明）**：v0.1 架构验证阶段，不是可直接用于生产的完整工具链。运行时契约的 pinned 目标是 **`12.0.102.0`**（`12.0.101.0` / `12.0.100.0` 仅作历史证据，不再是目标）；v0.1 Epic gate [#25] 与首个可用版本真机 gate [#107] 均已在 `12.0.102.0` 上端到端验收并关闭。**本地与 CI 全绿仍不是活字格运行时兼容证明**；后续改动都要在真实设计器与生成页面上重新验证，不继承这次验收。

路线：[#3]（v0.1 Epic） · 消费入口与本文示例：[#99] · 本文档票：[#106]

[#3]: https://github.com/MangMax/forguncy-react-workspace/issues/3
[#99]: https://github.com/MangMax/forguncy-react-workspace/issues/99
[#25]: https://github.com/MangMax/forguncy-react-workspace/issues/25
[#106]: https://github.com/MangMax/forguncy-react-workspace/issues/106
[#107]: https://github.com/MangMax/forguncy-react-workspace/issues/107
[#105]: https://github.com/MangMax/forguncy-react-workspace/issues/105
[#126]: https://github.com/MangMax/forguncy-react-workspace/issues/126

## 公开 API：业务项目只读最小的一层

业务项目（Cell 源码、`forguncy.config.ts`、`vite.config.ts`）只需要 **5 个** workspace 符号，外加一个端口模块类型：

| 文件 | 导入 | 作用 |
| --- | --- | --- |
| `forguncy.config.ts` | `defineForguncyConfig`（`@forguncy-react-workspace/core`） | 声明 Cell、目标与项目扩展行 |
| `vite.config.ts` | `defineForguncyViteConfig`（`…/dev-harness`） | 组装本地开发 loop |
| Cell 与 fixture | `runtimeFacade`、`createMockDataSource`、`MockRuntimeFacadeOptions`（`…/runtime`） | 宿主能力与本地 mock provider |
| 自己的 `--port` 模块 | `ForguncySyncPort`（`…/mcp-sync`，类型） | 声明一个已授权的设计器连接 |

`build` / `plan` / `sync` 不需要 import：它们是 `@forguncy-react-workspace/cell-project` 的 `fgc-cell` 命令。

**这一层之外不是业务 API。** 各包根入口导出的规格表、诊断规则、探针评分与证据 formatter 是工具链内部词汇，不承诺跨版本稳定；`core/browser`、`runtime/cell` 这类子路径选择的是**模块图**（Node 还是浏览器半边），不是第二套业务入口。分层由 [`consumer-surface.test.ts`](packages/cell-project/src/consumer-surface.test.ts) 钉住：扫描示例的真实 import，并固定 `cell-project` 根入口的导出清单。兼容代理（`dependency-resolver` → `core`、`dev-harness` → `runtime` 的再导出）仍可导入，但新代码应直接 import `core` / `runtime`；收敛范围见 [#105]，删除窗口见 [#126]。

## 快速上手（可执行）

在 Agent 中可以从 [`using-forguncy-react`](.agents/skills/using-forguncy-react/SKILL.md) 开始。它会根据当前项目和设计器连接，引导本地开发、构建、计划或同步。

### 试用全局 CLI

已安装本仓库开发依赖的维护者可以用 Node.js 24 或更新版本打包试用版：

```bash
node scripts/pack-cli.mjs 0.1.0-preview.1
```

输出为仓库根目录下的 `.fgc/release/forguncy-react-workspace-cli-0.1.0-preview.1.tgz`。可传第二个参数指定输出目录。收到 tarball 后，在独立项目里执行：

```bash
npm install -g /path/to/forguncy-react-workspace-cli-0.1.0-preview.1.tgz
fgc-cell --help
```

安装试用包时，npm 仍会从 registry 下载依赖。若 npm 提示 `@swc/core` 的安装脚本未获许可，但安装成功，可继续运行下面的两文件示例。

在一个空目录里创建 `forguncy.config.mjs`。把 `pageName` 和 `cell` 改为实际目标即可用于后续同步。

```js
export default {
  runtime: { forguncyVersion: "12.0.102", projectAlias: "hello" },
  cells: {
    hello: {
      entry: "./App.tsx",
      target: { pageName: "首页", cell: "B2" },
    },
  },
};
```

在同一目录创建 `App.tsx`。

```tsx
export function App() {
  return <p>你好，活字格</p>;
}
```

```bash
fgc-cell build
fgc-cell plan
```

`build` 在 `.fgc/build/` 生成代码和清单。`plan` 离线列出计划写入的位置。这个示例只使用宿主提供的 React，无需在项目里安装依赖。

需要 `runtimeFacade`、`vp dev` 或第三方依赖决策工具时，从下方的仓库内消费示例开始。独立试用包提供 `build`、`plan` 和 `sync`。项目初始化和 Agent Skill 安装由 [#191](https://github.com/MangMax/forguncy-react-workspace/issues/191) 跟踪，真机同步需要授权端口。

### 仓库内的消费示例

命令都来自真实消费入口：`examples/consumer-project` 加上公开的 `@forguncy-react-workspace/cell-project`。**除第 0 步外，所有命令都在 `examples/consumer-project` 下执行。**

前置条件：Node **≥ 24**（仓库 `engines`）、pnpm **11.18**（仓库 `packageManager`）；跑 `sync` 还需要**已授权的活字格设计器连接**，以及一个导出 `ForguncySyncPort` 的端口模块（见第 5 步）。

<!-- quickstart:start -->

### 0. 安装依赖（仓库根目录）

```bash
# 工作目录：仓库根目录
pnpm install --frozen-lockfile
```

`pnpm install` 链接好 workspace 里的全部包后，切到示例项目：

```bash
# 工作目录：仓库根目录
cd examples/consumer-project
```

### 1. 本地开发：不需要活字格

```bash
# 工作目录：examples/consumer-project
vp dev
```

把 `cells/sales-overview/src/App.tsx` 当作普通 React 挂载，用 `cells/sales-overview/fixture.ts` 作为页面数据的 mock provider，并带 HMR。它**不是**活字格模拟器：绿色结果属于 `local` 证据，不能证明设计器接受源码、页面生命周期、权限或跨 Cell 隔离。

### 2. 记录依赖决策

```bash
# 工作目录：examples/consumer-project
pnpm record
```

对已安装的 `es-toolkit` 跑 probe，把 `inline` 决策写入 `fgc.lock.json`、`fgc-evidence/`、`.fgc/probe-cache/`。前两者 **git-ignored**：记录里的 `installGraph` 是“这台机器”的测量，换机本就该重新 record；仓库提交的是决策**输入** `dependencies/es-toolkit.decision.json`。Skill 安装在 `.agents/skills/`，会被支持 Agent Skills 的工具自动发现；让 Agent 走 Skill 的 `probe → audit → record`，不要手写 `fgc.lock.json`。

### 3. 本地构建 Cell 产物

```bash
# 工作目录：examples/consumer-project
pnpm build
```

纯本地，**不连接、不写入**任何活字格工程。产物：

- `examples/consumer-project/.fgc/build/salesOverview.js` —— 自包含 IIFE，CSS 与 `badge.png` 已内联
- `examples/consumer-project/.fgc/build/manifest.json` —— 每个 Cell 的目标、字符数、fingerprint、资源与诊断

产物是报告与检查对象：`sync` 会从源码重新编译，不信任磁盘上某次 build 留下的文件。

### 4. 只读计划：先看会发生什么

```bash
# 工作目录：examples/consumer-project
pnpm plan
pnpm plan -- --port ./mcp-port.mjs
```

- `pnpm plan`：**offline**。编译、审计 lock、解析目标，不联系任何人、不写文件；可在 CI、全新 clone、没有设计器的 Agent 里运行。
- `pnpm plan -- --port ./mcp-port.mjs`：**connected**。读取设计器的前端库清单与每个目标 Cell 的当前内容，给出与真实 `sync` 相同的计划，**仍然不写**。

`mcp-port.mjs` 是**你自己的**端口模块，示例不附带真实设计器连接：默认导出（或命名导出 `port`）一个 `ForguncySyncPort`，含 `listFrontendLibraries`、`readCellSource`、`setCells`、`getProjectSaveStatus`、`saveProject`、`checkProjectErrors`、`generatePageAsync` 七个方法。具体形状见 [`examples/consumer-project/README.md`](examples/consumer-project/README.md)。

### 5. 显式同步：唯一会写的命令

```bash
# 工作目录：examples/consumer-project
pnpm sync -- --port ./mcp-port.mjs
```

`sync` 没有默认端口，必须用 `--port` 指名；缺参数是用法错误，**不会**退化成一次看起来像部署的静默 dry run。流程：重新编译 → 读取清单与目标 → 计划并拒绝冲突 → `setCells` → `saveProject` → 检查项目错误 → `generatePageAsync`，成功时打印可打开的页面 locator。同一份产物再次同步会报告 `unchanged` 且不重复写入 —— 这是正常结果，不是失败。

### 6. 验证边界

```bash
# 工作目录：examples/consumer-project
pnpm plan -- --port ./mcp-port.mjs
```

先确认计划仍是预期的那一个，再打开 `sync` 打印的 locator 看页面。**真正的兼容性验收是 [#107]（已在 `12.0.102.0` 上通过）**，且不继承给后续改动：本地 `vp dev` / `build` / offline `plan` 是 `local` 证据，`record` / probe 是构建输入证据，`plan --port` 与 mock-port `sync` 是流程证据，只有真实页面能证明“活字格接受并正确运行”。

<!-- quickstart:end -->

## 项目配置：`forguncy.config.ts`

一个消费项目只有一个声明文件：

```ts
import { defineForguncyConfig } from "@forguncy-react-workspace/core";

export default defineForguncyConfig({
  runtime: { forguncyVersion: "12.0.102", projectAlias: "consumer-example" },
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

- `cells.<id>.target`：映射到活字格的 `页面名 + 单元格`；`plan` / `sync` 共用同一 registry，两个 Cell 不能声明同一目的地。
- `cells.<id>.entry`：既是 `vp dev` 挂载的文件，也是编译器打包的文件 —— 没有 `.dev.tsx` 孪生文件。
- `cells.<id>.fixture`：只用于本地开发的页面数据 mock。
- `runtime.forguncyVersion`：**记录**的目标版本，不是运行时检查；写在这里不代表已经连上那个版本。
- `extensions.mappings`：**项目自己的**扩展行，不修改内置表；`libraryId` / `globalName` 必须来自真实的 `listFrontendLibraries`。

## 依赖策略

| 策略 | 含义 |
| --- | --- |
| `host` | 由活字格 / ReactCellType 宿主提供，如 React、ReactDOM、antd；宿主桥接在 Node 解析之前接管这些模块名，项目不需要安装 React。 |
| `inline` | 直接打包进当前 Cell 产物；兼容的现代浏览器库默认走这里。 |
| `extension` | 由活字格前端扩展提供；适合需要共享模块身份、跨 Cell 单例/缓存或明确复用的大型依赖。 |
| `replace` | 当前库不适合该运行环境，换一个更现代、更适合浏览器 / ESM 的替代方案，而不是维护永久适配器。 |

`host` / `inline` / `extension` 是三种**可部署**策略，`replace` 是对“这个包不该进入 Cell”的答复。

**workspace 共享源码不是运行时模块。** Cell 可以按名字导入 `@app/consumer-ui` 这样的 workspace 包，编译器会把它的源码**摊平**进每个消费它的 Cell 产物：两个 Cell 各带一份代码，包里的 React Context 只属于那个 Cell，模块级状态是 per-Cell 的；workspace 包不出现在 `frontendLibraries`，也不参与依赖策略决策。因此**跨 Cell 的状态必须交给页面或扩展提供的模块**。

判断顺序是先归属、再选包：能力属于活字格（页面路由、跨 Cell 业务状态、权限、数据源）就交回宿主；只有单元格局部 UI 的能力才进入选型。不要在 Cell 里重建应用路由、第二套全局业务 Store、权限系统或第二份业务数据源。

## CSS 与静态资源：v1 的封闭支持集合

`import "./panel.css"`、`import logo from "./logo.svg"` 在 `vp dev` 与 Cell 产物里**含义相同**：内联进那个自包含脚本，不生成兄弟文件、不猜目录、不暗中请求 CDN。

| 写法 | v1 结论 |
| --- | --- |
| `import "./x.css"`（普通 CSS） | ✅ 注入以样式内容哈希为 key 的 `<style data-forguncy-cell-style="…">` |
| 普通 CSS 指向同级小图片/字体的 `url(…)` | ✅ 重写为 `data:` URI（上限内） |
| `import url from "./x.png"` 等静态资源默认导入 | ✅ 默认导出是 `data:` URI（上限内） |
| `*.module.css`（CSS Modules） | ❌ 明确拒绝：v1 不提供与 Vite 一致的自动作用域实现 |
| CSS `@import` / `image-set()` | ❌ 拒绝：前者是样式级联解析，后者可绕过 `url()` 引用文件 |
| `http:` / `https:` / `//` / 以 `/` 开头的远程或绝对 URL | ❌ 拒绝：产物不能暗中联网，也不知道页面目录 |
| `?raw` / `?url` / `?inline` / `?worker` / `?sharedworker` | ❌ 拒绝：每个 query 都对应一个单文件编译器未实现的 Vite 变换 |
| Worker / `.wasm` / 其它二进制资源 | ❌ 拒绝 |
| 超过内联上限的资源（默认 4096 字节） | ❌ 拒绝，并报告实测字节数与上限 |

拒绝是**结构化诊断**（`rejected-cell-asset`），带 `extension` / `replace` 方向：需要被页面共享、被扩展加载或本来就是二进制的资源放进活字格前端扩展；只是太大或格式不合适，就换一个 v1 能内联的方案。

**选择器不会自动作用域**：普通 CSS 与 Vite 下一样是全局的，请给 Cell 根元素加自己的 class 前缀（示例用 `.sales-overview`）。样式生命周期由产物里的小安装器管理：同一 Cell 重复求值不会追加第二个 `<style>`，两个 Cell 各有自己的 id，卸载一个不会删掉另一个仍在用的样式。

## 证据等级：别把本地绿当成兼容

| 等级 | 来源 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| **Local** | `vp dev`、`pnpm build`、offline `pnpm plan` | 源码能被本地 React 挂载、被编译器打包、资源能内联、lock 与 workspace 图通过本地审计 | 设计器接受源码、页面生命周期、权限、跨 Cell 隔离、扩展加载 |
| **Probe** | `pnpm record`（Skill 的 `probe` / `audit` / `status`） | 已安装包在确定性 probe 下的构建事实；决策记录可复现 | 包在活字格页面上的行为；真实运行时兼容 |
| **Compile / DOM / Mock-port** | `pnpm plan -- --port`、recording-port 的 `pnpm sync`、测试里的 DOM 求值 | 完整同步流程可走通；编译产物在 DOM 中可求值；计划能读取目标并拒绝冲突 | 真实设计器接受了调用；生成页面真的渲染 |
| **Real Forguncy Runtime** | [#107] 的真机 gate：真实设计器 + 生成页面 | 页面/路由/权限/数据/命令/跨 Cell 隔离/扩展身份与加载顺序/页面离开重入 | —— |

CI 只跑前三类；**CI 绿不等于真机兼容**，本地绿也不等于 CI 绿。报告刻意把“本地能编译”和“部署 gate 会扣下什么”分开打印，避免把前者读成后者。

## 常见失败与恢复

先读诊断里的 `code`、`message`、`remediation`、`fixOwner`，再动手；不理解原因时不要用 `force`。不要手写 `fgc.lock.json`、不要手改生成代码、不要为了“先跑起来”把包塞进 `frontendLibraries`。

| 症状 / code | 原因 | 恢复 |
| --- | --- | --- |
| `unresolved-dependency-decision` | 导入的包没有单一可用决策（`host` / `inline` / `extension`），或包未安装 | `pnpm add <package>`；用 Skill 跑 `probe → audit → record`；能力其实属于活字格就删掉导入 |
| `missing-extension-mapping`；同步期 `extension-decision-unusable` / `missing-extension` / `extension-identity-mismatch` | 缺映射行，或页面扩展的 id / global / bundle / types 与映射不符 | 在 `extensions.mappings` 补行（`libraryId` / `globalName` 取自真实 `listFrontendLibraries`）；安装一致版本；不需要共享身份就改判 `inline` / `replace` |
| 记录 `WITHHELD`，`stalenessReasons` 含 `package-version-changed` / `toolchain-changed` / `install-graph-changed` / `forguncy-target-changed` | lock 过期 | 重新 `pnpm record` 并审阅 `fgc-evidence/` 差异。`probe-fingerprint-unknown` 是**本地边界**，不是“已通过” |
| `cell-diverged`（`sync` 报 `refused`） | 目标 Cell 是设计器里的人手修改，直接覆盖会毁掉仓库无法重建的工作 | 先读目标 Cell；改动移回源码再 build/sync，或还原该 Cell。`--overwrite force` 需人明确决定，CLI 没有盲写开关 |
| 重复同步一直 `unchanged` | 目标已持有与当前产物一致的 fingerprint，是成功不是错误 | 核对 `target` 与源码改动（`build` 的 fingerprint 应变化）后重跑 |
| `project-errors-after-sync` / `runtime-generation-failed` / transport failure（带 `stage` / `operation` / `mutationState`） | 写入后保存、检查或生成失败 | 按诊断修项目，**原样重跑** `sync`（已落地写入会识别为 `unchanged`）；读报告的 `mutated` / `uncertain` 判断实际写入状态 |

## 本地开发里的 `extension` 依赖

`extension` 依赖需要共享模块身份或跨 Cell 单例语义，本地解析成本机 npm 包会得到“渲染正确但结论错误”。因此 `vite.config.ts` 必须为每个 `extension` 依赖声明一个分支：

- `substitute`：本地用某个已安装包或项目 shim 替代，并写明理由；
- `real-runtime-only`：承认它只能留给真实运行验证，本地解析到一个**抛出异常**的模块，绝不静默退回 npm 副本。

`vp dev` 启动时会审计这份声明，遇到**未声明**的 `extension` 依赖直接拒绝启动。完整的匹配、过期与本地边界规则见 [`AGENTS.md`](AGENTS.md)。

## 模块别名

短路径别名（如 `import { Button } from "@/ui"`）写在 **`forguncy.config.ts`** 的 `resolve.alias`，不写在 `vite.config.ts`：

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

因为 Cell 产物是自包含 IIFE，生产构建直接驱动 Rolldown，读不到 `vite.config.ts` 里的别名；写在项目配置里，`vp dev` 与 Cell 构建才读同一份对象。别名只支持字符串 key / 字符串目标的**封闭子集**：正则、裸包名目标、绝对路径、项目根、宿主桥接 id（如 `react`）都会明确报错。`vite.config.ts` 可保留本地临时别名，但不能与项目别名重叠，否则 `vp dev` 拒绝启动。

## 仓库协作方式

**Issue-first / PR-first**：设计与技术 Spec 放在 GitHub Issues；实施计划与依赖关系放在 Issues / Epic Issues；代码通过关联 Issue 的 PR 提交；不维护 `specs/`、`plans/` 文档树；未经真实活字格运行验证的能力不宣称兼容；本地检查与真实运行验证分开报告。

Skill 位于 `.agents/skills/`，支持 Agent Skills 的工具会自动发现；本 README 与 [`AGENTS.md`](AGENTS.md) 都不维护重复的 Skill 清单。更多细节见 [`examples/consumer-project/README.md`](examples/consumer-project/README.md)、[`AGENTS.md`](AGENTS.md)、[#3]、[#99]、[#106]、[#107]。
