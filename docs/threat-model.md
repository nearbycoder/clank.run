# Threat model

This model covers the Clank framework, generated authenticated applications, CLI, control plane, deployment artifact path, managed ingress, service drivers, and backup system.

## Assets

- account credentials, sessions, passkeys, recovery tokens, agent OAuth grants, and CLI tokens;
- organization membership, project permissions, audit history, and deployment authority;
- application source/artifacts, migrations, secrets, databases, files, email, jobs, and webhooks;
- control-plane master keys, encrypted backups, release history, and signing/provenance data;
- availability and integrity of active application processes and routes.

## Principals

- anonymous browser or agent;
- authenticated application user;
- registered public MCP client acting through a user-approved, scoped OAuth grant;
- organization owner, admin, developer, or viewer;
- allowlisted control-plane platform administrator;
- browser account approving a CLI device;
- account-wide or project-scoped CLI token;
- deployment control-plane process;
- authenticated deployment worker;
- deployed application process/container;
- machine, container, database, DNS, email, object-storage, and TLS operators.

## Trust boundaries

1. Browser/agent to application HTTP, MCP, OAuth, and live-stream APIs.
2. Browser to auth, recovery, MFA, and passkey ceremonies.
3. CLI to browser-approved device flow and control-plane bearer API.
4. Artifact bytes to extraction, migration, candidate startup, and activation.
5. Control plane to application process/container and project filesystem.
6. Managed ingress to host routing and application upstream.
7. Framework to external email, file, job, webhook, database, and provisioning providers.
8. Live database to encrypted backup repository and restore target.
9. Git source to CI, attestation, GitHub release, and npm publication.
10. Trusted application source through the TSX compiler to generated executable modules.

## Primary abuse cases

| Threat | Representative attack | Principal controls | Residual responsibility |
| --- | --- | --- | --- |
| Account takeover | Credential stuffing, reset replay, stolen session, cloned authenticator | Scrypt, generic login errors, shared HMAC-keyed control-plane rate limits, single-use recovery, MFA, WebAuthn verification/counters, revocation | Upstream abuse controls, bot defense, email security, user/device risk policy |
| Cross-site action | CSRF, forged Origin, cross-site device approval | Strict cookies, CSRF token, Fetch Metadata/origin checks | Correct proxy scheme/host configuration and CSP |
| Agent credential abuse | Malicious dynamic client, authorization-code interception, refresh replay, token confused with another API or tenant | Exact HTTPS/loopback redirects, PKCE S256, explicit consent, resource indicators and audience checks, short access lifetime, hashed tokens, refresh rotation/family revocation, read/write scopes, MCP-only bearer resolution | User review of client/scopes, endpoint TLS, agent-host security, edge registration limits, and future grant-management UI |
| Agent action abuse | Prompt injection or compromised client invokes hidden/destructive tools, guesses a write tool with a read token, or submits adversarial arguments | Authenticated tool discovery, mutation scope enforcement before dispatch, `agent: false`, destructive annotations, shared runtime schemas/authorization/ownership/transactions, bounded messages, generic failures | Domain authorization and confirmation inside handlers; annotations guide clients but are not security controls |
| Tenant escape | Guess project/user IDs, reuse scoped token, stale membership | Owned SQL, membership/role checks, project/scope checks on every request, revocation | Domain-specific row/resource authorization |
| Privilege escalation | Admin grants excess scopes, removes last owner, uses viewer token to deploy | Role matrix, scope intersection, last-owner protection, audit | Periodic access review and separation of duties |
| Platform-admin abuse | Workspace admin assumes global authority, stolen CLI token lists tenants, stale allowlist retains access | Separate operator role, exact startup reconciliation, browser-only global APIs, same-origin sessions, bounded redacted directory | Protect operator email accounts, require strong authenticators, review the allowlist and global audit trail |
| Impersonation abuse | Operator silently edits tenant data, targets another operator, replays a support token, or denies accessing an account | Recent-auth and CSRF gate, exact target confirmation, required reason, admin/self/disabled-target denial, hashed 15-minute session-bound capability, safe-method-only effective identity, visible banner, real-actor start/stop audit | Limit the operator allowlist, alert on support sessions, require ticket-linked reasons and customer approval where policy or law requires it |
| Invitation replay or disclosure | Reuse a superseded token, create an uninvited account while signup is closed, scrape pending addresses or audit metadata, flood active invitations | Hashed email-bound single-use account-creation capability, pre-hash origin check, transactional consume/membership, failed-account cleanup, atomic replacement/revocation, administrator-only pending metadata, developer audit redaction, 100-active cap, audit | Deliver tokens through a trusted channel and protect invited mailboxes |
| Artifact compromise | Traversal, symlink, decompression bomb, digest swap, malicious install hook | Bounded deterministic bundle, path/type/mode validation, SHA-256 verification, no remote install/build hooks | Review trusted source and isolate runtime execution |
| Migration/data loss | Edited history, unsafe SQL, failed migration, destructive rollback | Immutable ledger, restricted SQL, quiesced backup, transactional apply, safety restore, confirmation | Schema review, off-host backups, restore drills |
| Secret disclosure | API response/log leak, filesystem exposure, package publication | AES-GCM, no secret reads, recursive log redaction, private umask, npm package audit | KMS, rotation, OS/operator access, provider logging |
| SSRF/proxy confusion | Attacker-chosen upstream, scheme-relative path, duplicate host, hop-header smuggling | Loopback/allowlist upstreams, target origin assigned before path, exact unique hosts, `Connection`-nominated header stripping, manual redirects | Network egress policy and trusted DNS/TLS edge |
| Domain/certificate takeover | Reassign pending hostname, spoof TXT, route elsewhere, trigger certificates for arbitrary SNI | Exact random TXT proof, immutable cross-project assignment, separate routing state, reserved namespaces, indexed TLS allow check restricted to deployed sites | Private edge link, CAA/ACME policy, certificate storage and CA monitoring |
| Worker split brain | Expired worker completes after reassignment | Authenticated leases, monotonic fences, idempotent durable operations | Highly available backing store and supervisor integration |
| Backup tampering or omission | Ciphertext/manifest alteration, duplicate schedulers, missed recovery point, restore wrong copy | AES-GCM envelope, manifest HMAC/AAD, digest/integrity checks, durable leased scheduling, bounded retention, explicit confirmation | Monitoring, separate key custody, off-host replication, restore drills |
| Destructive project action | Stolen scoped token, developer error, path substitution, partial site deletion | Owner/admin account principal, scoped-token denial, CSRF, exact slug confirmation, separate data-loss acknowledgement, durable lock, derived symlink-safe paths, token revocation, retained audit event | Account-token protection, off-platform copy deletion, legal retention policy, deletion drills |
| Audit repudiation or tenant disclosure | Hide a destructive event, read another workspace, reuse stale elevated scope | Non-cascading organization attribution, current membership/role joins, project-token intersection, bounded cursor pagination, no audit mutation API, deleted-target retention | Trusted SQLite admins can alter local rows; replicate or sign events independently when operator tampering is in scope |
| Supply-chain compromise | Mutable CI action, leaked npm token, package includes local state | Commit-pinned actions, least privilege, OIDC trusted publishing, attestation, package allowlist, zero dependencies | GitHub/npm account security and protected release environment |
| Compiler boundary confusion | Treat attacker-controlled data as TSX source or assume generated code is sandboxed | Compiler accepts project source only, performs no build-time evaluation, and emits reviewable modules | Never compile request/database values; isolate mutually untrusted app execution |
| Denial of service | Chunked oversized request, CBOR/artifact bomb, repeated retained releases, scrypt/device-code exhaustion, high-cardinality limiter keys, failing upstream, unbounded metric labels, site/domain exhaustion | Streaming byte/count/time bounds, CBOR depth/collection limits, per-project artifact count/byte ceilings, password queue, bounded durable rate-limit state, circuits, transactional quotas, fixed-cardinality metrics, leases/retries | Edge rate limits, whole-volume monitoring, compute quotas, autoscaling, capacity planning |

## Explicit assumptions

- The operating-system administrator and master-key holder are trusted.
- The process runner executes trusted applications. Use Docker or stronger isolation for mutually untrusted deployers.
- TypeScript and TSX files are trusted executable application source. The compiler is not a sanitizer for attacker-controlled data.
- OAuth authenticates the approving user and client grant; it does not make model-generated tool arguments trustworthy.
- TLS termination, certificate/key custody, ACME issuer policy, DDoS protection, WAF rules, and public network policy are external to the core package. Clank only decides hostname eligibility.
- An application process can read its own decrypted environment and database.
- SQLite is a strong single-node transactional default, not a globally replicated database.
- External drivers are trusted only to the authority represented by their narrowly scoped token and endpoint.

## Review triggers

Repeat this threat review when adding a credential type, raw HTML path, file parser, public protocol, proxy rule, external provider, database engine, runner, multi-node coordinator, privileged role, destructive action, or release channel.
