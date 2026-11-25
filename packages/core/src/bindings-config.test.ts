/**
 * The per-Cell host-binding declaration (#178), against its ticket's acceptance criteria.
 *
 * Decision sources: GitHub Issues
 * - #178 — "Implement: forguncy.config.ts 声明式宿主绑定与校验"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/178), under Epic #175,
 *   whose core semantic this file is organised around: **declared means managed**, and the
 *   three states of a field (pass-through / managed / managed-empty) are distinct values.
 *
 * The blocks follow the criteria rather than the functions, for the reason
 * `extension-mappings-config.test.ts` records: the criteria are the specification.
 *
 * - illegal declarations refuse loudly — wrong field names, wrong types, dropped keys,
 *   the forbidden `eventHandler` command body — asserted on `code` and `path` rather than
 *   on message text, because "a clear diagnostic at the config location" is the criterion;
 * - the measured schema is enforced *as measured*: round-tripped keys pass verbatim,
 *   camelCase is the input casing, `availableServerCommands` warns where the platform
 *   performs no existence validation;
 * - the three states round-trip into the normalized result — a declared `[]` is
 *   `managed-empty`, never pass-through, and a config with no `bindings` key at all is
 *   the backward-compatible default;
 * - the result is frozen and copied, so a mutation through the config object after
 *   loading cannot rewrite the declaration every consumer reads.
 */

import { describe, expect, it } from "vitest";

import {
  BINDINGS_ALLOWED_FIELDS,
  cellBindingFieldState,
  cellBindingFieldStates,
  validateCellBindings,
} from "./bindings-config.ts";
import type { BindingsConfigDiagnostic, NormalizeCellBindingsResult, NormalizedCellBindings } from "./bindings-config.ts";

/** The validation, or a failure that prints the diagnostics instead of an empty diff. */
function validateOrThrow(raw: unknown): NormalizeCellBindingsResult & { readonly ok: true } {
  const sink: BindingsConfigDiagnostic[] = [];
  const result = validateCellBindings(raw, "cells.orderList.bindings", sink);
  if (!result.ok) {
    throw new Error(
      `Expected this bindings block to validate:\n${result.diagnostics
        .map(diagnostic => `${diagnostic.path}: [${diagnostic.code}] ${diagnostic.message}`)
        .join("\n")}`,
    );
  }
  return result;
}

/** The diagnostics of a block that must fail validation. */
function diagnosticsOf(raw: unknown): readonly BindingsConfigDiagnostic[] {
  const sink: BindingsConfigDiagnostic[] = [];
  const result = validateCellBindings(raw, "cells.orderList.bindings", sink);
  if (result.ok) {
    throw new Error("Expected this bindings block to be refused, and it validated instead.");
  }
  return result.diagnostics;
}

/** A complete, valid declaration of all seven fields — the positive control every refusal is measured against. */
function fullBindings(): Record<string, unknown> {
  return {
    dataSources: [
      {
        dataSourceName: "orders",
        dataSource: {
          tableName: "订单表",
          bindingInfos: [{ bindingInfo: { tableName: "订单表", columnName: "金额" }, columnName: "金额" }],
        },
      },
    ],
    permissions: [{ name: "ordersRead", allowRoles: ["Administrator"] }],
    availableServerCommands: [{ name: "RecalculateOrders" }],
    properties: [{ propertyName: "title", propertyValue: '="总览"', exampleValue: "订单总览" }],
    eventHandlers: [{ eventName: "onSelect", eventArgs: [{ name: "rowId" }] }],
    uploadLimit: { extensionFilter: ".jpg, .png", sizeLimit: 5, maxUploadFileCount: 3 },
    libraries: "AntDesign, ECharts",
  };
}

describe("the pass-through default — backward compatibility", () => {
  it("an absent bindings key validates to `undefined`, the pre-#178 behaviour", () => {
    const result = validateOrThrow(undefined);

    expect(result.bindings).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("every field of an absent block is pass-through", () => {
    expect(cellBindingFieldStates(undefined)).toEqual({
      dataSources: "pass-through",
      permissions: "pass-through",
      availableServerCommands: "pass-through",
      properties: "pass-through",
      eventHandlers: "pass-through",
      uploadLimit: "pass-through",
      libraries: "pass-through",
    });
  });

  it("`bindings: {}` is legal and means \"this Cell takes over nothing\" — distinct from absent", () => {
    const result = validateOrThrow({});

    expect(result.bindings).toBeDefined();
    expect(result.bindings?.declaredFields).toEqual([]);
    // A declared-but-empty block still leaves every field pass-through *by field*, because no
    // field key is present — the states belong to the fields, the declaration to the block.
    expect(cellBindingFieldStates(result.bindings).properties).toBe("pass-through");
  });
});

describe("the three states of a declared field", () => {
  it("a present empty array is managed-empty, never pass-through", () => {
    const result = validateOrThrow({ properties: [], eventHandlers: [] });

    expect(result.bindings?.declaredFields).toEqual(["properties", "eventHandlers"]);
    // The keys survive validation — dropping them here is exactly the pass-through confusion
    // the model exists to prevent.
    expect(result.bindings?.properties).toEqual([]);
    expect(cellBindingFieldState(result.bindings, "properties")).toBe("managed-empty");
    expect(cellBindingFieldState(result.bindings, "eventHandlers")).toBe("managed-empty");
  });

  it("`uploadLimit: {}` is the object's managed-empty spelling", () => {
    const result = validateOrThrow({ uploadLimit: {} });

    expect(cellBindingFieldState(result.bindings, "uploadLimit")).toBe("managed-empty");
  });

  it("`libraries: \"None\"` is the scalar's managed-empty content", () => {
    const result = validateOrThrow({ libraries: "None" });

    expect(cellBindingFieldState(result.bindings, "libraries")).toBe("managed-empty");
    // …while a real preset list is managed.
    expect(cellBindingFieldState(validateOrThrow({ libraries: "AntDesign" }).bindings, "libraries")).toBe("managed");
  });

  it("content makes a field managed, and only the declared fields are managed", () => {
    const result = validateOrThrow({ properties: [{ propertyName: "title" }] });

    expect(cellBindingFieldState(result.bindings, "properties")).toBe("managed");
    expect(cellBindingFieldState(result.bindings, "dataSources")).toBe("pass-through");
    expect(result.bindings?.declaredFields).toEqual(["properties"]);
  });

  it("declaredFields is in schema order regardless of declaration order", () => {
    const result = validateOrThrow({
      libraries: "AntDesign",
      properties: [],
      dataSources: [],
    });

    expect(result.bindings?.declaredFields).toEqual(["dataSources", "properties", "libraries"]);
  });
});

describe("a valid full declaration round-trips verbatim", () => {
  it("carries all seven fields with their content intact", () => {
    const result = validateOrThrow(fullBindings());
    const bindings = result.bindings as NormalizedCellBindings;

    expect(bindings.declaredFields).toEqual([...BINDINGS_ALLOWED_FIELDS]);
    expect(bindings.properties).toEqual([{ propertyName: "title", propertyValue: '="总览"', exampleValue: "订单总览" }]);
    expect(bindings.eventHandlers).toEqual([{ eventName: "onSelect", eventArgs: [{ name: "rowId" }] }]);
    expect(bindings.availableServerCommands).toEqual([{ name: "RecalculateOrders" }]);
    expect(bindings.permissions).toEqual([{ name: "ordersRead", allowRoles: ["Administrator"] }]);
    expect(bindings.uploadLimit).toEqual({ extensionFilter: ".jpg, .png", sizeLimit: 5, maxUploadFileCount: 3 });
    expect(bindings.libraries).toBe("AntDesign, ECharts");
    expect(bindings.dataSources?.[0]?.dataSource.bindingInfos[0]).toEqual({
      bindingInfo: { tableName: "订单表", columnName: "金额" },
      columnName: "金额",
    });
    expect(cellBindingFieldStates(bindings).properties).toBe("managed");
    expect(result.warnings).toEqual([]);
  });

  it("omitted optional keys stay absent rather than being defaulted", () => {
    // Defaulting is the lie the platform would tell: a key the platform round-trips as absent
    // must stay absent here, or the declaration describes a cell that does not exist.
    const result = validateOrThrow({ properties: [{ propertyName: "title" }] });
    const entry = result.bindings?.properties?.[0] as unknown as Record<string, unknown>;

    expect("propertyValue" in entry).toBe(false);
    expect("exampleValue" in entry).toBe(false);
  });

  it("libraries is normalized to the platform's round-trip spelling", () => {
    // The read-back form has a space after the comma (`AntDesign, ECharts` for bitmask 3);
    // normalizing the input to it is what makes the drift comparison byte-stable.
    expect(validateOrThrow({ libraries: "AntDesign,ECharts" }).bindings?.libraries).toBe("AntDesign, ECharts");
    expect(validateOrThrow({ libraries: "ECharts , AntDesign" }).bindings?.libraries).toBe("ECharts, AntDesign");
  });
});

describe("illegal declarations refuse loudly, at their config path", () => {
  it("a non-object bindings block is invalid-bindings", () => {
    const diagnostics = diagnosticsOf("properties");

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["invalid-bindings"]);
    expect(diagnostics[0]?.path).toBe("cells.orderList.bindings");
  });

  it("an unknown field is refused naming the seven declarable ones", () => {
    const diagnostics = diagnosticsOf({ code: "var x", frontEndLibraries: [] });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["unknown-bindings-field", "unknown-bindings-field"]);
    expect(diagnostics[0]?.path).toBe("cells.orderList.bindings.code");
    // `code` and `frontendLibraries` are the two tempting mistakes — the message must say where
    // they actually live rather than only that they are unknown.
    expect(diagnostics[0]?.message).toContain("artifact");
    expect(diagnostics[1]?.message).toContain("dependency lock");
  });

  it("PascalCase input keys are refused as unknown, not normalized", () => {
    // Json.NET accepts them, but the byte-identical round-trip form is camelCase, and a
    // normalizing config layer would write a document the project never reviewed.
    const diagnostics = diagnosticsOf({ properties: [{ PropertyName: "title" }] });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toContain("unknown-binding-key");
    expect(diagnostics.find(diagnostic => diagnostic.code === "unknown-binding-key")?.path).toBe(
      "cells.orderList.bindings.properties[0].PropertyName",
    );
  });

  it("keys the platform drops on write are refused by name, with the evidence cited", () => {
    const diagnostics = diagnosticsOf({
      properties: [{ propertyName: "title", displayName: "标题", propertyType: "string" }],
    });

    const codes = diagnostics.map(diagnostic => diagnostic.code);
    expect(codes).toEqual(["unknown-binding-key", "unknown-binding-key"]);
    expect(diagnostics[0]?.message).toContain("dropped by the platform");
    expect(diagnostics[1]?.path).toBe("cells.orderList.bindings.properties[0].propertyType");
  });

  it("the eventHandler command body is refused outright — the one forbidden round-tripped key", () => {
    const diagnostics = diagnosticsOf({
      eventHandlers: [{ eventName: "onSelect", eventHandler: { commandName: "doThing" } }],
    });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["invalid-binding-value"]);
    expect(diagnostics[0]?.path).toBe("cells.orderList.bindings.eventHandlers[0].eventHandler");
    expect(diagnostics[0]?.message).toContain("designer");
    expect(diagnostics[0]?.message).toContain("#179");
  });

  it("an eventArgs entry carrying anything but `name` is refused", () => {
    const diagnostics = diagnosticsOf({
      eventHandlers: [{ eventName: "onSelect", eventArgs: [{ name: "rowId", type: "number" }] }],
    });

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["unknown-binding-key"]);
    expect(diagnostics[0]?.path).toBe("cells.orderList.bindings.eventHandlers[0].eventArgs[0].type");
  });

  it("wrong field types are refused per field", () => {
    expect(diagnosticsOf({ properties: {} }).map(d => d.code)).toEqual(["invalid-binding-value"]);
    expect(diagnosticsOf({ eventHandlers: "onSelect" }).map(d => d.code)).toEqual(["invalid-binding-value"]);
    expect(diagnosticsOf({ dataSources: {} }).map(d => d.code)).toEqual(["invalid-binding-value"]);
    expect(diagnosticsOf({ permissions: "ordersRead" }).map(d => d.code)).toEqual(["invalid-binding-value"]);
    expect(diagnosticsOf({ availableServerCommands: {} }).map(d => d.code)).toEqual(["invalid-binding-value"]);
    expect(diagnosticsOf({ uploadLimit: null }).map(d => d.code)).toEqual(["invalid-binding-value"]);
    expect(diagnosticsOf({ libraries: 3 }).map(d => d.code)).toEqual(["invalid-binding-value"]);
  });

  it("`uploadLimit: null` is refused — it is a platform delete, not a declaration", () => {
    const diagnostics = diagnosticsOf({ uploadLimit: null });

    expect(diagnostics[0]?.message).toContain("null");
  });

  it("`libraries: \"\"` is refused — the empty state is spelled \"None\"", () => {
    const diagnostics = diagnosticsOf({ libraries: "" });

    expect(diagnostics.map(d => d.code)).toEqual(["invalid-binding-value"]);
    expect(diagnostics[0]?.message).toContain("None");
  });

  it("the libraries bitmask input is refused — a number nobody can read is not a declaration", () => {
    const diagnostics = diagnosticsOf({ libraries: 3 });

    expect(diagnostics.map(d => d.code)).toEqual(["invalid-binding-value"]);
    expect(diagnostics[0]?.message).toContain("bitmask");
  });

  it("malformed libraries lists are refused", () => {
    expect(diagnosticsOf({ libraries: "AntDesign,,ECharts" }).length).toBeGreaterThan(0);
    expect(diagnosticsOf({ libraries: "Ant-Design" }).length).toBeGreaterThan(0);
    expect(diagnosticsOf({ libraries: "AntDesign, AntDesign" }).map(d => d.code)).toEqual(["duplicate-binding-name"]);
  });

  it("names that cannot be facade member literals are refused", () => {
    // The name becomes `props.<name>` and a `cellProperty`/`fireEvent` type literal (#177) —
    // a name with a space or leading digit is one the authored source cannot reference.
    expect(diagnosticsOf({ properties: [{ propertyName: "my prop" }] }).map(d => d.code)).toEqual(["invalid-binding-value"]);
    expect(diagnosticsOf({ eventHandlers: [{ eventName: "1select" }] }).map(d => d.code)).toEqual(["invalid-binding-value"]);
    expect(diagnosticsOf({ eventHandlers: [{ eventName: "onSelect", eventArgs: [{ name: "" }] }] }).length).toBeGreaterThan(0);
  });

  it("duplicate names are refused per name-bearing field", () => {
    expect(
      diagnosticsOf({ properties: [{ propertyName: "title" }, { propertyName: "title" }] }).map(d => d.code),
    ).toEqual(["duplicate-binding-name"]);
    expect(
      diagnosticsOf({ eventHandlers: [{ eventName: "onSelect" }, { eventName: "onSelect" }] }).map(d => d.code),
    ).toEqual(["duplicate-binding-name"]);
    expect(
      diagnosticsOf({ permissions: [{ name: "ordersRead" }, { name: "ordersRead" }] }).map(d => d.code),
    ).toEqual(["duplicate-binding-name"]);
    expect(
      diagnosticsOf({ availableServerCommands: [{ name: "Recalc" }, { name: "Recalc" }] }).map(d => d.code),
    ).toEqual(["duplicate-binding-name"]);
    expect(
      diagnosticsOf({ eventHandlers: [{ eventName: "onSelect", eventArgs: [{ name: "rowId" }, { name: "rowId" }] }] }).map(d => d.code),
    ).toEqual(["duplicate-binding-name"]);
  });

  it("a malformed dataSource shape is refused with the null-round-trip evidence", () => {
    // The measured fact: an entry without the full dataSourceName + bindingInfos shape
    // round-trips as `null` and is silently omitted — so a config accepting it would declare
    // a binding the cell never holds.
    const missing = diagnosticsOf({ dataSources: [{ dataSourceName: "orders" }] });
    expect(missing.map(d => d.code)).toEqual(["invalid-binding-value"]);
    expect(missing[0]?.message).toContain("null");

    const flat = diagnosticsOf({
      dataSources: [{ dataSourceName: "orders", dataSource: { tableName: "订单表" } }],
    });
    expect(flat.map(d => d.code)).toEqual(["invalid-binding-value"]);
    expect(flat[0]?.path).toBe("cells.orderList.bindings.dataSources[0].dataSource.bindingInfos");
  });

  it("wrong-typed scalar members are refused rather than carried", () => {
    expect(
      diagnosticsOf({ properties: [{ propertyName: "title", exampleValue: 42 }] }).map(d => d.code),
    ).toEqual(["invalid-binding-value"]);
    expect(
      diagnosticsOf({ uploadLimit: { sizeLimit: "5" } }).map(d => d.code),
    ).toEqual(["invalid-binding-value"]);
    expect(
      diagnosticsOf({ uploadLimit: { maxUploadFileCount: -1 } }).map(d => d.code),
    ).toEqual(["invalid-binding-value"]);
    expect(
      diagnosticsOf({ permissions: [{ name: "ordersRead", allowRoles: "Administrator" }] }).map(d => d.code),
    ).toEqual(["invalid-binding-value"]);
    expect(
      diagnosticsOf({ uploadLimit: { accepts: ".jpg" } }).map(d => d.code),
    ).toEqual(["unknown-binding-key"]);
  });

  it("several mistakes cost one round trip, not several", () => {
    // The registry's own convention, applied inside the block: a config with three mistakes
    // reports all three.
    const diagnostics = diagnosticsOf({
      properties: [{ propertyName: "a" }, { propertyName: "a" }],
      eventHandlers: [{ eventName: "onSelect", eventHandler: {} }],
      libraries: "",
    });

    expect(diagnostics.length).toBeGreaterThanOrEqual(3);
    expect(new Set(diagnostics.map(d => d.code))).toEqual(
      new Set(["duplicate-binding-name", "invalid-binding-value"]),
    );
    // One per field, across the whole block — the duplicate in `properties`, the forbidden
    // command body in `eventHandlers`, the empty libraries string.
    expect(diagnostics.map(d => d.path).some(path => path.startsWith("cells.orderList.bindings.properties"))).toBe(true);
    expect(diagnostics.map(d => d.path).some(path => path.includes("eventHandler"))).toBe(true);
    expect(diagnostics.map(d => d.path).some(path => path.endsWith("libraries"))).toBe(true);
  });
});

describe("the availableServerCommands warning — the field with no platform validation", () => {
  it("a suspicious name warns without blocking", () => {
    const result = validateOrThrow({ availableServerCommands: [{ name: "Recalculate Orders" }] });

    expect(result.bindings?.availableServerCommands).toEqual([{ name: "Recalculate Orders" }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe("suspicious-server-command-name");
    expect(result.warnings[0]?.path).toBe("cells.orderList.bindings.availableServerCommands[0].name");
    expect(result.warnings[0]?.message).toContain("no existence validation");
  });

  it("a plain command name does not warn", () => {
    expect(validateOrThrow({ availableServerCommands: [{ name: "RecalculateOrders" }] }).warnings).toEqual([]);
    expect(validateOrThrow({ availableServerCommands: [{ name: "重算订单" }] }).warnings).toEqual([]);
  });

  it("punctuation that almost always means a pasted expression warns too", () => {
    expect(validateOrThrow({ availableServerCommands: [{ name: "Recalc()" }] }).warnings).toHaveLength(1);
    expect(validateOrThrow({ availableServerCommands: [{ name: "1Recalc" }] }).warnings).toHaveLength(1);
  });
});

describe("the frozen, copied result", () => {
  it("a mutation through the config object after loading cannot rewrite the declaration", () => {
    const config = fullBindings();
    const result = validateOrThrow(config);
    const bindings = result.bindings as NormalizedCellBindings;

    (config.properties as Record<string, unknown>[])[0]!.propertyName = "rewritten";
    ((config.dataSources as Record<string, unknown>[])[0]!.dataSource as Record<string, unknown>).tableName = "改写";

    expect(bindings.properties?.[0]?.propertyName).toBe("title");
    expect(bindings.dataSources?.[0]?.dataSource.tableName).toBe("订单表");
  });

  it("the containers are frozen — the declaration every consumer reads is immutable", () => {
    const bindings = validateOrThrow(fullBindings()).bindings as NormalizedCellBindings;

    expect(Object.isFrozen(bindings)).toBe(true);
    expect(Object.isFrozen(bindings.declaredFields)).toBe(true);
    expect(Object.isFrozen(bindings.properties)).toBe(true);
    expect(Object.isFrozen(bindings.properties?.[0])).toBe(true);
    expect(Object.isFrozen(bindings.eventHandlers?.[0]?.eventArgs)).toBe(true);
    expect(Object.isFrozen(bindings.dataSources?.[0]?.dataSource)).toBe(true);
    expect(Object.isFrozen(bindings.dataSources?.[0]?.dataSource.bindingInfos)).toBe(true);
    expect(Object.isFrozen(bindings.uploadLimit)).toBe(true);
  });
});
