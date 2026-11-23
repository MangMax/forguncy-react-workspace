import { describe, expect, it } from "vitest";

import { packageNameOfSpecifier } from "./specifier.ts";

describe("packageNameOfSpecifier", () => {
  it("folds a bare specifier to its package name", () => {
    expect(packageNameOfSpecifier("react")).toBe("react");
    expect(packageNameOfSpecifier("react-dom/client")).toBe("react-dom");
    expect(packageNameOfSpecifier("lodash/fp/get")).toBe("lodash");
  });

  it("folds a scoped specifier to its two-segment package name", () => {
    expect(packageNameOfSpecifier("@scope/ui")).toBe("@scope/ui");
    expect(packageNameOfSpecifier("@scope/ui/button")).toBe("@scope/ui");
    expect(packageNameOfSpecifier("@scope/ui/button/index.js")).toBe("@scope/ui");
  });

  // A path has no package to fold out of it, and inventing one would let a
  // dependency decision match a file. This is the behaviour that differs from the
  // copy `core`'s host-bridge carried, which answered `.` for `./x`.
  it("returns a relative or absolute path unchanged", () => {
    expect(packageNameOfSpecifier("./local")).toBe("./local");
    expect(packageNameOfSpecifier("../shared/thing")).toBe("../shared/thing");
    expect(packageNameOfSpecifier("/absolute/path")).toBe("/absolute/path");
  });

  it("returns a scope-only or empty specifier as itself rather than throwing", () => {
    expect(packageNameOfSpecifier("@scope")).toBe("@scope");
    expect(packageNameOfSpecifier("")).toBe("");
  });
});
