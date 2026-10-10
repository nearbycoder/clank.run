# PostgreSQL application databases

`openPostgres` provides a supported subset of Clank's generated table and function contract.
It uses a dedicated Node worker and PostgreSQL's parameterized v3 protocol with no NPM driver.

SQLite remains the default application store and the native store for authentication, queues,
search, reviewed actions and offline mutation receipts. PostgreSQL does not replace the
platform control catalog or translate SQLite SQL.

```ts
import {defineDatabase, defineTable, defineBackend, openBackend, openPostgres, s}
  from "@clank.run/framework";

const schema = defineDatabase({
  notes: defineTable({title: s.string({max: 200}), complete: s.boolean()}),
});
const database = await openPostgres(schema, {
  host: "database.example.test",
  database: "application",
  user: "application",
  password: process.env.APPLICATION_DATABASE_PASSWORD!,
  namespace: "notes_application",
  tls: {ca: process.env.APPLICATION_DATABASE_CA},
});
const definition = defineBackend({schema}).functions(({publicQuery, publicMutation}) => ({
  list: publicQuery({args: {}, handler: ({db}) => db.table("notes").collect()}),
  add: publicMutation({args: {title: s.string({max: 200})},
    handler: ({db}, {title}) => db.table("notes").insert({title, complete: false})}),
}));
const backend = await openBackend(definition, {database});
// Mount backend.handle using the ordinary generated HTTP/MCP transport.
```

The caller supplies a dedicated database role and database. Give that role access only to
this application's database; the fixed `clank_pg_applications`, `clank_pg_documents` and
`clank_pg_changes` tables are internal, rather than an authorization layer for arbitrary SQL
clients. The initial setup requires table/index creation permission. A namespace separates
application rows inside those tables. Namespace and schema identity are validated on reopen;
changed schemas and unknown protocol versions fail before application writes. Automated schema
migrations, copying SQLite data and dual writes are unsupported.

## Supported contract

The adapter implements synchronous `read`, `tracked` and `transaction` callbacks, `table`,
`get`, `insert`, `patch`, `replace`, `delete`, scalar `where` comparisons, `orderBy`, `limit`,
`collect`, `first`, expected document versions, change subscriptions and retained global
revisions. One native connection executes each interactive transaction. Writes lock the
application revision row and commit all tables and change metadata together; reads use a
repeatable-read snapshot with its own revision. Equal canonical JSON does not advance a
document version. Returned documents are immutable. Nested callbacks, returned promises and
expired table/query handles are rejected.

Owned tables work through trusted server callbacks and an explicit `DatabaseScope`:

```ts
database.transaction(db => db.table("privateNotes").insert({title: "Owned note"}),
  {userId: trustedCurrentUserId});
```

Define that table with `.owned()`. Filtering executes in native SQL, and writes cannot change
the stored owner. A null owner is anonymous and cannot access owned tables. Omitted scope is
deliberate trusted server access for reads and existing-row changes; owned inserts still need
an explicit owner. Resolve identities on the server. Never accept a browser-provided owner as
authorization.

Generated `openBackend` integration initially accepts only public functions over the exact
same public-table schema. It refuses owned schemas, authenticated functions and SQLite-only
auth/jobs/activity/review/offline-receipt/bucket integrations before opening native services.
`BackendRuntime` infers the concrete storage type; ordinary SQLite runtimes retain their
existing native capability. PostgreSQL has no private SQLite handle.

`history`, `restore`, `purgeDeleted`, aggregates, search and SQLite-native services are
unsupported. The `unsupported` capability tuple names this boundary; these operations throw
`PG_OPERATION_UNSUPPORTED`, rather than returning an empty or approximate result. Queries
support declared scalar fields and metadata, at most twenty comparisons and one ordering.
Complex field comparisons and undefined comparison values are rejected. Limits are positive;
over-capacity `collect` fails instead of silently returning a partial collection.

## Authentication and transport

TLS verifies both the trusted CA and server identity by default. Supply a private CA with
`tls.ca`; `tls.serverName` can explicitly bind a certificate identity. There is no
`rejectUnauthorized` switch. Plaintext is available only with `tls: "loopback"` and the literal
`127.0.0.1` or `::1`, for an explicitly isolated development server. DNS names cannot use that
exception. The adapter requires SCRAM-SHA-256, bounded printable ASCII passwords and
4096–200000 iterations. Unicode SASLprep, SCRAM-PLUS, trust, cleartext passwords, MD5 and other
authentication mechanisms are unsupported. Unsupported wire messages fail closed.

Errors contain a fixed Clank error code and, for known native statement rejection, SQLSTATE.
They exclude PostgreSQL error text, credentials, cancellation keys, SQL parameters and
connection URLs. Keep credentials and CA material outside committed files and evidence exports.
Use [PostgreSQL's SASL documentation](https://www.postgresql.org/docs/current/sasl-authentication.html)
and [protocol reference](https://www.postgresql.org/docs/current/protocol-message-formats.html)
when configuring a compatible server.

## Reconnect and uncertain commits

External changes publish selective table/document/owner invalidation. If retained revisions
were missed, reconnect or synchronization publishes conservative invalidation. Revisions never
move backward. `changePollIntervalMs` defaults to 100 ms; zero disables polling, while ordinary
reads and the version getter still synchronize. Polling runs only when listeners exist.

A connection failure or deadline around `COMMIT` throws `PG_COMMIT_UNKNOWN` and poisons the
session. The write may have committed. No write is automatically replayed. Call
`await database.reconnect()` and inspect your application's native records and revision before
deciding what to do. Your application needs its own durable business identifier when an action
must distinguish an accepted operation from a new request. This subset does not provide
transactional mutation receipts. A known statement rejection preserves its SQLSTATE and rolls
back; native transport failures require reconnect. Quiesce writers before rollback or engine
replacement, and retain PostgreSQL data until recovery is explicitly resolved.

## Resource limits and verification

Defaults are a five-second operation/transaction deadline, 1000 returned rows, 4 MiB wire/shared
response, 100 mutation operations, 64 KiB canonical document and 10000 retained revisions.
Configurable ceilings are thirty seconds, 10000 rows, 16 MiB response, 1000 mutation operations
and 100000 revisions. SQL templates and parameters are bounded. Native statement, lock and idle
transaction timeouts also apply. Change retention additionally caps each namespace at 100000
rows, removing entire older revisions; missed changes cause conservative invalidation. There
are at most 128 schema tables and 1000 change listeners. Synchronous calls block their caller
until the bounded worker response, so use an application process sized for this execution model.

Change polling reads revision, retention and records in one repeatable native snapshot, so concurrent
pruning cannot silently omit an already observed change.

For native verification from a source checkout, install PostgreSQL server binaries and OpenSSL on a disposable Linux
host, then run as an ordinary user:

```sh
node scripts/verify-postgres.mjs
node scripts/verify-postgres.mjs --full
```

The verifier creates a fresh private cluster with SCRAM and verified TLS, uses the same table
and generated-function suite for SQLite and PostgreSQL, stops the exact owned cluster and
removes its private files. It never operates on an existing server. Tests exercise owner
isolation, atomic rollback, conflicts, two sessions, actual writer SIGKILL, a real TCP drop after
native commit, reconnect without replay, retention gaps, schema mismatch, bounds and TLS/credential
refusal. No production PostgreSQL or provider certification is implied.
