# Local provider fleet simulator

Use `@clank.run/framework/fleet-simulator` to reproduce a fixed failure against an actual
local coordinator, two Docker providers and two deployment agents. Each runs in its own OS
process; transport uses authenticated loopback HTTP. This optional module adds no dependency
and is not imported by the browser entry point.

Run drills only on an explicitly disposable Linux host with its own local Docker daemon and
dedicated XFS project-quota mount. First obtain a current [Linux host certificate](linux-host-certification.md)
for the selected immutable image, non-root container identity, resources, quota and outbound
policy. The caller must run with both real and effective UID 0. Admission requires more than
five minutes of certificate validity; the final result also checks expiry. Changing the
framework installation or selected policy invalidates the certificate.

## Run a scenario

```ts
import {
  runLocalProviderFleetScenario,
  exportLocalProviderFleetScenario,
} from "@clank.run/framework/fleet-simulator";

const scenario = {
  protocol: "clank-fleet-scenario/1",
  kind: "lease-loss",
} as const;

console.log(exportLocalProviderFleetScenario(scenario));
const report = await runLocalProviderFleetScenario({
  certificate: { directory: "/operator/certification", profile },
  scenario,
  disposable: true,
  quotaIds: [1201, 1202], // Reserve two unused IDs on this dedicated mount.
  portStart: 47000,       // Reserve ten unused application ports.
  signal: controller.signal,
});
if (report.status !== "passed") throw new Error(report.reason);
```

`profile` is the exact certified `LinuxHostCertificationProfile`; `controller` is an
application-owned `AbortController`. Neither is part of the portable scenario. The two quota
IDs must have zero existing byte/inode usage and limits. The API checks both before creating
scratch data; it never clears a preexisting reservation. Ports are local to the disposable
host. Existing port listeners cause ordinary provider activation to fail.

`parseLocalProviderFleetScenario(unknown)` validates plain static data and returns a frozen
normalized scenario. Unknown fields, getters, symbols, callbacks, unsupported faults and
unbounded values are rejected. Defaults and inclusive integer bounds are:

| Field | Default | Range |
| --- | --- | --- |
| `nodeTtlMs` | 5000 | 2000–30000 |
| `operationLeaseMs` | 3000 | 1000–30000 |
| `transportDelayMs` | 1500 | 200–10000 |

`exportLocalProviderFleetScenario(scenario)` emits deterministic versioned JSON containing
only these fields and the fault kind. It excludes paths, image policy, credentials and reports.
The API captures operator inputs before awaiting host admission. It supports one bounded run
at a time on a host and imposes a three-minute work deadline and bounded infrastructure calls.

## Faults and evidence

| Kind | Actual fault and required recovery |
| --- | --- |
| `takeover` | Kill the first agent with an outstanding claim, stop its owned provider, revoke its credentials, then let the second agent reclaim and execute with a higher fence. Old credentials must fail authentication, claim and observation. A separate stateful placement remains pinned to node A. |
| `lease-loss` | Delay real lease-renewal HTTP responses beyond the operation lease. Wait for actual store expiry, reject stale completion and artifact access, then execute a reclaimed higher fence. |
| `slow-transport` | Delay the real runtime-capsule HTTP response beyond the client deadline. Observe an actual transport timeout, restore transport and retry. |
| `disk-read-only` | Remount the first provider's dedicated bind mount read-only inside its private mount namespace. Prove `EROFS`, reject deployment state writes, preserve the previously serving generation, remount writable and recover. |
| `coordinator-restart` | Kill the coordinator and reopen its SQLite control store on the same listener. Preserve the prior desired generation and fence, then execute the next generation. |
| `provider-restart` | Kill the provider while its Docker runtime exists. Reopen the same owned roots, remove its orphan runtime through production cleanup, then activate the next generation with its committed database. |

Every passing drill serves the fixed synthetic application through production ingress before
and after recovery. It verifies the exact artifact digest, expected generation, synthetic row,
one committed migration, increasing fence and rejection of a stale provider request.
Coordinator and provider restarts use persistent stores. The read-only fault affects the
provider's own namespace; it does not remount the Docker daemon's host filesystem.

Provider workers run under the certified non-root application UID:GID, so storage ownership
matches the unmodified complete Docker provider service. The trusted provider processes retain
only `CAP_SYS_ADMIN`, `CAP_NET_ADMIN` and `CAP_DAC_OVERRIDE` for private bind mounts, quotas,
owned nftables rules and local Docker access. They clear supplementary groups, restrict their
capability bounding set and set `NoNewPrivs`. Startup verifies those identities and capabilities.
Application containers retain the production launcher's `cap-drop=ALL` and non-root user.
The provider's access to the Docker daemon remains a privileged host-control boundary.
`setpriv`, `mount` and `umount` are included in certificate host binding. See
[Docker provider runtime](provider-docker-runtime.md) for ordinary provider identity setup.

Portable takeover initializes the synthetic database on node B from the same immutable
artifact. It proves portable placement and credential/operation fencing. The separate stopped
stateful placement proves control-store pinning. These checks do not establish SQLite data
replication, promotion of a stateful database, or automatic supervisor leadership.

## CLI and reports

Save a mode-0600 JSON file owned by the invoking user with `certificate`, `scenario`, `quotaIds`
and `portStart`, then run:

```sh
clank-provider fleet --config /operator/private-fleet.json --disposable
```

The CLI accepts no arbitrary command or provider override. It rejects symlink configuration
files, non-private permissions and files over 16 KiB. It prints the immutable
`clank-fleet-report/1` result and exits 1 when blocked.

Reports contain seven checks (`host`, `processes`, `baseline`, `fault`, `recovery`, `fences`,
`cleanup`), the verified artifact digest when available, and at most 512 sequenced events.
Events expose only elapsed time, fixed node/event names, generation and fence. No tokens,
runtime capsules, database contents, operator paths or raw infrastructure errors are emitted.
Possible blocked reasons are `certification-required`, `aborted`, `scenario-failed` and
`cleanup-failed`. A partial recovery never counts as a passing scenario.

## Cleanup and interruption

Normal exit and cancellation stop agents before providers and the coordinator. Cleanup
verifies the exact owned containers, ownership-checked network resources, scratch files and
quota usage/limits. A passing report requires every check, including cleanup, to pass.

The root-owned `/run/clank-host-certification.attempt` marker excludes other fleet runs and
host-certification probes. Its private manifest records the process, boot, reserved quota IDs,
synthetic owner labels and, once created, the scratch root. Unconfirmed cleanup or a killed
parent leaves this marker in place and blocks certificate admission. Children also shut down
on IPC disconnection. Never treat a missing parent as proof that cleanup finished.

On this disposable host, inspect the marker and verify its boot/process identity. Check only
its recorded owners, network plans, scratch root and quota IDs using the production
ownership-checking helpers described in [Linux provider verification](linux-provider-isolation.md).
Remove the marker only after proving those exact resources are gone. Re-certify after any
host/framework change. Destroying the disposable guest is an alternative to manual recovery.
There is no automatic marker unlock or broad Docker/network cleanup command.

The source repository's manual `tests/fixtures/fleet-simulator-guest.mjs` driver requires an
explicit disposable marker, fresh dedicated mount and preloaded immutable image. Ordinary
tests exercise input, report and CLI admission; they do not substitute for privileged drills.
