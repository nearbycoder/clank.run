// Privileged acceptance fixture: real provider components, Docker and native HTTP.
// IPC drives only the trusted service API; no runtime, ingress or filesystem calls are injected.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDeploymentBundle, parseDeploymentConfig } from '../../dist/deploy.js';
import { createDeploymentRuntimeCapsule, decodeDeploymentRuntimeCapsule } from '../../dist/runtime-placement.js';
import { openDockerDeploymentProviderService } from '../../dist/provider-service.js';
import { serve } from '../../dist/node.js';

assert.equal(process.getuid(), 1000);
assert.equal(process.getgid(), 1000);
assert.ok(process.getgroups().every(group => group === 1000));
const processStatus = await readFile('/proc/self/status', 'utf8');
assert.match(processStatus, /^Groups:[ \t]*$/m);
for (const field of ['CapEff', 'CapPrm', 'CapInh', 'CapBnd', 'CapAmb']) {
  assert.equal(BigInt('0x' + processStatus.match(new RegExp('^' + field + ':\\s+([a-f0-9]+)$', 'm'))[1]), 0x201002n);
}
assert.match(processStatus, /^NoNewPrivs:\s+1$/m);

const application = `
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
const config=JSON.parse(await readFile(new URL('./fixture.json',import.meta.url),'utf8'));
const writer=process.env.PROVIDER_FIXTURE_WRITER==='1';
const database=new DatabaseSync('/data/app.sqlite',{readOnly:!writer});
database.exec('PRAGMA busy_timeout=5000');
const insert=kind=>database.prepare('INSERT INTO events(label,kind) VALUES(?,?)').run(config.label,kind);
if(writer){insert('startup');setInterval(()=>insert('tick'),50).unref();}
const attempt=async action=>{try{await action();return{ok:true}}catch(error){return{ok:false,code:error.code,message:error.message}}};
createServer(async(request,response)=>{
  const pathname=new URL(request.url,'http://localhost').pathname;
  response.setHeader('content-type','application/json');
  if(pathname==='/healthz'&&config.holdHealth){response.statusCode=503;response.end(JSON.stringify({healthy:false}));return;}
  if(pathname==='/held'){
    response.write(JSON.stringify({label:config.label,held:true})+'\\n');
    const timer=setTimeout(()=>response.end('finished\\n'),25000);
    response.once('close',()=>clearTimeout(timer));return;
  }
  let result={label:config.label,writer,secret:process.env.PROVIDER_FIXTURE_SECRET??null};
  if(pathname==='/write'&&request.method==='POST'){insert('after-checkpoint');result={...result,written:true};}
  if(pathname==='/readonly')result={...result,
    sqlite:await attempt(()=>insert('forbidden-candidate-write')),
    file:await attempt(()=>writeFile('/data/forbidden','forbidden-candidate-write')),
    rows:database.prepare('SELECT label,kind FROM events ORDER BY id').all(),
    headers:request.headers};
  response.setHeader('set-cookie','candidate-cookie=must-not-escape');
  response.setHeader('clear-site-data','"cookies"');
  response.end(JSON.stringify(result));
}).listen(Number(process.env.PORT),process.env.HOST);
`;

let configuration, service, server, closeFlight;
const releaseName = input => {
  assert.match(input, /^[A-Za-z0-9_-]{1,128}$/);
  return input;
};
const runtimePath = releaseId => join(configuration.root, 'fixture-capsules', releaseName(releaseId) + '.clank');
const readRuntime = async releaseId => decodeDeploymentRuntimeCapsule(new Uint8Array(await readFile(runtimePath(releaseId))), { maxDatabaseBytes: 4 * 1024 * 1024 });
const inputFor = (runtime, fence) => ({
  operation: { id: `fixture_reconcile_${runtime.manifest.generation}_${fence}`, projectId: configuration.projectId, fence, attempt: 1, maxAttempts: 1 },
  desired: { generation: runtime.manifest.generation, releaseId: runtime.manifest.releaseId, state: 'running', runtimeProtocol: 'clank-runtime/1' },
  artifact: runtime.artifact, runtime, signal: new AbortController().signal,
});
const close = () => closeFlight ??= (async () => {
  await service?.close();
  await server?.close();
})();
process.once('disconnect', () => { void close().then(() => process.exit(0), () => process.exit(72)); });
process.once('SIGTERM', () => { void close().then(() => process.exit(0), () => process.exit(72)); });

process.on('message', async message => {
  try {
    let value;
    if (message.method === 'open') {
      assert.equal(service, undefined);
      configuration = message.input;
      await mkdir(join(configuration.root, 'docker-config'), { recursive: true, mode: 0o700 });
      service = await openDockerDeploymentProviderService({
        rootDirectory: configuration.root, owner: configuration.owner,
        image: configuration.image, data: { maxDatabaseBytes: 4 * 1024 * 1024 },
        canaries: { readPaths: ['/healthz', '/readonly', '/held'], maximumDurationMs: 120000 },
        drainTimeoutMs: 5000,
        docker: {
          executable: '/usr/bin/docker', allowMutableImage: true,
          dockerEnvironment: { DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONFIG: join(configuration.root, 'docker-config') },
          user: '1000:1000', memory: '256m', cpus: '1', pidsLimit: 64,
          outboundNetwork: { allowCidrs: [] }, portStart: 25340, portEnd: 25348,
          maxRuntimes: 2, maxContainers: 2, stopTimeoutMs: 1000,
        },
        onError(error) { process.stderr.write(`Owned provider diagnostic: ${String(error?.message ?? error).slice(0, 500)}\n`); },
      });
      server = await serve(request => service.handle(request), { hostname: '127.0.0.1', port: 0, maxBodySize: 4 * 1024 * 1024 });
      value = { origin: server.url, pid: process.pid };
    } else if (message.method === 'create-runtime') {
      const input = message.input, releaseId = releaseName(input.releaseId);
      const source = join(configuration.root, 'fixture-source', releaseId);
      await mkdir(join(source, 'dist'), { recursive: true, mode: 0o700 });
      await mkdir(join(source, 'migrations'), { recursive: true, mode: 0o700 });
      await mkdir(join(configuration.root, 'fixture-capsules'), { recursive: true, mode: 0o700 });
      await writeFile(join(source, 'dist/server.mjs'), application, { mode: 0o600 });
      await writeFile(join(source, 'dist/fixture.json'), JSON.stringify({ label: input.label, holdHealth: input.holdHealth === true }), { mode: 0o600 });
      await writeFile(join(source, 'migrations/0001_events.sql'), 'CREATE TABLE events(id INTEGER PRIMARY KEY,label TEXT NOT NULL,kind TEXT NOT NULL);', { mode: 0o600 });
      const artifact = await createDeploymentBundle(source, parseDeploymentConfig({
        version: 1, entry: 'dist/server.mjs', include: ['dist', 'migrations'],
        database: { path: 'app.sqlite', migrations: 'migrations' },
        health: { path: '/healthz', timeoutMs: 30000 }, env: {},
      }));
      const runtime = await createDeploymentRuntimeCapsule({
        projectId: configuration.projectId, releaseId, generation: input.generation,
        environment: { PROVIDER_FIXTURE_WRITER: '1', PROVIDER_FIXTURE_SECRET: 'owned-primary-only-secret' },
        database: { path: 'app.sqlite', mode: input.mode },
        ingress: { route: `/v1/clank/apps/${configuration.projectId}`, token: configuration.ingressToken, controlToken: configuration.controlToken },
        artifact,
      }, { maxDatabaseBytes: 4 * 1024 * 1024 });
      await writeFile(runtimePath(releaseId), runtime.bytes, { mode: 0o600 });
      value = { sha256: runtime.sha256, releaseId };
    } else if (message.method === 'reconcile') {
      const runtime = await readRuntime(message.input.releaseId);
      await service.reconcile(inputFor(runtime, message.input.fence));
      value = await service.inspect(configuration.projectId);
    } else if (message.method === 'prepare') {
      const runtime = await readRuntime(message.input.releaseId);
      const primary = await service.canaries.binding(configuration.projectId);
      assert.ok(primary);
      value = await service.canaries.prepare({ primary, operationId: message.input.operationId,
        controllerEpoch: message.input.controllerEpoch, runtime, signal: new AbortController().signal });
    } else if (message.method === 'inspect') {
      value = { primary: await service.inspect(configuration.projectId), canary: await service.canaries.inspect(configuration.projectId) };
    } else if (message.method === 'stop') {
      value = await service.canaries.stop(message.input);
    } else if (message.method === 'close') {
      await close();
      process.send({ id: message.id, value: true }, () => process.exit(0));
      return;
    } else throw new Error('Unsupported owned provider fixture operation.');
    process.send({ id: message.id, value });
  } catch (error) {
    process.send({ id: message.id, error: String(error.stack ?? error).slice(0, 8192) });
  }
});
