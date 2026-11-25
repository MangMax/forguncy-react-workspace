/**
 * #185's fixed-only control: a page carrying ONLY the opt-out cell must show NO patch
 * activity — proving the `heightMode: "fixed"` artifact does not self-inject.
 *
 * The companion to `verify-autoh-injection-185.mjs`'s shared-page measurement. The two
 * results together are the honest statement of the Epic's semantics:
 *
 * - shared page (adaptive + fixed): BOTH cells render adaptive, because the patch is a
 *   page-global prototype wrap — per-instance opt-out is the Epic's explicit non-goal
 *   ("本轮全局生效；若后续有 cell 需要固定高度，再引入 opt-out 声明");
 * - fixed-only page (this script): no patch, no diagnostic global, container clipped at
 *   the grid row's height — proving the opt-out artifact carries no injection of its own.
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
const PAGE = `fgc-verify185fix-${RUN_ID}`;

const { compileCell, createRolldownCellBundler } = await import("@forguncy-react-workspace/cell-compiler");

const scratchDir = join(OUT_DIR, "scratch-cell");
mkdirSync(scratchDir, { recursive: true });
const entry = join(scratchDir, "TallCell.tsx");
writeFileSync(
  entry,
  [
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
const outcome = await compileCell(
  { entry, dependencies: [...dependencies] },
  { bundler: createRolldownCellBundler({ dir: scratchDir }), layout: { heightMode: "fixed" } },
);
if (outcome.status !== "compiled") throw new Error(`compile rejected: ${outcome.diagnostics.map(d => d.code).join(",")}`);
const fixedCode = outcome.artifact.code;

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
    clientInfo: { name: "fgc-verify-185-control", version: "0" },
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
    title: "verify-185-control",
    code: `const __run = async () => { ${script} };\nreturn await __run();`,
    permissionMode: "safeWriteAuto",
  });
  if (r?.result?.isError) throw new Error(r.result.content?.[0]?.text ?? "designer error");
  const text = r?.result?.content?.map(b => b.text).join("\n") ?? "";
  return JSON.parse(text).result;
}

await connect();
await designer(`
  const pages = await api.page.listPages({});
  if (pages.some(p => p.name === ${JSON.stringify(PAGE)})) throw new Error("page exists");
  await api.page.createPage({ name: ${JSON.stringify(PAGE)}, rowCount: 30, columnCount: 12 });
  return true;
`);
await designer(`
  await api.page.setCells({ pageName: ${JSON.stringify(PAGE)}, cells: [
    { cell: "A1", cellType: "ReactCellTypeCellType", name: "verifyFixedOnly", cellTypeProps: { code: ${JSON.stringify(fixedCode)}, frontendLibraries: [] } }
  ]});
  return true;
`);
console.log(`## fixed-only probe page written: ${PAGE}`);
const gen = await designer(`return await api.app.generateProject({});`);
if (!gen.success) throw new Error("generate failed");

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
    consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? "exception");
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

const loginState = await evaluate(`(function(){ return { hasUser: !!document.querySelector('input[type=password]') }; })()`);
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
// generous margin beyond the patch's own poll budget — a false pass here is the whole point
await new Promise(r => setTimeout(r, 6000));

const result = await evaluate(`(function(){
  var out = {};
  out.diagPresent = typeof globalThis.__fgcReactCellAutoHeight !== "undefined";
  var entry = typeof Forguncy !== "undefined" && Forguncy.Plugin && Forguncy.Plugin.CellTypeHelper &&
    Forguncy.Plugin.CellTypeHelper._registedCellTypes["ReactCellType.ReactCellTypeCellType, ReactCellType"];
  out.ctorGuardSet = !!(entry && entry[0] && entry[0].cellTypeCtor && entry[0].cellTypeCtor.prototype.__reactCellAutoHeightPatched);
  out.styleTagPresent = !!document.querySelector("style[data-reactcell-autoh]");
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
      containerHeightPx: Math.round(rect.height * 100) / 100,
      contentExtentPx: Math.round((contentBottom > 0 ? contentBottom - rect.top : 0) * 100) / 100,
    });
  }
  return out;
})()`);

const report = { runtime: result, consoleErrors };
console.log(JSON.stringify(report, null, 2));
writeFileSync(join(OUT_DIR, `control-${RUN_ID}.json`), JSON.stringify(report, null, 2));
console.log(`## control evidence written to ${join(OUT_DIR, `control-${RUN_ID}.json`)}`);
process.exit(0);
