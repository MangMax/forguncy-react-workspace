/**
 * The dev server's start-up audit: the lock projected onto the mounted Cell, the extension
 * choices, and the project's alias declarations (#97, #23 plan step 5).
 *
 * Split mechanically out of `vite-plugin.ts` (#160); the reasoning is the moved comments' own.
 * The plugin keeps the hooks and the closures they read — this file is handed the state the audit
 * needs and answers with the substitutions the same hook then serves.
 */

import { RUNTIME_CONTRACT_TARGET } from "@forguncy-react-workspace/core";
import type { CellRegistry } from "@forguncy-react-workspace/core";
import type { LocalDevExtensionChoice } from "@forguncy-react-workspace/runtime";
import {
  extensionCatalogOfNormalized,
  resolveInstalledVersions,
} from "@forguncy-react-workspace/dependency-resolver/local";

import { extensionSubstitutions } from "./extension-substitutions.ts";
import type { ExtensionSubstitution } from "./extension-substitutions.ts";
import {
  auditHarnessConfiguration,
  blockingLocalDevFindings,
  BlockingLocalDevFindingError,
  formatHarnessAudit,
  readProjectDependencyDecisions,
  unmatchedExtensionChoicePackages,
} from "./local-dev-audit.ts";
import {
  formatLocalDecisionProjection,
  installedToolchain,
  projectLocalDecisions,
} from "./local-decision-projection.ts";

export interface ServerStartAuditInput {
  readonly registry: CellRegistry;
  /** The Cell this server mounts, or null when none was selected. */
  readonly cellTarget: string | null;
  /** The project's declared `extensionChoices`, audited and then applied. */
  readonly extensionChoices: readonly LocalDevExtensionChoice[] | undefined;
  readonly userAliasKeys: readonly string[] | undefined;
  readonly userAliasPatterns: readonly { readonly key: string; readonly pattern: string }[] | undefined;
}

export interface ServerStartAudit {
  /** The substitutions this start may serve, built from the audit's own answer. */
  readonly substitutions: readonly ExtensionSubstitution[];
}

export async function auditServerStart(input: ServerStartAuditInput): Promise<ServerStartAudit> {
  const { registry } = input;

  // #23's plan step 5, executed. `runtime` owns every rule here — which branches an
  // `extension` choice may take, what makes one incomplete, and which findings block local
  // development — so this hook reads the project's two declarations, hands them to the audit,
  // and splits the answer by the contract's own `blocksLocalDevelopment` flag. Nothing below
  // decides what a problem is.

  // The lock, projected onto the Cell this server mounts, and the projection is not optional.
  //
  // A lock decision is keyed by `(packageName, cellTarget)`, because #4 defines a strategy per
  // *pair* — the same package may be `inline` in one Cell and `extension` in another. The audit
  // has no `cellTarget` parameter, so handing it the whole lock lets another Cell's record decide
  // this one: a mounted Cell with an `inline` override would still be substituted or refused
  // because of a target-independent `extension` record, while the compiler inlines. Review found
  // it, and it is the same dev/compiler drift as the stale-choice defect, reached from the other
  // side — that one applied a decision the lock no longer had, this one applies a decision the
  // mounted Cell does not have.
  //
  // `mounted` is assigned in `configResolved`, which Vite runs before this hook — measured, not
  // assumed, and `local-dev-audit-server.test.ts` exercises the ordering by mounting a Cell.
  const lock = await readProjectDependencyDecisions(registry.runtime.dependencyLockPathAbsolute);

  // And the lock is then put through the *validity* projection the compiler applies before it
  // will compile a dependency — the second half of the same defect. `compileCell` refuses an
  // artifact whose decision the compiler withheld (`unresolved-dependency-decision`), so a
  // harness that acted on such a record could render a Cell locally while the identical source
  // refuses to compile: a green local render for an artifact that cannot exist.
  //
  // `projectLocalDecisions` runs the compiler's own conformance audit and local projection, and
  // splits the result by axis. Axes a local process can judge decide; the two it cannot
  // (`extension-*`, which only a page's `listFrontendLibraries` answer supplies, and
  // `probe-fingerprint-*`, whose composer reaches a bundler) are reported as a boundary instead
  // of silently withholding. Withholding on those would drop every `extension` record, the
  // harness would see no `extension` strategy, and a Cell importing one would resolve silently
  // through npm — the first defect this work closed, restored. The module's docstring has the
  // measurement.
  //
  // The three axes this process *can* judge are supplied from what it actually knows, and the
  // first version of this call got that wrong in a way worth recording: it passed `target: null`
  // and `toolchain: null` as placeholders, which the projection correctly read as "unknown" —
  // manufacturing `forguncy-target-changed` and `toolchain-unknown` on records that were
  // perfectly valid, and so withholding decisions the compiler accepts. `null` in a freshness
  // axis means *unknown*, never *don't check*, which is the same asymmetry
  // `local-dev-audit.ts` records for `decisions` versus `referencedSpecifiers`.
  const projection = projectLocalDecisions({
    lock,
    cellTarget: input.cellTarget,
    resolvedVersions: (await resolveInstalledVersions(
      registry.root,
      lock.decisions.map(record => record.packageName),
    )).versions,
    // `RUNTIME_CONTRACT_TARGET` is the measured contract, which is what a record's own `target`
    // was written against — and comparing them is exactly what the freshness rule is for, so a
    // record recorded against a different build is reported rather than assumed fine. The
    // project's `runtime.forguncyVersion` is checked against it rather than substituted for it:
    // it names a version, not a build, so it cannot answer a comparison that asks for the build.
    target: RUNTIME_CONTRACT_TARGET,
    // The project's install graph, with `vitePlus` read through this package's own resolution
    // because that is the tool actually driving the loop (#94). `registry.root` is the graph
    // the Cells resolve in, which is the graph a record describes — and the one #94 exists
    // for, since it can move while every version a record names stays put.
    toolchain: await installedToolchain(registry.root),
    // The project's own mapping set, from the registry — not `core`'s built-in table (#87).
    //
    // `registry.extensionMappings` is the one normalization exit #85 built and #86 threaded into
    // the compiler, so this is the *same* set `compileCell` plans from. Auditing against
    // `core`'s table instead made a custom project extension a blocking conformance error here
    // while the compiler compiled it, which is exactly the "the dev server refuses what the
    // bundler accepts" split #87 exists to remove. Projected through the shared
    // `extensionCatalogOfNormalized`, so `moduleIds` widen exactly as they do for the compiler.
    extensionCatalog: extensionCatalogOfNormalized(registry.extensionMappings),
  });

  const audit = auditHarnessConfiguration({
    decisions: projection.decisions,
    extensionChoices: input.extensionChoices ?? [],
    ...(input.userAliasKeys === undefined ? {} : { userAliasKeys: input.userAliasKeys }),
    ...(input.userAliasPatterns === undefined ? {} : { userAliasPatterns: input.userAliasPatterns }),
    projectAlias: registry.resolve.alias,
  });

  // Built *here*, from the audit's own answer about which choices matched, and the ordering is
  // load-bearing rather than tidy. The first version built these in `configResolved` from
  // `options.extensionChoices` alone, before any decision was read — so a stale choice (a
  // package the lock has since moved from `extension` to `inline`) was still applied:
  // `resolveId` served the substitute while the compiler followed the lock and bundled the real
  // package. Review found it, and it is the dev/compiler drift this whole layer exists to
  // prevent, arriving through the layer itself.
  //
  // Throwing here rather than at `resolveId` is deliberate for the same reason as before: a
  // choice naming a package the extension table does not intercept is a configuration error the
  // reader can fix, and reporting it at startup puts it beside the other startup findings
  // instead of inside whichever module import happened to be first.
  const substitutions = extensionSubstitutions(
    input.extensionChoices ?? [],
    registry.root,
    unmatchedExtensionChoicePackages(audit),
    // The project's own rows, once normalized (#87): a choice for a custom extension is only
    // meaningful against the table the compiler resolves it through. See
    // `extension-substitutions.ts` for the refusal this replaced.
    registry.extensionMappings.mappings,
  );

  const lockFindings = formatLocalDecisionProjection(projection);
  const lockRefuses = projection.conformanceErrors.length > 0;

  const auditReport = formatHarnessAudit(audit);
  const report =
    lockFindings.length === 0
      ? auditReport
      : `${auditReport}\n\nLock decisions, projected the way the compiler projects them:\n${lockFindings}`;
  const blocking = blockingLocalDevFindings(audit);

  if (blocking.length > 0 || lockRefuses) {
    // Refusal carries the report, and *only* the refusal does.
    //
    // The first version wrote the report to stderr here as well, on the reasoning that a
    // blocking run should still show the full picture. That printed everything twice —
    // measured against a real `vp dev`: the report appeared once from the write below and
    // again inside this message, which Vite prints itself when a hook rejects. Two identical
    // copies of a six-line report, one after the other, in the one output a developer is
    // already unhappy to be reading.
    //
    // So the two paths are now exclusive and each prints once. The report is the message
    // because the alternative — "1 local dev diagnostic", with the finding somewhere else —
    // sends the reader to a second command for the remediation and the fix owner they need
    // now. It carries the distinction as well, so a blocked start is not the one path that
    // drops the local-versus-real caveat.
    throw new BlockingLocalDevFindingError(
      blocking,
      `The local dev harness refused to start: ${blocking.length} finding(s) that this project's configuration has to resolve first.\n${report}`,
    );
  }

  // The non-blocking path, and the common one. To stderr for the reason the version and Fast
  // Refresh warnings go there: this is output *about* the loop, and a page that carried it
  // would read as the Cell's own.
  process.stderr.write(`${report}\n`);

  return { substitutions };
}
