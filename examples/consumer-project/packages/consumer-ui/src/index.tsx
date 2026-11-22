/**
 * `@app/consumer-ui` — the shared UI package the consumer example's Cell imports by name.
 *
 * Decision source: GitHub Issue #99
 * (https://github.com/MangMax/forguncy-react-workspace/issues/99), exercising the workspace-source
 * contract merged as #14 (https://github.com/MangX/forguncy-react-workspace/issues/14).
 *
 * This is ordinary React source that happens to live in the same workspace as the Cell consuming
 * it. It imports `react` by name and it never mentions a Cell, a bundler or Forguncy — if
 * flattening required the package to know it was being flattened, the development-stage sharing
 * would not be sharing.
 *
 * Two exports, chosen for what they let the example *show* rather than for completeness: a
 * component that renders real markup, and a pure formatter whose output the Cell displays. A
 * package of constants would render a static string and prove nothing about what was bundled.
 *
 * The stylesheet beside this file is loaded by the Cell rather than by this module, so the v1
 * resource policy (#98) sees one import site and the artifact's style ledger names the cell's own
 * entry. The package stays a pure module graph, which is also what keeps `sideEffects: false`
 * honest.
 */

import { useId, useState } from "react";

import type { ReactNode } from "react";

export interface PanelProps {
  /** The heading shown above the shared content. */
  readonly title: string;
  readonly children: ReactNode;
}

/**
 * A titled panel the Cell renders around its own content.
 *
 * `useState` is here rather than in the Cell so HMR has something inside the *package* to keep:
 * a shared component whose state resets on every edit would make the fast loop look broken for
 * reasons that have nothing to do with the Cell.
 */
export function Panel({ title, children }: PanelProps) {
  const [open, setOpen] = useState(true);
  const titleId = useId();

  return (
    <section className="consumer-panel" aria-labelledby={titleId}>
      <header className="consumer-panel__header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" onClick={() => setOpen(current => !current)} aria-expanded={open}>
          {open ? "收起" : "展开"}
        </button>
      </header>
      {open ? <div className="consumer-panel__body">{children}</div> : null}
    </section>
  );
}

/** The currency symbol table `formatMoney` reads. Deliberately small: this is a business fact. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  CNY: "¥",
  USD: "$",
  EUR: "€",
};

export interface Money {
  readonly currency: string;
  readonly amount: number;
}

/**
 * A money value as a reader expects it: symbol, thousands separators, two decimals.
 *
 * Hand-written rather than delegated to `Intl` for a reason worth stating: `Intl` output depends on
 * the *runtime's* locale data, so the value a compiled artifact renders would differ from the one
 * a developer saw under `vp dev` whenever the two environments resolved different ICU data. A
 * formatter that is a pure function of its argument is what makes the example's self-check a claim
 * about the bundled code.
 *
 * An unknown currency is rendered with its code rather than a guessed symbol — the same
 * "absence is not a value" rule the façade types apply.
 */
export function formatMoney(money: Money): string {
  const symbol = CURRENCY_SYMBOLS[money.currency];
  const negative = money.amount < 0;
  const [whole, fraction = "00"] = Math.abs(money.amount).toFixed(2).split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const amount = `${grouped}.${fraction}`;
  return symbol === undefined ? `${negative ? "-" : ""}${amount} ${money.currency}` : `${negative ? "-" : ""}${symbol}${amount}`;
}
