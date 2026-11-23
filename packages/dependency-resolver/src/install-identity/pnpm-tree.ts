/**
 * What pnpm installed, read from its own `node_modules` records (#161).
 *
 * Split mechanically out of `install-identity.ts`; the reasoning is the moved comments' own.
 */
import type { Dirent } from "node:fs";
import { readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative as relativePath } from "node:path";

import { compareCodeUnits } from "@forguncy-react-workspace/core";
import { parse as parseYaml } from "yaml";

import { linkTargetsDigest } from "./link-targets.ts";
import {
  PNPM_MODULES_FILE,
  asPlainObject,
  canonicalJson,
  collectPackageFiles,
  digestOf,
  directoryExists,
  pathExists,
  readTextFile,
} from "./primitives.ts";

/** pnpm's `node_modules/.modules.yaml`, as the two portable fields that record the layout. */
export async function pnpmInstalledTreeDigest(installRoot: string): Promise<string | null> {
  const modules = await readTextFile(join(installRoot, "node_modules", PNPM_MODULES_FILE));
  if (modules.kind === "unreadable") {
    return null;
  }
  if (modules.kind !== "read") {
    return null;
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asPlainObject(parseYaml(modules.text));
  } catch {
    return null;
  }
  if (parsed === null) {
    return null;
  }
  // The fields that decide what is on disk *and* what resolution can reach:
  //
  // - `included` — which dependency classes were installed.
  // - `nodeLinker` — `isolated` versus `hoisted`.
  // - `hoistPattern` / `publicHoistPattern` — which undeclared packages are lifted into the root
  //   and virtual-store `node_modules`, i.e. which names Node and Rolldown can find at all. Review
  //   round 6: the CLI changes these while `included` and `nodeLinker` hold still, so omitting them
  //   left a real layout change invisible. Measured: `pnpm install --shamefully-hoist` moves
  //   `publicHoistPattern` from `[]` to `["*"]` with the other two unchanged.
  //
  // `hoistedDependencies` is deliberately **not** here, and both halves of that were measured on a
  // real install. It is not a better signal: `pnpm install --public-hoist-pattern='@rolldown/*'`
  // changed `publicHoistPattern` while `hoistedDependencies` stood still, so it would have missed
  // the very case the patterns catch. And it is not *portable*: its keys name the platform's own
  // binary — `@rolldown/binding-win32-x64-msvc` on this machine, the linux binding on CI — so
  // digesting it would make a committed lock churn between platforms, which is the portability rule
  // #94 requires and the same defect the CRLF normalization in `digestOf` exists to avoid.
  const fields = {
    included: parsed["included"],
    nodeLinker: parsed["nodeLinker"],
    hoistPattern: parsed["hoistPattern"],
    publicHoistPattern: parsed["publicHoistPattern"],
  };
  // A record missing any of them is one this toolchain cannot claim to have covered. `?? null`
  // would silently digest an absent pattern as if it were the empty one.
  if (Object.values(fields).some(value => value === undefined)) {
    return null;
  }

  // The layout fields above describe the *strategy*; the virtual store names the *result*. Review
  // round 7: with `--no-lockfile` (or a stale lock left in place), pnpm re-resolves from the
  // manifest and registry, so a transitive can move `b@1` → `b@2` while every layout field and the
  // old lockfile digest hold still. Measured: two `--no-lockfile` installs of the same tree produce
  // records that differ only in the `prunedAt` timestamp — every digestable field identical. The
  // store's directory names are the installed package identities (`is-odd@3.0.1`,
  // `@scope/pkg@2.0.0`), so they capture exactly that move.
  //
  // They are **portable**, which is why they are the signal: a directory under `.pnpm/` is
  // `name@version` (plus a peer hash), with no machine path. Platform-specific *binaries* do appear
  // when the platform's own binding is installed — measured, `@rolldown/binding-win32-x64-msvc@…` —
  // and those really are different installs, the same reasoning the npm side records deliberately.
  // **Where the store is, comes from the record rather than from a hardcoded `.pnpm`.** Review
  // round 11: pnpm writes the real location to `.modules.yaml#virtualStoreDir` and the CLI accepts
  // `--virtual-store-dir`, so a project can legitimately have its live store somewhere else while a
  // stale default `.pnpm` remains on disk. Measured: a live store at `node_modules/.alt` with a
  // leftover `.pnpm`, a fixed lockfile and identical layout fields — moving a package inside the
  // live store left this digest byte-identical, because the hardcoded path named a store the
  // install no longer used.
  //
  // The recorded value is a **machine absolute path**, so it is used only to *locate* the store and
  // never enters the digest; a relative value is resolved against `node_modules`, which is what
  // pnpm's own reader does. A value this module cannot read as a path is `unknown` rather than a
  // fall back to `.pnpm` — guessing the default is the defect this replaces.
  const storeDirectory = await pnpmStoreDirectory(installRoot, parsed["virtualStoreDir"]);
  if (storeDirectory === null) {
    return null;
  }
  // Every slot, described by the **identities** it holds: the store's own directory names for what it
  // installed, and its link graph for how those resolve against each other.
  //
  // Measured shape of a real store (this repository, pnpm 11): 111 slots, of which 99 entries are
  // symlinks into another slot — pnpm's deduplication — and 111 are the slot's own package as a real
  // directory. A registry package's identity **is** the `name@version` directory it lives in, which is
  // what round 7 established and what this round's `digests what the manager installed` test pins: a
  // transitive that moves `b@1` → `b@2` renames a slot while every layout field and the lockfile digest
  // hold still. Digesting the 8 509 files behind those directories measured **5.6 s** per read and
  // could not answer a question the names already answer.
  //
  // So each slot contributes:
  //
  // - a line for **itself**, named by the directory it lives in.
  // - a line per **link**, by the store-relative slot it points at — a real link is written absolute,
  //   and a digest carrying one would not survive a checkout elsewhere.
  //
  // Two shapes make that naming necessary rather than incidental:
  //
  // - a **scoped** package sits inside a `@scope` container directory, which is a namespace and not a
  //   package. Descending through it is not optional: reading `@babel` as a package walks into the
  //   symlinks beside it and fails, which is how a perfectly readable install came to answer
  //   `unknown`.
  // - a `file:`/injected **copy** is also a real directory, and its name does *not* move when its
  //   files do — that is `injectedDepsDigest` below, driven by the paths pnpm records.
  const store: string[] = [];
  let slots: Dirent[];
  try {
    // `withFileTypes` avoids a stat per entry, and the `node_modules` subdirectory inside the store
    // is the shared root the links point into rather than a package, so it is excluded by name.
    slots = (await readdir(storeDirectory, { withFileTypes: true })).filter(
      entry => entry.isDirectory() && entry.name !== "node_modules",
    );
  } catch {
    // No store on disk: `nodeLinker: hoisted` or an incomplete install. The layout fields above are
    // still a partial answer, but a partial answer to "what did this install" is the unknown the
    // third criterion asks for rather than a value pretending to be complete.
    return null;
  }

  for (const slot of slots.sort((a, b) => compareCodeUnits(a.name, b.name))) {
    const slotRoot = join(storeDirectory, slot.name, "node_modules");
    let names: string[];
    try {
      names = await readdir(slotRoot);
    } catch {
      return null;
    }
    // The slot is the record of one package identity, and it is recorded even when nothing below it
    // is a link — otherwise a slot that holds only its own package contributes nothing, and two
    // installs differing by exactly such a slot would digest alike.
    store.push(slot.name);
    for (const name of names.sort()) {
      // A `@scope` entry is a namespace directory holding this slot's package and links to its
      // dependencies; it is descended into rather than described, and its entries follow the same two
      // rules one level down.
      if (name.startsWith("@")) {
        const scopeRoot = join(slotRoot, name);
        let members: string[];
        try {
          members = await readdir(scopeRoot);
        } catch {
          return null;
        }
        for (const member of members.sort()) {
          const described = await describeStoreEntry(
            join(scopeRoot, member),
            `${slot.name}/${name}/${member}`,
            storeDirectory,
            store,
          );
          if (!described) {
            return null;
          }
        }
        continue;
      }
      const described = await describeStoreEntry(join(slotRoot, name), `${slot.name}/${name}`, storeDirectory, store);
      if (!described) {
        return null;
      }
    }
  }

  // Link targets last, because they are the one part of the result no manager's own record
  // describes: the store names registry packages, while a workspace dependency is a symlink out of
  // the tree whose *files* are the artifact (see `linkTargetsDigest`).
  const links = await linkTargetsDigest(installRoot);
  if (links === null) {
    return null;
  }

  // `injectedDeps` next, because a slot **name** is not the artifact it names. Review round 11: with
  // `injectWorkspacePackages`, a workspace dependency is materialized as a real directory
  // `node_modules/.pnpm/<name>@file+<name>/node_modules/<name>`, and `syncInjectedDepsAfterScripts`
  // rewrites the files *inside* it while the slot name, the lockfile and every layout field hold
  // still. Measured: syncing that copy moved nothing. So the copy's own content is digested; if a
  // recorded injected dependency cannot be read, the answer is `unknown` rather than a slot name.
  const injected = await injectedDepsDigest(installRoot, storeDirectory, parsed["injectedDeps"]);
  if (injected === null) {
    return null;
  }

  // Local `file:` slots materialized inside `.pnpm/` (`<name>@file+<encoded-path>`). Unlike
  // registry tarballs whose slot directory name carries an immutable version, a `file:` slot's name
  // encodes only its source path and stays identical when the package's source files change. Newer
  // pnpm releases list them in `.modules.yaml`'s `injectedDeps`, while pnpm 9/10 installs of
  // standalone `file:` dependencies can omit `injectedDeps` entirely — measured on Linux CI, where
  // editing and re-installing a `file:` fixture left `installedTree` unchanged. Digesting every
  // `@file+` slot directly covers all pnpm versions at zero cost for registry-only projects.
  const fileSlots: string[] = [];
  for (const slot of slots) {
    if (!slot.name.includes("@file+")) {
      continue;
    }
    const files = await storeSlotContentDigest(storeDirectory, slot.name);
    if (files === null) {
      return null;
    }
    fileSlots.push(`${slot.name}:${files}`);
  }
  fileSlots.sort();

  // Build state last, because it is the one manager field that describes something this module then
  // has to read off disk itself. Review round 11: a slot's **name** does not cover what a lifecycle
  // script left behind in it. Measured on a real registry package — `esbuild@0.25.0`, whose postinstall
  // writes `bin/esbuild` — removing that generated file left `installedTree` byte-identical, so a
  // package whose `main`/`exports` points at it could switch from buildable to missing with a warm
  // cache answering from the old probe.
  //
  // pnpm records who may build and who has not yet, but **not** what the build produced:
  //
  // | install | `allowBuilds` | `pendingBuilds` | `out.js` on disk |
  // | --- | --- | --- | --- |
  // | build ran | `{"bscript@file:vendor/b": true}` | `[]` | present |
  // | `--ignore-scripts` | `{"bscript@file:vendor/b": true}` | `["bscript@file:vendor/b"]` | absent |
  //
  // `allowBuilds` alone cannot tell those apart, which is why the record decides *whether to read*
  // and the files decide *what it is*: every slot the record implicates is digested by content.
  //
  // **What this does not cover, measured rather than assumed.** A package pnpm never approved has no
  // record naming it — an `is-odd@3.0.1` install writes `"allowBuilds": {}` and nothing else — so its
  // slot is read by name only. The alternative was to find such slots by reading each package's
  // manifest and looking for an install script: that measured **391 ms** for 292 manifests, and it is
  // not a sound signal either, because a script that exists is not a script that ran. An unapproved
  // package's build output is therefore still invisible here, and the honest report is that this axis
  // covers the builds the manager recorded rather than every build a script could have performed.
  const builds = await builtSlotsDigest(installRoot, storeDirectory, parsed, slots);
  if (builds === null) {
    return null;
  }

  return digestOf(
    canonicalJson({
      ...fields,
      store: store,
      links,
      injected,
      ...(fileSlots.length > 0 ? { fileSlots } : {}),
      builds,
    }),
  );
}

/**
 * The content of every slot pnpm's record says may have been built by a lifecycle script, or `null`
 * when one of them cannot be read.
 *
 * The store walk names slots; this reads the ones whose **content** a script produced. It is
 * deliberately scoped to the slots the record implicates rather than applied to the whole store:
 * digesting every slot measured **5.6 s** per read across 8 509 files, and the names already answer
 * the question for a package nothing built.
 *
 * Two key shapes occur, both measured, and both are matched to a slot by prefix rather than by being
 * composed: `allowBuilds` wrote `{"esbuild": true}` for a registry package and
 * `{"buildy@file:vendor/buildy": true}` for a `file:` one, while `pendingBuilds`/`ignoredBuilds`
 * wrote `name@version`. pnpm encodes a scope in a slot directory as `+` (`@esbuild+win32-x64@0.25.0`),
 * so a scoped key matches its slot only after that substitution.
 *
 * The three fields are also three **shapes**: `allowBuilds` is an object keyed by package, while
 * `pendingBuilds` and `ignoredBuilds` are **arrays** of keys (measured: `"pendingBuilds": []`,
 * `"ignoredBuilds": ["esbuild@0.25.0"]`). Reading an array as an object is not a near-miss — it reads
 * as a shape this module cannot interpret and answers `unknown`, which is how one field's container
 * would have made every install unverifiable.
 */
async function builtSlotsDigest(
  installRoot: string,
  storeDirectory: string,
  parsed: Record<string, unknown>,
  slots: readonly Dirent[],
): Promise<readonly string[] | null> {
  const implicated = new Set<string>();
  for (const field of ["allowBuilds", "pendingBuilds", "ignoredBuilds"]) {
    const value = parsed[field];
    if (value === undefined || value === null) {
      continue;
    }
    const declared = asPlainObject(value);
    if (declared !== null) {
      for (const key of Object.keys(declared)) {
        implicated.add(key);
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const key of value) {
        if (typeof key !== "string") {
          return null;
        }
        implicated.add(key);
      }
      continue;
    }
    // Present but neither object nor array is a shape this module cannot interpret, so it cannot
    // claim to know which slots were built.
    return null;
  }

  // An empty set does **not** mean "no slot was built". Review round 12 established that
  // `dangerouslyAllowAllBuilds` runs every lifecycle script regardless of `allowBuilds` and records
  // nothing about it; round 13 found the deeper reason my round-12 fix was built on the wrong thing.
  // The policy is **resolved configuration**, not installation state: pnpm's `env_overlay.rs` folds
  // `PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS` into it, and it also has user- and global-level config
  // layers. Measured: `PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS=true pnpm install` in a project with
  // **no** `.npmrc` wrote `allowBuilds: {}` / `pendingBuilds: []` and left no trace of the policy
  // anywhere on disk — not in `.modules.yaml`, not in `pnpm-lock.yaml`, not in the store. Reading the
  // environment at probe time does not fix it either: the probe's environment is not the
  // install-time witness, and the question is what the disk holds.
  //
  // **Neither alternative can be made sound, so this is `unknown`.** Measured, in order:
  //
  // - Reading the project's configuration — round 12's approach — answers "off" for the env-driven
  //   install above and returned a byte-identical digest before and after the built artifact changed.
  // - Enumerating slots whose own manifest declares `preinstall`/`install`/`postinstall` costs 300 ms
  //   and finds one buildable slot on this repository, but a dependency's install script is written by
  //   *its* publisher and does not have to be declared at all: the same fixture wrote a build output
  //   into `is-odd@3.0.1`, which declares no script, and stayed invisible.
  // - Digesting **every** slot's content catches it, and measured 12.7 s for 14 281 files — a cost
  //   every probe would pay to answer a question that is still not provable from the tree.
  //
  // So the empty record is not evidence, and the slots that could have been built are enumerated from
  // the disk instead: a dependency can only be built by a script **its own manifest declares**, so
  // those slots are digested by content and everything else stays name-only. That needs no policy and
  // no witness, and it is what catches the env-driven install above: measured on a real
  // `PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS=true pnpm install` of `esbuild`, the enumeration finds
  // exactly `esbuild@0.25.0` and reads the `bin/esbuild` its postinstall wrote.
  //
  // The cost is why this is enumeration and not a blanket pass. Measured on this repository: reading
  // **every** slot's content is 12.7 s for 14 281 files, while reading 292 manifests costs 300 ms and
  // finds **one** buildable slot (`@swc+core@1.16.2`), whose content then costs 54 ms — 354 ms to
  // answer a question 12 s would answer the same way but at thirty-four times the price.
  //
  // **The disk enumeration is not a fallback for an empty record — it is half of a union.** Review
  // round 15 closed the case where the record names nothing, and left the ordinary combined state open:
  // a project can persist `allowBuilds: { foo: true }` (an approval that outlives the package) *and*
  // install once under an ambient blanket policy, and pnpm's `check()` returns `Some(true)` for
  // everything when that policy is on. The record then still names `foo` while `esbuild` and every
  // other buildable slot were actually built. Gating the enumeration on `implicated.size === 0` read
  // only `foo`. Measured: a record naming `foo` while an ambient blanket build had also written an
  // artifact into `bar` held `installedTree` at `5b399ad50a20` when `bar`'s artifact changed.
  //
  // The policy is not persistable — no record of it exists on disk — so the question cannot be settled
  // by choosing a branch. Both sources are therefore always enumerated and **unioned**:
  //
  // - the slots the manager's record implicates, which is every build it knows about, and
  // - the slots whose own files say they can be built, which is every build the record might not know.
  //
  // When blanket builds are off, the union costs a **false stale** and nothing else: a slot declaring
  // `postinstall` that never ran is digested by content, so an edit to it reports staleness that did
  // not happen. That is the direction this axis has always chosen, and it is bounded by measurement —
  // the enumeration is 300 ms of manifests on this repository's 111 slots, plus 54 ms for the one
  // buildable slot among them.
  const byName = new Set<string>();
  for (const key of [...implicated].sort()) {
    // A key is `name` or `name@version`; a slot directory is `name@version`, with `+` for a scope.
    const slotName = key.replace("/", "+");
    const matching = slots.filter(slot => slot.name === slotName || slot.name.startsWith(`${slotName}@`));
    if (matching.length === 0) {
      // A key naming no slot here is an ordinary fact, not a gap: pnpm records an approval in
      // `package.json` and keeps it in `allowBuilds` across installs that never installed the
      // package. Measured: this repository approves `esbuild` and holds no `esbuild` slot at all,
      // while `{"@swc/core": true}` does match `@swc+core@1.16.2`. Answering `unknown` here would
      // make every project carrying a stale approval unverifiable, so the key is recorded as named
      // and the slots that do exist are read.
      byName.add(`${slotName}:absent`);
      continue;
    }
    for (const slot of matching) {
      byName.add(slot.name);
    }
  }

  const byTrigger = new Set<string>();
  for (const slot of slots) {
    const declares = await slotDeclaresInstallScript(storeDirectory, slot.name);
    if (declares === null) {
      return null;
    }
    if (declares) {
      byTrigger.add(slot.name);
    }
  }

  const digests: string[] = [];
  for (const absent of [...byName].filter(name => name.endsWith(":absent")).sort()) {
    digests.push(absent);
  }
  for (const slotName of [...new Set([...byName, ...byTrigger])].sort()) {
    if (slotName.endsWith(":absent")) {
      continue;
    }
    const files = await storeSlotContentDigest(storeDirectory, slotName);
    if (files === null) {
      return null;
    }
    digests.push(`${slotName}:${files}`);
  }
  return digests;
}

/**
 * Whether a slot's own package declares an install lifecycle script, or `null` when its manifest
 * cannot be read.
 *
 * This is what lets an empty build record be answered from the disk rather than from policy: pnpm runs
 * a dependency's install script from the slot it installed, so a slot whose manifest declares no
 * `preinstall`/`install`/`postinstall` and ships neither `.hooks/` nor `binding.gyp` has nothing pnpm
 * would have run there.
 *
 * **A declared trigger is not a claim that it ran** — a package may declare one that never executed.
 * That is harmless here because this only *selects* slots; what was read is the slot's **content**, so
 * "declared but never ran" and "ran" are told apart by the files rather than by the declaration.
 *
 * `null` on a manifest that is present and unparseable, because a manifest this module cannot read is
 * one whose build policy it cannot rule out. An absent `package.json` is not that case — pnpm has
 * already materialized the slot, so the package is present, and a package with no manifest declares
 * no script.
 */
async function slotDeclaresInstallScript(storeDirectory: string, slotName: string): Promise<boolean | null> {
  for (const root of await slotOwnPackageRoots(storeDirectory, slotName)) {
    if (root === null) {
      return null;
    }

    // **The file triggers come first and are unconditional**, which is what pnpm does and what two
    // earlier shapes of this function got wrong. Review round 15: pnpm's `pkg_build_triggers()` reads
    // `binding.gyp` / `.hooks/` from the file system and keeps those triggers whether or not the
    // manifest was readable. Reading the manifest first and `continue`-ing when it was absent skipped
    // this whole block, so a slot with a `binding.gyp` and **no** `package.json` was summarized by name
    // alone. Measured: the build artifact in such a slot changed and `installedTree` held at
    // `f141bc04fdb0`.
    //
    // **`gypfile: false` is deliberately not honoured**, and that is read rather than guessed. Out of
    // pnpm 10.13.1's bundle, `pkgRequiresBuild` is
    // `manifest_scripts || (filesIndex["binding.gyp"] != null || Object.keys(filesIndex).some(f => f.match(/^\.hooks[\/]/)))`
    // -- `gypfile` appears nowhere in the trigger module -- which matches the measurement that
    // `"gypfile": false` alongside a `binding.gyp` still ran `node-gyp rebuild`. Honouring the flag
    // would under-select and reintroduce the false fresh this axis exists to prevent.
    for (const marker of [".hooks", "binding.gyp"]) {
      const present = await pathExists(join(root, marker));
      if (present !== false) {
        // **`true` selects; `undefined` is "cannot establish".** `pathExists` is three-state precisely
        // so that an `EACCES`/`EIO` on the trigger path does not read as "there is no trigger here" --
        // the same laundering round 12 removed from the external-target guard, one function over.
        // Answering `unknown` is the only reading that failure supports.
        return present === true ? true : null;
      }
    }

    // The manifest answers only the **scripts** term; the two file triggers above cover the rest.
    const manifest = await readTextFile(join(root, "package.json"));
    if (manifest.kind === "unreadable") {
      return null;
    }
    if (manifest.kind !== "read") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest.text);
    } catch {
      return null;
    }
    const declaration = asPlainObject(parsed);
    const scripts = declaration === null ? null : asPlainObject(declaration["scripts"]);
    if (
      scripts !== null &&
      ["preinstall", "install", "postinstall"].some(name => typeof scripts[name] === "string")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The slot's own package directories, following a `@scope` container and skipping links, or a single
 * `null` when the slot cannot be read at all.
 *
 * A link inside a slot is a **dependency**, not the slot's own package — the store walk records those
 * by the slot they point at — and a `@scope` entry is a namespace directory rather than a package, so
 * it is descended into rather than read.
 */
async function slotOwnPackageRoots(storeDirectory: string, slotName: string): Promise<(string | null)[]> {
  const slotRoot = join(storeDirectory, slotName, "node_modules");
  let entries: Dirent[];
  try {
    entries = await readdir(slotRoot, { withFileTypes: true });
  } catch {
    return [null];
  }
  const roots: (string | null)[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (!entry.name.startsWith("@")) {
      roots.push(join(slotRoot, entry.name));
      continue;
    }
    const members = await scopeMembers(slotRoot, entry.name);
    if (members === null) {
      return [null];
    }
    roots.push(...members);
  }
  return roots;
}

/**
 * The content of one slot's own package, or `null` when it cannot be read.
 *
 * Deliberately the slot's own package and not everything under it: the dependency links beside it are
 * the store walk's business, and following them would re-digest the store through every slot.
 */
async function storeSlotContentDigest(storeDirectory: string, slotName: string): Promise<string | null> {
  // `slotOwnPackageRoots` decides which directory is this slot's own package, so the slot selected
  // for reading and the files read from it cannot drift apart.
  const roots = await slotOwnPackageRoots(storeDirectory, slotName);
  const collected: string[] = [];
  for (const root of roots) {
    if (root === null) {
      return null;
    }
    const files = await collectPackageFiles(root, root);
    if (files === null) {
      return null;
    }
    collected.push(...files);
  }
  return collected.length === 0 ? null : digestOf(canonicalJson(collected.sort()));
}

/** The real package directories inside a `@scope` container, or `null` when it cannot be read. */
async function scopeMembers(slotRoot: string, scope: string): Promise<string[] | null> {
  let members: Dirent[];
  try {
    members = await readdir(join(slotRoot, scope), { withFileTypes: true });
  } catch {
    return null;
  }
  const roots: string[] = [];
  for (const member of members) {
    if (!member.isSymbolicLink() && member.isDirectory()) {
      roots.push(join(slotRoot, scope, member.name));
    }
  }
  return roots;
}

/**
 * One entry inside a slot's `node_modules`, appended to the store description.
 *
 * A **link** is the store's deduplication: its identity is the slot it points at, recorded relative
 * to the store so a checkout in another directory composes the same digest. A **real directory** is
 * the slot's own package — the enclosing `name@version` directory is its identity, and a `file:`/
 * injected copy is covered by `injectedDepsDigest` from the path pnpm records — so the name already
 * says what the files would say, at a measured 5.6 s per read for the whole store instead.
 *
 * `false` when a link points outside the store, or when its target cannot be resolved: content this
 * module cannot describe by name, which the caller answers as `unknown` rather than a partial value.
 */
async function describeStoreEntry(
  path: string,
  slotRelativeName: string,
  storeDirectory: string,
  described: string[],
): Promise<boolean> {
  const link = await readlink(path).catch(() => null);
  if (link === null) {
    return true;
  }
  const resolved = await realpath(path).catch(() => null);
  if (resolved === null) {
    return false;
  }
  const target = relativePath(storeDirectory, resolved).split(/[\\/]/).join("/");
  if (target.startsWith("..")) {
    return false;
  }
  described.push(`${slotRelativeName} -> ${target}`);
  return true;
}

/**
 * Where pnpm's virtual store actually is, from the record it writes.
 *
 * `virtualStoreDir` is a **machine absolute path** on a real install (measured), and may be relative
 * when the CLI was given one, which pnpm's own reader resolves against the modules directory. Either
 * way it is used only to *locate* the store — it never enters a digest, so a lock recorded on one
 * machine still matches on another.
 *
 * `null` when the record states a value this module cannot read as a path, or when the value is
 * absent and the default is not usable. Falling back to the default unconditionally is the defect
 * round 11 removed: a project whose live store is elsewhere would then be digested from a stale one.
 */
async function pnpmStoreDirectory(installRoot: string, recorded: unknown): Promise<string | null> {
  const modulesDirectory = join(installRoot, "node_modules");
  if (recorded === undefined) {
    // No location recorded. A default store that exists is the install; one that does not means this
    // record describes an install this module cannot find.
    const defaultStore = await directoryExists(join(modulesDirectory, ".pnpm"));
    // `undefined` means the store could not be read, which is not the same as "there is no default
    // store": guessing either way is what round 11 removed.
    return defaultStore === true ? join(modulesDirectory, ".pnpm") : null;
  }
  if (typeof recorded !== "string" || recorded.trim().length === 0) {
    return null;
  }
  const value = recorded.trim();
  return isAbsolute(value) ? value : join(modulesDirectory, value);
}

/**
 * The content of every injected dependency copy pnpm materialized, or `null` when one cannot be read.
 *
 * `injectedDeps` maps a `file:`/injected dependency's **project-relative directory** to the paths of
 * the copies pnpm wrote for it, and **which** form those paths take follows the store. Measured on two
 * real installs of the same tree:
 *
 * - `--virtual-store-dir=.altstore` (inside the project) recorded `.altstore/…/file-lib`, relative to
 *   the project.
 * - `--virtual-store-dir=/tmp/gvs/globalstore` (outside it) recorded
 *   `C:/…/globalstore/gvslib@file+vendor+x/node_modules/gvslib` — **absolute**, because a global
 *   virtual store's slot is outside the project and there is no project-relative way to name it.
 *
 * So a recorded absolute path is used to *locate* the copy and is then recorded **relative to the
 * store**, exactly as `virtualStoreDir` itself is. Serializing it verbatim made two checkouts of one
 * tree disagree: measured, `0481eb99c048` versus `726bfcec6956` for identical content in two
 * directories, which is the false stale #94's portability criterion forbids.
 *
 * The **content** of each copy is what gets digested, keyed by the normalized location: with
 * `injectWorkspacePackages`, `syncInjectedDepsAfterScripts` rewrites the files inside a copy while the
 * slot name, the lockfile and every layout field hold still.
 */
async function injectedDepsDigest(
  installRoot: string,
  storeDirectory: string,
  recorded: unknown,
): Promise<readonly string[] | null> {
  if (recorded === undefined || recorded === null) {
    return [];
  }
  const declared = asPlainObject(recorded);
  if (declared === null) {
    return null;
  }

  const digests: string[] = [];
  for (const source of Object.keys(declared).sort()) {
    const copies = declared[source];
    if (!Array.isArray(copies)) {
      return null;
    }
    for (const copy of [...copies].sort()) {
      if (typeof copy !== "string") {
        return null;
      }
      const copyRoot = isAbsolute(copy) ? copy : join(installRoot, copy);
      // A relative path is already project-relative and portable. An absolute one names a slot in
      // *some* store, so it is recorded relative to the store this install uses — the same
      // normalization `virtualStoreDir` gets, and the reason two checkouts compose one identity.
      const location = isAbsolute(copy)
        ? relativePath(storeDirectory, copy).split(/[\\/]/).join("/")
        : copy.split(/[\\/]/).join("/");
      // An absolute path outside both the project and the store is content this module cannot name
      // portably, so it is `unknown` rather than a value carrying a machine directory.
      if (location.startsWith("..")) {
        return null;
      }
      const files = await collectPackageFiles(copyRoot, copyRoot);
      if (files === null) {
        return null;
      }
      digests.push(`${source}:${location}:${digestOf(canonicalJson(files))}`);
    }
  }
  return digests;
}
