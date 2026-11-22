/**
 * Ambient declarations for the fixture packages the consumer entries import.
 *
 * The consumer lives inside `packages/cell-compiler/src/__fixtures__/`, which is type-checked
 * (`tsconfig.typecheck.json` includes `packages/**`), while its dependencies are installed only
 * in the temporary copy `install-esm-chain.test.ts` builds. So the modules it imports are
 * declared here rather than resolved: the declarations are the fixture API the entry uses, and
 * the runtime behaviour is the fixture's own JavaScript — which is exactly what the test
 * executes.
 *
 * A global script with ambient declarations rather than a module: importing anything here would
 * turn the file into a module and those declarations into local ones.
 */
declare module "fgc-fixture-import-only" {
  export function importOnly(): string;
}

declare module "fgc-fixture-hidden" {
  export function hiddenManifest(): string;
}

declare module "fgc-fixture-subpath-only/only" {
  export function only(): string;
}

declare module "fgc-fixture-sub/extra" {
  export function extra(): string;
}

declare module "@fgc-fixture/scoped-esm" {
  export function scoped(): string;
}

declare module "fgc-fixture-transitive" {
  export function transitive(): string;
}

declare module "fgc-fixture-browser-cond" {
  export function whichBranch(): string;
}

/**
 * The subpath the package does **not** publish. Declared because the negative case compiles
 * this entry and the bundler — not the type checker — is the authority that refuses the
 * specifier; a missing declaration would make the case fail before it reached the bundler.
 */
declare module "fgc-fixture-sub/private" {
  export function privateExport(): string;
}
