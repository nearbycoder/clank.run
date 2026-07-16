# Threat model

This model covers the Clank framework, generated authenticated applications, CLI, control plane, deployment artifact path, managed ingress, service drivers, and backup system.

## Assets

- account credentials, sessions, passkeys, recovery tokens, and CLI tokens;
- organization membership, project permissions, audit history, and deployment authority;
- application source/artifacts, migrations, secrets, databases, files, email, jobs, and webhooks;
- control-plane master keys, encrypted backups, release history, and signing/provenance data;
- availability and integrity of active application processes and routes.

## Principals

- anonymous browser or agent;
- authenticated application user;
- organization owner, admin, developer, or viewer;
- browser account approving a CLI device;
- account-wide or project-scoped CLI token;
- deployment control-plane process;
- authenticated deployment worker;
- deployed application process/container;
- machine, container, database, DNS, email, object-storage, and TLS operators.

## Trust boundaries

1. Browser/agent to application HTTP and live-stream APIs.
2. Browser to auth, recovery, MFA, and passkey ceremonies.
3. CLI to browser-approved device flow and control-plane bearer API.
4. Artifact bytes to extraction, migration, candidate startup, and activation.
5. Control plane to application process/container and project filesystem.
6. Managed ingress to host routing and application upstream.
7. Framework to external email, file, job, webhook, database, and provisioning providers.
8. Live database to encrypted backup repository and restore target.
9. Git source to CI, attestation, GitHub release, and npm publication.

## Primary abuse cases

| Threat | Representative attack | Principal controls | Residual responsibility |
| --- | --- | --- | --- |
| Account takeover | Credential stuffing, reset replay, stolen session, cloned authenticator | Scrypt, generic login errors, rate-limit interface, single-use recovery, MFA, WebAuthn verification/counters, revocation | Shared limiter, bot defense, email security, user/device risk policy |
| Cross-site action | CSRF, forged Origin, cross-site device approval | Strict cookies, CSRF token, Fetch Metadata/origin checks | Correct proxy scheme/host configuration and CSP |
| Tenant escape | Guess project/user IDs, reuse scoped token, stale membership | Owned SQL, membership/role checks, project/scope checks on every request, revocation | Domain-specific row/resource authorization |
| Privilege escalation | Admin grants excess scopes, removes last owner, uses viewer token to deploy | Role matrix, scope intersection, last-owner protection, audit | Periodic access review and separation of duties |
| Artifact compromise | Traversal, symlink, decompression bomb, digest swap, malicious install hook | Bounded deterministic bundle, path/type/mode validation, SHA-256 verification, no remote install/build hooks | Review trusted source and isolate runtime execution |
| Migration/data loss | Edited history, unsafe SQL, failed migration, destructive rollback | Immutable ledger, restricted SQL, quiesced backup, transactional apply, safety restore, confirmation | Schema review, off-host backups, restore drills |
| Secret disclosure | API response/log leak, filesystem exposure, package publication | AES-GCM, no secret reads, recursive log redaction, private umask, npm package audit | KMS, rotation, OS/operator access, provider logging |
| SSRF/proxy confusion | Attacker-chosen upstream, duplicate host, hop-header smuggling | Loopback/allowlist upstreams, exact unique hosts, `Connection`-nominated header stripping, manual redirects | Network egress policy and trusted DNS/TLS edge |
| Worker split brain | Expired worker completes after reassignment | Authenticated leases, monotonic fences, idempotent durable operations | Highly available backing store and supervisor integration |
| Backup tampering | Ciphertext/manifest alteration, restore wrong copy | AES-GCM envelope, manifest HMAC/AAD, digest/integrity checks, explicit confirmation | Separate key custody, off-host replication, retention |
| Supply-chain compromise | Mutable CI action, leaked npm token, package includes local state | Commit-pinned actions, least privilege, OIDC trusted publishing, attestation, package allowlist, zero dependencies | GitHub/npm account security and protected release environment |
| Denial of service | Oversized request/CBOR/artifact, scrypt exhaustion, failing upstream | Byte/count/time bounds, CBOR depth/collection limits, password queue, circuits, leases/retries | Edge rate limits, quotas, autoscaling, capacity planning |

## Explicit assumptions

- The operating-system administrator and master-key holder are trusted.
- The process runner executes trusted applications. Use Docker or stronger isolation for mutually untrusted deployers.
- TLS termination, certificate issuance, DDoS protection, WAF rules, and public network policy are external to the core package.
- An application process can read its own decrypted environment and database.
- SQLite is a strong single-node transactional default, not a globally replicated database.
- External drivers are trusted only to the authority represented by their narrowly scoped token and endpoint.

## Review triggers

Repeat this threat review when adding a credential type, raw HTML path, file parser, public protocol, proxy rule, external provider, database engine, runner, multi-node coordinator, privileged role, destructive action, or release channel.
