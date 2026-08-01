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

The TSX transform is a source-to-source compiler, not a data sandbox. It deliberately preserves application-authored JavaScript and TypeScript expressions in generated modules. Compile only trusted project source, never request or database values; execute mutually untrusted generated applications inside the documented runner isolation boundary.

### Requests and RPC

- JSON endpoints require an `application/json` or `+json` content type.
- Bodies are streamed through hard byte limits and strict UTF-8/JSON decoding.
- Same-origin and Fetch Metadata checks reject cross-site state changes.
- Validation errors omit received values so secrets are not reflected.
- Production 500 responses are generic across request apps, the Node adapter, agent actions, backends, and the deployment platform. Unexpected exception text is available only to private `onError` hooks.
- Backend cache and live-query keys are partitioned by auth session.
- Request, live-argument, live-connection, and cache limits are configurable.

### Authentication and data

- Passwords use versioned scrypt hashes with random salts and optional server-only peppering.
- Session cookies are `HttpOnly`, `SameSite=Strict` by default, `Secure` on HTTPS, and use the `__Host-` prefix when possible.
- Only SHA-256 token hashes are stored in SQLite; raw session tokens exist only in cookies and the immediate response construction path.
- Authenticated mutations require a constant-time CSRF-token comparison.
- Login errors do not reveal whether an account exists or is disabled.
- Rate limits use trusted adapter identity rather than caller-selected IP headers.
- Email verification and password recovery tokens are hashed, expiring, and single-use; recovery delivery is removed from the response-timing path, and password reset revokes prior sessions.
- Email-code MFA challenges are expiring, attempt-bounded, hashed, and single-use.
- Passkeys require discoverable credentials and begin without account lookup; they verify challenge, origin, RP ID hash, user presence/verification, signature, and atomic signature-counter advancement.
- Owned tables enforce the current user in SQL reads and writes.
- Owner IDs also scope live-query invalidation, so one account's private writes do not republish another account's query.
- Disabling users, role changes, and revoking sessions close associated live streams across same-host processes.
- Document `ifVersion` checks reject stale writes instead of silently overwriting newer edits.
- Mutation writes, output validation, revision updates, and journal records share one transaction.
- Document-history snapshots share that transaction, inherit owned-record filtering, are bounded by
  global and per-document retention, and restore only through a new expected-version-checked write.
  Treat retained snapshots and backups as application data because changed or deleted values remain
  readable to authorized history actions until retention expires.
- Mutation application writes and durable job enqueue share that transaction when using the
  mutation-scoped publisher.
- Query snapshots and change metadata are immutable at runtime.

### Durable jobs

- Job arguments and optional results are schema validated and size bounded.
- App schemas and safe migrations cannot shadow or modify queue, event, or schedule tables.
- Claims use random renewable visibility tokens; completion compares token and worker identity.
- Expired workers are fenced and work is retried with bounded exponential backoff.
- Exhausted work is retained as an explicit dead letter; cancellation fences later success.
- Owner scope follows authenticated enqueue and applies to handler database reads/writes.
- Workflow starts, root enqueue, and surrounding mutation writes are atomic; workflow idempotency
  is owner scoped.
- Workflow steps can read results only from explicit dependency edges. Graph shape, schemas, mapper
  code, and output code are revision-bound so a rolling release cannot reinterpret an active run.
- Workflow inputs, step results, errors, and outputs are retained application data. Keep mapper and
  output callbacks pure, bound sensitive history retention, and put remote effects in idempotent jobs.
- Dead, cancelled, missing, or changed workflow steps fail closed, cancel unfinished children, and
  never make blocked dependants runnable. Run, step, and event history is bounded by retention.

### Durable objects

- Stable namespace and object IDs are ASCII allowlisted, state/arguments/results are schema and byte
  bounded, and retained object identities have a fail-closed per-namespace ceiling.
- Per-object calls serialize through renewable random leases; settlement fences the exact lease
  owner, token, and prior revision so an expired runtime cannot commit stale state.
- Mutation state and its idempotency result commit atomically. Exact retention deadlines, a
  per-object record ceiling, and namespace-scoped best-effort cleanup prevent an unrelated runtime
  or maintenance failure from changing retry semantics.
- Tombstones remain capacity-accounted. Reinitialization advances the revision and clears the prior
  incarnation's idempotency ledger so an old result cannot be replayed into new state.
- Alarms use the same fencing and transactional state path, park after bounded retry, and retain
  control-character-free UTF-8-bounded diagnostics.
- MCP exposure is opt-in per method and still requires application authorization for the exact
  authenticated context, namespace, object ID, method, and request on every invocation.
- Cron occurrences use deterministic idempotency keys and independently leased schedulers.
- Worker queues and concurrency are bounded in both config and environment parsing.
- Rolling deployments quiesce old background code before starting the candidate and resume it on
  candidate failure.
- Hosted inspection uses allowlisted operational columns and bounded rows. It never returns
  arguments, results, error text, owner/group identity, worker identity, or lease credentials.
- Hosted cancellation/retry requires the dedicated project `jobs` permission, applies a
  conditional state transition inside the application SQLite transaction boundary, and writes
  payload-free job plus control-plane audit events.
- Job mutations also hold the project's durable deployment lock and recheck current membership
  before touching the database, so a queued operation cannot race a migration, restore, rollback,
  or project deletion.

Delivery remains at least once. A handler can complete an external side effect before losing its
lease, so the application must make that side effect idempotent. Abort signals are cooperative and
do not sandbox handler code. See [Durable jobs, workflow graphs, and cron](jobs-and-cron.md#handler-security-checklist).

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
- Local CLI credentials and project links are bounded, structurally validated, URL-canonicalized, owner-only, and atomically replaced; platform responses are time- and byte-bounded before strict UTF-8/JSON decoding.
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
- Organization membership, role, project token scope, and project ownership are checked for every release, log, secret, token, domain, backup, audit, and rollback.
- Account, workspace, project-domain, release-storage, backup-retention, monthly request/transfer,
  and project-minute request quotas resolve from audited administrator overrides before
  enforcement. Account/workspace/domain inserts and traffic admission remain transactional,
  releases are checked under the project lease, and backup retention is resolved whenever its
  manager opens. Quota administration is browser-admin-only, same-origin, CSRF protected, schema
  bounded, and unavailable during support impersonation.
- Encrypted backup manifests and ciphertext are authenticated and verified before restore.
- Managed ingress uses exact unique hosts, constrained upstreams, bounded bodies/timeouts, hop-header stripping, safe retries, and circuits.
- Managed-ingress admission fails closed and receives no path, headers, cookies, IP, query, or body
  content. Its fixed monthly ledger retains only aggregate workspace/project counts and known
  bytes; streamed response bytes remain an explicit edge responsibility.
- Client disconnects abort proxied upstream work and cancel streamed Node responses.

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
- configure email verification, recovery, MFA, passkeys, and bot protection to match the application's risk;
- log internal exceptions through `onError` without returning them to clients;
- keep Node and Clank patched and back up the database.
- run one active built-in process supervisor per project/data directory until a remote worker/leader topology is configured;
- keep every app's web, worker, and scheduler roles on the same durable SQLite volume, or provide a
  reviewed transactional shared-store implementation;
- alert on dead letters, oldest-due age, lease expiry, and background restart loops;
- use Docker or stronger isolation for mutually untrusted deployers;
- supply the platform master key from external secret management;
- configure object-backed scheduled recovery or export backups off-host, and independently protect
  any pre-release snapshots required by the rollback policy.

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
- unauthenticated MCP requests receive an OAuth resource challenge;
- read-only agent grants cannot discover or invoke mutations;
- OAuth codes are single-use, PKCE-bound, and reject redirect or resource mismatches;
- replaying a rotated refresh token revokes its token family;
- MCP bearer tokens cannot authenticate ordinary browser or backend RPC endpoints;
- internal-only backend functions use `agent: false`;
- destructive mutations are explicitly annotated for agent clients;
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
- semantic browser journeys cannot leave the configured app origin, attach to network CDP, or
  enter a literal password; login secrets resolve from the runner environment and never appear in
  reports or inspected surfaces;
- untrusted agent-proposed journeys use JSON, because local `.js` and `.mjs` journey modules are
  executable project code rather than a sandbox;
- collaboration endpoints re-authorize the exact room on every stream, heartbeat, presence, and
  signal request; writes reuse the application's CSRF check, and presence contains no secret or
  hidden database values;
- analytics writes require explicit consent, honor do-not-track, admit only aggregate-safe typed
  properties, pseudonymize identity with an independent HMAC secret, enforce retention and storage
  ceilings, and never expose raw events or small cohorts;
- signed blueprint installs pin explicit Ed25519 roles and namespace/origin scopes, exact semantic
  versions, normalized data/digests, monotonic catalogs, revocations, and same-origin bounded JSON;
  redirects, mutable tags, executable registry content, and implicit wildcard authority fail;

Clank's test suite contains executable checks for these invariants. Security is iterative: repeat this review when adding a new transport, credential type, storage backend, raw-HTML path, or deployment topology.

See the [ASVS-oriented verification map](security-asvs.md), [threat model](threat-model.md), and [chaos drills](chaos-testing.md) for release evidence and residual responsibilities.
