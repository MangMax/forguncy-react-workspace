/**
 * The compile-time ReactCellAutoHeight injection: the patch source emitted into
 * every height-adaptive Cell's artifact.
 *
 * Decision sources: GitHub Issues
 * - #185 — "Implement: cell-compiler 编译期注入 ReactCellAutoHeight"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/185), this module's
 *   ticket, Ticket 1 of Epic #184 — "ReactCellType 高度自适应沉淀为 cell-compiler
 *   内置能力" (https://github.com/MangMax/forguncy-react-workspace/issues/184),
 * - #82 — "修复 Runtime：在生产 Cell 入口自动安装 Host Provider"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/82), whose generated
 *   runtime binding is the sibling mechanism this module sits beside — and whose
 *   naming discipline (`runtimeBindingNamesAreVerified`) this module follows,
 * - #6 — "generated ReactCellType artifact and compiler boundary"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/6), whose banner
 *   convention {@link AUTO_HEIGHT_GENERATED_BANNER} follows.
 *
 * ## What is injected, and why it is not re-derived
 *
 * The patch is the mechanism #184 verified end-to-end on the live 12.0.102.0 as an
 * external frontend library (`reactcell-autoh` 0.2.0), re-expressed as artifact
 * source. It is three complementary mechanisms, and they are complementary rather
 * than redundant. The plugin source pins the timing they answer, and the order is
 * the opposite of what "the wrap patches creation" suggests:
 *
 * - `createContent()` runs **synchronously, first**: it builds the container div
 *   (hardcoded `height: 100%`), creates the React root on it, sets the id and
 *   returns — with `renderCurrent()` early-returning on `!this.librariesReady`.
 * - the artifact evaluates **asynchronously, later**: `render()` →
 *   `createReactElement` → `compileSource` only fires once `librariesReady` and
 *   `_loaded` both hold, so by the time the injected source runs, *its own cell's
 *   container is already in the DOM, unpatched*.
 *
 * Measured against that sequence (the probe at
 * `packages/mcp-sync/scripts/probe-autoh-evidence-185.mjs`, recorded in `core`'s
 * `REACTCELLTYPE_CREATE_CONTENT_CONTRACT`):
 *
 * 1. **`repairExistingContainers()` is the primary path for the injecting cell
 *    itself.** Because the container pre-exists the artifact's evaluation, the scan
 *    for content roots whose id matches the position-independent `/^r\d+c\d+p$/`
 *    pattern is what actually adapts the first-rendered cell — the probe's step 5
 *    shows exactly that state (container in the DOM, `height: 100%` inline, no
 *    marker, before the patch lands). Nothing anywhere keys on a concrete cell id,
 *    which is what makes one artifact adapt at any grid position.
 * 2. **the prototype wrap** — `cellTypeCtor.prototype.createContent` wrapped so
 *    cells instantiated *after the patch lands* get the adaptive container
 *    (`min-height: 100%` fills the grid row, `height: auto` lets content extend it,
 *    plus the marker class). This covers *other* cells of the type mounted later,
 *    and any re-created containers — a maintenance reader removing it as "redundant
 *    with the repair pass" would lose every cell instantiated after the first scan.
 * 3. **the `MutationObserver`** — follows containers the SPA mounts after the patch
 *    lands (navigation away and back, cells added later), which neither of the
 *    first two can see: the scan runs once, and the wrap only affects creation time.
 *
 * Removing any one of the three re-opens the timing hole it covers.
 *
 * The polling loop (`setInterval` until the registry entry exists) is kept verbatim
 * from the proven patch, but its role changed with the delivery mechanism: for the
 * external *library* it was load-bearing, because a frontend-library bundle races
 * plugin-script registration. For the *injected artifact* the race cannot occur —
 * the artifact only ever evaluates inside the cell type's own `render()`, at which
 * point `cellTypeCtor` is trivially registered (every verification run shows
 * `attempts: 1`). What the poll is now is a cheap invariant guard against platform
 * change — one no-op pass in the common case — and it is documented as that rather
 * than as a load-bearing race answer.
 *
 * ## Why this is a template emission and not a bundler interception
 *
 * #82's provider install is generated as a virtual module the bundler substitutes for
 * the façade specifier — which means it exists in the artifact exactly when the Cell
 * imports the façade. The auto-height patch is not a façade concern and must not
 * share that condition: a Cell that never calls `runtimeFacade()` is still a
 * ReactCellType cell with the same hardcoded container. So this module renders
 * **source text** that `artifact-assembly.ts` splices into the composed artifact
 * ahead of the bundle — executed once at artifact evaluation, unconditionally, in
 * the same function scope the bundle and the entry wrapper share. The IIFE keeps the
 * patch's locals (`REGISTRY_KEY`, `STATE`, the observer) out of that scope, exactly
 * as the bundler's own IIFE keeps the bundle's.
 *
 * ## Idempotency, and which direction the guard carries it
 *
 * Two guards make the patch a no-op on repeat application, and both are page-global
 * state rather than artifact state — deliberately, because the failure they answer
 * is *across* artifacts:
 *
 * - `ctor.prototype.__reactCellAutoHeightPatched` lives on the constructor
 *   prototype, which is shared by every cell of the type on the page. A second
 *   compiled cell whose artifact also carries the injection reaches the guard and
 *   stops — no double-wrap of `createContent`, no second observer.
 * - `document.querySelector("style[data-reactcell-autoh]")` does the same for the
 *   stylesheet.
 *
 * Re-compilation is the other direction and it is important to state it correctly:
 * a re-compiled artifact is a *new evaluation*, but the page keeps the already
 * patched prototype until reload, so correctness across recompiles is carried by
 * the guard — not by anything resetting. Within one artifact the injection is
 * single by construction: assembly emits the block once.
 *
 * ## The diagnostic global, and why it is not the library's name
 *
 * The external library exposed `globalThis.ReactCellAutoHeight` because the
 * platform's frontend-library contract requires a global matching `globalName`.
 * The compiled injection has no such contract — but it does have a verification
 * need: #185's acceptance is real-machine evidence, and the DOM alone cannot
 * distinguish "the patch never ran" from "it ran and the guard was already set by
 * another cell". So the patch publishes exactly one non-enumerable global,
 * `__fgcReactCellAutoHeight`, carrying `{ patched, attempts, error }` getters. The
 * name is deliberately disjoint from `ReactCellAutoHeight`: a page carrying both
 * the injection and a `frontendLibraries` reference to the external library must
 * not have two writers `defineProperty`-ing one `writable: false` global (the
 * second would throw inside its own IIFE). Both being installed is otherwise
 * harmless — the prototype guard makes the second patch application a no-op —
 * though a project that compiles with the injection and still references
 * `reactcell-autoh` is carrying dead weight the library's job has replaced.
 *
 * ## What this artifact-side code may name
 *
 * Every free identifier the patch references is either an ES builtin or a name in
 * {@link CELL_AUTO_HEIGHT_HOST_NAMES}, each of which is verified against `core`'s
 * `CELL_BROWSER_HOST_GLOBALS` by {@link autoHeightNamesAreVerified} — the same
 * discipline `runtime-binding.ts` follows against `CELL_USER_SCOPE_BINDINGS`, and
 * the reason the two tables are separate: the browser globals are not module
 * identities a `host` dependency may be mapped onto. The patch never evaluates
 * `$`/`jQuery` as a free identifier — it calls `.css()`/`.addClass()` on the object
 * the platform's own `createContent` returns, inside a `try/catch` that degrades to
 * native behaviour rather than blocking the render (the reliance is recorded in
 * `REACTCELLTYPE_CREATE_CONTENT_CONTRACT`).
 *
 * ## What the opt-out is, and what it cannot be
 *
 * `heightMode: "fixed"` is a **compile-level** opt-out: the artifact carries no
 * injection of its own. It is not — and by the mechanism's nature cannot be — a
 * runtime shield. The patch wraps `cellTypeCtor.prototype.createContent`, and the
 * prototype is shared by every ReactCellType for the lifetime of the browser
 * window — and Forguncy is an SPA, so the accurate scope is **session-global, not
 * page-global**: once any injected cell renders anywhere in the session, every
 * ReactCellType in the whole session renders adaptive, including `fixed` cells on
 * pages navigated to afterwards. The fixed-only control in the acceptance run
 * proves compile-level absence on a fresh load, not session-level isolation. This
 * is the Epic's explicit scope decision (#184's "本轮全局生效；若后续有 cell 需要
 * 固定高度，再引入 opt-out 声明"), verified on the live page rather than inferred:
 * the acceptance run's shared-page measurement shows a fixed-control cell rendering
 * adaptive beside its adaptive neighbor, while the fixed-only control page shows
 * the same artifact carrying no patch activity at all. A future per-instance
 * conditional is new mechanism, not a bug in this one.
 *
 * ## The local-dev fidelity gap, stated rather than smoothed over
 *
 * `vp dev` mounts the Cell's *authored source*, not a compiled artifact — so the
 * injection never runs locally, and a developer iterating on layout in the harness
 * sees the unpatched container. That is the same class of divergence AGENTS.md
 * already records for the dev loop (it is not a Forguncy emulator), and it is
 * recorded here for the same reason those are: a local render is `local` evidence
 * about the Cell's component, and says nothing about the deployed container's
 * height behaviour. Real-machine verification is the only compatibility evidence,
 * and it lives in `verify-autoh-injection-185.mjs`'s measured output on the ticket.
 *
 * Scope note: this module renders source and declares the names that source
 * references. It does not decide *whether* a Cell is height-adaptive — that is the
 * `layout.heightMode` declaration's meaning, normalized in `core`'s registry and
 * plumbed through `registry-plan.ts` into `compileCell`'s options — nor where in
 * the artifact the block lands, which is `artifact-assembly.ts`'s call.
 */

import { CELL_BROWSER_HOST_GLOBALS, REACTCELLTYPE_CREATE_CONTENT_CONTRACT } from "@forguncy-react-workspace/core";

/**
 * The first line of the injected block.
 *
 * The same reasoning #6 gives for the artifact banner: a reviewer reading
 * designer-held code has to be able to tell generated wiring from the Cell's own
 * bundle, and the injection point is exactly where the two meet.
 */
export const AUTO_HEIGHT_GENERATED_BANNER =
  "/* generated by @forguncy-react-workspace/cell-compiler from the auto-height contract (#184/#185) — do not edit */";

/**
 * The diagnostic global the patch publishes, disjoint from the external library's
 * `ReactCellAutoHeight` on purpose — see the module header.
 */
export const AUTO_HEIGHT_DIAGNOSTIC_GLOBAL = "__fgcReactCellAutoHeight";

/**
 * The free identifiers the injected source references, as a declared list.
 *
 * Every entry is a browser/platform ambient recorded in `core`'s
 * `CELL_BROWSER_HOST_GLOBALS` — which is the table this list is checked against,
 * never `CELL_USER_SCOPE_BINDINGS`. The distinction is load-bearing: membership in
 * the user-scope table is what `artifact-audits.ts` reads as permission to map a
 * `host` dependency onto a global, and `document` must never become such an
 * identity. `Object` and `String` are referenced too but are ES builtins available
 * in every realm, so they are not host names and are not listed.
 */
export const CELL_AUTO_HEIGHT_HOST_NAMES = ["Forguncy", "document", "MutationObserver", "setInterval", "clearInterval"] as const;

/**
 * Renders the auto-height patch as artifact-top-level source.
 *
 * The output is one IIFE statement, deliberately ES5-shaped: the artifact's own
 * wrapper is the platform's `new Function` body, and while the bundler transpiles
 * the *bundle*, this block is spliced in verbatim — so nothing here may assume a
 * transpile pass. `const`/`let` would parse fine on the target's own Babel, but
 * ES5 costs nothing here and keeps the block identical in every artifact shape,
 * including the expression-context ones.
 *
 * The constants the source embeds — the registry key, the marker class, the id
 * pattern, the guard property — are read off `core`'s
 * `REACTCELLTYPE_CREATE_CONTENT_CONTRACT` rather than written a second time, so the
 * evidence record and the generated code cannot drift apart: a contract edit that
 * changes the measured registry key changes what every future artifact injects.
 *
 * The emitted source carries no import, no export, no dynamic import and none of
 * the callee names the platform's validator refuses — the same properties the
 * artifact audits enforce over the composed artifact, which is why the injection
 * cannot trip #6's source guard.
 */
export function renderAutoHeightInjection(): string {
  const contract = REACTCELLTYPE_CREATE_CONTENT_CONTRACT;
  const registryKey = JSON.stringify(contract.registryKey);
  const markerClass = JSON.stringify(contract.markerClass);
  const patchedGuard = JSON.stringify(contract.patchedGuard);
  const diagnosticGlobal = JSON.stringify(AUTO_HEIGHT_DIAGNOSTIC_GLOBAL);
  // The id pattern is emitted as a regex literal rather than a string + `new RegExp`,
  // because that is the shape the proven patch ran with — one less allocation per
  // call, and no constructor string to escape twice. The contract carries it as a
  // string so a consumer can read it; here it is interpolated into the literal.
  const idPatternLiteral = `/${contract.containerIdPattern}/`;

  return [
    AUTO_HEIGHT_GENERATED_BANNER,
    `(function () {`,
    `  "use strict";`,
    `  // Every mechanism below is DOM manipulation — container styles, a style element,`,
    `  // a mutation observer — so without a document there is nothing to do, and the`,
    `  // honest behaviour is inertness rather than a throw. This is an environment`,
    `  // guard, not a platform-state guard: the artifact can be evaluated outside a`,
    `  // browser page (a vm sandbox in this repository's own execution tests is the`,
    `  // proof), and an unguarded setInterval reference would throw at evaluation,`,
    `  // taking the whole artifact — and the cell — down with it.`,
    `  if (typeof document === "undefined") return;`,
    `  var REGISTRY_KEY = ${registryKey};`,
    `  var MARKER_CLASS = ${markerClass};`,
    `  var CELL_ROOT_ID = ${idPatternLiteral};`,
    `  var STATE = { patched: false, error: null, attempts: 0 };`,
    ``,
    `  function applyContainerControl(el) {`,
    `    if (!el || el.nodeType !== 1) return;`,
    `    el.style.minHeight = "100%";`,
    `    el.style.height = "auto";`,
    `    if (el.classList) {`,
    `      el.classList.add(MARKER_CLASS);`,
    `    }`,
    `  }`,
    ``,
    `  function repairExistingContainers() {`,
    `    if (typeof document === "undefined") return 0;`,
    `    var repaired = 0;`,
    `    var all = document.querySelectorAll("[id]");`,
    `    for (var i = 0; i < all.length; i += 1) {`,
    `      var el = all[i];`,
    `      if (CELL_ROOT_ID.test(el.id) && !el.classList.contains(MARKER_CLASS)) {`,
    `        applyContainerControl(el);`,
    `        repaired += 1;`,
    `      }`,
    `    }`,
    `    return repaired;`,
    `  }`,
    ``,
    `  function patchPrototype(ctor) {`,
    `    if (ctor.prototype[${patchedGuard}]) {`,
    `      return true;`,
    `    }`,
    `    var original = ctor.prototype.createContent;`,
    `    if (typeof original !== "function") {`,
    `      return false;`,
    `    }`,
    `    ctor.prototype.createContent = function createContent() {`,
    `      var div = original.call(this);`,
    `      try {`,
    `        // min-height fills the grid row; height:auto lets the container grow with`,
    `        // content. This overrides the plugin's hardcoded height:100%, which clips`,
    `        // tall content and leaves a blank tail under short content. div is the`,
    `        // jQuery object the platform's own createContent returns; a build that`,
    `        // ever returned a plain element degrades through the catch instead of`,
    `        // blocking the render.`,
    `        div.css({ "min-height": "100%", height: "auto" });`,
    `        div.addClass(MARKER_CLASS);`,
    `      } catch (error) {`,
    `        // Never block the cell render for a styling enhancement.`,
    `      }`,
    `      return div;`,
    `    };`,
    `    ctor.prototype[${patchedGuard}] = true;`,
    `    repairExistingContainers();`,
    `    if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {`,
    `      var observer = new MutationObserver(function (mutations) {`,
    `        for (var m = 0; m < mutations.length; m += 1) {`,
    `          var added = mutations[m].addedNodes;`,
    `          for (var n = 0; n < added.length; n += 1) {`,
    `            var nodeItem = added[n];`,
    `            if (nodeItem && nodeItem.nodeType === 1) {`,
    `              if (CELL_ROOT_ID.test(nodeItem.id || "") && !nodeItem.classList.contains(MARKER_CLASS)) {`,
    `                applyContainerControl(nodeItem);`,
    `              }`,
    `              var descendants = nodeItem.querySelectorAll ? nodeItem.querySelectorAll("[id]") : [];`,
    `              for (var d = 0; d < descendants.length; d += 1) {`,
    `                if (CELL_ROOT_ID.test(descendants[d].id) && !descendants[d].classList.contains(MARKER_CLASS)) {`,
    `                  applyContainerControl(descendants[d]);`,
    `                }`,
    `              }`,
    `            }`,
    `          }`,
    `        }`,
    `      });`,
    `      // documentElement rather than body alone: the container always lives inside`,
    `      // body, and body inside documentElement — but body can still be null when the`,
    `      // patch lands early, and a body-only guard would then never install the`,
    `      // observer at all. documentElement exists whenever a script can run, so the`,
    `      // fallback closes the hole without a retry loop.`,
    `      var observeTarget = document.body || document.documentElement;`,
    `      if (observeTarget) {`,
    `        observer.observe(observeTarget, { childList: true, subtree: true });`,
    `      }`,
    `    }`,
    `    return true;`,
    `  }`,
    ``,
    `  function tryPatch() {`,
    `    STATE.attempts += 1;`,
    `    try {`,
    `      if (`,
    `        typeof Forguncy === "undefined" ||`,
    `        !Forguncy.Plugin ||`,
    `        !Forguncy.Plugin.CellTypeHelper ||`,
    `        !Forguncy.Plugin.CellTypeHelper._registedCellTypes`,
    `      ) {`,
    `        return false;`,
    `      }`,
    `      var entry = Forguncy.Plugin.CellTypeHelper._registedCellTypes[REGISTRY_KEY];`,
    `      var ctor = entry && entry[0] && entry[0].cellTypeCtor;`,
    `      if (!ctor || !ctor.prototype) {`,
    `        return false;`,
    `      }`,
    `      STATE.patched = patchPrototype(ctor);`,
    `      return STATE.patched;`,
    `    } catch (error) {`,
    `      STATE.error = String((error && error.message) || error);`,
    `      return false;`,
    `    }`,
    `  }`,
    ``,
    `  // The ReactCellType class registers only after the plugin script loads, and`,
    `  // artifact evaluation races it — so the patch polls until the constructor is`,
    `  // available. Polling is the only ordering-tolerant mechanism: the patch cannot`,
    `  // decide its own execution order relative to the plugin script.`,
    `  function installWhenReady() {`,
    `    if (tryPatch()) {`,
    `      return;`,
    `    }`,
    `    var attempts = 0;`,
    `    var timer = setInterval(function () {`,
    `      attempts += 1;`,
    `      if (tryPatch() || attempts > 200) {`,
    `        clearInterval(timer);`,
    `      }`,
    `    }, 25);`,
    `  }`,
    ``,
    `  function ensureStyle() {`,
    `    if (typeof document === "undefined") return;`,
    `    if (document.querySelector("style[data-reactcell-autoh]")) return;`,
    `    var style = document.createElement("style");`,
    `    style.setAttribute("data-reactcell-autoh", "");`,
    `    style.textContent =`,
    `      "." + MARKER_CLASS + "{height:auto!important;min-height:100%!important}";`,
    `    (document.head || document.documentElement).appendChild(style);`,
    `  }`,
    ``,
    `  installWhenReady();`,
    `  ensureStyle();`,
    ``,
    `  // One non-enumerable diagnostic global, disjoint from the external library's`,
    `  // ReactCellAutoHeight: verification needs to tell "never ran" apart from "ran`,
    `  // and the guard was already set", and a page carrying both mechanisms must not`,
    `  // have two writers fighting over one writable:false global.`,
    `  var api = { version: ${JSON.stringify("injected")} };`,
    `  Object.defineProperty(api, "patched", {`,
    `    enumerable: true,`,
    `    get: function () { return STATE.patched; },`,
    `  });`,
    `  Object.defineProperty(api, "attempts", {`,
    `    enumerable: true,`,
    `    get: function () { return STATE.attempts; },`,
    `  });`,
    `  Object.defineProperty(api, "error", {`,
    `    enumerable: true,`,
    `    get: function () { return STATE.error; },`,
    `  });`,
    `  if (typeof globalThis !== "undefined" && !globalThis[${diagnosticGlobal}]) {`,
    `    Object.defineProperty(globalThis, ${diagnosticGlobal}, {`,
    `      configurable: true,`,
    `      enumerable: false,`,
    `      writable: false,`,
    `      value: api,`,
    `    });`,
    `  }`,
    `})();`,
    ``,
  ].join("\n");
}

/**
 * Whether every name the injected source references is a verified ambient global.
 *
 * The mirror of `runtimeBindingNamesAreVerified`, against the browser-globals
 * table rather than the user-scope one — the separation is the point, and this
 * predicate is what keeps it from being a claim in a comment: a patch that reached
 * for an invented global would ship an artifact throwing `ReferenceError` at
 * evaluation, before React or the cell is involved, and no artifact audit could
 * see it because a free identifier is not an import.
 */
export function autoHeightNamesAreVerified(
  names: readonly string[] = CELL_AUTO_HEIGHT_HOST_NAMES,
): boolean {
  return names.every(name => CELL_BROWSER_HOST_GLOBALS.some(entry => entry.name === name));
}
