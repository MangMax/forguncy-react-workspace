/**
 * The host value shapes the typed façade members resolve to — compile-time-only
 * declarations of what #176 measured on a live Forguncy `12.0.102.0`.
 *
 * Decision sources: GitHub Issues
 * - #177 — "Implement: 强类型 runtimeFacade 与本地 Mock（含绑定双向/用户/上传/值转换）"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/177), the ticket that
 *   turns #176's measured call shapes into typed members, under
 * - #27 — "Spec: typed Forguncy runtime facade for application-owned capabilities"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/27), whose rule every
 *   shape here obeys: nothing is typed that the probe did not execute.
 *
 * ## Why these live in their own module, and why that module has no exports that exist at runtime
 *
 * `cell-runtime.ts` is the production slim runtime (#124): everything it statically carries
 * lands in every compiled Cell artifact. These declarations are imported with `import type`,
 * which TypeScript erases completely, so they are free in the sense that matters — they add
 * no byte to the flattened artifact. What they must never become is a module with *values*:
 * a runtime table of shapes here would be exactly the contract-table bloat #124 separated,
 * reintroduced through the type system.
 *
 * ## What "measured" means for each shape
 *
 * Every shape below cites `CELL_FORGUNCY_FACADE_MEMBER_SHAPES` or `CELL_PROPS_SURFACE_SHAPES`
 * in `core`'s runtime contract, which is where #176's executed evidence is recorded. Where
 * the evidence is incomplete, the type says so rather than completing it:
 *
 * - `ForguncyCurrentUser`'s fields are optional because the signed-out shape is an open
 *   question (`signed-out-user-shape`); the probe measured the signed-in path only.
 * - `ForguncyUploadFilesInput` is not a structural `FileList` — see its own comment for why
 *   the weakest honest member of the accepted set is an array-like of `Blob` with a `name`.
 * - `ForguncyEventFiring` is `readonly unknown[]` because the gather semantics are measured
 *   but no project-specific event argument types exist until #178's declaration layer.
 */

/**
 * The user record `props.Forguncy.getCurrentUser()` answers with.
 *
 * #176 measured the signed-in path end-to-end: synchronous, and an object carrying exactly
 * these six keys (`{ UserName, FullName, Email, Role, HasPicture, PictureUrl }`), with
 * `PictureUrl` falling back to the built-in default avatar when the user has no uploaded
 * image. Every field is optional rather than required, because the signed-out shape is a
 * recorded open question (`signed-out-user-shape`): the underlying `getUserInfo()` fields
 * are `undefined` in that case, and the exact fallback shape was not separately executed.
 * Required fields would promise what the evidence does not — that a signed-out read cannot
 * produce a partially-empty record.
 */
export interface ForguncyCurrentUser {
  readonly UserName?: string;
  readonly FullName?: string;
  readonly Email?: string;
  readonly Role?: string;
  readonly HasPicture?: boolean;
  readonly PictureUrl?: string;
}

/**
 * The upload input `props.Forguncy.uploadFiles` accepts.
 *
 * #176 measured three accepted input shapes: a single `File`, an `Array<File>`, and a
 * `FileList`. `FileList` is a **browser interface type**: nothing constructs one, and what
 * actually reaches the call is the array-like the runtime's normalization reads — a
 * `length` plus indexed elements. Typing it structurally as `{ readonly length; readonly [index]: File }`
 * would admit fewer real callers than the host accepts, not more: `Array<File>` is not
 * assignable to that shape under TypeScript's numeric-index rules, so the array case would
 * need a cast, and any object with a `length` and numeric `File`s would pass while
 * producing the host's empty result. `File` itself is not portable either — this module is
 * consumed by tests running in Node, where the global exists but is the buffer-backed
 * implementation — so the element is typed as the structural pair the host's validation
 * actually reads: a `Blob` carrying a `name`.
 */
export type ForguncyUploadableFile = Blob & { readonly name: string };

export type ForguncyUploadFilesInput =
  | ForguncyUploadableFile
  | readonly ForguncyUploadableFile[]
  | ArrayLike<ForguncyUploadableFile>;

/** One uploaded file entry, as #176 measured the success path. */
export interface ForguncyUploadedFile {
  /** `<uuid>_<originalName>`, or `<uploadFolder>/<uuid>_<originalName>` when a folder is supplied. */
  readonly filePath: string;
  /** The original file name. */
  readonly fileName: string;
  /** `/Forguncy/FileDownloadUpload/Download?file=<urlencoded filePath>`. */
  readonly downloadUrl: string;
}

/**
 * What `uploadFiles` resolves to.
 *
 * `attachmentValue` is the pipe-separated, **trailing-pipe** concatenation of the
 * server-side `filePath`s (`<filePath>|<filePath>|…|`). No arguments, or an empty array,
 * resolves `{ files: [], attachmentValue: "" }` rather than rejecting — measured, not
 * documented. Validation failures (empty file, extension mismatch, oversize, too many
 * files) reject with localized messages whose wording `CELL_FORGUNCY_FACADE_MEMBER_SHAPES`
 * records verbatim.
 */
export interface ForguncyUploadResult {
  readonly files: readonly ForguncyUploadedFile[];
  readonly attachmentValue: string;
}

/**
 * The host's declared upload limit, answered synchronously.
 *
 * `sizeLimit` is **megabytes** — #176 measured the runtime validating
 * `sizeLimit * 1024 * 1024 < file.size` — and both numeric fields are `0` for unlimited.
 * `accept` is always equal to `extensionFilter`; it is typed as its own field because that
 * is the shape the host answers with, not because the two can differ. `maxUploadFileCount`
 * is per call, not per batch.
 */
export interface ForguncyUploadLimit {
  readonly extensionFilter: string;
  readonly accept: string;
  /** Megabytes; `0` means unlimited. */
  readonly sizeLimit: number;
  /** Files per call; `0` means unlimited. */
  readonly maxUploadFileCount: number;
}

/**
 * One cell method exposed through `exposeMethod`.
 *
 * #176 measured the invocation side the host uses: each entry in the host's
 * `methodParameters` is unwrapped as `.parameterValue` / `.ParameterValue` when either key
 * is present and passed through verbatim otherwise, so a method's arguments are positional
 * and arbitrary; a Promise return is awaited before the host places it on `Result`. The
 * parameter tuple is `readonly unknown[]` because the designer, not this contract, decides
 * what a given method takes — the same discipline `ServerCommandCall` follows, one level
 * down.
 */
export type ForguncyCellMethod = (...args: readonly unknown[]) => unknown;

/**
 * The host-assigned event firing function.
 *
 * #176 measured the gather semantics: for each declared `eventHandlers[i].eventName` the
 * runtime assigns `props[eventName] = (...args) => void`, and calling it gathers the
 * positional arguments into an object keyed by `eventArgs[].name` and hands that to
 * `executeCustomCommandObject`. The return is `void` even when a command runs: the command
 * pipeline is the host's, and its outcome is not observable through the firing call
 * (`event-handler-executeCustomCommandObject-error-shape` records the failure-shape half of
 * that as still open). The argument tuple is `readonly unknown[]` because which events
 * exist and what they carry is a project declaration (#178), not something this contract
 * knows.
 */
export type ForguncyEventFiring = (...args: readonly unknown[]) => void;
