/**
 * The `export-metadata` step in isolation: browser entry resolution from the
 * manifest alone.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Spec: #16 — only this step may observe
 * `ssr-or-server-only-without-browser-build`.
 */

import { describe, expect, it } from "vitest";

import type { ResolvedPackageIdentity } from "./identity.ts";
import { observeExportMetadata } from "./export-metadata.ts";

function identity(manifest: Record<string, unknown>): ResolvedPackageIdentity {
  return {
    packageName: typeof manifest["name"] === "string" ? manifest["name"] : "candidate",
    packageVersion: "1.0.0",
    license: "MIT",
    source: "https://github.com/example/candidate",
    directory: "/virtual/package",
    manifest,
  };
}

describe("observeExportMetadata", () => {
  it("accepts a browser-resolvable exports map without filing a rejection", () => {
    const observation = observeExportMetadata(
      identity({
        name: "browser-lib",
        exports: { ".": { browser: "./index.js", default: "./index.js" } },
        types: "index.d.ts",
      }),
    );

    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.validation.outcome).toBe("passed");
    expect(observation.facts.find(fact => fact.name === "exports.map.present")?.value).toBe(true);
    expect(observation.facts.find(fact => fact.name === "exports.types-present")?.value).toBe(true);
  });

  it("falls back to browser → module → main when exports is absent", () => {
    const observation = observeExportMetadata(
      identity({ name: "classic-lib", module: "./esm.js", main: "./cjs.js" }),
    );

    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.facts.find(fact => fact.name === "exports.fallback-fields")?.value).toEqual([
      "module",
      "main",
    ]);
  });

  // The one rejection this step may file: no browser entry means no browser
  // artifact, and that is decidable from the manifest alone.
  it("files ssr-or-server-only-without-browser-build for a Node-only entry", () => {
    const observation = observeExportMetadata(
      identity({ name: "server-only", main: "./server.js", exports: { ".": { node: "./server.js" } } }),
    );

    expect(observation.rejectionFindings).toHaveLength(1);
    const finding = observation.rejectionFindings[0]!;
    expect(finding.signal).toBe("ssr-or-server-only-without-browser-build");
    expect(finding.step).toBe("export-metadata");
    expect(finding.evidence).toContain("exports-map-does-not-resolve-for-browser");
    // The step succeeded at observing the absence — a rejection is not a step failure.
    expect(observation.validation.outcome).toBe("passed");
  });

  it("treats a .node-only entry as not browser-resolvable", () => {
    const observation = observeExportMetadata(identity({ name: "native-only", main: "./addon.node" }));

    expect(observation.rejectionFindings.map(finding => finding.signal)).toContain(
      "ssr-or-server-only-without-browser-build",
    );
  });

  it("records peer ranges as a fact when present", () => {
    const observation = observeExportMetadata(
      identity({ name: "peer-lib", main: "./index.js", peerDependencies: { react: ">=18" } }),
    );

    expect(observation.facts.find(fact => fact.name === "peerDependencies.ranges")?.value).toEqual(["react@>=18"]);
  });
});

// ---------------------------------------------------------------------------
// #90 — the question is about the entry, not the package root
// ---------------------------------------------------------------------------

describe("observeExportMetadata: published subpaths (#90)", () => {
  /**
   * A subpath-only package: `exports` publishes `./only` and no `"."` at all.
   *
   * Before #90 this step asked the manifest about the root entry, found nothing, and filed
   * `ssr-or-server-only-without-browser-build` — for the subpath the build had just built
   * successfully. The assessment became `supports-rejection-only`, so no `inline` decision for
   * such a package could ever be recorded.
   */
  const SUBPATH_ONLY = {
    name: "subpath-only-lib",
    version: "4.0.0",
    type: "module",
    exports: { "./only": { import: "./lib/only.js" } },
  };

  it("reports the published subpath as browser-resolvable rather than the absent root", () => {
    const observation = observeExportMetadata(identity(SUBPATH_ONLY), { entry: "subpath-only-lib/only" });

    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.facts.find(fact => fact.name === "exports.browser-resolvable")?.value).toBe(true);
    // The key the answer is about is recorded, because the package has no root entry to infer it
    // from and two probes of one manifest must not be indistinguishable in the report.
    expect(observation.facts.find(fact => fact.name === "exports.probed-entry")?.value).toBe("./only");
  });

  it("still reports the root as having no browser entry when the root is what is probed", () => {
    const observation = observeExportMetadata(identity(SUBPATH_ONLY));

    expect(observation.rejectionFindings.map(finding => finding.signal)).toContain(
      "ssr-or-server-only-without-browser-build",
    );
    expect(observation.facts.find(fact => fact.name === "exports.probed-entry")).toBeUndefined();
  });

  it("does not let a root entry answer for an undeclared subpath", () => {
    // The widening #90 forbids: the map publishes `"."` and `./extra`, and `./private` exists on
    // disk but not in the map. Falling back to the root would report a browser entry the bundler
    // will then refuse.
    const observation = observeExportMetadata(
      identity({
        name: "mixed-lib",
        version: "1.0.0",
        exports: { ".": { import: "./lib/index.js" }, "./extra": { import: "./lib/extra.js" } },
      }),
      { entry: "mixed-lib/private" },
    );

    expect(observation.facts.find(fact => fact.name === "exports.browser-resolvable")?.value).toBe(false);
    expect(observation.facts.find(fact => fact.name === "exports.probed-entry")?.value).toBe("./private");
    expect(observation.rejectionFindings.map(finding => finding.signal)).toContain(
      "ssr-or-server-only-without-browser-build",
    );
  });

  it("answers an exact published subpath of a package whose root is Node-only", () => {
    // The other direction: the root is server-only, the published subpath is browser-safe. Asking
    // the root would refuse a subpath a Cell can legitimately import.
    const observation = observeExportMetadata(
      identity({
        name: "dual-lib",
        version: "1.0.0",
        exports: { ".": { node: "./server.js" }, "./browser": { browser: "./browser.js", import: "./browser.js" } },
      }),
      { entry: "dual-lib/browser" },
    );

    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.facts.find(fact => fact.name === "exports.browser-resolvable")?.value).toBe(true);
  });

  it("matches a wildcard subpath by Node's longest-prefix rule", () => {
    const observation = observeExportMetadata(
      identity({ name: "wild-lib", version: "1.0.0", exports: { "./*": { import: "./lib/*.js" } } }),
      { entry: "wild-lib/any" },
    );

    expect(observation.rejectionFindings).toEqual([]);
    expect(observation.facts.find(fact => fact.name === "exports.probed-entry")?.value).toBe("./any");
  });
});
