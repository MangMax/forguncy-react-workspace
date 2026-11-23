/**
 * The full projection of this package's modules — the surface the root entry used to export.
 *
 * It exists for this package's own tests (#159): the root entry exports only what another
 * workspace package, an example, or the dependency-selection Skill imports, so a test that
 * reaches past that imports it from here. No other package may import this entry;
 * `package-boundaries.test.ts` asserts that.
 */

export * from "./plugin.ts";
