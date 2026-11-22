/**
 * The Cell's pure business logic, in its own module.
 *
 * Decision source: GitHub Issue #99
 * (https://github.com/MangMax/forguncy-react-workspace/issues/99).
 *
 * A second module rather than an inline literal in `App.tsx`, for a reason that is about the
 * compile rather than about tidiness: `./sales.ts` is a *source file* in the workspace graph
 * (neither an edge to follow nor a dependency to decide), and keeping one beside the two package
 * imports is what makes a compile of this Cell exercise every module kind at once (#14's
 * classification).
 *
 * It is also the file a unit test can hold to account without a React renderer: the self-check
 * below is a claim about the compiled code's behaviour, and a claim is only worth asserting if it
 * can be run against something other than the page.
 *
 * ## What the self-check is, and is not
 *
 * It recomputes a verdict from the rows it was handed. When the page's data source answers, the
 * verdict says whether the rows look like the shape this Cell expects; when it does not, the
 * verdict says the read was unavailable — never "pass", because an absent answer is not a match.
 * Nothing here is a claim about Forguncy: the fixture predicts the same shape locally, and #107 is
 * where a real page confirms it.
 */

import { clamp } from "es-toolkit";

/** One month's sales, as this project's business defines it. */
export interface SalesRow {
  readonly month: string;
  readonly amount: number;
}

/**
 * The rows the Cell renders.
 *
 * Fixed in source rather than read from the page, and that is a deliberate division of labour:
 * *this* Cell's job is to present a period's figures, and a project that wanted the page's live
 * rows would read them through `useDataSource` instead. The example does both — the source read
 * supplies the permission and the fixture's prediction, and these rows are the document — so the
 * compile has a reason to carry the package and the façade without the two fighting.
 */
export const SALES_ROWS: readonly SalesRow[] = [
  { month: "6月", amount: 3120 },
  { month: "5月", amount: 2870 },
  { month: "4月", amount: 2450 },
];

/** What the Cell's self-check concluded, in two pieces a reader can trust separately. */
export interface SalesReport {
  /** `pass` only when there was something to compare and every row agreed with the expected shape. */
  readonly verdict: "pass" | "fail" | "empty";
  readonly summary: string;
}

/**
 * Compare the page's rows against this Cell's own document.
 *
 * `clamp` comes from `es-toolkit`, and it is imported here rather than in `App.tsx` on purpose:
 * the package reaches the artifact through a *pure module*, so the inlined code is exercised by
 * the self-check rather than merely present in a component body that might be tree-shaken.
 */
export function buildSalesReport(rows: readonly unknown[], expected: readonly SalesRow[]): SalesReport {
  const compared = clamp(rows.length, 0, expected.length);

  if (rows.length === 0) {
    return {
      verdict: "empty",
      summary: "数据源未返回行：fixture 未配置或页面尚未提供 Sales。",
    };
  }

  const mismatches = expected.slice(0, compared).filter((row, index) => {
    const actual = rows[index];
    return typeof actual !== "object" || actual === null || !("月份" in (actual as Record<string, unknown>));
  });

  const verdict = mismatches.length === 0 ? "pass" : "fail";
  return {
    verdict,
    summary:
      verdict === "pass"
        ? `自检通过：比较了 ${compared} 行，数据源形状与本 Cell 的预期一致。`
        : `自检未通过：${mismatches.length} / ${compared} 行的形状与本 Cell 的预期不一致。`,
  };
}
