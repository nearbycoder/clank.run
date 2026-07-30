# Public beta readiness

Clank's public beta is suitable for controlled self-hosted evaluation once every gate below passes. “Beta” means the contracts are usable and tested, while operators should expect upgrade work and should not place irreplaceable or highly regulated workloads on the platform without an independent review.

## Go/no-go gate

- `npm run check` passes from a clean clone on Node 22.16 and Node 24.
- GitHub CI and CodeQL pass with no accepted critical or high-severity finding.
- The release tag exactly matches `package.json`; the tarball is attested and published through npm OIDC.
- Private vulnerability reporting, branch protection, secret scanning, and protected release environments are enabled.
- Browser signup/login, verification/recovery/MFA/passkey policy, CLI device login, organization RBAC, scoped token, deploy, domain, backup, rollback, and two-browser live sync are smoke-tested.
- Production TLS, allowed hosts, proxy trust, CSP, rate limits, telemetry export, alerting, quotas, and runner isolation are configured.
- A recent encrypted off-host backup has been restored into a clean environment.
- An incident owner, status channel, rollback decision maker, and security contact are named.

Any known cross-tenant access, authentication bypass, remote code execution across the documented runner boundary, secret disclosure, unrecoverable data loss, stale fenced commit, or release-provenance failure is a no-go.

## Known beta limitations

- The explicit `trusted` profile runs deployed application code as the platform Unix user and
  refuses public signup. Production defaults to the `isolated` Docker profile, but public
  multi-tenancy still preferably uses dedicated VMs or microVMs.
- Distributed leases, desired state, worker authentication, durable operations, fencing, and the
  provider-neutral remote-agent lifecycle are implemented, but the built-in process supervisor is
  not a turnkey multi-region HA control plane. Operate one active supervisor per project/data
  directory until leader election and an infrastructure execution adapter are deployed.
- The optional remote-node HTTP transport removes direct control-database access from deployment
  agents, and the generic loop handles credentials, heartbeat, claims, renewal, settlement, and
  drain. Current leases can retrieve a verified content-addressed release, and the portable
  provider contract plus authenticated HTTP bridge strip coordinator credentials and standardize
  fenced runtime reconciliation. An opt-in runtime capsule can bind final application secrets,
  SQLite placement, and ingress identity to an exact desired project/release/generation without
  putting those values in operation metadata or headers. The built-in supervisor does not yet
  delegate release activation through it. A package-supported provider lifecycle now covers
  immutable staging, SQLite snapshot/restore/delete, migrations, one-generation rollback, fences,
  and crash journals. Remote execution still needs provider-side Docker/VM/microVM launch, node
  pinning, independent backup replication, and atomic edge activation before the platform can
  safely select that protocol.
- The control-plane catalog uses SQLite. It supports durable coordination on one shared transactional store, not globally distributed consensus.
- Built-in application data and live queries are SQLite-first. The external PostgreSQL driver/provisioner is available, but generated backend tables do not transparently switch engines.
- Managed ingress performs exact-host HTTP proxying, automatically reconciles customer DNS routing with durable bounded leases, and supplies a restricted Caddy certificate-permission lookup. It does not itself issue or store certificates, change customer DNS, provide a WAF/DDoS edge, or proxy WebSocket upgrades. Put it behind the documented production edge.
- Managed ingress enforces durable workspace-month request/known-transfer and project-minute
  request limits, but known transfer excludes streamed or undeclared response bytes and direct
  application ports bypass it. Keep ports private and retain edge connection, body, response,
  WAF, and DDoS controls.
- Local file and email drivers are development/reference implementations. Configure durable object storage and a production email provider for hosted workloads.
- Verified encrypted backups run automatically every 24 hours by default and coordinate through
  durable leases. Repositories are local by default; operators can select the built-in
  S3-compatible chunked repository for an independent failure domain. The control database and
  encryption key must still be backed up separately.
- Release files and pre-deploy snapshots are locally retained behind enforced per-project count/byte ceilings. Pre-upgrade releases begin with upload-byte accounting; clean or redeploy old artifacts when exact extracted-size accounting is required.
- Permanent site deletion removes platform-managed local project state, object-backed recovery
  points, remote runner artifacts, and its quota, slug, port, and domains. It does not discover or
  erase external databases, manual/provider-retained copies, or edge certificate storage.
  Operators need a cross-system retention and erasure runbook.
- Generated apps compile and serve Tailwind CSS in production. The browser build remains only in
  standalone visual examples that are explicitly development-only.
- Passkey support accepts `none` attestation and does not perform enterprise authenticator attestation policy.
- Application-specific authorization, privacy, retention, moderation, payments, regulatory compliance, and abuse prevention are not inferred by the framework.

## Suggested beta operating targets

These are targets to validate in the chosen topology, not guarantees from the package:

- recovery point objective: no more than the configured backup interval;
- recovery time objective: demonstrated by a clean restore drill;
- deploy rollback: prior healthy release restored automatically after candidate failure;
- control-plane availability: measured at storage-backed `/healthz` or `/readyz`; use `/livez` only for process liveness;
- app availability: measured through the public host and representative authenticated transaction;
- security response: acknowledge complete private reports within three business days.

## Rollout

1. Start with maintainers and synthetic applications.
2. Add a small invited cohort with per-project quotas and the `isolated` Docker profile.
3. Review incidents, failed deploys, restore drills, support load, and security findings weekly.
4. Expand only when restore time, deployment success, auth failure rates, and isolation evidence remain inside the published operating targets.
5. Preserve an immediate rollback path for framework, control-plane, schema, and edge changes.
