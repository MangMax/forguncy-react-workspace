/**
 * Which lockfile describes a project's install, and where it lives (#161).
 *
 * Split mechanically out of `install-identity.ts`; the reasoning is the moved comments' own.
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { digestOf, digestOfBytes, isInside, readBinaryFile, readTextFile } from "./primitives.ts";

/**
 * Lockfiles this toolchain recognizes, in preference order.
 *
 * One is chosen rather than all of them hashed: a project has one install graph, and hashing every
 * lockfile present would make an unrelated stray `yarn.lock` invalidate evidence about a pnpm
 * install. First match wins, and the order is the order these managers are supported in.
 */
export const RECOGNIZED_LOCKFILE_NAMES: readonly string[] = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

/**
 * Lockfiles that are **not** text, and so are digested as raw bytes.
 *
 * `bun.lockb` is Bun's binary lockfile (Bun moved its default to the text `bun.lock` in 1.2, but
 * older projects still carry the binary one). Reading it as UTF-8 is not merely lossy: invalid
 * byte sequences are replaced with U+FFFD, so two *different* byte strings can decode to the same
 * string. Measured — `[0x41, 0xff, 0x42]` and `[0x41, 0xfe, 0x42]` both decode to `"A�B"` and
 * composed the identical digest, which means a lockfile edit could leave the identity unchanged.
 *
 * For these files the digest is over the raw bytes and carries **no** line-ending normalization:
 * a binary file has no line-ending convention, and rewriting bytes that are not text would be a
 * different distortion of the same kind.
 */
const BINARY_LOCKFILE_NAMES: ReadonlySet<string> = new Set(["bun.lockb"]);

/**
 * One lockfile that some ancestor holds, and where.
 *
 * `digest` is the file's content identity: text files are digested with line-ending normalization,
 * binary ones from their raw bytes (see {@link BINARY_LOCKFILE_NAMES}).
 */
export interface LockfileClaim {
  readonly directory: string;
  readonly name: string;
  readonly digest: string;
}

/** Why no single lockfile could be identified. */
export type InstallLockfileResult =
  | { readonly kind: "found"; readonly claim: LockfileClaim }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

/**
 * The one lockfile that describes this project's install, or why it cannot be named.
 *
 * **Ancestors, not just the project root**, because a workspace member has no lockfile of its own
 * and resolves through its workspace root's install — the shape `examples/probe-proving-cases` has
 * in this repository (measured: it declares `es-toolkit` and resolves it from the root's
 * `node_modules`, with the lockfile two levels up). Reading only `projectRoot` would report
 * `install-graph-unknown` for a project whose install graph is perfectly well described, and
 * withhold decisions the compiler accepts — the same misdirection as reporting a missing dependency
 * because the *project's* manifest was corrupt (#89).
 *
 * **Every ancestor is counted, and a claim that cannot own this install is dropped before the
 * count.** This is the part a first-match walk got wrong, and it is not hypothetical: a workspace
 * member keeps its own `node_modules` (so it looks self-contained) and often does *not* re-declare
 * the root's `packageManager`. Measured — a member holding a leftover `package-lock.json`, with the
 * real `pnpm-lock.yaml` one level up and dependencies resolving from the root's `node_modules`: the
 * walk stopped at the member, hashed a lockfile that describes no install, and the digest stayed put
 * while the root lock and its transitive dependencies moved. A lockfile's *presence* is not proof
 * that it owns the install this project resolves in, and guessing which one does is how that false
 * fresh happens. What remains after that filter is resolved by counting: zero or two surviving
 * claims is still `unknown`.
 *
 * Each directory is asked only about the names its **own** manifest claims (see
 * {@link candidateNamesFor}), which narrows only on an **installed** manager and otherwise keeps
 * every recognized name. `unreadable` short-circuits to `unknown` rather than being skipped:
 * reporting an identity taken from a different file would describe an install this process never
 * read.
 */
export async function findInstallLockfile(projectRoot: string): Promise<InstallLockfileResult> {
  // Absolute before the walk, so the ancestor search is over real directories rather than over the
  // caller's spelling of them. A relative root would still walk, but `dirname` on it eventually
  // reaches `""` and then `"."`, and the loop would terminate on a path that means "wherever the
  // process happens to be" — an identity that depends on the cwd.
  let directory = resolve(projectRoot);
  const claims: LockfileClaim[] = [];

  for (;;) {
    const names = candidateNamesFor();
    for (const name of names) {
      const path = join(directory, name);
      // A binary lockfile is digested from its bytes: decoding it first would let two distinct byte
      // strings compose one digest (`BINARY_LOCKFILE_NAMES` carries the measurement).
      if (BINARY_LOCKFILE_NAMES.has(name)) {
        const state = await readBinaryFile(path);
        if (state.kind === "unreadable") {
          return { kind: "unknown" };
        }
        if (state.kind === "read") {
          claims.push({ directory, name, digest: digestOfBytes(state.bytes) });
        }
        continue;
      }

      const state = await readTextFile(path);
      if (state.kind === "unreadable") {
        return { kind: "unknown" };
      }
      if (state.kind === "read") {
        claims.push({ directory, name, digest: digestOf(state.text) });
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  if (claims.length === 0) {
    return { kind: "none" };
  }

  // Keep only the claims that can plausibly own this project's install, using the same attribution
  // rule the single-claim path already applies. A claim whose own `node_modules` does not contain the
  // nearer tree's entries **cannot** own it, and counting it as an ambiguity made every project
  // nested under an unrelated lockfile — a stray `~/package-lock.json` is the ordinary shape — report
  // `unknown` forever, with no fix available short of deleting a file that is not the project's.
  // Measured on a developer machine: a temp project with its own `node_modules` and its own lockfile
  // reported an all-null graph because `~` happened to hold an 81-byte `package-lock.json`, which
  // silently disabled #94/#95's identity for every project under that home directory.
  //
  // "Cannot say" is **kept** as a candidate, never dropped: dropping an unattributable-but-unreadable
  // claim would let a nearer leftover lockfile win by default, which is the false fresh the ambiguity
  // rule exists to prevent (#94 review round 2). So a claim that fails attribution *definitively* is
  // dropped; a claim whose attribution could not be established makes the whole answer `unknown`.
  const candidates: LockfileClaim[] = [];
  let attributionUndecidable = false;
  for (const claim of claims) {
    const attribution = await nearerInstallIsAttributableTo(resolve(projectRoot), claim.directory);
    if (attribution === "attributable") {
      candidates.push(claim);
    } else if (attribution === "unknown") {
      candidates.push(claim);
      attributionUndecidable = true;
    }
  }

  if (candidates.length === 0 || candidates.length > 1 || attributionUndecidable) {
    // No claim can own it, two can, or one cannot be established: all three mean this process cannot
    // name the install. Reported rather than guessed, as #94's third criterion requires.
    return { kind: "unknown" };
  }
  return { kind: "found", claim: candidates[0]! };
}

/**
 * Whether every `node_modules` between `projectRoot` and `installRoot` belongs to `installRoot`'s
 * install, rather than to a closer one that no lockfile in the walk describes.
 *
 * **Why this is needed.** The walk finds the nearest ancestor *holding a lockfile*, but resolution
 * finds the nearest `node_modules` holding a *name* — and those are different questions. A
 * subproject with its own `node_modules` and no lockfile of its own resolves out of its own tree
 * first, while the only claim the walk sees is the parent's lock; the parent's lock then describes
 * an install that is not the one being measured, and its digest cannot move when the measured tree
 * does.
 *
 * **How it is decided.** A manager's install is *shared* by the members of its workspace through
 * symlinks: in this repository a member's `node_modules/@tanstack/react-query` is a link whose
 * realpath lands inside the root's `node_modules/.pnpm/…` (measured). An entry that already resolves
 * inside `installRoot` is therefore attributable to it, and a nearer tree made only of such entries
 * is the same install. An entry that resolves *outside* — a real directory, or a link elsewhere — is
 * a different install this walk cannot describe.
 *
 * **Three answers, because "no" and "cannot say" lead to different decisions.** A claim that is
 * definitely *not* attributable cannot own this install, and `findInstallLockfile` drops it before
 * counting ambiguity — otherwise an unrelated ancestor lockfile (a stray `~/package-lock.json`)
 * makes every project below it `unknown` with no project-side fix. A claim whose attribution cannot
 * be established is `unknown`, and the caller **keeps** it so the ambiguity is still reported;
 * folding it into `not-attributable` would let a nearer leftover lockfile win by default, which is
 * the false fresh this check exists to prevent.
 */
async function nearerInstallIsAttributableTo(
  projectRoot: string,
  installRoot: string,
): Promise<"attributable" | "not-attributable" | "unknown"> {
  // The directories strictly between the project and the install root, plus the project itself. The
  // install root's own `node_modules` is by definition its install, so it is not examined.
  const directories: string[] = [];
  let directory = projectRoot;
  for (;;) {
    if (directory === installRoot) {
      break;
    }
    directories.push(directory);
    const parent = dirname(directory);
    if (parent === directory) {
      // The project is not under the install root at all (a sibling tree resolved by some other
      // route), so this claim provably does not own it.
      return "not-attributable";
    }
    directory = parent;
  }

  // The containment target, resolved lazily: a project with no `node_modules` anywhere has nothing
  // to attribute and nothing to contradict, so it stays attributable without ever needing the
  // target. Resolving eagerly would make that case `unknown` for no reason — and it is the ordinary
  // state of a project whose install has not been run yet.
  //
  // **Absent and unreadable are kept apart.** A claim whose own `node_modules` does not exist cannot
  // own an entry that does, so it is `not-attributable`; a `node_modules` this process could not
  // canonicalize might own it, so it is `unknown`. Collapsing the two made an unrelated ancestor
  // lockfile with no install of its own (the stray `~/package-lock.json` shape) ambiguous forever.
  type InstallTree = { readonly kind: "found"; readonly path: string } | { readonly kind: "absent" } | { readonly kind: "unknown" };
  let canonicalInstallTree: InstallTree | undefined;
  const installTree = async (): Promise<InstallTree> => {
    if (canonicalInstallTree === undefined) {
      // **Canonicalized**, and that is not tidiness: the entry below is `realpath`'d while
      // `installRoot` arrives as whatever the walk spelled, so the two can differ for one directory.
      // Measured on Windows, where a runner's temp directory is an 8.3 short path
      // (`C:\Users\RUNNER~1\…`) that `realpath` expands to `runneradmin`: comparing an expanded entry
      // against a short root made `isInside` false for every package, so every install reported
      // `unknown`. That direction is fail-closed, but it disables the attribution check for a real
      // project on a real runner.
      canonicalInstallTree = await realpath(join(installRoot, "node_modules")).then(
        path => ({ kind: "found" as const, path }),
        (error: unknown) => {
          const code = (error as { readonly code?: unknown } | null)?.code;
          return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" as const } : { kind: "unknown" as const };
        },
      );
    }
    return canonicalInstallTree;
  };

  for (const candidate of directories) {
    const nodeModules = join(candidate, "node_modules");
    let entries: string[];
    try {
      entries = await readdir(nodeModules);
    } catch (error) {
      const code = (error as { readonly code?: unknown } | null)?.code;
      // Absent is the normal case for the directories in between: nothing to attribute.
      if (code === "ENOENT" || code === "ENOTDIR") {
        continue;
      }
      // Present and unreadable is "cannot say", not "no install here".
      return "unknown";
    }

    // Every package directory at this level, with scopes expanded one level so `@scope/name` entries
    // are examined as the packages they are rather than skipped as a name that starts with `@`.
    const packagePaths: string[] = [];
    for (const entry of entries) {
      // Dot entries (`.bin`, `.package-lock.json`, and the install root's own `.pnpm`) are not
      // packages, so they say nothing about which install a name resolves to.
      if (entry.startsWith(".")) {
        continue;
      }
      const path = join(nodeModules, entry);
      if (entry.startsWith("@")) {
        let scoped: string[];
        try {
          scoped = await readdir(path);
        } catch {
          return "unknown";
        }
        for (const name of scoped) {
          if (!name.startsWith(".")) {
            packagePaths.push(join(path, name));
          }
        }
        continue;
      }
      packagePaths.push(path);
    }

    for (const packagePath of packagePaths) {
      let resolved: string;
      try {
        // `realpath` follows a workspace link to the store path it points at, which is what makes
        // "is this the same install" answerable at all.
        resolved = await realpath(packagePath);
      } catch {
        return "unknown";
      }
      // A workspace dependency is a *source* link, not an install: `node_modules/@app/ui` is a
      // symlink to the workspace's own `packages/ui`, whose files are in no store and carry no
      // lockfile of their own. Treating it as an outside tree made every workspace member with a
      // shared package report `install-graph-unknown` — measured on this repository's own
      // `examples/*` (#99), where a consumer project with one shared UI package could not have any
      // record judged fresh. The entry is skipped only when it is a link *into this workspace* and
      // its target is not itself under a `node_modules`, which is exactly what separates source
      // from a second install.
      if (await isWorkspaceSourceLink(packagePath, resolved, installRoot)) {
        continue;
      }
      // The install a lockfile describes is the one under **its own `node_modules`** — that is where
      // its tree lives (and, for pnpm, where `.pnpm/` is). Checking "under the install root
      // directory" instead would accept a subproject's tree, because a subproject is *inside* the
      // root's directory while having nothing to do with the root's install.
      const target = await installTree();
      // A root with no tree at all cannot own an entry that exists; one whose tree this process
      // could not canonicalize might, so that one is `unknown`. An entry that resolves outside the
      // root's tree is definitively a different install.
      if (target.kind === "absent") {
        return "not-attributable";
      }
      if (target.kind === "unknown") {
        return "unknown";
      }
      if (!isInside(target.path, resolved)) {
        return "not-attributable";
      }
    }
  }

  return "attributable";
}

/**
 * Whether a nearer `node_modules` entry is a symlinked workspace-source package of this install.
 *
 * Three conditions, and each excludes a shape the attribution check must still refuse:
 *
 * 1. **It is a symlink.** A real directory under a nearer `node_modules` is a separate install's
 *    package, which is the case the check exists to catch. A workspace dependency is always linked.
 * 2. **It resolves inside the install root.** A link to somewhere else on the machine is a
 *    different tree by definition.
 * 3. **Its target is not under any `node_modules`.** A link into `<root>/node_modules/.pnpm/…` is
 *    the install's own package — already attributable without this branch — while a link into a
 *    nested project's `node_modules` is that project's install, not this one. Workspace source
 *    (`<root>/packages/ui`) has no `node_modules` segment, which is what makes it source.
 *
 * Only condition 1 can fail "readably": an `lstat` error makes this `false`, so the entry is judged
 * by the ordinary rule and an unreadable tree still reports `unknown` rather than being waved
 * through. Fail-closed, in the same direction as the rest of this module.
 */
async function isWorkspaceSourceLink(packagePath: string, resolved: string, installRoot: string): Promise<boolean> {
  let link: Awaited<ReturnType<typeof lstat>>;
  try {
    link = await lstat(packagePath);
  } catch {
    return false;
  }
  if (!link.isSymbolicLink()) {
    return false;
  }
  const canonicalRoot = await realpath(installRoot).catch(() => resolve(installRoot));
  if (!isInside(canonicalRoot, resolved)) {
    return false;
  }
  return !resolved.split(/[\\/]/).includes("node_modules");
}

/**
 * The lockfile spellings each manager can write, **unordered**.
 *
 * An ordering here would be a claim about which spelling that manager prefers, and for npm that
 * claim is version-dependent in a way this module cannot model safely: npm 11 documents
 * `npm-shrinkwrap.json` as taking precedence over `package-lock.json`, so an order of
 * `[package-lock, shrinkwrap]` hashes the file npm ignores. Measured: with both present and a
 * `packageManager` of `npm@11.0.0`, editing the *effective* shrinkwrap left the digest
 * byte-identical while editing the shadowed lock moved it — exactly backwards.
 *
 * A hardcoded order cannot be repaired by reversing it either, because the rule is not stable
 * across versions and this module has no verified model of npm 12. So the candidates are a *set*
 * and {@link findInstallLockfile} answers `unknown` when more than one is present. That is
 * the conservative direction #94 asks for: an identity that cannot be established must not be
 * presented as a complete one, and "unknown" costs a re-measurement while a wrong choice ships
 * stale evidence.
 */
/** The package managers whose lockfile spellings this toolchain knows. */
export type ManagerKind = "pnpm" | "npm" | "yarn" | "bun";

export const LOCKFILES_BY_MANAGER: Readonly<Record<string, readonly string[]>> = {
  pnpm: ["pnpm-lock.yaml"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

/**
 * The inverse of {@link LOCKFILES_BY_MANAGER}: the manager a lockfile name belongs to.
 *
 * Derived from that table rather than written out again, so a spelling added there cannot be
 * forgotten here — the two are the same fact from opposite ends, and a hand-copied second list is
 * the "second copy of a rule" this repository keeps finding.
 */
export const MANAGER_BY_LOCKFILE: Readonly<Record<string, ManagerKind>> = Object.fromEntries(
  Object.entries(LOCKFILES_BY_MANAGER).flatMap(([manager, names]) =>
    names.map(name => [name, manager as ManagerKind] as const),
  ),
);

/**
 * The lockfile names a directory can be the install root of — every recognized name, always.
 *
 * **Neither the declaration nor installed-manager evidence narrows this**, and both halves of that
 * are deliberate.
 *
 * The declaration must not: an earlier revision selected by the manifest's `packageManager`, and
 * review showed why that repeats the mistake #94 was written about. A project declaring `pnpm` can
 * have had `npm install` run in it — Corepack does not intercept `npm` (its shims are not installed
 * by default, so `npm` resolves to the Node-bundled copy) — and then `package-lock.json` describes
 * the current install while the declared `pnpm` lockfile is stale. Measured: with a declared
 * `pnpm@11`, a stale `pnpm-lock.yaml` and a live `package-lock.json`, moving the npm transitive
 * dependency left the identity byte-identical, because the real lockfile had been excluded.
 *
 * **Installed-manager evidence does not narrow it either**, and that was measured rather than
 * assumed. A manager's own marker (`node_modules/.modules.yaml` for pnpm, which even names the
 * version that ran; `node_modules/.package-lock.json` for npm) was tried as the selector and then
 * removed for two reasons:
 *
 * - It **changed no outcome.** It narrowed only when every other recognized name was absent — and
 *   then those names contributed no claim anyway, so the collected set was identical. Measured:
 *   `"pnpm marker + pnpm lock only"` and `"no marker + pnpm lock only"` both resolve, and both
 *   ambiguity cases stay `unknown` either way.
 * - It **can be stale, in the unsafe direction.** Markers accumulate: an old pnpm install followed
 *   by `npm install` leaves `.modules.yaml` *and* `.package-lock.json`, and an old lockfile beside
 *   them. A selector trusting the marker would then pick the stale lockfile — measured, both markers
 *   present with both lockfiles. Counting claims instead reports `unknown`, which is safe.
 *
 * So the names stay a set, and ambiguity is resolved by counting claims in
 * {@link findInstallLockfile} — the direction that can only *add* a claim.
 */
const candidateNamesFor = (): readonly string[] => RECOGNIZED_LOCKFILE_NAMES;
