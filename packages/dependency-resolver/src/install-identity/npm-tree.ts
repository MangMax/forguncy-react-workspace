/**
 * What npm installed, read from its materialized entry set (#161).
 *
 * Split mechanically out of `install-identity.ts`; the reasoning is the moved comments' own.
 */
import { join } from "node:path";

import { compareCodeUnits } from "@forguncy-react-workspace/core";

import { linkTargetsDigest } from "./link-targets.ts";
import { NPM_INSTALL_RECORD, asPlainObject, canonicalJson, digestOf, readTextFile } from "./primitives.ts";

/** npm's `node_modules/.package-lock.json`, as the materialized entry set. */
export async function npmInstalledTreeDigest(installRoot: string): Promise<string | null> {
  // Only the entry paths are read: the recorded integrity hashes duplicate the lockfile, and any
  // machine-dependent field would be the portability defect described above.
  const npmRecord = await readTextFile(join(installRoot, "node_modules", NPM_INSTALL_RECORD));
  if (npmRecord.kind === "unreadable") {
    return null;
  }
  if (npmRecord.kind !== "read") {
    return null;
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asPlainObject(JSON.parse(npmRecord.text));
  } catch {
    return null;
  }
  if (parsed === null) {
    return null;
  }
  const packages = asPlainObject(parsed["packages"]);
  if (packages === null) {
    return null;
  }

  // One entry per materialized package, carrying the portable artifact identity rather than only
  // the path. Review round 7: hashing the key *set* alone could not see an artifact change under an
  // unchanged path — the `--no-save` shape, where npm reifies a different version of a transitive
  // (and its integrity with it) while the root `package-lock.json` and the manifest stay put, then
  // saves the current tree to the hidden lock regardless. Measured: same keys, `installedTree`
  // byte-identical. `version` and `integrity` are the identity of what is on disk; `resolved` is the
  // registry URL and is portable (a URL, not a path); `link`/`workspace` entries have no version, so
  // their *type* is recorded instead — a link to somewhere is a different artifact from a copy.
  const entries = Object.entries(packages).map(([path, entry]) => {
    const record = asPlainObject(entry) ?? {};
    return {
      path,
      version: record["version"] ?? null,
      integrity: record["integrity"] ?? null,
      resolved: record["resolved"] ?? null,
      link: record["link"] ?? false,
      workspace: record["workspace"] ?? false,
    };
  });
  // Sorted by path so the digest is over the *set* of artifacts rather than over whatever order npm
  // happened to write them in.
  entries.sort((a, b) => compareCodeUnits(a.path, b.path));
  // Link targets are folded in here as well: npm records a `link: true` entry with only a relative
  // `resolved` path, which does not move when the target's source does (see `linkTargetsDigest`).
  const links = await linkTargetsDigest(installRoot);
  if (links === null) {
    return null;
  }
  return digestOf(canonicalJson({ entries, links }));
}
