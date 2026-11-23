/**
 * The canonicaliser factory, and the two orders it is asked for (#155).
 *
 * Decision source: GitHub Issue #155
 * (https://github.com/MangMax/forguncy-react-workspace/issues/155), under the parent spec #152:
 * "a canonicaliser factory parameterised by key order (with a precomputed rank map, so there is
 * no `indexOf` per comparison)".
 *
 * The lock and the probe report each had a copy of this. The two differ only in their listed
 * keys, which is what makes one factory with a key order the honest shape: the recursive walk,
 * the unlisted-keys-fall-in-alphabetically rule and the `undefined`-is-dropped rule are the same
 * in both.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createCanonicalizer } from "./canonical.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("createCanonicalizer", () => {
  it("puts listed keys first, in the declared order, and unlisted keys after them alphabetically", () => {
    const canonicalize = createCanonicalizer(["second", "first"]);

    expect(canonicalize({ zeta: 1, first: 2, alpha: 3, second: 4 })).toEqual({
      second: 4,
      first: 2,
      alpha: 3,
      zeta: 1,
    });
    expect(Object.keys(canonicalize({ zeta: 1, first: 2, alpha: 3, second: 4 }) as object)).toEqual([
      "second",
      "first",
      "alpha",
      "zeta",
    ]);
  });

  it("orders unlisted keys by code units, not by locale", () => {
    const canonicalize = createCanonicalizer([]);

    expect(Object.keys(canonicalize({ a: 1, A: 2, Ä: 3, z: 4 }) as object)).toEqual(["A", "a", "z", "Ä"]);
  });

  it("is recursive, and preserves array order", () => {
    const canonicalize = createCanonicalizer(["b", "a"]);

    expect(canonicalize({ outer: { a: 1, b: 2 }, list: [{ a: 1, b: 2 }] })).toEqual({
      outer: { b: 2, a: 1 },
      list: [{ b: 2, a: 1 }],
    });
    // Arrays are ordered data; reordering them would change meaning.
    expect(canonicalize({ list: [3, 1, 2] })).toEqual({ list: [3, 1, 2] });
  });

  it("drops an undefined-valued key rather than serialising it", () => {
    const canonicalize = createCanonicalizer(["a"]);

    expect(canonicalize({ a: undefined, b: 1 })).toEqual({ b: 1 });
  });

  it("leaves scalars alone, including null", () => {
    const canonicalize = createCanonicalizer(["a"]);

    expect(canonicalize(null)).toBeNull();
    expect(canonicalize(1)).toBe(1);
    expect(canonicalize("x")).toBe("x");
    expect(canonicalize(true)).toBe(true);
  });

  it("is idempotent, so serialising a serialised document is a no-op", () => {
    const canonicalize = createCanonicalizer(["schemaVersion", "decisions", "packageName"]);

    const once = canonicalize({ decisions: [{ packageName: "b", extra: 1 }, { packageName: "a" }], schemaVersion: 1 });
    expect(canonicalize(once)).toEqual(once);
  });

  it("does not consult a key list at comparison time", () => {
    // The rank map is precomputed, which is the point of the factory: a key order with 40 entries
    // must not cost 40 `indexOf` scans per comparison. Asserted structurally because the cost is
    // not observable in a value.
    const source = readFileSync(join(here, "canonical.ts"), "utf8");
    expect(source).not.toContain("indexOf(");
  });
});
