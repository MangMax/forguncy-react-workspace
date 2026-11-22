# `consumer-project` — the minimal ordinary business project

This is what a new Agent is handed: project source, `forguncy.config.ts`, the Skill, and an
authorized MCP connection. Nothing else. From here it can develop locally, build sync-ready Cell
artifacts, inspect a read-only sync plan, and sync explicitly — **without** reading seven packages'
internals or hand-assembling a `port`, a `decision`, a `target`, a `bundler`, `extensionMappings`
or a `workspace` graph. Issue: [#99](https://github.com/MangMax/forguncy-react-workspace/issues/99).

It is also the honest boundary: the tool never takes over business logic, permissions or secrets.
The Cell owns its UI; Forguncy owns the application.

## What is in here, and which contract each piece exercises

| piece | what it demonstrates |
| --- | --- |
| `cells/sales-overview/src/App.tsx` | the Cell — the *same* file `vp dev` serves and `fgc-cell build` compiles |
| `packages/consumer-ui/` | a shared workspace UI package, flattened into the Cell as source (#14) |
| `es-toolkit` | one installed ESM `inline` dependency, decided in `fgc.lock.json` (#10) |
| `runtimeFacade()` calls | data source, permission and command through the façade (#27/#82) |
| `cells/sales-overview/src/cell.css` + `badge.png` | v1 CSS and a small static asset, inlined into the one-script artifact (#98) |
| `extensions.mappings` in `forguncy.config.ts` | a **project-declared** extension row (#85/#87), not an edit to the tool's table |
| `vite.config.ts` | `defineForguncyViteConfig` — the local loop assembled in four lines (#125) |

There is **no** `.dev.tsx` twin, no `if (import.meta.env.DEV)`, and no second component. The same
source runs in both environments, which is what makes the local loop evidence about the code that
ships.

## Commands

Run each from this directory. `pnpm install` at the repository root links everything first.

```bash
# local development: the harness, HMR, this Cell's fixture as the page
vp dev

# record the dependency decision (the Skill's deterministic half)
pnpm record

# build: compile every Cell, write artifacts + manifest under .fgc/build. NO remote call.
pnpm build

# plan (read-only). Contact nothing:
pnpm plan
# plan against a designer, reading the listing and each target — still writes nothing:
pnpm plan -- --port ./mcp-port.mjs

# sync (explicit, and the only verb that writes)
pnpm sync -- --port ./mcp-port.mjs
```

The `pnpm <verb>` forms are thin aliases for `fgc-cell <verb>`; `npx fgc-cell --help` prints the
same surface.

### What each command guarantees about the outside world

| command | reads a designer | writes a designer | writes locally |
| --- | --- | --- | --- |
| `vp dev` | no | no | no |
| `record` | no | no | `fgc.lock.json`, `fgc-evidence/`, `.fgc/probe-cache/` |
| `build` | no | no | `.fgc/build/*.js`, `.fgc/build/manifest.json` |
| `plan` (offline) | no | no | nothing |
| `plan --port` | listing + each target's content | **no** | nothing |
| `sync --port` | listing + each target's content | `setCells`, `saveProject`, page generation | nothing |

`sync` has no default port. An authorized designer connection is the caller's — the Agent's MCP
session or a project-owned adapter — so a port module must be named, and its absence is a usage
error rather than a silent dry run that looks like a deployment.

### A port module

`--port <module>` imports the file (relative to the project root) and takes its default export, or
a named `port`, as a `ForguncySyncPort` from `@forguncy-react-workspace/mcp-sync`: the seven
methods `listFrontendLibraries`, `readCellSource`, `setCells`, `getProjectSaveStatus`,
`saveProject`, `checkProjectErrors`, `generatePageAsync`. Adapters for a real designer session live
outside this example; the shape is what this project owns.

## The lock is a measurement, not a decoration

`pnpm record` writes `fgc.lock.json` and `fgc-evidence/`, and both are **git-ignored**. That is a
measured decision, not an omission: a record's `probedWith.installGraph` digests the installed
tree, and this repository's own `vp dev` / `vp test` runs write caches under `node_modules`. A
committed record therefore reported `install-graph-changed` as soon as it was exercised on the
machine that recorded it — a measurement presented as project state #94 does not support.

What *is* committed is the decision **input**, `dependencies/es-toolkit.decision.json`: the
strategy and the reason, which is the half a reviewer can judge in a diff. `pnpm record` turns it
into a measurement of the machine running it, and `plan`/`build` report a stale record with
`pnpm record` as the named fix rather than compiling through it silently.

`example-lock-evidence.test.ts` classifies this example as `per-machine-record` and verifies the
committed input is present, so "no lock" cannot be confused with "nobody decided anything".

## What this example does **not** claim

A green `vp dev`, `build` or `plan` is **local** evidence. It does not establish that:

- the designer accepts the source (`import`/`export` declarations are what authored source is made
  of, and the designer refuses them — the compiler is what bridges that);
- the page publishes `ExampleChartPanel` for the extension row declared here;
- a sync lands, or that the generated page behaves.

Those are a real Forguncy run against `RUNTIME_CONTRACT_TARGET`, which the final gate
([#107](https://github.com/MangMax/forguncy-react-workspace/issues/107)) owns. AGENTS.md rules 6–7
are the rule this section exists to obey.

### Where the extension row is actually exercised

`forguncy.config.ts` declares a mapping for `@example/chart-panel`, but this Cell does not import
that package: an `extension` import needs a recorded `extension` decision *and* the real extension
on a page, and this example has neither. What is exercised here is the *consumer* half — a project
row that the registry normalizes, the build report carries, and `sync` passes to its extension
audit. The compile-and-sync half (a Cell importing a mapped package, the artifact reading the page
global and carrying the library id) is `examples/extension-custom`'s chain, and `mcp-sync`'s own
suite. Keeping the two apart is deliberate: a green build here says nothing about whether that
extension exists, which is exactly the claim a committed example must not make.
