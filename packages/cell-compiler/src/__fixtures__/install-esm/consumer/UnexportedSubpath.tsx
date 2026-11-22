/**
 * A Cell entry that imports a subpath the package's `exports` map does not publish.
 *
 * The negative half of #90's "a root decision must not silently widen support": the
 * lock may hold an `inline` decision for `fgc-fixture-sub`, and no decision authorizes
 * `fgc-fixture-sub/private`. The bundler is the only authority that can say whether the
 * specifier is exported, and it must refuse rather than fall through to the file that
 * happens to sit beside the published one.
 */
import { privateExport } from "fgc-fixture-sub/private";

export default function App() {
  return { undeclaredSubpath: privateExport() };
}
