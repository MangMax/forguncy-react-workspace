/**
 * The probe's build options come from the shared definition, not a copy beside the call.
 *
 * Decision source: GitHub Issue #158
 * (https://github.com/MangMax/forguncy-react-workspace/issues/158). The defect this guards is a
 * silent one: the probe's `rolldown()` options and the `generate()` options were written here and
 * again in `cell-compiler`'s bundler, and the fingerprint recorded a third copy. A copy that drifts
 * changes a probe's answer without moving the fingerprint that is supposed to invalidate it.
 *
 * The bundler is stubbed because the claim under test is exactly "these are the options the probe
 * hands Rolldown" — running the real bundler would test Rolldown, not this contract.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildConfigurationFingerprintInput,
  cellBundlerInputOptions,
  cellBundlerOutputOptions,
} from "@forguncy-react-workspace/core";
import { afterAll, describe, expect, it, vi } from "vitest";

import { BUILD_CONFIGURATION_FINGERPRINT, runCandidateBuild } from "./build.ts";

const captured = vi.hoisted(() => ({
  input: undefined as Record<string, unknown> | undefined,
  output: undefined as Record<string, unknown> | undefined,
}));

vi.mock("rolldown", () => ({
  rolldown: async (input: Record<string, unknown>) => {
    captured.input = input;
    return {
      generate: async (output: Record<string, unknown>) => {
        captured.output = output;
        return {
          output: [{ type: "chunk", isEntry: true, fileName: "candidate.js", code: "", modules: {}, imports: [] }],
        };
      },
      close: async () => undefined,
    };
  },
}));

const scratchRoot = await mkdtemp(join(tmpdir(), "fgc-probe-build-options-"));

afterAll(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

describe("the probe build's Rolldown options", () => {
  it("are the shared definition's input and output projections", async () => {
    const result = await runCandidateBuild({ projectRoot: scratchRoot, packageName: "candidate" });
    expect(result.outcome).toBe("passed");

    const input = captured.input ?? {};
    expect(
      Object.fromEntries(["platform", "transform", "experimental"].map(key => [key, input[key]])),
    ).toEqual(cellBundlerInputOptions());
    expect(captured.output).toEqual(cellBundlerOutputOptions("FgcProbeCandidate"));
  });

  it("record the shared definition's projection as the fingerprint's bundler input", () => {
    expect(BUILD_CONFIGURATION_FINGERPRINT).toEqual(buildConfigurationFingerprintInput());
  });
});
