/**
 * Code-unit string comparison — the one ordering rule every deterministic output uses.
 *
 * Decision source: GitHub Issue #155
 * (https://github.com/MangMax/forguncy-react-workspace/issues/155), under the parent spec #152
 * (https://github.com/MangMax/forguncy-react-workspace/issues/152), which records the defect this
 * module removes: the comparator existed in five copies — `core/lock.ts`, `core/probe-protocol.ts`,
 * `cell-compiler/workspace-source.ts`, `dependency-resolver/install-graph.ts` and
 * `dependency-resolver/probe/scan-utils.ts` — and the build manifest sorted with `localeCompare`
 * instead, so one output ordered by the reviewer's locale while every other ordered by code units.
 *
 * Why code units and not `localeCompare`: a locale-sensitive comparison orders the same two strings
 * differently on two machines (`localeCompare` puts `a` before `A`, and `Ä` before `z`), so a lock,
 * a probe report or an artifact sorted with it is not byte-stable across a team. That byte-stability
 * is the whole reason those documents are sorted at all — a diff has to show what changed, not how
 * the reader's locale ranks it.
 *
 * This is a **leaf**: it imports nothing, so it can be loaded from the browser projection, from
 * `local.ts` (which must stay free of a bundler) and from a Node-only module without pulling a graph
 * in with it.
 */

/**
 * Compares two strings by UTF-16 code unit, the same order `<` and `>` use.
 *
 * The negative/zero/positive convention is `Array.prototype.sort`'s, so this is passed to `sort`
 * directly rather than wrapped in a lambda at each call site.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
