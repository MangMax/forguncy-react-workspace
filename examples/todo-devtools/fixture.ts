/// <reference types="vite/client" />
import {
  createMockDataSource,
  type MockRuntimeFacadeOptions,
} from "@forguncy-react-workspace/runtime";
import {
  isScenario,
  mockSaveError,
  previewPath,
  scenarioTasks,
  traceChannel,
  type Trace,
} from "./preview.ts";
import type { Commands } from "./todo.ts";

const response = await fetch(previewPath);
const selected: unknown = response.ok ? await response.json() : undefined;
const scenario = isScenario(selected) ? selected : "populated";

function record(trace: Trace): void {
  import.meta.hot?.send(traceChannel, trace);
}

const fixture: MockRuntimeFacadeOptions<Commands> = {
  dataSources: { Tasks: createMockDataSource(scenarioTasks(scenario)) },
  eventHandlers: {
    onTaskToggle: (id, done) => {
      if (typeof id === "string" && typeof done === "boolean") record({ kind: "event", id, done });
    },
  },
  serverCommands: {
    SaveTask: async ({ id, done }) => {
      const errorCode = mockSaveError(scenario);
      record({ kind: "command", id, done, errorCode });
      return { errorCode, errorMessage: errorCode ? "模拟保存失败，请重试。" : "" };
    },
  },
};

export default fixture;
