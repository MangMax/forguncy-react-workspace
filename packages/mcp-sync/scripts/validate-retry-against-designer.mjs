/**
 * #93's real-designer validation: safe recovery against a disposable Forguncy project.
 *
 * ## What this run establishes, and what it does not
 *
 * It exercises the **normal retry paths against a real designer through the shipped
 * adapter**: a first write, a repeated sync that reports `unchanged` and issues no second
 * write, and — for the failure paths that can be injected safely at the *port boundary* — a
 * retry that re-reads the live target, writes nothing when the earlier write landed, and
 * refuses a Cell a person edited between the failure and the retry.
 *
 * AGENTS.md rules 6–7: this is the runtime half, and it is still not a hardware fault
 * injection. The failures it injects are **client-side response substitutions** — the call
 * really goes to Forguncy, then this script returns a declined save / a throw / an error count
 * instead of the product's answer. That is enough to drive the executor's recovery logic
 * against real persisted Cell state, which is what #93's local half cannot show; it is not
 * evidence that Forguncy itself failed that way.
 *
 * The failure modes **not** injectable here without destructive action — a real `setCells`
 * whose HTTP response is lost after the product applied it, a real `saveProject` that fails
 * on disk, a designer mode that makes generation fail — are covered by the stateful recording
 * port in `src/retry.test.ts`, not by this script. The script says so in its result output
 * rather than leaving a reader to infer it from what is absent.
 *
 * ## Safety rules this script follows
 *
 * - One disposable page per run (`fgc-issue93-<run id>`), never an existing page.
 * - No `api.page.clearCells`, no `api.page.deletePage`: both are `write/dangerous` in the
 *   product's permission model and a validation script must not be the thing that asks for
 *   that confirmation.
 * - The only direct designer writes are to Cells on that page, and they are the scenario
 *   itself (the hand edit that a retry must refuse).
 * - `saveProject` can exceed `execute_code`'s tool budget on this project (#113/#115). The
 *   save completes server-side; this script treats the *status read afterwards* as the
 *   evidence, exactly as `validate-unchanged-against-designer.mjs` does.
 *
 * ## Running it
 *
 *   node --experimental-strip-types scripts/validate-retry-against-designer.mjs
 *
 * Point `FGC_MCP_URL` at the designer if it is not on the default port.
 */
const URL_ = process.env.FGC_MCP_URL ?? "http://localhost:11234/mcp";
let sessionId = null;

async function rpc(method, params) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const response = await fetch(URL_, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }),
  });
  const assigned = response.headers.get("mcp-session-id");
  if (assigned) sessionId = assigned;
  const text = await response.text();
  const payloads = text
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => JSON.parse(line.slice(5).trim()));
  if (payloads.length === 0) return null;
  return payloads.length === 1 ? payloads[0] : payloads;
}

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "issue93-retry", version: "0" },
});
await fetch(URL_, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});

const callTool = (name, args) => rpc("tools/call", { name, arguments: args });

// Loaded from source, so the run is the code under review rather than a build.
const { createDesignerSyncPort } = await import("../src/designer-transport.ts");
const {
  confirmCellWriteOutcome,
  executeCellSync,
  executeCellSyncBatch,
} = await import("../src/executor.ts");
const { isSyncTransportError } = await import("../src/sync-failure.ts");
const { CELL_ARTIFACT_BANNER } = await import("@forguncy-react-workspace/cell-compiler");
const { EXTENSION_EXTERNAL_MAPPINGS, createCellRegistry } = await import("@forguncy-react-workspace/core");

const MAPPING = EXTENSION_EXTERNAL_MAPPINGS.find(row => row.libraryId === "tanstack-query") ?? EXTENSION_EXTERNAL_MAPPINGS[0];
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const PAGE = `fgc-issue93-${RUN_ID}`;

const raw = createDesignerSyncPort({ callTool });

async function designer(script, mode = "safeWriteAuto") {
  const response = await callTool("execute_code", {
    title: "issue93",
    code: `const __run = async () => { ${script} };\nreturn await __run();`,
    permissionMode: mode,
  });
  if (response?.result?.isError) throw new Error(response.result.content?.[0]?.text ?? "designer error");
  const text = response?.result?.content?.map(block => block.text).join("\n") ?? "";
  return JSON.parse(text).result;
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
};

/** The save can exceed the tool budget; the status read afterwards is the evidence. */
async function settleProject() {
  const status = await raw.getProjectSaveStatus({});
  if (!status.containsUnsavedChanges) return status;
  try {
    await raw.saveProject();
  } catch (error) {
    console.log("### saveProject exceeded the tool budget (known environment limit):", String(error.message).slice(0, 80));
  }
  return raw.getProjectSaveStatus({});
}

// --- Disposable page ---------------------------------------------------------------
await designer(`
  const pages = await api.page.listPages({});
  if (pages.some(p => p.name === ${JSON.stringify(PAGE)})) throw new Error("page exists");
  await api.page.createPage({ name: ${JSON.stringify(PAGE)}, rowCount: 20, columnCount: 12 });
  return { created: ${JSON.stringify(PAGE)} };
`);

const artifact = {
  code:
    `${CELL_ARTIFACT_BANNER}\n` +
    `function App(props) {\n` +
    `  var T = globalThis[${JSON.stringify(MAPPING.globalName)}];\n` +
    `  return React.createElement("div", { "data-issue93": "1" }, "ok " + (typeof T) + " @" + props.cell);\n` +
    `}\n`,
  frontendLibraries: [{ libraryId: MAPPING.libraryId }],
};
const decisions = [{ strategy: "extension", packageName: MAPPING.packageName, libraryId: MAPPING.libraryId, globalName: MAPPING.globalName }];

// --- The port: real adapter, plus safe, explicit fault injection --------------------
//
// Every method forwards to the adapter unless a fault is armed, and the faults are one-shot
// counters a scenario arms immediately before its run. The write requests are recorded so
// "the retry issued no second setCells" is asserted from the calls the adapter received, not
// from a step status.
const writes = [];
const faults = {
  saveDecline: 0,
  saveThrow: 0,
  checkErrors: 0,
  checkThrow: 0,
  generateThrow: 0,
  generateBlank: 0,
  generateThrowAtCall: 0,
};
let generateCalls = 0;

const port = {
  ...raw,
  setCells: async request => {
    writes.push({ pageName: request.pageName, cell: request.cells[0]?.cell, code: request.cells[0]?.cellTypeProps?.code });
    return raw.setCells(request);
  },
  saveProject: async () => {
    if (faults.saveThrow > 0) {
      faults.saveThrow -= 1;
      throw new Error("injected (port-level): saveProject threw");
    }
    if (faults.saveDecline > 0) {
      faults.saveDecline -= 1;
      return { saved: false };
    }
    return raw.saveProject();
  },
  checkProjectErrors: async () => {
    if (faults.checkThrow > 0) {
      faults.checkThrow -= 1;
      throw new Error("injected (port-level): checkProjectErrors threw");
    }
    if (faults.checkErrors > 0) {
      faults.checkErrors -= 1;
      return { errorCount: 1 };
    }
    return raw.checkProjectErrors();
  },
  generatePageAsync: async request => {
    generateCalls += 1;
    if (faults.generateThrow > 0) {
      faults.generateThrow -= 1;
      throw new Error("injected (port-level): generatePageAsync threw");
    }
    if (faults.generateBlank > 0) {
      faults.generateBlank -= 1;
      return { pageName: request.pageName, pageUrl: "   " };
    }
    if (faults.generateThrowAtCall === generateCalls) {
      faults.generateThrowAtCall = 0;
      throw new Error("injected (port-level): generatePageAsync threw on this target");
    }
    return raw.generatePageAsync(request);
  },
};

const runFor = cell => ({ target: { pageName: PAGE, cell }, artifact, decisions, port });
const writesFor = cell => writes.filter(write => write.cell === cell).length;

async function failureOf(promise) {
  try {
    await promise;
  } catch (error) {
    if (!isSyncTransportError(error)) throw error;
    return error;
  }
  throw new Error("expected the run to reject");
}

// --- 1. The core scenario: normal first sync and normal repeated sync ---------------
console.log("\n### 1. normal sync, then the same sync again");
const first = await executeCellSync(runFor("A1"));
check("the first sync writes the Cell", first.status === "written", first.status);
check("the first sync returns a locator for this page", first.status === "written" && first.runtime.pageUrl.includes(encodeURIComponent(PAGE)));
await settleProject();

const writesBeforeRepeat = writesFor("A1");
const repeat = await executeCellSync(runFor("A1"));
check("the repeated sync reports unchanged, not refused", repeat.status === "unchanged", repeat.status);
check(
  "the repeated sync issued no setCells",
  writesFor("A1") === writesBeforeRepeat,
  `${writesFor("A1") - writesBeforeRepeat} write(s)`,
);
check(
  "the repeated sync still checked errors and generated",
  repeat.steps.find(step => step.stepId === "check-project-errors")?.status === "ran" &&
    repeat.steps.find(step => step.stepId === "generate-page")?.status === "ran",
);
check(
  "the repeated sync returned a locator this run generated",
  repeat.status === "unchanged" && repeat.runtime.pageUrl.includes(encodeURIComponent(PAGE)),
  repeat.status === "unchanged" ? repeat.runtime.pageUrl : repeat.status,
);

// --- 2. Save failure, then retry -----------------------------------------------------
console.log("\n### 2. save failure after a landed write, then retry");
faults.saveDecline = 1;
const saveFailed = await executeCellSync(runFor("B1"));
check("the first attempt fails on the declined save", saveFailed.status === "failed", saveFailed.status);
check(
  "it reports the write as landed and the save as declined",
  saveFailed.status === "failed" && saveFailed.mutation.state === "written" && saveFailed.projectSave === "declined",
  saveFailed.status === "failed" ? `${saveFailed.mutation.state}/${saveFailed.projectSave}` : saveFailed.status,
);
check("the failed attempt returns no locator", saveFailed.status !== "written" && saveFailed.status !== "unchanged" && !("runtime" in saveFailed));
const writesAfterSaveFailure = writesFor("B1");
await settleProject();

const saveRetry = await executeCellSync(runFor("B1"));
check("the retry reports unchanged", saveRetry.status === "unchanged", saveRetry.status);
check("the retry issued no second write", writesFor("B1") === writesAfterSaveFailure, `${writesFor("B1") - writesAfterSaveFailure} write(s)`);
check(
  "the retry finished the validation steps with a locator",
  saveRetry.status === "unchanged" &&
    saveRetry.steps.find(step => step.stepId === "generate-page")?.status === "ran" &&
    saveRetry.runtime.pageUrl.includes(encodeURIComponent(PAGE)),
);

// --- 3. Generation failure (throw), then retry --------------------------------------
console.log("\n### 3. generation throws after the write, then retry");
faults.generateThrow = 1;
const generationFailure = await failureOf(executeCellSync(runFor("C1")));
check("the failure names the generation stage", generationFailure.stage === "generate-page" && generationFailure.operation === "generatePageAsync");
check("the failure reports the write as landed", generationFailure.mutation.state === "written", generationFailure.mutation.state);
check("the original error is preserved as `cause`", generationFailure.cause instanceof Error && String(generationFailure.cause.message).includes("injected"));
const writesAfterGenerationFailure = writesFor("C1");
await settleProject();

const generationRetry = await executeCellSync(runFor("C1"));
check("the retry reports unchanged", generationRetry.status === "unchanged", generationRetry.status);
check("the retry issued no second write", writesFor("C1") === writesAfterGenerationFailure);
check(
  "the retry returns a freshly generated locator",
  generationRetry.status === "unchanged" && generationRetry.runtime.pageUrl.includes(encodeURIComponent(PAGE)),
);

// --- 4. Blank generation, then retry ------------------------------------------------
console.log("\n### 4. generation resolves with no locator, then retry");
faults.generateBlank = 1;
const blankGeneration = await executeCellSync(runFor("D1"));
check(
  "a generation with no locator fails the run and returns none",
  blankGeneration.status === "failed" && !("runtime" in blankGeneration),
  blankGeneration.status,
);
const writesBeforeBlankRetry = writesFor("D1");
await settleProject();
const blankRetry = await executeCellSync(runFor("D1"));
check("the retry reports unchanged", blankRetry.status === "unchanged", blankRetry.status);
check("the retry issued no second write", writesFor("D1") === writesBeforeBlankRetry);
check(
  "the retry returns a locator",
  blankRetry.status === "unchanged" && blankRetry.runtime.pageUrl.includes(encodeURIComponent(PAGE)),
);

// --- 5. Error-count failure, then retry ---------------------------------------------
console.log("\n### 5. a non-zero error count, then retry");
faults.checkErrors = 1;
const checkFailed = await executeCellSync(runFor("E1"));
check(
  "the injected error count fails the run without a locator",
  checkFailed.status === "failed" && checkFailed.diagnostics.some(diagnostic => diagnostic.code === "project-errors-after-sync"),
  checkFailed.status,
);
const writesBeforeCheckRetry = writesFor("E1");
await settleProject();
const checkRetry = await executeCellSync(runFor("E1"));
check("the retry reports unchanged", checkRetry.status === "unchanged", checkRetry.status);
check("the retry issued no second write", writesFor("E1") === writesBeforeCheckRetry);
check("the real project reports zero errors on the retry", (await raw.checkProjectErrors()).errorCount === 0);

// --- 6. Uncertain write, confirmed by reading the live target -----------------------
console.log("\n### 6. an uncertain setCells outcome, confirmed by a read-back");
// Safe port-level injection: the write really lands, then the wrapper throws instead of
// returning the adapter's acknowledgement. This is the closest a validation script can get
// to "the response was lost" without breaking the real transport.
const uncertainPort = {
  ...port,
  setCells: async request => {
    writes.push({ pageName: request.pageName, cell: request.cells[0]?.cell, code: request.cells[0]?.cellTypeProps?.code });
    await raw.setCells(request);
    throw new Error("injected (port-level): setCells response lost after the product applied it");
  },
};
const uncertainFailure = await failureOf(
  executeCellSync({ target: { pageName: PAGE, cell: "F1" }, artifact, decisions, port: uncertainPort }),
);
check(
  "the uncertain write is reported as unknown-write-state",
  uncertainFailure.stage === "write-cell-source" && uncertainFailure.mutation.state === "unknown-write-state",
  `${uncertainFailure.stage}/${uncertainFailure.mutation.state}`,
);
const confirmation = await confirmCellWriteOutcome({ port: raw, target: { pageName: PAGE, cell: "F1" }, artifact });
check(
  "a read of the live target confirms the write landed",
  confirmation.mutation.state === "written" && confirmation.mutation.evidence === "read-back-identical",
  `${confirmation.mutation.state}/${confirmation.mutation.evidence}`,
);
const writesBeforeUncertainRetry = writesFor("F1");
await settleProject();
const uncertainRetry = await executeCellSync(runFor("F1"));
check("the retry reports unchanged", uncertainRetry.status === "unchanged", uncertainRetry.status);
check("the retry issued no second write", writesFor("F1") === writesBeforeUncertainRetry);

// --- 7. A manual edit between the failure and the retry ----------------------------
console.log("\n### 7. a designer edit between the failure and the retry");
faults.generateThrow = 1;
await failureOf(executeCellSync(runFor("G1")));
// A real designer write to the disposable page: unmarked source, which is designer work.
await designer(`
  await api.page.setCells({ pageName: ${JSON.stringify(PAGE)}, cells: [{ cell: "G1", cellType: "ReactCellTypeCellType", cellTypeProps: { code: "function App() { return null; } // edited after the failure\\n", frontendLibraries: [] } }] });
  return true;
`);
const writesBeforeEditedRetry = writesFor("G1");
await settleProject();
const editedRetry = await executeCellSync(runFor("G1"));
check("the retry refuses the edited Cell", editedRetry.status === "refused", editedRetry.status);
check(
  "the refusal names gate-refused, not the skip",
  editedRetry.status === "refused" && editedRetry.dispatch.reason === "gate-refused",
  editedRetry.status === "refused" ? editedRetry.dispatch.reason : editedRetry.status,
);
check("the retry issued no write over the edit", writesFor("G1") === writesBeforeEditedRetry);
const persistedEdit = await designer(
  `const g = await api.page.getCells({ pageName: ${JSON.stringify(PAGE)}, range: "G1" }); return g.cells[0]?.cellTypeProps?.code ?? null;`,
  "readAuto",
);
check("the designer's edit is still what the Cell holds", String(persistedEdit).includes("edited after the failure"));

// --- 8. A batch whose second target fails ------------------------------------------
console.log("\n### 8. a batch that stops on its second target");
await settleProject();
const registry = createCellRegistry(
  {
    runtime: { forguncyVersion: "12.0.101", projectAlias: "issue93" },
    cells: {
      probeH: { entry: "cells/probeH/App.tsx", target: { pageName: PAGE, cell: "H1" } },
      probeI: { entry: "cells/probeI/App.tsx", target: { pageName: PAGE, cell: "I1" } },
      probeJ: { entry: "cells/probeJ/App.tsx", target: { pageName: PAGE, cell: "J1" } },
    },
  },
  { root: process.cwd(), requireEntryFiles: false },
);
generateCalls = 0;
faults.generateThrowAtCall = 2;
const batchReport = await executeCellSyncBatch(
  registry,
  [
    { cellId: "probeH", artifact, decisions, port },
    { cellId: "probeI", artifact, decisions, port },
    { cellId: "probeJ", artifact, decisions, port },
  ],
  { onTransportFailure: "stop" },
);
check(
  "the batch reports landed / failed / not-attempted in order",
  batchReport.outcomes.map(outcome => outcome.kind).join(",") === "run,transport-failure,not-attempted",
  batchReport.outcomes.map(outcome => outcome.kind).join(","),
);
check(
  "the earlier landed write is reported despite the later failure",
  batchReport.mutatedTargets.some(target => target.cell === "H1") &&
    batchReport.mutatedTargets.some(target => target.cell === "I1"),
  batchReport.mutatedTargets.map(target => target.cell).join(","),
);
const persistedBatch = await designer(
  `const g = await api.page.getCells({ pageName: ${JSON.stringify(PAGE)}, range: "H1:J1" }); return g.cells.map(c => ({ cell: c.col, hasCode: typeof c.cellTypeProps?.code === "string" }));`,
  "readAuto",
);
check("the batch's landed Cells persisted generated code", persistedBatch.length >= 2 && persistedBatch.every(cell => cell.hasCode), JSON.stringify(persistedBatch));

// --- Result ------------------------------------------------------------------------
const failed = checks.filter(entry => !entry.ok);
console.log("\n### RESULT");
console.log(
  JSON.stringify(
    {
      page: PAGE,
      passed: checks.length - failed.length,
      total: checks.length,
      failed: failed.map(entry => entry.name),
      coveredByThisRun: [
        "normal first sync and repeated sync (unchanged, no second write)",
        "save declined after a landed write, then retry",
        "generate throw / blank locator after a landed write, then retry",
        "injected non-zero error count, then retry",
        "port-level lost setCells response, confirmed by a live read-back",
        "designer edit between failure and retry, refused",
        "batch partial success with stop policy",
      ],
      coveredOnlyByTheStatefulRecordingPort: [
        "a real setCells whose response is lost after the product applied it (this script simulates at the port boundary)",
        "a real saveProject that fails on disk",
        "a real checkProjectErrors transport failure",
        "the `continue` batch policy against a real target",
      ],
      note:
        "All faults here are port-level injections against a live disposable project; no destructive real-designer fault was induced. See src/retry.test.ts for the simulated-fault matrix and evidence separation.",
    },
    null,
    2,
  ),
);
if (failed.length > 0) process.exitCode = 1;
