# SQLite worker isolation

Linux workers use util-linux `setpriv` to clear inherited and ambient host capabilities
before starting Bubblewrap. This supports dedicated non-root providers with explicit quota
or network administration privileges without giving those privileges to SQLite work. The
provider's own capability state is unchanged. `setpriv`, `prlimit` and `bwrap` must all be
installed; inability to clear capabilities or create namespaces fails closed.

On Linux, Clank opens application databases only inside a private Bubblewrap filesystem namespace for migration planning/execution, backup/restore, platform job inspection/mutation, recovery inspection, preview sanitization, bucket usage, and rehearsal inspection. This contains application-controlled database paths and SQLite sidecars even when an application substitutes symbolic links or replaces a directory while a request is starting.

Install `bubblewrap` and `util-linux` at their standard `/usr/bin/bwrap` and `/usr/bin/prlimit` paths. The host must permit unprivileged user namespaces and Bubblewrap mount, PID, IPC, and network namespaces. Namespace setup fails closed; Clank never retries a failed sandbox operation outside the sandbox. Containerized control planes need an operator-configured environment that permits this nested sandbox. Installing the executables alone does not prove that the container's seccomp or AppArmor policy permits namespaces.

Each operation receives only its selected database directories and, when needed, a read-only migration directory. Clank opens every directory component with `O_DIRECTORY | O_NOFOLLOW`, retains a descriptor, and bind-mounts that exact inode. Replacing an ancestor after it has been opened does not redirect the mount. Callers must give different tenants separate application directories: sharing one directory between two tenants also shares their SQLite capability. Broad system roots and files directly in `/tmp`, `/home`, or `/var` are rejected; use a dedicated directory instead. Arbitrary host paths outside the granted directories are absent. Runtime modules and operating-system libraries are read-only, networking is unshared, inherited host environment/preloads are removed, and `/tmp` is a private 64 MiB tmpfs.

Backup and restore publication retains the same destination-directory descriptor through worker completion, publication, and cleanup. The parent removes sidecar directory entries and renames through that descriptor; it never follows a replaced destination ancestor. File permissions are changed through a no-follow descriptor before publication, rather than by following the destination pathname after rename. Applications that can write their own database directory can still modify their own data; this boundary prevents those writes from gaining host filesystem authority.

The existing resource bounds also apply: 10 seconds of worker execution, a 128 MiB V8 heap, 256 MiB data-segment and 1 GiB address-space kernel limits, a 10-second CPU bound, disabled core dumps, and a 16 MiB request/response limit. These are not disk quotas. Persistent database/WAL/journal growth still requires a filesystem quota, and tmpfs consumes memory accounted separately by the host.

The shared scheduler admits at most two active workers, with one active worker for each project. Project paths under `projects/<id>` or `deployments/<id>` share a queue key; standalone calls use the database's containing directory. Waiting projects rotate between admissions. Each project may have four queued requests, the global queue holds at most sixteen, and queued requests expire after ten seconds without being started. A saturated project cannot consume the second active slot or every waiting slot. Calls using `:memory:` remain subject to the global limits.

Other operating systems retain bounded child processes but do not receive this Linux filesystem boundary. Run untrusted tenants on a supported Linux sandbox host; a non-Linux development process is not a substitute for tenant isolation.

## Verification

Ubuntu 24.04 also requires explicit AppArmor namespace permission. The repository's CI installs the system packages above plus nftables, iproute2 and procps, then loads `scripts/ci-linux.apparmor` on its disposable runner. That grants namespace creation to `/usr/bin/bwrap` and the test utility `/usr/bin/unshare`; it preserves the global namespace restriction. Production operators must review a profile for their own host and service rather than automatically installing the CI profile.

Run the real namespace and scheduling regressions locally after building:

```sh
node --test tests/sqlite-sandbox.test.mjs tests/sqlite-isolation.test.mjs
```

The Linux tests use actual Bubblewrap namespaces and SQLite, without a Docker daemon. They check out-of-directory SQL attachment, database and ancestor symlinks, replacement of a directory after it was pinned, host networking isolation, read-only runtime mounts, backup sidecar handling, native memory/time limits, event-loop responsiveness, queue fairness, admission caps, and expiration. A missing or prohibited Linux sandbox makes these tests fail rather than silently skip. The normal test gate includes both files; no external CI run is needed for development.

During coverage collection, each worker receives its own pinned profile directory. The
host publishes profiles under unique collector-compatible names after the worker closes.
Workers do not receive the parent coverage directory. This preserves profiles when PID
namespaces emit the same V8 filename and avoids concurrent overwrites; coverage thresholds
and the existing single malformed-artifact retry remain unchanged.

## Migration and rollback

There is no database schema change. Before upgrading a Linux host, install the two system packages and run the verification command under the same user, container, and security profile as the production control plane. Move databases placed directly in broad shared system directories into per-application directories. Existing project layouts already meet this requirement. An upgrade intentionally refuses namespace execution when the host policy does not permit it. Rolling back restores the previous worker behavior and removes this filesystem security boundary; restrict deployers and data-directory writers to trusted operators before doing so.
