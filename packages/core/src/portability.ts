/**
 * The portability predicates every config reader has to agree on.
 *
 * Decision source: GitHub Issue #26 — "Spec: project configuration and React Cell target
 * declarations" (https://github.com/Mang-X/forguncy-react-workspace/issues/26), whose
 * portability rule is that "a committed config must be reviewable in a PR and must mean the
 * same thing on every machine".
 *
 * ## Why this is a leaf module
 *
 * These predicates were `cell-registry.ts`'s. They are here because a second config reader
 * needs them: `resolve-config.ts` checks an alias target with exactly the rule the registry
 * applies to a Cell entry, and importing that rule from the registry would make the two
 * modules a cycle — the registry calls the alias normalizer, so the normalizer may not call
 * back.
 *
 * The extraction follows `specifier.ts`'s precedent for the same reason, and the same
 * standard: the shared half became a leaf that imports nothing, so the property "one
 * implementation of this rule" is structural rather than a coincidence of load order.
 * `cell-registry.ts` re-exports both names, so its public surface and every existing caller
 * are unchanged.
 *
 * ## What belongs here, and what does not
 *
 * The test is "would two config readers have to give the same answer to this question".
 * Whether a value is a machine-specific path, and whether a key names something that would
 * have to be a secret, both pass: a node-spelled path committed in an alias target is the
 * same defect as one committed in a Cell entry, and it should read the same way.
 *
 * Everything else stays in the modules that own it — this is not a home for "config
 * helpers". `MARKER_NAMESPACE_PATTERN`, for instance, is about one runtime field and stays
 * with its validation in `cell-registry.ts`.
 *
 * ## One rule, two documents (#154)
 *
 * `containsMachineSpecificPath` is the rule both committed documents ask. It was the lock's
 * anywhere-in-string pattern set, which is stricter than the configuration's original
 * start-anchored one: the same string could be portable in a `forguncy.config` value and
 * non-portable in `fgc.lock.json`. `machineSpecificPathProblem` stays as the config side's
 * wording of that one answer, and the lock's document-wide scan calls the same predicate.
 */

/**
 * The machine-path shapes, most specific first, each with the wording that names it.
 *
 * These identify an absolute, machine-specific path *occurrence*. Anchored on the character
 * before the path rather than on the start of the string, because the path that leaks is rarely
 * the whole value: a fingerprint like `entry=/Users/mang/project/App.tsx` starts with `entry=`,
 * and an `^`-anchored check reports it as portable.
 *
 * The leading guard on the POSIX pattern is what keeps URLs out: in
 * `https://github.com/...` the first slash follows `:` and the second follows
 * `/`, so neither is the start of a path.
 *
 * This is the *only* machine-path rule in the repository (#154). It was the lock's
 * `ABSOLUTE_PATH_OCCURRENCES` and the configuration's five `^`-anchored patterns, which meant
 * one value could be portable in a config and non-portable in a lock. The lock's
 * anywhere-in-string answer won because it is the stricter one: a path embedded in a value is
 * exactly how a machine path re-enters a committed file.
 *
 * One ordered table rather than a pattern list plus a separate chain of `if`s, because the
 * *order* is part of the rule: `file:///c:/x` matches both the file URL and the drive pattern,
 * and the reader has to be told the shape that actually names the defect.
 * `machineSpecificPathProblem` reports the first match's wording, and
 * `containsMachineSpecificPath` asks whether any matched.
 */
const MACHINE_SPECIFIC_PATH_SHAPES: readonly { readonly pattern: RegExp; readonly problem: string }[] = [
  // A file URL is a filesystem path wearing a scheme, and it is what a Node/Vite
  // probe produces from `import.meta.url` — so it is the shape a machine path
  // most easily re-enters the lock in. `http(s)://` stays allowed; this one
  // cannot be portable on any machine.
  { pattern: /(?:^|[^0-9A-Za-z])file:[\\/]/i, problem: "a file:// URL" },
  // C:\Users\... or C:/Users/... — the guard keeps `https:` out (`s` is alphanumeric).
  { pattern: /(?:^|[^0-9A-Za-z])[A-Za-z]:[\\/]/, problem: "an absolute Windows path" },
  // \\server\share
  { pattern: /(?:^|[^\\])\\\\[^\\/]/, problem: "a UNC path" },
  // ~/ or ~\ home-relative
  { pattern: /(?:^|[^0-9A-Za-z._~-])~[\\/]/, problem: "a home-relative path" },
  // A slash that starts a path rather than continuing one, followed by a
  // path-ish character so prose containing " / " is not a hit.
  { pattern: /(?:^|[^0-9A-Za-z._~:/#-])\/[0-9A-Za-z._~-]/, problem: "an absolute path" },
];

/**
 * True when the value contains a machine-specific path anywhere in it.
 *
 * The one answer both committed documents ask for (#154): a configuration value and a lock
 * value that carry the same string get the same verdict.
 */
export function containsMachineSpecificPath(value: string): boolean {
  return MACHINE_SPECIFIC_PATH_SHAPES.some(shape => shape.pattern.test(value));
}

const SECRET_KEY_WORDS = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "apikey",
  "accesskey",
  "privatekey",
  "session",
  "cookie",
  "bearer",
  "authorization",
];

/**
 * Why a string cannot be committed, or `undefined` when it is portable.
 *
 * Ordered from most to least specific so `C:\x` is reported as a Windows path
 * rather than as a generic directory-looking value.
 *
 * The file URL is asked first because it *contains* a drive path:
 * `file:///c:/x` would otherwise be reported as a Windows path and the reader
 * would be told to fix the wrong thing.
 */
export function machineSpecificPathProblem(value: string): string | undefined {
  return MACHINE_SPECIFIC_PATH_SHAPES.find(shape => shape.pattern.test(value))?.problem;
}

/** True when the key names something that would have to be a secret. */
export function isSecretLikeKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return SECRET_KEY_WORDS.some(word => normalized.includes(word));
}
