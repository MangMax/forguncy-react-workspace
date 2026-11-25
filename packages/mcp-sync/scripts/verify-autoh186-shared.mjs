/**
 * Shared transport for the #186 verification scripts: the MCP designer channel and
 * the CDP browser channel, factored out of the #185 probe pattern so the three
 * scenario scripts measure rather than re-plumb.
 *
 * Everything here is transport only — no assertions, no scenario logic. Login is the
 * same Administrator/123456 dev-site credential flow the #185 probes used.
 */

export const MCP_URL = process.env.FGC_MCP_URL ?? "http://localhost:11234/mcp";
export const CDP_BASE = process.env.CDP_BASE ?? "http://localhost:9333";

export function createMcpChannel(clientName) {
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
      clientInfo: { name: clientName, version: "0" },
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
      title: clientName,
      code: `const __run = async () => { ${script} };\nreturn await __run();`,
      permissionMode: "safeWriteAuto",
    });
    if (r?.result?.isError) throw new Error(r.result.content?.[0]?.text ?? "designer error");
    const text = r?.result?.content?.map(b => b.text).join("\n") ?? "";
    return JSON.parse(text).result;
  }
  return { connect, designer };
}

export async function newTab(targetUrl) {
  let r = await fetch(`${CDP_BASE}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
  if (!r.ok) r = await fetch(`${CDP_BASE}/json/new?${encodeURIComponent(targetUrl)}`);
  return r.json();
}

export async function closeTab(targetId) {
  try { await fetch(`${CDP_BASE}/json/close/${targetId}`); } catch { /* best effort */ }
}

/**
 * A CDP websocket session against one tab: evaluate() with exception capture, a
 * rolling console-error buffer, and JavaScript dialogs auto-accepted (an alert in
 * headless Chromium blocks the JS thread and hangs the whole probe otherwise).
 */
export async function connectCdp(tab) {
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(tab.webSocketDebuggerUrl);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("ws error")), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const consoleErrors = [];
  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  ws.addEventListener("message", ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "exception").slice(0, 300));
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push((msg.params.args ?? []).map(a => a.value ?? a.description ?? "").join(" ").slice(0, 300));
    } else if (msg.method === "Page.javascriptDialogOpening") {
      void send("Page.handleJavaScriptDialog", { accept: true });
    }
  });
  async function evaluate(expression, awaitPromise = false) {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise, timeout: 20000 });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text, desc: r.exceptionDetails.exception?.description };
    return r.result?.value;
  }
  await send("Runtime.enable");
  await send("Page.enable");
  return { send, evaluate, consoleErrors, ws };
}

/**
 * The dev-site login flow, exactly as the #185 probes ran it: if a password input is
 * present, fill Administrator/123456 and re-navigate to the target page.
 */
export async function loginIfNeeded(cdp, pageUrl) {
  const loginState = await cdp.evaluate(`(function(){ return { hasUser: !!document.querySelector('input[type=password]') }; })()`);
  if (loginState && loginState.hasUser) {
    await cdp.evaluate(`(function(){
      function setVal(el, val){ if (!el) return; el.focus(); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      setVal(document.querySelector('input[type=text]'), 'Administrator');
      setVal(document.querySelector('input[type=password]'), '123456');
      const btn = document.querySelector('button');
      if (btn) btn.click();
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 5000));
    await cdp.send("Page.navigate", { url: pageUrl });
    await new Promise(r => setTimeout(r, 7000));
    return true;
  }
  return false;
}

/**
 * The measurement the scenarios share: every element whose id matches the positional
 * pattern, with the evidence needed to tell ReactCellType containers from other grid
 * cells — the react-container expando, the marker class, inline styles, and measured
 * heights. This is the same scan shape #185's probes used, extended with the expando
 * and pollution fields #186 needs.
 */
export const MEASURE_ROOTS_SNIPPET = `(function(){
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
  out.roots = [];
  var all = document.querySelectorAll("[id]");
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!/^r\\d+c\\d+p\\d*$/.test(el.id)) continue;
    var rect = el.getBoundingClientRect();
    var contentBottom = 0;
    var walker = el.querySelectorAll("*");
    for (var j = 0; j < walker.length; j++) {
      var r2 = walker[j].getBoundingClientRect();
      if (r2.bottom > contentBottom) contentBottom = r2.bottom;
    }
    var expando = false;
    for (var key in el) { if (key.indexOf("__reactContainer$") === 0) { expando = true; break; } }
    out.roots.push({
      id: el.id,
      tag: el.tagName,
      reactExpando: expando,
      markerClass: el.classList.contains("fgc-reactcell-autoh"),
      inlineHeight: el.style.height,
      inlineMinHeight: el.style.minHeight,
      className: typeof el.className === "string" ? el.className.slice(0, 80) : "",
      containerHeightPx: Math.round(rect.height * 100) / 100,
      contentExtentPx: Math.round((contentBottom > 0 ? contentBottom - rect.top : 0) * 100) / 100,
    });
  }
  return out;
})()`;

/** Deletes probe pages by exact name, tolerating absence; never saves the project. */
export async function cleanupPages(designer, pageNames, log) {
  const errors = [];
  for (const pageName of pageNames) {
    try {
      await designer(`
        const pages = await api.page.listPages({});
        if (pages.some(p => p.name === ${JSON.stringify(pageName)})) {
          try { await api.page.updatePageLoadCommands({ pageName: ${JSON.stringify(pageName)}, commands: [] }); } catch (e) {}
          await api.page.deletePage({ pageName: ${JSON.stringify(pageName)} });
        }
        return true;
      `);
      log?.(`## cleaned up probe page ${pageName}`);
    } catch (e) {
      errors.push(`${pageName}: ${e.message}`);
    }
  }
  return errors;
}
