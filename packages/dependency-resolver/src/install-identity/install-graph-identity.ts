/**
 * The install-graph identity, and which manager's tree record answers for it (#161).
 *
 * Split mechanically out of `install-identity.ts`; the reasoning is the moved comments' own.
 */
import type { InstallGraphIdentity } from "@forguncy-react-workspace/core";

import { configurationDigest, patchesDigest, readProjectManifest, readWorkspaceConfig } from "./config-digests.ts";
import { findInstallLockfile, MANAGER_BY_LOCKFILE } from "./lockfile-discovery.ts";
import { npmInstalledTreeDigest } from "./npm-tree.ts";
import { pnpmInstalledTreeDigest } from "./pnpm-tree.ts";

/**
 * The install graph identity for `projectRoot`.
 *
 * Never throws: every failure to establish a component is reported as `null` in that component,
 * and freshness turns `null` into a stale answer. Throwing here would turn "you have not run
 * install yet" into a crash in the middle of an Agent flow, which is the same choice
 * `install-graph.ts` makes for an unresolved version.
 */
export async function readInstallGraphIdentity(projectRoot: string): Promise<InstallGraphIdentity> {
  const lockfile = await findInstallLockfile(projectRoot);
  if (lockfile.kind !== "found") {
    // No ancestor owns an install this toolchain can name — or more than one appears to. Either way
    // there is no graph to describe confidently, and the answer is unknown rather than an identity
    // over the project's own files: those files would describe a resolution *request*, which is the
    // reading #94 exists to replace.
    return { lockfile: null, patches: null, configuration: null };
  }

  // The install root is the directory the single lockfile claim came from, so the patches and
  // configuration are read from **there** rather than from `projectRoot`: overrides and patches are
  // declared where the install is, so a workspace member's `patchedDependencies` live in the root's
  // `pnpm-workspace.yaml`. Reading them one level down would report "no patches" for a project
  // whose install carries them, and the record would look fresh through exactly the change this
  // axis exists to catch.
  const installRoot = lockfile.claim.directory;
  const [workspace, manifest] = await Promise.all([
    readWorkspaceConfig(installRoot),
    readProjectManifest(installRoot),
  ]);

  const [patches, configuration, installedTree] = await Promise.all([
    patchesDigest(installRoot, workspace, manifest),
    configurationDigest(installRoot, workspace, manifest),
    // The claim's own lockfile decides which manager's record to read, so a stale marker from a
    // previous manager cannot answer for the one that is actually installed (see the function).
    installedTreeDigest(installRoot, lockfile.claim.name),
  ]);

  return { lockfile: lockfile.claim.digest, patches, configuration, installedTree };
}

/**
 * What the package manager actually installed, from its own on-disk record, or `null` when it
 * writes none this toolchain can read.
 *
 * **Why this exists at all.** Every other component describes an input, and review showed inputs
 * cannot confirm a result: part of the effective install is decided by *install-time* parameters
 * that reach no digest. npm derives its `omit` default from `process.env.NODE_ENV` and accepts
 * `--omit=optional`, and neither is recorded in `package-lock.json` or `.npmrc`. Measured end to
 * end: on one real npm project, a default install puts `@rolldown/binding-win32-x64-msvc` on disk
 * while `npm install --omit=optional` does not, and both runs leave a **byte-identical**
 * `package-lock.json` — so every earlier component composed the same digest while the tree a probe
 * would measure had changed.
 *
 * **pnpm** writes `node_modules/.modules.yaml`, and two of its fields are exactly this fact:
 *
 * - `included` — which dependency classes were installed. Measured: `pnpm install --no-optional`
 *   flips `optionalDependencies` to `false` and drops the platform binding from disk.
 * - `nodeLinker` — the layout (`isolated` / `hoisted`), which decides what a `node_modules` tree
 *   even looks like.
 *
 * Both are **portable**, which is why they are the fields chosen: measured, they are plain booleans
 * and a short enum with no machine path. `skipped`, by contrast, lists other platforms' bindings and
 * would make the digest churn between a Windows and a Linux checkout of one project — the same
 * defect the CRLF normalization in `digestOf` exists to avoid.
 *
 * **npm** writes `node_modules/.package-lock.json`, the materialized entry set. It captures the
 * result (the omitted binding is absent from it — measured) and it is deliberately hashed as-is,
 * including the platform-specific entry names: those really are different installs, and the honest
 * answer is that a record measured on one does not describe the other.
 *
 * **Which record is read follows the lockfile the walk already identified**, and that is a
 * correctness requirement rather than a tidy-up. Choosing by first match re-trusted the accumulated
 * markers review had already measured: a project that ran `pnpm install` and later `npm install`
 * keeps **both** markers, so with `pnpm-lock.yaml` deleted — the migration case — the walk correctly
 * identifies npm while a first-match read still preferred the stale `.modules.yaml`. Measured: npm's
 * materialized entry set changed under `--omit=optional` and `installedTree` did not move.
 *
 * So the manager comes from the claim: pnpm's lockfile reads pnpm's record, npm's reads npm's. A
 * manager whose record this toolchain cannot read — yarn, bun — is `null`, and so is a claim whose
 * manager has no record reader at all. Inventing a marker would be the guess #94 exists to remove.
 */
export async function installedTreeDigest(installRoot: string, lockfileName: string): Promise<string | null> {
  const manager = MANAGER_BY_LOCKFILE[lockfileName] ?? null;
  if (manager === "pnpm") {
    return pnpmInstalledTreeDigest(installRoot);
  }
  if (manager === "npm") {
    return npmInstalledTreeDigest(installRoot);
  }
  // yarn, bun, or a lockfile name with no reader: the result record is not something this toolchain
  // can verify, so the answer is `unknown` rather than a value taken from a different manager's file.
  return null;
}
