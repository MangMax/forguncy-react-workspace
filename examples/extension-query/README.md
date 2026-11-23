# `extension-query` — the `extension` PoC, and a preserved historical record

This example exists to prove that a Cell can consume `@tanstack/react-query` through a **shared
page global** published by the verified TanStack Query Forguncy extension, rather than bundling
its own copy (#13, under Spec #12). Its authored source is ordinary React that imports the
package by name; the compiler externalizes that import through the `extension` decision in
[`fgc.lock.json`](./fgc.lock.json).

## The lock is historical real-runtime evidence — not current validation

The committed record was measured and **validated on a real Forguncy page**:

| field | recorded |
| --- | --- |
| package | `@tanstack/react-query@5.102.8` |
| strategy | `extension` (`libraryId: tanstack-query`, global `TanStackQuery`) |
| runtime target | Forguncy `12.0.100.0`, build `12.0.100.0+3d6e56feb0e449ed1cc71cc44d9f34060a06f623` |
| host React | `19.2.7` |
| probe fingerprint | `probe="inline-bundle";entry="@tanstack/react-query";analysis=14;config={};bundler={…}` |

The repository's runtime contract now targets **`12.0.102.0`**
(`RUNTIME_CONTRACT_TARGET` in `packages/core/src/runtime-contract.ts`). The record therefore
reports `stale`, and the deployment gate withholds it:

```console
$ node .agents/skills/forguncy-react-dependency-selection/scripts/select_dependency.mjs \
    status --project examples/extension-query
# "freshness": "stale"
# "stalenessReasons": ["forguncy-target-changed", "toolchain-changed", "install-graph-changed",
#                      "extension-version-unknown", "extension-identity-unknown"]
# "realRuntimeValidation": "validated"
```

Only `forguncy-target-changed` is about this record's own history; the rest are facts about
this checkout (the monorepo install graph and CI's floating Node patch, and the extension's
page-reported version/identity, which no local process can observe). In its own recorded
environment — the build it names — the record is still `fresh` and `validated`, which is what
the #13 PoC asserts.

**Owed validation:** a new real-designer run against the current build target, re-measuring the
probe and the extension identity on a real page. That cannot be done offline, so it has *not*
been simulated: the record keeps its historical `target`, its historical fingerprint and its
historical citations. Re-recording locally would legitimately clear `target` (no runtime check
ran) — that is why it was not done here, and why `status` reports the debt instead.

## `fgc-evidence/` is immutable historical evidence

Four content-addressed probe reports are cited by the record. Each filename is the SHA-256 of
the report's canonical serialization, and each file is an intact historical measurement:

| file | what it is |
| --- | --- |
| `47198a…json` | current-fact-set snapshot |
| `9ca557…json` | snapshot carrying the retracted `size.bound` fact (#79) |
| `b184ef…json` | snapshot carrying `size.estimateBias` (#79) |
| `f1de4e…json` | snapshot carrying `size.bound` (#79) |

They are kept exactly as measured. Editing a fact, renaming a file, or deleting one and
re-recording would break the content address and turn the record into a citation of something
that never ran; `status` reports that as `alteredEvidence`/`unresolvedEvidence`, and the CI
check below fails on it.

## Offline checks in CI

`.agents/skills/forguncy-react-dependency-selection/evals/example-lock-evidence.test.ts` runs on
every `vp test --run` (CI `check` and `check-windows`). It inventories every `examples/*`
directory, verifies every cited evidence reference resolves and hashes to its name, checks that
each report's `environment` agrees with the record that cites it, and asserts this record is
**preserved as historical** — stale against the current contract target, never re-labelled as
current validation. It runs no probe and compiles no Cell.

A green run there is a statement about the committed files, not about Forguncy: it is not
runtime compatibility evidence (AGENTS.md rules 6–7).
