/**
 * Shared scan utilities for the probe engine's steps (#17).
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (the probe protocol this engine executes — every helper
 * here exists to make one of its machine-readability properties hold) and #8
 * (the lock the fingerprint feeds).
 *
 * Two properties drive the design of everything in this module:
 *
 * - **Determinism.** Identical inputs must produce identical bytes
 *   (`PROBE_REPORT_MACHINE_READABILITY`'s last item), so directory walks are
 *   sorted before they are read, comparisons use code units rather than the
 *   locale, and bundler output is stripped of ANSI paint and machine-specific
 *   absolute paths *before* it reaches a `diagnostics` array. A failure message
 *   that embeds one machine's home directory on one machine and another's on a
 *   second would make the same broken candidate serialize differently in CI
 *   than on a developer's laptop.
 * - **Portability.** A probe report must survive being read on another machine.
 *   Every path that leaves this module as report content is either relative to
 *   the package being probed or relativized against the project root — the same
 *   rule `fgc.lock.json` enforces document-wide, applied at the point of escape
 *   rather than audited after the fact.
 */

import { sep } from "node:path";

import { describeReportedError, describeValue, hasReportedErrors, stripAnsi } from "@forguncy-react-workspace/core";

/**
 * Makes a bundler message portable: ANSI stripped, every occurrence of the
 * project root removed, remaining backslashes normalized to `/`.
 *
 * Relativized at the point of escape because the alternative — scanning the
 * finished report for absolute paths — only finds the ones the writer happened
 * to think about, while this makes a leak require bypassing the only function
 * that formats diagnostics.
 */
export function portableText(text: string, projectRoot: string): string {
  const roots = new Set([projectRoot, projectRoot.split(sep).join("/"), projectRoot.split("/").join(sep)]);
  let out = stripAnsi(text);
  for (const root of roots) {
    if (root.length > 0) {
      out = out.split(root).join("");
    }
  }
  return out.replace(/\\/g, "/");
}

/**
 * Turns an escaped bundler failure into the non-empty `diagnostics` array a
 * `failed` probe step owes (`validateProbeReport` refuses a failure without
 * one — "a failure is evidence, not a boolean").
 *
 * Empty lines are dropped and duplicates collapsed so the same failure always
 * yields the same list, whatever combination of frames the bundler chose to
 * print this time.
 */
export function describeBuildFailureLines(error: unknown, projectRoot: string): readonly string[] {
  // The message and the file share one portability rule: the report this feeds may be read on
  // another machine, so a path that escaped here would be a leak rather than a detail.
  const portable = (text: string): string => portableText(text, projectRoot);
  const raw: string[] = [];
  if (hasReportedErrors(error) && error.errors.length > 0) {
    raw.push(
      ...error.errors.map(entry =>
        describeReportedError(entry, {
          message: portable,
          file: text => portable(text).replace(/^[/\\]+/, ""),
        }),
      ),
    );
  } else if (error instanceof Error) {
    raw.push(...portable(error.message).split("\n"));
  } else if (error !== undefined && error !== null) {
    // A nullish failure has no text worth showing — `describeValue` renders it as the empty
    // string — so it falls through to the "without a readable message" line below instead of
    // contributing a blank diagnostic.
    const text = portable(describeValue(error));
    if (text.trim().length > 0) {
      raw.push(...text.split("\n"));
    }
  }

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of raw) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    lines.push(trimmed);
  }
  // A failure with no readable text still has to produce a diagnostic line:
  // `validateProbeReport` treats empty diagnostics as "failed without evidence".
  return lines.length > 0 ? lines : ["The bundler failed without a readable message."];
}

/**
 * Removed, deliberately: `walkPackageSourceFiles` lived here and returned every source
 * file under a package directory in sorted order. It is what the scanners used, and it
 * is the mechanism behind the three false `platform-api-unavailable` rejections that
 * #16's end-to-end acceptance criterion uncovered — "every file the package ships" is
 * not "every file a browser build reaches", and the difference is where `three`'s
 * optional draco loaders and `@embedpdf/pdfium`'s Node builds live.
 *
 * `module-source-reachability.ts`'s `collectReachableSourceFiles` replaces it: same determinism
 * guarantees, bounded by the manifest's browser entries. This note stays so that a
 * future reader who needs a directory walk finds the reason it was withdrawn rather
 * than re-adding it — a whole-tree walk is exactly the shape a scanner reaches for
 * first, and it silently over-reports findings ever after.
 */

/** A path usable as a directory-name component of the probe's scratch space. */
export function safePathSegment(name: string): string {
  return name.replace(/[@/\\]/g, "_").replace(/[^A-Za-z0-9._-]/g, "-");
}
