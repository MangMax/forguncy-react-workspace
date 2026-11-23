/**
 * Scan utilities: ANSI stripping, portability and deterministic walks.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Spec: #16 — `PROBE_REPORT_MACHINE_READABILITY`: identical inputs
 * produce identical bytes, and a report must survive being read on another
 * machine (no absolute paths, no ANSI paint).
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeBuildFailureLines,
  portableText,
  safePathSegment,
} from "./scan-utils.ts";

describe("portableText", () => {
  it("strips the project root and normalizes separators", () => {
    const root = join("virtual", "project");

    expect(portableText(`failed at ${root}/src/App.tsx`, root)).toBe("failed at /src/App.tsx");
    expect(portableText("a\\b\\c.ts", root)).toBe("a/b/c.ts");
  });
});

describe("describeBuildFailureLines", () => {
  it("reduces a reported bundler error to a portable line", () => {
    const root = join("virtual", "project");
    const error = {
      errors: [
        {
          message: "Could not resolve ./missing.js",
          loc: { file: join(root, "src", "entry.js"), line: 3, column: 10 },
        },
      ],
    };

    const lines = describeBuildFailureLines(error, root);

    expect(lines).toEqual(["Could not resolve ./missing.js (src/entry.js:3:10)"]);
  });

  it("never returns an empty diagnostics array for a bare Error", () => {
    const lines = describeBuildFailureLines(new Error("boom"), "/virtual/project");

    expect(lines).toEqual(["boom"]);
  });

  it("collapses duplicates and drops empty lines", () => {
    const lines = describeBuildFailureLines(new Error("boom\n\nboom\n"), "/virtual/project");

    expect(lines).toEqual(["boom"]);
  });

  it("produces a diagnostic when the failure has no readable text", () => {
    const lines = describeBuildFailureLines(undefined, "/virtual/project");

    expect(lines).toEqual(["The bundler failed without a readable message."]);
  });

  it("reports a thrown value that JSON cannot serialize instead of failing to format it", () => {
    // The defect the shared helper had: `JSON.stringify` throws on these, so formatting a strange
    // thrown value would replace the bundler's failure with a second one about the formatter.
    const circular: Record<string, unknown> = { code: "LOOP" };
    circular.self = circular;

    expect(describeBuildFailureLines(1n, "/virtual/project")).toEqual(["1"]);
    expect(describeBuildFailureLines(circular, "/virtual/project")).toEqual(["[object Object]"]);
  });
});

describe("safePathSegment", () => {
  it("makes a package name safe as a directory component", () => {
    expect(safePathSegment("@fixture/date-picker")).toBe("_fixture_date-picker");
    expect(safePathSegment("tiny-math")).toBe("tiny-math");
  });
});

