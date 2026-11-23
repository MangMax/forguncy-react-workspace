import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";

import { cellVirtualModuleId } from "@forguncy-react-workspace/vite-plugin-fgc";

import type { ForguncyConfig } from "@forguncy-react-workspace/core";

import { createDevCellResourcePolicy } from "./cell-assets.ts";
import { canonicalTempProject, removeTempProject } from "./temp-project.ts";
import { devHarness } from "./vite-plugin.ts";

/**
 * #98's dev half, against a **real Vite server**: the same stylesheet and asset that the compiler
 * inlines are served locally with the same meaning, and the same unsupported inputs are refused.
 *
 * Decision sources: GitHub Issues
 * - #98 — "基础资源：让 CSS 与小型静态资源在本地和单文件 Cell 中一致工作"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/98), which requires the *same*
 *   component to work in both paths and asks for the support set to be explicit rather than
 *   implied.
 *
 * ## Why a server rather than calling the plugin's hooks
 *
 * The policy is a hook pair (`load`, `transform`), and a unit test of either would pass for a
 * plugin Vite never calls them on. The two behaviours that matter are both properties of *Vite's*
 * pipeline: that a static import of the asset module yields the data URI the compiler produces,
 * and that a `url(...)` inside a real CSS module is rewritten before Vite composes it. Both are
 * only observable through `transformRequest`, which is why this file pays for a server.
 *
 * ## Why these servers do not listen
 *
 * `transformRequest` needs no port, and `server.listen()` is the one thing that hangs or refuses
 * on a sandboxed Windows CI leg (see `vite-plugin.test.ts` for the measured failure). The
 * middleware-mode form exercises exactly the code the browser form would.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "tests", "fixtures", "resources");
const cellRoot = join(fixtureRoot, "cells", "probe", "src");

/**
 * Every case here builds a **real Vite dev server**, so Vitest's 5 s unit-test default is the
 * wrong budget and the tests are being graded against the wrong thing (#150).
 *
 * Measured on the toolchain upgrade: the same cases take 1–2 s on a developer machine but crossed
 * 5 s on CI's cold runners — `vite-plugin.test.ts`'s 60 cases went from 20.8 s to 93.4 s on Linux
 * and 18 of them timed out on Windows, while still passing wherever they finished. The cost is
 * `createServer` (≈0.9 s each, unchanged between toolchains when measured directly) plus the
 * harness `config()` hook's install-graph read, which is a real integration cost this file exists
 * to exercise rather than overhead to delete.
 *
 * Set on the file rather than as a fifth argument on every case, because the subject is uniform:
 * unlike the `CASE_TIMEOUT_MS` suites, there is no single expensive case to single out — the
 * default is simply too small for any of them on a loaded runner.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** The bytes the committed PNG contains, so the data URI can be compared byte for byte. */
const PIXEL_BYTES = readFileSync(join(cellRoot, "pixel.png"));
const PIXEL_DATA_URI = `data:image/png;base64,${PIXEL_BYTES.toString("base64")}`;

const config: ForguncyConfig = {
  cells: {
    probe: {
      entry: "./cells/probe/src/index.tsx",
      target: { pageName: "探针", cell: "A1" },
    },
  },
};

const servers: ViteDevServer[] = [];
const cacheDirs: string[] = [];

async function serverFor(entry: string | undefined): Promise<ViteDevServer> {
  // Keep Vite's optimizer cache outside the workspace package so parallel tests that digest
  // linked workspace packages (`linkTargetsDigest`) never observe transient `.vite/deps_temp_*`
  // writes inside `packages/dev-harness/tests/fixtures/resources`.
  const cacheDir = canonicalTempProject("fgc-asset-policy-vite-");
  cacheDirs.push(cacheDir);
  const server = await createServer({
    root: fixtureRoot,
    cacheDir,
    logLevel: "silent",
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    plugins: [
      devHarness({
        config: entry === undefined ? config : { ...config, cells: { probe: { ...config.cells!.probe!, entry } } },
      }) as never,
    ],
  });
  servers.push(server);
  return server;
}

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await Promise.all(cacheDirs.map(dir => removeTempProject(dir)));
}, 30_000);

/** The transformed source of one module, or the error Vite rejected it with. */
async function transform(server: ViteDevServer, id: string): Promise<string> {
  const resolved = await server.pluginContainer.resolveId(id, undefined);
  expect(resolved, `could not resolve "${id}"`).not.toBeNull();
  const result = await server.transformRequest(resolved!.id);
  expect(result, `transformRequest produced nothing for "${id}"`).not.toBeNull();
  return result!.code;
}

describe("#98: local dev serves the same CSS and asset the compiler inlines", () => {
  it("serves the entry with the stylesheet and the asset as real module ids", async () => {
    const server = await serverFor(undefined);
    // Vite builds the graph lazily, so the entry's text names its imports and the modules behind
    // them carry the inlined values. The assertion here is traceability: a `/@fs/` URL would work
    // locally and have no counterpart in the artifact, which is the drift this policy removes.
    const code = await transform(server, join(cellRoot, "index.tsx"));
    expect(code).toContain("/cells/probe/src/panel.css");
    expect(code).toMatch(/pixel\.png(\?import)?/);
    expect(code).not.toMatch(/\/@fs\/.*pixel\.png/);
  });

  it("imports the asset module as the same data URI the compiler's default export is", async () => {
    const server = await serverFor(undefined);
    const asset = await transform(server, join(cellRoot, "pixel.png"));
    expect(asset).toContain(PIXEL_DATA_URI);
  });

  it("rewrites the stylesheet's references before Vite composes it", async () => {
    const server = await serverFor(undefined);
    const css = await transform(server, join(cellRoot, "panel.css"));

    // Vite's CSS pipeline wraps the sheet, so this asserts on the emitted module rather than on
    // the raw file: what matters is that the reference reached it as a data URI.
    expect(css).toContain("data:image/png;base64,");
    expect(css).not.toContain("./pixel.png");
    expect(css).toContain("dev-resource-probe");
  });

  it("serves the Cell entry through the harness seam with the stylesheet and asset attached", async () => {
    const server = await serverFor(undefined);
    const code = await transform(server, cellVirtualModuleId("probe"));
    // The Cell module is served — the proof that the resource imports did not break the graph.
    expect(code.length).toBeGreaterThan(0);
  });
});

describe("#98: local dev refuses what the compiler refuses", () => {
  it("refuses a CSS Module with the reason and the direction", async () => {
    const server = await serverFor("./cells/probe/src/module-entry.tsx");
    await expect(transform(server, join(cellRoot, "module.module.css"))).rejects.toThrow(
      /explicitly rejects CSS Modules/,
    );
  });

  it("names `extension` and `replace` in the refusal so the next action is not a guess", async () => {
    const server = await serverFor("./cells/probe/src/module-entry.tsx");
    await expect(transform(server, join(cellRoot, "module.module.css"))).rejects.toThrow(/extension/);
  });

  it("still serves a plain stylesheet in the same project", async () => {
    // The control: the refusal above is about the module, not about the server being broken.
    const server = await serverFor(undefined);
    const css = await transform(server, join(cellRoot, "panel.css"));
    expect(css).toContain("data:image/png;base64,");
  });
});

describe("#98: local dev and the compiled artifact produce the same asset value", () => {
  it("the harness asset module's default export is the compiler's data URI", async () => {
    // The acceptance criterion's "same source, same result", reduced to the one value that has to
    // agree. A CSS import on both paths installs a stylesheet; an asset import has to arrive in
    // the component as the *same string*, so that is what is compared.
    const server = await serverFor(undefined);
    const asset = await transform(server, join(cellRoot, "pixel.png"));
    // The URI is taken from the module's own default export rather than matched by a loose
    // regex over the text, so a change in Vite's module wrapper cannot make this pass without
    // an export to compare.
    const exported = /export default\s+("[^"]*")/.exec(asset)?.[1];
    expect(exported, `no default export in the asset module: ${asset}`).toBeDefined();
    expect(JSON.parse(exported!)).toBe(PIXEL_DATA_URI);
  });
});

/**
 * The policy as a unit, for the inputs a Vite request cannot reach cheaply.
 *
 * The server tests above exercise the two hooks through Vite; these cover the branches whose only
 * observable through a request would be "the server refused to start", and they assert the
 * *message* rather than only that something threw — an actionable refusal is the issue's
 * criterion, and "it threw" is satisfied by an opaque error too.
 */
describe("#98: the dev resource policy's refusals name the next action", () => {
  const policy = createDevCellResourcePolicy();

  it("refuses a Worker query on any file, including an ordinary `.js`", () => {
    expect(() => policy.load("/project/worker.js?worker")).toThrow(/extension/);
  });

  it("refuses `?url` on a supported asset", () => {
    expect(() => policy.load("/project/pixel.png?url")).toThrow(/\?url/);
    expect(() => policy.load("/project/pixel.png?url")).toThrow(/extension/);
  });

  it("refuses a preprocessor stylesheet", () => {
    expect(() => policy.load("/project/panel.scss")).toThrow(/plain CSS only/);
  });

  it("refuses a remote URL in a stylesheet with the CDN reason", async () => {
    await expect(
      policy.transform('.x { background: url("https://cdn.example/x.png") }', "/project/a.css"),
    ).rejects.toThrow(/CDN/);
  });

  it("refuses an oversized stylesheet reference with the measured size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fgc-dev-resource-"));
    const pixel = readFileSync(join(cellRoot, "pixel.png"));
    writeFileSync(join(dir, "big.png"), pixel);
    writeFileSync(join(dir, "a.css"), '.x { background: url("./big.png") }');

    await expect(policy.transform(readFileSync(join(dir, "a.css"), "utf8"), join(dir, "a.css"))).resolves.toEqual({
      code: '.x { background: url("data:image/png;base64,' + pixel.toString("base64") + '") }',
      map: null,
    });
  });

  it("answers `null` for a stylesheet it does not own, so Vite's pipeline keeps it", async () => {
    await expect(policy.transform(".x { color: red }", "/project/b.module.css")).resolves.toBeNull();
    await expect(policy.transform("export const x = 1;", "/project/c.ts")).resolves.toBeNull();
  });

  it("answers `null` from `load` for a file that is not a resource", () => {
    expect(policy.load("/project/App.tsx")).toBeNull();
  });
});
