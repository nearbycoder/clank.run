import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPlatform } from '../../dist/platform.js';
import { createDeploymentBundle, deploymentDigest, parseDeploymentConfig } from '../../dist/deploy.js';
const config = JSON.parse(process.argv[2]);
const origin = 'http://127.0.0.1:4200';
export function crashPlatformOptions(config) { return { dataDirectory: join(config.root, 'platform'), publicUrl: origin, signup: true,
  appPortStart: config.port ?? 4950, appPortEnd: (config.port ?? 4950) + 3,
  ingress: { baseDomain: 'apps.example.test', domainRecheckIntervalMs: false }, backups: { intervalMs: false },
  ...(config.runner ? { runner: config.runner } : {}),
  canary: { stages: [{ trafficPercent: 100, durationMs: 30000, minimumSamples: 2 }], maximumErrorRate: .1, maximumP95Ms: 1000 } }; }
const platform = await openPlatform(crashPlatformOptions(config));
process.once('message', async message => { if (message === 'close') { await platform.close(); process.exit(0); } });
const request = (path, body, session) => new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin,
  ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(session ? { cookie: session.cookie, 'x-clank-csrf': session.csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async request => { const response = await platform.handle(request); const value = await response.json(); if (!response.ok) throw Error(JSON.stringify(value)); return value; };
const signup = await platform.handle(request('/__clank/auth/register', { email: 'crash@example.test', password: 'correct horse battery staple' }));
if (signup.status !== 201) throw Error(await signup.text());
const account = await signup.json(), session = { cookie: signup.headers.get('set-cookie').split(';')[0], csrf: account.csrfToken };
const { project } = await json(request('/api/projects', { name: 'Crash fixture', slug: 'crash-fixture' }, session));
async function artifact(label) {
  const directory = join(config.root, label); await mkdir(join(directory, 'dist'), { recursive: true }); await mkdir(join(directory, 'migrations'));
  await writeFile(join(directory, 'dist/server.mjs'), `import{createServer}from'node:http';createServer((q,s)=>s.end(q.url==='/healthz'?'ok':${JSON.stringify(label)})).listen(Number(process.env.PORT),process.env.HOST);`);
  await writeFile(join(directory, 'dist/worker.mjs'), `import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(process.env.CLANK_DATABASE_PATH,{timeout:5000});const add=db.prepare('INSERT INTO writer_events(release,pid,at) VALUES(?,?,?)');const write=()=>add.run(${JSON.stringify(label)},process.pid,Date.now());write();setInterval(write,20);`);
  await writeFile(join(directory, 'migrations/0001_writers.sql'), 'CREATE TABLE writer_events(id INTEGER PRIMARY KEY,release TEXT,pid INTEGER,at INTEGER);');
  return createDeploymentBundle(directory, parseDeploymentConfig({ version: 1, entry: 'dist/server.mjs', include: ['dist','migrations'], database: { path: 'app.sqlite', migrations: 'migrations' }, health: { path: '/healthz', timeoutMs: 10000 }, env: {}, jobs: { entry: 'dist/worker.mjs', workers: 1, scheduler: false, concurrency: 1, queues: [] } }), { frameworkVersion: 'test', nodeVersion: process.versions.node });
}
async function deploy(bytes, key) {
  const response = await platform.handle(new Request(origin + `/api/projects/${project.id}/releases`, { method: 'POST', headers: { origin, cookie: session.cookie, 'x-clank-csrf': session.csrf, 'content-type': 'application/vnd.clank.deploy+gzip', 'content-length': String(bytes.byteLength), 'x-clank-content-sha256': await deploymentDigest(bytes), 'x-clank-idempotency-key': key }, body: bytes }));
  if (response.status !== 201) throw Error(await response.text()); return response.json();
}
await deploy(await artifact('stable'), 'crash-stable-release-0001');
const pending = deploy(await artifact('candidate'), 'crash-candidate-release-0002'); pending.catch(error => console.error(error.message));
const deadline = Date.now() + 30000;
while (true) {
  const status = await json(request(`/api/projects/${project.id}/canary`, undefined, session));
  if (status.canaries.some(report => report.state === 'running' && report.trafficPercent === 100)) break;
  if (Date.now() > deadline) throw Error('Canary did not become ready'); await new Promise(resolve => setTimeout(resolve, 25));
}
const guardians = await Promise.all((await readdir(join(config.root, 'platform/runtime-guardians'))).map(name => readFile(join(config.root, 'platform/runtime-guardians', name), 'utf8').then(JSON.parse)));
const databasePath = join(config.root, 'platform/projects', project.id, 'data/app.sqlite');
const database = new DatabaseSync(databasePath, { readOnly: true });
const writerDeadline = Date.now() + 10000;
try {
  while (!database.prepare("SELECT COUNT(*) AS count FROM writer_events WHERE release='candidate'").get().count) {
    if (Date.now() >= writerDeadline) throw Error('Candidate worker never wrote');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
} finally { database.close(); }
process.send({ ready: true, projectId: project.id, databasePath, guardians, options: crashPlatformOptions(config) });
await pending;
