// Disposable loopback-only capacity fixture. Never accepts a production URL or database.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createServer } from 'node:net';

if (!process.send) throw Error('Start this internal fixture through run.mjs or reliability.mjs');
const config = JSON.parse(process.argv[2]);
const platformKind = config.kind === 'platform' || config.kind === 'ingress';
const moduleAt = name => import(pathToFileURL(join(resolve(config.dist), `${name}.js`)));
const { serve } = await moduleAt('node');
const { defineAuth } = await moduleAt('auth');
const { defineBackend, defineDatabase, defineTable, openBackend } = await moduleAt('backend');
const { s } = await moduleAt('ai');
const { h } = await moduleAt('dom');
const { renderToString } = await moduleAt('ssr');
await mkdir(config.root, { recursive: true });
const password = 'synthetic-load-test-password';
const errors = [];
let runtime, server, users = [];
process.once('uncaughtException', async error => {
  console.error(error);
  const deadline = setTimeout(() => process.exit(1), 5000);
  try { await runtime?.close(); } finally { clearTimeout(deadline); process.exit(1); }
});
const appPath = join(config.root, 'app.sqlite');
const onError = error => { if (errors.length < 20) errors.push(String(error.message)); };
if (platformKind) {
  const { openPlatform } = await moduleAt('platform');
  runtime = await openPlatform({ dataDirectory: config.root, publicUrl: 'http://127.0.0.1:33930', signup: true,
    authentication: { concurrency: config.authConcurrency ?? 2, maxQueue: 32 },
    backups: { intervalMs: false }, ingress: { domainRecheckIntervalMs: false,
      ...(config.kind === 'ingress' ? { enabled: true, baseDomain: 'apps.example.test' } : {}) },
    ...(config.ingressRpm ? { limits: { requestsPerMinutePerProject: config.ingressRpm } } : {}), onError });
} else {
  const definition = defineBackend({ auth: defineAuth(config.authConcurrency ? { password: { concurrency: config.authConcurrency, maxQueue: config.authQueue ?? 16 } } : {}), schema: defineDatabase({
    items: defineTable({ title: s.string(), done: s.boolean(), count: s.number() }).owned(),
  }) }).functions(({ query, mutation }) => ({
    list: query({ args: {}, handler: ({ db }) => db.table('items').query().limit(20).collect() }),
    seed: mutation({ args: {}, handler: ({ db }) => {
      if (db.table('items').collect().length) return;
      for (let n = 0; n < 20; n++) db.table('items').insert({ title: `Task ${n} ${'x'.repeat(200)}`, done: false, count: 0 });
    } }),
    write: mutation({ args: {}, handler: ({ db }) => {
      const item = db.table('items').query().first();
      return db.table('items').patch(item._id, { count: item.count + 1, done: !item.done });
    } }),
  }));
  runtime = await openBackend(definition, { path: appPath, agent: false, diagnostics: true,
    offlineMutations: {}, ...(config.liveLimit ? { maxLiveConnections: config.liveLimit } : {}),
    ...(config.cacheEntries ? { maxCacheEntries: config.cacheEntries } : {}), onError });
}
// One real default-cost password registration, then deterministic tenant data and distinct sessions.
// Password hashing is measured separately; seeding is excluded from timings.
if (!config.resume) {
const register = await runtime.handle(new Request('http://127.0.0.1:33930/__clank/auth/register', {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:33930' },
  body: JSON.stringify({ email: 'seed@example.invalid', password }),
}));
if (register.status !== 201) throw Error(`Registration: ${register.status} ${await register.text()}`);
const cookieName = register.headers.get('set-cookie').split('=')[0];
const db = new DatabaseSync(platformKind ? join(config.root, 'control.sqlite') : appPath);
db.exec('PRAGMA busy_timeout=5000');
const template = db.prepare('SELECT * FROM clank_auth_users LIMIT 1').get();
const userInsert = db.prepare(`INSERT INTO clank_auth_users
  (id,email,email_verified_at,password_hash,role,profile,disabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`);
const sessionInsert = db.prepare(`INSERT INTO clank_auth_sessions
  (id,token_hash,user_id,csrf_token,created_at,last_seen_at,idle_expires_at,expires_at) VALUES (?,?,?,?,?,?,?,?)`);
const metricInsert = platformKind && config.metricBuckets ? db.prepare(`INSERT INTO clank_platform_metrics
  (project_id,bucket_started_at,request_count,error_count,status_2xx,status_5xx,duration_sum_ms,duration_max_ms,
   latency_le_50,latency_le_100,latency_le_250,latency_le_500,latency_le_1000,latency_le_2500,latency_le_5000,latency_inf,response_bytes,method_get,method_post)
  VALUES (?,?,60,1,59,1,6000,250,20,40,60,60,60,60,60,60,60000,59,1)`) : null;
const minute = Math.floor(Date.now() / 60000) * 60000;
db.exec('BEGIN');
for (let index = 0; index < config.users; index++) {
  const id = `load-user-${index}`, token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url');
  const email = `load-${index}@example.invalid`, now = Date.now();
  userInsert.run(id, email, now, template.password_hash, 'user', '{}', 0, now, now);
  sessionInsert.run(`load-session-${index}`, createHash('sha256').update(token).digest('base64url'), id, csrf, now, now, now + 86400000, now + 86400000);
  users.push({ id, email, cookie: `${cookieName}=${token}`, csrf });
  if (platformKind) {
    const org = `load-org-${index}`;
    db.prepare('INSERT INTO clank_platform_organizations (id,name,slug,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(org, org, org, id, now, now);
    db.prepare('INSERT INTO clank_platform_memberships VALUES (?,?,?,?,?)').run(org, id, 'owner', now, now);
    for (let p = 0; p < 3; p++) {
      const project = `load-project-${index}-${p}`;
      db.prepare(`INSERT INTO clank_platform_projects (id,owner_id,organization_id,name,slug,port,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(project, id, org, project, project, 10000 + index * 3 + p, now, now);
      for (let bucket = 0; bucket < (config.metricBuckets ?? 0); bucket++) metricInsert.run(project, minute - bucket * 60000);
    }
  }
}
db.exec('COMMIT');
db.close();
if (!platformKind) {
  for (const user of users) {
    const caller = await runtime.caller(new Request('http://127.0.0.1:33930/', { headers: { cookie: user.cookie } }));
    caller.mutation('seed', {});
  }
}
await writeFile(join(config.root, 'sessions.json'), JSON.stringify(users), { mode: 0o600 });
} else {
  users = JSON.parse(await readFile(join(config.root, 'sessions.json'), 'utf8'));
}
if (config.kind === 'ingress' && !config.resume) {
  const { createDeploymentBundle, parseDeploymentConfig, deploymentDigest } = await moduleAt('index');
  const control = new DatabaseSync(join(config.root, 'control.sqlite'));
  try {
    for (let index = 0; index < 3; index++) {
      const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
      const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
      const id = `load-project-${index}-0`, user = users[index];
      control.prepare('UPDATE clank_platform_projects SET port=? WHERE id=?').run(port, id);
      const directory = join(config.root, `artifact-${index}`);
      await mkdir(join(directory, 'dist'), { recursive: true }); await mkdir(join(directory, 'migrations'));
      await writeFile(join(directory, 'dist', 'server.js'), `import{createServer}from'node:http';const s=createServer((q,r)=>{r.setHeader('content-type','text/plain');r.end(q.url==='/healthz'?'ok':'load-app-${index}');});s.listen(Number(process.env.PORT),process.env.HOST);process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`);
      const deployment = parseDeploymentConfig({ version: 1, entry: 'dist/server.js', include: ['dist', 'migrations'],
        database: { path: 'app.sqlite', migrations: 'migrations' }, health: { path: '/healthz', timeoutMs: 5000 }, env: {} });
      const artifact = await createDeploymentBundle(directory, deployment, { frameworkVersion: '0.22.0', nodeVersion: process.version });
      const response = await runtime.handle(new Request(`http://127.0.0.1:33930/api/projects/${id}/releases`, {
        method: 'POST', headers: { cookie: user.cookie, origin: 'http://127.0.0.1:33930', 'x-clank-csrf': user.csrf,
          'content-type': 'application/vnd.clank.deploy+gzip', 'content-length': String(artifact.byteLength),
          'x-clank-content-sha256': await deploymentDigest(artifact), 'x-clank-idempotency-key': `load-test-release-key-${index}` }, body: artifact,
      }));
      if (response.status !== 201) throw Error(`Deployment: ${response.status} ${await response.text()}`);
      await response.arrayBuffer();
    }
  } finally { control.close(); }
}
server = await serve(async request => {
  const url = new URL(request.url);
  if (url.pathname === '/healthz') return Response.json({ ok: true });
  if (!platformKind && url.pathname === '/') {
    const caller = await runtime.caller(request);
    const result = caller.query('list', {});
    return new Response(await renderToString(h('main', {}, h('h1', {}, 'Tasks'),
      ...result.value.map(item => h('p', { 'data-id': item._id }, item.title)))), { headers: { 'content-type': 'text/html' } });
  }
  return runtime.handle(request);
}, { hostname: '127.0.0.1', port: 0, onError,
  ...(config.kind === 'ingress' ? { allowedHosts: ['127.0.0.1', ...Array.from({ length: 3 }, (_, n) => `load-project-${n}-0.apps.example.test`)] } : {}) });
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
let cpu = process.cpuUsage(), since = performance.now(), peakRss = process.memoryUsage().rss;
const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
process.on('message', async message => {
  try {
    let result;
    if (message.command === 'reset') {
      global.gc?.(); lag.reset(); cpu = process.cpuUsage(); since = performance.now(); peakRss = process.memoryUsage().rss;
      result = { rss: peakRss };
    } else if (message.command === 'metrics') {
      const usage = process.cpuUsage(cpu);
      result = { rss: process.memoryUsage().rss, peakRss, heapUsed: process.memoryUsage().heapUsed,
        cpuPercent: (usage.user + usage.system) / ((performance.now() - since) * 10),
        eventLoopP99Ms: lag.percentile(99) / 1e6, eventLoopMaxMs: lag.max / 1e6,
        queries: runtime.inspectQueries?.(), errors };
    } else if (message.command === 'revoke') {
      runtime.auth.revokeUserSessions(users[0].id);
      result = true;
    } else if (message.command === 'close') {
      clearInterval(memoryTimer); lag.disable(); await server.close(); await runtime.close();
      process.send({ id: message.id, result: true }); process.disconnect(); return;
    }
    process.send({ id: message.id, result });
  } catch (error) { process.send({ id: message.id, error: error.message }); }
});
const packageJson = JSON.parse(await readFile(join(resolve(config.dist), '..', 'package.json'), 'utf8'));
process.send({ ready: true, url: server.url, users, password, frameworkVersion: packageJson.version });
