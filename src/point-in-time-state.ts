import type { SQLiteCaptureConnection } from "./sqlite-internal.ts";
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
/** Canonical logical seal used both before commit and after changeset replay. */
export function sealPointInTimeState(connection: Pick<SQLiteCaptureConnection, "prepare">,
  createHash: (algorithm: string) => { update(value: string): unknown; digest(encoding: "hex"): string }, maximum: number): string {
  const digest = createHash("sha256"); let bytes = 0;
  const tables = connection.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB 'clank_pitr_*' ORDER BY name").all();
  for (const definition of tables) {
    const name = String(definition.name);
    if (/CREATE\s+VIRTUAL\s+TABLE/iu.test(String(definition.sql))) throw new Error("Recovery does not support virtual tables.");
    const columns = connection.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
    const primary = columns.filter((column) => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
    if (!primary.length || columns.some((column) => Number(column.hidden) !== 0)) throw new Error(`Recovery does not support tables without primary keys or with generated/hidden columns: ${name}.`);
    if (connection.prepare(`SELECT 1 AS found FROM ${quote(name)} WHERE ${primary.map((column) => `${quote(String(column.name))} IS NULL`).join(" OR ")} LIMIT 1`).get()) throw new Error(`Recovery requires non-null primary keys: ${name}.`);
    const rows = connection.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${primary.map((column) => `${quote(String(column.name))} COLLATE BINARY`).join(",")} LIMIT 200001`).all();
    if (rows.length > 200000) throw new Error("Recovery state exceeds its row bound.");
    digest.update(name); digest.update("\0");
    for (const row of rows) {
      const encoded = JSON.stringify(row, (_key, value) => value instanceof Uint8Array ? { $blob: Array.from(value) } : value);
      bytes += new TextEncoder().encode(encoded).byteLength;
      if (bytes > maximum) throw new Error("Recovery state exceeds maxStateBytes.");
      digest.update(encoded); digest.update("\n");
    }
  }
  const sequences = connection.prepare("SELECT 1 AS found FROM sqlite_schema WHERE name='sqlite_sequence'").get()
    ? connection.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all() : [];
  digest.update(JSON.stringify(sequences));
  return digest.digest("hex");
}
