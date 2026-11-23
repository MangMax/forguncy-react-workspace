/**
 * How a failed build becomes diagnostic text — one copy for the compiler and the probe.
 *
 * Decision source: the parent spec #152
 * (https://github.com/MangMax/forguncy-react-workspace/issues/152), whose review found these five
 * helpers copied between `cell-compiler/rolldown-bundler.ts` and
 * `dependency-resolver/probe/scan-utils.ts`. The two consumers read the same bundler's output, so
 * two copies could only drift: the compiler's copy already differed from the probe's on whether a
 * message is made portable.
 *
 * The difference the review found is a parameter here rather than a second copy: each consumer
 * passes how *its* diagnostic text becomes portable — the compiler strips ANSI only, the probe also
 * removes the project root and normalizes separators — and the line assembly is written once.
 * Nothing else is variable, so the two paths cannot disagree about what a reported error *is*.
 *
 * This is a **leaf**: it imports nothing, so the browser projection and the probe's `local.ts`
 * entry can load it without pulling a graph in with it.
 */

/** A complete ANSI sequence, with its escape byte. Built from the code point, not a literal. */
const ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, "g");

/** The same sequence missing its escape byte — recognised only when it carries parameters. */
const LOST_ESCAPE_SEQUENCE = /\[[0-9;]+[A-Za-z]/g;

/**
 * Removes colour and cursor codes.
 *
 * Rolldown frames every message with ANSI styling; the probe's diagnostics and #6's compiled
 * diagnostics both land in CI logs that get diffed, and an escape sequence inside a message makes
 * two identical failures compare unequal. Stripped at the point of escape so no downstream
 * consumer has to know that bundlers paint their text.
 *
 * The escape byte is built from its code point rather than written as a control character in
 * source, and a sequence whose escape byte got lost still leaves the bracket form behind for the
 * second pass. That second pass requires a *parameter* before the terminating letter, because
 * without one it would eat ordinary bracketed prose — `[object Object]` is exactly the text
 * {@link describeValue} produces for a value it cannot serialize, and a diagnostic that mangled
 * its own fallback would be worse than the value it was describing.
 */
export function stripAnsi(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, "").replace(LOST_ESCAPE_SEQUENCE, "");
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

interface ReportedBuildError {
  readonly message?: unknown;
  readonly id?: unknown;
  readonly loc?: Readonly<{ file?: unknown; line?: unknown; column?: unknown }> | null;
}

export function hasReportedErrors(value: unknown): value is { readonly errors: readonly unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "errors" in value &&
    Array.isArray((value as { readonly errors?: unknown }).errors)
  );
}

/**
 * A reported field as diagnostic text: a string as itself, an absent value as nothing, and
 * anything else in its JSON form. `String()` would print `[object Object]` for the last case,
 * which tells the reader neither what the bundler said nor which value it said it about.
 *
 * Total on purpose: `JSON.stringify` throws on a BigInt and on a circular value, and this runs
 * inside the diagnostic that reports a failure, so a throw here would replace the bundler's
 * failure with a second one about formatting it. A value that cannot be serialized falls back to
 * `String()`, and a value whose `toString` also throws to its `Object.prototype` tag.
 */
export function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    try {
      // eslint-disable-next-line typescript/no-base-to-string -- the JSON form already failed, so the object's own text is the best remaining description.
      return String(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
}

/** How a consumer makes a reported error's text portable for its own diagnostics. */
interface ReportedErrorFormat {
  /** Applied to the message before it is placed in the line. */
  readonly message: (text: string) => string;
  /** Applied to the extracted file path, when the consumer relativizes paths. Defaults to the path as reported. */
  readonly file?: (text: string) => string;
}

/**
 * One reported error as one line: message first, location pulled out of the
 * structured `loc` rather than scraped from the painted frame.
 *
 * The frame itself — the source excerpt with its box-drawing characters — is
 * dropped on purpose. `compileCell` embeds this text in a diagnostic's `detail`;
 * the message and `file:line:column` are what a reader needs to act on, and the
 * excerpt would carry the entry's absolute path into a log artifact.
 */
export function describeReportedError(value: unknown, format: ReportedErrorFormat): string {
  if (typeof value !== "object" || value === null) {
    return format.message(String(value));
  }
  const error = value as ReportedBuildError;
  const message =
    typeof error.message === "string"
      ? format.message(firstLine(stripAnsi(error.message)))
      : format.message(describeValue(error.message));
  const loc = error.loc ?? undefined;
  const file = typeof loc?.file === "string" ? loc.file : typeof error.id === "string" ? error.id : undefined;
  const line = typeof loc?.line === "number" ? loc.line : undefined;
  const column = typeof loc?.column === "number" ? loc.column : undefined;
  if (file === undefined) return message;
  const portableFile = format.file === undefined ? file : format.file(file);
  if (line === undefined) return `${message} (${portableFile})`;
  if (column === undefined) return `${message} (${portableFile}:${line})`;
  return `${message} (${portableFile}:${line}:${column})`;
}
