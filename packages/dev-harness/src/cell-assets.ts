/**
 * The dev-harness half of #98: local resource imports obey the compiler's v1 policy.
 *
 * Decision source: GitHub Issue #98 — "基础资源：让 CSS 与小型静态资源在本地和单文件 Cell 中一致工作"
 * (https://github.com/MangMax/forguncy-react-workspace/issues/98).
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
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  CELL_ASSET_INLINE_LIMIT_BYTES,
  cellStaticAssetMediaType,
  formatCellAssetDataUri,
  isCellCssFile,
  isCellCssModuleFile,
  isCellStylePreprocessorFile,
  isRejectedCellBinaryAsset,
  isSupportedCellStaticAsset,
  queryHasRejectedResourceParameter,
  rewriteCellCssReferences,
  splitCellSpecifierQuery,
  effectiveCellResourceQuery,
} from "@forguncy-react-workspace/core";

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

      if (authoredQuery !== undefined && queryHasRejectedResourceParameter(authoredQuery)) {
        throw refused(
          id,
          `uses the Vite query "?${authoredQuery}". v1 refuses ?raw, ?url, ?inline, ?worker and ?sharedworker because the compiled Cell does not implement those transforms and has nowhere to load a Worker or runtime asset from. Remove the query, or move the capability to a Forguncy frontend extension (extension).`,
        );
      }

      if (isCellCssModuleFile(filePath)) {
        throw refused(
          id,
          "is a CSS Module. v1 explicitly rejects CSS Modules: scoped class names would need a compiler-owned implementation matching Vite's, and v1 refuses rather than giving the same import two answers. Use plain CSS with a Cell-owned root-class prefix, or move the scoped stylesheet to a Forguncy frontend extension (extension).",
        );
      }

      if (isCellStylePreprocessorFile(filePath)) {
        throw refused(
          id,
          "is a stylesheet preprocessor source. v1 accepts plain CSS only; compile it ahead of time, or move it to a Forguncy frontend extension (extension).",
        );
      }

      // Plain CSS is Vite's to load and transform; this policy only rewrites its references.
      if (isCellCssFile(filePath)) {
        return null;
      }

      if (isRejectedCellBinaryAsset(filePath)) {
        throw refused(
          id,
          "is a binary asset outside v1 (Worker/WASM and sibling binaries are not supported). Move it to a Forguncy frontend extension (extension), or replace it with a small image/font v1 inlines (replace).",
        );
      }

      if (!isSupportedCellStaticAsset(filePath)) {
        return null;
      }

      if (authoredQuery !== undefined) {
        throw refused(
          id,
          `carries the query "?${authoredQuery}". v1 refuses every resource query on a static asset; remove it.`,
        );
      }
      if (!existsSync(filePath)) {
        throw refused(id, "does not exist. A Cell artifact can only inline a file the compiler can read.");
      }

      const mediaType = cellStaticAssetMediaType(filePath);
      if (mediaType === undefined) {
        throw refused(id, "has no media type v1 can inline.");
      }
      const bytes = readFileSync(filePath);
      if (bytes.length > CELL_ASSET_INLINE_LIMIT_BYTES) {
        throw refused(
          id,
          `is ${bytes.length} bytes; the v1 inline limit is ${CELL_ASSET_INLINE_LIMIT_BYTES}. A sibling file cannot be deployed beside a Cell artifact, so inline a smaller asset or move this one to a Forguncy frontend extension (extension) — or replace it (replace).`,
        );
      }

      // The default export, not a URL: dev and the artifact must hand the component the same
      // value, and "same value" here means a `data:` URI rather than a server path that happens to
      // render today.
      return `export default ${JSON.stringify(formatCellAssetDataUri(mediaType, bytes))};\n`;
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
          return existsSync(candidate) ? { fileName: candidate, bytes: readFileSync(candidate) } : undefined;
        },
      });

      if (!outcome.ok) {
        const detail = outcome.violations
          .map(violation => violation.detail)
          .join(" ");
        throw refused(
          id,
          `${detail} The v1 support set is closed: plain CSS, url(...) images/fonts at or below ${CELL_ASSET_INLINE_LIMIT_BYTES} bytes, and small static asset imports. Anything else belongs in a Forguncy frontend extension (extension) or must be replaced (replace).`,
        );
      }

      return { code: outcome.css, map: null };
    },
  };
}

/** One refusal message, naming the file, the reason and the direction. */
function refused(id: string, detail: string): Error {
  return new Error(`[forguncy-cell-assets] "${id}" ${detail}`);
}
