# Managed ingress and external data

The data-plane module separates public routing and provider-managed SQL from application processes.

## Managed ingress

`createManagedIngress` routes exact hostnames to fixed upstream origins. Route configuration is trusted control-plane data; request paths never select an arbitrary upstream.

The proxy:

- matches only active, uniquely assigned hosts;
- allows loopback upstreams by default and requires an explicit allowlist for remote upstream hosts;
- strips fixed hop-by-hop headers, `Connection`-nominated headers, and private server headers;
- sets controlled forwarding and project headers;
- bounds request bodies before forwarding;
- applies timeouts and safe-method retries for network failure or transient upstream 5xx responses;
- streams response bodies, including SSE;
- tracks per-route circuit failures; and
- exposes active-route health checks.

The Clank platform can enable ingress directly:

```ts
await openPlatform({
  publicUrl: "https://console.clank.example",
  dataDirectory: "/srv/clank",
  ingress: {
    baseDomain: "apps.clank.example",
  },
});
```

Projects are then available at `https://<slug>.apps.clank.example`. TLS should terminate at the edge proxy or load balancer in front of the Clank control/data-plane process.

## Custom domains

```sh
clank domain add tasks.customer.example
# publish the displayed TXT record
clank domain verify <domain-id>
clank domain list
```

Custom hosts do not enter the ingress route set until the exact `_clank.<hostname>` TXT challenge is present. Challenges are project bound, expiring, and unique by hostname. A verified hostname cannot be claimed by another project.

Certificate issuance is intentionally outside DNS ownership verification. A production edge should consume verified domain state, request ACME certificates, store private keys in its certificate manager, and activate TLS only after issuance succeeds.

## External PostgreSQL over HTTPS

`createHttpPostgresDriver` is the zero-package external SQL boundary:

```ts
const postgres = createHttpPostgresDriver({
  url: process.env.DATABASE_HTTP_URL!,
  token: process.env.DATABASE_HTTP_TOKEN!,
});

const result = await postgres.query({
  text: "SELECT id, title FROM tasks WHERE owner_id = $1",
  parameters: [user.id],
});
```

The driver sends structured statements and JSON parameters to an HTTPS database gateway. It never interpolates parameters, rejects redirects, bounds statement counts and response bytes, applies a timeout, and validates every result envelope.

`applyExternalMigrations` creates the same immutable `clank_migrations` ledger and sends all pending migration and ledger statements in one provider transaction. Edited or missing applied migrations stop deployment.

The framework's built-in auth, live document database, and revision journal remain SQLite-first. External PostgreSQL is an explicit service driver for workloads that require horizontal SQL. An application must choose which records are authoritative; it must not dual-write SQLite and PostgreSQL without an outbox or another explicit consistency protocol.

## Provisioning

`createHttpDatabaseProvisioner` defines the control-plane boundary for creating and destroying project databases:

- provisioning requires project, region, engine, and idempotency key;
- provider credentials stay in platform secrets;
- returned connection material is validated before storage;
- destruction requires `destroy <database-id>`; and
- application code receives only its own binding.

Open-source operators can implement this HTTP contract against their preferred PostgreSQL provider without changing framework application code.
