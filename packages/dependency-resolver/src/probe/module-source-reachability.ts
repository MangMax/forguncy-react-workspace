/**
 * Which files a browser build can reach, following relative specifiers only (#161).
 *
 * Split mechanically out of `module-source.ts`; the reasoning is the moved comments' own. The
 * parsing and masking it leans on are in `module-source-analysis.ts`.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { compareCodeUnits } from "@forguncy-react-workspace/core";

import {
  analyzeModuleSource,
  sourceWithoutCommentsLenient,
  type ModuleSourceAnalysis,
} from "./module-source-analysis.ts";

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/** Suffixes a bundler tries when a specifier names no file. */
/**
 * Suffixes tried when a specifier names no file.
 *
 * The TypeScript forms are included because reachability seeds from the manifest, and
 * a package may publish `"exports": { ".": "./src/index.ts" }` — the walk then follows
 * `.ts` specifiers out of a `.ts` entry, and omitting the suffix would leave every one
 * of them unresolved, silently truncating the graph at the entry.
 */
const RESOLVE_SUFFIXES: readonly string[] = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".json"];

/** Directory index basenames a bundler tries when a specifier names a directory. */
const INDEX_BASENAMES: readonly string[] = [
  "index.js",
  "index.mjs",
  "index.cjs",
  "index.jsx",
  "index.ts",
  "index.mts",
  "index.cts",
  "index.tsx",
];

export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..";
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Resolves `candidate` the way a bundler would, or `undefined` when nothing exists. */
async function resolveFileLike(candidate: string): Promise<string | undefined> {
  if (await isFile(candidate)) {
    return candidate;
  }
  for (const suffix of RESOLVE_SUFFIXES) {
    if (await isFile(`${candidate}${suffix}`)) {
      return `${candidate}${suffix}`;
    }
  }
  for (const basename of INDEX_BASENAMES) {
    const index = join(candidate, basename);
    if (await isFile(index)) {
      return index;
    }
  }
  return undefined;
}

/**
 * Whether `candidate` sits inside `directory`.
 *
 * `..` is matched as a path **segment**, which is the only form that distinguishes "one level
 * up" from "a file whose name starts with two dots". The bare `path.startsWith("..")` prefix
 * test that used to be here (redundantly, next to the segment tests that already did the job)
 * classified a real in-package file as outside: measured on `import "./..helper.js"`, where the
 * walk reported the specifier as *escaped* and the rejection for the builtin inside that file
 * was never filed — while rolldown bundled it. A file named `..d/x.js` or `...triple.js` has
 * the same shape.
 */
export function isInside(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate);
  if (path.length === 0) {
    return true;
  }
  if (isAbsolute(path)) {
    return false;
  }
  return !path.split(sep).includes("..");
}

/**
 * Bundler query suffixes that mean "include this file's **bytes**, do not execute it".
 *
 * `?raw` hands the importer the file's text, `?url` its URL, `?inline` its contents as a
 * data URL. None of them puts the file's own code in the bundle, so a Node builtin
 * inside such a file is not in the artifact — and following it produced a false
 * `platform-api-unavailable` rejection on a package that ships a `?raw` template beside
 * Node-only tooling. That is the same failure class this whole change removes, so the
 * distinction is load-bearing rather than tidy.
 */
const NON_EXECUTING_QUERY_TOKENS: readonly string[] = ["raw", "url", "inline"];

/**
 * The token that means "compile this file into a Worker", which **is** executed.
 *
 * Checked *before* {@link NON_EXECUTING_QUERY_TOKENS} because the two combine and
 * `worker` wins: `?worker&inline` is Vite's spelling for "bundle this Worker and inline
 * it as a data URL", and the Worker's code and imports are in the artifact. A token set
 * rather than a leading token because both orders appear in the wild. Getting the
 * precedence backwards stopped the walk at such a file, which is the false-negative
 * direction the walk must not fail in.
 */
const EXECUTING_QUERY_TOKEN = "worker";

/** The `&`/`?`-separated query tokens of a specifier, or none. */
function queryTokens(specifier: string): readonly string[] {
  const query = specifier.slice(specifier.indexOf("?"));
  if (query.length === 0) {
    return [];
  }
  return query.slice(1).split("&").filter(token => token.length > 0);
}

/**
 * Strips a query suffix a bundler treats as metadata, leaving the filename it names.
 */
function stripQuery(specifier: string): string {
  return specifier.replace(/\?.*$/, "");
}

/**
 * Whether a specifier carries a query that stops the file being executed.
 *
 * `worker` is checked first and wins outright, so `?worker&inline` is executed while a
 * bare `?inline` is not.
 */
function isNonExecutingQuery(specifier: string): boolean {
  const tokens = queryTokens(specifier);
  if (tokens.includes(EXECUTING_QUERY_TOKEN)) {
    return false;
  }
  return tokens.some(token => NON_EXECUTING_QUERY_TOKENS.includes(token));
}

/**
 * What a specifier resolves to inside the package.
 *
 * - a non-empty list — the files to enqueue;
 * - `null` — a *relative* specifier that was part of this package's graph but could
 *   not be followed: it either escaped the package or resolved to nothing on disk.
 *   The caller records which, because the two are different findings;
 * - an empty list — not part of this package's reachable graph at all: a third-party
 *   bare specifier (a separate node in the probe's dependency graph), a self-reference
 *   the manifest does not publish, or a file imported for its bytes rather than its
 *   code. Not evidence of anything.
 */
async function resolveReference(
  packageDirectory: string,
  fromFile: string,
  specifier: string,
  selfReference: SelfReferenceResolver | null,
  browserSubstitution: BrowserSubstitution | null,
): Promise<readonly string[] | null> {
  if (isRelativeSpecifier(specifier)) {
    // A file imported for its bytes (`?raw`, `?url`, `?inline`) is not executed, so its
    // imports are not part of the build. Skipped before resolution: the file may not
    // even be JavaScript.
    if (isNonExecutingQuery(specifier)) {
      return [];
    }
    // Otherwise the query is not part of the filename — `?worker` compiles the file
    // into a Worker the bundle starts, so its source *is* part of the build and not
    // following it would hide whatever that file imports.
    const candidate = resolve(dirname(fromFile), stripQuery(specifier));
    if (!isInside(packageDirectory, candidate)) {
      return null;
    }
    let resolved = await resolveFileLike(candidate);
    if (resolved === undefined) {
      // `null`, not `[]`: a relative specifier inside the package that resolves to
      // nothing is a broken link the walk has to report, because nothing else will.
      return null;
    }
    // The `browser` field substitutes a *resolved file*, not the request as spelled. A
    // resolver finishes resolution first — trying extensions and directory indexes — and then
    // consults the substitution table, so a remap keyed on `./impl.js` applies to a request
    // written `./impl`, and one keyed on `./dist/index.js` applies to `main: "./dist/index"`.
    // Substituting the unresolved request instead missed both: measured, a package whose entry
    // used the extensionless spelling was refused for the `node:fs` in the file its `browser`
    // map replaces, while rolldown built it cleanly. A false rejection in the direction this
    // whole change exists to remove.
    const resolvedPath = toPortableRelative(packageDirectory, resolved);
    const substituted = browserSubstitution === null ? resolvedPath : browserSubstitution(resolvedPath);
    if (substituted === null) {
      // Replaced by nothing: the browser build contains no version of this file.
      return [];
    }
    if (substituted !== resolvedPath) {
      const substitutedFile = await resolveFileLike(join(packageDirectory, ...substituted.split("/")));
      if (substitutedFile === undefined) {
        return [];
      }
      resolved = substitutedFile;
    }
    return [resolved];
  }

  // A `browser` map may redirect a **bare specifier** to a module in this package
  // (`{"browser": {"fs": "./fs-shim.js"}}`). The redirect target is a file the browser build
  // loads, so the walk has to follow it: treating the specifier as merely "redirected away"
  // left the target unscanned, and the artifact's `node:fs` — imported by the shim itself —
  // was never seen. Measured: the build failed on that builtin while the report was
  // `supports-rejection-only` with no rejection finding, the state that tells a consumer
  // nothing.
  //
  // Checked before the self-reference branch because a redirect is the more specific answer:
  // the manifest names this specifier explicitly.
  const redirected = selfReference === null ? null : selfReference.redirectedSpecifier(specifier);
  if (redirected !== null) {
    const candidate = join(packageDirectory, ...redirected.split("/"));
    if (!isInside(packageDirectory, candidate)) {
      return [];
    }
    const file = await resolveFileLike(candidate);
    return file === undefined ? [] : [file];
  }

  // A package may import itself by name, and a bundler resolves that through the
  // package's own `exports` map exactly as it resolves a consumer's import. Not
  // following it makes this walk disagree with the bundler — measured on a package
  // whose root entry re-exports from `pkg/server`, whose `./server` entry needs
  // `node:child_process`: the bundler followed it and failed on the builtin, while
  // the walk reached one file and filed no finding.
  if (selfReference === null) {
    return [];
  }
  const subpath = selfReference.subpathOf(specifier);
  if (subpath === null) {
    return [];
  }

  // The subpath's alternatives are an **ordered fallback list**, so the first one that
  // exists on disk is the one a resolver loads and the only one the walk follows. Scanning
  // every alternative that happens to exist would report findings from a file the bundler
  // never bundles: measured on `{".": ["./browser.js", "./node.js"]}`, where rolldown
  // bundled only `browser.js` while the scan reported the `node:fs` in `node.js`.
  for (const target of selfReference.resolveSubpath(subpath)) {
    const candidate = join(packageDirectory, ...target.split("/"));
    if (!isInside(packageDirectory, candidate)) {
      continue;
    }
    const file = await resolveFileLike(candidate);
    if (file === undefined) {
      continue;
    }
    // The `browser` substitution applies here too, and it was missing: a subpath resolved
    // through `exports` or an `imports` map is a *resolved file* like any other, so a
    // `browser` key naming it must redirect the walk. Omitting it made the walk follow the
    // file the browser build replaces — measured on a package whose `./s` subpath pointed at
    // a `node:fs` module that `browser` remapped away: rolldown built cleanly with the
    // replacement while the engine refused the package. The relative-specifier branch has
    // applied this since it was added; this branch returning the file directly is what made
    // the two disagree.
    const filePath = toPortableRelative(packageDirectory, file);
    const substituted = browserSubstitution === null ? filePath : browserSubstitution(filePath);
    if (substituted === null) {
      // Replaced by nothing for a browser build: not a file this walk can follow.
      continue;
    }
    if (substituted === filePath) {
      return [file];
    }
    const substitutedFile = await resolveFileLike(join(packageDirectory, ...substituted.split("/")));
    if (substitutedFile !== undefined) {
      return [substitutedFile];
    }
  }
  // None of the alternatives exists. Not `null`: that is reserved for a specifier that
  // escaped the package, which is a different finding. A published subpath whose
  // alternatives are all absent is a packaging fault the build step reports.
  return [];
}

/**
 * How a package's own name resolves to one of its published subpaths.
 *
 * Passed in rather than derived here so this module does not need the manifest —
 * `browser-entry.ts` owns `exports` resolution, and a second implementation of it
 * would be a second answer to the same question.
 */
/**
 * Applies the manifest's `browser` field substitution to a package-relative request,
 * returning the replacement path, `null` when the request is excluded, or the request
 * unchanged.
 *
 * Injected rather than imported so this module keeps owning the *walk* and
 * `browser-entry.ts` keeps owning manifest interpretation. A direct import would be a
 * cycle: `browser-entry.ts` imports {@link SelfReferenceResolver} from here.
 */
export type BrowserSubstitution = (packageRelativeRequest: string) => string | null;

export interface SelfReferenceResolver {
  /** The `./x` subpath `specifier` names under this package, or null when it names something else. */
  subpathOf(specifier: string): string | null;
  /** The package-relative files that subpath publishes — every browser-resolvable alternative, or none. */
  resolveSubpath(subpath: string): readonly string[];
  /**
   * The package-relative file a `browser` map redirects this **bare specifier** to, or `null`
   * when the map does not mention it (or excludes it with `false`, which is not a file).
   */
  redirectedSpecifier(specifier: string): string | null;
}

/**
 * One reachable file, already read and parsed.
 *
 * Read and parsed by the reachability walk, which had to do both anyway to follow
 * its imports, and handed to the scanners so neither has to open the file a second
 * time. `masked` is the source with comments blanked — what a text-matching scanner
 * should use.
 */
export interface PackageSourceFile {
  readonly absolutePath: string;
  /** Path relative to the package root, forward-slashed: what report evidence cites. */
  readonly relativePath: string;
  /** Raw file text, for anything that genuinely needs the original bytes. */
  readonly source: string;
  /** `source` with every comment body blanked, offsets preserved. */
  readonly masked: string;
  /** Parsed facts; `undefined` when the file could not be parsed. */
  readonly analysis: ModuleSourceAnalysis | undefined;
}

export interface ReachableSourceResult {
  /** Every source file reachable from an entry, sorted by package-relative path. */
  readonly files: readonly PackageSourceFile[];
  /** Entry paths the manifest named that do not exist in the package. */
  readonly missingEntries: readonly string[];
  /** Relative specifiers that resolved outside the package, in sorted order. */
  readonly escapedSpecifiers: readonly string[];
  /**
   * Relative specifiers that stayed inside the package but resolved to no file, in
   * sorted order.
   *
   * Recorded because a dropped specifier is invisible in every other channel, and the
   * walk is the only place that knows about it. Two realistic shapes: a packaging
   * fault (`import "./missing.js"`, which the build step reports) and a bundler query
   * (`import "./w.js?worker"`, which is *the* way a Vite package declares a Worker
   * entry — the query is not a filename, so the candidate does not exist on disk).
   * Without this, either one made the walk silently stop and the report's only trace
   * was a smaller file count.
   */
  readonly unresolvedSpecifiers: readonly string[];
  /**
   * Reachable files that could not be parsed, in sorted order.
   *
   * An unparseable file is still scanned (its text is matched directly), but nothing is
   * enqueued from it, so every file it imports is unreachable by construction. Naming
   * them is what keeps that truncation reviewable instead of showing up only as a
   * smaller file count.
   */
  readonly unparseableFiles: readonly string[];
}

/**
 * Every source file a browser build can reach from the package's published entries,
 * following relative specifiers only.
 *
 * Bare specifiers are deliberately not followed: another package is a separate node
 * in the probe's dependency graph, with its own manifest and its own entry, and
 * following it here would scan it under the wrong package's name and skip the graph
 * walk's cycle handling. Subpath self-references (`"my-pkg/sub"`) are not followed
 * either, for the same reason.
 *
 * Returns an empty `files` list when the package publishes nothing a browser can
 * enter through. Callers must read that as "no reachable source" rather than "scan
 * the tree": those are opposite answers, and conflating them is the defect this
 * function exists to prevent.
 */
/**
 * Reads one file into a {@link PackageSourceFile}, or `undefined` when it cannot be read.
 *
 * Exported because reachability is not the only way a file enters a scan: the artifact's own
 * file list is the *positive* source for a file the build reached through a path the package's
 * root entry does not lead to (a dependency's `exports` subpath, a `browser` specifier
 * redirect). A caller holding such a path needs the same read/parse/mask treatment, and a
 * second implementation of it would be a second answer to "what does this file say".
 */
export async function readSourceFile(
  packageDirectory: string,
  absolutePath: string,
): Promise<PackageSourceFile | undefined> {
  let source: string;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch {
    return undefined;
  }
  const analysis = analyzeModuleSource(source);
  return {
    absolutePath,
    relativePath: toPortableRelative(packageDirectory, absolutePath),
    source,
    // Masked on both paths, so the field means what its name says. Leaving it raw on the
    // unparseable path would let `runtime-pattern-scan` — which reads this field — see comment
    // text for that one file, undoing the masking exactly where the parse could not supply
    // ranges. `sourceWithoutCommentsLenient` needs no parse, so the two paths differ only in
    // how the ranges were found.
    masked: sourceWithoutCommentsLenient(source),
    analysis,
  };
}

export async function collectReachableSourceFiles(
  packageDirectory: string,
  entries: readonly string[],
  selfReference: SelfReferenceResolver | null = null,
  browserSubstitution: BrowserSubstitution | null = null,
): Promise<ReachableSourceResult> {
  const missingEntries: string[] = [];
  const escaped = new Set<string>();
  const unresolved = new Set<string>();
  const unparseable: string[] = [];
  const byAbsolutePath = new Map<string, PackageSourceFile>();
  let frontier: string[] = [];

  for (const entry of [...entries].sort(compareCodeUnits)) {
    const resolvedEntry = await resolveFileLike(join(packageDirectory, entry));
    if (resolvedEntry === undefined) {
      missingEntries.push(entry);
      continue;
    }
    // The entry is substituted too, and on the **resolved** file for the same reason a
    // relative import is: a remap is keyed on the file resolution landed on, so
    // `main: "./dist/index"` with `browser: { "./dist/index.js": … }` resolves first and
    // substitutes after. Doing it on the manifest spelling missed that shape — measured, the
    // walk followed the Node build file the browser map replaces while rolldown bundled the
    // replacement.
    const entryPath = toPortableRelative(packageDirectory, resolvedEntry);
    const substituted = browserSubstitution === null ? entryPath : browserSubstitution(entryPath);
    if (substituted === null) {
      // Replaced by nothing: the browser build has no entry through this file.
      continue;
    }
    if (substituted === entryPath) {
      frontier.push(resolvedEntry);
      continue;
    }
    const substitutedEntry = await resolveFileLike(join(packageDirectory, ...substituted.split("/")));
    if (substitutedEntry === undefined) {
      missingEntries.push(substituted);
      continue;
    }
    frontier.push(substitutedEntry);
  }

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const file of frontier) {
      if (byAbsolutePath.has(file)) {
        continue;
      }

      const read = await readSourceFile(packageDirectory, file);
      if (read === undefined) {
        continue;
      }
      const { analysis } = read;
      byAbsolutePath.set(file, read);

      if (analysis === undefined) {
        // Unparseable: the file is part of the graph but its imports are unknowable,
        // so nothing is enqueued from it. The file itself is still returned, which is
        // what keeps a real Node dependency in an unparseable file reportable — and
        // its path is recorded, because the walk stopping here is otherwise invisible.
        unparseable.push(toPortableRelative(packageDirectory, file));
        continue;
      }

      for (const reference of analysis.imports) {
        const resolved = await resolveReference(packageDirectory, file, reference.specifier, selfReference, browserSubstitution);
        if (resolved === null) {
          // A relative specifier that could not be followed. Which bucket it belongs in
          // is decided here rather than inside `resolveReference`, because "left the
          // package" and "resolves to nothing" are different findings: the first is
          // usually intentional, the second is usually broken.
          if (isInside(packageDirectory, resolve(dirname(file), reference.specifier))) {
            unresolved.add(reference.specifier);
          } else {
            escaped.add(reference.specifier);
          }
          continue;
        }
        for (const target of resolved) {
          if (!byAbsolutePath.has(target)) {
            next.push(target);
          }
        }
      }
    }
    frontier = next.sort(compareCodeUnits);
  }

  return {
    files: [...byAbsolutePath.values()].sort((left, right) =>
      compareCodeUnits(left.relativePath, right.relativePath),
    ),
    missingEntries: missingEntries.sort(compareCodeUnits),
    escapedSpecifiers: [...escaped].sort(compareCodeUnits),
    unresolvedSpecifiers: [...unresolved].sort(compareCodeUnits),
    unparseableFiles: unparseable.sort(compareCodeUnits),
  };
}

/** A path as report evidence cites it: package-relative, forward-slashed. */
function toPortableRelative(packageDirectory: string, absolutePath: string): string {
  return relative(packageDirectory, absolutePath).split(sep).join("/");
}
