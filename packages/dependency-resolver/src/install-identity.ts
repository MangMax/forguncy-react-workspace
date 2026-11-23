/**
 * The identity of the install graph a probe actually resolved against, and of the tools that ran.
 *
 * Decision source: GitHub Issue #94 — "Probe 身份：采集真实安装图、补丁和实际构建工具版本"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/94
 *
 * Governing Specs: #8 (a lock record's `probedWith` is the identity its technical evidence is
 * judged against, and `toolchain-changed`/`toolchain-unknown` are the reasons it produces), #16
 * ("exact package/version/license/source", so the evidence is about one artifact), #17 (the
 * fingerprint must be recomputable without re-running the probe).
 *
 * ## The defect this module closes
 *
 * Identity used to be `readToolchainIdentity`, which read the **declared** `vite-plus` string out
 * of the project's `package.json`. Measured, on a scratch project whose root package was held at
 * `a@1.0.0`:
 *
 * | change | root version | composed fingerprint | identity moved |
 * | --- | --- | --- | --- |
 * | baseline | 1.0.0 | `probe=…;analysis=14;config={};bundler={…}` | — |
 * | transitive `b` 1.0.0 → 2.0.0 | 1.0.0 | byte-identical | **no** |
 * | a patch added | 1.0.0 | byte-identical | **no** |
 *
 * A manifest is a *request*, not an install result: two projects that both write
 * `"vite-plus": "0.3.2"` can run different bundlers, and one can carry a patched transitive
 * dependency the other does not. So a record could keep reporting `fresh` while the artifact it
 * described was gone — the failure #94 exists to remove.
 *
 * ## What identity is taken from
 *
 * Every component is read from the **installation**, never from a declaration:
 *
 * - `vitePlus` — the installed `vite-plus` manifest, resolved through the shared `package-locator`
 *   (#89), so `"^0.3.2"` and `"0.3.2"` stop naming one thing.
 * - `rolldown` — the standalone `rolldown` **this package** resolves, because that is the module
 *   `probe/build.ts` imports and therefore the bundler that actually ran. It is deliberately *not*
 *   read from Vite+: `vite-plus@0.3.2` does not depend on `rolldown` at all (measured), and a
 *   record that conflated the two would say nothing about a build that goes through the other.
 * - `node` — `process.versions.node`, the runtime that executed the probe.
 * - `installGraph` — the digests below.
 *
 * ## Scope, and why it is deliberately conservative
 *
 * The install-graph digests cover the lockfile, the declared patch set (declarations *and* the
 * files they name), and the configuration that affects resolution. They are **broader than
 * necessary**: a change to a dependency no probed package can reach still invalidates, because
 * deciding reachability is the bundler's answer and this layer does not re-derive it. Narrowing to
 * the reachable subgraph is a later optimisation; guessing here would trade a false *stale* for a
 * false *fresh*, and only one of those ships broken code.
 *
 * ## Portability
 *
 * Every digest is over file **content** and repository-relative *declaration* text. No absolute
 * path is ever an input, so the same real inputs in two directories compose the same identity —
 * which is what lets a lock written on one machine be judged on another. The patch path is hashed
 * as the declaration spells it (repository-relative), never as a resolved absolute path.
 *
 * ## Absence is not the same as unreadability
 *
 * A missing lockfile, or a project with no patches declared, is a **known** state: the digests say
 * so and are non-null. A file that is *present and unreadable* is `null` — "this process cannot
 * say" — and freshness reports that as `install-graph-unknown`, which is stale. The distinction is
 * the whole of #94's third acceptance criterion: an identity that cannot be established must not
 * be rendered as a complete-looking one.
 */

/*
 * The seams this entry composes (#161): lockfile discovery, the configuration and patch digests,
 * the pnpm and npm tree digests, link targets and the toolchain read each live in
 * `install-identity/`, together with the orchestration they answer. This file keeps the four names
 * that were its surface, so `index.ts`, `internal.ts` and `local.ts` re-export exactly what they did.
 */

export { RECOGNIZED_LOCKFILE_NAMES } from "./install-identity/lockfile-discovery.ts";
export { WORKSPACE_CONFIG_FILE } from "./install-identity/config-digests.ts";
export { readInstallGraphIdentity } from "./install-identity/install-graph-identity.ts";
export { readToolchainIdentity } from "./install-identity/toolchain.ts";
