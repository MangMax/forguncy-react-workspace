/**
 * The project configuration the install-level ESM chain compiles through (#90).
 *
 * A plain object rather than `defineForguncyConfig`, for the reason the Skill's walkthrough
 * fixture records: the config loader validates the *loaded module*, and importing the authoring
 * helper would require this temporary project to resolve a workspace package it deliberately
 * does not install. A hand-written export is a valid config.
 *
 * `esm` is the chain's Cell: seven published entries — import-only, a hidden manifest, a
 * subpath-only package, a scoped package, an exact subpath, a transitive graph and a
 * browser/Node conditional export — compiled as one artifact.
 *
 * `unexported` exists so the negative case can compile a Cell that imports a subpath the
 * package's `exports` map does not publish. It is a declared Cell rather than an ad-hoc entry
 * string because `planCellCompile` is the path a project actually compiles through.
 *
 * Neither declares an `output` block: this ticket is about the dependency chain, so no code cap
 * applies.
 */
export default {
  runtime: { forguncyVersion: "12.0.100" },
  cells: {
    esm: {
      entry: "./consumer/App.tsx",
      target: { pageName: "InstallEsm", cell: "A1" },
    },
    unexported: {
      entry: "./consumer/UnexportedSubpath.tsx",
      target: { pageName: "InstallEsm", cell: "B2" },
    },
  },
};
