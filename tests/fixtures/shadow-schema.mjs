import { randomBytes } from 'node:crypto';

// Native minimal schema for the private protocol guard; no shadow session or
// provider runtime is started by these capability tests.
export function prepareShadowSchema(sql) {
  sql.exec(`CREATE TABLE clank_platform_projects(id TEXT PRIMARY KEY,provider_canary_epoch INTEGER NOT NULL DEFAULT 0,shadow_replay_receipt TEXT) STRICT;
    CREATE TABLE clank_platform_releases(id TEXT PRIMARY KEY,purpose TEXT NOT NULL DEFAULT 'deployment',upload_request_digest TEXT) STRICT;
    CREATE TABLE clank_platform_provider_canaries(project_id TEXT PRIMARY KEY,protocol INTEGER NOT NULL,epoch INTEGER NOT NULL,operation TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE clank_platform_shadow_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL,
      enrollment_id TEXT NOT NULL,schema_id TEXT NOT NULL) STRICT;
    CREATE TABLE clank_platform_shadow_reports(project_id TEXT NOT NULL,session_id TEXT NOT NULL,idempotency_key_digest TEXT NOT NULL,
      input_digest TEXT NOT NULL,receipt_json TEXT NOT NULL,report_json TEXT,PRIMARY KEY(project_id,session_id),UNIQUE(project_id,idempotency_key_digest)) STRICT;`);
  sql.prepare('INSERT INTO clank_platform_shadow_state VALUES(1,1,?,?)').run(randomBytes(32).toString('hex'),'clank-platform-shadow/1');
}
