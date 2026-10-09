import { DatabaseSync } from 'node:sqlite';
import { defineAuth } from '../../dist/auth.js';
import { defineDatabase, defineTable } from '../../dist/backend.js';
import { s } from '../../dist/ai.js';
import { openSearch, createSearchBrowsingClient } from '../../dist/search.js';
const [path, mode] = process.argv.slice(2);
const schema = defineDatabase({ notes: defineTable({ title: s.string(), body: s.string(), category: s.string(), score: s.number(), active: s.boolean(), optional: s.optional(s.string()), complex: s.array(s.string()) }).owned() });
const auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } });
const service = await openSearch({ path, schema, auth, source: { name: 'notes', table: 'notes', title: 'title', body: 'body', scope: 'owner', facets: ['category', 'score', 'active', 'optional'] }, browsing: { policyRevision: 'test/1' }, authorize: ({ auth }, scope) => auth.user?.id === scope });
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql);
  if (mode !== 'crash' || !sql.startsWith('INSERT INTO clank_search_definitions(owner')) return statement;
  return { all: statement.all.bind(statement), get: statement.get.bind(statement), run(...parameters) { const result = statement.run(...parameters); process.send({ uncommitted: true }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); return result; } };
};
process.send({ ready: true });
process.once('message', async ({ user, input }) => {
  const client = createSearchBrowsingClient({ url: 'https://search.test/__clank/search', auth: { csrfHeader: () => ({ 'x-clank-csrf': user.csrf }) }, fetch: (url, init) => { const headers = new Headers(init.headers); headers.set('cookie', user.cookie); headers.set('origin', 'https://search.test'); return service.handle(new Request(url, { ...init, headers })); } });
  try { const result = await client.save(user.id, input); process.send({ result }); service.close(); process.disconnect(); }
  catch (error) { process.stderr.write(String(error)); service.close(); process.exit(1); }
});
