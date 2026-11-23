import { defineConfig, configDefaults } from "vite-plus";

export default defineConfig({
  build: {
    sourcemap: false,
  },
  check: {
    fmt: false,
  },
  lint: {
    // `.claude/skills/**` is #18's agent-discovery compatibility layer: two committed symlinks
    // (git mode `120000`) pointing into `.agents/skills/**`. Both directories are walked, so the
    // same physical file is linted twice and each finding is reported under both paths.
    //
    // The tests get the same treatment through `test.exclude` below, and this is that exclusion's
    // lint-side half — not a second, independent decision. It is spelled here rather than shared
    // because the two tools take different configuration: `vp check` reads `lint.ignorePatterns`
    // for Oxlint and `test.exclude` for Vitest, and there is no one key both read.
    //
    // `.claude` alone, and not a broader `**/node_modules/**` too: the probe fixture install
    // graphs under `packages/dependency-resolver/src/__fixtures__/` are committed miniature
    // dependencies, and their warnings are the fixture data doing its job, not noise to silence.
    // A blanket `node_modules` ignore would hide them along with everything else under that name.
    ignorePatterns: ["**/.claude/**"],
    options: {
      typeAware: false,
      typeCheck: false,
    },
  },
  test: {
    // The deduplication #100 exists for. `.claude/skills/<name>` and `.agents/skills/<name>` are
    // the same directory, so Vitest's default include glob collects every eval test under both
    // and runs it twice. Measured on the tree that added this line: 3 files collected twice, 89
    // test cases re-run, and the duplicated three include `cli-contract.test.ts` and
    // `cap-e2e.test.ts` — the two slowest files in the suite.
    //
    // `...configDefaults.exclude` is load-bearing, not decoration: Vitest **replaces** rather than
    // extends `exclude`, so a bare `exclude: ["**/.claude/**"]` drops `**/node_modules/**` and
    // `**/.git/**` with it. Measured, that takes collection from ~100 files to 1377 on this tree —
    // 1274 of them test files inside installed packages under the workspace's linked
    // `node_modules`. Spreading the defaults in is what makes this an exclusion *of one alias*
    // rather than of the whole default set.
    //
    // The canonical source is `.agents/skills/**`, which is what a reader opens and what the
    // Skill's own scripts resolve against; `.claude/skills/**` exists only so agent-discovery
    // tools that look in `.claude` still find these Skills, so excluding it here costs no coverage.
    exclude: [...configDefaults.exclude, "**/.claude/**"],

    // Cap the worker count, and pin it rather than inheriting the runner's default (#150).
    //
    // Vitest 5 changed that default: it used to be `min(12, cpus - 1)` and is now `cpus - 1`
    // uncapped, so this 16-core machine went from 12 workers to 15. This suite does not tolerate
    // the extra contention, and it fails in a way that reads as a product defect rather than a
    // scheduling one: several integration tests re-derive the install-graph identity, whose
    // `linkTargetsDigest` walks every `node_modules` location in the repository (~1.3 s on this
    // tree), and under that contention a case can overrun Vitest's 5 s default timeout. Measured
    // on the upgrade: `extension-query-poc.test.ts`'s local-projection case timed out in one
    // full-suite run at 15 workers, and did not in runs at 4 or at the 12 this pins. It is
    // contention rather than a regression — the same file passes alone either way — so the fix is
    // the worker count this suite was written against, which is also what CI's 4-core runner
    // resolves to on its own. Local and CI now schedule the same way.
    maxWorkers: 12,
  },
});
