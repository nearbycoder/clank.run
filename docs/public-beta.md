# Public beta readiness

Clank's public beta is suitable for controlled self-hosted evaluation once every gate below passes. “Beta” means the contracts are usable and tested, while operators should expect upgrade work and should not place irreplaceable or highly regulated workloads on the platform without an independent review.

## Go/no-go gate

- `npm run check` passes from a clean clone on Node 22.13 and Node 24.
- GitHub CI and CodeQL pass with no accepted critical or high-severity finding.
- The release tag exactly matches `package.json`; the tarball is attested and published through npm OIDC.
- Private vulnerability reporting, branch protection, secret scanning, and protected release environments are enabled.
- Browser signup/login, verification/recovery/MFA/passkey policy, CLI device login, organization RBAC, scoped token, deploy, domain, backup, rollback, and two-browser live sync are smoke-tested.
- Production TLS, allowed hosts, proxy trust, CSP, rate limits, telemetry export, alerting, quotas, and runner isolation are configured.
- A recent encrypted off-host backup has been restored into a clean environment.
- An incident owner, status channel, rollback decision maker, and security contact are named.

Any known cross-tenant access, authentication bypass, remote code execution across the documented runner boundary, secret disclosure, unrecoverable data loss, stale fenced commit, or release-provenance failure is a no-go.

## Known beta limitations

- Process mode trusts deployed application code as the platform Unix user. Public multi-tenancy requires Docker at minimum and preferably dedicated VMs or microVMs.
- Distributed leases, desired state, worker authentication, durable operations, and fencing are implemented, but the built-in process supervisor is not a turnkey multi-region HA control plane. Operate one active supervisor per project/data directory until leader election and remote runner integration are deployed.
- The control-plane catalog uses SQLite. It supports durable coordination on one shared transactional store, not globally distributed consensus.
- Built-in application data and live queries are SQLite-first. The external PostgreSQL driver/provisioner is available, but generated backend tables do not transparently switch engines.
- Managed ingress performs exact-host HTTP proxying but does not issue TLS certificates, configure DNS, provide a WAF/DDoS edge, or proxy WebSocket upgrades. Put it behind a production edge.
- Local file and email drivers are development/reference implementations. Configure durable object storage and a production email provider for hosted workloads.
- Backup repositories are local unless the operator replicates them. The encryption key must be backed up separately.
- Tailwind's browser build is for development; production apps should compile and serve CSS.
- Passkey support accepts `none` attestation and does not perform enterprise authenticator attestation policy.
- Application-specific authorization, privacy, retention, moderation, payments, regulatory compliance, and abuse prevention are not inferred by the framework.

## Suggested beta operating targets

These are targets to validate in the chosen topology, not guarantees from the package:

- recovery point objective: no more than the configured backup interval;
- recovery time objective: demonstrated by a clean restore drill;
- deploy rollback: prior healthy release restored automatically after candidate failure;
- control-plane availability: measured at `/healthz`;
- app availability: measured through the public host and representative authenticated transaction;
- security response: acknowledge complete private reports within three business days.

## Rollout

1. Start with maintainers and synthetic applications.
2. Add a small invited cohort with per-project quotas and Docker isolation.
3. Review incidents, failed deploys, restore drills, support load, and security findings weekly.
4. Expand only when restore time, deployment success, auth failure rates, and isolation evidence remain inside the published operating targets.
5. Preserve an immediate rollback path for framework, control-plane, schema, and edge changes.
