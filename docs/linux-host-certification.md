# Linux host certification

`@clank.run/framework/host-certification` runs real enforcement probes for a captured,
static Docker deployment profile. Operators explicitly select a disposable Linux host
with its **own local Docker daemon** and dedicated XFS mount. The framework does not
format disks, install tools, pull images or substitute a trusted process runner.

A versioned report is green only when all seven checks pass, including verified cleanup.
The private operator report directory authenticates saved reports with a local 32-byte
key. Inspection rechecks the policy digest, host binding and expiry. Treat this directory
and its key as operator credentials; application tenants must never access them.

## Prepare an explicit disposable profile

Use Node 22.16+, Bubblewrap, util-linux, nftables, iproute2, procps, XFS tools and Docker.
V1 passing profiles require an operator process with real/effective UID 0, so every
privileged attempt uses the same root-owned host-wide lock. Delegated capability profiles
are unsupported; an unprivileged diagnostic attempt can only produce a blocked result.
Preload an operator-selected Node image, then use its immutable `@sha256` reference.
Mount a **new disposable** XFS filesystem with project accounting/enforcement (`prjquota`).
Never point this proof at a shared Docker daemon, live project or a filesystem that may
contain someone else's quota allocations. Reserve a previously unused nonzero project
ID; certification refuses a quota ID with existing usage or limits.

V1 proves the selected byte/inode ceilings together. Supported persistent byte limits
are 4–64 MiB, aligned to 1 KiB; inode limits are 32–128. The mount needs at least three
times the selected byte limit available for inside/outside positive controls. Larger
production quotas require a separately supported certification profile; a small profile
certificate cannot authorize a different large policy. These ceilings bound the proof's
allocation, rather than pretending to test an unlimited filesystem.

Container memory is an explicit `m`/`g` value from 128 MiB to 2 GiB; CPU limits are
0.1–4 with at most three decimal places, and PID limits are 16–32,768. The probe verifies
Docker's exact configured memory, swap, CPU and PID values as well as runtime restrictions.

The outbound policy uses the same validated public IPv4 CIDRs and pinned static hosts
as the Docker launcher. Supply one controlled allowed address within the policy and one
controlled denied public address outside it. An empty allowlist omits the allowed address.
V1 cannot certify a policy that permits every public destination, because its required
denied-public positive control would have no valid address. Private, metadata and host
destinations remain denied even when a CIDR includes them.

During the proof, these addresses route to a newly owned local network namespace; requests
do not contact their real external servers. The proof temporarily creates exact owned
routes/link/firewall/network/container resources on the disposable host. It restores IP
forwarding to its prior value and verifies cleanup before publishing a passing report.
This samples representative traffic and static names pointing to the selected address;
it does not attest the availability of every destination or an external DNS provider.

## Certify and inspect

```ts
import {
  certifyLinuxHost, requireCurrentLinuxHostCertification,
  type LinuxHostCertificationProfile,
} from "@clank.run/framework/host-certification";

const profile: LinuxHostCertificationProfile = {
  mode: "docker-isolated",
  image: "node@sha256:<replace-with-the-preloaded-64-hex-digest>",
  user: "1000:1000",
  memory: "512m", cpus: "1", pidsLimit: 128,
  diskQuota: {
    mountDirectory: "/disposable-xfs",
    hardBytes: 32 * 1024 * 1024, hardFiles: 64,
  },
  outboundNetwork: {
    allowCidrs: ["1.1.1.1/32"],
    hosts: { "allowed.example.test": "1.1.1.1" },
  },
  networkProbe: { allowedAddress: "1.1.1.1", deniedAddress: "9.9.9.9" },
};
const selected = { directory: "/root/clank-certification", profile };
const report = await certifyLinuxHost({
  ...selected, disposable: true, quotaId: 2147481001, ttlMs: 60 * 60 * 1000,
});
console.log(report.status, report.checks);
await requireCurrentLinuxHostCertification(selected); // Throws for every blocked/stale result.
```

The API report contains digests and fixed capability/reason codes; it does not expose
host paths, image references, command output or application secrets. Invalid API/profile
input and unsafe report storage throw before a successful report is returned. Operational
probe denials produce a blocked report. Missing/unusable foundational paths, metadata
writes and failures to finish final cleanup can also throw; they never produce green.

Save `{ "directory": "…", "profile": { … } }` as a bounded regular JSON file, then use:

```sh
clank-provider certify --config profile.json --quota-id 2147481001 --disposable
clank-provider certification --config profile.json
```

Both commands print JSON. Certification returns exit code 1 for a blocked report;
inspection returns 1 for missing, active, invalid, expired, changed or blocked reports.
The inspection command does not start a provider or require its bearer token. Existing
providers remain compatible: requiring certification is an explicit admission decision,
not an implicit change to current deployment behavior.

## What passes each check

| Capability | Required evidence |
| --- | --- |
| `namespaces` | Real user/mount/network namespace creation, mapped UID and a distinct network namespace. |
| `migrations` | Actual isolated SQLite migration succeeds; a later failed transaction preserves data and ledger, then the worker recovers. |
| `sqlite-worker` | Endless SQL is terminated by the fixed worker bound while the parent serves timers; partial writes roll back and another request succeeds. |
| `disk-quota` | Exact selected byte/inode denial, outside-quota writes, failed SQLite/WAL allocation and atomic rollback. |
| `runner` | Production Docker launcher, selected immutable image/non-root user/resources, zero effective capabilities, no-new-privileges, read-only code/root, writable data, absent host secret and bounded tmpfs. |
| `egress` | Controlled allowed/denied/private/metadata and host destinations are reachable before enforcement; selected policy then permits only the allowed control, with IPv6 disabled. |
| `cleanup` | Child exit, no owned containers/network/firewall, removal of owned routes/link/files, zero owned quota usage and released limits, restored host binding. |

No caller can supply a callback or arbitrary executable to manufacture a probe result.
Commands have fixed executables, clean environments, one-MiB output bounds and deadlines;
SQLite retains its existing ten-second execution bound. Cancellation is observed between
capabilities and during privileged commands. An already running SQLite task completes or
hits its fixed bound before cancellation cleanup; abort does not turn a skipped check green.

## Freshness, interruption and recovery

Reports live for one hour by default, configurable from one minute to 24 hours. Inspection
uses wall time and same-boot uptime, rejecting backwards clock movement and expiry. Host
binding includes boot/kernel/architecture, UID/groups/capabilities, relevant namespace and
forwarding settings, selected mount identity/options, framework/runtime/enforcement-tool bytes, local Docker
daemon configuration and resolved image identity. Changes require a fresh certificate.

This is an expiring measurement at a point in time, not continuous monitoring or a promise
that privileged operators cannot change the host later. Arbitrary external policy files,
every possible resource-exhaustion behavior and all network destinations are not attested.
Keep the profile identical when requiring current certification, and maintain normal host
security and deployment fencing. A locally compromised operator can replace the key and
code; local authentication does not claim protection from the host administrator.

Attempts are exclusive per private directory and, for root, across the host through
`/run/clank-host-certification.attempt`. The old report is invalidated before probing. A
root inspection also rejects this host-wide marker, including attempts using another
private report directory, before reading a certificate and again after host sampling. A
completed report is atomically renamed; a lost response can be recovered by inspection in
a new process. A forced process death leaves an attempt marker, so inspection remains
blocked even if an earlier report existed. Attempts are never automatically unlocked by
age or recycled into another live quota assignment.

On a forced interruption, an operator must first confirm the recorded PID/boot is no longer
active and clean the exact owned resources listed in the private attempt record (scratch,
project/owner label, link, controlled routes and reserved quota). Verify child/container
termination, firewall/network removal, original host policy and zero quota usage before
removing either attempt marker. Failed or uncertain owned cleanup retains both markers
for explicit operator recovery. Prefer disposing of the entire test VM after interruption.
Do not clear a marker while a live attempt can still mutate the host. Completed attempts
remove their markers automatically; failed verification remains blocked. V1 supplies no
automatic crash cleanup that could mistake another process or project for its own.

Persistence is additive private key/report/attempt metadata; application databases and
provider control stores are unchanged. Rollback removes this optional admission requirement
and its metadata only after owned attempts are stopped and cleaned. Quota IDs are never
silently borrowed from existing projects. Runtime remains dependency-free.
