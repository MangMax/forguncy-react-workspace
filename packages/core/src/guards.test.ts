/**
 * The plain-record guard, and the one answer to "is this an object" (#155).
 *
 * Decision source: GitHub Issue #155
 * (https://github.com/MangMax/forguncy-react-workspace/issues/155), under the parent spec #152:
 * "a plain-record type guard" exists once, so config, lock and probe parsing agree on what an
 * object is.
 */

import { describe, expect, it } from "vitest";

import { isPlainRecord } from "./guards.ts";

describe("isPlainRecord", () => {
  it("accepts a non-array object", () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ cells: {} })).toBe(true);
    // A class instance is still a named-field holder; every copy this replaces accepted it.
    expect(isPlainRecord(new (class Row {})())).toBe(true);
  });

  it("refuses arrays, null and every primitive", () => {
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord([{}])).toBe(false);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(undefined)).toBe(false);
    expect(isPlainRecord("cells")).toBe(false);
    expect(isPlainRecord(1)).toBe(false);
    expect(isPlainRecord(true)).toBe(false);
    expect(isPlainRecord(() => {})).toBe(false);
  });

  it("narrows the type, so a caller reads fields without a cast", () => {
    const value: unknown = { cells: 1 };
    if (!isPlainRecord(value)) {
      throw new Error("the guard refused an object literal");
    }
    expect(value["cells"]).toBe(1);
  });
});
