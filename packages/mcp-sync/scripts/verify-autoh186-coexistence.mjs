/**
 * #186 scenario 3 — coexistence with other frontend extension libraries, verified on
 * the live 12.0.102.0 designer.
 *
 * The page carries two adaptive React cells, each referencing the real extension
 * libraries registered in this project (tanstack-query 5.102.8 publishing
 * `TanStackQuery`, es-toolkit 1.52.0 publishing `ESToolkit`) and actually using them
 * in render. Measured: the cells work (the libraries answer), the containers adapt,
 * no global collision occurs (the injection's `__fgcReactCellAutoHeight` and the
 * libraries' globals coexist; the external `reactcell-autoh` global stays absent),
 * and console errors stay at zero through the library+injection load ordering.
 *
 * The probe page is deleted at the end; the project is never saved.
 *
 * Requirements: designer on http://localhost:11234/mcp, CDP browser on
 * http://localhost:9333. Run from the package directory:
 *   node --experimental-strip-types scripts/verify-autoh186-coexistence.mjs
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
const PAGE = `fgc-186coex-${RUN_ID}`;

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

// es-toolkit through the extension's published global, exactly as the library's own
// documentation instructs (globals, never imports) — exercising the real load order
// interaction: extension library scripts, the host React, and the injected patch.
function esToolkitCellSource() {
  return [
    `export function App() {`,
    `  const es = (globalThis as any).ESToolkit;`,
    `  const rows = [];`,
    `  const uniqCount = es ? es.uniq([1, 1, 2, 2, 3]).length : -1;`,
    `  for (let i = 1; i <= 25; i += 1) {`,
    `    rows.push(<div key={i} style={{ height: "30px", lineHeight: "30px" }}>uniq={uniqCount} row {i}</div>);`,
    `  }`,
    `  return <section data-coex="es" data-uniq-count={uniqCount}>{rows}</section>;`,
    `}`,
    ``,
  ].join("\n");
}

// tanstack-query: a real QueryClientProvider+useQuery tree, the same shape the
// project's own PoC page runs — async resolution exercises render-after-patch.
function tanstackCellSource() {
  return [
    `export function App() {`,
    `  const tq = (globalThis as any).TanStackQuery;`,
    `  if (!tq) return <section data-coex="tq" data-tq="missing">no tanstack</section>;`,
    `  const client = React.useMemo(() => new tq.QueryClient(), []);`,
    `  function Probe() {`,
    `    const result = tq.useQuery({ queryKey: ["coex186"], queryFn: async () => "tq-answer" });`,
    `    const rows = [];`,
    `    for (let i = 1; i <= 20; i += 1) {`,
    `      rows.push(<div key={i} style={{ height: "30px", lineHeight: "30px" }}>data={String(result.data ?? "loading")} row {i}</div>);`,
    `    }`,
    `    return <div data-tq-data={String(result.data ?? "loading")}>{rows}</div>;`,
    `  }`,
    `  return (`,
    `    <section data-coex="tq">`,
    `      <tq.QueryClientProvider client={client}><Probe /></tq.QueryClientProvider>`,
    `    </section>`,
    `  );`,
    `}`,
    ``,
  ].join("\n");
}

const evidence = { runId: RUN_ID, page: PAGE, scenario: "extension-coexistence" };
const mcp = createMcpChannel("fgc-verify-186-coex");

try {
  await mcp.connect();

  const esCode = await compileEntry("EsToolkitCell.tsx", esToolkitCellSource());
  const tqCode = await compileEntry("TanstackCell.tsx", tanstackCellSource());

  await mcp.designer(`
    const pages = await api.page.listPages({});
    if (pages.some(p => p.name === ${JSON.stringify(PAGE)})) throw new Error("page exists");
    await api.page.createPage({ name: ${JSON.stringify(PAGE)}, rowCount: 60, columnCount: 12 });
    return true;
  `);
  await mcp.designer(`
    await api.page.setCells({ pageName: ${JSON.stringify(PAGE)}, cells: [
      { cell: "A1", cellType: "ReactCellTypeCellType", name: "coexEs", cellTypeProps: { code: ${JSON.stringify(esCode)}, frontendLibraries: [{ libraryId: "es-toolkit" }] } },
      { cell: "D28", cellType: "ReactCellTypeCellType", name: "coexTq", cellTypeProps: { code: ${JSON.stringify(tqCode)}, frontendLibraries: [{ libraryId: "tanstack-query" }] } }
    ]});
    return true;
  `);
  console.log(`## probe page written: ${PAGE} (es-toolkit cell at A1, tanstack-query cell at D28)`);

  const gen = await mcp.designer(`return await api.app.generateProject({});`);
  if (!gen.success) throw new Error(`generateProject failed: ${JSON.stringify(gen).slice(0, 400)}`);

  const pageUrl = `${gen.url}/${encodeURIComponent(PAGE)}`;
  const tab = await newTab(pageUrl);
  const cdp = await connectCdp(tab);
  await new Promise(r => setTimeout(r, 4000));
  await loginIfNeeded(cdp, pageUrl);
  await new Promise(r => setTimeout(r, 4000));

  evidence.runtime = await cdp.evaluate(`(function(){
    var base = ${MEASURE_ROOTS_SNIPPET};
    base.tanStackQueryGlobal = typeof globalThis.TanStackQuery !== "undefined";
    base.esToolkitGlobal = typeof globalThis.ESToolkit !== "undefined";
    base.esToolkitFrozen = typeof globalThis.ESToolkit !== "undefined" ? Object.isFrozen(globalThis.ESToolkit) : null;
    var esSection = document.querySelector('[data-coex="es"]');
    var tqSection = document.querySelector('[data-coex="tq"]');
    base.esUniqCount = esSection ? esSection.getAttribute("data-uniq-count") : null;
    var tqProbe = document.querySelector("[data-tq-data]");
    base.tqData = tqProbe ? tqProbe.getAttribute("data-tq-data") : null;
    // global pollution audit: the injection must not leak its internals, and the
    // libraries must not have collided with it
    base.unexpectedGlobals = [];
    var expected = ["__fgcReactCellAutoHeight", "TanStackQuery", "ESToolkit"];
    for (var i = 0; i < expected.length; i++) {
      if (typeof globalThis[expected[i]] === "undefined") base.unexpectedGlobals.push("missing:" + expected[i]);
    }
    if (typeof globalThis.ReactCellAutoHeight !== "undefined") base.unexpectedGlobals.push("reactcell-autoh-present-but-not-referenced");
    if (typeof globalThis.ReactCellAutoHeightState !== "undefined") base.unexpectedGlobals.push("leaked:ReactCellAutoHeightState");
    return base;
  })()`);

  evidence.consoleErrors = cdp.consoleErrors;

  const verdicts = [];
  function check(name, pass, detail) {
    verdicts.push({ name, pass: !!pass, detail });
  }
  const rt = evidence.runtime ?? {};
  const reactRoots = (rt.roots ?? []).filter(r => r.reactExpando);
  const adapted = reactRoots.filter(r => r.markerClass && r.inlineHeight === "auto" && Math.abs(r.containerHeightPx - r.contentExtentPx) < 8);

  check("both library-bearing react containers adapt", reactRoots.length === 2 && adapted.length === 2, JSON.stringify(reactRoots.map(r => [r.id, r.containerHeightPx, r.contentExtentPx])));
  check("es-toolkit global present and used (uniq count = 3)", rt.esToolkitGlobal === true && rt.esUniqCount === "3", `global ${rt.esToolkitGlobal}, uniq ${rt.esUniqCount}`);
  check("tanstack-query global present and query resolves", rt.tanStackQueryGlobal === true && rt.tqData === "tq-answer", `global ${rt.tanStackQueryGlobal}, data ${rt.tqData}`);
  check("injection diagnostic global coexists with library globals", rt.diagPresent === true && rt.diag?.patched === true, JSON.stringify(rt.diag));
  check("no unexpected global pollution", (rt.unexpectedGlobals ?? []).length === 0, JSON.stringify(rt.unexpectedGlobals));
  check("external reactcell-autoh global absent (not referenced)", rt.externalLibraryPresent === false, "");
  check("zero console errors with libraries loading alongside the injection", cdp.consoleErrors.length === 0, `${cdp.consoleErrors.length} errors: ${cdp.consoleErrors.slice(0, 2).join("; ")}`);

  evidence.verdicts = verdicts;
  writeFileSync(join(OUT_DIR, `coexistence-${RUN_ID}.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({
    verdicts,
    roots: reactRoots.map(r => [r.id, r.containerHeightPx, r.contentExtentPx, r.markerClass]),
    esUniqCount: rt.esUniqCount,
    tqData: rt.tqData,
  }, null, 1));
  console.log(`## console errors: ${cdp.consoleErrors.length}`);
  console.log(`## evidence written to ${join(OUT_DIR, `coexistence-${RUN_ID}.json`)}`);
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
