/**
 * The build manifest's resource order is code-unit based, not locale based (#155).
 *
 * Decision source: GitHub Issue #155
 * (https://github.com/MangMax/forguncy-react-workspace/issues/155), under the parent spec #152
 * (https://github.com/MangMax/forguncy-react-workspace/issues/152): the manifest sorted with
 * `localeCompare`, which contradicts the repository's determinism rule — every other ordered
 * output compares code units — so two builds of one project could produce different manifests on
 * two machines with different locales.
 *
 * ## Why the names are chosen the way they are
 *
 * A locale-sensitive comparison and a code-unit comparison disagree on exactly the inputs below,
 * and each disagreement is a separate class:
 *
 * - **case** — `localeCompare` orders `a` before `B`; code units put every upper-case ASCII letter
 *   first (`B` = 66 before `a` = 97);
 * - **non-ASCII** — `localeCompare` sorts `Ä` among the `a`s; code units place it after `z`
 *   (196 > 122).
 *
 * So a manifest of `B.png`, `a.png`, `z.png`, `Ä.png` reads `B, a, z, Ä` under the rule and
 * `a, Ä, B, z` under the locale. The assertion is on the written file rather than on a helper,
 * because the manifest is what a reader diffs.
 *
 * The project is staged under the example's git-ignored `.fgc/` for the reason
 * `integration-regression.test.ts` records: bare imports in the config and in the Cell resolve by
 * walking up to the example's `node_modules`, which a copy in `os.tmpdir()` could not do without
 * rebuilding the install.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { buildProject } from "./index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..");
const EXAMPLE_ROOT = join(REPOSITORY_ROOT, "examples", "consumer-project");

/** A real compile through Rolldown for one Cell and four resources. */
const CASE_TIMEOUT_MS = 120_000;

const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The smallest 1×1 PNG, so each asset is a real file the compiler can inline. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

function scratchProject(name: string): string {
  mkdirSync(join(EXAMPLE_ROOT, ".fgc"), { recursive: true });
  const root = mkdtempSync(join(EXAMPLE_ROOT, ".fgc", `${name}-`));
  scratchRoots.push(root);
  return root;
}

/**
 * A project whose Cell imports four assets and one stylesheet.
 *
 * The stylesheet makes the `kind` half of the order observable as well: every `asset` reads before
 * every `style`, because the comparison is `kind` then `fileName`.
 */
function stageProject(root: string): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "manifest-order", version: "0.0.0", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "forguncy.config.ts"),
    `import { defineForguncyConfig } from "@forguncy-react-workspace/core";

export default defineForguncyConfig({
  runtime: { forguncyVersion: "12.0.102", projectAlias: "manifest-order" },
  cells: {
    order: { entry: "./cells/order/App.tsx", target: { pageName: "Order", cell: "A1" } },
  },
});
`,
    "utf8",
  );

  const sourceDirectory = join(root, "cells", "order");
  mkdirSync(sourceDirectory, { recursive: true });
  for (const fileName of ["B.png", "a.png", "z.png", "Ä.png"]) {
    writeFileSync(join(sourceDirectory, fileName), ONE_PIXEL_PNG);
  }
  writeFileSync(join(sourceDirectory, "Style.css"), ".order { color: #111; }\n", "utf8");
  writeFileSync(
    join(sourceDirectory, "App.tsx"),
    `import "./Style.css";
import b from "./B.png";
import a from "./a.png";
import z from "./z.png";
import ae from "./Ä.png";

export function App() {
  return (
    <ul>
      <li>{b}</li>
      <li>{a}</li>
      <li>{z}</li>
      <li>{ae}</li>
    </ul>
  );
}
`,
    "utf8",
  );
}

describe("the build manifest's resource order is code units, not locale", () => {
  it("orders assets by code units before the stylesheet", async () => {
    const root = scratchProject("manifest-order");
    stageProject(root);

    const report = await buildProject({ root });
    expect(report.cells.map(cell => cell.status)).toEqual(["compiled"]);

    const manifest = JSON.parse(readFileSync(report.manifestPath ?? "", "utf8")) as {
      cells: readonly { artifact: { resources: readonly { kind: string; fileName: string }[] } | null }[];
    };
    const resources = manifest.cells[0]?.artifact?.resources ?? [];

    // `B` before `a` (upper-case first) and `Ä` after `z` (196 > 122) are the two places a locale
    // comparison disagrees; `localeCompare` would read `a, Ä, B, z`.
    expect(resources.map(resource => resource.fileName)).toEqual(["B.png", "a.png", "z.png", "Ä.png", "Style.css"]);
    expect(resources.map(resource => resource.kind)).toEqual(["asset", "asset", "asset", "asset", "style"]);
  }, CASE_TIMEOUT_MS);
});
