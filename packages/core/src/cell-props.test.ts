import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CELL_FORGUNCY_PROP_KEYS, CELL_PROPS_BASE_KEYS } from "./cell-props.ts";
import { CELL_FORGUNCY_FACADE, CELL_PROPS_KEY_ORDER } from "./runtime-contract.ts";

/**
 * The key tuples `core/cell-props` owns (#124).
 *
 * `runtime-contract.ts` is the evidence record that explains these keys, and it now reads them
 * from this leaf instead of defining them. The separation exists so a production Cell can import
 * the tuples without the record; the risk it introduces is that the two drift — a restated tuple
 * here and a differently-ordered record there — which is why the equality is asserted rather
 * than assumed, and why the leaf is asserted to have no imports at all.
 */

const here = dirname(fileURLToPath(import.meta.url));

describe("cell-props is the record's own tuple, not a second definition", () => {
  it("is the exact tuple the props record exposes", () => {
    // Identity, not deep equality: these are the same array object, because the record assigns
    // this module's binding rather than copying it. A future edit that made them equal-but-separate
    // would pass a deep comparison while reintroducing the drift this module exists to remove.
    expect(CELL_PROPS_KEY_ORDER.baseKeys).toBe(CELL_PROPS_BASE_KEYS);
    expect(CELL_FORGUNCY_FACADE.keys).toBe(CELL_FORGUNCY_PROP_KEYS);
  });

  it("pins the observed keys and their order", () => {
    // The literals are here as well as in `runtime-contract.test.ts` because this module is now
    // what a Cell reads: a reorder introduced here would ship into an artifact without the
    // evidence record ever being loaded. The values are #5's, unchanged.
    expect(CELL_PROPS_BASE_KEYS).toEqual(["Forguncy", "Permissions", "ServerCommands", "ImageContext"]);
    expect(CELL_FORGUNCY_PROP_KEYS).toHaveLength(14);
    expect(CELL_FORGUNCY_PROP_KEYS.slice(0, 3)).toEqual([
      "ConvertDateToOADate",
      "ConvertOADateToDate",
      "ConvertToCssColor",
    ]);
  });

  it("imports nothing, which is why it is a leaf", () => {
    // A single import — of an evidence table, a governance record or a `node:` builtin — would
    // put the record back into a production Cell's graph, and the artifact guard in
    // `cell-compiler` would stop being a property of the module structure.  The assertion is on
    // the source because "this file has no dependencies" has no runtime observable.
    const source = readFileSync(join(here, "cell-props.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    expect(source).not.toMatch(/\bfrom\s+"/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });
});
