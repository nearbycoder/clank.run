import type { SQLiteInternal } from "./sqlite-internal.ts";

/** @internal Schema identity is separate from per-session policy and enablement. */
export const shadowSchemaIdentity = "clank-platform-shadow/1";

/** @internal Read only: protocol-three startup must never reconstruct missing state. */
export function assertProviderShadowSchema(connection: Pick<SQLiteInternal, "prepare">): string {
  const invalid = (): never => { const error = new Error("Retained shadow schema is missing or invalid; preserve it for recovery."); Object.assign(error, { code: "SUPERVISOR_SHADOW_SCHEMA" }); throw error; };
  const schemas = {
    clank_platform_shadow_state: ["singleton:INTEGER:0:1", "protocol:INTEGER:1:0", "enrollment_id:TEXT:1:0", "schema_id:TEXT:1:0"],
    clank_platform_shadow_reports: ["project_id:TEXT:1:1", "session_id:TEXT:1:2", "idempotency_key_digest:TEXT:1:0", "input_digest:TEXT:1:0", "receipt_json:TEXT:1:0", "report_json:TEXT:0:0"],
  };
  const tables = connection.prepare("PRAGMA table_list").all();
  for (const [name, expected] of Object.entries(schemas)) {
    if (!tables.some(table => table.schema === "main" && table.name === name && table.type === "table" && table.strict === 1)) invalid();
    const columns = connection.prepare(`PRAGMA main.table_info(${name})`).all();
    if (columns.length !== expected.length || columns.some((column, index) => `${column.name}:${column.type}:${column.notnull}:${column.pk}` !== expected[index])) invalid();
  }
  if (!tables.some(table => table.schema === "main" && table.name === "clank_platform_provider_canaries" && table.type === "table")) invalid();
  const candidateColumns = connection.prepare("PRAGMA main.table_info(clank_platform_provider_canaries)").all();
  const expectedCandidateColumns = ["project_id:TEXT:0:1", "protocol:INTEGER:1:0", "epoch:INTEGER:1:0", "operation:TEXT:1:0", "updated_at:INTEGER:1:0"];
  if (candidateColumns.length !== expectedCandidateColumns.length || candidateColumns.some((column, index) => `${column.name}:${column.type}:${column.notnull}:${column.pk}` !== expectedCandidateColumns[index])) invalid();
  const indices = connection.prepare("PRAGMA main.index_list(clank_platform_shadow_reports)").all();
  if (!indices.some(index => {
    if (index.unique !== 1 || index.partial !== 0 || typeof index.name !== "string") return false;
    const columns = connection.prepare(`PRAGMA main.index_info("${index.name.replaceAll('"', '""')}")`).all();
    return columns.length === 2 && columns[0].name === "project_id" && columns[1].name === "idempotency_key_digest";
  })) invalid();
  const projects = connection.prepare("PRAGMA main.table_info(clank_platform_projects)").all();
  const releases = connection.prepare("PRAGMA main.table_info(clank_platform_releases)").all();
  if (!projects.some(column => column.name === "provider_canary_epoch" && column.type === "INTEGER" && column.notnull === 1 && column.dflt_value === "0")
    || !projects.some(column => column.name === "shadow_replay_receipt" && column.type === "TEXT" && column.notnull === 0)
    || !releases.some(column => column.name === "purpose" && column.type === "TEXT" && column.notnull === 1 && column.dflt_value === "'deployment'")
    || !releases.some(column => column.name === "upload_request_digest" && column.type === "TEXT" && column.notnull === 0)) invalid();
  const rows = connection.prepare("SELECT * FROM clank_platform_shadow_state LIMIT 2").all();
  const row = rows[0];
  if (rows.length !== 1 || row.singleton !== 1 || row.protocol !== 1 || row.schema_id !== shadowSchemaIdentity
    || typeof row.enrollment_id !== "string" || !/^[a-f0-9]{64}$/u.test(row.enrollment_id)) invalid();
  return row.enrollment_id as string;
}
