/**
 * The consumer example's Cell, as an ordinary business author writes it.
 *
 * Decision source: GitHub Issue #99
 * (https://github.com/MangMax/forguncy-react-workspace/issues/99).
 *
 * ## The five things this file exercises, and where each one is decided
 *
 * | what the Cell does | who owns it |
 * | --- | --- |
 * | `import { Panel, formatMoney } from "@app/consumer-ui"` | workspace source, flattened (#14) |
 * | `import { clamp, sumBy } from "es-toolkit"` | an installed ESM package decided `inline` (#10) |
 * | `runtimeFacade().useDataSource("Sales", …)` | the page's data source, through the façade (#27/#82) |
 * | `runtimeFacade().hasPermission(…)` / `.invokeServerCommand(…)` | the page's permissions and commands |
 * | `import "./cell.css"` and `import badgeUrl from "./badge.png"` | the v1 resource pipeline (#98) |
 *
 * The project-declared extension row lives in `forguncy.config.ts` (`extensions.mappings`) and is
 * deliberately **not** imported here: a package mapped to an `extension` needs a recorded
 * `extension` decision *and* the real extension on the page, and this example has neither. What this project exercises is the consumer half — the row is normalized by the
 * registry, reported by the build, and handed to the sync's extension audit. The compile-and-sync
 * half lives in `examples/extension-custom`, where a Cell really imports a mapped package; keeping
 * them apart is what stops this example claiming an extension exists.
 *
 * ## What is deliberately absent
 *
 * No `props`, no `globalThis`, no `import.meta.env`, no `if (DEV)`, and no `.dev.tsx` twin. The
 * same file is what `vp dev` mounts and what the compiler bundles, which is #99's fifth acceptance
 * criterion, and it can be the same file only because every host value arrives through the façade
 * and every dependency resolves the same way in both environments.
 *
 * The stylesheet and the image are imported exactly as a browser project imports them (#98): the
 * compiler inlines both into the artifact, and `vp dev` serves the same two files through the same
 * closed support set — so a local render cannot pass an import the artifact would refuse.
 *
 * ## What this file does not establish
 *
 * That the page has a `Sales` source, that the extension exists, or that anything renders in
 * Forguncy. Those are #107's gate, on a real designer. The example's fixture predicts them for
 * local development, and its self-check verdicts are claims about the *compiled code* rather than
 * about the host.
 */

import { Panel, formatMoney } from "@app/consumer-ui";
import type { Money } from "@app/consumer-ui";
import { clamp, sumBy } from "es-toolkit";
import { useState } from "react";

import { runtimeFacade } from "@forguncy-react-workspace/runtime";

import type { CellServerCommands } from "./commands.ts";
import { buildSalesReport, SALES_ROWS } from "./sales.ts";
import "./cell.css";
import badgeUrl from "./badge.png";

export function App() {
  const [clicks, setClicks] = useState(0);

  // The page's data source, read the way #5 recorded the wrapper working. Nothing is cached or
  // reshaped here: a Cell-side cache would be the second data layer #27 forbids.
  const sales = runtimeFacade().useDataSource("Sales", { top: 3 });
  const rows = Array.isArray(sales.data) ? sales.data : [];

  // Synchronous on the host (#5 recorded `hasPermission(...)` → `true` with no `await`), so the
  // façade types it that way and a mock that returned a promise would be *more* permissive than
  // the target — the one direction a local loop must never lean.
  const mayRead = runtimeFacade().hasPermission("Orders.Read");
  const report = buildSalesReport(rows, SALES_ROWS);

  // Computed through `es-toolkit` so the artifact cannot be correct without the inlined package.
  const total = sumBy(SALES_ROWS, row => row.amount);
  const closed = clamp(rows.length, 0, SALES_ROWS.length);

  const totalMoney: Money = { currency: "CNY", amount: total };

  return (
    <Panel title="本月销售概览">
      <section className="sales-overview">
        <img className="sales-badge" alt="" src={badgeUrl} width={48} height={48} />

        {mayRead ? null : (
          <p role="alert" className="sales-alert">
            当前用户没有 Orders.Read 权限。
          </p>
        )}

        <p className="sales-total" data-sales-total={totalMoney.amount}>
          本月合计 <strong>{formatMoney(totalMoney)}</strong>
          <small>
            （已展示 {closed} / {SALES_ROWS.length} 条）
          </small>
        </p>

        <output className="sales-self-check" data-consumer-self-check={report.verdict}>
          {report.summary}
        </output>

        <ul className="sales-rows">
          {SALES_ROWS.map(row => (
            <li key={row.month}>
              {row.month}：<code>{formatMoney({ currency: "CNY", amount: row.amount })}</code>
            </li>
          ))}
        </ul>

        <footer className="sales-actions">
          <button type="button" onClick={() => setClicks(count => count + 1)}>
            交互计数 {clicks}
          </button>
          <ExportButton />
        </footer>
      </section>
    </Panel>
  );
}

/**
 * A command invocation from a handler.
 *
 * Note what is absent: no `props`, no host detection and no `ServerCommands` lookup. A command the
 * page did not configure arrives as a named failure (`server-command-not-configured`), which is
 * what makes this safe to write without knowing the page's configuration — and what makes the
 * fixture's `GetSalesReport` the only thing that decides whether this button works locally.
 */
function ExportButton() {
  return (
    <button
      type="button"
      onClick={() => {
        void runtimeFacade<CellServerCommands>()
          .invokeServerCommand("GetSalesReport", { top: 3 })
          .catch(error => {
            // Left to the console rather than swallowed into state: the local-dev contract records
            // that the loop must let a failure be loud, and a `catch` that rendered a fallback
            // would be the swallowed-error pattern by another name.
            console.error(error);
          });
      }}
    >
      导出报表
    </button>
  );
}
