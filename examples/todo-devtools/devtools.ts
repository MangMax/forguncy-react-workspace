import type { PluginWithDevTools } from "@vitejs/devtools-kit";
import { moduleNames, type InspectorModule } from "./designer-modules.ts";
import { readDesignerPage, type DesignerPage } from "./designer-reader.ts";
import config from "./forguncy.config.ts";
import { inspectorPanel, views, type InspectorScope, type View } from "./inspector-panel.ts";
import { previewPath, scenarios, traceChannel, type Scenario, type Trace } from "./preview.ts";

export function todoDevTools(
  scope: InspectorScope = {
    pageName: config.cells.todo.target.pageName,
    cells: Object.entries(config.cells),
    demo: true,
  },
): PluginWithDevTools {
  return {
    name: "forguncy-todo-devtools",
    apply: "serve",
    devtools: {
      setup(ctx) {
        const server = ctx.viteServer;
        if (!server) return;

        let scenario: Scenario = "populated";
        const traces: Trace[] = [];
        let view: View = "cells";
        let module: InspectorModule | undefined;
        let selected = scope.cells[0]?.[0] ?? "";
        const designer: { target: string; page?: DesignerPage; status?: string } = {
          target: scope.demo ? process.env.FGC_INSPECTOR_PAGE || scope.pageName : scope.pageName,
        };
        const ui = ctx.createJsonRenderer(
          inspectorPanel(view, selected, scenario, traces, designer, scope),
        );
        const refresh = () =>
          ui.updateSpec(
            inspectorPanel(view, selected, scenario, [...traces], designer, scope, module),
          );
        const register = (id: string, handler: () => void | Promise<void>) => {
          ctx.rpc.register({
            name: `forguncy-todo:${id}`,
            type: "action",
            setup: () => ({ handler }),
          });
        };
        for (const id of Object.keys(views) as View[]) {
          register(`view-${id}`, () => {
            view = id;
            module = undefined;
            refresh();
          });
        }
        for (const [id] of scope.cells) {
          register(`cell-${id}`, () => {
            selected = id;
            module = undefined;
            refresh();
          });
        }
        for (const id of Object.keys(moduleNames) as InspectorModule[]) {
          register(`module-${id}`, () => {
            module = id;
            refresh();
          });
        }
        register("module-back", () => {
          module = undefined;
          refresh();
        });
        let reading = false;
        const refreshDesigner = async () => {
          if (reading) return;
          reading = true;
          designer.page = undefined;
          designer.status = "正在读取设计器…";
          refresh();
          try {
            designer.page = await readDesignerPage(designer.target);
            designer.status = "已读取当前工程";
          } catch {
            designer.status = "读取失败。请确认设计器 MCP 已启动且目标页面存在。";
          } finally {
            reading = false;
            refresh();
          }
        };
        register("read-designer", refreshDesigner);
        ctx.docks.register({
          id: "forguncy-todo",
          title: "Forguncy",
          icon: "ph:list-checks-duotone",
          type: "json-render",
          view: ui.view,
        });
        if (!scope.demo) void refreshDesigner();

        server.middlewares.use(previewPath, (request, response, next) => {
          if (request.method !== "GET") return next();
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Cache-Control", "no-store");
          response.end(JSON.stringify(scenario));
        });
        server.ws.on(traceChannel, (trace: Trace) => {
          if (
            !trace ||
            (trace.kind !== "event" && trace.kind !== "command") ||
            typeof trace.id !== "string" ||
            trace.id.length > 100 ||
            typeof trace.done !== "boolean"
          )
            return;
          const { kind, id, done, errorCode } = trace;
          traces.unshift({
            kind,
            id,
            done,
            ...(typeof errorCode === "number" ? { errorCode } : {}),
          });
          traces.length = Math.min(traces.length, 20);
          if (view === "debug") refresh();
        });
        for (const id of Object.keys(scenarios) as Scenario[]) {
          register(id, () => {
            if (scenario === id) return;
            scenario = id;
            traces.length = 0;
            refresh();
            server.ws.send({ type: "full-reload", path: "*" });
          });
        }
      },
    },
  };
}
