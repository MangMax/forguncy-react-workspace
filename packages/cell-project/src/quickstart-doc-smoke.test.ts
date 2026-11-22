/**
 * The Chinese Quickstart in `README.md`, parsed and then actually executed (#106).
 *
 * Decision source: GitHub Issue #106
 * (https://github.com/MangMax/forguncy-react-workspace/issues/106), whose acceptance criteria
 * require the first screen to give an executable Quickstart, name real working directories and
 * output paths, and never present local evidence as real Forguncy compatibility.
 *
 * ## Why this is separate from `consumer-entrypoint.test.ts`
 *
 * #102 owns the integration test of the public entrypoints. This file owns one narrower promise:
 * *the commands printed in the README run*. Keeping them apart means a wording change in the
 * Quickstart cannot make the #102 integration test fail for a reason that is not about the
 * entrypoint, and the two can be worked on without merge conflicts.
 *
 * ## What is executed, and what cannot be
 *
 * `record` → `build` → offline `plan` are executed against a scratch copy of
 * `examples/consumer-project`, because the real designer is not available to a local process.
 * The two connected forms — `plan -- --port` and `sync -- --port` — are documented with a
 * placeholder port module and **cannot** run offline; this test verifies their documented shape
 * and verifies that `sync` refuses to run without a port, but it does not pretend to have talked
 * to Forguncy. That is #107's gate, not this file's.
 *
 * ## Why the underlying binaries instead of `pnpm <verb>`
 *
 * The README documents `pnpm record` / `pnpm build` / `pnpm plan`, which are thin aliases for the
 * Skill's `select_dependency.mjs` and the `fgc-cell` bin (`examples/consumer-project/package.json`
 * defines them, and this test asserts that). A scratch copy under `.fgc/` is not a linked pnpm
 * workspace package, so spawning `pnpm` there would test the package manager's PATH assembly
 * rather than the documented entrypoints. The test therefore runs exactly the binaries those
 * scripts run, against the same project shape the README tells a reader to use.
 */

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..");
const EXAMPLE_ROOT = join(REPOSITORY_ROOT, "examples", "consumer-project");
const README_PATH = join(REPOSITORY_ROOT, "README.md");
const SKILL_CLI = join(
  REPOSITORY_ROOT,
  ".agents",
  "skills",
  "forguncy-react-dependency-selection",
  "scripts",
  "select_dependency.mjs",
);
const CLI = join(HERE, "cli.ts");

/** A real compile plus a real probe; the probe builds `es-toolkit` through Rolldown. */
const CASE_TIMEOUT_MS = 180_000;

const QUICKSTART_START = "<!-- quickstart:start -->";
const QUICKSTART_END = "<!-- quickstart:end -->";
const WORKING_DIRECTORY_PREFIX = "# 工作目录：";
const REPOSITORY_ROOT_LABEL = "仓库根目录";

/** The scratch roots this file created, removed once at the end. */
const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface QuickstartBlock {
  /** The directory the block says to run from, verbatim from its `# 工作目录：` header. */
  readonly workingDirectory: string;
  /** Non-comment lines, in order. */
  readonly commands: readonly string[];
}

/**
 * Extracts the bash blocks between the Quickstart markers.
 *
 * Marker-delimited rather than heading-delimited on purpose: the documentation may gain or lose a
 * subheading without changing what the smoke test covers, and a stable pair of invisible markers
 * is a smaller promise than a heading string a writer would reasonably reword.
 */
function quickstartBlocks(markdown: string): readonly QuickstartBlock[] {
  const start = markdown.indexOf(QUICKSTART_START);
  const end = markdown.indexOf(QUICKSTART_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `README.md has no ${QUICKSTART_START} … ${QUICKSTART_END} section. The executable Quickstart must stay marker-delimited for the smoke test.`,
    );
  }

  const section = markdown.slice(start + QUICKSTART_START.length, end);
  const blocks: QuickstartBlock[] = [];
  const fence = /```bash[^\n]*\n([\s\S]*?)```/g;

  for (let match = fence.exec(section); match !== null; match = fence.exec(section)) {
    const lines = (match[1] ?? "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const header = lines.find(line => line.startsWith(WORKING_DIRECTORY_PREFIX));
    if (header === undefined) {
      throw new Error(`A bash block in the Quickstart has no "${WORKING_DIRECTORY_PREFIX}<dir>" first line.`);
    }

    blocks.push({
      workingDirectory: header.slice(WORKING_DIRECTORY_PREFIX.length).trim(),
      commands: lines.filter(line => !line.startsWith("#")),
    });
  }

  return blocks;
}

function documented(blocks: readonly QuickstartBlock[], workingDirectory: string, command: string): boolean {
  return blocks.some(block => block.workingDirectory === workingDirectory && block.commands.includes(command));
}

function resolveWorkingDirectory(label: string): string {
  return label === REPOSITORY_ROOT_LABEL ? REPOSITORY_ROOT : join(REPOSITORY_ROOT, label);
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the shipped CLI as a child process — the command entrypoint, not only the functions. */
async function cli(args: readonly string[], cwd: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * A temp copy of the example, inside its own tree so bare imports still resolve.
 *
 * Under `.fgc/` — which is git-ignored — because Node's and Rolldown's resolution walk up from the
 * scratch root to the example's `node_modules`, and the install-graph identity walk finds the
 * repository's lockfile the same way.
 */
function scratchProject(name: string): string {
  mkdirSync(join(EXAMPLE_ROOT, ".fgc"), { recursive: true });
  const root = mkdtempSync(join(EXAMPLE_ROOT, ".fgc", `${name}-`));
  scratchRoots.push(root);

  cpSync(join(EXAMPLE_ROOT, "forguncy.config.ts"), join(root, "forguncy.config.ts"));
  cpSync(join(EXAMPLE_ROOT, "cells"), join(root, "cells"), { recursive: true });
  cpSync(join(EXAMPLE_ROOT, "dependencies"), join(root, "dependencies"), { recursive: true });
  return root;
}

/** Every file under `root`, with its exact bytes. Used to prove a verb wrote nothing. */
function snapshot(root: string): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else {
        files[absolute.slice(root.length)] = readFileSync(absolute, "utf8");
      }
    }
  };
  walk(root);
  return files;
}

interface BuildReport {
  readonly command: string;
  readonly outDir: string | null;
  readonly wroteFiles: boolean;
  readonly cells: readonly {
    readonly cellId: string;
    readonly status: string;
    readonly artifact: { readonly file: string; readonly fingerprint: string } | null;
  }[];
}

interface PlanReport {
  readonly command: string;
  readonly mode: string;
  readonly portDescription: string | null;
  readonly cells: readonly {
    readonly cellId: string;
    readonly wouldWrite: boolean;
    readonly targetStateRead: boolean;
  }[];
}

interface ManifestReport {
  readonly cells: readonly {
    readonly cellId: string;
    readonly artifact: { readonly file: string } | null;
  }[];
}

describe("the README Quickstart names real, runnable commands and directories", () => {
  it("documents the consumer entrypoint's four verbs, the install step and the local loop", () => {
    const markdown = readFileSync(README_PATH, "utf8");
    const blocks = quickstartBlocks(markdown);

    // Every block's declared working directory exists. A Quickstart that says `cd somewhere` and
    // names a directory that is not there is not executable, whatever the command text says.
    for (const block of blocks) {
      expect(existsSync(resolveWorkingDirectory(block.workingDirectory)), block.workingDirectory).toBe(true);
    }

    const required: readonly (readonly [string, string])[] = [
      [REPOSITORY_ROOT_LABEL, "pnpm install --frozen-lockfile"],
      ["examples/consumer-project", "vp dev"],
      ["examples/consumer-project", "pnpm record"],
      ["examples/consumer-project", "pnpm build"],
      ["examples/consumer-project", "pnpm plan"],
      ["examples/consumer-project", "pnpm plan -- --port ./mcp-port.mjs"],
      ["examples/consumer-project", "pnpm sync -- --port ./mcp-port.mjs"],
    ];
    for (const [workingDirectory, command] of required) {
      expect(documented(blocks, workingDirectory, command), `${workingDirectory}: ${command}`).toBe(true);
    }

    // The aliases the README prints are the example's real scripts, not a parallel vocabulary.
    const exampleManifest = JSON.parse(readFileSync(join(EXAMPLE_ROOT, "package.json"), "utf8")) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    expect(exampleManifest.scripts).toMatchObject({
      build: "fgc-cell build",
      plan: "fgc-cell plan",
      sync: "fgc-cell sync",
    });
    expect(exampleManifest.scripts?.record).toContain("select_dependency.mjs record");

    // The output locations a reader is told to look for are the ones the build writes.
    expect(markdown).toContain(".fgc/build/salesOverview.js");
    expect(markdown).toContain(".fgc/build/manifest.json");

    // No command reaches into a package's private source tree: a consumer uses the public
    // entrypoint, and an example that printed a `packages/*/src` invocation would teach the
    // opposite.
    for (const block of blocks) {
      for (const command of block.commands) {
        expect(command, command).not.toMatch(/packages\/[^ ]+\/src\//);
      }
    }
  });

  it("states the honest stage instead of an outdated Next Action, and adds no specs/plans trees", () => {
    const markdown = readFileSync(README_PATH, "utf8");

    // The pinned contract and the re-validation debt are both visible on the first screen.
    expect(markdown).toContain("12.0.101.0");
    expect(markdown).toContain("12.0.102.0");
    expect(markdown).toContain("#107");

    // "Next Action" was the stale historical status this ticket replaces; a current README must
    // not present it as the present.
    expect(markdown.toLowerCase()).not.toContain("next action");

    // Specs and plans stay in GitHub Issues (AGENTS.md workflow rules 1–5).
    expect(existsSync(join(REPOSITORY_ROOT, "specs"))).toBe(false);
    expect(existsSync(join(REPOSITORY_ROOT, "plans"))).toBe(false);
  });
});

describe("the documented local sequence really runs", () => {
  it("records, builds the documented artifact, and plans offline without writing anything", async () => {
    const root = scratchProject("quickstart-smoke");

    // `pnpm record` — the Skill's deterministic half, writing a real lock and real evidence.
    await run(
      process.execPath,
      [
        SKILL_CLI,
        "record",
        "--project",
        root,
        "--decision",
        join(root, "dependencies", "es-toolkit.decision.json"),
      ],
      { cwd: REPOSITORY_ROOT, maxBuffer: 64 * 1024 * 1024 },
    );
    expect(existsSync(join(root, "fgc.lock.json"))).toBe(true);
    expect(existsSync(join(root, "fgc-evidence"))).toBe(true);

    // `pnpm build` — the same `fgc-cell build` the package.json script runs.
    const built = await cli(["build", "--project", root, "--json"], root);
    expect(built.code, built.stderr).toBe(0);
    const build = JSON.parse(built.stdout) as BuildReport;
    expect(build.command).toBe("build");
    expect(build.wroteFiles).toBe(true);
    expect(build.cells.map(cell => cell.status)).toEqual(["compiled"]);
    expect(build.cells[0]?.artifact?.file).toBe("salesOverview.js");

    const artifactPath = join(root, ".fgc", "build", "salesOverview.js");
    const manifestPath = join(root, ".fgc", "build", "manifest.json");
    expect(existsSync(artifactPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestReport;
    expect(manifest.cells[0]?.artifact?.file).toBe("salesOverview.js");

    // `pnpm plan` (offline) — the plan compiles in memory and must not touch the tree. The whole
    // scratch root is compared, not only `.fgc/build`, so a stray write anywhere is visible.
    const beforePlan = snapshot(root);
    const planned = await cli(["plan", "--project", root, "--json"], root);
    expect(planned.code, planned.stderr).toBe(0);
    const plan = JSON.parse(planned.stdout) as PlanReport;
    expect(plan.command).toBe("plan");
    expect(plan.mode).toBe("offline");
    expect(plan.portDescription).toBeNull();
    expect(plan.cells.map(cell => cell.wouldWrite)).toEqual([true]);
    expect(plan.cells.map(cell => cell.targetStateRead)).toEqual([false]);
    expect(snapshot(root)).toEqual(beforePlan);

    // The "only `sync` writes" guarantee, stated executably: the same verb without an authorized
    // port is a usage error, never a silent no-op that looks like a deployment.
    const unsynced = await cli(["sync", "--project", root], root);
    expect(unsynced.code).not.toBe(0);
    expect(unsynced.stderr).toContain("--port");

    // Connected forms (`plan --port` / `sync --port`) are deliberately not reached: they need a
    // real designer session, which no local process has. Real runtime validation is #107's gate.
  }, CASE_TIMEOUT_MS);
});
