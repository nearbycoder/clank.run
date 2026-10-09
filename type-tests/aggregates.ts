import { defineDatabase, defineTable, s, type ReadDatabase, type Id } from "../src/index.ts";

const schema = defineDatabase({
  sales: defineTable({ account: s.optional(s.nullable(s.id("accounts"))), amount: s.number(), tag: s.string(), extra: s.unknown() }).owned(),
  accounts: defineTable({ label: s.string(), weight: s.optional(s.number()), enabled: s.boolean(), empty: s.literal(null) }).owned(),
  other: defineTable({ text: s.string() }),
});
declare const db: ReadDatabase<typeof schema>;
const result = db.table("sales").query().aggregate({
  joins: { account: { table: "accounts", via: "account" } },
  groupBy: { source: "account", field: "label" },
  measures: { count: { count: true }, revenue: { sum: { source: "root", field: "amount" } }, weight: { sum: { source: "account", field: "weight" } } },
  authorize: {
    root(record, scoped) { const id: Id<"sales"> = record._id; scoped.table("sales").get(id); return true; },
    account(record) { const label: string = record.label; const id: Id<"accounts"> = record._id; return record.enabled && label.length > 0 && id.length > 0; },
  },
});
const group: string | null = result.groups[0].group;
const count: number = result.groups[0].values.count;
// @ts-expect-error Named measures remain exact.
result.groups[0].values.missing;
// @ts-expect-error Results are immutable.
result.groups[0].values.count = 2;
// @ts-expect-error Results are immutable.
result.groups.push(result.groups[0]);
const ungrouped = db.table("sales").query().aggregate({ measures: { total: { count: true } }, authorize: { root: () => true } });
const nullGroup: null = ungrouped.groups[0].group;
const rootOnly = db.table("sales").query().aggregate({ groupBy: { source: "root", field: "tag" }, measures: { total: { count: true } }, authorize: { root: () => true } });
const tag: string | null = rootOnly.groups[0].group;
const nullLiteral = db.table("accounts").query().aggregate({ groupBy: { source: "root", field: "empty" }, measures: { count: { count: true } }, authorize: { root: () => true } });
const literalGroup: null = nullLiteral.groups[0].group;
// @ts-expect-error The root alias is reserved.
db.table("sales").query().aggregate({ joins: { root: { table: "accounts", via: "account" } }, measures: { count: { count: true } }, authorize: { root: () => true } });
// @ts-expect-error A measure cannot declare both operations.
db.table("sales").query().aggregate({ measures: { count: { count: true, sum: { source: "root", field: "amount" } } }, authorize: { root: () => true } });
// @ts-expect-error The reference target must match its nominal field.
db.table("sales").query().aggregate({ joins: { wrong: { table: "other", via: "account" } }, measures: { total: { count: true } }, authorize: { root: () => true, wrong: () => true } });
// @ts-expect-error Plain strings are not declared references.
db.table("sales").query().aggregate({ joins: { wrong: { table: "accounts", via: "tag" } }, measures: { total: { count: true } }, authorize: { root: () => true, wrong: () => true } });
// @ts-expect-error Every joined source requires authorization.
db.table("sales").query().aggregate({ joins: { account: { table: "accounts", via: "account" } }, measures: { total: { count: true } }, authorize: { root: () => true } });
// @ts-expect-error Authorization is synchronous.
db.table("sales").query().aggregate({ measures: { total: { count: true } }, authorize: { root: async () => true } });
// @ts-expect-error Unknown sources cannot be projected.
db.table("sales").query().aggregate({ measures: { total: { sum: { source: "missing", field: "amount" } } }, authorize: { root: () => true } });
// @ts-expect-error Sum fields are numeric.
db.table("sales").query().aggregate({ measures: { total: { sum: { source: "root", field: "tag" } } }, authorize: { root: () => true } });
// @ts-expect-error Fields belong to their source table.
db.table("sales").query().aggregate({ joins: { account: { table: "accounts", via: "account" } }, measures: { total: { sum: { source: "account", field: "amount" } } }, authorize: { root: () => true, account: () => true } });
// @ts-expect-error Unknown values are not scalar groups.
db.table("sales").query().aggregate({ groupBy: { source: "root", field: "extra" }, measures: { total: { count: true } }, authorize: { root: () => true } });
void [group, count, nullGroup, tag, literalGroup];
