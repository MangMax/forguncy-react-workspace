/**
 * `cell-project` reaches the resolver through `/local`, and the fingerprint composer is there.
 *
 * Decision source: GitHub Issue #157
 * (https://github.com/MangMax/forguncy-react-workspace/issues/157), under #152's
 * "one shared definition" and "consume what your dependencies export".
 *
 * ## The two facts this pins
 *
 * 1. **No file in this package's `src/` imports the resolver's full entry.** The barrel reaches
 *    `probe/build.ts`, which imports `rolldown`; importing any name from it evaluates every module
 *    it re-exports. `project.ts` used to do exactly that for `composeProbeFingerprint`, which is
 *    the third copy of the "compose a fingerprint" cost #23 measured and fixed for the harness.
 * 2. **The composer is reachable from `/local`.** The reason it was not — `probe/build.ts`
 *    declaring `BUILD_CONFIGURATION_FINGERPRINT` beside its `rolldown` import — is what #157
 *    removes, so the projection has to prove it now answers the question rather than only that it
 *    is cheap.
 *
 * Both are read from source rather than from the module graph, for the reason
 * `dependency-resolver-local.test.ts` gives: a static import of a subpath is a text fact, and the
 * failure mode is a single import line that nothing else in the repository would notice.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compareCodeUnits } from "@forguncy-react-workspace/core";
import { composeProbeFingerprint as fromLocal } from "@forguncy-react-workspace/dependency-resolver/local";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..");
const PACKAGE_ROOT = "@forguncy-react-workspace/dependency-resolver";

/** Every non-test `.ts` file in this package's `src/`. */
function sourceFiles(directory: string, found: string[] = []): readonly string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      found.push(path);
    }
  }
  return found;
}

describe("cell-project consumes the resolver's lightweight entry", () => {
  it("imports no file from the resolver's full entry", () => {
    const offending: string[] = [];
    for (const file of sourceFiles(HERE)) {
      const source = readFileSync(file, "utf8");
      // An exact bare specifier is the full entry; `/local` and any other subpath are allowed,
      // because those exist precisely to choose a smaller module graph.
      for (const match of source.matchAll(/from\s+"(@forguncy-react-workspace\/dependency-resolver[^"]*)"/g)) {
        if (match[1] === PACKAGE_ROOT) {
          offending.push(`${file}: ${match[1]}`);
        }
      }
    }

    expect(offending).toEqual([]);
  });

  it("composes the fingerprint a committed lock already records, from `/local`", () => {
    // An independent source of truth rather than a comparison with the barrel: the fingerprint
    // stored in `examples/extension-query`'s committed `fgc.lock.json`. That value was produced by
    // a probe and is part of the repository's byte-identity evidence, so reproducing it exactly is
    // what "the composer is unchanged" means. A `/local` copy that composed a different string
    // would make every record in that file look stale to a deployment projection.
    const lock = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, "examples", "extension-query", "fgc.lock.json"), "utf8"),
    ) as { decisions: { packageName: string; probe: { fingerprint: string } }[] };
    const record = lock.decisions[0]!;

    const composed = fromLocal({ probeId: "inline-bundle", entry: record.packageName });

    expect(composed.fingerprint).toBe(record.probe.fingerprint);
    // The declared build inputs travel with it, and they are the ones the recorded fingerprint's
    // own `bundler=` segment names — read from the lock, so this compares the composer against the
    // committed evidence rather than against itself.
    const recordedBundler = /bundler=(\{.*\})$/.exec(record.probe.fingerprint)?.[1];
    expect(recordedBundler, "the committed fingerprint has no bundler segment").toBeDefined();
    // Ordered by key with the repository's code-unit rule, which is the order the fingerprint's
    // own composer uses — a bare `.sort()` over entries compares their stringified form instead.
    const sortedInput = Object.entries(composed.bundlerInput).sort(([left], [right]) =>
      compareCodeUnits(left, right),
    );
    expect(JSON.stringify(Object.fromEntries(sortedInput))).toBe(recordedBundler);
  });
});
