/**
 * The content identity of every workspace/link target reached from `node_modules` (#161).
 *
 * Split mechanically out of `install-identity.ts`; the reasoning is the moved comments' own.
 */
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { compareCodeUnits } from "@forguncy-react-workspace/core";

import {
  canonicalJson,
  collectPackageFiles,
  digestOf,
  directoryExists,
  isInside,
  isToolchainArtifact,
} from "./primitives.ts";

/**
 * Content identity of every **workspace/link target** reached from `node_modules`, or `null` when
 * one cannot be read.
 *
 * **Why this is a component of its own.** Review round 8: a workspace dependency is materialized as
 * a symlink out of the install tree — measured, both managers do this identically, pnpm linking
 * `node_modules/bar` to `packages/bar` and npm recording `{resolved: "packages/bar", link: true}`
 * with the same symlink on disk — and *nothing* in the other digests describes the target's files.
 * So a consumer could depend on `bar@1.0.0`, the probe could be cached, and then an edit to
 * `packages/bar/src/index.js` alone would move no version, no lockfile, no link path and no store
 * entry, while Rolldown's next build reads the new source. Measured: `installedTree` byte-identical
 * across exactly that edit, with the warm cache answering from the old report.
 *
 * **What is digested.** For each link whose target lies *outside* the install tree, the sorted
 * `(relative path, content digest)` pairs of its package files, skipping `node_modules` and dot
 * directories. Paths are relative to the link's own root, so the identity is portable: the same
 * workspace package in two checkouts composes the same bytes. The link's *name* is included too, so
 * two links to one target are not silently merged into one entry.
 *
 * **Why contents and not a target path.** A path is what the previous revision recorded, and it is
 * exactly what does not move when the source does — the defect this exists for. Digesting the tree
 * is the conservative answer, and it is affordable because these targets are source packages:
 * measured at 2–3 files in this repository's own workspace examples.
 *
 * **The cost, stated rather than discovered later.** A linked package that is *built* into a
 * gitignored `dist/` churns this digest: the output appears, the identity moves, and a record is
 * re-probed although the declared source never changed. That is a false *stale* — the direction this
 * axis has chosen over a false *fresh* at every round — and narrowing it (say, to the files the
 * probe's build actually reached) would mean guessing which files those are, which is the bundler's
 * answer rather than this module's. No fixture or example in this repository has a linked package
 * with build output today, so nothing here depends on the churn either way.
 *
 * `null` when a target cannot be read, which the caller reports as `unknown` — the fail-closed
 * direction, and the one the third criterion asks for.
 */
export async function linkTargetsDigest(installRoot: string): Promise<string | null> {
  const nodeModules = join(installRoot, "node_modules");
  const canonicalTree = await realpath(nodeModules).catch(() => null);
  if (canonicalTree === null) {
    return null;
  }

  const links: { readonly name: string; readonly files: readonly string[] }[] = [];
  const seenTargets = new Set<string>();

  // Every `node_modules` location under the install root, not just the top one. Review round 9: a
  // root-only walk finds only the links a manager *hoisted*, and both managers legitimately place a
  // transitive workspace dependency below that. Measured on a real pnpm isolated install — `b` is
  // linked only from `packages/a/node_modules` (a's dependency position), is absent from the root
  // `node_modules` entirely, and is still resolvable from `a`; editing its source moved no digest.
  // npm's hidden lock records the same shape (`node_modules/a/node_modules/b`). So the link set is
  // enumerated from the materialized tree, which is what the manager built, rather than guessed from
  // a directory shape that only holds for hoisted installs.
  const locations: string[] = [];
  // Whether the walk saw the **whole** tree. Review round 10: hitting the depth bound or failing to
  // read a subtree is not the same as "there was nothing there", and treating them alike is how a
  // false fresh returns — a link below the bound stays unseen and its target's source edits move
  // nothing. So an incomplete walk propagates as `unknown` rather than as an empty result.
  //
  // The budget counts **`node_modules` locations, not ordinary directories**, and that distinction is
  // the difference between usable and useless. Review measured 200 directories past a bound of 6
  // counted that way — `node_modules/.pnpm/@babel+parser@7.29.8/node_modules/@babel/parser/lib` and
  // a skills template's `.github/workflows` alike — so a bound on ordinary depth reports `unknown` for
  // a perfectly readable install. Only the nesting of installs is a bound worth having: each one is a
  // graph this walk has to descend into again, and that is both the cost and the cycle risk.
  const collectLocations = async (directory: string, depth: number): Promise<boolean> => {
    if (depth > MAX_LINK_SEARCH_DEPTH) {
      return false;
    }
    let dirents: Dirent[];
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      // A directory that is absent is not an incomplete view of one that exists; anything else is.
      const code = (error as { readonly code?: unknown } | null)?.code;
      return code === "ENOENT" || code === "ENOTDIR";
    }
    for (const entry of dirents) {
      if (!entry.isDirectory()) {
        continue;
      }
      // Skip this toolchain's own scratch/output directories (`.fgc/`, `fgc-evidence/`) — matching
      // `collectPackageFiles` — and `.git/`: neither is part of the project's install graph, and
      // descending into `.fgc/` causes concurrent scratch runs to race with `readdir(location)`.
      if (isToolchainArtifact(entry.name) || entry.name === ".git") {
        continue;
      }
      const path = join(directory, entry.name);
      let complete: boolean;
      if (entry.name === "node_modules") {
        locations.push(path);
        // A `node_modules` inside the tree can itself contain one (npm's nested install), and pnpm's
        // virtual store puts each package's own `node_modules` under `.pnpm/<name>@<version>/` — so
        // nesting an install is what consumes the budget.
        complete = await collectLocations(path, depth + 1);
      } else {
        // An ordinary directory costs nothing: a long workspace path or a deep `lib/` inside a store
        // entry is still the same install, and charging for it would report `unknown` for every
        // ordinary project (measured: 200 directories past the bound that way).
        complete = await collectLocations(path, depth);
      }
      if (!complete) {
        return false;
      }
    }
    return true;
  };
  if (!(await collectLocations(installRoot, 0))) {
    return null;
  }

  for (const location of locations) {
    let entries: string[];
    try {
      entries = await readdir(location);
    } catch {
      return null;
    }

    for (const entry of entries) {
      // A package name never starts with a dot, so this cannot skip a link — and it avoids
      // descending into `.pnpm`'s bookkeeping on a name that is not a package.
      if (entry.startsWith(".")) {
        continue;
      }
      const names = entry.startsWith("@")
        ? await readdir(join(location, entry)).then(scoped => scoped.map(name => `${entry}/${name}`)).catch(() => null)
        : [entry];
      if (names === null) {
        return null;
      }

      for (const name of names) {
        const path = join(location, ...name.split("/"));
        // `lstat` first, and that is a measured requirement rather than a micro-optimization.
        // Resolving *every* entry cost 10.5 s on this repository's own install, because
        // `realpath` on a Windows junction is ~20 ms and the walk visits hundreds of them; gating on
        // `lstat` brought it to 776 ms. `lstat` does not follow the link, so it reports a junction as
        // a link (verified on this platform) while a real directory inside the tree is not one — and
        // a real directory inside the tree cannot escape it, so skipping it costs no coverage.
        let isLink: boolean;
        try {
          isLink = (await lstat(path)).isSymbolicLink();
        } catch {
          return null;
        }
        if (!isLink) {
          continue;
        }

        let resolved: string;
        try {
          // `realpath` follows the link, so this is the tree resolution would actually reach.
          resolved = await realpath(path);
        } catch {
          return null;
        }
        if (isInside(canonicalTree, resolved)) {
          continue;
        }
        // The same target linked from two dependency positions is one package installed once; digesting
        // it twice would make the identity depend on how many places a manager happened to record it.
        if (seenTargets.has(resolved)) {
          continue;
        }
        seenTargets.add(resolved);

        // A target that escapes the install root carries **its own** resolution: `package-locator`
        // realpaths into it and Node and Rolldown resolve its `node_modules` first. So that tree is
        // part of what the probe will read, while this walk covers only the install root — skipping it
        // silently would leave a real dependency tree outside every identity. Review round 10,
        // measured: a `file:`/`link:` target whose `shared/node_modules/dep` moved v1 → v2 left the
        // digest byte-identical.
        //
        // Composing that tree's verifiable identity would be the precise answer; **composing it here
        // is not possible**, because the install graph it names is described by a lockfile this module
        // never reads. So an external target that brings its own `node_modules` is `unknown` — the
        // conservative side of the same requirement, and the one the third criterion asks for.
        if (!isInside(installRoot, resolved)) {
          // Present → `unknown`, because that tree is a separate install graph this module cannot
          // describe. **Unreadable** → `unknown` too, and for a different reason: the guard cannot
          // tell whether the target brings its own `node_modules`, and answering "no" would be the
          // claim it could not establish. Review round 12, measured on Linux as a non-root user:
          // `stat` of a `node_modules` inside a mode-`000` directory returns `EACCES`, which used to
          // fold into "absent" and produce a digest that read as complete.
          const ownsTree = await directoryExists(join(resolved, "node_modules"));
          if (ownsTree !== false) {
            return null;
          }
        }

        const files = await collectPackageFiles(resolved, resolved);
        if (files === null) {
          return null;
        }
        // Keyed by the link's *package name*, not by the location that found it: the identity is
        // about which package was installed, and a dependency position is an install-manager detail
        // that differs between pnpm's isolated layout and npm's hoisted one.
        links.push({ name, files });
      }
    }
  }

  links.sort((a, b) => compareCodeUnits(a.name, b.name));
  return digestOf(canonicalJson(links));
}

/**
 * How deep the link search descends below the install root.
 *
 * A bound rather than an unbounded walk, because the tree contains `node_modules` inside
 * `node_modules` and a dependency cycle among links would otherwise never terminate. Measured depths
 * in this repository's own installs: pnpm's isolated layout nests one level under
 * `.pnpm/<name>@<version>/`, npm's nested install one under the dependent package.
 *
 * **What this walk costs, measured.** Enumerating the link set reads this repository's whole install
 * (169 `node_modules` locations) and takes about **900 ms** on Windows, against 68 ms for the
 * root-only walk this replaced — so covering the transitive links costs ~13× on this axis, on a path
 * reached once per probe run and once per `vp dev` start. That is the conservative direction paying
 * for itself: without it, a transitive workspace dependency's source edit is invisible (review round
 * 9, measured).
 *
 * The 10.5 s it cost *before* the `lstat` gate in the scan loop was not this walk but
 * `realpath` on Windows junctions — see the note there. If this ever needs to get cheaper, the
 * honest lever is a manager's own materialized record rather than a shorter bound: a depth cut would
 * drop exactly the deep store layouts this walk exists to cover.
 */
const MAX_LINK_SEARCH_DEPTH = 6;
