# Automatic supervisor leadership

Dedicated Linux coordinators can share one private Clank catalog. A current leader runs the supervisor; standbys recover retained desired state after verified cleanup.

Opt into automatic leadership in dedicated coordinator processes on the same host. One current owner runs the built-in supervisor duties. The others wait and return `503` with `Retry-After` until an owner is ready. When the leader dies or stops responding, an independent guardian terminates its coordinator, and a standby recovers the retained desired state after previous runtime cleanup is proved.

This topology uses native SQLite transactions and Linux process identity. Keep the catalog, project data, guardian files and master key on the same durable local filesystem with normal SQLite locking and atomic rename. Every coordinator must use the same Unix account, canonical data directory, framework version, operator configuration and secret sources. Run each in its own process. Changing a configuration object after opening the platform does not change the captured ordinary configuration used for later takeover.

The first implementation covers one host and one transactional control store. Network filesystems, separate hosts and multi-region consensus require a different coordination protocol. Existing process, Docker and provider isolation/admission rules still apply; leadership does not certify a deployment host or make application code trusted.

## Start a coordinator

Programmatic operators can use the public platform entry point:

```ts
import { openPlatform } from "@clank.run/framework/platform";

const platform = await openPlatform({
  dataDirectory: "/var/lib/clank",
  publicUrl: "https://deploy.example.com",
  hostingProfile: "trusted",
  sqliteIsolation: "trusted-process",
  signup: "bootstrap",
  appPortStart: 4300,
  appPortEnd: 4999,
  supervisor: {
    configurationId: "production-coordinators",
    configurationRevision: 1,
    leaseMs: 15_000,
    pollIntervalMs: 500,
  },
});

const status = platform.supervisor?.();
console.log(status?.state, status?.epoch);
// Bind platform.handle through the usual HTTP adapter.
```

The trusted example is for trusted deployers with closed public signup. Use the existing isolated hosting configuration for mutually untrusted applications. A dedicated coordinator can be killed when it loses authority, so it must not also host unrelated application work in its process.

For the packaged `clank-platform` command, set these environment variables consistently on every coordinator:

| Variable | Required or default | Meaning |
| --- | --- | --- |
| `CLANK_SUPERVISOR_ID` | Required to enable | Operator-selected configuration identity, 1–128 ASCII letters/digits/periods/underscores/hyphens, starting with a letter |
| `CLANK_SUPERVISOR_REVISION` | Required | Positive safe integer; increase for a reviewed configuration change |
| `CLANK_SUPERVISOR_LEASE_MS` | `15000` | Ownership duration, 5000–120000 ms |
| `CLANK_SUPERVISOR_POLL_MS` | `500` | Standby checks and renewal cadence, 50 ms through one third of the lease |

Settings require positive decimal integers. Partial configuration, unsupported bounds and a changed identity or timing at the same revision are refused. Omit all four variables to keep the ordinary single-supervisor topology for a catalog that has never enabled leadership.

Coordinators need separate HTTP listener ports behind a proxy using the same public origin. Choose a common application port range that excludes every coordinator listener. The proxy can retry another coordinator after a standby `503`; it must preserve the existing origin, cookie, CSRF, host and authorization rules. A browser or agent should retry an ambiguous mutation using that API's retained idempotency key and exact original input.

## Current authority and recovery

The catalog retains an increasing ownership epoch, a private owner/token hash, the exact Linux PID and process birth, and lease timestamps. A released lease retains its epoch. An expired capability cannot renew itself or become current again. A higher configuration revision fences older coordinators; ordinary configurations and adapter implementations must be kept compatible by the operator. The identity is an explicit deployment contract, not an automatic hash of callback closures or external service state.

An unowned standby that encounters native SQLite catalog contention keeps waiting for its next poll; it creates no epoch and runs no supervisor duties. Other catalog errors remain visible. An existing owner still fails when contention prevents verifying or renewing its authority, so retrying standby admission cannot extend an unchecked lease.

Only a current owner opens the active platform core. This includes startup recovery, tenant runtimes, domain reconciliation, preview cleanup, idle sweeps, release windows, scheduled backups, invitation delivery, audit exports, retention and operations monitoring. These duties share the supervisor epoch and keep their existing project, job, generation and delivery leases. Takeover does not erase a durable task claim, reset a retry counter or silently approve an interrupted promotion.

Native catalog writes check current ownership inside the SQLite write transaction before work and again before commit. Losing authority rolls back data and associated revision/history changes. Runtime launch and request completion also check current ownership. Cached native SQL statements cannot bypass the transaction guard.

Each owner arms an independent guardian through private IPC before active bootstrap. The guardian checks the actual coordinator's birth identity and current lease. It can terminate its own coordinator after lease loss, `SIGSTOP`, lost IPC or guardian failure. A standby waits for actual prior coordinator death and the existing tenant guardian cleanup before admitting replacement writers. A failed or malformed cleanup record keeps admission closed and remains available for operator investigation.

Recovery time includes the ownership lease, cleanup budget, retained project/task lease and application health check. Blocking startup recovers desired local applications before the coordinator becomes ready; `startupRecovery: "background"` keeps the existing asynchronous recovery behavior. A suspended project stays suspended. Existing scheduled work resumes when its current durable claims permit it.

External mail, object storage and provider effects retain their documented idempotency and generation contracts. The SQLite fence does not turn an external request into a distributed transaction. Preserve the original operation key after a lost response and verify the retained receipt before submitting different input.

## Inspect and close

`PlatformRuntime.supervisor()` returns readonly `state`, `epoch`, `expiresAt` and the fixed responsibility names. It exposes no token, process-cleanup capability or renewal method. The local states are `standby`, `starting`, `leader`, `closing`, `closed` and `fenced`. Owned status reads validate current authority; a stale configuration or unsupported persisted protocol fails closed. This status is local operator metadata and is not a browser authentication claim.

The packaged command prints its initial supervisor state. `platform.close()` stops active duties and tenant workers while renewing current ownership, finishes the guardian handshake, and then releases the lease. A superseded standby can close its observer without releasing the newer owner's lease. Shutdown errors that leave active cleanup unresolved fence the dedicated process.

## Upgrade and rollback

Before first enabling leadership, quiesce every legacy coordinator and verify tenant cleanup. Upgrade them all to the same framework version, preserve the catalog and master key, then start the configured processes. The topology marker rejects accidental ordinary-mode startup in upgraded binaries. Already-running legacy binaries cannot be fenced by a protocol they do not implement.

For a configuration change, deploy compatible settings with a higher revision. This intentionally fences older owners. Keep callbacks, native adapters, secret sources and all effectful options consistent; registered adapter/class instances retain their identity and are not deep-copied. Preserve unknown protocol and exhausted-epoch records for operator recovery rather than resetting them.

For rollback to ordinary mode, stop every coordinator and tenant runtime, back up the catalog and guardian evidence, and review an explicit recovery procedure before changing the topology marker. Removing a row while writers run is unsafe. There is no automatic downgrade or epoch-reset endpoint.

Native process tests exercise stopped/killed leaders, guardian death, configuration replacement, death during actual application health recovery, retained tenant data, job-writer cleanup, one due encrypted backup, CLI takeover, ordinary-mode refusal and unresolved cleanup. Host-specific Docker/provider certification remains governed by the separate deployment admission contracts.
