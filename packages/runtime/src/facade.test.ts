import { afterEach, describe, expect, it } from "vitest";

import { CELL_FORGUNCY_PROP_KEYS, CELL_PROPS_BASE_KEYS } from "@forguncy-react-workspace/core";

import { RUNTIME_FACADE_CAPABILITY_IDS, RuntimeFacadeContractError } from "./capabilities.ts";
import {
  assertRuntimeFacadeSurfaceIsExposed,
  auditRuntimeFacadeSurface,
  findRuntimeFacadeSurfaceMember,
  RUNTIME_FACADE_SURFACE,
  RUNTIME_FACADE_SURFACE_FINDING_IDS,
  runtimeFacadeExposedAddressNames,
  runtimeFacadeMemberCarriesBinding,
} from "./facade.ts";
import type { RuntimeFacadeSurfaceMember } from "./facade.ts";
// The runtime half, from the module that defines it (#157): `facade.ts` no longer forwards these.
import {
  RUNTIME_FACADE_CELL_PROP_ADDRESSES,
  RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES,
  RUNTIME_FACADE_SURFACE_MEMBER_IDS,
  runtimeFacade,
  runtimeFacadeSurface,
} from "./cell-runtime.ts";
import type { RuntimeFacade } from "./cell-runtime.ts";
import type { DataSourceResult, RuntimeFacadeCellProps } from "./contract.ts";
import { createHostRuntimeFacadeProvider } from "./host-provider.ts";
import { createMockDataSource, createMockRuntimeFacadeProvider } from "./mock-provider.ts";
import { installRuntimeFacadeProvider, uninstallRuntimeFacadeProvider } from "./provider.ts";

afterEach(() => {
  uninstallRuntimeFacadeProvider();
});

describe("the surface registry", () => {
  /**
   * #27's first acceptance criterion — "every facade API maps to a confirmed
   * host/product capability" — in the form that can fail.
   *
   * Two directions, because either alone is satisfiable by a lie: a member
   * exposing something the registry never admitted, and an admitted capability no
   * member exposes (authored source then has no way to reach it through the
   * façade, which is the state #29 exists to end).
   */
  it("exposes exactly the admitted capabilities", () => {
    const exposed = new Set(RUNTIME_FACADE_SURFACE.flatMap(member => member.exposes));
    expect([...exposed].sort()).toEqual([...RUNTIME_FACADE_CAPABILITY_IDS].sort());
    expect(() => assertRuntimeFacadeSurfaceIsExposed()).not.toThrow();
    expect(auditRuntimeFacadeSurface()).toEqual([]);
  });

  // Seventeen members since #177: the four original typed members, the eleven typed
  // members #176's measured evidence pays for (including the two new dynamic-binding
  // capabilities `cellProperty`/`fireEvent`), and the two declared-shape accessors —
  // one reduced to the single presence-only address that remains (`ImageContext`),
  // one kept deliberately empty for the next presence-only member the probe adds.
  it("records exactly the seventeen members, in order", () => {
    expect([...RUNTIME_FACADE_SURFACE_MEMBER_IDS]).toEqual([
      "invokeServerCommand",
      "useDataSource",
      "hasPermission",
      "getPermissions",
      "permissionSnapshot",
      "getCurrentUser",
      "logIn",
      "logOut",
      "uploadFiles",
      "getUploadLimit",
      "exposeMethod",
      "convertDateToOADate",
      "convertOADateToDate",
      "convertToCssColor",
      "cellProperty",
      "fireEvent",
      "cellProp",
      "forguncyMember",
    ]);
    expect(RUNTIME_FACADE_SURFACE.map(member => member.id)).toEqual([...RUNTIME_FACADE_SURFACE_MEMBER_IDS]);
    for (const member of RUNTIME_FACADE_SURFACE) {
      expect(member.summary.trim().length, member.id).toBeGreaterThan(10);
    }
  });

  // The registry is the contract; the accessor is what a Cell gets. Comparing
  // them is the only way a documented member cannot exist without being callable
  // — and it is also what keeps the surface from growing a provider-facing member
  // (`kind`, `bindings`), which is the coupling #27 names.
  it("returns exactly the members it registers, and nothing else", () => {
    const returned = Object.keys(runtimeFacadeSurface()).sort();
    expect(returned).toEqual([...RUNTIME_FACADE_SURFACE_MEMBER_IDS].sort());
    expect(returned).not.toContain("kind");
    expect(returned).not.toContain("bindings");
    expect(returned).not.toContain("provider");
  });

  it("carries each member's confirmed signature strength", () => {
    const typed = RUNTIME_FACADE_SURFACE.filter(
      member => member.signature === "confirmed-call-shape",
    ).map(member => member.id);
    expect(typed).toEqual([
      "invokeServerCommand",
      "useDataSource",
      "hasPermission",
      "getPermissions",
      "permissionSnapshot",
      "getCurrentUser",
      "logIn",
      "logOut",
      "uploadFiles",
      "getUploadLimit",
      "exposeMethod",
      "convertDateToOADate",
      "convertOADateToDate",
      "convertToCssColor",
      "cellProperty",
      "fireEvent",
    ]);

    // Each typed handle member's address is the host's own name for it, so a reader
    // can check the signature against #5 instead of decoding a rename.
    expect(runtimeFacadeExposedAddressNames("hasPermission")).toEqual(["hasPermission"]);
    expect(runtimeFacadeExposedAddressNames("getPermissions")).toEqual(["getPermissions"]);
  });

  it("leaves exactly the two declared-shape accessors, one reduced and one empty", () => {
    // The end state #176's reviewer said the audit relaxation depends on: a capability
    // whose evidence reached `call-shape` no longer sits behind a weak accessor. What
    // remains is the one address whose evidence genuinely stops at `member-presence`
    // (`image-context`'s populated shape), and the deliberately empty `forguncyMember`
    // — the landing spot for the next presence-only member rather than a dead accessor.
    const weak = RUNTIME_FACADE_SURFACE.filter(
      member => member.signature === "caller-declared-shape",
    ).map(member => member.id);
    expect(weak).toEqual(["cellProp", "forguncyMember"]);
    expect(findRuntimeFacadeSurfaceMember("forguncyMember").exposes).toEqual([]);
    expect(findRuntimeFacadeSurfaceMember("cellProp").exposes).toEqual(["image-context"]);
  });

  it("refuses an unknown member id rather than returning undefined", () => {
    // @ts-expect-error an unknown id must not be accepted at the type level either
    expect(() => findRuntimeFacadeSurfaceMember("navigate")).toThrow(/Unknown façade surface member/);
  });
});

// A member's *address domain* is derived from the two registries, and the
// accessors' parameter types are literal tuples because a parameter type cannot
// be computed from them. This is where the two are allowed to meet, so drift is a
// failing test rather than a call that compiles and throws.
describe("accessor address domains", () => {
  function sorted(names: readonly string[]): readonly string[] {
    return [...names].sort();
  }

  it("derives the cellProp domain from the capabilities it exposes", () => {
    expect(sorted(runtimeFacadeExposedAddressNames("cellProp"))).toEqual(
      sorted([...RUNTIME_FACADE_CELL_PROP_ADDRESSES]),
    );
    expect(new Set(RUNTIME_FACADE_CELL_PROP_ADDRESSES).size).toBe(
      RUNTIME_FACADE_CELL_PROP_ADDRESSES.length,
    );
    for (const key of RUNTIME_FACADE_CELL_PROP_ADDRESSES) {
      expect(CELL_PROPS_BASE_KEYS, key).toContain(key);
    }
  });

  it("derives the forguncyMember domain from the capabilities it exposes", () => {
    expect(sorted(runtimeFacadeExposedAddressNames("forguncyMember"))).toEqual(
      sorted([...RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES]),
    );
    expect(new Set(RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES).size).toBe(
      RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES.length,
    );
    for (const member of RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES) {
      expect(CELL_FORGUNCY_PROP_KEYS, member).toContain(member);
    }
    // Empty since #177: all fourteen handle members are accounted for elsewhere —
    // eleven typed members (counting the conversion renames and the snapshot), the
    // two wrapper-locals the cell scope already names, and nothing left over. The
    // complement count is asserted rather than the emptiness alone so a member
    // re-entering this domain — the accessor's whole remaining purpose — changes
    // both numbers and cannot slip through as arithmetic a reader has to redo.
    expect(CELL_FORGUNCY_PROP_KEYS.length - RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES.length).toBe(14);
    expect(RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES).toEqual([]);
  });

  /**
   * The exclusions, asserted rather than left to a reader's arithmetic.
   *
   * Each one has a reason, and each reason is a rule this repository already
   * holds: `ServerCommands` has a call-shaped member of its own, `Permissions` is
   * the base prop the same capability already exposes, `hasPermission` and
   * `getPermissions` have typed members of their own, and the two
   * `DataSource*Type` members are names a Cell can already use without an import
   * (#5's user-scope table), so addressing them would give one value two
   * spellings.
   */
  it("keeps the addresses another member or the cell scope already owns out of the accessors", () => {
    expect(RUNTIME_FACADE_CELL_PROP_ADDRESSES as readonly string[]).not.toContain("ServerCommands");
    // `Permissions` moved out of `cellProp`'s domain with #177: its measured
    // identity-equality and one-boolean-per-name shape are exactly what
    // `permissionSnapshot` types, so reaching it through the weak accessor would be
    // the second-address failure the exclusion exists to refuse.
    expect(RUNTIME_FACADE_CELL_PROP_ADDRESSES as readonly string[]).not.toContain("Permissions");
    // Every typed handle member is out of `forguncyMember`'s domain for the same reason —
    // asserted per address rather than by inspecting the empty tuple, so a regression that
    // re-admitted one would name it here.
    for (const typedMember of [
      "getCurrentUser",
      "logIn",
      "logOut",
      "uploadFiles",
      "getUploadLimit",
      "exposeMethod",
      "ConvertDateToOADate",
      "ConvertOADateToDate",
      "ConvertToCssColor",
    ]) {
      expect(RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES as readonly string[], typedMember).not.toContain(typedMember);
    }

    // Each omitted name is a real confirmed address, so the exclusions are
    // choices rather than gaps in #5's evidence.
    expect(CELL_PROPS_BASE_KEYS).toContain("ServerCommands");
    expect(CELL_PROPS_BASE_KEYS).toContain("Permissions");
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("Permissions");
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("hasPermission");
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("getPermissions");
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("DataSourceCompareType");
  });

  // Keyed on the address rather than on the kind, so a second wrapper-local
  // cannot ride along on useDataSource's channel.
  it("matches a wrapper-local by name, not by being a wrapper-local", () => {
    const hookMember = findRuntimeFacadeSurfaceMember("useDataSource");
    expect(
      runtimeFacadeMemberCarriesBinding(hookMember, { kind: "cell-hook", hook: "useDataSource" }),
    ).toBe(true);
    expect(
      runtimeFacadeMemberCarriesBinding(hookMember, { kind: "cell-hook", hook: "someOtherLocal" }),
    ).toBe(false);
  });
});

// The audit is the guard #27 never had: the registry can be internally consistent
// and still describe a surface nobody implemented, or a surface that is reachable
// only through an address its member cannot carry. Each finding is driven by a
// mutation of the registry, so the check is asserted rather than assumed.
describe("surface audit", () => {
  function findingsFrom(members: readonly RuntimeFacadeSurfaceMember[]): readonly string[] {
    return auditRuntimeFacadeSurface(members).map(finding => finding.id);
  }

  it("records exactly the seven findings it can report", () => {
    expect([...RUNTIME_FACADE_SURFACE_FINDING_IDS]).toEqual([
      "member-exposes-nothing",
      "capability-not-admitted",
      "signature-outruns-confirmation",
      "capability-unexposed",
      "address-unreachable",
      "member-not-implemented",
      "surface-member-unregistered",
    ]);
  });

  it("refuses a member that exposes no capability", () => {
    // `forguncyMember` is empty by design since #177 (its summary says why the empty
    // accessor stays), so the mutation has to empty a member that is *supposed* to be
    // full: `cellProp` is the other declared-shape accessor, and emptying it is the
    // drift the finding exists to catch.
    const members = RUNTIME_FACADE_SURFACE.map(member =>
      member.id === "cellProp" ? { ...member, exposes: [] } : member,
    );
    expect(findingsFrom(members)).toContain("member-exposes-nothing");
  });

  // The `navigate` case #27 forbids by name: a member whose address is not in the
  // registry has to be reported, not resolved.
  it("refuses a member that exposes a capability the registry does not admit", () => {
    const members = RUNTIME_FACADE_SURFACE.map(member =>
      member.id === "forguncyMember"
        ? { ...member, exposes: [...member.exposes, "application-navigation" as never] }
        : member,
    );
    expect(findingsFrom(members)).toContain("capability-not-admitted");
  });

  it("refuses a signature that outruns the confirmation", () => {
    // The only direction the rule now refuses: typing what the evidence does not pin.
    // `caller-declared-shape` is the floor rather than a ceiling (#176), so a member
    // whose evidence has since been upgraded does not produce a finding — the rule
    // would otherwise punish every legitimate evidence upgrade by forcing a
    // simultaneous accessor redesign.
    const upgraded = RUNTIME_FACADE_SURFACE.map(member =>
      member.id === "cellProp" ? { ...member, signature: "confirmed-call-shape" as const } : member,
    );
    expect(findingsFrom(upgraded)).toContain("signature-outruns-confirmation");

    // The other direction is now admissible: declaring `caller-declared-shape` for a
    // capability already at `call-shape` is the steady state between #176 (evidence
    // upgraded) and #177 (typed members added), and must not produce a finding.
    const downgraded = RUNTIME_FACADE_SURFACE.map(member =>
      member.id === "invokeServerCommand" ? { ...member, signature: "caller-declared-shape" as const } : member,
    );
    expect(findingsFrom(downgraded)).not.toContain("signature-outruns-confirmation");
  });

  it("names a capability no member exposes", () => {
    // `getCurrentUser` is the only member exposing `current-user`, so dropping it is the
    // minimal mutation that strands exactly one capability.
    const members = RUNTIME_FACADE_SURFACE.filter(member => member.id !== "getCurrentUser");
    const findings = auditRuntimeFacadeSurface(members);
    expect(findings.map(finding => finding.id)).toContain("capability-unexposed");
    expect(
      findings
        .filter(finding => finding.id === "capability-unexposed")
        .map(finding => finding.capability),
    ).toContain("current-user");
    // Exactly the one `getCurrentUser` was the only surface for. The count is
    // asserted so a capability that quietly becomes reachable through nothing else
    // cannot hide behind the `toContain` above.
    expect(findings.filter(finding => finding.id === "capability-unexposed")).toHaveLength(1);
  });

  // The narrow case, and the one the first draft of this design got wrong: the
  // capability *is* exposed, but through a member that cannot carry one of its
  // two addresses.
  it("names an address the members that expose it cannot carry", () => {
    // `cell-event-firing`'s measured address is a declared prop, so moving `fireEvent`'s
    // carrier to the wrong kind strands the address in exactly the way the finding names —
    // exposed, but through a member whose carrier cannot reach it. (Mutating the carrier
    // rather than the exposes list keeps every other capability fully exposed, so the
    // `.find` below cannot be answered by a different finding first.)
    const members = RUNTIME_FACADE_SURFACE.map(member =>
      member.id === "fireEvent"
        ? { ...member, carrier: { kind: "forguncy-member" as const } }
        : member,
    );
    const finding = auditRuntimeFacadeSurface(members).find(
      candidate => candidate.id === "address-unreachable",
    );
    expect(finding?.capability).toBe("cell-event-firing");
    expect(finding?.address).toBe("<eventHandlers[].eventName>");
  });

  it("catches a registered member the accessor does not return", () => {
    const implemented = withoutMember("cellProp");
    expect(auditRuntimeFacadeSurface(RUNTIME_FACADE_SURFACE, implemented).map(f => f.id)).toContain(
      "member-not-implemented",
    );
  });

  it("catches a returned member the registry does not declare", () => {
    const implemented = { ...runtimeFacadeSurface(), navigate: () => undefined } as unknown as RuntimeFacade;
    const findings = auditRuntimeFacadeSurface(RUNTIME_FACADE_SURFACE, implemented);
    expect(findings.map(finding => finding.id)).toContain("surface-member-unregistered");
    expect(findings.find(finding => finding.id === "surface-member-unregistered")?.statement).toMatch(
      /navigate/,
    );
  });

  it("reports every finding at once, and refuses with a contract error", () => {
    // Dropping `getCurrentUser` strands its capability *and* leaves the session-control
    // pair untouched, so more than one finding fires — which is what the
    // "reports every finding at once" half needs.
    const members = RUNTIME_FACADE_SURFACE.filter(member => member.id !== "getCurrentUser" && member.id !== "logIn");
    expect(auditRuntimeFacadeSurface(members).length).toBeGreaterThan(1);

    let caught: unknown;
    try {
      assertRuntimeFacadeSurfaceIsExposed(members);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeFacadeContractError);
    expect((caught as RuntimeFacadeContractError).code).toBe("surface-not-exposed");
  });
});

function withoutMember(id: (typeof RUNTIME_FACADE_SURFACE_MEMBER_IDS)[number]): RuntimeFacade {
  const copy: Record<string, unknown> = { ...runtimeFacadeSurface() };
  delete copy[id];
  return copy as unknown as RuntimeFacade;
}

// #27's second and fifth acceptance criteria, at the point of use: a Cell reaches
// the supported capabilities through the façade, and an unsupported one fails
// clearly instead of answering with a plausible value.
describe("resolving through the installed provider", () => {
  function installMock(): void {
    installRuntimeFacadeProvider(
      createMockRuntimeFacadeProvider({
        // Synchronous, as #5 recorded them: `hasPermission("ProbePermission")` → `true`
        // and `getPermissions()` → `{"ProbePermission": true}`, neither awaited, beside a
        // command call the same section reports as `await … resolved in 185 ms`. A mock
        // that resolved them would be more permissive than the host, which is the one
        // direction a local harness must not lean.
        forguncyMembers: {
          hasPermission: (permissionName: string) => permissionName.endsWith("@readable"),
          getPermissions: () => ({ "dev@readable": true }),
          // One of the six #5 pinned by name only, so the declared-shape accessor has
          // something to reach that is not also a typed member.
          getCurrentUser: () => ({ UserName: "dev@example.com" }),
        },
        cellProps: { Permissions: { "Orders.Read": true } },
        // The call shape #5 executed: one object argument.
        serverCommands: {
          GetSalesData: async payload => ({ errorCode: 0, errorMessage: "OK", echo: payload }),
        },
        dataSources: { Sales: createMockDataSource([{ month: "6月" }], { totalCount: 72 }) },
      }),
    );
  }

  it("reads the permission snapshot typed, with no declaration and no await", () => {
    installMock();
    // The shape an executed page hands a Cell: a plain record of configured name to
    // boolean, not an array of descriptors — and since #177 the typed member reads it
    // directly rather than through a declared-shape accessor.
    expect(runtimeFacade().permissionSnapshot()).toEqual({ "Orders.Read": true });
  });

  // The rule that separates a value prop from a function member: the resolver answers
  // *presence*, and what the value holds is the caller's to declare. The runtime
  // injects `{}` for an unconfigured `ImageContext` and a harness may hand over
  // `undefined`; neither is a missing binding, so neither is refused.
  it("passes a value prop through whatever it holds instead of inventing an error", () => {
    installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());
    expect(runtimeFacade().cellProp("ImageContext")).toEqual({});

    uninstallRuntimeFacadeProvider();
    installRuntimeFacadeProvider(
      createMockRuntimeFacadeProvider({ cellProps: { ImageContext: undefined } }),
    );
    expect(runtimeFacade().cellProp("ImageContext")).toBeUndefined();
  });

  it("reaches the typed user member without declaring anything", () => {
    installMock();
    // `getCurrentUser` stopped being presence-only when #176 measured its call shape:
    // the typed member *is* the end state the accessor was the transitional one for.
    const user = runtimeFacade().getCurrentUser();
    expect(user.UserName).toBe("dev@example.com");
  });

  // The other half of the same split, and the one review corrected: `hasPermission`
  // and `getPermissions` are *calls* #5 executed, so an author declares nothing and
  // awaits nothing.
  it("types the two handle calls #5 executed, so the author declares and awaits nothing", () => {
    installMock();
    expect(runtimeFacade().hasPermission("dev@readable")).toBe(true);
    expect(runtimeFacade().hasPermission("dev@other")).toBe(false);
    expect(runtimeFacade().getPermissions()).toEqual({ "dev@readable": true });
  });

  it("names the typed member when a confirmed call is reached through the accessor", () => {
    installMock();
    // Same rule as `cellProp("ServerCommands")`: one address, one member. Reaching a
    // typed call through the declared-shape accessor would give the façade a second
    // way to be called wrongly. The accessor's domain is empty since #177, so every
    // one of these is `as never` — the runtime guard is what is being asserted, and
    // the message has to point at the typed member that owns the address now.
    expect(() => runtimeFacade().forguncyMember("hasPermission" as never)).toThrow(
      /not the member that exposes it/,
    );
    expect(() => runtimeFacade().forguncyMember("getPermissions" as never)).toThrow(
      /not the member that exposes it/,
    );
  });

  it("reads a declared data source, and keeps the host's error state for an undeclared one", () => {
    installMock();
    const source = runtimeFacade().useDataSource("Sales", { top: 3 });
    expect(source.totalCount).toBe(72);
    expect(source.data).toHaveLength(1);

    // Not a throw: #5 records an undeclared source as a state, so the façade
    // passes the host's own shape through.
    const missing = runtimeFacade().useDataSource("NotDeclared");
    expect(missing.error).toBeTruthy();
    expect(String(missing.error)).toContain("NotDeclared");
  });

  it("returns the reserved keys and the command's own named returns", async () => {
    installMock();
    const result = await runtimeFacade<{ GetSalesData: [payload: Readonly<Record<string, unknown>>] }>()
      .invokeServerCommand("GetSalesData", { top: 5 });
    expect(result.errorCode).toBe(0);
    expect(result.errorMessage).toBe("OK");
    expect(result.echo).toEqual({ top: 5 });
  });

  /**
   * The order the façade refuses in, which is a decision rather than an accident.
   *
   * A missing provider is the precondition of the whole surface, so it is reported
   * first — a harness that forgot to install one gets that answer instead of a
   * resolution detail it cannot act on. Once a provider exists, the *address* is
   * checked before the provider is read at all, because a name the façade does not
   * expose is a code mistake and should not be reported as a page-data problem.
   */
  it("refuses the precondition first, then the address, before reading the provider", () => {
    uninstallRuntimeFacadeProvider();
    expect(() => runtimeFacade()).toThrow(/No runtime façade provider is installed/);

    // A provider that carries nothing on the `cellProps` channel: the wrong
    // address below must be reported as a wrong address, not as the missing prop
    // it would have been if the provider had been read first.
    installRuntimeFacadeProvider({
      kind: "mock",
      bindings: { cellProps: { Forguncy: {} }, useDataSource: () => ({}) } as never,
    });
    expect(() => runtimeFacade().cellProp("NotABaseProp" as never)).toThrow(/not a base prop #5 verified/);
    // `Permissions` reached through its *typed* member hits the provider-binding refusal,
    // because the typed member does no confirmation check of its own — the base-prop read
    // is the validation, exactly as it is for the accessor.
    expect(() => runtimeFacade().permissionSnapshot()).toThrow(/does not carry "Permissions"/);
  });

  it("names the member to use instead when a confirmed address belongs to another one", () => {
    installMock();
    let caught: unknown;
    try {
      runtimeFacade().cellProp("ServerCommands" as never);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toMatch(/not the member that exposes it/);
  });
});

/**
 * The type-level half, where the guarantees are cheap to break.
 *
 * The `@ts-expect-error` directives below live in functions that are **never
 * called**, and that is deliberate rather than tidy: `invokeServerCommand` is
 * `async`, so executing a case that only exists to be type-checked would produce
 * a rejected promise, which vitest reports as an unhandled rejection and which
 * would hide the assertion it was meant to make. `tsc -p tsconfig.typecheck.json`
 * is what evaluates them, and CI runs it, so a directive that stops being an
 * error fails the build instead of quietly passing.
 *
 * Each case is paired with the *working* form of the same call in the tests
 * below, so a directive cannot be satisfied by a member that simply does not
 * exist.
 */
function typeOnlyUndeclaredCommandCall(): void {
  // @ts-expect-error a bare façade admits no command call: `keyof Record<never, never>` is `never`
  void runtimeFacade().invokeServerCommand("GetSalesData", {});
  // @ts-expect-error a declared tuple pins the arguments #5 observed, no more
  void runtimeFacade<{ GetSalesData: [payload: Readonly<Record<string, unknown>>] }>().invokeServerCommand(
    "GetSalesData",
  );
}

function typeOnlyUndeclaredShape(): void {
  const context = runtimeFacade().cellProp("ImageContext");
  // @ts-expect-error a base prop is `unknown` until its shape is declared too
  const entries: readonly string[] = context;
  void entries;
}

function typeOnlyWrongAddress(): void {
  const facade = runtimeFacade();
  // @ts-expect-error `ServerCommands` is exposed through `invokeServerCommand`
  void facade.cellProp("ServerCommands");
  // @ts-expect-error `Permissions` is the base prop, not a handle address
  void facade.forguncyMember("Permissions");
  // @ts-expect-error `hasPermission` is exposed through its own typed member
  void facade.forguncyMember("hasPermission");
  // @ts-expect-error a wrapper-local is already reachable in cell source
  void facade.forguncyMember("DataSourceCompareType");
  // @ts-expect-error a name #5 never verified is not an address at all
  void facade.cellProp("NotABaseProp");
}

/**
 * The permission map's type must not promise a boolean the runtime will not deliver.
 *
 * `getPermissions()` is `Readonly<Partial<Record<string, boolean>>>` and deliberately
 * not a plain `Record`, because #5 recorded one boolean per *configured* name and
 * nothing at all about the rest. This repository leaves `noUncheckedIndexedAccess`
 * off, so a plain `Record<string, boolean>` would let an arbitrary index read as
 * `boolean` while the value at runtime is `undefined` — a type stronger than the
 * evidence. The directive below is what keeps that from creeping back: restoring the
 * plain `Record` makes it an *unused* `@ts-expect-error`, which `tsc` fails on.
 *
 * The pair is completed by the runtime assertions in the test that calls this, where
 * a configured name really does carry `true` and an unconfigured one really is
 * `undefined` — so the type claims no more and the runtime delivers no less.
 */
function typeOnlyArbitraryPermissionKey(): void {
  const permissions = runtimeFacade().getPermissions();
  // @ts-expect-error an unconfigured name is `boolean | undefined`, not `boolean`
  const granted: boolean = permissions["NotConfigured"];
  void granted;

  // The usable form of the same read: acknowledging the absence compiles, so the
  // refusal above is the `undefined` rather than a member that never returns.
  const coalesced: boolean = permissions["NotConfigured"] ?? false;
  void coalesced;
}

describe("what the types refuse", () => {
  function installMock(): void {
    installRuntimeFacadeProvider(
      createMockRuntimeFacadeProvider({
        // Synchronous, as on the host: a promise here would be the shape the first
        // draft of this file asserted, and #5 never observed it.
        forguncyMembers: {
          hasPermission: (permissionName: string) => permissionName === "Orders.Read",
          getPermissions: () => ({ "Orders.Read": true }),
          getCurrentUser: () => ({ UserName: "dev@example.com" }),
        },
        cellProps: { Permissions: { "Orders.Read": true } },
        serverCommands: { GetSalesData: async () => ({ errorCode: 0 }) },
      }),
    );
  }

  it("admits no command call until a declaration supplies the parameters", () => {
    installMock();
    expect(typeOnlyUndeclaredCommandCall).toBeTypeOf("function");

    // The same member *is* callable once the declaration is supplied, so the
    // refusal above is the declaration's absence rather than a missing member.
    const declared = runtimeFacade<{ GetSalesData: [payload: Readonly<Record<string, unknown>>] }>();
    expect(typeof declared.invokeServerCommand).toBe("function");
  });

  it("leaves an undeclared shape unusable rather than plausible", () => {
    installMock();
    expect(typeOnlyUndeclaredShape).toBeTypeOf("function");

    // Both halves of the pair: un-declared is unusable, declared works — and the working
    // half is now the one base prop the accessor still owns.
    expect(runtimeFacade().cellProp("ImageContext")).toEqual({});
    expect(
      runtimeFacade().cellProp<{ readonly marker: string }>("ImageContext"),
    ).toEqual({});

    // The typed members need no declaration at all, which is exactly what the
    // confirmation level buys — including the ones #176 added evidence for.
    expect(runtimeFacade().hasPermission("Orders.Read")).toBe(true);
    expect(runtimeFacade().getPermissions()).toEqual({ "Orders.Read": true });
    expect(runtimeFacade().permissionSnapshot()).toEqual({ "Orders.Read": true });
    expect(runtimeFacade().getCurrentUser().UserName).toBe("dev@example.com");
  });

  it("refuses an address that belongs to another member or to the cell scope", () => {
    installMock();
    expect(typeOnlyWrongAddress).toBeTypeOf("function");

    // The runtime guard agrees with the type, because a name can also arrive from
    // JavaScript that never saw either.
    expect(() => runtimeFacade().cellProp("ServerCommands" as never)).toThrow(/not the member that exposes/);
    // The phrase is shared, the clause after it is not: one address domain, three
    // reasons, three fixes — so each case asserts the reason it is refused for.
    expect(() => runtimeFacade().forguncyMember("DataSourceCompareType" as never)).toThrow(
      /not the member that exposes it.*wrapper-local/,
    );
    expect(() => runtimeFacade().forguncyMember("Permissions" as never)).toThrow(
      /not the member that exposes it.*runtimeFacade\(\)\.permissionSnapshot\(\)/,
    );
    expect(() => runtimeFacade().forguncyMember("hasPermission" as never)).toThrow(
      /not the member that exposes it.*runtimeFacade\(\)\.hasPermission\(\)/,
    );
  });

  it("keeps an unconfigured permission name out of the boolean type", () => {
    installMock();
    expect(typeOnlyArbitraryPermissionKey).toBeTypeOf("function");

    // The runtime half of the pair: the configured name carries its boolean and the
    // unconfigured one is genuinely absent, which is *why* the type has to be
    // `Partial` rather than a plain `Record`. If this ever returned a value at
    // `NotConfigured`, the façade would be inventing one and the type would be right
    // to promise it.
    expect(runtimeFacade().getPermissions()["Orders.Read"]).toBe(true);
    expect(runtimeFacade().getPermissions()["NotConfigured"]).toBeUndefined();
  });
});

/**
 * The host boundaries a passing local suite cannot see by accident.
 *
 * Both were found in review on a PR whose tests all passed, and the reason is the
 * same for both: an arrow function and a plain property name are exactly the cases in
 * which losing a receiver and reading the prototype chain are *invisible*. Every
 * other fixture in this file is written the convenient way; these are written the
 * awkward way on purpose, because convenience is what hid the defect.
 */
describe("host boundaries only a hostile fixture can see", () => {
  /**
   * `this`, because #5 confirms the *method* form.
   *
   * The recorded call is `props.ServerCommands.GetSalesData({})` — a call *on the
   * record* — and nothing records that a command survives being detached from it. A
   * detached call hands the command `undefined` as `this`, which an arrow function
   * cannot reveal, so the fixture below is a method that reads it.
   */
  it("keeps the server-command receiver on the record it came from", async () => {
    installRuntimeFacadeProvider(
      createHostRuntimeFacadeProvider({
        cellProps: hostCellProps({
          ServerCommands: {
            marker: "the-command-record",
            GetSalesData(this: { marker?: string }) {
              return Promise.resolve({ errorCode: 0, sawThis: this?.marker });
            },
          },
        }),
        useDataSource: unusedDataSource,
      }),
    );

    const result = await runtimeFacade<{ GetSalesData: [] }>().invokeServerCommand("GetSalesData");
    expect(result.sawThis).toBe("the-command-record");
  });

  /**
   * The same boundary on the handle, on both paths in.
   *
   * `props.Forguncy.hasPermission(…)` is the recorded form, and the typed member and
   * the declared-shape accessor both have to preserve the receiver — otherwise one of
   * them would be a subtly different call from the other, and only one of them would
   * match the host.
   */
  it("keeps the props.Forguncy receiver on the handle it came from, on both paths", () => {
    let logInReceiver: unknown;
    installRuntimeFacadeProvider(
      createHostRuntimeFacadeProvider({
        cellProps: hostCellProps({
          Forguncy: {
            realm: "the-handle",
            hasPermission(this: { realm?: string }) {
              return this?.realm === "the-handle";
            },
            logIn(this: { realm?: string }) {
              // `logIn` is `void` and fire-and-forget on the host, so the receiver cannot
              // be read back off a return value — the fixture records it instead, which is
              // the same observation the method form makes either way.
              logInReceiver = this?.realm;
            },
          },
        }),
        useDataSource: unusedDataSource,
      }),
    );

    // Typed member first, then a second typed member through the same helper: `logIn`
    // is typed since #177, so the receiver rule is now asserted across the typed half
    // wholesale rather than as the typed-member/declared-accessor pair it used to be —
    // the accessor's domain is empty and there is no second path left to compare.
    expect(runtimeFacade().hasPermission("ProbePermission")).toBe(true);
    runtimeFacade().logIn();
    expect(logInReceiver).toBe("the-handle");
  });

  /**
   * The empty accessor's guard still runs — for the next presence-only member.
   *
   * `forguncyMember`'s domain is empty since #177, so there is no presence-only member
   * left to reach through it. What does not change is the *rule* the accessor exists
   * for: a confirmed address it does own (when one arrives) is handed over as read,
   * never forced callable. This test keeps the guard honest in the meantime by driving
   * the refusal path the domain empties into: a member the registry confirms but the
   * typed surface owns is refused with the owner named, so the accessor cannot silently
   * become a second way in.
   */
  it("refuses a typed member's address reached through the empty accessor, naming the owner", () => {
    installRuntimeFacadeProvider(
      createHostRuntimeFacadeProvider({
        cellProps: hostCellProps({
          Forguncy: { getCurrentUser: () => ({ UserName: "dev@example.com" }) },
        }),
        useDataSource: unusedDataSource,
      }),
    );

    expect(() => runtimeFacade().forguncyMember("getCurrentUser" as never)).toThrow(
      /not the member that exposes it.*runtimeFacade\(\)\.getCurrentUser\(\)/,
    );
    // And the typed member itself reaches the same value — the pair is what makes the
    // refusal a routing rule rather than a dead end.
    expect(runtimeFacade().getCurrentUser().UserName).toBe("dev@example.com");
  });

  /**
   * A name supplied by the caller is a *string*, and `record[name]` walks the
   * prototype chain.
   *
   * Before this was fixed, `invokeServerCommand("toString")` found
   * `Object.prototype.toString`, passed the callable check, and was invoked —
   * answering with `"[object Undefined]"` and never reaching the
   * `server-command-not-configured` branch #5's unconfigured-command observation is
   * about. The names below are the ones a caller would plausibly stumble into, and the
   * fix is `Object.hasOwn`, so all of them now get the same answer as `DoesNotExist`.
   */
  it("answers a command name only the prototype chain has as unconfigured", async () => {
    installRuntimeFacadeProvider(createMockRuntimeFacadeProvider());

    for (const inherited of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      await expect(
        runtimeFacade<Record<string, []>>().invokeServerCommand(inherited),
      ).rejects.toMatchObject({ code: "server-command-not-configured" });
    }
  });

  /**
   * The command result is the third narrowing this file does, so it is checked too.
   *
   * `serverCommandRecord` types the record as `Record<string, unknown>`, which makes
   * `ServerCommandResult` a claim of this file's rather than a type it forwards, and #5
   * records that a real call returns `{ errorCode, errorMessage, data: [...] }`. A
   * command that resolves a primitive is therefore reported instead of being handed
   * over as a record whose fields a caller would read as `undefined`. The host fixture
   * is the awkward one on purpose: the mock's `serverCommands` is typed, so only a
   * provider written the way a real host arrives can produce this answer.
   */
  it("refuses a command result that is not the record #5 recorded", async () => {
    installRuntimeFacadeProvider(
      createHostRuntimeFacadeProvider({
        cellProps: hostCellProps({ ServerCommands: { GetSalesData: async () => undefined } }),
        useDataSource: unusedDataSource,
      }),
    );

    await expect(runtimeFacade<{ GetSalesData: [] }>().invokeServerCommand("GetSalesData")).rejects.toThrow(
      /answered a value whose typeof is "undefined" rather than the result record/,
    );
  });

  /**
   * A typed member's declared return is a claim about the host, so an answer of the
   * wrong type is reported rather than coerced into it.
   *
   * `Boolean("false")` is `true`: a truthiness conversion in `hasPermission` would
   * report every permission as granted against a host that answered a string, and
   * `{}` in place of a missing map would say "this user may do nothing" where the host
   * said nothing at all. Both are the guess #29's fifth acceptance criterion forbids.
   */
  it("refuses an answer that is not the shape #5 recorded instead of coercing it", () => {
    installRuntimeFacadeProvider(
      createMockRuntimeFacadeProvider({
        forguncyMembers: { hasPermission: () => "false", getPermissions: () => undefined },
      }),
    );

    expect(() => runtimeFacade().hasPermission("Orders.Read")).toThrow(/rather than the boolean/);
    expect(() => runtimeFacade().getPermissions()).toThrow(/rather than the permission map/);
  });

  /**
   * The same boundary against every wrong answer rather than one, because "not an
   * object" was the test that let them all through.
   *
   * The thenable cases are the ones that matter: `typeof promise === "object"` passes an
   * object test, so before this was fixed an async mock was cast straight into a
   * permission map and a caller whose declared type is a value was handed a pending
   * one — the host/mock timing difference these typed members exist to remove, restored
   * by the very check meant to keep shapes honest. Each case is asserted against the
   * *reason* it is refused for, so a catch-all message would fail here.
   */
  it("refuses every wrong answer to a narrowed return, naming the one that arrived", () => {
    type MockMembers = NonNullable<
      NonNullable<Parameters<typeof createMockRuntimeFacadeProvider>[0]>["forguncyMembers"]
    >;
    const cases: readonly {
      readonly why: string;
      readonly members: MockMembers;
      readonly expected: RegExp;
    }[] = [
      {
        why: "an async mock, the shape that would restore the timing difference",
        members: { getPermissions: async () => ({ "Orders.Read": true }) },
        expected: /answered a thenable — typeof "object"/,
      },
      {
        why: "an async boolean on the other narrowed member",
        members: { hasPermission: async () => true },
        expected: /hasPermission\("Orders.Read"\) answered a thenable/,
      },
      {
        why: "an array, whose indices would read as permission names",
        members: { getPermissions: () => [{ name: "Orders.Read" }] },
        expected: /answered an array/,
      },
      {
        why: "a Map, whose entries a record read cannot see",
        members: { getPermissions: () => new Map([["Orders.Read", true]]) },
        expected: /and not a plain record whose own keys are permission names/,
      },
      {
        why: "a Date",
        members: { getPermissions: () => new Date() },
        expected: /and not a plain record/,
      },
      {
        why: "a non-boolean value, which would read true in a condition and false in a comparison",
        members: { getPermissions: () => ({ "Orders.Read": "yes" }) },
        expected: /a value whose typeof is "string" for the permission "Orders.Read"/,
      },
      {
        why: "a boolean beside an absent one",
        members: { getPermissions: () => ({ "Orders.Read": true, "Orders.Write": undefined }) },
        expected: /a value whose typeof is "undefined" for the permission "Orders.Write"/,
      },
    ];

    for (const { why, members, expected } of cases) {
      uninstallRuntimeFacadeProvider();
      installRuntimeFacadeProvider(createMockRuntimeFacadeProvider({ forguncyMembers: members }));
      const call =
        "getPermissions" in members
          ? (): unknown => runtimeFacade().getPermissions()
          : (): unknown => runtimeFacade().hasPermission("Orders.Read");
      expect(call, why).toThrow(expected);
    }
  });

  /**
   * And the accepting half, so the boundary is a shape test rather than a suspicion of
   * anything unusual.
   *
   * A record with no prototype is accepted on purpose: it is still a plain map of own
   * enumerable keys, which is all #5 recorded, and refusing it would be this file
   * inventing a requirement the evidence does not make.
   */
  it("answers a plain record of booleans, with or without a prototype", () => {
    installRuntimeFacadeProvider(
      createMockRuntimeFacadeProvider({
        forguncyMembers: {
          getPermissions: () =>
            Object.assign(Object.create(null), { "Orders.Read": true, "Orders.Write": false }),
        },
      }),
    );

    expect(runtimeFacade().getPermissions()).toEqual({ "Orders.Read": true, "Orders.Write": false });
  });
});

/**
 * The typed members #177 adds, exercised end to end against the mock's measured defaults.
 *
 * What is asserted here is the *delegation and the narrowing*, not the mock behaviour —
 * `mock-provider.test.ts` owns the measured behaviours themselves. Each member is
 * checked for the one thing that is this file's job: the value the cell actually sees,
 * which is the host answer after the boundary check this file implements.
 */
describe("the typed members #176's evidence pays for", () => {
  function installDefaultMock(options?: Parameters<typeof createMockRuntimeFacadeProvider>[0]): void {
    installRuntimeFacadeProvider(createMockRuntimeFacadeProvider(options));
  }

  it("delegates uploadFiles and hands the resolved result back as the measured shape", async () => {
    installDefaultMock();
    const result = await runtimeFacade().uploadFiles(new File(["x"], "probe.png"));
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.fileName).toBe("probe.png");
    expect(result.attachmentValue).toBe(`${result.files[0]?.filePath}|`);

    // The no-arguments path is the host's own empty result, forwarded — not an error
    // the façade pre-empts.
    expect(await runtimeFacade().uploadFiles()).toEqual({ files: [], attachmentValue: "" });
  });

  it("refuses an uploadFiles answer that is not a thenable, because a sync answer is not the measured contract", () => {
    installDefaultMock({
      forguncyMembers: { uploadFiles: (() => ({ files: [] })) as never },
    });
    expect(() => runtimeFacade().uploadFiles(new File(["x"], "probe.png"))).toThrow(/rather than the Promise #176 measured/);
  });

  it("refuses an uploadFiles resolution that is not the result object", async () => {
    installDefaultMock({
      forguncyMembers: { uploadFiles: (async () => "done") as never },
    });
    await expect(runtimeFacade().uploadFiles(new File(["x"], "probe.png"))).rejects.toThrow(
      /rather than the upload result #176 measured/,
    );
  });

  it("reads the upload limit synchronously and refuses a non-record answer", () => {
    installDefaultMock();
    const limit = runtimeFacade().getUploadLimit();
    expect(limit.sizeLimit).toBe(0);
    expect(limit.accept).toBe(limit.extensionFilter);
    expect(limit).not.toBeInstanceOf(Promise);

    uninstallRuntimeFacadeProvider();
    installDefaultMock({ forguncyMembers: { getUploadLimit: (() => null) as never } });
    expect(() => runtimeFacade().getUploadLimit()).toThrow(/rather than the upload limit record/);
  });

  it("reads the current user synchronously and refuses a non-record answer", () => {
    installDefaultMock();
    const user = runtimeFacade().getCurrentUser();
    expect(user.UserName).toBeTypeOf("string");
    expect(user).not.toBeInstanceOf(Promise);

    uninstallRuntimeFacadeProvider();
    installDefaultMock({ forguncyMembers: { getCurrentUser: (() => Promise.resolve({})) as never } });
    expect(() => runtimeFacade().getCurrentUser()).toThrow(/rather than the user record/);
  });

  it("forwards the session verbs verbatim and fire-and-forget", () => {
    const seen: (boolean | undefined)[] = [];
    installDefaultMock({
      forguncyMembers: {
        logIn: () => {
          seen.push(undefined);
        },
        logOut: (navigateToHomePage?: boolean) => {
          seen.push(navigateToHomePage);
        },
      },
    });

    // Neither returns anything the cell can use, and the argument goes over untouched —
    // including its absence, because coalescing a default would be a navigation decision
    // the host owns.
    expect(runtimeFacade().logIn()).toBeUndefined();
    expect(runtimeFacade().logOut(false)).toBeUndefined();
    runtimeFacade().logOut();
    expect(seen).toEqual([undefined, false, undefined]);
  });

  it("forwards exposeMethod input exactly as written, validation deferred to the host shape", () => {
    const registrations: [unknown, unknown][] = [];
    installDefaultMock({
      forguncyMembers: {
        exposeMethod: (name: unknown, method: unknown) => {
          registrations.push([name, method]);
        },
      },
    });

    const method = () => "result";
    runtimeFacade().exposeMethod("run", method);
    expect(registrations).toEqual([["run", method]]);

    // Invalid input is forwarded too — #176 measured the host silently ignoring it, so
    // refusing it here would make the façade stricter than the host. The mock's own
    // default reproduces the silent ignore; this fixture records what arrived instead.
    runtimeFacade().exposeMethod("", method);
    expect(registrations).toHaveLength(2);
  });

  it("delegates the three conversions as measured, boundary only", () => {
    installDefaultMock();
    // The boundary is a forward: what is asserted is that the value the mock computed is
    // the value the cell receives, not that the façade recomputed anything.
    expect(runtimeFacade().convertToCssColor("#80FF0000")).toBe("rgba(255,0,0,0.50)");
    const now = new Date();
    expect(runtimeFacade().convertOADateToDate(runtimeFacade().convertDateToOADate(now)).getTime()).toBe(now.getTime());
  });

  it("reads a declared property through cellProperty, typed only by the project", () => {
    installDefaultMock({ properties: { title: "销售总览" } });
    // The bare façade admits no property read — `Properties` defaults to `never` — so
    // the declaration is what makes this compile, the same discipline as the command map.
    const title = runtimeFacade<Record<never, never>, "title">().cellProperty<string>("title");
    expect(title).toBe("销售总览");
  });

  it("refuses an undeclared property name as a missing injection, not a silent undefined", () => {
    installDefaultMock();
    // The host cannot inject a property the cell never declared, so a read of one is a
    // wiring fault — the same absence family as a missing base prop.
    expect(() => runtimeFacade<Record<never, never>, "missing">().cellProperty("missing")).toThrow(
      /does not carry "missing"/,
    );
  });

  it("fires a declared event through the props-assigned function, arguments verbatim", () => {
    const seen: readonly unknown[][] = [];
    installDefaultMock({
      eventHandlers: {
        onSelect: (...args: readonly unknown[]) => {
          (seen as unknown[][]).push([...args]);
        },
      },
    });

    runtimeFacade<Record<never, never>, never, "onSelect">().fireEvent("onSelect", "row-3", 42);
    expect(seen).toEqual([["row-3", 42]]);
    // And the firing itself is void, because the command outcome is the host pipeline's.
    expect(runtimeFacade<Record<never, never>, never, "onSelect">().fireEvent("onSelect")).toBeUndefined();
  });

  it("fires an uncommanded event as a no-op rather than refusing it", () => {
    installDefaultMock({ eventHandlers: { onIdle: undefined } });
    expect(() => runtimeFacade<Record<never, never>, never, "onIdle">().fireEvent("onIdle")).not.toThrow();
  });

  it("refuses to fire an event the host never injected", () => {
    installDefaultMock();
    expect(() => runtimeFacade<Record<never, never>, never, "onNope">().fireEvent("onNope")).toThrow(
      /does not carry "onNope"/,
    );
  });

  it("refuses a non-callable value at an event address as the wrong shape, not as a call", () => {
    // A property and an event are both props-sibling injections, so a project that
    // declares a *property* under the same conceptual name and then fires it meets the
    // non-callable refusal — the shape #176 measured events as never having.
    installDefaultMock({ properties: { onClick: "a-string-not-a-firing" } });
    expect(() => runtimeFacade<Record<never, never>, "onClick", never>().fireEvent("onClick" as never)).toThrow(
      /not callable/,
    );
  });

  it("keeps the permission snapshot identity-equal between the typed member and the base prop", () => {
    installDefaultMock({ cellProps: { Permissions: { "Orders.Read": true } } });
    // What is asserted is the *content* agreement: identity itself is the mock's
    // construction (`mock-provider.test.ts` pins `toBe`), and the façade's contribution
    // is that both reads pass through the same narrowing and answer the same map.
    expect(runtimeFacade().permissionSnapshot()).toEqual(runtimeFacade().getPermissions());
    expect(runtimeFacade().cellProp("ImageContext")).toEqual({});
  });
});

/** Every base prop key `core` verified, with the ones under test overridden. */
function hostCellProps(overrides: Readonly<Record<string, unknown>>): RuntimeFacadeCellProps {
  const base = Object.fromEntries(CELL_PROPS_BASE_KEYS.map(key => [key, undefined])) as Record<
    string,
    unknown
  >;
  return { ...base, ...overrides } as unknown as RuntimeFacadeCellProps;
}

/** A binding the cases above never read, kept out of the way of what they assert. */
const unusedDataSource = (): DataSourceResult => ({
  data: [],
  totalCount: 0,
  loading: false,
  error: null,
});
