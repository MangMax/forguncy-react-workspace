/**
 * The compiler half of #98: CSS and small static assets become inline artifact code, or the
 * compile is refused with a structured diagnostic.
 *
 * Decision source: GitHub Issue #98 — "基础资源：让 CSS 与小型静态资源在本地和单文件 Cell 中一致工作"
 * (https://github.com/MangMax/forguncy-react-workspace/issues/98), under #81 and downstream of
 * #6 (https://github.com/MangX/forguncy-react-workspace/issues/6).
 *
 * ## What this module adds to the bundler, and why it is not a bundler
 *
 * Rolldown 1.3.3 can emit CSS and assets, but "emit" is precisely what a Cell cannot accept: a
 * ReactCellType cell is one script, and `auditEmittedAssets` refuses every sibling file. Vite's
 * answer to the same problem is `?inline` plus a stylesheet plugin, and neither is reachable from
 * this package: the compiler may not become a second resolver (#6), and a Vite plugin instance is
 * not available to the Rolldown port. So the port answers the resource import itself, at the two
 * hooks where it already owns resolution:
 *
 * - **Stylesheets** load as a module whose only statement is a call to the artifact-scope style
 *   installer. The CSS text is JSON-encoded into that call, so the transform's output is plain
 *   JavaScript and no CSS parser has to survive into the artifact.
 * - **Static assets** load as a module exporting one `data:` URI string.
 *
 * The policy — which files are supported, how big an inline asset may be, what a CSS `url(…)` may
 * reference — is `core`'s (`cell-assets.ts`) rather than this file's. That is not tidiness: the
 * dev harness has to refuse the same inputs, and two packages answering "is this supported"
 * separately is how a local render becomes an artifact that will not compile.
 *
 * ## The lifecycle the installed runtime provides
 *
 * The generated installer is reference-counted and keyed, because the four situations the issue
 * names all arrive through the same door:
 *
 * | situation | what the installer does |
 * | --- | --- |
 * | two Cells on one page | each Cell keys by its own style id, so neither sees the other's tag |
 * | one Cell mounted twice | the second mount increments the first tag's reference count rather than appending a second `<style>` |
 * | unmount | the count decrements; the tag is removed only at zero |
 * | re-evaluation (HMR / recompile) | the existing tag is reused, so styles never grow without bound |
 *
 * The runtime lives in the artifact's own scope, so an unmount of one instance cannot reach
 * another Cell's counter: the closure is per compiled script, and the DOM tag is the only shared
 * state. That is the smallest mechanism that satisfies the criteria without a page-global registry
 * the Cell is not allowed to install.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  CELL_ASSET_INLINE_LIMIT_BYTES,
  cellUnsupportedAssetRefusal,
  classifyCellResource,
  effectiveCellResourceQuery,
  formatCellAssetDataUri,
  formatCellCssRefusalDetail,
  formatCellResourceSupportMatrix,
  isCellResourcePath,
  rewriteCellCssReferences,
  splitCellSpecifierQuery,
} from "@forguncy-react-workspace/core";
import type { CellCssViolation, CellResourceFileProbe, CellResourceRefusal } from "@forguncy-react-workspace/core";

import type { CellArtifactDiagnostic } from "./diagnostics.ts";
import { createCellArtifactDiagnostic } from "./diagnostics.ts";

/**
 * The virtual id prefix a stylesheet or asset module loads under.
 *
 * `\0`-prefixed for the same reason the other generated modules are: it is the convention that
 * distinguishes "a module we composed" from "a module that exists", so no code that filters on
 * ``isGeneratedModuleId`` (the runtime binding's own import, #82) has to learn a second rule.
 *
 * The original file id is appended after the query, which makes the id stable across two builds
 * of one project — a requirement the deterministic-artifact guarantee imposes on everything that
 * can reach the output.
 */
const CELL_RESOURCE_MODULE_PREFIX = "\0forguncy-cell-resource:";

/** The style id a stylesheet module installs under. Derived from the CSS text, never from its order. */
export function cellStyleIdOf(css: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < css.length; index += 1) {
    hash ^= css.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // The length is part of the id so two different stylesheets that collide in 32 bits cannot
  // silently share a `<style>` element: they would have to collide in both hash and length.
  return `forguncy-cell-style-${hash.toString(36)}-${css.length.toString(36)}`;
}

/** The virtual module id one resource loads under. */
export function cellResourceModuleIdOf(fileId: string): string {
  return `${CELL_RESOURCE_MODULE_PREFIX}${fileId}`;
}

/** The file id embedded in a resource module id, or `undefined` when the id is not one. */
export function cellResourceFileIdOf(moduleId: string): string | undefined {
  return moduleId.startsWith(CELL_RESOURCE_MODULE_PREFIX) ? moduleId.slice(CELL_RESOURCE_MODULE_PREFIX.length) : undefined;
}

/** A virtual resource module id put back to the file id the resource reader takes. */
function fileIdOfResourceModule(moduleId: string): string {
  const fileId = cellResourceFileIdOf(moduleId);
  return fileId === undefined ? moduleId : fileId;
}

/** What one resource import contributed, for the report and the issue's byte ledger. */
export interface CellInlinedStyle {
  readonly kind: "style";
  /** The stylesheet's own id, as resolved (an absolute path). */
  readonly fileId: string;
  /** The key the installer tags the `<style>` element with. */
  readonly styleId: string;
  /** Characters of the stylesheet as authored, after its `url(...)` references were rewritten. */
  readonly cssCharacters: number;
  /** Every asset a `url(…)` in this stylesheet inlined. */
  readonly assetBytes: number;
  /** Characters the inlined `data:` URIs contributed. */
  readonly dataUriCharacters: number;
  /** Characters the generated module contributed to the artifact. */
  readonly renderedCharacters: number;
}

export interface CellInlinedAsset {
  readonly kind: "asset";
  readonly fileId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: number;
  /** The exact `data:` URI the asset module exports, so the audit can find it in the artifact. */
  readonly dataUri: string;
  /** Characters the `data:` URI contributed. */
  readonly dataUriCharacters: number;
  /** Characters the generated module contributed to the artifact. */
  readonly renderedCharacters: number;
}

export type CellInlinedResource = CellInlinedStyle | CellInlinedAsset;

/**
 * A resource the compiler refuses, in the compiler's own terms.
 *
 * The classification — reason code, subject, importer and the one explanation — is `core`'s
 * (#153): the dev harness throws the same refusal, so the two paths cannot disagree about which
 * imports are legal or about the sentence that explains why one is not. This module adds only
 * what the compiler's report needs on top of it.
 */
export type { CellResourceRefusal } from "@forguncy-react-workspace/core";

export type CellResourceResolution =
  | {
      readonly ok: true;
      readonly moduleId: string;
      readonly source: string;
      readonly resource: CellInlinedResource;
    }
  | { readonly ok: false; readonly refusal: CellResourceRefusal };

/** The diagnostic a refusal becomes: one code, the subject and the required direction. */
export function createCellResourceDiagnostic(refusal: CellResourceRefusal): CellArtifactDiagnostic {
  return createCellArtifactDiagnostic("rejected-cell-asset", refusal.subject, {
    detail: refusal.detail,
    ...(refusal.importer === undefined ? {} : { location: `imported from ${refusal.importer}` }),
  });
}

/**
 * A fatal resource policy refusal travelling through the bundler.
 *
 * Thrown from a Rolldown hook, caught by the port, and reduced to its diagnostics by
 * `compileCell` rather than being flattened into an opaque `bundler-failure`. The distinction is
 * the point: "this asset is outside v1 and here is the direction" is actionable, while "the
 * bundler failed" is the string #6's error model exists to replace.
 */
export class CellResourcePolicyError extends Error {
  readonly diagnostics: readonly CellArtifactDiagnostic[];

  constructor(refusals: readonly CellResourceRefusal[]) {
    const diagnostics = refusals.map(createCellResourceDiagnostic);
    super(diagnostics.map(diagnostic => diagnostic.message).join("\n"));
    this.name = "CellResourcePolicyError";
    this.diagnostics = diagnostics;
  }
}

/** Whether an escaping error is this compiler's structured resource refusal. */
export function isCellResourcePolicyError(error: unknown): error is CellResourcePolicyError {
  return error instanceof CellResourcePolicyError;
}

/**
 * Whether a resolved module id is a resource this module owns rather than JavaScript.
 *
 * Queries are part of the question: `./x.svg?url` is a Vite feature v1 refuses, so it must not be
 * admitted here by looking only at the extension.
 */
export function isCellResourceFile(fileId: string): boolean {
  const { path: filePath } = splitCellSpecifierQuery(fileId);
  // The predicate itself is `core`'s, so the bundler port's early "is this worth resolving"
  // question and the classification's "is this mine" question are one list rather than two.
  return isCellResourcePath(filePath);
}

/**
 * The stylesheet module source: one call into the artifact-scope installer.
 *
 * `JSON.stringify` rather than a template literal, because a stylesheet contains backticks,
 * `${`, quotes and newlines, and every one of them would be an injection site in a template.
 * JSON is also what makes the CSS text byte-identical to what the agent or the review diff sees.
 */
function renderCellStyleModule(styleId: string, css: string): string {
  return `__forguncyCellStyleInstall(${JSON.stringify(styleId)}, ${JSON.stringify(css)});\n`;
}

/**
 * The artifact-scope style installer, emitted once per artifact that has any style.
 *
 * ## Why `globalThis` rather than a module-scope function
 *
 * The stylesheet modules and the installer would otherwise live in the same bundle, and a bundle
 * local function would be the obvious choice. It is the wrong one for the two-Cell page: each Cell
 * is a *separate* script with its own bundle scope, so two Cells' styles would install into two
 * unrelated registries and an unmount could not be reference-counted against the other. The page
 * document is the one object both scripts share, so the registry lives on it — keyed, and with
 * the counter stored in the same property so no Cell installs a page-global *name* that another
 * Cell's user scope could collide with.
 *
 * ## The lifetime rule
 *
 * `install` returns the reference count. A module evaluation happens exactly once per script
 * evaluation, so "styles are needed" and "the script was evaluated" are the same fact, and that is
 * the count that matters: unmounting one React tree cannot be observed by a bundled stylesheet
 * module, but a re-evaluation (HMR, a recompiled artifact) must not append a second copy. So the
 * installer is idempotent per `styleId`, and the count is exposed on `globalThis` for the page
 * consumer that owns the real unmount lifecycle (the runtime gate, #25) rather than guessed at
 * here.
 *
 * What that buys, precisely, and what it does not: two Cells never share a style id, so one
 * Cell's unmount cannot delete another's tag; one Cell evaluated twice reuses its tag, so a
 * remount does not grow the DOM. It is deliberately *not* keyed by React instance because a
 * bundled stylesheet has no React instance to key by — the tag belongs to the artifact, and the
 * artifact is one script.
 */
export const CELL_STYLE_INSTALLER_SOURCE = `var __forguncyCellStyleRegistry = (function () {
  var root = typeof globalThis === "object" ? globalThis : undefined;
  if (!root) return null;
  var existing = root.__forguncyCellStyleRegistry;
  if (existing && typeof existing === "object") return existing;
  var registry = { styles: Object.create(null), install: function (styleId, css) {
    var record = registry.styles[styleId];
    if (record) {
      record.references += 1;
      if (record.element && record.element.textContent !== css) record.element.textContent = css;
      return record.references;
    }
    var documentObject = root.document;
    if (!documentObject || !documentObject.createElement) return 0;
    var element = documentObject.querySelector
      ? documentObject.querySelector("style[data-forguncy-cell-style='" + styleId + "']")
      : null;
    if (!element) {
      element = documentObject.createElement("style");
      element.setAttribute("data-forguncy-cell-style", styleId);
      (documentObject.head || documentObject.documentElement).appendChild(element);
    }
    if (element.textContent !== css) element.textContent = css;
    registry.styles[styleId] = { element: element, references: 1 };
    return 1;
  }, release: function (styleId) {
    var record = registry.styles[styleId];
    if (!record) return 0;
    record.references -= 1;
    if (record.references > 0) return record.references;
    if (record.element && record.element.parentNode) record.element.parentNode.removeChild(record.element);
    delete registry.styles[styleId];
    return 0;
  } };
  try {
    root.__forguncyCellStyleRegistry = registry;
  } catch (error) {
    return registry;
  }
  return registry;
})();
function __forguncyCellStyleInstall(styleId, css) {
  if (!__forguncyCellStyleRegistry) {
    throw new Error("Forguncy Cell style installer is unavailable: the artifact was evaluated without its generated style registry.");
  }
  return __forguncyCellStyleRegistry.install(styleId, css);
}
`;

/**
 * The installer emitted once per artifact that contains any stylesheet.
 *
 * The artifact-scope `var`/`function` declarations are visible to the bundled modules inside the
 * IIFE, so a stylesheet module calls `__forguncyCellStyleInstall` by lexical name rather than
 * reaching through `globalThis`. Only the *registry* is page-global, because two Cells are two
 * scripts and the shared `<style>` tags are the one thing they must agree on.
 */
export function renderCellStyleInstaller(): string {
  return CELL_STYLE_INSTALLER_SOURCE;
}

export interface CellResourceReader {
  /** The module the import was written in, for a refusal that can name it. */
  readonly importer: string | undefined;
  /** The absolute path the resolver produced. */
  readonly fileId: string;
  readonly inlineLimitBytes: number;
  /**
   * Generate the module source, or only classify the resource.
   *
   * The pre-bundle pass needs the classification (a refusal must stop the compile before any
   * code is generated) but no source, because `scan` renders nothing and a source it never loads
   * would be dead weight — and, worse, one more place for the two passes to disagree about what
   * the module text is. Defaults to `true` so the build path states nothing.
   */
  readonly emitSource?: boolean;
}

/** The refusal a resource carries, when it is refused; shared by both passes' error handling. */
export function cellResourceRefusalOf(resolution: CellResourceResolution): CellResourceRefusal | undefined {
  return resolution.ok ? undefined : resolution.refusal;
}

/**
 * Reads and compiles one resource, or refuses it.
 *
 * Every refusal names the direction the issue requires: `extension` when the asset must be served
 * or shared, `replace` when a smaller browser-first asset would do. A refusal that only said
 * "unsupported" would be the opaque build string #6's error model exists to remove.
 */
export async function resolveCellResource(input: CellResourceReader): Promise<CellResourceResolution> {
  const fileId = fileIdOfResourceModule(input.fileId);
  const { path: filePath, query: rawQuery } = splitCellSpecifierQuery(fileId);
  // Vite's own marks (`?import`, `?t=`, `?direct`) never reach the compiled path, but an authored
  // `?import` should mean the same thing here as it does locally. An authored resource query does
  // not, so this is the one place the distinction is applied for the compiler.
  const query = effectiveCellResourceQuery(rawQuery);
  const classification = classifyCellResource({
    subject: fileId,
    filePath,
    ...(query === undefined ? {} : { query }),
    ...(input.importer === undefined ? {} : { importer: input.importer }),
    inlineLimitBytes: input.inlineLimitBytes,
    probe: CELL_RESOURCE_FILE_PROBE,
  });

  if (classification.kind === "refuse") {
    return { ok: false, refusal: classification.refusal };
  }

  const importerNote = input.importer === undefined ? "" : ` (imported from "${input.importer}")`;
  if (classification.kind === "css") {
    return readCellStyle(fileId, filePath, importerNote, input.inlineLimitBytes, input.emitSource !== false);
  }
  if (classification.kind === "not-a-resource") {
    // The bundler asks only about a file `isCellResourceFile` admitted, so reaching here means the
    // id and the resolved file disagree about the extension. A refusal still names the file, which
    // is more useful than an assertion, and it is the same sentence the classification uses.
    return { ok: false, refusal: cellUnsupportedAssetRefusal(fileId, filePath, input.importer) };
  }

  return readCellStaticAsset(fileId, filePath, classification.mediaType, importerNote, input.emitSource !== false);
}

/** The compiler's filesystem answers to the shared classification's two questions. */
const CELL_RESOURCE_FILE_PROBE: CellResourceFileProbe = {
  isRegularFile,
  byteLength: filePath => {
    try {
      return statSync(filePath).size;
    } catch {
      return undefined;
    }
  },
};

async function readCellStyle(
  fileId: string,
  filePath: string,
  importerNote: string,
  inlineLimitBytes: number,
  emitSource: boolean,
): Promise<CellResourceResolution> {
  const css = readFileSync(filePath, "utf8");
  const rewritten = await rewriteCellCssReferences({
    css,
    fileName: filePath,
    inlineLimitBytes,
    loadAsset: url => readCssReferencedAsset(filePath, url),
  });

  if (!rewritten.ok) {
    return {
      ok: false,
      refusal: {
        code: "css-reference",
        subject: fileId,
        detail: cssViolationDetail(fileId, importerNote, rewritten.violations),
      },
    };
  }

  const styleId = cellStyleIdOf(rewritten.css);
  const source = emitSource ? renderCellStyleModule(styleId, rewritten.css) : "";
  return {
    ok: true,
    moduleId: cellResourceModuleIdOf(filePath),
    source,
    resource: {
      kind: "style",
      fileId: filePath,
      styleId,
      cssCharacters: rewritten.css.length,
      assetBytes: rewritten.assets.reduce((total, asset) => total + asset.bytes, 0),
      dataUriCharacters: rewritten.assets.reduce((total, asset) => total + asset.dataUriCharacters, 0),
      renderedCharacters: source.length,
    },
  };
}

function readCellStaticAsset(
  fileId: string,
  filePath: string,
  mediaType: string,
  importerNote: string,
  emitSource: boolean,
): CellResourceResolution {
  const bytes = readFileSync(filePath);
  const dataUri = formatCellAssetDataUri(mediaType, bytes);
  const source = emitSource ? `export default ${JSON.stringify(dataUri)};\n` : "";
  return {
    ok: true,
    moduleId: cellResourceModuleIdOf(filePath),
    source,
    resource: {
      kind: "asset",
      fileId: filePath,
      fileName: path.basename(filePath),
      mediaType,
      bytes: bytes.length,
      dataUri,
      dataUriCharacters: dataUri.length,
      renderedCharacters: source.length,
    },
  };
}

/** Resolves one `url(…)` from a stylesheet against that stylesheet's own directory. */
function readCssReferencedAsset(stylesheetPath: string, url: string): { fileName: string; bytes: Uint8Array } | undefined {
  if (url.startsWith("node:")) {
    return undefined;
  }
  const candidate = path.resolve(path.dirname(stylesheetPath), url);
  if (!isRegularFile(candidate)) {
    return undefined;
  }
  return { fileName: candidate, bytes: readFileSync(candidate) };
}

function cssViolationDetail(fileName: string, importerNote: string, violations: readonly CellCssViolation[]): string {
  // The composition is `core`'s (#153), because the dev server shows the same sentence after the
  // same violations: `rewriteCellCssReferences` already produces the violation text for both.
  return formatCellCssRefusalDetail(fileName, violations, importerNote);
}

function isRegularFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The v1 support matrix, for a CLI report or a PR body. Re-exported so the compiler's callers do not need `core`. */
export { CELL_ASSET_INLINE_LIMIT_BYTES, formatCellResourceSupportMatrix };

/** Whether the artifact needs the installer: any resolved style at all. */
export function cellResourcesNeedStyleInstaller(resources: readonly CellInlinedResource[]): boolean {
  return resources.some(resource => resource.kind === "style");
}

/** The byte ledger the issue asks for: asset bytes in, inline characters out. */
export interface CellResourceBudget {
  readonly styleCharacters: number;
  readonly dataUriCharacters: number;
  readonly assetBytes: number;
  readonly renderedCharacters: number;
}

export function cellResourceBudgetOf(resources: readonly CellInlinedResource[]): CellResourceBudget {
  return resources.reduce<CellResourceBudget>(
    (budget, resource) => ({
      styleCharacters: budget.styleCharacters + (resource.kind === "style" ? resource.cssCharacters : 0),
      dataUriCharacters: budget.dataUriCharacters + resource.dataUriCharacters,
      assetBytes: budget.assetBytes + (resource.kind === "style" ? resource.assetBytes : resource.bytes),
      renderedCharacters: budget.renderedCharacters + resource.renderedCharacters,
    }),
    { styleCharacters: 0, dataUriCharacters: 0, assetBytes: 0, renderedCharacters: 0 },
  );
}

/** One line per resource, for the compile report. */
export function formatCellResourceLedger(resources: readonly CellInlinedResource[]): string {
  if (resources.length === 0) {
    return "Inlined Cell resources: none.";
  }
  const lines = resources.map(resource =>
    resource.kind === "style"
      ? `style ${resource.styleId}: ${resource.cssCharacters} CSS characters, ${resource.assetBytes} asset bytes inlined as ${resource.dataUriCharacters} data-URI characters, ${resource.renderedCharacters} rendered`
      : `asset ${resource.fileName}: ${resource.bytes} bytes as ${resource.dataUriCharacters} data-URI characters, ${resource.renderedCharacters} rendered`,
  );
  const budget = cellResourceBudgetOf(resources);
  lines.push(
    `Total: ${budget.assetBytes} asset bytes -> ${budget.dataUriCharacters} data-URI characters + ${budget.styleCharacters} CSS characters = ${budget.renderedCharacters} rendered characters.`,
  );
  return lines.join("\n");
}
