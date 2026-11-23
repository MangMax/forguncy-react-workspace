/**
 * The one definition of the Rolldown build options, and the projections its consumers read.
 *
 * Decision source: GitHub Issue #158
 * (https://github.com/MangMax/forguncy-react-workspace/issues/158), under #152, which records the
 * defect: the probe build, the compiler build and the build-configuration fingerprint each wrote
 * their own copy of the same options, and the probe pinned `platform: "browser"` while the
 * compiler left it to Rolldown's default.
 *
 * The expected values below are literals, not projections recomputed the same way the code does:
 * the fingerprint input in particular is quoted from the fingerprints recorded in existing
 * `fgc.lock.json` evidence, so a change to it fails here rather than invalidating evidence.
 */

import { describe, expect, it } from "vitest";

import {
  CELL_BUNDLER_BUILD_OPTIONS,
  buildConfigurationFingerprintInput,
  cellBundlerInputOptions,
  cellBundlerOutputOptions,
} from "./cell-bundler-options.ts";

describe("the Cell bundler build configuration", () => {
  it("is the options every Cell build has always used, with `platform` stated rather than defaulted", () => {
    expect(CELL_BUNDLER_BUILD_OPTIONS).toEqual({
      platform: "browser",
      transform: { jsx: "react-jsx" },
      experimental: { attachDebugInfo: "none" },
      output: { format: "iife", codeSplitting: false },
    });
  });

  it("projects the definition into the `rolldown()` input options", () => {
    expect(cellBundlerInputOptions()).toEqual({
      platform: "browser",
      transform: { jsx: "react-jsx" },
      experimental: { attachDebugInfo: "none" },
    });
  });

  it("projects the definition into the `generate()` output options, naming the binding the caller asked for", () => {
    expect(cellBundlerOutputOptions("CellComponent")).toEqual({
      format: "iife",
      codeSplitting: false,
      name: "CellComponent",
    });
  });

  it("projects the definition into the fingerprint input, in the string form a lock record stores", () => {
    // `codeSplitting` is a string here because the fingerprint is a record of strings: the
    // composition stringifies every value, and a boolean would not survive that round trip.
    expect(buildConfigurationFingerprintInput()).toEqual({
      format: "iife",
      codeSplitting: "false",
      jsx: "react-jsx",
      platform: "browser",
      attachDebugInfo: "none",
    });
  });
});
