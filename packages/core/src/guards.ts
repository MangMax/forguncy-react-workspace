/**
 * The plain-record guard — one answer to "is this a named-field holder".
 *
 * Decision source: GitHub Issue #155
 * (https://github.com/MangMax/forguncy-react-workspace/issues/155), under the parent spec #152
 * (https://github.com/MangMax/forguncy-react-workspace/issues/152), which records five copies of
 * this predicate: `isPlainObject` in `core/lock.ts` and `core/probe-protocol.ts`; `isConfigRecord`
 * in `core/forguncy-config.ts`; `isConfigRecordValue` in
 * `core/resolve-config.ts`; `isRecord` in `cell-compiler/workspace-graph.ts`; and `asPlainObject` in
 * `dependency-resolver/install-identity.ts`. They agree today, and a parser that disagreed about
 * what an object is would accept a document another parser refuses — the drift this module makes
 * impossible.
 *
 * The definition is deliberately the widest one all the copies shared: a non-array object. A class
 * instance passes, because every copy accepted it and a config record has no reason to refuse one;
 * what is excluded is the two shapes that are not named-field holders — `null` (which `typeof`
 * reports as an object) and an array (which holds positions rather than names).
 *
 * This is a **leaf**: it imports nothing.
 */

/** True when `value` is a non-array object, i.e. something that can hold named fields. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
