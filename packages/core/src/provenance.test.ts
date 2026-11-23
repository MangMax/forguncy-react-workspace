import { describe, expect, it } from "vitest";

import type { ArchitectureDecisionSource } from "./governance.ts";
import { OWNERSHIP_AND_DEPENDENCY_DECISION, RUNTIME_CONTRACT_DECISION } from "./governance.ts";
import { defineDecisionProvenance } from "./provenance.ts";

const DOWNSTREAM: ArchitectureDecisionSource = {
  repository: "Mang-X/forguncy-react-workspace",
  issue: 42,
  title: "Spec: a downstream contract",
  url: "https://github.com/Mang-X/forguncy-react-workspace/issues/42",
};

describe("defineDecisionProvenance", () => {
  it("derives the short and repo-qualified references from the record", () => {
    const provenance = defineDecisionProvenance(DOWNSTREAM);

    expect(provenance.reference).toBe("#42");
    expect(provenance.qualifiedReference).toBe("Mang-X/forguncy-react-workspace#42");
  });

  it("derives the citation patterns from the record", () => {
    const { citationPatterns } = defineDecisionProvenance(DOWNSTREAM);

    expect(citationPatterns).toHaveLength(3);
    expect(citationPatterns.some(pattern => pattern.test("(see #42)"))).toBe(true);
    expect(citationPatterns.some(pattern => pattern.test("#420"))).toBe(false);
  });

  it("derives the governing line from the list it is given, in order", () => {
    const provenance = defineDecisionProvenance(DOWNSTREAM, [
      OWNERSHIP_AND_DEPENDENCY_DECISION,
      RUNTIME_CONTRACT_DECISION,
      DOWNSTREAM,
    ]);

    expect(provenance.governingSpecReferenceLine).toBe("Governing architecture Spec Issue(s): #4, #5, #42");
  });

  // A decision that is only cited (the workspace-graph implementation Issue) has no
  // governing line of its own, and the helper must not invent one for it.
  it("omits the governing line when no list is supplied", () => {
    expect(defineDecisionProvenance(DOWNSTREAM).governingSpecReferenceLine).toBeUndefined();
  });
});
