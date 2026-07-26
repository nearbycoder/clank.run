# Railway production deployment

This profile runs the Clank control plane and its trusted application processes in one Railway
service. Railway terminates TLS and forwards every control-plane and application hostname to the
same listener; Clank then routes application hosts to their supervised loopback processes.

## Topology

```text
clink.run ───────────────┐
*.apps.clink.run ────────┼─ Railway edge ─ Clank control plane :$PORT
approved custom domains ┘                    ├─ app :4300 ─ projects/<id>/data/app.sqlite
                                             ├─ app :4301 ─ projects/<id>/data/app.sqlite
                                             └─ /data/control.sqlite

Railway volume mounted at /data
```

Use exactly one replica. Clank's control database and each application database use SQLite, and the
included application supervisor is single-leader. Horizontal replicas need the external storage,
leader, and remote-runner integrations described in [Self-hosting](self-hosting.md).

## Repository configuration

- `Dockerfile` builds the dependency-free TypeScript sources and copies only the production
  control-plane runtime into the final image.
- `railway.json` selects the Dockerfile, probes storage-backed `/_clank/readyz`, gives graceful
  shutdown 30 seconds, and restarts failed processes. The reserved path is checked before
  application-host dispatch because Railway sends its own health-check hostname.
- A Railway volume must be mounted at `/data`.

The service needs these variables:

```sh
HOST=0.0.0.0
NODE_ENV=production
TRUST_PROXY=1
CLANK_PLATFORM_URL=https://clink.run
CLANK_PLATFORM_DATA=/data
CLANK_PLATFORM_MASTER_KEY=<base64url-encoded 32-byte secret>
CLANK_SIGNUP=bootstrap
CLANK_RUNNER=process
CLANK_INGRESS=1
CLANK_INGRESS_BASE_DOMAIN=apps.clink.run
CLANK_APP_URL_TEMPLATE=https://{slug}.apps.clink.run
CLANK_CUSTOM_DOMAIN_TARGET=apps.clink.run
CLANK_MAX_PROJECTS_PER_ACCOUNT=10
CLANK_MAX_PROJECTS_PER_ORGANIZATION=10
CLANK_MAX_DOMAINS_PER_PROJECT=5
CLANK_METRICS_RETENTION_DAYS=30
CLANK_BACKUP_INTERVAL_MS=86400000
CLANK_BACKUP_MAX_COUNT=30
CLANK_BACKUP_MAX_AGE_MS=7776000000
CLANK_ALLOW_UNSAFE_MIGRATIONS=0
```

Do not put `CLANK_PLATFORM_MASTER_KEY` in source control. Back it up separately from the volume:
losing it makes encrypted secrets and recovery points unreadable.

`bootstrap` lets the first browser user create the only public account, then closes registration.
Additional people join through email-bound invitations created by an owner or administrator.

## Domains

Attach both `clink.run` and `*.apps.clink.run` to the Railway service. Publish every CNAME and TXT
validation record Railway returns. Cloudflare records must be DNS-only until Railway finishes
certificate validation; proxying can be evaluated afterward.

The wildcard gives every project an immediate `https://<slug>.apps.clink.run` URL. Railway must also
know about a customer-owned custom domain before its edge can issue a certificate for that host.
For the current single-tenant deployment, add the hostname to the same service with:

```sh
railway domain customer.example --service clank
```

Then publish Railway's validation records plus the ownership record shown in the Clank console.
Clank will route the host only after both ownership and routing checks succeed.

## First account and CLI

1. Open `https://clink.run` and create the bootstrap owner with a unique password of at least 12
   characters.
2. In a local checkout, set the platform and start browser-assisted device authorization:

   ```sh
   clank link https://clink.run
   clank login
   ```

3. Create or scaffold an application and deploy it:

   ```sh
   clank create my-app --template auth-todo
   cd my-app
   clank deploy
   ```

Each project receives a separate directory and SQLite database under `/data/projects/<project-id>`.
Database migrations are planned and applied by Clank during deployment; a failed health check or
migration leaves the active release unchanged.

## Operations

Before each framework upgrade, download or snapshot the Railway volume and preserve the external
master key. After deployment, verify:

```sh
curl --fail https://clink.run/livez
curl --fail https://clink.run/readyz
curl --fail https://clink.run/_clank/readyz
railway logs --service clank --lines 100
```

Also verify browser session refresh, CLI device authorization, a disposable deployment, its
wildcard application URL, backup creation, rollback, and permanent deletion.

The Railway deployment uses Clank's `process` runner because hosted Railway containers do not expose
a Docker daemon. This runner is intentionally for trusted deployers: application code runs with the
same container and volume authority as the control plane. Use Clank's Docker runner or a remote
sandbox worker before opening deployment access to mutually untrusted users.
