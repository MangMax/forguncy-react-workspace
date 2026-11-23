/**
 * The declared patches and the resolution-affecting configuration, as digests (#161).
 *
 * Split mechanically out of `install-identity.ts`; the reasoning is the moved comments' own.
 */
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { asPlainObject, canonicalJson, digestOf, readTextFile } from "./primitives.ts";

/** The workspace configuration file pnpm reads, which is where overrides and patches are declared. */
export const WORKSPACE_CONFIG_FILE = "pnpm-workspace.yaml";

/** A parsed YAML or JSON object, or why it could not be produced. */
export type ParsedConfig =
  | { readonly kind: "absent" }
  | { readonly kind: "parsed"; readonly value: Record<string, unknown> }
  | { readonly kind: "unreadable" };

export async function readWorkspaceConfig(projectRoot: string): Promise<ParsedConfig> {
  const state = await readTextFile(join(projectRoot, WORKSPACE_CONFIG_FILE));
  if (state.kind !== "read") {
    return state;
  }
  try {
    const parsed = asPlainObject(parseYaml(state.text));
    // A YAML file whose top level is a scalar or a list is not a workspace config this toolchain
    // can read, which is an unreadable *config* rather than an absent one.
    return parsed === null ? { kind: "unreadable" } : { kind: "parsed", value: parsed };
  } catch {
    return { kind: "unreadable" };
  }
}

export async function readProjectManifest(projectRoot: string): Promise<ParsedConfig> {
  const state = await readTextFile(join(projectRoot, "package.json"));
  if (state.kind !== "read") {
    return state;
  }
  try {
    const parsed = asPlainObject(JSON.parse(state.text));
    return parsed === null ? { kind: "unreadable" } : { kind: "parsed", value: parsed };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * The `patchedDependencies` map a config declares, normalized to string→string.
 *
 * Read from **every** site a pnpm version has honoured, and the sites are measured rather than
 * assumed:
 *
 * - `pnpm-workspace.yaml#patchedDependencies` — where pnpm 11 acts on it (measured: a declaration
 *   there produces a `patch_hash=` resolution key and a patched tree).
 * - `package.json#pnpm.patchedDependencies` — the **pnpm 10 and earlier** site (pnpm#11536 records
 *   pnpm 10.33.x still reading it, with the move to the workspace file landing in 11).
 * - `package.json#patchedDependencies` (top level) — silently ignored by pnpm 12.4.2, covered
 *   because it costs nothing and guards a project that believes it declared a patch.
 *
 * **The legacy site is read rather than modelled.** Review showed the gap: under `pnpm@10.x` the
 * manager is recognized and a complete-looking identity was produced, but a patch declared at
 * `pnpm.patchedDependencies` reached only {@link configurationDigest} — which covers the *declared
 * path*, not the file's contents. Measured: keeping the lockfile and the declared path fixed and
 * editing `patches/foo.patch` moved none of the three digests, so a patch edit could not invalidate
 * anything. Reading the legacy site here fixes that without needing a version-to-site table, and a
 * site that does not apply contributes an empty map — which is the correct answer for it.
 */
function patchDeclarations(config: ParsedConfig): Record<string, string> | null {
  if (config.kind === "absent") {
    return {};
  }
  if (config.kind === "unreadable") {
    return null;
  }
  const normalized = normalizePatchMap(config.value["patchedDependencies"]);
  return normalized;
}

/** One site's declarations, normalized, or `null` when a declaration cannot be interpreted. */
function normalizePatchMap(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) {
    return {};
  }
  const record = asPlainObject(value);
  if (record === null) {
    return null;
  }
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      // A declaration this module cannot interpret is one it cannot claim to have covered, so it
      // reports unknown rather than hashing a shape it guessed at.
      return null;
    }
    normalized[key] = entry.trim();
  }
  return normalized;
}

/** One declared patch, with the content of the file it names. */
interface PatchEntry {
  readonly declaration: string;
  /** The path as the declaration spells it — repository-relative, so two checkouts agree. */
  readonly path: string;
  readonly content: string;
}

/** Resolves each declaration's file content, or `null` when one cannot be read. */
async function patchEntries(
  projectRoot: string,
  declarations: Readonly<Record<string, string>>,
): Promise<readonly PatchEntry[] | null> {
  const entries: PatchEntry[] = [];
  for (const declaration of Object.keys(declarations).sort()) {
    const path = declarations[declaration]!;
    const state = await readTextFile(join(projectRoot, ...path.split(/[\\/]/)));
    if (state.kind !== "read") {
      return null;
    }
    entries.push({ declaration, path, content: digestOf(state.text) });
  }
  return entries;
}

/**
 * The declared patch set, as one digest over every declaration and the file each names.
 *
 * Both halves are load-bearing. The **declaration** says which patches apply; the **file content**
 * says what they do, and a patch edited without a re-install is exactly the change a
 * declaration-only digest would miss.
 *
 * **Every source stays separate in the digest**, and that is a correctness requirement rather than
 * tidiness. Merging declarations into one `declaration → path` map let one site shadow another for
 * the same key — so with two sites declaring a patch for one dependency, the digest covered one
 * site's file while the package manager applied the other's. Measured: editing the *effective*
 * patch, with no re-install and an unchanged lockfile, left the digest byte-identical and the record
 * reporting `fresh` — a false fresh of exactly the class #94 removes.
 *
 * The sites are keyed individually, which is also what covers the **legacy** `pnpm@10` location
 * (`package.json#pnpm.patchedDependencies`): a patch declared there now contributes its file's
 * contents, where before only its declared path reached {@link configurationDigest} and editing the
 * file itself moved nothing.
 *
 * `null` when a declaration cannot be read or a named patch file is missing. A project with no
 * declarations yields the digest of three empty lists, which is a *known* answer rather than an
 * unknown one.
 */
export async function patchesDigest(projectRoot: string, workspace: ParsedConfig, manifest: ParsedConfig): Promise<string | null> {
  // Every site pnpm has honoured, keyed separately so none can shadow another.
  const sites: { readonly site: string; readonly declarations: Record<string, string> | null }[] = [
    {
      site: "workspace",
      declarations:
        workspace.kind === "parsed" ? normalizePatchMap(workspace.value["patchedDependencies"]) : patchDeclarations(workspace),
    },
    {
      site: "manifestTopLevel",
      declarations:
        manifest.kind === "parsed" ? normalizePatchMap(manifest.value["patchedDependencies"]) : patchDeclarations(manifest),
    },
    {
      // The pnpm 10 and earlier site (pnpm#11536).
      site: "manifestPnpm",
      declarations:
        manifest.kind === "parsed" ? normalizePatchMap(asPlainObject(manifest.value["pnpm"])?.["patchedDependencies"]) : {},
    },
  ];

  const entries: Record<string, readonly PatchEntry[]> = {};
  for (const { site, declarations } of sites) {
    if (declarations === null) {
      return null;
    }
    const resolved = await patchEntries(projectRoot, declarations);
    if (resolved === null) {
      return null;
    }
    entries[site] = resolved;
  }

  // Keyed by source, so a declaration present in two sites is two entries rather than one shadowed
  // one.
  return digestOf(canonicalJson(entries));
}

/**
 * Manager configuration files that can change the installed tree without changing a lockfile.
 *
 * Named so the set is inspectable rather than scattered through the digest:
 *
 * - `.npmrc` — npm. `omit=optional` is the measured case: omitted dependencies stay in
 *   `package-lock.json` and are only skipped on disk.
 * - `.yarnrc.yml` — Yarn. `nodeLinker` selects `node-modules` versus PnP, which decides whether a
 *   `node_modules` tree exists at all.
 * - `bunfig.toml` — Bun, whose `[install].linker` is the same choice.
 *
 * A file that does not apply to the project's manager is simply absent, which contributes a known
 * `null`.
 */
const MANAGER_CONFIG_FILES: readonly string[] = [".npmrc", ".yarnrc.yml", "bunfig.toml"];

/**
 * The configuration that affects resolution, minus the patch declarations.
 *
 * Patch declarations are excluded on purpose: they are {@link patchesDigest}'s subject, and
 * hashing them here too would report one edit as two moved components. What remains is what this
 * component owns — workspace globs, catalogs, overrides, the package-manager field, and the manager
 * configuration files that change the installed tree — so the freshness diagnostic can say *which*
 * half moved.
 *
 * `null` when any config file is present and unreadable. An absent `pnpm-workspace.yaml` is
 * normal for a non-pnpm project and is not an unknown.
 */
export async function configurationDigest(
  installRoot: string,
  workspace: ParsedConfig,
  manifest: ParsedConfig,
): Promise<string | null> {
  if (workspace.kind === "unreadable" || manifest.kind === "unreadable") {
    return null;
  }

  const workspaceFields =
    workspace.kind === "parsed"
      ? Object.fromEntries(Object.entries(workspace.value).filter(([key]) => key !== "patchedDependencies"))
      : null;

  const manifestFields =
    manifest.kind === "parsed"
      ? {
          packageManager: manifest.value["packageManager"] ?? null,
          overrides: manifest.value["overrides"] ?? null,
          resolutions: manifest.value["resolutions"] ?? null,
          pnpm: manifest.value["pnpm"] ?? null,
        }
      : null;

  // Manager configuration files that change the **installed tree without changing the lockfile**.
  // Review round 4: this module treats npm/yarn/bun lockfiles as verifiable identities, but only
  // pnpm's configuration was covered — so a non-pnpm project could change what is on disk while all
  // three digests held. Measured with npm's `omit=optional`: npm documents that omitted
  // dependencies are "still resolved and added to the package-lock.json", only "not physically
  // installed on disk", so the same lockfile describes two different trees and the record would stay
  // `fresh` across the switch.
  //
  // These are digested as **whole file contents** rather than by parsing each manager's schema: the
  // set of settings each one has that can change an install is not something this module can
  // enumerate reliably, and a parser per manager would be a second implementation to keep in step.
  // Content is the conservative answer — any edit invalidates, including one this module does not
  // understand, and a file that is absent contributes a known `null` rather than a guess.
  const managerConfigs: Record<string, string | null> = {};
  for (const name of MANAGER_CONFIG_FILES) {
    const state = await readTextFile(join(installRoot, name));
    if (state.kind === "unreadable") {
      // Present and unreadable is "cannot say", not "no config".
      return null;
    }
    managerConfigs[name] = state.kind === "read" ? digestOf(state.text) : null;
  }

  return digestOf(canonicalJson({ workspace: workspaceFields, manifest: manifestFields, managerConfigs }));
}
