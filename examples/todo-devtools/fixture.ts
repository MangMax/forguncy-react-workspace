/// <reference types="vite/client" />
import {
  createMockDataSource,
  type MockRuntimeFacadeOptions,
} from "@forguncy-react-workspace/runtime";
import { isScenario, previewPath, traceChannel, type Trace } from "./preview.ts";
import type { Commands, Task } from "./todo.ts";

const response = await fetch(previewPath);
const selected: unknown = response.ok ? await response.json() : undefined;
const scenario = isScenario(selected) ? selected : "populated";

const rows: Task[] =
  scenario === "empty"
    ? []
    : [
        { id: "review", title: "审查单元格的属性与事件", done: false },
        { id: "preview", title: "预览同步计划", done: true },
      ];

function record(trace: Trace): void {
  import.meta.hot?.send(traceChannel, trace);
}

const fixture: MockRuntimeFacadeOptions<Commands> = {
  dataSources: { Tasks: createMockDataSource(rows) },
  eventHandlers: {
    onTaskToggle: (id, done) => {
      if (typeof id === "string" && typeof done === "boolean") record({ kind: "event", id, done });
    },
  },
  serverCommands: {
    SaveTask: async ({ id, done }) => {
      const errorCode = scenario === "failure" ? 1 : 0;
      record({ kind: "command", id, done, errorCode });
      return { errorCode, errorMessage: errorCode ? "模拟保存失败，请重试。" : "" };
    },
  },
};

export default fixture;
