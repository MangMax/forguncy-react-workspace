/**
 * The consumer tier, measured from the project a new Agent is handed (#105).
 *
 * Decision sources: GitHub Issues
 * - #105 — "可选收敛：缩小消费方公共 API，精简重复契约说明而不改变行为"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/105), whose first plan step is to
 *   classify the exports a consumer actually uses separately from the internal proof/diagnostic
 *   vocabulary, and
 * - #99/#102 — the consumer entrypoint and its black-box regression, which is what makes the
 *   classified path executable rather than a claim.
 *
 * ## What this pins, and what it deliberately does not change
 *
 * The roots of `core`, `runtime`, `mcp-sync` and the other packages stay exactly as wide as they
 * were: #105 requires 100% backward compatibility, so nothing here removes an export or marks one
 * deprecated. What the issue asks for is a *separation* — a stable consumer tier that a new Agent
 * can read without wading through the contract tables — and a separation nothing checks decays
 * back into a comment. So this file fixes the consumer side in place:
 *
 * 1. every `@forguncy-react-workspace/*` import in `examples/consumer-project` resolves to a bare
 *    package entry (no internal subpath) and uses a symbol on the declared tier;
 * 2. `cell-project`'s own value surface is the declared list, so the "minimal entrypoint" cannot
 *    quietly grow a helper a consumer would then be expected to assemble.
 *
 * Both are ratchets, not measurements of taste: adding a symbol is one deliberate edit here,
 * reviewed with the API change it represents. That is the whole enforcement — it does not say a
 * root export is *unused*, only that a business project does not need it.
 *
 * ## Evidence label
 *
 * The scan reads this checkout's source; the runtime half imports the same entries the example's
 * bare specifiers resolve to. It is `local` structural evidence. It says nothing about a Forguncy
 * page (AGENTS.md rules 6–7) — #107 owns that gate.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..", "..");
const EXAMPLE_ROOT = join(REPOSITORY_ROOT, "examples", "consumer-project");
const PACKAGES_ROOT = join(REPOSITORY_ROOT, "packages");

/** The workspace packages, by manifest name, with the entry `exports["."]` names. */
interface WorkspacePackage {
  readonly name: string;
  readonly directory: string;
  readonly entry: string;
}

function workspacePackages(): ReadonlyMap<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const directory of readdirSync(PACKAGES_ROOT)) {
    const packageRoot = join(PACKAGES_ROOT, directory);
    if (!statSync(packageRoot).isDirectory()) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      name: string;
      exports?: Record<string, string | Record<string, string>>;
    };
    const rootExport = manifest.exports?.["."];
    // Only packages whose root entry is a path this scan can read are relevant; a package with no
    // root export is not something a consumer can import from at all.
    const entry = typeof rootExport === "string" ? rootExport : undefined;
    if (entry !== undefined) {
      packages.set(manifest.name, { name: manifest.name, directory: packageRoot, entry });
    }
  }
  return packages;
}

/**
 * The consumer tier: every workspace symbol `examples/consumer-project` imports.
 *
 * Five symbols across three packages, and each one is at the consumer's own boundary: the config
 * file, the Cell and its fixture, and the Vite config. The port type a consumer's own adapter
 * imports (`ForguncySyncPort` from `mcp-sync`) is documented in the example's README and is not
 * imported by any file here, so it is not part of this scan — a port module lives in the
 * caller's project, not in the example.
 */
const CONSUMER_TIER = {
  "@forguncy-react-workspace/core": ["defineForguncyConfig"],
  "@forguncy-react-workspace/dev-harness": ["defineForguncyViteConfig"],
  "@forguncy-react-workspace/runtime": ["createMockDataSource", "MockRuntimeFacadeOptions", "runtimeFacade"],
} as const satisfies Record<string, readonly string[]>;

/** The symbols `cell-project`'s root exports, pinned so the entrypoint cannot grow silently. */
const CELL_PROJECT_VALUES = [
  "BUILD_MANIFEST_FILE_NAME",
  "DEFAULT_BUILD_OUT_DIR",
  "ProjectPlanError",
  "buildProject",
  "cellLockOf",
  "compileProject",
  "deploymentTargetIdentity",
  "deploymentWithheldOf",
  "formatPlannedCellSteps",
  "formatProjectBuildReport",
  "formatProjectSyncPlan",
  "formatProjectSyncReport",
  "hostDefaultsOf",
  "loadCellProject",
  "planProject",
  "planProjectAgainstPort",
  "projectExtensionMappings",
  "syncProject",
  "unobservableReasonsOf",
] as const;

/** Every file the example's own module graph is authored in. Scratch roots and installs excluded. */
function consumerSourceFiles(directory: string, found: string[] = []): readonly string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === ".fgc" || entry.startsWith(".")) {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      consumerSourceFiles(path, found);
      continue;
    }
    if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Remove comments, keeping string literals intact.
 *
 * The example's `App.tsx` documents its imports in a block comment, and a table of `import ...`
 * lines is exactly the shape a naive scan would read as source. Stripping comments first means
 * the tier is measured from declarations rather than from prose about them.
 */
function withoutComments(source: string): string {
  let output = "";
  let index = 0;
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (index < source.length) {
    const character = source[index]!;
    const next = source[index + 1];
    if (mode === "code") {
      if (character === "/" && next === "/") {
        mode = "line";
        index += 2;
        continue;
      }
      if (character === "/" && next === "*") {
        mode = "block";
        index += 2;
        continue;
      }
      if (character === "'") mode = "single";
      else if (character === '"') mode = "double";
      else if (character === "`") mode = "template";
      output += character;
      index += 1;
      continue;
    }
    if (mode === "line") {
      if (character === "\n") {
        mode = "code";
        output += character;
      }
      index += 1;
      continue;
    }
    if (mode === "block") {
      if (character === "*" && next === "/") {
        mode = "code";
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (character === "\\") {
      output += character + (next ?? "");
      index += 2;
      continue;
    }
    if (
      (mode === "single" && character === "'") ||
      (mode === "double" && character === '"') ||
      (mode === "template" && character === "`")
    ) {
      mode = "code";
    }
    output += character;
    index += 1;
  }
  return output;
}

/** One static import from a workspace package: its specifier and the names it binds. */
interface WorkspaceImport {
  readonly file: string;
  readonly specifier: string;
  readonly names: readonly string[];
}

/**
 * The named/default bindings of every `import ... from "@forguncy-react-workspace/..."`.
 *
 * Namespace imports are not read as a symbol list — `import * as core` has no names to classify,
 * and a consumer written that way is a deliberate broadening this ratchet should fail on rather
 * than guess about. The tier's imports are named or type-only, which is what an ordinary project
 * writes.
 */
function workspaceImports(): readonly WorkspaceImport[] {
  const imports: WorkspaceImport[] = [];
  // `[^;]*?` keeps one declaration per match: an import clause cannot contain a semicolon, and a
  // side-effect import (`import "./cell.css"`) has no `from`, so it cannot swallow the next one.
  const declaration = /^[ \t]*import\s+(?:type\s+)?([^;]*?)\s+from\s+"([^"]+)"/gm;
  for (const file of consumerSourceFiles(EXAMPLE_ROOT)) {
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(declaration)) {
      const clause = match[1] ?? "";
      const specifier = match[2] ?? "";
      if (!specifier.startsWith("@forguncy-react-workspace/")) {
        continue;
      }
      expect(clause, `${file} imports ${specifier} as a namespace, which the tier cannot classify`).not.toMatch(
        /\*\s*as/,
      );
      const named = /\{([\s\S]*?)\}/.exec(clause)?.[1];
      const bound = new Set<string>();
      // A default binding sits outside the braces (`import core from "..."`).
      for (const part of clause.replace(/\{[\s\S]*?\}/, "").split(",")) {
        const identifier = part.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(identifier)) {
          bound.add(identifier);
        }
      }
      for (const entry of named?.split(",") ?? []) {
        // `type X` inside a value import is a type-only binding; `X as Y` binds Y.
        const identifier = entry
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]!
          .trim();
        if (identifier.length > 0) {
          bound.add(identifier);
        }
      }
      imports.push({ file, specifier, names: [...bound] });
    }
  }
  return imports;
}

/** The `.ts` entry a package's `exports["."]` names, as a specifier this test can import. */
function entrySpecifier(pkg: WorkspacePackage): string {
  return pathToFileURL(join(pkg.directory, pkg.entry)).href;
}

describe("a business project uses the consumer tier, not the internal vocabulary", () => {
  it("imports five workspace symbols, each from a bare package entry", () => {
    const imports = workspaceImports();
    // The control: the scan found the example's workspace imports, so a passing comparison below
    // is about these declarations rather than about an empty list.
    expect(imports.length).toBeGreaterThanOrEqual(5);

    const used = new Map<string, Set<string>>();
    for (const entry of imports) {
      // A subpath (`core/browser`, `dev-harness/mount`) is deliberately *not* a consumer tier:
      // those entries exist to choose a module graph inside the toolchain, and a business project
      // reaching one would be assembling internals again.
      expect(entry.specifier, `${entry.file} imports a package subpath`).not.toMatch(
        /^@forguncy-react-workspace\/[^/]+\/.+/,
      );
      const names = used.get(entry.specifier) ?? new Set<string>();
      for (const name of entry.names) names.add(name);
      used.set(entry.specifier, names);
    }

    const actual = Object.fromEntries(
      [...used.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([specifier, names]) => [
        specifier,
        [...names].sort(),
      ]),
    );
    const expected = Object.fromEntries(
      Object.entries(CONSUMER_TIER)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([specifier, names]) => [specifier, [...names].sort()]),
    );

    expect(actual).toEqual(expected);
  });

  it("resolves each declared symbol in the entry the bare specifier names", async () => {
    const packages = workspacePackages();
    let checked = 0;
    const declared = Object.values(CONSUMER_TIER).reduce((total, names) => total + names.length, 0);

    for (const [specifier, names] of Object.entries(CONSUMER_TIER)) {
      const pkg = packages.get(specifier);
      expect(pkg, `${specifier} is not a workspace package with a root export`).toBeDefined();
      const module = (await import(entrySpecifier(pkg!))) as Record<string, unknown>;
      const entrySource = readFileSync(join(pkg!.directory, pkg!.entry), "utf8");

      for (const name of names) {
        if (name in module) {
          checked += 1;
          continue;
        }
        // Types are erased before this import runs, so a type-only name is confirmed against the
        // barrel's own declaration rather than the runtime namespace. That is a weaker check than
        // the compiler's and is stated as such: `pnpm typecheck` is what gates the binding.
        expect(entrySource, `${name} is neither a value nor declared in ${pkg!.entry}`).toMatch(
          new RegExp(`\\b${name}\\b`),
        );
        checked += 1;
      }
    }

    // The control: every declared name was actually visited, so "no failure" is not an empty loop.
    expect(checked).toBe(declared);
    expect(declared).toBe(5);
  });
});

describe("the consumer entrypoint's own surface is pinned", () => {
  it("exports the declared values and nothing else from its root", async () => {
    const cellProject = workspacePackages().get("@forguncy-react-workspace/cell-project");
    expect(cellProject, "cell-project is missing from the workspace scan").toBeDefined();

    const module = (await import(entrySpecifier(cellProject!))) as Record<string, unknown>;
    const names = Object.keys(module).sort();
    expect(names.length).toBeGreaterThan(10);
    expect(names).toEqual([...CELL_PROJECT_VALUES].sort());
  });
});
