/**
 * The one answer to "which package does this specifier name".
 *
 * A leaf module: it imports nothing, so every package that has to fold a
 * specifier down to its package — the host bridge, the compiler's artifact
 * boundary and workspace contract, the bundler's inlining report, and the local
 * dev runtime's deferred-module audit — can import the same rule without
 * dragging a graph along with it.
 *
 * The copies it replaces had drifted on exactly one input: the host bridge's
 * version answered `.` for `./x` (the first `/`-segment of a relative path),
 * which is a package name that does not exist. Returning a path unchanged is the
 * property that makes this safe to call on a specifier that has not been
 * classified yet — there is no package to fold out of `./Button`, and inventing
 * one would let a dependency decision match a file.
 */

/**
 * The package a bare or scoped specifier resolves to, so decisions can be matched by package.
 *
 * A path is returned unchanged, which is what makes it safe to call on a specifier
 * that has not been classified yet: there is no package to fold out of `./Button`,
 * and inventing one would let a decision match a file.
 */
export function packageNameOfSpecifier(specifier: string): string {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return specifier;
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) return segments.slice(0, 2).join("/");
  return segments[0] ?? specifier;
}
