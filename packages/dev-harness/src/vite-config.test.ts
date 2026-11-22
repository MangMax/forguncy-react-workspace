import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { createServer } from "vite";
import type { UserConfig } from "vite";

import { hostModuleAliases, hostModuleDedupePackages } from "./host-modules.ts";
import { defineForguncyViteConfig } from "./vite-config.ts";
import { DEV_HARNESS_PLUGIN_NAME, REACT_FAST_REFRESH_PLUGIN_NAME, reactFastRefresh } from "./vite-plugin.ts";

/**
 * `defineForguncyViteConfig` under the two claims it makes: it assembles the loop's config by
 * itself, and a project's own settings keep precedence over that assembly.
 *
 * Decision sources: GitHub Issues
 * - #125 — "feat(dev-harness): 提供 defineForguncyViteConfig 顶层配置助手，消除业务项目
 *   vite.config.ts 样板拼装"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/125), whose acceptance asks for
 *   both halves to be proven by tests,
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23)
 *
 * ## Why half of this file inspects a config and the other half starts a server
 *
 * The assembly is visible in the returned object, so the defaults, the merge rules and the
 * Fast-Refresh deduplication are asserted there. Precedence is *not* visible there in the way
 * that matters: `vite-plugin.test.ts` records at length that a correct-looking alias list can
 * still lose a race, because Vite merges plugin results and evaluates entries in a particular
 * order. So the override tests that could pass for the wrong reason — the array form, where
 * Vite's merge order is least forgiving — are asserted through `pluginContainer.resolveId`, the
 * same instrument that caught the plugin's own prefix bug.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "tests", "fixtures", "html-injection", "ordinary");

/** A hand-written config, so the committed fixture needs no `forguncy.config.ts` of its own. */
const config = {
  cells: {
    probe: {
      entry: "./cells/probe/src/index.ts",
      target: { pageName: "探针", cell: "A1" },
    },
  },
};

/** One alias entry as Vite will evaluate it. */
interface AliasEntry {
  readonly find: string | RegExp;
  readonly replacement: string;
}

/** Every plugin name in a Vite plugin list, nested arrays included. */
function pluginNames(plugins: readonly unknown[]): string[] {
  const names: string[] = [];
  const visit = (option: unknown): void => {
    if (Array.isArray(option)) {
      for (const member of option) {
        visit(member);
      }
      return;
    }
    if (option === null || typeof option !== "object") {
      return;
    }
    const { name } = option as { readonly name?: unknown };
    if (typeof name === "string") {
      names.push(name);
    }
  };
  for (const plugin of plugins) {
    visit(plugin);
  }
  return names;
}

/**
 * The names `reactFastRefresh()` registers under — one package contributes several plugins.
 *
 * `vite:react-swc` appears twice (its `serve` and `build` transforms), so counting exact names
 * would make one Fast Refresh install look like two; counting the whole family makes "wired once"
 * the statement the test means.
 */
const FAST_REFRESH_FAMILY_PREFIX = `${REACT_FAST_REFRESH_PLUGIN_NAME}:`;

/** The members of one Fast Refresh install, so "not duplicated" can be asserted against it. */
function fastRefreshNames(names: readonly string[]): string[] {
  return names.filter(
    name => name === REACT_FAST_REFRESH_PLUGIN_NAME || name.startsWith(FAST_REFRESH_FAMILY_PREFIX),
  );
}

/** The composed `resolve.alias` as the list of entries this helper built. */
function aliasList(alias: unknown): readonly AliasEntry[] {
  if (!Array.isArray(alias)) {
    throw new Error("The composed `resolve.alias` is not the entry list this helper builds.");
  }
  return alias as readonly AliasEntry[];
}

/** The composed alias as a map of string finds, which is what the default case produces. */
function aliasMap(alias: unknown): Record<string, string> {
  const entries = aliasList(alias);
  return Object.fromEntries(
    entries.map(entry => {
      if (typeof entry.find !== "string") {
        throw new Error("A RegExp `find` belongs in `aliasList`, not in the map helper.");
      }
      return [entry.find, entry.replacement];
    }),
  );
}

/** Whether the composed alias still contains an entry for a string id, and which. */
function findEntry(alias: unknown, moduleId: string): AliasEntry | undefined {
  return aliasList(alias).find(entry => entry.find === moduleId);
}

/** The server's answer to "where does this import go", through Vite's own resolver. */
async function resolveModuleId(
  server: { pluginContainer: { resolveId(id: string): Promise<{ id: string } | null> } },
  moduleId: string,
): Promise<string> {
  const resolved = await server.pluginContainer.resolveId(moduleId);
  return resolved?.id ?? "(unresolved)";
}

/**
 * A middleware-mode server over the fixture, built from the helper's own output.
 *
 * Middleware mode because the assertions read the resolver rather than a response. The optimizer
 * is switched off for the reason `vite-plugin.test.ts` records: the override tests point host ids
 * at paths that do not exist, and a background optimizer scan would report loading them as an
 * unhandled rejection *after* the test passed, which Vitest counts as an error. A server that
 * answers no request has no module graph for the optimizer to build, so this removes background
 * work rather than an assertion.
 */
async function serverFor(composed: UserConfig) {
  return createServer({
    root: fixtureRoot,
    configFile: false,
    logLevel: "error",
    appType: "spa",
    ...composed,
    optimizeDeps: { ...composed.optimizeDeps, disabled: true },
    server: { middlewareMode: true, hmr: false, watch: null },
  });
}

describe("defineForguncyViteConfig assembles the loop without a project's help", () => {
  it("puts Fast Refresh before the harness and adds the harness exactly once", () => {
    const composed = defineForguncyViteConfig({ config });
    const names = pluginNames(composed.plugins ?? []);

    expect(names).toContain(REACT_FAST_REFRESH_PLUGIN_NAME);
    expect(names.filter(name => name === DEV_HARNESS_PLUGIN_NAME)).toHaveLength(1);
    expect(names.indexOf(REACT_FAST_REFRESH_PLUGIN_NAME)).toBeLessThan(names.indexOf(DEV_HARNESS_PLUGIN_NAME));
  });

  it("injects every host alias, every dedupe package and the optimizer inclusions", () => {
    const composed = defineForguncyViteConfig({ config });

    expect(aliasMap(composed.resolve?.alias)).toEqual(hostModuleAliases());
    expect(composed.resolve?.dedupe).toEqual([...hostModuleDedupePackages()]);
    expect(composed.optimizeDeps?.include).toEqual([...hostModuleDedupePackages()]);
  });
});

describe("a project's own configuration keeps precedence over the defaults", () => {
  it("lets the object form claim a host alias without dropping the rest of the plan", () => {
    const composed = defineForguncyViteConfig(
      { config },
      { resolve: { alias: { react: "/project-owned/react" } } },
    );

    expect(findEntry(composed.resolve?.alias, "react")).toEqual({
      find: "react",
      replacement: "/project-owned/react",
    });
    // The default entry is gone rather than shadowed: two entries for one id disagreeing are a
    // latent failure even when the first one happens to win.
    expect(aliasList(composed.resolve?.alias).filter(entry => entry.find === "react")).toHaveLength(1);
    // And the ids the project did not name are still served by the plan.
    expect(findEntry(composed.resolve?.alias, "react-dom/client")?.replacement).toBe(
      hostModuleAliases()["react-dom/client"],
    );
  });

  it("reads the array form, including Vite's trailing-slash normalization", () => {
    const composed = defineForguncyViteConfig(
      { config },
      { resolve: { alias: [{ find: "react/", replacement: "/project-owned/react/" }] } },
    );

    // The project's entry is kept exactly as written, and first.
    expect(aliasList(composed.resolve?.alias)[0]).toEqual({
      find: "react/",
      replacement: "/project-owned/react/",
    });
    // Vite normalizes `find` and `replacement` together, so this entry claims `react`; the default
    // exact entry must therefore be dropped or the two would disagree about one id.
    expect(aliasList(composed.resolve?.alias).filter(entry => entry.find === "react")).toHaveLength(0);
  });

  it("keeps a project's plugins after the harness and merges its dedupe and optimizer entries", () => {
    const userPlugin = { name: "user-plugin" };
    const composed = defineForguncyViteConfig(
      { config },
      {
        plugins: [userPlugin as never],
        resolve: { dedupe: ["user-package"] },
        optimizeDeps: { include: ["user-dependency"], exclude: ["never-bundle"] },
        server: { port: 1234 },
        root: "project-root",
      },
    );

    const names = pluginNames(composed.plugins ?? []);
    expect(names.at(-1)).toBe("user-plugin");
    expect(names.filter(name => name === DEV_HARNESS_PLUGIN_NAME)).toHaveLength(1);

    expect(composed.resolve?.dedupe).toEqual([...new Set(["user-package", ...hostModuleDedupePackages()])]);
    expect(composed.optimizeDeps?.include).toEqual(
      [...new Set(["user-dependency", ...hostModuleDedupePackages()])],
    );
    // Pass-through: everything this helper does not assemble is preserved untouched.
    expect(composed.optimizeDeps?.exclude).toEqual(["never-bundle"]);
    expect(composed.server).toEqual({ port: 1234 });
    expect(composed.root).toBe("project-root");
  });

  it("does not inject a second Fast Refresh when the project already wired one", () => {
    const composed = defineForguncyViteConfig(
      { config },
      // `reactFastRefresh()` is the same entry the helper would add itself, so the only correct
      // outcome is one transform pass.
      { plugins: [reactFastRefresh() as never] },
    );

    const names = pluginNames(composed.plugins ?? []);
    expect(fastRefreshNames(names)).toHaveLength(fastRefreshNames(pluginNames(reactFastRefresh() as unknown[])).length);
    expect(names.filter(name => name === DEV_HARNESS_PLUGIN_NAME)).toHaveLength(1);
  });
});

describe("a project's alias precedence at resolution time", () => {
  it("serves the object form's aliased id and its subpaths from the project's entry", async () => {
    const composed = defineForguncyViteConfig(
      { config },
      { resolve: { alias: { react: "/project-owned/react" } } },
    );
    const server = await serverFor(composed);

    try {
      expect(await resolveModuleId(server, "react")).toBe("/project-owned/react");
      expect(await resolveModuleId(server, "react/jsx-dev-runtime")).toBe(
        "/project-owned/react/jsx-dev-runtime",
      );
    } finally {
      await server.close();
    }
  });

  it("serves the array form's aliased id and its subpaths from the project's entry", async () => {
    const composed = defineForguncyViteConfig(
      { config },
      { resolve: { alias: [{ find: "react", replacement: "/project-owned/react" }] } },
    );
    const server = await serverFor(composed);

    try {
      // The array form is the one Vite's merge order handles least forgivingly, and the form the
      // plugin's own alias bug was found in. Asserted through the resolver, not the entry list:
      // an entry list can look right while the earlier of two entries wins the subpath.
      expect(await resolveModuleId(server, "react")).toBe("/project-owned/react");
      expect(await resolveModuleId(server, "react/jsx-dev-runtime")).toBe(
        "/project-owned/react/jsx-dev-runtime",
      );
    } finally {
      await server.close();
    }
  });
});
