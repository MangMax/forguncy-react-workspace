/**
 * The v1 Cell resource policy: which styles and static assets a Cell may use, and how they
 * become part of one self-contained script.
 *
 * Decision source: GitHub Issue #98 — "基础资源：让 CSS 与小型静态资源在本地和单文件 Cell 中一致工作"
 * (https://github.com/MangMax/forguncy-react-workspace/issues/98), under #81 and downstream of
 * #6 (https://github.com/MangX/forguncy-react-workspace/issues/91).
 *
 * ## Why this lives in `core`
 *
 * Two consumers have to agree byte-for-byte about the answer: the compiler's Rolldown port turns
 * a CSS/asset import into inline artifact code, and the dev harness has to reject the same
 * inputs so local development cannot hand back a green render the compiler will refuse. A rule
 * stated in both packages is two rules, and the first time they disagree the disagreement is a
 * local render that never compiles — the failure mode this repository keeps designing against.
 * `core` is the only package both may depend on, and this module is deliberately *pure*: no
 * `node:` import, so it is also part of the `core/browser` projection and can be read from a
 * browser graph without dragging a filesystem in.
 *
 * ## The explicit v1 support set
 *
 * The support set is a closed list, and the closure is the contract. Anything outside it fails
 * with a structured diagnostic instead of producing an artifact that works locally and breaks on
 * a Forguncy page:
 *
 * | resource | v1 decision | why |
 * | --- | --- | --- |
 * | plain `.css` imported from JS | supported | injected once per style id into a keyed `<style>` tag |
 * | `url(...)` in plain CSS, relative image/font | supported when the file is at or below {@link CELL_ASSET_INLINE_LIMIT_BYTES} | rewritten to a `data:` URI |
 * | default import of a small static asset | supported | the module's default export is a `data:` URI |
 * | CSS Modules (`*.module.css`) | **rejected** | scoped class names would need a second, compiler-owned CSS-module implementation to match Vite's output; v1 refuses rather than shipping two different answers |
 * | `@import` in CSS | rejected | inlining a cascade of media/layer rules is a stylesheet resolver, not an asset inliner |
 * | remote (`http:`, `https:`, `//`) and root-absolute (`/…`) URLs | rejected | the Cell must make no covert CDN request and cannot load a page-relative file it does not own |
 * | Vite query imports (`?raw`, `?url`, `?inline`, `?worker`) | rejected | each selects a different Vite transform the single-file compiler does not implement |
 * | Workers / `.wasm` / other binary assets | rejected | not part of v1; see the refusal's `extension` / `replace` direction |
 * | assets above {@link CELL_ASSET_INLINE_LIMIT_BYTES} | rejected | base64 would grow the Cell past a useful budget and the sibling file cannot be deployed |
 *
 * ## Selector scope, stated rather than implied
 *
 * Plain CSS is **global by design**, exactly as it is under Vite, and v1 adds no automatic
 * scoping. A Cell that writes `.card { … }` can therefore affect the page around it, so authored
 * CSS should prefix its selectors with a Cell-owned root class. CSS Modules are the alternative
 * that would need scoping, and they are rejected above; leaving that choice implicit would be the
 * one outcome the issue forbids.
 *
 * ## What this module is not
 *
 * It does not read files, resolve specifiers, or know what a bundler is. Those remain the
 * compiler's and the dev server's jobs; this module answers only the questions both must answer
 * the same way.
 */

/** The largest asset v1 inlines, in bytes, matching Vite's default `assetsInlineLimit`. */
export const CELL_ASSET_INLINE_LIMIT_BYTES = 4096;

/**
 * Static asset extensions the default import of which yields a `data:` URI.
 *
 * Deliberately a closed list. An extension outside it is not silently passed to the host
 * bundler, because on the compiled path that would mean either an emitted sibling file or an
 * opaque parse failure instead of the structured refusal the issue requires.
 */
export const CELL_SUPPORTED_STATIC_ASSET_EXTENSIONS = [
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
] as const;

export type CellSupportedStaticAssetExtension = (typeof CELL_SUPPORTED_STATIC_ASSET_EXTENSIONS)[number];

const STATIC_ASSET_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
};

/**
 * Extensions that are *explicitly* outside v1 rather than merely unknown.
 *
 * `wasm` and `node` are the two the issue names; the rest are common binary assets a Cell might
 * try to import and that would otherwise reach a bundler with no structured answer. Listing them
 * buys a diagnostic that says "this is a v1 boundary", not a parse error.
 */
export const CELL_REJECTED_BINARY_ASSET_EXTENSIONS = [
  ".wasm",
  ".node",
  ".pdf",
  ".zip",
  ".gz",
  ".mp3",
  ".wav",
  ".mp4",
  ".webm",
  ".glb",
  ".gltf",
] as const;

/** Preprocessor stylesheets v1 does not compile. */
export const CELL_STYLE_PREPROCESSOR_EXTENSIONS = [".scss", ".sass", ".less", ".styl", ".stylus"] as const;

/**
 * The extension Vite query suffixes v1 refuses on a style or asset import.
 *
 * Matched as whole query parameters so `?worker&inline` is caught by `worker` and `?url=` by
 * `url`; a query such as `?v=1` is not on this list and is refused separately by
 * {@link isCellResourceQuery}, which rejects *any* query on a resource import rather than
 * pretending an unknown one is harmless.
 */
export const CELL_REJECTED_RESOURCE_QUERIES = ["raw", "url", "inline", "worker", "sharedworker"] as const;

/** The extension of a file name, lower-cased, with any query or fragment removed. */
export function cellAssetExtensionOf(fileName: string): string {
  const withoutQuery = fileName.split("?")[0]?.split("#")[0] ?? "";
  const match = /\.[^./\\]+$/.exec(withoutQuery);
  return match === null ? "" : match[0].toLowerCase();
}

/** Whether the file is a plain CSS stylesheet (not a module, not a preprocessor). */
export function isCellCssFile(fileName: string): boolean {
  return cellAssetExtensionOf(fileName) === ".css";
}

/**
 * Whether the file is a CSS Module.
 *
 * Checked on the whole name rather than the extension, because `.module.css` shares `.css` with
 * the supported case; the distinction the issue asks to be explicit is exactly this one.
 */
export function isCellCssModuleFile(fileName: string): boolean {
  return /\.module\.css$/i.test(fileName.split("?")[0] ?? "");
}

/** Whether the file is a preprocessor stylesheet v1 does not compile. */
export function isCellStylePreprocessorFile(fileName: string): boolean {
  return (CELL_STYLE_PREPROCESSOR_EXTENSIONS as readonly string[]).includes(cellAssetExtensionOf(fileName));
}

/** Whether the extension is one whose default import v1 turns into a `data:` URI. */
export function isSupportedCellStaticAsset(fileName: string): boolean {
  return (CELL_SUPPORTED_STATIC_ASSET_EXTENSIONS as readonly string[]).includes(cellAssetExtensionOf(fileName));
}

/** The media type v1 uses for a supported static asset, or `undefined` when it is not supported. */
export function cellStaticAssetMediaType(fileName: string): string | undefined {
  return STATIC_ASSET_MEDIA_TYPES[cellAssetExtensionOf(fileName)];
}

/** Whether the extension is explicitly refused rather than merely unknown. */
export function isRejectedCellBinaryAsset(fileName: string): boolean {
  return (CELL_REJECTED_BINARY_ASSET_EXTENSIONS as readonly string[]).includes(cellAssetExtensionOf(fileName));
}

/** A specifier split into its path and its Vite-style query, with `?` removed from the query. */
export interface CellSpecifierQuery {
  readonly path: string;
  /** `undefined` when the specifier has no query. */
  readonly query?: string;
}

/** Splits `./a.png?url` into `{ path: "./a.png", query: "url" }`. */
export function splitCellSpecifierQuery(specifier: string): CellSpecifierQuery {
  const queryStart = specifier.indexOf("?");
  if (queryStart === -1) {
    return { path: specifier };
  }
  return { path: specifier.slice(0, queryStart), query: specifier.slice(queryStart + 1) };
}

/**
 * Whether a resource import carries any query at all.
 *
 * Any query is a refusal, not only the ones on {@link CELL_REJECTED_RESOURCE_QUERIES}: an
 * unknown query is a Vite feature this compiler has not been taught, and assuming it can be
 * ignored is how a local pass becomes an artifact that is subtly different.
 */
export function hasCellResourceQuery(specifier: string): boolean {
  return specifier.includes("?");
}

/**
 * Whether a query is Vite's own bookkeeping rather than an authored resource query.
 *
 * Vite appends `?import` to a URL import it has already decided is a module, and `?t=`/`?direct`/
 * `?used` to modules it re-requests for HMR or asks for their raw text. None of those is a feature
 * the author asked for, and the compiled path never sees them, so both consumers treat them as
 * "no query". Matched per parameter and exactly, so an authored `?import=1` or `?timestamp` is not
 * this marker.
 */
export function isInternalCellResourceQuery(query: string | undefined): boolean {
  if (query === undefined) return false;
  const internal = ["import", "t", "direct", "used"];
  return query
    .split("&")
    .every(part => internal.includes((part.split("=")[0] ?? "").toLowerCase()));
}

/** The query a resource policy should act on: `undefined` when there is none or it is internal. */
export function effectiveCellResourceQuery(query: string | undefined): string | undefined {
  return isInternalCellResourceQuery(query) ? undefined : query;
}

/** One row of the explicit v1 support matrix. */
export interface CellResourceSupportRow {
  readonly id: string;
  readonly pattern: string;
  readonly decision: "supported" | "rejected";
  readonly note: string;
}

/**
 * The support matrix, as data.
 *
 * Exported rather than left to the docstring above because diagnostics, tests and the PR's
 * support table should print the same list. A matrix maintained in prose and a matrix maintained
 * in code are two matrices the first time one changes.
 */
export const CELL_RESOURCE_SUPPORT_MATRIX: readonly CellResourceSupportRow[] = [
  {
    id: "plain-css",
    pattern: "import \"…/x.css\"",
    decision: "supported",
    note: "Global CSS, injected once into a keyed <style data-forguncy-cell-style> element. Selectors are not scoped; prefix them with a Cell-owned root class.",
  },
  {
    id: "css-url-assets",
    pattern: "url(…) in plain CSS",
    decision: "supported",
    note: `Relative images and fonts at or below ${CELL_ASSET_INLINE_LIMIT_BYTES} bytes are rewritten to data: URIs.`,
  },
  {
    id: "static-asset-imports",
    pattern: `default import of ${CELL_SUPPORTED_STATIC_ASSET_EXTENSIONS.join(", ")}`,
    decision: "supported",
    note: `The default export is a data: URI; the file must be at or below ${CELL_ASSET_INLINE_LIMIT_BYTES} bytes.`,
  },
  {
    id: "css-modules",
    pattern: "*.module.css",
    decision: "rejected",
    note: "v1 explicitly rejects CSS Modules. Scoped class names would need a compiler-owned CSS-module implementation matching Vite's, and v1 refuses rather than shipping two answers.",
  },
  {
    id: "css-import",
    pattern: "@import in CSS",
    decision: "rejected",
    note: "A stylesheet import is a cascade resolver, not an asset inliner. Flatten the stylesheet instead.",
  },
  {
    id: "css-image-set",
    pattern: "image-set(…) in CSS",
    decision: "rejected",
    note: "image-set can name files without url(), so v1 refuses the whole function rather than missing a reference.",
  },
  {
    id: "external-urls",
    pattern: "http:, https:, //, /absolute",
    decision: "rejected",
    note: "No runtime network request and no page-relative file. Move the asset to a Forguncy frontend extension or inline a small replacement.",
  },
  {
    id: "resource-queries",
    pattern: "?raw, ?url, ?inline, ?worker",
    decision: "rejected",
    note: "Each query selects a Vite transform the single-file compiler does not implement.",
  },
  {
    id: "workers-wasm",
    pattern: "new Worker(…), *.wasm, other binary assets",
    decision: "rejected",
    note: "Outside v1. An asset that needs a Worker, WASM or a sibling binary belongs in a Forguncy frontend extension.",
  },
  {
    id: "oversized-assets",
    pattern: `asset > ${CELL_ASSET_INLINE_LIMIT_BYTES} bytes`,
    decision: "rejected",
    note: "Base64 inflation plus the character budget makes a large inline asset a deployment problem, and a sibling file cannot be deployed with the Cell.",
  },
];

/** The matrix as a printable block, for a diagnostic detail or a report. */
export function formatCellResourceSupportMatrix(): string {
  return CELL_RESOURCE_SUPPORT_MATRIX.map(
    row => `${row.decision === "supported" ? "supported" : "rejected"}  ${row.pattern} — ${row.note}`,
  ).join("\n");
}

/** Whether a specifier carries a Vite resource query v1 refuses, matched per parameter. */
export function queryHasRejectedResourceParameter(query: string): boolean {
  return query
    .split("&")
    .map(part => part.split("=")[0]?.toLowerCase() ?? "")
    .some(part => (CELL_REJECTED_RESOURCE_QUERIES as readonly string[]).includes(part));
}

// ---------------------------------------------------------------------------
// Static asset encoding
// ---------------------------------------------------------------------------

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64-encodes bytes without `Buffer`.
 *
 * `core` is part of the browser projection, so reaching for `Buffer` here would make the module
 * load only in Node. The loop is the predictable 3→4 mapping; AESNI-style tricks would save
 * microseconds on a 4 KiB asset and cost a second implementation to audit.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const chunk = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += BASE64_ALPHABET[(chunk >>> 18) & 0x3f];
    output += BASE64_ALPHABET[(chunk >>> 12) & 0x3f];
    output += second === undefined ? "=" : BASE64_ALPHABET[(chunk >>> 6) & 0x3f];
    output += third === undefined ? "=" : BASE64_ALPHABET[chunk & 0x3f];
  }
  return output;
}

/** The `data:` URI v1 inlines a supported asset as. */
export function formatCellAssetDataUri(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${encodeBase64(bytes)}`;
}

// ---------------------------------------------------------------------------
// CSS reference scanning and rewriting
// ---------------------------------------------------------------------------

/** One `url(…)` reference found in a stylesheet. */
export interface CellCssUrlReference {
  /** The URL as written, trimmed and without its quotes. */
  readonly url: string;
  /** Index of the first character of the URL in the stylesheet, after any quote. */
  readonly start: number;
  /** Index one past the last character of the URL. */
  readonly end: number;
  /** The quote character the URL was written with, or `""` for an unquoted URL. */
  readonly quote: '"' | "'" | "";
}

function isCssIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_-]/.test(character);
}

/**
 * Finds every `url(…)` reference outside comments and strings.
 *
 * A scanner rather than a regular expression because the grammar has three shapes a regex
 * flattens badly: a quoted URL may contain `)`, an unquoted one ends at the first unescaped `)`,
 * and a `url(x)` written inside a comment is a comment rather than a reference. The function is deliberately not a
 * full CSS parser — v1 handles declarations and `@font-face`, not nesting — but the tokens it
 * does look for are read with the same rules a parser would apply.
 */
export function findCellCssUrlReferences(css: string): readonly CellCssUrlReference[] {
  const references: CellCssUrlReference[] = [];
  let index = 0;

  while (index < css.length) {
    if (css[index] === "/" && css[index + 1] === "*") {
      const close = css.indexOf("*/", index + 2);
      index = close === -1 ? css.length : close + 2;
      continue;
    }

    const character = css[index];
    if (character === '"' || character === "'") {
      index = skipCssString(css, index);
      continue;
    }

    if (
      (character === "u" || character === "U") &&
      css.slice(index, index + 4).toLowerCase() === "url(" &&
      !isCssIdentifierCharacter(css[index - 1])
    ) {
      const parsed = parseCssUrl(css, index + 4);
      if (parsed !== undefined) {
        references.push(parsed.reference);
        index = parsed.next;
        continue;
      }
    }

    index += 1;
  }

  return references;
}

function skipCssString(css: string, start: number): number {
  const quote = css[start];
  let index = start + 1;
  while (index < css.length) {
    if (css[index] === "\\") {
      index += 2;
      continue;
    }
    if (css[index] === quote) {
      return index + 1;
    }
    index += 1;
  }
  return css.length;
}

function parseCssUrl(
  css: string,
  afterFunction: number,
): { readonly reference: CellCssUrlReference; readonly next: number } | undefined {
  let index = afterFunction;
  while (index < css.length && /\s/.test(css[index] ?? "")) {
    index += 1;
  }

  const quote = css[index];
  if (quote === '"' || quote === "'") {
    const start = index + 1;
    let cursor = start;
    while (cursor < css.length) {
      if (css[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (css[cursor] === quote) {
        break;
      }
      cursor += 1;
    }
    if (cursor >= css.length) {
      return undefined;
    }
    const url = css.slice(start, cursor);
    let close = cursor + 1;
    while (close < css.length && /\s/.test(css[close] ?? "")) {
      close += 1;
    }
    if (css[close] !== ")") {
      return undefined;
    }
    return { reference: { url: url.trim(), start, end: cursor, quote }, next: close + 1 };
  }

  const start = index;
  let cursor = index;
  while (cursor < css.length && css[cursor] !== ")") {
    if (css[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    cursor += 1;
  }
  if (cursor >= css.length) {
    return undefined;
  }
  const raw = css.slice(start, cursor);
  const trimmed = raw.trim();
  const leading = raw.length - raw.trimStart().length;
  const urlStart = start + leading;
  return {
    reference: { url: trimmed, start: urlStart, end: urlStart + trimmed.length, quote: "" },
    next: cursor + 1,
  };
}

/**
 * Returns a copy of the stylesheet with comments and string contents blanked out.
 *
 * Used only to detect at-rules, so positions must be preserved. Blanking rather than deleting is
 * what keeps an index into the masked copy an index into the original.
 */
function maskCellCssNonTokens(css: string): string {
  // `split("")` rather than `[...css]`: the latter splits by code point, while every index in
  // this module is a UTF-16 offset, so a single emoji in a stylesheet would shift every later
  // replacement by one and leave a comment's `url(...)` looking like a real reference.
  const characters = css.split("");
  let index = 0;
  while (index < css.length) {
    if (css[index] === "/" && css[index + 1] === "*") {
      const close = css.indexOf("*/", index + 2);
      const end = close === -1 ? css.length : close + 2;
      for (let cursor = index; cursor < end; cursor += 1) {
        characters[cursor] = " ";
      }
      index = end;
      continue;
    }
    if (css[index] === '"' || css[index] === "'") {
      const end = skipCssString(css, index);
      for (let cursor = index + 1; cursor < end - 1; cursor += 1) {
        characters[cursor] = " ";
      }
      index = end;
      continue;
    }
    index += 1;
  }
  return characters.join("");
}

/** An at-rule or function v1 refuses in a stylesheet. */
export interface CellCssUnsupportedConstruct {
  readonly kind: "css-import" | "image-set";
  readonly index: number;
}

/** Finds `@import` and `image-set(` outside comments and strings. */
export function findCellCssUnsupportedConstructs(css: string): readonly CellCssUnsupportedConstruct[] {
  const masked = maskCellCssNonTokens(css);
  const found: CellCssUnsupportedConstruct[] = [];

  // No context requirement before `@import`: the masked text has comments and strings blanked,
  // so a leading comment becomes whitespace and an anchored `(^|[;{}])` pattern would miss an
  // `@import` that followed one. `\b` is what keeps `@important` from matching.
  const importPattern = /@import\b/gi;
  for (const match of masked.matchAll(importPattern)) {
    found.push({ kind: "css-import", index: match.index ?? 0 });
  }

  const imageSetPattern = /image-set\s*\(/gi;
  for (const match of masked.matchAll(imageSetPattern)) {
    found.push({ kind: "image-set", index: match.index ?? 0 });
  }

  return found.sort((left, right) => left.index - right.index);
}

/** One asset a CSS `url(…)` reference inlined. */
export interface CellCssInlinedAsset {
  /** The URL as written in the stylesheet. */
  readonly url: string;
  /** The asset file's own name, as the loader reported it. */
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: number;
  /** Characters the `data:` URI added to the stylesheet. */
  readonly dataUriCharacters: number;
}

/** Why a stylesheet reference was refused. */
export type CellCssViolationKind =
  | "css-import"
  | "image-set"
  | "external-url"
  | "remote-url"
  | "unsupported-query"
  | "missing-asset"
  | "unsupported-asset"
  | "oversized-asset";

export interface CellCssViolation {
  readonly kind: CellCssViolationKind;
  /** The offending URL, when the violation is about one. */
  readonly url?: string;
  readonly detail: string;
}

/** What a loader returns for a CSS reference, or `undefined` when the file cannot be read. */
export interface CellCssAssetSource {
  /** The file's name, used for the media type and the report. */
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export type CellCssAssetLoader = (url: string) => CellCssAssetSource | undefined | Promise<CellCssAssetSource | undefined>;

export interface RewriteCellCssReferencesInput {
  readonly css: string;
  /** The stylesheet's own name, used in violation details. */
  readonly fileName: string;
  readonly inlineLimitBytes: number;
  readonly loadAsset: CellCssAssetLoader;
}

export type CellCssRewriteOutcome =
  | { readonly ok: true; readonly css: string; readonly assets: readonly CellCssInlinedAsset[] }
  | { readonly ok: false; readonly violations: readonly CellCssViolation[] };

/**
 * Rewrites every local `url(…)` in a stylesheet to a `data:` URI, or reports why it cannot.
 *
 * The whole stylesheet is returned unchanged on failure: a partially inlined sheet is exactly
 * the "fake-usable artifact" the issue forbids, so there is no partial success.
 */
export async function rewriteCellCssReferences(input: RewriteCellCssReferencesInput): Promise<CellCssRewriteOutcome> {
  const violations: CellCssViolation[] = [];

  for (const construct of findCellCssUnsupportedConstructs(input.css)) {
    violations.push(
      construct.kind === "css-import"
        ? {
            kind: "css-import",
            detail: `"${input.fileName}" uses @import. v1 does not resolve a stylesheet cascade; flatten the imported rules into this file or move the shared styles to a Forguncy frontend extension.`,
          }
        : {
            kind: "image-set",
            detail: `"${input.fileName}" uses image-set(), which can name files without url(). v1 refuses the function rather than miss a runtime reference; use a single url(...) or move the image to a Forguncy frontend extension.`,
          },
    );
  }

  const replacements: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  const assets: CellCssInlinedAsset[] = [];

  for (const reference of findCellCssUrlReferences(input.css)) {
    const classification = classifyCellCssUrl(reference.url);
    if (classification.kind === "leave") {
      continue;
    }
    if (classification.kind === "violation") {
      violations.push(classification.violation);
      continue;
    }

    const source = await input.loadAsset(classification.path);
    if (source === undefined) {
      violations.push({
        kind: "missing-asset",
        url: reference.url,
        detail: `"${reference.url}" in "${input.fileName}" could not be resolved to a file. v1 only inlines assets that resolve next to the stylesheet or through an installed package.`,
      });
      continue;
    }

    const extension = cellAssetExtensionOf(source.fileName);
    const mediaType = cellStaticAssetMediaType(source.fileName);
    if (mediaType === undefined) {
      violations.push({
        kind: "unsupported-asset",
        url: reference.url,
        detail: `"${reference.url}" resolves to "${source.fileName}" (${extension || "no extension"}), which is outside the v1 inlinable set. Use an image/font extension v1 supports, or move the file to a Forguncy frontend extension (extension) — and if a smaller browser-first asset would do the job, replace it (replace).`,
      });
      continue;
    }

    if (source.bytes.length > input.inlineLimitBytes) {
      violations.push({
        kind: "oversized-asset",
        url: reference.url,
        detail: `"${reference.url}" resolves to "${source.fileName}", which is ${source.bytes.length} bytes; the v1 inline limit is ${input.inlineLimitBytes}. Inline a smaller asset, or move this one to a Forguncy frontend extension (extension) or replace it (replace) — the generated Cell is one script and cannot load a sibling file.`,
      });
      continue;
    }

    const dataUri = formatCellAssetDataUri(mediaType, source.bytes) + classification.fragment;
    replacements.push({ start: reference.start, end: reference.end, text: dataUri });
    assets.push({
      url: reference.url,
      fileName: source.fileName,
      mediaType,
      bytes: source.bytes.length,
      dataUriCharacters: dataUri.length,
    });
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }

  let css = input.css;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    css = css.slice(0, replacement.start) + replacement.text + css.slice(replacement.end);
  }
  return { ok: true, css, assets };
}

type CellCssUrlClassification =
  | { readonly kind: "leave" }
  | { readonly kind: "violation"; readonly violation: CellCssViolation }
  | { readonly kind: "load"; readonly path: string; readonly fragment: string };

/**
 * Classifies one CSS URL.
 *
 * `leave` means "not an asset reference at all": an empty value, a `data:` URI the author wrote,
 * or a fragment reference (`url(#icon)`), none of which fetches a file. Everything else either
 * loads through the caller's loader or produces the violation that says why it cannot.
 */
function classifyCellCssUrl(rawUrl: string): CellCssUrlClassification {
  const url = rawUrl.trim();
  if (url.length === 0 || url.startsWith("#")) {
    return { kind: "leave" };
  }
  if (/^data:/i.test(url)) {
    return { kind: "leave" };
  }

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") {
    return {
      kind: "violation",
      violation: {
        kind: "remote-url",
        url,
        detail: `"${url}" is a remote URL. A Cell artifact may not make a covert CDN request; inline the asset as a small data: URI, or move it to a Forguncy frontend extension.`,
      },
    };
  }
  if (scheme !== undefined) {
    return {
      kind: "violation",
      violation: {
        kind: "external-url",
        url,
        detail: `"${url}" uses the "${scheme}:" scheme, which the Cell cannot serve itself. Inline the asset or move it to a Forguncy frontend extension.`,
      },
    };
  }
  if (url.startsWith("//") || url.startsWith("/") || url.startsWith("\\")) {
    return {
      kind: "violation",
      violation: {
        kind: "external-url",
        url,
        detail: `"${url}" is page-relative rather than a file next to the stylesheet. The Cell does not know the Forguncy page's directory, so v1 refuses it instead of guessing; use a relative path that resolves to a real file.`,
      },
    };
  }
  if (url.includes("?")) {
    return {
      kind: "violation",
      violation: {
        kind: "unsupported-query",
        url,
        detail: `"${url}" carries a query string. v1 does not apply Vite's resource queries to CSS references; remove it.`,
      },
    };
  }

  const fragmentStart = url.indexOf("#");
  const path = fragmentStart === -1 ? url : url.slice(0, fragmentStart);
  const fragment = fragmentStart === -1 ? "" : url.slice(fragmentStart);
  return { kind: "load", path: decodeCssUrlPath(path), fragment };
}

function decodeCssUrlPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
