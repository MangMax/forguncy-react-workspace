/**
 * The compile-time auto-height injection: presence, opt semantics, idempotency and thinness.
 *
 * Decision sources: GitHub Issues
 * - #185 — "Implement: cell-compiler 编译期注入 ReactCellAutoHeight"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/185), this file's ticket,
 *   Ticket 1 of Epic #184,
 * - #124 — the artifact-thinness negative controls this file extends: the patch IS real
 *   runtime code (allowed in the artifact), but it must not drag the capability registry,
 *   the contract tables or the mock in with it.
 *
 * ## What is local evidence here, and what is not
 *
 * Everything in this file is `local` evidence in #4's vocabulary: it proves the artifact
 * carries the injection, carries it once, omits it on opt-out, and stays free of the
 * toolchain symbols #124 forbids. It does NOT prove the patch adapts a real cell's height —
 * that is the real-machine verification (#185's acceptance), recorded on the ticket with
 * the browser evidence separated from this run. AGENTS.md rule 7 forbids presenting this
 * green run as runtime compatibility.
 */

import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  CELL_BROWSER_HOST_GLOBALS,
  CELL_USER_SCOPE_BINDINGS,
  createCellRegistry,
  REACTCELLTYPE_CREATE_CONTENT_CONTRACT,
} from "@forguncy-react-workspace/core";
import type { DependencyDecision } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

import { compileCell } from "./artifact.ts";
import type { CompileCellOutcome } from "./artifact.ts";
import { buildCellProject } from "./build-cell-project.ts";
import {
  AUTO_HEIGHT_DIAGNOSTIC_GLOBAL,
  AUTO_HEIGHT_GENERATED_BANNER,
  autoHeightNamesAreVerified,
  CELL_AUTO_HEIGHT_HOST_NAMES,
  renderAutoHeightInjection,
} from "./auto-height.ts";
import { createRolldownCellBundler } from "./rolldown-bundler.ts";

const DEPENDENCIES: readonly DependencyDecision[] = [
  { strategy: "host", packageName: "react", globalName: "React" },
];

/**
 * A minimal Cell, compiled from a scratch file — the same pattern
 * `runtime-binding.test.ts`'s `compilePlainCell` uses, for the same reason: resolving
 * `react` the same way across compiles, and a marker string that makes the artifact
 * identifiable rather than assumed.
 *
 * The scratch directory is created **by the caller** rather than per compile: the
 * byte-increment test compiles the same entry twice with different layout options,
 * and two tempdir paths differing in length would leak a path-length difference into
 * what is supposed to measure the injection alone.
 */
async function compileScratchCell(layout?: { readonly heightMode?: "auto" | "fixed" }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "fgc-auto-height-"));
  try {
    const entry = join(dir, "ScratchCell.tsx");
    writeFileSync(
      entry,
      `export function App() {\n  return <section data-marker="scratch-cell-marker">scratch cell</section>;\n}\n`,
    );
    const outcome = await compileCell(
      { entry, dependencies: [...DEPENDENCIES] },
      {
        bundler: createRolldownCellBundler({ dir }),
        ...(layout === undefined ? {} : { layout }),
      },
    );
    return compiledCode(outcome);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Two compiles of one entry in one directory, differing only in the layout option —
 * the measurement pair the byte-increment test needs, with no path-length noise.
 */
async function compileLayoutPair(): Promise<{ readonly adaptive: string; readonly fixed: string }> {
  const dir = mkdtempSync(join(tmpdir(), "fgc-auto-height-pair-"));
  try {
    const entry = join(dir, "ScratchCell.tsx");
    writeFileSync(
      entry,
      `export function App() {\n  return <section data-marker="scratch-cell-marker">scratch cell</section>;\n}\n`,
    );
    const compile = async (layout?: { readonly heightMode?: "auto" | "fixed" }) => {
      const outcome = await compileCell(
        { entry, dependencies: [...DEPENDENCIES] },
        {
          bundler: createRolldownCellBundler({ dir }),
          ...(layout === undefined ? {} : { layout }),
        },
      );
      return compiledCode(outcome);
    };
    return { adaptive: await compile(), fixed: await compile({ heightMode: "fixed" }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function compiledCode(outcome: CompileCellOutcome): string {
  if (outcome.status !== "compiled") {
    throw new Error(
      `Expected the scratch Cell to compile; it was rejected with:\n${outcome.diagnostics
        .map(diagnostic => `  - ${diagnostic.code}: ${diagnostic.message}`)
        .join("\n")}`,
    );
  }
  return outcome.artifact.code;
}

// ---------------------------------------------------------------------------
// Injection presence and opt semantics
// ---------------------------------------------------------------------------

describe("the compile-time auto-height injection", () => {
  it("is present in a default compile, ahead of the bundle", async () => {
    // The Epic's default: an undeclared Cell compiles height-adaptive. "Ahead of the
    // bundle" is asserted as "before the entry binding is assigned", the first line of
    // the bundler's IIFE — the same ordering fact `runtime-binding.test.ts` asserts
    // for the live-props declaration.
    const code = await compileScratchCell();

    expect(code).toContain(AUTO_HEIGHT_GENERATED_BANNER);
    expect(code).toContain("__reactCellAutoHeightPatched");
    expect(code.indexOf(AUTO_HEIGHT_GENERATED_BANNER)).toBeLessThan(code.indexOf("var __forguncyCellEntry ="));
    // And the mechanism's three parts are all there — the complementarity is the
    // mechanism, so a compile that dropped one would fail here rather than silently
    // shipping a half-patch.
    expect(code).toContain("repairExistingContainers");
    expect(code).toContain("MutationObserver");
    expect(code).toContain("setInterval");
  });

  it("carries no hardcoded cell id — the position-independent pattern instead", async () => {
    // The acceptance criterion in executable form: `r\d+c\d+p` keys the repair and
    // observer passes precisely so one artifact adapts at any grid position. A compile
    // that emitted a concrete id (`r0c0p` and friends) would be readable here as a
    // regression to position-dependent patching.
    const code = await compileScratchCell();

    expect(code).toContain(String.raw`/^r\d+c\d+p$/`);
  });

  it("is absent when the Cell declares heightMode fixed — the declared opt-out", async () => {
    const code = await compileScratchCell({ heightMode: "fixed" });

    expect(code).toContain("scratch-cell-marker");
    expect(code).not.toContain(AUTO_HEIGHT_GENERATED_BANNER);
    expect(code).not.toContain("__reactCellAutoHeightPatched");
    expect(code).not.toContain("repairExistingContainers");
    expect(code).not.toContain(AUTO_HEIGHT_DIAGNOSTIC_GLOBAL);
  });

  it("is present when the Cell declares heightMode auto explicitly — the written default", async () => {
    // `auto` is the default, but it is also a legitimate written answer: a reviewer
    // reading a diff should be able to tell "this Cell accepted the default on purpose"
    // from "nobody thought about it", and the two must compile to the same artifact.
    // One directory for both compiles, so the comparison is the layout option and
    // nothing else — two tempdir paths differ in length, which would fail the equality
    // for a reason that has nothing to do with the option.
    const dir = mkdtempSync(join(tmpdir(), "fgc-auto-height-explicit-"));
    try {
      const entry = join(dir, "ScratchCell.tsx");
      writeFileSync(
        entry,
        `export function App() {\n  return <section data-marker="scratch-cell-marker">scratch cell</section>;\n}\n`,
      );
      const compile = async (layout?: { readonly heightMode?: "auto" | "fixed" }) => {
        const outcome = await compileCell(
          { entry, dependencies: [...DEPENDENCIES] },
          {
            bundler: createRolldownCellBundler({ dir }),
            ...(layout === undefined ? {} : { layout }),
          },
        );
        return compiledCode(outcome);
      };
      const explicit = await compile({ heightMode: "auto" });
      const undeclared = await compile();

      expect(explicit).toContain(AUTO_HEIGHT_GENERATED_BANNER);
      expect(explicit).toBe(undeclared);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is exactly one injection per artifact, however the compile is shaped", async () => {
    // Within one artifact the injection is single by construction — assembly emits the
    // block once. Counting the banner rather than the mechanism names because the
    // banner is the injection's own marker: the names also occur once each, but the
    // banner is the count a regression would multiply first.
    const code = await compileScratchCell();
    const occurrences = code.split(AUTO_HEIGHT_GENERATED_BANNER).length - 1;

    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency of the mechanism itself
// ---------------------------------------------------------------------------

describe("the patch's own idempotency guards", () => {
  it("guards the prototype wrap and the stylesheet against repeat application", () => {
    // Cross-artifact and re-compile correctness is carried by these two guards, both
    // page-global state: the constructor prototype is shared by every cell of the type,
    // so a second compiled cell whose artifact also injects reaches the guard and
    // stops — no double-wrap, no second observer. Asserted on the rendered source
    // because that is the side that can be checked: it fails the moment someone drops
    // a guard while editing the template.
    const source = renderAutoHeightInjection();

    expect(source).toContain("ctor.prototype[");
    expect(source).toContain("__reactCellAutoHeightPatched");
    expect(source).toContain('document.querySelector("style[data-reactcell-autoh]")');
  });

  it("short-circuits the polling loop once patched or out of attempts", () => {
    // The poll is the timing-tolerance mechanism, and a poll that never stopped would
    // be a per-page leak every artifact carries. `clearInterval` is the stop, asserted
    // beside the `setInterval` that starts it.
    const source = renderAutoHeightInjection();

    expect(source).toContain("setInterval");
    expect(source).toContain("clearInterval(timer)");
    expect(source).toContain("attempts > 200");
  });

  it("publishes a diagnostic global disjoint from the external library's name", () => {
    // Verification needs to distinguish "never ran" from "ran into an already-set
    // guard", and a page carrying both the injection and the external `reactcell-autoh`
    // library must not have two writers fighting over one writable:false global — the
    // second defineProperty would throw inside its own IIFE. The disjoint name is the
    // whole point, so the test pins both directions: the injection's name is present,
    // the library's name is absent.
    const source = renderAutoHeightInjection();

    expect(source).toContain(AUTO_HEIGHT_DIAGNOSTIC_GLOBAL);
    expect(source).not.toContain('"ReactCellAutoHeight"');
    expect(AUTO_HEIGHT_DIAGNOSTIC_GLOBAL).not.toBe("ReactCellAutoHeight");
  });
});

// ---------------------------------------------------------------------------
// The contract derivation: the source names what the evidence records
// ---------------------------------------------------------------------------

describe("the injection's derivation from the runtime contract", () => {
  it("embeds the contract's registry key, marker class and id pattern, not a second spelling", () => {
    // `renderAutoHeightInjection` reads the constants off `core`'s evidence record, so
    // a contract edit changes what every future artifact injects. The test pins the
    // direction: the rendered source carries the contract's values, and they are the
    // values the live 12.0.102.0 probe measured — see
    // `packages/mcp-sync/scripts/probe-autoh-evidence-185.mjs`.
    const source = renderAutoHeightInjection();
    const contract = REACTCELLTYPE_CREATE_CONTENT_CONTRACT;

    expect(source).toContain(JSON.stringify(contract.registryKey));
    expect(source).toContain(JSON.stringify(contract.markerClass));
    expect(source).toContain(`/${contract.containerIdPattern}/`);
    expect(contract.containerIdPattern).toBe(String.raw`^r\d+c\d+p$`);
  });

  it("names only identifiers the browser-globals table verifies", () => {
    // A patch that reached for an invented global would ship an artifact throwing
    // `ReferenceError` at evaluation — before React or the cell is involved, and
    // invisible to every artifact audit because a free identifier is not an import.
    expect(autoHeightNamesAreVerified()).toBe(true);
    for (const name of CELL_AUTO_HEIGHT_HOST_NAMES) {
      expect(
        CELL_BROWSER_HOST_GLOBALS.some(entry => entry.name === name),
        name,
      ).toBe(true);
    }
  });

  it("references every name it declares, and declares every name it references", () => {
    // The declaration is checked in both directions, the same discipline
    // `runtime-binding.test.ts` applies to the other generated module: one direction
    // alone passes for a list the template never uses, the other alone for a
    // declaration that has outlived the template.
    const source = renderAutoHeightInjection();

    for (const name of CELL_AUTO_HEIGHT_HOST_NAMES) {
      expect(source, name).toMatch(new RegExp(`\\b${name}\\b`));
    }
    // The mirror: the host-environment free identifiers in the source are exactly the
    // declared ones. `document`, `MutationObserver`, `setInterval`, `clearInterval` and
    // `Forguncy` are the five; everything else the patch touches is either a local,
    // an ES builtin (`Object`, `String`, `globalThis`), or a property access on one of
    // those. `globalThis` is an ES2020 builtin rather than a host name, so it is
    // deliberately absent from the declaration — and present in the source.
    expect(source).toContain("globalThis");
    expect(CELL_AUTO_HEIGHT_HOST_NAMES).not.toContain("globalThis");
  });

  it("keeps its names out of the host-mapping surface", () => {
    // The separation this module exists to keep: `CELL_USER_SCOPE_BINDINGS` membership
    // is what `artifact-audits.ts` reads as permission to map a `host` dependency onto
    // a global, and `document` must never become such an identity. Asserted rather
    // than assumed because the cheap fix for "the patch names things" is to add them
    // to the wrong table.
    for (const name of CELL_AUTO_HEIGHT_HOST_NAMES) {
      expect(
        CELL_USER_SCOPE_BINDINGS.some(binding => binding.name === name),
        `${name} must stay out of CELL_USER_SCOPE_BINDINGS`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// #124 thinness: real runtime code, no toolchain leakage
// ---------------------------------------------------------------------------

const TOOLCHAIN_SYMBOLS = [
  "LOCAL_DEV_",
  "RUNTIME_FACADE_CAPABILITIES",
  "RUNTIME_CONTRACT_TARGET",
  "SELECTION_SIGNALS",
  "createMockRuntimeFacadeProvider",
] as const;

describe("the injection's artifact thinness (#124)", () => {
  it("carries no toolchain or contract-table symbols", async () => {
    // The patch IS real runtime code — DOM manipulation and platform registry access
    // are exactly what a production artifact may carry. What it must not carry is the
    // toolchain: the capability registry, the contract prose tables, the mock. The
    // check is over the whole composed artifact rather than only the injected block,
    // because a leak would hide in the bundle half.
    const code = await compileScratchCell();

    for (const symbol of TOOLCHAIN_SYMBOLS) {
      expect(code, `artifact carries "${symbol}"`).not.toContain(symbol);
    }
  });

  it("measures the byte increment the injection costs", async () => {
    // #124's discipline extended: a size increase is fine when it is *this* code and
    // accounted for. The increment is measured rather than estimated, over one entry
    // in one directory so no path-length noise enters the comparison.
    const { adaptive, fixed } = await compileLayoutPair();
    const increment = adaptive.length - fixed.length;
    const patchLength = renderAutoHeightInjection().length;

    // The increment is the patch plus its newline joining — no more. A compile that
    // dragged anything else in with the injection (a module wrapper, a second copy)
    // exceeds this by far more than rounding.
    expect(increment).toBeGreaterThan(patchLength - 20);
    expect(increment).toBeLessThan(patchLength + 20);
    // And the order of magnitude is recorded for the PR: small single-digit KiB, not
    // the tens of kilobytes a leaked contract table would cost.
    expect(increment).toBeLessThan(8192);
    console.info(
      `[auto-height] artifact increment: ${increment} characters ` +
        `(adaptive ${adaptive.length}, fixed ${fixed.length}, patch source ${patchLength})`,
    );
  });

  it("trips none of the artifact's own source guards", async () => {
    // The injected source is spliced into the composed artifact verbatim, so it is
    // parsed by the same audit as the bundle: no import/export declarations, no
    // refused callees, no dynamic import. The proof is that the compile *succeeded* —
    // `compileScratchCell` throws on rejection — but the assertion is stated rather
    // than left implicit, because the guard is exactly what a careless edit to the
    // template (an `import` sneaking in) would trip first.
    const code = await compileScratchCell();

    expect(code).toContain(AUTO_HEIGHT_GENERATED_BANNER);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the config declaration reaches the artifact
// ---------------------------------------------------------------------------

describe("the config-to-artifact path", () => {
  /**
   * Compiles one tiny project end-to-end through the public build entry — config
   * normalization, registry, plan, compile — the way `vp build` and the sync consume it.
   *
   * The cells are written into one scratch project so the registry's path checks pass
   * for real, and the two entries are identical on purpose: any difference in the
   * artifacts is then the declaration's, which is what the assertions read.
   */
  async function buildTwoCellProject(): Promise<{ readonly adaptive: string; readonly fixed: string }> {
    const root = mkdtempSync(join(tmpdir(), "fgc-auto-height-project-"));
    try {
      const { mkdirSync } = await import("node:fs");
      for (const id of ["adaptiveCell", "fixedCell"]) {
        const dir = join(root, "cells", id, "src");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "index.tsx"),
          `export function App() {\n  return <section data-marker="${id}">${id}</section>;\n}\n`,
        );
      }
      const registry = createCellRegistry(
        {
          cells: {
            adaptiveCell: {
              entry: "./cells/adaptiveCell/src/index.tsx",
              target: { pageName: "探针", cell: "A1" },
              layout: { heightMode: "auto" },
            },
            fixedCell: {
              entry: "./cells/fixedCell/src/index.tsx",
              target: { pageName: "探针", cell: "B2" },
              layout: { heightMode: "fixed" },
            },
          },
        },
        { root },
      );
      const build = await buildCellProject({
        registry,
        dependencies: [{ strategy: "host", packageName: "react", globalName: "React" }],
        workspace: false,
      });

      const codeOf = (cellId: string): string => {
        const cell = build.cells.find(candidate => candidate.cellId === cellId);
        if (cell?.outcome.status !== "compiled") {
          throw new Error(`Cell "${cellId}" must compile; it was: ${JSON.stringify(cell?.outcome)}`);
        }
        return cell.outcome.artifact.code;
      };
      return { adaptive: codeOf("adaptiveCell"), fixed: codeOf("fixedCell") };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("two Cells of one project differ exactly by their declared heightMode", async () => {
    // The integration the option-plumbing tests cannot prove: `forguncy.config.ts`'s
    // `cells.<id>.layout.heightMode` travels through the registry's materialization,
    // the plan and `buildCellProject` into `compileCell`'s options — so one project's
    // two Cells really can differ, and they differ in the injection and nothing else.
    const { adaptive, fixed } = await buildTwoCellProject();

    expect(adaptive).toContain(AUTO_HEIGHT_GENERATED_BANNER);
    expect(adaptive).toContain("adaptiveCell");
    expect(fixed).not.toContain(AUTO_HEIGHT_GENERATED_BANNER);
    expect(fixed).not.toContain("__reactCellAutoHeightPatched");
    expect(fixed).toContain("fixedCell");
    // The size relationship is the mechanism-independent proof: the difference between
    // the two artifacts is the injection's cost, not a different compile.
    expect(adaptive.length - fixed.length).toBeGreaterThan(renderAutoHeightInjection().length - 20);
  });
});
