export default {
  runtime: { forguncyVersion: "12.0.102", projectAlias: "todo-devtools" },
  cells: {
    todo: {
      entry: "./App.tsx",
      fixture: "./fixture.ts",
      target: { pageName: "待办事项", cell: "A1" },
      bindings: {
        eventHandlers: [
          { eventName: "onTaskToggle", eventArgs: [{ name: "id" }, { name: "done" }] },
        ],
      },
    },
  },
};
