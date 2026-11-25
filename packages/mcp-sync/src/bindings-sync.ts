/**
 * The deploy-side vocabulary of #175's declared host bindings: how a repository
 * declaration becomes a wire value, how a read-back wire value is compared against it,
 * and how the `eventHandlers` command body survives a write.
 *
 * Decision source: GitHub Issue #179 — "Implement: fgc-sync v2 漂移检测 + --restore
 * 一键还原 + 真机 Gate" (https://github.com/Mang-X/forguncy-react-workspace/issues/179),
 * under Epic #175 (https://github.com/Mang-X/forguncy-react-workspace/issues/175).
 *
 * This module is the *pure* half of the binding takeover — no port call, no plan, only
 * the transformations every other module shares. It exists so the four consumers that
 * must agree cannot drift apart:
 *
 * - the **fingerprint** (#179's v2) hashes the declared bindings in canonical form;
 * - the **drift report** compares the read-back against the declaration in the *same*
 *   canonical form;
 * - the **transport's write** produces the *same* wire value the comparison expects;
 * - the **`eventHandlers` merge** preserves the designer's command body.
 *
 * If any two of those used a different spelling of "the same binding", a sync would either
 * report drift on an unchanged cell or overwrite a real edit. They share the functions here
 * instead.
 *
 * ## The measured wire semantics these transformations encode
 *
 * Probed on live Forguncy `12.0.102.0` (#179's evidence comment). Each is a fact about the
 * product, not a preference:
 *
 * - **`setCells` replaces `cellTypeProps` wholesale.** A write carrying only `code` erases the
 *   host bindings (#141). So a write must carry every field it means to keep.
 * - **An array binding is cleared by `[]` and an object binding by `{}`.** `null` clears too,
 *   but the empty form is what the schema calls the managed-empty spelling, and either way the
 *   cell survives — `uploadLimit: null` clears the *field*, it does not remove the cell.
 * - **A pass-through field must never be written `null`.** `libraries` omitted *defaults* to
 *   `"AntDesign"` on a fresh cell, and `null` writes `"None"` — so the only safe pass-through is
 *   to carry the read-back value verbatim.
 * - **`properties[].propertyValue` is rewritten when it is a bare cell reference.** `=A1` comes
 *   back as `='<pageName>'!A1`. Drift detection must canonicalize this or every formula reads as
 *   drift.
 * - **`libraries` round-trips in the comma-space form.** `"AntDesign,ECharts"` is persisted and
 *   read back as `"AntDesign, ECharts"`. The comparison canonicalizes whitespace so the two
 *   spellings are one.
 * - **A rewrite of `eventHandlers` that omits `eventHandler` drops the command body.** Measured:
 *   writing the same event contract without the body clears it. So the merge is not optional.
 */

import { isPlainRecord } from "@forguncy-react-workspace/core";
import type { CellBindingFieldName, NormalizedCellBindings } from "@forguncy-react-workspace/core";
import { cellBindingFieldState } from "@forguncy-react-workspace/core";

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/**
 * A value with its object keys in sorted order, recursively.
 *
 * The fingerprint and the drift comparison both need "the same content" to be insensitive to
 * the key order the platform happened to serialize with — Json.NET's order is not a contract,
 * and two reads of one object may differ in it. Arrays keep their order (order is meaningful in
 * a binding list). This is the JSON-twin of `frontendLibraries`' canonical ordering, applied to
 * the binding content the artifact hash does not cover.
 */
export function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalizeJsonValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The canonical JSON text of a value — the form the bindings fingerprint hashes. */
export function canonicalJsonText(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

/**
 * Normalize a `libraries` preset list to the platform's round-trip form.
 *
 * `"AntDesign,ECharts"` and `"AntDesign, ECharts"` are the same declaration; the platform reads
 * back the comma-space spelling. Splitting on the comma and re-joining with `", "` collapses the
 * difference so an input authored without the space does not read as drift against the read-back.
 */
export function canonicalizeLibraries(value: string): string {
  return value
    .split(",")
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Declaration -> wire value
// ---------------------------------------------------------------------------

/**
 * The wire value a declared field is written as, in the shape `setCells`/`getCells` round-trip.
 *
 * This is the *content* of a managed or managed-empty field — never the pass-through case, which
 * this function does not answer (there is no declared content for it). The shapes are the
 * measured round-trip keys of `CELL_TYPE_PROPS_WRITE_SCHEMA`: the declaration is already
 * validated against that schema by #178, so the conversion is a structural copy, not a
 * re-validation.
 *
 * `eventHandlers` is the one field whose write value is **not** just this: the declared
 * `eventName`/`eventArgs` contract is here, but the command body (`eventHandler`) is merged in
 * separately by {@link mergeEventHandlerBodies}, because the repository does not own it.
 *
 * Managed-empty is expressed as the platform's empty form — `[]` for the array fields, `{}` for
 * `uploadLimit`, `"None"` for `libraries` — which the probe measured as clearing the field.
 */
export function declaredBindingWireValue(
  bindings: NormalizedCellBindings,
  field: CellBindingFieldName,
): unknown {
  const state = cellBindingFieldState(bindings, field);
  const value = bindings[field];

  switch (field) {
    case "dataSources":
    case "permissions":
    case "availableServerCommands":
    case "properties":
      // The validated declaration is already in the round-trip shape; copy it so a caller cannot
      // mutate the frozen registry object through the wire payload.
      return state === "managed-empty" ? [] : deepCopyJson(value);
    case "eventHandlers":
      // Only the contract — `eventName` + `eventArgs`. The command body is the designer's and is
      // merged back at write time; it is never part of the declaration.
      return state === "managed-empty"
        ? []
        : (value as readonly { readonly eventName: string; readonly eventArgs: readonly { readonly name: string }[] }[]).map(entry => ({
            eventName: entry.eventName,
            eventArgs: entry.eventArgs.map(arg => ({ name: arg.name })),
          }));
    case "uploadLimit":
      return state === "managed-empty" ? {} : deepCopyJson(value);
    case "libraries":
      return state === "managed-empty" ? "None" : canonicalizeLibraries(value as string);
  }
}

/** A structural copy of JSON-shaped data, so the frozen declaration is never shared into a write. */
function deepCopyJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Read-back normalization
// ---------------------------------------------------------------------------

/**
 * The read-back value of one field, normalized into the same shape the declaration compares
 * against.
 *
 * Three normalizations, all measured:
 *
 * - a field the platform omits (because it is empty) reads back as the field's empty form, so
 *   "the designer never set it" and "the designer cleared it" are the same `managed-empty` value
 *   rather than one being a phantom diff;
 * - `libraries` is canonicalized to the comma-space form;
 * - `properties[].propertyValue` keeps its (possibly page-qualified) formula verbatim — the
 *   rewrite is handled at comparison time, not here, because the qualification depends on the
 *   page name.
 *
 * Returns `undefined` when the read-back holds nothing for the field *and* the field is one the
 * platform omits when empty — the caller maps that onto the empty form via {@link emptyFormOf}.
 */
export function readBackBindingValue(field: CellBindingFieldName, rawProps: Record<string, unknown>): unknown {
  const raw = rawProps[field];
  if (raw === undefined || raw === null) return undefined;

  // Pass-through fidelity first: whatever the cell holds is carried **verbatim**, because carrying
  // it back is a no-op (it is the same value) and is what keeps a pass-through field byte-stable
  // across a sync — the backward-compatibility the Epic requires. That means no normalization and
  // no shape filtering here: a `libraries` the designer set (even a non-standard one), an
  // `uploadLimit` of any shape, and the array fields all pass through untouched. Normalization is
  // a *comparison* concern and lives in {@link normalizedForCompare}, never in the carrier.
  switch (field) {
    case "libraries":
      // Only a string round-trips as a preset list; anything else the platform does not produce,
      // so it is carried verbatim as well. `canonicalizeLibraries` is NOT applied — that would
      // rewrite the value the designer sees.
      return deepCopyJson(raw);
    default:
      return deepCopyJson(raw);
  }
}

/**
 * The comparison-normalized form of a read-back or declared value, for one field.
 *
 * This is where the measured platform normalizations live — and it is applied only when
 * *comparing*, never when carrying:
 *
 * - `libraries` whitespace is collapsed to the round-trip form;
 * - everything else is canonical-JSON (key order insensitive).
 *
 * The drift comparison reduces both sides through this; the write carrier does not.
 */
export function normalizedForCompare(field: CellBindingFieldName, value: unknown): unknown {
  if (field === "libraries" && typeof value === "string") {
    return canonicalizeLibraries(value);
  }
  return value;
}

/** The empty form a field reads back as when the platform omits it. */
export function emptyFormOf(field: CellBindingFieldName): unknown {
  switch (field) {
    case "uploadLimit":
      return {};
    case "libraries":
      // `libraries` is never truly absent — the platform persists a default — but the empty
      // *declaration* is `"None"`, and that is the only empty form the comparison needs.
      return "None";
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/**
 * Are a declared value and a read-back value the same binding, for one field?
 *
 * The comparison is over canonical JSON, with two field-specific tolerances — both measured
 * platform behaviour, both required to avoid reporting drift on an unchanged cell:
 *
 * - **`properties`**: a declared bare cell reference is page-qualified on write. The comparison
 *   treats `=A1` and `='<page>'!A1` as the same when they differ only by that qualification.
 * - **`libraries`**: whitespace around the comma is collapsed before comparison.
 *
 * Everything else is a structural canonical-JSON equality.
 */
export function bindingValuesEqual(
  field: CellBindingFieldName,
  declared: unknown,
  readBack: unknown,
  pageName: string,
): boolean {
  if (field === "properties") {
    return canonicalJsonText(normalizePropertiesForCompare(declared, pageName)) === canonicalJsonText(normalizePropertiesForCompare(readBack, pageName));
  }
  // Both sides pass through the comparison normalization (never the carrier), so a whitespace or
  // key-order difference the platform does not mean is not reported as drift.
  return canonicalJsonText(normalizedForCompare(field, declared)) === canonicalJsonText(normalizedForCompare(field, readBack));
}

/**
 * Normalize a `properties` list for comparison: collapse the formula rewrite in both directions.
 *
 * A bare reference (`=A1`, `=$B$2`) and its page-qualified form (`='<page>'!A1`) are the same
 * declared intent — the platform qualifies a bare reference on write, so the read-back of a
 * declaration that wrote `=A1` is `='<page>'!A1`. The comparison must therefore reduce *both* to a
 * common form, because either side may be the qualified one:
 *
 * - the read-back is already page-qualified, so it is stripped back to the bare reference;
 * - the declaration is bare, so it is *expanded* to the qualified form as well.
 *
 * Reducing only one side would compare `=A1` against `=A1` only when the qualifier stripping
 * happened to fire; expanding the bare side too makes the comparison robust to a declaration that
 * was itself written pre-qualified (idempotent — expanding an already-qualified value is a no-op).
 * Any other formula (a real expression, a literal string) is untouched and compares byte-for-byte.
 */
function normalizePropertiesForCompare(value: unknown, pageName: string): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(entry => {
    if (!isPlainRecord(entry)) return entry;
    const copy: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
    const pv = copy.propertyValue;
    if (typeof pv === "string") {
      copy.propertyValue = normalizeFormulaForCompare(pv, pageName);
    }
    return copy;
  });
}

/**
 * Reduce one `propertyValue` formula to a canonical comparison form.
 *
 * Only a *simple cell reference* is collapsed, because that is the one shape the platform rewrites.
 * A compound formula (`=SUM(A1,A2)`, `=A1+1`) is not a bare reference and is compared verbatim —
 * the platform does not rewrite it, so neither side differs by qualification.
 */
function normalizeFormulaForCompare(formula: string, pageName: string): string {
  const qualifiedQuoted = `='${pageName}'!`;
  const qualifiedBare = `=${pageName}!`;

  // Strip a page qualifier back to the bare reference.
  let bare = formula;
  if (bare.startsWith(qualifiedQuoted)) {
    bare = `=${bare.slice(qualifiedQuoted.length)}`;
  } else if (bare.startsWith(qualifiedBare)) {
    bare = `=${bare.slice(qualifiedBare.length)}`;
  }

  // If what remains is a simple cell reference, the canonical form is the qualified one — so a
  // declaration written bare and a read-back already qualified both arrive here. A non-reference
  // is returned as it was passed in (unstripped), because stripping a qualifier off a compound
  // formula would invent a meaning the platform did not.
  if (/^=\$?[A-Za-z]{1,3}\$?\d+$/.test(bare)) {
    return `='${pageName}'!${bare.slice(1)}`;
  }
  return formula;
}

// ---------------------------------------------------------------------------
// The field-level drift report
// ---------------------------------------------------------------------------

/**
 * One declared field whose read-back value differs from the repository declaration.
 *
 * `declared`/`readBack` are the canonical forms, so the report can show *exactly* what the
 * designer changed the field to. `readBack` is the empty form when the platform omits the field
 * (the designer cleared it), never a phantom `undefined`.
 */
export interface BindingFieldDrift {
  readonly field: CellBindingFieldName;
  readonly declared: unknown;
  readonly readBack: unknown;
}

/**
 * Compare every declared field's read-back value against its declaration.
 *
 * Only **declared** fields are compared — a pass-through field is the designer's by contract, so
 * a difference there is not drift and is never reported. `readBackProps` is the cell's
 * `cellTypeProps` as read; a field absent from it is read as its empty form.
 *
 * Returns the drift entries in schema order, empty when nothing declared was changed.
 */
export function diffDeclaredBindings(
  bindings: NormalizedCellBindings,
  readBackProps: Record<string, unknown>,
  pageName: string,
): readonly BindingFieldDrift[] {
  const drift: BindingFieldDrift[] = [];
  for (const field of bindings.declaredFields) {
    const declared = declaredBindingWireValue(bindings, field);
    const readBackRaw = readBackBindingValue(field, readBackProps);
    // The empty-collapse, applied at comparison time: the platform omits an empty array/object
    // field on read-back, so "designer never set it" and "designer cleared it" are the same empty
    // form. `null`/absent both read back as `undefined` here, and an actual empty array/object the
    // carrier preserved is the same shape — both reduce to the empty form for the comparison.
    const collapsed = collapseToEmptyForm(field, readBackRaw);
    // The eventHandlers command body is stripped before comparison: it is the designer's own work,
    // never part of the declaration, so its presence is not drift. `eventName`/`eventArgs` remain
    // and are compared — a change to the *contract* is drift, a change to the *body* is not.
    const forCompare = stripEventHandlerBodiesForCompare(field, collapsed);
    const declaredForCompare = stripEventHandlerBodiesForCompare(field, declared);
    if (!bindingValuesEqual(field, declaredForCompare, forCompare, pageName)) {
      drift.push({ field, declared, readBack: collapsed });
    }
  }
  return drift;
}

/**
 * Strip the designer-owned command bodies out of an `eventHandlers` value for comparison.
 *
 * Both the declaration and the read-back are reduced to the contract shape — `eventName` +
 * `eventArgs` — because the command body is the one part of the field the repository does not own.
 * The declaration never carries a body to begin with, so stripping it is a no-op there; the
 * read-back does, and stripping it is what keeps a preserved body from reading as drift. For any
 * other field the value is returned unchanged.
 */
export function stripEventHandlerBodiesForCompare(field: CellBindingFieldName, value: unknown): unknown {
  if (field !== "eventHandlers" || !Array.isArray(value)) return value;
  return value.map(entry => {
    if (!isPlainRecord(entry)) return entry;
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (k !== "eventHandler") copy[k] = v;
    }
    return copy;
  });
}

/**
 * Reduce a read-back value to the field's canonical content form for comparison.
 *
 * `undefined` (the platform omitted the field) becomes the empty form. An empty array or empty
 * object — which the carrier preserves verbatim — is the same empty form, because the platform
 * drops it on write anyway. Non-empty content passes through unchanged.
 */
function collapseToEmptyForm(field: CellBindingFieldName, value: unknown): unknown {
  if (value === undefined) return emptyFormOf(field);
  if (field === "uploadLimit") {
    return isPlainRecord(value) && Object.keys(value).length === 0 ? emptyFormOf(field) : value;
  }
  if (field === "libraries") {
    return value;
  }
  // The array fields: an empty array is the empty form.
  if (Array.isArray(value) && value.length === 0) return emptyFormOf(field);
  return value;
}

// ---------------------------------------------------------------------------
// The eventHandlers command-body merge
// ---------------------------------------------------------------------------

/**
 * Merge the designer's command bodies into the declared event contract.
 *
 * The repository owns `eventName` + `eventArgs`; the designer owns `eventHandlers[i].eventHandler`.
 * For each declared event, if the designer's current cell has a command tree attached at the
 * matching `eventName`, it is carried onto the write untouched; the contract (`eventName`,
 * `eventArgs`) is the repository's.
 *
 * Matched by `eventName`, not by index: the designer may reorder or re-attach events, and the
 * body belongs to the *named* event. When `clearBodies` is false (the default, and `--restore`'s
 * behaviour) a declared event with no matching designer body simply has none — the body is
 * additive, never invented. When `clearBodies` is true (`--restore-all`) the merge is skipped
 * entirely, so no designer body survives.
 *
 * An event the designer has but the repository no longer declares is dropped with the rest of the
 * array — the declaration is authoritative for the *set* of events, so a removed event's body is
 * cleared exactly as the Epic specifies.
 */
export function mergeEventHandlerBodies(
  declaredEvents: readonly { readonly eventName: string; readonly eventArgs: readonly { readonly name: string }[] }[],
  designerEvents: unknown,
  options: { readonly clearBodies: boolean },
): readonly Record<string, unknown>[] {
  return declaredEvents.map(event => {
    const merged: Record<string, unknown> = {
      eventName: event.eventName,
      eventArgs: event.eventArgs.map(arg => ({ name: arg.name })),
    };
    if (!options.clearBodies) {
      const body = designerBodyFor(designerEvents, event.eventName);
      if (body !== undefined) {
        merged.eventHandler = body;
      }
    }
    return merged;
  });
}

/** The command tree the designer attached to one named event, verbatim, or `undefined`. */
function designerBodyFor(designerEvents: unknown, eventName: string): unknown {
  if (!Array.isArray(designerEvents)) return undefined;
  for (const entry of designerEvents) {
    if (!isPlainRecord(entry)) continue;
    if ((entry as Record<string, unknown>).eventName !== eventName) continue;
    const body = (entry as Record<string, unknown>).eventHandler;
    if (body !== undefined && body !== null) return deepCopyJson(body);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The write plan: which fields a sync writes, which it carries
// ---------------------------------------------------------------------------

/**
 * How one binding field is written for one Cell, given its declaration and the read-back.
 *
 * - `managed` / `managed-empty` — write the declaration's content (or its empty form).
 *   `eventHandlers` writes the contract with the designer's command bodies merged in (or cleared
 *   under `--restore-all`).
 * - `pass-through` — carry the read-back value verbatim, so the wholesale write does not erase a
 *   field the repository does not own.
 *
 * This is the single decision the transport's `setCells` payload is assembled from, extracted so
 * the write and the drift comparison cannot disagree about what "authoritative" means.
 */
export interface BindingWriteInstruction {
  readonly field: CellBindingFieldName;
  readonly state: "managed" | "managed-empty" | "pass-through";
  /**
   * The value to write, or `undefined` for a pass-through field the read-back holds nothing for.
   * When `undefined` the key is simply omitted (which for an already-empty field is a no-op).
   */
  readonly value: unknown;
}

/**
 * Assemble the per-field write instructions for one Cell.
 *
 * `bindings` is the Cell's declaration (possibly `undefined` = the all-pass-through default).
 * `readBackProps` is the cell's current `cellTypeProps` — required because pass-through fields
 * and the `eventHandlers` bodies both read from it. `clearEventBodies` is `--restore-all`.
 */
export function bindingWriteInstructions(
  bindings: NormalizedCellBindings | undefined,
  readBackProps: Record<string, unknown>,
  pageName: string,
  options: { readonly clearEventBodies: boolean },
): readonly BindingWriteInstruction[] {
  const instructions: BindingWriteInstruction[] = [];
  const fields: readonly CellBindingFieldName[] = [
    "dataSources",
    "permissions",
    "availableServerCommands",
    "properties",
    "eventHandlers",
    "uploadLimit",
    "libraries",
  ];

  for (const field of fields) {
    const state = cellBindingFieldState(bindings, field);
    if (state === "pass-through") {
      const readBack = readBackBindingValue(field, readBackProps);
      instructions.push({ field, state, value: readBack });
      continue;
    }

    if (field === "eventHandlers") {
      const declaredEvents = state === "managed-empty" ? [] : ((bindings?.eventHandlers ?? []) as readonly { readonly eventName: string; readonly eventArgs: readonly { readonly name: string }[] }[]);
      const merged = mergeEventHandlerBodies(declaredEvents, readBackProps.eventHandlers, {
        clearBodies: options.clearEventBodies,
      });
      instructions.push({ field, state, value: merged });
      continue;
    }

    // The binding is declared non-empty here (`bindings` is defined when state is not pass-through).
    instructions.push({ field, state, value: declaredBindingWireValue(bindings as NormalizedCellBindings, field) });
  }

  return instructions;
}
