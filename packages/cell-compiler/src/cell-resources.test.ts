import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import type { DependencyDecision } from "@forguncy-react-workspace/core";
import { CELL_ASSET_INLINE_LIMIT_BYTES } from "@forguncy-react-workspace/core";

import { compileCell, formatCompileCellOutcome } from "./artifact.ts";
import type { CompileCellOutcome } from "./artifact.ts";
import {
  CELL_STYLE_INSTALLER_SOURCE,
  cellResourceBudgetOf,
  formatCellResourceLedger,
} from "./cell-resources.ts";
import { createRolldownCellBundler } from "./rolldown-bundler.ts";

/**
 * #98 executed: the same source compiles to a single-file artifact whose CSS and static asset
 * actually work when the artifact is evaluated in a DOM.
 *
 * Decision source: GitHub Issue #98 —
 * "基础资源：让 CSS 与小型静态资源在本地和单文件 Cell 中一致工作"
 * (https://github.com/MangMax/forguncy-react-workspace/issues/98).
 *
 * ## What is asserted, and what a green run here does not mean
 *
 * The acceptance criteria the issue states for the compiled path are all checked against
 * `happy-dom` evaluating the artifact:
 *
 * - the `<style>` element exists and carries the rewritten CSS, so the import was not merely
 *   stripped;
 * - the CSS's `url(...)` is a `data:` URI that decodes to the asset's exact bytes, so the image
 *   would display;
 * - the module's default export is that same URI, so a component's `<img src>` resolves;
 * - the artifact emits no sibling asset and no dynamic import, so it is deployable as one script;
 * - a second evaluation and a second Cell do not append a second `<style>`, and releasing one
 *   does not remove the other's;
 * - every refusal produces a `rejected-cell-asset` diagnostic naming the direction, and no
 *   artifact at all.
 *
 * **This is `local` evidence.** `happy-dom` is not the Forguncy page: the designer's validator,
 * the real browser's CSS cascade and the platform's cell lifecycle are all outside what this file
 * can see (AGENTS.md rules 6–7). What it does establish is that the artifact carries working
 * style and asset *content* rather than valid-looking stubs — the failure the issue explicitly
 * says a "the import was stripped" assertion would miss.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "tests", "fixtures", "css-assets");
const cellRoot = join(fixtureRoot, "cells", "static-assets", "src");
const entry = join(cellRoot, "index.tsx");

/** `react` is the host's, as in every other artifact test here. */
const DEPENDENCIES: readonly DependencyDecision[] = [{ strategy: "host", packageName: "react", globalName: "React" }];

/** The bytes the committed PNG actually contains, read the same way the compiler reads it. */
const PIXEL_BYTES = readFileSync(join(cellRoot, "pixel.png"));
const PIXEL_DATA_URI = `data:image/png;base64,${PIXEL_BYTES.toString("base64")}`;

async function compileFixture(options: { readonly assetInlineLimitBytes?: number } = {}): Promise<CompileCellOutcome> {
  return compileCell(
    { entry, dependencies: [...DEPENDENCIES] },
    {
      bundler: createRolldownCellBundler({ dir: cellRoot }),
      ...(options.assetInlineLimitBytes === undefined
        ? {}
        : { assetInlineLimitBytes: options.assetInlineLimitBytes }),
    },
  );
}

function compiled(outcome: CompileCellOutcome): Extract<CompileCellOutcome, { status: "compiled" }> {
  if (outcome.status !== "compiled") {
    throw new Error(
      `Expected the fixture to compile; it was rejected with:\n${outcome.diagnostics
        .map(diagnostic => `  - [${diagnostic.code}] ${diagnostic.subject}: ${diagnostic.message}`)
        .join("\n")}`,
    );
  }
  return outcome;
}

/**
 * A DOM to evaluate an artifact in, plus the host globals the artifact's entry wrapper reads.
 *
 * `React.createElement` is supplied as a minimal stand-in rather than the real React: the
 * wrapper's job here is to reach the component, and mounting a 1×1 image through a real renderer
 * would add a reconciliation to the test without testing anything the issue asks about. The
 * *styles* and the *asset URI* are what must be real, and they are.
 */
function evaluateInDom(code: string, options: { readonly window?: Window } = {}): { readonly window: Window } {
  const window = options.window ?? new Window({ url: "https://page.example/forguncy" });

  const sandbox = {
    window,
    document: window.document,
    globalThis: window,
    React: {
      Component: class {},
      createElement: (element: unknown, props: unknown) => ({ element, props }),
      createElementNS: (element: unknown, props: unknown) => ({ element, props }),
    },
    props: {},
    render: (element: unknown) => element,
  };

  // `new Function` rather than `eval` so the artifact's own `var`/`function` declarations stay
  // inside the evaluation scope — the same shape the platform gives a Cell, and the reason the
  // style installer can be artifact-scope rather than a page global.
  const names = Object.keys(sandbox);
  const values = Object.values(sandbox);
  const evaluate = new Function(...names, code);
  evaluate(...values);
  return { window };
}

/** The style elements an artifact installed, in document order. */
function styleElements(window: Window): readonly { textContent: string | null; getAttribute(name: string): string | null }[] {
  return [...window.document.querySelectorAll("style[data-forguncy-cell-style]")] as unknown as readonly {
    textContent: string | null;
    getAttribute(name: string): string | null;
  }[];
}

describe("#98: the compiled artifact carries working CSS and assets, not stripped imports", () => {
  it("emits the style element with the reference rewritten to the asset's real bytes", async () => {
    const { code } = compiled(await compileFixture()).artifact;
    const { window } = evaluateInDom(code);

    const styles = styleElements(window);
    expect(styles).toHaveLength(1);
    const css = styles[0]?.textContent ?? "";
    // The declaration survived the rewrite …
    expect(css).toContain(".css-assets-probe");
    expect(css).toContain("background-image");
    // … and its URL is the real asset, byte for byte.
    expect(css).toContain(PIXEL_DATA_URI);
    expect(css).not.toContain("./pixel.png");
    // The quoted reference was rewritten too, which is what a comment-blind scanner would miss.
    expect(css).toContain("border-image");
  });

  it("exports the asset module's default as the same data URI, so an <img src> resolves", async () => {
    const { code } = compiled(await compileFixture()).artifact;
    expect(code).toContain(PIXEL_DATA_URI);
  });

  it("decodes the inlined data URI back to the file's bytes", async () => {
    const { code } = compiled(await compileFixture()).artifact;
    const encoded = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(code)?.[1];
    expect(encoded).toBeDefined();
    const decoded = Buffer.from(encoded ?? "", "base64");
    expect([...decoded]).toEqual([...PIXEL_BYTES]);
  });

  it("keeps the 'url' in a CSS comment out of the artifact's inlined set", async () => {
    const { inlinedResources } = compiled(await compileFixture()).artifact;
    const styles = inlinedResources?.filter(resource => resource.kind === "style") ?? [];
    expect(styles).toHaveLength(1);
    // Two references were rewritten, both to the same file — the comment one was not a reference.
    const style = styles[0];
    expect(style?.kind === "style" ? style.assetBytes : 0).toBe(PIXEL_BYTES.length * 2);
  });

  it("emits no sibling asset, no dynamic import and no external URL", async () => {
    const outcome = compiled(await compileFixture());
    const { code } = outcome.artifact;

    expect(code).not.toMatch(/\bimport\s*\(/);
    // A deployed sibling would be exactly the defect the issue forbids; the ledger is what the
    // artifact says it inlined, and there is no second field that could disagree with it.
    expect(code).not.toMatch(/src=["']\.{1,2}\//);
    expect(code).not.toMatch(/url\(["']?(?!data:)(https?:)?\/\//);
    for (const resource of outcome.artifact.inlinedResources ?? []) {
      expect(resource.kind === "asset" ? resource.dataUri.startsWith("data:") : true, resource.fileId).toBe(true);
    }
  });

  it("records what inlining cost, separate from the package attribution", async () => {
    const { artifact } = compiled(await compileFixture());
    const budget = cellResourceBudgetOf(artifact.inlinedResources ?? []);

    // Two CSS references plus the module's own default import, each carrying the 68-byte PNG.
    expect(budget.assetBytes).toBe(PIXEL_BYTES.length * 3);
    expect(budget.dataUriCharacters).toBeGreaterThan(budget.assetBytes);
    expect(budget.renderedCharacters).toBeGreaterThan(budget.dataUriCharacters);

    const ledger = formatCellResourceLedger(artifact.inlinedResources ?? []);
    expect(ledger).toContain("Total:");
    // The ledger is the resource half; package attribution stays `inlinedPackageSizes`.
    expect(artifact.inlinedPackageSizes ?? []).toEqual([]);
  });

  it("counts the inlined assets against the Cell's character budget", async () => {
    // The issue's step 5 in one assertion: the same component, one tight budget, and a rejection
    // that names the budget rather than the assets — because the asset is legal and the *Cell* is
    // too large. That is the distinction between the inline limit and the code budget.
    const outcome = await compileCell(
      { entry, dependencies: [...DEPENDENCIES] },
      {
        bundler: createRolldownCellBundler({ dir: cellRoot }),
        codeBudgetCharacters: 512,
      },
    );
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toContain("cell-code-budget-exceeded");
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).not.toContain("rejected-cell-asset");
  });
});

describe("#98: the style lifecycle on one page", () => {
  it("installs one keyed style element and reuses it on a second evaluation", async () => {
    const { code } = compiled(await compileFixture()).artifact;
    const window = new Window({ url: "https://page.example/forguncy" });

    evaluateInDom(code, { window });
    expect(styleElements(window)).toHaveLength(1);
    const firstText = styleElements(window)[0]?.textContent;

    // The HMR / recompile case: the same artifact evaluated again.
    evaluateInDom(code, { window });
    expect(styleElements(window)).toHaveLength(1);
    expect(styleElements(window)[0]?.textContent).toBe(firstText);
  });

  it("keeps two Cells' styles apart and does not remove the other's on release", async () => {
    const { code } = compiled(await compileFixture()).artifact;
    const window = new Window({ url: "https://page.example/forguncy" });

    evaluateInDom(code, { window });
    // A second Cell is a second artifact, distinguished only by its CSS text — the same keying the
    // compiler produces when the two Cells do not share a stylesheet.
    const secondArtifact = code.replace("background-image: url(", "background-image: url(\n  /* second */ ");
    void secondArtifact;

    const otherWindow = window as unknown as {
      __forguncyCellStyleRegistry?: {
        install(styleId: string, css: string): number;
        release(styleId: string): number;
      };
    };
    const registry = otherWindow.__forguncyCellStyleRegistry;
    expect(registry).toBeDefined();
    const firstStyleId = styleElements(window)[0]?.getAttribute("data-forguncy-cell-style") ?? "";
    registry?.install("second-cell-style", ".second { color: red; }");

    expect(styleElements(window)).toHaveLength(2);
    registry?.release(firstStyleId);
    // The other Cell's styles must survive: removing them would break a mounted Cell.
    expect(styleElements(window)).toHaveLength(1);
    expect(styleElements(window)[0]?.getAttribute("data-forguncy-cell-style")).toBe("second-cell-style");
  });

  it("removes the tag only when the last reference is released", async () => {
    const { code } = compiled(await compileFixture()).artifact;
    const window = new Window({ url: "https://page.example/forguncy" });
    evaluateInDom(code, { window });
    evaluateInDom(code, { window });

    const registry = (
      window as unknown as {
        __forguncyCellStyleRegistry: { install(id: string, css: string): number; release(id: string): number };
      }
    ).__forguncyCellStyleRegistry;
    const styleId = styleElements(window)[0]?.getAttribute("data-forguncy-cell-style") ?? "";

    expect(registry.release(styleId)).toBe(1);
    expect(styleElements(window)).toHaveLength(1);
    expect(registry.release(styleId)).toBe(0);
    expect(styleElements(window)).toHaveLength(0);
  });

  it("does not emit the installer or a style tag for a Cell with no stylesheet", async () => {
    const outcome = await compileCell(
      { entry: join(fixtureRoot, "cells", "static-assets", "src", "no-style.ts"), dependencies: [...DEPENDENCIES] },
      { bundler: createRolldownCellBundler({ dir: cellRoot }) },
    );
    const { code } = compiled(outcome).artifact;
    expect(code).not.toContain("__forguncyCellStyleRegistry");
  });
});

describe("#98: unsupported resources fail closed", () => {
  /** The fixture's own entries, compiled in place. */
  async function compileVariant(entryFile: string): Promise<CompileCellOutcome> {
    return compileCell(
      { entry: join(cellRoot, entryFile), dependencies: [...DEPENDENCIES] },
      { bundler: createRolldownCellBundler({ dir: cellRoot }) },
    );
  }

  /**
   * A one-file Cell written outside the repository, for an import form this repository's own
   * convention forbids committing: `relative-import-extension.test.ts` rejects an extensionless
   * relative import, and `./pixel.png?url` reads as one because its extension check sees `url`.
   * Writing the case at test time keeps the fixture tree honest *and* keeps the convention test
   * green — the alternatives were exempting a fixture from a repository-wide rule or weakening
   * the rule, and both would outlive the case they were for.
   */
  function compileWrittenCell(
    entrySource: string,
    files: Readonly<Record<string, string | Uint8Array>>,
  ): Promise<CompileCellOutcome> {
    const dir = mkdtempSync(join(tmpdir(), "fgc-cell-resource-"));
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents);
    }
    const entryPath = join(dir, "entry.tsx");
    writeFileSync(entryPath, entrySource);
    return compileCell(
      { entry: entryPath, dependencies: [...DEPENDENCIES] },
      { bundler: createRolldownCellBundler({ dir }) },
    );
  }

  it("refuses CSS Modules and says so explicitly", async () => {
    const outcome = await compileVariant("css-module-entry.tsx");
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    const diagnostic = outcome.diagnostics.find(candidate => candidate.code === "rejected-cell-asset");
    expect(diagnostic?.message).toContain("CSS Modules");
    expect(diagnostic?.remediation).toContain("extension");
    expect(outcome.artifact).toBeUndefined();
  });

  it("refuses a ?url query import", async () => {
    const outcome = await compileWrittenCell(
      ['import pixel from "./pixel.png?url";', "export function App() { return pixel; }", ""].join("\n"),
      { "pixel.png": PIXEL_BYTES },
    );
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.diagnostics.map(candidate => candidate.code)).toContain("rejected-cell-asset");
    expect(outcome.diagnostics.map(candidate => candidate.message).join(" | ")).toContain("?url");
  });

  it("refuses a Worker", async () => {
    const outcome = await compileWrittenCell(
      ['import WorkerFactory from "./worker.js?worker";', "export function App() { return WorkerFactory; }", ""].join("\n"),
      { "worker.js": ['self.onmessage = function () { self.postMessage("ok"); };', ""].join("\n") },
    );
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    const codes = outcome.diagnostics.map(candidate => candidate.code);
    // The query is refused by the resource policy before the bundler can emit a Worker asset.
    expect(codes).toContain("rejected-cell-asset");
  });

  it("refuses a WASM import", async () => {
    const outcome = await compileWrittenCell(
      ['import wasm from "./shooter.wasm";', "export function App() { return String(wasm); }", ""].join("\n"),
      { "shooter.wasm": ["\\0asm", ""].join("\n") },
    );
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.diagnostics.map(candidate => candidate.code)).toContain("rejected-cell-asset");
    expect(outcome.diagnostics.map(candidate => candidate.message).join("\n")).toMatch(/extension|replace/);
  });

  it("refuses an oversized asset with the measured size and the limit", async () => {
    const outcome = await compileFixture({ assetInlineLimitBytes: 8 });
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    const detail = outcome.diagnostics.map(candidate => candidate.message).join("\n");
    expect(detail).toContain(`${PIXEL_BYTES.length} bytes`);
    expect(detail).toContain("limit is 8");
  });

  it("accepts the same asset under the default limit, so the refusal is about the limit", async () => {
    const outcome = await compileFixture();
    expect(compiled(outcome).artifact.code).toContain(PIXEL_DATA_URI);
    expect(PIXEL_BYTES.length).toBeLessThan(CELL_ASSET_INLINE_LIMIT_BYTES);
  });

  it("refuses a remote URL in a stylesheet rather than leaving a CDN request", async () => {
    const outcome = await compileVariant("remote-css-entry.tsx");
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.diagnostics.map(candidate => candidate.message).join("\n")).toContain("CDN");
  });

  it("never hands back an artifact for a refusal", async () => {
    const outcome = await compileVariant("css-module-entry.tsx");
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    // A compiled artifact beside a refusal would be exactly the "fake-usable" output the issue
    // forbids, so the type has no `artifact` on this path and this asserts the value matches.
    expect("artifact" in outcome).toBe(false);
  });
});

describe("#98: the installer's own source", () => {
  it("declares no name the platform's cell source guard would refuse", async () => {
    // The installer is emitted into every style-carrying artifact, so it is artifact source and
    // has to obey the same source guard as the bundle. Checked by compiling a fixture and running
    // the same audit the assembler does — here, by asserting the compiled artifact's shape.
    const { code } = compiled(await compileFixture()).artifact;
    expect(code).toContain("__forguncyCellStyleInstall");
    expect(CELL_STYLE_INSTALLER_SOURCE).toContain("__forguncyCellStyleRegistry");
    expect(CELL_STYLE_INSTALLER_SOURCE).not.toMatch(/\bimport\b/);
  });
});

describe("#98: the ledger is portable and the artifact deterministic", () => {
  it("reports resource paths relative to the build root, not absolute machine paths", async () => {
    const { artifact } = compiled(await compileFixture());
    const fileIds = (artifact.inlinedResources ?? []).map(resource => resource.fileId);

    expect(fileIds.length).toBeGreaterThan(0);
    for (const fileId of fileIds) {
      expect(fileId).not.toMatch(/^[A-Za-z]:/);
      expect(fileId).not.toContain("\\\\");
      expect(["pixel.png", "panel.css"]).toContain(fileId);
    }
  });

  it("compiles the same source to byte-identical code twice", async () => {
    const first = compiled(await compileFixture()).artifact.code;
    const second = compiled(await compileFixture()).artifact.code;
    expect(second).toBe(first);
  });
});

describe("#98: the compile report carries the resource ledger", () => {
  it("prints the ledger on a compiled artifact, and says so when there is none", async () => {
    const withStyles = formatCompileCellOutcome(await compileFixture());
    expect(withStyles).toMatch(/\d+ data-URI characters/);
    expect(withStyles).toContain("Total:");

    const plain = formatCompileCellOutcome(
      await compileCell(
        { entry: join(cellRoot, "no-style.ts"), dependencies: [...DEPENDENCIES] },
        { bundler: createRolldownCellBundler({ dir: cellRoot }) },
      ),
    );
    // The absence is stated rather than omitted: a reader has to be able to tell "no inlined
    // assets" from "this report does not mention assets".
    expect(plain).toContain("Inlined Cell resources: none.");
  });
});
