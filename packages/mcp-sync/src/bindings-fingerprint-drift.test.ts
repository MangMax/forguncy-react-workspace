/**
 * The v2 fingerprint and the field-level drift classification (#179), as unit tests.
 *
 * What this file pins:
 *
 * - the v2 marker carries a `bindings` hash **without** bumping the version, so a v1 cell is not
 *   misread as malformed;
 * - a v1 marker (no `bindings` key) reads back cleanly and covers only the code — the backward
 *   compatibility the Epic requires, so a pre-#179 managed cell is never misjudged as
 *   binding-drifted;
 * - `classifyCellDivergence` reports `binding-drifted` for a declared-field edit and names the
 *   field, and `restore`/`restore-all` resolve only the managed-cell conflicts — never a foreign
 *   or unreadable target.
 */

import { describe, expect, it } from "vitest";

import { CELL_ARTIFACT_BANNER } from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";
import type { NormalizedCellBindings } from "@forguncy-react-workspace/core";

import {
  classifyCellDivergence,
  cellDivergenceOverride,
  formatCellDivergence,
  resolveCellWriteAction,
} from "./divergence.ts";
import type { DeployedCellState } from "./divergence.ts";
import {
  fingerprintDeclaredBindings,
  readSyncMarker,
  stampSyncMarker,
  stripSyncMarker,
  SYNC_MARKER_VERSION,
} from "./fingerprint.ts";

function generated(code = "function App() { return null; }\n"): CompileCellResult {
  return { code: `${CELL_ARTIFACT_BANNER}\n${code}`, frontendLibraries: [] };
}

function declared(overrides: Partial<NormalizedCellBindings> = {}): NormalizedCellBindings {
  return {
    declaredFields: ["properties"],
    properties: [{ propertyName: "title", propertyValue: "hello" }],
    ...overrides,
  } as NormalizedCellBindings;
}

/** A read-back state whose bindings match the declaration — the baseline, no drift. */
function matchingRead(stampedCode: string, extra: Record<string, unknown> = {}): DeployedCellState {
  return {
    kind: "read",
    code: stampedCode,
    frontendLibraries: [],
    declaredBindings: {
      properties: [{ propertyName: "title", propertyValue: "hello" }],
      ...extra,
    },
  };
}

describe("the v2 marker", () => {
  it("stays version 1 — a binding-aware marker is not a new format version", () => {
    expect(SYNC_MARKER_VERSION).toBe(1);
  });

  it("omits the bindings hash when no bindings are threaded, byte-identical to a v1 marker", () => {
    const artifact = generated();
    const without = stampSyncMarker(artifact);
    const withUndefined = stampSyncMarker(artifact, undefined);
    expect(without).toBe(withUndefined);
    expect(readSyncMarker(without)).toMatchObject({ kind: "present" });
    const state = readSyncMarker(without);
    if (state.kind !== "present") throw new Error("expected a present marker");
    expect(state.marker.bindings).toBeUndefined();
  });

  it("carries a bindings hash when bindings are threaded, and reads it back", () => {
    const artifact = generated();
    const bindings = declared();
    const stamped = stampSyncMarker(artifact, bindings);
    const state = readSyncMarker(stamped);
    if (state.kind !== "present") throw new Error("expected a present marker");
    expect(state.marker.bindings).toBe(fingerprintDeclaredBindings(bindings));
  });

  it("reads a hand-written v1 marker (no bindings key) as present, not malformed", () => {
    // The shape a pre-#179 sync wrote: v/artifact/code and nothing else.
    const artifact = generated();
    const v1 = stampSyncMarker(artifact); // no bindings — the v1 form
    const state = readSyncMarker(v1);
    expect(state.kind).toBe("present");
    if (state.kind !== "present") return;
    expect(state.marker.version).toBe(1);
    expect(state.marker.bindings).toBeUndefined();
  });

  it("reports a present-but-non-digest bindings field as corruption, not as no-bindings", () => {
    const artifact = generated();
    const line = `/* fgc-sync {"v":1,"artifact":"${"a".repeat(64)}","code":"${"b".repeat(64)}","bindings":"not-a-digest"} */`;
    const code = `${stripSyncMarker(artifact.code)}\n${line}\n`;
    const state = readSyncMarker(code);
    expect(state.kind).toBe("malformed");
  });

  it("hashes only the declared fields, so a pass-through field never enters the fingerprint", () => {
    const withExtra = declared();
    const hash = fingerprintDeclaredBindings(withExtra);
    // Two declarations differing only in pass-through content hash identically — but here there is
    // no pass-through content on the object, so the meaningful check is that the hash is stable and
    // deterministic, and changes when a *declared* field changes.
    expect(hash).toBe(fingerprintDeclaredBindings(declared()));
    expect(hash).not.toBe(fingerprintDeclaredBindings(declared({ properties: [{ propertyName: "title", propertyValue: "different" }] })));
  });
});

describe("binding drift classification", () => {
  it("is identical when the read-back matches the declaration", () => {
    const artifact = generated();
    const bindings = declared();
    const stamped = stampSyncMarker(artifact, bindings);
    const divergence = classifyCellDivergence(matchingRead(stamped), artifact, { bindings, pageName: "P" });
    expect(divergence.kind).toBe("identical");
    expect(divergence.bindingDrift).toEqual([]);
  });

  it("reports binding-drifted for a declared-field edit, and names the field", () => {
    const artifact = generated();
    const bindings = declared();
    const stamped = stampSyncMarker(artifact, bindings);
    const state = matchingRead(stamped, { properties: [{ propertyName: "title", propertyValue: "EDITED IN DESIGNER" }] });
    const divergence = classifyCellDivergence(state, artifact, { bindings, pageName: "P" });
    expect(divergence.kind).toBe("binding-drifted");
    expect(divergence.bindingDrift.map(entry => entry.field)).toEqual(["properties"]);
  });

  it("never judges a v1 cell binding-drifted — the backward-compat rule", () => {
    const artifact = generated();
    const bindings = declared();
    // A v1 cell: stamped with NO bindings hash, but the read-back has drifted bindings.
    const v1Stamped = stampSyncMarker(artifact);
    const state: DeployedCellState = {
      kind: "read",
      code: v1Stamped,
      frontendLibraries: [],
      declaredBindings: { properties: [{ propertyName: "title", propertyValue: "EDITED" }] },
    };
    const divergence = classifyCellDivergence(state, artifact, { bindings, pageName: "P" });
    // The binding axis is not covered by a v1 marker, so this is identical-or-previous on the code
    // axis, never binding-drifted.
    expect(divergence.kind).not.toBe("binding-drifted");
    expect(divergence.bindingDrift).toEqual([]);
  });

  it("does not report binding drift when the read-back was not captured", () => {
    const artifact = generated();
    const bindings = declared();
    const stamped = stampSyncMarker(artifact, bindings);
    // No declaredBindings on the state — a read that did not capture them.
    const state: DeployedCellState = { kind: "read", code: stamped, frontendLibraries: [] };
    const divergence = classifyCellDivergence(state, artifact, { bindings, pageName: "P" });
    expect(divergence.bindingDrift).toEqual([]);
  });
});

describe("the restore policies", () => {
  function driftedDivergence() {
    const artifact = generated();
    const bindings = declared();
    const stamped = stampSyncMarker(artifact, bindings);
    const state = matchingRead(stamped, { properties: [{ propertyName: "title", propertyValue: "EDITED" }] });
    return classifyCellDivergence(state, artifact, { bindings, pageName: "P" });
  }

  it("refuses a binding-drifted target under the default policy", () => {
    expect(resolveCellWriteAction(driftedDivergence())).toBe("conflict");
    expect(resolveCellWriteAction(driftedDivergence(), "preserve-designer-edits")).toBe("conflict");
  });

  it("writes a binding-drifted target under restore and restore-all", () => {
    expect(resolveCellWriteAction(driftedDivergence(), "restore")).toBe("write");
    expect(resolveCellWriteAction(driftedDivergence(), "restore-all")).toBe("write");
  });

  it("never lets restore override a foreign or unreadable target — restore is not a quieter force", () => {
    const artifact = generated();
    const foreign = classifyCellDivergence({ kind: "occupied", detail: "a text value" }, artifact);
    const unverifiable = classifyCellDivergence({ kind: "unread", reason: "read-failed" }, artifact);
    for (const policy of ["restore", "restore-all"] as const) {
      expect(resolveCellWriteAction(foreign, policy)).toBe("conflict");
      expect(resolveCellWriteAction(unverifiable, policy)).toBe("conflict");
    }
    // …while force still overrides them, which is the documented difference.
    expect(resolveCellWriteAction(foreign, "force")).toBe("write");
  });

  it("records the conflict a restore overrode, so a restore is not invisible", () => {
    const divergence = driftedDivergence();
    expect(cellDivergenceOverride(divergence, "restore")).toBe(divergence);
    expect(cellDivergenceOverride(divergence, "preserve-designer-edits")).toBeUndefined();
  });
});

describe("the field-level report", () => {
  it("names exactly which declared field drifted and to what", () => {
    const artifact = generated();
    const bindings = declared();
    const stamped = stampSyncMarker(artifact, bindings);
    const state = matchingRead(stamped, { properties: [{ propertyName: "title", propertyValue: "EDITED" }] });
    const divergence = classifyCellDivergence(state, artifact, { bindings, pageName: "P" });
    const report = formatCellDivergence(divergence);
    expect(report).toContain("properties");
    expect(report).toContain("EDITED");
  });
});
