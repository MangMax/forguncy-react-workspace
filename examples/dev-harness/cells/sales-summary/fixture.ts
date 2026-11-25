/**
 * What the dev harness installs for this Cell: the page's values, declared as data.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose plan step 3 is
 *   this file's subject ("support example/project-provided mock props and `ServerCommands`
 *   implementations"), and
 * - #26 — "Spec: project configuration and React Cell target declarations"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/26), which declares
 *   `cells.<id>.fixture` as the project-relative local-dev entry.
 *
 * ## What a fixture is
 *
 * A *prediction of the page*. Every value below stands in for something the page would have
 * configured — the `Sales` data source, the `GetSalesData` command, the `Orders.Read`
 * permission — and nothing stands in for a host global, because authored source cannot reach
 * one any other way either. `runtime`'s `cell-fixture.ts` owns the shape and refuses the rest:
 * a misspelt field is a `fixture-unknown-field` failure rather than a value that is silently
 * ignored, and a non-function where a call belongs is `fixture-invalid-field`. Neither is
 * restated here.
 *
 * ## What is deliberately *not* here
 *
 * - **No `ImageContext` and no `Forguncy` handle entries.** #5 records both as always-injected
 *   base props, and the mock supplies the two empty objects and the member handle itself. A
 *   fixture that restated them would be predicting a host shape this file has no evidence for.
 * - **No stand-in for an unconfigured name.** `GetSalesData` is declared because the page
 *   declares it. Nothing declares a command it does not have, because an unconfigured name
 *   arriving as `undefined` is what #5 records, and the façade is where that becomes the named
 *   `server-command-not-configured` failure. A fixture that pre-empted it would remove the
 *   example's own demonstration of that path.
 */

import { createMockDataSource } from "@forguncy-react-workspace/runtime";
import type { MockRuntimeFacadeOptions } from "@forguncy-react-workspace/runtime";

import type { AppServerCommands } from "./src/orders.ts";

/**
 * The rows the `Sales` source answers with.
 *
 * The shape is this example's business, not the host's — #5 pins that a data-source result
 * carries `totalCount` and `error`, never what a page puts in `data`.
 */
const SALES_ROWS = [
  { 月份: "6月", 销售额: 3120 },
  { 月份: "5月", 销售额: 2870 },
  { 月份: "4月", 销售额: 2450 },
];

/**
 * `totalCount` is deliberately larger than the rows on hand, mirroring #5's observation that
 * `top: 3` returned three rows while `totalCount` stayed `72`: paging is the server's, so a
 * mock that shrank the count would teach authored source the wrong thing.
 */
const SALES_TOTAL_COUNT = 240;

const options: MockRuntimeFacadeOptions<AppServerCommands> = {
  // `hasPermission`/`getPermissions` are deliberately **not** overridden: since #177 the
  // mock's own defaults reproduce the measured semantics — they read the snapshot
  // `cellProps.Permissions` carries below, synchronously, which is exactly what this
  // fixture used to hand-write. What the fixture still owns is the snapshot itself,
  // because which permissions the page configured is the page's claim, not the mock's.
  cellProps: { Permissions: { "Orders.Read": true } },
  // Declared properties land on `props` under their own names — the host's injection for
  // `properties[].propertyName`. `title` is the bidirectional half the example exercises:
  // the Cell reads it through `cellProperty` and the harness can push a new value through
  // `SetPropertyValue`'s local equivalent (re-render with fresh props), mirroring the
  // measured re-render-without-re-execute semantics.
  properties: {
    title: "本月销售",
    highlightColor: "#80FF0000",
  },
  // `onExport` has no handler on purpose: it demonstrates the uncommanded event — the
  // firing function exists and is a no-op, which is what the designer preview produces
  // for an event with no command tree attached. `onRowSelect` carries one so the firing
  // is observable in the harness console, the local stand-in for the host's command
  // pipeline receiving the gathered arguments.
  eventHandlers: {
    onExport: undefined,
    onRowSelect: (...args: readonly unknown[]) => {
      console.log("[fixture] onRowSelect fired with gathered args:", ...args);
    },
  },
  serverCommands: {
    GetSalesData: async payload => ({ errorCode: 0, errorMessage: "OK", payload }),
  },
  dataSources: {
    Sales: createMockDataSource(SALES_ROWS, { totalCount: SALES_TOTAL_COUNT }),
  },
};

export default options;
