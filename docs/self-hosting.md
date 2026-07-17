# Self-hosting Clank Deploy

Clank Deploy is one Node control-plane process plus one supervised process or container per active project.

## Requirements

- Node 22.16+;
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
| `CLANK_INGRESS` | inferred from base domain | Enable managed exact-host ingress |
| `CLANK_INGRESS_BASE_DOMAIN` | none | Built-in `slug.<base>` site namespace |
| `CLANK_CUSTOM_DOMAIN_TARGET` | base domain | CNAME target displayed to customers |
| `CLANK_CUSTOM_DOMAIN_ADDRESSES` | none | Comma-separated edge A/AAAA values accepted for apex routing |
| `CLANK_TLS_ASK_TOKEN` | none | Secret for the private Caddy certificate permission check |
| `CLANK_INGRESS_MAX_BODY_BYTES` | `26214400` | Per-request managed-ingress body limit |
| `CLANK_MAX_PROJECTS_PER_ORGANIZATION` | `10` | Transactionally enforced site limit |
| `CLANK_MAX_DOMAINS_PER_PROJECT` | `5` | Transactionally enforced custom-domain limit |
| `CLANK_METRICS_RETENTION_DAYS` | `30` | Ingress metric retention, 1–365 days |
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
export CLANK_INGRESS=1
export CLANK_INGRESS_BASE_DOMAIN=apps.example.com
export CLANK_CUSTOM_DOMAIN_TARGET=edge.apps.example.com
export CLANK_CUSTOM_DOMAIN_ADDRESSES=192.0.2.10,2001:db8::10
export CLANK_TLS_ASK_TOKEN="$(your-secret-manager read clank-tls-ask-token)"
export HOST=127.0.0.1
export PORT=4200
export ALLOWED_HOSTS=deploy.example.com,127.0.0.1,localhost
export TRUST_PROXY=1

clank-platform
```

Proxy the console and application hosts to port 4200. Clank performs exact-host project routing; the edge performs public DNS, TLS, WAF/rate limiting, and DDoS controls. The recommended Caddy On-Demand TLS configuration and DNS records are in [Deployment dashboard, quotas, and domains](platform-dashboard.md).

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
4. Start the selected active supervisor/worker topology.
5. Verify browser login, CLI login, organization and scoped-token access, project status, ingress/domain state, app health, test deploy, backup verification, and rollback.

Durable distributed locks, authenticated nodes, desired generations, operations/fencing, wildcard base-domain routing, ownership and routing verification, Caddy certificate eligibility, ingress metrics, enforced site/domain limits, organization RBAC, and external database drivers are implemented. The included child-process supervisor remains single-leader and artifacts/backups are local by default; a hosted multi-region service still needs leader/remote-runner integration, external object storage, globally transactional control storage, shared metric storage, and a multi-region edge service.
