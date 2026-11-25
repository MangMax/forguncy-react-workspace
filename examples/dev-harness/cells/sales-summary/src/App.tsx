/**
 * A Cell, as a component author writes it — and the source that both `vp dev` and the
 * Cell compiler consume, which is #23's acceptance criterion 2 ("the same source compiles
 * for Forguncy without local-only branches in application code").
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose plan step 7 asks
 *   for "at least one example where the same source is used both by `vp dev` and by Cell
 *   compiler output", and
 * - #27 — "Spec: typed Forguncy runtime facade for application-owned capabilities"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/27), which decides *how* it
 *   manages that: every host value arrives through the façade, so there is nothing here for
 *   a local-only branch to switch on.
 *
 * ## The three rules this file follows, and why each one is load-bearing
 *
 * 1. **No `props` and no host branch.** Nothing reads `globalThis`, nothing asks whether it
 *    is running on Forguncy, and `props` is never threaded down. `RUNTIME_FACADE_FORBIDDEN_PATTERNS`
 *    names all three, and `local-only-source-branch` is the one that would silently make the
 *    local loop a *second* implementation: the branch that only runs locally is the branch
 *    that never runs on the page.
 * 2. **No local-only module.** There is no `.dev.tsx` twin and no harness wrapper around this
 *    component. The harness mounts *this* file — the compiler inlines *this* file — and
 *    the local-dev contract's `second-local-component` rule records why a twin is worse than
 *    a branch: it keeps looking right while it drifts.
 * 3. **The imports are the ordinary ones.** `react` is imported by name. On the page, #9's
 *    host bridge binds that specifier to the page's React object; under `vp dev`, the harness
 *    resolves the same specifier to its own pinned copy of the same version. Neither is
 *    visible from here, which is the entire point.
 *
 * ## HMR is observable here on purpose
 *
 * `useState` is used for something a developer can actually watch survive an edit: the click
 * count stays put across a React Fast Refresh pass. That is what makes "HMR works" checkable
 * by hand rather than taken on faith — a full page reload resets it to zero, Fast Refresh does
 * not. It is also a real answer to a real question, because React state surviving an edit is
 * only possible if the module graph and the host React substitution are wired the way this
 * example claims.
 */

import { useState } from "react";

import {
  canReadOrders,
  exposeSalesMethodOnce,
  fireExport,
  fireRowSelect,
  readCurrentUser,
  readHighlightColor,
  readOrderPermissions,
  readTitle,
  readUploadLimit,
  refreshOrders,
  uploadSalesEvidence,
  useOrdersSummary,
} from "./orders.ts";

export function App() {
  // Survives a Fast Refresh pass, resets on a full reload — see the file docstring.
  const [clicks, setClicks] = useState(0);
  const [uploadState, setUploadState] = useState("未上传");

  // The exposed method is registered once per module evaluation — see `orders.ts` for why
  // this is not a render effect. Called here rather than at module top level because the
  // façade's provider is installed before the first render and module evaluation order
  // under the harness does not guarantee that.
  exposeSalesMethodOnce();

  const summary = useOrdersSummary(3);
  // Synchronous, because #5 recorded these as synchronous calls: `hasPermission(...)` →
  // `true` and `getPermissions()` → `{"ProbePermission": true}` with no `await`. A harness
  // that made them promises would be *more* permissive than the target and would teach
  // authored source to await something that is not a promise.
  const mayRead = canReadOrders();
  const permissions = readOrderPermissions();

  // The bidirectional bindings #177 types. `readTitle()` is read during render, which *is*
  // the reactive half: the host's `SetPropertyValue` re-renders this tree without
  // re-executing the entry, so the render-time read sees the current value — locally the
  // harness re-render plays the same role.
  const title = readTitle();
  const highlight = readHighlightColor();
  const user = readCurrentUser();
  const uploadLimit = readUploadLimit();

  return (
    <section data-dev-harness="sales-summary">
      {/* The property value arrives through `cellProperty` — the binding is the point, so
          the literal is the fixture's initial value rather than a hard-coded string. */}
      <h2 style={{ color: highlight }}>{title}（本月销售）</h2>

      <p>
        当前用户：{user.UserName ?? "（未登录）"}（{user.Role ?? "无角色"}）
      </p>

      {mayRead ? null : <p role="alert">当前用户没有 Orders.Read 权限。</p>}

      {summary.error ? (
        <p role="alert">销售数据不可用：{String(summary.error)}</p>
      ) : (
        <ul>
          {summary.rows.map((row, index) => (
            // `key` by index on purpose: the rows are a flat projection of whatever the page's
            // data source returned and carry no stable identity in authored source. This is the
            // one place a keyed list exists in the example, so it is also where a JSX-runtime
            // mistake would surface locally — #22 records that the local loop resolves the
            // *published* JSX runtime, never #9's generated adapter, which is exactly why a
            // green render here says nothing about the adapter.
            <li key={index}>
              <button type="button" onClick={() => fireRowSelect(JSON.stringify(row), index)}>
                {JSON.stringify(row)}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p>
        权限：
        {Object.entries(permissions)
          .map(([name, granted]) => `${name}=${granted}`)
          .join("、")}
      </p>

      <p>
        上传限制：{uploadLimit.extensionFilter}，单文件 {uploadLimit.sizeLimit === 0 ? "不限" : `${uploadLimit.sizeLimit} MB`}，
        单次 {uploadLimit.maxUploadFileCount === 0 ? "不限" : `${uploadLimit.maxUploadFileCount} 个`}
      </p>

      <p>
        <button type="button" onClick={() => setClicks(count => count + 1)}>
          交互计数 {clicks}
        </button>{" "}
        <button type="button" onClick={() => fireExport()}>
          触发 onExport（无命令）
        </button>{" "}
        <button
          type="button"
          onClick={() => {
            const file = new File(["probe"], "销售凭证.txt", { type: "text/plain" });
            void uploadSalesEvidence(file)
              .then(result => setUploadState(`已上传：${result.fileNames.join("、")}（${result.attachmentValue}）`))
              .catch(error => {
                console.error(error);
              });
          }}
        >
          上传凭证
        </button>
      </p>

      <p>上传状态：{uploadState}</p>

      <ExportButton />
    </section>
  );
}

/**
 * A command invocation from a handler.
 *
 * Note what is absent: no `props`, no host detection, no `ServerCommands` lookup. A command
 * the page did not configure arrives as a named failure
 * (`server-command-not-configured`), which is what makes this safe to write without knowing
 * the page's configuration — and what makes the fixture's `GetSalesData` the only thing that
 * decides whether this button works locally.
 */
function ExportButton() {
  return (
    <button
      type="button"
      onClick={() => {
        void refreshOrders({ top: 3 }).catch(error => {
          // Left to the console rather than swallowed into state: the local-dev error-surfacing contract
          // records that the local loop must let a failure be loud, and a `catch` that rendered
          // a fallback would be the swallowed-error pattern by another name.
          console.error(error);
        });
      }}
    >
      导出
    </button>
  );
}
