/**
 * The authored half of the server-command read, and the data-source read.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), and
 * - #27 — "Spec: typed Forguncy runtime facade for application-owned capabilities"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/27), which decides every shape
 *   used below.
 *
 * This is a near-copy of `examples/runtime-facade/src/orders.ts`, and the duplication is
 * deliberate rather than an oversight: the two examples answer *different* questions, and
 * merging them would make one file responsible for two claims.
 *
 * - `examples/runtime-facade` proves the façade's *run-time* behaviour under two provider
 *   kinds, executed by `packages/runtime`'s test suite with no React renderer involved.
 * - `examples/dev-harness` proves the *loop*: that this source renders under `vp dev`, that
 *   HMR reaches it, and — #23's acceptance criterion 2 — that the same file compiles into a
 *   Cell artifact with no local-only branch. That claim needs the file to live in a project
 *   the compiler can be pointed at, with a real `forguncy.config.ts` and a real fixture.
 *
 * The shared part is the *shape* rather than the text, and the shape is #27's: a command map
 * declared here because #5 pinned that a Cell's `ServerCommands` record carries only the names
 * the designer listed and not what any command takes, so the parameter knowledge is this
 * project's claim, written once.
 */

import { runtimeFacade } from "@forguncy-react-workspace/runtime";

/**
 * The commands this Cell's page makes available.
 *
 * The one executed call #5 records is `await props.ServerCommands.GetSalesData({})`, so the
 * single object argument below is a shape that was *observed* rather than one that reads well.
 */
export type AppServerCommands = {
  readonly GetSalesData: [payload: Readonly<Record<string, unknown>>];
};

export interface OrdersSummary {
  readonly rows: readonly unknown[];
  /** The server-side count, which stays put while the page size limits rows. */
  readonly totalCount: unknown;
  readonly error: unknown;
}

/**
 * The Cell's read of the page's data source.
 *
 * Named `use…` because it calls the confirmed hook: in a real Cell this runs during render,
 * which is the only place `useDataSource` is legal. Nothing here caches or reshapes the
 * result — a Cell-side cache would be the second data layer #27's non-goals forbid.
 */
export function useOrdersSummary(top = 3): OrdersSummary {
  const sales = runtimeFacade().useDataSource("Sales", { top });
  return {
    rows: Array.isArray(sales.data) ? sales.data : [],
    totalCount: sales.totalCount,
    error: sales.error,
  };
}

export interface OrdersRefresh {
  readonly errorCode: unknown;
  readonly errorMessage: unknown;
  /** The command's own named returns arrive beside the reserved keys. */
  readonly result: Readonly<Record<string, unknown>>;
}

/**
 * Invoke the page's server command.
 *
 * No `TypeError` for an unconfigured name and no prop plumbing: the façade reports a command
 * the page did not configure as a named failure (`server-command-not-configured`), which is
 * what makes this call safe to write without knowing the page configuration — and what makes
 * the *fixture* the only thing deciding whether it works locally.
 */
export async function refreshOrders(payload: Readonly<Record<string, unknown>> = {}): Promise<OrdersRefresh> {
  const result = await runtimeFacade<AppServerCommands>().invokeServerCommand("GetSalesData", payload);
  return {
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    result: result as Readonly<Record<string, unknown>>,
  };
}

/**
 * Ask the host whether the current user holds the permission this Cell needs.
 *
 * Synchronous, and it declares nothing: #5 executed the call
 * (`props.Forguncy.hasPermission("ProbePermission")` → `true`) and did not await it, while
 * awaiting the `ServerCommands` call recorded beside it — so the call shape is confirmed and
 * the façade types it. The one case #5 never ran is a *denied* permission, so `false` here is
 * what the return type claims rather than something that was observed.
 */
export function canReadOrders(): boolean {
  return runtimeFacade().hasPermission("Orders.Read");
}

/**
 * Every configured permission's boolean, through the host's own handle.
 *
 * The `Partial` is not stylistic. #5 recorded one boolean per *configured* permission — the
 * page confirmed that an unconfigured name is simply not a key — not a boolean at every
 * possible key. Declaring a plain `Record<string, boolean>` compiles happily here because this
 * repository leaves `noUncheckedIndexedAccess` off, so an unconfigured name would type as
 * `boolean` and read `undefined` on a real page. Keeping the type `Partial` keeps that absence
 * in the type, where the compiler can still catch it.
 */
export function readOrderPermissions(): Readonly<Partial<Record<string, boolean>>> {
  return runtimeFacade().getPermissions();
}

/**
 * The Cell's declared bindings, **projected from the config** rather than written twice.
 *
 * `forguncy.config.ts` declares the same names in `cells.salesSummary.bindings` — and #178's
 * contract is that the two are *one* declaration. Projecting off `typeof config` is what
 * keeps them that way: adding a property to the config adds it to this union in the same
 * edit, and removing one breaks this file at compile time rather than letting the facade
 * admit a binding the deployment no longer writes. `cellProperty` and `fireEvent` take
 * these as their type arguments — `never` by default, so an undeclared name is un-callable,
 * which is the same discipline the command map already follows.
 */
import type config from "../../forguncy.config.ts";

type DeclaredBindings = (typeof config)["cells"]["salesSummary"]["bindings"];
export type AppCellBindings = {
  readonly properties: NonNullable<DeclaredBindings>["properties"] extends readonly { readonly propertyName: infer Name }[] ? Name : never;
  readonly events: NonNullable<DeclaredBindings>["eventHandlers"] extends readonly { readonly eventName: infer Name }[] ? Name : never;
};

/** The façade typed for this Cell's commands *and* its declared bindings. */
function cellFacade() {
  return runtimeFacade<AppServerCommands, AppCellBindings["properties"], AppCellBindings["events"]>();
}

/**
 * The current value of the declared `title` property.
 *
 * Read during render rather than captured: #176 measured `SetPropertyValue` re-rendering
 * the existing tree **without re-executing the cell entry**, so a property read inside
 * the component body is already the reactive half of the binding — there is no
 * subscription to write, and writing one would be the façade inventing a lifecycle the
 * host does not have.
 */
export function readTitle(): string {
  return cellFacade().cellProperty<string>("title");
}

/** The declared `highlightColor`, converted through the host's own colour conversion. */
export function readHighlightColor(): string {
  const raw = cellFacade().cellProperty<string>("highlightColor");
  return runtimeFacade().convertToCssColor(raw);
}

/**
 * Fire the declared events.
 *
 * `onExport` is the uncommanded demonstration — the designer attached no command tree,
 * so the firing is a no-op locally exactly as it is in the designer preview. `onRowSelect`
 * carries the gathered positional arguments, which the host would key by `eventArgs[].name`
 * before handing them to the configured command.
 */
export function fireExport(): void {
  cellFacade().fireEvent("onExport");
}

export function fireRowSelect(rowKey: string, index: number): void {
  cellFacade().fireEvent("onRowSelect", rowKey, index);
}

/** The signed-in user the host resolved — synchronous, so there is nothing to await. */
export function readCurrentUser(): { readonly UserName?: string; readonly Role?: string } {
  return runtimeFacade().getCurrentUser();
}

/** The host's upload limit, `sizeLimit` in megabytes with `0` meaning unlimited. */
export function readUploadLimit(): { readonly extensionFilter: string; readonly sizeLimit: number; readonly maxUploadFileCount: number } {
  const limit = runtimeFacade().getUploadLimit();
  return {
    extensionFilter: limit.extensionFilter,
    sizeLimit: limit.sizeLimit,
    maxUploadFileCount: limit.maxUploadFileCount,
  };
}

/**
 * Upload through the host — the one genuinely asynchronous member.
 *
 * The result's `attachmentValue` is the pipe-separated trailing-pipe form the host
 * persists, so the Cell surfaces it verbatim rather than reshaping it: reshaping is
 * the application-layer decision, and a cell doing it silently would drift from what
 * the host writes into a bound attachment column.
 */
export async function uploadSalesEvidence(files: Parameters<ReturnType<typeof runtimeFacade>["uploadFiles"]>[0]): Promise<{
  readonly fileNames: readonly string[];
  readonly attachmentValue: string;
}> {
  const result = await runtimeFacade().uploadFiles(files);
  return {
    fileNames: result.files.map(file => file.fileName),
    attachmentValue: result.attachmentValue,
  };
}

/**
 * Register the Cell's exposed method at module scope.
 *
 * `exposeMethod` is the registration half of the host's command pipeline: a configured
 * Forguncy command reaches the cell through `ExecuteMethod`, and this is what it reaches.
 * Module scope rather than render scope because the registration is not a render effect —
 * re-registering on every render would be noise the host's overwrite-wins semantics
 * tolerate but the cell never needs.
 */
let methodExposed = false;
export function exposeSalesMethodOnce(): void {
  if (methodExposed) {
    return;
  }
  methodExposed = true;
  runtimeFacade().exposeMethod("getSalesSummary", () => ({
    totalCount: SALES_TOTAL_COUNT_HINT,
    exposedBy: "sales-summary",
  }));
}

/** The count the exposed method reports, mirroring the fixture's server-side total. */
const SALES_TOTAL_COUNT_HINT = 240;
