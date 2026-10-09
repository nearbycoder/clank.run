import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { openSQLite, defineDatabase } from '../dist/backend.js';
import { SQLITE_INTERNAL } from '../dist/sqlite-internal.js';
import { forecastUsage } from '../dist/usage-forecast.js';
import { openAuditExporter, verifyAuditExport } from '../dist/audit-export.js';

test('usage forecasts expose rate, exhaustion time, observation limits and actual warning thresholds', () => {
  const base = { used: 60, limit: 100, periodStartedAt: 0, periodEndsAt: 10_000, asOf: 5000, minimumObservationMs: 1000 };
  const projected = forecastUsage(base);
  assert.equal(projected.status, 'projected_exhaustion'); assert.equal(projected.projectedTotal, 120); assert.equal(projected.exhaustionAt, 8334);
  assert.equal(forecastUsage({ ...base, trackingStartedAt: 4999 }).status, 'insufficient_data');
  assert.equal(forecastUsage({ ...base, used: 90, trackingStartedAt: 4999 }).status, 'warning');
  assert.equal(forecastUsage({ ...base, used: 100 }).status, 'exhausted');
  assert.equal(forecastUsage({ ...base, used: 0 }).exhaustionAt, null);
  assert.equal(forecastUsage({ ...base, used: 10, asOf: 20_000 }).projectedTotal, 10);
  assert.throws(() => forecastUsage({ ...base, periodEndsAt: -1 }), /Invalid/);
});

test('audit exports survive delivery failures, verify independent checkpoints, and detect omissions/tampering', async () => {
  const database = await openSQLite(defineDatabase({}), { path: ':memory:' });
  const internal = database[SQLITE_INTERNAL];
  internal.exec(`CREATE TABLE clank_platform_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_user_id TEXT,actor_token_id TEXT,project_id TEXT,organization_id TEXT,action TEXT,metadata TEXT,created_at INTEGER)`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const keys = { key1: publicKey.export({ format: 'pem', type: 'spki' }) };
  let fail = true; const attempts = [];
  const exporter = await openAuditExporter(internal, { keyId: 'key1', privateKey: pem, destination: async (batch) => { attempts.push(batch); if (fail) throw new Error('independent storage unavailable'); } });
  const insert = (action) => internal.prepare('INSERT INTO clank_platform_audit(actor_user_id,action,metadata,created_at) VALUES(?,?,?,?)').run('actor', action, '{"ok":true}', Date.now());
  try {
    insert('first'); insert('second');
    await assert.rejects(exporter.flush(), /unavailable/);
    assert.equal(exporter.status().pending, 2); assert.equal(exporter.status().exportedThrough.sequence, 0);
    fail = false; assert.equal(await exporter.flush(), 2);
    assert.deepEqual(attempts[0], attempts[1]);
    const checkpoint = await verifyAuditExport(attempts[1], keys);
    assert.equal(checkpoint.sequence, 2);
    assert.deepEqual(exporter.status().exportedThrough, checkpoint);
    insert('third'); await exporter.flush();
    assert.equal((await verifyAuditExport(attempts[2], keys, checkpoint)).sequence, 3);
    await assert.rejects(verifyAuditExport([attempts[1][1]], keys), /missing|reordered/);
    const tampered = structuredClone(attempts[1]); tampered[0].event.action = 'forged';
    await assert.rejects(verifyAuditExport(tampered, keys), /signature|content/);
    const extra = structuredClone(attempts[1]); extra[0].forged = true;
    await assert.rejects(verifyAuditExport(extra, keys), /untrusted/);
    insert('missing'); insert('fifth'); internal.prepare('DELETE FROM clank_platform_audit WHERE id=4').run();
    await assert.rejects(exporter.flush(), /missing events/);
  } finally { await exporter.close(); database.close(); }
});

test('operational alerts persist retries, deduplicate unchanged conditions and preserve incident delivery order', async () => {
  const { createOperationalMonitor } = await import('../dist/operations-monitor.js');
  const database = await openSQLite(defineDatabase({}), { path: ':memory:' });
  const internal = database[SQLITE_INTERNAL];
  let active = true, fail = true;
  const delivered = [], attempted = [];
  const monitor = createOperationalMonitor(internal, { intervalMs: false, notify: async (alert) => {
    attempted.push(alert); if (fail) throw new Error('destination unavailable'); delivered.push(alert);
  } }, async () => [{ key: 'backup:project', kind: 'backup_failed', active, severity: 'critical', resourceId: 'project', message: 'Backup failed.' }]);
  try {
    await monitor.runOnce(); await monitor.runOnce();
    assert.equal(attempted.length, 1, 'unchanged state and retry backoff do not send again');
    active = false; await monitor.runOnce();
    assert.equal(attempted.length, 1, 'resolution cannot overtake the failed open notification');
    fail = false; internal.exec('UPDATE clank_operational_deliveries SET next_at=0');
    await monitor.runOnce();
    assert.deepEqual(delivered.map((entry) => entry.state), ['open', 'resolved']);
    assert.equal(attempted[0].id, delivered[0].id);
    assert.equal(monitor.list()[0].state, 'resolved');
    await monitor.runOnce(); assert.equal(delivered.length, 2);
  } finally { await monitor.close(); database.close(); }
});

test('scheduled restore drills decrypt a real backup, boot the disposable application, and retain receipts', async () => {
  const { createOperationalMonitor } = await import('../dist/operations-monitor.js');
  const { openBackupManager } = await import('../dist/recovery.js');
  const { rehearseRecovery } = await import('../dist/rehearsal.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'clank-auto-drill-'));
  const source = join(root, 'source.sqlite');
  const native = new DatabaseSync(source); native.exec("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('backed up');");
  const database = await openSQLite(defineDatabase({}), { path: ':memory:' });
  const internal = database[SQLITE_INTERNAL];
  internal.exec("CREATE TABLE clank_platform_projects(id TEXT PRIMARY KEY,database_path TEXT,active_release_id TEXT); INSERT INTO clank_platform_projects VALUES('project','source.sqlite','release');");
  const manager = await openBackupManager({ databasePath: source, repositoryDirectory: join(root, 'backups'), encryptionKey: new Uint8Array(32).fill(4) });
  let boots = 0;
  const boot = ({ databasePath }) => {
    assert.notEqual(databasePath, source); boots++;
    const restored = new DatabaseSync(databasePath);
    return { handle: () => new Response(String(restored.prepare('SELECT value FROM records').get().value)), close: () => restored.close() };
  };
  const monitor = createOperationalMonitor(internal, { intervalMs: false, restoreDrills: { boot: (_project, context) => boot(context) } }, async () => [], async () => {
    const latest = (await manager.list())[0];
    return rehearseRecovery({ source: { manager, backupId: latest.id }, boot, checks: [{ name: 'restored data', path: '/healthz', includes: 'backed up' }] });
  });
  try {
    await manager.create(); native.exec("UPDATE records SET value='production changed'");
    await monitor.runOnce(); await monitor.runOnce();
    assert.equal(boots, 1); assert.equal(monitor.drills()[0].report.ok, true);
    assert.equal(native.prepare('SELECT value FROM records').get().value, 'production changed');
    assert.equal(monitor.list()[0].state, 'resolved');
  } finally { await monitor.close(); manager.close(); native.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});


test('audit destination cancellation bounds shutdown even when a callback ignores its signal', async () => {
  const database = await openSQLite(defineDatabase({}), { path: ':memory:' });
  const internal = database[SQLITE_INTERNAL];
  internal.exec(`CREATE TABLE clank_platform_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_user_id TEXT,actor_token_id TEXT,project_id TEXT,organization_id TEXT,action TEXT,metadata TEXT,created_at INTEGER); INSERT INTO clank_platform_audit(action,metadata,created_at) VALUES('first','{}',0)`);
  const { privateKey } = generateKeyPairSync('ed25519');
  const exporter = await openAuditExporter(internal, { keyId: 'test', privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), destination: async () => new Promise(() => {}), timeoutMs: 100 });
  try {
    const pending = exporter.flush(); const rejected = assert.rejects(pending, /cancelled|deadline/);
    await exporter.close(); await rejected;
    assert.equal(exporter.status().exportedThrough.sequence, 0); assert.equal(exporter.status().pending, 1);
  } finally { await exporter.close(); database.close(); }
});

test('audit capture capacity still delivers pending entries and held acknowledgements apply backpressure', async () => {
  const database = await openSQLite(defineDatabase({}), { path: ':memory:' }), internal = database[SQLITE_INTERNAL];
  internal.exec("CREATE TABLE clank_platform_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_user_id TEXT,actor_token_id TEXT,project_id TEXT,organization_id TEXT,action TEXT,metadata TEXT,created_at INTEGER); CREATE TABLE clank_retention_state(singleton INTEGER PRIMARY KEY,protocol INTEGER,revision INTEGER); INSERT INTO clank_retention_state VALUES(1,1,1); CREATE TABLE clank_retention_holds(kind TEXT,resource_id TEXT,scope TEXT,reason TEXT,expires_at INTEGER,version INTEGER); INSERT INTO clank_retention_holds VALUES('audit','1','org','Keep',NULL,1);");
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'), batches = []; let fail = true;
  const exporter = await openAuditExporter(internal, { keyId: 'bounded', privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), maxOutboxEntries: 1, destination: async entries => { batches.push(entries); if (fail) throw Error('Offline'); } });
  const append = action => internal.prepare("INSERT INTO clank_platform_audit(actor_user_id,action,metadata,created_at) VALUES('actor',?,'{}',0)").run(action);
  try {
    append('first'); await assert.rejects(exporter.flush(), /Offline/); append('second'); fail = false;
    assert.equal(await exporter.flush(), 1); assert.equal(exporter.status().pending, 0); assert.equal(exporter.status().retainedAcknowledged, 1);
    await assert.rejects(exporter.flush(), /retention capacity/); assert.equal(batches.length, 2);
    const checkpoint = await verifyAuditExport(batches[1], { bounded: publicKey.export({ format: 'pem', type: 'spki' }) });
    internal.prepare('DELETE FROM clank_retention_holds').run(); internal.prepare('DELETE FROM clank_audit_export_outbox WHERE sequence<=?').run(checkpoint.sequence);
    assert.equal(await exporter.flush(), 1); assert.equal((await verifyAuditExport(batches[2], { bounded: publicKey.export({ format: 'pem', type: 'spki' }) }, checkpoint)).sequence, 2);
  } finally { await exporter.close(); database.close(); }
});

test('invalid new audit events cannot starve already signed delivery and rejected error observers stay contained', async () => {
  const database = await openSQLite(defineDatabase({}), { path: ':memory:' }), internal = database[SQLITE_INTERNAL];
  internal.exec("CREATE TABLE clank_platform_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_user_id TEXT,actor_token_id TEXT,project_id TEXT,organization_id TEXT,action TEXT,metadata TEXT,created_at INTEGER); INSERT INTO clank_platform_audit(action,metadata,created_at) VALUES('first','{}',0)");
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'), batches = []; let fail = true, entered, observer;
  const observed = new Promise(resolve => { observer = resolve; });
  const exporter = await openAuditExporter(internal, { keyId: 'bounded', privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), destination: async entries => { batches.push(entries); if (fail) throw Error('Offline'); if (entered) { entered(); await new Promise(() => {}); } }, onError: () => { observer(); return Promise.reject(Error('Rejected observer')); } });
  try {
    await assert.rejects(exporter.flush(), /Offline/); fail = false;
    internal.prepare("INSERT INTO clank_platform_audit(action,metadata,created_at) VALUES('large',?,0)").run(JSON.stringify({ value: 'x'.repeat(262144) }));
    await assert.rejects(exporter.flush(), /size bound/); assert.equal(exporter.status().pending, 0); assert.equal(exporter.status().exportedThrough.sequence, 1);
    assert.equal((await verifyAuditExport(batches[1], { bounded: publicKey.export({ format: 'pem', type: 'spki' }) })).sequence, 1);
    internal.prepare("UPDATE clank_platform_audit SET metadata='{}' WHERE id=2").run(); const started = new Promise(resolve => { entered = resolve; });
    const pending = exporter.flush(), rejected = assert.rejects(pending, /cancelled|deadline/); await started; await exporter.close(); await rejected; await observed; await new Promise(resolve => setImmediate(resolve));
  } finally { await exporter.close(); database.close(); }
});
