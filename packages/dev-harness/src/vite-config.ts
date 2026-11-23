/**
 * The top-level Vite config helper: one call that assembles the local loop a project's
 * `vite.config.ts` used to assemble by hand.
 *
 * Decision sources: GitHub Issues
 * - #125 — "feat(dev-harness): 提供 defineForguncyViteConfig 顶层配置助手，消除业务项目
 *   vite.config.ts 样板拼装"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/125), the request this answers,
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose plan step 4 requires
 *   reusing the host-module bridge so the compiler and the dev server cannot drift,
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), the contract the loop
 *   implements, and
 * - #26 — "Spec: project configuration and React Cell target declarations"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/26), which makes
 *   `forguncy.config.ts` an *imported object* rather than a path this helper could load.
 *
 * ## Why this exists
 *
 * A project's `vite.config.ts` has to do four things that are not its own concerns: put
 * `reactFastRefresh()` in front of the harness, call `harnessHostModulePlan()` and spread its
 * `aliases`/`dedupe` into `resolve`, put the same packages in `optimizeDeps.include`, and only
 * then add whatever the project actually wants. Every one of those lines is a rule from this
 * package's contract, and a project that omits one does not get an error — it gets a loop that
 * renders but resets `useState` on every edit (no Fast Refresh), or one whose first
 * `import { createElement } from "react"` fails because the CJS host package was never
 * optimized. The failure is green, which is the shape this package exists to prevent.
 *
 * So this module owns the assembly and a project states only what it decided. It is additive:
 * {@link devHarness} and `harnessHostModulePlan()` are untouched and still exported, because a
 * project that wants to hand-assemble the config — or to inspect the plan it is composed from —
 * keeps working exactly as before.
 *
 * ## The two questions this helper has to answer, and how
 *
 * **1. The host plan.** {@link harnessHostModulePlan} is the single derivation of which module
 * ids the page provides and which package stands in for them locally (#9 via #22's projection).
 * This helper spreads its aliases, `dedupe` and `include` into the config, so a project gets the
 * same substitutions the compiler would, at the version this package installed, without naming
 * a package itself.
 *
 * **2. User precedence.** A project may deliberately point a host package somewhere else — a
 * patched React, a local fork — and that must win. The composed `resolve.alias` therefore lists
 * the project's own entries *first*, in the shape Vite evaluates first-match-wins, and drops the
 * default entries the project's patterns already claim (by Vite's own rule, including its
 * trailing-slash normalization). Dropping matters for a second reason: two entries for one id
 * that disagree are a latent failure even when the first one happens to win, and this package
 * has already paid for that lesson once (see `unclaimedHostAliases` in `vite-plugin.ts`).
 *
 * The plugin's `config()` hook still emits the ids a project did *not* claim, so a bare
 * `devHarness({ config })` remains a working harness. Because this helper has already put every
 * unclaimed host id into the project's own config, that hook's filter finds them all claimed and
 * emits nothing — the two do not duplicate one another.
 *
 * ## Fast Refresh: injected, not duplicated
 *
 * `reactFastRefresh()` goes first, before the harness, and the order is the reason the function
 * exists at all: Vite ignores `plugins` returned from a plugin's `config()` hook, so
 * {@link devHarness} cannot add Fast Refresh on the project's behalf (measured against Vite
 * 8.3.0, recorded on {@link reactFastRefresh}).
 *
 * If the project already supplied one of the fast-refresh plugins this package re-exports, it is
 * not injected a second time — adding it twice would wire two transforms over one module — and
 * the project's own placement is preserved. Detection uses the plugin name the contract records
 * (`vite:react-swc`, including its colon-suffixed companions), which is the same name
 * `formatFastRefreshWarning` uses, so "wired" means one thing in both places.
 *
 * ## What this does *not* claim
 *
 * It is configuration assembly, so the evidence it can produce is `local` only: a config this
 * helper returns says nothing about whether a Cell compiles, whether the designer accepts the
 * source, or whether the artifact behaves on a Forguncy page. Those remain #6/#7/#20/#25, and
 * `runtime`'s `formatLocalDevValidationDistinction()` — printed by the harness at server start —
 * is the report of what is still owed.
 */

import type { Alias, AliasOptions, PluginOption, UserConfig } from "vite";

import { normalizeAliasFind } from "./alias-audit.ts";
import {
  devHarness,
  harnessHostModulePlan,
  REACT_FAST_REFRESH_PLUGIN_NAME,
  reactFastRefresh,
} from "./vite-plugin.ts";
import type { DevHarnessOptions } from "./vite-plugin.ts";

/**
 * A project's `vite.config.ts`, assembled around the local dev harness.
 *
 * The first argument is the harness's own options — the project config object (#26) plus the
 * local-development declarations that never reach the artifact — and the second is ordinary Vite
 * configuration the project wants on top. Everything in the second argument is preserved;
 * `plugins`, `resolve.alias`, `resolve.dedupe` and `optimizeDeps.include` are merged rather than
 * replaced, and the project's alias entries keep precedence over the host plan.
 */
export function defineForguncyViteConfig(
  harnessOptions: DevHarnessOptions,
  userConfig: UserConfig = {},
): UserConfig {
  const { aliases, dedupe: hostDedupe } = harnessHostModulePlan();

  const userAliases = aliasEntries(userConfig.resolve?.alias);
  const unclaimedHostAliases: Alias[] = Object.entries(aliases)
    .filter(([moduleId]) => !userAliases.some(entry => claimsAlias(entry, moduleId)))
    .map(([find, replacement]) => ({ find, replacement }));

  const userPlugins = userConfig.plugins ?? [];
  const plugins: PluginOption[] = [
    // Only when the project has not already wired Fast Refresh itself; see the module docstring
    // for why a duplicate is worse than a missing one and why the project's placement wins.
    ...(hasFastRefresh(userPlugins) ? [] : (reactFastRefresh() as PluginOption[])),
    devHarness(harnessOptions),
    ...userPlugins,
  ];

  // Dedupe and `include` are lists rather than lookups: Vite concatenates them and neither can
  // shadow a project's entry, so the merge is a union that cannot drop anything the project said.
  // `include` shares the dedupe packages because both answer "pre-bundle this host package" —
  // see `DevHarnessVitePlugin.config` for the CJS-interop failure an excluded host package caused.
  const dedupe = unique([...(userConfig.resolve?.dedupe ?? []), ...hostDedupe]);
  const include = unique([...(userConfig.optimizeDeps?.include ?? []), ...hostDedupe]);

  return {
    ...userConfig,
    plugins,
    resolve: {
      ...userConfig.resolve,
      alias: [...userAliases, ...unclaimedHostAliases],
      dedupe,
    },
    optimizeDeps: {
      ...userConfig.optimizeDeps,
      include,
    },
  };
}

/** A project's `resolve.alias` in either shape Vite accepts, as one list of entries. */
function aliasEntries(alias: AliasOptions | undefined): readonly Alias[] {
  if (alias === undefined) {
    return [];
  }
  if (Array.isArray(alias)) {
    return alias.map(entry => ({ ...entry }));
  }
  return Object.entries(alias as Record<string, string>).map(([find, replacement]) => ({ find, replacement }));
}

/**
 * Whether one of the project's alias entries claims a host module id, by Vite's own rule.
 *
 * Vite decides with `importee === pattern || importee.startsWith(pattern + "/")` for a string
 * `find`, and `importee.match(pattern)` for a `RegExp`. Both are reproduced rather than
 * approximated, including {@link normalizeAliasFind}'s trailing-slash condition, because the
 * question is "which ids will Vite consider already claimed" — a filter that decided differently
 * from the resolver would disagree with the thing it is compensating for. That is exactly how the
 * equality-instead-of-prefix bug in `vite-plugin.ts` got through review.
 *
 * The `lastIndex` save/restore matters for the same reason it does there: `test` on a `/g` or `/y`
 * pattern is stateful, and asking a project's own RegExp would let this helper's call count decide
 * what Vite's later resolution sees.
 */
function claimsAlias(entry: Alias, moduleId: string): boolean {
  const { find } = entry;
  if (find instanceof RegExp) {
    const { lastIndex } = find;
    try {
      return find.test(moduleId);
    } finally {
      find.lastIndex = lastIndex;
    }
  }

  const pattern = normalizeAliasFind(find, entry.replacement);
  return moduleId === pattern || moduleId.startsWith(`${pattern}/`);
}

/**
 * Whether the project already wired React Fast Refresh itself.
 *
 * Recursive because Vite accepts nested plugin arrays and falsy members, and name-based because
 * that is the only observable the contract has: `@vitejs/plugin-react-swc`'s JSX transform and
 * Vite's built-in Oxc transform both emit `jsxDEV`, so a source scan cannot tell the two apart.
 * The colon-suffixed forms (`vite:react-swc:resolve-runtime`, `:refresh-bundled-dev`) belong to
 * the same plugin family and are detected with it the way `formatFastRefreshWarning` treats only
 * the exact name — a project that supplied the family has supplied the transform.
 */
function hasFastRefresh(plugins: readonly PluginOption[]): boolean {
  return plugins.some(plugin => {
    if (Array.isArray(plugin)) {
      return hasFastRefresh(plugin as readonly PluginOption[]);
    }
    if (plugin === null || typeof plugin !== "object") {
      return false;
    }
    const { name } = plugin as { readonly name?: unknown };
    return (
      typeof name === "string" &&
      (name === REACT_FAST_REFRESH_PLUGIN_NAME || name.startsWith(`${REACT_FAST_REFRESH_PLUGIN_NAME}:`))
    );
  });
}

/** The values with duplicates removed, keeping the first occurrence's position. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
