import type { PluginWithDevTools } from "@vitejs/devtools-kit";
import { readDesignerPage, type DesignerPage } from "./designer-reader.ts";
import { inspectorPanel, mountedCell, pageCells, views, type View } from "./inspector-panel.ts";
import { previewPath, scenarios, traceChannel, type Scenario, type Trace } from "./preview.ts";

export function todoDevTools(): PluginWithDevTools {
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
        let selected = mountedCell;
        const designer: { target: string; page?: DesignerPage; status?: string } = {
          target: process.env.FGC_INSPECTOR_PAGE || "待办事项",
        };
        const ui = ctx.createJsonRenderer(
          inspectorPanel(view, selected, scenario, traces, designer),
        );
        const refresh = () =>
          ui.updateSpec(inspectorPanel(view, selected, scenario, [...traces], designer));
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
            refresh();
          });
        }
        for (const [id] of pageCells) {
          register(`cell-${id}`, () => {
            selected = id;
            refresh();
          });
        }
        let reading = false;
        register("read-designer", async () => {
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
        });
        ctx.docks.register({
          id: "forguncy-todo",
          title: "Forguncy",
          icon: "ph:list-checks-duotone",
          type: "json-render",
          view: ui.view,
        });

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
