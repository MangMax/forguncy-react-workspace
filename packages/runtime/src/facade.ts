/**
 * The façade's public surface: the six members authored source is allowed to
 * call, and the audit that keeps them honest.
 *
 * Decision source: GitHub Issue #27 — "Spec: typed Forguncy runtime facade for
 * application-owned capabilities"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/27).
 * Implementation: GitHub Issue #29 — "Implement: typed Forguncy runtime facade
 * and local mock provider"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/29).
 *
 * `capabilities.ts` decides *which* capabilities exist; `contract.ts` declares
 * the port they resolve through; `provider.ts` holds the installed provider.
 * This module is the thing a Cell author actually imports: named members, each
 * one an address for capabilities the registry admitted, each one resolving
 * through whichever provider the harness installed.
 *
 * ## Why six members and not twelve
 *
 * One member per capability would produce twelve signatures, and #5 pinned the
 * call shape of only four of them (`#27`'s `confirmation` field: `call-shape` for
 * `server-command-invocation`, `data-source-binding`, `permission-check` and
 * `permission-map-read`; `member-presence` for the other eight). So the surface is
 * split by that same line rather than by taste:
 *
 * - a `call-shape` capability is reachable through a **typed member** —
 *   `invokeServerCommand`, `useDataSource`, `hasPermission` and `getPermissions` —
 *   because a call was observed;
 * - a `member-presence` capability is reachable through a **declared-shape
 *   accessor** — `cellProp` and `forguncyMember` — which asserts the confirmed
 *   *address* and resolves to `unknown` until the caller declares the shape it
 *   expects.
 *
 * The two handle members keep the host's own names (`props.Forguncy.hasPermission`,
 * `props.Forguncy.getPermissions`) because the address is the thing a reader has to
 * be able to check against #5, and because a rename would give one binding two
 * spellings — the rule `RUNTIME_FACADE_FORBIDDEN_PATTERNS` already records. They are
 * two members rather than one because their return shapes differ, and they are typed
 * members rather than entries in `forguncyMember` because #5 *called* them: the
 * accessor exists for names whose signature nobody observed, so putting a called
 * member there would discard the one thing that lets the façade type it.
 *
 * That split is not documentation, it is checked: `auditRuntimeFacadeSurface`
 * reports `signature-outruns-confirmation` for a member that types a
 * presence-only capability, or refuses to type a call-shaped one. The rule is
 * the whole answer to #27's "do not invent APIs merely because they would be
 * convenient": a signature has to be paid for with evidence, and the only
 * currency is `confirmation`.
 *
 * ## What "declared shape" means, and what it does not
 *
 * `cellProp<Shaper>("Permissions")` and `forguncyMember<Signature>("logIn")`
 * resolve to whatever the caller declares. The façade's claim is the *address* —
 * that `Permissions` is a base prop key #5 observed, that the provider carries
 * it, and that the members list in `CELL_FORGUNCY_PROP_KEYS` is where `logIn`
 * comes from. The signature is the caller's claim, and the default is `unknown`:
 * it can be neither called nor assigned to anything narrower, so the shape of an
 * unprobed member reads as "cannot be safely used" rather than as a plausible
 * guess. `(...parameters: never[]) => unknown` was the other candidate for that
 * default and is wrong — TypeScript accepts a zero-argument call of it, which is
 * a call #5 never observed.
 *
 * ## Why the surface holds no provider kind
 *
 * `RUNTIME_FACADE_RESOLUTION_MODEL` (contract.ts): "the provider is selected by
 * the harness, not by the Cell. Authored source never observes which provider it
 * got." So the surface has no `kind` and no `bindings`, and the audit reports
 * `surface-member-unregistered` if one appears: `runtimeFacadeProviderState()`
 * is how a harness or a diagnostic asks that question, and it is deliberately
 * not on the surface.
 *
 * ## What stayed here after #124
 *
 * The runtime half — the accessor, the two address tuples it validates against and the provider
 * the compiled Cell installs — moved to `cell-runtime.ts`. The reason is the module graph a
 * compiled Cell carries: this file's audit reads `capabilities.ts`, an evidence table a Cell
 * never executes, and a statically imported table is an edge into every artifact that imports
 * this module's barrel. What remains here is the declaration (`RUNTIME_FACADE_SURFACE`) and every
 * check comparing it with the accessors, which is the toolchain side of the same contract; the
 * runtime half is imported for those checks and re-exported from its own module, so the package's
 * root entry is unchanged.
 */


import type { RuntimeFacade, RuntimeFacadeSurfaceMemberId } from "./cell-runtime.ts";
import { runtimeFacadeSurface } from "./cell-runtime.ts";
import {
  findRuntimeFacadeCapability,
  RUNTIME_FACADE_CAPABILITIES,
  RuntimeFacadeContractError,
  runtimeFacadeBindingName,
} from "./capabilities.ts";
import type { RuntimeFacadeCapabilityId, RuntimeFacadeHostBinding } from "./capabilities.ts";
import { RUNTIME_FACADE_PORT_HOOK_NAME } from "./port.ts";

// The runtime half of the surface — the accessor, the two address tuples it validates against,
// and the provider a compiled Cell installs — lives in `cell-runtime.ts` (#124). It is imported
// above because the audit here compares it with the registry, and it is *not* re-exported through
// this module (#157): the root entry takes each of those names from `cell-runtime.ts` directly, so
// there is one hop from a defining module to the barrel rather than two. The audit below is what
// stayed here, and it reads the capability registry, which a Cell never does.

/**
 * How far a surface member's signature is allowed to go.
 *
 * `confirmed-call-shape` types the call, because `#5` executed one.
 * `caller-declared-shape` asserts the address and hands the value over as
 * `unknown`, because `#5` observed only the name. The audit pairs these with
 * `RuntimeFacadeConfirmation` in both directions.
 */
export const RUNTIME_FACADE_SURFACE_SIGNATURES = [
  "confirmed-call-shape",
  "caller-declared-shape",
] as const;

export type RuntimeFacadeSurfaceSignature = (typeof RUNTIME_FACADE_SURFACE_SIGNATURES)[number];

/**
 * Which host bindings a member can carry.
 *
 * Data rather than a switch on the member's id: `runtimeFacadeMemberCarriesBinding`
 * compares this against a capability's own `hostBindings`, so the answer to
 * "does this member reach that address" is derived from the two registries
 * instead of restated. A new member therefore has to say what it carries rather
 * than inheriting a channel.
 */
export type RuntimeFacadeSurfaceCarrier =
  | { readonly kind: "cell-prop" }
  | { readonly kind: "forguncy-member" }
  | { readonly kind: "cell-hook"; readonly hook: string };

export interface RuntimeFacadeSurfaceMember {
  readonly id: RuntimeFacadeSurfaceMemberId;
  /** The admitted capabilities this member is the surface for. Never empty. */
  readonly exposes: readonly RuntimeFacadeCapabilityId[];
  readonly carrier: RuntimeFacadeSurfaceCarrier;
  readonly signature: RuntimeFacadeSurfaceSignature;
  readonly summary: string;
}

/**
 * The surface, as data.
 *
 * `exposes` names the capabilities a member is the surface for, and the two
 * registries decide whether that is consistent: a capability no member exposes is
 * `capability-unexposed`, and one whose address no exposing member can carry is
 * `address-unreachable`. Keeping the list here rather than deriving the members
 * from the registry is what lets the audit compare a *built* object against the
 * declaration — the `member-not-implemented` / `surface-member-unregistered` pair
 * below — instead of comparing the registry with itself.
 */
export const RUNTIME_FACADE_SURFACE: readonly RuntimeFacadeSurfaceMember[] = [
  {
    id: "invokeServerCommand",
    exposes: ["server-command-invocation"],
    carrier: { kind: "cell-prop" },
    signature: "confirmed-call-shape",
    summary: "Invoke a server command the designer made available to this Cell.",
  },
  {
    id: "useDataSource",
    exposes: ["data-source-binding"],
    carrier: { kind: "cell-hook", hook: RUNTIME_FACADE_PORT_HOOK_NAME },
    signature: "confirmed-call-shape",
    summary: "Read a data source the page declared, with its loading and error state.",
  },
  {
    id: "hasPermission",
    exposes: ["permission-check"],
    carrier: { kind: "forguncy-member" },
    signature: "confirmed-call-shape",
    summary: "Ask the host's own permission check whether the current user holds a permission.",
  },
  {
    id: "getPermissions",
    exposes: ["permission-map-read"],
    carrier: { kind: "forguncy-member" },
    signature: "confirmed-call-shape",
    summary: "Read the host's permission map, one boolean per configured permission name.",
  },
  {
    id: "cellProp",
    exposes: ["permission-snapshot", "image-context"],
    carrier: { kind: "cell-prop" },
    signature: "caller-declared-shape",
    summary: "Read a confirmed base prop under its own name, with the caller declaring its shape.",
  },
  {
    id: "forguncyMember",
    exposes: [
      "current-user",
      "session-control",
      "file-upload",
      "upload-limit",
      "cell-method-exposure",
      "forguncy-value-conversions",
    ],
    carrier: { kind: "forguncy-member" },
    signature: "caller-declared-shape",
    summary: "Reach a confirmed member of the `props.Forguncy` handle under its own name.",
  },
];

export function findRuntimeFacadeSurfaceMember(id: RuntimeFacadeSurfaceMemberId): RuntimeFacadeSurfaceMember {
  const member = RUNTIME_FACADE_SURFACE.find(candidate => candidate.id === id);
  if (!member) {
    throw new RuntimeFacadeContractError("surface-not-exposed", `Unknown façade surface member "${id}".`);
  }
  return member;
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

export const RUNTIME_FACADE_SURFACE_FINDING_IDS = [
  "member-exposes-nothing",
  "capability-not-admitted",
  "signature-outruns-confirmation",
  "capability-unexposed",
  "address-unreachable",
  "member-not-implemented",
  "surface-member-unregistered",
] as const;

export type RuntimeFacadeSurfaceFindingId = (typeof RUNTIME_FACADE_SURFACE_FINDING_IDS)[number];

export interface RuntimeFacadeSurfaceFinding {
  readonly id: RuntimeFacadeSurfaceFindingId;
  readonly statement: string;
  readonly member?: RuntimeFacadeSurfaceMemberId;
  readonly capability?: RuntimeFacadeCapabilityId;
  readonly address?: string;
}

/** True when a member can carry this exact binding, by address rather than by kind. */
export function runtimeFacadeMemberCarriesBinding(
  member: RuntimeFacadeSurfaceMember,
  binding: RuntimeFacadeHostBinding,
): boolean {
  switch (binding.kind) {
    case "cell-prop":
      return member.carrier.kind === "cell-prop";
    case "forguncy-member":
      return member.carrier.kind === "forguncy-member";
    case "cell-hook":
      return member.carrier.kind === "cell-hook" && member.carrier.hook === binding.hook;
  }
}

/**
 * The confirmed addresses a member reaches, derived from the two registries.
 *
 * Derived rather than listed per member, so a capability that gains a second
 * address cannot leave a member's domain behind. The accessors' *types* are
 * literal tuples (`RUNTIME_FACADE_CELL_PROP_ADDRESSES`, because a parameter type
 * cannot be computed here), and a test compares those against this derivation —
 * which is the only place the two are allowed to meet.
 */
export function runtimeFacadeExposedAddresses(
  memberId: RuntimeFacadeSurfaceMemberId,
): readonly RuntimeFacadeHostBinding[] {
  const member = findRuntimeFacadeSurfaceMember(memberId);
  return member.exposes
    .flatMap(capabilityId => findRuntimeFacadeCapability(capabilityId).hostBindings)
    .filter(binding => runtimeFacadeMemberCarriesBinding(member, binding));
}

export function runtimeFacadeExposedAddressNames(memberId: RuntimeFacadeSurfaceMemberId): readonly string[] {
  return runtimeFacadeExposedAddresses(memberId).map(runtimeFacadeBindingName);
}

/**
 * Every way the surface and the registries can disagree, as findings.
 *
 * Returns findings instead of throwing so that a caller can report all of them
 * at once: a surface that drifted covers more than one rule at a time, and
 * fixing them one exception per run is how the drift survives. The two
 * implementation checks are the reason this takes the built surface as an
 * argument rather than reading the registry — they compare the registry against
 * the object a Cell actually gets.
 */
export function auditRuntimeFacadeSurface(
  members: readonly RuntimeFacadeSurfaceMember[] = RUNTIME_FACADE_SURFACE,
  implemented: RuntimeFacade = runtimeFacadeSurface(),
): readonly RuntimeFacadeSurfaceFinding[] {
  const findings: RuntimeFacadeSurfaceFinding[] = [];

  for (const member of members) {
    if (member.exposes.length === 0) {
      findings.push({
        id: "member-exposes-nothing",
        member: member.id,
        statement: `Surface member "${member.id}" exposes no capability, so it asserts nothing about the host.`,
      });
    }

    for (const capabilityId of member.exposes) {
      const capability = RUNTIME_FACADE_CAPABILITIES.find(candidate => candidate.id === capabilityId);
      if (!capability) {
        findings.push({
          id: "capability-not-admitted",
          member: member.id,
          capability: capabilityId,
          statement: `Surface member "${member.id}" exposes "${capabilityId}", which the capability registry does not admit.`,
        });
        continue;
      }
      // The rule that makes "do not invent APIs" checkable: a typed member may
      // only type what #5 called, and a declared-shape accessor may only carry
      // what #5 merely named.
      const expected =
        member.signature === "confirmed-call-shape" ? "call-shape" : "member-presence";
      if (capability.confirmation !== expected) {
        findings.push({
          id: "signature-outruns-confirmation",
          member: member.id,
          capability: capabilityId,
          statement: `Surface member "${member.id}" is "${member.signature}" but "${capabilityId}" is only confirmed to "${capability.confirmation}".`,
        });
      }
    }
  }

  for (const capability of RUNTIME_FACADE_CAPABILITIES) {
    const exposing = members.filter(member => member.exposes.includes(capability.id));
    if (exposing.length === 0) {
      findings.push({
        id: "capability-unexposed",
        capability: capability.id,
        statement: `Capability "${capability.id}" is admitted but no surface member exposes it, so authored source cannot reach it through the façade.`,
      });
      continue;
    }
    for (const binding of capability.hostBindings) {
      if (!exposing.some(member => runtimeFacadeMemberCarriesBinding(member, binding))) {
        findings.push({
          id: "address-unreachable",
          capability: capability.id,
          address: runtimeFacadeBindingName(binding),
          statement: `Capability "${capability.id}" addresses "${runtimeFacadeBindingName(binding)}", which none of the members exposing it can carry.`,
        });
      }
    }
  }

  for (const member of members) {
    if (!Object.hasOwn(implemented, member.id)) {
      findings.push({
        id: "member-not-implemented",
        member: member.id,
        statement: `Surface member "${member.id}" is registered but the accessor does not return it.`,
      });
    }
  }
  for (const key of Object.keys(implemented)) {
    if (!members.some(member => member.id === key)) {
      findings.push({
        id: "surface-member-unregistered",
        statement: `The accessor returns "${key}", which no surface member registers — a provider-facing or otherwise unadmitted member.`,
      });
    }
  }

  return findings;
}

/** Refuse a surface that drifted away from the registry. */
export function assertRuntimeFacadeSurfaceIsExposed(
  members: readonly RuntimeFacadeSurfaceMember[] = RUNTIME_FACADE_SURFACE,
  implemented: RuntimeFacade = runtimeFacadeSurface(),
): void {
  const findings = auditRuntimeFacadeSurface(members, implemented);
  if (findings.length > 0) {
    throw new RuntimeFacadeContractError(
      "surface-not-exposed",
      `The façade surface disagrees with its registries: ${findings.map(finding => finding.statement).join(" ")}`,
    );
  }
}
