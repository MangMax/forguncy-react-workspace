/**
 * The production Cell runtime: the façade a compiled Cell executes, and nothing else.
 *
 * Decision sources: GitHub Issues
 * - #27 — "Spec: typed Forguncy runtime facade for application-owned capabilities"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/27)
 * - #29 — "Implement: typed Forguncy runtime facade and local mock provider"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/29)
 * - #82 — "修复 Runtime：在生产 Cell 入口自动安装 Host Provider"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/82)
 * - #124 — "refactor(runtime,core): 隔离 Cell 生产超薄运行时与工具链契约表"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/124)
 *
 * ## What this module is, and why it is a separate file from `facade.ts`
 *
 * `facade.ts` is the façade *surface and its audit*: the six members, the registry of which
 * capabilities they expose, and `auditRuntimeFacadeSurface()`. The audit is a toolchain concern
 * — it is run by tests and by `assertRuntimeFacadeSurfaceIsExposed()`, never by a Cell — and it
 * reads `capabilities.ts`, an 892-line evidence table. The runtime a Cell executes needs none of
 * that: it needs the six accessors, the provider slot, and the two key tuples they validate
 * against. Keeping both in one module meant every production Cell's flattened artifact carried
 * the registry.
 *
 * So this module is the runtime and `facade.ts` is the audit. `facade.ts` imports and re-exports
 * what is here, which keeps the root entry's surface unchanged; `cell.ts` is the subpath the
 * compiler's generated binding imports, and it re-exports this module alone. The split is
 * structural, not a tree-shaking hope: this module's *static* imports are `provider.ts`,
 * `host-provider.ts`, `port.ts` and `core/cell-props`, none of which imports the registry or
 * `local-dev.ts`.
 *
 * #21's single-Cell budget is the reason it matters, and the rule is stated where the artifact
 * is measured (`cell-compiler`'s `runtime-binding.test.ts`): the compiled example carries no
 * local-development contract, no capability registry, no target record and no selection-signal
 * table. This file is what makes that a property of the module graph rather than of how well a
 * bundler can prove a table inert.
 *
 * ## What this module does not own
 *
 * It does not own the surface *declaration* (`RUNTIME_FACADE_SURFACE` stays in `facade.ts`
 * beside the audit that compares it against the accessors) and it does not own the absence
 * taxonomy (`provider.ts` does). Its subject is exactly "what a Cell calls and what it gets
 * when the host cannot answer".
 */

import { CELL_FORGUNCY_PROP_KEYS, CELL_PROPS_BASE_KEYS } from "@forguncy-react-workspace/core/cell-props";
import type { CellPropKey, ForguncyPropMember } from "@forguncy-react-workspace/core/cell-props";

import { RUNTIME_FACADE_PORT_HOOK_NAME } from "./port.ts";
import { refuseAbsence, requireRuntimeFacadeProvider, RuntimeFacadeResolutionError } from "./provider.ts";
import type { RuntimeFacadeRefusalPathId } from "./provider.ts";
import type {
  DataSourceQueryOptions,
  DataSourceResult,
  RuntimeFacadeHostBindings,
  RuntimeFacadeProvider,
  ServerCommandParameterMap,
  ServerCommandResult,
} from "./contract.ts";
// Erased at compile time: these are the shapes #176 measured, and they cost a production
// Cell nothing because `import type` leaves no runtime edge. See `facade-types.ts` for why
// the shapes live in their own module rather than in this one.
import type {
  ForguncyCellMethod,
  ForguncyCurrentUser,
  ForguncyEventFiring,
  ForguncyUploadFilesInput,
  ForguncyUploadLimit,
  ForguncyUploadResult,
} from "./facade-types.ts";

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

export const RUNTIME_FACADE_SURFACE_MEMBER_IDS = [
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
] as const;

export type RuntimeFacadeSurfaceMemberId = (typeof RUNTIME_FACADE_SURFACE_MEMBER_IDS)[number];

/**
 * The base props `cellProp` reaches.
 *
 * Written out rather than derived, for the same reason `DataSourceResult` writes
 * its four fields out: `core` declares `CELL_PROPS_BASE_KEYS` as a literal tuple
 * but `RuntimeFacadeHostBinding` carries the prop name as a literal union only
 * after a lookup, so the *type* of the accessor's parameter has to come from a
 * literal tuple somewhere. A test compares this tuple against the addresses the
 * registry derives for `cellProp`, so the two cannot quietly diverge — including
 * the exclusion that matters: `ServerCommands` is a confirmed base prop and is
 * deliberately not here, because the member that exposes it is
 * `invokeServerCommand`.
 *
 * Since #177 the tuple is a single entry: `ImageContext` is the one capability whose
 * evidence still stops at `member-presence` (its populated shape was read from the runtime
 * source but never executed — `image-context-populated-shape`), so it is the one address
 * the declared-shape accessor still owns. `Permissions` moved out: #176 measured its
 * identity-equality with `props.Forguncy.Permissions` and lifted `permission-snapshot` to
 * `call-shape`, which is what `permissionSnapshot` now types. An address whose evidence
 * supports a typed member does not stay in the weak accessor's domain — reaching it there
 * would be the second-address failure this tuple's exclusions exist to refuse.
 */
export const RUNTIME_FACADE_CELL_PROP_ADDRESSES = [
  "ImageContext",
] as const satisfies readonly CellPropKey[];

/**
 * The handle members `forguncyMember` reaches, in `CELL_FORGUNCY_PROP_KEYS`
 * order.
 *
 * **Empty since #177**, and deliberately kept rather than deleted. Every member of this
 * tuple's original domain is now exposed through a typed member — #176 measured all nine
 * call shapes, and a confirmed address whose signature the evidence pins is the exact
 * input the typed half of the surface is for. What remains is the *machinery*: the empty
 * tuple is the type-level statement that there is currently no handle member whose shape a
 * caller must declare for themselves, and keeping the accessor in place is what lets the
 * next probed member land somewhere honest — a presence-only address that arrives later
 * goes here first instead of being typed on a guess or left unreachable. The derivation
 * test still compares this tuple against the registry's answer for `forguncyMember`, so a
 * member that re-enters the domain is picked up by both.
 */
export const RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES = [
] as const satisfies readonly ForguncyPropMember[];

export type ExposedCellPropKey = (typeof RUNTIME_FACADE_CELL_PROP_ADDRESSES)[number];
export type ExposedForguncyMember = (typeof RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES)[number];

// ---------------------------------------------------------------------------
// The surface type
// ---------------------------------------------------------------------------

/**
 * The façade a Cell author calls.
 *
 * Generic over the project's server-command map, defaulting to the empty map —
 * the same trick `ServerCommandBindings` uses, for the same reason: `keyof
 * Record<never, never>` is `never`, so a bare `runtimeFacade()` admits **no**
 * command call at all. An un-declared command stays un-callable rather than
 * becoming a call whose arguments nobody observed.
 *
 * The other three members take their declaration at the call site instead,
 * because what a project declares for them is a single shape rather than a
 * record of names: `cellProp<PermissionEntry[]>("Permissions")`. The asymmetry
 * follows the host shape — commands are a map keyed by designer-chosen names,
 * props and handle members are single addresses.
 */
export interface RuntimeFacade<
  Commands extends ServerCommandParameterMap = Record<never, never>,
  Properties extends string = never,
  Events extends string = never,
> {
  invokeServerCommand<Name extends keyof Commands & string>(
    name: Name,
    ...parameters: Commands[Name]
  ): Promise<ServerCommandResult>;

  /**
   * The confirmed `useDataSource` wrapper-local, under its confirmed name.
   *
   * Kept as a `use`-prefixed function because it *is* a React hook: the host
   * implementation is a wrapper-local hook, so React's rules have to see it as
   * one. Renaming it would give one binding two names, which
   * `RUNTIME_FACADE_FORBIDDEN_PATTERNS` records as the way two spellings of the
   * same value start to disagree — and the name is also the port member
   * (`RUNTIME_FACADE_PORT_HOOK_NAME`), so the façade and the port agree by
   * construction.
   */
  useDataSource(dataSourceName: string, options?: DataSourceQueryOptions): DataSourceResult;

  /**
   * The host's own permission check, under its confirmed name.
   *
   * Synchronous, because that is what #5 recorded: the probe called
   * `props.Forguncy.hasPermission("ProbePermission")` and logged `true`, while the
   * `ServerCommands` call recorded in the same section is logged as
   * `await … resolved in 185 ms`. A `Promise<boolean>` here would be a shape nothing
   * observed — and precisely the one an author would write by assuming the handle
   * mirrors the command record.
   */
  hasPermission(permissionName: string): boolean;

  /**
   * Every configured permission's boolean, under the host's own name.
   *
   * `Readonly<Partial<Record<string, boolean>>>` rather than a keyed shape or a plain
   * `Record<string, boolean>`: #5 records one boolean per *configured*
   * `permissions[].name`, and those names are designer-chosen, so a key union would be a
   * declaration this package has no basis to make — while a plain `Record` is the
   * opposite mistake, promising a `boolean` at every string key when the evidence covers
   * only the configured ones and an unconfigured key is simply absent. This repository
   * does not enable `noUncheckedIndexedAccess`, so that promise would be collected
   * silently: `const granted: boolean = map["NotConfigured"]` compiles, and reads
   * `undefined` at runtime. `Partial` puts the absence back in the type where the
   * evidence puts it. The values are `readonly` too because the map is the host's
   * resolved snapshot — a Cell that wrote to it would be editing host state, which is
   * the ownership mistake `RUNTIME_FACADE_BOUNDARIES` exists to describe.
   *
   * The shape is *checked* at the boundary rather than asserted, unlike the members that
   * forward a port type: the handle declares this member as
   * `(...args: unknown[]) => unknown`, so this type is a narrowing the package invents,
   * and an invented claim is one it has to earn. `permissionMap` refuses the answers that
   * are not the recorded shape — and what it guarantees, that every *present* own entry
   * holds a boolean, is now the same sentence this type says rather than a stronger one.
   */
  getPermissions(): Readonly<Partial<Record<string, boolean>>>;

  /**
   * The permission snapshot the host resolved before the page rendered, read as a base prop.
   *
   * #176 measured on `12.0.102.0` that `props.Permissions` is identity-equal to
   * `props.Forguncy.Permissions` and carries one boolean per configured `permissions[].name`,
   * which is what lifts this out of the declared-shape accessor: the shape is the same
   * `Partial<Record<string, boolean>>` `getPermissions()` returns, and the `Partial` is load-bearing
   * in the same way — an unconfigured name is absent, so the type may not promise a boolean
   * there. Reading it as a value rather than calling it as a method is the measured difference
   * between this member and `getPermissions`: the snapshot is captured at cell initialization,
   * not consulted per call.
   */
  permissionSnapshot(): Readonly<Partial<Record<string, boolean>>>;

  /**
   * The signed-in user the host already resolved, under the host's own member name.
   *
   * Synchronous — #176 measured the object being returned directly, not a Promise. Every
   * field of `ForguncyCurrentUser` is optional because the signed-out shape is still an open
   * question (`signed-out-user-shape`): requiring `UserName` would promise that a signed-out
   * read cannot produce a partially-empty record, which is exactly the shape of claim this
   * façade exists to refuse.
   */
  getCurrentUser(): ForguncyCurrentUser;

  /**
   * Navigate the browser to the host's login page. Arity 0, fire-and-forget.
   *
   * #176 measured `logIn.length === 0` and the wrapper forwarding to
   * `Forguncy.AccountEx_ForApi.navigateToLogin()` with no arguments and no Promise: the
   * redirect *is* the outcome, so there is nothing to await. A return type of `Promise` here
   * would teach authored source to await a navigation that has already started.
   */
  logIn(): void;

  /**
   * End the session through the host's own sign-out, forwarding `navigateToHomePage` verbatim.
   *
   * Arity 1, fire-and-forget — #176 measured `logOut.length === 1` and the wrapper forwarding
   * the single argument to `Forguncy.logOut` untouched. What the redirect matrix is, and
   * whether `false` suppresses the navigation, is the host's own contract
   * (`logOut-redirect-observability`), which is why the parameter is typed `boolean | undefined`
   * rather than required: the host forwards whatever it is given, and this façade pins the
   * arity, not the host's navigation decisions.
   */
  logOut(navigateToHomePage?: boolean): void;

  /**
   * Upload files through the host rather than posting to a cell-invented endpoint.
   *
   * #176 executed the full matrix: a single `File`, an array, or a `FileList` are all
   * accepted; no arguments or an empty array resolve the empty result rather than rejecting;
   * validation failures reject with the localized messages
   * `CELL_FORGUNCY_FACADE_MEMBER_SHAPES` records verbatim. This is the one typed member that
   * is genuinely asynchronous — the host's own contract is a Promise, so awaiting here is
   * correct rather than permissive.
   */
  uploadFiles(files?: ForguncyUploadFilesInput, options?: { readonly uploadFolder?: string }): Promise<ForguncyUploadResult>;

  /**
   * The host's declared upload limit, synchronous.
   *
   * `sizeLimit` is **megabytes** and `0` means unlimited on both numeric fields — measured,
   * not documented. The shape is returned verbatim rather than narrowed because there is
   * nothing to refuse: #176 measured a plain object with these four keys, so the type is the
   * measurement rather than a claim about it.
   */
  getUploadLimit(): ForguncyUploadLimit;

  /**
   * Publish a cell-provided method so a configured Forguncy command can reach it.
   *
   * #176 measured the registration half end-to-end: invalid input (a falsy name, a
   * non-function method) is silently ignored rather than throwing, and re-registering the
   * same name replaces the previous registration. The invocation half — the host reaching
   * the cell through `page.getCell(name).getCellType().ExecuteMethod` — is the host's
   * command pipeline, and the cell's half of it ends here: this façade registers, it does
   * not invoke.
   */
  exposeMethod(methodName: string, method: ForguncyCellMethod): void;

  /**
   * The host's own date conversion, running in the local timezone.
   *
   * #176 measured the pair as local-timezone-shifted: a round-trip composed with
   * `convertOADateToDate` is exact to the millisecond, but the OLE Automation epoch does not
   * map to `0` because the conversion is not UTC. The return is `number` rather than a
   * branded type because the value is the host's own currency — a cell passing it back to
   * the host needs the number, not a refinement of it.
   */
  convertDateToOADate(date: Date): number;

  /** The inverse conversion, with the same local-timezone behaviour as its pair. */
  convertOADateToDate(oadate: number): Date;

  /**
   * The host's own colour conversion.
   *
   * #176 measured the passthrough matrix verbatim: 6-digit hex, `rgb()` and named colours
   * pass through unchanged; an `FF` alpha is dropped from 8-digit hex; a partial alpha is
   * quantized to `rgba(r,g,b,a)` with two decimals; non-string input throws a `TypeError`
   * in the host's own code. The cell-facing contract is the type, not the behaviour —
   * reproducing the quantization in the façade would be a second implementation of a host
   * value.
   */
  convertToCssColor(color: string): string;

  /**
   * A declared cell property's current value.
   *
   * `Properties` defaults to `never`, so a bare `runtimeFacade()` admits **no** property read
   * — the same discipline `invokeServerCommand` applies to commands, because which properties
   * exist is a project declaration (#178), not something this contract can know. The value is
   * `unknown` until the caller declares its shape: the host evaluates the property's formula
   * and hands the cell the result, and what a given property carries is the project's claim,
   * not the façade's. What *is* measured is the re-render half: when the host's
   * `SetPropertyValue` runs, the existing tree re-renders with the new value **without**
   * re-executing the cell entry, so a component reading this member during render sees the
   * current value on every render.
   */
  cellProperty<Shape = unknown>(propertyName: Properties): Shape;

  /**
   * Fire a declared event, gathering the positional arguments for the host's command pipeline.
   *
   * `Events` defaults to `never` for the same reason `Properties` does. The firing call is
   * `void` even when the designer attached a command tree: #176 measured the runtime gathering
   * the positional arguments into an object keyed by `eventArgs[].name` and handing it to
   * `executeCustomCommandObject`, and the command's outcome is the host pipeline's business —
   * it is not observable through the firing call. An event with no command attached is a
   * no-op, which is the host's own behaviour in the designer preview rather than an absence
   * the façade refuses.
   */
  fireEvent(eventName: Events, ...args: readonly unknown[]): void;

  /** A confirmed base prop, under the name `core` verified. */
  cellProp<Shape = unknown>(key: ExposedCellPropKey): Shape;

  /**
   * A confirmed `props.Forguncy` member, under the name `core` verified.
   *
   * Since #177 every measured member has a typed surface member of its own, so this accessor's
   * domain is empty: it exists for the next presence-only address, and until one arrives it
   * admits nothing — which is the type system saying "no member currently needs its shape
   * declared by hand" rather than the accessor being broken.
   */
  forguncyMember<Signature = unknown>(member: ExposedForguncyMember): Signature;
}

/**
 * The implementation, typed the way the members are really written.
 *
 * `RuntimeFacade` with its default type argument is the *un-declared* surface, so
 * it is the right type for everything except the two generic accessors, whose
 * shape is supplied by the caller at the call site: an implementation typed with
 * a caller's `Shape` would have to be generic over it, which the runtime knows
 * nothing about. Splitting the two is what keeps the boundary cast to a **single
 * site** — `surface` below is built as this interface and declared as
 * {@link RuntimeFacade}, and the only other cast over the same object is
 * `runtimeFacade`'s variance step onto the caller's type argument. Neither is a
 * second code path, so neither can behave differently per provider kind, and
 * that property is what the split is for; the cast count is a symptom of it, not
 * the goal. (The audit's read of a provider's `bindings` is a third cast and is
 * a different thing: it reads an object it was handed, and is documented there.)
 */
interface RuntimeFacadeImplementation {
  invokeServerCommand(name: string, ...parameters: readonly unknown[]): Promise<ServerCommandResult>;
  useDataSource(dataSourceName: string, options?: DataSourceQueryOptions): DataSourceResult;
  hasPermission(permissionName: string): boolean;
  getPermissions(): Readonly<Partial<Record<string, boolean>>>;
  permissionSnapshot(): Readonly<Partial<Record<string, boolean>>>;
  getCurrentUser(): ForguncyCurrentUser;
  logIn(): void;
  logOut(navigateToHomePage?: boolean): void;
  uploadFiles(files?: ForguncyUploadFilesInput, options?: { readonly uploadFolder?: string }): Promise<ForguncyUploadResult>;
  getUploadLimit(): ForguncyUploadLimit;
  exposeMethod(methodName: string, method: ForguncyCellMethod): void;
  convertDateToOADate(date: Date): number;
  convertOADateToDate(oadate: number): Date;
  convertToCssColor(color: string): string;
  cellProperty(propertyName: string): unknown;
  fireEvent(eventName: string, ...args: readonly unknown[]): void;
  cellProp(key: ExposedCellPropKey): unknown;
  forguncyMember(member: ExposedForguncyMember): unknown;
}

/**
 * The concrete surface, as it is built.
 *
 * Built once and handed out by {@link runtimeFacade}, which is what makes the
 * audit able to compare the *implementation* against the registry
 * (`member-not-implemented` / `surface-member-unregistered`) instead of
 * comparing the registry against itself.
 *
 * The members close over nothing: each one resolves the installed provider at the
 * moment it is called, so a Cell that renders twice under a harness that
 * reinstalled a provider for the second render reads the second one. Holding the
 * bindings here instead would freeze the first render's props and make a
 * property change invisible.
 */
function buildRuntimeFacadeSurface(): RuntimeFacadeImplementation {
  return {
    invokeServerCommand: async (name, ...parameters) => {
      const commands = serverCommandRecord(requireRuntimeFacadeProvider());
      // A *named-record* address, so absence is read differently from the
      // rectangular ones (a base prop, a handle member): #5 records that only the
      // names in `availableServerCommands` are present, so a name that is not
      // there is a page configuration and gets its own code. Reading it with the
      // presence rule above would report every unconfigured command as a wiring
      // fault.
      //
      // `Object.hasOwn` rather than `commands[name]`, because `name` is a string a
      // caller supplies and a bare read walks the prototype chain: `toString`,
      // `constructor`, `valueOf` and the rest of `Object.prototype` all answer with
      // a function, so the branch below — the one #5's unconfigured-command
      // observation is about — would never be reached for them, and the command
      // would be invoked. Own keys are what the observation is about, so own keys
      // are what is asked about.
      const call = Object.hasOwn(commands, name) ? commands[name] : undefined;
      if (call === undefined) {
        throw refuseAbsence(
          "server-command-not-configured",
          name,
          `Server command "${name}" is not available to this Cell: #5 records only the names in availableServerCommands as present, so the record has no such key. Add it to the Cell's available commands, or supply it in the mock provider.`,
        );
      }
      if (typeof call !== "function") {
        // `refuseAbsence` reads the code *and* the family from the path, which is why
        // this branch names `server-command-entry-not-callable` rather than choosing
        // a code: the key is on the record, so nothing is missing from the provider —
        // what sits behind a declared command is unusable, which is
        // `capability-not-supplied`, and the address is a command name.
        //
        // This branch used to borrow `missingBinding`, whose name and hard-coded code
        // are both about an address that is *not there*. That classified a declared
        // command as a provider wiring fault, and — because the family was written
        // down nowhere but in the taxonomy row and the regression's annotation — the
        // mistake survived two review rounds. The path table is what makes that
        // impossible rather than merely unlikely.
        throw refuseAbsence(
          "server-command-entry-not-callable",
          name,
          `Server command "${name}" is on the record but is not a function, so the call cannot be made: #5 records ServerCommands as a record of command name to async function. The page declared the command but did not supply it in the form the runtime calls.`,
        );
      }
      // Called *on the record*, not detached from it: #5 confirms the method form
      // (`props.ServerCommands.GetSalesData({})`), and a detached call hands the
      // command `undefined` as `this`. That difference is invisible until the
      // command uses `this`, which is why the regression drives one that does.
      //
      // `async` on purpose: an unconfigured command must surface as a rejection
      // of the promise the caller is already awaiting, not as a synchronous throw
      // that a `.catch()` would miss.
      const result = await (call as (...args: readonly unknown[]) => Promise<unknown>).call(
        commands,
        ...parameters,
      );
      // The third place this file narrows what a provider gave back, and the last one
      // whose claim can be checked at all: `serverCommandRecord` types the record as
      // `Record<string, unknown>`, so `ServerCommandResult` is this file's claim about
      // what a command resolves to, and the only part of that claim #5 records beyond
      // the reserved keys is that a real call *is* a record
      // (`{ errorCode, errorMessage, data: [...] }`). Object-ness is therefore all that
      // is asked, and requiring the reserved keys here would contradict
      // `ServerCommandResult`'s deliberate optionality — which exists because #5
      // recorded the keys, not what a given command puts in them.
      if (result === null || typeof result !== "object") {
        throw refuseAbsence(
          "server-command-result-invalid",
          name,
          `Server command "${name}" answered ${answerShape(result)} rather than the result record #5 recorded, so the call cannot be reported as having returned one.`,
        );
      }
      return result as ServerCommandResult;
    },

    useDataSource: (dataSourceName, options) => {
      const provider = requireRuntimeFacadeProvider();
      const binding = portBinding(provider, "useDataSource");
      if (typeof binding !== "function") {
        throw missingInjection(
          "data-source-hook-not-supplied",
          RUNTIME_FACADE_PORT_HOOK_NAME,
          "the provider carries no data-source binding",
        );
      }
      // No undeclared-name check here, and that is deliberate: #5 records an
      // undeclared data source as an error *state* on the result, so passing the
      // name through is passing through the host's own contract. See
      // `RUNTIME_FACADE_ABSENCE_MODES`' `undeclared-data-source` row.
      //
      // Called bare, unlike the record addresses around it, and the asymmetry is read
      // off the evidence rather than chosen: `useDataSource` is a wrapper-local
      // function in the cell scope (`CELL_SOURCE_EXECUTION_MODEL.userCodeNesting`),
      // and #5 records it called as `useDataSource("Sales", { top: 3 })` — a form
      // with no owning object, so there is no receiver to preserve.
      return (binding as RuntimeFacadeHostBindings["useDataSource"])(dataSourceName, options);
    },

    // The two handle members below resolve their address the same way `forguncyMember`
    // does — the same own-property rule, the same receiver preservation — but they
    // resolve it through `hostHandleMethod` rather than `hostHandleMember`, and that
    // difference is the whole point of having two helpers: #5 *called* these two, so
    // demanding a callable value here is paid for by evidence. The nine
    // `member-presence` addresses behind `forguncyMember` were only ever seen in the
    // handle's key list, so the same demand there would be a contract the evidence
    // never gave — see `hostHandleMember`.
    //
    // They are also where the narrowing happens, and the reason is the handle's own
    // type: `ForguncyPropMember` declares every member as
    // `(...args: unknown[]) => unknown`, so `boolean` and the permission map's shape are
    // types this file invents rather than types it forwards — and a claim this file
    // invents is one it has to check at the boundary, which is what `answerShape` and
    // `permissionMap` below do. `useDataSource` is the one member that does not narrow:
    // its shape is declared in `contract.ts` as the port's own obligation, so re-testing
    // it here would be a second copy of a rule that already has an owner. The command
    // record is the middle case — it arrives as `Record<string, unknown>` and is narrowed
    // on the spot — so its check lives where its value arrives, in `invokeServerCommand`.
    hasPermission: permissionName => {
      const check = hostHandleMethod(requireRuntimeFacadeProvider(), "hasPermission") as (
        permissionName: string,
      ) => unknown;
      const granted = check(permissionName);
      // Checked rather than coerced, because the declared return is a claim this
      // member has to be able to make: `Boolean("false")` is `true`, so a truthiness
      // conversion would report every permission as granted against a host that
      // answered a string, and returning `false` for an unobserved shape would be
      // the guess #29's fifth acceptance criterion forbids.
      if (typeof granted !== "boolean") {
        throw refuseAbsence(
          "called-member-answered-wrong-shape",
          permissionName,
          `props.Forguncy.hasPermission("${permissionName}") answered ${answerShape(granted)} rather than the boolean #5 recorded, so the check's result cannot be reported as one.`,
        );
      }
      return granted;
    },

    getPermissions: () => {
      const read = hostHandleMethod(requireRuntimeFacadeProvider(), "getPermissions") as () => unknown;
      return permissionMap(read());
    },

    // Reads the base prop rather than the handle because that is the snapshot's measured
    // address — captured at initialization, identity-equal to `props.Forguncy.Permissions` —
    // and the narrowing is the same `permissionMap` the other two permission members run.
    permissionSnapshot: () => {
      const provider = requireRuntimeFacadeProvider();
      const snapshot = ownValue(portBinding(provider, "cellProps"), "Permissions", "Permissions", "base-prop-not-supplied");
      return permissionMap(snapshot);
    },

    // The members below all resolve through `hostHandleMethod` — every one was *called* in
    // #176's probe, so callability is paid for — and each narrows only what separates the
    // measured shape from one the evidence does not describe. The behaviours inside the
    // shapes (the timezone shift, the alpha quantization, the pipe joining) stay the host's
    // own: reproducing them here would be the second implementation `no-host-api-mirror`
    // refuses.
    getCurrentUser: () => {
      const read = hostHandleMethod(requireRuntimeFacadeProvider(), "getCurrentUser") as () => unknown;
      const user = read();
      if (user === null || typeof user !== "object" || Array.isArray(user) || isThenable(user)) {
        throw refuseAbsence(
          "called-member-answered-wrong-shape",
          "getCurrentUser",
          `props.Forguncy.getCurrentUser() answered ${answerShape(user)} rather than the user record #176 measured, so the call cannot be reported as having returned one.`,
        );
      }
      return user as ForguncyCurrentUser;
    },

    logIn: () => {
      const navigate = hostHandleMethod(requireRuntimeFacadeProvider(), "logIn");
      // Fire-and-forget as measured: no return inspection, because awaiting or refusing a
      // return the host never promised would invent a shape. The `void` is the type
      // system's copy of that measurement.
      void navigate();
    },

    logOut: navigateToHomePage => {
      const logout = hostHandleMethod(requireRuntimeFacadeProvider(), "logOut");
      // Verbatim, including `undefined` when the caller omitted it — coalescing a default
      // would be a navigation decision the host owns.
      void logout(navigateToHomePage);
    },

    uploadFiles: (files, options) => {
      const upload = hostHandleMethod(requireRuntimeFacadeProvider(), "uploadFiles") as (
        files?: unknown,
        options?: unknown,
      ) => unknown;
      // Arguments forward exactly as they arrived: the input normalization is the host's
      // own, and the no-arguments case is the host's empty result, not an error this member
      // may pre-empt.
      const result = upload(files, options);
      if (!isThenable(result)) {
        throw refuseAbsence(
          "called-member-answered-wrong-shape",
          "uploadFiles",
          `props.Forguncy.uploadFiles() answered ${answerShape(result)} rather than the Promise #176 measured, so the upload cannot be reported as having started.`,
        );
      }
      return (result as Promise<unknown>).then(settled => {
        if (settled === null || typeof settled !== "object" || Array.isArray(settled)) {
          throw refuseAbsence(
            "called-member-answered-wrong-shape",
            "uploadFiles",
            `props.Forguncy.uploadFiles() resolved to ${answerShape(settled)} rather than the upload result #176 measured, so the upload cannot be reported as having returned one.`,
          );
        }
        return settled as ForguncyUploadResult;
      });
    },

    getUploadLimit: () => {
      const read = hostHandleMethod(requireRuntimeFacadeProvider(), "getUploadLimit") as () => unknown;
      const limit = read();
      if (limit === null || typeof limit !== "object" || Array.isArray(limit) || isThenable(limit)) {
        throw refuseAbsence(
          "called-member-answered-wrong-shape",
          "getUploadLimit",
          `props.Forguncy.getUploadLimit() answered ${answerShape(limit)} rather than the upload limit record #176 measured, so the call cannot be reported as having returned one.`,
        );
      }
      return limit as ForguncyUploadLimit;
    },

    exposeMethod: (methodName, method) => {
      const expose = hostHandleMethod(requireRuntimeFacadeProvider(), "exposeMethod");
      // Forwarded as written, invalid input included: the host silently ignores it, so
      // refusing here would make the façade stricter than the host.
      void expose(methodName, method);
    },

    convertDateToOADate: date => {
      const convert = hostHandleMethod(requireRuntimeFacadeProvider(), "ConvertDateToOADate");
      return convert(date) as number;
    },

    convertOADateToDate: oadate => {
      const convert = hostHandleMethod(requireRuntimeFacadeProvider(), "ConvertOADateToDate");
      return convert(oadate) as Date;
    },

    convertToCssColor: color => {
      const convert = hostHandleMethod(requireRuntimeFacadeProvider(), "ConvertToCssColor");
      return convert(color) as string;
    },

    cellProperty: propertyName => {
      const provider = requireRuntimeFacadeProvider();
      // Presence, not definedness — a property whose formula currently evaluates to
      // `undefined` is a state the host allows. No confirmation check: property names are
      // the project's declaration, not anything #5 enumerated. The re-render half needs no
      // machinery either: this read runs during render, and the host's `SetPropertyValue`
      // re-renders without re-executing the entry, so the current render's value is what it
      // sees.
      return ownValue(portBinding(provider, "cellProps"), propertyName, propertyName, "base-prop-not-supplied");
    },

    fireEvent: (eventName, ...args) => {
      const provider = requireRuntimeFacadeProvider();
      const firing = ownValue(portBinding(provider, "cellProps"), eventName, eventName, "base-prop-not-supplied");
      if (typeof firing !== "function") {
        throw refuseAbsence(
          "called-member-not-callable",
          eventName,
          `props.${eventName} is not callable, so the event cannot be fired: #176 measured the host assigning a function for each declared eventHandlers entry. Declare the event in the Cell's eventHandlers, or supply it in the mock provider.`,
        );
      }
      // Called bare, matching the measured `props[eventName](...args)` form: the gather into
      // the keyed object is inside the function the host assigned, so the positional
      // arguments go over exactly as written.
      (firing as (...args: readonly unknown[]) => unknown)(...args);
    },

    cellProp: key => {
      const confirmed = claimCellPropAddress("cellProp", key);
      const provider = requireRuntimeFacadeProvider();
      // Presence, not definedness: #5 pinned the *key*, and both values it names
      // (`Permissions`, `ImageContext`) are values whose emptiness #5 left open,
      // so treating `undefined` as an error would refuse a state the target
      // allows. The caller declared the shape; an absent key cannot be declared
      // away.
      return ownValue(portBinding(provider, "cellProps"), confirmed, confirmed, "base-prop-not-supplied");
    },

    forguncyMember: member => {
      const confirmed = claimForguncyMemberAddress("forguncyMember", member);
      return hostHandleMember(requireRuntimeFacadeProvider(), confirmed);
    },
  };
}

/**
 * The `ServerCommands` record the host injected, or a refusal.
 *
 * Reads the address with the same presence rule the other base props use, so a
 * provider that carries props but no command record is reported as the wiring fault
 * it is rather than as a page that configured no commands — the two are different
 * claims and only one of them is a remediation.
 */
function serverCommandRecord(provider: RuntimeFacadeProvider): Record<string, unknown> {
  const commands = ownValue(
    portBinding(provider, "cellProps"),
    "ServerCommands",
    "ServerCommands",
    "base-prop-not-supplied",
  );
  if (commands === null || typeof commands !== "object") {
    throw missingInjection(
      "base-prop-not-supplied",
      "ServerCommands",
      "the value is not the record of commands the host injects",
    );
  }
  return commands as Record<string, unknown>;
}

/**
 * The `props.Forguncy` handle, or a refusal naming it.
 *
 * Split out because the two member helpers below differ in exactly one thing — what
 * they require of the value they find — and the handle read is not that thing.
 * Duplicating it would let the two drift over the part they agree about.
 */
function forguncyHandle(provider: RuntimeFacadeProvider): Record<string, unknown> {
  const handle = ownValue(
    portBinding(provider, "cellProps"),
    "Forguncy",
    "Forguncy",
    "handle-not-supplied",
  );
  if (handle === null || typeof handle !== "object") {
    throw missingInjection("handle-not-supplied", "Forguncy", "the value is not the handle the host injects");
  }
  return handle as Record<string, unknown>;
}

/**
 * A `props.Forguncy` member #5 only ever saw in the handle's key list.
 *
 * Returns the own value: **bound when it is a function**, and otherwise handed over
 * exactly as it was read. The restraint is the point. These addresses are
 * `member-presence` — #5 recorded `Object.keys(props.Forguncy)` and never called one
 * of them, nor read its `typeof` — so "is a function" is not part of anything the
 * façade observed. Requiring it here would be a contract invented in the
 * implementation, one the registry does not carry, and it would refuse a shape the
 * current evidence plainly allows: a confirmed address holding a non-function value.
 *
 * Binding, where it applies, follows the same observation the call-shaped members
 * follow: #5 only saw the method form (`props.Forguncy.hasPermission(…)`) and never a
 * detached one, so a function goes back bound to its handle rather than raw. A
 * non-function has no receiver to lose, so it is returned untouched — and the caller's
 * declared shape is what decides whether it can be used at all.
 *
 * Every caller names its member from `CELL_FORGUNCY_PROP_KEYS`, so this cannot be
 * asked for an address #5 never saw.
 */
function hostHandleMember(provider: RuntimeFacadeProvider, member: ForguncyPropMember): unknown {
  const handle = forguncyHandle(provider);
  const value = ownValue(handle, member, member, "handle-member-not-supplied");
  return typeof value === "function"
    ? (value as (...args: readonly unknown[]) => unknown).bind(handle)
    : value;
}

/**
 * A *callable* `props.Forguncy` member, bound to the handle that owns it.
 *
 * For the two members #5 actually called — `hasPermission` and `getPermissions`. A
 * `member-presence` address must not come through here: demanding a callable value is
 * a signature, and a signature has to be paid for with `confirmation` (see
 * `hostHandleMember`). Keeping this helper reserved for the call-shaped members is what
 * stops that rule being quietly relaxed by a shared code path — which is exactly how it
 * was relaxed before review.
 *
 * Returns the member **bound** rather than the raw function: #5 confirms the method
 * form (`props.Forguncy.hasPermission(…)`, `props.Forguncy.getPermissions()`) and never
 * that a handle member survives being detached from its object. Handing out
 * `handle[member]` unchanged would call it with `this === undefined`, which is a
 * behaviour nothing observed — the shape of over-claim this package exists to refuse.
 */
function hostHandleMethod(
  provider: RuntimeFacadeProvider,
  member: ForguncyPropMember,
): (...args: readonly unknown[]) => unknown {
  const handle = forguncyHandle(provider);
  const value = ownValue(handle, member, member, "handle-member-not-supplied");
  if (typeof value !== "function") {
    throw refuseAbsence(
      "called-member-not-callable",
      member,
      `props.Forguncy.${member} is not callable, so the ${member} capability was not supplied. Configure it in the designer, or supply it in the mock provider.`,
    );
  }
  return (value as (...args: readonly unknown[]) => unknown).bind(handle);
}

/**
 * Whether an answer is a thenable, i.e. a promise wearing an object.
 *
 * Named rather than inlined because two boundaries have to refuse the same answer, and
 * because `typeof promise === "object"` is precisely the test that lets one through.
 * It is also the wrong answer whose wrongness a declared type cannot reveal: a caller
 * holding what its type says is a value cannot see that it is holding a pending one.
 */
function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/**
 * A refusal's name for the answer that arrived.
 *
 * One vocabulary for both narrowed members, so their refusals read as one rule with
 * several causes rather than as several rules. `null` and an array are named rather
 * than described, because `typeof` calls both of them `"object"` — the two least
 * informative things a message could say about the answers that are wrong for
 * structural reasons.
 *
 * A thenable carries its reason with it, because it is the one cause that needs one:
 * refusing rather than awaiting is a decision, and awaiting here would be the façade
 * choosing an answer #5 did not record. Both permission calls were read
 * synchronously, so a promise is exactly the shape that puts a synchronous host call
 * and the mock on different timings.
 */
function answerShape(value: unknown): string {
  if (isThenable(value)) {
    return 'a thenable — typeof "object", so an object test passes it unchanged, and #5 read this call synchronously';
  }
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a value whose typeof is "${typeof value}"`;
}

/**
 * The permission snapshot, or a refusal naming the answer that arrived.
 *
 * The shape is invented here — `ForguncyPropMember` declares the member as
 * `(...args: unknown[]) => unknown` — so it has to be earned rather than cast into
 * existence. What is earned is exactly what the declared type says, no more: `Partial` in
 * the return type and the loop at the bottom are the same claim, that every *present* own
 * entry holds a boolean, and neither says anything about a key that is absent. That
 * alignment is the point: before `Partial`, the type promised a `boolean` at every string
 * key while this function could only ever verify the present ones.
 *
 * Four shapes reach this function in practice, and each is refused for its own reason
 * rather than one shared "not an object":
 *
 * - **a thenable**: the object test below would pass it through unchanged, and answer a
 *   caller whose declared type is a value with a pending one.
 * - **an array**: `Object.entries` would read its indices as permission names.
 * - **anything that is not a plain record**: a `Map` is the case that matters, because
 *   its entries are invisible to the record read at the bottom, so it would answer
 *   `{}` — an empty permission map. That is the silently empty snapshot #5 reports as
 *   a contract-breaking failure mode rather than as a state to interpret, so refusing
 *   the shape is the only answer that does not invent one.
 * - **a record holding a non-boolean**: `{"Orders.Read": "yes"}` would become a map
 *   that reads `true` in a condition and `false` in a comparison.
 *
 * A record with no prototype is accepted: it is still a plain map of own enumerable
 * keys, which is all #5 recorded.
 */
function permissionMap(value: unknown): Readonly<Partial<Record<string, boolean>>> {
  const refuse = (clause: string): never => {
    throw refuseAbsence(
      "called-member-answered-wrong-shape",
      "getPermissions",
      `props.Forguncy.getPermissions() answered ${clause} rather than the permission map #5 recorded.`,
    );
  };

  if (isThenable(value)) return refuse(answerShape(value));
  if (Array.isArray(value)) return refuse(answerShape(value));
  if (value === null || typeof value !== "object") return refuse(answerShape(value));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return refuse(`${answerShape(value)}, and not a plain record whose own keys are permission names`);
  }
  for (const [permissionName, granted] of Object.entries(value)) {
    if (typeof granted !== "boolean") {
      return refuse(`${answerShape(granted)} for the permission "${permissionName}"`);
    }
  }
  return value as Readonly<Partial<Record<string, boolean>>>;
}

/**
 * The façade, resolved from the installed provider.
 *
 * Fails fast when nothing is installed rather than at the first resolution: the
 * provider is the precondition for the whole surface, not one capability among
 * many, so a Cell that calls a façade member at all is broken without it. A Cell
 * that never calls one is never refused — the check lives here, not in the
 * package's import path.
 *
 * The cast is the typed boundary and happens once, in `surface` below: the
 * members are implemented over the *un-declared* surface (a command name that is
 * `never`, values that are `unknown`), and the declaration is applied by the
 * caller's type argument, where it can say nothing the runtime does not already
 * do. The cast on the line after it is a variance step over the same object —
 * TypeScript will not narrow `Record<never, never>`'s key bound in one
 * assertion — not a second boundary, and there is no second implementation
 * behind either. That matters here rather than being pedantry: the property the
 * two provider kinds depend on is that authorization happens once, in one body,
 * so a host and a mock cannot differ in it.
 */
export function runtimeFacade<
  Commands extends ServerCommandParameterMap = Record<never, never>,
  Properties extends string = never,
  Events extends string = never,
>(): RuntimeFacade<Commands, Properties, Events> {
  requireRuntimeFacadeProvider();
  return surface as unknown as RuntimeFacade<Commands, Properties, Events>;
}

const surface: RuntimeFacade = buildRuntimeFacadeSurface() as unknown as RuntimeFacade;

/** The implementation the accessor hands out, for the audit and for tests. */
export function runtimeFacadeSurface(): RuntimeFacade {
  return surface;
}

// ---------------------------------------------------------------------------
// Address claims
// ---------------------------------------------------------------------------

/**
 * Refuse an address the façade does not expose, distinguishing the two causes.
 *
 * Two errors rather than one, because the fixes are different: a name #5 never
 * observed is a typo or a fabricated API, while a confirmed name reached through
 * the wrong member is a call the author can correct — and the second one has a
 * better member to point at, which is what makes the message worth reading.
 */
function claimCellPropAddress(accessor: RuntimeFacadeSurfaceMemberId, key: string): ExposedCellPropKey {
  if (!(CELL_PROPS_BASE_KEYS as readonly string[]).includes(key)) {
    throw refuseAbsence(
      "base-prop-not-confirmed",
      key,
      `"${key}" is not a base prop #5 verified on a ReactCellType Cell, so the façade has no address for it: ${CELL_PROPS_BASE_KEYS.join(", ")} are the ones it observed.`,
    );
  }
  if (!(RUNTIME_FACADE_CELL_PROP_ADDRESSES as readonly string[]).includes(key)) {
    throw refuseAbsence(
      "base-prop-not-exposed",
      key,
      `"${key}" is a confirmed base prop but "${accessor}" is not the member that exposes it — an address reached through two members is a second way for the façade to be wrong. Use the member the capability registry names for it.`,
    );
  }
  return key as ExposedCellPropKey;
}

function claimForguncyMemberAddress(
  accessor: RuntimeFacadeSurfaceMemberId,
  member: string,
): ExposedForguncyMember {
  if (!(CELL_FORGUNCY_PROP_KEYS as readonly string[]).includes(member)) {
    throw refuseAbsence(
      "handle-member-not-confirmed",
      member,
      `"${member}" is not a member of props.Forguncy that #5 verified, so the façade has no address for it.`,
    );
  }
  if (!(RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES as readonly string[]).includes(member)) {
    throw refuseAbsence(
      "handle-member-not-exposed",
      member,
      `"${member}" is a confirmed handle member but "${accessor}" is not the member that exposes it: ${handleAddressOwner(member)}`,
    );
  }
  return member as ExposedForguncyMember;
}

/**
 * Where an omitted handle address *is* reachable, said in the words of the cause.
 *
 * `RUNTIME_FACADE_FORGUNCY_MEMBER_ADDRESSES` leaves five of #5's fourteen out for
 * three different reasons, and the clause after the colon is the part a reader
 * acts on — so it names the member rather than restating the refusal. Saying only
 * "that is not the member that exposes it" is what sends an author to the *other*
 * wrong accessor, which is the same mistake one step later.
 *
 * The shared phrase is what keeps the three one error class: each is a confirmed
 * address reached through the wrong member, and the fix is the same shape in all
 * three cases — name the member the registry names for it.
 */
/**
 * The handle members whose owning surface member is not spelled the same way.
 *
 * Two kinds of rename, each with its own reason: the three conversions drop the PascalCase
 * the host uses because façade member ids are camelCase by convention (the conversion names
 * are verbs, and the host's capitalization is a CLR-ism rather than part of the measured
 * contract — what #176 measured is the call shape, which the member keeps exactly); and
 * `Permissions` is not a method at all but the snapshot whose other, measured address is the
 * base prop. Data rather than branches so the derivation test can compare this table against
 * the surface members directly: a conversion renamed away from its host spelling is a
 * deliberate act, not a drift.
 */
const HANDLE_ADDRESS_TYPED_OWNERS: Readonly<Record<string, { readonly member: string; readonly basis: string }>> = {
  ConvertDateToOADate: { member: "convertDateToOADate", basis: "#176 measured props.Forguncy.ConvertDateToOADate()" },
  ConvertOADateToDate: { member: "convertOADateToDate", basis: "#176 measured props.Forguncy.ConvertOADateToDate()" },
  ConvertToCssColor: { member: "convertToCssColor", basis: "#176 measured props.Forguncy.ConvertToCssColor()" },
  Permissions: { member: "permissionSnapshot", basis: "#176 measured it as identity-equal to the base prop the snapshot lives at" },
};

function handleAddressOwner(member: string): string {
  if ((RUNTIME_FACADE_SURFACE_MEMBER_IDS as readonly string[]).includes(member)) {
    return `#5 executed props.Forguncy.${member}(), so the façade calls it under the host's own name as runtimeFacade().${member}(), and a second address is a second way for the façade to be wrong.`;
  }
  const renamed = HANDLE_ADDRESS_TYPED_OWNERS[member];
  if (renamed !== undefined) {
    return `${renamed.basis}, so the façade exposes it as runtimeFacade().${renamed.member}(), and a second address is a second way for the façade to be wrong.`;
  }
  if ((RUNTIME_FACADE_CELL_PROP_ADDRESSES as readonly string[]).includes(member)) {
    return `it is the base prop "${member}", so cellProp("${member}") is the member that exposes it, and a second address is a second way for the façade to be wrong.`;
  }
  return `it is a wrapper-local the Cell scope declares for itself, so Cell source names ${member} directly and props.Forguncy is not its address.`;
}

// ---------------------------------------------------------------------------
// Reading through the provider
// ---------------------------------------------------------------------------

/**
 * One port member, read defensively.
 *
 * Defensively because a provider can arrive from JavaScript that never saw
 * `RuntimeFacadeHostBindings` — the same reason the registry guards run at
 * runtime as well as at compile time in `capabilities.ts`.
 */
function portBinding(
  provider: RuntimeFacadeProvider,
  member: keyof RuntimeFacadeHostBindings,
): unknown {
  const bindings = (provider as unknown as { readonly bindings?: Record<string, unknown> }).bindings;
  if (bindings === null || typeof bindings !== "object") {
    throw missingInjection(
      "provider-carries-no-bindings",
      String(member),
      "the provider carries no bindings at all",
    );
  }
  return bindings[member];
}

/**
 * An own property, or a refusal naming the address.
 *
 * `Object.hasOwn` rather than a truthiness test, because "the provider never
 * declared this address" is a wiring fault and "the provider declared it as
 * `undefined`" is not the same statement: #5 pins the *keys* the runtime
 * injects, so a missing key is the target's own contract being violated.
 */
function ownValue(
  record: unknown,
  key: string,
  address: string,
  path: RuntimeFacadeInjectionPathId,
): unknown {
  if (record === null || typeof record !== "object" || !Object.hasOwn(record, key)) {
    throw missingInjection(path, address, `the provider does not carry "${key}"`);
  }
  return (record as Record<string, unknown>)[key];
}

/**
 * The paths an *injected* address can fail on — the addresses the runtime supplies
 * on every Cell, whatever the page says.
 *
 * Extracted from the path union rather than written out, so it cannot fall behind
 * the table, and so `missingInjection` below can be handed only paths whose
 * remediation is "build the provider from the Cell's own props". An address a *page*
 * was supposed to supply — a server command name — is not one of these, which is the
 * distinction that a helper named `missingBinding` with one hard-coded code used to
 * erase.
 */
type RuntimeFacadeInjectionPathId = Extract<
  RuntimeFacadeRefusalPathId,
  | "provider-carries-no-bindings"
  | "base-prop-not-supplied"
  | "handle-not-supplied"
  | "handle-member-not-supplied"
  | "data-source-hook-not-supplied"
>;

/**
 * A refusal for an address the runtime was supposed to inject and did not.
 *
 * Takes a path, so the code and the family come from the table, and its parameter
 * type admits only the injected addresses. Both are deliberate: this helper has
 * already been borrowed once for a failure that was neither — a declared command that
 * was not callable — and the borrowing was invisible because the helper chose the
 * code itself and the family was written down elsewhere.
 */
function missingInjection(
  path: RuntimeFacadeInjectionPathId,
  address: string,
  detail: string,
): RuntimeFacadeResolutionError {
  return refuseAbsence(
    path,
    address,
    `The installed provider does not supply "${address}": ${detail}. A base prop, the handle, a handle member and the useDataSource hook are all injected by the ReactCellType runtime on every Cell, so this is a wiring fault — build the provider from the Cell's own props, or from a mock that fills them.`,
  );
}


// ---------------------------------------------------------------------------
// The entry's remaining runtime exports
// ---------------------------------------------------------------------------

// The provider a generated binding builds from the Cell's own values (#82), and the slot
// operations a harness calls. Re-exported rather than implemented here: `provider.ts` owns
// the slot and `host-provider.ts` owns the host shape, and the root entry re-exports the same
// bindings through `facade.ts`, so this module adds no second definition.
export { createHostRuntimeFacadeProvider, RUNTIME_FACADE_HOST_BINDING_CHANNELS } from "./host-provider.ts";
export type { HostRuntimeFacadeProviderInput } from "./host-provider.ts";
export { getHostGlobal } from "./host-globals.ts";
export {
  installRuntimeFacadeProvider,
  RUNTIME_FACADE_RESOLUTION_ERROR_CODES,
  RuntimeFacadeResolutionError,
  runtimeFacadeProviderState,
  uninstallRuntimeFacadeProvider,
} from "./provider.ts";
export type { RuntimeFacadeProviderState, RuntimeFacadeResolutionErrorCode } from "./provider.ts";
