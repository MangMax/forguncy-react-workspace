/**
 * The mock provider: the same surface, supplied by the project instead of by
 * Forguncy, so authored source runs unchanged under a local harness.
 *
 * Decision source: GitHub Issue #27 — "Spec: typed Forguncy runtime facade for
 * application-owned capabilities"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/27).
 * Implementation: GitHub Issue #29 — "Implement: typed Forguncy runtime facade
 * and local mock provider"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/29).
 *
 * #27's fourth acceptance criterion is "Local dev can provide mocks for the same
 * public facade", and its fifth is that the façade must not become a cross-Cell
 * state store or a second data layer. Those two together decide what this module
 * is: a **provider**, not a fixture library. It carries values the project hands
 * it and reproduces the host's *absences*, so a Cell meets the same shapes
 * locally as it will in Forguncy. It does not cache, aggregate, reorder or
 * retry — the moment it does, it becomes the second data layer #27 forbids, and
 * the moment it is *more* capable than the host, local development stops being a
 * prediction of production.
 *
 * That parity rule is enforced rather than documented: a mock that names a
 * `props.Forguncy` member or a base prop #5 never observed is refused at
 * construction. A mock that could impersonate `navigate` would let a Cell pass
 * every local check and fail on the first real page, which is the one failure
 * mode a local harness is supposed to prevent.
 *
 * ## What the mock does not do
 *
 * The two absences #5 records behave exactly as #5 records them, and no more:
 *
 * - a server-command name the mock was not given is **`undefined` on the
 *   record**, which is what an unconfigured name is on a real Cell — the façade
 *   is where that becomes `server-command-not-configured`, not here;
 * - a data source the mock was not given answers with an error **state**, not a
 *   throw, because that is what #5 observed for an undeclared source.
 *
 * A value prop the mock was not given stays `undefined`. It is deliberately not
 * defaulted to something plausible: `#5` records that it saw the `Permissions`
 * key and not what an empty snapshot means, so a mock that answered `[]` would be
 * asserting a shape on the host's behalf.
 */

import {
  CELL_FORGUNCY_PROP_KEYS,
  CELL_PROPS_BASE_KEYS,
} from "@forguncy-react-workspace/core/browser";

import type { CellPropKey, ForguncyPropMember } from "./capabilities.ts";
import { RuntimeFacadeContractError } from "./capabilities.ts";
import type {
  DataSourceBinding,
  DataSourceQueryOptions,
  DataSourceResult,
  RuntimeFacadeCellProps,
  RuntimeFacadeHostBindings,
  RuntimeFacadeProvider,
  ServerCommandBindings,
  ServerCommandParameterMap,
} from "./contract.ts";

/** A data source's behaviour, as the project wants it simulated. */
export type MockDataSourceResolver = (options?: DataSourceQueryOptions) => DataSourceResult;

/** The base props a mock does not stand in for through `cellProps`, because they have their own option. */
export type MockStandInCellPropKey = Exclude<CellPropKey, "Forguncy" | "ServerCommands">;

export interface MockRuntimeFacadeOptions<Commands extends ServerCommandParameterMap = Record<never, never>> {
  /**
   * Handle members the project wants to stand in for, by their confirmed names.
   *
   * A value that depends on `this` sees the mock's own handle, because that is what
   * the façade binds the member to — the same receiver a host member would get. It
   * is not the object literal the value was written in, which is the parity the host
   * forces rather than a choice this module makes.
   *
   * Any member the project does not supply is filled with the mock's own measured
   * stand-in: #176 executed every one of these members on `12.0.102.0`, so a default
   * mock reproducing that measured behaviour is a *prediction of the host*, while
   * `undefined` would be a prediction of a host that does not have the member at all —
   * the one direction a local harness must never lean. A project override still wins
   * verbatim: the defaults exist so a fixture declares what it cares about rather than
   * restating the whole handle.
   */
  readonly forguncyMembers?: Partial<Record<ForguncyPropMember, unknown>>;
  /** Value props the project wants to stand in for. */
  readonly cellProps?: Partial<Record<MockStandInCellPropKey, unknown>>;
  /**
   * Declared cell properties the page would have configured, by name.
   *
   * These land on `props` under their own names — the same injection the host performs
   * for `properties[].propertyName` — which is what makes `cellProperty` and the direct
   * `props.<name>` read the same value, the parity the production Cell has. A name that
   * collides with a base prop key is refused at construction: overwriting `Forguncy` or
   * `ServerCommands` with a declared property is not a page configuration, it is a
   * fixture error, and the host would never produce it.
   */
  readonly properties?: Readonly<Record<string, unknown>>;
  /**
   * Declared events the page would have configured, by event name.
   *
   * Each entry is the firing function's *behaviour*: the mock assigns
   * `props[eventName] = (...args) => void` exactly as the host does, and calling it
   * invokes the handler supplied here with the positional arguments — the local stand-in
   * for the host gathering them into the `eventArgs`-keyed object and running the
   * configured command tree. Omit the handler (or pass nothing) and the firing function
   * is a no-op, which is the host's own behaviour for an event with no command attached
   * (and in the designer preview). Refused at construction when the name collides with a
   * declared property or a base prop: two host injections writing one key is not a state
   * a page can be in.
   */
  readonly eventHandlers?: Readonly<Record<string, ((...args: readonly unknown[]) => void) | undefined>>;
  /** Commands the page would have made available to this Cell. */
  readonly serverCommands?: ServerCommandBindings<Commands>;
  /** Data sources the page would have declared, by name. */
  readonly dataSources?: Readonly<Record<string, MockDataSourceResolver>>;
}

/**
 * The message the mock uses for a source it was not given.
 *
 * Exported so a test asserts the property #5 actually pinned — that the message
 * **contains the name** — rather than an equality against wording the product
 * never recorded. The exact host string is not part of the evidence; the shape
 * and the name are.
 */
export function mockUndeclaredDataSourceMessage(dataSourceName: string): string {
  return `ReactCellType data source was not found: ${dataSourceName}`;
}

/**
 * A data source over fixed rows.
 *
 * Paging is applied locally, which is mechanical: `top` limits rows and
 * `totalCount` stays the count the project declared, mirroring #5's observation
 * that `top: 3` returned three rows while `totalCount` remained `72`
 * (`pageSizeCountsAreServerSide`).
 *
 * `orderBySqlParams` is **not** applied. Ordering on the real target is the
 * server's — it depends on the database collation, not on the rows the client
 * happens to hold — so a local sort would encode a guess as a simulation. A
 * project that needs ordered results supplies its own resolver; this helper
 * returns the rows in the order it was given them, whatever options arrive.
 */
export function createMockDataSource(
  rows: readonly unknown[],
  options: { readonly totalCount?: number } = {},
): MockDataSourceResolver {
  return query => {
    const offset = query?.offset ?? 0;
    const limit = query?.top ?? rows.length;
    return {
      data: rows.slice(offset, offset + limit),
      totalCount: options.totalCount ?? rows.length,
      loading: false,
      error: null,
    };
  };
}

/**
 * The mock stand-ins for the members #176 measured.
 *
 * Each is deliberately the *least* behaviour the measurement pins — enough for authored
 * source to exercise the real call shape locally, and nothing the measurement did not
 * execute. They are defaults rather than the mock itself: a project overrides any of them
 * through `forguncyMembers`, and the override wins verbatim. What they must never do is
 * out-behave the host: a mock `uploadFiles` that really stored files somewhere would be a
 * second implementation of a host capability, which is the `no-host-api-mirror` boundary
 * applied to the local half.
 */
function createDefaultForguncyMembers(
  exposedMethods: Record<string, unknown>,
  cellProps: Record<string, unknown>,
): Partial<Record<ForguncyPropMember, unknown>> {
  return {
    // The two permission calls are over the *snapshot*, which is the measured semantics:
    // `hasPermission` reads the capture rather than consulting the host per call, and
    // `getPermissions` answers a fresh shallow copy each time so mutating the result cannot
    // affect what other callers see. Both are synchronous because both were measured
    // synchronous — a Promise here is the more-permissive-than-the-host shape this package
    // already refuses elsewhere.
    hasPermission: (permissionName: unknown) => {
      if (typeof permissionName !== "string" || permissionName.length === 0) {
        return false;
      }
      const snapshot = cellProps.Permissions;
      if (snapshot === null || typeof snapshot !== "object") {
        return false;
      }
      return (snapshot as Record<string, unknown>)[permissionName] === true;
    },
    getPermissions: () => {
      const snapshot = cellProps.Permissions;
      if (snapshot === null || typeof snapshot !== "object") {
        return {};
      }
      return { ...(snapshot as Record<string, boolean>) };
    },
    // The signed-in shape is the measured one and the mock cannot know a project-specific
    // user; the shape is what is predicted (six keys, `PictureUrl` falling back to the
    // built-in default avatar exactly as measured), not the values.
    getCurrentUser: () => ({
      UserName: "MockUser",
      FullName: "MockUser",
      Email: "mock@example.com",
      Role: "User",
      HasPicture: false,
      PictureUrl: "/Forguncy/Resources/Images/SiteBuiltInImages/DefaultCurrentUser.png",
    }),
    // Both fire-and-forget, both no-ops: the measured behaviour is navigation, and a local
    // harness has nowhere to navigate *to* — reproducing a redirect would end the dev
    // session the same way it would have ended #176's probe. Recording nothing is the
    // honest stand-in; a project that needs to observe the call overrides the member.
    // `logOut` declares its parameter because #176 measured arity **1** — an arity of 0
    // here would be a shape the host does not have, observable to anything reading
    // `.length`.
    logIn: () => undefined,
    logOut: (_navigateToHomePage?: boolean) => undefined,
    // The one genuinely asynchronous member, so the mock is asynchronous too — a
    // synchronous answer would be more permissive than the host in exactly the way
    // `hasPermission`'s history warns about. The result shape is the measured one
    // verbatim, including the trailing pipe.
    uploadFiles: async (files?: unknown, options?: { readonly uploadFolder?: string }) => {
      const list = normalizeUploadInput(files);
      const uploadFolder = typeof options?.uploadFolder === "string" && options.uploadFolder.length > 0
        ? `${options.uploadFolder}/`
        : "";
      const uploaded = list.map(file => {
        const filePath = `${uploadFolder}${mockUuid()}_${file.name}`;
        return {
          filePath,
          fileName: file.name,
          downloadUrl: `/Forguncy/FileDownloadUpload/Download?file=${encodeURIComponent(filePath)}`,
        };
      });
      return {
        files: uploaded,
        attachmentValue: uploaded.map(file => `${file.filePath}|`).join(""),
      };
    },
    getUploadLimit: () => ({
      extensionFilter: ".jpg, .jpeg, .png, .gif, .bmp, .xlsx, .docx, .doc, .xls, .pdf",
      accept: ".jpg, .jpeg, .png, .gif, .bmp, .xlsx, .docx, .doc, .xls, .pdf",
      sizeLimit: 0,
      maxUploadFileCount: 0,
    }),
    // The measured semantics, including the silent-ignore: a falsy name or a non-function
    // method does nothing rather than throwing, and a re-registration replaces. The
    // registry is resolved through the closure rather than `this`: the façade binds the
    // member to the handle, so both routes land on the same object, but the closure
    // survives even a detached call — which is exactly the call form a test or a careless
    // consumer can produce, and the one a `this`-based lookup would crash on.
    // Nothing invokes the registrations, because invocation is the host's command
    // pipeline and the mock has no page; `mockExposedMethodInvocations` is the test seam.
    exposeMethod: (methodName: unknown, method: unknown) => {
      if (!methodName || typeof method !== "function") {
        return;
      }
      exposedMethods[methodName as string] = method;
    },
    // The measured passthrough matrix, reproduced because the behaviour *is* the contract
    // here: a colour conversion that did not quantize the alpha would let a cell pass
    // locally with output the host would never produce.
    ConvertToCssColor: (color: string) => mockConvertToCssColor(color),
    ConvertDateToOADate: (date: Date) => mockConvertDateToOADate(date),
    ConvertOADateToDate: (oadate: number) => mockConvertOADateToDate(oadate),
  };
}

/** A per-mock UUID stand-in: unique enough for the path format, without pulling in a dependency. */
let mockUuidCounter = 0;
function mockUuid(): string {
  mockUuidCounter += 1;
  return `mock-${mockUuidCounter.toString().padStart(8, "0")}-0000-4000-8000-000000000000`;
}

/**
 * The input normalization, as #176 measured the host's.
 *
 * A single file-like is one file; an array or array-like (`length` plus indexed elements)
 * is its elements; anything else — including the `undefined` of a no-arguments call — is
 * the empty list, which is what makes the empty-result resolution fall out rather than be
 * a special case.
 */
function normalizeUploadInput(files: unknown): readonly { readonly name: string }[] {
  if (files === undefined || files === null) {
    return [];
  }
  if (Array.isArray(files)) {
    return files as readonly { readonly name: string }[];
  }
  if (typeof files === "object" && typeof (files as { length?: unknown }).length === "number") {
    const length = (files as { length: number }).length;
    const collected: { readonly name: string }[] = [];
    for (let index = 0; index < length; index += 1) {
      collected.push((files as Record<number, { readonly name: string }>)[index]);
    }
    return collected;
  }
  return [files as { readonly name: string }];
}

/**
 * The measured alpha quantization.
 *
 * The 8-digit form is **alpha-leading** — `#AARRGGBB`, the ARGB ordering the host's CLR
 * colour model uses — which the measured matrix pins exactly: `#80FF0000` →
 * `rgba(255,0,0,0.50)` has `FF` at the red position only when the alpha is the first
 * byte, and `#FFFF0000` dropping to `#FF0000` is the same layout with a full alpha.
 * Anything that is not 8-digit hex passes through verbatim, because that is what the
 * host does. Non-string input throws in the host's own code before conversion; the mock
 * relies on the same accident by calling `.startsWith` first, so the TypeError is the
 * host's shape too.
 */
function mockConvertToCssColor(color: string): string {
  if (!color.startsWith("#")) {
    return color;
  }
  if (color.length !== 9) {
    return color;
  }
  const alpha = Number.parseInt(color.slice(1, 3), 16);
  if (alpha === 0xff) {
    return `#${color.slice(3)}`;
  }
  const red = Number.parseInt(color.slice(3, 5), 16);
  const green = Number.parseInt(color.slice(5, 7), 16);
  const blue = Number.parseInt(color.slice(7, 9), 16);
  return `rgba(${red},${green},${blue},${(alpha / 255).toFixed(2)})`;
}

/**
 * The OADate pair, in the local wall-clock arithmetic the host is measured to use.
 *
 * Both directions treat the date as its *local wall-clock components reinterpreted as
 * UTC*, which is what the probe data pins exactly: `ConvertDateToOADate` of the UTC
 * instant `1899-12-30T00:00:00Z` answers `0.33730324074074075` (the local-mean-time
 * offset in days) rather than `0`, and the noon measurement `46023.833333333336` only
 * matches the wall-clock reading — the naive epoch-milliseconds formula misses it by
 * the same offset. The round-trip is exact to the millisecond because the two
 * directions are strict inverses in wall-clock space. Reproducing that here rather
 * than approximating it is the difference between a mock that predicts the host and
 * one that contradicts it on every non-midnight input.
 */
function mockConvertDateToOADate(date: Date): number {
  const asUtc = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
  return (asUtc - Date.UTC(1899, 11, 30)) / 86400000;
}

function mockConvertOADateToDate(oadate: number): Date {
  const shifted = new Date(Date.UTC(1899, 11, 30) + oadate * 86400000);
  return new Date(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    shifted.getUTCHours(),
    shifted.getUTCMinutes(),
    shifted.getUTCSeconds(),
    shifted.getUTCMilliseconds(),
  );
}

/**
 * The methods a mock registered through its `exposeMethod` stand-in, by name.
 *
 * Not part of the façade surface and never reachable through it: the invocation side of
 * the measured contract is the host's command pipeline (`page.getCell(name).getCellType().ExecuteMethod`),
 * which a local process does not have. This is the seam a *test* uses to verify that a
 * cell's registration happened — the local evidence for the registration half, kept
 * explicitly separate from the invocation half the mock cannot reproduce.
 */
export function mockExposedMethodInvocations(provider: RuntimeFacadeProvider): Readonly<Record<string, unknown>> {
  const handle = provider.bindings.cellProps.Forguncy as Record<string, unknown>;
  return (handle.__exposedMethods ?? {}) as Readonly<Record<string, unknown>>;
}

/** Build the provider a local harness installs. */
export function createMockRuntimeFacadeProvider<
  Commands extends ServerCommandParameterMap = Record<never, never>,
>(options: MockRuntimeFacadeOptions<Commands> = {}): RuntimeFacadeProvider {
  // The base props first, because the handle's defaults read them: `Permissions` on the
  // handle is the *same object* as the base prop, which is the identity #176 measured.
  const cellProps = Object.fromEntries(CELL_PROPS_BASE_KEYS.map(key => [key, undefined])) as Record<
    string,
    unknown
  >;
  // Two of them are injected as an empty *object* on every Cell, including a Cell that
  // configured nothing — an executed page handed a Cell `{}` for each of these. Leaving
  // them `undefined` would make the mock a different host in the one direction a local
  // harness must never lean: `Object.keys(props.Permissions)` throws locally and works
  // in production. Defaulted before the override loop, so a harness that deliberately
  // wants `undefined` can still ask for it and exercise the resolver's presence rule.
  cellProps.Permissions = {};
  cellProps.ImageContext = {};
  for (const [key, value] of Object.entries(options.cellProps ?? {})) {
    if (!(CELL_PROPS_BASE_KEYS as readonly string[]).includes(key)) {
      throw new RuntimeFacadeContractError(
        "unknown-host-binding",
        `The mock supplies the base prop "${key}", which is not one #5 verified on a ReactCellType Cell.`,
      );
    }
    cellProps[key] = value;
  }
  cellProps.ServerCommands = options.serverCommands ?? {};

  // Declared properties and events land on `props` itself, under their own names — the
  // host's own injection. Both collision checks are construction-time refusals for the
  // same reason the unknown-key ones are: a fixture that quietly overwrote a base prop,
  // or let two declarations write one key, would be predicting a page that cannot exist.
  for (const [propertyName, value] of Object.entries(options.properties ?? {})) {
    if ((CELL_PROPS_BASE_KEYS as readonly string[]).includes(propertyName)) {
      throw new RuntimeFacadeContractError(
        "unknown-host-binding",
        `The mock declares the cell property "${propertyName}", which collides with a base prop the runtime always injects. A property cannot overwrite the host's own injection — rename the property.`,
      );
    }
    cellProps[propertyName] = value;
  }

  const declaredProperties = new Set(Object.keys(options.properties ?? {}));
  for (const [eventName, handler] of Object.entries(options.eventHandlers ?? {})) {
    if ((CELL_PROPS_BASE_KEYS as readonly string[]).includes(eventName) || declaredProperties.has(eventName)) {
      throw new RuntimeFacadeContractError(
        "unknown-host-binding",
        `The mock declares the event "${eventName}", which collides with a base prop or a declared property. Two host injections cannot write one key — rename the event.`,
      );
    }
    // Always a function, even when the project supplied no handler: #176 measured the
    // runtime assigning `props[eventName] = (...args) => void` for *every* declared
    // eventHandlers entry, and an uncommanded event is a no-op rather than an absent key.
    cellProps[eventName] = typeof handler === "function"
      ? (...args: readonly unknown[]) => {
          handler(...args);
        }
      : () => undefined;
  }

  // The handle is built after the props: the defaults read `cellProps` (the permission
  // identity), and the registry the `exposeMethod` stand-in writes into lives on it.
  const handle = Object.fromEntries(CELL_FORGUNCY_PROP_KEYS.map(member => [member, undefined])) as Record<
    string,
    unknown
  >;
  // The registration registry the `exposeMethod` stand-in writes into. Non-enumerable on
  // purpose: the host handle's key list is exactly `CELL_FORGUNCY_PROP_KEYS` — a cell
  // enumerating `Object.keys(props.Forguncy)` must see the same fourteen names locally —
  // and a mock-internal key showing up there would be the mock being *wider* than the host,
  // the one direction it must never lean.
  const exposedMethods: Record<string, unknown> = {};
  Object.defineProperty(handle, "__exposedMethods", {
    value: exposedMethods,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  for (const [member, value] of Object.entries(createDefaultForguncyMembers(exposedMethods, cellProps))) {
    handle[member] = value;
  }
  // The snapshot on the handle is the *same object* the base prop carries — identity, not
  // equality, because that is what #176 measured (`identityEqualsPropsPermissions`) and what
  // `permission-snapshot`'s note pins. Written after the defaults loop because the default
  // table cannot close over `cellProps` without circularity, and a copy here instead of the
  // same reference would break the identity a cell can legitimately compare — which is also
  // why `permissionSnapshot` and the base-prop read must agree.
  handle.Permissions = cellProps.Permissions;
  for (const [member, value] of Object.entries(options.forguncyMembers ?? {})) {
    if (!(CELL_FORGUNCY_PROP_KEYS as readonly string[]).includes(member)) {
      throw new RuntimeFacadeContractError(
        "unknown-host-binding",
        `The mock supplies props.Forguncy.${member}, which is not a member #5 verified. A mock may only stand in for addresses the host has, or local development stops predicting the host.`,
      );
    }
    handle[member] = value;
  }
  cellProps.Forguncy = handle;

  const dataSources = options.dataSources ?? {};
  const useDataSource: DataSourceBinding = (dataSourceName, query) => {
    // `Object.hasOwn`, for the same reason the façade asks it of `ServerCommands`: a
    // data-source name is a string a caller supplies, so a bare read walks the
    // prototype chain and `toString` / `constructor` answer with functions. The
    // undeclared-source path below would then never be reached for them, and the
    // mock would answer with a string where #5 records an error *state* — a local
    // harness disagreeing with the host about a shape, which is the one thing it
    // must not do.
    const resolver = Object.hasOwn(dataSources, dataSourceName)
      ? dataSources[dataSourceName]
      : undefined;
    if (typeof resolver !== "function") {
      // The host's own shape for this case: an error state rather than a throw.
      return {
        data: [],
        totalCount: 0,
        loading: false,
        error: mockUndeclaredDataSourceMessage(dataSourceName),
      };
    }
    return resolver(query);
  };

  const bindings: RuntimeFacadeHostBindings = {
    cellProps: cellProps as RuntimeFacadeCellProps,
    useDataSource,
  };
  return { kind: "mock", bindings };
}
