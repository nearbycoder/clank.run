import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { defineAuth, defineBackend, defineDatabase, defineTable, openBackend, openSQLite, createSQLiteDatabase, s } from "../dist/index.js";

function schema() {
  return defineDatabase({
    sales: defineTable({ account: s.optional(s.nullable(s.id("accounts"))), amount: s.optional(s.nullable(s.number())), tag: s.union([s.string(), s.number(), s.boolean(), s.literal(null)]), allowed: s.boolean(), extra: s.unknown() }).owned(),
    accounts: defineTable({ label: s.string(), weight: s.number(), allowed: s.boolean(), note: s.string() }).owned(),
    acl: defineTable({ allowed: s.boolean() }), other: defineTable({ value: s.number() }),
  });
}
const count = { count: true }, sum = { sum: { source: "root", field: "amount" } };
const own = { userId: "alice" }, foreign = { userId: "bob" };
const options = () => ({ joins: { account: { table: "accounts", via: "account" } }, groupBy: { source: "account", field: "label" },
  measures: { count, total: { sum: { source: "root", field: "amount" } }, weight: { sum: { source: "account", field: "weight" } } },
  authorize: { root: row => row.allowed, account: row => row.allowed } });
const sale = (account, amount = 1, allowed = true, tag = "tag") => ({ account, amount, allowed, tag, extra: {} });
const account = (label = "visible", allowed = true, weight = 2, note = "") => ({ label, weight, allowed, note });

test("aggregates enforce root and related owner/policy scopes and count shared references once per root", async () => {
  const database = await openSQLite(schema());
  try {
    const [parent, denied] = database.transaction(db => [db.table("accounts").insert(account()), db.table("accounts").insert(account("denied", false))], own);
    const otherParent = database.transaction(db => db.table("accounts").insert(account("foreign", true, 999)), foreign);
    database.transaction(db => {
      for (const row of [sale(parent, 10), sale(parent, 20), sale(denied, 300), sale(otherParent, 400), sale(parent, 500, false), sale(null, 600), sale("missing_record", 700)]) db.table("sales").insert(row);
    }, own);
    database.transaction(db => db.table("sales").insert(sale(otherParent, 999)), foreign);
    let policies = 0;
    const plan = options(); plan.authorize.account = row => { policies++; return row.allowed; };
    const result = database.tracked(db => db.table("sales").query().aggregate(plan), own);
    assert.deepEqual(result.value, { protocol: "clank-aggregate/1", groups: [{ group: "visible", values: { count: 2, total: 30, weight: 4 } }] });
    assert.equal(policies, 2, "each visible distinct parent receives one policy call");
    assert.ok(Object.isFrozen(result.value.groups[0].values));
    assert.deepEqual(result.dependencies.filter(dep => dep.table === "accounts").map(dep => dep.id).sort(), [parent, denied, otherParent, "missing_record"].sort());
    assert.ok(result.dependencies.filter(dep => dep.table === "accounts").every(dep => dep.ownerId === "alice"));
    assert.throws(() => database.read(db => db.table("sales").query().aggregate(options()), { userId: null }), /authenticated/u);
    assert.equal(database.read(db => db.table("sales").query().aggregate({ measures: { count }, authorize: { root: () => true } })).groups[0].values.count, 8, "explicit trusted server access retains ordinary unscoped semantics");
  } finally { database.close(); }
});

test("aggregate filter semantics, nullable fields, typed scalar keys, empty results and stable ordering", async () => {
  const database = await openSQLite(schema());
  try {
    database.transaction(db => { for (const [tag, amount] of [["1", 2], [1, 3], [false, null], [null, undefined]]) db.table("sales").insert({ ...sale(null, 1, true, tag), amount }); }, own);
    const plan = { measures: { count, total: sum }, groupBy: { source: "root", field: "tag" }, authorize: { root: () => true } };
    const rows = database.read(db => db.table("sales").query().orderBy("amount", "desc").aggregate(plan), own);
    assert.deepEqual(rows.groups, [ { group: false, values: { count: 1, total: 0 } }, { group: 1, values: { count: 1, total: 3 } }, { group: null, values: { count: 1, total: 0 } }, { group: "1", values: { count: 1, total: 2 } } ]);
    for (const [field, op, value] of [["amount", "gte", 2], ["amount", "eq", null], ["tag", "neq", false], ["allowed", "eq", true]]) {
      const actual = database.read(db => { const query = db.table("sales").query().where(field, op, value); return { ordinary: query.collect().length, aggregate: query.aggregate({ measures: { count }, authorize: { root: () => true } }).groups[0].values.count }; }, own);
      assert.equal(actual.ordinary, actual.aggregate);
    }
    const empty = database.read(db => db.table("sales").query().where("allowed", false).aggregate({ measures: { count, total: sum }, authorize: { root: () => true } }), own);
    assert.deepEqual(empty.groups, [{ group: null, values: { count: 0, total: 0 } }]);
    assert.deepEqual(database.read(db => db.table("sales").query().where("allowed", false).aggregate(plan), own).groups, []);
  } finally { database.close(); }
});

test("aggregate captures plans and policies before callbacks, protects projection values and rejects asynchronous policies", async () => {
  const database = await openSQLite(schema());
  try {
    const id = database.transaction(db => db.table("accounts").insert(account()), own);
    database.transaction(db => { db.table("sales").insert(sale(id, 2)); db.table("sales").insert(sale(id, 3)); }, own);
    const plan = options(); plan.authorize.root = row => {
      assert.throws(() => { row.amount = 999; }, TypeError);
      plan.joins.account.via = "extra"; plan.measures.total.sum.field = "extra"; plan.authorize.account = () => false;
      return true;
    };
    assert.equal(database.read(db => db.table("sales").query().aggregate(plan), own).groups[0].values.total, 5);
    for (const policy of [() => 1, async () => { throw new Error("contained rejection"); }, () => ({ then(_resolve, reject) { reject(new Error("contained thenable")); } })]) {
      assert.throws(() => database.read(db => db.table("sales").query().aggregate({ measures: { count }, authorize: { root: policy } }), own), /boolean|synchronous/u);
    }
    await new Promise(resolve => setImmediate(resolve));
    let escaped, escapedReader;
    database.read(db => { escaped = db.table("sales").query(); escapedReader = db; }, own);
    assert.throws(() => escaped.aggregate({ measures: { count }, authorize: { root: () => true } }), /active database/u);
    database.read(() => {
      assert.throws(() => escaped.aggregate({ measures: { count }, authorize: { root: () => true } }), /original active/u);
      assert.throws(() => escapedReader.table("sales").query().aggregate({ measures: { count }, authorize: { root: () => true } }), /original active/u);
    }, foreign);
  } finally { database.close(); }
});

test("aggregate policies are independent for aliases sharing a target and denied roots never follow references", async () => {
  const database = await openSQLite(schema());
  try {
    const id = database.transaction(db => db.table("accounts").insert(account()), own);
    database.transaction(db => db.table("sales").insert(sale(id, 2)), own);
    const plan = { joins: { one: { table: "accounts", via: "account" }, two: { table: "accounts", via: "account" } }, measures: { count }, authorize: { root: () => true, one: () => true, two: () => false } };
    assert.equal(database.read(db => db.table("sales").query().aggregate(plan), own).groups[0].values.count, 0);
    plan.authorize.root = () => false;
    const denied = database.tracked(db => db.table("sales").query().aggregate(plan), own);
    assert.deepEqual(denied.dependencies.map(dep => dep.table), ["sales"]);
  } finally { database.close(); }
});

test("native aggregate admission bounds rows and UTF-8 bytes before source/parent materialization", () => {
  const native = new DatabaseSync(":memory:"); const reads = [];
  const database = createSQLiteDatabase(schema(), { exec: sql => native.exec(sql), close: () => native.close(), prepare(sql) {
    const statement = native.prepare(sql);
    return new Proxy(statement, { get(target, key) { if (typeof target[key] !== "function") return target[key]; return (...args) => { if (["get", "all"].includes(key)) reads.push({ sql, key, args }); return target[key](...args); }; } });
  } });
  try {
    const parent = database.transaction(db => db.table("accounts").insert(account("parent", true, 1, "😀".repeat(100))), own);
    database.transaction(db => { db.table("sales").insert(sale(parent)); db.table("sales").insert(sale(parent)); }, own);
    database.transaction(db => { db.table("sales").insert({ ...sale(parent), extra: "😀".repeat(2000) }); db.table("accounts").insert(account("foreign", true, 1, "😀".repeat(2000))); }, foreign);
    const rootPlan = { measures: { count }, authorize: { root: () => true }, limits: { maxRows: 1 } };
    reads.length = 0;
    assert.throws(() => database.read(db => db.table("sales").query().aggregate(rootPlan), own), /source row capacity/u);
    assert.equal(reads.filter(row => row.sql.includes("_version, _data FROM")).length, 0);
    assert.ok(reads.some(row => row.sql.includes(" AS bytes") && row.args.at(-1) === 2));
    const rootBytes = Number(native.prepare('SELECT sum(length(CAST(_data AS BLOB))) AS bytes FROM clank_sales WHERE _owner_id=?').get("alice").bytes);
    reads.length = 0;
    assert.throws(() => database.read(db => db.table("sales").query().aggregate({ ...rootPlan, limits: { maxBytes: rootBytes - 1 } }), own), /JSON byte capacity/u);
    assert.equal(reads.filter(row => row.sql.includes("_version, _data FROM")).length, 0);
    reads.length = 0;
    assert.throws(() => database.read(db => db.table("sales").query().aggregate({ ...options(), limits: { maxBytes: rootBytes + 200 } }), own), /JSON byte capacity/u);
    assert.equal(reads.filter(row => row.sql.includes('_version, _data FROM "clank_accounts"')).length, 0);
    assert.ok(reads.some(row => row.sql.includes(' AS bytes FROM "clank_accounts"') && row.args[1] === "alice"));
    reads.length = 0;
    assert.equal(database.read(db => db.table("sales").query().aggregate({ ...options(), limits: { maxBytes: 1024, maxRelated: 1 } }), own).groups[0].values.count, 2);
    assert.equal(reads.filter(row => row.sql.includes('_version, _data FROM "clank_accounts"')).length, 1, "repeated references decode once");
  } finally { database.close(); }
});

test("aggregate capacities reject without partial totals and include distinct missing references", async () => {
  const database = await openSQLite(schema());
  try {
    const ids = database.transaction(db => [db.table("sales").insert(sale("missing_one", 1, true, "a")), db.table("sales").insert(sale("missing_two", 2, true, "b"))], own);
    const plain = { measures: { count, total: sum }, authorize: { root: () => true } };
    for (const plan of [{ ...options(), limits: { maxRelated: 1 } }, { ...plain, groupBy: { source: "root", field: "tag" }, limits: { maxGroups: 1 } }, { ...plain, limits: { maxOutputBytes: 1 } }]) {
      assert.throws(() => database.read(db => db.table("sales").query().aggregate(plan), own), /capacity/u);
    }
    database.transaction(db => db.table("sales").patch(ids[0], { amount: Number.MAX_SAFE_INTEGER }), own);
    assert.throws(() => database.read(db => db.table("sales").query().aggregate(plain), own), /numeric capacity/u);
    database.transaction(db => { for (const id of ids) db.table("sales").patch(id, { amount: Number.MAX_VALUE }); }, own);
    assert.throws(() => database.read(db => db.table("sales").query().aggregate(plain), own), /numeric capacity/u);
  } finally { database.close(); }
});

test("aggregate declarations fail closed for unknown, inherited, malformed and excessive plans", async () => {
  const database = await openSQLite(schema());
  try {
    const plain = { measures: { count }, authorize: { root: () => true } };
    const invalid = [null, { ...plain, unknown: true }, { ...plain, joins: { root: { table: "accounts", via: "account" } } },
      { ...plain, authorize: {} }, { ...plain, authorize: Object.create({ root: () => true }) }, { ...plain, joins: { a: { table: "constructor", via: "account" } } },
      { ...plain, joins: { a: { table: "other", via: "account" } } }, { ...plain, joins: { a: { table: "accounts", via: "tag" } } },
      { ...plain, measures: { x: { count: true, sum: { source: "root", field: "amount" } } } }, { ...plain, measures: {} },
      { ...plain, measures: { x: { count: false } } }, { ...plain, measures: { x: { sum: { source: "root", field: "tag" } } } },
      { ...plain, groupBy: { source: "root", field: "extra" } }, { ...plain, groupBy: { source: "root", field: "constructor" } },
      { ...plain, measures: { x: { sum: { source: "missing", field: "amount" } } } },
      { ...plain, limits: { maxRows: 10001 } }, { ...plain, limits: { maxRows: -1 } }, { ...plain, limits: { maxRows: null } }, { ...plain, limits: { ignored: 2 } },
      { ...plain, measures: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`n${index}`, count])) },
      { ...plain, joins: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`j${index}`, { table: "accounts", via: "account" }])) },
      { ...plain, measures: { ["x".repeat(65)]: count } }, { ...plain, [Symbol("hidden")]: true },
      Object.defineProperty({ ...plain }, "limits", { enumerable: true, get() { throw new Error("getter must not run"); } })];
    for (const plan of invalid) assert.throws(() => database.read(db => db.table("sales").query().aggregate(plan), own), /aggregate|Aggregate|Unknown/u);
    assert.throws(() => database.read(db => db.table("sales").query().limit(1).aggregate(plain), own), /limit/u);
    assert.throws(() => database.read(db => { let query = db.table("sales").query(); for (let i = 0; i < 33; i++) query = query.where("allowed", true); return query.aggregate(plain); }, own), /32 filters/u);
    assert.throws(() => database.read(db => db.table("constructor")), /Unknown table/u);
    assert.throws(() => database.read(db => db.table("sales").query().where("constructor", "x")), /Unknown field/u);
    assert.throws(() => defineTable({ actual: s.string() }).index("bad", ["constructor"]), /Unknown field/u);
    const literal = defineTable({ constructor: s.string(), toString: s.number() }).index("constructor", ["constructor"]);
    const special = await openSQLite(defineDatabase({ constructor: literal }));
    try { special.transaction(db => db.table("constructor").insert({ constructor: "literal", toString: 3 })); assert.equal(special.read(db => db.table("constructor").query().where("constructor", "literal").aggregate({ measures: { toString: { sum: { source: "root", field: "toString" } } }, authorize: { root: () => true } })).groups[0].values.toString, 3); } finally { special.close(); }
  } finally { database.close(); }
});

test("aggregate numeric/nullable/default contracts and Unicode output bounds", async () => {
  const tables = defineDatabase({ rows: defineTable({ total: s.default(s.nullable(s.number()), null), key: s.literal(null), text: s.string() }) });
  const database = await openSQLite(tables);
  try {
    const ids = database.transaction(db => [db.table("rows").insert({ key: null, text: "😀".repeat(100) }), db.table("rows").insert({ key: null, text: "small", total: 0.1 }), db.table("rows").insert({ key: null, text: "small", total: 0.2 })]);
    const plan = { measures: { count, total: { sum: { source: "root", field: "total" } } }, groupBy: { source: "root", field: "key" }, authorize: { root: () => true } };
    assert.deepEqual(database.read(db => db.table("rows").query().aggregate(plan)).groups, [{ group: null, values: { count: 3, total: 0.1 + 0.2 } }]);
    assert.throws(() => database.read(db => db.table("rows").query().aggregate({ ...plan, groupBy: { source: "root", field: "text" }, limits: { maxOutputBytes: 300 } })), /output byte capacity/u);
    database.transaction(db => { db.table("rows").patch(ids[0], { total: 0.5 }); db.table("rows").patch(ids[1], { total: Number.MAX_VALUE }); db.table("rows").patch(ids[2], { total: Number.MAX_VALUE }); });
    assert.throws(() => database.read(db => db.table("rows").query().aggregate(plan)), /numeric capacity/u);
  } finally { database.close(); }
});

test("aggregate snapshot remains consistent across a real concurrent WAL commit and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-aggregates-")); const path = join(directory, "data.sqlite");
  let database = await openSQLite(schema(), { path, changePollIntervalMs: 0 });
  try {
    const parent = database.transaction(db => db.table("accounts").insert(account("before", true, 2)), own);
    database.transaction(db => db.table("sales").insert(sale(parent, 3)), own);
    const plan = options(); let written = false;
    plan.authorize.root = () => {
      if (!written) {
        written = true;
        const script = `import { defineDatabase, defineTable, s, openSQLite } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/index.js")).href)}; ${schema.toString()} const db=await openSQLite(schema(),{path:process.argv[1],changePollIntervalMs:0}); try { db.transaction(writer=>writer.table('accounts').patch(process.argv[2],{label:'after'}),{userId:'alice'}); } finally { db.close(); }`;
        const writer = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, path, parent], { encoding: "utf8", timeout: 10000 });
        assert.equal(writer.status, 0, writer.stderr);
      }
      return true;
    };
    assert.equal(database.read(db => db.table("sales").query().aggregate(plan), own).groups[0].group, "before");
    const after = database.read(db => db.table("sales").query().aggregate(options()), own);
    assert.equal(after.groups[0].group, "after");
    database.close(); database = await openSQLite(schema(), { path, changePollIntervalMs: 0 });
    assert.deepEqual(database.read(db => db.table("sales").query().aggregate(options()), own), after);
  } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
});

test("authorized aggregate live queries track related/ACL IDs selectively and stop on session revocation", async () => {
  for (const maxCacheEntries of [0, 1]) {
    const auth = defineAuth({ password: { minLength: 8, cost: 1024, maxMemory: 4 * 1024 * 1024 } }); let runs = 0;
    const definition = defineBackend({ schema: schema(), auth }).functions(({ query }) => ({
      total: query({ args: { acl: s.id("acl") }, handler: ({ db }, args) => { runs++; const plan = options(); plan.authorize.account = (row, scoped) => row.allowed && scoped.table("acl").get(args.acl)?.allowed === true; return db.table("sales").query().aggregate(plan); } }),
      other: query({ args: {}, handler: ({ db }) => db.table("other").collect() }),
    }));
    const errors = [], runtime = await openBackend(definition, { maxCacheEntries, agent: false, onError: error => errors.push(error) }); const cleanups = [];
    try {
      const response = await runtime.handle(new Request("https://aggregate.test/__clank/auth/register", { method: "POST", headers: { "content-type": "application/json", origin: "https://aggregate.test", "x-clank-client-ip": "127.0.0.1" }, body: JSON.stringify({ email: `aggregate-${maxCacheEntries}@example.com`, password: "correct horse battery staple", profile: { name: "Alice" } }) }));
      assert.equal(response.status, 201);
      const caller = await runtime.caller(new Request("https://aggregate.test/", { headers: { cookie: response.headers.get("set-cookie").split(";", 1)[0] } }));
      const scope = { userId: caller.auth.user.id };
      const [parent, unused] = runtime.database.transaction(db => [db.table("accounts").insert(account()), db.table("accounts").insert(account("unused"))], scope);
      const [acl, unusedAcl] = runtime.database.transaction(db => [db.table("acl").insert({ allowed: true }), db.table("acl").insert({ allowed: true })]);
      const root = runtime.database.transaction(db => db.table("sales").insert(sale(parent, 3)), scope);
      const values = [];
      cleanups.push(caller.subscribe("total", { acl }, value => values.push(value)));
      caller.query("other", {}); // Evict the aggregate cache when maxCacheEntries is one.
      const initialRuns = runs;
      runtime.database.transaction(db => { db.table("accounts").patch(unused, { weight: 20 }); db.table("acl").patch(unusedAcl, { allowed: false }); db.table("other").insert({ value: 1 }); });
      runtime.database.transaction(db => { db.table("sales").insert(sale(null, 999)); db.table("accounts").insert(account("foreign")); }, foreign);
      assert.equal(runs, initialRuns); assert.equal(values.length, 1);
      runtime.database.transaction(db => db.table("accounts").patch(parent, { weight: 7 }), scope);
      assert.equal(values.at(-1).groups[0].values.weight, 7);
      runtime.database.transaction(db => db.table("acl").patch(acl, { allowed: false }));
      assert.deepEqual(values.at(-1).groups, []);
      runtime.database.transaction(db => db.table("acl").patch(acl, { allowed: true }));
      assert.equal(values.at(-1).groups[0].values.total, 3);
      runtime.database.transaction(db => db.table("sales").patch(root, { amount: 4 }), scope);
      assert.equal(values.at(-1).groups[0].values.total, 4);
      const before = values.length;
      runtime.auth.revokeUserSessions(caller.auth.user.id);
      assert.throws(() => caller.query("total", { acl }), /authentication|session/iu);
      runtime.database.transaction(db => db.table("sales").patch(root, { amount: 5 }), scope);
      assert.equal(values.length, before, "revoked subscribers receive no later protected aggregate");
    } finally { for (const cleanup of cleanups) cleanup(); runtime.close(); }
  }
});
