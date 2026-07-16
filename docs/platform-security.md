# Platform security

The deployment platform has three principals: the browser account, an approved CLI bearer token, and deployed application code.

The control plane trusts its machine administrator and master-key holder. It does not trust uploaded paths, artifact metadata, browser input, CLI tokens, migration history, app health, or ownership claims.

Runner choice changes the code boundary:

- `process` trusts apps as much as the platform Unix user;
- `docker` is the minimum supported boundary for mutually untrusted deployers;
- hostile public multi-tenancy should use VMs/microVMs or dedicated nodes.

Never operate the process runner as a public code sandbox.

## Authentication

Browser accounts inherit Clank's scrypt passwords, hardened cookies, CSRF, generic login errors, expiry, idle timeout, and revocation.

Registration defaults to a race-guarded first-account bootstrap. Public signup must be enabled explicitly. Email verification, recovery, MFA, invitations, and organization RBAC are not yet built in.

CLI flow follows [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628/): hashed high-entropy device codes, short expiry, rate limiting, visible client identity/code, same-origin CSRF approval, throttled polling, and single use.

Bearer tokens are returned once and hashed at rest. Follow [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750): TLS, no tokens in URLs/logs, revocation, and rotation. Current tokens inherit all user projects; project-scoped tokens are future work.

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
- Stopped-app database paths are checked component-by-component for symlink substitution before backup or migration.
- Apps stop before backup/migration.
- Failure restores prior data/code.
- Data rollback is narrow and explicitly confirmed.

Export backups off-host.

## Runner hardening

Docker mode adds read-only root, dropped capabilities, no-new-privileges, non-root UID/GID, PID/memory/CPU limits, narrow bind mounts, and a constrained temporary filesystem.

Also pin image digests, patch the kernel/runtime, apply seccomp/AppArmor/SELinux, restrict network egress, protect the Docker socket, set disk quotas, isolate customer tiers, and prefer microVMs for hostile code.

## Network and scaling

- Bind control/app ports to loopback.
- Terminate TLS at a trusted proxy.
- Permit direct access only from that proxy.
- Enable proxy trust only in that topology.
- Validate allowed hosts.
- Add upstream auth/upload/request rate limits.

The control plane is currently single-instance: deploy locks and process ownership are in memory. Two active control planes over one data directory are unsupported.

## Audit checklist

- External master key and tested off-host backup.
- Docker or stronger isolation for untrusted users.
- Explicit TLS, hosts, proxy trust, resource quotas, and image digests.
- Scheduled token/audit review.
- Failed deploy leaves prior app healthy.
- Migration and data rollback rehearsed.
- Full browser-login, CLI-login, deploy, app, and rollback smoke test after upgrades.
