# Managed ingress and external data

The data-plane module separates public routing and provider-managed SQL from application processes.

## Managed ingress

`createManagedIngress` routes exact hostnames to fixed upstream origins. Route configuration is trusted control-plane data; request paths never select an arbitrary upstream.

The proxy:

- matches only active, uniquely assigned hosts;
- allows loopback upstreams by default and requires an explicit allowlist for remote upstream hosts;
- strips fixed hop-by-hop headers, `Connection`-nominated headers, and private server headers;
- sets controlled forwarding and project headers;
- optionally binds a remote provider origin, path, protocol, and generation with an
  ingress-only credential that public requests cannot override;
- bounds request bodies before forwarding;
- applies timeouts and safe-method retries for network failure or transient upstream 5xx responses;
- streams response bodies, including SSE;
- tracks per-route circuit failures; and
- exposes active-route health checks.
- records bounded per-project ingress metrics; and
- constructs every target from the trusted upstream origin before assigning the request path, so a scheme-relative path cannot replace the upstream host.

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

### Generation-bound provider routes

Several projects or runtime generations can share one trusted provider origin without making the
public request choose a provider path:

```ts
const ingress = createManagedIngress({
  allowedUpstreamHosts: ["provider.internal.example"],
  routes: () => [{
    id: "route_tasks",
    projectId: "project_tasks",
    hosts: ["tasks.apps.clank.example"],
    upstream: "https://provider.internal.example",
    active: true,
    runtime: {
      protocol: "clank-runtime/1",
      generation: 42,
      path: "/v1/runtimes/project_tasks",
      token: process.env.PROJECT_TASKS_INGRESS_TOKEN!,
    },
  }],
});
```

For a public request to `/todos?done=false`, the example calls
`https://provider.internal.example/v1/runtimes/project_tasks/todos?done=false`. The upstream
remains an allowlisted origin and the provider path is strict trusted configuration: it must be an
absolute, non-scheme-relative path made from URL path-safe ASCII characters, without percent
encoding, backslashes, or an empty, dot, query, fragment, or null segment.

Managed ingress removes client-supplied versions of all reserved binding headers and then sets:

- `x-clank-project-id`;
- `x-clank-runtime-protocol`;
- `x-clank-runtime-generation`; and
- `x-clank-runtime-ingress`, containing the private route token.

The provider must compare every field with its committed runtime state before dispatching. It
should return a generic unavailable response for a missing, invalid, stale, or stopped binding.
The token is not an application bearer credential: keep it out of URLs, logs, metrics, errors,
responses, and application code, and rotate it when replacing the provider route.

Active-route health probes use the same fixed provider path and binding headers. Circuit state is
also scoped to origin, protocol, provider path, and generation, so failures from an old generation
cannot hold a newly activated generation open; late responses from the replaced generation also
cannot change its replacement's circuit. This contract does not by itself publish a remote runtime;
activation still requires a verified provider launcher and an atomic control-plane route switch.

### Admission policy

Embedders can apply durable capacity policy after the request body passes its bound and before any
upstream call:

```ts
const ingress = createManagedIngress({
  routes,
  async admitRequest(request) {
    // projectId, routeId, normalized method, requestBytes, recordedAt
    return withinCapacity(request)
      ? { allowed: true }
      : {
          allowed: false,
          code: "PROJECT_RATE_LIMIT_REACHED",
          message: "This project has reached its request rate limit.",
          retryAfterSeconds: 30,
        };
  },
});
```

The callback receives no path, hostname, headers, cookies, IP address, query string, or body
content. A thrown exception, invalid decision, unsafe code/message, or invalid retry interval fails
closed with a generic `ADMISSION_UNAVAILABLE` response. A valid denial returns `429` without
calling upstream and remains observable with `admitted: false` in `onRequest`.

The built-in platform uses this boundary for its transactional workspace/month and project/minute
ledger. See [Usage accounting and traffic limits](usage-and-limits.md).

## Custom domains

```sh
clank domain add tasks.customer.example
# publish the displayed TXT record
clank domain verify <domain-id>
clank domain list
```

Custom hosts do not enter the ingress route set until the exact `_clank.<hostname>` TXT challenge is present **and** the hostname resolves to the configured CNAME target or edge A/AAAA address. Challenges are project bound, expiring, and unique by hostname. Pending and verified hostnames cannot be claimed by another project.

Ownership, routing, and certificate status are separate. Clank provides a constant-time, token-protected permission endpoint for Caddy On-Demand TLS; Caddy or another edge remains responsible for ACME, certificate/key storage, and renewal. See [Deployment dashboard, quotas, and domains](platform-dashboard.md) for the DNS lifecycle and production Caddy configuration.

The deployment platform refreshes routing in bounded background batches. Expiring SQLite claims prevent duplicate work across control-plane processes, per-domain deadlines prevent a slow resolver from stopping the pass, and manual checks fence out stale automatic results. Ownership verification stays explicit.

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
