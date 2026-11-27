export const previewPath = "/__forguncy-todo/scenario";
export const traceChannel = "forguncy-todo:trace";
export const scenarios = {
  populated: "有数据",
  empty: "空列表",
  failure: "保存失败",
} as const;

export type Scenario = keyof typeof scenarios;
export function isScenario(value: unknown): value is Scenario {
  return typeof value === "string" && Object.hasOwn(scenarios, value);
}

export interface Trace {
  kind: "event" | "command";
  id: string;
  done: boolean;
  errorCode?: number;
}
