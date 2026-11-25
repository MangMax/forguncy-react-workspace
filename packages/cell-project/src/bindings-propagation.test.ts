/**
 * The host-binding declaration, threaded into the `build`/`plan` outputs (#178).
 *
 * Decision source: GitHub Issue #178 — "Implement: forguncy.config.ts 声明式宿主绑定与校验"
 * (https://github.com/MangMax/forguncy-react-workspace/issues/178), under Epic #175
 * (https://github.com/MangMax/forguncy-react-workspace/issues/175).
 *
 * The ticket's propagation criterion is what this file is organised around: the declaration a
 * project writes in `forguncy.config.ts` must be readable, per Cell, from the outputs the sync
 * side consumes — the build report, the written manifest, and the plan report. The tests are
 * ordered by that path rather than by function:
 *
 * - **the build report** carries the declaration per Cell with its three states readable;
 * - **the written manifest** is the same answer in serialization — `bindings` is present per
 *   Cell *unconditionally*, because the difference between "this Cell takes over nothing" and
 *   "this manifest predates the feature" is the backward-compatibility answer #179 reads;
 * - **the plan report** carries the same declaration through unchanged — the plan reports, it
 *   never re-decides;
 * - **backward compatibility** is a property of the output, not the input: a config with no
 *   `bindings` key compiles byte-identically to before (the artifact is untouched by a
 *   declaration it never had) and reports `bindings: undefined` / manifest `null` rather than
 *   an invented declaration.
 *
 * The projects are staged under the example's git-ignored `.fgc/` for the reason
 * `integration-regression.test.ts` records: bare imports in the config and in the Cell resolve
 * by walking up to the example's `node_modules`, which a copy in `os.tmpdir()` could not do
 * without rebuilding the install.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { buildProject, compileProject, planProject } from "./index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..");
const EXAMPLE_ROOT = join(REPOSITORY_ROOT, "examples", "consumer-project");

/** A real compile through Rolldown for one small Cell. */
const CASE_TIMEOUT_MS = 120_000;

const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratchProject(name: string): string {
  mkdirSync(join(EXAMPLE_ROOT, ".fgc"), { recursive: true });
  const root = mkdtempSync(join(EXAMPLE_ROOT, ".fgc", `${name}-`));
  scratchRoots.push(root);
  return root;
}

/** The smallest compiling project: one trivial Cell, one config. */
function stageProject(root: string, cellsConfig: string): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "bindings-propagation", version: "0.0.0", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "forguncy.config.ts"),
    `import { defineForguncyConfig } from "@forguncy-react-workspace/core";

export default defineForguncyConfig({
  runtime: { forguncyVersion: "12.0.102", projectAlias: "bindings-propagation" },
  cells: {
${cellsConfig}
  },
});
`,
    "utf8",
  );

  const sourceDirectory = join(root, "cells", "board");
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(
    join(sourceDirectory, "App.tsx"),
    `export function App() {
  return <div>board</div>;
}
`,
    "utf8",
  );
}

/** A Cell declaration declaring every field class: content, empty arrays, and an empty object. */
const DECLARED_CELL = `    board: {
      entry: "./cells/board/App.tsx",
      target: { pageName: "销售看板", cell: "B2" },
      bindings: {
        properties: [{ propertyName: "title", propertyValue: "=\\"总览\\"", exampleValue: "订单总览" }],
        eventHandlers: [{ eventName: "onSelect", eventArgs: [{ name: "rowId" }] }],
        permissions: [],
        availableServerCommands: [{ name: "RecalculateOrders" }],
        dataSources: [],
        uploadLimit: {},
        libraries: "AntDesign",
      },
    },`;

describe("the build output carries the declaration per Cell", () => {
  it("reports the three states per field beside the validated content", async () => {
    const root = scratchProject("declared");
    stageProject(root, DECLARED_CELL);

    const report = await buildProject({ root });
    expect(report.cells.map(cell => cell.status)).toEqual(["compiled"]);

    const cell = report.cells[0]!;
    expect(cell.bindings).toBeDefined();
    expect(cell.bindings?.declaredFields).toEqual([
      "dataSources",
      "permissions",
      "availableServerCommands",
      "properties",
      "eventHandlers",
      "uploadLimit",
      "libraries",
    ]);
    expect(cell.bindings?.states).toEqual({
      dataSources: "managed-empty",
      permissions: "managed-empty",
      availableServerCommands: "managed",
      properties: "managed",
      eventHandlers: "managed",
      uploadLimit: "managed-empty",
      libraries: "managed",
    });
    // The content is the validated declaration, verbatim — the empty arrays included, because
    // dropping them is exactly the pass-through demotion the model exists to prevent.
    expect(cell.bindings?.content.properties).toEqual([
      { propertyName: "title", propertyValue: '="总览"', exampleValue: "订单总览" },
    ]);
    expect(cell.bindings?.content.permissions).toEqual([]);
    expect(cell.bindings?.content.uploadLimit).toEqual({});
    expect(cell.bindings?.content.libraries).toBe("AntDesign");
  }, CASE_TIMEOUT_MS);

  it("an undeclared Cell reports bindings: undefined — pass-through, not an invented empty declaration", async () => {
    const root = scratchProject("undeclared");
    stageProject(root, `    board: { entry: "./cells/board/App.tsx", target: { pageName: "销售看板", cell: "B2" } },`);

    const report = await buildProject({ root });

    expect(report.cells[0]?.status).toBe("compiled");
    expect(report.cells[0]?.bindings).toBeUndefined();
  }, CASE_TIMEOUT_MS);

  it("the declaration reaches the report even when the Cell fails to compile", async () => {
    // Config truth is not a build product: a consumer reconciling the manifest against the
    // config must not lose the declaration to a compile failure.
    const root = scratchProject("rejected");
    stageProject(root, DECLARED_CELL);
    writeFileSync(
      join(root, "cells", "board", "App.tsx"),
      `import { nope } from "totally-undecided-package";
export function App() {
  return <div>{nope}</div>;
}
`,
      "utf8",
    );

    const report = await buildProject({ root });

    expect(report.cells[0]?.status).toBe("rejected");
    expect(report.cells[0]?.bindings?.declaredFields).toContain("properties");
  }, CASE_TIMEOUT_MS);
});

describe("the written manifest carries the declaration, unconditionally", () => {
  it("serializes the declared Cell's bindings and the undeclared Cell's null in one manifest", async () => {
    const root = scratchProject("manifest");
    stageProject(
      root,
      [
        DECLARED_CELL,
        `    plain: { entry: "./cells/plain/App.tsx", target: { pageName: "销售看板", cell: "C3" } },`,
      ].join("\n"),
    );
    const plainDirectory = join(root, "cells", "plain");
    mkdirSync(plainDirectory, { recursive: true });
    writeFileSync(join(plainDirectory, "App.tsx"), `export function App() { return <div>plain</div>; }\n`, "utf8");

    const report = await buildProject({ root });
    expect(report.cells.map(cell => cell.status)).toEqual(["compiled", "compiled"]);

    const manifest = JSON.parse(readFileSync(report.manifestPath ?? "", "utf8")) as {
      schemaVersion: number;
      cells: readonly {
        cellId: string;
        bindings: {
          declaredFields: readonly string[];
          states: Record<string, string>;
          content: Record<string, unknown>;
        } | null;
      }[];
    };

    // v2 rather than v1-with-a-field: a reader that does not understand the bindings half must
    // not read the manifest at all, which is what a version is for.
    expect(manifest.schemaVersion).toBe(2);

    const declared = manifest.cells.find(cell => cell.cellId === "board");
    expect(declared?.bindings?.declaredFields).toContain("properties");
    expect(declared?.bindings?.states.permissions).toBe("managed-empty");
    expect(declared?.bindings?.states.dataSources).toBe("managed-empty");
    // Empty content survives serialization — the demotion-to-pass-through must not happen in JSON either.
    expect((declared?.bindings?.content as Record<string, unknown>).permissions).toEqual([]);
    expect((declared?.bindings?.content as Record<string, unknown>).uploadLimit).toEqual({});

    const plain = manifest.cells.find(cell => cell.cellId === "plain");
    // `null`, and present as a key: "takes over nothing" and "predates the feature" must never
    // be the same reading.
    expect(plain).toBeDefined();
    expect(Object.hasOwn(plain!, "bindings")).toBe(true);
    expect(plain?.bindings).toBeNull();
  }, CASE_TIMEOUT_MS);
});

describe("the plan output carries the same declaration through", () => {
  it("reports bindings per planned Cell, verbatim from the build", async () => {
    const root = scratchProject("planned");
    stageProject(root, DECLARED_CELL);

    const build = await compileProject({ root, write: false });
    const plan = planProject(build);

    const cell = plan.report.cells[0]!;
    expect(cell.bindings).toBeDefined();
    expect(cell.bindings?.declaredFields).toEqual(build.report.cells[0]?.bindings?.declaredFields);
    expect(cell.bindings?.states.dataSources).toBe("managed-empty");
    // Verbatim — the plan reports the declaration, and re-deriving it would be a second copy.
    expect(cell.bindings?.content).toBe(build.report.cells[0]?.bindings?.content);
  }, CASE_TIMEOUT_MS);

  it("a plan over an undeclared Cell says nothing — pass-through stays invisible, not stated as empty", async () => {
    const root = scratchProject("plan-undeclared");
    stageProject(root, `    board: { entry: "./cells/board/App.tsx", target: { pageName: "销售看板", cell: "B2" } },`);

    const build = await compileProject({ root, write: false });
    const plan = planProject(build);

    expect(plan.report.cells[0]?.bindings).toBeUndefined();
  }, CASE_TIMEOUT_MS);
});

describe("backward compatibility — the declaration that was never written", () => {
  it("an undeclared Cell's artifact is byte-identical to its declared sibling's", async () => {
    // The proof that bindings is deployment metadata, not build input: the compiler never sees
    // it, so the same source compiles to the same artifact either way. If this ever diverges,
    // a project adopting the declaration would change what it deploys by declaring it — the
    // exact drift the Epic's "backward compatible" acceptance criterion forbids.
    const root = scratchProject("parity");
    stageProject(
      root,
      [
        `    declared: {
      entry: "./cells/board/App.tsx",
      target: { pageName: "销售看板", cell: "B2" },
      bindings: { properties: [{ propertyName: "title" }] },
    },`,
        `    plain: { entry: "./cells/plain/App.tsx", target: { pageName: "销售看板", cell: "C3" } },`,
      ].join("\n"),
    );
    const plainDirectory = join(root, "cells", "plain");
    mkdirSync(plainDirectory, { recursive: true });
    writeFileSync(
      join(plainDirectory, "App.tsx"),
      readFileSync(join(root, "cells", "board", "App.tsx"), "utf8"),
      "utf8",
    );

    const report = await buildProject({ root });
    expect(report.cells.map(cell => cell.status)).toEqual(["compiled", "compiled"]);

    const declaredArtifact = readFileSync(join(report.outDir ?? "", "declared.js"), "utf8");
    const plainArtifact = readFileSync(join(report.outDir ?? "", "plain.js"), "utf8");
    expect(plainArtifact).toBe(declaredArtifact);
  }, CASE_TIMEOUT_MS);
});
