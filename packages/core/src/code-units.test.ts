/**
 * The code-unit comparator, and the property every ordered output rests on (#155).
 *
 * Decision source: GitHub Issue #155
 * (https://github.com/MangMax/forguncy-react-workspace/issues/155), under the parent spec #152
 * (https://github.com/MangMax/forguncy-react-workspace/issues/152): "a code-unit string
 * comparator" exists once, in a core leaf module, and every ordering that is part of an output
 * uses it.
 *
 * The cases below are chosen so a locale-sensitive comparator fails them: `localeCompare` orders
 * `a` before `A` and `Ä` before `z`, while UTF-16 code units put every upper-case ASCII letter
 * first and place `Ä` after `z`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compareCodeUnits } from "./code-units.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("compareCodeUnits", () => {
  it("orders by UTF-16 code units, never by locale", () => {
    // `localeCompare` would give ["a", "A", "b", "B"] and ["A", "Ä", "z"].
    expect(["b", "A", "a", "B"].sort(compareCodeUnits)).toEqual(["A", "B", "a", "b"]);
    expect(["z", "Ä", "A"].sort(compareCodeUnits)).toEqual(["A", "z", "Ä"]);
  });

  it("reports equality, and orders the empty string first", () => {
    expect(compareCodeUnits("a", "a")).toBe(0);
    expect(compareCodeUnits("", "")).toBe(0);
    expect(compareCodeUnits("", "a")).toBe(-1);
    expect(compareCodeUnits("a", "")).toBe(1);
  });

  it("is a total order: antisymmetric and transitive over a sample", () => {
    const sample = ["", "A", "a", "b", "B", "Ä", "z", "ä", "0", "9"];
    for (const left of sample) {
      for (const right of sample) {
        // `0` rather than `-0`: `-Math.sign(0)` is negative zero, and this is about the sign.
        expect(compareCodeUnits(left, right) + compareCodeUnits(right, left)).toBe(0);
      }
    }
    const sorted = [...sample].sort(compareCodeUnits);
    expect(sorted).toEqual(["", "0", "9", "A", "B", "a", "b", "z", "Ä", "ä"]);
  });

  it("imports nothing, which is why it is a leaf", () => {
    // The leaf has to stay loadable from a browser entry and from `local.ts`, so a single import —
    // of a sibling module, an evidence table or a `node:` builtin — is the property this file
    // exists to keep. "This module has no dependencies" has no runtime observable.
    const source = readFileSync(join(here, "code-units.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/^\s*import\b/m);
  });
});
