# Platform security

The deployment platform has three principals: the browser account, an approved CLI bearer token, and deployed application code.

The control plane trusts its machine administrator and master-key holder. It does not trust uploaded paths, artifact metadata, browser input, CLI tokens, migration history, app health, or ownership claims.

Runner choice changes the code boundary:

- `process` trusts apps as much as the platform Unix user;
- `docker` is the minimum supported boundary for mutually untrusted deployers;
- hostile public multi-tenancy should use VMs/microVMs or dedicated nodes.

Never operate the process runner as a public code sandbox.

The packaged production entry point defaults to `CLANK_HOSTING_PROFILE=isolated`, which selects
Docker and rejects a process runner. `CLANK_HOSTING_PROFILE=trusted` is an explicit low-cost
self-hosting acknowledgement: it permits process execution but refuses `CLANK_SIGNUP=public`.
Bootstrap, disabled registration, and email-bound invitations remain available for operators who
personally trust every deployer. Invalid or misspelled runner/profile values are startup errors.

Programmatic `openPlatform()` callers can declare the same profile. An `isolated` runtime rejects
anything other than the Docker runner and reports the resolved profile and runner kind for private
operator diagnostics. The profile is a policy assertion; it does not turn a container into a VM or
replace daemon hardening, network policy, resource limits, image pinning, or host monitoring.

## Remote deployment nodes

The deployment-node API is absent unless `CLANK_RUNNER_COORDINATOR=1` or the legacy shared
`CLANK_RUNNER_REGISTRATION_TOKEN` is configured. Managed enrollment is created only by a
same-origin, CSRF-protected browser administrator and is bound to one exact node and region,
expiring, transactionally reserved, and single-use. It must not reuse the master key, CLI
credentials, project tokens, or application secrets. Registration returns a node credential once
and stores only its digest. Every subsequent call binds a bearer credential to an exact bounded
node ID. See [Deployment runner fleet](runner-fleet.md).

The versioned transport accepts only POST JSON, bounds request and response bytes, refuses
non-loopback cleartext clients and redirects, emits no-store responses, and returns generic
authentication failures. Operation settlement still compares node ID, operation token digest,
lease expiry, and monotonically increasing fence. An expired heartbeat cannot authenticate for
settlement, and a generation-stale observation cannot replace current desired state.

Protect enrollment with edge rate limiting and preferably private-network admission. A registration
token holder can rotate a node identity, so rotate the token after provisioning-system exposure.
Node credentials authorize deployment coordination, not browser, CLI, database, secret, or
application APIs.

Release download additionally requires a current operation lease bound to the same node and fence;
a node credential alone cannot enumerate or fetch releases. The provider never receives the
operation lease token, and release selection comes from the canonical stored operation rather than
the node's echoed payload. The coordinator and client independently bound the body and verify
SHA-256, and the platform reads retained archives through an owner/mode/inode-validated no-follow
file descriptor. Archives are retained only while remote enrollment is enabled, counted against
release storage, and contain neither platform-managed secrets nor application database files.

The separate runtime-capsule call is available only when a coordinator runtime source is
configured and still requires the exact current node and operation lease. It carries the final
application environment, SQLite placement intent/optional snapshot, and ingress token only in a
bounded `private, no-store` body. Both hops verify the whole digest and the provider adapter binds
the decoded project, release, and generation to canonical desired state. The provider is therefore
a trusted application compute boundary; compromise there can expose placed application data and
secrets. The platform master key, browser/CLI credentials, node credential, and operation token
never enter the capsule.

The built-in deployment-agent loop keeps the enrollment token separate from the per-node
credential and needs enrollment authority only when no usable node credential exists. Its file
store rejects symbolic links, non-regular and oversized files, group/world-readable permissions,
unexpected owners or inode/path swaps, invalid versions, malformed records, and invalid tokens;
reads use a no-follow descriptor and writes use an atomic owner-only replacement. Keep that file on
a private persistent volume and do not share one store across processes.

Lease loss and shutdown deadline are abandonment paths, not failure settlement: the executor is
aborted and the coordinator reclaims the operation only after its current fenced lease expires.
Likewise, an uncertain completion response is never followed by an explicit failure, because the
completion may already have committed. Runtime adapters must honor the abort signal and make
provider mutations idempotent under the operation identity and monotonically increasing fence.
Private execution and transport errors go to the node's operator hook; the default durable failure
message contains no exception detail.

The `DeploymentProvider` wrapper gives provider code only the operation ID, project ID, monotonic
fence, attempt counters, desired generation/state/release, verified deployment content, and abort
signal. A runtime-selected request intentionally adds the verified application environment,
database placement, and ingress identity needed to launch that project. Node credentials and
operation lease tokens do not cross the boundary. The optional HTTP bridge uses a separate
high-entropy bearer token, refuses redirects and non-loopback plaintext HTTP, bounds requests and
failure bodies, independently verifies artifact or capsule bytes, and exposes only generic
provider failures. Secret values stay out of headers. Its exact retries are safe only when
provider code persists the operation/fence idempotency rule.

The built-in control plane can activate only explicitly created provider projects. It encrypts a
frozen environment per generation, produces the capsule only for a current reconcile lease,
requires stateful endpoint/label placement, validates the provider endpoint against an exact HTTPS
hostname allowlist, and publishes only when desired and observed project/release/generation/node
all match. The public route overwrites every provider-binding header and derives its private token
from the master key, project, and generation without storing it. A distinct derived control token
never enters public ingress and authorizes only a consistent snapshot of that same active
generation.

Provider rollback and deletion are separately fenced operations pinned to the exact active node.
Deletion removes control metadata only after provider confirmation. Pending deploys retain staging
state and their CLI idempotency key. A stale, unavailable, or mismatched provider fails closed
without falling into the local supervisor or moving node-local SQLite.

Provider backup creation requires the currently active pinned node and unchanged allowlisted
origin, refuses redirects and content encodings, bounds time and bytes, verifies media type,
release, generation, length, and SHA-256, then rechecks placement before direct in-memory
encryption. No plaintext snapshot is staged on control-plane storage. Local backup storage remains
the cheap default; use the S3-compatible repository to cross the control-volume failure domain.
Provider restore authenticates the selected envelope, creates and verifies an encrypted safety
backup, and persists only recovery IDs/digests/sizes beside the encrypted generation environment.
The recovery bytes travel only inside the lease-scoped private runtime capsule. The provider
independently verifies the capsule, revokes and drains the old writer, takes an exact local safety
snapshot, replaces SQLite, reapplies current immutable migrations, validates a deferred candidate,
and publishes ingress last. Pending retention protects both platform recovery points; a timeout
resumes the same intent, while a failed exact operation can advance only through a new monotonic
generation after target and safety re-verification. Restore intentionally pauses writes and is not
a zero-downtime database operation.

Provider hosts remain trusted compute and require private TLS, non-root isolated runtime execution,
a protected Docker socket, disk/network policy, monitoring, and secret rotation after compromise.

Provider diagnostics use the separate generation-derived control credential, not the public
ingress credential. The provider retains only a bounded memory tail, samples exact tracked
containers without a shell, omits Docker/container/environment/path identity, and caps the private
JSON response. The control plane pins the allowlisted origin, refuses redirects and encodings,
checks length/media/release/generation, validates every field and aggregate, then rechecks
placement after transfer. Configured project secrets are redacted before the project API response;
unregistered sensitive application output remains an operator/application responsibility.
See [Complete deployment provider service](provider-service.md), [Provider data
lifecycle](provider-data-lifecycle.md), [Provider Docker
runtime](provider-docker-runtime.md), [Provider runtime
ingress](provider-runtime-ingress.md), and [Remote runtime placement](runtime-placement.md).

## Authentication

Browser accounts inherit Clank's scrypt passwords, hardened cookies, CSRF, generic login errors, expiry, idle timeout, verification, recovery, email-code MFA, WebAuthn passkeys, and revocation.

Password registration/login and CLI device-start throttles use atomic sliding windows in the control database, so another control-plane process or restart cannot reset them. Keys are HMAC-SHA-256 pseudonyms under the platform master key; raw client/account combinations are not stored. Expired windows are removed on use, future timestamps caused by clock rollback are conservatively clamped, and high-cardinality state is pruned from 20,000 to 18,000 keys. Keep upstream IP/account abuse controls because bounded local state can still be pressured by a distributed attacker.

Registration defaults to a race-guarded first-account bootstrap. The platform applies its policy to the same normalized auth operation as the low-level router, including repeated-slash compatibility paths. An expiring singleton claim in the control database serializes bootstrap across control-plane runtimes; a stable insertion-order check removes any losing account before its session is returned. Public signup must be enabled explicitly. Organizations include owner/admin/developer/viewer roles, invitations, last-owner protection, and project-scoped CLI tokens whose permissions are intersected with current membership on every request.

Platform administration is a separate operator authority, never an alias for a workspace
administrator. Exact normalized emails are supplied through `platformAdminEmails` or
`CLANK_PLATFORM_ADMIN_EMAILS`; the allowlist is reconciled at startup and after registration, and
removing an address demotes the account. Global user and analytics APIs require a same-origin
interactive browser session. Account-wide and project-scoped CLI bearer tokens are deliberately
denied even when they belong to an operator. The user directory returns identity, status, activity,
membership, project, and aggregate storage metadata but never password hashes, session/CSRF
secrets, token hashes, raw tokens, recovery material, passkeys, or application-database users.

The memory-diagnostics API follows the same browser-only platform-administrator boundary. It
returns bounded cgroup and process counters, project/release identifiers, and process IDs, but
never command arguments, environment variables, secrets, or filesystem paths. CLI bearer tokens,
ordinary accounts, and support impersonation cannot access it. Process-runner attribution uses
Linux PSS when available to avoid double-counting shared pages, with RSS as a portable fallback;
Docker-runner entries describe the wrapper process and must not be treated as complete container
isolation telemetry.

The storage-diagnostics API uses the same boundary and returns only aggregate byte and entry
counters plus existing project identity metadata. It never returns host paths, filenames, file
contents, database rows, backup manifests, or secret material. The scan is entry- and depth-bounded,
deduplicates hard-linked file allocation, does not descend through symbolic-link entries, and
reports truncation and read errors instead of silently presenting partial data as complete.

Support impersonation is deliberately narrower than administrator access. Starting it requires the
operator's same-origin browser session, CSRF token, a session created within the last 30 minutes, an
8–500 character audit reason, and exact target-email confirmation. An operator cannot target
themselves, a disabled account, or another platform administrator. The opaque 15-minute capability
is stored only as a hash, bound to the operator's current browser session, and carried in a separate
`HttpOnly`, `Secure`, `SameSite=Strict` cookie. The effective target identity applies only to safe
read methods: tenant, identity, device-approval, and platform-administration mutations are rejected
server-side. A permanent console banner names the operator, target, reason, and expiry; starting and
stopping are attributed to the real operator in the audit log. Signing out first revokes the support
session. These controls reduce accidental change and token replay, but impersonation still exposes
all data that the target can read, so operators need strong account security and a documented
support-access policy.

Sign-out and an authenticated API `401` reload the console from the server instead of reusing an in-memory dashboard. This clears prior-account DOM and recomputes both session state and bootstrap availability before another identity can use the page.

Invitation tokens are email-bound, single-use, expiring, hashed at rest, and returned only by the create response. A valid token is a narrowly scoped account-creation capability even when ordinary registration is closed. Workspace invitations add one explicit role in one existing workspace. Personal invitations create only the recipient account; normal dashboard initialization then provisions that account's isolated personal workspace. Personal invitation creation, listing, and revocation require an allowlisted, non-impersonating platform administrator using a same-origin browser session and CSRF token; bearer credentials are rejected. The assisted route enforces the configured origin policy before token lookup, uses the normal bounded registration, rate-limit, password-validation, and scrypt path, then transactionally rechecks and consumes the invitation before conditionally creating membership. A race or membership failure deletes the new account and its cascaded session before responding; invalid, expired, revoked, mismatched, and replayed tokens receive a generic invitation error.

Reissuing for one scope/email atomically revokes older active tokens, existing workspace members must use the explicit role-change path, and both each workspace and the platform-wide personal scope are capped at 100 active invitations. A personal invitation is rejected when its email already has an account. Pending addresses are returned only to their authorized administrators; developer audit responses also redact workspace-invitation recipient email fields, including for older stored events. Creation, revocation, acceptance, role changes, and removals are audited; removal also revokes organization/project-scoped credentials.

Optional invitation email uses a transactional control-database outbox. The ordinary invitation
record remains hash-only; the outbox holds an AES-256-GCM token envelope only while delivery can
still run. Creation and enqueue commit atomically, control-plane instances claim work through
expiring SQLite leases, and every provider attempt reuses an invitation-scoped idempotency key.
Successful send, acceptance, replacement, revocation, or expiry erases the ciphertext. Stale
worker leases are reclaimable, while lease-token fencing prevents a late response from restoring a
cancelled delivery. Provider error details reach only the private operator error hook; tenant
responses expose a generic queued, retrying, sent, failed, or manual state. Invite URLs carry the
token in a browser fragment and scrub it immediately, keeping it out of HTTP request targets and
referrers. Email already accepted by a provider cannot be recalled, but revocation makes its token
invalid.

CLI flow follows [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628/): hashed high-entropy device codes, short expiry, rate limiting, visible client identity/code, same-origin CSRF approval, throttled polling, and single use.

Bearer tokens are returned once and hashed at rest. Follow [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750): TLS, no tokens in URLs/logs, revocation, and rotation. Account tokens can create or administer organizations according to membership; project tokens are restricted to one project and explicit `read`, `deploy`, `rollback`, `jobs`, `secrets`, `tokens`, and `audit` permissions.

## Billing and entitlements

Billing is absent unless an operator configures a bounded plan catalog. Catalog parsing is exact
and fail-closed: the free default must have a zero price, paid plans must map one-to-one to the
provider adapter, quota keys and ranges are validated, and provider secrets are accepted only
through environment variables. Public billing payloads contain plan names, descriptions, prices,
states, and effective quotas, but never customer/subscription references or provider secrets.

Account billing reads accept an interactive account or account-wide token; project-scoped tokens
are denied. Checkout and portal mutations reject bearer credentials and require the account's
same-origin browser session and CSRF header. Administrators can grant or revoke catalog plans only
through a non-impersonating browser-admin boundary. A provider-managed row cannot be replaced by a
manual grant, and an explicit account quota override remains the highest account-level authority.
All grants, revocations, checkout creation, and provider state changes emit bounded audit metadata
without provider resource identifiers.

The included Stripe adapter sends POST requests only to the fixed Stripe API origin, refuses
redirects and encoded or unbounded responses, applies deadlines, validates hosted return origins,
and uses a durable checkout-attempt identity as Stripe's idempotency key. The webhook reads at most
512 KiB and verifies HMAC-SHA256 over the exact raw bytes with a bounded timestamp window before
JSON parsing. It checks live/test mode, supported event type, metadata, one configured subscription
item, quantity, Price mapping, and opaque ID syntax.

Clank transactionally binds a webhook to its durable attempt, account, session, customer, and
subscription. Event IDs are stored with a digest: an exact replay is idempotent and conflicting
reuse is rejected. Subscription event timestamps impose a monotonic state order, including when a
subscription event arrives before checkout completion. Entitlement snapshots apply for manual,
trialing, active, and bounded-grace past-due states; every other state and malformed stored snapshot
falls back to the default plan. Downgrades change future admission only and never delete resources.
See [Hosted plans and billing](hosted-plans-and-billing.md).

## Artifact intake

Before extraction Clank bounds HTTP and gzip output; rejects unknown fields, traversal, duplicates, links, special files, sensitive dotfiles, NULs, and unsafe modes; verifies base64, sizes, every file hash, and the artifact hash; and writes exclusively inside a new release root.

The platform never runs uploaded package-install or build hooks.

## Secrets

Secret values use AES-256-GCM authenticated encryption, consistent with [OWASP secrets-management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html).

- Supply the master key from KMS or secret management.
- Back it up separately and restrict decryption authority.
- Rotate application secrets after exposure.
- Never log secrets.
- Platform administrators and the running app can access decrypted values.
- Environment injection can be inspected by privileged host/container administrators.

The generated local key is onboarding convenience, not protection from a compromised host.

## Database and filesystem

- Projects have dedicated contained data directories.
- Platform and apps use umask `0077`.
- SQLite, WAL, backups, CLI config, and master-key files are owner-only.
- Migration history is immutable.
- Cross-database, extension, PRAGMA, and transaction-control SQL is rejected by default.
- App configuration cannot enable unrestricted SQL unless the platform operator separately opts in.
- Database paths are checked component-by-component for symlink substitution before backup or migration.
- Deploy migrations stop the app and take a pre-change snapshot; scheduled recovery points use SQLite's consistent online backup API and are encrypted and verified before publication.
- Scheduled backup work uses expiring durable claims across control planes, and public metadata omits the host database path.
- Per-project release count and byte quotas include extracted runtime files and pre-deploy snapshots; cleanup is contained to derived project/release paths.
- Previews are independent project/data/token namespaces, never inherit production secrets or raw
  database contents, cannot be nested, and consume the same account/workspace project quotas as
  production. Opt-in data branches use only the active production release's bounded policy, purge
  auth/OAuth/jobs/workflow state/document-history snapshots and unlisted tables, HMAC-pseudonymize per preview, securely clear staging files,
  disclose only counts, and pass target migrations plus health before publication. Expiration uses
  the complete locked project-deletion path before startup recovery.
- Per-account and per-workspace quota overrides are validated against a fixed key/range registry,
  require a real browser administrator session plus CSRF, and are written with an append-only audit
  event. Workspace values override their owning account, which overrides installation defaults;
  lowering capacity never implicitly deletes application resources. Backup retention reconciles
  oldest restore points during the next successful backup, as stated in the operator UI.
- Monthly workspace requests, known transfer, and per-project minute requests are admitted in one
  immediate SQLite transaction, so concurrent control-plane connections cannot cross the request
  boundary by racing reads. Policy errors and malformed decisions fail closed. Denials increment a
  separate rejection counter without becoming admitted usage.
- The retained usage ledger has fixed workspace/project/month dimensions and contains no paths,
  hosts, headers, cookies, IP addresses, query strings, body content, email addresses, or
  application identities. Deleted projects retain only bounded operational totals until the
  configured installation-wide retention expires; pruning runs at startup and during ingress.
- Active artifacts cannot be removed; cleanup requires rollback scope, and deleting the immediate rollback target requires a separate rollback-loss decision that also prunes its now-unusable matching data snapshot.
- Permanent site deletion requires an owner/admin account principal, exact slug-bound confirmation, a separate data-loss acknowledgement, and the durable project lock. Project-scoped tokens cannot invoke it.
- Site storage removal derives the directory from the validated project ID, rejects symbolic-link parents/roots, and occurs before metadata removal. Active project tokens and distributed orchestration rows are cleared, while the deletion audit event survives the project cascade.
- Audit rows carry non-cascading organization attribution. Workspace feeds join current membership, exclude viewers, scope project tokens to one project, cap pages at 200 events, and use parameterized descending-ID cursors.
- Failure restores prior data/code.
- Data rollback is narrow and explicitly confirmed.

Configure the built-in object-backed recovery repository or export completed encrypted backups
off-host, and keep the master key in a separate failure domain. Site deletion removes
platform-managed local and object-backed recovery points, but cannot discover provider-retained
versions, manual copies, external databases, unrelated artifacts, or edge certificate storage;
operators must apply the same retention/deletion request to those systems.

The control-plane audit API has no update or delete operation, but the trusted SQLite administrator can modify local history. Replicate events to a separately administered append-only or signed log when operator tampering is part of the threat model.

## Runner hardening

Docker mode adds read-only root, dropped capabilities, no-new-privileges, non-root UID/GID,
PID/memory/CPU limits, narrow bind mounts, and a constrained temporary filesystem. Runtime values
are serialized into one encoded `CLANK_RUNTIME_ENV_B64` envelope; only that inert name enters the
Docker client's environment and arguments. The container bootstrap decodes and deletes it before
application import. Application variables therefore cannot act as host-side Docker, loader, proxy,
or TLS controls, and no secret value appears in Docker CLI arguments. Privileged host/container
administrators can still inspect runtime environment state.

The remote provider Docker launcher uses a stricter one-shot stdin bootstrap, so its capsule
environment never becomes Docker container configuration. It also requires an immutable image and
non-root uid/gid by default, bounds combined container count, and verifies exact-owner cleanup on
startup, uncertain create, stop, and close. Deferred activation keeps workers and schedulers
stopped until provider data metadata commits, and the data discard hook proves candidate removal
before uncommitted SQLite rollback. See [Provider Docker runtime](provider-docker-runtime.md) and
[Complete deployment provider service](provider-service.md).

Also pin image digests, patch the kernel/runtime, apply seccomp/AppArmor/SELinux, restrict network egress, protect the Docker socket, set disk quotas, isolate customer tiers, and prefer microVMs for hostile code.

## Network and scaling

- Bind control/app ports to loopback.
- Terminate TLS at a trusted proxy.
- Permit direct access only from that proxy.
- Enable proxy trust only in that topology.
- Validate allowed hosts.
- Add upstream auth/upload/request rate limits; the built-in shared limiter is a control-plane backstop, not a DDoS edge.

Distributed leases, authenticated workers, desired generations, durable idempotent operations, node draining, retries, and monotonic fences are available. The built-in child-process supervisor still keeps process ownership in memory, so run one active supervisor per project/data directory unless using a remote worker/leader integration.

Managed ingress routes only exact verified hosts to loopback or explicit allowlisted upstreams, strips hop-by-hop and `Connection`-nominated headers, bounds request bodies and timeouts, retries only safe methods, and opens failure circuits. TLS certificates, DNS automation, WAF/DDoS controls, and WebSocket proxying belong at the external edge.

Ingress constructs the upstream URL from trusted route configuration before assigning the untrusted path, preventing scheme-relative path SSRF. The Node adapter exposes request bodies as capped streams, so authentication and smaller route-level limits run without first buffering the deployment-wide artifact maximum. Bodies without `Content-Length` are stopped at the same transport and ingress limits. Metrics are project-only aggregates with fixed status, method, byte, and histogram columns; they do not create host/path/IP/user/query/user-agent label cardinality.

The traffic admission callback receives only project/route IDs, normalized method, request byte
count, and receipt time. It never receives the URL path, headers, cookies, client address, query
string, or body content. Known transfer deliberately counts only admitted request bodies and
body-capable responses with `Content-Length`; streamed bytes are not estimated. Already-admitted
concurrent responses can move that ledger beyond its limit before later requests are refused.
Keep direct application ports private, set application/edge response and concurrency bounds, and
retain edge rate/body/DDoS controls because pre-admission failures and unmetered response streams
are outside the tenant ledger.

Custom domains require an exact random TXT ownership proof and a separate CNAME/A/AAAA routing check. A pending or verified hostname cannot move between projects, and Clank's own console, target, base domain, and base-domain namespace are reserved. Account organization/site, organization site, and project domain ceilings are enforced inside SQLite transactions.

The Caddy TLS permission route uses a high-entropy shared token and an indexed local lookup. It allows only deployed built-in hosts or deployed custom domains with verified ownership and ready routing; it never performs DNS during a TLS handshake. Keep it on loopback/private networking, persist Caddy certificate storage, avoid logging its token-bearing URL, and enable strict SNI/Host matching at the edge.

## Audit checklist

- External master key and tested off-host backup.
- Docker or stronger isolation for untrusted users.
- Explicit TLS, hosts, proxy trust, resource quotas, and image digests.
- Private token-protected TLS permission route, persistent certificate storage, and strict SNI/Host matching.
- Scheduled token/audit review.
- Destructive site-deletion drill, including off-host retention cleanup and audit review.
- Failed deploy leaves prior app healthy.
- Migration and data rollback rehearsed.
- Full browser-login, CLI-login, deploy, app, and rollback smoke test after upgrades.
- `npm run check`, CodeQL, ASVS evidence review, and the staging chaos/restore drills.
