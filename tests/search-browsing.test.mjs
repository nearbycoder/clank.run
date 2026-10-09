import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineDatabase, defineTable, defineBackend, openBackend } from '../dist/backend.js';
import { defineAuth } from '../dist/auth.js';
import { s } from '../dist/ai.js';
import { openSearch, createSearchBrowsingClient, createSearchClient } from '../dist/search.js';
import { SQLITE_INTERNAL } from '../dist/sqlite-internal.js';

const schema = defineDatabase({ notes: defineTable({ title: s.string(), body: s.string(), category: s.string(), score: s.number(), active: s.boolean(), optional: s.optional(s.string()), complex: s.array(s.string()) }).owned() });
const auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } });
const source = { name: 'notes', table: 'notes', title: 'title', body: 'body', scope: 'owner', facets: ['category', 'score', 'active', 'optional'] };
const definition = { text: '', filters: [], sort: 'title' };
const value = (title, category = 'alpha', score = 1) => ({ title, body: 'launch checklist', category, score, active: true, complex: [] });
async function fixture(extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clank-search-browsing-')), path = join(directory, 'app.sqlite');
  const runtime = await openBackend(defineBackend({ schema, auth }).functions(() => ({})), { path, agent: false });
  const settings = { path, schema, auth, source, browsing: { policyRevision: 'test/1' }, authorize: ({ auth }, scope) => auth.user?.id === scope, ...extra };
  let service = await openSearch(settings);
  return {
    path, directory, runtime, settings, get service() { return service; }, native: runtime.database[SQLITE_INTERNAL],
    async user(email) { const response = await runtime.handle(new Request('https://search.test/__clank/auth/register', { method: 'POST', headers: { origin: 'https://search.test', 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery staple' }) })); assert.equal(response.status, 201); const data = await response.json(); return { id: data.user.id, csrf: data.csrfToken, cookie: response.headers.get('set-cookie').split(';')[0] }; },
    client(user, responseHook) { return createSearchBrowsingClient({ url: 'https://search.test/__clank/search', auth: { csrfHeader: () => ({ 'x-clank-csrf': user.csrf }) }, fetch: async (url, init) => { const headers = new Headers(init.headers); headers.set('cookie', user.cookie); headers.set('origin', 'https://search.test'); const response = await service.handle(new Request(url, { ...init, headers })); return responseHook ? responseHook(response, url) : response; } }); },
    insert(user, record) { return runtime.database.transaction(db => db.table('notes').insert(record), { userId: user.id }); },
    rebuild() { while (service.rebuild({ batchSize: 1000 }).status !== 'ready') {} },
    async restart(changes = {}) { service.close(); Object.assign(settings, changes); service = await openSearch(settings); },
    async close() { service.close(); runtime.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
const denied = (code, status) => error => error.code === code && (status === undefined || error.status === status);

test('facets and filters include only current authorized source rows, with stable complete paging', async () => {
  const hidden = new Set(), f = await fixture({ authorizeRecord: (_ctx, ref) => !hidden.has(ref.id) });
  try {
    const alice = await f.user('facets@example.invalid'), bob = await f.user('facet-other@example.invalid');
    const a = f.insert(alice, value('Éclair')), b = f.insert(alice, value('E\u0301clair')), c = f.insert(alice, value('Zulu', 'beta', 2));
    hidden.add(f.insert(alice, value('Private launch', 'secret', 999))); f.insert(bob, value('Other tenant', 'other-secret', 500)); f.rebuild();
    const client = f.client(alice), first = await client.browse(alice.id, definition, { limit: 1 });
    assert.equal(first.total, 3); assert.deepEqual(first.facets.find(facet => facet.field === 'category').values, [{ value: 'alpha', count: 2 }, { value: 'beta', count: 1 }]);
    assert.deepEqual(first.facets.find(facet => facet.field === 'optional').values, [{ value: null, count: 3 }]);
    const second = await client.browse(alice.id, definition, { limit: 1, cursor: first.nextCursor }), third = await client.browse(alice.id, definition, { limit: 1, cursor: second.nextCursor });
    assert.deepEqual([...first.hits, ...second.hits, ...third.hits].map(hit => hit.id), [c, ...[a, b].sort()]); assert.equal(third.nextCursor, null);
    const accents = await client.browse(alice.id, { ...definition, text: 'eclair' }); assert.deepEqual(accents.hits.map(hit => hit.id), [a, b].sort()); assert.equal(accents.hits.every(hit => hit.score === 4), true);
    const filtered = await client.browse(alice.id, { ...definition, filters: [{ field: 'category', value: 'beta' }, { field: 'score', value: 2 }, { field: 'active', value: true }] });
    assert.deepEqual(filtered.hits.map(hit => hit.id), [c]); assert.equal(filtered.facets[0].values[0].count, 1);
    assert.equal((await client.browse(alice.id, { ...definition, text: 'LAUNCH', sort: 'relevance' })).hits.every(hit => hit.score === 1), true);
    await assert.rejects(client.browse(bob.id, definition), error => error.status === 404);
    f.runtime.database.transaction(db => db.table('notes').patch(c, { category: 'changed', active: false }), { userId: alice.id });
    const changed = await client.browse(alice.id, definition); assert.ok(changed.facets[0].values.some(item => item.value === 'changed')); assert.equal(changed.total, 3);
  } finally { await f.close(); }
});

test('cursors bind account, scope, definition, visible ACL, source/index versions and policy', async () => {
  const hidden = new Set(), f = await fixture({ authorizeRecord: (_ctx, ref) => !hidden.has(ref.id) });
  try {
    const user = await f.user('cursor@example.invalid'), ids = [f.insert(user, value('A')), f.insert(user, value('B'))]; f.rebuild(); const client = f.client(user);
    const page = await client.browse(user.id, definition, { limit: 1 }); assert.ok(page.nextCursor);
    await assert.rejects(client.browse(user.id, { ...definition, sort: 'relevance' }, { cursor: page.nextCursor }), denied('SEARCH_CURSOR_STALE', 409));
    hidden.add(ids[1]); await assert.rejects(client.browse(user.id, definition, { cursor: page.nextCursor }), denied('SEARCH_CURSOR_STALE', 409)); hidden.clear();
    f.runtime.database.transaction(db => db.table('notes').patch(ids[1], { title: 'C' }), { userId: user.id });
    await assert.rejects(client.browse(user.id, definition, { cursor: page.nextCursor }), denied('SEARCH_CURSOR_STALE', 409));
    const fresh = await client.browse(user.id, definition, { limit: 1 }); await f.restart({ browsing: { policyRevision: 'test/2' } });
    await assert.rejects(f.client(user).browse(user.id, definition, { cursor: fresh.nextCursor }), denied('SEARCH_CURSOR_STALE', 409));
    await assert.rejects(f.client(user).browse(user.id, definition, { cursor: 'broken' }), error => error.status === 400);
    const forged = encodeURIComponent(JSON.stringify({ protocol: 1, stamp: '0'.repeat(64), after: ids[0] })); await assert.rejects(f.client(user).browse(user.id, definition, { cursor: forged }), denied('SEARCH_CURSOR_STALE', 409));
    const ready = f.service.inspect(); f.service.rebuild({ batchSize: 1, ifRevision: ready.revision });
    await assert.rejects(f.client(user).browse(user.id, definition), denied('SEARCH_SOURCE_UNAVAILABLE', 503));
    f.rebuild(); assert.equal((await f.client(user).browse(user.id, definition)).total, 2);
  } finally { await f.close(); }
});

test('saved searches fence edits and deletions, recover lost responses and retire keys across restart', async () => {
  const f = await fixture();
  try {
    const alice = await f.user('saved@example.invalid'), bob = await f.user('saved-other@example.invalid'); f.insert(alice, value('A')); f.rebuild();
    const input = { key: 'daily', expectedRevision: 0, name: 'Daily launch', definition };
    let lost = false; const uncertain = f.client(alice, (response, url) => { if (!lost && String(url).includes('/mutation/')) { lost = true; throw Error('Committed HTTP response lost'); } return response; });
    await assert.rejects(uncertain.save(alice.id, input), /lost/); assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_search_definitions').get().n, 1);
    await f.restart(); const client = f.client(alice), accepted = await client.save(alice.id, input); assert.equal(accepted.revision, 1); assert.deepEqual(await client.saved(alice.id), [accepted]);
    assert.deepEqual(await f.client(bob).saved(bob.id), []); await assert.rejects(f.client(bob).save(alice.id, input), error => error.status === 404);
    await assert.rejects(client.save(alice.id, { ...input, name: 'Changed retry' }), denied('SEARCH_DEFINITION_STALE', 409));
    const updatedInput = { ...input, expectedRevision: 1, name: 'Updated', definition: { ...definition, text: 'launch' } }, updated = await client.save(alice.id, updatedInput); assert.equal(updated.revision, 2);
    assert.deepEqual(await client.save(alice.id, updatedInput), updated); await assert.rejects(client.save(alice.id, input), denied('SEARCH_DEFINITION_STALE', 409));
    const removed = await client.removeSaved(alice.id, 'daily', 2); assert.equal(removed.revision, 3); await f.restart();
    assert.deepEqual(await f.client(alice).removeSaved(alice.id, 'daily', 2), removed); assert.deepEqual(await f.client(alice).saved(alice.id), []);
    const raw = f.native.prepare('SELECT * FROM clank_search_definitions').get(); assert.equal(raw.definition, ''); assert.equal(raw.name, ''); assert.equal(raw.deleted, 1);
    await assert.rejects(f.client(alice).save(alice.id, input), denied('SEARCH_DEFINITION_STALE', 409)); await assert.rejects(f.client(alice).removeSaved(alice.id, 'daily', 1), denied('SEARCH_DEFINITION_STALE', 409));
  } finally { await f.close(); }
});

test('saved definitions become explicitly unusable after policy or generation replacement', async () => {
  const f = await fixture();
  try {
    const user = await f.user('saved-policy@example.invalid'); f.insert(user, value('A')); f.rebuild();
    await f.client(user).save(user.id, { key: 'policy', expectedRevision: 0, name: 'Private policy filter', definition: { ...definition, filters: [{ field: 'category', value: 'alpha' }] } });
    await f.restart({ browsing: { policyRevision: 'test/2' }, source: { ...source, facets: ['score'] } });
    const stale = (await f.client(user).saved(user.id))[0]; assert.equal(stale.usable, false); assert.equal(stale.definition, null);
    const revised = await f.client(user).save(user.id, { key: 'policy', expectedRevision: 1, name: 'Current', definition }); assert.equal(revised.usable, true);
    f.service.detach(f.service.inspect().generation); await f.restart(); f.rebuild(); assert.equal((await f.client(user).saved(user.id))[0].usable, false);
    await f.client(user).removeSaved(user.id, 'policy', 2); assert.deepEqual(await f.client(user).saved(user.id), []);
  } finally { await f.close(); }
});

test('complete facet admission fails explicitly for candidate, source-byte and distinct-value overflow', async () => {
  const f = await fixture({ maxCandidates: 1, maxScopeRecords: 200 });
  try {
    const user = await f.user('capacities@example.invalid'); f.insert(user, value('A')); f.insert(user, value('B')); f.rebuild();
    await assert.rejects(f.client(user).browse(user.id, definition), denied('SEARCH_BROWSING_CAPACITY', 503));
    await f.restart({ maxCandidates: 200 });
    for (let index = 2; index < 101; index++) f.insert(user, value('Value ' + index, 'category-' + index));
    f.runtime.database.transaction(db => { for (const row of db.table('notes').query().collect()) db.table('notes').patch(row._id, { category: row._id }); }, { userId: user.id });
    await assert.rejects(f.client(user).browse(user.id, definition), denied('SEARCH_BROWSING_CAPACITY', 503));
    f.runtime.database.transaction(db => { for (const row of db.table('notes').query().collect()) db.table('notes').patch(row._id, { category: 'one', complex: ['x'.repeat(200000)] }); }, { userId: user.id });
    await assert.rejects(f.client(user).browse(user.id, definition), denied('SEARCH_BROWSING_CAPACITY', 503));
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_notes').get().n, 101);
  } finally { await f.close(); }
});

test('saved identity and per-account capacity preserve accepted rows and compact tombstones', async () => {
  const f = await fixture({ browsing: { policyRevision: 'test/1', maxSavedSearches: 1, maxSavedIdentities: 2 } });
  try {
    const user = await f.user('saved-capacity@example.invalid'); f.rebuild(); const client = f.client(user), input = { key: 'first', name: 'First', expectedRevision: 0, definition };
    const first = await client.save(user.id, input); await assert.rejects(client.save(user.id, { ...input, key: 'second' }), denied('SEARCH_BROWSING_CAPACITY', 503));
    await client.removeSaved(user.id, first.key, first.revision); const second = await client.save(user.id, { ...input, key: 'second' }); await client.removeSaved(user.id, second.key, second.revision);
    await assert.rejects(client.save(user.id, { ...input, key: 'third' }), denied('SEARCH_BROWSING_CAPACITY', 503)); assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_search_definitions').get().n, 2);
    await assert.rejects(f.restart({ browsing: { policyRevision: 'test/1', maxSavedIdentities: 1 } }), /capacity/);
  } finally { await f.close(); }
});

test('legacy search remains compatible and browsing validates optional scalar contracts before async opening', async () => {
  const f = await fixture();
  try {
    const user = await f.user('legacy-browse@example.invalid'); f.insert(user, value('A')); f.rebuild();
    const options = { ...f.settings, source: { ...source, facets: ['category'] }, browsing: { policyRevision: 'snapshot/1' } }, opening = openSearch(options); options.source.facets[0] = 'complex'; options.browsing.policyRevision = 'mutated'; options.authorize = () => false;
    const stable = await opening; try { const headers = { cookie: user.cookie, origin: 'https://search.test' }; const client = createSearchClient({ url: 'https://search.test/__clank/search', fetch: (url, init) => stable.handle(new Request(url, { ...init, headers: { ...init.headers, ...headers } })) }); assert.equal((await client.search(user.id, 'launch')).hits.length, 1); } finally { stable.close(); }
    await assert.rejects(openSearch({ ...f.settings, source: { ...source, facets: ['complex'] } }), /scalar/);
    await assert.rejects(openSearch({ ...f.settings, source: undefined }), /linked source/);
    await assert.rejects(openSearch({ ...f.settings, browsing: { policyRevision: '' } }), /configuration/);
    await assert.rejects(f.client(user).browse(user.id, { ...definition, filters: [{ field: 'complex', value: 'secret' }] }), error => error.status === 400);
    await assert.rejects(f.client(user).browse(user.id, { ...definition, text: '!!!' }), error => error.status === 400);
    await assert.rejects(f.client(user).browse(user.id, { ...definition, filters: [{ field: 'category', value: 'a' }, { field: 'category', value: 'b' }] }), error => error.status === 400);
    await assert.rejects(f.client(user).browse(user.id, { ...definition, filters: [{ field: 'category', value: [] }] }), error => error.status === 400);
    await f.restart({ authorizeRecord: () => Promise.reject(Error('Async policy rejected')) }); assert.equal((await f.client(user).browse(user.id, definition)).total, 0);
    await f.restart({ authorize: () => Promise.reject(Error('Async scope rejected')) }); await assert.rejects(f.client(user).saved(user.id), error => error.status === 404);
  } finally { await f.close(); }
});

test('current scope and session revocation deny accepted retries; protocol and byte capacity fail closed', async () => {
  let allowed = true; const f = await fixture({ authorize: ({ auth }, scope) => allowed && auth.user?.id === scope });
  try {
    const user = await f.user('revoked-browse@example.invalid'); f.rebuild(); const client = f.client(user), input = { key: 'retained', expectedRevision: 0, name: 'Accepted', definition };
    const saved = await client.save(user.id, input); allowed = false;
    await assert.rejects(client.save(user.id, input), error => error.status === 404); await assert.rejects(client.saved(user.id), error => error.status === 404); await assert.rejects(client.removeSaved(user.id, saved.key, saved.revision), error => error.status === 404);
    allowed = true; f.native.prepare('UPDATE clank_search_definitions_protocol SET version=2 WHERE id=1').run();
    await assert.rejects(client.browse(user.id, definition), denied('SEARCH_DEFINITION_UNAVAILABLE', 503)); await assert.rejects(client.save(user.id, input), denied('SEARCH_DEFINITION_UNAVAILABLE', 503));
    assert.equal(f.native.prepare('SELECT revision FROM clank_search_definitions').get().revision, 1); f.native.prepare('UPDATE clank_search_definitions_protocol SET version=1 WHERE id=1').run();
    await f.restart({ browsing: { policyRevision: 'test/1', maxSavedBytes: 800 } });
    await assert.rejects(f.client(user).save(user.id, { ...input, key: 'too-large', name: 'x'.repeat(100), definition: { ...definition, text: 'x'.repeat(500) } }), denied('SEARCH_BROWSING_CAPACITY', 503));
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_search_definitions').get().n, 1);
    f.runtime.auth.revokeUserSessions(user.id); await assert.rejects(f.client(user).save(user.id, input), error => error.status === 401); await assert.rejects(f.client(user).browse(user.id, definition), error => error.status === 401);
  } finally { await f.close(); }
});

test('missing optional facets use own stored fields even when the name exists on Object.prototype', async () => {
  const extended = defineDatabase({ notes: defineTable({ ...schema.tables.notes.fields, constructor: s.optional(s.string()) }).owned() });
  const f = await fixture({ schema: extended, source: { ...source, facets: ['constructor'] } });
  try {
    const user = await f.user('own-facet@example.invalid'); f.insert(user, value('A')); f.rebuild();
    assert.deepEqual((await f.client(user).browse(user.id, definition)).facets, [{ field: 'constructor', values: [{ value: null, count: 1 }] }]);
  } finally { await f.close(); }
});

function worker(f, mode, user, input) {
  const child = fork(new URL('./fixtures/search-browsing-worker.mjs', import.meta.url), [f.path, mode], { execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let diagnostics = ''; child.stderr.on('data', chunk => { diagnostics += chunk; });
  let result;
  const done = new Promise((resolve, reject) => { child.on('message', message => { if (message.ready) child.send({ user, input }); if (message.result) result = message.result; if (message.uncommitted) { result = 'killed'; child.kill('SIGKILL'); } }); child.once('exit', code => { if (result !== undefined) resolve(result); else reject(Error(diagnostics || 'Worker failed: ' + code)); }); child.once('error', reject); });
  return done.finally(() => { if (child.connected) child.disconnect(); child.kill(); });
}

test('independent processes accept one saved-key mutation, and SIGKILL rolls back its SQL boundary', async () => {
  const f = await fixture();
  try {
    const user = await f.user('process-browse@example.invalid'); f.insert(user, value('A')); f.rebuild();
    const input = { key: 'competing', expectedRevision: 0, name: 'One accepted', definition };
    const results = await Promise.all([worker(f, 'save', user, input), worker(f, 'save', user, input)]); assert.deepEqual(results[0], results[1]); assert.equal(f.native.prepare('SELECT count(*) AS n FROM clank_search_definitions').get().n, 1);
    assert.equal(await worker(f, 'crash', user, { ...input, key: 'uncommitted' }), 'killed');
    await f.restart(); assert.equal(f.native.prepare("SELECT count(*) AS n FROM clank_search_definitions WHERE key='uncommitted'").get().n, 0);
    assert.equal((await f.client(user).save(user.id, { ...input, key: 'uncommitted' })).revision, 1);
  } finally { await f.close(); }
});
