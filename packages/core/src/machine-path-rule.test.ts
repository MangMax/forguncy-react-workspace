import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createCellRegistry, ForguncyConfigError } from "./cell-registry.ts";
import type { ConfigDiagnosticCode } from "./cell-registry.ts";
import { FGC_LOCK_SCHEMA_VERSION, forguncyTargetIdentity } from "./lock-types.ts";
import type { FgcLockDocument, LockedDependencyDecision } from "./lock-types.ts";
import { validateFgcLockDocument } from "./lock-validate.ts";
import { machineSpecificPathProblem } from "./portability.ts";

/**
 * One rule for "is this a machine-specific path?", asked of both documents that must obey it.
 *
 * Decision sources: GitHub Issues
 * - #154 — "refactor(core): one machine-specific-path rule for config and lock"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/154), under
 * - #152 — "spec: stabilise the current shape — single answers, single copies, narrow surfaces"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/152).
 *
 * ## Why the cases run through both validators
 *
 * Before #154 the question had two answers: `portability.ts` asked it with start-anchored
 * patterns, so a value *was* a path or was not, and `lock.ts` asked it with anywhere-in-string
 * patterns, so a path embedded in a fingerprint (`entry=/Users/x`) was caught there and missed
 * in a committed config. That is one question with two answers, and the user-visible defect is
 * that a config accepted by `forguncy.config` validation is the same non-portable value the
 * lock would refuse.
 *
 * So the table is asserted through the *public* validators — `createCellRegistry` for config
 * and `validateFgcLockDocument` for the lock — and not against a predicate alone. A test of
 * `machineSpecificPathProblem` would pass while either caller kept its own copy of the rule,
 * which is exactly the state this ticket removes.
 *
 * ## Where the value is placed, and why it does not matter
 *
 * Both walks are whole-document: every string in a config and every string in a lock is judged,
 * including fields added later. The value therefore goes into a free-form string field
 * (`runtime.projectAlias` on the config, `rationale` on the lock record) rather than into the
 * field the ticket happens to name, so a case measures the rule and not one field's own
 * validation. The ticket's own example (`entry=/Users/x`) is a *value*, and it is in the table.
 */
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "valid-multi");

/**
 * The base lock record the table's value is attached to.
 *
 * Clean by construction — a relative fingerprint, a spec URL and a repository-relative probe
 * reference — because a fixture that already tripped the rule would make every case pass.
 */
const inlineRecord: LockedDependencyDecision = {
  strategy: "inline",
  packageName: "es-toolkit",
  cellTarget: null,
  resolvedVersion: "1.39.8",
  probe: {
    status: "passed",
    fingerprint: "probe=inline-bundle;entry=src/cells/orders-table/App.tsx",
    versionIndependent: false,
  },
  target: forguncyTargetIdentity(),
  probedWith: { vitePlus: "0.3.2" },
  extension: null,
  rejectedCandidate: null,
  rationale: null,
  evidence: [
    { kind: "spec-issue", reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/8" },
    { kind: "probe", reference: "docs/probes/inline-es-toolkit.md" },
  ],
};

function lockWith(value: string): FgcLockDocument {
  return { schemaVersion: FGC_LOCK_SCHEMA_VERSION, decisions: [{ ...inlineRecord, rationale: value }] };
}

/** The codes config validation reports for a document carrying `value`. */
function configCodes(value: string): readonly ConfigDiagnosticCode[] {
  try {
    createCellRegistry(
      {
        runtime: { projectAlias: value },
        cells: { app: { entry: "./cells/app/src/index.ts", target: { pageName: "Page", cell: "A1" } } },
      },
      { root: PROJECT_ROOT, requireEntryFiles: false },
    );
    return [];
  } catch (error) {
    if (error instanceof ForguncyConfigError) {
      return error.codes;
    }
    throw error;
  }
}

/** Whether lock validation files the machine-path problem for a document carrying `value`. */
function lockRejects(value: string): boolean {
  return validateFgcLockDocument(lockWith(value)).some(problem => problem.includes("machine-specific absolute path"));
}

function configRejects(value: string): boolean {
  return configCodes(value).includes("machine-specific-path");
}

interface MachinePathCase {
  readonly value: string;
  /** The one answer both validators must give. */
  readonly machineSpecific: boolean;
}

const CASES: readonly MachinePathCase[] = [
  // Portable: URLs, repository-relative references and prose.
  { value: "https://github.com/Mang-X/forguncy-react-workspace/issues/8", machineSpecific: false },
  { value: "https://github.com/Mang-X/forguncy-react-workspace/issues/8 (see the probe)", machineSpecific: false },
  { value: "prose with a / separator in it", machineSpecific: false },
  { value: "./cells/app/src/index.ts", machineSpecific: false },
  { value: "docs/probes/inline-es-toolkit.md", machineSpecific: false },
  { value: "vite-plus@0.3.2;entry=src/cells/orders-table/App.tsx", machineSpecific: false },
  { value: "sha256:9f1c2b7d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091", machineSpecific: false },
  { value: "sales-portal", machineSpecific: false },
  { value: "销售订单", machineSpecific: false },

  // Machine-specific, whether bare or embedded in a larger value.
  { value: "/Users/mang/project/App.tsx", machineSpecific: true },
  { value: "entry=/Users/x", machineSpecific: true },
  { value: "entry=/home/ci/App.tsx", machineSpecific: true },
  { value: "C:\\Users\\mang\\App.tsx", machineSpecific: true },
  { value: "c:/repos/a.ts", machineSpecific: true },
  { value: "entry=C:/Users/mang/App.tsx", machineSpecific: true },
  { value: "\\\\build-server\\share\\App.tsx", machineSpecific: true },
  { value: "~/repos/a.ts", machineSpecific: true },
  { value: "file at ~/project/App.tsx", machineSpecific: true },
  { value: "notes: see /var/tmp/probe.json", machineSpecific: true },
  { value: "file:///Users/mang/project/App.tsx", machineSpecific: true },
  { value: "probe=x;entry=file:///Users/mang/project/App.tsx", machineSpecific: true },
];

describe("#154: one machine-specific-path rule for config and lock", () => {
  it("has clean base documents, so each case measures the value rather than the fixture", () => {
    // Without this the two verdict functions could both be constant and the table would pass
    // for the wrong reason.
    expect(configCodes("sales-portal")).toEqual([]);
    expect(validateFgcLockDocument(lockWith("sales-portal"))).toEqual([]);
  });

  it("gives config validation and lock validation the same verdict for every case", () => {
    for (const { value, machineSpecific } of CASES) {
      expect(machineSpecificPathProblem(value) !== undefined, `predicate: ${value}`).toBe(machineSpecific);
      expect(configRejects(value), `config: ${value}`).toBe(machineSpecific);
      expect(lockRejects(value), `lock: ${value}`).toBe(machineSpecific);
    }
  });

  it("rejects a path embedded inside a configuration value, not only a bare one", () => {
    // The defect #154 removes: this value *starts* with `entry=`, so the old start-anchored
    // config rule reported it as portable while the lock refused the identical string.
    expect(configRejects("entry=/Users/x")).toBe(true);
    expect(configCodes("entry=/Users/x")).toEqual(["machine-specific-path"]);
  });

  it("keeps https URLs and prose containing a spaced slash portable in both documents", () => {
    for (const value of ["https://example.test/issue/8", "chosen over the other one / alternative"]) {
      expect(configRejects(value), value).toBe(false);
      expect(lockRejects(value), value).toBe(false);
    }
  });
});
