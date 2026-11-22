/**
 * The Cell entry the install-level ESM chain compiles (#90).
 *
 * Every import here is a shape the probe used to locate by `require.resolve` (#89) or
 * a shape whose entry selection depends on the resolver's export conditions. The
 * component returns the values verbatim, so evaluating the emitted artifact in a
 * sandbox is an assertion about **what ran**, not about which strings the bundle
 * contains.
 *
 * No JSX and no React import on purpose: the point of this entry is the dependency
 * graph, and a React import would add a host-bridge decision to every walkthrough of a
 * failure. The compiler's entry wrapper still binds this function as the Cell component.
 */
import { whichBranch } from "fgc-fixture-browser-cond";
import { hiddenManifest } from "fgc-fixture-hidden";
import { importOnly } from "fgc-fixture-import-only";
import { extra } from "fgc-fixture-sub/extra";
import { only } from "fgc-fixture-subpath-only/only";
import { scoped } from "@fgc-fixture/scoped-esm";
import { transitive } from "fgc-fixture-transitive";

export default function App() {
  return {
    importOnly: importOnly(),
    hiddenManifest: hiddenManifest(),
    subpathOnly: only(),
    declaredSubpath: extra(),
    scoped: scoped(),
    transitive: transitive(),
    browserBranch: whichBranch(),
  };
}
