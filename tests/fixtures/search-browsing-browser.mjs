import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineAuth } from '../../dist/auth.js';
import { defineBackend, defineDatabase, defineTable, openBackend } from '../../dist/backend.js';
import { s } from '../../dist/ai.js';
import { openSearch } from '../../dist/search.js';
const root = await mkdtemp(join(tmpdir(), 'clank-search-browser-')), path = join(root, 'app.sqlite'), origin = 'http://127.0.0.1:43177';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const assets = new Map(await Promise.all((await readdir(join(repository, 'dist'))).filter(name => /^[a-z0-9-]+\.js$/u.test(name)).map(async name => ['/dist/' + name, await readFile(join(repository, 'dist', name))])));
const schema = defineDatabase({ notes: defineTable({ title: s.string(), body: s.string(), category: s.string() }).owned(), operators: defineTable({ userId: s.string(), allowed: s.boolean() }).index('by_user', ['userId']) });
const auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } });
const runtime = await openBackend(defineBackend({ schema, auth }).functions(() => ({})), { path, agent: false });
const service = await openSearch({ path, auth, schema, source: { name: 'notes', table: 'notes', title: 'title', body: 'body', scope: 'owner', facets: ['category'] }, browsing: { policyRevision: 'browser/1' }, authorize: ({ auth, db }, scope) => auth.user?.id === scope && db.table('operators').query().where('userId', auth.user.id).first()?.allowed === true });
async function register(email) { const response = await runtime.handle(new Request(`${origin}/__clank/auth/register`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'disposable browser verification password' }) })); if (response.status !== 201) throw Error('Registration failed'); const data = await response.json(); runtime.database.transaction(db => db.table('operators').insert({ userId: data.user.id, allowed: true })); return { id: data.user.id, csrf: data.csrfToken, setCookie: response.headers.get('set-cookie'), cookie: response.headers.get('set-cookie').split(';')[0] }; }
const alice = await register('search-alice@example.invalid'), bob = await register('search-bob@example.invalid');
runtime.database.transaction(db => { for (let index = 1; index <= 6; index++) db.table('notes').insert({ title: `Launch note ${index}`, body: `Original launch checklist ${index}`, category: index <= 3 ? 'alpha' : 'beta' }); }, { userId: alice.id });
runtime.database.transaction(db => db.table('notes').insert({ title: 'Bob record', body: 'Bob launch checklist', category: 'other-account' }), { userId: bob.id });
while (service.rebuild().status !== 'ready') {}
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Search browsing verification</title><style>body{font:16px system-ui;max-width:950px;margin:24px auto;padding:0 16px}label{display:block;margin:12px 0}button{padding:10px;margin:8px 8px 8px 0}input,select{font:inherit;max-width:100%;box-sizing:border-box}h1{font-size:24px}</style><h1>Search browsing verification</h1><p>Disposable authenticated application database</p><button id="switch">Switch account</button><button id="revoke">Revoke current operator</button><button id="dispose">Dispose controls</button><div id="app"></div><p id="opened"></p><script type="module">
import { createSearchBrowsingClient, mountSearchBrowsing } from '/dist/search.js';
let identity = ${JSON.stringify({ id: alice.id, csrf: alice.csrf })}; const client = createSearchBrowsingClient({url:'${origin}/__clank/search',auth:{csrfHeader:()=>({'x-clank-csrf':identity.csrf})}});
const dispose = mountSearchBrowsing(document.querySelector('#app'),{client,currentUser:()=>identity.id,scope:()=>identity.id,fields:['category'],pageSize:2,open:id=>{document.querySelector('#opened').textContent='Opened record '+id}});
async function fixtureAction(path){const response=await fetch(path,{method:'POST',headers:{'x-clank-csrf':identity.csrf}});if(!response.ok)throw Error('Fixture action failed');return response.json()}
document.querySelector('#switch').onclick=async()=>{identity=await fixtureAction('/fixture/switch');document.querySelector('#app form').requestSubmit()};
document.querySelector('#revoke').onclick=async()=>{await fixtureAction('/fixture/revoke');document.querySelector('#app form').requestSubmit()};
document.querySelector('#dispose').onclick=dispose;
</script></html>`;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('set-cookie', alice.setCookie); res.end(html); return; }
    if (assets.has(req.url)) { res.setHeader('content-type', 'text/javascript'); res.end(assets.get(req.url)); return; }
    const user = [alice, bob].find(user => String(req.headers.cookie ?? '').split(/;\s*/u).includes(user.cookie));
    if (req.url.startsWith('/fixture/')) {
      if (req.method !== 'POST' || req.headers.origin !== origin || !user || req.headers['x-clank-csrf'] !== user.csrf) { res.statusCode = 403; res.end(); return; }
      if (req.url === '/fixture/switch') { const next = user === alice ? bob : alice; res.setHeader('set-cookie', next.setCookie); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: next.id, csrf: next.csrf })); return; }
      if (req.url === '/fixture/revoke') { runtime.database.transaction(db => { const row = db.table('operators').query().where('userId', user.id).first(); if (row) db.table('operators').delete(row._id); }); res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
    }
    if (req.url.startsWith('/__clank/search/')) {
      const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 65536) throw Error('Body exceeds bound'); chunks.push(chunk); }
      const response = await service.handle(new Request(origin + req.url, { method: req.method, headers: req.headers, body: Buffer.concat(chunks) })); res.statusCode = response.status; for (const [name, value] of response.headers) res.setHeader(name, value); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    res.statusCode = 404; res.end('Not found');
  } catch { res.statusCode = 500; res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end('Fixture request failed'); }
});
server.listen(43177, '127.0.0.1', () => console.log('Search verification at ' + origin));
let closing = false; async function close() { if (closing) return; closing = true; server.close(); service.close(); runtime.close(); await rm(root, { recursive: true, force: true }); }
process.on('SIGTERM', () => { void close(); }); process.on('SIGINT', () => { void close(); });
