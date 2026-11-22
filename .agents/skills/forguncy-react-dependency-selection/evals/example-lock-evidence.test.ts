/**
 * The repository's example locks and evidence, checked offline on every CI run.
 *
 * Decision source: GitHub Issue #96 — "证据回归：重测示例锁、验证多 Cell 记录并保留历史证据"
 * (https://github.com/MangMax/forguncy-react-workspace/issues/96), plan items 1, 2 and 5 (the
 * offline CI check) and acceptance items 1 and 4. It is the example-facing half of #95: that Issue made the probe
 * refuse a stale cache; this file makes the *committed citations* answer the same question
 * without re-running a build, so a fresh checkout cannot carry a lock whose evidence has gone
 * missing or been edited.
 *
 * ## Why this is a repository-wide inventory and not a check on one file
 *
 * A per-example assertion can only say "the file somebody remembered to list is fine". The
 * failure this Issue is aimed at is the opposite: an example starts carrying a lock (or an
 * evidence directory) and nothing states what that file *is* — current, stale, or historical
 * evidence that can no longer be produced on this machine. So the test enumerates
 * `examples/*`, and every entry's classification is declared here. A new example with a lock
 * fails until someone decides what it means; a lock that only a different build can validate
 * cannot drift into "current" by being edited.
 *
 * ## The three separate claims, and why they are separate
 *
 * 1. **A citation resolves and still hashes to its name.** Content addressing is what makes
 *    "delete the inconvenient evidence and re-record" detectable: a file whose bytes changed
 *    no longer matches the `sha256` in its filename, and a file that is gone is a citation to
 *    nothing. Both are blockers in `status`; both must fail here, offline.
 * 2. **The evidence agrees with the record that cites it.** A lock can cite a perfectly valid
 *    report for a *different* package version or a *different* Forguncy build; the content
 *    address would still verify. So the report's own `environment` is compared against the
 *    record's claim.
 * 3. **Historical real-runtime evidence is preserved, not re-labelled.** The
 *    `extension-query` record was validated on Forguncy `12.0.100.0`; the repository now
 *    targets `12.0.101.0`, and re-running that check needs a real designer. The record keeps
 *    its target and its evidence, reports `stale` (`forguncy-target-changed`) against the
 *    current contract, and is *not* admitted by the deployment gate. That is the honest state,
 *    and this file is where it is pinned — re-recording on 12.0.101.0 would require changing
 *    the declared historical identity below, which is exactly the deliberate act it should be.
 *
 * ## What is deliberately not done here
 *
 * No probe is executed and no Cell is compiled. That is the point: an offline check has to be
 * able to say "the citation is intact" without the machine being able to reproduce the
 * measurement. It does *not* say the measurement still holds — `status` re-runs the probe for
 * that, and neither this file nor a green `vp test` is Forguncy runtime validation
 * (AGENTS.md rules 6–7).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  DecisionEvidenceLink,
  FgcLockDocument,
  ForguncyTargetIdentity,
  LockEnvironment,
  LockedDependencyDecision,
  RuntimeContractTarget,
  ToolchainIdentity,
} from "../../../../packages/core/src/index.ts";
import {
  assessLockDecision,
  forguncyTargetIdentity,
  isRepositoryRelativeReference,
  matchesForguncyTargetIdentity,
  parseProbeReport,
  RUNTIME_CONTRACT_TARGET,
  serializeProbeReport,
} from "../../../../packages/core/src/index.ts";
import {
  compilationDependencies,
  composeProbeFingerprint,
  localCompilationDependencies,
  readFgcLock,
} from "../../../../packages/dependency-resolver/src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..", "..");
const EXAMPLES_ROOT = join(REPOSITORY_ROOT, "examples");

/** `fgc-evidence/<sha256-of-canonical-report>.json`, the address `record` writes. */
const CONTENT_ADDRESSED_EVIDENCE = /^fgc-evidence\/([0-9a-f]{64})\.json$/;

/**
 * What each example's dependency evidence *is*.
 *
 * `none` is a classification, not an omission: an example that compiles framework APIs, host
 * globals, workspace source or a test fixture has no dependency selection to record, and a lock
 * added to it later has to be classified before this suite will pass.
 */
type ExampleEvidence =
  | { readonly kind: "none"; readonly rationale: string }
  | {
      readonly kind: "recorded";
      /** `historical-real-runtime` means it names a build this machine cannot re-validate. */
      readonly status: "historical-real-runtime" | "current";
      readonly rationale: string;
    };

const EXAMPLE_INVENTORY: Readonly<Record<string, ExampleEvidence>> = {
  "dev-harness": {
    kind: "none",
    rationale:
      "The local loop's example: it consumes the runtime façade as workspace source and supplies `react` through the dev harness, so there is no package selection to record.",
  },
  "extension-custom": {
    kind: "none",
    rationale:
      "Its chain records into a scratch tree per test (#87), because the extension identity is a declared placeholder and the package is deliberately not installed. A committed lock would make an unverified identity look like a decision.",
  },
  "extension-query": {
    kind: "recorded",
    status: "historical-real-runtime",
    rationale:
      "The #13 `extension` PoC: @tanstack/react-query 5.102.8, validated on a real Forguncy 12.0.100.0 page. The repository now targets 12.0.101.0; re-validation needs a designer and is owed, so the record keeps its historical target and citations.",
  },
  "host-antd": {
    kind: "none",
    rationale:
      "Both packages are decided `host` by the bridge's interception, and the example deliberately installs neither; there is no per-project decision and therefore no lock.",
  },
  "inline-es-toolkit": {
    kind: "none",
    rationale:
      "An `inline` proof: the compiler flattens the package's own source into the Cell. The behavior is asserted by the example's artifact tests, not by a recorded decision.",
  },
  "probe-proving-cases": {
    kind: "none",
    rationale:
      "The Skill's proving fixture. Every `record` runs against a scratch root under its git-ignored `.fgc/`, so no committed lock exists by design (#91).",
  },
  "runtime-facade": {
    kind: "none",
    rationale:
      "Imports the runtime façade as workspace source; the graph is workspace source, which never receives a dependency decision.",
  },
  "workspace-package": {
    kind: "none",
    rationale:
      "The workspace-source PoC: `@app/*` packages are flattened per Cell and never appear in `frontendLibraries`, so no decision is recorded.",
  },
};

/**
 * The historical record `extension-query` carries, pinned by value.
 *
 * Pinned rather than read back and trusted: a test that only asserted "the target differs from
 * the current contract" would pass after someone re-wrote the record as any *other* build. The
 * point of these constants is that the historical claim can only change deliberately, in a diff
 * a reviewer sees.
 */
const HISTORICAL_RECORD = {
  example: "extension-query",
  packageName: "@tanstack/react-query",
  resolvedVersion: "5.102.8",
  /**
   * Exactly the fingerprint `composeProbeFingerprint` produces today for the record's declared
   * inputs — the probe id, the entry and no imports or cap. The lock's probe inputs have not
   * moved; what moved is the install graph, the toolchain and the product build.
   */
  probeFingerprint:
    'probe="inline-bundle";entry="@tanstack/react-query";analysis=14;config={};bundler={"attachDebugInfo":"none","codeSplitting":"false","format":"iife","jsx":"react-jsx","platform":"browser"}',
  target: {
    product: "Forguncy",
    productVersion: "12.0.100.0",
    productBuild: "12.0.100.0+3d6e56feb0e449ed1cc71cc44d9f34060a06f623",
    hostReactVersion: "19.2.7",
  },
  /**
   * The four content-addressed reports the record cites, in filename order.
   *
   * They are *not* four copies of one report: they are snapshots from the probe's revisions
   * around the retracted "size bound" claim (#79), two carrying `size.bound` and one
   * `size.estimateBias`. Keeping them is deliberate — they are the measured history the record
   * rests on, and rewriting either the facts or the filenames would be falsifying evidence.
   */
  evidenceFiles: [
    "47198a7a4ab60d414b96841669d943b6bbde10cd96ace3925c3bf5cb2679f22f.json",
    "9ca557283524375a45ff32b47064b3e1a8ec9694f16eab168794d3cfe43324ea.json",
    "b184efbf0a30fe97f98a90e58904166b5b027b2b02ad8c522d018d394c0f5fe9.json",
    "f1de4e0da600eb6efc29c51bfca32c2b53a6b5ac2e4a2312deb87b21ab66637d.json",
  ],
} as const satisfies {
  readonly example: string;
  readonly packageName: string;
  readonly resolvedVersion: string;
  readonly probeFingerprint: string;
  readonly target: ForguncyTargetIdentity;
  readonly evidenceFiles: readonly string[];
};

const exampleDirectories = readdirSync(EXAMPLES_ROOT, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();

const recordedExamples = Object.entries(EXAMPLE_INVENTORY)
  .filter(([, evidence]) => evidence.kind === "recorded")
  .map(([directory]) => directory)
  .sort();

function exampleRoot(directory: string): string {
  return join(EXAMPLES_ROOT, directory);
}

function lockPathOf(directory: string): string {
  return join(exampleRoot(directory), "fgc.lock.json");
}

/** The local path an evidence reference names, or null when it is a URL. */
function localReferencePath(directory: string, reference: string): string | null {
  if (!isRepositoryRelativeReference(reference)) {
    return null;
  }
  return join(exampleRoot(directory), ...reference.trim().split(/[\\/]/));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function recordsOf(lock: FgcLockDocument): readonly LockedDependencyDecision[] {
  return lock.decisions;
}

function evidenceReferences(record: LockedDependencyDecision): readonly string[] {
  return record.evidence.map((link: DecisionEvidenceLink) => link.reference);
}

/**
 * A `LockEnvironment` in which every axis except `target` is supplied **from the record**.
 *
 * That is the only construction under which the target reason can be read alone. Re-detecting
 * the toolchain or install graph here would make this file fail whenever an unrelated PR moved
 * the repository's dependency graph, reporting a fact the case is not about — the same trade the
 * #13 PoC makes for its own environment, and for the same reason.
 */
function environmentAgainst(record: LockedDependencyDecision, target: RuntimeContractTarget): LockEnvironment {
  const toolchain: ToolchainIdentity | null = record.probedWith;
  const extensionVersions: Record<string, string> = {};
  const extensionIdentities: Record<string, string> = {};
  if (record.strategy === "extension" && record.extension !== null) {
    if (record.extension.version !== null) {
      extensionVersions[record.libraryId] = record.extension.version;
    }
    if (record.extension.identity !== null) {
      extensionIdentities[record.libraryId] = record.extension.identity;
    }
  }

  return {
    resolvedVersions: record.resolvedVersion === null ? {} : { [record.packageName]: record.resolvedVersion },
    target,
    toolchain,
    probeFingerprints:
      record.probe.fingerprint === null ? {} : { [record.packageName]: record.probe.fingerprint },
    extensionVersions,
    extensionIdentities,
  };
}

/**
 * The environment a page would report for the build the record names.
 *
 * Reconstructing the full contract from the recorded identity is not a claim that the run
 * happened on today's build: `forguncyTargetIdentity` compares only the four recorded fields,
 * so the version that goes in is the one in the lock.
 */
function targetOfRecordedRun(record: LockedDependencyDecision): RuntimeContractTarget {
  return record.target === null ? RUNTIME_CONTRACT_TARGET : { ...RUNTIME_CONTRACT_TARGET, ...record.target };
}

async function lockFor(directory: string): Promise<FgcLockDocument> {
  return readFgcLock(exampleRoot(directory));
}

function historicalRecordOf(lock: FgcLockDocument): LockedDependencyDecision {
  const record = lock.decisions.find(candidate => candidate.packageName === HISTORICAL_RECORD.packageName);
  if (record === undefined) {
    throw new Error(`the historical example no longer records ${HISTORICAL_RECORD.packageName}`);
  }
  return record;
}

describe("the example lock/evidence inventory", () => {
  it("classifies every example, so a new lock cannot go unclassified", () => {
    expect(exampleDirectories).toEqual(Object.keys(EXAMPLE_INVENTORY).sort());

    // What the classification controls: an example either has a committed lock and is
    // `recorded`, or has none and says why. A lock under an example classified `none` is
    // exactly the drift this suite exists to stop.
    for (const directory of exampleDirectories) {
      const classified = EXAMPLE_INVENTORY[directory];
      const hasLock = existsSync(lockPathOf(directory));
      expect(hasLock, `${directory}: classification says "${classified?.kind}"`).toBe(classified?.kind === "recorded");
      // An evidence directory with no record that cites it is the "historical, unreferenced"
      // state the inventory has to state; today no example carries one.
      expect(
        existsSync(join(exampleRoot(directory), "fgc-evidence")),
        `${directory}: an unreferenced fgc-evidence/ must be classified`,
      ).toBe(classified?.kind === "recorded");
    }
  });

  it("loads every recorded lock through the real read path", async () => {
    for (const directory of recordedExamples) {
      const lock = await lockFor(directory);
      expect(lock.decisions.length, `${directory} records no decisions`).toBeGreaterThan(0);
      // Reading is not proof of conformance, and this file does not claim it: a target-specific
      // catalogue check needs the project's mappings. It is proof the document is one a fresh
      // checkout can load, which every later check depends on.
      expect(lock.schemaVersion).toBeGreaterThan(0);
    }
  });

  it("resolves every repository-relative citation, and verifies every content address", async () => {
    for (const directory of recordedExamples) {
      const lock = await lockFor(directory);
      for (const record of recordsOf(lock)) {
        for (const reference of evidenceReferences(record)) {
          const path = localReferencePath(directory, reference);
          if (path === null) {
            // A URL is a claim about somewhere this process cannot reach. `status` treats it the
            // same way; reporting it as missing would be a claim of its own.
            continue;
          }

          expect(existsSync(path), `${directory}: ${record.packageName} cites ${reference}, which is absent`).toBe(
            true,
          );

          const contentAddressed = CONTENT_ADDRESSED_EVIDENCE.exec(reference.trim());
          if (contentAddressed === null) {
            // A plain committed path: existence is all this check can establish.
            continue;
          }

          // Parsed and re-serialized before hashing, exactly like `record`/`status`: the address
          // is defined over the canonical report, so a Git-normalized CRLF checkout is not an
          // edit and a hand-edit still changes the digest.
          const report = parseProbeReport(readFileSync(path, "utf8"));
          expect(sha256(serializeProbeReport(report)), `${directory}: ${reference} does not hash to its name`).toBe(
            contentAddressed[1],
          );
        }
      }
    }
  });

  it("leaves no evidence file unreferenced", async () => {
    for (const directory of recordedExamples) {
      const lock = await lockFor(directory);
      const cited = new Set<string>();
      for (const record of recordsOf(lock)) {
        for (const reference of evidenceReferences(record)) {
          if (localReferencePath(directory, reference) !== null) {
            cited.add(reference.trim().replaceAll("\\", "/"));
          }
        }
      }

      const evidenceDirectory = join(exampleRoot(directory), "fgc-evidence");
      if (!existsSync(evidenceDirectory)) {
        expect([...cited], `${directory} cites evidence but has no fgc-evidence/`).toEqual([]);
        continue;
      }

      const present = readdirSync(evidenceDirectory)
        .filter(name => name.endsWith(".json"))
        .map(name => `fgc-evidence/${name}`)
        .sort();

      // Both directions: a citation to nothing is checked above, and a file nothing cites is a
      // historical artifact whose status the inventory would have to state. Today every file is
      // cited, so an orphan is a change to the example's history and must be reviewed as one.
      expect(present, `${directory}: unreferenced evidence must be classified`).toEqual([...cited].sort());
    }
  });

  it("cites evidence that agrees with the record that rests on it", async () => {
    for (const directory of recordedExamples) {
      const lock = await lockFor(directory);
      for (const record of recordsOf(lock)) {
        for (const reference of evidenceReferences(record)) {
          const path = localReferencePath(directory, reference);
          if (path === null || CONTENT_ADDRESSED_EVIDENCE.exec(reference.trim()) === null) {
            continue;
          }

          const report = parseProbeReport(readFileSync(path, "utf8"));
          expect(report.environment.packageName, `${directory}: ${reference} measures another package`).toBe(
            record.packageName,
          );
          if (record.resolvedVersion !== null) {
            expect(report.environment.packageVersion, `${directory}: ${reference} measures another version`).toBe(
              record.resolvedVersion,
            );
          }
          // The build the report was measured on is the build the record claims. A newer report
          // under an older record is the "fresh conclusion by hand" this Issue forbids.
          expect(report.environment.target, `${directory}: ${reference} names another runtime build`).toEqual(
            record.target,
          );
        }
      }
    }
  });

  it("keeps the historical record's exact identity, so it cannot be re-labelled", async () => {
    const lock = await lockFor(HISTORICAL_RECORD.example);
    const record = historicalRecordOf(lock);

    expect(record.resolvedVersion).toBe(HISTORICAL_RECORD.resolvedVersion);
    expect(record.target).toEqual(HISTORICAL_RECORD.target);
    expect(record.probe.fingerprint).toBe(HISTORICAL_RECORD.probeFingerprint);

    // The fingerprint is reproducible offline from the record's declared inputs, which is #8's
    // rule for a probe fingerprint. If the entry, probe id, imports or cap moved, this fails
    // without a build — and the recorded value is not silently "the one that passed".
    expect(
      composeProbeFingerprint({ probeId: "inline-bundle", entry: HISTORICAL_RECORD.packageName }).fingerprint,
    ).toBe(record.probe.fingerprint);

    // The citations are the historical set, in the historical order, by content address.
    expect(
      evidenceReferences(record)
        .filter(reference => localReferencePath(HISTORICAL_RECORD.example, reference) !== null)
        .map(reference => reference.replace(/^fgc-evidence\//, "")),
    ).toEqual([...HISTORICAL_RECORD.evidenceFiles].sort());
    expect(existsSync(join(exampleRoot(HISTORICAL_RECORD.example), "fgc-evidence"))).toBe(true);
  });
});

describe("historical real-runtime evidence is preserved, and not treated as current validation", () => {
  it("names an older build than the contract targets, and is stale against the current one", async () => {
    const lock = await lockFor(HISTORICAL_RECORD.example);
    const record = historicalRecordOf(lock);
    const recordedTarget: ForguncyTargetIdentity | null = record.target;

    expect(recordedTarget).not.toBeNull();
    if (recordedTarget === null) {
      throw new Error("the historical record lost its runtime target");
    }
    expect(matchesForguncyTargetIdentity(recordedTarget, forguncyTargetIdentity(RUNTIME_CONTRACT_TARGET))).toBe(false);

    // Every other axis is supplied from the record, so the target is the **only** reason.
    const assessment = assessLockDecision(record, environmentAgainst(record, RUNTIME_CONTRACT_TARGET));
    expect(assessment.freshness).toBe("stale");
    expect(assessment.stalenessReasons).toEqual(["forguncy-target-changed"]);
    // The historical claim is intact — the target moved, it did not erase what was observed.
    expect(assessment.realRuntimeValidation).toBe("validated");
  });

  it("is withheld by both compilation projections when asked about the current target", async () => {
    const lock = await lockFor(HISTORICAL_RECORD.example);
    const record = historicalRecordOf(lock);
    const current = environmentAgainst(record, RUNTIME_CONTRACT_TARGET);

    // The deployment gate: not admitted, and the reason names the build rather than the evidence.
    expect(compilationDependencies(lock, current)).toEqual({
      dependencies: [],
      withheld: [
        {
          packageName: HISTORICAL_RECORD.packageName,
          strategy: "extension",
          reason: "not-verified",
          stalenessReasons: ["forguncy-target-changed"],
          realRuntimeValidation: "validated",
        },
      ],
    });

    // The local projection relaxes only the runtime *claim*; freshness still gates, so a stale
    // record cannot reach `compileCell` through the development loop either.
    expect(localCompilationDependencies(lock, current).dependencies).toEqual([]);
    expect(localCompilationDependencies(lock, current).withheld).toHaveLength(1);
  });

  it("still projects for the build it names, so the preserved evidence is not inert", async () => {
    const lock = await lockFor(HISTORICAL_RECORD.example);
    const record = historicalRecordOf(lock);
    const asRecorded = environmentAgainst(record, targetOfRecordedRun(record));

    expect(assessLockDecision(record, asRecorded).freshness).toBe("fresh");
    expect(compilationDependencies(lock, asRecorded)).toEqual({
      dependencies: [
        {
          strategy: "extension",
          packageName: HISTORICAL_RECORD.packageName,
          libraryId: "tanstack-query",
          globalName: "TanStackQuery",
        },
      ],
      withheld: [],
    });
  });

  it("states the owed validation instead of inventing one", () => {
    // The declaration this file can make offline. The record's build is 12.0.100.0 and the
    // contract targets 12.0.101.0; with no executed real-design run against the latter, the
    // owed step is a new page validation, not a new timestamp.
    expect(HISTORICAL_RECORD.target.productVersion).not.toBe(RUNTIME_CONTRACT_TARGET.productVersion);
    expect(HISTORICAL_RECORD.target.productBuild).not.toBe(RUNTIME_CONTRACT_TARGET.productBuild);
  });
});
