import { describe, expect, it } from "vitest";

import { CELL_FORGUNCY_PROP_KEYS, CELL_PROPS_BASE_KEYS } from "@forguncy-react-workspace/core";

import { RuntimeFacadeContractError } from "./capabilities.ts";
import type { RuntimeFacadeCellProps, RuntimeFacadeHostBindings } from "./contract.ts";
import {
  createMockDataSource,
  createMockRuntimeFacadeProvider,
  mockUndeclaredDataSourceMessage,
} from "./mock-provider.ts";

function cellPropsOf(provider: { readonly bindings: RuntimeFacadeHostBindings }): Record<string, unknown> {
  return provider.bindings.cellProps as unknown as Record<string, unknown>;
}

// The mock is a stand-in, so its *shape* has to match the host's. Both halves of
// that are checked here: the addresses it fills, and the addresses it refuses to
// fill.
describe("mock provider shape", () => {
  it("fills every base prop key and handle member `core` verified", () => {
    const props = cellPropsOf(createMockRuntimeFacadeProvider());
    expect(Object.keys(props).sort()).toEqual([...CELL_PROPS_BASE_KEYS].sort());
    expect(Object.keys(props.Forguncy as object).sort()).toEqual([...CELL_FORGUNCY_PROP_KEYS].sort());
  });

  /**
   * The parity rule, and the reason it is a construction-time refusal rather than
   * a note: a mock that could supply `navigate` would let a Cell pass every local
   * check and fail on the first real page, which is the one failure mode a local
   * harness exists to prevent.
   */
  it("refuses to impersonate an address the host does not have", () => {
    expect(() =>
      createMockRuntimeFacadeProvider({ forguncyMembers: { navigate: () => undefined } as never }),
    ).toThrow(/not a member #5 verified/);

    expect(() => createMockRuntimeFacadeProvider({ cellProps: { theme: "dark" } as never })).toThrow(
      /not one #5 verified/,
    );

    let caught: unknown;
    try {
      createMockRuntimeFacadeProvider({ forguncyMembers: { navigate: () => undefined } as never });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeFacadeContractError);
    expect((caught as RuntimeFacadeContractError).code).toBe("unknown-host-binding");
  });

  // The two value props the runtime injects as an empty *object* on every Cell, whatever
  // the page configured. This used to default them to `undefined` on the argument that
  // #5 left what an empty snapshot means open and a default would assert a shape on the
  // host's behalf — an executed page closed that question: both arrive as `{}`, and the
  // empty snapshot is empty rather than absent. A harness can still override either with
  // `undefined` when it wants to exercise the resolver's presence rule.
  it("defaults the two always-injected value props to the empty object the runtime sends", () => {
    const props = cellPropsOf(createMockRuntimeFacadeProvider());
    expect(props.Permissions).toEqual({});
    expect(props.ImageContext).toEqual({});
    expect(props.ServerCommands).toEqual({});
  });

  it("carries the kind a harness reports, and the same port as the host", () => {
    const mock = createMockRuntimeFacadeProvider();
    expect(mock.kind).toBe("mock");
    expect(Object.keys(mock.bindings).sort()).toEqual(["cellProps", "useDataSource"]);
  });
});

describe("mock data sources", () => {
  it("answers a declared source and leaves the count server-side", () => {
    const sales = createMockDataSource([{ id: 1 }, { id: 2 }, { id: 3 }], { totalCount: 240 });
    const result = sales({ top: 2 });

    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    // #5: `top: 3` returned three rows while `totalCount` stayed 72, so the count
    // is the declared one rather than the number of rows on hand.
    expect(result.totalCount).toBe(240);
    expect(result.loading).toBe(false);
    expect(result.error).toBeNull();
  });

  it("applies offset the way the server does, and defaults the count to the rows it has", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(createMockDataSource(rows)({ offset: 1 })).toMatchObject({
      data: [{ id: 2 }, { id: 3 }],
      totalCount: 3,
    });
    expect(createMockDataSource(rows)({ top: 2, offset: 1 }).data).toEqual([{ id: 2 }, { id: 3 }]);
    expect(createMockDataSource(rows)().data).toHaveLength(3);
  });

  /**
   * A stated non-claim rather than a silent one.
   *
   * Ordering on the target is the server's — it depends on the database collation
   * rather than on the rows the client holds — so a local sort would encode a guess
   * as a simulation. The helper therefore ignores `orderBySqlParams`, and this test
   * exists so that the limitation is a named behaviour instead of an accident a
   * project discovers when local results stop predicting production ones.
   */
  it("does not pretend to apply server-side ordering", () => {
    const rows = [{ id: 3 }, { id: 1 }, { id: 2 }];
    const ordered = createMockDataSource(rows)({
      orderBySqlParams: [{ ColumnName: "id", Order: "DESC" }],
    });
    expect(ordered.data).toEqual(rows);
  });

  // #5 records the undeclared case as an error *state* whose message contains the
  // name, so the mock reproduces that rather than throwing — the alternative would
  // make local development stricter than the target.
  it("answers an undeclared source with the host's error state", () => {
    const bindings = createMockRuntimeFacadeProvider({ dataSources: {} }).bindings;
    expect(() => bindings.useDataSource("NoSuchSource")).not.toThrow();

    const result = bindings.useDataSource("NoSuchSource");
    expect(result).toEqual({
      data: [],
      totalCount: 0,
      loading: false,
      error: mockUndeclaredDataSourceMessage("NoSuchSource"),
    });
    // The property #5 pinned is that the message *contains* the name; the exact
    // product wording is not evidence this repository has.
    expect(String(result.error)).toContain("NoSuchSource");
  });

  /**
   * A data-source name is a string a caller supplies, so `dataSources[name]` walks the
   * prototype chain.
   *
   * `toString`, `constructor`, `valueOf` and the rest answer with a *function*, so the
   * `typeof resolver !== "function"` guard below them passes and the mock would call
   * `Object.prototype.toString` and hand its return value back as if it were a data
   * source result. A local harness quietly disagreeing with the host about a shape is
   * the one thing it must never do, so the fixture names the cases that reach it, and
   * `Object.hasOwn` is the fix they check.
   */
  it("answers an undeclared source named after a prototype member with the host's error state", () => {
    const bindings = createMockRuntimeFacadeProvider({ dataSources: {} }).bindings;

    for (const inherited of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      const result = bindings.useDataSource(inherited);
      expect(result.data, inherited).toEqual([]);
      expect(result.totalCount, inherited).toBe(0);
      expect(result.loading, inherited).toBe(false);
      expect(String(result.error), inherited).toContain(inherited);
    }
  });

  // The complement, so the fix cannot be "refuse everything": a project is allowed to
  // name a source after a prototype member, and an own key still wins.
  it("still answers a source the project declared under a prototype member's name", () => {
    const bindings = createMockRuntimeFacadeProvider({
      dataSources: { constructor: createMockDataSource([{ id: 1 }]) },
    }).bindings;

    const result = bindings.useDataSource("constructor");
    expect(result.data).toEqual([{ id: 1 }]);
    expect(result.error).toBeNull();
  });
});

describe("mock server commands", () => {
  // The host's own shape, kept: a name the designer did not list is `undefined` on
  // the record. The façade is where that becomes a named failure, not here.
  it("leaves an unconfigured name undefined rather than substituting behaviour", () => {
    const serverCommands = cellPropsOf(createMockRuntimeFacadeProvider()).ServerCommands as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(serverCommands, "GetSalesData")).toBe(false);
    expect(serverCommands.GetSalesData).toBeUndefined();
  });

  it("carries the commands the project supplied with the declared parameter tuple", async () => {
    const provider = createMockRuntimeFacadeProvider<{ GetSalesData: [payload: { top: number }] }>({
      serverCommands: {
        GetSalesData: async payload => ({ errorCode: 0, errorMessage: "OK", echo: payload.top }),
      },
    });

    // `payload` is the declared tuple's parameter, which is what makes the mock as
    // typed as the real binding rather than looser than it: the option is typed
    // `ServerCommandBindings<Commands>`, so the line above only compiles while
    // `payload` is `{ top: number }`.
    //
    // Reading the value back needs one cast, and for the same reason the port has
    // one: `RuntimeFacadeCellProps.ServerCommands` deliberately declares no command
    // (`contract.ts`), so the record is addressed the way a generated binding
    // addresses it — by name, at the boundary.
    const commands = provider.bindings.cellProps.ServerCommands as unknown as {
      GetSalesData?: (payload: { top: number }) => Promise<{ echo?: unknown }>;
    };
    const result = await commands.GetSalesData?.({ top: 3 });
    expect(result?.echo).toBe(3);
  });
});

describe("mock cell props typing", () => {
  // The mock's `cellProps` has to be assignable where a host's `props` is, or the
  // two providers would not be interchangeable.
  it("is assignable to the port's cell props", () => {
    const props: RuntimeFacadeCellProps = createMockRuntimeFacadeProvider().bindings.cellProps;
    expect(Object.keys(props).length).toBe(CELL_PROPS_BASE_KEYS.length);
  });
});

// Since #177 the mock is not just shape-parity but behaviour-parity for the members #176
// measured: the defaults reproduce the measured call shapes, so a fixture declares what it
// cares about instead of restating the whole handle. These tests pin the measured
// behaviours — not conveniences — so a mock that started out-behaving or under-behaving
// the host fails here rather than in a project.
describe("measured member defaults", () => {
  function handleOf(provider: { readonly bindings: RuntimeFacadeHostBindings }): Record<string, unknown> {
    return provider.bindings.cellProps.Forguncy as unknown as Record<string, unknown>;
  }

  it("answers getCurrentUser with the six-key shape #176 measured, synchronously", () => {
    const getCurrentUser = handleOf(createMockRuntimeFacadeProvider()).getCurrentUser as () => Record<string, unknown>;
    const user = getCurrentUser();
    expect(Object.keys(user).sort()).toEqual(["Email", "FullName", "HasPicture", "PictureUrl", "Role", "UserName"]);
    // The default-avatar fallback is part of the measured shape, not a detail:
    // `HasPicture: false` and the built-in path travel together.
    expect(user.HasPicture).toBe(false);
    expect(user.PictureUrl).toBe("/Forguncy/Resources/Images/SiteBuiltInImages/DefaultCurrentUser.png");
    expect(user).not.toBeInstanceOf(Promise);
  });

  it("makes both session verbs fire-and-forget no-ops, because navigation is the host's", () => {
    const handle = handleOf(createMockRuntimeFacadeProvider());
    // #176 measured arity 0 and 1 and no Promise on either. The mock cannot reproduce the
    // navigation — there is no host page to navigate away from — so the honest stand-in is
    // the inert call with the measured arity and the measured absence of a Promise.
    expect((handle.logIn as (...args: unknown[]) => unknown).length).toBe(0);
    expect((handle.logOut as (...args: unknown[]) => unknown).length).toBe(1);
    expect((handle.logIn as () => unknown)()).toBeUndefined();
    expect((handle.logOut as (navigateToHomePage?: boolean) => unknown)(false)).toBeUndefined();
  });

  it("resolves uploadFiles with the measured files/attachmentValue shape, trailing pipe included", async () => {
    const uploadFiles = handleOf(createMockRuntimeFacadeProvider()).uploadFiles as (
      files?: unknown,
      options?: { uploadFolder?: string },
    ) => Promise<{ files: readonly { filePath: string; fileName: string; downloadUrl: string }[]; attachmentValue: string }>;

    const file = new File(["probe-bytes"], "probe.png");
    const result = await uploadFiles(file);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.fileName).toBe("probe.png");
    expect(result.files[0]?.filePath).toMatch(/^[a-z0-9-]+_probe\.png$/);
    expect(result.files[0]?.downloadUrl).toBe(
      `/Forguncy/FileDownloadUpload/Download?file=${encodeURIComponent(result.files[0]!.filePath)}`,
    );
    // The trailing pipe is the measured format, not a typo: `<filePath>|`.
    expect(result.attachmentValue).toBe(`${result.files[0]?.filePath}|`);

    // The uploadFolder prefix, measured: `<folder>/<uuid>_<name>`.
    const foldered = await uploadFiles([file], { uploadFolder: "probe176" });
    expect(foldered.files[0]?.filePath).toMatch(/^probe176\/[a-z0-9-]+_probe\.png$/);
  });

  it("resolves the empty upload result for no arguments and for an empty array, without rejecting", async () => {
    const uploadFiles = handleOf(createMockRuntimeFacadeProvider()).uploadFiles as (
      files?: unknown,
    ) => Promise<{ files: readonly unknown[]; attachmentValue: string }>;
    expect(await uploadFiles()).toEqual({ files: [], attachmentValue: "" });
    expect(await uploadFiles([])).toEqual({ files: [], attachmentValue: "" });
  });

  it("accepts an array-like the way the measured FileList path does", async () => {
    const uploadFiles = handleOf(createMockRuntimeFacadeProvider()).uploadFiles as (
      files?: unknown,
    ) => Promise<{ files: readonly { fileName: string }[] }>;
    const arrayLike = { 0: new File(["a"], "a.png"), 1: new File(["b"], "b.png"), length: 2 };
    const result = await uploadFiles(arrayLike);
    expect(result.files.map(file => file.fileName)).toEqual(["a.png", "b.png"]);
  });

  it("answers getUploadLimit with the measured defaults, synchronously", () => {
    const getUploadLimit = handleOf(createMockRuntimeFacadeProvider()).getUploadLimit as () => Record<string, unknown>;
    const limit = getUploadLimit();
    // Unset means `0`, and `0` means unlimited on both numeric fields — measured, and
    // `accept` always equals `extensionFilter`.
    expect(limit.sizeLimit).toBe(0);
    expect(limit.maxUploadFileCount).toBe(0);
    expect(limit.accept).toBe(limit.extensionFilter);
    expect(limit).not.toBeInstanceOf(Promise);
  });

  it("reproduces the exposeMethod registration semantics #176 measured", () => {
    const handle = handleOf(createMockRuntimeFacadeProvider());
    const exposeMethod = handle.exposeMethod as (name: unknown, method: unknown) => void;
    const registry = handle.__exposedMethods as Record<string, unknown>;

    // Invalid input is silently ignored — no throw, no registration.
    expect(() => exposeMethod("", () => undefined)).not.toThrow();
    expect(() => exposeMethod("x", "not-a-function")).not.toThrow();
    expect(() => exposeMethod(null, () => undefined)).not.toThrow();
    expect(Object.keys(registry)).toEqual([]);

    // Overwrite wins: the second registration replaces the first.
    const first = () => "first";
    const second = () => "second";
    exposeMethod("run", first);
    exposeMethod("run", second);
    expect(registry.run).toBe(second);
  });

  it("quantizes an 8-digit hex alpha exactly as measured", () => {
    const convert = handleOf(createMockRuntimeFacadeProvider()).ConvertToCssColor as (color: string) => string;
    // The measured matrix, verbatim — the two-decimal quantization is the behaviour a
    // cell can come to depend on, so a mock that rounded differently would be lying.
    expect(convert("#FF0000")).toBe("#FF0000");
    expect(convert("#FFFF0000")).toBe("#FF0000");
    expect(convert("#80FF0000")).toBe("rgba(255,0,0,0.50)");
    expect(convert("#00FF0000")).toBe("rgba(255,0,0,0.00)");
    expect(convert("rgb(255,0,0)")).toBe("rgb(255,0,0)");
    expect(convert("red")).toBe("red");
    expect(convert("#f00")).toBe("#f00");
    expect(convert("not-a-color")).toBe("not-a-color");
    expect(convert("")).toBe("");
  });

  it("round-trips the OADate pair exact to the millisecond, in the local timezone", () => {
    const handle = handleOf(createMockRuntimeFacadeProvider());
    const toOA = handle.ConvertDateToOADate as (date: Date) => number;
    const fromOA = handle.ConvertOADateToDate as (oadate: number) => Date;

    // The measured round-trip guarantee: exact to the millisecond when composed. Asserted
    // across a spread of inputs rather than one wall-clock instant, because the floating-point
    // inverse is *deterministically* lossy for a fraction of inputs — `(asUtc - epoch) / 86400000`
    // then `oadate * 86400000` drifted by up to 1ms before the millisecond count was rounded
    // (caught by #182's CI), and a single `new Date()` only sometimes lands on a drifting value.
    // A spread across millisecond boundaries makes the lossy direction deterministic rather
    // than flaky, so a regression fails every run, not one run in three.
    const inputs = [
      new Date(),
      // Wall-clock-scale values chosen to straddle millisecond boundaries and a spread of
      // fractional-millisecond-producing magnitudes — the region where the unrounded inverse
      // drifted. The exact values matter less than that they span many milliseconds.
      ...Array.from({ length: 24 }, (_, index) => new Date(1795593657000 + index * 137 + (index % 4))),
    ];
    for (const input of inputs) {
      expect(fromOA(toOA(input)).getTime() - input.getTime()).toBe(0);
    }
    // And the measured timezone behaviour: the epoch is local, so `0` does not produce
    // `1899-12-30T00:00:00Z` except on a UTC host — what is asserted is the *local*
    // midnight, which is the conversion the host performs.
    const roundTrippedEpoch = fromOA(0);
    expect(roundTrippedEpoch.getFullYear()).toBe(1899);
    expect(roundTrippedEpoch.getMonth()).toBe(11);
    expect(roundTrippedEpoch.getDate()).toBe(30);
  });

  it("uses the local-wall-clock arithmetic the probe's data points pin, not the naive formula", () => {
    const handle = handleOf(createMockRuntimeFacadeProvider());
    const toOA = handle.ConvertDateToOADate as (date: Date) => number;
    // The noon measurement is what distinguishes the two candidate formulas: the naive
    // epoch-milliseconds reading misses it by the local-timezone offset, while the
    // wall-clock reinterpretation hits it exactly. Asserted as the *difference* the two
    // formulas disagree by rather than as one absolute number, because the absolute value
    // is timezone-dependent — the probe recorded it on a UTC+8 host — and this suite has
    // to pass on any machine. What is machine-independent is that the wall-clock formula
    // is the one the mock implements: the UTC-instant noon input converts to exactly the
    // day count the probe recorded plus the probe machine's own offset, which is what
    // reproducing the arithmetic means.
    const noonUtc = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
    // On any machine, the local wall clock of a UTC-noon instant reinterpreted as UTC is
    // offset from the naive epoch formula by exactly the local-timezone shift — so the
    // two candidate answers differ, and the mock must give the wall-clock one. Computing
    // the wall-clock expectation here (rather than writing 46023.833…​3 down) is what
    // keeps the test about the arithmetic instead of about one machine's timezone.
    const wallClockAsUtc =
      (Date.UTC(
        noonUtc.getFullYear(), noonUtc.getMonth(), noonUtc.getDate(),
        noonUtc.getHours(), noonUtc.getMinutes(), noonUtc.getSeconds(), noonUtc.getMilliseconds(),
      ) - Date.UTC(1899, 11, 30)) / 86400000;
    expect(toOA(noonUtc)).toBe(wallClockAsUtc);
    // And the discriminating half: the naive formula's answer, which the mock must NOT
    // give — it is the wrong arithmetic, off by the timezone offset on every non-UTC host.
    const naive = (noonUtc.getTime() - new Date(1899, 11, 30).getTime()) / 86400000;
    if (new Date().getTimezoneOffset() !== 0) {
      expect(toOA(noonUtc)).not.toBe(naive);
    }
  });

  it("lets a project override any default verbatim", () => {
    const custom = () => ({ UserName: "Custom" });
    const handle = handleOf(createMockRuntimeFacadeProvider({ forguncyMembers: { getCurrentUser: custom } }));
    expect(handle.getCurrentUser).toBe(custom);
  });

  it("keeps the handle key list exactly the fourteen core verified, with internals hidden", () => {
    const handle = handleOf(createMockRuntimeFacadeProvider());
    // The registry the exposeMethod stand-in writes into is non-enumerable, because the
    // host's own key list is the fourteen and nothing else — a cell enumerating the
    // handle locally must see what it would see on the page.
    expect(Object.keys(handle).sort()).toEqual([...CELL_FORGUNCY_PROP_KEYS].sort());
    expect(Object.hasOwn(handle, "__exposedMethods")).toBe(true);
  });
});

// The bidirectional surface area #177 adds: properties land as base-prop-sibling keys and
// events as callable firings, the same injection the host performs.
describe("declared properties and events", () => {
  function propsOf(options: Parameters<typeof createMockRuntimeFacadeProvider>[0]): Record<string, unknown> {
    return cellPropsOf(createMockRuntimeFacadeProvider(options));
  }

  it("injects declared properties onto props under their own names", () => {
    const props = propsOf({ properties: { title: "销售总览", threshold: 500 } });
    expect(props.title).toBe("销售总览");
    expect(props.threshold).toBe(500);
  });

  it("refuses a property that collides with a base prop, because the host cannot produce that", () => {
    expect(() => createMockRuntimeFacadeProvider({ properties: { Forguncy: {} } })).toThrow(/collides with a base prop/);
    expect(() => createMockRuntimeFacadeProvider({ properties: { ServerCommands: {} } })).toThrow(/collides with a base prop/);
  });

  it("assigns a callable firing for every declared event, handler or not", () => {
    const props = propsOf({ eventHandlers: { onClick: () => undefined, onIdle: undefined } });
    expect(typeof props.onClick).toBe("function");
    // The no-handler case is a function too: #176 measured the runtime assigning
    // `props[eventName] = (...args) => void` for every declared entry, and an uncommanded
    // event is a no-op rather than an absent key.
    expect(typeof props.onIdle).toBe("function");
    expect(() => (props.onIdle as () => void)()).not.toThrow();
  });

  it("routes the firing's positional arguments to the declared handler", () => {
    const seen: readonly unknown[][] = [];
    const props = propsOf({
      eventHandlers: {
        onSelect: (...args: readonly unknown[]) => {
          (seen as unknown[][]).push([...args]);
        },
      },
    });
    (props.onSelect as (...args: unknown[]) => void)("row-3", 42);
    expect(seen).toEqual([["row-3", 42]]);
  });

  it("refuses an event that collides with a base prop or a declared property", () => {
    expect(() =>
      createMockRuntimeFacadeProvider({ eventHandlers: { Permissions: () => undefined } }),
    ).toThrow(/collides/);
    expect(() =>
      createMockRuntimeFacadeProvider({
        properties: { title: "x" },
        eventHandlers: { title: () => undefined },
      }),
    ).toThrow(/collides/);
  });

  it("keeps the permission identity between the base prop and the handle", () => {
    // #176 measured identity equality, not deep equality: `props.Permissions` *is*
    // `props.Forguncy.Permissions`. A copy would let the two disagree, which is the
    // exact drift the measurement rules out.
    const props = propsOf({ cellProps: { Permissions: { "Orders.Read": true } } });
    expect((props.Forguncy as Record<string, unknown>).Permissions).toBe(props.Permissions);
  });
});
