/**
 * The toolchain identity a probe ran under (#161).
 *
 * Split mechanically out of `install-identity.ts`; the reasoning is the moved comments' own.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolchainIdentity } from "@forguncy-react-workspace/core";

import { locatePackage } from "../package-locator.ts";
import { readInstallGraphIdentity } from "./install-graph-identity.ts";

/** This package's root, so `rolldown` is resolved from the tree that actually imports it. */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The installed version of a package, resolved from `base`'s location, or null.
 *
 * `base` is made **absolute** before the lookup, and that is not a formality: `locatePackage`'s
 * host primitive (`module.findPackageJSON`) takes a `file:` URL or an absolute path and throws
 * `ERR_INVALID_URL` for a relative one. Measured — `readToolchainIdentity("examples/x")` reported
 * `vitePlus: null` while the identical project named by an absolute path reported `"0.3.2"`,
 * because the relative call was silently classified as "not installed".
 *
 * That asymmetry is exactly the class of defect #94 exists to remove: an identity that depends on
 * how a caller *spelled* a path rather than on what is installed. Every caller in this repository
 * passes an absolute root, so the bug was invisible until a test compared the two spellings — and
 * it would have surfaced as a record reported `toolchain-unknown` for a project whose toolchain is
 * perfectly well installed.
 */
async function installedVersion(base: string, request: string): Promise<string | null> {
  const location = await locatePackage(resolve(base), request);
  if (location.outcome === "failed") {
    return null;
  }
  return location.package.version ?? null;
}

/**
 * The identity a probe ran under, in the shape a lock record's `probedWith` compares against.
 *
 * One function for the probe engine, the cache, the CLI's `status` and the dev harness, so those
 * four cannot each read a different version of the same fact (#94, plan item 5).
 *
 * `vitePlus` is the only component read through the *project's* resolution; `rolldown` is read
 * through this package's, for the reason the module header gives — they are different questions
 * ("what does this project install" versus "what does this probe bundle with").
 */
export async function readToolchainIdentity(projectRoot: string): Promise<ToolchainIdentity> {
  const [vitePlus, rolldown, installGraph] = await Promise.all([
    installedVersion(join(projectRoot, "package.json"), "vite-plus"),
    installedVersion(join(packageRoot, "package.json"), "rolldown"),
    readInstallGraphIdentity(projectRoot),
  ]);

  return {
    vitePlus,
    rolldown,
    // The **exact** version, not the major line. This was the major until review round 8, on the
    // argument that only a major can change resolution while patch lines are bugfix-only — and that
    // argument is false, because a "bugfix" to the resolver *is* a behaviour change to resolution.
    // The counterexample is Node's own and it is about the primitive this module calls: 23.6.0
    // carries `module: fix async resolution error within the sync findPackageJSON`
    // (nodejs/node#56382, commit 4f77920a9d), a **minor** release of the same major, and
    // `package-locator.ts` resolves every identity through exactly that function. Under the major
    // reading both 23.5.x and 23.6.0 record `"23"`, so a package graph that moved between them
    // would leave every toolchain axis reporting "unchanged".
    //
    // The cost is the one #94's third criterion asks for: a CI runner that picks up a new 24.x
    // patch reports `toolchain-changed` and re-probes a record that would have been fine. That is a
    // false *stale*, which costs a measurement, and it is the direction this whole axis has
    // deliberately chosen over a false *fresh* at every previous review round.
    node: process.versions.node,
    installGraph,
  };
}
