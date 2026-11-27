import type { JsonRenderSpec } from "@vitejs/devtools/json-render";
import type { CellBindingsConfig } from "../../packages/core/src/browser.ts";
import type { DesignerPage } from "./designer-reader.ts";
import { designerModules, moduleNames, type InspectorModule } from "./designer-modules.ts";
import { mockSaveError, scenarioTasks, scenarios, type Scenario, type Trace } from "./preview.ts";

export const views = {
  cells: "接管单元格",
  page: "页面级",
  debug: "模拟与日志",
  designer: "设计器",
} as const;
export type View = keyof typeof views;
export interface InspectorScope {
  pageName: string;
  cells: readonly [string, { target: { cell: string }; bindings?: CellBindingsConfig }][];
  demo: boolean;
}

const bindingLabels = {
  dataSources: "数据源",
  permissions: "权限",
  availableServerCommands: "服务端命令",
  properties: "属性",
  eventHandlers: "事件",
  uploadLimit: "上传限制",
  libraries: "前端库",
} as const;

function bindingSummary(
  bindings: CellBindingsConfig,
): Record<keyof CellBindingsConfig, string | undefined> {
  const {
    dataSources,
    permissions,
    availableServerCommands,
    properties,
    eventHandlers,
    uploadLimit,
    libraries,
  } = bindings;
  const list = <T>(items: readonly T[] | undefined, describe: (item: T) => string) =>
    items === undefined ? undefined : items.map(describe).join("；") || "清空此项";
  return {
    dataSources: list(dataSources, ({ dataSourceName, dataSource }) => {
      const columns = dataSource.bindingInfos.map(
        ({ columnName, bindingInfo }) =>
          `${columnName} ← ${bindingInfo.tableName}.${bindingInfo.columnName}`,
      );
      return `${dataSourceName}（数据表：${dataSource.tableName}${columns.length ? `，字段：${columns.join("、")}` : ""}）`;
    }),
    permissions: list(
      permissions,
      ({ name, allowRoles }) => `${name}（允许角色：${allowRoles?.join("、") || "无"}）`,
    ),
    availableServerCommands: list(availableServerCommands, ({ name }) => name),
    properties: list(
      properties,
      ({ propertyName, propertyValue, exampleValue }) =>
        `${propertyName}（绑定值：${propertyValue ?? "未绑定"}，示例值：${exampleValue ?? "未设置"}）`,
    ),
    eventHandlers: list(
      eventHandlers,
      ({ eventName, eventArgs }) =>
        `${eventName}（参数：${eventArgs?.map(({ name }) => name).join("、") || "无"}）`,
    ),
    uploadLimit:
      uploadLimit &&
      [
        `文件类型：${uploadLimit.extensionFilter || "未限制"}`,
        `单个文件：${uploadLimit.sizeLimit ? `${uploadLimit.sizeLimit} MB` : "不限大小"}`,
        `单次上传：${uploadLimit.maxUploadFileCount ? `${uploadLimit.maxUploadFileCount} 个` : "不限数量"}`,
      ].join("；"),
    libraries: libraries === "None" ? "不加载预设库" : libraries,
  };
}

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
  designer: { target: string; page?: DesignerPage; status?: string },
  scope: InspectorScope,
  selectedModule?: InspectorModule,
): JsonRenderSpec {
  const { pageName, cells: pageCells, demo } = scope;
  const page = designer.page?.name === pageName ? designer.page : undefined;
  const elements: JsonRenderSpec["elements"] = {
    root: {
      type: "Stack",
      props: { gap: 12, padding: 16 },
      children: ["header", "tabs", "body"],
    },
    header: {
      type: "Stack",
      props: { direction: "row", align: "center", wrap: true, gap: 8 },
      children: ["page-name", "source"],
    },
    "page-name": {
      type: "Text",
      props: { text: view === "designer" ? designer.target : pageName, variant: "heading" },
    },
    source: {
      type: "Text",
      props: {
        text:
          view === "designer"
            ? "活字格设计器 · 只读"
            : page
              ? "本地预览 · 已读取设计器配置"
              : "本地预览",
      },
    },
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
    if (!demo && (id === "debug" || id === "designer")) continue;
    button(`view-${id}`, title, id === view, `view-${id}`);
    elements.tabs.children?.push(`view-${id}`);
  }
  if (!demo && view !== "designer") {
    button("refresh-designer", "刷新设计器配置", false, "read-designer");
    elements.header.children?.push("refresh-designer");
  }
  if (selectedModule) {
    button("module-back", "← 返回模块总览", false, "module-back");
    elements["module-name"] = {
      type: "Text",
      props: { text: moduleNames[selectedModule], variant: "heading" },
    };
    elements.body.children?.push("module-back", "module-name");
  }

  function card(
    key: string,
    title: string,
    value: Record<string, string>,
    collapsed = false,
    parent = "body",
  ) {
    elements[key] = {
      type: "Card",
      props: { title, collapsible: true, defaultCollapsed: collapsed },
      children: [`${key}-values`],
    };
    elements[`${key}-values`] = { type: "KeyValueTable", props: { data: value } };
    elements[parent].children?.push(key);
  }

  if (view === "designer") {
    button("read-designer", "读取设计器", true, "read-designer");
    elements.body.children?.push("read-designer");
    if (designer.status) {
      elements["designer-status"] = { type: "Text", props: { text: designer.status } };
      elements.body.children?.push("designer-status");
    }
    if (designer.page) {
      elements.body.children?.push(
        ...designerModules(elements, "designer-page", undefined, false).page(
          designer.page.settings,
        ),
      );
      for (const cell of designer.page.cells) {
        const key = `designer-${cell.position}`;
        elements[key] = {
          type: "Card",
          props: {
            title: `${cell.position} · React AI 单元格`,
            collapsible: true,
            defaultCollapsed: true,
          },
          children: designerModules(elements, key, undefined, false).cell(cell.capabilities),
        };
        elements.body.children?.push(key);
      }
    }
  } else if (view === "page") {
    if (page) {
      elements.body.children?.push(
        ...designerModules(elements, "page", selectedModule).page(page.settings),
      );
    } else if (!demo) {
      elements["snapshot-note"] = {
        type: "Text",
        props: { text: designer.status ?? "尚未读取设计器配置" },
      };
      elements.body.children?.push("snapshot-note");
    } else {
      elements["snapshot-note"] = {
        type: "Text",
        props: { text: "虚构样例快照" },
      };
      elements.body.children?.push("snapshot-note");
      for (const [title, values] of pageSnapshot) card(title, title, values);
    }
  } else if (view === "cells") {
    elements["cell-layout"] = {
      type: "Stack",
      props: { gap: 12 },
      children: ["cells", "cell-detail"],
    };
    elements.cells = {
      type: "Stack",
      props: { direction: "row", align: "center", wrap: true, gap: 6 },
      children: ["cell-list-title"],
    };
    elements["cell-list-title"] = { type: "Text", props: { text: "单元格" } };
    elements["cell-detail"] = {
      type: "Stack",
      props: { gap: 8 },
      children: [],
    };
    elements.body.children?.push("cell-layout");
    for (const [id, cell] of pageCells) {
      const key = `cell-${id}`;
      if (pageCells.length === 1) {
        elements[key] = {
          type: "Text",
          props: { text: `${cell.target.cell} · ${id}`, variant: "code" },
        };
      } else {
        button(key, `${cell.target.cell} · ${id}`, id === selected, key);
      }
      elements.cells.children?.push(key);
    }
    const cell = pageCells.find(([id]) => id === selected)?.[1];
    if (cell) {
      const fixture: Record<string, string> =
        demo && selected === "todo"
          ? {
              dataSources: `Tasks · ${scenarioTasks(scenario).length} 行`,
              availableServerCommands: `SaveTask · errorCode ${mockSaveError(scenario)}`,
              eventHandlers: "onTaskToggle · 记录 id、done",
            }
          : {};
      const summaries = bindingSummary(cell.bindings ?? {});
      const actual = page?.cells.find((item) => item.position === cell.target.cell)?.capabilities;
      const declared = Object.keys(bindingLabels) as (keyof typeof bindingLabels)[];
      const configured = declared.filter((key) => summaries[key] !== undefined);
      if (actual) {
        elements["binding-source"] = {
          type: "Text",
          props: {
            text: configured.length
              ? `设计器当前值 · ${configured.length} 项另有同步配置`
              : "设计器当前值 · 同步时保留",
          },
        };
        elements["cell-detail"].children?.push(
          "binding-source",
          ...designerModules(elements, "cell", selectedModule).cell(actual),
        );
      } else if (!demo && designer.status) {
        elements["designer-status"] = { type: "Text", props: { text: designer.status } };
        elements["cell-detail"].children?.push("designer-status");
      }
      for (const key of selectedModule ? [] : actual ? configured : declared) {
        card(
          key,
          bindingLabels[key],
          {
            ...(summaries[key] !== undefined ? { 同步配置: summaries[key] } : {}),
            ...(fixture[key] ? { 本地模拟: fixture[key] } : {}),
          },
          key !== "dataSources" && key !== "eventHandlers",
          "cell-detail",
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
