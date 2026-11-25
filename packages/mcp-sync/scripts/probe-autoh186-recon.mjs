/**
 * #186 reconnaissance probe — the measurements the edge-case design depends on,
 * taken before any verification script is written:
 *
 * 1. **id-pattern incidence**: which elements on a real generated page carry ids
 *    matching `/^r\d+c\d+p$/` — ReactCellType content roots only, or also plain
 *    cells / other platform structures? This is the evidence for the reviewer's
 *    imprecision question on `repairExistingContainers`.
 * 2. **react-root expando**: whether a ReactCellType content root carries React's
 *    `__reactContainer$*` expando synchronously — the candidate precise test for
 *    "this element is a ReactCellType container".
 * 3. **navigation machinery**: what the runtime exposes for in-app navigation
 *    (the MCP cannot write built-in button cells, so the SPA lifecycle test needs
 *    another driver — a plain anchor inside a React cell, or a runtime API).
 * 4. **anchor behaviour**: whether clicking a same-app anchor navigates in-app
 *    (SPA, session state survives) or reloads the shell.
 *
 * Writes two probe pages with one tall React cell, plain value cells and an anchor
 * link each, generates the project, measures through CDP, and leaves the evidence
 * JSON beside the script. The probe pages are deleted again at the end; the project
 * is never saved.
 *
 * Requirements: designer on http://localhost:11234/mcp, CDP browser on
 * http://localhost:9333. Run from the package directory:
 *   node --experimental-strip-types scripts/probe-autoh186-recon.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_URL = process.env.FGC_MCP_URL ?? "http://localhost:11234/mcp";
const CDP_BASE = process.env.CDP_BASE ?? "http://localhost:9333";
const OUT_DIR = process.env.FGC_PROBE_OUT ?? join(HERE, ".verify-186-evidence");
mkdirSync(OUT_DIR, { recursive: true });

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const PAGE_A = `fgc-186recon-a-${RUN_ID}`;
const PAGE_B = `fgc-186recon-b-${RUN_ID}`;

// ---------------------------------------------------------------------------
// compile one tall adaptive cell (the injection matters little for recon, but
// shipping mechanism is what real pages carry)
// ---------------------------------------------------------------------------

const { compileCell, createRolldownCellBundler } = await import("@forguncy-react-workspace/cell-compiler");

const scratchDir = join(OUT_DIR, "scratch-cell");
mkdirSync(scratchDir, { recursive: true });

function cellSource(marker, linkTarget) {
  return [
    `export function App() {`,
    `  const rows = [];`,
    `  for (let i = 1; i <= 20; i += 1) {`,
    `    rows.push(<div key={i} style={{ height: "30px", lineHeight: "30px", borderBottom: "1px solid #eee" }}>row {i}</div>);`,
    `  }`,
    `  return (`,
    `    <section data-recon="${marker}">`,
    `      {rows}`,
    linkTarget
      ? `      <a id="${marker}-link" href="${linkTarget}" style={{ display: "block", padding: "8px", background: "#def" }}>go to other page</a>`
      : `      <span>no link here</span>`,
    `    </section>`,
    `  );`,
    `}`,
    ``,
  ].join("\n");
}

async function compileEntry(fileName, source) {
  const entry = join(scratchDir, fileName);
  writeFileSync(entry, source);
  const outcome = await compileCell(
    { entry, dependencies: [{ strategy: "host", packageName: "react", globalName: "React" }] },
    { bundler: createRolldownCellBundler({ dir: scratchDir }) },
  );
  if (outcome.status !== "compiled") {
    throw new Error(`compile rejected: ${outcome.diagnostics.map(d => `${d.code}: ${d.message}`).join("; ")}`);
  }
  return outcome.artifact.code;
}

// ---------------------------------------------------------------------------
// MCP + CDP transports (same pattern as the #185 probes)
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
    clientInfo: { name: "fgc-recon-186", version: "0" },
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
    title: "recon-186",
    code: `const __run = async () => { ${script} };\nreturn await __run();`,
    permissionMode: "safeWriteAuto",
  });
  if (r?.result?.isError) throw new Error(r.result.content?.[0]?.text ?? "designer error");
  const text = r?.result?.content?.map(b => b.text).join("\n") ?? "";
  return JSON.parse(text).result;
}

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

async function closeTab(targetId) {
  try { await fetch(`${CDP_BASE}/json/close/${targetId}`); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const evidence = { runId: RUN_ID, pages: { a: PAGE_A, b: PAGE_B } };
const cleanupErrors = [];

try {
  await connect();

  // clean up the interactive scratch page from exploration if still present
  await designer(`
    const pages = await api.page.listPages({});
    if (pages.some(p => p.name === "fgc-scratch186-probe")) {
      try { await api.page.deletePage({ pageName: "fgc-scratch186-probe" }); } catch (e) {}
    }
    return true;
  `);

  // The link target has to be the final runtime URL shape, but that depends on the
  // app base url we only know after generation. Forguncy serves pages under the app
  // root as `${base}/${pageName}` — the #185 probes build it exactly that way, so the
  // anchor can use a root-relative path and the correct base is filled in below,
  // before writing the cells. generateProject is what it is; the pageName is stable.
  // Simplest correct order: create both pages with placeholder-free cells first using
  // a RELATIVE href is wrong across pages at the same depth — root-relative it is,
  // patched after the first generate. Instead: measure first without the anchor being
  // perfect? No — the base is deterministic: gen.url is fixed for the app across
  // generations. So: compile with a placeholder, generate once to learn gen.url,
  // rewrite the cells with the real href, measure. Two generations, but both cheap
  // enough and the evidence is exact.
  const placeholderCode = await compileEntry("ReconA.tsx", cellSource("reconA", "PLACEHOLDER"));
  const codeB = await compileEntry("ReconB.tsx", cellSource("reconB", null));

  for (const pageName of [PAGE_A, PAGE_B]) {
    await designer(`
      const pages = await api.page.listPages({});
      if (pages.some(p => p.name === ${JSON.stringify(pageName)})) throw new Error("page exists");
      await api.page.createPage({ name: ${JSON.stringify(pageName)}, rowCount: 60, columnCount: 12 });
      return true;
    `);
  }

  // page A: tall react cell at A1 + plain value cells + a named plain cell
  await designer(`
    await api.page.setCells({ pageName: ${JSON.stringify(PAGE_A)}, cells: [
      { cell: "A1", cellType: "ReactCellTypeCellType", name: "reconReact", cellTypeProps: { code: ${JSON.stringify(placeholderCode)}, frontendLibraries: [] } },
      { cell: "A26", value: "plain value cell A26", name: "plainNamed" },
      { cell: "B28", value: 42 },
      { cell: "C30", formula: "=1+1" }
    ]});
    return true;
  `);
  await designer(`
    await api.page.setCells({ pageName: ${JSON.stringify(PAGE_B)}, cells: [
      { cell: "A1", cellType: "ReactCellTypeCellType", name: "reconReactB", cellTypeProps: { code: ${JSON.stringify(codeB)}, frontendLibraries: [] } },
      { cell: "A26", value: "plain value on B" }
    ]});
    return true;
  `);

  const gen1 = await designer(`return await api.app.generateProject({});`);
  if (!gen1.success) throw new Error(`generateProject failed: ${JSON.stringify(gen1).slice(0, 400)}`);
  evidence.genUrl = gen1.url;

  // now rewrite page A's cell with the real anchor target
  const pageBUrl = `${gen1.url}/${encodeURIComponent(PAGE_B)}`;
  const pageAUrl = `${gen1.url}/${encodeURIComponent(PAGE_A)}`;
  const codeA = await compileEntry("ReconA2.tsx", cellSource("reconA", pageBUrl));
  await designer(`
    await api.page.setCells({ pageName: ${JSON.stringify(PAGE_A)}, cells: [
      { cell: "A1", cellType: "ReactCellTypeCellType", name: "reconReact", cellTypeProps: { code: ${JSON.stringify(codeA)}, frontendLibraries: [] } }
    ]});
    return true;
  `);
  // and page B gets a link back to A
  const codeB2 = await compileEntry("ReconB2.tsx", cellSource("reconB", pageAUrl));
  await designer(`
    await api.page.setCells({ pageName: ${JSON.stringify(PAGE_B)}, cells: [
      { cell: "A1", cellType: "ReactCellTypeCellType", name: "reconReactB", cellTypeProps: { code: ${JSON.stringify(codeB2)}, frontendLibraries: [] } }
    ]});
    return true;
  `);
  const gen = await designer(`return await api.app.generateProject({});`);
  if (!gen.success) throw new Error(`generateProject (2) failed`);
  console.log(`## generated: ${gen.url}`);

  // -------------------------------------------------------------------------
  // browser measurement
  // -------------------------------------------------------------------------

  const tab = await newTab(pageAUrl);
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
    await send("Page.navigate", { url: pageAUrl });
    await new Promise(r => setTimeout(r, 7000));
  }
  await new Promise(r => setTimeout(r, 2500));

  // --- measurement 1+2: id-pattern incidence and react-root expando ----------
  evidence.idPatternIncidence = await evaluate(`(function(){
    var out = { matches: [], totalElementsWithId: 0 };
    var all = document.querySelectorAll("[id]");
    out.totalElementsWithId = all.length;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!/^r\\d+c\\d+p$/.test(el.id)) continue;
      var reactKeys = Object.keys(el).filter(function(k){ return k.indexOf("__reactContainer$") === 0 || k.indexOf("__reactFiber$") === 0; });
      var chain = [];
      var node = el;
      for (var depth = 0; depth < 5 && node; depth += 1) {
        chain.push(node.tagName + (node.className && typeof node.className === "string" ? "." + node.className.split(" ").filter(Boolean).slice(0,3).join(".") : ""));
        node = node.parentElement;
      }
      out.matches.push({
        id: el.id,
        tag: el.tagName,
        className: typeof el.className === "string" ? el.className.slice(0, 120) : "",
        reactExpandoKeys: reactKeys,
        childElementCount: el.childElementCount,
        hasMarkerClass: el.classList.contains("fgc-reactcell-autoh"),
        inlineHeight: el.style.height,
        inlineMinHeight: el.style.minHeight,
        containsReactContent: !!el.querySelector("[data-recon]"),
        ancestors: chain,
        heightPx: Math.round(el.getBoundingClientRect().height * 100) / 100,
      });
    }
    return out;
  })()`);

  // every ReactCellType container on the page, identified via the registry ctor walk:
  // is the expando present on the elements the pattern matches AND contains react content?
  evidence.expandoDetail = await evaluate(`(function(){
    var out = { reactRoots: [] };
    var all = document.querySelectorAll("[data-recon]");
    for (var i = 0; i < all.length; i++) {
      var content = all[i];
      // walk up to the element whose id matches the pattern
      var node = content;
      var root = null;
      while (node && node !== document.body) {
        if (/^r\\d+c\\d+p$/.test(node.id || "")) { root = node; break; }
        node = node.parentElement;
      }
      out.reactRoots.push({
        marker: content.getAttribute("data-recon"),
        rootId: root ? root.id : null,
        rootExpandoKeys: root ? Object.keys(root).filter(function(k){ return k.indexOf("__react") === 0; }) : [],
        contentExpandoKeys: Object.keys(content).filter(function(k){ return k.indexOf("__react") === 0; }),
      });
    }
    return out;
  })()`);

  // --- measurement 3: navigation machinery -----------------------------------
  evidence.navigationSurface = await evaluate(`(function(){
    var out = {};
    out.forguncyKeys = typeof Forguncy === "undefined" ? null : Object.keys(Forguncy).sort();
    out.pageKeys = (typeof Forguncy !== "undefined" && Forguncy.Page) ? Object.keys(Forguncy.Page).sort() : null;
    // hunt for navigation-ish members anywhere shallow
    out.navCandidates = [];
    function scan(obj, path, depth) {
      if (!obj || depth > 2) return;
      var keys;
      try { keys = Object.keys(obj); } catch (e) { return; }
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (/navigate|goto|router|redirect|transition/i.test(k)) {
          out.navCandidates.push(path + "." + k + " : " + typeof obj[k]);
        }
        if (depth < 2 && obj[k] && typeof obj[k] === "object" && k !== "prototype" && k.length < 40) {
          scan(obj[k], path + "." + k, depth + 1);
        }
      }
    }
    if (typeof Forguncy !== "undefined") scan(Forguncy, "Forguncy", 0);
    // history length + router hints
    out.historyLength = history.length;
    out.hash = location.hash;
    out.href = location.href;
    return out;
  })()`);

  // --- measurement 4: anchor navigation behaviour -----------------------------
  // plant a sentinel the SPA cannot survive a reload with, then click the anchor
  await evaluate(`(function(){ window.__reconSentinel = "spa-alive"; return true; })()`);
  const linkExists = await evaluate(`(function(){ var a = document.getElementById("reconA-link"); return !!a; })()`);
  evidence.anchorTest = { linkExists };
  if (linkExists === true) {
    await evaluate(`(function(){ document.getElementById("reconA-link").click(); return true; })()`);
    await new Promise(r => setTimeout(r, 5000));
    evidence.anchorTest.after = await evaluate(`(function(){
      return {
        href: location.href,
        sentinelSurvived: typeof window.__reconSentinel !== "undefined",
        pageBRenders: !!document.querySelector('[data-recon="reconB"]'),
      };
    })()`);
    // if the sentinel survived we're on page B in-app; click back to A the same way
    if (evidence.anchorTest.after && evidence.anchorTest.after.sentinelSurvived) {
      await evaluate(`(function(){ var a = document.getElementById("reconB-link"); if (a) a.click(); return true; })()`);
      await new Promise(r => setTimeout(r, 5000));
      evidence.anchorTest.roundTrip = await evaluate(`(function(){
        return {
          href: location.href,
          sentinelSurvived: typeof window.__reconSentinel !== "undefined",
          pageARenders: !!document.querySelector('[data-recon="reconA"]'),
        };
      })()`);
    }
  }

  evidence.consoleErrors = consoleErrors;
  writeFileSync(join(OUT_DIR, `recon-${RUN_ID}.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  await closeTab(tab.id);
} finally {
  // probe pages are cleaned up unconditionally; the project is never saved.
  try {
    await connect();
    for (const pageName of [PAGE_A, PAGE_B]) {
      try {
        await designer(`
          const pages = await api.page.listPages({});
          if (pages.some(p => p.name === ${JSON.stringify(pageName)})) {
            await api.page.deletePage({ pageName: ${JSON.stringify(pageName)} });
          }
          return true;
        `);
        console.log(`## cleaned up probe page ${pageName}`);
      } catch (e) { cleanupErrors.push(`${pageName}: ${e.message}`); }
    }
  } catch (e) { cleanupErrors.push(`reconnect: ${e.message}`); }
  if (cleanupErrors.length) console.error("## cleanup errors:", cleanupErrors);
}
process.exit(0);
