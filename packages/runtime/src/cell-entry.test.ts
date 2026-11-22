import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as cellEntry from "./cell.ts";
import * as rootEntry from "./index.ts";
import { CELL_RUNTIME_BINDING_CONTRACT } from "@forguncy-react-workspace/core";

/**
 * `@forguncy-react-workspace/runtime/cell` is the production Cell entry (#124).
 *
 * The artifact guard lives in `cell-compiler`'s `runtime-binding.test.ts`, where it can be
 * asserted against a real compile. This file guards the *cause* one level up, because an
 * artifact that happens to be small today is not the property #124 asks for: the property is
 * that the entry the compiler binds has no path to the toolchain at all, and a tree-shaker's
 * proof is not a substitute for that when a later edit adds a value import.
 *
 * The walk is over **value** imports only. A type-only edge is erased before anything runs, so
 * `cell-runtime.ts` importing the provider's error type from `contract.ts` is not a route into
 * `capabilities.ts`; treating it as one would fail this test for a change that cannot affect an
 * artifact. `provider.ts` and `port.ts` use the same form for the port's types, and that is why
 * the walk has to model erasure rather than refuse the edge.
 */

const here = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN_MODULES = [
  "local-dev",
  "mock-provider",
  "cell-fixture",
  "capabilities",
  "provenance",
  "contract",
  "index",
] as const;

/**
 * Source with comments removed.
 *
 * Comments matter here for a reason this repository has already met: a doc comment that says
 * "`facade.ts` imports and re-exports what is here" is prose, not an edge, and a walker reading
 * raw text would count it. `stripComments` removes both forms — the block comments the modules
 * are mostly made of, and the line comments.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Every relative module a file imports or re-exports by value. */
function valueImportSpecifiersOf(fileName: string): readonly string[] {
  const source = stripComments(readFileSync(join(here, `${fileName}.ts`), "utf8"));
  const specs: string[] = [];
  // `import`/`export` statements without the `type` modifier. The module specifier is the last
  // quoted string before the statement's semicolon; import statements contain no other
  // semicolons, so `[^;]*?` is enough.
  for (const match of source.matchAll(/(?:import|export)\s*(type\s+)?[^;]*?from\s+"([^"]+)"/g)) {
    if (match[1] !== undefined) continue;
    specs.push(match[2]!);
  }
  return specs;
}

const RELATIVE_MODULE = /^\.\/([a-z-]+?)\.ts$/;

/** The transitive value-import graph of one entry, as module basenames. */
function valueGraphOf(entry: string, seen = new Set<string>()): readonly string[] {
  const visited: string[] = [];
  const visit = (fileName: string): void => {
    if (seen.has(fileName)) return;
    seen.add(fileName);
    visited.push(fileName);
    for (const specifier of valueImportSpecifiersOf(fileName)) {
      const match = RELATIVE_MODULE.exec(specifier);
      if (match?.[1] !== undefined) visit(match[1]);
    }
  };
  visit(entry);
  return visited;
}

/** The bare specifiers a file imports by value, so the package boundary is visible. */
function bareImportSpecifiersOf(fileName: string): readonly string[] {
  return valueImportSpecifiersOf(fileName).filter(specifier => !specifier.startsWith("./"));
}

describe("the production Cell entry reaches the runtime and nothing else", () => {
  it("has a value-import graph with no toolchain module in it", () => {
    const graph = valueGraphOf("cell");

    // The module the compiler binds is included — otherwise the walk would pass for an entry
    // that forgot to re-export the runtime.
    expect(graph).toContain("cell-runtime");
    for (const forbidden of FORBIDDEN_MODULES) {
      expect(graph, `cell entry reaches "${forbidden}.ts"`).not.toContain(forbidden);
    }
  });

  it("crosses the package boundary only at the core key leaf", () => {
    // One bare specifier, and it is the leaf (#124): `core/browser` would be the 17-module
    // barrel and bare `core` would reach `node:fs`. Both are the defect this entry avoids.
    const graph = valueGraphOf("cell");
    const bare = new Set(graph.flatMap(name => bareImportSpecifiersOf(name)));

    expect([...bare]).toEqual(["@forguncy-react-workspace/core/cell-props"]);
  });

  it("declares the subpath and the side-effect claim it relies on", () => {
    // Both are package metadata rather than module structure, and both are load-bearing: the
    // compiler resolves `./cell` through `exports`, and `sideEffects: false` is the audit's
    // statement that no module here does import-time work. Reading the manifest also keeps
    // this test honest if the field is removed while the module graph is still small.
    const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      exports: Record<string, string>;
      sideEffects?: boolean;
    };

    expect(manifest.exports["./cell"]).toBe("./src/cell.ts");
    expect(manifest.sideEffects).toBe(false);
  });

  it("exposes every name the root entry re-exports from the façade's runtime half", () => {
    // The slim entry is not allowed to be a *narrower public surface*: a Cell that imports a
    // member by name must get it after compilation, and the generated binding supplies exactly
    // these names. `runtimeFacade` is the one exercised by the artifact regression; the rest
    // are the slot operations a harness and the generated binding use.
    const required = [
      "runtimeFacade",
      "installRuntimeFacadeProvider",
      "uninstallRuntimeFacadeProvider",
      "runtimeFacadeProviderState",
      "createHostRuntimeFacadeProvider",
      "RuntimeFacadeResolutionError",
    ] as const;

    for (const name of required) {
      expect(Object.hasOwn(cellEntry, name), `${name} is missing from the cell entry`).toBe(true);
      expect(Object.hasOwn(rootEntry, name), `${name} is missing from the root entry`).toBe(true);
    }
  });

  it("is the entry the compiler's binding contract names", () => {
    // The contract and the manifest have to agree. They are two files in different packages,
    // and a typo in either would be a compile-time failure in every Cell — so it is asserted
    // here rather than discovered by a user.
    const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      name: string;
      exports: Record<string, string>;
    };
    const rootSpecifier = CELL_RUNTIME_BINDING_CONTRACT.facadeSpecifier;

    expect(CELL_RUNTIME_BINDING_CONTRACT.bindingSpecifier).toBe(`${rootSpecifier}/cell`);
    expect(manifest.name).toBe(rootSpecifier);
    expect(manifest.exports["./cell"]).toBeDefined();
  });
});
