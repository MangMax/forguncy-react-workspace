/**
 * The consumer project, loaded and judged once, so build / plan / sync read one answer.
 *
 * Decision sources: GitHub Issues
 * - #99 — "消费入口：提供无需内部 API 拼装的最小业务项目与 build/sync 命令"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/99), this package's Issue, and
 * - #97 — "构建入口：统一 Cell registry、别名与生产构建配置的消费路径"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/97), whose entry compiles it,
 *
 * downstream of #4 (ownership and dependency strategy) and #8 (reproducible decisions).
 *
 * ## What "loaded once" buys
 *
 * `build` writes artifacts, `plan` decides what a sync *would* do, and `sync` performs it. All
 * three must agree about the registry, the lock, which decisions survive, and which targets the
 * config declared — and the way that agreement fails silently is three stages each reading the
 * project themselves. So this module answers the project-level questions once and hands the same
 * values to every verb. It composes; it does not restate a rule:
 *
 * | question | answered by |
 * | --- | --- |
 * | which Cells exist, and where each one goes | `core`'s registry (#26), via `loadForguncyConfig` |
 * | which decisions may a local process act on | `dev-harness`'s local projection (#23) |
 * | which decisions would a *deployment* require | `dependency-resolver`'s `compilationDependencies` (#8) |
 * | which extension rows the project declared | `registry.extensionMappings` (#85/#87) |
 *
 * ## The two projections, and why both are reported
 *
 * The local projection is what the build consumes: it enforces every freshness axis this process
 * can observe, keeps a record whose only staleness is on an axis that needs a page (an
 * extension's version/identity) or a probe composer, and reports that boundary instead of hiding
 * it. The deployment projection is stricter: it additionally withholds any record whose evidence
 * never ran against a real Forguncy page. A local build is therefore *not* a validated deployment,
 * and `plan` prints both so nobody has to infer that from a green build (AGENTS.md rules 6–7).
 */

import {
  HOST_BRIDGE_MAPPINGS,
  RUNTIME_CONTRACT_TARGET,
  findLockDecision,
  forguncyTargetIdentity,
  loadForguncyConfig,
  packageNameOfModuleId,
} from "@forguncy-react-workspace/core";
import type {
  CellRegistry,
  DependencyDecision,
  FgcLockDocument,
  LockEnvironment,
  LockStalenessReason,
  LockedDependencyDecision,
} from "@forguncy-react-workspace/core";
import {
  compilationDependencies,
  composeProbeFingerprint,
  extensionCatalogOfNormalized,
  readFgcLock,
  readToolchainIdentity,
  recordedPackageNames,
  resolveInstalledVersions,
} from "@forguncy-react-workspace/dependency-resolver/local";
import type { WithheldCompilationDependency } from "@forguncy-react-workspace/dependency-resolver/local";
import { projectLocalDecisions } from "@forguncy-react-workspace/dev-harness/local-decisions";
import type { LocalDecisionProjection } from "@forguncy-react-workspace/dev-harness/local-decisions";

/**
 * The record a Cell's import resolves through, and what a local process concluded about it.
 *
 * `projection` is carried unreduced rather than flattened into `decisions`: the withheld and
 * unobservable records are the report a caller needs when a Cell does not compile, and a shape
 * that kept only the usable array would leave "why is this import unresolved" to be re-derived.
 */
export interface ProjectCellLock {
  readonly cellId: string;
  readonly decisions: readonly DependencyDecision[];
  readonly projection: LocalDecisionProjection;
  /**
   * What a *deployment* gate would additionally withhold for this Cell (#8's runtime axis).
   *
   * Reported, never used to build: a locally recorded decision has no real-page validation, so a
   * strict deployment projection withholds every one of them. That is the honest difference
   * between "this artifact compiles here" and "this decision was validated on a page".
   */
  readonly deploymentWithheld: readonly WithheldCompilationDependency[];
}

/** A project, loaded and judged once for every verb. */
export interface LoadedCellProject {
  /** Absolute project root the registry was normalized against. */
  readonly root: string;
  readonly registry: CellRegistry;
  /** The lock as read — an empty document when the project has none. */
  readonly lock: FgcLockDocument;
  readonly hasLock: boolean;
  /**
   * `host` decisions the target's bridge supplies for packages the lock does not decide, with the
   * row each came from. See {@link hostDefaultsOf} for why these are not recorded decisions.
   */
  readonly hostDefaults: readonly HostDefault[];
  /** One entry per declared Cell, in declaration order. */
  readonly cells: readonly ProjectCellLock[];
  /** The installed versions the freshness rules compared against. */
  readonly resolvedVersions: Readonly<Record<string, string>>;
  readonly toolchain: LockEnvironment["toolchain"];
}

export interface LoadCellProjectOptions {
  /** Absolute project root. */
  readonly root: string;
  /** Verify declared entries exist on disk while normalizing. Defaults to `true`. */
  readonly requireEntryFiles?: boolean;
}

/**
 * Composes the probe fingerprint this checkout would record for `record`.
 *
 * Needed because the deployment projection compares the record's stored fingerprint against the
 * current declared inputs, and `LockEnvironment` is the caller's answer to "what would a probe
 * run now compose". The inputs are the ones `record` uses by default: the `inline-bundle` probe,
 * the package itself as the synthetic entry, the recorded import surface, and the declared Cell
 * cap when the record is scoped to a Cell. A record produced with different inputs composes a
 * different string, and the projection reports that as stale — which is the right answer: this
 * process cannot show the record describes the build it would produce.
 *
 * Composed through `dependency-resolver/local` (#157): the string is `probe/fingerprint.ts`'s, the
 * one place that owns how it is composed, and the declared build inputs it folds in now live in a
 * leaf module (`probe/build-configuration.ts`) rather than beside the bundler. Reading it from the
 * barrel would evaluate every module the barrel re-exports, including `probe/build.ts`'s
 * `rolldown` import — a bundler loaded to compose a string.
 */
function currentProbeFingerprint(registry: CellRegistry, record: LockedDependencyDecision): string {
  const budgetCharacters =
    record.cellTarget === null ? null : (registry.get(record.cellTarget)?.output?.codeBudgetCharacters ?? null);
  return composeProbeFingerprint({
    probeId: "inline-bundle",
    entry: record.packageName,
    ...(record.imports === null ? {} : { imports: record.imports }),
    budgetCharacters,
  }).fingerprint;
}

/**
 * The environment a *deployment* projection is judged in, for one Cell.
 *
 * Extension version and identity are deliberately absent: only a page's
 * `api.app.listFrontendLibraries` answers them, and inventing the record's own values here
 * would turn "this process cannot say" into "unchanged" — the false-fresh direction AGENTS.md
 * rule 6 forbids. The projection therefore withholds extension records, and `plan` reports why.
 */
function deploymentEnvironment(project: Omit<LoadedCellProject, "cells">, cellId: string): LockEnvironment {
  const probeFingerprints: Record<string, string> = {};
  // The lock's own lookup, not a second copy of its precedence (#157): an exact Cell record wins
  // over the `null` fallback, and that order is `findLockDecision`'s. A record for *another* Cell
  // is not a candidate at all, which is what makes this agree with `resolveLockDecision` — the
  // function the projection then compares against.
  for (const packageName of recordedPackageNames(project.lock)) {
    const chosen = findLockDecision(project.lock, { packageName, cellTarget: cellId });
    if (chosen !== null) {
      probeFingerprints[packageName] = currentProbeFingerprint(project.registry, chosen);
    }
  }

  return {
    resolvedVersions: project.resolvedVersions,
    target: RUNTIME_CONTRACT_TARGET,
    toolchain: project.toolchain,
    probeFingerprints,
    extensionVersions: {},
    extensionIdentities: {},
    artifactFingerprints: {},
  };
}

/** One host decision the bridge supplies. */
export interface HostDefault {
  /** The package the Cell imported. */
  readonly packageName: string;
  /** The page global the bridge binds it to. */
  readonly globalName: string;
  /** The module id the bridge's row is keyed by — `react-dom` and `react-dom/client` differ here. */
  readonly specifier: string;
  /** Why the bridge can answer this import without a recorded decision. */
  readonly reason: string;
}

/**
 * The `host` decisions the target's own bridge supplies.
 *
 * ## Why this is not a bypass of the lock
 *
 * #9's bridge table is the *target's* answer, not a project's: the page provides React, ReactDOM
 * and antd, and the bridge binds those specifiers before Node resolution runs. So an import of
 * `react` is not a package this project selected — there is no alternative to pick — and asking a
 * consumer project to re-record `{ strategy: "host", packageName: "react" }` in `fgc.lock.json`
 * would make the lock state something the page decided.
 *
 * The distinction matters because the lock's job (#8) is to make *selection* reproducible: which
 * package, which version, which evidence, and when it stops being true. A `host` row has none of
 * that — the entry names a global, `resolvedVersion` is the page's, and the conformance audit
 * checks it against #9's table rather than against a measurement.
 *
 * ## What still belongs in the lock
 *
 * A package the bridge intercepts but that a *project* chose to treat differently — `inline`
 * where the bridge could do `host`, or `extension` through a project row — is a decision, and a
 * recorded decision always wins: the union below skips any package the lock already decides. What
 * is supplied is only the intersection of "the bridge has a `host-global` row" and "nothing decided
 * it".
 *
 * Only `host-global` rows are considered. `react/jsx-runtime` is a `jsx-runtime-adapter` row with
 * no page global — #9 forbids mapping it to the React object — and its package is the same
 * `react` name, so the host-global row answers the whole package without a second spelling. Keying
 * on the row kind rather than on table order is what keeps a reordered table from silently
 * reporting the adapter as the answer.
 */
export function hostDefaultsOf(project: { readonly lock: FgcLockDocument }): readonly HostDefault[] {
  const decided = new Set(project.lock.decisions.map(record => record.packageName));
  const seen = new Set<string>();
  const defaults: HostDefault[] = [];

  for (const mapping of HOST_BRIDGE_MAPPINGS) {
    if (mapping.kind !== "host-global") {
      continue;
    }
    const packageName = packageNameOfModuleId(mapping.specifier);
    if (decided.has(packageName) || seen.has(packageName)) {
      continue;
    }
    seen.add(packageName);
    defaults.push({
      packageName,
      globalName: mapping.globalName,
      specifier: mapping.specifier,
      reason: `The page provides this module: #9's bridge binds "${mapping.specifier}" to the page global "${mapping.globalName}" before Node resolution runs, so there is no package for this project to select.`,
    });
  }

  return defaults;
}

/** The `host` decisions a compile receives, from the bridge rows whose package nothing decided. */
export function hostDecisionDefaults(defaults: readonly HostDefault[]): readonly DependencyDecision[] {
  return defaults.map(entry => ({ strategy: "host" as const, packageName: entry.packageName, globalName: entry.globalName }));
}

/** Loads the project's registry and lock, and projects the lock onto every declared Cell. */
export async function loadCellProject(options: LoadCellProjectOptions): Promise<LoadedCellProject> {
  const registry = await loadForguncyConfig({
    root: options.root,
    requireEntryFiles: options.requireEntryFiles ?? true,
  });

  const lock = await readFgcLock(registry.root);
  // The lock's own answer to "which packages does this need versions for", rather than a
  // re-derived set (#157): a second spelling of the dedupe-and-sort could differ in order, and the
  // version map it feeds is compared by exact key.
  const { versions } = await resolveInstalledVersions(registry.root, recordedPackageNames(lock));
  // The toolchain that will compile, read the way the probe read it: `readToolchainIdentity`
  // resolves the project's installed `vite-plus` through the shared locator (#94), so a consumer
  // project's own toolchain is what a record is compared against rather than the tool package's.
  // The dev harness's `installedToolchain` overrides `vitePlus` with *its* resolution, which is
  // right for a dev server and wrong here — this process builds the consumer's Cell, not the
  // harness's.
  const toolchain = await readToolchainIdentity(registry.root);
  const extensionCatalog = extensionCatalogOfNormalized(registry.extensionMappings);
  const hostDefaults = hostDefaultsOf({ lock });

  const base = {
    root: registry.root,
    registry,
    lock,
    hasLock: lock.decisions.length > 0,
    hostDefaults,
    resolvedVersions: versions,
    toolchain,
  } satisfies Omit<LoadedCellProject, "cells">;

  const cells = registry.cells.map(cell => {
    const projection = projectLocalDecisions({
      lock,
      cellTarget: cell.id,
      resolvedVersions: versions,
      target: RUNTIME_CONTRACT_TARGET,
      toolchain,
      extensionCatalog,
    });
    const deployment = compilationDependencies(lock, deploymentEnvironment(base, cell.id), { cellTarget: cell.id });
    return {
      cellId: cell.id,
      // The bridge's rows for what nothing decided, then the lock's decisions. Order is what
      // `auditDependencyDecisions` reads for a duplicate; the union above cannot produce one
      // because it skips every package the lock decides.
      decisions: [...hostDecisionDefaults(hostDefaults), ...projection.decisions],
      projection,
      deploymentWithheld: deployment.withheld,
    } satisfies ProjectCellLock;
  });

  return { ...base, cells };
}

/** The lock view of one Cell, or a refusal naming the id — the registry has not drifted here. */
export function cellLockOf(project: LoadedCellProject, cellId: string): ProjectCellLock {
  const found = project.cells.find(cell => cell.cellId === cellId);
  if (found === undefined) {
    throw new Error(
      `No lock projection for Cell "${cellId}". The project declares: ${project.cells.map(cell => cell.cellId).join(", ") || "(none)"}.`,
    );
  }
  return found;
}

/** The staleness reasons a *local* process could not evaluate for a Cell, named once for reports. */
export function unobservableReasonsOf(project: LoadedCellProject, cellId: string): readonly LockStalenessReason[] {
  return cellLockOf(project, cellId).projection.unobservableEvidence.flatMap(entry => entry.stalenessReasons);
}

/**
 * The configured staleness reasons the *deployment* gate withholds for a Cell.
 *
 * The local projection already reports the same records it withheld for an observable reason; this
 * adds the deployment-only rows (`real-runtime-not-validated`, `extension-*-unknown`) so a plan
 * can state the whole deployment debt in one place.
 */
export function deploymentWithheldOf(project: LoadedCellProject, cellId: string): readonly WithheldCompilationDependency[] {
  return cellLockOf(project, cellId).deploymentWithheld;
}

/** The extension rows the project itself declared, as the report prints them. */
export interface ProjectExtensionMapping {
  readonly packageName: string;
  readonly libraryId: string;
  readonly globalName: string;
}

export function projectExtensionMappings(project: LoadedCellProject): readonly ProjectExtensionMapping[] {
  return project.registry.extensionMappings.projectMappings.map(mapping => ({
    packageName: mapping.packageName,
    libraryId: mapping.libraryId,
    globalName: mapping.globalName,
  }));
}

/** The target identity every deployment projection was judged against, for report footers. */
export function deploymentTargetIdentity(): ReturnType<typeof forguncyTargetIdentity> {
  return forguncyTargetIdentity(RUNTIME_CONTRACT_TARGET);
}
