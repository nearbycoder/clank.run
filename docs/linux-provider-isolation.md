# Linux provider disk and outbound policies

Docker provider launchers can enforce operator-assigned filesystem quotas and outbound network policies. Configure these through `openDockerDeploymentRuntimeLauncher` or the `docker` option of `openDockerDeploymentProviderService`. They are opt-in because the host must provide the required kernel capabilities and filesystem setup. Once configured, a failure to apply or verify either policy refuses runtime launch.

```ts
const provider = await openDockerDeploymentProviderService({
  rootDirectory: "/srv/clank",
  owner: "provider-a",
  image: "registry.example/clank-app@sha256:...", // Supply the complete immutable digest.
  docker: {
    user: "1000:1000",
    diskQuota(projectId) {
      return {
        mountDirectory: "/srv/clank",
        quotaId: assignedProjectQuotaId(projectId),
        hardBytes: 1024 * 1024 * 1024,
        hardFiles: 100_000,
      };
    },
    outboundNetwork: {
      allowCidrs: ["1.1.1.1/32"],
      hosts: { "api.example.com": "1.1.1.1" }, // Replace with the service's actual approved address.
    },
  },
});
```

The example callbacks and addresses are configuration placeholders. Choose and persist a unique, nonzero XFS project quota ID for every project across the entire filesystem. Never reuse an ID while any associated files remain. Clank also records each assignment under the provider's private `.isolation-quotas` directory and rejects conflicting assignments within that provider root.

## Persistent allocations

The quota backend requires a dedicated XFS mount with project quota accounting and enforcement already enabled, plus the `xfs_quota` executable and the privileges needed to manage that mount. It does not mount filesystems or enable quotas globally. The provider service enforces the limit before extracting releases, restoring snapshots, or running migrations, and the launcher verifies it again before starting containers. A direct launcher caller should call `prepareProject(projectId)` before writing prepared deployment data.

A project quota covers its full `projects/<id>` directory tree: live SQLite databases, WAL and journal files, application writes, releases, staging, and recovery snapshots. Both allocated blocks and inode counts have hard limits. Newly created files inherit the project ID; the kernel rejects allocations at the hard limit. This does not depend on periodic usage scans or cooperation from application code. Application containers retain bounded `/tmp` and `/run` tmpfs mounts (64 MiB and 8 MiB per container) and a read-only root filesystem. SQLite helper scratch space has a separate 64 MiB tmpfs limit.

Size the persistent quota to leave room for deployment snapshots, journal records, and recovery. Full quotas can prevent a deployment or rollback from writing its durable state; stop writers, remove unneeded data or raise the quota, and retry the fenced operation. Filesystem quota state survives process restarts and Clank never removes limits during normal runtime cleanup. These policies require the provider process's filesystem and Docker daemon bind-mount filesystem to refer to the same local host paths.

## Outbound traffic

`outboundNetwork` creates a dedicated Docker bridge for each provider owner/project pair. It installs and verifies an owned nftables table before creating application containers. Network options cannot be combined with the launcher's generic `network` setting. The rules allow replies to established ingress connections, reject new connections to host services, reject private/link-local/reserved destinations, allow declared public IPv4 CIDRs, then drop all other outbound traffic. IPv6 is disabled on the network and unmatched traffic is dropped. Static host entries must resolve to an allowed public IPv4 address. External DNS forwarding is disabled; changing DNS responses cannot redirect an allowed hostname to an unapproved address.

These are IP/network policies, not URL/path policies. An allowed address grants connections to that address on all ports; it does not authenticate a particular remote service. Applications should still verify TLS identities. Runtime workers and schedulers receive the same network policy. Removing a runtime first removes its containers and network, then removes its owned nftables table. If network cleanup cannot be verified, the restrictive policy is retained. Following an unexpected provider crash, stale owned network/table pairs are replaced when that project is relaunched; an operator can remove unused pairs after confirming their containers are gone.

The provider needs access to its local Docker daemon and nftables administration privileges. Clank manages only its own named tables and project bridges. Existing host firewall rules may further restrict allowed traffic. Host administrators must not disable or overwrite these rules while runtimes are active.

## Local verification

After a build, run:

```sh
node --test tests/sqlite-sandbox.test.mjs tests/sqlite-isolation.test.mjs \
  tests/linux-project-isolation.test.mjs tests/provider-docker.test.mjs \
  tests/provider-service.test.mjs
```

Install Bubblewrap, util-linux, nftables, iproute2, and procps for the Linux kernel tests. They create disposable user/network namespaces and verify actual packet forwarding: approved traffic succeeds, denied/private/host destinations fail, and removing the policy restores reachability. No host-global firewall or network settings are changed by these tests.

The XFS allocation test requires an explicitly supplied, empty disposable XFS mount with project quotas enabled and appropriate privileges:

```sh
CLANK_XFS_TEST_MOUNT=/disposable-xfs node --test tests/linux-project-isolation.test.mjs
```

It refuses a populated mount, configures a 4 MiB project quota, checks ordinary writes fail with `EDQUOT` or `ENOSPC` while the same allocation succeeds outside the quota on a filesystem with free space, SQLite/WAL writes fail atomically, and inode allocation is bounded, and removes its test files. It leaves the harmless quota record for ID `2147483000` on that disposable filesystem. Without this environment variable the XFS test reports an explicit skip. A passing network namespace test does not prove Docker daemon integration or XFS quota enforcement on a production host; run those capability checks under the actual provider security profile before rollout.

## Compatibility and rollback

No deployment wire protocol or database schema changes are required. Existing providers without these options retain their prior policy. Configure the host and validate its capabilities before enabling the options. Remove application containers before disabling enforcement or rolling back to a version that does not apply it. Keep quota IDs and assignment records during upgrades and rollback. An nftables cleanup failure leaves restrictive rules in place so an operational error cannot silently open egress.

The implementation follows the kernel-backed project quota controls documented in [xfs_quota](https://www.man7.org/linux/man-pages/man8/xfs_quota.8.html) and the independent filtering hooks documented in the [nftables manual](https://netfilter.org/projects/nftables/manpage.html).

The privileged Docker regression is explicitly opt-in and must run on a disposable Linux VM with its own Docker daemon, `iproute2`, `nftables`, `procps`, and `util-linux`. Preload an operator-selected Node image; the test never pulls one implicitly:

```sh
CLANK_DOCKER_INTEGRATION=1 CLANK_DISPOSABLE_TEST_HOST=1 \
  CLANK_DOCKER_TEST_IMAGE=node:24-bookworm-slim \
  node --test tests/provider-docker-integration.test.mjs
```

It creates real network namespaces and reachable positive-control endpoints inside the VM, starts an actual unprivileged application container through the provider launcher, verifies filesystem/capability/tmpfs restrictions, tests permitted and denied packets (including private, metadata and host destinations), and verifies container, network and policy cleanup. Together with the disposable XFS test this was exercised locally on Debian 13 with Docker 26.1.5. Production hosts must validate their own kernel, firewall, filesystem and namespace profiles; a passing disposable-host test does not change those host requirements.

The ordinary Linux isolation suite requires `bubblewrap`, `util-linux`, `iproute2`, `nftables` and `procps`, plus permission to create unprivileged user, mount and network namespaces. It fails when those enforcement capabilities are missing. Containerized control planes additionally require an explicitly reviewed seccomp/AppArmor profile that permits the helper namespaces; installing `bubblewrap` alone does not override a container runtime's restrictions. Do not replace that requirement with `--privileged` or a silent unsandboxed fallback.
