import { openBackend, type BackendDefinition } from "./backend.ts";
import type { AppFixture } from "./blueprint.ts";
import { SQLITE_INTERNAL } from "./sqlite-internal.ts";
import { applyMigrations, backupSQLite } from "./migrations.ts";

/** Build a fresh synthetic fixture database without opening any application/production data. */
export async function createPreviewFixture(definition: BackendDefinition<any, any, any, any>, fixture: AppFixture,
  options: { outputPath: string; password: string; migrations?: string }): Promise<{ protocol: "clank-preview-fixture/1"; users: number; records: number; bytes: number }> {
  if (fixture?.protocol !== "clank-fixture/1" || !fixture.users || !fixture.records) throw new TypeError("A clank-fixture/1 document is required.");
  if (JSON.stringify(fixture).length > 1_048_576) throw new RangeError("Fixture metadata exceeds 1 MiB.");
  if (typeof options.password !== "string" || options.password.length < 12) throw new TypeError("Use a fixture password of at least 12 characters.");
  const users = Object.entries(fixture.users);
  const pending = Object.entries(fixture.records).flatMap(([table, rows]) => Object.entries(rows).map(([name, record]) => ({ table, name, record })));
  if (users.length > 20 || pending.length > 10_000) throw new RangeError("A fixture supports at most 20 users and 10000 records.");
  for (const [, user] of users) {
    if (typeof user.email !== "string" || !/@(?:[a-z0-9-]+\.)*example\.invalid$/i.test(user.email)) throw new TypeError("Fixture identities must use example.invalid addresses.");
  }
  const fsName = "node:fs/promises", osName = "node:os", pathName = "node:path";
  const fs = await import(fsName), os = await import(osName), path = await import(pathName);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clank-preview-fixture-"));
  await fs.chmod(root, 0o700);
  const databasePath = path.join(root, "fixture.sqlite");
  const snapshotPath = path.join(root, "snapshot.sqlite");
  let runtime: Awaited<ReturnType<typeof openBackend>> | undefined;
  try {
    if (options.migrations) await applyMigrations({ path: databasePath, directory: options.migrations });
    runtime = await openBackend(definition, { path: databasePath, agent: false, changePollIntervalMs: 0 });
    const identities = new Map<string, string>();
    for (const [name, user] of users) {
      if (!runtime.auth) throw new TypeError("Fixture users require an authenticated backend.");
      const response = await runtime.handle(new Request("https://fixture.example.invalid/__clank/auth/register", {
        method: "POST", headers: { "content-type": "application/json", origin: "https://fixture.example.invalid" },
        body: JSON.stringify({ email: user.email, password: options.password, profile: user.profile }),
      }));
      const registered = await response.json() as { user?: { id: string } };
      if (response.status !== 201 || !registered.user) throw new Error("Fixture registration failed; check the application's auth policy.");
      runtime.auth.setRole(registered.user.id as any, user.role);
      identities.set(name, registered.user.id);
    }
    const created = new Map<string, unknown>();
    while (pending.length) {
      let progressed = false;
      for (let index = 0; index < pending.length;) {
        const { table, name, record } = pending[index]!;
        const owner = identities.get(record.owner);
        if (!Object.hasOwn(definition.schema.tables, table)) throw new TypeError("Fixture names an unknown table.");
        if (!owner && (users.length || definition.schema.tables[table].ownership === "user")) throw new TypeError("Fixture record names an unknown owner.");
        const values: Record<string, unknown> = Object.create(null);
        let ready = true;
        for (const [field, value] of Object.entries(record.values)) {
          if (value !== null && typeof value === "object") {
            if (Object.keys(value).length !== 1 || typeof value.ref !== "string") throw new TypeError("Fixture object values must be record references.");
            if (!created.has(value.ref)) { ready = false; break; }
            values[field] = created.get(value.ref);
          } else values[field] = value;
        }
        if (!ready) { index++; continue; }
        const id = runtime.database.transaction((db) => db.table(table).insert(values), owner ? { userId: owner } : undefined);
        created.set(`${table}.${name}`, id);
        pending.splice(index, 1); progressed = true;
      }
      if (!progressed) throw new TypeError("Fixture references contain a cycle or missing record.");
    }
    const internal = runtime.database[SQLITE_INTERNAL];
    // Registration sessions are temporary; fixture users sign in with the supplied password.
    if (internal.prepare("SELECT 1 FROM sqlite_master WHERE name = 'clank_auth_sessions'").get()) internal.exec("DELETE FROM clank_auth_sessions");
    internal.exec("CREATE TABLE clank_preview_fixture(protocol TEXT NOT NULL, users INTEGER NOT NULL, records INTEGER NOT NULL)");
    internal.prepare("INSERT INTO clank_preview_fixture VALUES ('clank-preview-fixture/1', ?, ?)").run(users.length, created.size);
    await backupSQLite(databasePath, snapshotPath);
    const bytes = await fs.readFile(snapshotPath);
    if (bytes.byteLength > 32 * 1024 * 1024) throw new RangeError("Preview fixture exceeds 32 MiB.");
    await fs.writeFile(options.outputPath, bytes, { flag: "wx", mode: 0o600 });
    return { protocol: "clank-preview-fixture/1", users: users.length, records: created.size, bytes: bytes.byteLength };
  } finally { runtime?.close(); await fs.rm(root, { recursive: true, force: true }); }
}
