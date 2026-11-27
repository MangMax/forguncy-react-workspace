# TodoList 的 Forguncy DevTools

从仓库根安装依赖后运行：

```sh
cd examples/todo-devtools
vp dev
```

打开终端打印的地址。首次打开 Vite DevTools 时，用终端打印的一次性验证码授权，再从 Dock 打开 **Forguncy**。面板由 Vite DevTools 的 JSON Render 组件渲染。

1. 选择 **有数据**、**空列表** 或 **保存失败**。切换会重新加载本地预览，并重置 Cell 状态和调用记录。
2. 收起 Dock 面板，勾选一项待办，再打开 **Forguncy** 查看事件参数和保存命令返回码。保存失败时勾选状态保持原样。

`App.tsx` 通过现有运行时接口调用数据源、事件和命令。`fixture.ts` 提供模拟结果，`devtools.ts` 负责场景切换和显示最近的调用。场景和记录在本地开发服务器内存中，同一服务器的浏览器标签页共用。

在本目录运行 `pnpm build` 生成单元格产物，`pnpm plan` 查看离线同步计划。实际保存、设计器事件命令和页面联动需要在真实活字格页面验证。
