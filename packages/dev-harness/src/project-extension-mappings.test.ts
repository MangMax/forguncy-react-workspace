import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";
import { createServer } from "vite";

import { RUNTIME_CONTRACT_TARGET } from "@forguncy-react-workspace/core";
import type { ForguncyConfig, LockedDependencyDecision } from "@forguncy-react-workspace/core";

import { removeTempProject } from "./temp-project.ts";
import { devHarness } from "./vite-plugin.ts";

/**
 * A custom project extension reaching the dev server's *own* audit and resolver (#87).
 *
 * Decision source: GitHub Issue #87 — "扩展集成：让 Skill、锁文件、本地替代与 MCP 校验消费同一项目映射"
 * (https://github.com/MangMax/forguncy-react-workspace/issues/87).
 *
 * ## What this file asserts that a function test cannot
 *
 * `extension-substitutions.test.ts` proves what a *declared* choice resolves to; this file
 * proves that a choice for a package only `forguncy.config.ts` maps survives the plugin's
 * startup path at all. Two stages run in `devHarness.configureServer` before any module is
 * served, and both used to read `core`'s built-in table rather than the registry's normalized
 * set:
 *
 * - the conformance audit, which reports `extension-library-not-verified` for a decision the
 *   project's own row binds — a **blocking** finding, so the server refused to start; and
 * - `extensionSubstitutions`, which threw `ExtensionSubstituteError` for the same reason.
 *
 * So the observable difference is "does `createServer` resolve?", which is exactly what the
 * harness promises a developer. The assertions below are therefore at the server boundary, and
 * deliberately not about the modules the page would fetch: this repository's local sandbox
 * cannot always open a localhost socket, and that limitation is not the subject here.
 *
 * What a green start is *not*: evidence that the extension exists or that a page publishes its
 * global. The fixture's row is a placeholder, the lock records a local probe, and #88 owns the
 * real-runtime half (AGENTS.md rules 6–7).
 */

const CHART_KIT = {
  packageName: "@example/chart-kit",
  libraryId: "example-chart-kit",
  globalName: "ExampleChartKit",
} as const;

/** The package's identity as a project row, in #85's committed-config shape. */
const PROJECT_ROW = {
  packageName: CHART_KIT.packageName,
  libraryId: CHART_KIT.libraryId,
  globalName: CHART_KIT.globalName,
  metadataSource: "verified-catalog",
  metadataReference: "MangMax/forguncy-react-library#example-chart-kit",
  verificationRule: "A verified catalog entry whose id and global a real listing confirms (#88).",
  verifiedBy: ["product-documentation"],
  note: "A project row the built-in table does not carry.",
} as const;

/** A legal `extension` record for the custom package, at the version the fixture installs. */
function extensionRecord(): LockedDependencyDecision {
  return {
    strategy: "extension",
    packageName: CHART_KIT.packageName,
    cellTarget: null,
    resolvedVersion: "1.0.0",
    globalName: CHART_KIT.globalName,
    libraryId: CHART_KIT.libraryId,
    probe: { status: "passed", fingerprint: "probe=inline-bundle;entry=x", versionIndependent: false },
    target: null,
    probedWith: { vitePlus: null },
    extension: { version: "1.0.0", identity: "sha256:fixture" },
    rejectedCandidate: null,
    rationale: "The extension publishes one page global, so a bundled copy is a second instance.",
    evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/report.md" }],
  } as LockedDependencyDecision;
}

/** A temp project with one Cell, the lock, and the package the lock records. */
async function projectWithCustomExtension(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dev-harness-custom-extension-"));
  onTestFinished(() => removeTempProject(root));

  await writeFile(
    join(root, "fgc.lock.json"),
    JSON.stringify({ schemaVersion: 1, decisions: [extensionRecord()] }),
    "utf8",
  );
  await mkdir(join(root, "cells", "probe", "src"), { recursive: true });
  await writeFile(join(root, "cells", "probe", "src", "App.tsx"), "export function App() { return null; }\n", "utf8");

  const pkg = join(root, "node_modules", "@example", "chart-kit");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: CHART_KIT.packageName, version: "1.0.0", type: "module", main: "index.js" }),
    "utf8",
  );
  await writeFile(join(pkg, "index.js"), "export const FIXTURE = true;\n", "utf8");

  // The substitute the choice names, so `substitute` is honoured rather than falling into the
  // `unavailable` branch — the assertion is about *which table* answered, not about whether a
  // file happens to exist.
  await mkdir(join(root, "shims"), { recursive: true });
  await writeFile(join(root, "shims", "chart-kit.ts"), "export const SHIM = true;\n", "utf8");

  return root;
}

/** The project config the plugin is handed: an object, because `vp dev` imports it (#26). */
function configWith(declareMapping: boolean): ForguncyConfig {
  return {
    ...(declareMapping ? { extensions: { mappings: [PROJECT_ROW] } } : {}),
    cells: {
      probe: { entry: "./cells/probe/src/App.tsx", target: { pageName: "探针", cell: "A1" } },
    },
    runtime: { dependencyLockPath: "./fgc.lock.json" },
  };
}

/** The stderr the plugin wrote, restored afterwards. */
async function capturingStderr(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    lines.push(chunk);
    return true;
  };
  try {
    await run();
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  return lines.join("");
}

describe("#87: the dev server reads the project's extension mappings, not a private table", () => {
  it("starts with a substitute for a package only the project maps", async () => {
    const root = await projectWithCustomExtension();

    let refusal: unknown;
    const printed = await capturingStderr(async () => {
      try {
        const server = await createServer({
          root,
          configFile: false,
          logLevel: "silent",
          appType: "spa",
          plugins: [
            devHarness({
              config: configWith(true),
              extensionChoices: [
                {
                  packageName: CHART_KIT.packageName,
                  mode: "substitute",
                  kind: "project-shim",
                  resolvesTo: "./shims/chart-kit.ts",
                  justification: "The Cell's UI is what is under test; the page owns the shared instance.",
                },
              ],
            }) as never,
          ],
          server: { middlewareMode: true, hmr: false, watch: null },
        });
        await server.close();
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal, "the server refused a choice the project's own row binds").toBeUndefined();
    // And the boundary is still reported, so a green start is not read as runtime compatibility.
    expect(printed).toContain("cannot be checked here");
  }, 120_000);

  it("starts with a `real-runtime-only` acknowledgement and names the package it leaves out", async () => {
    const root = await projectWithCustomExtension();

    let refusal: unknown;
    const printed = await capturingStderr(async () => {
      try {
        const server = await createServer({
          root,
          configFile: false,
          logLevel: "silent",
          appType: "spa",
          plugins: [
            devHarness({
              config: configWith(true),
              extensionChoices: [
                {
                  packageName: CHART_KIT.packageName,
                  mode: "real-runtime-only",
                  reason: "The extension's global is page-wide, and an npm copy cannot reproduce that.",
                  consequence: "Nothing local exercises the shared instance.",
                },
              ],
            }) as never,
          ],
          server: { middlewareMode: true, hmr: false, watch: null },
        });
        await server.close();
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal).toBeUndefined();
    expect(printed).toContain(`Left to real-runtime validation by decision: ${CHART_KIT.packageName}`);
  }, 120_000);

  it("refuses a decision the project does not map, which is the table being read", async () => {
    // The control for both tests above: same lock, same package, only the config's row missing.
    // If this did not refuse, the two green starts would be evidence about the extension being
    // in *some* table — `core`'s, say — rather than about the project's own set.
    const root = await projectWithCustomExtension();

    let refusal: unknown;
    await capturingStderr(async () => {
      try {
        const server = await createServer({
          root,
          configFile: false,
          logLevel: "silent",
          appType: "spa",
          plugins: [devHarness({ config: configWith(false) }) as never],
          server: { middlewareMode: true, hmr: false, watch: null },
        });
        await server.close();
      } catch (error) {
        refusal = error;
      }
    });

    expect(refusal).toBeDefined();
    const message = String((refusal as Error).message);
    expect(message).toContain("extension-library-not-verified");
    expect(message).toContain("fix owner: dependency-decision");
    // The local-versus-real distinction travels on the refusal path too.
    expect(message).toContain("does not establish any real-runtime check");
  }, 120_000);
});

void RUNTIME_CONTRACT_TARGET;
