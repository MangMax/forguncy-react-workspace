/**
 * The dev-harness half of #98: local resource imports obey the compiler's v1 policy.
 *
 * Decision source: GitHub Issues
 * - #98 — "基础资源：让 CSS 与小型静态资源在本地和单文件 Cell 中一致工作"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/98).
 *
 * ## Why the dev server has to refuse anything the compiler refuses
 *
 * Vite's defaults are *more* permissive than the Cell artifact: it serves an asset by URL in dev
 * regardless of size, accepts CSS Modules, applies `?raw`/`?url`/`?worker`, and follows a remote
 * `url(...)` in a stylesheet. Every one of those works locally and fails (or silently changes
 * meaning) at compile time, which is the "green local render that never compiles" this repository
 * treats as a defect rather than a convenience. So the harness applies the same closed support
 * set `core/cell-assets` states, and applies it in the same places the compiler does: a resource
 * import, and a `url(...)` inside a plain stylesheet.
 *
 * ## What it does not do
 *
 * It does not emulate the compiled path. The style installer, the single-file artifact and the
 * character budget are the compiler's; locally Vite owns the `<style>` lifecycle and HMR, and
 * those are *better* than the artifact's in every way that matters to a developer. The shared
 * promise is narrower and exact: which inputs are legal, and what an inlined asset means. A local
 * pass is still `local` evidence (AGENTS.md rules 6–7).
 *
 * The two hooks are deliberately ordinary Vite hooks on the harness plugin (`enforce: "pre"`)
 * rather than a second plugin: Vite ignores `plugins` returned from a `config()` hook, and a
 * helper that only worked through `defineForguncyViteConfig` would leave a bare `devHarness(...)`
 * project with the permissive defaults.
 *
 * ## Why the classification is not written here (#153)
 *
 * The answer to "may a Cell import this file" is `core`'s `classifyCellResource`, and this module
 * is an adapter over it: the same call the compiler's resource resolution makes, with the same
 * message, so a local refusal and a compile diagnostic are one explanation. What is local is the
 * *channel* — a thrown error, because Vite turns a plugin's throw into the overlay that names the
 * file and the line — and the two filesystem answers the classification asks for.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  CELL_ASSET_INLINE_LIMIT_BYTES,
  classifyCellResource,
  effectiveCellResourceQuery,
  formatCellAssetDataUri,
  formatCellCssRefusalDetail,
  isCellCssFile,
  isCellCssModuleFile,
  rewriteCellCssReferences,
  splitCellSpecifierQuery,
} from "@forguncy-react-workspace/core";
import type { CellResourceFileProbe, CellResourceRefusal } from "@forguncy-react-workspace/core";

/** The subset of the Vite transform result this policy returns. */
export interface DevResourceTransformResult {
  readonly code: string;
  readonly map: null;
}

export interface DevCellResourcePolicy {
  /**
   * Answers a resource import with inline source, or `null` when the id is not a resource.
   *
   * Throws for a refused resource. A throw is the right channel here: Vite already turns a
   * plugin's thrown error into the overlay that names the file and the line, which is exactly the
   * "actionable refusal" the issue asks for, and a returned error object would have to be
   * invented for a hook that has no such shape.
   */
  load(id: string): Promise<string | null> | string | null;
  /** Rewrites a plain stylesheet's `url(...)` references, or refuses the sheet. */
  transform(code: string, id: string): Promise<DevResourceTransformResult | null> | DevResourceTransformResult | null;
  /** The build-side default that keeps a `vite build` of the harness aligned with the compiler. */
  readonly assetsInlineLimit: number;
}

/**
 * A refusal thrown into Vite's pipeline, carrying the classification's reason code.
 *
 * The message is the classification's `detail` verbatim — the compiler's diagnostic carries the
 * same string — and the code travels as data so a test can assert the reason rather than match
 * prose. `[forguncy-cell-assets]` remains as the prefix, because the overlay's first line is what
 * tells a developer which plugin refused.
 */
export class CellResourceRefusedError extends Error {
  readonly refusal: CellResourceRefusal;

  constructor(refusal: CellResourceRefusal) {
    super(refusal.detail);
    this.name = "CellResourceRefusedError";
    this.refusal = refusal;
  }
}

/** The harness's filesystem answers to the shared classification's two questions. */
const CELL_RESOURCE_FILE_PROBE: CellResourceFileProbe = {
  isRegularFile: filePath => {
    try {
      return statSync(filePath).isFile();
    } catch {
      return false;
    }
  },
  byteLength: filePath => {
    try {
      return statSync(filePath).size;
    } catch {
      return undefined;
    }
  },
};

/** One refusal, naming the file, the reason and the direction — the same sentence the compiler uses. */
function refused(refusal: CellResourceRefusal): CellResourceRefusedError {
  return new CellResourceRefusedError(refusal);
}

/** Builds the policy. Stateless: a dev server may transform the same file many times (HMR). */
export function createDevCellResourcePolicy(): DevCellResourcePolicy {
  return {
    assetsInlineLimit: CELL_ASSET_INLINE_LIMIT_BYTES,

    load(id) {
      // Vite appends its own marks (`?import`, `?t=`, `?direct`, `?used`) to modules it has
      // already resolved. Those are bookkeeping rather than authored queries — the compiler never
      // sees them — so treating one as an authored query would refuse every asset in local dev.
      const { path: filePath, query } = splitCellSpecifierQuery(id);
      const authoredQuery = effectiveCellResourceQuery(query);

      // One call, the same one the compiler's resource resolution makes. The classification
      // answers `not-a-resource` for an ordinary module, refuses a Vite transform parameter on
      // *any* file (which is why `worker.js?worker` is refused without a resource extension), and
      // carries the query and the file's size into the decision so the two paths cannot disagree.
      const classification = classifyCellResource({
        subject: id,
        filePath,
        ...(authoredQuery === undefined ? {} : { query: authoredQuery }),
        inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
        probe: CELL_RESOURCE_FILE_PROBE,
      });

      if (classification.kind === "refuse") {
        throw refused(classification.refusal);
      }

      // Plain CSS is Vite's to load and transform; this policy only rewrites its references.
      if (classification.kind !== "asset") {
        return null;
      }

      const bytes = readFileSync(filePath);
      // The default export, not a URL: dev and the artifact must hand the component the same
      // value, and "same value" here means a `data:` URI rather than a server path that happens to
      // render today.
      return `export default ${JSON.stringify(formatCellAssetDataUri(classification.mediaType, bytes))};\n`;
    },

    async transform(code, id) {
      const { path: filePath, query } = splitCellSpecifierQuery(id);
      if (effectiveCellResourceQuery(query) !== undefined || !isCellCssFile(filePath) || isCellCssModuleFile(filePath)) {
        return null;
      }

      const outcome = await rewriteCellCssReferences({
        css: code,
        fileName: filePath,
        inlineLimitBytes: CELL_ASSET_INLINE_LIMIT_BYTES,
        loadAsset: url => {
          const candidate = path.resolve(path.dirname(filePath), url);
          return CELL_RESOURCE_FILE_PROBE.isRegularFile(candidate)
            ? { fileName: candidate, bytes: readFileSync(candidate) }
            : undefined;
        },
      });

      if (!outcome.ok) {
        // The violation text and the composition around it are both `core`'s, so the compiler's
        // stylesheet diagnostic and this overlay say the same thing (#153).
        throw refused({
          code: "css-reference",
          subject: id,
          detail: formatCellCssRefusalDetail(filePath, outcome.violations),
        });
      }

      return { code: outcome.css, map: null };
    },
  };
}
