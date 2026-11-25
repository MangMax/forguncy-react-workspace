/**
 * #186 scenario 2 — SPA lifecycle: navigation away-and-back, adaptation correctness,
 * and what the platform does to page DOM across visits, verified on the live
 * 12.0.102.0 designer.
 *
 * Why the choreography is shaped this way (all of it probed, none assumed):
 *  - the platform's `Navigate` command is the only honest SPA-navigation mechanism:
 *    direct `new Forguncy.NavigateCommand()` construction fails silently outside the
 *    executor, plain anchors reload the shell, and synthetic pushState+popstate does
 *    not drive the router — each measured, not guessed;
 *  - page-load commands re-fire on every page entry including popstate re-entries
 *    (measured), so an unconditional auto-navigate would loop — the probe page pair
 *    starts with lifA auto-navigating to lifB exactly once, then the script clears
 *    lifA's commands mid-session and regenerates (the running SPA reads fresh page
 *    metadata — measured), which turns the round trip into a user-realistic
 *    history-driven one;
 *  - navigation is SPA throughout: the session sentinel survives every hop.
 *
 * Measured per hop: every positional-id element's adaptation (container height vs
 * content extent, marker, inline styles, expando discrimination), the diagnostic
 * global, element identity across visits (did the platform recreate the DOM or reuse
 * it — either is acceptable, but the evidence says which), console errors.
 *
 * The probe pages are deleted at the end; the project is never saved.
 *
 * Requirements: designer on http://localhost:11234/mcp, CDP browser on
 * http://localhost:9333. Run from the package directory:
 *   node --experimental-strip-types scripts/verify-autoh186-lifecycle.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupPages,
  connectCdp,
  createMcpChannel,
  loginIfNeeded,
  MEASURE_ROOTS_SNIPPET,
  newTab,
  closeTab,
} from "./verify-autoh186-shared.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.FGC_PROBE_OUT ?? join(HERE, ".verify-186-evidence");
mkdirSync(OUT_DIR, { recursive: true });

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LIF_A = `fgc-186lifA-${RUN_ID}`;
const LIF_B = `fgc-186lifB-${RUN_ID}`;

const { compileCell, createRolldownCellBundler } = await import("@forguncy-react-workspace/cell-compiler");

const scratchDir = join(OUT_DIR, "scratch-cell");
mkdirSync(scratchDir, { recursive: true });

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

function tallCellSource(marker) {
  return [
    `export function App() {`,
    `  const rows = [];`,
    `  for (let i = 1; i <= 40; i += 1) {`,
    `    rows.push(<div key={i} style={{ height: "30px", lineHeight: "30px", borderBottom: "1px solid #eee" }}>row {i}</div>);`,
    `  }`,
    `  return <section data-life="${marker}">{rows}</section>;`,
    `}`,
    ``,
  ].join("\n");
}

function shortCellSource(marker) {
  return [
    `export function App() {`,
    `  return <section data-life="${marker}"><div style={{ height: "90px" }}>short ${marker}</div></section>;`,
    `}`,
    ``,
  ].join("\n");
}

const evidence = { runId: RUN_ID, pages: { lifA: LIF_A, lifB: LIF_B }, scenario: "spa-lifecycle", hops: [] };
const mcp = createMcpChannel("fgc-verify-186-life");

try {
  await mcp.connect();

  const tallA = await compileEntry("TallA.tsx", tallCellSource("tallA"));
  const shortA = await compileEntry("ShortA.tsx", shortCellSource("shortA"));
  const tallB = await compileEntry("TallB.tsx", tallCellSource("tallB"));
  const shortB = await compileEntry("ShortB.tsx", shortCellSource("shortB"));

  for (const pageName of [LIF_A, LIF_B]) {
    await mcp.designer(`
      const pages = await api.page.listPages({});
      if (pages.some(p => p.name === ${JSON.stringify(pageName)})) throw new Error("page exists");
      await api.page.createPage({ name: ${JSON.stringify(pageName)}, rowCount: 60, columnCount: 12 });
      return true;
    `);
  }

  // lifA: tall at A1, short at G10, plus plain cells. lifB mirrors it at different positions.
  await mcp.designer(`
    await api.page.setCells({ pageName: ${JSON.stringify(LIF_A)}, cells: [
      { cell: "A1", cellType: "ReactCellTypeCellType", name: "tallA", cellTypeProps: { code: ${JSON.stringify(tallA)}, frontendLibraries: [] } },
      { cell: "G10", cellType: "ReactCellTypeCellType", name: "shortA", cellTypeProps: { code: ${JSON.stringify(shortA)}, frontendLibraries: [] } },
      { cell: "J1", value: "plain on lifA" }
    ]});
    return true;
  `);
  await mcp.designer(`
    await api.page.setCells({ pageName: ${JSON.stringify(LIF_B)}, cells: [
      { cell: "C5", cellType: "ReactCellTypeCellType", name: "tallB", cellTypeProps: { code: ${JSON.stringify(tallB)}, frontendLibraries: [] } },
      { cell: "H20", cellType: "ReactCellTypeCellType", name: "shortB", cellTypeProps: { code: ${JSON.stringify(shortB)}, frontendLibraries: [] } },
      { cell: "J1", value: "plain on lifB" }
    ]});
    return true;
  `);

  // lifA auto-navigates to lifB once at load, carrying the session sentinel plant.
  await mcp.designer(`
    const cmds = api.command.build("pageLoad", builder => {
      builder.addCommand("RunJavaScript", { javascript: "window.__spaSentinel186 = 'session-alive'; window.__lifAEntries = (window.__lifAEntries || 0) + 1;" });
      builder.addCommand("Navigate", { pageName: ${JSON.stringify(LIF_B)} });
    });
    await api.page.updatePageLoadCommands({ pageName: ${JSON.stringify(LIF_A)}, commands: cmds });
    return true;
  `);
  console.log(`## probe pages written: ${LIF_A} (auto-nav to ${LIF_B}), ${LIF_B}`);

  const gen = await mcp.designer(`return await api.app.generateProject({});`);
  if (!gen.success) throw new Error(`generateProject failed: ${JSON.stringify(gen).slice(0, 400)}`);
  evidence.genUrl = gen.url;

  const lifAUrl = `${gen.url}/${encodeURIComponent(LIF_A)}`;
  const lifBUrl = `${gen.url}/${encodeURIComponent(LIF_B)}`;
  const tab = await newTab(lifAUrl);
  const cdp = await connectCdp(tab);
  await new Promise(r => setTimeout(r, 4000));
  await loginIfNeeded(cdp, lifAUrl);
  // settle past login redirects and the auto-navigation
  await new Promise(r => setTimeout(r, 9000));

  const snap = async label => {
    const state = await cdp.evaluate(`(function(){
      var base = ${MEASURE_ROOTS_SNIPPET};
      base.sentinelAlive = typeof window.__spaSentinel186 !== "undefined";
      base.lifAEntries = window.__lifAEntries || 0;
      base.historyLength = history.length;
      base.bodyLen = (document.body.textContent || "").length;
      base.gridPresent = !!document.querySelector(".fgc-page-elements-container");
      base.pageWrapperCount = document.querySelectorAll("[id^=pageWrapper]").length;
      base.totalIds = document.querySelectorAll("[id]").length;
      base.hasTallContent = (document.body.textContent || "").indexOf("row 5") >= 0;
      return base;
    })()`);
    evidence.hops.push({ label, state });
    return state;
  };

  const onPage = async pageName => {
    const state = await cdp.evaluate(`(function(){ return { href: location.href }; })()`);
    return state && decodeURIComponent(state.href).includes(pageName);
  };

  // hop 0: should be on lifB after the auto-navigation
  evidence.hop0_onLifB = await onPage(LIF_B);
  await snap("hop0-arrived-lifB");

  // disarm lifA's auto-navigation mid-session, regenerate
  await mcp.designer(`
    await api.page.updatePageLoadCommands({ pageName: ${JSON.stringify(LIF_A)}, commands: [] });
    await api.app.generateProject({});
    return true;
  `);
  console.log("## lifA auto-navigation disarmed mid-session");

  // tag lifB's react containers before leaving — element identity across the round
  // trip tells whether the platform recreates or reuses page DOM.
  await cdp.evaluate(`(function(){
    var tagged = 0;
    var all = document.querySelectorAll("[id]");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!/^r\\d+c\\d+p\\d*$/.test(el.id)) continue;
      var expando = false;
      for (var key in el) { if (key.indexOf("__reactContainer$") === 0) { expando = true; break; } }
      if (expando) { el.__lifTag186 = "original"; tagged += 1; }
    }
    window.__lifBTagged = tagged;
    return tagged;
  })()`);

  // hop 1: back to lifA — auto-nav is disarmed, so lifA stays
  await cdp.evaluate(`(function(){ history.back(); return 1; })()`);
  await new Promise(r => setTimeout(r, 5000));
  evidence.hop1_onLifA = await onPage(LIF_A);
  await snap("hop1-back-to-lifA");

  // hop 2: forward to lifB — re-measure, and check whether the tagged elements survived
  await cdp.evaluate(`(function(){ history.forward(); return 1; })()`);
  await new Promise(r => setTimeout(r, 5000));
  evidence.hop2_onLifB = await onPage(LIF_B);
  await snap("hop2-forward-to-lifB");
  evidence.tagSurvival = await cdp.evaluate(`(function(){
    var survived = 0, lost = 0, total = 0;
    var all = document.querySelectorAll("[id]");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!/^r\\d+c\\d+p\\d*$/.test(el.id)) continue;
      var expando = false;
      for (var key in el) { if (key.indexOf("__reactContainer$") === 0) { expando = true; break; } }
      if (!expando) continue;
      total += 1;
      if (el.__lifTag186 === "original") survived += 1; else lost += 1;
    }
    return { tagged: window.__lifBTagged || 0, expandoRootsNow: total, originalElementsSurvived: survived, recreatedElements: lost };
  })()`);

  // hop 3: back to lifA again — second re-entry, adaptation must still be correct
  await cdp.evaluate(`(function(){ history.back(); return 1; })()`);
  await new Promise(r => setTimeout(r, 5000));
  evidence.hop3_onLifA = await onPage(LIF_A);
  await snap("hop3-back-to-lifA-again");

  evidence.consoleErrors = cdp.consoleErrors;

  // ---- verdicts ---------------------------------------------------------------
  const verdicts = [];
  function check(name, pass, detail) {
    verdicts.push({ name, pass: !!pass, detail });
  }
  function adaptive(state) {
    if (!state || state.__error) return { ok: false, roots: [], reason: "evaluation failed" };
    const roots = (state.roots ?? []).filter(r => r.reactExpando);
    const nonReact = (state.roots ?? []).filter(r => !r.reactExpando);
    const adapted = roots.filter(r => r.markerClass && r.inlineHeight === "auto" && Math.abs(r.containerHeightPx - r.contentExtentPx) < 8);
    const polluted = nonReact.filter(r => r.markerClass || r.inlineHeight === "auto");
    return { ok: roots.length > 0 && adapted.length === roots.length && polluted.length === 0, roots, adapted, polluted, state };
  }

  const hop0 = adaptive(evidence.hops.find(h => h.label === "hop0-arrived-lifB")?.state);
  const hop1 = adaptive(evidence.hops.find(h => h.label === "hop1-back-to-lifA")?.state);
  const hop2 = adaptive(evidence.hops.find(h => h.label === "hop2-forward-to-lifB")?.state);
  const hop3 = adaptive(evidence.hops.find(h => h.label === "hop3-back-to-lifA-again")?.state);

  check("hop0: lifB adaptation correct after initial SPA navigation", hop0.ok && evidence.hop0_onLifB, `${hop0.adapted.length}/${hop0.roots.length} adapted, polluted ${hop0.polluted.length}`);
  check("hop1: lifA adaptation correct after history.back (away-and-back)", hop1.ok && evidence.hop1_onLifA, `${hop1.adapted.length}/${hop1.roots.length} adapted, polluted ${hop1.polluted.length}`);
  check("hop2: lifB adaptation correct after history.forward", hop2.ok && evidence.hop2_onLifB, `${hop2.adapted.length}/${hop2.roots.length} adapted, polluted ${hop2.polluted.length}`);
  check("hop3: lifA adaptation correct on second re-entry", hop3.ok && evidence.hop3_onLifA, `${hop3.adapted.length}/${hop3.roots.length} adapted, polluted ${hop3.polluted.length}`);
  check("tall cells measure ~1200px and short ~90px independently on lifA hop1", (() => {
    const roots = hop1.roots;
    const tall = roots.filter(r => r.contentExtentPx > 500);
    const short = roots.filter(r => r.contentExtentPx <= 500 && r.contentExtentPx > 0);
    return tall.length === 1 && short.length === 1 && Math.abs(tall[0].containerHeightPx - tall[0].contentExtentPx) < 8 && Math.abs(short[0].containerHeightPx - short[0].contentExtentPx) < 8;
  })(), JSON.stringify((hop1.roots).map(r => [r.id, r.containerHeightPx, r.contentExtentPx])));
  check("session sentinel alive through every hop", evidence.hops.every(h => h.state && h.state.sentinelAlive === true), "");
  check("diagnostic global present and patched throughout", evidence.hops.every(h => h.state && h.state.diagPresent && h.state.diag?.patched === true), "");
  check("zero console errors across the round trip", cdp.consoleErrors.length === 0, `${cdp.consoleErrors.length} errors`);

  evidence.verdicts = verdicts;
  writeFileSync(join(OUT_DIR, `lifecycle-${RUN_ID}.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({
    verdicts,
    tagSurvival: evidence.tagSurvival,
    hopsSummary: evidence.hops.map(h => ({
      label: h.label,
      href: h.state?.href,
      sentinel: h.state?.sentinelAlive,
      reactRoots: (h.state?.roots ?? []).filter(r => r.reactExpando).map(r => [r.id, r.containerHeightPx, r.contentExtentPx, r.markerClass]),
    })),
  }, null, 1));
  console.log(`## console errors: ${cdp.consoleErrors.length}`);
  console.log(`## evidence written to ${join(OUT_DIR, `lifecycle-${RUN_ID}.json`)}`);
  await closeTab(tab.id);
} finally {
  try {
    await mcp.connect();
    const errors = await cleanupPages(mcp.designer, [LIF_A, LIF_B], console.log);
    if (errors.length) console.error("## cleanup errors:", errors);
  } catch (e) {
    console.error("## cleanup reconnect failed:", e.message);
  }
}
process.exit(0);
