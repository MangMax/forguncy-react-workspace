/**
 * The black-box drift/restore regression (#179), end to end through the transport.
 *
 * This is the Epic's core acceptance loop, exercised against a faithful script-level fake of the
 * designer rather than the live product: it drives `executeCellSync` through the real
 * `createDesignerSyncPort` transport, answers the `execute_code` scripts the way Forguncy
 * `12.0.102.0` does (wholesale `cellTypeProps` replacement, empty-field omission, the command-body
 * drop on rewrite), and asserts on the wire payloads and the resulting designer state.
 *
 * What it establishes: declare bindings → sync writes them → a designer-side manual edit of a
 * declared field makes the default `sync` REFUSE with a field-level diff → `--restore` overwrites
 * the declared field while preserving the `eventHandlers` command body → undeclared fields are
 * byte-stable throughout. What it does not: that the real designer accepts the scripts — that is
 * the live gate, and AGENTS.md rule 7 keeps the two apart.
 */

import { describe, expect, it } from "vitest";

import { CELL_ARTIFACT_BANNER } from "@forguncy-react-workspace/cell-compiler";
import type { CompileCellResult } from "@forguncy-react-workspace/cell-compiler";
import type { NormalizedCellBindings } from "@forguncy-react-workspace/core";

import { createDesignerSyncPort } from "./designer-transport.ts";
import type { DesignerCallTool } from "./designer-transport.ts";
import { executeCellSync } from "./sync-execution.ts";

const TARGET = { pageName: "OrderPage", cell: "A1" } as const;

function artifact(code = "function App() { return null; }\n"): CompileCellResult {
  return { code: `${CELL_ARTIFACT_BANNER}\n${code}`, frontendLibraries: [] };
}

function declaration(): NormalizedCellBindings {
  return {
    declaredFields: ["properties", "eventHandlers"],
    properties: [{ propertyName: "title", propertyValue: "hello" }],
    eventHandlers: [{ eventName: "onClick", eventArgs: [{ name: "n" }] }],
  } as NormalizedCellBindings;
}

// ---------------------------------------------------------------------------
// A faithful designer, faked at the execute_code script layer.
//
// The fake implements the measured platform semantics, not a convenient subset: wholesale
// replacement of cellTypeProps on write, omission of empty binding fields on read, and the
// command-body drop when an eventHandlers array is rewritten without the body. That fidelity is
// what makes "the merge preserved the body" a statement about the transport rather than about the
// fake.
// ---------------------------------------------------------------------------

interface DesignerCell {
  cellTypeProps: Record<string, unknown>;
}

function createFakeDesigner() {
  const cells = new Map<string, DesignerCell>();
  const key = (pageName: string, cell: string) => `${pageName}::${cell}`;

  // The write: replace cellTypeProps wholesale with the payload's, then apply the platform's
  // read-back normalizations so a subsequent read returns what the product would — not what was
  // literally written. Two are load-bearing for this regression:
  //
  // - `properties[].propertyValue`: a bare cell reference is page-qualified on write (`=A1` →
  //   `='<page>'!A1`). Without this the formula canonicalization is never exercised.
  // - `libraries`: persisted and read back in the comma-space form.
  //
  // Empty arrays/objects and `null` are stored and then omitted on *read*, matching the product.
  function applySetCells(payload: {
    pageName: string;
    cells: readonly { cell: string; cellTypeProps: Record<string, unknown> }[];
  }): void {
    for (const cell of payload.cells) {
      const stored: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cell.cellTypeProps)) {
        if (k === "properties" && Array.isArray(v)) {
          stored[k] = v.map(entry => {
            if (typeof entry !== "object" || entry === null) return entry;
            const copy = { ...(entry as Record<string, unknown>) };
            const pv = copy.propertyValue;
            if (typeof pv === "string" && /^=\$?[A-Za-z]{1,3}\$?\d+$/.test(pv)) {
              copy.propertyValue = `='${payload.pageName}'!${pv.slice(1)}`;
            }
            return copy;
          });
        } else if (k === "libraries" && typeof v === "string") {
          stored[k] = v
            .split(",")
            .map(segment => segment.trim())
            .filter(segment => segment.length > 0)
            .join(", ");
        } else {
          stored[k] = v;
        }
      }
      cells.set(key(payload.pageName, cell.cell), { cellTypeProps: stored });
    }
  }

  // The read: report the cell as the product would — empty binding fields omitted. The transport
  // script embeds the locator as a top-level `cell` variable (it is the read's `range` argument),
  // so the lookup keys on that — matching how the write keys on its payload's `cells[].cell`.
  function applyGetCells(pageName: string, cellRef: string): { cells: readonly unknown[] } {
    const cell = cells.get(key(pageName, cellRef));
    if (cell === undefined) return { cells: [] };
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cell.cellTypeProps)) {
      // The product omits empty arrays and empty objects for these fields.
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
      if (v === null) continue;
      props[k] = v;
    }
    return { cells: [{ row: 0, col: 0, cellType: "ReactCellType", cellTypeProps: props }] };
  }

  const callTool: DesignerCallTool = async (_name, args) => {
    const script = args.code;
    const respond = (value: unknown) => ({
      result: { isError: false, content: [{ type: "text", text: JSON.stringify({ status: "success", result: value }) }] },
    });
    // Extract the embedded payload from the script (`const x = {...};` lines) the way the designer
    // would receive it.
    const payloads: Record<string, unknown> = {};
    for (const line of script.split("\n")) {
      const match = /^const (\w+) = (.*);$/.exec(line);
      if (!match) continue;
      try {
        payloads[match[1]!] = JSON.parse(match[2]!);
      } catch {
        // Not every `const` is an embedded payload — the generation script embeds arrow-function
        // source (`const relay = (answer) => …`), which is JavaScript rather than JSON. Only the
        // data payloads parse, and only they are read below, so a non-JSON const is simply skipped.
      }
    }

    if (script.includes("api.page.getCells")) {
      return respond(applyGetCells(payloads.pageName as string, payloads.cell as string));
    }
    if (script.includes("api.page.setCells")) {
      applySetCells(
        payloads.payload as {
          pageName: string;
          cells: readonly { cell: string; cellTypeProps: Record<string, unknown> }[];
        },
      );
      return respond({ message: "1 cell(s) set" });
    }
    if (script.includes("api.app.listFrontendLibraries")) return respond([]);
    if (script.includes("api.app.getProjectSaveStatus")) return respond({ containsUnsavedChanges: false });
    if (script.includes("api.app.checkProjectErrors")) return respond({ errorCount: 0 });
    if (script.includes("api.app.generateProject") || script.includes("api.app.generatePageAsync")) {
      return respond({ url: "http://localhost:63982/Forguncy" });
    }
    if (script.includes("api.app.saveProject")) return respond({ saved: true });
    throw new Error(`unhandled script: ${script}`);
  };

  return {
    callTool,
    /** The cell's current binding-bearing props, as a designer inspection would see them. */
    inspect(cellKey: string): Record<string, unknown> {
      const cell = cells.get(cellKey);
      return cell === undefined ? {} : { ...cell.cellTypeProps };
    },
    /** Simulate a designer-side manual edit, the way a person would in the GUI. */
    designerEdit(cell: string, field: string, value: unknown): void {
      const k = key(TARGET.pageName, cell);
      const existing = cells.get(k);
      if (existing) existing.cellTypeProps[field] = value;
    },
    /** Attach a command tree to an event, as the designer does when wiring a page command. */
    attachCommandBody(cell: string, eventName: string, body: unknown): void {
      const k = key(TARGET.pageName, cell);
      const existing = cells.get(k);
      if (!existing) return;
      const handlers = (existing.cellTypeProps.eventHandlers as readonly Record<string, unknown>[] | undefined) ?? [];
      existing.cellTypeProps.eventHandlers = handlers.map(entry =>
        entry.eventName === eventName ? { ...entry, eventHandler: body } : entry,
      );
    },
  };
}

function syncOptions(
  port: ReturnType<typeof createDesignerSyncPort>,
  overwrite?: "restore" | "restore-all" | "force" | "preserve-designer-edits",
) {
  return {
    target: TARGET,
    artifact: artifact(),
    decisions: [],
    bindings: declaration(),
    port,
    ...(overwrite === undefined ? {} : { overwrite }),
  };
}

const COMMAND_BODY = {
  commandType: "ServerCommand",
  serverCommandName: "刷新数据",
  commandList: [{ commandType: "NOPCommand", parametricParameters: [{ name: "x", parameterValue: "1" }] }],
};

describe("the drift/restore loop, end to end through the transport", () => {
  it("writes declared bindings on the first sync, preserving nothing yet", async () => {
    const designer = createFakeDesigner();
    const port = createDesignerSyncPort({ callTool: designer.callTool });

    const run = await executeCellSync(syncOptions(port));
    expect(run.status).toBe("written");

    const written = designer.inspect(`${TARGET.pageName}::${TARGET.cell}`);
    expect(written.properties).toEqual([{ propertyName: "title", propertyValue: "hello" }]);
    expect(written.eventHandlers).toEqual([{ eventName: "onClick", eventArgs: [{ name: "n" }] }]);
  });

  it("default sync REFUSES with a field-level diff after a designer edit, overwriting nothing", async () => {
    const designer = createFakeDesigner();
    const port = createDesignerSyncPort({ callTool: designer.callTool });
    await executeCellSync(syncOptions(port));

    // The designer edits a declared binding by hand.
    designer.designerEdit(TARGET.cell, "properties", [{ propertyName: "title", propertyValue: "EDITED-BY-HAND" }]);

    const run = await executeCellSync(syncOptions(port));
    expect(run.status).toBe("refused");
    if (run.status !== "refused") return;
    // The divergence names the exact field, and the value it was changed to.
    expect(run.plan.divergence.kind).toBe("binding-drifted");
    expect(run.plan.divergence.bindingDrift.map(entry => entry.field)).toEqual(["properties"]);

    // And nothing was overwritten: the designer's edit is still there.
    const after = designer.inspect(`${TARGET.pageName}::${TARGET.cell}`);
    expect(after.properties).toEqual([{ propertyName: "title", propertyValue: "EDITED-BY-HAND" }]);
  });

  it("--restore overwrites the declared binding AND preserves the eventHandler command body", async () => {
    const designer = createFakeDesigner();
    const port = createDesignerSyncPort({ callTool: designer.callTool });
    await executeCellSync(syncOptions(port));

    // The designer attaches a command tree to the declared event, then edits a declared field.
    designer.attachCommandBody(TARGET.cell, "onClick", COMMAND_BODY);
    designer.designerEdit(TARGET.cell, "properties", [{ propertyName: "title", propertyValue: "EDITED-BY-HAND" }]);

    const run = await executeCellSync(syncOptions(port, "restore"));
    expect(run.status).toBe("written");

    const after = designer.inspect(`${TARGET.pageName}::${TARGET.cell}`);
    // The declared field is restored to the repository's value…
    expect(after.properties).toEqual([{ propertyName: "title", propertyValue: "hello" }]);
    // …and the command body survived the rewrite.
    const handlers = after.eventHandlers as readonly Record<string, unknown>[];
    expect(handlers[0]?.eventHandler).toEqual(COMMAND_BODY);
    // The event contract is the repository's.
    expect(handlers[0]?.eventName).toBe("onClick");
    expect(handlers[0]?.eventArgs).toEqual([{ name: "n" }]);
  });

  it("--restore-all overwrites the binding AND clears the command body", async () => {
    const designer = createFakeDesigner();
    const port = createDesignerSyncPort({ callTool: designer.callTool });
    await executeCellSync(syncOptions(port));

    designer.attachCommandBody(TARGET.cell, "onClick", COMMAND_BODY);
    designer.designerEdit(TARGET.cell, "properties", [{ propertyName: "title", propertyValue: "EDITED-BY-HAND" }]);

    const run = await executeCellSync(syncOptions(port, "restore-all"));
    expect(run.status).toBe("written");

    const after = designer.inspect(`${TARGET.pageName}::${TARGET.cell}`);
    expect(after.properties).toEqual([{ propertyName: "title", propertyValue: "hello" }]);
    const handlers = after.eventHandlers as readonly Record<string, unknown>[];
    expect(handlers[0]?.eventHandler).toBeUndefined();
  });

  it("leaves undeclared binding fields byte-stable throughout the whole flow", async () => {
    const designer = createFakeDesigner();
    const port = createDesignerSyncPort({ callTool: designer.callTool });
    await executeCellSync(syncOptions(port));

    // The designer sets an UNDECLARED field (permissions) and edits a declared one.
    const customPermissions = [{ name: "订单.读取", allowRoles: ["Admin", "Sales"] }];
    designer.designerEdit(TARGET.cell, "permissions", customPermissions);
    designer.designerEdit(TARGET.cell, "properties", [{ propertyName: "title", propertyValue: "EDITED" }]);

    // Restore the declared drift. permissions is pass-through and must be untouched.
    const run = await executeCellSync(syncOptions(port, "restore"));
    expect(run.status).toBe("written");

    const after = designer.inspect(`${TARGET.pageName}::${TARGET.cell}`);
    expect(after.properties).toEqual([{ propertyName: "title", propertyValue: "hello" }]);
    expect(after.permissions).toEqual(customPermissions);
  });

  it("a no-drift re-sync is unchanged, not a rewrite", async () => {
    const designer = createFakeDesigner();
    const port = createDesignerSyncPort({ callTool: designer.callTool });
    await executeCellSync(syncOptions(port));
    designer.attachCommandBody(TARGET.cell, "onClick", COMMAND_BODY);

    // Nothing declared drifted (the command body is not drift — it is not part of the declaration).
    // Re-syncing takes the unchanged path rather than rewriting.
    const run = await executeCellSync(syncOptions(port));
    expect(run.status).toBe("unchanged");
  });
});
