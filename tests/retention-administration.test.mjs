import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { defineAuth } from '../dist/auth.js';
import { defineBackend, defineDatabase, defineTable, openBackend } from '../dist/backend.js';
import { s } from '../dist/ai.js';
import { SQLITE_INTERNAL } from '../dist/sqlite-internal.js';
import { openDurableImport, createDurableImportClient } from '../dist/durable-import.js';
import { openCollaborativeDocuments, createCollaborativeDocumentsClient } from '../dist/collaborative-documents.js';
import { openRetentionAdministration, createRetentionAdministrationClient } from '../dist/retention-administration.js';
const auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } });
const schema = defineDatabase({ records: defineTable({ title: s.string(), score: s.number() }).owned(), scopes: defineTable({ documentId: s.string(), scope: s.string() }).index('by_document', ['documentId']), operators: defineTable({ userId: s.string(), allowed: s.boolean() }).index('by_user', ['userId']) });
const definition = defineBackend({ schema, auth }).functions(() => ({}));
const columns = [{ source: 'name', target: 'title', type: 'text', required: true }, { source: 'points', target: 'score', type: 'number', required: true }];
const isCode = code => error => error.code === code;
const contextOperator = (db, userId) => db.table('operators').query().where('userId', userId).first()?.allowed === true;
async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clank-retention-')), path = join(root, 'app.sqlite');
  let runtime, imports, documents, retention;
  const importOptions = { path, auth, schema, table: 'records', fields: ['title', 'score'], uniqueBy: ['title'], reviewable: { duplicates: 'upsert' } };
  const documentOptions = { path, auth, schema, retainedOperations: 1, retainedReceipts: 1, authorize: ({ auth, db }, id) => db.table('scopes').query().where('documentId', id).first()?.scope === auth.user.id };
  const retentionOptions = { path, auth, schema, sources: { imports: true, collaboration: {} }, policyRevision: 'test/1', scope: ({ db }, resource) => resource.kind === 'import' ? resource.ownerId : db.table('scopes').query().where('documentId', resource.id).first()?.scope ?? null, authorize: ({ auth, db }, scope) => auth.user.id === scope && contextOperator(db, auth.user.id), ...overrides };
  const open = async () => { runtime = await openBackend(definition, { path, agent: false }); imports = await openDurableImport(importOptions); documents = await openCollaborativeDocuments(documentOptions); retention = await openRetentionAdministration(retentionOptions); };
  await open();
  const transport = (user, prefix, service) => ({ url: `https://retention.test/__clank/${prefix}`, auth: { csrfHeader: () => ({ 'x-clank-csrf': user.csrf }) }, fetch: (url, init) => service().handle(new Request(url, { ...init, headers: { ...init.headers, cookie: user.cookie, origin: 'https://retention.test' } })) });
  const operators = {
    add(userId) { runtime.database.transaction(db => { const table = db.table('operators'), row = table.query().where('userId', userId).first(); if (row) table.patch(row._id, { allowed: true }); else table.insert({ userId, allowed: true }); }); },
    delete(userId) { runtime.database.transaction(db => { const table = db.table('operators'), row = table.query().where('userId', userId).first(); if (row) table.delete(row._id); }); }
  };
  return { root, path, operators, retentionOptions, get runtime() { return runtime; }, get retention() { return retention; }, get native() { return runtime.database[SQLITE_INTERNAL]; },
    async user(email) { const response = await runtime.handle(new Request('https://retention.test/__clank/auth/register', { method: 'POST', headers: { origin: 'https://retention.test', 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery staple' }) })); assert.equal(response.status, 201); const body = await response.json(); return { id: body.user.id, cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrfToken }; },
    client(user) { return createRetentionAdministrationClient(transport(user, 'retention', () => retention)); },
    importer(user) { return createDurableImportClient({ ...transport(user, 'imports', () => imports), currentUser: () => user.id }); },
    document(user) { return createCollaborativeDocumentsClient(transport(user, 'documents', () => documents)); },
    associate(user, id) { runtime.database.transaction(db => db.table('scopes').insert({ documentId: id, scope: user.id })); },
    async restart() { retention.close(); documents.close(); imports.close(); runtime.close(); await open(); },
    async close() { retention.close(); documents.close(); imports.close(); runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
const purge = (scope, resources, maxDeletes = 1000) => ({ scope, resources, cutoff: Date.now(), maxDeletes });

test('durable holds preserve terminal import source and superseded corrections; fenced retirement expires retry identities', async () => {
  const f = await fixture();
  try {
    const a = await f.user('hold@example.invalid'), b = await f.user('other@example.invalid'); f.operators.add(a.id); f.operators.add(b.id);
    const client = f.client(a), importer = f.importer(a), job = await importer.uploadReviewableCsv(new Blob(['name,points\nLaunch,bad\n']), columns), ref = { kind: 'import', id: job.id };
    assert.equal((await client.preview(purge(a.id, [ref]))).items[0].blocked, 'active');
    const held = await client.hold(a.id, ref, 0, 'Keep incident evidence', null, 'hold');
    await importer.correctRows(job.id, 0, [{ row: 2, values: { score: 1 } }], 'fix1');
    await importer.correctRows(job.id, 1, [{ row: 2, values: { score: 2 } }], 'fix2');
    const importPreview = await importer.preview(job.id); await importer.apply(importPreview, 'apply');
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_durableImportChunks').get().n, 1);
    assert.ok(f.native.prepare("SELECT count(*) AS n FROM clank_document_revisions WHERE table_name='durableImportCorrections'").get().n >= 3);
    await f.restart();
    const inventory = await client.inventory(a.id); assert.equal(inventory.resources[0].hold.reason, 'Keep incident evidence'); assert.ok(inventory.resources[0].historyRows > 0);
    const blocked = await client.preview(purge(a.id, [ref])); assert.equal(blocked.records, 0); assert.equal(blocked.items[0].blocked, 'held');
    await assert.rejects(f.client(b).preview(purge(b.id, [ref])), error => error.status === 404);
    assert.deepEqual((await f.client(b).inventory(b.id)).resources, []);
    await client.release(a.id, ref, held.version, 'release'); await assert.rejects(client.accept(blocked, 'stale'), isCode('RETENTION_STALE'));
    const preview = await client.preview(purge(a.id, [ref])); assert.ok(preview.records > 0);
    const result = await client.accept(preview, 'retire'); await f.restart(); assert.deepEqual(await client.accept(preview, 'retire'), result);
    for (const table of ['durableImportChunks', 'durableImportCorrections']) assert.equal(f.native.prepare(`SELECT count(*) AS n FROM clank_${table}`).get().n, 0);
    assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_document_revisions WHERE table_name IN ('durableImportChunks','durableImportCorrections')").get().n, 0);
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_durableImportJobs').get().n, 1);
    assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_durableImportOperations WHERE json_extract(_data,'$.expired')=1").get().n, 3);
    await assert.rejects(importer.apply(importPreview, 'apply'), isCode('IMPORT_OPERATION_EXPIRED'));
    await assert.rejects(importer.correctRows(job.id, 0, [{ row: 2, values: { score: 1 } }], 'fix1'), isCode('IMPORT_OPERATION_EXPIRED'));
    f.operators.delete(a.id); await assert.rejects(client.accept(preview, 'retire'), error => error.status === 404);
  } finally { await f.close(); }
});

test('held collaboration receipts survive pruning; administration advances the durable retry floor without changing text', async () => {
  const f = await fixture();
  try {
    const a = await f.user('document@example.invalid'); f.operators.add(a.id); f.associate(a, 'shared');
    const d = f.document(a), c = f.client(a), ref = { kind: 'collaboration', id: 'shared' };
    await d.create('shared', 'abc'); const held = await c.hold(a.id, ref, 0, 'Preserve edits', null, 'hold-document');
    const first = { documentId: 'shared', operationId: 'first', baseRevision: 1, start: 0, deleteCount: 0, insert: 'X' }; await d.edit(first);
    await d.edit({ ...first, operationId: 'second', baseRevision: 2, start: 4, insert: 'Y' });
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_collaborativeReceipts').get().n, 2);
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_collaborativeOperations').get().n, 2);
    await f.restart(); assert.equal((await d.edit(first)).acceptedRevision, 2);
    await c.release(a.id, ref, held.version, 'release-document');
    const before = await d.read('shared'), preview = await c.preview(purge(a.id, [ref])); await c.accept(preview, 'retire-document'); await f.restart();
    assert.deepEqual(await d.read('shared'), before); await assert.rejects(d.edit(first), isCode('COLLAB_EDIT_CONFLICT'));
    const next = await d.edit({ ...first, operationId: 'next', baseRevision: before.revision, start: 0, insert: 'N' }); assert.equal(next.text, 'NXabcY');
  } finally { await f.close(); }
});

test('scheduled cleanup commits one durable occurrence, revalidates its session and pauses on revocation', async () => {
  const f = await fixture();
  try {
    const a = await f.user('schedule@example.invalid'); f.operators.add(a.id);
    const importer = f.importer(a), job = await importer.uploadReviewableCsv(new Blob(['name,points\nLaunch,1\n']), columns), ref = { kind: 'import', id: job.id }, c = f.client(a);
    const held = await c.hold(a.id, ref, 0, 'Scheduled fixture', null, 'hold'); await importer.apply(await importer.preview(job.id), 'apply'); await c.release(a.id, ref, held.version, 'release');
    const input = { id: 'daily', scope: a.id, expectedVersion: 0, kinds: ['import'], olderThanMs: 0, everyMs: 1000, maxDeletes: 1000, state: 'active' };
    const scheduled = await c.saveSchedule(input, 'schedule'); assert.deepEqual(await c.saveSchedule(input, 'schedule'), scheduled);
    f.native.prepare('UPDATE clank_retention_schedules SET next_at=0').run(); await f.restart();
    assert.equal(f.retention.runDue(), 1); assert.equal(f.retention.runDue(), 0); assert.equal((await c.schedules(a.id))[0].lastReceipt.records > 0, true);
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_durableImportChunks').get().n, 0);
    f.native.prepare('UPDATE clank_retention_schedules SET next_at=0').run(); f.native.prepare('DELETE FROM clank_auth_sessions WHERE user_id=?').run(a.id);
    assert.equal(f.retention.runDue(), 0); const row = f.native.prepare('SELECT definition,error FROM clank_retention_schedules').get(); assert.equal(JSON.parse(row.definition).state, 'paused'); assert.equal(row.error, 'RETENTION_RUN_FAILED');
  } finally { await f.close(); }
});

test('platform audit holds retain acknowledged envelopes, isolate organizations and preserve independently verified continuity', { timeout: 20000 }, async () => {
  const { openPlatform } = await import('../dist/platform.js');
  const { openSQLite } = await import('../dist/backend.js');
  const { openAuditExporter, verifyAuditExport } = await import('../dist/audit-export.js');
  const { generateKeyPairSync } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'clank-platform-retention-'));
  let platform, database, exporter;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), keys = { test: publicKey.export({ format: 'pem', type: 'spki' }) };
  const attempts = []; let fail = true;
  const auditOptions = { keyId: 'test', privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), intervalMs: 3600000, destination: async entries => { attempts.push(entries); if (fail) throw Error('Independent archive unavailable'); } };
  const settings = { dataDirectory: root, publicUrl: 'https://retention.test', signup: true, backups: { intervalMs: false }, auditExport: auditOptions, retention: { policyRevision: 'platform/1', intervalMs: false } };
  const request = (path, body, user, headers = {}) => new Request(`https://retention.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://retention.test', ...(user ? { cookie: user.cookie, 'x-clank-csrf': user.csrf } : {}), ...headers }, body: JSON.stringify(body) });
  const register = async email => { const response = await platform.handle(request('/__clank/auth/register', { email, password: 'correct horse battery staple', profile: { name: 'Operator' } })); assert.equal(response.status, 201); const data = await response.json(); return { id: data.user.id, csrf: data.csrfToken, cookie: response.headers.get('set-cookie').split(';')[0] }; };
  const organization = async (user, slug) => { const response = await platform.handle(request('/api/organizations', { name: slug, slug }, user)); assert.equal(response.status, 201); return (await response.json()).organization.id; };
  const client = user => createRetentionAdministrationClient({ url: 'https://retention.test/api/retention', auth: { csrfHeader: () => ({ 'x-clank-csrf': user.csrf }) }, fetch: (url, init) => platform.handle(new Request(url, { ...init, headers: { ...init.headers, cookie: user.cookie, origin: 'https://retention.test' } })) });
  try {
    platform = await openPlatform(settings);
    const a = await register('audit-a@example.invalid'), b = await register('audit-b@example.invalid');
    const first = await organization(a, 'audit-one'), second = await organization(b, 'audit-two');
    database = await openSQLite(defineDatabase({}), { path: join(root, 'control.sqlite') });
    const native = database[SQLITE_INTERNAL]; exporter = await openAuditExporter(native, auditOptions);
    const ref = { kind: 'audit', id: String(native.prepare('SELECT id FROM clank_platform_audit WHERE organization_id=?').get(first).id) }, scope = `organization:${first}`, c = client(a);
    const unacknowledged = await c.preview(purge(scope, [ref])); assert.equal(unacknowledged.items[0].blocked, 'unacknowledged');
    const held = await c.hold(scope, ref, 0, 'External audit investigation', null, 'audit-hold');
    await assert.rejects(client(b).inventory(scope), error => error.status === 404);
    await assert.rejects(client(b).preview(purge(`organization:${second}`, [ref])), error => error.status === 404);
    const missingCsrf = await platform.handle(request('/api/retention/mutation/release', { scope, resource: ref, expectedVersion: held.version, operationId: 'csrf' }, a, { 'x-clank-csrf': '' })); assert.equal(missingCsrf.status, 403);
    await assert.rejects(exporter.flush(), /archive unavailable/); assert.ok(exporter.status().pending >= 2);
    fail = false; const acknowledged = await exporter.flush(); assert.ok(acknowledged >= 2);
    const checkpoint = await verifyAuditExport(attempts.at(-1), keys); assert.deepEqual(exporter.status().exportedThrough, checkpoint);
    assert.equal(exporter.status().pending, 0); assert.equal(exporter.status().retainedAcknowledged, 1);
    const deliveries = attempts.length; assert.equal(await exporter.flush(), 0); assert.equal(attempts.length, deliveries, 'a held acknowledged envelope is not delivered again');
    await platform.close(); platform = await openPlatform(settings);
    assert.equal((await c.inventory(scope)).resources[0].hold.active, true);
    await c.release(scope, ref, held.version, 'audit-release'); const preview = await c.preview(purge(scope, [ref])); assert.equal(preview.records, 2);
    const receipt = await c.accept(preview, 'audit-retire'); assert.deepEqual(await c.accept(preview, 'audit-retire'), receipt);
    assert.equal(native.prepare('SELECT count(*) AS n FROM clank_platform_audit WHERE organization_id=?').get(first).n, 0);
    assert.equal(native.prepare('SELECT count(*) AS n FROM clank_platform_audit WHERE organization_id=?').get(second).n, 1);
    await organization(a, 'audit-three'); await exporter.flush();
    const continued = await verifyAuditExport(attempts.at(-1), keys, checkpoint); assert.ok(continued.sequence > checkpoint.sequence);
    native.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(first, a.id);
    await assert.rejects(c.accept(preview, 'audit-retire'), error => error.status === 404, 'an exact receipt cannot bypass removed membership');
  } finally { await exporter?.close(); database?.close(); await platform?.close(); await rm(root, { recursive: true, force: true }); }
});

test('retention receipt exhaustion rolls back purges, expiry and holds; rejected async operator policies are contained', async () => {
  const f = await fixture({ maxReceipts: 2 });
  try {
    const a = await f.user('capacity@example.invalid'); f.operators.add(a.id); const c = f.client(a), i = f.importer(a);
    const job = await i.uploadReviewableCsv(new Blob(['name,points\nLaunch,1\n']), columns), ref = { kind: 'import', id: job.id }, held = await c.hold(a.id, ref, 0, 'Keep', null, 'hold');
    await i.apply(await i.preview(job.id), 'apply'); await c.release(a.id, ref, held.version, 'release');
    const preview = await c.preview(purge(a.id, [ref]));
    await assert.rejects(c.accept(preview, 'full'), isCode('RETENTION_CAPACITY'));
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_durableImportChunks').get().n, 1);
    assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_durableImportOperations WHERE json_extract(_data,'$.expired')=1").get().n, 0);
    await assert.rejects(c.hold(a.id, ref, 0, 'New', null, 'full-hold'), isCode('RETENTION_CAPACITY'));
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_retention_holds').get().n, 0);
    const native = f.native; assert.throws(() => native.writeScoped(a.id, () => {}), /active write transaction/);
    f.retentionOptions.authorize = () => Promise.reject(Error('Rejected policy')); await f.restart();
    await assert.rejects(c.inventory(a.id), error => error.status === 404); await new Promise(resolve => setImmediate(resolve));
  } finally { await f.close(); }
});

test('expired holds remain inspectable and cannot reuse a prior version; current policy changes pause durable schedules', async t => {
  const f = await fixture();
  try {
    const a = await f.user('expiry@example.invalid'); f.operators.add(a.id); const c = f.client(a), i = f.importer(a), job = await i.uploadReviewableCsv(new Blob(['name,points\nLaunch,1\n']), columns), ref = { kind: 'import', id: job.id };
    const now = Date.now(), held = await c.hold(a.id, ref, 0, 'Temporary', now + 1000, 'temporary');
    const clock = t.mock.method(Date, 'now', () => now + 2000);
    try {
      const expired = (await c.inventory(a.id)).resources[0].hold; assert.equal(expired.active, false); assert.equal(expired.version, held.version);
      await c.release(a.id, ref, held.version, 'expired-release');
      const fresh = await c.hold(a.id, ref, 0, 'New reason', null, 'new'); assert.ok(fresh.version > held.version);
      await assert.rejects(c.release(a.id, ref, held.version, 'old-version'), isCode('RETENTION_STALE'));
      await c.saveSchedule({ id: 'rule', scope: a.id, expectedVersion: 0, kinds: ['import'], olderThanMs: 0, everyMs: 1000, maxDeletes: 1000, state: 'active' }, 'rule');
    } finally { clock.mock.restore(); }
    f.native.prepare('UPDATE clank_retention_schedules SET next_at=0').run(); f.retentionOptions.policyRevision = 'test/2'; await f.restart();
    assert.equal(f.retention.runDue(), 0); const rule = (await c.schedules(a.id))[0]; assert.equal(rule.state, 'paused'); assert.equal(rule.error, 'RETENTION_POLICY_CHANGED');
    assert.equal((await c.inventory(a.id)).resources[0].hold.active, true);
  } finally { await f.close(); }
});

test('inventory pages reject changed authorized data and ignore denied resources in their cursor identity', async () => {
  const f = await fixture();
  try {
    const a = await f.user('page-a@example.invalid'), b = await f.user('page-b@example.invalid'); f.operators.add(a.id); f.operators.add(b.id);
    const c = f.client(a), i = f.importer(a);
    await i.create('First', 'first'); await i.create('Second', 'second');
    const page = await c.inventory(a.id, { limit: 1 }); assert.ok(page.next);
    await f.importer(b).create('Private', 'private');
    assert.equal((await c.inventory(a.id, { limit: 1, after: page.next })).resources.length, 1);
    await i.create('Third', 'third'); await assert.rejects(c.inventory(a.id, { after: page.next }), isCode('RETENTION_STALE'));
  } finally { await f.close(); }
});

async function worker(path, mode = 'race') {
  const child = fork(new URL('./fixtures/retention-worker.mjs', import.meta.url), [path, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const message = () => new Promise((resolve, reject) => {
    const finish = (error, value) => { clearTimeout(timer); child.off('message', received); child.off('exit', failed); child.off('error', failed); if (error) reject(error); else resolve(value); };
    const received = value => finish(undefined, value), failed = code => finish(Error(`Retention worker exited ${code}: ${errors}`));
    const timer = setTimeout(() => finish(Error(`Retention worker timed out: ${errors}`)), 10000); child.once('message', received); child.once('exit', failed); child.once('error', failed);
  });
  try { assert.deepEqual(await message(), { ready: true }); } catch (error) { child.kill('SIGKILL'); await exited; throw error; }
  return { child, message, async close() { child.kill('SIGKILL'); await exited; } };
}
for (const stage of ['payload', 'receipt']) test(`SIGKILL after a real ${stage} write rolls back purge, history retirement and expired identities`, async () => {
  const f = await fixture(); let child;
  try {
    const a = await f.user(`${stage}@example.invalid`); f.operators.add(a.id); const c = f.client(a), i = f.importer(a), job = await i.uploadReviewableCsv(new Blob(['name,points\nLaunch,1\n']), columns), ref = { kind: 'import', id: job.id };
    const held = await c.hold(a.id, ref, 0, 'Crash fixture', null, 'hold'); await i.apply(await i.preview(job.id), 'apply'); await c.release(a.id, ref, held.version, 'release');
    const preview = await c.preview(purge(a.id, [ref])), history = f.native.prepare("SELECT count(*) AS n FROM clank_document_revisions WHERE table_name='durableImportChunks'").get().n;
    child = await worker(f.path, stage); const reached = child.message(); child.child.send({ user: a, preview, operationId: 'crash' }); assert.deepEqual(await reached, { uncommitted: true }); await child.close(); child = undefined;
    await f.restart(); assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_durableImportChunks').get().n, 1);
    assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_document_revisions WHERE table_name='durableImportChunks'").get().n, history);
    assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_durableImportOperations WHERE json_extract(_data,'$.expired')=1").get().n, 0);
    assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_retention_receipts WHERE operation_id='crash'").get().n, 0);
    assert.ok((await c.accept(preview, 'crash')).records > 0);
  } finally { await child?.close(); await f.close(); }
});

test('independent processes accept one exact purge and recover a lost accepted response after restart', async () => {
  const f = await fixture(); const children = [];
  try {
    const a = await f.user('process@example.invalid'); f.operators.add(a.id); const c = f.client(a), i = f.importer(a), job = await i.uploadReviewableCsv(new Blob(['name,points\nLaunch,1\n']), columns), ref = { kind: 'import', id: job.id };
    const held = await c.hold(a.id, ref, 0, 'Race fixture', null, 'hold'); await i.apply(await i.preview(job.id), 'apply'); await c.release(a.id, ref, held.version, 'release');
    const preview = await c.preview(purge(a.id, [ref])); children.push(await worker(f.path), await worker(f.path));
    const messages = children.map(child => child.message()); for (const child of children) child.child.send({ user: a, preview, operationId: 'race' });
    const results = await Promise.all(messages); assert.deepEqual(results[0].result, results[1].result);
    for (const child of children) await child.close(); children.length = 0;
    assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_retention_receipts WHERE operation_id='race'").get().n, 1);
    // Lose a real committed HTTP response, then replay through a new service.
    const lost = createRetentionAdministrationClient({ url: 'https://retention.test/__clank/retention', auth: { csrfHeader: () => ({ 'x-clank-csrf': a.csrf }) }, fetch: async (url, init) => { const response = await f.retention.handle(new Request(url, { ...init, headers: { ...init.headers, cookie: a.cookie, origin: 'https://retention.test' } })); assert.equal(response.status, 200); throw Error('Response lost'); } });
    const next = await c.preview(purge(a.id, [ref])); await assert.rejects(lost.accept(next, 'lost'), /Response lost/); await f.restart(); const result = await c.accept(next, 'lost'); assert.equal(result.records, 0);
  } finally { for (const child of children) await child.close(); await f.close(); }
});

test('independent schedule runners accept one due occurrence under the persisted operator policy', async () => {
  const f = await fixture(), children = [];
  try {
    const a = await f.user('scheduled-process@example.invalid'); f.operators.add(a.id);
    const c = f.client(a), i = f.importer(a), job = await i.uploadReviewableCsv(new Blob(['name,points\nLaunch,1\n']), columns), ref = { kind: 'import', id: job.id };
    const hold = await c.hold(a.id, ref, 0, 'Schedule race', null, 'hold'); await i.apply(await i.preview(job.id), 'apply'); await c.release(a.id, ref, hold.version, 'release');
    await c.saveSchedule({ id: 'daily', scope: a.id, expectedVersion: 0, kinds: ['import'], olderThanMs: 0, everyMs: 60000, maxDeletes: 1000, state: 'active' }, 'schedule');
    f.native.prepare('UPDATE clank_retention_schedules SET next_at=0').run();
    children.push(await worker(f.path, 'schedule'), await worker(f.path, 'schedule'));
    const messages = children.map(child => child.message()); for (const child of children) child.child.send({ user: a });
    const values = await Promise.all(messages); assert.deepEqual(values.map(value => value.result).sort(), [0, 1]);
    assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_retention_receipts WHERE operation_id LIKE 'schedule:%'").get().n, 1);
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_durableImportChunks').get().n, 0);
    const [rule] = await c.schedules(a.id); assert.equal(rule.version, 2); assert.ok(rule.lastReceipt.records > 0); assert.ok(rule.nextAt > Date.now());
  } finally { for (const child of children) await child.close(); await f.close(); }
});

test('bounds, forged previews and corrupt hold/source metadata fail without retiring evidence', async () => {
  const f = await fixture({ maxHolds: 1, maxResources: 1 });
  try {
    const a = await f.user('bounds@example.invalid'); f.operators.add(a.id); const c = f.client(a), i = f.importer(a);
    const first = await i.create('First', 'first'), second = await i.create('Second', 'second'), ref = { kind: 'import', id: first.id };
    await assert.rejects(c.inventory(a.id), isCode('RETENTION_CAPACITY'));
    const hold = await c.hold(a.id, ref, 0, 'Evidence', null, 'hold');
    await assert.rejects(c.hold(a.id, { kind: 'import', id: second.id }, 0, 'Second', null, 'full'), isCode('RETENTION_CAPACITY'));
    await c.release(a.id, ref, hold.version, 'release');
    await assert.rejects(c.preview({ ...purge(a.id, [ref]), cutoff: Date.now() + 100000 }), isCode('RETENTION_INPUT'));
    const preview = await c.preview(purge(a.id, [ref]));
    await assert.rejects(c.accept({ ...preview, digest: 'forged' }, 'forged'), isCode('RETENTION_STALE'));
    assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_retention_receipts WHERE operation_id='forged'").get().n, 0);
    const secondHold = await c.hold(a.id, ref, 0, 'Evidence', null, 'hold-again');
    f.native.prepare('UPDATE clank_retention_holds SET version=0').run(); await assert.rejects(c.preview(purge(a.id, [ref])), error => error.status === 500);
    f.native.prepare('UPDATE clank_retention_holds SET version=?').run(secondHold.version);
    f.native.prepare("UPDATE clank_durableImportJobs SET _data=json_set(_data,'$.state','unknown') WHERE _id=?").run(first.id);
    await assert.rejects(c.preview(purge(a.id, [ref])), error => error.status === 500);
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_retention_holds').get().n, 1);
  } finally { await f.close(); }
});

test('opening snapshots source and operator configuration before asynchronous initialization', async () => {
  const f = await fixture(); let service;
  try {
    const a = await f.user('snapshot@example.invalid'); f.operators.add(a.id); await f.importer(a).create('Source', 'source');
    const settings = { ...f.retentionOptions, sources: { imports: true }, prefix: '/retention-snapshot' }, opening = openRetentionAdministration(settings);
    settings.authorize = () => false; settings.scope = () => 'wrong'; settings.sources.imports = false; settings.policyRevision = 'changed';
    service = await opening;
    const c = createRetentionAdministrationClient({ url: 'https://retention.test/retention-snapshot', auth: { csrfHeader: () => ({ 'x-clank-csrf': a.csrf }) }, fetch: (url, init) => service.handle(new Request(url, { ...init, headers: { ...init.headers, cookie: a.cookie, origin: 'https://retention.test' } })) });
    assert.equal((await c.inventory(a.id)).resources.length, 1);
    await assert.rejects(openRetentionAdministration({ ...f.retentionOptions, sources: { imports: 'true' } }), /Declare retention/);
  } finally { service?.close(); await f.close(); }
});

test('aggregate purge snapshot bytes are admitted before loading later resource payloads', async () => {
  const f = await fixture();
  try {
    const a = await f.user('bytes@example.invalid'); f.operators.add(a.id); const c = f.client(a), i = f.importer(a), refs = [];
    for (let index = 0; index < 2; index++) {
      const job = await i.uploadReviewableCsv(new Blob([`name,points\nLaunch${index},1\n`]), columns), ref = { kind: 'import', id: job.id }; refs.push(ref);
      const held = await c.hold(a.id, ref, 0, 'Large snapshot fixture', null, `hold-${index}`); await i.apply(await i.preview(job.id), `apply-${index}`); await c.release(a.id, ref, held.version, `release-${index}`);
      // Deliberately corrupt a bounded source field to exercise native byte admission.
      f.native.prepare("UPDATE clank_durableImportChunks SET _data=json_set(_data,'$.records',?) WHERE json_extract(_data,'$.jobId')=?").run('x'.repeat(9 * 1024 * 1024), job.id);
    }
    const loaded = []; const original = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) { const statement = original.call(this, sql); if (!sql.startsWith('SELECT * FROM clank_durableImportChunks ')) return statement; return { get: statement.get.bind(statement), run: statement.run.bind(statement), all(...args) { loaded.push(args[0]); return statement.all(...args); } }; };
    try { await assert.rejects(c.preview(purge(a.id, refs)), isCode('RETENTION_CAPACITY')); } finally { DatabaseSync.prototype.prepare = original; }
    assert.equal(loaded.length, 1, 'later source payload is refused before its SELECT materializes');
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_durableImportChunks').get().n, 2);
  } finally { await f.close(); }
});

test('platform audit inventory without a signer stays unacknowledged and cannot be purged', async () => {
  const { openPlatform } = await import('../dist/platform.js'); const root = await mkdtemp(join(tmpdir(), 'clank-retention-no-signer-')); let platform;
  try {
    platform = await openPlatform({ dataDirectory: root, publicUrl: 'https://retention.test', signup: true, backups: { intervalMs: false }, retention: { policyRevision: 'platform/1', intervalMs: false } });
    const register = await platform.handle(new Request('https://retention.test/__clank/auth/register', { method: 'POST', headers: { origin: 'https://retention.test', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'no-signer@example.invalid', password: 'correct horse battery staple', profile: { name: 'Operator' } }) })); assert.equal(register.status, 201);
    const user = await register.json(), cookie = register.headers.get('set-cookie').split(';')[0], scope = `account:${user.user.id}`;
    const c = createRetentionAdministrationClient({ url: 'https://retention.test/api/retention', auth: { csrfHeader: () => ({ 'x-clank-csrf': user.csrfToken }) }, fetch: (url, init) => platform.handle(new Request(url, { ...init, headers: { ...init.headers, cookie, origin: 'https://retention.test' } })) });
    const organization = await platform.handle(new Request('https://retention.test/api/organizations', { method: 'POST', headers: { origin: 'https://retention.test', 'content-type': 'application/json', cookie, 'x-clank-csrf': user.csrfToken }, body: JSON.stringify({ name: 'No signer', slug: 'no-signer' }) })); assert.equal(organization.status, 201);
    const orgScope = `organization:${(await organization.json()).organization.id}`, inventory = await c.inventory(orgScope); assert.equal(inventory.resources.length, 1); assert.equal(inventory.resources[0].state, 'unacknowledged');
    const preview = await c.preview(purge(orgScope, inventory.resources.map(({ kind, id }) => ({ kind, id })))); assert.equal(preview.records, 0); assert.equal(preview.items[0].blocked, 'unacknowledged'); assert.deepEqual((await c.inventory(scope)).resources, []);
  } finally { await platform?.close(); await rm(root, { recursive: true, force: true }); }
});

test('preopened database writers preserve held source snapshots through global and per-document history cleanup', async () => {
  const { openSQLite } = await import('../dist/backend.js');
  const { importMetadataTables, collaborativeMetadataTables } = await import('../dist/feature-service.js');
  const f = await fixture(); let perDocument, global;
  try {
    const sourceSchema = defineDatabase({ ...schema.tables, ...importMetadataTables(true), ...collaborativeMetadataTables(200000) });
    perDocument = await openSQLite(sourceSchema, { path: f.path, historyRetentionRevisions: 10000, historyRetentionPerDocument: 1 });
    global = await openSQLite(schema, { path: f.path, historyRetentionRevisions: 1, historyRetentionPerDocument: 1 });
    const a = await f.user('history-cleanup@example.invalid'); f.operators.add(a.id); f.associate(a, 'held-document');
    const c = f.client(a), i = f.importer(a), d = f.document(a), job = await i.uploadReviewableCsv(new Blob(['name,points\nLaunch,bad\n']), columns), importRef = { kind: 'import', id: job.id }, documentRef = { kind: 'collaboration', id: 'held-document' };
    await d.create('held-document', 'Original');
    const hold = await c.hold(a.id, importRef, 0, 'Keep source history', null, 'import-hold'), docHold = await c.hold(a.id, documentRef, 0, 'Keep text history', null, 'document-hold');
    await i.correctRows(job.id, 0, [{ row: 2, values: { score: 1 } }], 'first-fix'); await i.correctRows(job.id, 1, [{ row: 2, values: { score: 2 } }], 'second-fix'); await i.apply(await i.preview(job.id), 'apply');
    await d.edit({ documentId: 'held-document', operationId: 'edit1', baseRevision: 1, start: 0, deleteCount: 0, insert: 'A' });
    const doc = f.native.prepare("SELECT _id FROM clank_collaborativeDocs WHERE json_extract(_data,'$.key')='held-document'").get();
    for (let index = 0; index < 3; index++) perDocument.transaction(db => { db.table('durableImportJobs').patch(job.id, { name: `History ${index}` }); db.table('collaborativeDocs').patch(doc._id, {}); }, { userId: a.id });
    const counts = () => f.native.prepare("SELECT table_name AS name,count(*) AS n FROM clank_document_revisions WHERE table_name IN ('durableImportJobs','durableImportChunks','durableImportCorrections','durableImportOperations','collaborativeDocs','collaborativeOperations','collaborativeReceipts') GROUP BY table_name ORDER BY table_name").all();
    const kept = counts(); assert.ok(kept.find(row => row.name === 'durableImportJobs').n > 1); assert.ok(kept.find(row => row.name === 'collaborativeDocs').n > 1); assert.ok(kept.find(row => row.name === 'durableImportCorrections').n >= 3);
    for (let index = 0; index < 3; index++) global.transaction(db => db.table('records').insert({ title: `Unrelated ${index}`, score: index }), { userId: a.id });
    assert.deepEqual(counts(), kept, 'global cleanup cannot prune any held source snapshot');
    f.native.prepare('UPDATE clank_retention_state SET protocol=2').run();
    assert.throws(() => global.transaction(db => db.table('records').insert({ title: 'Must roll back', score: 4 }), { userId: a.id }), /Unsupported persisted/);
    f.native.prepare('UPDATE clank_retention_state SET protocol=1').run(); assert.deepEqual(counts(), kept);
    await c.release(a.id, importRef, hold.version, 'release-import'); await c.release(a.id, documentRef, docHold.version, 'release-document');
    global.transaction(db => db.table('records').insert({ title: 'Cleanup after release', score: 5 }), { userId: a.id }); assert.deepEqual(counts(), []);
  } finally { perDocument?.close(); global?.close(); await f.close(); }
});

test('held history admission rolls back new holds and writes without deleting protected snapshots', async () => {
  const f = await fixture();
  try {
    const a = await f.user('history-capacity@example.invalid'); f.operators.add(a.id); f.associate(a, 'capacity-document');
    const c = f.client(a), d = f.document(a); await d.create('capacity-document', 'Original');
    const row = f.native.prepare("SELECT * FROM clank_collaborativeDocs WHERE json_extract(_data,'$.key')='capacity-document'").get(), ref = { kind: 'collaboration', id: 'capacity-document' };
    f.native.prepare(`WITH RECURSIVE copies(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM copies WHERE n<100001)
      INSERT INTO clank_document_revisions(revision,sequence,table_name,document_id,owner_id,document_version,creation_time,operation,snapshot_data,recorded_at)
      SELECT ?,n+100000,'collaborativeDocs',?,NULL,1,0,'update',?,0 FROM copies`).run(f.runtime.database.version, row._id, row._data);
    await assert.rejects(c.hold(a.id, ref, 0, 'Would exceed capacity', null, 'too-large'), isCode('RETENTION_CAPACITY'));
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_retention_holds').get().n, 0); assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_retention_receipts WHERE operation_id='too-large'").get().n, 0);
    f.native.prepare('DELETE FROM clank_document_revisions WHERE sequence>=200000').run();
    const held = await c.hold(a.id, ref, 0, 'At capacity', null, 'held');
    const before = f.native.prepare("SELECT count(*) AS n FROM clank_document_revisions WHERE table_name='collaborativeDocs'").get().n; assert.equal(before, 100000);
    await assert.rejects(d.edit({ documentId: ref.id, operationId: 'too-large-edit', baseRevision: 1, start: 0, deleteCount: 0, insert: 'Changed' }), isCode('RETENTION_CAPACITY'));
    assert.equal((await d.read(ref.id)).text, 'Original'); assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_document_revisions WHERE table_name='collaborativeDocs'").get().n, before);
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_collaborativeReceipts').get().n, 0);
    await c.release(a.id, ref, held.version, 'release'); await d.edit({ documentId: ref.id, operationId: 'too-large-edit', baseRevision: 1, start: 0, deleteCount: 0, insert: 'Changed' });
    assert.equal((await d.read(ref.id)).text, 'ChangedOriginal'); assert.ok(f.native.prepare("SELECT count(*) AS n FROM clank_document_revisions WHERE table_name='collaborativeDocs'").get().n <= 100);
  } finally { await f.close(); }
});
