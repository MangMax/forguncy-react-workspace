/**
 * The local dev contract's boundaries and claims, moved verbatim from `local-dev.ts` (#160).
 *
 * `local-dev.ts` remains that contract's module doc and the home of the sections it keeps; this
 * file holds the two sections stating what the loop may claim: "The emulator boundary" and "What
 * the local loop establishes, and what stays owed".
 */

import {
  checksForLevel,
  DEPENDENCY_STRATEGIES,
  isApplicationOwned,
} from "@forguncy-react-workspace/core/browser";
import type { DependencyCheckLevel, DependencyStrategy, OwnershipConcernId } from "@forguncy-react-workspace/core/browser";

import { LocalDevRuntimeContractError, localDevHandlingForStrategy } from "./local-dev.ts";

// ---------------------------------------------------------------------------
// The emulator boundary
// ---------------------------------------------------------------------------

export const LOCAL_DEV_BOUNDARY_IDS = [
  "no-project-routing-semantics",
  "no-page-lifecycle-fidelity",
  "no-permission-semantics",
  "no-extension-loader-fidelity",
  "no-designer-write-time-validation",
  "no-cross-cell-isolation-model",
] as const;

export type LocalDevBoundaryId = (typeof LOCAL_DEV_BOUNDARY_IDS)[number];

/**
 * What the harness does instead of the behaviour it must not reproduce.
 *
 * Enumerated so that "it is out of scope" and "the project has to supply
 * something" are visibly different answers. #22's Non-responsibilities forbid the
 * harness from claiming five behaviours, but it still has to *do* something about
 * each, and `out-of-scope` is a much stronger statement than an omission.
 */
export const LOCAL_DEV_BOUNDARY_BEHAVIOURS = [
  "out-of-scope",
  "mock-value-only",
  "substitute-or-diagnostic",
  "not-validated-locally",
  "single-cell-only",
] as const;

export type LocalDevBoundaryBehaviour = (typeof LOCAL_DEV_BOUNDARY_BEHAVIOURS)[number];

export interface LocalDevBoundary {
  readonly id: LocalDevBoundaryId;
  /** #22's Non-responsibility, in its own wording. */
  readonly statement: string;
  /**
   * The #4 concerns this boundary protects.
   *
   * Every entry must be Forguncy-owned: a boundary whose job is to stop the
   * harness from impersonating the platform cannot be about a capability the cell
   * owns. May be empty — but only when {@link ownedBy} names the contract that
   * actually owns the behaviour, because "there is no #4 concern for this" and
   * "nobody owns this" are very different statements.
   */
  readonly protects: readonly OwnershipConcernId[];
  /** The contract that owns the real behaviour, when no #4 concern covers it. */
  readonly ownedBy?: string;
  readonly why: string;
  readonly localBehaviour: LocalDevBoundaryBehaviour;
}

/**
 * #22's Non-responsibilities, one entry per bullet.
 *
 * Two of the six are the ones a reviewer is least likely to predict, and they are
 * recorded at length for that reason:
 *
 * - `no-designer-write-time-validation` runs the *opposite* way to the intuitive
 *   expectation. It is not that the local loop is weaker than the designer; it is
 *   that the two accept different source shapes, so a local pass is not weak
 *   evidence about designer acceptance, it is *no* evidence.
 * - `no-cross-cell-isolation-model` is a modelling hazard rather than a missing
 *   feature: mounting two cells into one local React tree would make React Context
 *   cross them, which is the exact opposite of what #5 measured on a page.
 */
export const LOCAL_DEV_BOUNDARIES: readonly LocalDevBoundary[] = [
  {
    id: "no-project-routing-semantics",
    statement: "Project routing/navigation semantics.",
    protects: ["application-navigation"],
    why: "#4 assigns navigation to Forguncy because the host owns the history and the page graph, and #5 recorded no navigation bridge a cell could delegate to. A local Vite process has neither a history the host can observe nor a page graph, so any navigation a harness offered would be a second, differently-behaving implementation of an application-owned concern — which is #4's definition of a platform conflict, not a convenience.",
    localBehaviour: "out-of-scope",
  },
  {
    id: "no-page-lifecycle-fidelity",
    statement: "Real page lifecycle details not proven by #5.",
    protects: ["page-lifecycle"],
    why: "#5 leaves the property-change re-render question open (`property-change-re-render`, owned by #6) and records that teardown renders `null` into the cell's own root from the runtime source rather than by observation. A harness that mounted and disposed a cell on a lifecycle of its own invention would be encoding a guess as a contract — the same refusal #27 makes when it declines to build a lifecycle API at all.",
    localBehaviour: "out-of-scope",
  },
  {
    id: "no-permission-semantics",
    statement: "Permissions/auth behavior.",
    protects: ["permissions"],
    why: "#4 puts the permission snapshot on the host's side precisely because the host resolved it before the page rendered. Locally the snapshot is a value the project typed in, so a cell can be made to pass or fail a permission check by editing the mock: the local process never authorises anything, and a cell that branches on a permission is exercising the branch, not the permission.",
    localBehaviour: "mock-value-only",
  },
  {
    id: "no-extension-loader-fidelity",
    statement: "MCP/extension loader behavior.",
    protects: [],
    ownedBy: "#12 (extension externals) / #19 / #20 (MCP sync)",
    why: "#5 records that page-level frontend-library load order is not guaranteed (`loadOrderGuaranteed: false`) and that a cell can render while another cell's declared libraries are still in flight (`crossCellReadinessGuaranteed: false`). Neither has an npm analogue: locally a dependency is simply present when the module graph says so, which is a *stronger* readiness guarantee than the page gives. A harness that resolved an extension-backed package to npm would therefore be presenting a guarantee the page does not make, and the failure it hides only appears once two cells race.",
    localBehaviour: "substitute-or-diagnostic",
  },
  {
    id: "no-designer-write-time-validation",
    statement: "Exact designer/CodeEditor behavior.",
    protects: [],
    ownedBy: "#5 (the recorded validation mechanism); #6 / #7 own its projection",
    why: "This is the sharpest local-versus-real gap in the whole loop, and it runs the opposite way to what a developer expects. #5 records the platform's write-time validator refusing `import` and `export` declarations outright — `ReactCellType does not support import statements` — and `CELL_SOURCE_VALIDATION_MECHANISM` records that those checks walk syntax nodes, with comments and tokens skipped. A local Vite project is made of `import` declarations. Source that compiles and renders perfectly under `vp dev` can therefore be refused by the designer before it is ever written, so a local pass is not weak evidence about designer acceptance — it is no evidence, and the harness must not present it as any.",
    localBehaviour: "not-validated-locally",
  },
  {
    id: "no-cross-cell-isolation-model",
    statement: "True cross-Cell deployment isolation unless explicitly simulated for a targeted test.",
    protects: ["cross-cell-communication", "application-state"],
    why: "#5 verified that all cells on a page share one `globalThis` and that component state, hooks and React Context stay local per cell *because* each cell is its own React root (`context-does-not-cross-cells`). A local process mounts whatever roots the harness creates, so mounting two cells into one tree would make Context cross them — a local model of the exact opposite of the page. The default is therefore one Cell per root; simulating two cells is a targeted test that has to say so.",
    localBehaviour: "single-cell-only",
  },
];

/**
 * Refuse a boundary that is not actually a boundary.
 *
 * Two failure shapes, both easy to write:
 *
 * - a boundary that protects a concern the *cell* owns — "the harness does not
 *   manage animation" reads like a boundary but is only a scope note, and
 *   inverting it is exactly what #27's equivalent guard exists to catch;
 * - a boundary that protects nothing and names nobody, which is an omission
 *   dressed as a decision.
 */
export function assertLocalDevBoundariesAreAdmissible(
  boundaries: readonly LocalDevBoundary[] = LOCAL_DEV_BOUNDARIES,
): void {
  for (const boundary of boundaries) {
    if (boundary.why.trim().length === 0) {
      throw new LocalDevRuntimeContractError(
        "boundary-not-admissible",
        `Local dev boundary "${boundary.id}" gives no reason, so a reader cannot tell which decision it implements.`,
      );
    }

    if (boundary.protects.length === 0 && boundary.ownedBy === undefined) {
      throw new LocalDevRuntimeContractError(
        "boundary-not-admissible",
        `Local dev boundary "${boundary.id}" protects no #4 concern and names no owner, so it records an omission rather than a boundary.`,
      );
    }

    if (!LOCAL_DEV_BOUNDARY_BEHAVIOURS.includes(boundary.localBehaviour)) {
      throw new LocalDevRuntimeContractError(
        "boundary-not-admissible",
        `Local dev boundary "${boundary.id}" declares behaviour "${boundary.localBehaviour}", which is not one of the recorded handlings.`,
      );
    }

    for (const concern of boundary.protects) {
      if (!isApplicationOwned(concern)) {
        throw new LocalDevRuntimeContractError(
          "boundary-not-admissible",
          `Local dev boundary "${boundary.id}" protects "${concern}", which #4 assigns to the cell. A harness declining to duplicate a capability the cell owns is a scope note, not a boundary.`,
        );
      }
    }
  }
}

/** The boundary that keeps a harness from impersonating a concern, when one exists. */
export function findLocalDevBoundaryForConcern(concern: OwnershipConcernId): LocalDevBoundary | undefined {
  return LOCAL_DEV_BOUNDARIES.find(boundary => boundary.protects.includes(concern));
}

/** Every #4 concern at least one local dev boundary refuses to model. */
export function localDevProtectedConcerns(): readonly OwnershipConcernId[] {
  return [...new Set(LOCAL_DEV_BOUNDARIES.flatMap(boundary => boundary.protects))];
}

// ---------------------------------------------------------------------------
// What the local loop establishes, and what stays owed
// ---------------------------------------------------------------------------

export const LOCAL_DEV_CLAIM_IDS = [
  "cell-source-mounts-unmodified",
  "cell-ui-renders",
  "hmr-round-trip",
  "repo-checks-pass",
  "dependency-substitutions-resolve",
] as const;

export type LocalDevClaimId = (typeof LOCAL_DEV_CLAIM_IDS)[number];

export interface LocalDevClaim {
  readonly id: LocalDevClaimId;
  readonly statement: string;
  /**
   * Always `local`, and typed as the literal rather than as `DependencyCheckLevel`.
   *
   * That is the whole mechanism: a claim that carried the general level type could
   * be written as `real-runtime` and would then type-check. #22's Problem section
   * asks for a local loop that does not pretend, and the type is where that stops
   * being a promise.
   */
  readonly level: "local";
  /** What the local loop does not establish by doing this. */
  readonly doesNotEstablish: string;
  /** The Issue or contract that owns the real evidence for it. */
  readonly realRuntimeOwner: string;
}

export const LOCAL_DEV_CLAIMS: readonly LocalDevClaim[] = [
  {
    id: "cell-source-mounts-unmodified",
    statement: "The Cell entry runs locally without any change to the source the artifact is generated from.",
    level: "local",
    doesNotEstablish:
      "That the same source is accepted by the platform's write-time validator — see `no-designer-write-time-validation`, which is the boundary this claim most often gets read past.",
    realRuntimeOwner: "#5 (the recorded validation mechanism); #6 / #7 project it",
  },
  {
    id: "cell-ui-renders",
    statement:
      "The Cell's own UI — components, interaction state, forms, visualisation — renders and behaves as authored.",
    level: "local",
    doesNotEstablish:
      "That it renders that way in a cell. Substituted host modules are the published packages, and #5 measured a cell in which a preset-conditional global is legitimately absent.",
    realRuntimeOwner: "#20 / #25 (real page and clean-checkout gate)",
  },
  {
    id: "hmr-round-trip",
    statement: "A source edit reaches the running UI through Vite's normal HMR path.",
    level: "local",
    doesNotEstablish:
      "Anything about the product. HMR is a property of the local bundler and has no counterpart in the designer or in a deployed cell.",
    realRuntimeOwner: "#20 / #25 (real page and clean-checkout gate)",
  },
  {
    id: "repo-checks-pass",
    statement: "Type checking, linting and the repository's test suite pass over this source.",
    level: "local",
    doesNotEstablish:
      "That the artifact is within budget or that it runs. Both are AGENTS.md's separate concerns: #21 measures the size envelope and only a page executes.",
    realRuntimeOwner: "#21 (measured budget) and #20 / #25 (execution)",
  },
  {
    id: "dependency-substitutions-resolve",
    statement:
      "Every module id #9's bridge intercepts resolves locally, and the ones with a recorded version resolve at that version.",
    level: "local",
    doesNotEstablish:
      "That the page provides the corresponding global, or that a narrowed bridged surface behaves the same way. Locally `react-dom/client` is the whole published module; on the page it is the members #5 observed and nothing else.",
    realRuntimeOwner: "#4's `real-runtime` checks per strategy, exercised through #20 / #25",
  },
];

/**
 * Refuse a claim that the local loop produced real-runtime evidence.
 *
 * The literal type on {@link LocalDevClaim.level} already makes this unrepresentable
 * for the shipped list. The guard exists for the same reason `core`'s table guards
 * exist: a project or a future caller can build its own list, and the one mistake
 * worth catching is the one that reads as success.
 */
export function assertLocalDevClaimsAreLocalOnly(claims: readonly LocalDevClaim[] = LOCAL_DEV_CLAIMS): void {
  for (const claim of claims) {
    if ((claim.level as DependencyCheckLevel) !== "local") {
      throw new LocalDevRuntimeContractError(
        "claim-not-local",
        `Claim "${claim.id}" is marked "${claim.level}". The local dev loop produces local evidence only; a claim at another level would report a local process as having validated the target.`,
      );
    }
  }
}

export interface LocalDevOwedCheck {
  readonly strategy: DependencyStrategy;
  /** #4's own wording for the check, not a restatement. */
  readonly check: string;
  readonly owner: string;
}

/**
 * Every check the local loop cannot discharge, read from `#4`'s strategy table.
 *
 * Derived from `checksForLevel` rather than listed, for the reason #14's review
 * established: a second copy of a rule is a second place for it to be wrong. A
 * strategy whose `real-runtime` checks are empty would produce nothing here, which
 * is the answer `#4` gives rather than an omission this module decided on.
 */
export function localDevRealRuntimeOwedChecks(): readonly LocalDevOwedCheck[] {
  return DEPENDENCY_STRATEGIES.flatMap(strategy =>
    checksForLevel(strategy, "real-runtime").map(check => ({
      strategy,
      check: check.description,
      owner: localDevHandlingForStrategy(strategy).realRuntimeClaimedBy,
    })),
  );
}

/** The local checks #4 allows for a strategy — what a local build *is* allowed to report. */
export function localDevDischargeableChecks(strategy: DependencyStrategy): readonly string[] {
  return checksForLevel(strategy, "local").map(check => check.description);
}

/**
 * The distinction #22's fifth acceptance criterion asks documentation to make,
 * in the form a report can print.
 *
 * Built from #4's tables and the records above, so it cannot drift: a strategy
 * whose `real-runtime` checks change changes this text, and a stage list that
 * gained a second real-runtime stage would fail
 * {@link assertLocalDevLoopStagesAreAdmissible} before any document was written.
 */
export function formatLocalDevValidationDistinction(): string {
  const owed = localDevRealRuntimeOwedChecks();
  return [
    "Local Vite+ development produces `local` evidence only.",
    "It establishes:",
    ...LOCAL_DEV_CLAIMS.map(claim => `- ${claim.statement}`),
    "It does not establish any real-runtime check. Still owed to a real Forguncy page:",
    ...owed.map(entry => `- [${entry.strategy}] ${entry.check} (owner: ${entry.owner})`),
  ].join("\n");
}

