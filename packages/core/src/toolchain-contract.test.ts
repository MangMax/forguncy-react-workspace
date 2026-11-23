/**
 * The static-analysis gate, pinned where narrowing it has to be deliberate.
 *
 * Decision source: GitHub Issue #163 — "chore(lint): enable type-aware lint in vp check"
 * (https://github.com/MangMax/forguncy-react-workspace/issues/163), under the parent spec #152
 * (https://github.com/MangMax/forguncy-react-workspace/issues/152), whose last decision is
 * "type-aware lint is enabled and passes".
 *
 * ## What this can and cannot say
 *
 * It reads `vite.config.ts` as text, the same way `ci-contract.test.ts` reads the CI workflow.
 * The claim is about the repository's configuration: a setting that a future edit can switch off
 * in one line and nothing else in the suite would notice. It does not prove that any particular
 * type-aware rule fires — that is `vp check`'s own job, and a green run there is local evidence
 * only (AGENTS.md rules 6–7).
 *
 * ## Why the waivers are checked too
 *
 * The Issue accepts a rule being switched off only "with a one-line reason". A bare `"off"` is
 * indistinguishable from a rule someone silenced to get a green run, so the reason is part of the
 * contract rather than a review convention: every switched-off rule carries its `//` explanation
 * on the same line, and this file fails when one does not.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The root config's text with line endings normalized to LF.
 *
 * Normalized for the reason `#91` recorded: a Windows checkout is CRLF, and a test that reads
 * file contents must not depend on what Git did to the file.
 */
function rootConfig(): string {
  return readFileSync(join(repositoryRoot, "vite.config.ts"), "utf8").replace(/\r\n/g, "\n");
}

describe("type-aware lint is part of `vp check`", () => {
  it("enables lint.options.typeAware", () => {
    expect(rootConfig()).toMatch(/^ {6}typeAware: true,$/m);
  });

  it("states a reason on the same line as every rule it switches off", () => {
    const switchedOff = rootConfig()
      .split("\n")
      .filter(line => /^\s*"[^"]+\/[^"]+":\s*"off",/.test(line));

    for (const line of switchedOff) {
      expect(line, `a switched-off rule needs a stated reason: ${line.trim()}`).toMatch(/\/\/ \S/);
    }
  });
});
