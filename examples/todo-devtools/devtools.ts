import type { PluginWithDevTools } from "@vitejs/devtools-kit";
import type { JsonRenderSpec } from "@vitejs/devtools/json-render";
import { previewPath, scenarios, traceChannel, type Scenario, type Trace } from "./preview.ts";

function panel(scenario: Scenario, traces: readonly Trace[]): JsonRenderSpec {
  const elements: JsonRenderSpec["elements"] = {
    root: {
      type: "Stack",
      props: { gap: 12, padding: 16 },
      children: ["status", "actions", "trace"],
    },
    status: {
      type: "KeyValueTable",
      props: { data: { Cell: "TodoList · todo", 场景: scenarios[scenario], 环境: "本地 fixture" } },
    },
    actions: {
      type: "Stack",
      props: { direction: "row", gap: 8, wrap: true },
      children: Object.keys(scenarios),
    },
    trace: {
      type: "Card",
      props: { title: "最近的模拟调用" },
      children: [traces.length ? "rows" : "no-calls"],
    },
    "no-calls": { type: "Text", props: { text: "勾选一项待办后，这里会显示调用参数与结果。" } },
    rows: { type: "Tree", props: { data: traces, defaultExpanded: true } },
  };
  for (const id of Object.keys(scenarios) as Scenario[]) {
    elements[id] = {
      type: "Button",
      props: { label: scenarios[id], variant: id === scenario ? "primary" : "secondary" },
      on: { press: { action: `forguncy-todo:${id}` } },
    };
  }
  return { root: "root", elements };
}

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
        const ui = ctx.createJsonRenderer(panel(scenario, traces));
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
          ui.updateSpec(panel(scenario, [...traces]));
        });
        for (const id of Object.keys(scenarios) as Scenario[]) {
          ctx.rpc.register({
            name: `forguncy-todo:${id}`,
            type: "action",
            setup: () => ({
              handler: () => {
                scenario = id;
                traces.length = 0;
                ui.updateSpec(panel(scenario, []));
                server.ws.send({ type: "full-reload", path: "*" });
              },
            }),
          });
        }
      },
    },
  };
}
