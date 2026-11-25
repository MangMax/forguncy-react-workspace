/**
 * The per-Cell host-binding declaration — which of the seven `cellTypeProps`
 * binding fields the repository takes over — and its one normalization.
 *
 * Decision sources: GitHub Issues
 * - #178 — "Implement: forguncy.config.ts 声明式宿主绑定与校验"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/178), this module's ticket,
 *   Ticket 3 of Epic #175 — "仓库唯一事实源 — Cell 宿主绑定声明接管 + 漂移检测与一键还原"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/175),
 * - #26 — "Spec: project configuration and React Cell target declarations"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/26), the config contract
 *   this block extends, downstream of
 * - #4 — "application ownership boundaries and dependency strategy semantics"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/4): these seven fields are
 *   Forguncy-owned state *about* the Cell — the repository claims authorship of their
 *   content, never of their ownership.
 *
 * ## The core semantic: declared means managed
 *
 * The Epic's rule is that whichever binding fields a Cell declares in
 * `forguncy.config.ts`, the repository is authoritative for — writing, drift detection
 * and restore are #179's deploy-time verbs over exactly the declared set. A field the
 * config does not mention is **pass-through**: the sync leaves it untouched, and an
 * existing project that manages bindings in the designer keeps working unchanged. So
 * the declaration distinguishes three states per field, and they are distinct values
 * rather than shades of one:
 *
 * | state | spelling | meaning |
 * | --- | --- | --- |
 * | pass-through | the key is absent | the repository says nothing; the designer's content is preserved |
 * | managed-empty | the key is present with an empty value (`[]` for the five array fields, `{}` for `uploadLimit`) | the repository is authoritative, and the truth is *empty* — drift restore clears the field |
 * | managed | the key is present with content | the repository is authoritative for exactly this content |
 *
 * `libraries` is the one field with no empty spelling, because it needs none: it is a
 * scalar preset list whose empty *content* already has a name — `"None"` is the
 * no-libraries preset (`CELL_PRESET_LIBRARIES`), so `libraries: "None"` **is** the
 * managed-empty declaration. `""` is refused rather than read as one, because the
 * platform never round-trips an empty string here and a spelling the platform cannot
 * produce is a declaration drift detection cannot compare.
 *
 * `undefined` cannot mean "managed-empty" for the same reason #85's
 * `ExtensionMappingsConfig` cannot express "declared, and empty" as an array presence:
 * in JavaScript, omission and `undefined` are indistinguishable at a boundary the
 * loader does not control (a `.mjs` config, a hand-edited one), so the object shell is
 * the state carrier. `bindings: {}` is therefore a legal, meaningful document — "this
 * Cell takes over nothing" — and an absent `bindings` is the backward-compatible
 * default every pre-#178 config already has.
 *
 * ## The write schema is measured fact
 *
 * `CELL_TYPE_PROPS_WRITE_SCHEMA` in `runtime-contract.ts` is what `setCells` accepts
 * and `getCells` returns, probed on `12.0.102.0` (#176). This module enforces it as
 * the contract reads:
 *
 * - **round-tripped keys allowed**: a `properties` entry carrying a dropped key
 *   (`displayName`, `propertyType`, …) is refused by name, because the platform would
 *   silently discard it on write — a declaration that cannot round-trip is a fact
 *   source that lies about what the cell holds. Unknown keys are refused rather than
 *   merely dropped for the same reason: a typo'd `propertyname` passing as dead weight
 *   would read as declared.
 * - **input keys are camelCase**: Json.NET accepts PascalCase too but always outputs
 *   camelCase, so a `PropertyName` input is refused as an unknown key rather than
 *   normalized — normalization would write a document that is not the one the project
 *   reviewed, and the camelCase input round-trips byte-identically, which is the form
 *   #179's drift comparison reads back.
 * - **`eventHandlers` declares the contract, never the command body**: an entry's
 *   `eventHandler` key is refused outright. The command tree is the designer's own
 *   work — #179 preserves it on sync (`CELL_TYPE_PROPS_WRITE_SCHEMA.eventHandlers.eventHandlerShape`)
 *   — so a repository that could declare it here would be authoring Forguncy-owned
 *   content, the ownership inversion #4 exists to prevent. What the repository owns is
 *   the event's name and its argument contract, because those are what the cell's
 *   source code fires against.
 * - **`availableServerCommands` warns rather than assumes**: the schema records
 *   `existenceValidation: "none"` — the platform persists a command name no server
 *   command defines, and calling it at runtime is a plain TypeError — so nothing
 *   downstream will catch a typo. `validateCellBindings` flags suspicious entries
 *   with a non-blocking warning *beside* the blocking diagnostics, precisely because
 *   the designer will not. Whether a named command genuinely exists is a fact about
 *   the target project, so it is #179's connected-sync check, not this module's —
 *   see "what this module deliberately does not decide" below.
 *
 * ## Alignment with #177's facade
 *
 * `RuntimeFacade<Commands, Properties, Events>` types `cellProperty(name)` against
 * `Properties` and `fireEvent(name)` against `Events` — both `never` by default, so an
 * undeclared property or event is un-callable. The `properties` and `eventHandlers`
 * blocks here are **the same declaration** those generics read, written once:
 *
 * ```ts
 * bindings: {
 *   properties: [
 *     { propertyName: "title", propertyValue: "=\"总览\"", exampleValue: "订单总览" },
 *   ],
 *   eventHandlers: [
 *     { eventName: "onSelect", eventArgs: [{ name: "rowId" }] },
 *   ],
 * }
 * ```
 *
 * `propertyName` is the `Properties` member, `propertyValue` the formula the host
 * evaluates (`exampleValue` is what `vp dev` and the designer's unbound preview show),
 * `eventName` the `Events` member and `eventArgs[].name` the keys the host's gather
 * fills from the positional arguments `fireEvent` receives. Type generation is not
 * implemented here — but the shape is deliberately declarable-once: the names are
 * string literals, the arg contract is a name list, and nothing else in the shape is
 * project-specific, so a `typeof config` projection can feed the facade's parameters
 * without a parallel hand-written copy. That is the drift the Epic's "仓库唯一事实源"
 * exists to remove: one declaration drives the deploy-time binding *and* the typed
 * surface the cell's source compiles against.
 *
 * ## What this module deliberately does not decide
 *
 * It does not verify that a table, column, permission, command or library exists in
 * the target project — a config file cannot know, and claiming otherwise would be the
 * compatibility claim AGENTS.md rule 6 forbids. It does not merge, diff or restore
 * anything: those are #179's deploy-time verbs. It does not touch `code` or
 * `frontendLibraries`: the artifact owns the first and the dependency lock the second,
 * which is why `bindings` has exactly seven fields and not nine. And it does not
 * interpret `eventArgs` beyond names — the measured schema round-trips `{ name }` and
 * nothing more, so a richer argument type would be inventing platform behaviour.
 */

import { CELL_TYPE_PROPS_WRITE_SCHEMA } from "./runtime-contract.ts";

// ---------------------------------------------------------------------------
// The input shape (what `forguncy-config.ts` re-exports for `CellConfig`)
// ---------------------------------------------------------------------------

/**
 * A name usable as a JavaScript property key and, for events, as a member access.
 *
 * Enforced rather than documented because the name becomes a *syntactic* address:
 * #176 measured the runtime assigning `props[eventName]`, the cell fires it as
 * `props.onSelect(...)`, and #177's `fireEvent(eventName)`/`cellProperty(propertyName)`
 * are typed against the literal. A name with a space or a leading digit is a runtime
 * key the authored source cannot reference ergonomically — and, for the facade's
 * generics, cannot write as a member access at all.
 */
export const BINDING_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** One declared cell property: the name, the formula the host evaluates, and the example value. */
export interface CellPropertyBindingConfig {
  /** The prop's name — the `Properties` member of #177's facade generics. */
  readonly propertyName: string;
  /**
   * The formula the host evaluates, e.g. `=\"订单明细\"!B2` — or omitted for a
   * property the designer leaves unbound, which round-trips with the key absent.
   */
  readonly propertyValue?: string;
  /** What the cell sees in `vp dev` and in the designer's unbound preview. */
  readonly exampleValue?: string;
}

/** One event argument: a name, and nothing more — that is all the platform round-trips. */
export interface CellEventArgConfig {
  readonly name: string;
}

/**
 * One declared event: the contract the cell fires against.
 *
 * **There is deliberately no `eventHandler` field** — see the module header. The type
 * does not carry it even optionally, so `defineForguncyConfig`'s excess-property check
 * flags it in a typed config and the validator refuses it in a raw one.
 */
export interface CellEventHandlerBindingConfig {
  /** The event's name — the `Events` member of #177's facade generics. */
  readonly eventName: string;
  /** The positional-argument contract: `fireEvent(name, a, b)` is gathered into `{ [args[0].name]: a, [args[1].name]: b }`. */
  readonly eventArgs?: readonly CellEventArgConfig[];
}

/** One bound column of a data-source table. */
export interface CellDataSourceBindingInfoConfig {
  readonly tableName: string;
  readonly columnName: string;
}

/**
 * One declared data source, in the measured `{ tableName, bindingInfos }` shape.
 *
 * The shape is nested rather than flattened because that is what the platform
 * round-trips: `dataSource.bindingInfos` is the unit the schema's
 * `missingBindingInfosOutcome` judges, and a flattened declaration would be a second
 * spelling of a structure the deploy side must produce verbatim.
 */
export interface CellDataSourceBindingConfig {
  /** The name `useDataSource(name)` reads — the hook's lookup key. */
  readonly dataSourceName: string;
  readonly dataSource: {
    readonly tableName: string;
    readonly bindingInfos: readonly {
      readonly bindingInfo: CellDataSourceBindingInfoConfig;
      readonly columnName: string;
    }[];
    /** Passed through verbatim; the schema round-trips it as part of `dataSource`. */
    readonly formulaNullQueryPolicy?: unknown;
  };
}

/** One declared permission the cell can check. */
export interface CellPermissionBindingConfig {
  readonly name: string;
  /** The roles granted it; omitted declares the permission without a grant list. */
  readonly allowRoles?: readonly string[];
}

/** One server command made available to the cell. Nothing but the name round-trips. */
export interface CellAvailableServerCommandBindingConfig {
  readonly name: string;
}

/** The upload ceiling the host enforces. `0` means unlimited on both numeric fields. */
export interface CellUploadLimitBindingConfig {
  /** Comma-separated extensions, e.g. `".jpg, .png"`. */
  readonly extensionFilter?: string;
  /** Megabytes per file. */
  readonly sizeLimit?: number;
  /** Files per upload call. */
  readonly maxUploadFileCount?: number;
}

/**
 * The seven binding fields a Cell may declare itself authoritative for.
 *
 * Every field is optional, and presence is the semantics — see the module header's
 * three-state table. `libraries` is the one string-valued field, because the
 * platform's round-trip form is the comma-separated preset list (`"AntDesign"`,
 * `"AntDesign, ECharts"`, `"None"`).
 */
export interface CellBindingsConfig {
  readonly dataSources?: readonly CellDataSourceBindingConfig[];
  readonly permissions?: readonly CellPermissionBindingConfig[];
  readonly availableServerCommands?: readonly CellAvailableServerCommandBindingConfig[];
  readonly properties?: readonly CellPropertyBindingConfig[];
  readonly eventHandlers?: readonly CellEventHandlerBindingConfig[];
  readonly uploadLimit?: CellUploadLimitBindingConfig;
  readonly libraries?: string;
}

/** Fields allowed inside a `bindings` block, in schema order. Used verbatim in diagnostics. */
export const BINDINGS_ALLOWED_FIELDS = [
  "dataSources",
  "permissions",
  "availableServerCommands",
  "properties",
  "eventHandlers",
  "uploadLimit",
  "libraries",
] as const;

/** The seven declarable binding field names. */
export type CellBindingFieldName = (typeof BINDINGS_ALLOWED_FIELDS)[number];

// ---------------------------------------------------------------------------
// The normalized shape (what the registry, the build and #179 read)
// ---------------------------------------------------------------------------

/**
 * Which state one field is in, for one Cell.
 *
 * Derived rather than stored — a field's state is a function of its key's presence,
 * so carrying it as data would be a second copy that can drift. Exported because it
 * is exactly what #179's plan reads to decide "write, clear, or leave alone".
 */
export type CellBindingFieldState = "managed" | "managed-empty" | "pass-through";

/** One data-source entry, validated and frozen. */
export interface NormalizedCellDataSourceBinding {
  readonly dataSourceName: string;
  readonly dataSource: {
    readonly tableName: string;
    readonly bindingInfos: readonly {
      readonly bindingInfo: CellDataSourceBindingInfoConfig;
      readonly columnName: string;
    }[];
    readonly formulaNullQueryPolicy?: unknown;
  };
}

export interface NormalizedCellPropertyBinding {
  readonly propertyName: string;
  readonly propertyValue?: string;
  readonly exampleValue?: string;
}

export interface NormalizedCellEventHandlerBinding {
  readonly eventName: string;
  readonly eventArgs: readonly { readonly name: string }[];
}

export interface NormalizedCellPermissionBinding {
  readonly name: string;
  readonly allowRoles?: readonly string[];
}

export interface NormalizedCellUploadLimitBinding {
  readonly extensionFilter?: string;
  readonly sizeLimit?: number;
  readonly maxUploadFileCount?: number;
}

/**
 * One Cell's declared bindings, validated.
 *
 * **Every field key that the project declared is present on this object** — including
 * the empty ones, because a managed-empty declaration must survive all the way to the
 * build manifest: dropping `properties: []` here would read as pass-through at the
 * deploy side, which is the one confusion the whole three-state model exists to
 * prevent. `declaredFields` is the manifest-ready answer to "which fields does the
 * repository own for this Cell", in schema order, so a report does not re-derive it
 * by key-sniffing.
 *
 * Frozen, for the reason `NormalizedExtensionMappings` is: the registry hands this
 * object to the build, the plan and the sync, and a mutable shared declaration is a
 * second source of truth.
 */
export interface NormalizedCellBindings {
  readonly declaredFields: readonly CellBindingFieldName[];
  readonly dataSources?: readonly NormalizedCellDataSourceBinding[];
  readonly permissions?: readonly NormalizedCellPermissionBinding[];
  readonly availableServerCommands?: readonly { readonly name: string }[];
  readonly properties?: readonly NormalizedCellPropertyBinding[];
  readonly eventHandlers?: readonly NormalizedCellEventHandlerBinding[];
  readonly uploadLimit?: NormalizedCellUploadLimitBinding;
  readonly libraries?: string;
}

/**
 * The state one field is in, read off a normalized declaration.
 *
 * Presence of the key — not the content's truthiness — is the whole answer, so a
 * declared `properties: []` is `managed-empty` while an absent key is `pass-through`.
 */
export function cellBindingFieldState(
  bindings: NormalizedCellBindings | undefined,
  field: CellBindingFieldName,
): CellBindingFieldState {
  if (bindings === undefined || !(field in bindings)) {
    return "pass-through";
  }
  const value = bindings[field];
  const empty =
    (Array.isArray(value) && value.length === 0) ||
    (field === "uploadLimit" && value !== undefined && Object.keys(value).length === 0) ||
    // `"None"` is the no-libraries preset — the scalar's empty content, not an empty spelling.
    (field === "libraries" && value === "None");
  return empty ? "managed-empty" : "managed";
}

/**
 * The per-field states of a normalized declaration, in schema order — the manifest's
 * per-Cell answer to "declared vs undeclared", as data a consumer does not re-derive.
 */
export function cellBindingFieldStates(
  bindings: NormalizedCellBindings | undefined,
): Readonly<Record<CellBindingFieldName, CellBindingFieldState>> {
  const states = {} as Record<CellBindingFieldName, CellBindingFieldState>;
  for (const field of BINDINGS_ALLOWED_FIELDS) {
    states[field] = cellBindingFieldState(bindings, field);
  }
  return states;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * The codes this module reports. Members of the config vocabulary `cell-registry` carries,
 * for the reason `extension-mappings-config` records: one error type, one `codes` accessor,
 * and a project with a bad binding plus a bad entry pays one round trip.
 */
export type BindingsDiagnosticCode =
  | "invalid-bindings"
  | "unknown-bindings-field"
  | "invalid-binding-value"
  | "unknown-binding-key"
  | "duplicate-binding-name";

/**
 * One actionable problem, located at the config path that produced it.
 *
 * Structurally `cell-registry`'s `ConfigDiagnostic` — `code`/`path`/`message` — so the
 * registry passes these through without translating them. Declared here rather than
 * imported because that module calls this one: a runtime import back would be a cycle.
 */
export interface BindingsConfigDiagnostic {
  readonly code: BindingsDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

/**
 * A non-blocking observation about a declaration that validates but is suspicious.
 *
 * Kept strictly separate from the diagnostics: a warning never fails the config,
 * because the platform's own schema says the check cannot be conclusive —
 * `availableServerCommands` has `existenceValidation: "none"`, so whether a command
 * name exists is a fact about the target project a config file cannot know. What a
 * warning *can* catch is the entry that is wrong on its face, and it is carried on the
 * normalized result rather than logged, because a CLI, a build report and a test all
 * need to read it — stderr is where warnings go to be ignored.
 */
export interface BindingsConfigWarning {
  readonly code: "suspicious-server-command-name";
  readonly path: string;
  readonly message: string;
}

export type NormalizeCellBindingsResult =
  | {
      readonly ok: true;
      /** `undefined` when the Cell declares no `bindings` key at all — the pass-through default. */
      readonly bindings: NormalizedCellBindings | undefined;
      readonly warnings: readonly BindingsConfigWarning[];
    }
  | { readonly ok: false; readonly diagnostics: readonly BindingsConfigDiagnostic[] };

function diag(code: BindingsDiagnosticCode, path: string, message: string): BindingsConfigDiagnostic {
  return { code, path, message };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The dropped-keys a field's elements may not carry, read off the measured schema. */
function droppedKeysOf(field: CellBindingFieldName): readonly string[] {
  const record = CELL_TYPE_PROPS_WRITE_SCHEMA[field] as { readonly droppedKeys?: readonly string[] };
  return record.droppedKeys ?? [];
}

/**
 * The round-tripped keys a field's elements may carry, plus `eventArgs`'s own key list.
 *
 * Read off `CELL_TYPE_PROPS_WRITE_SCHEMA` rather than restated: the schema is the
 * measured fact (#176), and a hand-written copy here is exactly the table that drifts.
 */
function roundTrippedKeysOf(field: CellBindingFieldName): readonly string[] {
  const record = CELL_TYPE_PROPS_WRITE_SCHEMA[field] as { readonly roundTrippedKeys?: readonly string[] };
  return record.roundTrippedKeys ?? [];
}

/** The wire key of the one forbidden member: the designer's command tree. */
const EVENT_HANDLER_BODY_KEY = "eventHandler" as const;

/**
 * Validates a name-bearing entry's key set against the measured round-trip schema.
 *
 * The one helper for every object element in the block, because the rule is the same
 * everywhere: a key the platform round-trips is fine (validated for type elsewhere),
 * a key the platform *drops* is refused by name with the evidence cited, and any
 * other key is a typo the schema would carry as dead weight.
 */
function checkElementKeys(
  raw: Record<string, unknown>,
  options: {
    readonly field: CellBindingFieldName;
    readonly extraAllowed?: readonly string[];
    readonly forbidden?: readonly string[];
  },
  path: string,
  out: BindingsConfigDiagnostic[],
): void {
  const allowed = new Set([...roundTrippedKeysOf(options.field), ...(options.extraAllowed ?? [])]);
  const dropped = droppedKeysOf(options.field);
  for (const key of Object.keys(raw)) {
    if ((options.forbidden ?? []).includes(key)) {
      out.push(
        diag(
          "invalid-binding-value",
          `${path}.${key}`,
          `"${key}" must not be declared here: the event's command tree is the designer's own work, which #179 preserves on sync — the repository declares the event name and argument contract only. Authoring the command body in config would make the repository the source of Forguncy-owned content, which #4's ownership boundary forbids. Measured: \`eventHandler\` round-trips verbatim under the designer's control (${CELL_TYPE_PROPS_WRITE_SCHEMA.eventHandlers.eventHandlerShape.split(".")[0]}).`,
        ),
      );
      continue;
    }
    if (allowed.has(key)) {
      continue;
    }
    if (dropped.includes(key)) {
      out.push(
        diag(
          "unknown-binding-key",
          `${path}.${key}`,
          `"${key}" is dropped by the platform on write — the measured \`cellTypeProps\` schema round-trips only ${roundTrippedKeysOf(options.field).join("/")} for ${options.field} and discards ${dropped.join("/")} (#176). A declaration that cannot round-trip would read as authoritative while the cell silently loses it, so it is refused rather than carried. Remove the key; none of its values reach the cell.`,
        ),
      );
    } else {
      out.push(
        diag(
          "unknown-binding-key",
          `${path}.${key}`,
          `Unknown key "${key}" on a ${options.field} entry. The platform round-trips exactly ${roundTrippedKeysOf(options.field).join("/")}${options.extraAllowed?.length ? ` plus ${options.extraAllowed.join("/")}` : ""}; input keys are camelCase because Json.NET always outputs camelCase and the byte-identical form is what drift detection reads back. Check the spelling.`,
        ),
      );
    }
  }
}

/** One element of a name-keyed array field, or a diagnostic. */
function readNamedEntry(
  raw: unknown,
  field: CellBindingFieldName,
  path: string,
  out: BindingsConfigDiagnostic[],
): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    out.push(
      diag(
        "invalid-binding-value",
        path,
        `A ${field} entry must be an object. Non-object entries fail the whole write on the platform itself (${CELL_TYPE_PROPS_WRITE_SCHEMA[field as "properties"].elementNonObjectError ?? "the deserializer rejects them"}), so they are refused here first.`,
      ),
    );
    return undefined;
  }
  return raw as Record<string, unknown>;
}

/** Reports duplicates in a name-keyed list, because a later entry silently shadowing an earlier one is a lie about what the cell holds. */
function checkDuplicateNames(
  names: readonly string[],
  what: string,
  path: string,
  out: BindingsConfigDiagnostic[],
): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  for (const name of duplicates) {
    out.push(
      diag(
        "duplicate-binding-name",
        path,
        `"${name}" is declared more than once in ${what}. A duplicate is never a meaningful declaration — one of the entries is dead or shadowed — so it is refused rather than resolved by order.`,
      ),
    );
  }
}

function validateBindingName(name: unknown, label: string, path: string, out: BindingsConfigDiagnostic[]): name is string {
  if (!isNonEmptyString(name)) {
    out.push(diag("invalid-binding-value", path, `${label} must be a non-empty string.`));
    return false;
  }
  if (!BINDING_NAME_PATTERN.test(name)) {
    out.push(
      diag(
        "invalid-binding-value",
        path,
        `${label} "${name}" is not a usable JavaScript identifier. It becomes a props key the cell's source references and a literal in the facade's type parameters (\`cellProperty\`/\`fireEvent\`, #177), so it must match ${BINDING_NAME_PATTERN}.`,
      ),
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-field validators
// ---------------------------------------------------------------------------

function validateProperties(
  raw: unknown,
  path: string,
  out: BindingsConfigDiagnostic[],
): readonly NormalizedCellPropertyBinding[] | undefined {
  if (!Array.isArray(raw)) {
    out.push(diag("invalid-binding-value", path, `"properties" must be an array (possibly empty — an empty array is the managed-empty declaration).`));
    return undefined;
  }
  const entries: NormalizedCellPropertyBinding[] = [];
  const names: string[] = [];
  for (const [index, element] of raw.entries()) {
    const elementPath = `${path}[${index}]`;
    const record = readNamedEntry(element, "properties", elementPath, out);
    if (record === undefined) continue;
    checkElementKeys(record, { field: "properties" }, elementPath, out);
    const name = record.propertyName;
    // Checked *before* the name's validity, so a duplicate is reported even when the offending
    // entry has other problems — a config with two mistakes costs one round trip, not two.
    if (typeof name === "string") names.push(name);
    if (!validateBindingName(name, "A property's `propertyName`", `${elementPath}.propertyName`, out)) continue;
    const badValueKeys = (["propertyValue", "exampleValue"] as const).filter(
      key => record[key] !== undefined && typeof record[key] !== "string",
    );
    for (const key of badValueKeys) {
      out.push(diag("invalid-binding-value", `${elementPath}.${key}`, `\`${key}\` must be a string when present — it round-trips as one or is absent.`));
    }
    if (badValueKeys.length > 0) continue;
    entries.push({
      propertyName: name,
      ...(typeof record.propertyValue === "string" ? { propertyValue: record.propertyValue } : {}),
      ...(typeof record.exampleValue === "string" ? { exampleValue: record.exampleValue } : {}),
    });
  }
  checkDuplicateNames(names, "properties", path, out);
  return entries;
}

function validateEventHandlers(
  raw: unknown,
  path: string,
  out: BindingsConfigDiagnostic[],
): readonly NormalizedCellEventHandlerBinding[] | undefined {
  if (!Array.isArray(raw)) {
    out.push(diag("invalid-binding-value", path, `"eventHandlers" must be an array (possibly empty — an empty array is the managed-empty declaration).`));
    return undefined;
  }
  const entries: NormalizedCellEventHandlerBinding[] = [];
  const names: string[] = [];
  for (const [index, element] of raw.entries()) {
    const elementPath = `${path}[${index}]`;
    const record = readNamedEntry(element, "eventHandlers", elementPath, out);
    if (record === undefined) continue;
    // `eventHandler` is forbidden outright — the one key this validator refuses even though the
    // platform round-trips it, because what it carries is the designer's. See the module header.
    checkElementKeys(record, { field: "eventHandlers", forbidden: [EVENT_HANDLER_BODY_KEY] }, elementPath, out);
    const name = record.eventName;
    if (typeof name === "string") names.push(name);
    if (!validateBindingName(name, "An event's `eventName`", `${elementPath}.eventName`, out)) continue;

    const args: { readonly name: string }[] = [];
    const argNames: string[] = [];
    let argsValid = true;
    if (record.eventArgs !== undefined) {
      if (!Array.isArray(record.eventArgs)) {
        out.push(diag("invalid-binding-value", `${elementPath}.eventArgs`, `"eventArgs" must be an array of \`{ name }\` entries — the measured schema round-trips nothing else about an argument.`));
        argsValid = false;
      } else {
        for (const [argIndex, arg] of record.eventArgs.entries()) {
          const argPath = `${elementPath}.eventArgs[${argIndex}]`;
          if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
            out.push(diag("invalid-binding-value", argPath, `An event argument must be an object with a \`name\`.`));
            argsValid = false;
            continue;
          }
          const argRecord = arg as Record<string, unknown>;
          for (const key of Object.keys(argRecord)) {
            if (key !== "name") {
              out.push(
                diag(
                  "unknown-binding-key",
                  `${argPath}.${key}`,
                  `Unknown key "${key}" on an event argument. The measured schema round-trips exactly \`{ name }\` for \`eventArgs\` entries — nothing else reaches the cell, so nothing else may be declared.`,
                ),
              );
              argsValid = false;
            }
          }
          if (typeof argRecord.name === "string") argNames.push(argRecord.name);
          if (!validateBindingName(argRecord.name, "An event argument's `name`", `${argPath}.name`, out)) {
            argsValid = false;
            continue;
          }
          args.push({ name: argRecord.name });
        }
      }
    }
    checkDuplicateNames(argNames, `${elementPath}.eventArgs`, `${elementPath}.eventArgs`, out);
    if (!argsValid) continue;
    entries.push({ eventName: name, eventArgs: args });
  }
  checkDuplicateNames(names, "eventHandlers", path, out);
  return entries;
}

function validateDataSources(
  raw: unknown,
  path: string,
  out: BindingsConfigDiagnostic[],
): readonly NormalizedCellDataSourceBinding[] | undefined {
  if (!Array.isArray(raw)) {
    out.push(diag("invalid-binding-value", path, `"dataSources" must be an array (possibly empty — an empty array is the managed-empty declaration).`));
    return undefined;
  }
  const entries: NormalizedCellDataSourceBinding[] = [];
  const names: string[] = [];
  for (const [index, element] of raw.entries()) {
    const elementPath = `${path}[${index}]`;
    const record = readNamedEntry(element, "dataSources", elementPath, out);
    if (record === undefined) continue;
    checkElementKeys(record, { field: "dataSources" }, elementPath, out);

    const name = record.dataSourceName;
    if (typeof name === "string") names.push(name);
    if (!validateBindingName(name, "A data source's `dataSourceName`", `${elementPath}.dataSourceName`, out)) continue;

    const dataSource = record.dataSource;
    if (typeof dataSource !== "object" || dataSource === null || Array.isArray(dataSource)) {
      out.push(
        diag(
          "invalid-binding-value",
          `${elementPath}.dataSource`,
          `\`dataSource\` must be the measured \`{ tableName, bindingInfos: [...] }\` object — an entry without the full shape round-trips as \`null\` and is silently omitted on the platform (${CELL_TYPE_PROPS_WRITE_SCHEMA.dataSources.missingBindingInfosOutcome}), so a malformed declaration would read as authoritative while the cell loses it.`,
        ),
      );
      continue;
    }
    const ds = dataSource as Record<string, unknown>;
    let dsValid = true;
    if (!isNonEmptyString(ds.tableName)) {
      out.push(diag("invalid-binding-value", `${elementPath}.dataSource.tableName`, `\`tableName\` must be a non-empty string naming the table the binding reads.`));
      dsValid = false;
    }
    if (!Array.isArray(ds.bindingInfos)) {
      out.push(
        diag(
          "invalid-binding-value",
          `${elementPath}.dataSource.bindingInfos`,
          `\`bindingInfos\` must be an array of \`{ bindingInfo: { tableName, columnName }, columnName }\` entries — the nested shape is what the platform round-trips, and a flat declaration would be a second spelling of it.`,
        ),
      );
      dsValid = false;
    }
    if (!dsValid) continue;

    const bindingInfos: {
      readonly bindingInfo: CellDataSourceBindingInfoConfig;
      readonly columnName: string;
    }[] = [];
    let infosValid = true;
    for (const [infoIndex, info] of (ds.bindingInfos as readonly unknown[]).entries()) {
      const infoPath = `${elementPath}.dataSource.bindingInfos[${infoIndex}]`;
      if (typeof info !== "object" || info === null || Array.isArray(info)) {
        out.push(diag("invalid-binding-value", infoPath, `A binding info must be an object with \`bindingInfo\` and \`columnName\`.`));
        infosValid = false;
        continue;
      }
      const infoRecord = info as Record<string, unknown>;
      const bindingInfo = infoRecord.bindingInfo;
      if (typeof bindingInfo !== "object" || bindingInfo === null || Array.isArray(bindingInfo)) {
        out.push(diag("invalid-binding-value", `${infoPath}.bindingInfo`, `\`bindingInfo\` must be a \`{ tableName, columnName }\` object.`));
        infosValid = false;
        continue;
      }
      const bi = bindingInfo as Record<string, unknown>;
      if (!isNonEmptyString(bi.tableName) || !isNonEmptyString(bi.columnName) || !isNonEmptyString(infoRecord.columnName)) {
        out.push(
          diag(
            "invalid-binding-value",
            infoPath,
            `\`bindingInfo.tableName\`, \`bindingInfo.columnName\` and the entry's own \`columnName\` must each be a non-empty string.`,
          ),
        );
        infosValid = false;
        continue;
      }
      bindingInfos.push({
        bindingInfo: { tableName: bi.tableName, columnName: bi.columnName },
        columnName: infoRecord.columnName,
      });
    }
    if (!infosValid) continue;

    entries.push({
      dataSourceName: name,
      dataSource: {
        tableName: ds.tableName as string,
        bindingInfos,
        ...("formulaNullQueryPolicy" in ds ? { formulaNullQueryPolicy: ds.formulaNullQueryPolicy } : {}),
      },
    });
  }
  checkDuplicateNames(names, "dataSources", path, out);
  return entries;
}

function validatePermissions(
  raw: unknown,
  path: string,
  out: BindingsConfigDiagnostic[],
): readonly NormalizedCellPermissionBinding[] | undefined {
  if (!Array.isArray(raw)) {
    out.push(diag("invalid-binding-value", path, `"permissions" must be an array (possibly empty — an empty array is the managed-empty declaration).`));
    return undefined;
  }
  const entries: NormalizedCellPermissionBinding[] = [];
  const names: string[] = [];
  for (const [index, element] of raw.entries()) {
    const elementPath = `${path}[${index}]`;
    const record = readNamedEntry(element, "permissions", elementPath, out);
    if (record === undefined) continue;
    checkElementKeys(record, { field: "permissions" }, elementPath, out);
    const name = record.name;
    if (typeof name === "string") names.push(name);
    if (!validateBindingName(name, "A permission's `name`", `${elementPath}.name`, out)) continue;
    let allowRoles: readonly string[] | undefined;
    let rolesValid = true;
    if (record.allowRoles !== undefined) {
      if (!Array.isArray(record.allowRoles) || record.allowRoles.some(role => typeof role !== "string" || role.trim().length === 0)) {
        out.push(diag("invalid-binding-value", `${elementPath}.allowRoles`, `\`allowRoles\` must be an array of non-empty role-name strings.`));
        rolesValid = false;
      } else {
        allowRoles = (record.allowRoles as readonly string[]).map(role => role.trim());
      }
    }
    if (!rolesValid) continue;
    entries.push({ name, ...(allowRoles === undefined ? {} : { allowRoles }) });
  }
  checkDuplicateNames(names, "permissions", path, out);
  return entries;
}

function validateAvailableServerCommands(
  raw: unknown,
  path: string,
  out: BindingsConfigDiagnostic[],
  warnings: BindingsConfigWarning[],
): readonly { readonly name: string }[] | undefined {
  if (!Array.isArray(raw)) {
    out.push(diag("invalid-binding-value", path, `"availableServerCommands" must be an array (possibly empty — an empty array is the managed-empty declaration).`));
    return undefined;
  }
  const entries: { readonly name: string }[] = [];
  const names: string[] = [];
  for (const [index, element] of raw.entries()) {
    const elementPath = `${path}[${index}]`;
    const record = readNamedEntry(element, "availableServerCommands", elementPath, out);
    if (record === undefined) continue;
    checkElementKeys(record, { field: "availableServerCommands" }, elementPath, out);
    const name = record.name;
    if (!isNonEmptyString(name)) {
      out.push(diag("invalid-binding-value", `${elementPath}.name`, `A server command's \`name\` must be a non-empty string.`));
      continue;
    }
    // Warn rather than refuse: the platform performs no existence validation on this field at
    // all — a nonexistent name persists and fails at runtime as a plain TypeError — so nothing
    // downstream will catch the typo this pattern almost always is. The declaration is still
    // accepted, because a command name genuinely containing whitespace or punctuation is the
    // designer's to choose; what a config can honestly do is say "this looks wrong" loudly.
    if (/\s/.test(name) || /^[0-9]/.test(name) || /[(){}[\].,;]/.test(name)) {
      warnings.push({
        code: "suspicious-server-command-name",
        path: `${elementPath}.name`,
        message: `Server command name ${JSON.stringify(name)} contains whitespace or punctuation. The platform performs no existence validation on availableServerCommands — a nonexistent or mistyped name persists silently and fails at runtime as a TypeError when called — so this warning is the only check the name will ever get before deploy. Confirm it matches the server command's exact name.`,
      });
    }
    names.push(name);
    entries.push({ name });
  }
  checkDuplicateNames(names, "availableServerCommands", path, out);
  return entries;
}

const PRESET_NAME_PATTERN = /^[A-Za-z]+$/;

function validateLibraries(
  raw: unknown,
  path: string,
  out: BindingsConfigDiagnostic[],
): string | undefined {
  if (typeof raw !== "string") {
    out.push(
      diag(
        "invalid-binding-value",
        path,
        `"libraries" must be a string — the platform's round-trip form is the comma-separated preset list (\`"AntDesign"\`, \`"AntDesign, ECharts"\`, \`"None"\`). The integer bitmask the write API also accepts is deliberately not declarable here: a config is the reviewed fact source, and a number nobody can read is not a declaration.`,
      ),
    );
    return undefined;
  }
  if (raw.trim() === "") {
    out.push(
      diag(
        "invalid-binding-value",
        path,
        `"libraries" must not be empty — the no-libraries preset is spelled \`"None"\` (see \`CELL_PRESET_LIBRARIES\`), which is what the platform round-trips. An empty string is not a form the platform produces, so drift detection could never compare it.`,
      ),
    );
    return undefined;
  }
  const segments = raw.split(",").map(segment => segment.trim());
  const bad = segments.filter(segment => !PRESET_NAME_PATTERN.test(segment));
  if (bad.length > 0 || segments.some(segment => segment.length === 0)) {
    out.push(
      diag(
        "invalid-binding-value",
        path,
        `"libraries" must be a comma-separated list of preset names (${CELL_TYPE_PROPS_WRITE_SCHEMA.libraries.acceptedInputs[0]}); got ${JSON.stringify(raw)}. The declared presets are validated against the project at sync time (#179) — a config can only promise the spelling is a preset-shaped one.`,
      ),
    );
    return undefined;
  }
  const seen = new Set<string>();
  for (const segment of segments) {
    if (seen.has(segment)) {
      out.push(diag("duplicate-binding-name", path, `Preset "${segment}" is listed more than once in ${JSON.stringify(raw)}.`));
      return undefined;
    }
    seen.add(segment);
  }
  return segments.join(", ");
}

function validateUploadLimit(
  raw: unknown,
  path: string,
  out: BindingsConfigDiagnostic[],
): NormalizedCellUploadLimitBinding | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    out.push(diag("invalid-binding-value", path, `"uploadLimit" must be an object with any of ${roundTrippedKeysOf("uploadLimit").join("/")} — \`{}\` is the managed-empty declaration, and \`null\` is refused: writing \`uploadLimit: null\` *removes* the object on the platform, which is a delete the three-state model cannot distinguish from pass-through.`));
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(roundTrippedKeysOf("uploadLimit") as readonly string[]).includes(key)) {
      out.push(
        diag(
          "unknown-binding-key",
          `${path}.${key}`,
          `Unknown key "${key}" on \`uploadLimit\`. The measured schema round-trips exactly ${roundTrippedKeysOf("uploadLimit").join("/")}; anything else is dead weight the platform discards.`,
        ),
      );
    }
  }
  const result: Record<string, unknown> = {};
  if (record.extensionFilter !== undefined) {
    if (typeof record.extensionFilter !== "string") {
      out.push(diag("invalid-binding-value", `${path}.extensionFilter`, `\`extensionFilter\` must be a comma-separated string such as \`".jpg, .png"\`.`));
    } else {
      result.extensionFilter = record.extensionFilter;
    }
  }
  for (const key of ["sizeLimit", "maxUploadFileCount"] as const) {
    if (record[key] === undefined) continue;
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      out.push(
        diag(
          "invalid-binding-value",
          `${path}.${key}`,
          `\`${key}\` must be a non-negative number — \`sizeLimit\` is megabytes, \`maxUploadFileCount\` is files per call, and \`0\` means unlimited on both (#176).`,
        ),
      );
    } else {
      result[key] = value;
    }
  }
  return result as NormalizedCellUploadLimitBinding;
}

// ---------------------------------------------------------------------------
// The normalization entry point
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes one Cell's `bindings` block.
 *
 * Returns `bindings: undefined` when the key is absent — the pass-through default, and
 * the backward-compatible answer for every pre-#178 config. A present `bindings` is
 * validated field by field against the measured schema; any failure is a blocking
 * diagnostic, and because the registry folds these into its own error list, an invalid
 * declaration never produces a registry at all — there is no path on which a broken
 * `bindings` block is quietly demoted to pass-through, which is the one direction
 * (more permissive than declared) the Epic forbids.
 */
/**
 * The output shape the registry hands in.
 *
 * Structurally identical to this module's own diagnostic — `code`/`path`/`message` — but typed
 * against the registry's wider code vocabulary, because the registry collects every sub-module's
 * findings into one list and this module contributes only its own codes. `BindingsConfigDiagnostic`
 * stays the type of the *result* half: a caller reading the failure of a standalone validation
 * should not have to know which other modules exist.
 */
export interface BindingsDiagnosticSink {
  push(diagnostic: BindingsConfigDiagnostic): unknown;
}

export function validateCellBindings(raw: unknown, path: string, out: BindingsDiagnosticSink): NormalizeCellBindingsResult {
  const diagnostics: BindingsConfigDiagnostic[] = [];
  const warnings: BindingsConfigWarning[] = [];

  if (raw === undefined) {
    return { ok: true, bindings: undefined, warnings };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    diagnostics.push(
      diag(
        "invalid-bindings",
        path,
        `"bindings" must be an object declaring any of ${BINDINGS_ALLOWED_FIELDS.join("/")}. An empty object is legal and means "this Cell takes over nothing"; an absent key means the same thing with less typing.`,
      ),
    );
    return { ok: false, diagnostics };
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(BINDINGS_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      diagnostics.push(
        diag(
          "unknown-bindings-field",
          `${path}.${key}`,
          `Unknown bindings field "${key}". The declarable host-binding fields are exactly the seven the measured \`cellTypeProps\` schema round-trips: ${BINDINGS_ALLOWED_FIELDS.join(", ")}. \`code\` belongs to the artifact and \`frontendLibraries\` to the dependency lock — neither is declarable here.`,
        ),
      );
    }
  }

  const result: Record<string, unknown> = {};
  const declaredFields: CellBindingFieldName[] = [];

  const declare = (field: CellBindingFieldName, value: unknown): void => {
    declaredFields.push(field);
    result[field] = value;
  };

  if ("dataSources" in record) {
    const value = validateDataSources(record.dataSources, `${path}.dataSources`, diagnostics);
    if (value !== undefined) declare("dataSources", value);
  }
  if ("permissions" in record) {
    const value = validatePermissions(record.permissions, `${path}.permissions`, diagnostics);
    if (value !== undefined) declare("permissions", value);
  }
  if ("availableServerCommands" in record) {
    const value = validateAvailableServerCommands(record.availableServerCommands, `${path}.availableServerCommands`, diagnostics, warnings);
    if (value !== undefined) declare("availableServerCommands", value);
  }
  if ("properties" in record) {
    const value = validateProperties(record.properties, `${path}.properties`, diagnostics);
    if (value !== undefined) declare("properties", value);
  }
  if ("eventHandlers" in record) {
    const value = validateEventHandlers(record.eventHandlers, `${path}.eventHandlers`, diagnostics);
    if (value !== undefined) declare("eventHandlers", value);
  }
  if ("uploadLimit" in record) {
    const value = validateUploadLimit(record.uploadLimit, `${path}.uploadLimit`, diagnostics);
    if (value !== undefined) declare("uploadLimit", value);
  }
  if ("libraries" in record) {
    const value = validateLibraries(record.libraries, `${path}.libraries`, diagnostics);
    if (value !== undefined) declare("libraries", value);
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // Copied and frozen, for the reason `extension-mappings-config`'s `freezeMappings` copies:
  // the validators built these structures out of the config's own values, so without a copy a
  // caller mutating its config object after loading would be editing the declaration the build,
  // the plan and the sync all read — the "second source of truth" failure the freeze exists to
  // prevent. `formulaNullQueryPolicy` is the one value shared by reference rather than cloned: it
  // is a pass-through the schema round-trips without this repository interpreting it, and cloning
  // an `unknown` deeply would be inventing its structure. Everything frozen around it is what
  // keeps the sharing contained.
  const freezeValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return Object.freeze(value.map(freezeValue));
    }
    if (typeof value === "object" && value !== null) {
      const copy: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        copy[key] = key === "formulaNullQueryPolicy" ? child : freezeValue(child);
      }
      return Object.freeze(copy);
    }
    return value;
  };

  const frozen: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(result)) {
    frozen[field] = freezeValue(value);
  }

  const bindings = Object.freeze({
    declaredFields: Object.freeze([...declaredFields].sort((a, b) => BINDINGS_ALLOWED_FIELDS.indexOf(a) - BINDINGS_ALLOWED_FIELDS.indexOf(b))),
    ...frozen,
  }) as NormalizedCellBindings;

  return { ok: true, bindings, warnings: Object.freeze(warnings) };
}
