# Security

Clank treats browser input, agent input, URLs, cookies, request bodies, and persisted document data as untrusted. Secure defaults are applied in the framework, but deployment configuration and application authorization remain part of the boundary.

## Built-in defenses

### Rendering

- Text and attributes are escaped during SSR.
- Serialized state escapes `<`, `>`, `&`, and Unicode line separators.
- Inline `on*` attributes are rejected case-insensitively.
- `javascript:`, `vbscript:`, `file:`, non-image `data:`, SVG data images, and `srcdoc` attributes are rejected.
- Event listeners must be functions and are installed through `addEventListener`.
- Two-way binding is restricted to `value`, `checked`, `selected`, and `selectedIndex`.
- `renderDocument({ nonce })` applies a validated CSP nonce to generated boot-state and module script tags.

`dangerouslySetInnerHTML` deliberately bypasses escaping. Use it only with trusted static content or an application-selected sanitizer. Clank does not include an HTML sanitizer because safe policies depend on the tags, attributes, and URL schemes an application intends to allow.

### Requests and RPC

- JSON endpoints require an `application/json` or `+json` content type.
- Bodies are streamed through hard byte limits and strict UTF-8/JSON decoding.
- Same-origin and Fetch Metadata checks reject cross-site state changes.
- Validation errors omit received values so secrets are not reflected.
- Production 500 responses are generic unless `exposeErrors` is explicitly enabled.
- Backend cache and live-query keys are partitioned by auth session.
- Request, live-argument, live-connection, and cache limits are configurable.

### Authentication and data

- Passwords use versioned scrypt hashes with random salts and optional server-only peppering.
- Session cookies are `HttpOnly`, `SameSite=Strict` by default, `Secure` on HTTPS, and use the `__Host-` prefix when possible.
- Only SHA-256 token hashes are stored in SQLite; raw session tokens exist only in cookies and the immediate response construction path.
- Authenticated mutations require a constant-time CSRF-token comparison.
- Login errors do not reveal whether an account exists or is disabled.
- Owned tables enforce the current user in SQL reads and writes.
- Owner IDs also scope live-query invalidation, so one account's private writes do not republish another account's query.
- Disabling users, role changes, and revoking sessions close associated live streams across same-host processes.
- Document `ifVersion` checks reject stale writes instead of silently overwriting newer edits.
- Mutation writes, output validation, revision updates, and journal records share one transaction.
- Query snapshots and change metadata are immutable at runtime.

### Node and files

- The Node adapter caps headers and bodies and configures header, request, and keep-alive timeouts.
- Loopback servers allow only loopback Host values by default.
- `allowedHosts` is available for production and reverse-proxy hostnames.
- `trustProxy` is off by default.
- Static paths are URL-decoded, containment-checked, resolved through the filesystem, checked again after symlinks, and deny dotfiles by default.
- Static responses use MIME types plus `X-Content-Type-Options: nosniff`.

### Agent actions

- Inputs and optional outputs are runtime validated.
- Authorization runs before the action handler.
- HTTP calls to write/destructive actions require `x-clank-confirmation: confirmed` when the action policy is `write` or `always`.
- Semantic inspection omits password, file, hidden, and inaccessible control values.
- Agent input refuses disabled, read-only, hidden, and file controls; file upload must use an application-defined, validated action.
- Confirmation is an accident-prevention protocol, not authorization. A caller able to forge the header still needs application authentication and authorization.

### Deployment platform

- CLI login uses short-lived browser-approved device codes; raw access tokens are returned once and stored only as hashes.
- Artifacts and every contained file are SHA-256 verified before exclusive extraction.
- Paths, links, special files, sensitive dotfiles, sizes, counts, modes, and decompression output are validated.
- Builds run locally without a shell; uploaded install/build hooks are never executed by the platform.
- Secrets use AES-256-GCM and values are never returned by the API.
- SQL migration history is immutable and pending migrations are transactional.
- Safe migrations cannot modify Clank-managed SQL namespaces.
- SQLite is integrity-checked and backed up after quiescing the active app.
- Database and backup paths reject final symbolic links and use private file permissions.
- Migration, startup, or health failure restores the prior database and process.
- Code rollback is health-gated; data rollback is narrowly scoped and confirmed.
- Project ownership is checked for every release, log, secret, audit, and rollback.

See [Platform security](platform-security.md) for the runner trust boundary.

## Recommended production setup

```ts
const app = createApp()
  .use(securityHeaders({
    contentSecurityPolicy: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; "),
  }))
  .route("*", "*", ({ request }) => runtime.handle(request));

await serve(app, {
  hostname: "0.0.0.0",
  allowedHosts: ["app.example.com"],
  maxBodySize: 1024 * 1024,
});
```

Also:

- terminate TLS at the app or a trusted reverse proxy;
- set `trustProxy: true` only when untrusted clients cannot reach the Node listener directly;
- set a strong `CLANK_AUTH_PEPPER` through secret management;
- keep the SQLite file and backups outside static roots with restrictive OS permissions;
- compile and serve Tailwind CSS locally in production;
- add a shared rate limiter when running more than one process;
- add email verification, reset, and MFA when the application's risk warrants them;
- log internal exceptions through `onError` without returning them to clients;
- keep Node and Clank patched and back up the database.
- run one control-plane instance per platform data directory;
- use Docker or stronger isolation for mutually untrusted deployers;
- supply the platform master key from external secret management;
- export scheduled backups and pre-release snapshots off-host.

## CSP nonces

Generate a fresh unpredictable nonce for every HTML response:

```tsx
const nonce = crypto.randomUUID().replaceAll("-", "");
const page = await renderDocument(view, {
  nonce,
  state,
  scripts: ["/app.js"],
});

return html(page, {
  headers: {
    "content-security-policy":
      `default-src 'self'; script-src 'self' 'nonce-${nonce}'; object-src 'none'`,
  },
});
```

Any inline script supplied through `head` must receive the same `nonce` property. Avoid `unsafe-inline` for scripts.

## Reverse proxies and Tailscale

For the authenticated Todo behind Tailscale Serve:

```sh
PORT=4180 \
TRUST_PROXY=1 \
ALLOWED_HOSTS=localhost,127.0.0.1,nearbyserver.example.ts.net \
node examples/auth-todo/server.js

tailscale serve --https=8446 http://127.0.0.1:4180
```

`TRUST_PROXY=1` is safe here only because the listener remains on loopback and Tailscale is the only proxy that can reach it. `ALLOWED_HOSTS` must contain the public Tailscale DNS name so Host validation succeeds. With forwarded HTTPS enabled, Clank issues the `Secure; __Host-` session cookie.

## Reporting and audit checklist

Before release, verify:

- anonymous requests cannot call required queries or mutations;
- two accounts cannot read or mutate each other's owned rows;
- missing/wrong CSRF tokens fail;
- cross-origin writes fail;
- logout and user disabling revoke current live access;
- malformed paths and oversized bodies return 4xx, not 500;
- internal exceptions do not appear in production responses;
- static traversal, dotfile, and symlink escape attempts fail;
- CSP is present on HTML;
- cookies are `HttpOnly`, `Secure`, `SameSite`, and host-only in production;
- the complete app works in two independent browser contexts.

Clank's test suite contains executable checks for these invariants. Security is iterative: repeat this review when adding a new transport, credential type, storage backend, raw-HTML path, or deployment topology.
