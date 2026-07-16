# Self-hosting Clank Deploy

Clank Deploy is one Node control-plane process plus one supervised process or container per active project.

## Requirements

- Node 22.13+;
- persistent local storage;
- HTTPS proxy outside loopback;
- Docker for mutually untrusted deployers;
- external master key and off-host backups for production.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4200` | Control-plane port |
| `HOST` | `127.0.0.1` | Listener address |
| `CLANK_PLATFORM_URL` | loopback URL | Exact public console origin |
| `CLANK_PLATFORM_DATA` | `.clank-platform` | Persistent root |
| `CLANK_PLATFORM_MASTER_KEY` | generated file | Base64/base64url 32-byte key |
| `CLANK_SIGNUP` | `bootstrap` | `bootstrap`, `public`, or `disabled` |
| `CLANK_RUNNER` | `process` | `process` or `docker` |
| `CLANK_DOCKER_IMAGE` | Node image | Pin by digest in production |
| `CLANK_APP_MEMORY` | `512m` | Container memory |
| `CLANK_APP_CPUS` | `1` | Container CPUs |
| `CLANK_APP_PIDS` | `128` | Container PID limit |
| `CLANK_APP_PORT_START` | `4300` | Port-range start |
| `CLANK_APP_PORT_END` | `4999` | Port-range end |
| `CLANK_APP_URL_TEMPLATE` | loopback with `{port}` | Public app URL pattern |
| `CLANK_MAX_ARTIFACT_BYTES` | `104857600` | Artifact limit |
| `CLANK_ALLOW_UNSAFE_MIGRATIONS` | `0` | Operator approval for unrestricted SQL |
| `ALLOWED_HOSTS` | loopback | Exact host allowlist |
| `TRUST_PROXY` | `0` | Trust forwarded client/protocol |

## Production start

```sh
export CLANK_PLATFORM_URL=https://deploy.example.com
export CLANK_PLATFORM_DATA=/var/lib/clank
export CLANK_PLATFORM_MASTER_KEY="$(your-secret-manager read clank-master-key)"
export CLANK_RUNNER=docker
export CLANK_DOCKER_IMAGE=node@sha256:<approved-digest>
export CLANK_APP_URL_TEMPLATE='https://{slug}.apps.example.com'
export HOST=127.0.0.1
export PORT=4200
export ALLOWED_HOSTS=deploy.example.com,127.0.0.1,localhost
export TRUST_PROXY=1

clank-platform
```

Proxy the console origin to port 4200. Application routing remains external because wildcard DNS and certificates are operator-specific. Generate proxy routes from project status or expose selected ports through a private VPN.

## Tailscale

```sh
CLANK_PLATFORM_URL=https://host.tailnet-name.ts.net:8447 \
HOST=127.0.0.1 PORT=4200 TRUST_PROXY=1 \
ALLOWED_HOSTS=host.tailnet-name.ts.net,localhost,127.0.0.1 \
clank-platform

tailscale serve --https=8447 http://127.0.0.1:4200
```

Expose app ports separately or place a wildcard-capable proxy in front.

## Storage

```text
control.sqlite
master.key
projects/<id>/
  data/app.sqlite
  releases/<release-id>/
  backups/<release-id>.sqlite
```

Use a local filesystem with correct SQLite locking/rename semantics. The platform sets umask `0077`.

Back up the control database, project data, recoverable artifacts/source, and master key through separate paths. Pre-release snapshots are not a scheduled backup policy.

## Upgrades

1. Back up data and key.
2. Stop new deploys and the platform.
3. Install and verify the new Clank build.
4. Start one platform instance.
5. Verify browser login, CLI login, project status, app health, test deploy, and rollback.

Current scaling is deliberately single-host/single-control-plane. Distributed locks, remote artifact storage, multi-node runners, automatic wildcard routing, organization RBAC, and managed external databases are future infrastructure.
