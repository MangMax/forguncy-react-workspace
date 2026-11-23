/**
 * The shared build-failure formatting: ANSI stripping and a total value description.
 *
 * Decision source: the parent spec #152, whose review found `describeValue`, `hasReportedErrors`,
 * `stripAnsi`, `firstLine` and `describeReportedError` copied between the compiler and the probe,
 * and found that the copies' `JSON.stringify` could throw where `String()` never did.
 *
 * The assertions moved here with the code: `stripAnsi`'s two cases are the probe's own tests, now
 * run against the one copy both consumers load. The totality cases are the new ones — a diagnostic
 * about a failure must not itself fail.
 */

import { describe, expect, it } from "vitest";

import { describeReportedError, describeValue, hasReportedErrors, stripAnsi } from "./build-failure.ts";

describe("stripAnsi", () => {
  it("removes colour sequences built from code points", () => {
    const esc = String.fromCharCode(0x1b);
    const painted = `${esc}[31merror${esc}[0m`;

    expect(stripAnsi(painted)).toBe("error");
  });

  it("removes a bracket form even when the escape byte was lost", () => {
    expect(stripAnsi("[31merror[0m")).toBe("error");
  });
});

describe("describeValue", () => {
  it("renders a string as itself and a nullish value as nothing", () => {
    expect(describeValue("boom")).toBe("boom");
    expect(describeValue(undefined)).toBe("");
    expect(describeValue(null)).toBe("");
  });

  it("renders a structured value in its JSON form", () => {
    expect(describeValue({ code: "PARSE_ERROR" })).toBe('{"code":"PARSE_ERROR"}');
  });

  it("falls back rather than throwing on a BigInt, which JSON cannot serialize", () => {
    expect(describeValue(10n)).toBe("10");
  });

  it("falls back rather than throwing on a circular value", () => {
    const circular: Record<string, unknown> = { code: "LOOP" };
    circular.self = circular;

    expect(describeValue(circular)).toBe("[object Object]");
  });

  it("falls back to the object tag when `toString` itself throws", () => {
    const hostile = {
      toString: () => {
        throw new Error("no");
      },
      toJSON: () => {
        throw new Error("no");
      },
    };

    expect(describeValue(hostile)).toBe("[object Object]");
  });
});

describe("describeReportedError", () => {
  it("puts the structured location after the first line of the message", () => {
    const line = describeReportedError(
      { message: "Could not resolve ./missing.js\nsecond line", loc: { file: "src/entry.js", line: 3, column: 10 } },
      { message: stripAnsi },
    );

    expect(line).toBe("Could not resolve ./missing.js (src/entry.js:3:10)");
  });

  it("uses the consumer's path formatter when one is given", () => {
    const line = describeReportedError(
      { message: "boom", loc: { file: "/root/src/entry.js", line: 1 } },
      { message: stripAnsi, file: text => text.replace("/root/", "") },
    );

    expect(line).toBe("boom (src/entry.js:1)");
  });
});

describe("hasReportedErrors", () => {
  it("recognizes the bundler's reported-errors shape only", () => {
    expect(hasReportedErrors({ errors: [] })).toBe(true);
    expect(hasReportedErrors({ errors: "no" })).toBe(false);
    expect(hasReportedErrors(null)).toBe(false);
    expect(hasReportedErrors(new Error("boom"))).toBe(false);
  });
});
