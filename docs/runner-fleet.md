# Deployment runner fleet

Clank can expose a closed, authenticated coordinator for deployment runners. The control-plane
administrator can enroll named nodes, inspect heartbeat and capacity, drain them before
maintenance, reactivate them, or revoke their credentials from `/admin`.

This is a fleet-control foundation, not automatic remote application placement. In the current
release, ordinary hosted projects still run under the built-in supervisor on the control-plane
host. Enrollment alone does not grant project secrets, SQLite databases, ingress traffic, backups,
or rollback data. A separate exact-lease runtime-capsule protocol can carry application placement
inputs to a trusted provider, but the built-in platform keeps it unselected until the complete
data, backup/restore, rollback, and ingress lifecycle is implemented. See
[Remote runtime placement](runtime-placement.md).

## Enable the coordinator

The default remains closed and costs nothing:

```sh
CLANK_RUNNER_COORDINATOR=0
```

Set the explicit switch on a self-hosted installation that is ready to operate runner nodes:

```sh
CLANK_RUNNER_COORDINATOR=1
```

This opens only the versioned `/api/runner/v1` coordinator routes. It does not create another
service, VM, volume, database, bucket, or Railway resource. It also retains an additional exact
compressed upload for each new release so an authorized operation can fetch it later. That copy is
included in project release quotas.

After restarting, sign in with an address in `CLANK_PLATFORM_ADMIN_EMAILS` and open `/admin`.
The **Deployment runner fleet** panel reports whether the coordinator is enabled. Platform fleet
administration is browser-session-only, CSRF-protected, unavailable during support impersonation,
and never accepts CLI, project, application, or MCP bearer tokens.

## Enroll one node

In the fleet panel:

1. Enter the exact node ID and region the runner will advertise.
2. Choose a 15-minute, 1-hour, or 24-hour lifetime.
3. Create the enrollment and copy the `clnke_...` value immediately.

The plaintext value is returned once. Clank stores only its SHA-256 digest. It is bound to the
exact node ID and region, expires automatically, is transactionally reserved during registration,
and can be consumed once. A malformed registration rolls the reservation back; concurrent
redemption has one winner; a completed token cannot be replayed. Creation, consumption, revocation,
draining, activation, and node revocation are audited without recording either the enrollment or
node credential.

Configure the target host:

```sh
export CLANK_CONTROL_URL=https://clank.example.com
export CLANK_RUNNER_NODE_ID=runner-us-central-01
export CLANK_RUNNER_REGION=us-central
export CLANK_RUNNER_REGISTRATION_TOKEN='clnke_value-copied-once'
export CLANK_RUNNER_CREDENTIALS=/var/lib/clank-runner/credentials.json

export CLANK_PROVIDER_URL=https://runtime.internal.example
export CLANK_PROVIDER_TOKEN='separate-provider-bridge-secret'

clank-runner
```

Before starting the long-running process, validate the environment without consuming a fresh
enrollment:

```sh
clank-runner --check
clank-runner --check --json
```

When a saved node credential exists, the check authenticates it with the coordinator. On a first
start it validates the local configuration and reports that enrollment is ready without redeeming
the one-time token. The provider bridge has no generic health call, so the check validates its URL
and token shape but does not issue a reconciliation. Neither secret is printed.

`clank-runner` exchanges the enrollment for a separate `clnka_...` node credential and writes it
atomically to an owner-only `0600` file. Remove `CLANK_RUNNER_REGISTRATION_TOKEN` from the
long-running service after the first successful start. Normal restarts use the saved node
credential. Keep the credentials path on a private persistent disk and use one file per runner
process.

The provider bridge token is a different secret with a different authority. Never reuse the
platform master key, browser session, CLI token, project token, application secret, enrollment
token, or node credential.

## Operate and upgrade nodes

The fleet panel shows:

- active, draining, and offline nodes;
- advertised region, capacity, and labels;
- last heartbeat and current credential lease;
- assigned placement count; and
- queued, leased, retrying, and failed coordination operations.

To upgrade a runner:

1. Select **Drain**. The node stops receiving new placement or claims but keeps its existing
   placement record.
2. Let current leased work finish or expire.
3. Stop and upgrade the process.
4. Start it with the same credentials file.
5. Select **Reactivate** if the process did not reactivate itself.

**Revoke** rotates the stored credential digest immediately, marks the node offline, and
reassigns eligible desired placement. The old runner can no longer authenticate, renew, complete,
or observe work. A leased operation stays fenced until its lease expires, then becomes retryable on
the replacement node with a higher fence. To reuse a revoked node ID, create and consume a new
one-time enrollment.

Draining is graceful maintenance; revocation is credential invalidation. Do not use revocation as
the normal shutdown path.

## Legacy shared enrollment

`CLANK_RUNNER_REGISTRATION_TOKEN` on the control plane remains supported for compatibility and
also enables the coordinator when `CLANK_RUNNER_COORDINATOR` is unset. It is a shared,
non-expiring credential that can rotate any named node and therefore has more authority and more
operational risk than an administrator-created one-time enrollment.

Prefer managed enrollment for new installations. If legacy automation still needs the shared
secret, store it in an operator secret manager, rate-limit the enrollment path at the edge, and
rotate it after provisioning-system exposure. Never place it in repository files, command history,
URLs, logs, application configuration, or the runner credential file.

## Cost and topology guidance

Keep the coordinator disabled for a cheap one-service deployment. Enabling it does not make the
current process runner safe for mutually untrusted public users and does not improve isolation by
itself. Provision an additional runner host and optional object storage only when the placement
phase and provider adapter need them.

On the current Railway single-service profile, leave `CLANK_RUNNER_COORDINATOR` unset and do not add
a service or bucket. A future runner can be another small service on a private network; an
S3-compatible artifact store is optional and should be added only when artifacts must survive
outside the control-plane volume.

For the underlying authentication, leases, artifacts, fencing, and agent loop, see
[Durable distributed deployment](distributed-deployment.md). For the infrastructure mutation
boundary and HTTP bridge, see [Deployment provider adapters](provider-adapters.md). For the
generation-bound private traffic hop, see [Provider runtime
ingress](provider-runtime-ingress.md).
