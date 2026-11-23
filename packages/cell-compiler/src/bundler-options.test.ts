/**
 * The compiler's Rolldown options come from the shared definition, not a copy beside the calls.
 *
 * Decision source: GitHub Issue #158
 * (https://github.com/MangMax/forguncy-react-workspace/issues/158). The compiler wrote the same
 * `transform`/`experimental`/format options as the probe but left `platform` to Rolldown's
 * format-derived default, so the two builds' answer to "what does this import resolve to" was an
 * assumption rather than a stated decision.
 *
 * Both passes are covered because both are the compiler's build options: the pre-bundle `scan`
 * pass and the `rolldown()` build pass. The bundler is stubbed because the claim under test is
 * exactly "these are the options the compiler hands Rolldown".
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cellBundlerInputOptions, cellBundlerOutputOptions } from "@forguncy-react-workspace/core";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createRolldownCellBundler } from "./rolldown-bundler.ts";

const captured = vi.hoisted(() => ({
  build: undefined as Record<string, unknown> | undefined,
  generate: undefined as Record<string, unknown> | undefined,
  scan: undefined as Record<string, unknown> | undefined,
}));

vi.mock("rolldown", () => ({
  rolldown: async (input: Record<string, unknown>) => {
    captured.build = input;
    return {
      generate: async (output: Record<string, unknown>) => {
        captured.generate = output;
        return {
          output: [{ type: "chunk", isEntry: true, fileName: "cell.js", code: "", modules: {}, imports: [] }],
        };
      },
      close: async () => undefined,
    };
  },
}));

vi.mock("rolldown/experimental", () => ({
  scan: async (input: Record<string, unknown>) => {
    captured.scan = input;
    return Promise.resolve();
  },
}));

const fixtureDir = join(tmpdir(), "fgc-cell-compiler-build-options");
mkdirSync(fixtureDir, { recursive: true });
writeFileSync(join(fixtureDir, "App.tsx"), "export function App() { return null; }\n");

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function projectionOf(options: Record<string, unknown> | undefined): Record<string, unknown> {
  const source = options ?? {};
  return Object.fromEntries(["platform", "transform", "experimental"].map(key => [key, source[key]]));
}

describe("the compiler's Rolldown options", () => {
  it("are the shared definition's input and output projections in the build pass", async () => {
    const bundler = createRolldownCellBundler({ dir: fixtureDir });
    await bundler.bundle({ entry: "App.tsx", dependencies: [], componentBinding: "CellComponent" });

    expect(projectionOf(captured.build)).toEqual(cellBundlerInputOptions());
    expect(captured.generate).toEqual(cellBundlerOutputOptions("CellComponent"));
  });

  it("are the shared definition's input projection in the pre-bundle scan pass", async () => {
    const bundler = createRolldownCellBundler({ dir: fixtureDir });
    await bundler.resolveEntrySpecifiers?.({ entry: "App.tsx", dependencies: [] });

    expect(projectionOf(captured.scan)).toEqual(cellBundlerInputOptions());
  });
});
