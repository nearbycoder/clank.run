import { DatabaseSync } from 'node:sqlite';
import { defineAuth } from '../../dist/auth.js';
import { defineDatabase, defineTable } from '../../dist/backend.js';
import { s } from '../../dist/ai.js';
import { openRetentionAdministration, createRetentionAdministrationClient } from '../../dist/retention-administration.js';
const [path, mode] = process.argv.slice(2);
const auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } });
const schema = defineDatabase({ records: defineTable({ title: s.string(), score: s.number() }).owned(), scopes: defineTable({ documentId: s.string(), scope: s.string() }).index('by_document', ['documentId']), operators: defineTable({ userId: s.string(), allowed: s.boolean() }).index('by_user', ['userId']) });
const service = await openRetentionAdministration({ path, auth, schema, sources: { imports: true, collaboration: {} }, policyRevision: 'test/1', scope: ({ db }, resource) => resource.kind === 'import' ? resource.ownerId : db.table('scopes').query().where('documentId', resource.id).first()?.scope ?? null, authorize: ({ auth, db }, scope) => auth.user.id === scope && db.table('operators').query().where('userId', auth.user.id).first()?.allowed === true });
const original = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = original.call(this, sql), boundary = mode === 'payload' ? sql.startsWith('DELETE FROM "clank_durableImportChunks"') : mode === 'receipt' && sql.startsWith('INSERT INTO clank_retention_receipts VALUES');
  if (!boundary) return statement;
  return { all: statement.all.bind(statement), get: statement.get.bind(statement), run(...parameters) {
    const result = statement.run(...parameters); process.send({ uncommitted: true }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); return result;
  } };
};
process.send({ ready: true });
process.once('message', async ({ user, preview, operationId }) => {
  const client = createRetentionAdministrationClient({ url: 'https://retention.test/__clank/retention', auth: { csrfHeader: () => ({ 'x-clank-csrf': user.csrf }) }, fetch: (url, init) => service.handle(new Request(url, { ...init, headers: { ...init.headers, cookie: user.cookie, origin: 'https://retention.test' } })) });
  try { const value = mode === 'schedule' ? service.runDue() : await client.accept(preview, operationId); process.send({ result: value }); service.close(); process.disconnect(); }
  catch (error) { process.stderr.write(String(error)); service.close(); process.exit(1); }
});
