export const previewPath = "/__forguncy-todo/scenario";
export const traceChannel = "forguncy-todo:trace";
export const scenarios = {
  populated: "有数据",
  empty: "空列表",
  failure: "保存失败",
} as const;

export type Scenario = keyof typeof scenarios;

export function scenarioTasks(scenario: Scenario): Task[] {
  return scenario === "empty"
    ? []
    : [
        { id: "review", title: "审查单元格的属性与事件", done: false },
        { id: "preview", title: "预览同步计划", done: true },
      ];
}

export function mockSaveError(scenario: Scenario): number {
  return scenario === "failure" ? 1 : 0;
}
export function isScenario(value: unknown): value is Scenario {
  return typeof value === "string" && Object.hasOwn(scenarios, value);
}

export interface Trace {
  kind: "event" | "command";
  id: string;
  done: boolean;
  errorCode?: number;
}
import type { Task } from "./todo.ts";
