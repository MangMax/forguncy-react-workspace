/**
 * The canonicaliser factory — one recursive key-ordering walk, parameterised by key order.
 *
 * Decision source: GitHub Issue #155
 * (https://github.com/MangMax/forguncy-react-workspace/issues/155), under the parent spec #152
 * (https://github.com/MangMax/forguncy-react-workspace/issues/152), which records four copies of
 * "canonical JSON": `lock.ts:878`, `probe-protocol.ts:1023`, `probe/fingerprint.ts:44` and
 * `install-identity.ts:216`. Two of them are the same algorithm with a different key order (the
 * lock's and the report's), which is exactly what this factory parameterises; the other two sort
 * keys with no listed order at all, which this factory expresses as an empty key order.
 *
 * The difference between the copies was only ever the listed keys. The rules they share, and which
 * a factory makes impossible to restate differently by accident:
 *
 * - listed keys come first, in the declared order;
 * - anything unlisted follows in code-unit order, so a field added later is deterministic without
 *   an edit here;
 * - the walk is recursive, so a nested record is canonical too;
 * - array order is preserved — arrays are ordered data, and reordering them would change meaning;
 * - a key whose value is `undefined` is dropped rather than serialised, which is what lets an
 *   omitted optional field and an explicit `undefined` produce one document.
 *
 * The rank map is built once, at factory time. The copies compared with `LOCK_KEY_ORDER.indexOf` per
 * comparison, which is O(n) in the key list for every pair sorted; with the lock's ~40 listed keys
 * that is a scan of 40 strings per comparison, and this factory makes it a single map lookup.
 *
 * This is a **leaf** in the sense the parent spec means: it imports nothing outside this module.
 */

import { compareCodeUnits } from "./code-units.ts";
import { isPlainRecord } from "./guards.ts";

/**
 * Builds a canonicaliser for one key order.
 *
 * `keyOrder` lists the keys that read first, in the order they should read; every key it does not
 * name sorts after them by code unit. An empty list is "alphabetical at every depth", which is the
 * shape the fingerprint and install-identity digests ask for.
 */
export function createCanonicalizer(keyOrder: readonly string[]): (value: unknown) => unknown {
  // Precomputed, so comparison never scans the list. A listed key ranks by its position; an
  // unlisted one ranks after every listed key and is then ordered by its own spelling.
  const rank = new Map<string, number>();
  keyOrder.forEach((key, index) => {
    // A duplicate in the order is a mistake in the caller's table rather than a second rank: the
    // first position wins, so the document reads the way the table is written.
    if (!rank.has(key)) {
      rank.set(key, index);
    }
  });
  const unlistedRank = keyOrder.length;

  const rankOf = (key: string): number => rank.get(key) ?? unlistedRank;

  const compareKeys = (a: string, b: string): number => {
    const rankA = rankOf(a);
    const rankB = rankOf(b);
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return compareCodeUnits(a, b);
  };

  const canonicalizeValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonicalizeValue);
    }
    if (isPlainRecord(value)) {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort(compareKeys)) {
        const child = canonicalizeValue(value[key]);
        if (child !== undefined) {
          result[key] = child;
        }
      }
      return result;
    }
    return value;
  };

  return canonicalizeValue;
}
