import { SQLITE_INTERNAL } from "./sqlite-internal.ts";
import type { SQLiteDatabase } from "./backend.ts";
import { RequestInputError } from "./security.ts";

export interface MutationReceiptOptions {
  /** Successful keys remain usable for this window; older keys are rejected, never rerun. Default 7 days. */
  retentionMs?: number;
  /** Bound successful receipts across the application. Default 10000. */
  maxEntries?: number;
}

export function openMutationReceipts(database: SQLiteDatabase<any>, options: MutationReceiptOptions) {
  const retention = options.retentionMs ?? 7 * 86_400_000;
  const maximum = options.maxEntries ?? 10_000;
  if (!Number.isSafeInteger(retention) || retention < 60_000 || retention > 30 * 86_400_000
    || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100_000) throw new TypeError("Invalid mutation receipt limits.");
  const sql = database[SQLITE_INTERNAL];
  sql.exec(`CREATE TABLE IF NOT EXISTS clank_mutation_receipts (
    owner TEXT NOT NULL, key TEXT NOT NULL, path TEXT NOT NULL, input TEXT NOT NULL,
    output TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(owner, key))`);
  sql.exec("CREATE INDEX IF NOT EXISTS clank_mutation_receipts_expiry ON clank_mutation_receipts(expires)");
  sql.exec("CREATE TABLE IF NOT EXISTS clank_mutation_receipt_policy (id INTEGER PRIMARY KEY CHECK(id = 1), retention INTEGER NOT NULL)");
  sql.prepare("INSERT OR IGNORE INTO clank_mutation_receipt_policy(id, retention) VALUES (1, ?)").run(retention);
  if (Number(sql.prepare("SELECT retention FROM clank_mutation_receipt_policy WHERE id = 1").get()!.retention) !== retention) throw new TypeError("Mutation receipt retention cannot change after initialization; existing keys depend on it.");
  return (key: string, owner: string, path: string, input: string, execute: () => unknown): unknown => {
    if (!sql.inTransaction) throw new Error("Mutation receipts require the application write transaction.");
    const match = /^(\d{13})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(key);
    const issued = Number(match?.[1]);
    const now = Date.now();
    if (!match || issued > now + 60_000) throw new RequestInputError(400, "INVALID_MUTATION_KEY", "Invalid offline mutation key.");
    if (issued + retention <= now) throw new RequestInputError(410, "MUTATION_KEY_EXPIRED", "Offline mutation expired; reconcile its result before creating another.");
    sql.prepare("DELETE FROM clank_mutation_receipts WHERE expires <= ?").run(now);
    const previous = sql.prepare("SELECT path, input, output, expires FROM clank_mutation_receipts WHERE owner = ? AND key = ?").get(owner, key);
    if (previous) {
      if (previous.path !== path || previous.input !== input) throw new RequestInputError(409, "MUTATION_KEY_REUSED", "Mutation key was already used for different input.");
      return JSON.parse(String(previous.output)).value;
    }
    if (Number(sql.prepare("SELECT count(*) AS n FROM clank_mutation_receipts").get()!.n) >= maximum
      || Number(sql.prepare("SELECT count(*) AS n FROM clank_mutation_receipts WHERE owner = ?").get(owner)!.n) >= Math.min(maximum, 1000)) {
      throw new RequestInputError(503, "MUTATION_RECEIPTS_FULL", "Offline mutation capacity is temporarily full.");
    }
    const value = execute();
    const output = JSON.stringify({ value });
    if (new TextEncoder().encode(output).byteLength > 65536) throw new RequestInputError(413, "MUTATION_RESULT_TOO_LARGE", "Offline mutation results must fit in 64 KiB.");
    sql.prepare("INSERT INTO clank_mutation_receipts(owner, key, path, input, output, expires) VALUES (?, ?, ?, ?, ?, ?)")
      .run(owner, key, path, input, output, issued + retention);
    return value;
  };
}
