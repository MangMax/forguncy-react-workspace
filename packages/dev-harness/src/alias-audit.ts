/**
 * The project-alias parsing and audit, moved verbatim from `vite-plugin.ts` (#160).
 *
 * `vite-plugin.ts` keeps the hooks: this file holds the extraction of the project's own
 * `vite.config.ts` aliases, Vite's matching rules reproduced for it, and the two audits built on
 * them — the host-alias filter and the subtraction that finds an alias no one declared.
 */

import { hostModuleAliases } from "./host-modules.ts";

/**
 * The host aliases a project has *not* already claimed for itself.
 *
 * Vite merges a plugin's `config()` result over the user's config, so an alias emitted here can
 * win against the project's own — which is wrong for the one case the split exists to support: a
 * project deliberately pointing a host package somewhere else (a patched React, a local fork).
 * Dropping the ids the project already claims is what turns `harnessHostModulePlan()` from a
 * duplicate of this hook into an actual override.
 *
 * ## Claiming is a *prefix* relation, not equality
 *
 * Vite decides whether an alias entry matches an import with:
 *
 * ```js
 * importee === pattern || importee.startsWith(pattern + "/")
 * ```
 *
 * so naming `react` claims `react/jsx-runtime` and `react/jsx-dev-runtime` as well. Filtering by
 * exact equality was therefore wrong, and the fix is to reproduce Vite's rule in
 * {@link isClaimedBy} rather than invent a simpler one.
 *
 * ## Why only the array form actually broke, which is worth recording
 *
 * The merge order differs by form, so the same bug had different consequences. Measured against
 * Vite 8.3.0 with a real server, with the harness emitting its own `react/jsx-dev-runtime` entry
 * beside a project claiming `react`:
 *
 * | project's `resolve.alias` | entries, in evaluation order | bare `react` | `react/jsx-dev-runtime` |
 * | --- | --- | --- | --- |
 * | object `{ react: "/patched" }` | `[react, react/jsx-dev-runtime]` | project | **project** |
 * | array `[{ find: "react" }]` | `[react/jsx-dev-runtime, react]` | project | **harness** |
 *
 * With the object form Vite produces the project's entry *first*, so its prefix match wins the
 * subpath and the exact-equality filter was harmless. With the array form the harness's entry
 * comes first and wins — the project got its patched React for the bare import and the harness's
 * stock React for every JSX runtime import. That asymmetry is why a resolution-level test is
 * needed and an alias-list assertion is not enough: in the object case the list looks fine, and in
 * the array case it also looks fine, because the defect is in evaluation order rather than in
 * contents.
 *
 * ## The three forms, and what changed for RegExps
 *
 * - **object form** (`{ react: "/path" }`) — the keys, normalized then matched by the prefix rule;
 * - **array string `find`** — normalized then matched by the prefix rule;
 * - **array `RegExp` `find`** — matched by `pattern.test(importee)`, which is what Vite itself
 *   does with it. This replaces an earlier conservative version that ignored RegExps, reasoning
 *   that which ids they match is undecidable. It is decidable: the question is not what the
 *   expression *means* but whether it matches each of the finite host ids, and `test` answers
 *   that. Ignoring them was wrong in the direction that matters — a project's `find: /^react$/`
 *   override would have been beaten by the harness exactly as the array string case was.
 *
 * ## Why the string form is normalized before matching
 *
 * A third review round found that matching the `find` *as written* is still not the same question
 * as matching the `find` Vite uses, because Vite normalizes a trailing slash off both `find` and
 * `replacement` when both carry one. `{ find: "react/", replacement: "/patched-react/" }` is a
 * valid alias, and matching `"react/"` claims neither `react` nor `react/jsx-dev-runtime`, so the
 * harness kept its exact aliases and the project's override did nothing at all — worse than the
 * subpath-only failure the previous round found.
 *
 * The rule is reproduced rather than approximated: stripping the slash unconditionally would
 * decline to alias on behalf of `{ find: "react/", replacement: "/patched-react" }`, which Vite
 * does *not* normalize and whose prefix rule therefore matches nothing — leaving a project with no
 * React at all. Both conditions are Vite's, so both are reproduced, in both alias forms.
 *
 * Each round of this filter has shared one shape, and it is worth naming because the next change
 * here should watch for it: the filter decides by *reimplementing* a rule Vite already owns, so it
 * is only ever as correct as its reproduction — equality instead of prefix, then prefix without
 * normalization, then normalization in one form and not the other. The tests that guard it
 * therefore assert through `pluginContainer.resolveId` rather than against the alias list, since
 * every one of the first two defects was invisible in the list.
 *
 * An `undefined` or unreadable `userAlias` claims nothing, so a bare `devHarness({ config })`
 * with no `resolve.alias` of its own still gets the full plan.
 */
export function unclaimedHostAliases(userAlias: unknown): Record<string, string> {
  const patterns = readAliasPatterns(userAlias);

  return Object.fromEntries(
    Object.entries(hostModuleAliases()).filter(([moduleId]) => !patterns.some(pattern => isClaimedBy(pattern, moduleId))),
  );
}

/**
 * Every alias `find` the user's config declares, as Vite will see it, in either shape.
 *
 * Both forms are read because Vite accepts either and a project may use whichever. A member that
 * is not a usable pattern — an array entry that is not an object, an object key that is empty —
 * is dropped rather than guessed at; an unreadable pattern claims nothing, which leaves the
 * harness's alias in place.
 *
 * Both forms are also normalized, and the fourth round's documentation fix is why that is stated
 * rather than implied. An earlier version of this comment claimed object-form aliases "have no
 * such rule", on the reasoning that this module reads only the keys of a `{ key: value }` map. The
 * rule is not in the reading, it is in Vite: object entries are converted to `{ find, replacement }`
 * pairs by `Object.entries` and then run through the same `normalizeSingleAlias`, so
 * `{ "react/": "/patched-react/" }` really does become `find: "react"`. Measured against Vite
 * 8.3.0 — the entry arrives as `react` and both `react` and `react/jsx-dev-runtime` resolve to the
 * project's path.
 *
 * Reproducing it in both branches matters even though the *bug* it caused was array-only. An
 * object-form alias with trailing slashes was still misjudged by the filter — the harness kept its
 * own `react` entry alongside the project's, and the resolution happened to be right only because
 * the project's entry is merged first. Two entries for one id disagreeing about nothing is a
 * latent failure, not a working state, and `vite-plugin.test.ts` asserts on the entry set for this
 * case rather than on the resolved id, precisely because the id looked fine either way.
 *
 * Returning patterns of one type rather than a `{ find, replacement }` record keeps
 * `isClaimedBy`'s contract as simple as the string-or-RegExp question it actually asks.
 */
/**
 * The project keys a `RegExp` alias `find` shadows, paired with the pattern that does it.
 *
 * ## Why the pattern is evaluated rather than approximated
 *
 * An earlier version passed `pattern.source` and let the audit compare it as a string. That is
 * unsound in the direction that matters: `^@app\/shared(?=\/|$)` becomes the string
 * `@app/shared(?=/|$)`, which is neither equal to the project key nor a `/`-prefix of it, so a
 * pattern Vite genuinely applies to `@app/shared/thing` passed the check and the dev/build split
 * returned silently. Review found it; measured before fixing.
 *
 * Deciding "can this regex match a string that is `key` or a subpath of it" in general is an
 * intersection problem, and this does **not** attempt to solve it. It does something both sound and
 * simple: it runs the caller's own `RegExp` against the specifiers a project alias can actually
 * match, using the caller's own regex engine. A hit is a fact rather than an inference, so there is
 * no approximation left to be wrong about.
 *
 * ## Why that is not a heuristic
 *
 * The probe set is a **superset** of what the project alias can match, not a sample of it. A
 * project key `k` covers `k` and every string beginning `k + "/"`; the set below is `k`, `k + "/"`,
 * and a bounded set of `k + "/a…"` extensions. A pattern that matches any member of the set shadows
 * at least that specifier, so refusing is sound. A pattern that matches none is not *proved*
 * disjoint — a pattern needing five path segments could match `k + "/a/b/c/d/e"` without matching
 * the ones probed — so the residue is decided by the one test that cannot be wrong: a source with
 * no metacharacters can only match the literal it spells, and anything else is undecidable and
 * refused.
 *
 * ## Why there is no static prefix exemption
 *
 * An earlier version added one: a `^`-anchored pattern's leading literal run was treated as
 * mandatory on every match, so a key that could not start with it was skipped without being
 * tested. Review found the premise false in three independent ways, each reproduced against a
 * real Vite server before removing it — with a project alias `@app/shared -> ./shared`, all three of
 * these **do** apply to `@app/shared/thing`, and all three sailed through the exemption:
 *
 * | pattern | why the extracted prefix was wrong |
 * | --- | --- |
 * | `/^@APP\/SHARED(?=\/|$)/i` | the `i` flag makes matching case-insensitive; `startsWith` is not |
 * | `/^other\|@app\/shared(?=\/|$)/` | `^` binds only the first alternative, so `other` is not required of the second branch |
 * | `/^@app\/\x73hared(?=\/|$)/` | `\x73` is the character `s`; the extractor treated it as a two-character escape |
 *
 * So the exemption was not merely imprecise — it was a **silent bypass** of a blocking gate, which
 * is the one failure mode this whole check exists to prevent. Correct regex-prefix analysis would
 * have to handle flags, alternation, quantifiers, classes, lookaround and every escape form before
 * it could prove anything; that analysis is not implemented, so there is no exemption, and a
 * `RegExp` is judged only by being run.
 *
 * The cost is that a complex regex which overlaps nothing may also be refused. That is the correct
 * trade for a blocking gate — the remedy is a plain string alias, which is checked exactly and is
 * what a project would write for an id it means literally.
 *
 * ## What it returns, and why the key is echoed back verbatim
 *
 * Each returned string is the **project key**, not the pattern. That is what lets a `RegExp` reach
 * the audit through the same door as a string key — the audit compares strings and needs no regex
 * knowledge. The cost is that the finding then quotes the project key as though `vite.config.ts`
 * had declared it, which for a pattern that did *not* literally spell the key is a misattribution:
 * measured, an undecidable pattern produced a message saying `vite.config.ts` "declares an alias
 * \`@app/shared\`" when it declared no such thing.
 *
 * So the pattern is returned in the position the audit reads as `find`, by prefixing it with the
 * key it shadows. The audit's message then names a string that *is* in the config file, and the
 * comparison still matches exactly — one value, correct in both roles.
 */
/**
 * One alias entry with its `replacement` kept, which `readAliasPatterns` throws away.
 *
 * The subtraction in {@link undeclaredAliasEntries} has to answer "is this final entry still the
 * contribution we know?", and a key cannot answer it: Vite's merge keeps the last value for a
 * repeated key, so a later plugin that rewrites `react -> /local-copy/react` produces a final entry
 * whose `find` is one the harness owns and whose `replacement` is not the one the harness emitted
 * (measured — dev resolved `react` to `/local-copy/react` while the harness's own alias was skipped
 * on key alone). Keeping the pair is what makes the comparison an identity check on the whole
 * contribution rather than a name check.
 */
/**
 * Whether a value is a resolver Vite will actually honour, in either of the two forms it accepts.
 *
 * Vite 8.3.0 (the version this behaviour was measured on; the repository pins the same 8.3
 * line) types the field as
 * `ResolverFunction | ResolverObject | null`, and its runtime `resolveCustomResolver` follows the
 * same two shapes:
 *
 * ```js
 * function resolveCustomResolver(customResolver) {
 *   if (typeof customResolver === "function") return customResolver;
 *   if (customResolver) return getHookFunction(customResolver.resolveId);
 *   return null;
 * }
 * ```
 *
 * So the object form — `{ resolveId() { … } }` — is a resolver too. Recognising only functions left
 * the round-13 bypass open by a different spelling (measured: a later plugin repeating the
 * harness's own `react` find *and* replacement with only `customResolver: { resolveId }` added
 * resolved `react` to `/local-copy/react` while the artifact kept the host bridge's page `React`).
 *
 * What is deliberately not distinguished is *which* resolver: the policy is fail-closed, so the
 * only question is whether one is present, never what it would do.
 */
function isViteHonouredResolver(value: unknown): boolean {
  if (typeof value === "function") {
    return true;
  }
  if (typeof value === "object" && value !== null) {
    return typeof (value as { resolveId?: unknown }).resolveId === "function";
  }
  // `null` and `undefined` are the two values Vite's own `resolveCustomResolver` turns into "no
  // resolver", so they are the two this treats as absent.
  return false;
}

export interface AliasEntry {
  readonly find: string | RegExp;
  /** The value as authored, or `undefined` when the entry shape carried none. */
  readonly replacement: string | undefined;
  /**
   * Whether the entry carried Vite's `customResolver` — a resolver *function*, which decides
   * resolution instead of the `replacement` string.
   *
   * Recorded as a boolean rather than the function, deliberately. Two functions cannot be compared
   * for behavioural equality, so an entry carrying one is **refused** rather than accepted as equal
   * to a plain one (measured: a later plugin repeating the harness's own `react` find *and*
   * replacement and adding only a `customResolver` made Vite resolve `react` to the resolver's
   * `/local-copy/react`, while the artifact kept the host bridge's page `React`). Recording the fact
   * and comparing it is what lets the check answer; keeping the function would only invite a
   * comparison that cannot be sound.
   */
  readonly hasCustomResolver: boolean;
}

export function readAliasEntries(
  userAlias: unknown,
  options: { readonly normalize: boolean } = { normalize: true },
): readonly AliasEntry[] {
  // Two inputs, and conflating them is what let round 11 through. The **declaration** is raw and must
  // be carried to the form Vite merges it into; the **final list is already Vite's output** and
  // normalizing it again applies the rule a second time. `normalize: false` for the latter.
  const pair = (find: string, replacement: string): { find: string; replacement: string } =>
    options.normalize ? normalizeAliasEntryPair(find, replacement) : { find, replacement };

  // Both branches go through the same pair normalization, and the object form needs it as much as
  // the array form: `normalizeAliasFind` strips a trailing `/` from the key only, so reading
  // `{ "react/": "/patched-react/" }` as `find: "react"` with the *unstripped* value leaves a pair
  // that no longer matches Vite's own merged entry `react -> /patched-react` (measured — the
  // pre-existing trailing-slash test failed until this was applied to both halves).
  if (Array.isArray(userAlias)) {
    return userAlias
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map(entry => {
        const { find, replacement } = entry;
        if (typeof find !== "string" && !(find instanceof RegExp)) {
          return undefined;
        }
        const hasCustomResolver = isViteHonouredResolver(entry.customResolver);
        if (typeof find === "string" && typeof replacement === "string") {
          // The pair rule produces the normalized halves; the raw spelling is deliberately not kept
          // alongside, because comparing against a Vite-merged entry can only ever succeed on the
          // normalized form.
          return { ...pair(find, replacement), hasCustomResolver };
        }
        return { find, replacement: typeof replacement === "string" ? replacement : undefined, hasCustomResolver };
      })
      .filter((entry): entry is AliasEntry => entry !== undefined);
  }

  if (typeof userAlias === "object" && userAlias !== null) {
    return Object.entries(userAlias as Record<string, unknown>)
      .filter(([key]) => key.length > 0)
      .map(([key, value]) => {
        // Recorded for the object form too even though Vite 8.3.0 passes a non-string value through
        // unchanged (measured: `{ nm: { replacement, customResolver } }` arrives as a literal object,
        // with the resolver lost rather than honoured). Recording it means a *future* Vite that did
        // honour it here cannot slip past the check, and it costs one field.
        const hasCustomResolver =
          typeof value === "object" && value !== null && isViteHonouredResolver((value as { customResolver?: unknown }).customResolver);
        return typeof value === "string"
          ? { ...pair(key, value), hasCustomResolver }
          : { find: normalizeAliasFind(key, value), replacement: undefined, hasCustomResolver };
      });
  }

  return [];
}

/**
 * Final alias entries that neither the project nor this harness declared, as string keys.
 *
 * ## Why the `config()` snapshot is not enough on its own
 *
 * This plugin declares `enforce: "pre"` and Vite runs `config` hooks sequentially, so a normal or
 * `post` user plugin still merges into the config **after** the snapshot was captured. Measured
 * before this existed, with no RegExp involved: a plugin returning
 * `{ resolve: { alias: { "@app/shared/thing": "/local-copy" } } }` made Vite resolve
 * `@app/shared/thing` to `/local-copy/thing` while the Cell build used `./shared/thing` — and the
 * snapshot-based audit had nothing to refuse.
 *
 * So the final set is compared against the contributions that are *known*, and the remainder is
 * reported. "Known" is assembled from three sources rather than matched by looking for markers in
 * the alias text, which is the mistake that produced the two previous bypasses:
 *
 * - what the project declared (the `config()` snapshot);
 * - what this harness emits, which is {@link hostModuleAliases} — the very map `config()` returns,
 *   so it is compared as a value rather than re-derived;
 * - Vite's own injected entries, which are the `@vite/` scope.
 *
 * Only a **string** `find` is returned, and the reason is not convenience: a string is what the
 * audit compares, and a `RegExp` arriving from a plugin this harness did not write has already
 * been judged by {@link projectAliasShadowKeys} if the project declared it. An undeclared pattern is
 * reported here by its source text so the message quotes something findable in the plugin rather
 * than pretending to have run it.
 */
export function undeclaredAliasPatterns(
  finalAlias: unknown,
  declared: readonly unknown[],
): readonly string[] {
  const harnessOwned = hostModuleAliases();
  // The project's own contributions, as whole entries rather than keys: a later plugin that
  // rewrites a key the project declared must not inherit its approval, and only the value can
  // tell the two apart.
  const declaredEntries = readAliasEntries(declared);

  const undeclared: string[] = [];
  for (const entry of readAliasEntries(finalAlias, { normalize: false })) {
    const { find, replacement } = entry;

    // A `customResolver` decides resolution instead of the `replacement` string, so an entry that
    // carries one is **never** matched against a plain contribution. Two functions cannot be
    // compared for behavioural equality, so the sound answer is to refuse rather than to guess
    // (measured: a later plugin repeating this harness's own `react` find *and* replacement and
    // adding only a resolver made Vite resolve `react` to `/local-copy/react`, while the artifact
    // kept the host bridge's page `React`).
    if (entry.hasCustomResolver) {
      undeclared.push(typeof find === "string" ? find : String(find));
      continue;
    }

    if (typeof find === "string") {
      // This harness's own entries: both halves must match, so a later plugin rewriting
      // `react -> /local-copy/react` is not accepted on the strength of the key alone (measured: dev
      // resolved `react` to the plugin's copy while the harness's was skipped). Compared through the
      // same normalization as the project's, because Vite strips the slashes off whichever entry it
      // merged — so the harness's own emitted spelling is not what the final list carries.
      // The key must **belong** to the harness before its value is worth comparing. A `?? ""` here
      // would turn "this key is not one of ours" into "ours, with an empty replacement", and a
      // later plugin's `{ "@app/shared": "" }` would then match it exactly and be accepted (measured:
      // Vite rewrites `@app/shared/thing` to `/thing` for that entry, while the artifact keeps
      // `./shared/thing`). An empty replacement is a real value a project can write — it is not a
      // stand-in for "absent", and the two must not be conflated.
      if (
        Object.prototype.hasOwnProperty.call(harnessOwned, find) &&
        replacement !== undefined &&
        isSameStringAlias({ find, replacement: harnessOwned[find], hasCustomResolver: false }, find, replacement)
      ) {
        continue;
      }
      // Then the project's own, which is what a project claiming a host id actually ends up with:
      // the harness defers to it (see `unclaimedHostAliases`), so the merged entry carries the
      // project's value and the harness's never appears. Checked after the harness's own value so a
      // later plugin overwriting a host alias is still caught — the two differ only in the value.
      if (declaredEntries.some(known => isSameStringAlias(known, find, replacement))) {
        continue;
      }
      undeclared.push(find);
      continue;
    }

    // A `RegExp`. Identity is source **and flags**, and Vite's own client entries are recognised by
    // the exact shape they arrive in — so a project pattern that merely mentions `@vite/` cannot
    // claim to be one of them (measured: such a pattern, contributed by a later plugin, resolved
    // `@app/shared/thing` to `/local-copy/thing` and was skipped on content alone).
    if (isViteInjectedClientPattern(entry)) {
      continue;
    }
    if (declaredEntries.some(known => isSamePatternAlias(known, find, replacement))) {
      continue;
    }
    undeclared.push(String(find));
  }

  return undeclared;
}

/**
 * Vite's own injected client entries, recognised by the exact form they arrive in.
 *
 * Deliberately not a `@vite/` substring test. That is the judgement that produced the two previous
 * bypasses: a string test cannot distinguish *who wrote an alias*, and both times a project's own
 * pattern or a later plugin's pattern was let through by containing the marker. Matching the whole
 * entry — the source **and** the flag set **and** the replacement — means only Vite's own two
 * entries match, and anything else must be accounted for by the project.
 */
/**
 * The two alias patterns Vite injects into every resolved config for its dev client.
 *
 * Named as data rather than matched by a marker, because "contains `@vite/`" cannot say *who
 * wrote an alias* — that mistake is what let two bypasses through in a row (a project pattern and,
 * later, a plugin pattern, each naming the scope and each being accepted as Vite's own).
 */
const VITE_INJECTED_CLIENT_PATTERNS: readonly RegExp[] = [/^\/?@vite\/env/, /^\/?@vite\/client/];

function isViteInjectedClientPattern(entry: AliasEntry): boolean {
  const { find } = entry;
  if (typeof find !== "object" || find === null) {
    return false;
  }
  return VITE_INJECTED_CLIENT_PATTERNS.some(
    known => find.source === known.source && find.flags === known.flags && isViteClientReplacement(entry),
  );
}

/**
 * The replacement Vite points its client entries at.
 *
 * A shape test rather than a literal: the path ends in Vite's own client module and is a version-
 * and install-specific path, so pinning the exact string would break on every upgrade. Both a
 * forward-slash and a backslash spelling are accepted, since a Windows path arrives escaped.
 */
function isViteClientReplacement(entry: { readonly replacement: string | undefined }): boolean {
  return entry.replacement !== undefined && /(client[\\/])?client\.mjs$|env\.mjs$/.test(entry.replacement);
}

/**
 * Two string aliases are the same contribution when both the key and the value agree.
 *
 * The **value** is compared through {@link normalizeAliasFind} as well, and that is Vite's own
 * rule rather than a convenience: `{ find: "react/", replacement: "/patched-react/" }` is normalized
 * by Vite to `find: "react"` with both slashes stripped, so the final entry carries the *stripped*
 * spelling while the project's declaration carries the slashed one (measured — comparing them raw
 * refused a project that had declared its alias correctly, in both the array and the object form).
 */
function isSameStringAlias(known: AliasEntry, find: string, replacement: string | undefined): boolean {
  if (typeof known.find !== "string" || known.replacement === undefined || replacement === undefined) {
    return false;
  }
  return known.find === find && known.replacement === replacement;
}

/**
 * One alias entry through Vite's own `normalizeSingleAlias` rule, as a pair.
 *
 * The rule is **conditional on both sides**: Vite strips a trailing `/` only when `find` *and*
 * `replacement` both end in one, and leaves both alone otherwise. That is not a detail — this file's
 * own test `does not normalize a slash on find alone, since Vite does not either` exists to pin
 * it, and `{ find: "foo/", replacement: "/a" }` is consequently a *different* pattern from
 * `{ find: "foo", replacement: "/a" }`: the first matches nothing, the second matches `foo/x`.
 *
 * An earlier version of this comparison trimmed each side **unconditionally**, which is wider than
 * Vite and therefore merges two genuinely different aliases. Measured: with the project declaring
 * the inert `{ find: "some-unrelated/", replacement: "/local-copy" }` and a later plugin adding
 * `{ "some-unrelated": "/local-copy" }`, the plugin's entry was accepted as the project's own, while
 * Vite resolved `some-unrelated/thing` to `/local-copy/thing` — the plugin's copy — which the
 * harness did not report.
 *
 * So the pair is normalized together, exactly as Vite normalizes it, and `foo/` stays distinct from
 * `foo`. Comparing the two halves independently would be the same mistake one level down.
 */
function normalizeAliasEntryPair(find: string, replacement: string): { find: string; replacement: string } {
  if (find.endsWith("/") && replacement.endsWith("/")) {
    return { find: find.slice(0, -1), replacement: replacement.slice(0, -1) };
  }
  return { find, replacement };
}

function isSamePatternAlias(
  known: AliasEntry,
  find: RegExp,
  replacement: string | undefined,
): boolean {
  return (
    known.find instanceof RegExp &&
    known.find.source === find.source &&
    known.find.flags === find.flags &&
    known.replacement === replacement
  );
}


export function projectAliasShadowKeys(
  pattern: RegExp,
  projectAlias: Readonly<Record<string, string>>,
): readonly { readonly key: string; readonly pattern: string }[] {  // Extensions chosen to exceed what any realistic module path segment contains, so a pattern has to
  // be *specific* to escape them rather than merely long.
  const probeSegments = ["a", "ab", "abc", "abcd", "abcde", "a/b", "a/b/c", "a/b/c/d"];

  // The audit quotes this verbatim as the offending `find`, so it must be something a developer
  // can find in their own config — the pattern's own spelling, never the project key echoed back.
  const rendered = String(pattern);
  const shadowed: { key: string; pattern: string }[] = [];
  for (const key of Object.keys(projectAlias)) {
    const probes = [key, `${key}/`, ...probeSegments.map(segment => `${key}/${segment}`)];

    // `test` on a `/g` or `/y` pattern is stateful (it advances `lastIndex`), so the caller's own
    // object is restored before returning — the same obligation `isClaimedBy` documents.
    const { lastIndex } = pattern;
    let matched = false;
    try {
      matched = probes.some(probe => {
        pattern.lastIndex = 0;
        return pattern.test(probe);
      });
    } finally {
      pattern.lastIndex = lastIndex;
    }

    if (matched) {
      // The project key itself is the subject the audit reports, and the string comparison then
      // matches it exactly — so a `RegExp` reaches the audit through the same door as a string key.
      shadowed.push({ key, pattern: rendered });
      continue;
    }

    // The probes missed it. A source with no metacharacters can only match the literal it
    // spells, so a miss is a true miss. Anything else is undecidable from a bounded probe set, and
    // the audit's default answer — "no overlap" — would restore the silent divergence, so it is
    // refused instead.
    if (/[.*+?()[\]{}|^$\\]/.test(pattern.source)) {
      shadowed.push({ key, pattern: rendered });
    }
  }

  return shadowed;
}

function readAliasPatterns(userAlias: unknown): readonly unknown[] {
  if (Array.isArray(userAlias)) {
    return userAlias
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map(entry => {
        const { find, replacement } = entry;
        if (typeof find === "string") {
          return normalizeAliasFind(find, replacement);
        }
        return find;
      })
      .filter(find => find !== undefined);
  }

  if (typeof userAlias === "object" && userAlias !== null) {
    // `Object.entries` then normalize, which is Vite's own order for a map: it converts the map to
    // pairs first (`getEntries`) and only then strips the slashes. Normalizing before splitting
    // would produce the same answer for these keys, but following Vite's order keeps the two
    // readable side by side.
    return Object.entries(userAlias as Record<string, unknown>)
      .map(([key, value]) => (key.length === 0 ? undefined : normalizeAliasFind(key, value)))
      .filter(key => key !== undefined);
  }

  return [];
}

/**
 * Whether one alias pattern claims a module id, by Vite's own rule.
 *
 * The regular-expression branch is Vite's too, including `test` (not `match`, and no anchoring of
 * its own): reproducing the rule is the point, because a filter that decided differently from the
 * resolver would be a filter that disagrees with the thing it is compensating for — which is how
 * the equality bug got through. A pattern that matches partially, so that the user's replacement
 * of `react` would be applied to `react/jsx-dev-runtime` as a *string* concatenation, is still a
 * claim: Vite will use the user's entry for that id, whoever's replacement it produces.
 *
 * The `lastIndex` save/restore is not tidiness. `test` on a `/g` or `/y` pattern is stateful — it
 * advances `lastIndex` on a match and resets it on a miss — so asking a caller's own RegExp would
 * make *this* function's call count decide what Vite's later resolution sees: a project writing
 * `find: /react/g` would get an override that applied on every other import. Restoring the
 * property leaves the pattern exactly as the project handed it over, which is what a predicate
 * borrowed from someone else's object owes them.
 *
 * The pattern arrives already normalized — see {@link normalizeAliasFind} for why that has to
 * happen before matching rather than being folded in here.
 */
function isClaimedBy(pattern: unknown, moduleId: string): boolean {
  if (pattern instanceof RegExp) {
    const { lastIndex } = pattern;
    try {
      return pattern.test(moduleId);
    } finally {
      pattern.lastIndex = lastIndex;
    }
  }
  if (typeof pattern !== "string" || pattern.length === 0) {
    return false;
  }
  return moduleId === pattern || moduleId.startsWith(`${pattern}/`);
}

/**
 * A string alias `find` as Vite will see it, which is not always as the project wrote it.
 *
 * Vite 8.3's `normalizeSingleAlias` strips a trailing slash from **both** `find` and
 * `replacement` when **both** end in one:
 *
 * ```js
 * if (typeof find === "string" && find.endsWith("/") && replacement.endsWith("/")) { … slice both … }
 * ```
 *
 * The filter runs earlier than that, so a project writing the perfectly valid
 *
 * ```ts
 * { find: "react/", replacement: "/patched-react/" }
 * ```
 *
 * handed this module the pattern `"react/"`, which matches neither `react` nor
 * `react/jsx-dev-runtime`. The harness concluded the project claimed nothing, kept its own exact
 * aliases, and — because Vite merges the plugin's aliases *before* the user's array and only then
 * normalizes — those exact entries won the resolution. Measured against Vite 8.3.0: with that
 * alias in the array form, **both** `react` and `react/jsx-dev-runtime` resolved to the harness's
 * stock React, so the project's override did nothing at all rather than only failing for subpaths.
 *
 * Reproducing the normalization is the whole fix. Two half-versions are worth ruling out
 * explicitly, because both look reasonable and both are wrong:
 *
 * - **Stripping the trailing slash unconditionally** would claim ids on behalf of an entry Vite
 *   never normalizes. `{ find: "react/", replacement: "/patched-react" }` — one slash, not two —
 *   keeps `find: "react/"` in Vite, whose prefix rule then matches nothing, so the project has
 *   claimed nothing and the harness must keep its substitutions. Stripping anyway would leave the
 *   project with no React at all: the harness would decline to alias on behalf of an entry that
 *   resolves nothing. (That one-slash form is arguably a project mistake, but it is not this
 *   module's to correct, and guessing would trade one silent failure for another.)
 * - **Requiring the slash on `replacement` only** is the same error in a different place; both
 *   conditions are Vite's, so both are reproduced.
 *
 * `replacement` is passed in solely to reproduce that condition — the value is never used for
 * matching, which is why the parameter is documented rather than typed as optional.
 *
 * Exported for `vite-plugin.test.ts` to assert directly, which is unusual for a helper this small
 * and is deliberate: the *conditionality* is the whole content of the fix, and it is not
 * observable through resolution. Both the correct implementation and an unconditional strip
 * produce the same resolved module for `{ find: "react/", replacement: "/patched-react" }` — the
 * user's entry claims nothing either way, so the harness's own alias serves the id in both. The
 * difference is only whether the pattern is claimed, which is why the guard asserts on this
 * function rather than on a resolved id.
 */
export function normalizeAliasFind(find: string, replacement: unknown): string {
  if (find.endsWith("/") && typeof replacement === "string" && replacement.endsWith("/")) {
    return find.slice(0, -1);
  }
  return find;
}

/**
 * The project alias entry that matches a module id, by Vite's own string rule.
 *
 * #97's requirement is that one declared alias set drives the dev server and the artifact. The
 * set comes from `registry.resolve.alias` — the normalization of the project's
 * `forguncy.config.ts` `resolve.alias` block — and this is the dev half of applying it.
 *
 * ## Why the rule is written here rather than by handing Vite an alias
 *
 * The natural mechanism is `resolve.alias` in a `config()` hook, which is how the host aliases are
 * already emitted. That route does not work for a *project* alias, and three measurements say so:
 *
 * - `config()` runs before the registry exists, and it cannot see the project root when the
 *   project does not set one — so there is nothing to normalize the block against. Guessing
 *   `process.cwd()` there reproduced Vite's own root rule in the measured cases, but it would be a
 *   *second* normalization of one config file, with a second answer if the two roots ever
 *   differed.
 * - Mutating `config.resolve.alias` in `configResolved` is inert: Vite has already built the
 *   resolver by then, so neither `unshift` nor replacing the array changes what resolves.
 * - Emitting an alias from `config()` puts it *before* the project's own `vite.config.ts` aliases
 *   (`mergeConfig` lets the later value win), which is the silent override the host-alias filter
 *   exists to avoid.
 *
 * Applying it in this plugin's `resolveId` has none of those problems and one property the others
 * lack: it reads the *normalized* set off the registry, so there is exactly one normalization of
 * one config file and the dev server cannot disagree with the build about it.
 *
 * ## The rule itself, including the precedence — measured, not assumed
 *
 * `===` or `startsWith(find + "/")`, which is Vite's — and, measured against Rolldown 1.2.9,
 * exactly what that engine's `resolve.alias` does too. That identity is the whole reason the config
 * block accepts only this key shape: a rule the two engines agree on is one the two paths cannot
 * diverge about.
 *
 * **First declaration wins, not the longest match.** That is worth stating because the intuitive
 * reading is the opposite, and the difference is observable. With `@/lib` and `@/lib/deep` both
 * declared, `@/lib/deep/x` is matched by both, and measured against Vite 8.3.0 and Rolldown 1.2.9:
 *
 * | declaration order | Vite resolved `@/lib/deep/x` to |
 * | --- | --- |
 * | `@/lib` first | `@/lib`'s target |
 * | `@/lib/deep` first | `@/lib/deep`'s target |
 *
 * Both engines answer by declaration order, so this does too — `Object.entries` order over the
 * normalized map, which `normalizeResolveConfig` preserves from the config file. Picking the
 * longest key instead would be a *third* rule: correct in isolation, and a genuine divergence from
 * both engines the first time a project declared overlapping prefixes. That is precisely the class
 * of defect this whole change removes, so the ordering here is the engines' rather than a better
 * one.
 */
export function projectAliasTarget(
  moduleId: string,
  alias: Readonly<Record<string, string>>,
): string | undefined {
  for (const [find, target] of Object.entries(alias)) {
    if (moduleId === find || moduleId.startsWith(`${find}/`)) {
      // `slice` rather than `replace`: the remainder has to survive verbatim, and `replace` with a
      // string pattern also rewrites an occurrence inside the matched text.
      return `${target}${moduleId.slice(find.length)}`;
    }
  }

  return undefined;
}
