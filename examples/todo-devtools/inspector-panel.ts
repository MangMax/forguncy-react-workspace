import type { JsonRenderSpec } from "@vitejs/devtools/json-render";
import config from "./forguncy.config.ts";
import { mockSaveError, scenarioTasks, scenarios, type Scenario, type Trace } from "./preview.ts";

export const views = { cells: "接管单元格", page: "页面级", debug: "模拟与日志" } as const;
export type View = keyof typeof views;
export const mountedCell = "todo";
const pageName = config.cells[mountedCell].target.pageName;
export const pageCells = Object.entries(config.cells).filter(
  ([, cell]) => cell.target.pageName === pageName,
);

const bindingLabels = {
  dataSources: "数据源",
  permissions: "权限",
  availableServerCommands: "服务端命令",
  properties: "属性",
  eventHandlers: "事件",
  uploadLimit: "上传限制",
  libraries: "前端库",
} as const;

const pageSnapshot = [
  ["页面属性", { activeList: "我的待办" }],
  ["页面事件", { 页面加载: "执行 RefreshTasks" }],
  ["页面命令", { RefreshTasks: "刷新待办数据源" }],
] as const;

export function inspectorPanel(
  view: View,
  selected: string,
  scenario: Scenario,
  traces: readonly Trace[],
): JsonRenderSpec {
  const elements: JsonRenderSpec["elements"] = {
    root: {
      type: "Stack",
      props: { gap: 12, padding: 16 },
      children: ["page-name", "source", "tabs", "body"],
    },
    "page-name": { type: "Text", props: { text: pageName, variant: "heading" } },
    source: { type: "Text", props: { text: "本地预览 · 设计器未连接" } },
    tabs: { type: "Stack", props: { direction: "row", gap: 8, wrap: true }, children: [] },
    body: { type: "Stack", props: { gap: 8 }, children: [] },
  };

  function button(key: string, label: string, active: boolean, action: string) {
    elements[key] = {
      type: "Button",
      props: { label, variant: active ? "primary" : "secondary" },
      on: { press: { action: `forguncy-todo:${action}` } },
    };
  }
  for (const [id, title] of Object.entries(views)) {
    button(`view-${id}`, title, id === view, `view-${id}`);
    elements.tabs.children?.push(`view-${id}`);
  }

  function card(key: string, title: string, value: Record<string, string>, collapsed = false) {
    elements[key] = {
      type: "Card",
      props: { title, collapsible: true, defaultCollapsed: collapsed },
      children: [`${key}-values`],
    };
    elements[`${key}-values`] = { type: "KeyValueTable", props: { data: value } };
    elements.body.children?.push(key);
  }

  if (view === "page") {
    elements["snapshot-note"] = {
      type: "Text",
      props: { text: "虚构样例快照 · 页面级设计器配置待接入" },
    };
    elements.body.children?.push("snapshot-note");
    for (const [title, values] of pageSnapshot) card(title, title, values);
  } else if (view === "cells") {
    elements.cells = {
      type: "Stack",
      props: { direction: "row", gap: 8, wrap: true },
      children: [],
    };
    elements.body.children?.push("cells");
    for (const [id, cell] of pageCells) {
      const key = `cell-${id}`;
      button(key, `${cell.target.cell} · ${id}`, id === selected, key);
      elements.cells.children?.push(key);
    }
    const cell = pageCells.find(([id]) => id === selected)?.[1];
    if (cell) {
      const fixture: Record<string, string> =
        selected === mountedCell
          ? {
              dataSources: `Tasks · ${scenarioTasks(scenario).length} 行`,
              availableServerCommands: `SaveTask · errorCode ${mockSaveError(scenario)}`,
              eventHandlers: "onTaskToggle · 记录 id、done",
            }
          : {};
      const bindings: Record<string, unknown> = cell.bindings ?? {};
      for (const [key, title] of Object.entries(bindingLabels)) {
        const declaration = bindings[key];
        card(
          key,
          title,
          {
            项目声明:
              declaration === undefined ? "未声明 · 由设计器保留" : JSON.stringify(declaration),
            fixture: fixture[key] ?? "未提供",
            设计器: "未连接",
          },
          key !== "dataSources" && key !== "eventHandlers",
        );
      }
    }
  } else {
    elements.scene = { type: "Text", props: { text: `当前场景 · ${scenarios[scenario]}` } };
    elements.actions = {
      type: "Stack",
      props: { direction: "row", gap: 8, wrap: true },
      children: Object.keys(scenarios),
    };
    elements.trace = {
      type: "Card",
      props: { title: "最近的模拟调用" },
      children: ["trace-values"],
    };
    elements["trace-values"] = traces.length
      ? { type: "Tree", props: { data: traces, defaultExpanded: true } }
      : { type: "Text", props: { text: "勾选一项待办后查看事件参数和命令结果。" } };
    elements.body.children?.push("scene", "actions", "trace");
    for (const [id, title] of Object.entries(scenarios)) button(id, title, id === scenario, id);
  }
  return { root: "root", elements };
}
