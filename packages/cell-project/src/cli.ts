#!/usr/bin/env node
/**
 * `fgc-cell` — the three verbs #99 asks a project to be able to run.
 *
 * Decision source: GitHub Issue #99
 * (https://github.com/MangMax/forguncy-react-workspace/issues/99).
 *
 * ```
 * fgc-cell build  [--project <dir>] [--out <dir>] [--json]
 * fgc-cell plan   [--project <dir>] [--port <module>] [--overwrite force] [--json]
 * fgc-cell sync   --port <module> [--project <dir>]
 *                  [--on-transport-failure stop|continue] [--on-failed-run stop|continue] [--json]
 * ```
 *
 * ## Why a `.ts` file is the bin
 *
 * Every package here ships source, and the repository's floor is Node 24, which strips erasable
 * type annotations itself. A `.ts` bin therefore runs without a build step and — the part that
 * matters — imports the workspace packages through the *project's* installed links, so the CLI
 * executes the same source `build`/`plan`/`sync` describe rather than a copy in `dist/`.
 *
 * ## Why `sync` has no default port
 *
 * There is no built-in MCP client, by design: an authorized designer connection is the caller's.
 * `--port ./mcp-port.mjs` imports a module whose default export (or named `port`) is a
 * `ForguncySyncPort`. Requiring it makes "sync without a designer" impossible to express, and the
 * argument's absence is a usage error rather than a silent dry run that looks like a deployment.
 *
 * ## Exit codes
 *
 * `0` — the verb did what it says (`build` compiled every Cell; `plan` produced a plan, even one
 * that holds every target; `sync` reports every target as `written` or `unchanged`).
 * `1` — the verb refused or failed: `build` with a rejected Cell, `plan` with a Cell it could not
 * plan, `sync` with any target that was not written and was not already correct (a refusal, a
 * failed run, a target never attempted, a transport failure), or a usage error. A refusal is
 * printed in full and then affects the code, never swallowed into a zero exit.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CellOverwritePolicy, ForguncySyncPort } from "@forguncy-react-workspace/mcp-sync";
import { FORGUNCY_SYNC_PORT_METHODS } from "@forguncy-react-workspace/mcp-sync";

import {
  buildProject,
  compileProject,
  formatProjectBuildReport,
  formatProjectSyncPlan,
  formatProjectSyncReport,
  planProject,
  planProjectAgainstPort,
  syncProject,
} from "./index.ts";

const USAGE = `fgc-cell — build, inspect and sync a Forguncy React Cell project.

  fgc-cell build  [--project <dir>] [--out <dir>] [--json]
      Compile every declared Cell and write the artifacts + manifest under --out
      (default: .fgc/build). Makes no remote call.

  fgc-cell plan   [--project <dir>] [--port <module>] [--overwrite <policy>] [--json]
      Report what a sync would do. Without --port nothing is contacted; with --port
      the project's extension listing and each target are read, and nothing is written.

  fgc-cell sync   --port <module> [--project <dir>] [--on-transport-failure <stop|continue>]
                  [--on-failed-run <stop|continue>] [--restore | --restore-all] [--json]
      Write the compiled Cells through the supplied port. Explicit only: there is no
      default designer and no auto-start. By default a target that diverged from the
      repository declaration — edited code, or an edited declared binding — is REFUSED and
      reported field by field. --restore overwrites the declared bindings from the repository
      but preserves the eventHandlers command body; --restore-all additionally clears that body.

  --overwrite <policy>   preserve-designer-edits (default) | force. Applies to plan.
  --restore              sync: overwrite declared bindings from the repo, keep event command bodies.
  --restore-all          sync: overwrite declared bindings and clear event command bodies.
  --project <dir>        Project root. Defaults to the current directory.
  --json                 Print the machine-readable report instead of the prose one.

A --port module exports a ForguncySyncPort as its default export or as \`port\`.
`;

interface ParsedArguments {
  readonly command: string | undefined;
  readonly options: Readonly<Record<string, string | boolean>>;
}

const BOOLEAN_OPTIONS = new Set(["json", "restore", "restore-all"]);
const VALUE_OPTIONS = new Set(["project", "out", "port", "overwrite", "on-transport-failure", "on-failed-run"]);

class UsageError extends Error {
  readonly code = "usage-error";
}

/**
 * Parses `argv` against a whitelist.
 *
 * Unknown options are refused rather than ignored: a misspelt `--overwrite` would otherwise leave
 * the default policy in place while the caller believed they had forced a write — the same
 * fail-open shape the dependency-selection CLI's own parser records, arriving with worse
 * consequences here.
 */
function parseArguments(argv: readonly string[]): ParsedArguments {
  const [command, ...rest] = argv;
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      throw new UsageError(`Unexpected argument "${token}".`);
    }
    const [name, inline] = token.slice(2).split("=", 2);
    if (name === undefined || (!BOOLEAN_OPTIONS.has(name) && !VALUE_OPTIONS.has(name))) {
      throw new UsageError(`Unknown option "--${name ?? ""}". Known options: ${[...BOOLEAN_OPTIONS, ...VALUE_OPTIONS].map(option => `--${option}`).join(", ")}.`);
    }
    if (BOOLEAN_OPTIONS.has(name)) {
      options[name] = inline === undefined ? true : inline !== "false";
      continue;
    }
    const value = inline ?? rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`--${name} needs a value.`);
    }
    if (inline === undefined) index += 1;
    options[name] = value;
  }

  return { command, options };
}

function requireValue(options: ParsedArguments["options"], name: string): string {
  const value = options[name];
  if (typeof value !== "string") {
    throw new UsageError(`--${name} is required for this command.`);
  }
  return value;
}

function overwritePolicy(options: ParsedArguments["options"]): CellOverwritePolicy | undefined {
  const value = options["overwrite"];
  if (value === undefined) return undefined;
  if (value !== "preserve-designer-edits" && value !== "force") {
    throw new UsageError(`--overwrite accepts "preserve-designer-edits" or "force"; received ${JSON.stringify(value)}.`);
  }
  return value;
}

function failurePolicy(options: ParsedArguments["options"], name: string): "stop" | "continue" | undefined {
  const value = options[name];
  if (value === undefined) return undefined;
  if (value !== "stop" && value !== "continue") {
    throw new UsageError(`--${name} accepts "stop" or "continue"; received ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * The sync overwrite policy, resolved from the restore flags.
 *
 * `--restore` and `--restore-all` are boolean flags rather than a `--overwrite` value because they
 * are #179's user-facing verbs and mean something narrower than `force` — and because a caller
 * reaching for one should not have to know the policy enum. They are mutually exclusive, and
 * exclusive with `--overwrite force` on the same command: passing both is a contradiction about
 * what the sync may destroy, so it is refused rather than resolved by precedence.
 */
function syncOverwritePolicy(options: ParsedArguments["options"]): CellOverwritePolicy | undefined {
  const restore = options["restore"] === true;
  const restoreAll = options["restore-all"] === true;
  const overwrite = overwritePolicy(options);
  if (restore && restoreAll) {
    throw new UsageError(`--restore and --restore-all are mutually exclusive: one keeps the event command bodies, the other clears them.`);
  }
  if ((restore || restoreAll) && overwrite !== undefined) {
    throw new UsageError(`--restore/--restore-all cannot be combined with --overwrite: they are different decisions about what the sync may overwrite.`);
  }
  if (restoreAll) return "restore-all";
  if (restore) return "restore";
  return overwrite;
}

/**
 * The port a `--port` module exports.
 *
 * Loaded through `pathToFileURL` rather than a bare import so a project-relative path works, and
 * checked for the methods the flow needs — a module that happens to export an object is not a port,
 * and letting the sync fail on the first missing method would report a transport error for what is
 * a wiring mistake.
 *
 * The method list is `mcp-sync`'s (`FORGUNCY_SYNC_PORT_METHODS`, #157), not a copy: a hand-written
 * list here would let a method added to the port contract go unchecked, and the first symptom would
 * be a sync that fails deep in the flow instead of at the wiring.
 */
async function loadPort(specifier: string, projectRoot: string): Promise<ForguncySyncPort> {
  const absolute = resolve(projectRoot, specifier);
  const module = (await import(pathToFileURL(absolute).href)) as {
    readonly default?: unknown;
    readonly port?: unknown;
  };
  const candidate = module.port ?? module.default;
  const required = FORGUNCY_SYNC_PORT_METHODS;
  if (typeof candidate !== "object" || candidate === null) {
    throw new UsageError(
      `The module at ${absolute} exports no port. Export a ForguncySyncPort as \`default\` or as \`port\`.`,
    );
  }
  const missing = required.filter(method => typeof (candidate as Record<string, unknown>)[method] !== "function");
  if (missing.length > 0) {
    throw new UsageError(
      `The module at ${absolute} is not a ForguncySyncPort: it has no ${missing.join(", ")}. The ${String(required.length)} port methods are the sync's whole designer surface.`,
    );
  }
  return candidate as ForguncySyncPort;
}

/** Prints a machine-readable report, and nothing else, so a caller can pipe it. */
function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runBuild(options: ParsedArguments["options"]): Promise<number> {
  const root = resolve(requireValueProject(options));
  const out = typeof options.out === "string" ? options.out : undefined;
  const report = await buildProject({ root, ...(out === undefined ? {} : { outDir: out }) });

  if (options.json === true) {
    printJson({ command: "build", ...report });
  } else {
    process.stdout.write(`${formatProjectBuildReport(report)}\n`);
  }

  const rejected = report.cells.filter(cell => cell.status === "rejected");
  if (rejected.length > 0) {
    process.stderr.write(
      `Build refused: ${rejected.length} of ${report.cells.length} Cell(s) did not compile (${rejected.map(cell => cell.cellId).join(", ")}). Nothing was deployed; this command never deploys.\n`,
    );
    return 1;
  }
  return 0;
}

async function runPlan(options: ParsedArguments["options"]): Promise<number> {
  const root = resolve(requireValueProject(options));
  const overwrite = overwritePolicy(options);
  const build = await compileProject({ root, write: false });
  const planOptions = overwrite === undefined ? {} : { overwrite };

  const portSpecifier = options.port;
  const plan =
    typeof portSpecifier === "string"
      ? await planProjectAgainstPort(build, {
          ...planOptions,
          port: await loadPort(portSpecifier, root),
          portDescription: `--port ${portSpecifier}`,
        })
      : planProject(build, planOptions);

  if (options.json === true) {
    printJson({ command: "plan", ...plan.report });
  } else {
    process.stdout.write(`${formatProjectSyncPlan(plan.report)}\n`);
  }

  // A plan holding every target is a *successful* plan — it is an answer, not a failure. Only a
  // Cell that could not be planned at all (a rejected compile) is an error, and that threw above.
  return 0;
}

async function runSync(options: ParsedArguments["options"]): Promise<number> {
  const root = resolve(requireValueProject(options));
  const portSpecifier = requireValue(options, "port");

  // The build is in memory: `sync` compiles from the project's source rather than trusting a file
  // a previous run may have left, so what it writes is what this project compiles to now.
  const build = await compileProject({ root, write: false });
  const overwrite = syncOverwritePolicy(options);
  const report = await syncProject(build, {
    port: await loadPort(portSpecifier, root),
    portDescription: `--port ${portSpecifier}`,
    ...(overwrite === undefined ? {} : { overwrite }),
    ...(failurePolicy(options, "on-transport-failure") === undefined
      ? {}
      : { onTransportFailure: failurePolicy(options, "on-transport-failure") }),
    ...(failurePolicy(options, "on-failed-run") === undefined
      ? {}
      : { onFailedRun: failurePolicy(options, "on-failed-run") }),
  });

  if (options.json === true) {
    printJson({ command: "sync", ...report });
  } else {
    process.stdout.write(`${formatProjectSyncReport(report)}\n`);
  }

  // A target that was not written and was not already correct is a sync that did *not* happen —
  // refused, failed, never attempted, or a transport failure. It is a result rather than a crash,
  // so it is reported fully and then affects the exit code, which is what lets a pipeline notice.
  const incomplete = report.cells.filter(cell => cell.status !== "written" && cell.status !== "unchanged");
  return incomplete.length === 0 ? 0 : 1;
}

/** The project root, from `--project` or the process's own directory. */
function requireValueProject(options: ParsedArguments["options"]): string {
  const value = options.project;
  return typeof value === "string" ? value : process.cwd();
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 1;
    }
    throw error;
  }

  try {
    switch (parsed.command) {
      case "build":
        return await runBuild(parsed.options);
      case "plan":
        return await runPlan(parsed.options);
      case "sync":
        return await runSync(parsed.options);
      case undefined:
        process.stderr.write(USAGE);
        return 1;
      default:
        process.stderr.write(`Unknown command "${parsed.command}".\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// Only run when executed as the entry point, so importing this module in a test does not parse
// the test runner's own argv.
//
// The comparison is on `realpath`: a package manager's `node_modules/.bin` shim invokes this file
// through a *relative* spelling and an intermediate path, so a plain `import.meta.url` equality
// missed on every `fgc-cell` invocation that did not name the absolute path — the command printed
// nothing and exited 0, which is the failure that looks like success.
if (process.argv[1] !== undefined) {
  const invoked = realpathSync(process.argv[1]);
  const self = realpathSync(fileURLToPath(import.meta.url));
  if (invoked === self) {
    process.exitCode = await main(process.argv.slice(2));
  }
}

export { main };
