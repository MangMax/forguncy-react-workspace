/**
 * Two Cells, one package: what a lock record may and may not share.
 *
 * Decision source: GitHub Issue #96 — "证据回归：重测示例锁、验证多 Cell 记录并保留历史证据"
 * (https://github.com/MangMax/forguncy-react-workspace/issues/96), plan items 3 and 4. It is
 * the regression half of #95's cache/freshness fix: #95 made the *probe* stop answering from a
 * cache that no longer describes the tree, and this file pins the record-level rules that the
 * `record`/`status` commands rely on so that two records for one package can never answer for
 * each other.
 *
 * ## Why these cases are resolver-level and offline
 *
 * The end-to-end cases already live in the Skill's evals (`cap-e2e.test.ts` spawns the CLI
 * against a real project and runs a real Rolldown build, twice per Cell). They are the right
 * place to prove the wiring; they are a slow and indirect place to pin the *rules*. Every
 * assertion here is about a pure function the CLI also calls — `recordDependencyDecision`,
 * `assessLockDecision`, `compilationDependencies` — so a regression is named by the rule it
 * broke rather than by "the second build differed on this machine".
 *
 * ## The four properties, and the defect each one is aimed at
 *
 * 1. **A record is addressed by `(packageName, cellTarget)`, and the null record is a
 *    fallback, not a wildcard write target.** A cell that has its own record must never get the
 *    fallback, and a cell the lock says nothing about must get *nothing* rather than the
 *    adjacent Cell's record.
 * 2. **The cap is a fingerprint input, so two Cells' records for one package carry different
 *    fingerprints.** Moving one Cell's cap moves exactly one record.
 * 3. **Re-recording is keyed, ordered and idempotent.** Repeating an observation does not
 *    touch a byte; recording one Cell's new measurement does not move its sibling.
 * 4. **A strategy change replaces the record in place.** It never appends a second one, never
 *    inherits a rationale written for the old strategy, and never leaves the old
 *    strategy-specific measurement behind — a `replace` is a cache the compiler must not act
 *    on, while an `extension` is admitted only with its own evidence.
 *
 * The artifact-rejection cases extend the same keying rule to `artifactEvidence`: #77 keyed
 * replay by record identity, and this file pins that two Cells replay their own subject
 * decisions rather than sharing one. The install-graph case then draws the other boundary —
 * which staleness axes are per-package and which are per-resolution — because "only the
 * affected record moves" is only true of the first kind.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  ArtifactBudgetEvidence,
  FgcLockDocument,
  LockEnvironment,
  LockedDependencyDecision,
  ToolchainIdentity,
} from "@forguncy-react-workspace/core";
import {
  assessLockDecision,
  compareCodeUnits,
  forguncyTargetIdentity,
  resolveLockDecision,
  RUNTIME_CONTRACT_TARGET,
} from "@forguncy-react-workspace/core";

import type { DependencyDecisionUpdate } from "./internal.ts";
import {
  compilationDependencies,
  composeProbeFingerprint,
  localCompilationDependencies,
  readFgcLock,
  recordDependencyDecision,
  recordDependencyDecisions,
} from "./internal.ts";

const PACKAGE = "es-toolkit";
const CHART_PACKAGE = "@tanstack/react-query";

/**
 * The identity every record and environment in this file shares, so each case reports only the
 * axis it is about. Every component is present: an absent one is `unknown`, and unknown is
 * stale by design — a partial literal would make a case pass or fail for a reason it does not
 * name (#94).
 */
const FIXTURE_INSTALL_GRAPH = {
  lockfile: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  patches: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  configuration: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  installedTree: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
} as const;

const FIXTURE_TOOLCHAIN: ToolchainIdentity = {
  vitePlus: "0.3.2",
  rolldown: "1.2.9",
  node: "24.21.0",
  installGraph: FIXTURE_INSTALL_GRAPH,
};

/** The probe fingerprint a Cell with this cap composes. `null` is the un-scoped, uncapped run. */
function fingerprintFor(cap: number | null, entry: string = PACKAGE): string {
  return composeProbeFingerprint({
    probeId: "inline-bundle",
    entry,
    ...(cap === null ? {} : { budgetCharacters: cap }),
  }).fingerprint;
}

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fgc-multi-record-"));
}

function environmentFor(
  packageName: string,
  fingerprint: string,
  overrides: Partial<LockEnvironment> = {},
): LockEnvironment {
  return {
    resolvedVersions: { [packageName]: "1.39.8" },
    target: RUNTIME_CONTRACT_TARGET,
    toolchain: FIXTURE_TOOLCHAIN,
    probeFingerprints: { [packageName]: fingerprint },
    extensionVersions: {},
    extensionIdentities: {},
    ...overrides,
  };
}

/**
 * An `inline` observation a Cell could record.
 *
 * `target: forguncyTargetIdentity()` is the **caller asserting a runtime check ran**. It is
 * convenient for the projection cases below (the deployment gate requires it) and is not a
 * claim this file makes about any real product: the cases that are about an *unknown* runtime
 * identity deliberately omit it.
 */
function inlineUpdate(
  packageName: string,
  fingerprint: string,
  overrides: Partial<DependencyDecisionUpdate> = {},
): DependencyDecisionUpdate {
  return {
    decision: { strategy: "inline", packageName },
    probe: { status: "passed", fingerprint, versionIndependent: false },
    resolvedVersion: "1.39.8",
    probedWith: FIXTURE_TOOLCHAIN,
    target: forguncyTargetIdentity(),
    evidence: [{ kind: "probe", reference: "fgc-evidence/probe.json" }],
    ...overrides,
  };
}

function hostUpdate(
  packageName: string,
  fingerprint: string,
  overrides: Partial<DependencyDecisionUpdate> = {},
): DependencyDecisionUpdate {
  return inlineUpdate(packageName, fingerprint, {
    decision: { strategy: "host", packageName, globalName: "EsToolkit" },
    ...overrides,
  });
}

function replaceUpdate(
  packageName: string,
  fingerprint: string,
  overrides: Partial<DependencyDecisionUpdate> = {},
): DependencyDecisionUpdate {
  return {
    decision: {
      strategy: "replace",
      packageName,
      rejection: {
        kind: "technical",
        code: "platform-api-unavailable",
        summary: "The package reaches for a Node builtin that no browser provides.",
        evidence: ["probe: graph.node-only-specifiers"],
        remediation: "Use a browser-first alternative.",
      },
      alternatives: ["a browser-first utility library"],
    },
    probe: { status: "failed", fingerprint, versionIndependent: false },
    resolvedVersion: null,
    probedWith: FIXTURE_TOOLCHAIN,
    target: null,
    rejectedCandidate: { version: "1.39.8" },
    rationale: "The package needs a runtime API the browser does not provide.",
    evidence: [{ kind: "probe", reference: "fgc-evidence/probe.json" }],
    ...overrides,
  };
}

function artifactRejectionEvidence(
  compileFingerprint: string,
  subjectDecision: ArtifactBudgetEvidence["subjectDecision"],
  cap: number,
): ArtifactBudgetEvidence {
  return {
    compileFingerprint,
    subjectDecision,
    subjectRenderedCharacters: cap + 90_000,
    codeCharacters: cap + 100_000,
    budgetCharacters: cap,
  };
}

function artifactRejectionUpdate(
  cellTarget: string,
  cap: number,
  artifactEvidence: ArtifactBudgetEvidence,
): DependencyDecisionUpdate {
  return {
    decision: {
      strategy: "replace",
      packageName: PACKAGE,
      rejection: {
        kind: "technical",
        code: "cell-code-budget-exceeded",
        summary: "The composed Cell is over this Cell's declared cap.",
        evidence: ["compile: codeCharacters > budgetCharacters"],
        remediation: "Evaluate a smaller alternative.",
      },
      alternatives: ["a lighter utility library"],
      // The compile evidence belongs to the *decision*, not to the lock update: it is the
      // evidence the rejection cites, and the merge takes the decision as the strategy says it.
      artifactEvidence,
    },
    cellTarget,
    probe: { status: "passed", fingerprint: fingerprintFor(cap), versionIndependent: false },
    resolvedVersion: null,
    probedWith: FIXTURE_TOOLCHAIN,
    target: null,
    rejectedCandidate: { version: "1.39.8" },
    rationale: "This Cell is over its cap and this package is what puts it there.",
    evidence: [{ kind: "probe", reference: "fgc-evidence/probe.json" }],
  };
}

function recordFor(lock: FgcLockDocument, cellTarget: string | null): LockedDependencyDecision {
  const record = lock.decisions.find(
    candidate => candidate.packageName === PACKAGE && candidate.cellTarget === cellTarget,
  );
  if (record === undefined) {
    throw new Error(`no ${PACKAGE} record for cell ${String(cellTarget)}`);
  }
  return record;
}

/** The compile evidence of a `replace` record, narrowed rather than cast. */
function artifactEvidenceOf(lock: FgcLockDocument, cellTarget: string): ArtifactBudgetEvidence {
  const record = recordFor(lock, cellTarget);
  if (record.strategy !== "replace") {
    throw new Error(`the ${cellTarget} record is "${record.strategy}", not a rejection`);
  }
  const evidence = record.artifactEvidence;
  if (evidence === undefined) {
    throw new Error(`the ${cellTarget} rejection records no compile evidence`);
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// 1. A cell-specific record and the target-independent fallback
// ---------------------------------------------------------------------------

describe("a cell-specific record and the null fallback", () => {
  it("resolves each Cell to its own record, and only unnamed Cells to the fallback", async () => {
    const root = await project();
    const fingerprint = fingerprintFor(null);

    await recordDependencyDecision(root, hostUpdate(PACKAGE, fingerprint));
    await recordDependencyDecision(root, inlineUpdate(PACKAGE, fingerprint, { cellTarget: "alpha" }));
    const lock = await readFgcLock(root);

    // Two records for one package, one per key — the cell-specific write did not replace the
    // fallback and did not become a second record for the same Cell. Ordered by the repository's
    // code-unit comparator rather than a bare `.sort()`: `cellTarget` is `string | null`, so a
    // default sort would compare its stringified form.
    const byCellTarget = (left: string | null, right: string | null): number =>
      compareCodeUnits(left ?? "", right ?? "");
    expect(lock.decisions.map(record => record.cellTarget).sort(byCellTarget)).toEqual(
      [null, "alpha"].sort(byCellTarget),
    );
    expect(resolveLockDecision(lock, { packageName: PACKAGE, cellTarget: "alpha" }, environmentFor(PACKAGE, fingerprint)).record?.strategy).toBe(
      "inline",
    );
    expect(resolveLockDecision(lock, { packageName: PACKAGE, cellTarget: "beta" }, environmentFor(PACKAGE, fingerprint)).record?.strategy).toBe(
      "host",
    );

    // The compiler projection uses the same precedence: an exact record wins, the fallback
    // answers the Cells that declare nothing, and a Cell-specific record is never handed to a
    // *different* Cell.
    expect(compilationDependencies(lock, environmentFor(PACKAGE, fingerprint), { cellTarget: "alpha" }).dependencies).toEqual([
      { strategy: "inline", packageName: PACKAGE },
    ]);
    expect(compilationDependencies(lock, environmentFor(PACKAGE, fingerprint), { cellTarget: "beta" }).dependencies).toEqual([
      { strategy: "host", packageName: PACKAGE, globalName: "EsToolkit" },
    ]);

    // The lock decides only `alpha` here. `beta` is not "withheld" — there is no decision about
    // it at all — so the projection contributes nothing and reports no problem. The Cell's own
    // import audit (#6) is what notices an undecided dependency.
    const alphaOnly: FgcLockDocument = {
      ...lock,
      decisions: lock.decisions.filter(record => record.cellTarget === "alpha"),
    };
    expect(compilationDependencies(alphaOnly, environmentFor(PACKAGE, fingerprint), { cellTarget: "beta" })).toEqual({
      dependencies: [],
      withheld: [],
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Two Cells, two caps
// ---------------------------------------------------------------------------

describe("two Cells with different declared caps", () => {
  it("composes one fingerprint per cap, and moving one cap moves exactly one record", async () => {
    const root = await project();
    const alphaCap = 900_000;
    const betaCap = 950_000;
    const alphaFingerprint = fingerprintFor(alphaCap);
    const betaFingerprint = fingerprintFor(betaCap);
    expect(alphaFingerprint).not.toBe(betaFingerprint);

    const { lock } = await recordDependencyDecisions(root, [
      inlineUpdate(PACKAGE, alphaFingerprint, { cellTarget: "alpha" }),
      inlineUpdate(PACKAGE, betaFingerprint, { cellTarget: "beta" }),
    ]);

    expect(recordFor(lock, "alpha").probe.fingerprint).toBe(alphaFingerprint);
    expect(recordFor(lock, "beta").probe.fingerprint).toBe(betaFingerprint);

    // Each record is assessed against **its own** fingerprint. A single package-keyed map could
    // hold only one of the two, which is the defect #77 round 7 fixed in `status`.
    expect(assessLockDecision(recordFor(lock, "alpha"), environmentFor(PACKAGE, alphaFingerprint)).freshness).toBe("fresh");
    expect(assessLockDecision(recordFor(lock, "beta"), environmentFor(PACKAGE, betaFingerprint)).freshness).toBe("fresh");

    // The alpha cap moves to 910_000. Only alpha's fingerprint changes.
    const movedAlpha = fingerprintFor(910_000);
    const alphaAfterMove = assessLockDecision(recordFor(lock, "alpha"), environmentFor(PACKAGE, movedAlpha));
    expect(alphaAfterMove.freshness).toBe("stale");
    expect(alphaAfterMove.stalenessReasons).toEqual(["probe-fingerprint-changed"]);

    const betaAfterMove = assessLockDecision(recordFor(lock, "beta"), environmentFor(PACKAGE, betaFingerprint));
    expect(betaAfterMove.freshness).toBe("fresh");
    expect(betaAfterMove.stalenessReasons).toEqual([]);
  });

  it("does not let one Cell's cap answer for the other in the local projection", async () => {
    const root = await project();
    const alphaFingerprint = fingerprintFor(900_000);
    const betaFingerprint = fingerprintFor(950_000);

    const { lock } = await recordDependencyDecisions(root, [
      inlineUpdate(PACKAGE, alphaFingerprint, { cellTarget: "alpha" }),
      inlineUpdate(PACKAGE, betaFingerprint, { cellTarget: "beta" }),
    ]);

    // The local projection is freshness-only, so a locally observable cap move still withholds.
    // Assessed with alpha's *new* fingerprint while the lock still names the old one; the target
    // stays current so the only reason reported is the cap this case is about (the projection
    // relaxes the runtime *claim*, not the target axis).
    const environment = environmentFor(PACKAGE, fingerprintFor(910_000));
    expect(localCompilationDependencies(lock, environment, { cellTarget: "alpha" }).withheld).toEqual([
      {
        packageName: PACKAGE,
        strategy: "inline",
        reason: "not-verified",
        stalenessReasons: ["probe-fingerprint-changed"],
        realRuntimeValidation: "validated",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. Re-recording
// ---------------------------------------------------------------------------

describe("re-recording one record", () => {
  it("leaves the lock byte-identical when the observation is unchanged", async () => {
    const root = await project();
    const alphaFingerprint = fingerprintFor(900_000);
    const betaFingerprint = fingerprintFor(950_000);
    const alpha = inlineUpdate(PACKAGE, alphaFingerprint, { cellTarget: "alpha" });
    const beta = inlineUpdate(PACKAGE, betaFingerprint, { cellTarget: "beta" });

    await recordDependencyDecisions(root, [alpha, beta]);
    const before = await readFile(join(root, "fgc.lock.json"), "utf8");

    // Recording one Cell again must not reorder the lock, duplicate a link, or restate the
    // fallback — canonical writes are what makes a re-run show up as no diff at all.
    await recordDependencyDecision(root, alpha);
    expect(await readFile(join(root, "fgc.lock.json"), "utf8")).toBe(before);
  });

  it("updates one Cell's measurement without moving its sibling", async () => {
    const root = await project();
    const alphaFingerprint = fingerprintFor(900_000);
    const betaFingerprint = fingerprintFor(950_000);

    await recordDependencyDecisions(root, [
      inlineUpdate(PACKAGE, alphaFingerprint, { cellTarget: "alpha" }),
      inlineUpdate(PACKAGE, betaFingerprint, { cellTarget: "beta" }),
    ]);
    const before = await readFgcLock(root);
    const betaBefore = recordFor(before, "beta");

    // A new measurement for alpha: the declared cap moved, so the composed fingerprint did.
    const alphaAfterMove = fingerprintFor(910_000);
    const { lock } = await recordDependencyDecision(
      root,
      inlineUpdate(PACKAGE, alphaAfterMove, { cellTarget: "alpha" }),
    );

    expect(recordFor(lock, "alpha").probe.fingerprint).toBe(alphaAfterMove);
    // Byte-for-byte the same record: a re-record is keyed, so the sibling cannot inherit the
    // new fingerprint, version or measurement.
    expect(recordFor(lock, "beta")).toEqual(betaBefore);

    // And the two assessments stay separate immediately after the write: the writer's own record
    // is fresh under the environment it was measured in, the sibling under its own.
    expect(assessLockDecision(recordFor(lock, "alpha"), environmentFor(PACKAGE, alphaAfterMove)).freshness).toBe("fresh");
    expect(assessLockDecision(recordFor(lock, "beta"), environmentFor(PACKAGE, betaFingerprint)).freshness).toBe("fresh");
  });
});

// ---------------------------------------------------------------------------
// 4. Strategy changes
// ---------------------------------------------------------------------------

describe("a strategy change replaces the record in place", () => {
  it("does not append a second record, and does not carry the old strategy's rationale", async () => {
    const root = await project();
    const fingerprint = fingerprintFor(null);

    await recordDependencyDecision(
      root,
      inlineUpdate(PACKAGE, fingerprint, {
        cellTarget: "alpha",
        // `inline` may carry a note; the point is that it belongs to the inline decision.
        rationale: "Every Cell in this project formats dates.",
      }),
    );

    // inline -> replace. The rejection is a different reason, so the update supplies its own.
    const replaced = await recordDependencyDecision(root, replaceUpdate(PACKAGE, fingerprint, { cellTarget: "alpha" }));

    const sameKey = replaced.lock.decisions.filter(
      record => record.packageName === PACKAGE && record.cellTarget === "alpha",
    );
    expect(sameKey).toHaveLength(1);
    expect(sameKey[0]?.strategy).toBe("replace");
    expect(sameKey[0]?.rationale).toBe("The package needs a runtime API the browser does not provide.");
    // The old strategy's measurement is not evidence about this one: a `replace` records no
    // resolved version, and the candidate that failed goes in `rejectedCandidate`.
    expect(sameKey[0]?.resolvedVersion).toBeNull();
    expect(sameKey[0]?.rejectedCandidate).toEqual({ version: "1.39.8" });
  });

  it("withholds a fresh rejection as a cache, and admits the strategy it is replaced by", async () => {
    const root = await project();
    const fingerprint = fingerprintFor(null);
    const environment = environmentFor(PACKAGE, fingerprint);

    const { lock: rejected } = await recordDependencyDecision(
      root,
      replaceUpdate(PACKAGE, fingerprint, { cellTarget: "alpha" }),
    );
    expect(assessLockDecision(recordFor(rejected, "alpha"), environment).freshness).toBe("fresh");
    // Rule 4 of #8: a rejection is an Agent cache, not a dependency — the compiler must not act
    // on it even though it is fresh.
    expect(compilationDependencies(rejected, environment, { cellTarget: "alpha" })).toEqual({
      dependencies: [],
      withheld: [{ packageName: PACKAGE, strategy: "replace", reason: "replace-cache" }],
    });

    // replace -> extension. The new strategy owns its own evidence and rationale; it is admitted
    // only when the extension it names is the one the page reports.
    const extensionFingerprint = fingerprintFor(null, CHART_PACKAGE);
    const { lock: extended } = await recordDependencyDecision(root, {
      decision: {
        strategy: "extension",
        packageName: PACKAGE,
        libraryId: "tanstack-query",
        globalName: "TanStackQuery",
      },
      cellTarget: "alpha",
      probe: { status: "passed", fingerprint: extensionFingerprint, versionIndependent: false },
      resolvedVersion: "1.39.8",
      probedWith: FIXTURE_TOOLCHAIN,
      target: forguncyTargetIdentity(),
      extension: { version: "5.102.8", identity: "sha256:extension" },
      rationale: "A bundled copy would give every Cell its own cache, so the shared global is required.",
      evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/report.md" }],
    });

    const extensionEnvironment = environmentFor(PACKAGE, extensionFingerprint, {
      extensionVersions: { "tanstack-query": "5.102.8" },
      extensionIdentities: { "tanstack-query": "sha256:extension" },
    });
    expect(extended.decisions.filter(record => record.packageName === PACKAGE)).toHaveLength(1);
    expect(compilationDependencies(extended, extensionEnvironment, { cellTarget: "alpha" }).dependencies).toEqual([
      { strategy: "extension", packageName: PACKAGE, libraryId: "tanstack-query", globalName: "TanStackQuery" },
    ]);

    // extension -> inline: the extension's justification is dropped rather than attached to a
    // strategy nobody wrote it for, and the record count is still one.
    const { lock: backToInline } = await recordDependencyDecision(
      root,
      inlineUpdate(PACKAGE, fingerprint, { cellTarget: "alpha", target: undefined }),
    );
    expect(backToInline.decisions.filter(record => record.packageName === PACKAGE)).toHaveLength(1);
    expect(recordFor(backToInline, "alpha").strategy).toBe("inline");
    expect(recordFor(backToInline, "alpha").rationale).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Artifact rejections replay per record
// ---------------------------------------------------------------------------

describe("artifact-rejection evidence is replayed per record", () => {
  it("keeps each Cell's subject decision and invalidates only the Cell whose compile moved", async () => {
    const root = await project();
    const alphaCap = 100_000;
    const betaCap = 120_000;
    const alphaCompile = "cell=alpha;entry=v1";
    const betaCompile = "cell=beta;entry=v1";

    const { lock } = await recordDependencyDecisions(root, [
      artifactRejectionUpdate(
        "alpha",
        alphaCap,
        artifactRejectionEvidence(alphaCompile, { strategy: "inline" }, alphaCap),
      ),
      // A different subject decision on purpose: the replay input is a property of the record,
      // and a shared one would replay beta's Cell with alpha's pre-rejection decision.
      artifactRejectionUpdate(
        "beta",
        betaCap,
        artifactRejectionEvidence(betaCompile, { strategy: "host", globalName: "EsToolkit" }, betaCap),
      ),
    ]);

    expect(artifactEvidenceOf(lock, "alpha").subjectDecision).toEqual({ strategy: "inline" });
    expect(artifactEvidenceOf(lock, "beta").subjectDecision).toEqual({ strategy: "host", globalName: "EsToolkit" });

    // One environment entry per record identity — the same keying `status` rebuilds (#77 round 7).
    const compileEnvironment = environmentFor(PACKAGE, fingerprintFor(alphaCap), {
      artifactFingerprints: {
        [`${PACKAGE}\u0000alpha`]: {
          fingerprint: alphaCompile,
          codeCharacters: alphaCap + 100_000,
          budgetCharacters: alphaCap,
          subjectRenderedCharacters: alphaCap + 90_000,
        },
        [`${PACKAGE}\u0000beta`]: {
          fingerprint: betaCompile,
          codeCharacters: betaCap + 100_000,
          budgetCharacters: betaCap,
          subjectRenderedCharacters: betaCap + 90_000,
        },
      },
    });

    for (const [cell, fingerprint] of [
      ["alpha", fingerprintFor(alphaCap)],
      ["beta", fingerprintFor(betaCap)],
    ] as const) {
      const record = recordFor(lock, cell);
      const assessment = assessLockDecision(record, {
        ...compileEnvironment,
        probeFingerprints: { [PACKAGE]: fingerprint },
      });
      expect(assessment.stalenessReasons.filter(reason => reason.startsWith("artifact-"))).toEqual([]);
    }

    // A transitive source change in alpha's Cell composes a different artifact. Only alpha's
    // record may report it; beta's compile did not move.
    const alphaMoved = assessLockDecision(recordFor(lock, "alpha"), {
      ...compileEnvironment,
      probeFingerprints: { [PACKAGE]: fingerprintFor(alphaCap) },
      artifactFingerprints: {
        [`${PACKAGE}\u0000alpha`]: {
          fingerprint: "cell=alpha;entry=v2",
          codeCharacters: alphaCap + 100_000,
          budgetCharacters: alphaCap,
          subjectRenderedCharacters: alphaCap + 90_000,
        },
        [`${PACKAGE}\u0000beta`]: {
          fingerprint: betaCompile,
          codeCharacters: betaCap + 100_000,
          budgetCharacters: betaCap,
          subjectRenderedCharacters: betaCap + 90_000,
        },
      },
    });
    expect(alphaMoved.stalenessReasons).toEqual(["artifact-compile-changed"]);

    const betaUnmoved = assessLockDecision(recordFor(lock, "beta"), {
      ...compileEnvironment,
      probeFingerprints: { [PACKAGE]: fingerprintFor(betaCap) },
      artifactFingerprints: {
        [`${PACKAGE}\u0000alpha`]: {
          fingerprint: "cell=alpha;entry=v2",
          codeCharacters: alphaCap + 100_000,
          budgetCharacters: alphaCap,
          subjectRenderedCharacters: alphaCap + 90_000,
        },
        [`${PACKAGE}\u0000beta`]: {
          fingerprint: betaCompile,
          codeCharacters: betaCap + 100_000,
          budgetCharacters: betaCap,
          subjectRenderedCharacters: betaCap + 90_000,
        },
      },
    });
    expect(betaUnmoved.stalenessReasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. Which records an install-graph move reaches
// ---------------------------------------------------------------------------

describe("an install-graph move", () => {
  it("reaches every record, while a package version move reaches only that package", async () => {
    const root = await project();
    const utilityFingerprint = fingerprintFor(null);
    const chartFingerprint = fingerprintFor(null, CHART_PACKAGE);

    const { lock } = await recordDependencyDecisions(root, [
      inlineUpdate(PACKAGE, utilityFingerprint),
      inlineUpdate(CHART_PACKAGE, chartFingerprint, { resolvedVersion: "5.102.8" }),
    ]);

    const baseEnvironment = (overrides: Partial<LockEnvironment> = {}): LockEnvironment => ({
      resolvedVersions: { [PACKAGE]: "1.39.8", [CHART_PACKAGE]: "5.102.8" },
      target: RUNTIME_CONTRACT_TARGET,
      toolchain: FIXTURE_TOOLCHAIN,
      probeFingerprints: { [PACKAGE]: utilityFingerprint, [CHART_PACKAGE]: chartFingerprint },
      extensionVersions: {},
      extensionIdentities: {},
      ...overrides,
    });

    const utilityRecord = lock.decisions.find(record => record.packageName === PACKAGE);
    const chartRecord = lock.decisions.find(record => record.packageName === CHART_PACKAGE);
    if (utilityRecord === undefined || chartRecord === undefined) {
      throw new Error("the fixture did not record both packages");
    }

    expect(assessLockDecision(utilityRecord, baseEnvironment()).freshness).toBe("fresh");
    expect(assessLockDecision(chartRecord, baseEnvironment()).freshness).toBe("fresh");

    // A resolved-version move is scoped to the package the record names: the other record's
    // inputs did not change. This is the contrast that makes the next assertion meaningful.
    const movedVersion = baseEnvironment({
      resolvedVersions: { [PACKAGE]: "1.40.0", [CHART_PACKAGE]: "5.102.8" },
    });
    expect(assessLockDecision(utilityRecord, movedVersion).stalenessReasons).toEqual(["package-version-changed"]);
    expect(assessLockDecision(chartRecord, movedVersion).stalenessReasons).toEqual([]);

    // An install-graph move is not scoped to one package: it says the whole resolution changed
    // (#94), so every record measured against it is stale. A record cannot stay fresh by naming
    // a package whose own version did not move.
    const movedGraph = baseEnvironment({
      toolchain: {
        ...FIXTURE_TOOLCHAIN,
        installGraph: {
          ...FIXTURE_INSTALL_GRAPH,
          lockfile: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
        },
      },
    });
    expect(assessLockDecision(utilityRecord, movedGraph).stalenessReasons).toEqual(["install-graph-changed"]);
    expect(assessLockDecision(chartRecord, movedGraph).stalenessReasons).toEqual(["install-graph-changed"]);
  });
});

// ---------------------------------------------------------------------------
// 7. An unknown runtime identity never self-fills `target`
// ---------------------------------------------------------------------------

describe("an unknown real-runtime identity", () => {
  it("is cleared by a measurement that did not observe one, and never becomes validated", async () => {
    const root = await project();
    const fingerprint = fingerprintFor(null);

    await recordDependencyDecision(root, inlineUpdate(PACKAGE, fingerprint));

    // A re-probe that ran no runtime check observes no runtime. The merge takes the measurement
    // it is given (null), rather than keeping the previous target: reporting a runtime nobody
    // observed is the failure #8's two axes exist to prevent.
    const { record, lock } = await recordDependencyDecision(
      root,
      inlineUpdate(PACKAGE, fingerprint, { target: undefined }),
    );
    expect(record.target).toBeNull();

    // The *environment* naming the current contract target cannot fill it in either: the
    // real-runtime axis answers from the record, so a local rerun stays `not-validated` and the
    // deployment gate withholds it.
    const environment = environmentFor(PACKAGE, fingerprint);
    const assessment = assessLockDecision(record, environment);
    expect(assessment.freshness).toBe("fresh");
    expect(assessment.realRuntimeValidation).toBe("not-validated");
    expect(compilationDependencies(lock, environment)).toEqual({
      dependencies: [],
      withheld: [
        {
          packageName: PACKAGE,
          strategy: "inline",
          reason: "not-verified",
          stalenessReasons: [],
          realRuntimeValidation: "not-validated",
        },
      ],
    });
  });
});
