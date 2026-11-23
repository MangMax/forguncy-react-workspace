/**
 * What a package's **source actually says**, as opposed to what its text happens to
 * contain — plus the files a browser build can reach from its published entries.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine". The defect this module closes was found by running the probe engine
 * against real npm packages for #16's end-to-end acceptance criterion, which is the
 * first time any probe target was anything other than a hand-written fixture.
 *
 * Governing Specs: #16 (a rejection has to be a statement about the artifact the
 * cell would ship, never about a sibling file the browser build does not open), #5
 * (the browser-first artifact the entry question is about).
 *
 * ## Two false positives, one root cause
 *
 * `node-builtin-scan` read a package's whole directory tree with plain regular
 * expressions, and reported `platform-api-unavailable` — "the browser platform
 * cannot provide this" — for three packages whose **browser artifacts contain no
 * Node builtins at all**:
 *
 * - `@embedpdf/pdfium` publishes `dist/index.browser.js` for browsers beside
 *   `dist/index.js` / `dist/index.cjs` for Node. Every `fs`/`module` reference lives
 *   in the Node builds; the browser build has zero.
 * - `three` publishes optional loaders under `examples/jsm/libs/` (draco, basis,
 *   ammo) that carry `require('fs')`. None is reachable from `build/three.module.js`.
 * - `es-toolkit` — the package `#10`'s PoC had already proved inlineable end to end —
 *   exposed two independent false positives: `dist/server/*` behind a `./server`
 *   subpath the root entry never imports, and `dist/predicate/isNode.mjs`, whose
 *   `import('node:fs')` exists only inside a JSDoc `@example` block.
 *
 * So there were two ways for a rejection to be about text rather than code, and both
 * are addressed here rather than in the scanner, so every scanner that reads package
 * source gets the same answer:
 *
 * 1. **Reachability** ({@link collectReachableSourceFiles}) — a file no browser
 *    entry can reach is not part of the artifact, so it cannot disqualify it.
 * 2. **Comments are not code** ({@link maskComments}) — a specifier inside a comment
 *    is documentation about the code, not a dependency of it.
 *
 * ## Why the parser, and not a better regular expression
 *
 * `cell-compiler`'s `source-guard.ts` already recorded this lesson at length: it
 * scanned, then masked comments and literals with a hand-written lexer, then needed
 * four rounds of patches — a template's `${...}`, a minified `import{x}from"x"`, a
 * `new` expression, a regular-expression literal, and finally `n++ / 2`, where a `/`
 * that was a division read as a literal opener and swallowed a real dynamic import.
 * That is the signature of approximating a grammar with text. Everything here that
 * has to tell code from text goes through the same parser the target itself uses, so
 * "this is comment text" is a parse result rather than a guess.
 *
 * Note what is deliberately *not* masked. Strings keep their contents, because these
 * scanners read specifiers *out of* string literals (`require("fs")`, `from "./x"`);
 * masking them would blind the detection rather than sharpen it. Only comment ranges
 * are masked, and `maskComments` preserves every offset and newline so the patterns
 * that run afterwards see the same layout with only the comment bodies blanked.
 *
 * ## What happens when a file will not parse
 *
 * The file is scanned textually, exactly as before, and no comment ranges are
 * removed. That is fail-*open* on purpose: this module's job is to stop false
 * rejections, and silently dropping an unparseable file from the scan would trade a
 * false positive for a false negative — the worse of the two errors, because a
 * package that genuinely needs `fs` would then look deployable.
 */

import { parse } from "@babel/parser";

import { compareCodeUnits } from "@forguncy-react-workspace/core";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A comment's byte offsets in the source it was parsed from. */
export interface CommentRange {
  readonly start: number;
  readonly end: number;
}

/** How a specifier was written — the three forms these scanners treat as real code. */
export type ImportReferenceKind = "static" | "dynamic" | "require";

export interface ImportReference {
  readonly specifier: string;
  readonly kind: ImportReferenceKind;
}

export interface ModuleSourceAnalysis {
  /** Every comment in the file, so callers can mask them before matching text. */
  readonly commentRanges: readonly CommentRange[];
  /** Literal specifiers from `import`/`export … from`, `import()` and `require()`. */
  readonly imports: readonly ImportReference[];
  /** `process.dlopen` / `require("*.node")` — native-addon indicators in source. */
  readonly nativeIndicators: readonly string[];
}

/**
 * Parses a module for the two facts these scanners need, or `undefined` when it
 * cannot be parsed.
 *
 * `errorRecovery` is on, so a file with one of the syntax errors Babel can recover
 * from still yields the comments and imports read before it rather than nothing at
 * all. That set is narrower than it sounds — a stray `}` or a truncated expression
 * still throws — so the text fallback in `findNodeOnlySpecifiers` is the common path
 * for a genuinely malformed file, and this function's `undefined` is what routes a
 * file there.
 *
 * `unambiguous` lets one call handle both `.mjs`/ESM and `.cjs`/CommonJS sources, which
 * is what a package tree actually contains. The TypeScript plugin is required, not
 * optional: reachability now seeds from the manifest, and packages increasingly publish
 * `"exports": { ".": "./src/index.ts" }`, so a `.ts` file is a normal entry. Without the
 * plugin a typed file reports `undefined` and — because an unparseable file enqueues
 * nothing — silently truncates the walk at that point, hiding every file beyond it.
 *
 * `decorators-legacy` covers the decorator syntax the TypeScript plugin alone rejects
 * (`@Injectable class A {}` and the property/method forms), which is common in the
 * Angular/NestJS-style packages that ship a `.ts` entry. `decoratorAutoAccessors` covers
 * the `accessor` field, which TypeScript 5 and modern decorator tooling emit and which
 * nothing else in this list accepts. Both are needed: a file either plugin alone rejects
 * reports `undefined`, and `undefined` means the walk cannot follow its imports — so a
 * parser gap is a truncated graph, not just a missed comment.
 *
 * This is still a partial plugin list by necessity — Babel's proposal plugins disagree
 * with each other (`pipelineOperator` and `decoratorAutoAccessors` cannot be combined
 * blindly, and the pipeline operator has several mutually exclusive syntaxes), so the
 * list is deliberately limited to what published packages actually ship. Anything outside
 * it takes the lenient text-masking path in {@link sourceWithoutCommentsLenient} rather
 * than the raw-text path an earlier version used, so a parser gap can no longer restore
 * the comment false positive.
 */
export function analyzeModuleSource(source: string): ModuleSourceAnalysis | undefined {
  let program: unknown;
  let rawComments: readonly CommentRange[];
  try {
    const file = parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      plugins: ["jsx", "typescript", "decorators-legacy", "decoratorAutoAccessors"],
    }) as unknown as { program: unknown; comments?: readonly CommentRange[] };
    program = file.program;
    rawComments = Array.isArray(file.comments) ? file.comments : [];
  } catch {
    return undefined;
  }

  const commentRanges = rawComments
    .filter(
      (comment): comment is CommentRange =>
        typeof comment?.start === "number" && typeof comment?.end === "number" && comment.end >= comment.start,
    )
    .map(comment => ({ start: comment.start, end: comment.end }))
    .sort((left, right) => left.start - right.start);

  const imports: ImportReference[] = [];
  const nativeIndicators = new Set<string>();

  walkSyntax(program, node => {
    collectNodeReferences(node, imports, nativeIndicators);
  });

  return { commentRanges, imports, nativeIndicators: [...nativeIndicators].sort(compareCodeUnits) };
}

/** A literal string argument, or `undefined` for anything computed. */
function literalArgument(argument: unknown): string | undefined {
  if (argument === null || typeof argument !== "object") {
    return undefined;
  }
  const record = argument as Record<string, unknown>;
  if (record["type"] !== "StringLiteral" && record["type"] !== "Literal") {
    return undefined;
  }
  return typeof record["value"] === "string" ? record["value"] : undefined;
}

function collectNodeReferences(
  node: Record<string, unknown>,
  imports: ImportReference[],
  nativeIndicators: Set<string>,
): void {
  const type = node["type"];

  if (type === "ImportDeclaration" || type === "ExportAllDeclaration" || type === "ExportNamedDeclaration") {
    const specifier = literalArgument(node["source"]);
    // `export { a }` has no `source`, which is not an import of anything.
    if (specifier !== undefined) {
      pushImport(imports, specifier, "static");
    }
    return;
  }

  if (type !== "CallExpression") {
    return;
  }

  const callee = node["callee"];
  const calleeRecord = callee !== null && typeof callee === "object" ? (callee as Record<string, unknown>) : undefined;
  const argumentsList = Array.isArray(node["arguments"]) ? (node["arguments"] as readonly unknown[]) : [];
  const first = literalArgument(argumentsList[0]);

  // `process.dlopen(module, "./addon.node")` — the Node API for loading a native
  // addon, and the one native indicator a call site can establish on its own. It has
  // to be recognised here rather than left to the text fallback: the fallback only
  // runs for files that do not parse, so routing the scan through the parser silently
  // stopped reporting it for every parseable file — a regression measured on a
  // reachable module whose only native dependency was a `dlopen`, which reported zero
  // native indicators and `no-node-builtins: true`.
  if (isMemberCall(calleeRecord, "process", "dlopen")) {
    nativeIndicators.add("source:process.dlopen");
    return;
  }

  // `import("x")` — the callee node type is `Import` for a dynamic import.
  if (calleeRecord?.["type"] === "Import") {
    if (first !== undefined) {
      pushImport(imports, first, "dynamic");
    }
    return;
  }

  if (calleeRecord?.["type"] !== "Identifier" || calleeRecord["name"] !== "require") {
    return;
  }
  if (first === undefined) {
    return;
  }
  pushImport(imports, first, "require");
  if (first.endsWith(".node")) {
    nativeIndicators.add("source:require-*.node");
  }
}

/** True for a non-computed `object.method(...)` call site. */
function isMemberCall(callee: Record<string, unknown> | undefined, object: string, method: string): boolean {
  if (callee?.["type"] !== "MemberExpression" || callee["computed"] === true) {
    return false;
  }
  const target = callee["object"];
  const property = callee["property"];
  if (target === null || typeof target !== "object" || property === null || typeof property !== "object") {
    return false;
  }
  const targetRecord = target as Record<string, unknown>;
  const propertyRecord = property as Record<string, unknown>;
  return (
    targetRecord["type"] === "Identifier" &&
    targetRecord["name"] === object &&
    propertyRecord["type"] === "Identifier" &&
    propertyRecord["name"] === method
  );
}

function pushImport(imports: ImportReference[], specifier: string, kind: ImportReferenceKind): void {
  if (specifier.trim().length === 0) {
    return;
  }
  imports.push({ specifier, kind });
}

/** Pre-order walk over a Babel AST, visiting every node with a `type`. */
function walkSyntax(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      walkSyntax(item, visit);
    }
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record["type"] === "string") {
    visit(record);
  }
  for (const key of Object.keys(record)) {
    // Position and comment side-tables are not syntax, and descending them would
    // both waste work and re-visit nodes reachable from the tree.
    if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") {
      continue;
    }
    const value = record[key];
    if (value !== null && typeof value === "object") {
      walkSyntax(value, visit);
    }
  }
}

/**
 * Blanks every comment body, preserving UTF-16 length and line breaks.
 *
 * Offsets and newlines are preserved so a caller's later pattern match sees the same
 * layout it would have seen unmasked — only the comment *content* is gone. A
 * newline inside a block comment is kept so line numbers in any diagnostic that
 * quotes the masked text still line up with the original file.
 *
 * **Indexed by UTF-16 code unit, matching the offsets it is given.** Babel's
 * `comment.start`/`end` count code units — the same unit `String.prototype.length`
 * and `slice` use — so this builds its result with `slice` rather than spreading the
 * string into an array. Spreading yields an array of *code points*, and the two stop
 * agreeing at the first astral character: an array index is then smaller than the
 * offset it is compared against, so blanking lands short by the astral count. Measured
 * consequence at 22 astral characters before a comment — the entire comment survived
 * masking, which put `require("node:fs")` written in prose back in front of the
 * scanner and restored the exact false rejection this module exists to remove; with
 * the drift in the other direction it consumed real code instead, silently dropping a
 * `import(`, a `new Worker(` or an AMD/UMD marker and so *hiding* a real finding.
 * Neither direction is acceptable, and the earlier version's own test only used ASCII,
 * which is why it passed.
 */
export function maskComments(source: string, ranges: readonly CommentRange[]): string {
  if (ranges.length === 0) {
    return source;
  }
  // `slice` on the original string, so every offset stays in the code-unit space
  // Babel reported. Sorted and clamped because a caller may pass ranges from any
  // source, and a bad range must not lose text before it.
  const ordered = [...ranges].sort((left, right) => left.start - right.start);
  let masked = "";
  let cursor = 0;
  for (const range of ordered) {
    const start = Math.max(cursor, Math.min(range.start, source.length));
    const end = Math.max(start, Math.min(range.end, source.length));
    if (start > cursor) {
      masked += source.slice(cursor, start);
    }
    // A newline inside the comment survives, so line/column arithmetic over the
    // result stays valid.
    masked += source.slice(start, end).replace(/[^\n\r]/g, " ");
    cursor = end;
  }
  return cursor < source.length ? masked + source.slice(cursor) : masked;
}

/**
 * `source` with its comments removed, or `source` unchanged when it will not parse.
 *
 * Use this when the caller *has* a parse anyway (`artifact-scan` does, and so does
 * `module-source`'s own walk): it reuses the ranges the parse produced and costs nothing
 * extra. Callers with no parse in hand want {@link sourceWithoutCommentsLenient}, which
 * does not need one.
 */
export function sourceWithoutComments(source: string): string {
  const analysis = analyzeModuleSource(source);
  if (analysis === undefined) {
    return source;
  }
  return maskComments(source, analysis.commentRanges);
}

/**
 * `source` with its comments removed, without requiring a parse.
 *
 * The difference from {@link sourceWithoutComments} is the whole point: this one always
 * masks, so a file the parser rejects still has its comments stripped rather than having
 * its prose scanned as code. That matters because an unparseable file is exactly the case
 * where a scanner has *nothing else* — and an earlier version's fallback treated the
 * absence of a parse as permission to match raw text, which restored the defect the
 * masking exists to remove: a package whose entry used the `accessor` field was refused
 * over a `require("node:child_process")` written in a doc comment, while the bundler
 * built it cleanly.
 *
 * Text-based, so it is strictly weaker than the parser's ranges and deliberately biased
 * against hiding code:
 *
 * - Nothing is masked inside a string, template or regex literal, because every specifier
 *   these scanners look for lives inside a string. A false positive from a string is
 *   tolerable; a false negative from a masked import is not.
 * - An unterminated block comment masks to end of file, which *does* risk hiding code
 *   after a `/*` inside an unterminated construct. That is the one shape where the two
 *   errors trade places, and it is accepted because a file containing a lone `/*` outside
 *   a string is already a file the build step will report.
 */
export function sourceWithoutCommentsLenient(source: string): string {
  const analysis = analyzeModuleSource(source);
  if (analysis !== undefined) {
    return maskComments(source, analysis.commentRanges);
  }
  return maskCommentsByText(source);
}

/**
 * Blanks `//` and `/* *\/` comments in `source`, skipping string, template and regex
 * literals so their contents are never treated as comments.
 *
 * Length- and newline-preserving, like {@link maskComments}, so a caller's later match
 * sees the same layout. Regex-literal detection is approximate — distinguishing `a / b`
 * from `a /re/` needs context this does not have — and errs toward *not* masking, so the
 * worst case is a comment that survives rather than code that disappears.
 */
function maskCommentsByText(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to && index < out.length; index += 1) {
      if (out[index] !== "\n" && out[index] !== "\r") {
        out[index] = " ";
      }
    }
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === "/" && next === "/") {
      const newline = source.indexOf("\n", index);
      const stop = newline === -1 ? source.length : newline;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (character === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      const stop = close === -1 ? source.length : close + 2;
      blank(index, stop);
      index = stop;
      continue;
    }

    // Strings and templates are skipped, never blanked: the specifier is inside one.
    if (character === "'" || character === '"' || character === "`") {
      index = endOfQuoted(source, index);
      continue;
    }

    index += 1;
  }

  return out.join("");
}

/**
 * Index just past the closing quote, or the line break when unterminated.
 *
 * Stopping at an unterminated literal's line break keeps one malformed string from
 * swallowing the rest of the file, which would hide every later comment.
 */
function endOfQuoted(source: string, start: number): number {
  const quote = source[start]!;
  let index = start + 1;
  while (index < source.length) {
    const character = source[index]!;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) {
      return index + 1;
    }
    if (character === "\n") {
      return index;
    }
    index += 1;
  }
  return source.length;
}
