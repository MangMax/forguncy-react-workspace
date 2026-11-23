/**
 * The v1 resource policy, as a pure contract (#98).
 *
 * Decision source: GitHub Issue #98
 * (https://github.com/MangMax/forguncy-react-workspace/issues/98).
 *
 * The policy is the one thing the compiler and the dev harness must answer identically, so it is
 * tested where it lives rather than only through either consumer: a scanner that reads a `url()`
 * inside a comment, an encoder that pads base64 wrong, or a classification that treats a
 * page-relative URL as a file are all invisible to an end-to-end render and obvious here.
 */
import { describe, expect, it } from "vitest";

import {
  CELL_ASSET_INLINE_LIMIT_BYTES,
  CELL_RESOURCE_SUPPORT_MATRIX,
  CELL_SUPPORTED_STATIC_ASSET_EXTENSIONS,
  cellAssetExtensionOf,
  cellStaticAssetMediaType,
  classifyCellResource,
  encodeBase64,
  findCellCssUnsupportedConstructs,
  findCellCssUrlReferences,
  formatCellAssetDataUri,
  formatCellResourceSupportMatrix,
  hasCellResourceQuery,
  isCellCssFile,
  isCellCssModuleFile,
  isCellStylePreprocessorFile,
  isRejectedCellBinaryAsset,
  isSupportedCellStaticAsset,
  rewriteCellCssReferences,
  splitCellSpecifierQuery,
} from "./cell-assets.ts";

const PIXEL_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("the v1 support matrix is explicit and closed", () => {
  it("names a decision for every row", () => {
    expect(CELL_RESOURCE_SUPPORT_MATRIX.length).toBeGreaterThan(5);
    for (const row of CELL_RESOURCE_SUPPORT_MATRIX) {
      expect(["supported", "rejected"], row.id).toContain(row.decision);
      expect(row.pattern.trim().length, row.id).toBeGreaterThan(0);
      expect(row.note.trim().length, row.id).toBeGreaterThan(20);
    }
  });

  it("decides CSS Modules rather than leaving them ambiguous", () => {
    // The issue's explicit requirement: modules are either supported consistently or refused
    // loudly. v1 refuses, so the matrix must say so rather than omitting the row.
    const row = CELL_RESOURCE_SUPPORT_MATRIX.find(candidate => candidate.id === "css-modules");
    expect(row?.decision).toBe("rejected");
    expect(row?.note).toContain("explicitly");
  });

  it("prints the same matrix it holds", () => {
    const printed = formatCellResourceSupportMatrix().split("\n");
    expect(printed).toHaveLength(CELL_RESOURCE_SUPPORT_MATRIX.length);
    expect(printed.every(line => line.startsWith("supported") || line.startsWith("rejected"))).toBe(true);
  });

  it("does not claim Workers or WASM", () => {
    const workers = CELL_RESOURCE_SUPPORT_MATRIX.find(candidate => candidate.id === "workers-wasm");
    expect(workers?.decision).toBe("rejected");
  });
});

describe("file classification", () => {
  it("reads the extension with a query or fragment removed", () => {
    expect(cellAssetExtensionOf("a/b/Logo.PNG")).toBe(".png");
    expect(cellAssetExtensionOf("./x.css?inline")).toBe(".css");
    expect(cellAssetExtensionOf("./x.svg#icon")).toBe(".svg");
    expect(cellAssetExtensionOf("no-extension")).toBe("");
  });

  it("distinguishes a plain stylesheet from a module and from a preprocessor source", () => {
    expect(isCellCssFile("./a.css")).toBe(true);
    expect(isCellCssModuleFile("./a.module.css")).toBe(true);
    expect(isCellCssFile("./a.module.css")).toBe(true);
    expect(isCellStylePreprocessorFile("./a.scss")).toBe(true);
    expect(isCellCssModuleFile("./a.scss")).toBe(false);
  });

  it("admits only the listed static asset extensions", () => {
    for (const extension of CELL_SUPPORTED_STATIC_ASSET_EXTENSIONS) {
      expect(isSupportedCellStaticAsset(`asset${extension}`), extension).toBe(true);
      expect(cellStaticAssetMediaType(`asset${extension}`), extension).toMatch(/^[a-z]+\/[-+.\w]+$/);
    }
    expect(isSupportedCellStaticAsset("icon.psd")).toBe(false);
    expect(isSupportedCellStaticAsset("movie.mp4")).toBe(false);
  });

  it("names binary assets as explicitly rejected rather than merely unknown", () => {
    expect(isRejectedCellBinaryAsset("module.wasm")).toBe(true);
    expect(isRejectedCellBinaryAsset("addon.node")).toBe(true);
    expect(isRejectedCellBinaryAsset("icon.psd")).toBe(false);
  });

  it("splits a specifier into its path and query", () => {
    expect(splitCellSpecifierQuery("./a.svg?url")).toEqual({ path: "./a.svg", query: "url" });
    expect(splitCellSpecifierQuery("./a.svg")).toEqual({ path: "./a.svg" });
    expect(hasCellResourceQuery("./a.svg?url")).toBe(true);
    expect(hasCellResourceQuery("./a.svg")).toBe(false);
  });
});

describe("base64 and data URIs", () => {
  it("encodes the same bytes Buffer does, including both padding lengths", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const bytes = Uint8Array.from({ length }, (_, index) => index + 1);
      expect(encodeBase64(bytes), `length ${length}`).toBe(Buffer.from(bytes).toString("base64"));
    }
  });

  it("formats a media type and payload as a data URI", () => {
    expect(formatCellAssetDataUri("image/png", PIXEL_BYTES)).toBe(
      `data:image/png;base64,${Buffer.from(PIXEL_BYTES).toString("base64")}`,
    );
  });
});

describe("the CSS reference scanner", () => {
  it("finds quoted, unquoted and spaced references", () => {
    const references = findCellCssUrlReferences(
      'a { background: url("one.png"); } b { x: url(\'two.png\'); } c { y: url( three.png ); }',
    );
    expect(references.map(reference => reference.url)).toEqual(["one.png", "two.png", "three.png"]);
    expect(references.map(reference => reference.quote)).toEqual(['"', "'", ""]);
  });

  it("does not find a reference inside a comment or a string", () => {
    expect(findCellCssUrlReferences('/* url(ghost.png) */ a { color: red }')).toEqual([]);
    expect(findCellCssUrlReferences('a::after { content: "url(ghost.png)"; }')).toEqual([]);
  });

  it("ends an unquoted URL at the first close paren and tolerates a quoted one containing it", () => {
    expect(findCellCssUrlReferences("a { x: url(one.png) }").map(reference => reference.url)).toEqual([
      "one.png",
    ]);
    expect(findCellCssUrlReferences('a { x: url("weird).png") }').map(reference => reference.url)).toEqual([
      "weird).png",
    ]);
  });

  it("does not read a function whose name merely ends in url as url(", () => {
    expect(findCellCssUrlReferences("a { x: myurl(one.png); }")).toEqual([]);
  });

  it("reports @import and image-set outside comments and strings", () => {
    const constructs = findCellCssUnsupportedConstructs(
      '@import "x.css";\n/* @import "y.css" */\na { background: image-set("a.png" 1x); }',
    );
    expect(constructs.map(construct => construct.kind)).toEqual(["css-import", "image-set"]);
  });
});

describe("rewriting a stylesheet", () => {
  const loadAsset = (): { fileName: string; bytes: Uint8Array } => ({
    fileName: "pixel.png",
    bytes: PIXEL_BYTES,
  });

  it("rewrites every local reference to a data URI and keeps the rest of the sheet", async () => {
    const outcome = await rewriteCellCssReferences({
      css: 'a { background: url("./pixel.png") no-repeat; }',
      fileName: "panel.css",
      inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
      loadAsset,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.css).toContain("data:image/png;base64,");
    expect(outcome.css).not.toContain("./pixel.png");
    expect(outcome.css).toContain("no-repeat");
    expect(outcome.assets).toHaveLength(1);
    expect(outcome.assets[0]?.bytes).toBe(PIXEL_BYTES.length);
  });

  it("leaves data URIs, fragment-only references and empty values alone", async () => {
    const css =
      'a { x: url(data:image/png;base64,AAAA); y: url(#filter); z: url(""); }';
    const outcome = await rewriteCellCssReferences({
      css,
      fileName: "a.css",
      inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
      loadAsset,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.css).toBe(css);
    expect(outcome.assets).toEqual([]);
  });

  it("keeps a fragment on an inlined reference", async () => {
    const outcome = await rewriteCellCssReferences({
      css: 'a { x: url("./pixel.png#glyph"); }',
      fileName: "a.css",
      inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
      loadAsset,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.css).toContain("#glyph");
  });

  it("refuses a remote URL rather than leaving a covert CDN request", async () => {
    const outcome = await rewriteCellCssReferences({
      css: 'a { background: url("https://cdn.example.com/x.png") }',
      fileName: "a.css",
      inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
      loadAsset,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.kind).toBe("remote-url");
    expect(outcome.violations[0]?.detail).toContain("CDN");
  });

  it("refuses a page-relative URL instead of guessing a runtime directory", async () => {
    const outcome = await rewriteCellCssReferences({
      css: "a { x: url(/assets/x.png) }",
      fileName: "a.css",
      inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
      loadAsset,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.kind).toBe("external-url");
  });

  it("refuses an oversized asset with the measured size and the inline limit", async () => {
    const outcome = await rewriteCellCssReferences({
      css: 'a { x: url("./big.png") }',
      fileName: "a.css",
      inlineLimitBytes: 4,
      loadAsset: () => ({ fileName: "big.png", bytes: PIXEL_BYTES }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.kind).toBe("oversized-asset");
    expect(outcome.violations[0]?.detail).toContain(`${PIXEL_BYTES.length} bytes`);
    expect(outcome.violations[0]?.detail).toContain("extension");
  });

  it("refuses an unsupported asset type with an extension/replace direction", async () => {
    const outcome = await rewriteCellCssReferences({
      css: 'a { x: url("./movie.mp4") }',
      fileName: "a.css",
      inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
      loadAsset: () => ({ fileName: "movie.mp4", bytes: PIXEL_BYTES }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.kind).toBe("unsupported-asset");
    expect(outcome.violations[0]?.detail).toContain("replace");
  });

  it("refuses a missing file rather than emitting a broken reference", async () => {
    const outcome = await rewriteCellCssReferences({
      css: 'a { x: url("./missing.png") }',
      fileName: "a.css",
      inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
      loadAsset: () => undefined,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.kind).toBe("missing-asset");
  });

  it("returns the stylesheet unchanged when anything is refused", async () => {
    // No partial success: an artifact that inlined half a sheet is the "fake-usable" output the
    // issue forbids, so the failure shape must not carry a usable body.
    const outcome = await rewriteCellCssReferences({
      css: 'a { x: url("./pixel.png") } b { y: url("https://x.example/y.png") }',
      fileName: "a.css",
      inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
      loadAsset,
    });
    expect(outcome.ok).toBe(false);
    expect("css" in outcome).toBe(false);
  });
});

describe("UTF-16 offsets stay aligned when a stylesheet has astral characters", () => {
  it("masks a comment without shifting later references", () => {
    // A naive code-point split would shift every index after the emoji by one and leave the
    // comment's `url(` unmasked, which is the kind of bug only a stylesheet with real non-BMP text
    // would reveal.
    const css = "/* 公司 🏢 url(ghost.png) */\n.x { background: url(real.png); }";
    expect(findCellCssUrlReferences(css).map(reference => reference.url)).toEqual(["real.png"]);
    expect(findCellCssUnsupportedConstructs(css)).toEqual([]);
  });

  it("rewrites the real reference without touching the comment", async () => {
    const outcome = await rewriteCellCssReferences({
      css: "/* 🏢 url(ghost.png) */ .x { background: url(real.png); }",
      fileName: "a.css",
      inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
      loadAsset: url => (url === "real.png" ? { fileName: "real.png", bytes: PIXEL_BYTES } : undefined),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.css).toContain("url(ghost.png)");
    expect(outcome.css).toContain("data:image/png;base64,");
  });
});

describe("an @import is found wherever it is written", () => {
  it("finds one that follows a comment or sits at the top of the file", () => {
    expect(findCellCssUnsupportedConstructs('/* banner */\n@import "x.css";').map(c => c.kind)).toEqual([
      "css-import",
    ]);
    expect(findCellCssUnsupportedConstructs('@import url("x.css");').map(c => c.kind)).toEqual(["css-import"]);
    expect(findCellCssUnsupportedConstructs(".a { grid: 1; } @import 'y.css';").map(c => c.kind)).toEqual([
      "css-import",
    ]);
  });

  it("does not read an @important-looking name as the at-rule", () => {
    expect(findCellCssUnsupportedConstructs("a { color: red !important; }")).toEqual([]);
  });
});

describe("one classification for dev and compiler (#153)", () => {
  /** A probe over a fixed set of regular files, so the classification is exercised without a disk. */
  const probe = (files: Readonly<Record<string, number>>, directories: readonly string[] = []) => ({
    isRegularFile: (filePath: string) => filePath in files,
    exists: (filePath: string) => filePath in files || directories.includes(filePath),
    byteLength: (filePath: string) => files[filePath],
  });

  const classify = (
    filePath: string,
    options: { query?: string; files?: Record<string, number>; directories?: readonly string[] } = {},
  ) =>
    classifyCellResource({
      subject: filePath,
      filePath,
      ...(options.query === undefined ? {} : { query: options.query }),
      inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
      probe: probe(options.files ?? { [filePath]: 8 }, options.directories),
    });

  it("accepts a plain stylesheet and a small supported asset", () => {
    expect(classify("/p/x.css")).toEqual({ kind: "css", filePath: "/p/x.css" });
    expect(classify("/p/x.png")).toEqual({
      kind: "asset",
      filePath: "/p/x.png",
      mediaType: "image/png",
      bytes: 8,
    });
  });

  it("answers `not-a-resource` for what neither path owns", () => {
    expect(classify("/p/App.tsx")).toEqual({ kind: "not-a-resource" });
    expect(classify("/p/data.json")).toEqual({ kind: "not-a-resource" });
  });

  it("refuses any authored query on a resource, not only the Vite transform parameters", () => {
    const refusal = classify("/p/x.css", { query: "foo" });
    expect(refusal.kind).toBe("refuse");
    if (refusal.kind !== "refuse") return;
    expect(refusal.refusal.code).toBe("resource-query");
    expect(refusal.refusal.detail).toContain('"?foo"');
  });

  it("refuses a Vite transform parameter on a file that is not a resource at all", () => {
    // `worker.js?worker` names no resource extension and is still refused, which is why this check
    // runs before the `not-a-resource` answer.
    const refusal = classify("/p/worker.js", { query: "worker" });
    expect(refusal.kind).toBe("refuse");
    if (refusal.kind !== "refuse") return;
    expect(refusal.refusal.code).toBe("resource-query");
    expect(refusal.refusal.detail).toContain("?worker");
  });

  it("refuses a directory and a missing file by the regular-file answer, with different codes", () => {
    // The path exists but is not a file, so `missing-resource-file` would misdescribe it: what a
    // caller has to fix differs, even though the sentence a reader sees does not.
    const directory = classify("/p/directory.css", { files: {}, directories: ["/p/directory.css"] });
    expect(directory.kind).toBe("refuse");
    if (directory.kind !== "refuse") return;
    expect(directory.refusal.code).toBe("not-a-regular-file");
    expect(directory.refusal.detail).toContain("does not resolve to a regular file");

    const missing = classify("/p/missing.css", { files: {} });
    expect(missing.kind).toBe("refuse");
    if (missing.kind !== "refuse") return;
    expect(missing.refusal.code).toBe("missing-resource-file");
    expect(missing.refusal.detail).toContain("does not resolve to a regular file");
  });

  it("refuses an oversized asset by the size the probe reported", () => {
    const refusal = classify("/p/big.png", { files: { "/p/big.png": CELL_ASSET_INLINE_LIMIT_BYTES + 1 } });
    expect(refusal.kind).toBe("refuse");
    if (refusal.kind !== "refuse") return;
    expect(refusal.refusal.code).toBe("oversized-asset");
    expect(refusal.refusal.detail).toContain(`${CELL_ASSET_INLINE_LIMIT_BYTES + 1} bytes`);
    expect(refusal.refusal.detail).toContain(`limit is ${CELL_ASSET_INLINE_LIMIT_BYTES}`);
  });

  it("names the importer in the same sentence the compiler's diagnostic carries", () => {
    const refusal = classifyCellResource({
      subject: "/p/x.module.css",
      filePath: "/p/x.module.css",
      importer: "/p/App.tsx",
      inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
      probe: probe({ "/p/x.module.css": 8 }),
    });
    expect(refusal.kind).toBe("refuse");
    if (refusal.kind !== "refuse") return;
    expect(refusal.refusal.importer).toBe("/p/App.tsx");
    expect(refusal.refusal.detail).toContain('(imported from "/p/App.tsx")');
  });
});
