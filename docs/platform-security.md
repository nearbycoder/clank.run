# Platform security

The deployment platform has three principals: the browser account, an approved CLI bearer token, and deployed application code.

The control plane trusts its machine administrator and master-key holder. It does not trust uploaded paths, artifact metadata, browser input, CLI tokens, migration history, app health, or ownership claims.

Runner choice changes the code boundary:

- `process` trusts apps as much as the platform Unix user;
- `docker` is the minimum supported boundary for mutually untrusted deployers;
- hostile public multi-tenancy should use VMs/microVMs or dedicated nodes.

Never operate the process runner as a public code sandbox.

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

Invitation tokens are email-bound, single-use, expiring, hashed at rest, and returned only by the create response. A valid token is a narrowly scoped account-creation capability even when ordinary registration is closed. The assisted route enforces the configured origin policy before token lookup, uses the normal bounded registration, rate-limit, password-validation, and scrypt path, then transactionally rechecks and consumes the invitation with membership creation. A race or membership failure deletes the new account and its cascaded session before responding; invalid, expired, revoked, mismatched, and replayed tokens receive a generic invitation error.

Reissuing for one workspace/email atomically revokes older active tokens, existing members must use the explicit role-change path, and each workspace is capped at 100 active invitations. Pending addresses are returned only to owners and administrators; developer audit responses also redact invitation-recipient email fields, including for older stored events. Revocation, acceptance, role changes, and removals are audited; removal also revokes organization/project-scoped credentials.

CLI flow follows [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628/): hashed high-entropy device codes, short expiry, rate limiting, visible client identity/code, same-origin CSRF approval, throttled polling, and single use.

Bearer tokens are returned once and hashed at rest. Follow [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750): TLS, no tokens in URLs/logs, revocation, and rotation. Account tokens can create or administer organizations according to membership; project tokens are restricted to one project and explicit `read`, `deploy`, `rollback`, `secrets`, `tokens`, and `audit` permissions.

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
- Active artifacts cannot be removed; cleanup requires rollback scope, and deleting the immediate rollback target requires a separate rollback-loss decision that also prunes its now-unusable matching data snapshot.
- Permanent site deletion requires an owner/admin account principal, exact slug-bound confirmation, a separate data-loss acknowledgement, and the durable project lock. Project-scoped tokens cannot invoke it.
- Site storage removal derives the directory from the validated project ID, rejects symbolic-link parents/roots, and occurs before metadata removal. Active project tokens and distributed orchestration rows are cleared, while the deletion audit event survives the project cascade.
- Audit rows carry non-cascading organization attribution. Workspace feeds join current membership, exclude viewers, scope project tokens to one project, cap pages at 200 events, and use parameterized descending-ID cursors.
- Failure restores prior data/code.
- Data rollback is narrow and explicitly confirmed.

Export completed encrypted backup directories off-host and keep the master key in a separate failure domain. Site deletion removes the platform-managed local recovery directory but cannot erase already replicated backups, external databases, copied artifacts, or edge certificate storage; operators must apply the same retention/deletion request to those systems.

The control-plane audit API has no update or delete operation, but the trusted SQLite administrator can modify local history. Replicate events to a separately administered append-only or signed log when operator tampering is part of the threat model.

## Runner hardening

Docker mode adds read-only root, dropped capabilities, no-new-privileges, non-root UID/GID, PID/memory/CPU limits, narrow bind mounts, and a constrained temporary filesystem. Runtime secret values are supplied through the Docker client's environment with name-only `-e NAME` arguments, so values do not appear in the Docker CLI process arguments. Privileged host/container administrators can still inspect runtime environment state.

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
