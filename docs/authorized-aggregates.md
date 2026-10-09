# Authorized aggregates

`db.table(name).query().aggregate(options)` computes typed counts, sums and scalar groups over
declared application tables. It runs synchronously in the current SQLite read snapshot or write
transaction. Generated backend queries supply the caller's ownership scope automatically.
Explicit `openSQLite().read()` scopes remain a trusted server API: `undefined` means unscoped
server access and `null` means anonymous access, just as for ordinary reads.

Every source needs an explicit authorization policy, including `root`. Owned rows are selected
with the current owner before policies run. A denied root never follows its references. A related
record must pass its own owner scope and policy before it can affect any measure or group.

```ts
import { defineDatabase, defineTable, openSQLite, s } from "@clank.run/framework";

const schema = defineDatabase({
  accounts: defineTable({ category: s.string(), enabled: s.boolean() }).owned(),
  orders: defineTable({ account: s.id("accounts"), amount: s.number(), paid: s.boolean() }).owned(),
});
const database = await openSQLite(schema);
const scope = { userId: "example-account" }; // Supplied by trusted server code.
try {
  database.transaction(db => {
    const account = db.table("accounts").insert({ category: "support", enabled: true });
    db.table("orders").insert({ account, amount: 12.5, paid: true });
    db.table("orders").insert({ account, amount: 7.5, paid: true });
  }, scope);
  const totals = database.read(db => db.table("orders").query().where("paid", true).aggregate({
    joins: { account: { table: "accounts", via: "account" } },
    groupBy: { source: "account", field: "category" },
    measures: {
      orders: { count: true },
      revenue: { sum: { source: "root", field: "amount" } },
    },
    authorize: { root: order => order.paid, account: account => account.enabled },
  }), scope);
  console.log(totals.groups); // [{ group: "support", values: { orders: 2, revenue: 20 } }]
} finally {
  database.close();
}
```

## References, values and results

`joins` maps up to four aliases to direct root fields declared with `s.id(targetTable)`. Optional,
nullable, defaulted and refined references are supported when every non-null alternative has the
same target. An alias cannot be `root`. These are inner references: missing, null, other-owner or
policy-denied related records exclude the root from **all** measures. Related records are loaded
once per distinct table/ID; authorization is cached separately for each alias. Two aliases can
therefore apply different policies to the same record.

Each accepted root contributes once to `count`, even when many roots refer to one account.
A sum of a related field contributes that field once **per accepted root**, rather than summing
unique accounts. Counts accept `{ count: true }`; sums accept `{ sum: { source, field } }` for a
declared numeric field. Null or absent numeric values contribute zero. There are 1–16 named
measures; names and aliases are ASCII identifiers of at most 64 characters.

`groupBy` accepts declared string, finite number, boolean or null fields. Optional values group
under null; negative zero groups with zero. Arrays, objects, unknown schemas and document
metadata fields cannot be projected. Numeric `1`, string `"1"` and boolean values stay distinct.
Source rows use stable creation-time/ID order; `orderBy()` does not change aggregate evaluation.
Groups use a deterministic lexical order of their JSON-encoded type/value keys. The order is
stable across restart and is not a locale or numeric sort.

The immutable result is `{ protocol: "clank-aggregate/1", groups: [{ group, values }] }`. Types
preserve each source's fields, reference target, group value and exact measure names. An empty
ungrouped selection produces one null group with zero measures; an empty grouped selection
produces `groups: []`. `limit()` is rejected, so a partial selection cannot appear as a complete
total. Queries can use up to 32 ordinary `where()` filters, with the existing comparison semantics.

## Admission and failure

| Limit | Default | Maximum |
| --- | --- | --- |
| `maxRows` | 1,000 candidate source rows | 10,000 |
| `maxRelated` | 1,000 distinct table/ID lookups, including misses | 10,000 |
| `maxBytes` | 2 MiB of stored UTF-8 JSON | 8 MiB |
| `maxGroups` | 100 output groups | 1,000 |
| `maxOutputBytes` | 64 KiB of serialized UTF-8 output | 256 KiB |

Supply smaller positive integer limits through `limits`. Native SQLite metadata admits at most
`maxRows + 1` candidates and measures their stored UTF-8 JSON lengths **before** source JSON is
materialized. Related JSON lengths are checked in the same owner scope before each first read;
their bytes are counted once per distinct record. The combined byte limit includes source
candidates denied by policy. Other owners' rows never enter either admission or projection.

Capacity failures throw `RangeError` and return no partial totals. Invalid declarations, non-boolean
policies or asynchronous policies throw `TypeError`; unexpected policy failures propagate. Sums
use JavaScript's IEEE 754 arithmetic, including ordinary decimal rounding. Non-finite sums and
an unsafe integer intermediate when both operands are integers throw `RangeError`. Use validated
integer minor units within the safe integer range when exact integer accounting is required.

The limits bound materialized candidates, related lookups, stored JSON and output. They do not
bound SQLite's internal filter/index scan time, schema parsing/default work, or arbitrary trusted
policy computation and additional reads. A policy-denied candidate can affect admission failure
within the caller's owner scope; it cannot produce an inaccessible value, count or group in a
successful result. Do not convert capacity failures into apparently complete zero totals.

## Live updates and lifecycle

Policy callbacks receive the current scoped `ReadDatabase`. Use it to read ACL records so those
dependencies are tracked alongside precise related table/ID dependencies. Changes to a referenced
parent or ACL re-run the live query. Changes to another owner's roots, another table or an unrelated
parent ID stay quiet. The root dependency remains table-wide within the owner's scope, matching
ordinary queries; filters do not narrow invalidation. Session revocation still uses the backend's
current authentication checks and closes protected live streams.

Policies are trusted application code, must return a synchronous boolean and must not produce
side effects. Top-level document fields are frozen before policy calls. The complete plan and
callback references are captured before any policy executes. A builder or reader retained from a
finished transaction cannot aggregate during a later transaction. Recreate it inside the current
handler. No aggregation state is persisted, no schema migration is required, and disabling a query's
aggregate call changes neither stored documents nor the live protocol.
