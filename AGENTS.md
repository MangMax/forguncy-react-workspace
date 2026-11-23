# Agent rules

This repository is managed Issue-first and PR-first.

## Architecture

**Forguncy owns the application. React owns the island.**

| Forguncy owns | React cells own |
| --- | --- |
| application routing, page/global state, data sources, server commands, permissions, page lifecycle, cross-cell communication | component-local UI, local interaction state, forms, visualization, animation, drag-and-drop, charts, maps, 3D, editors, other browser UI |

## Dependency strategies

Every non-workspace dependency used by generated cell code must resolve to one of:

- `host`: provided by the ReactCellType host, e.g. React or built-in globals.
- `inline`: bundled into the generated cell artifact; the default for compatible browser-first libraries.
- `extension`: provided by a Forguncy frontend extension when shared module identity, cross-cell singleton semantics, or deliberate reuse is required.
- `replace`: the selected package is unsuitable; prefer a modern browser-first/ESM alternative instead of building a permanent adapter.

**Local workspace packages are source, not runtime modules.** A cell may import a shared workspace package such as `@app/ui` by name; the compiler flattens that source into each consuming cell artifact like any other source file. Development-stage source sharing does not imply deployed module sharing. Two cells importing the same package each carry their own copy, a React Context declared there is local to each cell, and module-scope state is per cell. Cross-cell state has to be delegated to a module the page or an extension provides, and workspace packages never receive a dependency decision and never appear in `frontendLibraries`.

The workspace graph is read from the project's own `pnpm-workspace.yaml` and each member's `package.json` (`loadPnpmWorkspaceGraph` in `packages/cell-compiler/src/workspace-graph.ts`), never hand-written. A `package.json` dependency key is a *name*: whether that name is local source or a published package is the graph's answer, and a published one still resolves through `fgc.lock.json`. Declaring `workspace:*` says local, not `inline`.

Pass that graph to `compileCell` as `options.workspace` and the compile reports the workspace-source audit beside the artifact. The graph audits, never resolves: modules still resolve through the bundler and `node_modules`, and supplying it changes no artifact byte. A circular workspace dependency is the one workspace finding that rejects a compile — the others ("a workspace import survived", "a workspace package reached `frontendLibraries`") are already rejected from the output side and are reported, not restated.

Do not introduce application routers, a second application-wide state system, authentication frameworks, or a second business-data source of truth inside React cells.

A rejected dependency is reported either as an **architectural rejection** (the capability belongs to Forguncy, so no replacement package can fix it) or as a **technical bundling failure** (the right role, the wrong artifact). These are different answers and must not be reported as one another. React Router `BrowserRouter` and application-wide duplicate business stores are platform conflicts, not packages to adapt.

Ownership boundaries are role-sensitive: a state library used for one cell's local state is fine; the same library used as the cross-cell business-state source of truth is a platform conflict.

## Local development

`vp dev` — bare, no flags — in a Cell project mounts one Cell's authored source as ordinary React, with the project's `fixture` as a mock provider: edit, see, no sync.

Bare `vp dev` needs every relative import in `packages/**` and `examples/**` to name its file with a `.ts`/`.tsx` extension, so Node's ESM loader can resolve a `vite.config.ts` that imports workspace TypeScript after Vite externalizes it. Write the extension, and keep `allowImportingTsExtensions` in the root `tsconfig.json` — one extensionless import breaks bare `vp dev` before Vite starts. Reasoning: `examples/dev-harness/package.json` under `//scripts`.

| test | fails on |
| --- | --- |
| `vp-dev-command.test.ts` | the `vp dev` **command** no longer serving the harness (spawns it, expects the plugin's mount node and entry) |
| `bare-vp-dev.test.ts` | Vite's default **loader** no longer resolving the example's config graph, the mechanism the convention exists for |
| `relative-import-extension.test.ts` | any **extensionless relative import** under `packages/**` or `examples/**`, including `.tsx` |

Keep all three; none covers another's case.

It is **not** a Forguncy emulator, and its output is `local` evidence only. A green local render says nothing about whether the designer accepts the source (it refuses `import`/`export` declarations), page lifecycle, routing, permissions, extension load order, cross-Cell isolation, or the generated host bridge — the harness resolves the *published* packages and never runs the bridge.

An `extension` dependency has no inferable local equivalent, so the project declares one of two branches per package (`extensionChoices` in `devHarness`'s options): a `substitute` with its justification, or a `real-runtime-only` acknowledgement with a reason *and* a consequence. Both branches are **enforced**: a substitute resolves the id to the named package or shim file, and `real-runtime-only` resolves it to a module that throws, so the dependency is never exercised by an npm copy the project said it could not validate. A declaration that cannot be honoured — a shim that is not there, a package that is not installed — throws, because resolving somewhere else is worse than failing.

`vp dev` audits the declaration at server start and **refuses to start** on an undeclared one. Only matched choices are applied: a choice whose decision moved to another strategy is reported as unmatched and never used for resolution, because serving a substitute while the compiler follows the lock and bundles the real package is the dev/compiler drift this layer exists to prevent. The lock is projected onto the mounted Cell first (a decision is keyed by `(package, cellTarget)`), then through the same validity pipeline the compiler runs — conformance audit plus freshness. Two freshness axes (extension version/identity, probe fingerprint) are not observable locally, so a record stale only on those is kept and reported rather than withheld: withholding it would drop every extension decision and resolve the import silently through npm. Both branches, the finding, and whether it blocks belong to the runtime package (`LOCAL_DEV_DIAGNOSTIC_RULES`); `dev-harness` reads `blocksLocalDevelopment` off that table, so a rule the contract marks blocking cannot be downgraded here by omission. Matching is exact, not a prefix, so a subpath the extension does not provide is not answered locally.

Where the loop is *more* permissive than the page, it is recorded rather than smoothed over: locally `react-dom/client` is the whole published module, while the page narrows it to the members the runtime contract observed. A local pass must never be reported as a stronger result than it is.

Run the runtime package's `formatLocalDevValidationDistinction()` to print what is still owed to a real page instead of enumerating it from memory; the harness prints it at server start for the same reason.

## Workflow

1. Every design/specification is a GitHub Issue.
2. Every implementation plan is represented by an Issue or Epic Issue.
3. Implementation is delivered through a PR that references or closes its Issue.
4. A Spec that decides ownership or dependency strategy must name the architecture Spec Issue that governs it.
5. Do not add `specs/` or `plans/` documentation directories.
6. Do not claim Forguncy runtime compatibility without an executed validation path.
7. State local checks separately from real Forguncy runtime validation; a green local build is not runtime compatibility.
