/**
 * The one diagnostic vocabulary factory.
 *
 * Four packages had each written the same three functions — build a diagnostic from a
 * rule table, collapse two diagnostics that say the same thing about the same subject,
 * and render one line with its fix owner — and each copy had its own small divergence.
 * The shared half is mechanical: a rule's `states` sentence with an occurrence's
 * `detail` appended, and a dedupe key of `code` + NUL + `subject`. This module owns
 * that half, so a package supplies only what is genuinely its own: the rule table, the
 * diagnostic's extra fields, and the one line's spelling.
 *
 * Decision source: GitHub Issue #156 — "refactor(core): shared package-name,
 * diagnostic-vocabulary and provenance helpers"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/156), under
 * #152 "spec: stabilise the current shape — single answers, single copies, narrow
 * surfaces" (https://github.com/Mang-X/forguncy-react-workspace/issues/152).
 *
 * ## Why a factory and not four shared functions with generics at each call site
 *
 * The packages disagree about the diagnostic's *shape* (a `subject` or a `specifier`,
 * an optional `location`, a conditional `delegate`) while agreeing exactly about the
 * composition and the key. A factory takes the shape as a parameter once and yields the
 * trio closed over it, so a call site keeps the signature it had — `create(code,
 * subject, options)` — and a package's rule table stays the thing that decides what a
 * diagnostic can say. The line each package prints is passed in for the same reason: the
 * artifact adds a location, the sync adds its delegate, and the bridge names a label, so
 * only the *default* spelling is shareable and sharing it by default would hide those
 * differences rather than state them.
 *
 * Nothing here is stateful or cached: `defineDiagnosticVocabulary` returns closures over
 * the table it was given, so two vocabularies in one process cannot see each other.
 */

/** The rule fields every diagnostic vocabulary needs. Extra fields ride along untouched. */
export interface DiagnosticRuleShape<Code extends string> {
  readonly code: Code;
  /** One sentence stating the condition, without the offending value. */
  readonly states: string;
}

/** What {@link createDiagnosticFields} builds: the fields every rule table can fill in. */
export interface DiagnosticFields<Code extends string, Owner extends string, Guarantee extends string> {
  readonly code: Code;
  /** What the diagnostic is about: a package name, a module id, a Cell, a step. */
  readonly subject: string;
  readonly message: string;
  readonly remediation: string;
  readonly fixOwner: Owner;
  readonly breaksGuarantees: readonly Guarantee[];
}

/**
 * A rule's sentence with an occurrence's detail appended, never replaced.
 *
 * Appending is the contract rather than a formatting choice: the generic statement stays
 * reviewable in one place, and the per-occurrence facts stay in the diagnostic. A
 * package that replaced `states` with its detail would lose the sentence a reviewer
 * approves once and a caller branches on.
 */
export function composeDiagnosticMessage(rule: { readonly states: string }, detail: string | undefined): string {
  return detail === undefined ? rule.states : `${rule.states} ${detail}`;
}

/**
 * The key two diagnostics must share to be the same finding.
 *
 * NUL is the separator because it cannot occur in a code or a subject, so `code` "a" with
 * subject "b" cannot collide with code "a\u0000b" and an empty subject.
 */
export function diagnosticDedupeKey(code: string, subject: string): string {
  return `${code}\u0000${subject}`;
}

/**
 * The common instance shape, for a package whose diagnostic carries exactly the rule's
 * fields plus the composed message.
 */
export function createDiagnosticFields<Code extends string, Owner extends string, Guarantee extends string>(
  rule: {
    readonly code: Code;
    readonly states: string;
    readonly remediation: string;
    readonly fixOwner: Owner;
    readonly breaksGuarantees: readonly Guarantee[];
  },
  code: Code,
  subject: string,
  detail: string | undefined,
): DiagnosticFields<Code, Owner, Guarantee> {
  return {
    code,
    subject,
    message: composeDiagnosticMessage(rule, detail),
    remediation: rule.remediation,
    fixOwner: rule.fixOwner,
    breaksGuarantees: rule.breaksGuarantees,
  };
}

export interface DiagnosticInstanceInput<Code extends string, Rule, Options> {
  readonly code: Code;
  readonly rule: Rule;
  readonly subject: string;
  /** The occurrence's detail, already read from the options. */
  readonly detail: string | undefined;
  /** The options object as the caller supplied it, defaulted to an empty object. */
  readonly options: Options;
}

export interface DefineDiagnosticVocabularyOptions<
  Code extends string,
  Rule extends DiagnosticRuleShape<Code>,
  Diagnostic extends { readonly code: Code },
  Options,
> {
  readonly rules: Readonly<Record<Code, Rule>>;
  /** Builds one instance. The package's extra fields and conditional ones live here. */
  readonly instance: (input: DiagnosticInstanceInput<Code, Rule, Options>) => Diagnostic;
  /** The field two instances are compared on for dedupe. */
  readonly subjectOf: (diagnostic: Diagnostic) => string;
  /** One line for a PR body, a CLI summary or a test failure. */
  readonly format: (diagnostic: Diagnostic, rule: Rule) => string;
  /** The block a report carries when there is nothing to report. */
  readonly emptyReport: string;
}

export interface DiagnosticVocabulary<
  Code extends string,
  Rule extends DiagnosticRuleShape<Code>,
  Diagnostic extends { readonly code: Code },
  Options,
> {
  readonly rules: Readonly<Record<Code, Rule>>;
  /** The rule behind a code, so a report can print guidance without the code. */
  rule(code: Code): Rule;
  create(code: Code, subject: string, options?: Options): Diagnostic;
  /** Collapses diagnostics that share a (code, subject) key, keeping the first. */
  dedupe(diagnostics: readonly Diagnostic[]): readonly Diagnostic[];
  format(diagnostic: Diagnostic): string;
  /** A block a report or a test failure can carry verbatim. */
  formatAll(diagnostics: readonly Diagnostic[]): string;
}

/**
 * Closes the shared trio over one package's rule table and diagnostic shape.
 *
 * `subjectOf` and `format` are required rather than defaulted: the four packages differ
 * on both (a `specifier` instead of a `subject`, a label instead of the sentence, a
 * location or a delegate appended), and a default that guessed would let one of those
 * differences disappear silently. Supplying them is one line per package.
 */
export function defineDiagnosticVocabulary<
  Code extends string,
  Rule extends DiagnosticRuleShape<Code>,
  Diagnostic extends { readonly code: Code },
  Options = Record<string, never>,
>(
  options: DefineDiagnosticVocabularyOptions<Code, Rule, Diagnostic, Options>,
): DiagnosticVocabulary<Code, Rule, Diagnostic, Options> {
  return {
    rules: options.rules,
    rule: code => options.rules[code],
    create(code, subject, supplied) {
      const instanceOptions = (supplied ?? {}) as Options;
      return options.instance({
        code,
        rule: options.rules[code],
        subject,
        detail: (instanceOptions as { readonly detail?: string }).detail,
        options: instanceOptions,
      });
    },
    dedupe(diagnostics) {
      const seen = new Set<string>();
      const result: Diagnostic[] = [];
      for (const diagnostic of diagnostics) {
        const key = diagnosticDedupeKey(diagnostic.code, options.subjectOf(diagnostic));
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(diagnostic);
      }
      return result;
    },
    format: diagnostic => options.format(diagnostic, options.rules[diagnostic.code]),
    formatAll(diagnostics) {
      if (diagnostics.length === 0) return options.emptyReport;
      return diagnostics.map(diagnostic => `- ${options.format(diagnostic, options.rules[diagnostic.code])}`).join("\n");
    },
  };
}
