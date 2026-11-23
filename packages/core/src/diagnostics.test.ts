import { describe, expect, it } from "vitest";

import {
  composeDiagnosticMessage,
  createDiagnosticFields,
  defineDiagnosticVocabulary,
  diagnosticDedupeKey,
} from "./diagnostics.ts";
import type { DiagnosticFields } from "./diagnostics.ts";

// A rule table shaped like the packages' own, so the assertions below are about the
// factory rather than about a fixture invented to fit it.
const RULES = {
  "alpha-broken": {
    code: "alpha-broken",
    states: "Alpha is broken.",
    remediation: "Fix alpha.",
    fixOwner: "cell-source",
    breaksGuarantees: ["alpha-holds"],
  },
  "beta-broken": {
    code: "beta-broken",
    states: "Beta is broken.",
    remediation: "Fix beta.",
    fixOwner: "dependency-decision",
    breaksGuarantees: [],
  },
} as const;

type TestCode = keyof typeof RULES;

const vocabulary = defineDiagnosticVocabulary<
  TestCode,
  (typeof RULES)[TestCode],
  DiagnosticFields<TestCode, string, string>,
  { readonly detail?: string }
>({
  rules: RULES,
  instance: input => createDiagnosticFields(input.rule, input.code, input.subject, input.detail),
  subjectOf: diagnostic => diagnostic.subject,
  format: (diagnostic, rule) => {
    void rule;
    return `[${diagnostic.code}] ${diagnostic.subject}: ${diagnostic.message} Fix (${diagnostic.fixOwner}): ${diagnostic.remediation}`;
  },
  emptyReport: "No test diagnostics.",
});

describe("diagnostic message composition", () => {
  it("appends an occurrence's detail to the rule's sentence", () => {
    expect(composeDiagnosticMessage({ states: "Alpha is broken." }, "at line 3")).toBe(
      "Alpha is broken. at line 3",
    );
  });

  it("states the rule alone when there is no detail", () => {
    expect(composeDiagnosticMessage({ states: "Alpha is broken." }, undefined)).toBe("Alpha is broken.");
  });
});

describe("diagnostic dedupe key", () => {
  it("separates code and subject so neither can imitate the other", () => {
    expect(diagnosticDedupeKey("a", "b")).not.toBe(diagnosticDedupeKey("a\u0000b", ""));
    expect(diagnosticDedupeKey("a", "b")).toBe("a\u0000b");
  });
});

describe("defineDiagnosticVocabulary", () => {
  it("builds an instance from the rule table", () => {
    expect(vocabulary.create("alpha-broken", "pkg")).toEqual({
      code: "alpha-broken",
      subject: "pkg",
      message: "Alpha is broken.",
      remediation: "Fix alpha.",
      fixOwner: "cell-source",
      breaksGuarantees: ["alpha-holds"],
    });
  });

  it("carries the occurrence's detail into the message, not over it", () => {
    expect(vocabulary.create("alpha-broken", "pkg", { detail: "It was imported twice." }).message).toBe(
      "Alpha is broken. It was imported twice.",
    );
  });

  it("looks a rule up by code", () => {
    expect(vocabulary.rule("beta-broken")).toBe(RULES["beta-broken"]);
  });

  it("collapses diagnostics that share a code and subject, keeping the first", () => {
    const first = vocabulary.create("alpha-broken", "pkg", { detail: "first" });
    const sameKey = vocabulary.create("alpha-broken", "pkg", { detail: "second" });
    const otherSubject = vocabulary.create("alpha-broken", "other");
    const otherCode = vocabulary.create("beta-broken", "pkg");

    expect(vocabulary.dedupe([first, sameKey, otherSubject, otherCode])).toEqual([
      first,
      otherSubject,
      otherCode,
    ]);
  });

  it("renders one line with the fix owner and the remediation", () => {
    expect(vocabulary.format(vocabulary.create("alpha-broken", "pkg"))).toBe(
      "[alpha-broken] pkg: Alpha is broken. Fix (cell-source): Fix alpha.",
    );
  });

  it("renders a block, and says so when there is nothing to report", () => {
    expect(vocabulary.formatAll([])).toBe("No test diagnostics.");
    expect(vocabulary.formatAll([vocabulary.create("alpha-broken", "pkg")])).toBe(
      "- [alpha-broken] pkg: Alpha is broken. Fix (cell-source): Fix alpha.",
    );
  });
});

describe("defineDiagnosticVocabulary with a package-specific instance", () => {
  // The host-bridge variant: its instance carries the offending value as `detail` and
  // its line names the rule's label rather than restating the sentence. The factory
  // still owns the rule lookup, so a code cannot reach a caller without its rule.
  const bridgeRules = {
    "host-missing": {
      code: "host-missing",
      label: "Host global missing",
      states: "A mapping's global was not present.",
      fixOwner: "host-environment",
    },
  } as const;
  type BridgeCode = keyof typeof bridgeRules;

  interface BridgeDiagnostic {
    readonly code: BridgeCode;
    readonly specifier: string;
    readonly detail: string;
  }

  const bridge = defineDiagnosticVocabulary<
    BridgeCode,
    (typeof bridgeRules)[BridgeCode],
    BridgeDiagnostic,
    { readonly detail: string }
  >({
    rules: bridgeRules,
    instance: input => ({ code: input.code, specifier: input.subject, detail: input.options.detail }),
    subjectOf: diagnostic => diagnostic.specifier,
    format: (diagnostic, rule) => `${diagnostic.specifier}: [${diagnostic.code}] ${rule.label} — ${diagnostic.detail}`,
    emptyReport: "No bridge diagnostics.",
  });

  it("keeps the package's own instance shape", () => {
    expect(bridge.create("host-missing", "react-dom", { detail: "not on the page" })).toEqual({
      code: "host-missing",
      specifier: "react-dom",
      detail: "not on the page",
    });
  });

  it("dedupes on the field the package names as its subject", () => {
    const a = bridge.create("host-missing", "react-dom", { detail: "one" });
    const b = bridge.create("host-missing", "react-dom", { detail: "two" });
    expect(bridge.dedupe([a, b])).toEqual([a]);
  });

  it("renders the package's own line", () => {
    expect(bridge.format(bridge.create("host-missing", "react-dom", { detail: "not on the page" }))).toBe(
      "react-dom: [host-missing] Host global missing — not on the page",
    );
  });
});
