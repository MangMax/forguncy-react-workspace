import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { resolveCellResource } from "@forguncy-react-workspace/cell-compiler";
import type { CellResourceRefusalCode } from "@forguncy-react-workspace/core";
import { CELL_ASSET_INLINE_LIMIT_BYTES } from "@forguncy-react-workspace/core";
import { CellResourceRefusedError, createDevCellResourcePolicy } from "@forguncy-react-workspace/dev-harness";

/**
 * One Cell resource policy, measured through both of its consumers (#153).
 *
 * Decision sources: GitHub Issues
 * - #153 — "refactor(core): one Cell resource classification for dev and compiler"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/153), whose acceptance criterion
 *   is one shared table of resource imports running through the compiler's resource resolution
 *   and dev-harness's resource policy and answering identically, and
 * - #152 — the spec this ticket belongs to, whose first user story is "`vp dev` refuses a CSS
 *   import with a query exactly when the compiler refuses it".
 *
 * ## Why the table lives in `cell-project`
 *
 * It has to import *both* sides, and neither may depend on the other: `cell-compiler` is upstream
 * of every pipeline, and `dev-harness` is a pipeline. `cell-project` is the one package that
 * already depends on both, so the cross-path contract has a home here without adding a package
 * edge that would make the dependency direction look reversible.
 *
 * ## What is asserted, and what is not
 *
 * Each row runs through `resolveCellResource` — the compiler's resource resolution — and through
 * `createDevCellResourcePolicy().load`, the policy hook Vite calls. For a refusal the two must
 * agree on the reason code *and* on the message text, because one explanation has to teach one
 * rule (the spec's third user story). For an acceptance the compiler must inline the resource and
 * dev must not refuse it; plain CSS is `null` locally because Vite owns its `<style>` lifecycle,
 * which is the one deliberate difference and is asserted as such rather than smoothed over.
 *
 * The expected verdicts below are the policy's, written down rather than derived from either
 * implementation: a table computed from the code under test would pass by construction.
 */
const fixtureRoot = mkdtempSync(join(tmpdir(), "fgc-resource-parity-"));
writeFileSync(join(fixtureRoot, "x.css"), ".probe { color: red; }\n");
writeFileSync(join(fixtureRoot, "x.module.css"), ".probe { color: red; }\n");
writeFileSync(join(fixtureRoot, "x.scss"), "$probe-color: red;\n.probe { color: $probe-color; }\n");
writeFileSync(join(fixtureRoot, "x.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
writeFileSync(join(fixtureRoot, "x.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
// A directory whose name says "stylesheet": the import names a resource, the target is not a
// file. This is the EISDIR case the ticket names, made reachable without a filesystem race.
mkdirSync(join(fixtureRoot, "directory.css"));

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

type ResourceCase =
  | { readonly id: string; readonly verdict: "accept"; readonly kind: "css" | "asset" }
  | { readonly id: string; readonly verdict: "refuse"; readonly code: CellResourceRefusalCode };

const RESOURCE_CASES: readonly ResourceCase[] = [
  { id: "x.css", verdict: "accept", kind: "css" },
  { id: "x.css?foo", verdict: "refuse", code: "resource-query" },
  { id: "x.css?raw", verdict: "refuse", code: "resource-query" },
  { id: "x.module.css", verdict: "refuse", code: "css-module" },
  { id: "x.scss", verdict: "refuse", code: "css-preprocessor" },
  { id: "x.wasm", verdict: "refuse", code: "rejected-binary-asset" },
  { id: "x.png", verdict: "accept", kind: "asset" },
  { id: "x.png?v=1", verdict: "refuse", code: "resource-query" },
  { id: "directory.css", verdict: "refuse", code: "not-a-regular-file" },
  { id: "missing.css", verdict: "refuse", code: "missing-resource-file" },
  // Vite's own bookkeeping is not an authored query, so both paths ignore it. It is in the table
  // because "dev is stricter now" must not mean "dev refuses the marks Vite itself appends" —
  // that would refuse every asset the moment Vite re-requested one.
  { id: "x.png?import", verdict: "accept", kind: "asset" },
  { id: "x.css?t=1234", verdict: "accept", kind: "css" },
];

describe("#153: dev and the compiler answer every Cell resource import the same way", () => {
  it.each(RESOURCE_CASES)("$id", async resourceCase => {
    const fileId = join(fixtureRoot, resourceCase.id);

    const compilation = await resolveCellResource({
      importer: undefined,
      fileId,
      inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
    });

    let devValue: string | null = null;
    let devRefusal: CellResourceRefusedError | undefined;
    try {
      devValue = await createDevCellResourcePolicy().load(fileId);
    } catch (error) {
      if (!(error instanceof CellResourceRefusedError)) {
        throw error;
      }
      devRefusal = error;
    }

    if (resourceCase.verdict === "accept") {
      expect(compilation.ok, `the compiler refused "${resourceCase.id}"`).toBe(true);
      if (!compilation.ok) return;
      expect(devRefusal?.message, `dev refused "${resourceCase.id}"`).toBeUndefined();
      expect(compilation.resource.kind).toBe(resourceCase.kind === "css" ? "style" : "asset");
      if (resourceCase.kind === "css") {
        // Vite owns plain CSS locally; the compiler is what inlines it into the artifact.
        expect(devValue).toBeNull();
      } else {
        expect(devValue).toContain("data:");
      }
      return;
    }

    expect(compilation.ok, `the compiler accepted "${resourceCase.id}"`).toBe(false);
    if (compilation.ok) return;
    expect(compilation.refusal.code).toBe(resourceCase.code);
    expect(devRefusal?.refusal.code, `dev did not refuse "${resourceCase.id}"`).toBe(resourceCase.code);
    // One explanation, not two: the text Vite shows is the text the diagnostic carries.
    expect(devRefusal?.message).toBe(compilation.refusal.detail);
  });
});
