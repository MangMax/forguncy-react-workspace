/**
 * #95's cache contract, measured by running the probe twice on **real install graphs**.
 *
 * Decision source: GitHub Issue #95 — "修复 Probe 缓存：依赖图变化失效，并阻止旧报告继续放行"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/95
 *
 * Governing Specs: #8 (a fingerprint is a function of declared inputs; freshness is a separate
 * comparison), #16 (the probe protocol and its determinism premise), #17 (the engine and its
 * cache), #94 (the identity those comparisons now read).
 *
 * ## Why these cases build a filesystem instead of constructing an identity
 *
 * #94 already proved that `readToolchainIdentity` *sees* a transitive bump, a patch and a real
 * bundler move. The question here is one layer out: does the **cache** consult that identity before
 * answering, and does the answer say what moved? A hand-written identity object would test the
 * comparison while skipping the thing #95 is about — the reader — so every run below derives its
 * toolchain through `readToolchainIdentity(projectRoot)` and every change is made to the files a
 * real install writes: `package-lock.json`, `node_modules/.package-lock.json`, a patch file, and
 * the virtual-store slot names.
 *
 * `./build.ts` is wrapped rather than mocked away, so `buildCalls` counts **executed builds** and
 * the report is still produced by the real Rolldown stack. That count is the acceptance evidence:
 * "the cache missed" is only meaningful if the measurement actually ran.
 *
 * ## What is local, and what is not
 *
 * Local checks only: these tests run the probe's own Rolldown build over a temp tree and read a
 * lockfile. They make no Forguncy runtime claim, and `runtime-smoke` is deliberately never passed a
 * hook here — a green run of this file is evidence about cache semantics, not about a real page.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Build invocations for the current case.
 *
 * The wrapper delegates to the real `runCandidateBuild`, so the count answers "was the measurement
 * executed" without replacing the measurement with a stub.
 */
const buildCalls = { count: 0 };

vi.mock("./build.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./build.ts")>();
  return {
    ...actual,
    runCandidateBuild: async (options: Parameters<typeof actual.runCandidateBuild>[0]) => {
      buildCalls.count += 1;
      return actual.runCandidateBuild(options);
    },
  };
});

import type { ToolchainIdentity } from "@forguncy-react-workspace/core";

import { createFileProbeCache } from "./cache.ts";
import { runDependencyProbe } from "./probe-engine.ts";
import { readToolchainIdentity } from "../install-identity.ts";

const CANDIDATE = "probe-candidate";
const TRANSITIVE = "transitive-lib";

async function writeFileAt(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

/**
 * A project whose candidate and transitive dependency are real installed packages.
 *
 * npm's shape is chosen because its identity components are all readable from files this test can
 * write deterministically: the visible `package-lock.json`, the hidden materialized record
 * (`node_modules/.package-lock.json`) and the tree itself. pnpm's equivalent needs a virtual store
 * whose slot layout is pnpm's to define; this file tests the cache, and #94's own suite already
 * covers the pnpm store reader.
 */
async function writeProject(
  root: string,
  options: {
    readonly transitiveVersion: string;
    /** Which npm record carries the version: the visible lock, the materialized one, or both. */
    readonly where: "both" | "installedTree";
    readonly patch?: string;
  },
): Promise<void> {
  const { transitiveVersion: transitive, where } = options;

  await writeFileAt(
    join(root, "package.json"),
    JSON.stringify({ name: "cache-fixture", version: "0.0.0", private: true, type: "module" }, null, 2),
  );

  const candidate = {
    name: CANDIDATE,
    version: "1.0.0",
    license: "MIT",
    type: "module",
    main: "index.js",
    exports: { ".": { import: "./index.js", default: "./index.js" }, "./package.json": "./package.json" },
  };
  await writeFileAt(join(root, "node_modules", CANDIDATE, "package.json"), JSON.stringify(candidate, null, 2));
  await writeFileAt(
    join(root, "node_modules", CANDIDATE, "index.js"),
    `export function measure() {\n  return 1;\n}\n`,
  );

  const transitivePackage = { name: TRANSITIVE, version: transitive, type: "module", main: "index.js" };
  await writeFileAt(
    join(root, "node_modules", CANDIDATE, "node_modules", TRANSITIVE, "package.json"),
    JSON.stringify(transitivePackage, null, 2),
  );
  await writeFileAt(
    join(root, "node_modules", CANDIDATE, "node_modules", TRANSITIVE, "index.js"),
    `export const value = ${transitive === "1.0.0" ? "1" : "2"};\n`,
  );

  // The visible lock: what a real re-resolution writes when the transitive moves.
  const lockPackages = {
    "": {
      name: "cache-fixture",
      version: "0.0.0",
      dependencies: { [CANDIDATE]: "1.0.0" },
    },
    [`node_modules/${CANDIDATE}`]: {
      version: "1.0.0",
      resolved: `https://registry.example/${CANDIDATE}/-/${CANDIDATE}-1.0.0.tgz`,
      integrity: "sha512-candidate",
    },
    [`node_modules/${CANDIDATE}/node_modules/${TRANSITIVE}`]: {
      version: where === "both" ? transitive : "1.0.0",
      resolved: `https://registry.example/${TRANSITIVE}/-/${TRANSITIVE}-${where === "both" ? transitive : "1.0.0"}.tgz`,
      integrity: where === "both" ? `sha512-transitive-${transitive}` : "sha512-transitive-1.0.0",
    },
  };
  await writeFileAt(
    join(root, "package-lock.json"),
    JSON.stringify({ name: "cache-fixture", version: "0.0.0", lockfileVersion: 3, requires: true, packages: lockPackages }, null, 2),
  );

  // The hidden, materialized record: npm's own account of what is on disk. It is where the
  // `--no-save` shape shows up (a different transitive reified under an unchanged visible lock),
  // and `installedTree` is the component that has to see it.
  const installedPackages = {
    "": { name: "cache-fixture", version: "0.0.0", dependencies: { [CANDIDATE]: "1.0.0" } },
    [`node_modules/${CANDIDATE}`]: {
      version: "1.0.0",
      resolved: `https://registry.example/${CANDIDATE}/-/${CANDIDATE}-1.0.0.tgz`,
      integrity: "sha512-candidate",
    },
    [`node_modules/${CANDIDATE}/node_modules/${TRANSITIVE}`]: {
      version: transitive,
      resolved: `https://registry.example/${TRANSITIVE}/-/${TRANSITIVE}-${transitive}.tgz`,
      integrity: `sha512-transitive-${transitive}`,
    },
  };
  await writeFileAt(
    join(root, "node_modules", ".package-lock.json"),
    JSON.stringify(
      {
        name: "cache-fixture",
        version: "0.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: installedPackages,
      },
      null,
      2,
    ),
  );

  if (options.patch !== undefined) {
    // A declared patch is pnpm's site, and `patchesDigest` reads it for any manager — the
    // declaration plus the file's content are two halves of one fact.
    await writeFileAt(
      join(root, "pnpm-workspace.yaml"),
      `patchedDependencies:\n  ${TRANSITIVE}@${transitive}: patches/${TRANSITIVE}.patch\n`,
    );
    await writeFileAt(join(root, "patches", `${TRANSITIVE}.patch`), options.patch);
  }
}

async function withProject(
  root: string,
  body: (root: string) => Promise<void>,
): Promise<void> {
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

beforeEach(() => {
  buildCalls.count = 0;
});

describe("#95: probe cache invalidation on real install graphs", () => {
  it("hits stably when nothing moves, and re-runs the build when only the installed tree moves", async () => {
    const root = await mkdtemp(join(tmpdir(), "fgc-cache-95-"));
    await withProject(root, async root => {
      await writeProject(root, { transitiveVersion: "1.0.0", where: "both" });

      // 1. Cold: no report stored under these declared inputs.
      const first = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE });
      expect(first.fromCache).toBe(false);
      expect(first.cache).toMatchObject({ outcome: "miss", reason: "no-cached-report" });
      expect(buildCalls.count).toBe(1);

      // 2. Unchanged inputs: the cache answers, and no second build happens.
      const second = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE });
      expect(second.fromCache).toBe(true);
      expect(second.cache).toEqual({ outcome: "hit", reason: null, detail: null });
      expect(buildCalls.count).toBe(1);
      expect(second.fingerprint).toBe(first.fingerprint);

      // 3. The `--no-save` shape: the *materialized* record reifies a different transitive while
      //    the visible lock and the candidate's own version hold still. `installedTree` is the only
      //    component that can see it, and the cached report must not answer.
      await writeProject(root, { transitiveVersion: "2.0.0", where: "installedTree" });
      const moved = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE });

      expect(moved.fromCache).toBe(false);
      expect(moved.cache.outcome).toBe("miss");
      expect(moved.cache.reason).toBe("install-graph-changed");
      // Readable, and it names the component that moved rather than "something changed".
      expect(moved.cache.detail).toContain("installedTree");
      // The fingerprint is unchanged by design — the toolchain is modeled separately — which is
      // exactly why the cache could not rely on the key alone.
      expect(moved.fingerprint).toBe(first.fingerprint);
      expect(moved.report.environment.toolchain.installGraph?.installedTree).not.toBe(
        first.report.environment.toolchain.installGraph?.installedTree,
      );
      expect(buildCalls.count).toBe(2);

      // 4. The new state is stable: a repeat run hits again.
      const afterMove = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE });
      expect(afterMove.fromCache).toBe(true);
      expect(buildCalls.count).toBe(2);
    });
  });

  it("re-probes when a transitive bump rewrites the lock, with the root package version held still", async () => {
    const root = await mkdtemp(join(tmpdir(), "fgc-cache-95-lock-"));
    await withProject(root, async root => {
      await writeProject(root, { transitiveVersion: "1.0.0", where: "both" });
      const first = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE });
      expect(first.fromCache).toBe(false);
      expect(first.report.environment.packageVersion).toBe("1.0.0");

      // A real re-resolution: the visible lock and the hidden record both name `transitive-lib@2`
      // while the candidate — the package the record measures — stays at 1.0.0.
      await writeProject(root, { transitiveVersion: "2.0.0", where: "both" });
      const bumped = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE });

      expect(bumped.report.environment.packageVersion).toBe("1.0.0");
      expect(bumped.fromCache).toBe(false);
      expect(bumped.cache.reason).toBe("install-graph-changed");
      expect(bumped.cache.detail).toContain("lockfile");
      expect(buildCalls.count).toBe(2);
    });
  });

  it("re-probes when a patch is added, and the reason names the patch half of the graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "fgc-cache-95-patch-"));
    await withProject(root, async root => {
      await writeProject(root, { transitiveVersion: "1.0.0", where: "both" });
      const first = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE });
      expect(first.fromCache).toBe(false);

      await writeProject(root, {
        transitiveVersion: "1.0.0",
        where: "both",
        patch: "--- a/index.js\n+++ b/index.js\n",
      });
      const patched = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE });

      expect(patched.fromCache).toBe(false);
      expect(patched.cache.reason).toBe("install-graph-changed");
      expect(patched.cache.detail).toContain("patches");
      expect(buildCalls.count).toBe(2);

      // Editing the patch's text without re-installing is the second half of the same fact.
      await writeProject(root, {
        transitiveVersion: "1.0.0",
        where: "both",
        patch: "--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-1\n+2\n",
      });
      const edited = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE });
      expect(edited.fromCache).toBe(false);
      expect(edited.cache.reason).toBe("install-graph-changed");
      expect(buildCalls.count).toBe(3);
    });
  });

  it("re-probes when the bundler that actually ran differs, and hits again when it agrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "fgc-cache-95-tool-"));
    await withProject(root, async root => {
      await writeProject(root, { transitiveVersion: "1.0.0", where: "both" });
      const installed = await readToolchainIdentity(root);
      // `rolldown` is read from this package's resolution (#94), so it is a real installed version
      // here; overriding it is how the case says "a different bundler is running now" without a
      // second install.
      const upgraded: ToolchainIdentity = { ...installed, rolldown: "9.9.9" };

      const first = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE, toolchain: installed });
      expect(first.fromCache).toBe(false);
      expect(first.cache.reason).toBe("no-cached-report");

      const moved = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE, toolchain: upgraded });
      expect(moved.fromCache).toBe(false);
      expect(moved.cache.reason).toBe("toolchain-changed");
      expect(moved.cache.detail).toContain("rolldown");
      expect(buildCalls.count).toBe(2);

      // The control: the same moved identity twice is a known, equal value — and it hits.
      const repeat = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE, toolchain: upgraded });
      expect(repeat.fromCache).toBe(true);
      expect(buildCalls.count).toBe(2);
    });
  });

  it("never treats a missing identity as agreement, on either side", async () => {
    const root = await mkdtemp(join(tmpdir(), "fgc-cache-95-unknown-"));
    await withProject(root, async root => {
      await writeProject(root, { transitiveVersion: "1.0.0", where: "both" });
      const installed = await readToolchainIdentity(root);
      const withoutGraph: ToolchainIdentity = { ...installed, installGraph: undefined };

      // An unidentifiable graph does not make the *first* run fail — there is nothing stored to
      // disagree with, so it measures. The requirement is that the stored report never answers a
      // repeat on the strength of two identical silences: from the second run on, #94/#95 both
      // require this to be a miss with an explicit reason.
      const first = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE, toolchain: withoutGraph });
      expect(first.fromCache).toBe(false);
      expect(first.cache.reason).toBe("no-cached-report");

      const second = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE, toolchain: withoutGraph });
      expect(second.fromCache).toBe(false);
      expect(second.cache.reason).toBe("install-graph-unknown");

      // And the mixed shape: a report that *can* identify the graph must not answer a run that
      // cannot say which one it has. This is the pre-#94 cache entry, answered by a run with an
      // installed tree — the case a warm `.fgc/probe-cache/` used to satisfy.
      const identified = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE });
      expect(identified.fromCache).toBe(false);
      const cannotSay = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE, toolchain: withoutGraph });
      expect(cannotSay.fromCache).toBe(false);
      expect(cannotSay.cache.reason).toBe("install-graph-unknown");

      expect(buildCalls.count).toBe(4);
    });
  });

  it("never reads or writes the cache when the caller disabled it", async () => {
    const root = await mkdtemp(join(tmpdir(), "fgc-cache-95-disabled-"));
    await withProject(root, async root => {
      await writeProject(root, { transitiveVersion: "1.0.0", where: "both" });
      const warm = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE });
      expect(warm.cache.outcome).toBe("miss");
      const cacheFile = join(root, ...warm.cacheRelativePath.split("/"));
      const before = await readFile(cacheFile, "utf8");

      const disabled = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE, cache: false });
      expect(disabled.fromCache).toBe(false);
      expect(disabled.cache).toMatchObject({ outcome: "disabled", reason: null });
      // A real build ran, and the stored bytes were not replaced by it.
      expect(buildCalls.count).toBe(2);
      expect(await readFile(cacheFile, "utf8")).toBe(before);

      // And the disabled run did not claim a hit on a *later* attempt either: the stored report is
      // still there, so the next cache-enabled run hits it — which shows the previous run did not
      // consult it.
      const enabledAgain = await runDependencyProbe({ projectRoot: root, packageName: CANDIDATE });
      expect(enabledAgain.fromCache).toBe(true);
      expect(buildCalls.count).toBe(2);
    });
  });

  it("does not let two projects sharing one root package version answer for each other", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "fgc-cache-95-a-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "fgc-cache-95-b-"));
    try {
      await writeProject(firstRoot, { transitiveVersion: "1.0.0", where: "both" });
      await writeProject(secondRoot, { transitiveVersion: "2.0.0", where: "both" });

      // A cache object deliberately shared across the two roots, which is the strongest form of
      // the question: same fingerprint, same package name, same root version — only the translated
      // graph differs. A cache that answered on the key alone would serve project A's report to
      // project B. The second view is read-only so B *reads* A's stored report without replacing it;
      // otherwise this would test the write race rather than the identity gate.
      const shared = createFileProbeCache(firstRoot);
      const readOnlyShared = {
        get: (fingerprint: string) => shared.get(fingerprint),
        set: async () => undefined,
      };

      const a = await runDependencyProbe({ projectRoot: firstRoot, packageName: CANDIDATE, cache: shared });
      expect(a.fromCache).toBe(false);
      expect(a.report.environment.packageVersion).toBe("1.0.0");

      // Project B's probe *identity* (its own install graph, read through its own root) is what the
      // second run must compare against, so the environment is supplied from B rather than A.
      const bEnvironment = await readToolchainIdentity(secondRoot);
      const b = await runDependencyProbe({
        projectRoot: secondRoot,
        packageName: CANDIDATE,
        cache: readOnlyShared,
        toolchain: bEnvironment,
      });
      expect(b.fromCache).toBe(false);
      expect(b.cache.reason).toBe("install-graph-changed");
      expect(b.report.environment.packageVersion).toBe("1.0.0");
      expect(buildCalls.count).toBe(2);

      // Project A's own follow-up still hits its own report — the one B was refused.
      const again = await runDependencyProbe({
        projectRoot: firstRoot,
        packageName: CANDIDATE,
        cache: shared,
        toolchain: await readToolchainIdentity(firstRoot),
      });
      expect(again.fromCache).toBe(true);
      expect(buildCalls.count).toBe(2);
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });
});
