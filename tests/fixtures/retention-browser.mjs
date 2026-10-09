import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineAuth } from '../../dist/auth.js';
import { defineBackend, defineDatabase, defineTable, openBackend } from '../../dist/backend.js';
import { s } from '../../dist/ai.js';
import { SQLITE_INTERNAL } from '../../dist/sqlite-internal.js';
import { openDurableImport, createDurableImportClient } from '../../dist/durable-import.js';
import { openRetentionAdministration, createRetentionAdministrationClient } from '../../dist/retention-administration.js';
const root = await mkdtemp(join(tmpdir(), 'clank-retention-browser-')), path = join(root, 'app.sqlite'), origin = 'http://127.0.0.1:43176';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const assets = new Map(await Promise.all((await readdir(join(repository, 'dist'))).filter(name => /^[a-z0-9-]+\.js$/u.test(name)).map(async name => ['/dist/' + name, await readFile(join(repository, 'dist', name))])));
const schema = defineDatabase({ records: defineTable({ title: s.string(), score: s.number() }).owned(), operators: defineTable({ userId: s.string(), allowed: s.boolean() }).index('by_user', ['userId']) });
const auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } });
const runtime = await openBackend(defineBackend({ schema, auth }).functions(() => ({})), { path, agent: false });
const imports = await openDurableImport({ path, auth, schema, table: 'records', fields: ['title', 'score'], uniqueBy: ['title'], reviewable: { duplicates: 'upsert' } });
const retention = await openRetentionAdministration({ path, auth, schema, sources: { imports: true }, policyRevision: 'browser/1', scope: (_ctx, ref) => ref.ownerId ?? null, authorize: ({ auth, db }, scope) => auth.user?.id === scope && db.table('operators').query().where('userId', auth.user.id).first()?.allowed === true });
async function register(email) { const response = await runtime.handle(new Request(`${origin}/__clank/auth/register`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'disposable browser verification password' }) })); if (response.status !== 201) throw Error('Registration failed'); const data = await response.json(); runtime.database.transaction(db => db.table('operators').insert({ userId: data.user.id, allowed: true })); return { id: data.user.id, csrf: data.csrfToken, setCookie: response.headers.get('set-cookie'), cookie: response.headers.get('set-cookie').split(';')[0] }; }
const alice = await register('retention-alice@example.invalid'), bob = await register('retention-bob@example.invalid');
const transport = (user, prefix, service) => ({ url: `${origin}/__clank/${prefix}`, auth: { csrfHeader: () => ({ 'x-clank-csrf': user.csrf }) }, fetch: (url, init) => service.handle(new Request(url, { ...init, headers: { ...init.headers, cookie: user.cookie, origin } })) });
const admin = createRetentionAdministrationClient(transport(alice, 'retention', retention)), importer = createDurableImportClient({ ...transport(alice, 'imports', imports), currentUser: () => alice.id });
const job = await importer.uploadReviewableCsv(new Blob(['name,points\nRetained incident source,5\n']), [{ source: 'name', target: 'title', type: 'text', required: true }, { source: 'points', target: 'score', type: 'number', required: true }]);
await admin.hold(alice.id, { kind: 'import', id: job.id }, 0, 'Browser incident investigation', null, 'fixture-hold'); await importer.apply(await importer.preview(job.id), 'fixture-apply');
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Retention administration verification</title><style>body{font:16px system-ui;max-width:900px;margin:24px auto;padding:0 16px}label{display:block;margin:12px 0}button{padding:10px;margin:8px 8px 8px 0}input{font:inherit}fieldset{margin:16px 0;min-width:0}td,th{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #ddd}h1{font-size:24px}</style><h1>Retention administration verification</h1><p>Disposable authenticated application database</p><button id="switch">Switch account</button><button id="revoke">Revoke current operator</button><button id="dispose">Dispose controls</button><div id="app"></div><script type="module">
import { createRetentionAdministrationClient, mountRetentionAdministration } from '/dist/retention-administration.js';
let identity = ${JSON.stringify({ id: alice.id, csrf: alice.csrf })}; const client=createRetentionAdministrationClient({url:'${origin}/__clank/retention',auth:{csrfHeader:()=>({'x-clank-csrf':identity.csrf})}});
const dispose=mountRetentionAdministration(document.querySelector('#app'),{client,currentUser:()=>identity.id,scope:()=>identity.id,kinds:['import']});
async function fixtureAction(path){const response=await fetch(path,{method:'POST',headers:{'x-clank-csrf':identity.csrf}});if(!response.ok)throw Error('Fixture action failed');return response.json()}
document.querySelector('#switch').onclick=async()=>{identity=await fixtureAction('/fixture/switch');document.querySelector('#app button').click()};
document.querySelector('#revoke').onclick=async()=>{await fixtureAction('/fixture/revoke');document.querySelector('#app button').click()};
document.querySelector('#dispose').onclick=dispose;
</script></html>`;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.setHeader('set-cookie', alice.setCookie); res.end(html); return; }
    if (assets.has(req.url)) { res.setHeader('content-type', 'text/javascript'); res.end(assets.get(req.url)); return; }
    const user = [alice, bob].find(user => String(req.headers.cookie ?? '').split(/;\s*/u).includes(user.cookie));
    if (req.url.startsWith('/fixture/')) {
      if (req.method !== 'POST' || req.headers.origin !== origin || !user || req.headers['x-clank-csrf'] !== user.csrf) { res.statusCode = 403; res.end(); return; }
      if (req.url === '/fixture/switch') { const next = user === alice ? bob : alice; res.setHeader('set-cookie', next.setCookie); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: next.id, csrf: next.csrf })); return; }
      if (req.url === '/fixture/revoke') { runtime.database.transaction(db => { const row = db.table('operators').query().where('userId', user.id).first(); if (row) db.table('operators').delete(row._id); }); res.end('{}'); return; }
    }
    if (req.url.startsWith('/__clank/retention/')) {
      const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw Error('Body exceeds bound'); chunks.push(chunk); }
      const response = await retention.handle(new Request(origin + req.url, { method: req.method, headers: req.headers, body: Buffer.concat(chunks) })); res.statusCode = response.status; for (const [name, value] of response.headers) res.setHeader(name, value); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (req.url === '/fixture/evidence' && user) { const native = runtime.database[SQLITE_INTERNAL]; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ chunks: native.prepare('SELECT count(*) AS n FROM clank_durableImportChunks').get().n, expiredIdentities: native.prepare("SELECT count(*) AS n FROM clank_durableImportOperations WHERE json_extract(_data,'$.expired')=1").get().n, rules: native.prepare('SELECT count(*) AS n FROM clank_retention_schedules').get().n })); return; }
    res.statusCode = 404; res.end('Not found');
  } catch { res.statusCode = 500; res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end('Fixture request failed'); }
});
server.listen(43176, '127.0.0.1', () => console.log('Retention verification at ' + origin));
let closing = false; async function close() { if (closing) return; closing = true; server.close(); retention.close(); imports.close(); runtime.close(); await rm(root, { recursive: true, force: true }); }
process.on('SIGTERM', () => { void close(); }); process.on('SIGINT', () => { void close(); });
