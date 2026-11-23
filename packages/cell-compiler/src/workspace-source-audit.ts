/**
 * The executable half of #14's workspace-source contract: indexing the graph,
 * classifying module ids, walking the source closure, and the audit that reports what
 * it finds.
 *
 * Decision source: GitHub Issue #14 — "Spec: local workspace packages are source
 * dependencies and inline by default"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14), projected by the
 * artifact contract in #6. The contract tables themselves — the reuse classes, the
 * graph types, the guarantees and the diagnostic vocabulary — stay in
 * `workspace-source.ts`; this module only applies them.
 *
 * Split out of `workspace-source.ts` by #162, under the shape-stabilisation Spec #152.
 */

import { compareCodeUnits } from "@forguncy-react-workspace/core";
import type {
  DependencyDecision,
  FrontendLibraryReference,
} from "@forguncy-react-workspace/core";

import {
  dependencyDecisionsFor,
  findDependencyDecision,
  isSourceSpecifier,
  packageNameOfSpecifier,
} from "./specifier.ts";
import {
  createWorkspaceSourceDiagnostic,
  formatWorkspaceSourceDiagnostics,
  orderWorkspaceSourceDiagnostics,
} from "./workspace-source.ts";
import type {
  WorkspaceDelegationAssessment,
  WorkspaceDelegationGap,
  WorkspaceGraph,
  WorkspaceGraphIndex,
  WorkspaceGraphIndexResult,
  WorkspaceImportCycle,
  WorkspaceModuleKind,
  WorkspacePackageRecord,
  WorkspaceSourceAudit,
  WorkspaceSourceAuditInput,
  WorkspaceSourceClosure,
  WorkspaceSourceDiagnostic,
  WorkspaceUsageState,
} from "./workspace-source.ts";

/** The workspace-relative form `directory` is required to take. */
function isWorkspaceRelativeDirectory(directory: string): boolean {
  const normalized = directory.replace(/\\/g, "/").trim();
  if (normalized.length === 0) return false;
  if (normalized.startsWith("/")) return false;
  // A Windows drive-absolute path, which is machine-specific in the same way.
  if (/^[A-Za-z]:/.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}

/** A name source can import. Deliberately not npm's registry policy, only what changes resolution here. */
function isImportablePackageName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith(".") || trimmed.startsWith("/")) return false;
  return !/\s/.test(trimmed);
}

/**
 * Indexes a workspace graph, reporting the records it cannot use.
 *
 * Never throws, and never drops a record silently. An unnameable record is skipped
 * because there is no way to look it up, and that is reported; a record whose
 * `directory` is absolute is kept because it still answers the resolution
 * question, and the portability problem is reported separately.
 *
 * A duplicated name keeps the canonical-first record and reports both directories:
 * the ambiguity is in the project's declarations, and picking whichever the
 * caller happened to list first would make the answer depend on array order.
 */
export function indexWorkspaceGraph(graph: WorkspaceGraph): WorkspaceGraphIndexResult {
  const diagnostics: WorkspaceSourceDiagnostic[] = [];
  const candidates: WorkspacePackageRecord[] = [];

  for (const record of graph.packages) {
    const subject = record.name.trim().length > 0 ? record.name : record.directory;

    if (!isImportablePackageName(record.name)) {
      diagnostics.push(
        createWorkspaceSourceDiagnostic("workspace-graph-conflict", subject, {
          detail: `"${record.name}" cannot be a workspace package name: source cannot import it, so no decision about it would ever be reached. A workspace package is named, not pathed.`,
        }),
      );
      continue;
    }

    if (!isWorkspaceRelativeDirectory(record.directory)) {
      diagnostics.push(
        createWorkspaceSourceDiagnostic("workspace-graph-conflict", subject, {
          detail: `The record's directory "${record.directory}" is not workspace-relative. It is carried into diagnostics, and this repository's portability rule is that a machine-specific path must not travel.`,
        }),
      );
    }

    if (record.moduleIdentity?.kind === "delegated" && !isImportablePackageName(record.moduleIdentity.via)) {
      diagnostics.push(
        createWorkspaceSourceDiagnostic("undelegated-workspace-module-identity", subject, {
          detail: `The delegation names "${record.moduleIdentity.via}", which is not an importable module id, so nothing can provide the identity it claims to delegate to.`,
        }),
      );
    }

    candidates.push(record);
  }

  // Canonical order over the record's *raw* content, because two records can share a
  // name and a directory and still disagree about `imports` or `moduleIdentity`. A
  // comparator that returned 0 for them would leave the winner to JavaScript's stable
  // sort — that is, to the caller's array order — and the index would then retain a
  // different record depending on it. Normalising the imports would be the other way to
  // avoid the tie, and it is the wrong one here: it would make `["react", "react"]` and
  // `["react"]` the same key, so the retained record would again depend on which came
  // first, while the diagnostic below still has to tell them apart.
  const ordered = [...candidates].sort((a, b) => compareCodeUnits(recordSelectionKey(a), recordSelectionKey(b)));

  const byName = new Map<string, WorkspacePackageRecord>();
  for (const record of ordered) {
    const existing = byName.get(record.name);
    if (existing !== undefined) {
      const equivalent = recordsAreEquivalent(existing, record);
      diagnostics.push(
        createWorkspaceSourceDiagnostic("workspace-graph-conflict", record.name, {
          detail: equivalent
            ? `Two records declare this package equivalently ("${existing.directory}" and "${record.directory}"), so the graph is resolved to one of them by content order and nothing downstream changes. The duplicate declaration is still a project declaration problem.`
            : `Two records declare this package differently ("${existing.directory}" and "${record.directory}"), so which one an import of "${record.name}" reaches changes the answer: a name is resolved by content order, but the collision means the graph does not describe one package.`,
        }),
      );
      continue;
    }
    byName.set(record.name, record);
  }

  return {
    // The index's own list rather than every candidate: a record nothing can resolve
    // to is not part of the index, and it is reported instead of silently dropped.
    // `Map` preserves insertion order and the candidates are sorted, so this stays
    // canonical.
    index: { packages: [...byName.values()], byName },
    diagnostics: orderWorkspaceSourceDiagnostics(diagnostics),
  };
}

/**
 * The whole of a record, raw, as a sort key.
 *
 * Raw rather than normalised, so that two records a caller wrote differently are ordered
 * by what they wrote and never tie. A tie then means the two records are the same text,
 * which is the only case where keeping either can change nothing: see
 * {@link recordsAreEquivalent} for the weaker question the diagnostic asks.
 *
 * `JSON.stringify` of the fields rather than a hand-rolled separator, because the point of
 * the key is that two *different* records cannot collide: a separator can be spelled inside
 * a value, and the two distinctions that matter both have to survive it — `undefined`
 * against `[]` for `imports`, and an absent `moduleIdentity` against an explicit
 * `{ kind: "cell-local" }`. Both optional fields are written as `null` when absent, so
 * presence is part of the key. Those pairs mean the same thing to every check here, but
 * they are not the same record, and only the key keeps them apart.
 *
 * Which of two records that differ only in this key's tail wins is decided by text order,
 * and carries no preference: records that tie on their meaning are interchangeable, and the
 * duplicate is reported either way.
 */
function recordSelectionKey(record: WorkspacePackageRecord): string {
  return JSON.stringify([
    record.name,
    record.directory,
    record.imports ?? null,
    record.moduleIdentity ?? null,
  ]);
}

/**
 * A record's meaning, normalised: the weaker comparison the duplicate diagnostic asks.
 *
 * Two records that list the same imports in a different order, list one twice, or spell
 * `cell-local` explicitly rather than leaving the field out are equivalent — the graph
 * computes edges through a set, the reachability check is a membership test, and an absent
 * identity already means `cell-local` by the type's own definition. The distinction matters
 * for the report, not for the resolution: a reader of "two records declare this package"
 * needs to know whether the duplicate changed anything.
 *
 * `undefined` and `[]` for `imports` stay different, for the reason
 * {@link recordSelectionKey} gives: "nobody said" is not "there are none", and the
 * reachability check answers differently for them.
 */
function recordMeaning(record: WorkspacePackageRecord): string {
  const imports =
    record.imports === undefined ? null : [...new Set(record.imports)].sort(compareCodeUnits);
  const identity =
    record.moduleIdentity === undefined || record.moduleIdentity.kind === "cell-local"
      ? "cell-local"
      : `delegated:${record.moduleIdentity.via}`;
  return JSON.stringify([record.name, record.directory, imports, identity]);
}

/** Whether two records say the same thing about a package, once spelling differences are set aside. */
function recordsAreEquivalent(a: WorkspacePackageRecord, b: WorkspacePackageRecord): boolean {
  return recordMeaning(a) === recordMeaning(b);
}

/**
 * The workspace package a specifier resolves to, or `undefined` for a published
 * dependency or a file path.
 *
 * Exact first, then the specifier's package: `@app/ui/theme.css` is workspace
 * source because `@app/ui` is. The precedence is the same question
 * `artifact.findDependencyDecision` answers for decisions, and it is asked here
 * through {@link packageNameOfSpecifier} rather than through a second
 * implementation of "what package is this".
 */
export function workspacePackageFor(
  index: WorkspaceGraphIndex,
  specifier: string,
): WorkspacePackageRecord | undefined {
  const exact = index.byName.get(specifier);
  if (exact !== undefined) return exact;

  const packageName = packageNameOfSpecifier(specifier);
  // A file path or a bare name is its own package name, so there is no second
  // lookup left to do — and `packageNameOfSpecifier` returns the input for both.
  if (packageName === specifier) return undefined;
  return index.byName.get(packageName);
}

/** True when a specifier is workspace source rather than a published dependency. */
export function isWorkspaceSourceSpecifier(index: WorkspaceGraphIndex, specifier: string): boolean {
  return workspacePackageFor(index, specifier) !== undefined;
}

/**
 * What a module id is, as far as a workspace graph can tell.
 *
 * Three answers rather than two, because the walk needs them: a
 * `workspace-package` is an edge to follow and gets inlined, a `source-file` is
 * neither an edge nor a dependency to decide (it is a file inside one of the
 * packages, and whether it is internal to *this* package or another one is not a
 * question the dependency pipeline can act on), and an `external-package` is a
 * published dependency that needs a decision.
 *
 * Two answers would make a source-derived graph unusable: `./Button` is not in the
 * graph, so "not a workspace package" would silently mean "a published dependency",
 * and the audit would demand a dependency decision for a component file next to it.
 *
 * The path test is `artifact.isSourceSpecifier`, the same function the artifact
 * boundary uses to tell a leftover import from an unresolved decision, so the two
 * layers cannot end up with two definitions of "this is a file".
 */
export function classifyWorkspaceModule(
  index: WorkspaceGraphIndex,
  specifier: string,
): WorkspaceModuleKind {
  if (workspacePackageFor(index, specifier) !== undefined) return "workspace-package";
  return isSourceSpecifier(specifier) ? "source-file" : "external-package";
}

/**
 * The workspace packages a package's stated imports reach, deduped and canonical.
 *
 * `workspacePackageFor` rather than `classifyWorkspaceModule`, because this asks the
 * narrower question: which of these imports is an edge to follow. The three-way
 * classification is for the walk, which has to decide about the other two kinds as
 * well — and for a file path both functions agree, since neither treats one as a
 * package.
 *
 * A name with no record has no known edges, rather than a fabricated empty package:
 * this only happens for a node the caller's edge list mentions and the graph does
 * not declare, and inventing a record for it would report a package that does not
 * exist.
 */
function workspaceEdgesOf(index: WorkspaceGraphIndex, name: string): readonly string[] {
  const record = index.byName.get(name);
  if (record === undefined) return [];

  const reached = new Set<string>();
  for (const moduleId of record.imports ?? []) {
    const target = workspacePackageFor(index, moduleId);
    if (target !== undefined) reached.add(target.name);
  }
  return [...reached].sort(compareCodeUnits);
}

/**
 * Whether an import list names a module, exactly or by its package.
 *
 * A membership question over a plain list, not the precedence question
 * `artifact.findDependencyDecision` answers over decisions: there are no strategies
 * here, so "either form matches" is the whole rule and `some` cannot make the result
 * depend on the array's order.
 */
function declaresImport(imports: readonly string[], moduleId: string): boolean {
  return imports.some(
    candidate => candidate === moduleId || packageNameOfSpecifier(candidate) === moduleId,
  );
}

/**
 * Walks the workspace source reachable from the entry's imports.
 *
 * Three answers, and #14 asks for all three: which workspace packages a cell pulls
 * in, which published dependencies come with them (acceptance criterion 3), and
 * whether the import graph has a cycle (acceptance criterion 4).
 *
 * The walk branches on {@link classifyWorkspaceModule}, never on "is this in the
 * graph": a `source-file` import is neither an edge to follow nor a dependency to
 * decide, and treating "not a workspace package" as "a published dependency" would
 * demand a decision for `./Button` in any graph derived from source rather than from
 * a manifest.
 *
 * The walk is over the edges the caller stated. A package whose `imports` is
 * absent contributes no outgoing edges and is still reached, so an incomplete
 * graph produces a smaller answer rather than a wrong one, and the audit reports
 * the abstention through `usage`/`imports` rather than through an empty result.
 *
 * Cycles are found as back edges during one depth-first pass: every cycle in a
 * reachable strongly-connected component is *reported*, but elementary cycles are
 * not enumerated one by one, because the diagnostic's job is to name the chain a
 * reviewer has to break, not to list every way around it.
 *
 * Iterative rather than recursive on purpose. A deeply nested graph is exactly the
 * malformed input this function exists to report, and a `RangeError` escaping it
 * would turn a diagnostic into a crash.
 */
export function traceWorkspaceSourceClosure(
  index: WorkspaceGraphIndex,
  entryModuleIds: readonly string[],
): WorkspaceSourceClosure {
  const roots = [
    ...new Set(
      entryModuleIds
        .map(moduleId => workspacePackageFor(index, moduleId)?.name)
        .filter((name): name is string => name !== undefined),
    ),
  ].sort(compareCodeUnits);

  // Reachability and the external-module map share one pass: both need every
  // package the entry reaches, and a second walk would be a second answer.
  const reached = new Set<string>(roots);
  const externalImports = new Map<string, Set<string>>();
  const pending = [...roots];

  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined) break;
    const record = index.byName.get(name);
    if (record === undefined) continue;

    for (const moduleId of record.imports ?? []) {
      switch (classifyWorkspaceModule(index, moduleId)) {
        case "workspace-package": {
          const target = workspacePackageFor(index, moduleId);
          if (target === undefined) break;
          if (!reached.has(target.name)) {
            reached.add(target.name);
            pending.push(target.name);
          }
          break;
        }
        case "source-file":
          // A file inside some package: not an edge to follow and not a dependency
          // to decide. The bundler flattens it as ordinary source.
          break;
        case "external-package": {
          const importers = externalImports.get(moduleId);
          if (importers === undefined) externalImports.set(moduleId, new Set([name]));
          else importers.add(name);
          break;
        }
      }
    }
  }

  return {
    packages: [...reached].sort(compareCodeUnits),
    externalModules: [...externalImports.keys()].sort(compareCodeUnits).map(moduleId => ({
      moduleId,
      importedBy: [...(externalImports.get(moduleId) ?? [])].sort(compareCodeUnits),
    })),
    cycles: findWorkspaceCycles(index, roots, reached),
  };
}

const UNVISITED = 0;
const ON_PATH = 1;
const SETTLED = 2;

interface TraversalFrame {
  readonly name: string;
  edge: number;
  readonly edges: readonly string[];
}

/**
 * The chain rotated so it starts and ends at its smallest member.
 *
 * The canonical form, and the reason it has to be applied to the *reported* chain
 * and not only to the key: a cycle is entered at whichever of its members the walk
 * happens to reach first, so the raw traversal path is the same cycle written from a
 * different starting point. Rotating both makes one cycle one answer — a report that
 * changed when an unrelated package was added to the entry list would not be
 * diffable.
 */
function canonicalCycleChain(chain: readonly string[]): readonly string[] {
  const members = chain.slice(0, -1);
  let smallest = 0;
  for (let index = 1; index < members.length; index += 1) {
    if (compareCodeUnits(members[index] ?? "", members[smallest] ?? "") < 0) smallest = index;
  }
  const rotated = [...members.slice(smallest), ...members.slice(0, smallest)];
  return [...rotated, ...rotated.slice(0, 1)];
}

function findWorkspaceCycles(
  index: WorkspaceGraphIndex,
  roots: readonly string[],
  reached: ReadonlySet<string>,
): readonly WorkspaceImportCycle[] {
  const state = new Map<string, number>();
  const cycles = new Map<string, WorkspaceImportCycle>();

  for (const root of roots) {
    if (state.get(root) !== undefined) continue;

    state.set(root, ON_PATH);
    const path: string[] = [root];
    const stack: TraversalFrame[] = [{ name: root, edge: 0, edges: workspaceEdgesOf(index, root) }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;

      if (frame.edge < frame.edges.length) {
        const next = frame.edges[frame.edge];
        frame.edge += 1;
        if (next === undefined) continue;

        const nextState = state.get(next) ?? UNVISITED;
        if (nextState === ON_PATH) {
          const chain = canonicalCycleChain([...path.slice(path.indexOf(next)), next]);
          cycles.set(chain.join("\u0000"), { chain });
          continue;
        }
        if (nextState === SETTLED) continue;

        state.set(next, ON_PATH);
        path.push(next);
        stack.push({ name: next, edge: 0, edges: workspaceEdgesOf(index, next) });
        continue;
      }

      state.set(frame.name, SETTLED);
      path.pop();
      stack.pop();
    }
  }

  // A package outside the closure cannot be part of a cycle the entry reaches, but
  // the traversal only ever follows reachable edges, so this filter is a statement
  // of that invariant rather than a second check.
  return [...cycles.values()]
    .filter(cycle => cycle.chain.every(name => reached.has(name)))
    .sort((a, b) => compareCodeUnits(a.chain.join("\u0000"), b.chain.join("\u0000")));
}

/**
 * Everything #14 says about one cell's workspace source, and nothing it cannot know.
 *
 * The checks run in a fixed order and the result is ordered by the code table, so the
 * same input always produces the same report regardless of the order the caller's
 * arrays happen to be in. Where two records could disagree — a graph that declares one
 * package twice, a decision list with two records for one module — the answer is not
 * "the first one wins": the graph is ordered by raw content, and the decision list is
 * refused rather than read past.
 */
export function auditWorkspaceSource(input: WorkspaceSourceAuditInput): WorkspaceSourceAudit {
  if (input.workspace === undefined) {
    return {
      graphActivation: "unstated",
      usage: "unstated",
      packages: [],
      delegations: [],
      diagnostics: [],
    };
  }

  const { index, diagnostics: graphDiagnostics } = indexWorkspaceGraph(input.workspace);
  const diagnostics: WorkspaceSourceDiagnostic[] = [...graphDiagnostics];
  const decisions = input.dependencies;

  diagnostics.push(...auditDecisions(index, decisions));
  diagnostics.push(...auditFrontendLibraries(index, input.frontendLibraries));
  diagnostics.push(...auditWorkspaceImportsLeftExternal(index, input.externalImports));

  const usage: WorkspaceUsageState = input.entryModuleIds === undefined ? "unstated" : "stated";
  const closure =
    input.entryModuleIds === undefined
      ? undefined
      : traceWorkspaceSourceClosure(index, input.entryModuleIds);

  if (closure !== undefined) {
    diagnostics.push(...auditTransitiveDependencies(closure, decisions));
    diagnostics.push(...auditCycles(closure));
  }

  const delegation = assessDelegations(index, decisions);
  diagnostics.push(...delegation.diagnostics);

  return {
    graphActivation: "stated",
    usage,
    packages: index.packages.map(entry => entry.name),
    ...(closure === undefined ? {} : { closure }),
    delegations: delegation.delegations,
    diagnostics: orderWorkspaceSourceDiagnostics(diagnostics),
  };
}

/**
 * Decisions that name workspace source.
 *
 * Every strategy is refused, including `replace`: the problem is not which strategy
 * was chosen but that a workspace package was treated as a dependency at all. #4's
 * rule is about "every *non-workspace* dependency", so a decision record for one is
 * outside its scope by construction.
 *
 * Grouped by the package the decision resolves to rather than reported per record, so
 * two records naming one workspace package produce one diagnostic whose message names
 * every strategy involved — the same shape #6's decision audit uses, and the reason
 * the message does not depend on which record was read first.
 */
function auditDecisions(
  index: WorkspaceGraphIndex,
  dependencies: readonly DependencyDecision[] | undefined,
): readonly WorkspaceSourceDiagnostic[] {
  if (dependencies === undefined) return [];

  const strategiesByName = new Map<string, { record: WorkspacePackageRecord; strategies: Set<string> }>();
  for (const decision of dependencies) {
    const record = workspacePackageFor(index, decision.packageName);
    if (record === undefined) continue;
    const entry = strategiesByName.get(record.name);
    if (entry === undefined) strategiesByName.set(record.name, { record, strategies: new Set([decision.strategy]) });
    else entry.strategies.add(decision.strategy);
  }

  const diagnostics: WorkspaceSourceDiagnostic[] = [];
  for (const name of [...strategiesByName.keys()].sort(compareCodeUnits)) {
    const entry = strategiesByName.get(name);
    if (entry === undefined) continue;
    const strategies = [...entry.strategies].sort(compareCodeUnits);
    const lead =
      strategies.length === 1
        ? `The decision is \`${strategies[0] ?? ""}\``
        : `${strategies.length} decisions name it (${strategies.map(strategy => `\`${strategy}\``).join(", ")})`;
    diagnostics.push(
      createWorkspaceSourceDiagnostic("workspace-package-decided-as-dependency", name, {
        detail: `${lead}, but "${entry.record.name}" (${entry.record.directory}) is workspace source: it is flattened into every cell that imports it, so there is no runtime module for a strategy to describe.`,
      }),
    );
  }
  return diagnostics;
}

/**
 * A workspace package name in `frontendLibraries`.
 *
 * The one place a workspace package could still acquire a runtime identity: the
 * metadata tells ReactCellType to resolve a frontend library before the cell runs,
 * and no such library exists for a package that only ever lived in the monorepo.
 */
function auditFrontendLibraries(
  index: WorkspaceGraphIndex,
  frontendLibraries: readonly FrontendLibraryReference[] | undefined,
): readonly WorkspaceSourceDiagnostic[] {
  if (frontendLibraries === undefined) return [];

  const diagnostics: WorkspaceSourceDiagnostic[] = [];
  for (const reference of frontendLibraries) {
    const record = workspacePackageFor(index, reference.libraryId);
    if (record === undefined) continue;
    diagnostics.push(
      createWorkspaceSourceDiagnostic("workspace-package-in-frontend-libraries", reference.libraryId, {
        detail: `"${record.name}" (${record.directory}) is workspace source and is not published as a frontend extension, so no library answers to this id.`,
      }),
    );
  }
  return diagnostics;
}

/**
 * Workspace source the bundler left for the page to load.
 *
 * Only named workspace packages. A relative path left external is #6's
 * `source-level-import-remains`, and duplicating it here would report one problem
 * under two codes; the manifest changes nothing about that case, because a path was
 * never ambiguous.
 */
function auditWorkspaceImportsLeftExternal(
  index: WorkspaceGraphIndex,
  externalImports: readonly string[] | undefined,
): readonly WorkspaceSourceDiagnostic[] {
  if (externalImports === undefined) return [];

  const diagnostics: WorkspaceSourceDiagnostic[] = [];
  for (const specifier of externalImports) {
    const record = workspacePackageFor(index, specifier);
    if (record === undefined) continue;
    diagnostics.push(
      createWorkspaceSourceDiagnostic("workspace-source-left-external", specifier, {
        detail: `"${record.name}" (${record.directory}) is workspace source, which is inlined like any other source file, but the bundler left it external — so the Cell would try to load another workspace package at runtime.`,
      }),
    );
  }
  return diagnostics;
}

/**
 * Published dependencies reached through workspace source, against the decisions.
 *
 * Acceptance criterion 3 of #14, and the check that exists because the alternative
 * is silent: a dependency pulled in only by workspace source is exactly the one that
 * gets bundled without ever passing the decision pipeline, and nothing about the
 * resulting artifact shows it.
 *
 * `dependencies` absent abstains; an empty array does not, because "there are no
 * decisions" is a stated position and every transitive dependency is then
 * undecided.
 */
function auditTransitiveDependencies(
  closure: WorkspaceSourceClosure,
  dependencies: readonly DependencyDecision[] | undefined,
): readonly WorkspaceSourceDiagnostic[] {
  if (dependencies === undefined) return [];

  const diagnostics: WorkspaceSourceDiagnostic[] = [];
  for (const external of closure.externalModules) {
    if (findDependencyDecision(dependencies, external.moduleId) !== undefined) continue;
    diagnostics.push(
      createWorkspaceSourceDiagnostic("unresolved-workspace-transitive-dependency", external.moduleId, {
        detail: `No decision covers it, and it is reached through workspace source: imported by ${external.importedBy.join(", ")}.`,
      }),
    );
  }
  return diagnostics;
}

/**
 * Why a strategy that is not `host` or `extension` cannot back a delegation.
 *
 * Exhaustive over the remaining strategies rather than a default sentence, because
 * "a private copy" and "a recorded refusal" are different problems and a reader has
 * to be able to tell which one they have.
 */
function whyStrategyCannotProvideSharedIdentity(strategy: "inline" | "replace"): string {
  return strategy === "inline"
    ? "an inlined copy is a private instance per cell, which is the duplicate the delegation assumes cannot exist."
    : "a recorded refusal is not a provider.";
}

 /** The package a cycle is reported against: its first member, which is the canonical one. */
function cycleSubject(cycle: WorkspaceImportCycle): string {
  return cycle.chain.slice(0, 1).join(" → ");
}

/**
 * The cycles the closure found, as diagnostics.
 *
 * Reported only from a traced closure, because a cycle is a property of the import
 * chain this cell reaches and a graph-wide sweep would report chains the cell never
 * enters — a diagnostic about something the artifact does not contain.
 */
function auditCycles(closure: WorkspaceSourceClosure): readonly WorkspaceSourceDiagnostic[] {
  return closure.cycles.map(cycle =>
    createWorkspaceSourceDiagnostic("circular-workspace-dependency", cycleSubject(cycle), {
      detail: `The chain is ${cycle.chain.join(" → ")}.`,
    }),
  );
}

interface DelegationAssessment {
  readonly diagnostics: readonly WorkspaceSourceDiagnostic[];
  readonly delegations: readonly WorkspaceDelegationAssessment[];
}

/**
 * What a delegation to a module the page shares, or does not.
 *
 * Four ways a declaration can be refused, and each is a different fix:
 *
 * - the module it delegates to is workspace source, which cannot provide an identity —
 *   the cell would inline a second definition of the very thing;
 * - no decision covers it, so nothing says the page provides it;
 * - several decisions cover it, so *which* provides it is unresolved — #6's artifact
 *   audit refuses the same list as `unresolved-dependency-decision`, and a delegation
 *   may not be called backed on the strength of one arbitrarily chosen record;
 * - the decision is `inline` (a private copy) or `replace` (a refusal), neither of which
 *   is a shared identity.
 *
 * The reachability check is separate because it depends on the graph stating the
 * package's imports, and it is the one that catches a *decorative* declaration: a
 * delegation to a module the package never imports shares nothing. It is a necessary
 * condition and not a sufficient one, and the wording says so — see the module note on
 * what this contract cannot prove.
 *
 * Only the first check needs no decision list, and only the first two and the last need
 * no `imports`; the rest are skipped when their input is absent and recorded as
 * {@link WorkspaceDelegationGap}s. That is why this walks every check it *can* run
 * instead of returning at the first missing input: a decorative declaration whose
 * decision list was not supplied is still decorative, and an early return would have
 * called it undetermined instead.
 *
 * Checked for every package in the graph rather than only for the ones the entry
 * reaches, unlike the closure checks. A delegation is a property of the declaration,
 * not of one cell's imports: a workspace package whose delegation is unbacked is wrong
 * for whichever cell reaches it first, and reporting it only once some cell imports it
 * would report it at the least useful moment.
 *
 * Every delegation it examines produces an assessment, including the ones with nothing
 * wrong — a report that lists only the failures would read as "the others are fine",
 * which is exactly the reading the module note forbids.
 */
function assessDelegations(
  index: WorkspaceGraphIndex,
  dependencies: readonly DependencyDecision[] | undefined,
): DelegationAssessment {
  const diagnostics: WorkspaceSourceDiagnostic[] = [];
  const delegations: WorkspaceDelegationAssessment[] = [];

  for (const record of index.packages) {
    const identity = record.moduleIdentity;
    if (identity === undefined || identity.kind !== "delegated") continue;
    const via = identity.via;

    const gaps: WorkspaceDelegationGap[] = [];
    const failed = (detail: string): void => {
      diagnostics.push(
        createWorkspaceSourceDiagnostic("undelegated-workspace-module-identity", record.name, { detail }),
      );
    };

    const delegate = workspacePackageFor(index, via);
    if (delegate !== undefined) {
      // Workspace source cannot provide an identity, so nothing else is worth asking:
      // decisions *about* a workspace package are themselves an error, and the fix is a
      // different module rather than a better decision.
      failed(
        `It delegates to "${via}", which is workspace source (${delegate.directory}) as well — each cell inlines its own copy, so the identity it claims to share is the one thing inlining cannot provide. Delegate to a module the page provides (\`host\`) or an extension provides (\`extension\`).`,
      );
      delegations.push({ package: record.name, via, status: "unbacked", stateSharingEstablished: false });
      continue;
    }

    let refused = false;

    if (dependencies === undefined) {
      gaps.push("decision-list-absent");
    } else {
      const governing = dependencyDecisionsFor(dependencies, via);
      if (governing.length === 0) {
        refused = true;
        failed(`It delegates to "${via}", and no decision covers that module, so nothing says the page provides it.`);
      } else if (governing.length > 1) {
        // Not "the first one wins": the list has no single answer, and #6 refuses it for
        // the same reason. Recorded as a gap *and* reported, because a caller reading
        // only diagnostics must not go silent about a declaration that cannot be backed.
        gaps.push("decision-list-conflicted");
        diagnostics.push(
          createWorkspaceSourceDiagnostic("conflicting-module-identity-decisions", via, {
            detail: `${governing.length} decisions cover it (${[...new Set(governing.map(entry => entry.strategy))]
              .sort(compareCodeUnits)
              .map(strategy => `\`${strategy}\``)
              .join(", ")}), so which one provides the identity "${record.name}" delegates to is unresolved. The artifact audit (#6) refuses the same list as an unresolved dependency decision.`,
          }),
        );
      } else {
        const decision = governing[0];
        if (decision !== undefined && decision.strategy !== "host" && decision.strategy !== "extension") {
          refused = true;
          failed(
            `It delegates to "${via}", which is decided \`${decision.strategy}\`: ${whyStrategyCannotProvideSharedIdentity(decision.strategy)} Only \`host\` and \`extension\` carry a module identity the page shares.`,
          );
        }
      }
    }

    const imports = record.imports;
    if (imports === undefined) {
      gaps.push("package-imports-absent");
    } else if (!declaresImport(imports, via)) {
      refused = true;
      failed(
        `It declares that its state is delegated to "${via}", but its stated imports do not reach that module, so the declaration delegates nothing.`,
      );
    }

    if (refused) {
      delegations.push({ package: record.name, via, status: "unbacked", stateSharingEstablished: false });
      continue;
    }

    delegations.push(
      gaps.length > 0
        ? { package: record.name, via, status: "undetermined", gaps, stateSharingEstablished: false }
        : // Backed, and that is all that can be said: the module is provided by the page,
          // the package reaches it, and there is one decision rather than several. Whether
          // the package's state is *in* it is not a question a module-id graph answers,
          // which is what the assessment carries.
          { package: record.name, via, status: "backed", stateSharingEstablished: false },
    );
  }

  return { diagnostics, delegations };
}

/** A report block for a CI log or a PR body. */
export function formatWorkspaceSourceAudit(audit: WorkspaceSourceAudit): string {
  const lines = [
    `Workspace graph: ${audit.graphActivation}${audit.graphActivation === "unstated" ? " (the caller did not supply one, so every workspace check abstains and no claim is made about workspace packages)" : ` — ${audit.packages.length} package(s): ${audit.packages.join(", ") || "(none)"}`}`,
    `Cell imports: ${audit.usage}${audit.usage === "unstated" ? " (not supplied, so no closure was traced and cycles were not looked for)" : ""}`,
  ];

  if (audit.closure !== undefined) {
    lines.push(
      `Workspace source in the closure: ${audit.closure.packages.join(", ") || "(none)"}`,
      `Published dependencies reached through it: ${audit.closure.externalModules.map(entry => entry.moduleId).join(", ") || "(none)"}`,
      `Cycles: ${audit.closure.cycles.map(cycle => cycle.chain.join(" → ")).join("; ") || "(none)"}`,
    );
  }

  if (audit.delegations.length > 0) {
    // Printed even when it is empty of findings, so "no diagnostics" cannot be read as
    // "the declared sharing was verified".
    lines.push(
      `Delegated identity: ${audit.delegations
        .map(delegation => {
          const qualifier =
            delegation.status === "undetermined" ? ` (undetermined: ${delegation.gaps.join(", ")})` : ` (${delegation.status})`;
          return `${delegation.package} → ${delegation.via}${qualifier}; state sharing ${delegation.stateSharingEstablished ? "established" : "NOT established by this audit and not locally checkable"}`;
        })
        .join("; ")}`,
    );
  }

  lines.push(
    audit.diagnostics.length === 0
      ? "No workspace source diagnostics."
      : `${audit.diagnostics.length} workspace source diagnostic(s):\n${formatWorkspaceSourceDiagnostics(audit.diagnostics)}`,
  );

  return lines.join("\n");
}
