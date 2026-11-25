/**
 * #185's real-machine acceptance: compile a production Cell with the auto-height
 * injection, deploy it to the live designer, and measure height adaptation in a real
 * browser — with NO `frontendLibraries` reference to reactcell-autoh.
 *
 * This is the verification AGENTS.md rule 7 requires be separated from local evidence:
 * the unit tests prove the artifact *carries* the patch; this script proves a real
 * Forguncy 12.0.102.0 page renders the cell height-adaptive because of it.
 *
 * The subject cell is purpose-built rather than the dev-harness example, and the reason
 * is measurement: the example exercises the facade's declared-props path, whose absence
 * fails the platform's write-time validation for a probe page that declares no bindings.
 * This cell renders a tall static block (~1500px of lines) with no prop reads at all,
 * which is also the case the blank-tail mechanism is sharpest against: a default-height
 * grid row clips the tall content when unpatched, so the fixed control and the adaptive
 * cell read visibly different container heights.
 *
 * What it does:
 *  1. Compiles the tall cell through the public compile entry — once with the default
 *     (adaptive) and once with `heightMode: "fixed"`.
 *  2. Writes both artifacts into a fresh probe page `fgc-verify-185-*` — adaptive at
 *     A1, fixed at A10 — with `frontendLibraries: []` on both, so nothing external can
 *     be doing the patching.
 *  3. Generates the project, drives a real browser, and measures: the diagnostic
 *     global's state, container vs content heights on both cells, console errors.
 *
 * Requirements: designer on http://localhost:11234/mcp with the project open, a CDP
 * browser on http://localhost:9333, dev-site credential Administrator/123456 accepted.
 * Never saves the project; the probe page is left for manual inspection.
 *
 * Run from the repository root or the package directory:
 *   node --experimental-strip-types scripts/verify-autoh-injection-185.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_URL = process.env.FGC_MCP_URL ?? "http://localhost:11234/mcp";
const CDP_BASE = process.env.CDP_BASE ?? "http://localhost:9333";
const OUT_DIR = process.env.FGC_PROBE_OUT ?? join(HERE, ".verify-185-evidence");
mkdirSync(OUT_DIR, { recursive: true });

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const PAGE = `fgc-verify-185-${RUN_ID}`;

// ---------------------------------------------------------------------------
// Step 1: compile a tall content-free cell, adaptive and fixed
// ---------------------------------------------------------------------------

const { compileCell, createRolldownCellBundler } = await import("@forguncy-react-workspace/cell-compiler");

// The cell source, written to a scratch dir beside this script so `react` resolves
// through the workspace's own node_modules exactly as the unit-test compiles resolve it.
const scratchDir = join(OUT_DIR, "scratch-cell");
mkdirSync(scratchDir, { recursive: true });
const entry = join(scratchDir, "TallCell.tsx");
writeFileSync(
  entry,
  [
    `// 50 lines at 30px each — ~1500px of content in a default-height grid row.`,
    `// No props, no facade: what is measured here is the container, not the bindings.`,
    `export function App() {`,
    `  const rows = [];`,
    `  for (let i = 1; i <= 50; i += 1) {`,
    `    rows.push(<div key={i} style={{ height: "30px", lineHeight: "30px", borderBottom: "1px solid #eee" }}>row {i}</div>);`,
    `  }`,
    `  return <section data-verify-185="tall">{rows}</section>;`,
    `}`,
    ``,
  ].join("\n"),
);

const dependencies = [{ strategy: "host", packageName: "react", globalName: "React" }];

async function compileOne(layout) {
  const outcome = await compileCell(
    { entry, dependencies: [...dependencies] },
    {
      bundler: createRolldownCellBundler({ dir: scratchDir }),
      ...(layout === undefined ? {} : { layout }),
    },
  );
  if (outcome.status !== "compiled") {
    throw new Error(`compile rejected: ${outcome.diagnostics.map(d => `${d.code}: ${d.message}`).join("; ")}`);
  }
  return outcome.artifact.code;
}

const adaptiveCode = await compileOne();
const fixedCode = await compileOne({ heightMode: "fixed" });

const evidence = {
  runId: RUN_ID,
  page: PAGE,
  compile: {
    adaptiveChars: adaptiveCode.length,
    fixedChars: fixedCode.length,
    increment: adaptiveCode.length - fixedCode.length,
    adaptiveHasBanner: adaptiveCode.includes("auto-height contract"),
    fixedHasBanner: fixedCode.includes("auto-height contract"),
  },
};
console.log(`## compiled: adaptive ${adaptiveCode.length} chars, fixed ${fixedCode.length} chars, increment ${adaptiveCode.length - fixedCode.length}`);

// ---------------------------------------------------------------------------
// MCP + CDP transports (same pattern as the other probes)
// ---------------------------------------------------------------------------

let sessionId = null;
async function rpc(method, params) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const r = await fetch(MCP_URL, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }),
  });
  const assigned = r.headers.get("mcp-session-id");
  if (assigned) sessionId = assigned;
  const text = await r.text();
  const payloads = text.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5).trim()));
  return payloads.length === 1 ? payloads[0] : payloads;
}
async function connect() {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "fgc-verify-185", version: "0" },
  });
  await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return init;
}
const callTool = (name, args) => rpc("tools/call", { name, arguments: args });
async function designer(script) {
  const r = await callTool("execute_code", {
    title: "verify-185",
    code: `const __run = async () => { ${script} };\nreturn await __run();`,
    permissionMode: "safeWriteAuto",
  });
  if (r?.result?.isError) throw new Error(r.result.content?.[0]?.text ?? "designer error");
  const text = r?.result?.content?.map(b => b.text).join("\n") ?? "";
  return JSON.parse(text).result;
}

await connect();

// ---------------------------------------------------------------------------
// Step 2: probe page with both artifacts, NO frontendLibraries
// ---------------------------------------------------------------------------

await designer(`
  const pages = await api.page.listPages({});
  if (pages.some(p => p.name === ${JSON.stringify(PAGE)})) throw new Error("page exists");
  await api.page.createPage({ name: ${JSON.stringify(PAGE)}, rowCount: 30, columnCount: 12 });
  return true;
`);

// The adaptive cell at A1, the fixed control at A10 — both spanning one row of default
// height, so the unpatched clipping case is the control's behavior. `frontendLibraries: []`
// on both: the only auto-height mechanism on the page can be the compiled injection.
await designer(`
  await api.page.setCells({ pageName: ${JSON.stringify(PAGE)}, cells: [
    {
      cell: "A1",
      cellType: "ReactCellTypeCellType",
      name: "verifyAdaptive",
      cellTypeProps: { code: ${JSON.stringify(adaptiveCode)}, frontendLibraries: [] }
    },
    {
      cell: "A10",
      cellType: "ReactCellTypeCellType",
      name: "verifyFixed",
      cellTypeProps: { code: ${JSON.stringify(fixedCode)}, frontendLibraries: [] }
    }
  ]});
  return true;
`);
console.log(`## probe page written: ${PAGE} (adaptive at A1, fixed control at A10, frontendLibraries empty on both)`);

const gen = await designer(`return await api.app.generateProject({});`);
if (!gen.success) throw new Error(`generateProject failed: ${JSON.stringify(gen).slice(0, 400)}`);

// ---------------------------------------------------------------------------
// Step 3: drive the browser, measure both cells
// ---------------------------------------------------------------------------

async function newTab(targetUrl) {
  let r = await fetch(`${CDP_BASE}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
  if (!r.ok) r = await fetch(`${CDP_BASE}/json/new?${encodeURIComponent(targetUrl)}`);
  return r.json();
}
function connectWS(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
  });
}

const pageUrl = `${gen.url}/${encodeURIComponent(PAGE)}`;
const tab = await newTab(pageUrl);
const ws = await connectWS(tab.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener("message", ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "exception");
  } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    consoleErrors.push((msg.params.args ?? []).map(a => a.value ?? a.description ?? "").join(" ").slice(0, 300));
  }
});
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise, timeout: 20000 });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.text, desc: r.exceptionDetails.exception?.description };
  return r.result?.value;
}

await send("Runtime.enable");
await send("Page.enable");
await new Promise(r => setTimeout(r, 4000));

const loginState = await evaluate(`(function(){
  return { href: location.href, hasUser: !!document.querySelector('input[type=password]') };
})()`);
if (loginState.hasUser) {
  await evaluate(`(function(){
    function setVal(el, val){ if (!el) return; el.focus(); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    setVal(document.querySelector('input[type=text]'), 'Administrator');
    setVal(document.querySelector('input[type=password]'), '123456');
    const btn = document.querySelector('button');
    if (btn) btn.click();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 5000));
  await send("Page.navigate", { url: pageUrl });
  await new Promise(r => setTimeout(r, 7000));
}

// Give the patch's polling loop room to land, then measure everything.
await new Promise(r => setTimeout(r, 2000));

evidence.runtime = await evaluate(`(function(){
  var out = {};
  out.href = location.href;
  out.diagPresent = typeof globalThis.__fgcReactCellAutoHeight !== "undefined";
  if (out.diagPresent) {
    out.diag = {
      patched: globalThis.__fgcReactCellAutoHeight.patched,
      attempts: globalThis.__fgcReactCellAutoHeight.attempts,
      error: globalThis.__fgcReactCellAutoHeight.error,
    };
  }
  out.externalLibraryPresent = typeof globalThis.ReactCellAutoHeight !== "undefined";
  var entry = typeof Forguncy !== "undefined" && Forguncy.Plugin && Forguncy.Plugin.CellTypeHelper &&
    Forguncy.Plugin.CellTypeHelper._registedCellTypes["ReactCellType.ReactCellTypeCellType, ReactCellType"];
  out.ctorGuardSet = !!(entry && entry[0] && entry[0].cellTypeCtor && entry[0].cellTypeCtor.prototype.__reactCellAutoHeightPatched);

  // measure every content root on the page
  out.roots = [];
  var all = document.querySelectorAll("[id]");
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!/^r\\d+c\\d+p$/.test(el.id)) continue;
    var rect = el.getBoundingClientRect();
    var contentBottom = 0;
    var walker = el.querySelectorAll("*");
    for (var j = 0; j < walker.length; j++) {
      var r2 = walker[j].getBoundingClientRect();
      if (r2.bottom > contentBottom) contentBottom = r2.bottom;
    }
    out.roots.push({
      id: el.id,
      markerClass: el.classList.contains("fgc-reactcell-autoh"),
      inlineHeight: el.style.height,
      inlineMinHeight: el.style.minHeight,
      containerHeightPx: Math.round(rect.height * 100) / 100,
      contentExtentPx: Math.round((contentBottom > 0 ? contentBottom - rect.top : 0) * 100) / 100,
      blankTailPx: Math.round((rect.height - (contentBottom > 0 ? contentBottom - rect.top : 0)) * 100) / 100,
    });
  }
  return out;
})()`);

evidence.consoleErrors = consoleErrors;

writeFileSync(join(OUT_DIR, `verify-${RUN_ID}.json`), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence.runtime, null, 2));
console.log(`\n## console errors: ${consoleErrors.length}`);
for (const err of consoleErrors.slice(0, 5)) console.log(`  - ${err}`);
console.log(`## evidence written to ${join(OUT_DIR, `verify-${RUN_ID}.json`)}`);
console.log(`## probe page left in designer: ${PAGE} (never saved)`);
process.exit(0);
