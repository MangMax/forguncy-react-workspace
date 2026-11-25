/**
 * The loopback host the local dev server binds to.
 *
 * Decision sources: GitHub Issues
 * - #187 — "Fix: 排查恢复 dev-harness 本地预览环境（vp dev 监听失败）"
 *   (https://github.com/MangMax/forguncy-react-workspace/issues/187), the failure this answers,
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose dev loop must start and
 *   answer on this machine at all.
 *
 * ## The failure this fixes
 *
 * Left at its default, Vite binds the dev server to `localhost`, which Node's `net`/`http` layer
 * resolves through `dns.lookup` with `verbatim` ordering — the address family the *system* lists
 * first. On a machine whose resolver returns `::1` before `127.0.0.1` for `localhost` (the common
 * Windows default), the server binds the IPv6 loopback and nothing else:
 *
 * ```
 * vite default bound: {"address":"::1","family":"IPv6","port":5192}
 * ```
 *
 * That is correct everywhere the IPv6 loopback is connectable — but it is not connectable on the
 * machine this Issue was filed against. A `sing-box` TUN-mode proxy client (a WireGuard-based
 * tunnel adapter, `singbox_tun`) installs an IPv6 interception that makes a connect to `::1` fail
 * with `EACCES` even for a socket bound in the *same* process:
 *
 * ```
 * listening on {"address":"::1","family":"IPv6","port":5197}
 * http://[::1]:5197/  -> connect EACCES ::1:5197      (IPv6 loopback blocked by the tunnel)
 * http://127.0.0.1:5197/ -> connect ECONNREFUSED      (nothing ever bound IPv4)
 * ```
 *
 * The dev server therefore announced `http://localhost:…/` — which the client's resolver again
 * answered with `::1` first — but the TCP listener was unreachable from every address family. The
 * spawn harness saw the banner and then `fetch failed` until the deadline, and `vp dev` exited 255
 * with no output a user could act on. Measured: 16 test failures across `vp-dev-command`,
 * `local-dev-audit-server`, `vite-plugin` and `extension-substitutions`, every one rooted in this
 * single connect failure, none a defect in the harness's own logic.
 *
 * ## Why `127.0.0.1` rather than "fix the proxy" or `host: true`
 *
 * The tunnel is the user's own networking configuration and not this package's to remove or to
 * require. The loop the harness provides is a *loopback-only* preview: it is not a shared service,
 * and #23/#22 define it as a local stand-in for a page, never a network host. Binding the IPv4
 * loopback is the correct contract for that loop on every platform — it is reachable whether or not
 * IPv6 loopback is intercepted, and it does not require a working `::1` to exist at all.
 *
 * `host: true` (the dual-stack wildcard `::`) was measured here too, and it does answer — but it
 * also listens on every external interface, which is exactly what a local-only preview must not do.
 * `127.0.0.1` is the narrow host that is both reachable and correct in scope.
 *
 * Crucially, `localhost` remains reachable on the client side: once the server binds IPv4 loopback,
 * the client's `::1`-first lookup falls through to `127.0.0.1` within the same happy-eyeballs
 * connect, so a browser opening the printed URL still works. Verified on this machine:
 *
 * ```
 * host:127.0.0.1 bound: {"address":"127.0.0.1","family":"IPv4"}
 *   http://127.0.0.1:5190/ -> 404   (answered)
 *   http://localhost:5190/ -> 404   (answered — fell through to IPv4)
 * ```
 *
 * ## Why this is a shared helper rather than a per-test constant
 *
 * The same bind decision has to hold in three places that must not disagree: the config a real
 * `vp dev` serves, and the in-process servers the tests bind and then fetch. If they drifted, a
 * test could pass against a server bound one way while `vp dev` binds another — the precise
 * dev/compiler drift this package exists to prevent. So the value lives here once, and both the
 * harness config helper and the tests import it.
 */

/**
 * The loopback host the dev server binds: the IPv4 loopback, always.
 *
 * Exported rather than inlined so the harness config and the test servers share one answer. It is
 * a `string`, not `true`: `true` is the dual-stack wildcard and exposes the preview on external
 * interfaces, which a local-only loop must not do.
 */
export const DEV_SERVER_LOOPBACK_HOST = "127.0.0.1";

/**
 * The `server.host` value a Vite config or test server should use for the local loop.
 *
 * A function returning the constant rather than the constant alone, because several call sites
 * spread it into a `server` object and naming the intent (`loopbackServerHost()`) reads better
 * than a bare magic string there. Both are the same value; nothing here is lazy.
 */
export function loopbackServerHost(): string {
  return DEV_SERVER_LOOPBACK_HOST;
}
