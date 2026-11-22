/**
 * The server commands this Cell's *page* makes available.
 *
 * Decision source: GitHub Issue #99
 * (https://github.com/MangMax/forguncy-react-workspace/issues/99), following #27's façade
 * contract and #5's observation that a Cell's `ServerCommands` record carries only the names the
 * designer listed and not what any command takes.
 *
 * So the parameter knowledge is this project's claim, written once: a command the project forgot
 * to declare is not callable at all, and one the page did not configure arrives through the façade
 * as a named failure (`server-command-not-configured`) rather than a `TypeError`.
 *
 * A separate module rather than a type beside the component, because the *fixture* has to declare
 * the same command map — and both reading one declaration is what keeps the local prediction and
 * the authorship from drifting.
 */

export type CellServerCommands = {
  /** `await props.ServerCommands.GetSalesReport({ top })` — the shape #5 recorded, with a payload. */
  readonly GetSalesReport: [payload: Readonly<{ top: number }>];
};
