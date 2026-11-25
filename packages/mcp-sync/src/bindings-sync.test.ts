/**
 * The binding takeover vocabulary (#179), as unit tests.
 *
 * What this file can establish: the declaration→wire conversion, the comparison normalization,
 * the field-level diff, the `eventHandlers` command-body merge, and the write-plan assembly are
 * internally consistent and honour the measured platform semantics. What it cannot: that a real
 * designer round-trips any of it — that is #179's real-machine gate, kept separate per AGENTS.md
 * rule 7.
 *
 * The platform facts these tests encode are #179's probe evidence, not assumptions: empty-array/
// empty-object clearing, the `properties` formula rewrite, the `libraries` comma-space form, and
 * the wholesale `cellTypeProps` replacement.
 */

import { describe, expect, it } from "vitest";

import type { NormalizedCellBindings } from "@forguncy-react-workspace/core";

import {
  bindingValuesEqual,
  bindingWriteInstructions,
  canonicalizeJsonValue,
  canonicalizeLibraries,
  declaredBindingWireValue,
  diffDeclaredBindings,
  emptyFormOf,
  mergeEventHandlerBodies,
  readBackBindingValue,
} from "./bindings-sync.ts";

/** A declaration with several managed fields, in the normalized shape #178 produces. */
function declared(overrides: Partial<NormalizedCellBindings> = {}): NormalizedCellBindings {
  return {
    declaredFields: ["properties", "eventHandlers", "libraries"],
    properties: [{ propertyName: "title", propertyValue: "hello" }],
    eventHandlers: [{ eventName: "onClick", eventArgs: [{ name: "n" }] }],
    libraries: "AntDesign, ECharts",
    ...overrides,
  } as NormalizedCellBindings;
}

describe("canonicalizeJsonValue", () => {
  it("orders object keys recursively but keeps array order", () => {
    expect(canonicalizeJsonValue({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toEqual({
      a: { c: [{ y: 2, z: 1 }], d: 2 },
      b: 1,
    });
  });
});

describe("canonicalizeLibraries", () => {
  it("collapses the comma whitespace to the round-trip form", () => {
    expect(canonicalizeLibraries("AntDesign,ECharts")).toBe("AntDesign, ECharts");
    expect(canonicalizeLibraries("AntDesign, ECharts")).toBe("AntDesign, ECharts");
    expect(canonicalizeLibraries("None")).toBe("None");
  });
});

describe("declaredBindingWireValue", () => {
  it("produces the empty form for a managed-empty declaration", () => {
    const empty = { declaredFields: ["properties", "uploadLimit", "libraries"], properties: [], uploadLimit: {}, libraries: "None" } as NormalizedCellBindings;
    expect(declaredBindingWireValue(empty, "properties")).toEqual([]);
    expect(declaredBindingWireValue(empty, "uploadLimit")).toEqual({});
    expect(declaredBindingWireValue(empty, "libraries")).toBe("None");
  });

  it("produces only the event contract for eventHandlers — never the command body", () => {
    const value = declaredBindingWireValue(declared(), "eventHandlers");
    expect(value).toEqual([{ eventName: "onClick", eventArgs: [{ name: "n" }] }]);
    // No `eventHandler` key anywhere: the body is the designer's and is merged separately.
    expect(JSON.stringify(value)).not.toContain("eventHandler");
  });

  it("canonicalizes the libraries preset list", () => {
    expect(declaredBindingWireValue(declared({ libraries: "AntDesign,ECharts" }), "libraries")).toBe("AntDesign, ECharts");
  });
});

describe("readBackBindingValue + collapse semantics", () => {
  it("carries a pass-through value verbatim — no normalization, no shape filtering", () => {
    // A non-standard libraries value (not a string the platform produces) is still carried back
    // unchanged, because carrying it is a no-op and normalization is a comparison-only concern.
    expect(readBackBindingValue("libraries", { libraries: "WeirdValue" })).toBe("WeirdValue");
    expect(readBackBindingValue("uploadLimit", { uploadLimit: {} })).toEqual({});
    expect(readBackBindingValue("properties", { properties: { not: "an array" } })).toEqual({ not: "an array" });
  });

  it("returns undefined when the field is absent or null", () => {
    expect(readBackBindingValue("properties", {})).toBeUndefined();
    expect(readBackBindingValue("properties", { properties: null })).toBeUndefined();
  });
});

describe("emptyFormOf", () => {
  it("is the empty array for array fields, empty object for uploadLimit, None for libraries", () => {
    expect(emptyFormOf("properties")).toEqual([]);
    expect(emptyFormOf("uploadLimit")).toEqual({});
    expect(emptyFormOf("libraries")).toBe("None");
  });
});

describe("bindingValuesEqual", () => {
  it("treats the libraries whitespace variants as equal", () => {
    expect(bindingValuesEqual("libraries", "AntDesign, ECharts", "AntDesign,ECharts", "P")).toBe(true);
  });

  it("treats the properties formula rewrite as equal — bare vs page-qualified", () => {
    const declaredProps = [{ propertyName: "bare", propertyValue: "=A1" }];
    const readBackProps = [{ propertyName: "bare", propertyValue: "='OrderPage'!A1" }];
    expect(bindingValuesEqual("properties", declaredProps, readBackProps, "OrderPage")).toBe(true);
  });

  it("does not collapse a compound formula or a literal string", () => {
    expect(bindingValuesEqual("properties", [{ propertyName: "x", propertyValue: "=SUM(A1,A2)" }], [{ propertyName: "x", propertyValue: "=SUM(A1,A2)" }], "P")).toBe(true);
    expect(bindingValuesEqual("properties", [{ propertyName: "x", propertyValue: "text" }], [{ propertyName: "x", propertyValue: "text" }], "P")).toBe(true);
    // And a genuinely different value is not equal.
    expect(bindingValuesEqual("properties", [{ propertyName: "x", propertyValue: "a" }], [{ propertyName: "x", propertyValue: "b" }], "P")).toBe(false);
  });

  it("is key-order insensitive for object content", () => {
    expect(
      bindingValuesEqual("uploadLimit", { sizeLimit: 2, extensionFilter: ".png" }, { extensionFilter: ".png", sizeLimit: 2 }, "P"),
    ).toBe(true);
  });
});

describe("diffDeclaredBindings", () => {
  it("reports nothing when the read-back matches the declaration", () => {
    const readBack = {
      properties: [{ propertyName: "title", propertyValue: "hello" }],
      eventHandlers: [{ eventName: "onClick", eventArgs: [{ name: "n" }] }],
      libraries: "AntDesign, ECharts",
    };
    expect(diffDeclaredBindings(declared(), readBack, "P")).toEqual([]);
  });

  it("reports the one field the designer changed, with the new value", () => {
    const readBack = {
      properties: [{ propertyName: "title", propertyValue: "EDITED" }],
      eventHandlers: [{ eventName: "onClick", eventArgs: [{ name: "n" }] }],
      libraries: "AntDesign, ECharts",
    };
    const drift = diffDeclaredBindings(declared(), readBack, "P");
    expect(drift.map(entry => entry.field)).toEqual(["properties"]);
    expect(drift[0]?.readBack).toEqual([{ propertyName: "title", propertyValue: "EDITED" }]);
  });

  it("reports a cleared field as its empty form, not as a phantom undefined", () => {
    // The designer cleared `properties` — the platform omits it on read-back.
    const readBack = {
      eventHandlers: [{ eventName: "onClick", eventArgs: [{ name: "n" }] }],
      libraries: "AntDesign, ECharts",
    };
    const drift = diffDeclaredBindings(declared(), readBack, "P");
    expect(drift.map(entry => entry.field)).toEqual(["properties"]);
    expect(drift[0]?.readBack).toEqual([]);
  });

  it("never compares a pass-through field", () => {
    // `availableServerCommands` is not declared, so even a radical designer change is not drift.
    const readBack = {
      properties: [{ propertyName: "title", propertyValue: "hello" }],
      eventHandlers: [{ eventName: "onClick", eventArgs: [{ name: "n" }] }],
      libraries: "AntDesign, ECharts",
      availableServerCommands: [{ name: "DesignerAdded" }],
    };
    expect(diffDeclaredBindings(declared(), readBack, "P")).toEqual([]);
  });
});

describe("mergeEventHandlerBodies", () => {
  const declaredEvents = [
    { eventName: "onClick", eventArgs: [{ name: "n" }] },
    { eventName: "onClose", eventArgs: [] },
  ];
  const body = { commandType: "ServerCommand", serverCommandName: "刷新数据", commandList: [{ commandType: "NOPCommand" }] };

  it("preserves the designer's command body for a declared event, matched by name", () => {
    const designerEvents = [{ eventName: "onClick", eventHandler: body }];
    const merged = mergeEventHandlerBodies(declaredEvents, designerEvents, { clearBodies: false });
    expect(merged[0]).toEqual({ eventName: "onClick", eventArgs: [{ name: "n" }], eventHandler: body });
  });

  it("matches by name, not index — a reordered designer list still merges", () => {
    const designerEvents = [
      { eventName: "onClose", eventHandler: { commandType: "A" } },
      { eventName: "onClick", eventHandler: body },
    ];
    const merged = mergeEventHandlerBodies(declaredEvents, designerEvents, { clearBodies: false });
    expect(merged[0]?.eventHandler).toEqual(body);
    expect(merged[1]?.eventHandler).toEqual({ commandType: "A" });
  });

  it("drops the body of an event the repository no longer declares", () => {
    // Only onClick is declared; the designer's onClose body must not survive, because the set of
    // events is authoritative.
    const designerEvents = [{ eventName: "onRemoved", eventHandler: body }];
    const merged = mergeEventHandlerBodies([declaredEvents[0]!], designerEvents, { clearBodies: false });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.eventName).toBe("onClick");
    expect(JSON.stringify(merged)).not.toContain("onRemoved");
  });

  it("clears every body under --restore-all (clearBodies)", () => {
    const designerEvents = [{ eventName: "onClick", eventHandler: body }];
    const merged = mergeEventHandlerBodies(declaredEvents, designerEvents, { clearBodies: true });
    expect(JSON.stringify(merged)).not.toContain("eventHandler");
    expect(merged[0]).toEqual({ eventName: "onClick", eventArgs: [{ name: "n" }] });
  });

  it("never invents a body for a declared event the designer has none for", () => {
    const merged = mergeEventHandlerBodies(declaredEvents, [], { clearBodies: false });
    expect(merged[0]).toEqual({ eventName: "onClick", eventArgs: [{ name: "n" }] });
    expect("eventHandler" in (merged[0] as Record<string, unknown>)).toBe(false);
  });
});

describe("bindingWriteInstructions", () => {
  it("writes declared fields authoritatively and carries pass-through fields verbatim", () => {
    const readBack = {
      // pass-through field the designer set — must be carried, not written from the declaration.
      permissions: [{ name: "订单.读取", allowRoles: ["Admin"] }],
      // the declared fields' current content (irrelevant to what is written — the declaration wins).
      properties: [{ propertyName: "title", propertyValue: "OLD" }],
    };
    const instructions = bindingWriteInstructions(declared(), readBack, "P", { clearEventBodies: false });
    const byField = Object.fromEntries(instructions.map(instruction => [instruction.field, instruction]));

    // managed: written from the declaration, not the read-back.
    expect(byField.properties?.state).toBe("managed");
    expect(byField.properties?.value).toEqual([{ propertyName: "title", propertyValue: "hello" }]);
    // pass-through: carried verbatim.
    expect(byField.permissions?.state).toBe("pass-through");
    expect(byField.permissions?.value).toEqual([{ name: "订单.读取", allowRoles: ["Admin"] }]);
  });

  it("marks a pass-through field the read-back holds nothing for as undefined (omitted, never null)", () => {
    const instructions = bindingWriteInstructions(declared(), {}, "P", { clearEventBodies: false });
    const permissions = instructions.find(instruction => instruction.field === "permissions");
    expect(permissions?.state).toBe("pass-through");
    expect(permissions?.value).toBeUndefined();
  });

  it("merges the designer's eventHandler bodies into a managed eventHandlers write", () => {
    const body = { commandType: "ServerCommand" };
    const readBack = { eventHandlers: [{ eventName: "onClick", eventHandler: body }] };
    const instructions = bindingWriteInstructions(declared(), readBack, "P", { clearEventBodies: false });
    const eventHandlers = instructions.find(instruction => instruction.field === "eventHandlers");
    expect((eventHandlers?.value as readonly Record<string, unknown>[])[0]?.eventHandler).toEqual(body);
  });

  it("clears the bodies when clearEventBodies is set (--restore-all)", () => {
    const body = { commandType: "ServerCommand" };
    const readBack = { eventHandlers: [{ eventName: "onClick", eventHandler: body }] };
    const instructions = bindingWriteInstructions(declared(), readBack, "P", { clearEventBodies: true });
    const eventHandlers = instructions.find(instruction => instruction.field === "eventHandlers");
    expect(JSON.stringify(eventHandlers?.value)).not.toContain("eventHandler");
  });

  it("writes the empty form for a managed-empty declaration", () => {
    const empty = { declaredFields: ["properties"], properties: [] } as NormalizedCellBindings;
    const readBack = { properties: [{ propertyName: "x", propertyValue: "y" }] };
    const instructions = bindingWriteInstructions(empty, readBack, "P", { clearEventBodies: false });
    const properties = instructions.find(instruction => instruction.field === "properties");
    expect(properties?.state).toBe("managed-empty");
    expect(properties?.value).toEqual([]);
  });

  it("treats an all-pass-through cell (no bindings) as carrying everything", () => {
    const readBack = { properties: [{ propertyName: "x", propertyValue: "y" }], libraries: "AntDesign" };
    const instructions = bindingWriteInstructions(undefined, readBack, "P", { clearEventBodies: false });
    expect(instructions.every(instruction => instruction.state === "pass-through")).toBe(true);
    expect(instructions.find(instruction => instruction.field === "properties")?.value).toEqual([{ propertyName: "x", propertyValue: "y" }]);
  });
});
