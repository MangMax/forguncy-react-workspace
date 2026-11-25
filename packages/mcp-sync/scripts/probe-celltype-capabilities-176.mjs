/**
 * #176's reproducible probe: measure ReactCellType runtime facade call shapes and
 * `cellTypeProps` schema on Forguncy 12.0.102.0.
 *
 * This is not an automated test. It is the executed evidence behind the contract
 * table updates #176 makes — see the issue comment for the full report.
 *
 * ## What it does
 *
 * 1. **[DT]** Writes a probe cell carrying every supported `cellTypeProps` field
 *    (`properties` / `eventHandlers` / `dataSources` / `permissions` /
 *    `availableServerCommands` / `uploadLimit` / `libraries` / `frontendLibraries`),
 *    reads it back through `api.page.getCells`, and records the exact round-trip
 *    shape the platform persists.
 * 2. **[DT]** Negative probes: writes bad `dataSources`/`eventHandlers`/`properties`/
 *    `permissions`/`availableServerCommands` element shapes and records the
 *    Json.NET deserialization errors verbatim.
 * 3. **[RT]** Generates the project, drives a real headless Chrome over CDP,
 *    logs in as Administrator (the dev site's printed default), and inside the
 *    live ReactCellType runtime evaluates:
 *    - `props.Forguncy` member types
 *    - `getCurrentUser()` return shape
 *    - `getUploadLimit()` return shape and units
 *    - `uploadFiles` validation errors, single/File/Array/FileList shapes,
 *      attachment-string format, `uploadFolder` option, sizeLimit unit (MB)
 *    - `hasPermission` / `getPermissions` / `Permissions` prop behaviour
 *    - `ConvertToCssColor` / `ConvertDateToOADate` / `ConvertOADateToDate` exact
 *      input/output shapes
 *    - `exposeMethod` registration, overwrite semantics, and the
 *      `CellType.ExecuteMethod` invocation path through `page.getCell(name).getCellType()`
 *    - `useDataSource` result fields (`data`/`totalCount`/`loading`/`error`/`reload`)
 *    - `SetPropertyValue` re-render semantics (no entry re-execution)
 *    - `props.ImageContext` empty-object default
 *
 * ## Running it
 *
 *   node --experimental-strip-types scripts/probe-celltype-capabilities-176.mjs
 *
 * Requirements:
 * - Forguncy designer running with the ReactCellType project open (MCP http://localhost:11234/mcp)
 * - Headless Chrome reachable at http://localhost:9333 (this script does not launch Chrome;
 *   it uses whatever debug port `CDP_BASE` points at — see `.probe-176/cdp-drive.mjs` in the
 *   evidence archive for the launcher pattern)
 * - The dev site's default `Administrator`/`123456` credential is accepted
 *
 * The page name carries the run id so a second run never reuses a probe page, and the
 * script makes no `write/dangerous` call: it neither deletes pages nor saves the project.
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_URL = process.env.FGC_MCP_URL ?? "http://localhost:11234/mcp";
const CDP_BASE = process.env.CDP_BASE ?? "http://localhost:9333";
const OUT_DIR = process.env.FGC_PROBE_OUT ?? join(HERE, ".probe-176-evidence");
mkdirSync(OUT_DIR, { recursive: true });

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const PAGE = `fgc-probe-176-${RUN_ID}`;

// ---------------------------------------------------------------------------
// MCP + CDP transports
// ---------------------------------------------------------------------------

let sessionId = null;
async function rpc(method, params) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
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
    clientInfo: { name: "fgc-probe-176", version: "0" },
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
    title: "probe-176",
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
  console.log(`\n### [${channel}] ${step}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2).slice(0, 2000)}`);
}

// ---------------------------------------------------------------------------
// Step 1: create a fresh probe page
// ---------------------------------------------------------------------------

const init = await connect();
record("environment", "INF", {
  serverInfo: init?.result?.serverInfo,
  page: PAGE,
  runId: RUN_ID,
  mcpUrl: MCP_URL,
  cdpBase: CDP_BASE,
});

await designer(`
  const pages = await api.page.listPages({});
  if (pages.some(p => p.name === ${JSON.stringify(PAGE)})) throw new Error("page exists");
  await api.page.createPage({ name: ${JSON.stringify(PAGE)}, rowCount: 20, columnCount: 12 });
  return true;
`);
record("1. create probe page", "DT", { created: PAGE });

// ---------------------------------------------------------------------------
// Step 2: write a cell with all seven fields populated, read back round-trip
// ---------------------------------------------------------------------------

const PROBE_CODE = `
window.__probeExec = (window.__probeExec || 0) + 1;
function App(props) {
  window.__probeAppCalls = (window.__probeAppCalls || 0) + 1;
  var F = props.Forguncy || {};
  var out = {};
  out.propKeys = Object.keys(props).sort();
  out.forguncyKeys = Object.keys(F).sort();
  out.forguncyTypeof = {};
  Object.keys(F).forEach(function(k){ out.forguncyTypeof[k] = typeof F[k]; });
  try {
    var u = F.getCurrentUser();
    out.getCurrentUser_keys = u && typeof u === 'object' ? Object.keys(u).sort() : null;
    out.getCurrentUser_sample = { UserName: u.UserName, FullName: u.FullName, Role: u.Role, Email: u.Email, HasPicture: u.HasPicture, PictureUrl: u.PictureUrl };
  } catch(e) { out.getCurrentUser_err = String(e); }
  try { out.getUploadLimit = F.getUploadLimit(); } catch(e) { out.getUploadLimit_err = String(e); }
  try {
    out.hasPermission_probed = F.hasPermission('Probe176.Permission');
    out.hasPermission_missing = F.hasPermission('NonexistentPerm176');
    out.hasPermission_empty = F.hasPermission('');
    out.hasPermission_null = F.hasPermission(null);
    out.hasPermission_caseLower = F.hasPermission('probe176.permission');
  } catch(e) { out.hasPermission_err = String(e); }
  try {
    var p1 = F.getPermissions(); var p2 = F.getPermissions();
    out.getPermissions_keys = p1 ? Object.keys(p1).sort() : null;
    out.getPermissions_snapshot = p1;
    out.getPermissions_returnsCopy = p1 !== p2;
    out.Permissions_prop_sameAsFacade = props.Permissions === F.Permissions;
  } catch(e) { out.permErr = String(e); }
  try {
    out.ccc_hex6 = F.ConvertToCssColor('#FF0000');
    out.ccc_argb = F.ConvertToCssColor('#80FF0000');
    out.ccc_argb_full = F.ConvertToCssColor('#FFFF0000');
    out.ccc_argb_zero = F.ConvertToCssColor('#00FF0000');
    out.ccc_hexshort = F.ConvertToCssColor('#f00');
    out.ccc_rgb = F.ConvertToCssColor('rgb(255,0,0)');
    out.ccc_named = F.ConvertToCssColor('red');
    out.ccc_empty = F.ConvertToCssColor('');
    try { out.ccc_num = F.ConvertToCssColor(255); } catch(e) { out.ccc_num_err = String(e && e.message || e); }
  } catch(e) { out.ccc_err = String(e); }
  try {
    var d1 = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    var d2 = new Date(Date.UTC(1899, 11, 30, 0, 0, 0));
    out.dateToOA_20260101midnight = F.ConvertDateToOADate(d1);
    out.dateToOA_epoch = F.ConvertDateToOADate(d2);
    out.oaToDate_zero_iso = F.ConvertOADateToDate(0).toISOString();
    out.oaToDate_one_iso = F.ConvertOADateToDate(1).toISOString();
    out.oaToDate_46023_iso = F.ConvertOADateToDate(46023).toISOString();
    out.oaToDate_type = typeof F.ConvertOADateToDate(0);
    var src = new Date(Date.UTC(2026, 5, 15, 10, 30, 0));
    var oa = F.ConvertDateToOADate(src);
    var back = F.ConvertOADateToDate(oa);
    out.roundtripDiffMs = back.getTime() - src.getTime();
  } catch(e) { out.oaErr = String(e); }
  try {
    out.dsCompare_keys = Object.keys(F.DataSourceCompareType).filter(function(k){return isNaN(Number(k));});
    out.dsCompare_eq = F.DataSourceCompareType.EqualsTo;
    out.dsCompare_in = F.DataSourceCompareType.In;
    out.dsRel_keys = Object.keys(F.DataSourceRelationType).filter(function(k){return isNaN(Number(k));});
    out.dsRel_and = F.DataSourceRelationType.And;
  } catch(e) { out.enumErr = String(e); }
  try {
    out.imageContext_type = typeof props.ImageContext;
    out.imageContext_keys = props.ImageContext ? Object.keys(props.ImageContext) : null;
    out.imageContext_eqEmptyObject = props.ImageContext && Object.keys(props.ImageContext).length === 0;
  } catch(e) { out.imgErr = String(e); }
  try {
    out.sc_keys = props.ServerCommands ? Object.keys(props.ServerCommands).sort() : null;
    out.sc_unconfiguredLookup = props.ServerCommands ? (props.ServerCommands['nonexistent-cmd-176'] === undefined ? 'undefined' : 'present') : null;
  } catch(e) { out.scErr = String(e); }
  out.title_prop = props.title;
  out.onClick_typeof = typeof props.onClick;
  out.onSave_typeof = typeof props.onSave;
  out.logIn_arity = typeof F.logIn === 'function' ? F.logIn.length : null;
  out.logOut_arity = typeof F.logOut === 'function' ? F.logOut.length : null;
  out.logIn_src = typeof F.logIn === 'function' ? String(F.logIn).slice(0, 80) : null;
  out.logOut_src = typeof F.logOut === 'function' ? String(F.logOut).slice(0, 90) : null;
  // exposeMethod registration
  try {
    F.exposeMethod('echo', function(a, b){ return { echoA: a, echoB: b }; });
    F.exposeMethod('echoAsync', function(a){ return Promise.resolve({ asyncA: a }); });
    out.exposeMethod_registered = true;
  } catch(e) { out.exposeMethod_regErr = String(e); }
  // upload probes
  var uploadProbes = [];
  try {
    var emptyFile = new File([], 'empty.txt', { type: 'text/plain' });
    uploadProbes.push(Promise.resolve(F.uploadFiles([emptyFile])).then(
      function(){ return { kind: 'emptyFile', resolved: true }; },
      function(e){ return { kind: 'emptyFile', resolved: false, error: String(e && e.message || e) }; }));
    var badExt = new File(['x'], 'evil.exe', { type: 'application/x-msdownload' });
    uploadProbes.push(Promise.resolve(F.uploadFiles([badExt])).then(
      function(){ return { kind: 'badExt', resolved: true }; },
      function(e){ return { kind: 'badExt', resolved: false, error: String(e && e.message || e) }; }));
    var pngBytes = new Uint8Array([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0,0,0,0,0,0,0,0]);
    var pngFile = new File([pngBytes], 'probe.png', { type: 'image/png' });
    uploadProbes.push(Promise.resolve(F.uploadFiles([pngFile])).then(
      function(r){ return { kind: 'single_png', resolved: true, keys: r && Object.keys(r), filesLen: r && r.files && r.files.length, firstFile: r && r.files && r.files[0], attachmentValue: r && r.attachmentValue }; },
      function(e){ return { kind: 'single_png', resolved: false, error: String(e && e.message || e) }; }));
    uploadProbes.push(Promise.resolve(F.uploadFiles([pngFile], { uploadFolder: 'probe176' })).then(
      function(r){ return { kind: 'single_png_withFolder', resolved: true, firstFile: r && r.files && r.files[0] }; },
      function(e){ return { kind: 'single_png_withFolder', resolved: false, error: String(e && e.message || e) }; }));
    uploadProbes.push(Promise.resolve(F.uploadFiles(pngFile)).then(
      function(r){ return { kind: 'singleFile_noArray', resolved: true, filesLen: r && r.files && r.files.length }; },
      function(e){ return { kind: 'singleFile_noArray', resolved: false, error: String(e && e.message || e) }; }));
    var dt = new DataTransfer();
    dt.items.add(new File(['a'], 'a.png', { type: 'image/png' }));
    dt.items.add(new File(['b'], 'b.png', { type: 'image/png' }));
    uploadProbes.push(Promise.resolve(F.uploadFiles(dt.files)).then(
      function(r){ return { kind: 'fileList_twoFiles', resolved: true, filesLen: r && r.files && r.files.length, attachmentValue: r && r.attachmentValue, names: r && r.files && r.files.map(function(f){return f.fileName;}) }; },
      function(e){ return { kind: 'fileList_twoFiles', resolved: false, error: String(e && e.message || e) }; }));
    uploadProbes.push(Promise.resolve(F.uploadFiles()).then(
      function(r){ return { kind: 'noArgs', resolved: true, r: r }; },
      function(e){ return { kind: 'noArgs', resolved: false, error: String(e && e.message || e) }; }));
    uploadProbes.push(Promise.resolve(F.uploadFiles([])).then(
      function(r){ return { kind: 'emptyArray', resolved: true, r: r }; },
      function(e){ return { kind: 'emptyArray', resolved: false, error: String(e && e.message || e) }; }));
  } catch(e) { out.uploadSetupErr = String(e); }
  // useDataSource
  try {
    var dsResult = useDataSource('Probe176DS', { top: 2 });
    out.useDataSource_keys = dsResult && typeof dsResult === 'object' ? Object.keys(dsResult).sort() : null;
    out.useDataSource_initial = { loading: dsResult.loading, dataLen: dsResult.data && dsResult.data.length, totalCount: dsResult.totalCount, hasReload: typeof dsResult.reload };
    window.__probeDsResult = dsResult;
  } catch(e) { out.dsErr = String(e); }
  window.__probeOut = out;
  window.__probeUploads = Promise.all(uploadProbes);
  window.__probeProps = props;
  window.__probeF = F;
  var R = window.React;
  return R.createElement('pre', { 'data-probe176': '1' }, 'probe');
}
`;

const writeResult = await designer(`
  await api.page.setCells({ pageName: ${JSON.stringify(PAGE)}, cells: [{
    cell: "A1",
    cellType: "ReactCellTypeCellType",
    name: "probe176cell",
    cellTypeProps: {
      code: ${JSON.stringify(PROBE_CODE)},
      properties: [
        { propertyName: "title", propertyValue: "42", exampleValue: "\\"example-title\\"" },
        { propertyName: "count", exampleValue: "7" }
      ],
      eventHandlers: [
        { EventName: "onClick", EventArgs: [{ Name: "numParam" }, { Name: "strParam" }], EventHandler: { commandType: "ServerCommand", serverCommandName: "GetSalesData" } },
        { EventName: "onSave", EventArgs: [{ Name: "rowIndex" }], EventHandler: { commandType: "ServerCommand", serverCommandName: "GetSalesData" } }
      ],
      dataSources: [{
        dataSourceName: "Probe176DS",
        dataSource: {
          tableName: "销售明细",
          bindingInfos: [
            { bindingInfo: { tableName: "销售明细", columnName: "ID" }, columnName: "ID" },
            { bindingInfo: { tableName: "销售明细", columnName: "月份" }, columnName: "月份" }
          ],
          formulaNullQueryPolicy: "EmptyDatas"
        }
      }],
      permissions: [{ name: "Probe176.Permission", allowRoles: ["FGC_Anonymous", "FGC_LoginUser"] }],
      availableServerCommands: [{ name: "GetSalesData" }],
      uploadLimit: { extensionFilter: ".jpg,.png", sizeLimit: 1, maxUploadFileCount: 2 },
      frontendLibraries: []
    }
  }]});
  const g = await api.page.getCells({ pageName: ${JSON.stringify(PAGE)}, range: "A1" });
  return g.cells[0];
`);
record("2. cellTypeProps round-trip with all fields", "DT", writeResult);

// ---------------------------------------------------------------------------
// Step 3: negative-shape probes for deserialization errors
// ---------------------------------------------------------------------------

const negatives = {};
async function probeNegative(label, addr, fragment) {
  try {
    await designer(`
      await api.page.setCells({ pageName: ${JSON.stringify(PAGE)}, cells: [{
        cell: ${JSON.stringify(addr)}, cellType: "ReactCellTypeCellType",
        cellTypeProps: Object.assign({ code: "function App(props){return null;}", frontendLibraries: [] }, ${JSON.stringify(fragment)})
      }]});
      return { wrote: true };
    `);
    negatives[label] = { wrote: true };
  } catch(e) {
    negatives[label] = { wrote: false, error: String(e).slice(0, 350) };
  }
}
await probeNegative("dataSources_stringElement", "B3", { dataSources: ["str"] });
await probeNegative("dataSources_numberElement", "B5", { dataSources: [42] });
await probeNegative("eventHandlers_stringElement", "B7", { eventHandlers: ["str"] });
await probeNegative("eventHandlers_numberElement", "B9", { eventHandlers: [42] });
await probeNegative("properties_stringElement", "B11", { properties: ["str"] });
await probeNegative("availableServerCommands_stringElement", "B13", { availableServerCommands: ["str"] });
await probeNegative("permissions_stringElement", "B15", { permissions: ["str"] });
record("3. deserialization errors on bad input shapes", "DT", negatives);

// ---------------------------------------------------------------------------
// Step 4: generate + drive browser
// ---------------------------------------------------------------------------

const gen = await designer(`return await api.app.generateProject({});`);
record("4. generateProject", "DT", { success: gen.success, errors: gen.checkResult?.errorCount, url: gen.url });

// Drive CDP — reuse the login-and-probe.mjs pattern inline so this script is self-contained.
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
const events = [];
ws.addEventListener("message", ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method) events.push(msg);
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

// login if needed
const loginState = await evaluate(`(function(){
  return { href: location.href, title: document.title, hasUser: !!document.querySelector('input[type=password]') };
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
  // navigate explicitly
  await send("Page.navigate", { url: pageUrl });
  await new Promise(r => setTimeout(r, 6000));
}

const rtEvidence = await evaluate(`(async function(){
  const out = {};
  out.href = location.href;
  out.probeOut = window.__probeOut || null;
  if (window.__probeUploads) {
    try { out.uploads = await window.__probeUploads; } catch(e) { out.uploadsErr = String(e); }
  }
  if (window.__probeDsResult) {
    // wait for data to load
    await new Promise(r => setTimeout(r, 2000));
    const d = window.__probeDsResult;
    out.dsAfterLoad = { loading: d.loading, dataLen: d.data && d.data.length, totalCount: d.totalCount, firstRowKeys: d.data && d.data[0] ? Object.keys(d.data[0]) : null, error: d.error ? String(d.error) : null };
  }
  // exposeMethod invocation through the cell object
  const page = window.Forguncy && window.Forguncy.Page;
  if (page) {
    const cellObj = page.getCell('probe176cell');
    if (cellObj) {
      out.cellObjProtoMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(cellObj)).filter(n => typeof cellObj[n] === 'function').slice(0, 30);
      const ct = typeof cellObj.getCellType === 'function' ? cellObj.getCellType() : null;
      if (ct && typeof ct.ExecuteMethod === 'function') {
        out.ctCtor = ct.constructor && ct.constructor.name;
        try {
          const r = await ct.ExecuteMethod('echo', [{ parameterValue: 'hello' }, { parameterValue: 42 }]);
          out.echoInvoke = { ok: true, resultKeys: r && Object.keys(r), result: r && r.Result !== undefined ? r.Result : r };
        } catch(e) { out.echoInvoke = { ok: false, err: String(e && e.message || e) }; }
        try {
          const r = await ct.ExecuteMethod('echoAsync', [{ parameterValue: 'asyncHi' }]);
          out.echoAsyncInvoke = { ok: true, resultKeys: r && Object.keys(r), result: r && r.Result !== undefined ? r.Result : r };
        } catch(e) { out.echoAsyncInvoke = { ok: false, err: String(e && e.message || e) }; }
        try {
          await ct.ExecuteMethod('nonExposed176', []);
          out.notExposed = { ok: true };
        } catch(e) { out.notExposed = { ok: false, err: String(e && e.message || e) }; }
        try {
          const r = await ct.ExecuteMethod('echo', [{ ParameterValue: 'pascal' }, { ParameterValue: 7 }]);
          out.echoPascalInvoke = { ok: true, result: r && r.Result !== undefined ? r.Result : r };
        } catch(e) { out.echoPascalInvoke = { ok: false, err: String(e && e.message || e) }; }
        try {
          const r = await ct.ExecuteMethod('echo', ['bareA', 'bareB']);
          out.echoBareInvoke = { ok: true, result: r && r.Result !== undefined ? r.Result : r };
        } catch(e) { out.echoBareInvoke = { ok: false, err: String(e && e.message || e) }; }
        try {
          const r = await ct.ExecuteMethod('echo', []);
          out.echoNoArgsInvoke = { ok: true, result: r && r.Result !== undefined ? r.Result : r };
        } catch(e) { out.echoNoArgsInvoke = { ok: false, err: String(e && e.message || e) }; }
        try {
          const r = await ct.ExecuteMethod('echo', null);
          out.echoNullParamsInvoke = { ok: true, result: r && r.Result !== undefined ? r.Result : r };
        } catch(e) { out.echoNullParamsInvoke = { ok: false, err: String(e && e.message || e) }; }
        try {
          await ct.ExecuteMethod('', []);
          out.emptyNameInvoke = { ok: true };
        } catch(e) { out.emptyNameInvoke = { ok: false, err: String(e && e.message || e) }; }
        // SetPropertyValue re-render probe
        try {
          const execBefore = window.__probeExec;
          const appCallsBefore = window.__probeAppCalls;
          ct.SetPropertyValue('title', 'afterSet');
          await new Promise(r => setTimeout(r, 400));
          out.setProp = {
            execDelta: window.__probeExec - execBefore,
            appCallsDelta: window.__probeAppCalls - appCallsBefore
          };
        } catch(e) { out.setPropErr = String(e && e.message || e); }
      }
    }
  }
  return out;
})()`, true);

record("5. runtime facade evidence", "RT", rtEvidence);

const exceptions = events.filter(e => e.method === "Runtime.exceptionThrown")
  .map(e => ({ text: e.params.exceptionDetails.text, desc: e.params.exceptionDetails.exception?.description }));
record("6. exceptions during runtime probes", "RT", exceptions);

try { await fetch(`${CDP_BASE}/json/close/${tab.id}`); } catch {}

console.log(`\n## evidence written to ${join(OUT_DIR, `findings-${RUN_ID}.json`)}`);
console.log(`## probe page left in place: ${PAGE} (delete by hand if desired — never auto-deleted)`);
