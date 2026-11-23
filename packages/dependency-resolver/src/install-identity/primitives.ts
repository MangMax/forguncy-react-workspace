/**
 * File and digest primitives shared by the install-identity seams (#161).
 *
 * Nothing here knows what an install graph is: these are the three-state readers, the two digest
 * functions, the canonical form the install-identity digests are composed from, and the path and
 * file-walk helpers the seams share. They live together so the seams below import them rather than
 * each carrying a copy.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative as relativePath, resolve } from "node:path";

import { createCanonicalizer, FGC_LOCK_FILE_NAME, isPlainRecord } from "@forguncy-react-workspace/core";

/**
 * Artifacts **this toolchain** writes into a project, which are not the project's content.
 *
 * Excluded from a link target's digest for the same structural reason `node_modules` is, and
 * excluding them is not tidiness — two of the three made the identity self-referential:
 *
 * - `.fgc/` — the probe cache and synthetic build entries. Measured: including it made a workspace
 *   member's identity change on every read of an unchanged tree.
 * - `fgc.lock.json` and `fgc-evidence/` — the recorded evidence. These are this toolchain's
 *   *output* about the project, and a project that carries them has them inside the very target
 *   being digested. Measured: reading the identity, writing the lock, and reading it again in the
 *   same process produced two different values, because the first write had become part of the input
 *   to the second read. An identity that cannot survive recording its own evidence carries no
 *   information, and it would re-measure for ever.
 */
export const TOOLCHAIN_ARTIFACT_NAMES: ReadonlySet<string> = new Set([".fgc", "fgc-evidence", FGC_LOCK_FILE_NAME]);

/** Whether an entry of a link target is one of this toolchain's own artifacts. */
export function isToolchainArtifact(name: string): boolean {
  return TOOLCHAIN_ARTIFACT_NAMES.has(name);
}

/** Whether `path` is a readable directory. */
/**
 * Whether `path` is a directory, or `undefined` when that could not be established.
 *
 * Three states, because the caller reads this as a *fact about the install graph*: only `ENOENT` and
 * `ENOTDIR` say the entry is genuinely absent, and a readable path that is not a directory says it is
 * present and is something else. Every other error says **nothing**, and folding it into "absent"
 * turns "could not read" into "confirmed not there" — the false-fresh shape #94's third criterion
 * rules out. Review round 12: measured, `stat` of a `node_modules` inside a mode-`000` directory
 * returns `EACCES` for a non-root user (CI runs non-root), and that guard answers whether an external
 * link target carries its own install graph.
 *
 * A symlink **loop** does not reach here: `stat` follows a link without descending through it, so a
 * self-referential `node_modules` still reports a directory on both Windows and Linux (measured), and
 * a dangling one reports `ENOENT`, which is the absent case.
 */
export async function directoryExists(path: string): Promise<boolean | undefined> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    const code = (error as { readonly code?: unknown } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? false : undefined;
  }
}

/**
 * The install records the package managers write into their own `node_modules`.
 *
 * Named as constants so the two readers and their tests cannot drift on the spelling:
 * `node_modules/.modules.yaml` (pnpm) and `node_modules/.package-lock.json` (npm).
 */
export const PNPM_MODULES_FILE = ".modules.yaml";
export const NPM_INSTALL_RECORD = ".package-lock.json";

/**
 * The content digest of one file's text, with line endings normalized to `\n` first.
 *
 * **Normalization is required, not cosmetic**, and this was measured the hard way: the digest of a
 * file is not a property of the project unless it is independent of how git happened to check that
 * file out. This repository sets `core.autocrlf=true`, so a Windows working tree holds `pnpm-lock.yaml`
 * with CRLF while the committed bytes — and therefore CI's checkout — are LF. Hashing raw bytes made
 * one project produce two identities, and a lock re-recorded on Windows reported
 * `install-graph-changed` on Linux for a graph that had not moved.
 *
 * The line-ending convention a checkout uses is a fact about the *checkout*, not about the install.
 * `git` already normalizes the other direction on commit for exactly this reason, and #94's
 * portability criterion — "the same real inputs in different directories compose the same identity"
 * — cannot be met while a digest depends on the platform that read the file.
 *
 * The cost is that a change which only rewrites line endings no longer invalidates. That is the
 * correct answer rather than a tolerated one: such a change cannot alter what a bundler resolves or
 * emits, so reporting `install-graph-changed` for it would be a false positive of the same class as
 * tying a record to a Node patch release.
 */
export function digestOf(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

/**
 * The content digest of a **binary** file's bytes, with no decoding and no normalization.
 *
 * The counterpart to {@link digestOf} for the files `BINARY_LOCKFILE_NAMES` names. Decoding first
 * would replace each invalid byte sequence with U+FFFD, so distinct byte strings could compose one
 * digest — measured, `[0x41, 0xff, 0x42]` and `[0x41, 0xfe, 0x42]` both became `"A�B"`. A
 * digest that two different files can share is not an identity.
 */
export function digestOfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Sorted-key JSON, so the same inputs compose the same bytes regardless of property order.
 *
 * The walk is core's canonicaliser (#155) with no listed keys — alphabetical at every depth — and
 * not `probe/fingerprint.ts`'s composer: that module imports `build.ts`, which imports `rolldown`,
 * and this module is reachable from `local.ts`, the entry whose whole purpose is to stay free of a
 * bundler. `core` reaches no bundler, so sharing the primitive no longer costs that property, which
 * is why the copy this used to be is gone rather than kept "for the same reason".
 */
const canonicalizeIdentityValue = createCanonicalizer([]);

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeIdentityValue(value)) ?? "null";
}

/**
 * What reading one file produced.
 *
 * Three states, because two would collapse the distinction this module's header is about:
 * `absent` is a known fact ("there is no lockfile"), while `unreadable` is the inability to say.
 */
export type FileState =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly text: string }
  | { readonly kind: "unreadable" };

/** The same three states for a file read as bytes, for the lockfiles that are not text. */
export type BinaryFileState =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly bytes: Uint8Array }
  | { readonly kind: "unreadable" };

/** Classifies a read failure: absence (`ENOENT`/`ENOTDIR`) versus a file that is there and unreadable. */
function failedKind(error: unknown): "absent" | "unreadable" {
  // Anything else (`EACCES`, `EISDIR`, an I/O error) is a file that is there and cannot be read.
  // Collapsing them would report "no lockfile" for a lockfile the reader can see in their own
  // directory listing.
  const code = (error as { readonly code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
}

export async function readTextFile(path: string): Promise<FileState> {
  try {
    return { kind: "read", text: await readFile(path, "utf8") };
  } catch (error) {
    return { kind: failedKind(error) };
  }
}

export async function readBinaryFile(path: string): Promise<BinaryFileState> {
  try {
    const bytes = await readFile(path);
    // Copied into a plain `Uint8Array` because `readFile` may hand back a pooled `Buffer` view,
    // and the digest must be over exactly this file's bytes rather than a shared backing store.
    return { kind: "read", bytes: new Uint8Array(bytes) };
  } catch (error) {
    return { kind: failedKind(error) };
  }
}

/** Whether `candidate` is `directory` itself or lies beneath it, compared on normalized paths. */
export function isInside(directory: string, candidate: string): boolean {
  const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
  const parent = fold(resolve(directory));
  const child = fold(resolve(candidate));
  return child === parent || child.startsWith(`${parent}${process.platform === "win32" ? "\\" : "/"}`);
}

export function asPlainObject(value: unknown): Record<string, unknown> | null {
  return isPlainRecord(value) ? value : null;
}

/**
 * Whether `path` exists at all, or `undefined` when that could not be established.
 *
 * Separate from {@link directoryExists} because the two build triggers are named by **files**: a
 * `binding.gyp` is a file, and asking `isDirectory()` of it answers `false` for every package that has
 * one. Measured while writing that case — the trigger check reported "no `binding.gyp`" on a slot that
 * shipped one, which is the under-selection this axis cannot afford.
 */
export async function pathExists(path: string): Promise<boolean | undefined> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = (error as { readonly code?: unknown } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? false : undefined;
  }
}

/**
 * Sorted `"<relative path>:<content digest>"` for every file under `directory`, or `null` when one
 * cannot be read.
 *
 * **`node_modules` is the only exclusion**, because it is the only name whose exclusion has a
 * reason that holds — it is a different install graph, so following it would make this digest depend
 * on a tree the link does not own. Dot-named entries are *not* excluded: `exports: { ".":
 * "./.generated/index.js" }` is an ordinary way to publish a workspace package, and treating a dot
 * as "manager bookkeeping" left that file invisible (review round 9, measured).
 */
export async function collectPackageFiles(directory: string, root: string): Promise<readonly string[] | null> {
  let entries: { readonly name: string; readonly isDirectory: () => boolean; readonly isFile: () => boolean }[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  const files: string[] = [];
  for (const entry of entries) {
    // Only `node_modules` is excluded, and it is excluded for a reason that holds: it is a *different
    // install graph* with its own identity, so following it would make this digest depend on a tree
    // the link does not own. Every other entry is included — including dot-named ones. Review round 9
    // measured the false fresh that blanket dot-exclusion bought: a workspace package whose
    // `package.json` points `exports` (or `main`) at `./.generated/index.js` is entirely ordinary, and
    // editing that file moved nothing while the next build read the new source. A dot name is not
    // evidence of manager bookkeeping; only the names below are.
    // Exclusions are **enumerated**, not "every dot name". The two that exist have separate, specific
    // reasons, and a blanket rule gets one of them wrong:
    //
    // - `node_modules` is a *different install graph*, so following it would make this digest depend
    //   on a tree the link does not own.
    // - this toolchain's own artifacts (`.fgc/`, `fgc.lock.json`, `fgc-evidence/`) are its *output*
    //   about the project, and a project carrying them has them inside the target being digested.
    //   Measured: including them made the identity change on every read of an unchanged tree, and
    //   made it self-referential — read the identity, write the lock, read it again in one process and
    //   the two values differed. An identity that cannot survive recording its own evidence carries
    //   no information, and it would re-measure for ever.
    //
    // Everything else is included, dot-named or not: `exports: { ".": "./.generated/index.js" }` is
    // an ordinary way to publish a package, and excluding it on the grounds that a dot implies
    // "manager bookkeeping" left that file invisible (review round 9, measured).
    if (entry.name === "node_modules" || isToolchainArtifact(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectPackageFiles(path, root);
      if (nested === null) {
        return null;
      }
      files.push(...nested);
      continue;
    }
    if (!entry.isFile()) {
      // A symlink or socket inside the target: its content is elsewhere, so this digest cannot claim
      // to have covered it.
      return null;
    }
    const bytes = await readFile(path).catch(() => null);
    if (bytes === null) {
      return null;
    }
    // Paths relative to the link's own root, so a checkout in another directory composes the same
    // identity. Separators normalized for the same reason.
    const relative = relativePath(root, path).split(/[\\/]/).join("/");
    files.push(`${relative}:${digestOfBytes(bytes)}`);
  }
  files.sort();
  return files;
}
