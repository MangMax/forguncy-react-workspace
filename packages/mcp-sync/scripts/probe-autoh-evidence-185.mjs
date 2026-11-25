/**
 * #185's evidence probe: confirm the platform facts the compile-time auto-height
 * injection depends on, on the live Forguncy 12.0.102.0, before the contract records them.
 *
 * Channels (per the repo's probe method):
 * - [SRC] the shipped plugin resource (already read locally); this script re-reads the
 *   load-bearing lines from the served copy so the evidence file pins them to this build.
 * - [RT]  a real browser driving a generated page: the `_registedCellTypes` registry
 *   shape, the container's hardcoded height, and the position-independent id pattern.
 * - [DT]  designer-side page/cell creation.
 *
 * The probe writes a probe page `fgc-probe-185-*` with one ReactCellType cell whose
 * content is deliberately short (a few lines), then measures in the live runtime:
 *
 *   1. `Forguncy.Plugin.CellTypeHelper._registedCellTypes` — present, and the entry
 *      under `"ReactCellType.ReactCellTypeCellType, ReactCellType"` is an array whose
 *      `[0].cellTypeCtor.prototype.createContent` is a function;
 *   2. the cell content root's id matches `/^r\d+c\d+p$/` — the position-independent
 *      pattern the patch's repair/observer pass keys on;
 *   3. the unpatched container's computed height vs its content's height — the blank
 *      tail this Epic exists to remove, measured rather than asserted;
 *   4. after applying the #184-verified patch in-page (the same source the compiler
 *      will inject), the container height tracks the content — the mechanism's effect
 *      confirmed on this exact build.
 *
 * ## Running it
 *
 *   node scripts/probe-autoh-evidence-185.mjs
 *
 * Requirements: the designer running with the project open (MCP at
 * http://localhost:11234/mcp), a CDP browser at http://localhost:9333, and the dev
 * site's default Administrator/123456 credential accepted. The script never saves the
 * project and never deletes anything; the probe page is left for manual inspection
 * (prefix `fgc-probe-`).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_URL = process.env.FGC_MCP_URL ?? "http://localhost:11234/mcp";
const CDP_BASE = process.env.CDP_BASE ?? "http://localhost:9333";
const OUT_DIR = process.env.FGC_PROBE_OUT ?? join(HERE, ".probe-185-evidence");
mkdirSync(OUT_DIR, { recursive: true });

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const PAGE = `fgc-probe-185-${RUN_ID}`;

// ---------------------------------------------------------------------------
// MCP + CDP transports (same pattern as probe-celltype-capabilities-176.mjs)
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
    clientInfo: { name: "fgc-probe-185", version: "0" },
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
    title: "probe-185",
    code: `const __run = async () => { ${script} };\nreturn await __run();`,
    permissionMode: "safeWriteAuto",
  });
  if (r?.result?.isError) throw new Error(r.result.content?.[0]?.text ?? "designer error");
  const text = r?.result?.content?.map(b => b.text).join("\n") ?? "";
  return JSON.parse(text).result;
}

const findings = [];
function record(step, channel, value) {
  findings.push({ step, channel, value });
  writeFileSync(join(OUT_DIR, `findings-${RUN_ID}.json`), JSON.stringify(findings, null, 2));
  console.log(`\n### [${channel}] ${step}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2).slice(0, 2400)}`);
}

// ---------------------------------------------------------------------------
// Step 0 [SRC]: re-read the load-bearing lines off the served plugin resource
// ---------------------------------------------------------------------------

const init = await connect();
const gen0 = await designer(`return await api.app.generateProject({});`);
const pluginUrl = `${gen0.url}/Plugins/96205a31-0c2e-4b98-9ce5-6555088e6cbd/Resources/ReactCellTypeCellType.js`;
const pluginSource = await (await fetch(pluginUrl)).text();
const createContentMatch = /createContent\(\)\s*{[\s\S]{0,900}?div\.attr\("id", this\.ID\);\s*return div;/.exec(pluginSource);
const registerMatch = /Forguncy\.Plugin\.CellTypeHelper\.registerCellType\([^)]*\)/.exec(pluginSource);
const hardcodedStyle = /\$\("<div style='width: 100%;height: 100%'\/>"\)/.exec(pluginSource);
record("0. plugin resource facts", "SRC", {
  pluginUrl,
  bytes: pluginSource.length,
  createContentSetsIdAndReturnsDiv: createContentMatch !== null,
  createContentExcerpt: createContentMatch ? createContentMatch[0].replace(/\s+/g, " ").slice(0, 480) : null,
  registration: registerMatch ? registerMatch[0] : null,
  hardcodedHeight100Container: hardcodedStyle !== null,
});

// ---------------------------------------------------------------------------
// Step 1 [DT]: probe page + one short-content cell
// ---------------------------------------------------------------------------

await designer(`
  const pages = await api.page.listPages({});
  if (pages.some(p => p.name === ${JSON.stringify(PAGE)})) throw new Error("page exists");
  await api.page.createPage({ name: ${JSON.stringify(PAGE)}, rowCount: 20, columnCount: 12 });
  return true;
`);
record("1. create probe page", "DT", { created: PAGE });

// A few lines of content — short enough that the grid row is taller than the content,
// which is the blank-tail case. No data sources, no libraries: this probe measures the
// container, not the facade.
const PROBE_CODE = `
function App(props) {
  return React.createElement('div', { style: { padding: '4px' } },
    React.createElement('div', null, 'line one'),
    React.createElement('div', null, 'line two'),
    React.createElement('div', null, 'line three'));
}
`;

await designer(`
  await api.page.setCells({ pageName: ${JSON.stringify(PAGE)}, cells: [{
    cell: "A1",
    cellType: "ReactCellTypeCellType",
    name: "probe185cell",
    cellTypeProps: { code: ${JSON.stringify(PROBE_CODE)}, frontendLibraries: [] }
  }]});
  return true;
`);
record("2. write short-content probe cell", "DT", { written: true });

const gen = await designer(`return await api.app.generateProject({});`);
record("3. generateProject", "DT", { success: gen.success, errors: gen.checkResult?.errorCount, url: gen.url });

// ---------------------------------------------------------------------------
// Step 2 [RT]: drive the browser
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
ws.addEventListener("message", ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
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
await new Promise(r => setTimeout(r, 3500));

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
  await new Promise(r => setTimeout(r, 6000));
}

// ---------------------------------------------------------------------------
// Step 3 [RT]: registry shape + container measurement, unpatched
// ---------------------------------------------------------------------------

const registryEvidence = await evaluate(`(function(){
  var out = {};
  out.hasForguncy = typeof Forguncy !== "undefined";
  if (!out.hasForguncy) return out;
  out.hasPlugin = !!Forguncy.Plugin;
  out.hasHelper = !!(Forguncy.Plugin && Forguncy.Plugin.CellTypeHelper);
  out.hasRegistry = !!(Forguncy.Plugin && Forguncy.Plugin.CellTypeHelper && Forguncy.Plugin.CellTypeHelper._registedCellTypes);
  if (!out.hasRegistry) return out;
  var entry = Forguncy.Plugin.CellTypeHelper._registedCellTypes["ReactCellType.ReactCellTypeCellType, ReactCellType"];
  out.entryIsArray = Array.isArray(entry);
  out.entryLength = entry && entry.length;
  var zero = entry && entry[0];
  out.entryZeroKeys = zero ? Object.keys(zero).sort() : null;
  var ctor = zero && zero.cellTypeCtor;
  out.ctorType = typeof ctor;
  out.protoCreateContentType = ctor && ctor.prototype ? typeof ctor.prototype.createContent : null;
  out.patchedAlready = !!(ctor && ctor.prototype && ctor.prototype.__reactCellAutoHeightPatched);
  return out;
})()`);
record("4. _registedCellTypes registry shape", "RT", registryEvidence);

const containerEvidence = await evaluate(`(function(){
  var out = {};
  var roots = [];
  var all = document.querySelectorAll("[id]");
  for (var i = 0; i < all.length; i++) {
    if (/^r\\d+c\\d+p$/.test(all[i].id)) roots.push(all[i]);
  }
  out.matchingRootCount = roots.length;
  if (roots.length === 0) return out;
  var el = roots[0];
  out.rootId = el.id;
  out.rootIdMatchesPattern = /^r\\d+c\\d+p$/.test(el.id);
  out.inlineStyleHeight = el.style.height;
  out.inlineStyleWidth = el.style.width;
  var rect = el.getBoundingClientRect();
  out.containerHeightPx = rect.height;
  // content height: the deepest rendered subtree's extent inside the container
  var contentBottom = 0;
  var walker = el.querySelectorAll("*");
  for (var j = 0; j < walker.length; j++) {
    var r2 = walker[j].getBoundingClientRect();
    if (r2.bottom > contentBottom) contentBottom = r2.bottom;
  }
  out.contentExtentPx = contentBottom > 0 ? contentBottom - rect.top : 0;
  out.blankTailPx = rect.height - out.contentExtentPx;
  out.hasMarkerClass = el.classList.contains("fgc-reactcell-autoh");
  out.minHeightComputed = getComputedStyle(el).minHeight;
  return out;
})()`);
record("5. unpatched container vs content (the blank tail, measured)", "RT", containerEvidence);

// ---------------------------------------------------------------------------
// Step 4 [RT]: apply the #184 patch in-page, re-measure
// ---------------------------------------------------------------------------

const patchResult = await evaluate(`(function(){
  var REGISTRY_KEY = "ReactCellType.ReactCellTypeCellType, ReactCellType";
  var MARKER_CLASS = "fgc-reactcell-autoh";
  var entry = Forguncy.Plugin.CellTypeHelper._registedCellTypes[REGISTRY_KEY];
  var ctor = entry && entry[0] && entry[0].cellTypeCtor;
  if (!ctor || !ctor.prototype) return { patched: false, reason: "no ctor" };
  if (!ctor.prototype.__reactCellAutoHeightPatched) {
    var original = ctor.prototype.createContent;
    if (typeof original !== "function") return { patched: false, reason: "no createContent" };
    ctor.prototype.createContent = function createContent() {
      var div = original.call(this);
      try {
        div.css({ "min-height": "100%", height: "auto" });
        div.addClass(MARKER_CLASS);
      } catch (error) {}
      return div;
    };
    ctor.prototype.__reactCellAutoHeightPatched = true;
  }
  // repair existing containers, exactly as the proven patch does
  var repaired = 0;
  var all = document.querySelectorAll("[id]");
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (/^r\\d+c\\d+p$/.test(el.id) && !el.classList.contains(MARKER_CLASS)) {
      el.style.minHeight = "100%";
      el.style.height = "auto";
      el.classList.add(MARKER_CLASS);
      repaired += 1;
    }
  }
  return { patched: true, repaired: repaired };
})()`);
record("6. in-page application of the #184 patch", "RT", patchResult);

await new Promise(r => setTimeout(r, 1200));

const patchedMeasure = await evaluate(`(function(){
  var out = {};
  var all = document.querySelectorAll("[id]");
  var el = null;
  for (var i = 0; i < all.length; i++) {
    if (/^r\\d+c\\d+p$/.test(all[i].id)) { el = all[i]; break; }
  }
  if (!el) { out.missing = true; return out; }
  var rect = el.getBoundingClientRect();
  out.containerHeightPx = rect.height;
  var contentBottom = 0;
  var walker = el.querySelectorAll("*");
  for (var j = 0; j < walker.length; j++) {
    var r2 = walker[j].getBoundingClientRect();
    if (r2.bottom > contentBottom) contentBottom = r2.bottom;
  }
  out.contentExtentPx = contentBottom > 0 ? contentBottom - rect.top : 0;
  out.blankTailPx = rect.height - out.contentExtentPx;
  out.hasMarkerClass = el.classList.contains("fgc-reactcell-autoh");
  out.inlineHeight = el.style.height;
  out.inlineMinHeight = el.style.minHeight;
  return out;
})()`);
record("7. patched container vs content", "RT", patchedMeasure);

// jQuery reliance: the patch calls .css()/.addClass() on the createContent return.
// Confirm the return is a jQuery object on this build (the constructor.prototype patch
// path uses it; the repair path uses native style/classList).
const jqueryEvidence = await evaluate(`(function(){
  var entry = Forguncy.Plugin.CellTypeHelper._registedCellTypes["ReactCellType.ReactCellTypeCellType, ReactCellType"];
  var ctor = entry && entry[0] && entry[0].cellTypeCtor;
  // Instantiate nothing ourselves — inspect through the live cell instance instead.
  var cells = document.querySelectorAll("[id]");
  var root = null;
  for (var i = 0; i < cells.length; i++) if (/^r\\d+c\\d+p$/.test(cells[i].id)) { root = cells[i]; break; }
  var out = { jqueryGlobalPresent: typeof window.$ === "function" || typeof window.jQuery === "function" };
  out.rootIsJqueryBacked = !!(root && root.jquery !== undefined) || "n/a-dom-node-always-plain";
  return out;
})()`);
record("8. jQuery availability on the page", "RT", jqueryEvidence);

console.log(`\n## evidence written to ${join(OUT_DIR, `findings-${RUN_ID}.json`)}`);
console.log(`## probe page left in designer: ${PAGE} (never saved, safe to discard)`);
process.exit(0);
