/**
 * Safe retry after a write has landed (#93), against a **stateful** recording port.
 *
 * Decision source: GitHub Issue #93 — "MCP 恢复：覆盖写入后保存、检查、生成失败的安全重试"
 * (https://github.com/MangX/forguncy-react-workspace/issues/93), building on #92's
 * `unchanged` path.
 *
 * ## Why a stateful port rather than a spy
 *
 * The question this file answers is not "was a method called?" but "what does a retry see
 * after a failure?". That depends on the *deployed Cell state persisting across calls*, which
 * a per-call stub cannot model: if `setCells` does not change what `readCellSource` returns,
 * the second run cannot take the `unchanged` path, and a test claiming "no redundant write"
 * would be asserting against a state the product never has.
 *
 * So the port below keeps the deployed Cell, the project's dirtiness and its error count as
 * state. `setCells` applies the payload exactly as `readCellSource` would report it — code and
 * libraries — before any injected failure is raised. That is what makes "the write landed but
 * the response was lost" reproducible: the call throws and the state still changed, which is
 * the `unknown-write-state` case.
 *
 * ## What is local evidence and what is not
 *
 * Every scenario here is a *simulated* fault. It establishes the executor's recovery
 * behaviour — a retry re-reads, takes `unchanged`, and a designer edit in between still
 * refuses — and says nothing about whether Forguncy's designer actually fails that way.
 * `scripts/validate-retry-against-designer.mjs` is the separated real-designer run; AGENTS.md
 * rules 6–7 make that separation required rather than stylistic.
 */

import { describe, expect, it } from "vitest";

import { CELL_ARTIFACT_BANNER, frontendLibraryReference } from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";
import { createCellRegistry } from "@forguncy-react-workspace/core";

import {
  confirmCellWriteOutcome,
  executeCellSync,
  executeCellSyncBatch,
  executeCellSyncTargets,
  formatCellSyncRun,
  SyncBatchTransportError,
} from "./executor.ts";
import type { ExecuteCellSyncOptions } from "./executor.ts";
import { isSyncTransportError, SyncTransportError } from "./sync-failure.ts";
import type {
  ForguncySyncPort,
  GeneratedPage,
  IssuedSetCellsRequest,
  ProjectErrorReport,
  ProjectSaveResult,
  ProjectSaveStatus,
  ReadCellSourceResult,
} from "./port.ts";
import type { CellTarget } from "./target.ts";

const TARGET: CellTarget = { pageName: "OrderPage", cell: "A1" };
const CODE_BODY = "function App() { return null; }\n";
const FIRST_RUNTIME: GeneratedPage = {
  pageName: TARGET.pageName,
  pageUrl: "http://localhost:63982/Forguncy/OrderPage?run=1",
};
const SECOND_RUNTIME: GeneratedPage = {
  pageName: TARGET.pageName,
  pageUrl: "http://localhost:63982/Forguncy/OrderPage?run=2",
};

function generated(libraryIds: readonly string[] = [], code = CODE_BODY): CompileCellResult {
  return {
    code: `${CELL_ARTIFACT_BANNER}\n${code}`,
    frontendLibraries: libraryIds.map(frontendLibraryReference),
  };
}

// ---------------------------------------------------------------------------
// The stateful recording port
// ---------------------------------------------------------------------------

type CallMethod =
  | "listFrontendLibraries"
  | "readCellSource"
  | "setCells"
  | "getProjectSaveStatus"
  | "saveProject"
  | "checkProjectErrors"
  | "generatePageAsync";

interface Call {
  readonly method: CallMethod;
  readonly argument: unknown;
}

/**
 * Faults a test injects, one per stage of the flow.
 *
 * Mutable on the state object so a test can inject a fault, run, *clear it*, and retry with
 * the exact same input — which is the shape #93's acceptance is written in. A frozen options
 * object would force a second port for the retry, and the whole point is that the retry is
 * the same caller against the same (now healthy) product.
 */
interface Faults {
  listThrow?: boolean;
  readThrow?: boolean;
  /** `before` throws without applying the write; `after` applies it then throws. */
  setCellsFailure?: "before" | "after";
  saveStatusThrow?: boolean;
  save?: "decline" | "throw";
  checkThrow?: boolean;
  /** Error count by 1-based `checkProjectErrors` call number, for per-target batch tests. */
  errorAtCheckCall?: Readonly<Record<number, number>>;
  generateThrow?: boolean;
  generateBlank?: boolean;
  /** Throw on this 1-based `generatePageAsync` call, leaving earlier ones intact. */
  generateThrowAtCall?: number;
}

interface StatefulPortState {
  /**
   * What `readCellSource` reports for the single test target, and what `setCells` mutates
   * there. A view over the per-Cell map below, so a batch can keep each target's state apart
   * (which is what makes "the second target is written" observable rather than "identical to
   * the first target's Cell").
   */
  deployed: ReadCellSourceResult;
  unsaved: boolean;
  errors: number;
  runtime: GeneratedPage;
  readonly faults: Faults;
  readonly calls: Call[];
  setCellsAttempts: number;
  readCalls: number;
  checkCalls: number;
  generateCalls: number;
}

function cellKey(pageName: string, cell: string): string {
  return `${pageName}\u0000${cell}`;
}

function statefulPort(initial: { readonly deployed?: ReadCellSourceResult } = {}): {
  readonly port: ForguncySyncPort;
  readonly state: StatefulPortState;
} {
  // The deployed state is per Cell and persists across calls: a batch must not see target
  // B1 as identical because A1 happened to hold the same artifact.
  const cells = new Map<string, ReadCellSourceResult>();
  cells.set(cellKey(TARGET.pageName, TARGET.cell), initial.deployed ?? { kind: "blank" });

  const state: StatefulPortState = {
    get deployed(): ReadCellSourceResult {
      return cells.get(cellKey(TARGET.pageName, TARGET.cell)) ?? { kind: "blank" };
    },
    set deployed(value: ReadCellSourceResult) {
      cells.set(cellKey(TARGET.pageName, TARGET.cell), value);
    },
    unsaved: false,
    errors: 0,
    runtime: FIRST_RUNTIME,
    faults: {},
    calls: [],
    setCellsAttempts: 0,
    readCalls: 0,
    checkCalls: 0,
    generateCalls: 0,
  };

  const record = (method: CallMethod, argument: unknown): void => {
    state.calls.push({ method, argument });
  };

  const port: ForguncySyncPort = {
    listFrontendLibraries: async request => {
      record("listFrontendLibraries", request);
      if (state.faults.listThrow) throw new Error("transport refused listFrontendLibraries");
      return [];
    },
    readCellSource: async request => {
      state.readCalls += 1;
      record("readCellSource", request);
      if (state.faults.readThrow) throw new Error("transport refused readCellSource");
      return cells.get(cellKey(request.pageName, request.cell)) ?? { kind: "blank" };
    },
    setCells: async (request: IssuedSetCellsRequest) => {
      state.setCellsAttempts += 1;
      record("setCells", request);
      if (state.faults.setCellsFailure === "before") throw new Error("transport refused setCells");
      const [cell] = request.cells;
      // The product's effect, applied before a post-write failure is raised: this is what
      // "the write landed but the caller did not learn it" means.
      cells.set(cellKey(request.pageName, cell.cell), {
        kind: "react-cell",
        code: cell.cellTypeProps.code,
        frontendLibraries: cell.cellTypeProps.frontendLibraries,
        bindingProps: {},
      });
      state.unsaved = true;
      if (state.faults.setCellsFailure === "after") throw new Error("transport refused setCells after it landed");
    },
    getProjectSaveStatus: async (request): Promise<ProjectSaveStatus> => {
      record("getProjectSaveStatus", request);
      if (state.faults.saveStatusThrow) throw new Error("transport refused getProjectSaveStatus");
      return { containsUnsavedChanges: state.unsaved };
    },
    saveProject: async (): Promise<ProjectSaveResult> => {
      record("saveProject", undefined);
      if (state.faults.save === "throw") throw new Error("transport refused saveProject");
      if (state.faults.save === "decline") return { saved: false };
      state.unsaved = false;
      return { saved: true };
    },
    checkProjectErrors: async (): Promise<ProjectErrorReport> => {
      state.checkCalls += 1;
      record("checkProjectErrors", undefined);
      if (state.faults.checkThrow) throw new Error("transport refused checkProjectErrors");
      const overridden = state.faults.errorAtCheckCall?.[state.checkCalls];
      return { errorCount: overridden ?? state.errors };
    },
    generatePageAsync: async request => {
      state.generateCalls += 1;
      record("generatePageAsync", request);
      if (state.faults.generateThrow) throw new Error("transport refused generatePageAsync");
      if (state.faults.generateThrowAtCall === state.generateCalls) {
        throw new Error(`transport refused generatePageAsync on call ${state.generateCalls}`);
      }
      if (state.faults.generateBlank) return { pageName: request.pageName, pageUrl: "   " };
      return { pageName: request.pageName, pageUrl: state.runtime.pageUrl };
    },
  };

  return { port, state };
}

function runOptions(port: ForguncySyncPort, overrides: Record<string, unknown> = {}): ExecuteCellSyncOptions {
  return {
    target: TARGET,
    artifact: generated(),
    decisions: [],
    port,
    ...overrides,
  } as ExecuteCellSyncOptions;
}

function setCellsCalls(state: StatefulPortState): readonly Call[] {
  return state.calls.filter(call => call.method === "setCells");
}

/** Catch the thrown failure, failing the test with a readable message if nothing threw. */
async function failureOf(promise: Promise<unknown>): Promise<SyncTransportError> {
  try {
    await promise;
  } catch (error) {
    expect(isSyncTransportError(error)).toBe(true);
    return error as SyncTransportError;
  }
  throw new Error("Expected the run to reject, but it resolved.");
}

// ---------------------------------------------------------------------------
// The core scenarios (#93 acceptance)
// ---------------------------------------------------------------------------

describe("normal repeated sync", () => {
  it("writes once and returns a locator generated by each run", async () => {
    const { port, state } = statefulPort();

    const first = await executeCellSync(runOptions(port));
    state.runtime = SECOND_RUNTIME;
    const second = await executeCellSync(runOptions(port));

    expect(first.status).toBe("written");
    expect(second.status).toBe("unchanged");
    if (second.status !== "unchanged") return;
    expect(setCellsCalls(state)).toHaveLength(1);
    // This run's own locator, not the first run's.
    expect(second.runtime.pageUrl).toBe(SECOND_RUNTIME.pageUrl);
    expect(second.steps.find(step => step.stepId === "write-cell-source")?.status).toBe("skipped");
  });
});

describe("retry after the write landed but the save failed", () => {
  it("retries the same input, writes nothing and completes the remaining steps", async () => {
    const artifact = generated();
    const { port, state } = statefulPort();
    state.faults.save = "decline";

    const first = await executeCellSync(runOptions(port, { artifact }));

    expect(first.status).toBe("failed");
    if (first.status !== "failed") return;
    // The Cell was written; the project is the thing that was not persisted.
    expect(first.mutated).toBe(true);
    expect(first.mutation).toMatchObject({ state: "written", evidence: "write-acknowledged" });
    expect(first.projectSave).toBe("declined");
    expect("runtime" in first).toBe(false);
    expect(setCellsCalls(state)).toHaveLength(1);

    // The fault clears; the retry is the exact same input.
    state.faults.save = undefined;
    state.runtime = SECOND_RUNTIME;
    const readsBeforeRetry = state.readCalls;
    const generationsBeforeRetry = state.generateCalls;
    const retry = await executeCellSync(runOptions(port, { artifact }));

    expect(retry.status).toBe("unchanged");
    if (retry.status !== "unchanged") return;
    // The retry read the live target again before planning; that read is what makes the
    // no-write decision safe rather than a remembered acknowledgement.
    expect(state.readCalls).toBe(readsBeforeRetry + 1);
    // The locator is this run's generation, not the failed attempt's.
    expect(state.generateCalls).toBe(generationsBeforeRetry + 1);
    // The write already landed: the retry re-read it and issued no second `setCells`.
    expect(setCellsCalls(state)).toHaveLength(1);
    expect(retry.steps.find(step => step.stepId === "write-cell-source")?.status).toBe("skipped");
    expect(retry.steps.find(step => step.stepId === "save-project-if-required")?.status).toBe("ran");
    expect(retry.steps.find(step => step.stepId === "check-project-errors")?.status).toBe("ran");
    expect(retry.steps.find(step => step.stepId === "generate-page")?.status).toBe("ran");
    expect(retry.runtime.pageUrl).toBe(SECOND_RUNTIME.pageUrl);
    expect(retry.mutated).toBe(true);
  });

  it("reports the failed save as a resolved failure and preserves the cause of a thrown one", async () => {
    const { port, state } = statefulPort();
    state.faults.save = "throw";

    const failure = await failureOf(executeCellSync(runOptions(port)));

    expect(failure.stage).toBe("save-project-if-required");
    expect(failure.operation).toBe("saveProject");
    // The Cell write is confirmed; the project save is the unknown one.
    expect(failure.mutation).toMatchObject({ state: "written", evidence: "write-acknowledged" });
    expect(failure.projectSave).toBe("unknown");
    // The original error is the cause, stack included — not a manufactured diagnostic.
    expect(failure.cause).toBeInstanceOf(Error);
    expect((failure.cause as Error).message).toContain("transport refused saveProject");
    expect(failure.message).toContain("transport refused saveProject");
    // The step snapshot says what the flow had done when the call failed.
    expect(failure.steps.find(step => step.stepId === "write-cell-source")?.status).toBe("ran");
    expect(failure.retryGuidance).toContain("retrying the same input takes the `unchanged` path");
    // No locator exists on a thrown failure at all.
    expect("runtime" in failure).toBe(false);

    state.faults.save = undefined;
    const retry = await executeCellSync(runOptions(port));
    expect(retry.status).toBe("unchanged");
    expect(setCellsCalls(state)).toHaveLength(1);
  });

  it("does not read an unanswerable save status as a clean project", async () => {
    const { port, state } = statefulPort();
    state.faults.saveStatusThrow = true;

    const failure = await failureOf(executeCellSync(runOptions(port)));

    expect(failure.stage).toBe("save-project-if-required");
    expect(failure.operation).toBe("getProjectSaveStatus");
    expect(failure.mutation.state).toBe("written");
    // "not-required" would claim the project was clean; nothing established that.
    expect(failure.projectSave).toBe("unknown");
    expect((failure.cause as Error).message).toContain("transport refused getProjectSaveStatus");
  });
});

describe("retry after the project check failed", () => {
  it("fails on a non-zero count, then retries without a second write", async () => {
    const { port, state } = statefulPort();
    state.errors = 2;

    const first = await executeCellSync(runOptions(port));

    expect(first.status).toBe("failed");
    if (first.status !== "failed") return;
    expect(first.mutation.state).toBe("written");
    expect(first.projectSave).toBe("persisted");
    expect(first.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["project-errors-after-sync"]);
    expect(formatCellSyncRun(first)).toContain("write: the target holds this artifact");

    state.errors = 0;
    const retry = await executeCellSync(runOptions(port));

    expect(retry.status).toBe("unchanged");
    expect(setCellsCalls(state)).toHaveLength(1);
  });

  it("does not bypass the zero-error gate on a retry", async () => {
    const { port, state } = statefulPort();
    state.errors = 2;

    const first = await executeCellSync(runOptions(port));
    const retry = await executeCellSync(runOptions(port));

    for (const run of [first, retry]) {
      expect(run.status).toBe("failed");
      if (run.status !== "failed") continue;
      expect(run.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["project-errors-after-sync"]);
      expect("runtime" in run).toBe(false);
    }
    // The retry re-read the landing write and still refused to generate.
    expect(setCellsCalls(state)).toHaveLength(1);
    expect(state.generateCalls).toBe(0);
  });

  it("reports a rejected check with its stage and the confirmed write", async () => {    const { port, state } = statefulPort();
    state.faults.checkThrow = true;

    const failure = await failureOf(executeCellSync(runOptions(port)));

    expect(failure.stage).toBe("check-project-errors");
    expect(failure.operation).toBe("checkProjectErrors");
    expect(failure.mutation.state).toBe("written");
    expect(failure.projectSave).toBe("persisted");
    expect((failure.cause as Error).message).toContain("transport refused checkProjectErrors");

    state.faults.checkThrow = false;
    const retry = await executeCellSync(runOptions(port));
    expect(retry.status).toBe("unchanged");
    expect(setCellsCalls(state)).toHaveLength(1);
  });
});

describe("retry after generation failed", () => {
  it("does not return a locator for a blank generation, and retries to a fresh one", async () => {
    const { port, state } = statefulPort();
    state.faults.generateBlank = true;

    const first = await executeCellSync(runOptions(port));

    expect(first.status).toBe("failed");
    if (first.status !== "failed") return;
    expect(first.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["runtime-generation-failed"]);
    expect("runtime" in first).toBe(false);
    expect(first.mutation.state).toBe("written");
    expect(setCellsCalls(state)).toHaveLength(1);

    state.faults.generateBlank = false;
    state.runtime = SECOND_RUNTIME;
    const retry = await executeCellSync(runOptions(port));

    expect(retry.status).toBe("unchanged");
    if (retry.status !== "unchanged") return;
    expect(retry.runtime.pageUrl).toBe(SECOND_RUNTIME.pageUrl);
    expect(setCellsCalls(state)).toHaveLength(1);
  });

  it("reports a rejected generation with its stage, never as a successful locator", async () => {
    const { port, state } = statefulPort();
    state.faults.generateThrow = true;

    const failure = await failureOf(executeCellSync(runOptions(port)));

    expect(failure.stage).toBe("generate-page");
    expect(failure.operation).toBe("generatePageAsync");
    expect(failure.mutation.state).toBe("written");
    expect(failure.projectSave).toBe("persisted");
    expect("runtime" in failure).toBe(false);

    state.faults.generateThrow = false;
    state.runtime = SECOND_RUNTIME;
    const retry = await executeCellSync(runOptions(port));
    expect(retry.status).toBe("unchanged");
    expect(setCellsCalls(state)).toHaveLength(1);
  });
});

describe("failure before the write", () => {
  it("reports not-written and retries to exactly one write", async () => {
    const { port, state } = statefulPort();
    state.faults.listThrow = true;

    const failure = await failureOf(executeCellSync(runOptions(port)));

    expect(failure.stage).toBe("verify-extension-metadata");
    expect(failure.operation).toBe("listFrontendLibraries");
    expect(failure.mutation.state).toBe("not-written");
    expect(failure.retryGuidance).toContain("Nothing is known to have been written");
    expect(setCellsCalls(state)).toHaveLength(0);
    expect(state.readCalls).toBe(0);

    state.faults.listThrow = false;
    const retry = await executeCellSync(runOptions(port));

    expect(retry.status).toBe("written");
    expect(setCellsCalls(state)).toHaveLength(1);
  });

  it("reports a rejected target read as a pre-write failure", async () => {
    const { port, state } = statefulPort();
    state.faults.readThrow = true;

    const failure = await failureOf(executeCellSync(runOptions(port)));

    expect(failure.stage).toBe("read-target-state");
    expect(failure.operation).toBe("readCellSource");
    expect(failure.mutation.state).toBe("not-written");
    expect(setCellsCalls(state)).toHaveLength(0);
  });

  it("does not retry by itself", async () => {
    const { port, state } = statefulPort();
    state.faults.setCellsFailure = "before";

    await failureOf(executeCellSync(runOptions(port)));

    // One attempt, not a retry loop: recovery is the caller's decision.
    expect(state.setCellsAttempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The uncertain write
// ---------------------------------------------------------------------------

describe("an uncertain setCells outcome", () => {
  it("reports unknown-write-state when the write landed, and a read-back confirms it", async () => {
    const artifact = generated();
    const { port, state } = statefulPort();
    state.faults.setCellsFailure = "after";

    const failure = await failureOf(executeCellSync(runOptions(port, { artifact })));

    expect(failure.stage).toBe("write-cell-source");
    expect(failure.operation).toBe("setCells");
    expect(failure.mutation.state).toBe("unknown-write-state");
    expect(failure.retryGuidance).toContain("read the target back");
    // The product applied it even though the call threw.
    expect(state.deployed).toMatchObject({ kind: "react-cell" });

    const confirmation = await confirmCellWriteOutcome({ port, target: TARGET, artifact });

    expect(confirmation.mutation).toMatchObject({ state: "written", evidence: "read-back-identical" });
    expect(confirmation.divergence.kind).toBe("identical");

    state.faults.setCellsFailure = undefined;
    state.runtime = SECOND_RUNTIME;
    const retry = await executeCellSync(runOptions(port, { artifact }));

    expect(retry.status).toBe("unchanged");
    expect(setCellsCalls(state)).toHaveLength(1);
    expect(retry.status === "unchanged" ? retry.runtime.pageUrl : undefined).toBe(SECOND_RUNTIME.pageUrl);
  });

  it("reports unknown-write-state when the write did not land, and a read-back says not-written", async () => {
    const artifact = generated();
    const { port, state } = statefulPort();
    state.faults.setCellsFailure = "before";

    const failure = await failureOf(executeCellSync(runOptions(port, { artifact })));

    expect(failure.mutation.state).toBe("unknown-write-state");

    const confirmation = await confirmCellWriteOutcome({ port, target: TARGET, artifact });

    expect(confirmation.mutation).toMatchObject({
      state: "not-written",
      evidence: "read-back-holds-no-artifact",
    });
    expect(confirmation.divergence.kind).toBe("vacant");

    state.faults.setCellsFailure = undefined;
    const retry = await executeCellSync(runOptions(port, { artifact }));

    // The target was still vacant, so the retry writes once — it does not guess the earlier
    // outcome either way.
    expect(retry.status).toBe("written");
    expect(state.setCellsAttempts).toBe(2);
    expect(setCellsCalls(state)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The property the retry exists for
// ---------------------------------------------------------------------------

describe("a target edited between the failure and the retry", () => {
  function designerEdit(state: StatefulPortState): void {
    // Source with no sync marker: designer work, which the plan classifies `foreign-code`.
    state.deployed = {
      kind: "react-cell",
      code: "function App() { return null; } // edited by hand after the failure\n",
      frontendLibraries: [],
      bindingProps: {},
    };
  }

  it("is re-read and refused, not overwritten", async () => {
    const artifact = generated();
    const { port, state } = statefulPort();
    state.faults.generateThrow = true;

    await failureOf(executeCellSync(runOptions(port, { artifact })));
    expect(setCellsCalls(state)).toHaveLength(1);

    designerEdit(state);
    state.faults.generateThrow = false;

    const retry = await executeCellSync(runOptions(port, { artifact }));

    expect(retry.status).toBe("refused");
    if (retry.status !== "refused") return;
    expect(retry.dispatch.reason).toBe("gate-refused");
    expect(retry.plan.divergence.kind).toBe("foreign-code");
    // The retry read the edited Cell before planning, and issued no write.
    expect(state.readCalls).toBeGreaterThanOrEqual(2);
    expect(setCellsCalls(state)).toHaveLength(1);
    expect("runtime" in retry).toBe(false);
  });

  it("after an uncertain write, still refuses the manual edit", async () => {
    const artifact = generated();
    const { port, state } = statefulPort();
    state.faults.setCellsFailure = "after";

    await failureOf(executeCellSync(runOptions(port, { artifact })));
    designerEdit(state);
    state.faults.setCellsFailure = undefined;

    const confirmation = await confirmCellWriteOutcome({ port, target: TARGET, artifact });
    // The Cell does not hold this artifact any more — the edit replaced it — and the
    // divergence says a retry will refuse what is there.
    expect(confirmation.mutation).toMatchObject({ state: "not-written", evidence: "read-back-holds-other-content" });
    expect(confirmation.divergence.kind).toBe("foreign-code");

    const retry = await executeCellSync(runOptions(port, { artifact }));

    expect(retry.status).toBe("refused");
    expect(setCellsCalls(state)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A batch, where a later failure must not hide earlier mutations (#93 item 4)
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.platform === "win32" ? "C:\\probe\\retry" : "/probe/retry";

function registryOf() {
  return createCellRegistry(
    {
      runtime: { forguncyVersion: "12.0.101", projectAlias: "sync-retry" },
      cells: {
        first: { entry: "cells/first/App.tsx", target: { pageName: "销售订单", cell: "A1" } },
        second: { entry: "cells/second/App.tsx", target: { pageName: "销售订单", cell: "B1" } },
        third: { entry: "cells/third/App.tsx", target: { pageName: "销售订单", cell: "C1" } },
      },
    },
    { root: PROJECT_ROOT, requireEntryFiles: false },
  );
}

function batchPlans(port: ForguncySyncPort) {
  return [
    { cellId: "first", artifact: generated(), decisions: [], port },
    { cellId: "second", artifact: generated(), decisions: [], port },
    { cellId: "third", artifact: generated(), decisions: [], port },
  ];
}

describe("a batch with a failure in the middle", () => {
  it("reports per-target outcomes and stops after a transport failure", async () => {
    const { port, state } = statefulPort();
    // Each target writes, saves nothing and checks; the second target's generation throws.
    state.faults.generateThrowAtCall = 2;

    const report = await executeCellSyncBatch(registryOf(), batchPlans(port), {
      onTransportFailure: "stop",
    });

    expect(report.outcomes.map(outcome => outcome.kind)).toEqual([
      "run",
      "transport-failure",
      "not-attempted",
    ]);
    expect(report.runs.map(run => run.status)).toEqual(["written"]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.target).toEqual({ pageName: "销售订单", cell: "B1" });
    // The second target's write landed before its generation failed, so it is a confirmed
    // mutation rather than an unknown one — and both landed targets are reported.
    expect(report.failures[0]?.mutation.state).toBe("written");
    expect(report.mutatedTargets).toEqual([
      { pageName: "销售订单", cell: "A1" },
      { pageName: "销售订单", cell: "B1" },
    ]);
    expect(report.uncertainTargets).toEqual([]);
    expect(report.stoppedEarly).toBe(true);
    const notAttempted = report.outcomes[2];
    expect(notAttempted?.kind === "not-attempted" ? notAttempted.stoppedAtCellId : undefined).toBe("second");
    // The third target was never read, let alone written.
    expect(state.readCalls).toBe(2);
  });

  it("continues after a transport failure when the caller asks, keeping every outcome", async () => {
    const { port, state } = statefulPort();
    state.faults.generateThrowAtCall = 2;

    const report = await executeCellSyncBatch(registryOf(), batchPlans(port), {
      onTransportFailure: "continue",
    });

    expect(report.outcomes.map(outcome => outcome.kind)).toEqual(["run", "transport-failure", "run"]);
    expect(report.runs.map(run => run.status)).toEqual(["written", "written"]);
    expect(report.mutatedTargets).toEqual([
      { pageName: "销售订单", cell: "A1" },
      { pageName: "销售订单", cell: "B1" },
      { pageName: "销售订单", cell: "C1" },
    ]);
    expect(report.stoppedEarly).toBe(false);
    expect(state.readCalls).toBe(3);
  });

  it("throws a batch error carrying the partial report, so earlier writes are not lost", async () => {
    const { port, state } = statefulPort();
    state.faults.generateThrowAtCall = 2;

    let caught: unknown;
    try {
      await executeCellSyncTargets(registryOf(), batchPlans(port));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SyncBatchTransportError);
    const batchError = caught as SyncBatchTransportError;
    expect(batchError.report.runs.map(run => run.target.cell)).toEqual(["A1"]);
    expect(batchError.report.mutatedTargets.map(target => target.cell)).toEqual(["A1", "B1"]);
    expect(batchError.report.failures[0]?.target.cell).toBe("B1");
    expect(batchError.message).toContain("confirmed written");
  });

  it("honours `onFailedRun: stop` while defaulting to continuing", async () => {
    const stopping = statefulPort();
    stopping.state.faults.errorAtCheckCall = { 1: 1 };

    const stopped = await executeCellSyncBatch(registryOf(), batchPlans(stopping.port), {
      onFailedRun: "stop",
    });

    expect(stopped.outcomes.map(outcome => outcome.kind)).toEqual(["run", "not-attempted", "not-attempted"]);
    expect(stopped.runs[0]?.status).toBe("failed");
    expect(stopped.stoppedEarly).toBe(true);

    const continuing = statefulPort();
    continuing.state.faults.errorAtCheckCall = { 1: 1 };

    const continued = await executeCellSyncBatch(registryOf(), batchPlans(continuing.port));

    expect(continued.outcomes.map(outcome => outcome.kind)).toEqual(["run", "run", "run"]);
    expect(continued.runs.map(run => run.status)).toEqual(["failed", "written", "written"]);
    expect(continued.stoppedEarly).toBe(false);
  });
});
