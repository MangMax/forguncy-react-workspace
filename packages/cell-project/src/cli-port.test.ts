/**
 * The CLI's port check is `mcp-sync`'s method list, not a hand-copied one.
 *
 * Decision source: GitHub Issue #157
 * (https://github.com/MangMax/forguncy-react-workspace/issues/157): "the CLI validates a supplied
 * port against mcp-sync's exported port method list, so that adding a port method cannot silently
 * leave the CLI behind."
 *
 * ## Why this goes through the shipped command
 *
 * The check lives in `cli.ts`'s `loadPort`, which is not exported — and that is the right shape: the
 * question is what a *user* is told when their port module is not a port. So each case runs
 * `fgc-cell sync --port <module>` as a child process against a real (tiny) project and reads
 * stderr, exactly as a person would.
 *
 * ## What each case pins
 *
 * - A port missing one method is refused by name, and the sentence around it says how many methods
 *   the sync needs — which is `FORGUNCY_SYNC_PORT_METHODS.length` rather than a literal, so this
 *   case stays true if the list grows.
 * - A port carrying exactly the declared list is accepted: the run gets past the port check and
 *   fails later, in the designer flow, rather than reporting a wiring mistake. That is the control
 *   that stops the first case passing for a CLI that refuses everything.
 *
 * Evidence label: a mock port and a real compile. `local` only (AGENTS.md rules 6–7).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { FORGUNCY_SYNC_PORT_METHODS } from "@forguncy-react-workspace/mcp-sync";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..");
const EXAMPLE_ROOT = join(REPOSITORY_ROOT, "examples", "consumer-project");
const CLI = join(HERE, "cli.ts");

/** A real compile happens before the port is loaded, so this is a compile-sized budget. */
const CASE_TIMEOUT_MS = 120_000;

const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A project with one dependency-free Cell, under the example's tree so resolution works. */
function projectRoot(name: string): string {
  mkdirSync(join(EXAMPLE_ROOT, ".fgc"), { recursive: true });
  const root = mkdtempSync(join(EXAMPLE_ROOT, ".fgc", `${name}-`));
  scratchRoots.push(root);

  mkdirSync(join(root, "cells", "plain", "src"), { recursive: true });
  writeFileSync(join(root, "cells", "plain", "src", "App.ts"), "export function App() {\n  return null;\n}\n", "utf8");
  writeFileSync(
    join(root, "forguncy.config.ts"),
    [
      "export default {",
      '  runtime: { forguncyVersion: "12.0.102", projectAlias: "cli-port" },',
      "  cells: {",
      '    plain: { entry: "./cells/plain/src/App.ts", target: { pageName: "Page", cell: "A1" } },',
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

/**
 * A port module that answers every declared method with a refusal.
 *
 * The methods are written from `FORGUNCY_SYNC_PORT_METHODS` rather than typed out, so a method the
 * list gains later is provided here automatically — and the case below that omits one names it the
 * same way.
 */
function portModule(omit: string | undefined): string {
  const methods = FORGUNCY_SYNC_PORT_METHODS.filter(method => method !== omit);
  return [
    "export const port = {",
    ...methods.map(method => `  ${method}: async () => { throw new Error("not a real designer"); },`),
    "};",
    "",
  ].join("\n");
}

/** The shipped CLI, as a person would run it. */
async function cli(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("`fgc-cell sync` checks the port against mcp-sync's own method list", () => {
  it("names the one method a port is missing, and how many the sync needs", async () => {
    const root = projectRoot("port-missing");
    writeFileSync(join(root, "port.mjs"), portModule("saveProject"), "utf8");

    const result = await cli(["sync", "--project", root, "--port", "./port.mjs"], root);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("is not a ForguncySyncPort");
    expect(result.stderr).toContain("saveProject");
    // The count comes from the list, not a literal: the sentence has to stay true when it grows.
    expect(result.stderr).toContain(String(FORGUNCY_SYNC_PORT_METHODS.length));
  }, CASE_TIMEOUT_MS);

  it("accepts a port carrying exactly the declared methods", async () => {
    const root = projectRoot("port-complete");
    writeFileSync(join(root, "port.mjs"), portModule(undefined), "utf8");

    const result = await cli(["sync", "--project", root, "--port", "./port.mjs"], root);

    // Past the port check, the mock port throws from inside the designer flow, which the executor
    // reports as a transport failure — a different outcome, in a different vocabulary. What must
    // not appear is the wiring refusal.
    expect(result.stderr).not.toContain("is not a ForguncySyncPort");
    expect(result.stdout).toContain("transport-failure");
    expect(result.stdout).toContain("listFrontendLibraries");
  }, CASE_TIMEOUT_MS);
});
