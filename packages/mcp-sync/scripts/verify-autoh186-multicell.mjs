/**
 * #186 scenario 1 — multi-cell coexistence, portability, idempotency and the
 * imprecision regression, verified on the live 12.0.102.0 designer.
 *
 * One probe page carries:
 *  - the SAME tall artifact deployed twice, at A1 and D8 — portability: position
 *    independence is only real if one artifact adapts at two different grid ids;
 *  - a short adaptive cell at G30 — multi-cell independence: each container must
 *    track its own content, not a shared height;
 *  - plain value cells (which the recon probe proved produce `fgc-general-cell-label`
 *    elements with positional ids) — the imprecision regression: after the fix, none
 *    of those labels may carry the marker class or adaptive inline styles.
 *
 * Idempotency is measured three ways: the page's natural double-evaluation (two
 * copies of the tall artifact), the prototype-guard state, and a manual re-execution
 * of the compiled artifact in the page — after which `createContent`'s reference
 * must be unchanged (no double-wrap) and the style element count stays one (no
 * duplicate observer registration is implied by the unchanged wrap, since the
 * observer is created inside the same guarded block).
 *
 * The probe page is deleted at the end; the project is never saved.
 *
 * Requirements: designer on http://localhost:11234/mcp, CDP browser on
 * http://localhost:9333. Run from the package directory:
 *   node --experimental-strip-types scripts/verify-autoh186-multicell.mjs
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
const PAGE = `fgc-186mc-${RUN_ID}`;

const { compileCell, createRolldownCellBundler } = await import("@forguncy-react-workspace/cell-compiler");

const scratchDir = join(OUT_DIR, "scratch-cell");
mkdirSync(scratchDir, { recursive: true });

function tallCellSource() {
  return [
    `// 50 lines at 30px — ~1500px of content in a default-height grid row.`,
    `export function App() {`,
    `  const rows = [];`,
    `  for (let i = 1; i <= 50; i += 1) {`,
    `    rows.push(<div key={i} style={{ height: "30px", lineHeight: "30px", borderBottom: "1px solid #eee" }}>row {i}</div>);`,
    `  }`,
    `  return <section data-verify186="tall">{rows}</section>;`,
    `}`,
    ``,
  ].join("\n");
}

function shortCellSource() {
  return [
    `export function App() {`,
    `  return <section data-verify186="short"><div style={{ height: "60px" }}>short content</div></section>;`,
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

const evidence = { runId: RUN_ID, page: PAGE, scenario: "multicell-portability-idempotency-imprecision" };
const mcp = createMcpChannel("fgc-verify-186-mc");

try {
  await mcp.connect();

  const tallCode = await compileEntry("TallCell.tsx", tallCellSource());
  const shortCode = await compileEntry("ShortCell.tsx", shortCellSource());
  evidence.compile = {
    tallChars: tallCode.length,
    shortChars: shortCode.length,
    tallHasInjection: tallCode.includes("auto-height contract"),
    shortHasInjection: shortCode.includes("auto-height contract"),
    tallHasExpandoDiscriminator: tallCode.includes("__reactContainer$"),
  };

  await mcp.designer(`
    const pages = await api.page.listPages({});
    if (pages.some(p => p.name === ${JSON.stringify(PAGE)})) throw new Error("page exists");
    await api.page.createPage({ name: ${JSON.stringify(PAGE)}, rowCount: 60, columnCount: 12 });
    return true;
  `);

  // tall at A1 and D8 (same artifact, two positions), short at G30, plain cells beside them
  await mcp.designer(`
    await api.page.setCells({ pageName: ${JSON.stringify(PAGE)}, cells: [
      { cell: "A1", cellType: "ReactCellTypeCellType", name: "tallA", cellTypeProps: { code: ${JSON.stringify(tallCode)}, frontendLibraries: [] } },
      { cell: "D8", cellType: "ReactCellTypeCellType", name: "tallB", cellTypeProps: { code: ${JSON.stringify(tallCode)}, frontendLibraries: [] } },
      { cell: "G30", cellType: "ReactCellTypeCellType", name: "shortC", cellTypeProps: { code: ${JSON.stringify(shortCode)}, frontendLibraries: [] } },
      { cell: "J1", value: "plain text one" },
      { cell: "J3", value: 1234 },
      { cell: "J5", formula: "=2+2" }
    ]});
    return true;
  `);
  console.log(`## probe page written: ${PAGE} (tall x2 at A1/D8, short at G30, 3 plain cells)`);

  const gen = await mcp.designer(`return await api.app.generateProject({});`);
  if (!gen.success) throw new Error(`generateProject failed: ${JSON.stringify(gen).slice(0, 400)}`);
  evidence.genUrl = gen.url;

  const pageUrl = `${gen.url}/${encodeURIComponent(PAGE)}`;
  const tab = await newTab(pageUrl);
  const cdp = await connectCdp(tab);
  await new Promise(r => setTimeout(r, 4000));
  await loginIfNeeded(cdp, pageUrl);
  await new Promise(r => setTimeout(r, 3000));

  // --- measurement 1: adaptation, independence, portability, pollution-free ----
  evidence.initial = await cdp.evaluate(MEASURE_ROOTS_SNIPPET);

  // --- measurement 2: idempotency under manual re-execution --------------------
  // capture the current createContent reference, re-execute the whole compiled
  // artifact in the page (what recompilation/re-evaluation does), compare.
  evidence.idempotency = await cdp.evaluate(`(function(){
    var entry = Forguncy.Plugin.CellTypeHelper._registedCellTypes["ReactCellType.ReactCellTypeCellType, ReactCellType"];
    var ctor = entry[0].cellTypeCtor;
    window.__beforeCreateContent = ctor.prototype.createContent;
    window.__beforeStyleCount = document.querySelectorAll("style[data-reactcell-autoh]").length;
    return { captured: typeof window.__beforeCreateContent === "function", styleCount: window.__beforeStyleCount };
  })()`);
  // re-executing the whole compiled artifact in the page is what a recompiled or
  // re-rendered cell does to the session; the guards must absorb it completely.
  await cdp.evaluate(tallCode);
  await new Promise(r => setTimeout(r, 1500));
  evidence.idempotencyAfter = await cdp.evaluate(`(function(){
    var entry = Forguncy.Plugin.CellTypeHelper._registedCellTypes["ReactCellType.ReactCellTypeCellType, ReactCellType"];
    var ctor = entry[0].cellTypeCtor;
    return {
      createContentUnchanged: ctor.prototype.createContent === window.__beforeCreateContent,
      styleCountNow: document.querySelectorAll("style[data-reactcell-autoh]").length,
      styleCountBefore: window.__beforeStyleCount,
      diagStillPresent: typeof globalThis.__fgcReactCellAutoHeight !== "undefined",
    };
  })()`);
  // re-measure roots after the manual re-execution: adaptation must not regress
  evidence.afterReExecution = await cdp.evaluate(MEASURE_ROOTS_SNIPPET);

  evidence.consoleErrors = cdp.consoleErrors;
  writeFileSync(join(OUT_DIR, `multicell-${RUN_ID}.json`), JSON.stringify(evidence, null, 2));

  // ---- verdicts ---------------------------------------------------------------
  const verdicts = [];
  function check(name, pass, detail) {
    verdicts.push({ name, pass: !!pass, detail });
  }
  const initial = evidence.initial ?? {};
  const roots = initial.roots ?? [];
  const reactRoots = roots.filter(r => r.reactExpando);
  const nonReactPatterned = roots.filter(r => !r.reactExpando);
  const tallRoots = reactRoots.filter(r => (r.contentExtentPx ?? 0) > 500);
  const shortRoots = reactRoots.filter(r => (r.contentExtentPx ?? 0) <= 500 && (r.contentExtentPx ?? 0) > 0);

  check("three react containers present (tall x2 + short x1)", reactRoots.length === 3, `reactExpando roots: ${reactRoots.length}`);
  check("both tall positions adapt to ~1500px content", tallRoots.length === 2 && tallRoots.every(r => Math.abs(r.containerHeightPx - r.contentExtentPx) < 8), JSON.stringify(tallRoots.map(r => [r.id, r.containerHeightPx, r.contentExtentPx])));
  check("short cell adapts to its own smaller height independently", shortRoots.length === 1 && Math.abs(shortRoots[0].containerHeightPx - shortRoots[0].contentExtentPx) < 8, JSON.stringify(shortRoots.map(r => [r.id, r.containerHeightPx, r.contentExtentPx])));
  check("every react root marked", reactRoots.every(r => r.markerClass && r.inlineHeight === "auto" && r.inlineMinHeight === "100%"), "");
  check("diag global present and patched", initial.diagPresent && initial.diag?.patched === true, JSON.stringify(initial.diag));
  check("non-react patterned elements untouched", nonReactPatterned.every(r => !r.markerClass && r.inlineHeight !== "auto" && r.inlineMinHeight !== "100%"), JSON.stringify(nonReactPatterned.map(r => [r.id, r.tag, r.markerClass, r.inlineHeight])));
  check("non-react patterned elements exist (the pollution case is exercised)", nonReactPatterned.length >= 3, `count: ${nonReactPatterned.length}`);
  check("manual re-execution does not re-wrap createContent", evidence.idempotencyAfter?.createContentUnchanged === true, "");
  check("manual re-execution does not duplicate the stylesheet", evidence.idempotencyAfter?.styleCountNow === 1, `now: ${evidence.idempotencyAfter?.styleCountNow}`);
  check("adaptation survives manual re-execution", (evidence.afterReExecution?.roots ?? []).filter(r => r.reactExpando).every(r => r.markerClass), "");
  check("zero console errors", cdp.consoleErrors.length === 0, `${cdp.consoleErrors.length} errors`);

  evidence.verdicts = verdicts;
  writeFileSync(join(OUT_DIR, `multicell-${RUN_ID}.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ verdicts, roots: roots.map(r => ({ id: r.id, tag: r.tag, react: r.reactExpando, marker: r.markerClass, h: r.containerHeightPx, extent: r.contentExtentPx })) }, null, 1));
  console.log(`## console errors: ${cdp.consoleErrors.length}`);
  console.log(`## evidence written to ${join(OUT_DIR, `multicell-${RUN_ID}.json`)}`);
  await closeTab(tab.id);
} finally {
  try {
    await mcp.connect();
    const errors = await cleanupPages(mcp.designer, [PAGE], console.log);
    if (errors.length) console.error("## cleanup errors:", errors);
  } catch (e) {
    console.error("## cleanup reconnect failed:", e.message);
  }
}
process.exit(0);
