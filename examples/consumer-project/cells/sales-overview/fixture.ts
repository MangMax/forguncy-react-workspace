/**
 * What `vp dev` installs for this Cell: the page's values, declared as data.
 *
 * Decision source: GitHub Issue #99
 * (https://github.com/MangMax/forguncy-react-workspace/issues/99), consuming #26's
 * `cells.<id>.fixture` and #27's mock-provider contract.
 *
 * ## What a fixture is, and what it must not become
 *
 * It is a *prediction of the page*: every value below stands in for something the designer would
 * configure — the `Sales` data source, the `GetSalesReport` command, the `Orders.Read` permission.
 * It stands in for nothing else, because authored source cannot reach a host global any other way
 * either.
 *
 * It is **not** a second implementation of the Cell. The authored source imports nothing from this
 * file, this file imports nothing from it but a type, and there is no branch in the Cell that could
 * tell whether it is running locally. That is #99's fifth acceptance criterion, and a fixture that
 * leaked into `src/` would be the `.dev` twin by another name.
 *
 * ## What is deliberately absent
 *
 * - **No `ImageContext` or `Forguncy` handle entries.** #5 records both as always-injected base
 *   props and the mock supplies them; restating them here would predict a shape this file has not
 *   measured.
 * - **No stand-in for an unconfigured name.** `GetSalesReport` is declared because the page
 *   declares it. An unconfigured command arrives as `undefined` and the façade turns that into the
 *   named `server-command-not-configured` failure — which is the path worth exercising, not hiding.
 */

import { createMockDataSource } from "@forguncy-react-workspace/runtime";
import type { MockRuntimeFacadeOptions } from "@forguncy-react-workspace/runtime";

import type { CellServerCommands } from "./src/commands.ts";

/**
 * The rows the `Sales` source answers with.
 *
 * Deliberately *not* `SALES_ROWS` from `src/sales.ts`: the page's source returns the business's
 * own columns (`月份`/`销售额`), while the Cell's document is its own projection. Importing the
 * Cell's constant here would make the self-check compare a value against itself and always pass —
 * the fixture would stop predicting anything.
 */
const PAGE_SALES_ROWS = [
  { 月份: "6月", 销售额: 3120 },
  { 月份: "5月", 销售额: 2870 },
  { 月份: "4月", 销售额: 2450 },
];

/**
 * `totalCount` is larger than the rows on hand on purpose: #5 recorded `top: 3` returning three
 * rows while `totalCount` stayed `72`. Paging is the server's, so a mock that shrank the count
 * would teach authored source the wrong thing.
 */
const PAGE_SALES_TOTAL_COUNT = 240;

const options: MockRuntimeFacadeOptions<CellServerCommands> = {
  forguncyMembers: {
    // Both synchronous, because both are synchronous on the host: #5 recorded `hasPermission(…)`
    // → `true` and `getPermissions()` → `{"ProbePermission": true}` with no `await`, unlike the
    // command call recorded beside them. A mock returning promises would be *more* permissive than
    // the target — the one direction a local loop must never lean.
    hasPermission: (permissionName: string) => permissionName === "Orders.Read",
    // `Partial` matches the façade's type and the mock's honesty: one entry per *configured* name,
    // nothing at all for the names this harness did not configure.
    getPermissions: (): Partial<Record<string, boolean>> => ({ "Orders.Read": true }),
  },
  // `props.Permissions` is the snapshot the runtime injects as a base prop: a plain record of
  // configured name to boolean, `{}` when nothing is configured — never absent.
  cellProps: { Permissions: { "Orders.Read": true } },
  serverCommands: {
    GetSalesReport: async payload => ({ errorCode: 0, errorMessage: "OK", payload }),
  },
  dataSources: {
    Sales: createMockDataSource(PAGE_SALES_ROWS, { totalCount: PAGE_SALES_TOTAL_COUNT }),
  },
};

export default options;
