# ASVS-oriented verification

Clank uses [OWASP ASVS 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) as a control vocabulary for the framework, generated applications, CLI, and deployment platform. This is an engineering evidence map, not an OWASP certification and not a claim that every application built with Clank automatically satisfies ASVS.

The current target is an ASVS Level 2 posture for Clank-owned internet-facing surfaces. Application-specific business authorization, privacy, content policy, provider configuration, and infrastructure remain the deployer's responsibility.

## Release evidence

| Control area | Clank control | Automated evidence | Operator or application evidence |
| --- | --- | --- | --- |
| Encoding and injection | Escaped SSR/DOM output, executable-URL rejection, parameterized SQLite access, restricted migration SQL, shell-free build commands | DOM, SSR, migration, compiler, and security-audit tests | Review every use of raw HTML and external SQL |
| Validation and business logic | Runtime schemas, exact input objects, bounded bodies/files/artifacts, immutable migration checksums, confirmed destructive actions | Schema, forms, backend, deployment, conformance, and fuzz-oriented tests | Define domain rules and authorization for every action |
| Web frontend security | CSP nonce support, safe state serialization, typed events, no inline handler strings | SSR, DOM, server, and strict type tests | Deploy a restrictive CSP and compiled production CSS |
| API and web services | Content-type enforcement, UTF-8/JSON limits, same-origin checks, generic 500 responses, scoped tokens | Security, backend, auth, platform, and conformance tests | Configure allowed hosts, TLS, proxy trust, quotas, and edge limits |
| File handling | Containment and realpath checks, dotfile denial, symlink rejection, bounded file store, signed capabilities | Node, deploy, services, and conformance tests | Add malware/content scanning for domain-specific uploads |
| Authentication | Scrypt passwords, generic failures, session expiry/idle expiry, verification, recovery, MFA, WebAuthn passkeys | Auth and WebAuthn tests | Configure email delivery, pepper/KMS, bot defense, and recovery policy |
| Session management | Hashed tokens, `HttpOnly`/`Secure`/`SameSite` cookies, CSRF, revocation, session-aware live streams | Auth, backend, platform, and conformance tests | Use TLS everywhere and shared revocation/rate-limit stores when scaled |
| Authorization | Required server functions, owned tables, organization RBAC, project-scoped permissions, re-check on every request | Backend, auth, and platform isolation tests | Add resource and business-state authorization inside each app |
| Tokens and secrets | High-entropy bearer tokens, hashes at rest, AES-256-GCM platform secrets, redacted structured logs | Platform, observability, services, and security-audit tests | Use external secret management, rotation, least privilege, and access review |
| Cryptography | Node cryptographic randomness, scrypt, SHA-256, HMAC, AES-256-GCM, WebAuthn signature verification | Auth, WebAuthn, recovery, deploy, and service tests | Configure approved TLS and managed key lifecycle |
| Secure communication | HTTPS-only external service drivers, exact ingress hosts, hop-header stripping, bounded proxying | Data-plane and chaos tests | Supply TLS termination, certificate automation, HSTS, WAF, and egress policy |
| Configuration | Private umask, safe defaults, explicit unsafe-migration escape hatch, immutable CI actions | Platform, deployment, security audit, CI, and CodeQL | Harden OS/container, pin images, and separate control/data authority |
| Data protection | Per-app database paths, owner-scoped documents, encrypted backups, authenticated manifests | Backend, recovery, platform, conformance, and chaos tests | Define retention, residency, deletion, classification, and off-host copies |
| Logging and error handling | Structured redacted logs, traces, metrics, health checks, bounded stored logs, generic public failures | Observability, platform, auth, and server tests | Export, alert, retain, and protect telemetry |
| Secure coding and architecture | Zero runtime dependencies, strict public types, deterministic artifacts, signed release provenance | Build, package-consumer, conformance, security audit, CodeQL | Review changes to trust boundaries and third-party service code |

## Automated gate

Run:

```sh
npm run check
```

That command builds from source, verifies the dependency contract, runs the complete test suite including chaos scenarios, exercises a packed release through the conformance lifecycle, inspects the npm allowlist for state/credential leaks, and checks immutable least-privilege GitHub workflows.

The audit fails closed when a dependency appears, a workflow action is not pinned to a commit, a sensitive file enters the package, a high-confidence credential pattern is found, or required security evidence is missing.

## Manual verification required before a public release

- Review the [threat model](threat-model.md) for every changed boundary.
- Triage CodeQL and all vulnerability reports; ship with no known critical or high-severity issue.
- Exercise the [chaos drills](chaos-testing.md) in the intended deployment topology.
- Restore a recent off-host backup into a clean environment.
- Verify TLS, cookies, CSP, host validation, rate limiting, alerting, and runner isolation against production configuration.
- Review organization roles, project tokens, secrets, audit records, and operator access.
- Record accepted residual risks and an owner/date for each one.

## Framework versus application responsibility

Clank can make safe mechanics concise, but it cannot infer whether a particular user may approve an invoice, view a medical record, refund a payment, or invite an administrator. Generated actions must still name their authorization and confirmation policy. Regulations, privacy notices, data retention, abuse response, and business continuity are deployment-specific.
