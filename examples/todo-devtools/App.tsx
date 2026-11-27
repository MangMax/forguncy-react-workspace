import { useState } from "react";
import { runtimeFacade } from "@forguncy-react-workspace/runtime";
import type { Commands, Task } from "./todo.ts";

const facade = runtimeFacade<Commands, never, "onTaskToggle">;

export function App() {
  const host = facade();
  const { data } = host.useDataSource("Tasks");
  const tasks = Array.isArray(data) ? (data as Task[]) : [];
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function toggle(id: string, done: boolean) {
    setPending(true);
    setError("");
    try {
      host.fireEvent("onTaskToggle", id, done);
      const result = await host.invokeServerCommand("SaveTask", { id, done });
      if (result.errorCode === 0) setSaved((previous) => ({ ...previous, [id]: done }));
      else
        setError(
          typeof result.errorMessage === "string" && result.errorMessage
            ? result.errorMessage
            : "保存失败",
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <main
      style={{ maxWidth: 440, margin: "48px auto", padding: "0 16px", fontFamily: "system-ui" }}
    >
      <h1>待办事项</h1>
      {tasks.length === 0 && <p>暂无待办事项</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {tasks.map((task) => (
          <li key={task.id}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
              <input
                type="checkbox"
                checked={saved[task.id] ?? task.done}
                disabled={pending}
                onChange={(event) => void toggle(task.id, event.currentTarget.checked)}
              />
              {task.title}
            </label>
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
