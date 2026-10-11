// Disposable-host acceptance worker. Both roles use production components;
// only the HTTP delivery gate is controlled through the owned parent IPC.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openPlatform } from '../../dist/platform.js';
import { openDockerDeploymentProviderService } from '../../dist/provider-service.js';
import { createDeploymentCoordinatorClient, openProviderDeploymentAgent } from '../../dist/index.js';
import { createLinuxDockerNetworkPlan } from '../../dist/linux-project-isolation.js';

assert.ok(process.send, 'Owned IPC is required.');
assert.equal(process.getuid(), 1000);
assert.equal(process.getgid(), 1000);
const status = await readFile('/proc/self/status', 'utf8');
assert.match(status, /^Groups:[ \t]*$/m);
assert.match(status, /^NoNewPrivs:\s+1$/m);
const role = process.argv[2];
assert.ok(['platform', 'provider'].includes(role));
for (const field of ['CapEff', 'CapPrm', 'CapInh', 'CapBnd', 'CapAmb']) {
  assert.equal(BigInt('0x' + status.match(new RegExp('^' + field + ':\\s+([a-f0-9]+)$', 'm'))[1]), role === 'provider' ? 0x201002n : 0n);
}

let configuration, platform, provider, agent, server, closing;
const gates = new Map(), events = [], diagnostics = [];
const note = event => { events.push(event); if (events.length > 128) events.shift(); };
const execute = promisify(execFile);
const diagnostic = error => { diagnostics.push(String(error?.message ?? error).slice(0, 500)); if (diagnostics.length > 16) diagnostics.shift(); };
const close = () => closing ??= (async () => {
  for (const gate of gates.values()) gate.release();
  await agent?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await platform?.close();
  await provider?.close();
})();
process.once('disconnect', () => { void close().then(() => process.exit(0), () => process.exit(72)); });
process.once('SIGTERM', () => { void close().then(() => process.exit(0), () => process.exit(72)); });

async function listen(port, handler) {
  server = createServer({ maxHeaderSize: 16384, requestTimeout: 120000 }, async (incoming, outgoing) => {
    try {
      // Consume the bounded body before holding delivery. A killed coordinator
      // cannot erase a request already received by this independent provider.
      const chunks = []; let length = 0;
      for await (const chunk of incoming) {
        length += chunk.length;
        if (length > 8 * 1024 * 1024) throw new Error('Owned request exceeds fixture bound.');
        chunks.push(chunk);
      }
      const request = new Request('http://' + incoming.headers.host + incoming.url, {
        method: incoming.method, headers: incoming.headers,
        ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }),
      });
      const action = role === 'provider' ? /\/canary\/(binding|prepare|retire)$/u.exec(new URL(request.url).pathname)?.[1] : undefined;
      const gate = gates.get(action);
      if (gate) { gate.entered++; await gate.promise; }
      const response = await handler(request);
      if (action) note({ kind: 'control', action, status: response.status });
      const bytes = Buffer.from(await response.arrayBuffer());
      // Delayed requests continue through the real service even after their
      // old HTTP socket closes. Only delivery of the response is discarded.
      if (!outgoing.destroyed) { outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(bytes); }
    } catch (error) {
      diagnostic(error);
      if (!outgoing.destroyed) { if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end('Owned fixture request failed.'); }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
}

async function startAgent() {
  assert.equal(agent, undefined);
  agent = await openProviderDeploymentAgent({
    client: createDeploymentCoordinatorClient({ baseUrl: configuration.origin }),
    registrationToken: configuration.registrationToken,
    node: { id: 'docker-canary-provider', region: 'local', endpoint: configuration.endpoint, capacity: 4 },
    provider: {
      kind: 'http',
      async reconcile(input) {
        const cleanup = [];
        let retained;
        try { retained = JSON.parse(await readFile(join(configuration.root, 'service', input.operation.projectId + '.canary-retirements.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        for (const retirement of retained?.entries ?? []) {
          // Observe native resources before invoking the production writer. A
          // failed oracle fails this acceptance test; it supplies no cleanup.
          assert.equal(retirement.phase, 'retired');
          const id = retirement.candidateProjectId;
          const plan = await createLinuxDockerNetworkPlan(configuration.owner, id, { allowCidrs: [] });
          const run = async (executable, args) => {
            try { return { code: 0, ...await execute(executable, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
              env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONFIG: join(configuration.root, 'docker-config') } }) }; }
            catch (error) { if (typeof error.code !== 'number') throw error; return { code: error.code, stdout: error.stdout ?? '' }; }
          };
          const containers = await run('/usr/bin/docker', ['container', 'ls', '--all', '--quiet', '--filter', 'label=run.clank.owner=' + configuration.owner, '--filter', 'label=run.clank.project=' + id]);
          assert.equal(containers.code, 0); assert.equal(containers.stdout.trim(), '');
          assert.equal(existsSync(join(configuration.root, 'projects', id)), false);
          assert.notEqual((await run('/usr/bin/docker', ['network', 'inspect', plan.network])).code, 0);
          assert.notEqual((await run(existsSync('/usr/sbin/nft') ? '/usr/sbin/nft' : '/usr/bin/nft', ['list', 'table', 'inet', plan.table])).code, 0);
          cleanup.push({ candidateProjectId: id, retired: true, absent: true });
        }
        note({ kind: 'reconcile', projectId: input.operation.projectId, generation: input.desired.generation, mode: input.runtime?.manifest.database.mode, cleanup });
        return provider.reconcile(input);
      },
      rollback: input => provider.rollback(input), delete: input => provider.delete(input),
    },
    pollIntervalMs: 25, heartbeatIntervalMs: 250,
  });
}

process.on('message', async message => {
  try {
    let value;
    if (message.method === 'open') {
      assert.equal(configuration, undefined); configuration = message.input;
      if (role === 'platform') {
        platform = await openPlatform({
          dataDirectory: configuration.root, publicUrl: configuration.origin,
          hostingProfile: 'trusted', sqliteIsolation: 'trusted-process', signup: 'bootstrap',
          platformAdminEmails: ['docker-canary@example.test'],
          appPortStart: configuration.appPortStart, appPortEnd: configuration.appPortEnd,
          supervisor: { configurationId: 'owned-docker-canary-platform', configurationRevision: 1, leaseMs: 5000, pollIntervalMs: 50 },
          backups: { intervalMs: false }, previews: { cleanupIntervalMs: false },
          ingress: { baseDomain: 'apps.example.test' },
          deploymentAgents: { registrationToken: configuration.registrationToken, placement: { activationTimeoutMs: 15000 } },
          ...(configuration.disabled ? {} : { canary: {
            stages: configuration.stages, maximumErrorRate: 0.2, maximumP95Ms: 3000,
            provider: { databasePolicy: 'isolated-read-only', readPaths: ['/', '/healthz'] },
          } }), onError: diagnostic,
        });
        await listen(configuration.port, request => platform.handle(request));
      } else {
        await mkdir(join(configuration.root, 'docker-config'), { recursive: true, mode: 0o700 });
        provider = await openDockerDeploymentProviderService({
          rootDirectory: configuration.root, owner: configuration.owner, image: configuration.image,
          data: { maxDatabaseBytes: 4 * 1024 * 1024 }, drainTimeoutMs: 2000,
          canaries: { readPaths: ['/', '/healthz'], maximumDurationMs: 120000, controlTimeoutMs: 30000 },
          docker: {
            executable: '/usr/bin/docker', allowMutableImage: true,
            dockerEnvironment: { DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONFIG: join(configuration.root, 'docker-config') },
            user: '1000:1000', memory: '256m', cpus: '1', pidsLimit: 64,
            outboundNetwork: { allowCidrs: [] }, portStart: configuration.portStart, portEnd: configuration.portEnd,
            maxRuntimes: 2, maxContainers: 2, stopTimeoutMs: 1000,
          }, onError: diagnostic,
        });
        await listen(configuration.port, request => provider.handle(request));
        await startAgent();
      }
      value = { pid: process.pid };
    } else if (message.method === 'status') {
      value = { supervisor: platform?.supervisor(), events: [...events], diagnostics: [...diagnostics], gates: Object.fromEntries([...gates].map(([key, gate]) => [key, gate.entered])) };
    } else if (message.method === 'hold') {
      assert.equal(role, 'provider'); assert.ok(['prepare', 'retire'].includes(message.input)); assert.equal(gates.has(message.input), false);
      let release; const promise = new Promise(resolve => { release = resolve; });
      gates.set(message.input, { promise, release, entered: 0 }); value = true;
    } else if (message.method === 'release') {
      assert.equal(role, 'provider'); const gate = gates.get(message.input); assert.ok(gate);
      gates.delete(message.input); gate.release(); value = true;
    } else if (message.method === 'stop-agent') {
      await agent.close(); agent = undefined; value = true;
    } else if (message.method === 'start-agent') {
      await startAgent(); value = true;
    } else if (message.method === 'close') {
      await close(); process.send({ id: message.id, value: true }, () => process.exit(0)); return;
    } else throw new Error('Unsupported owned fixture operation.');
    process.send({ id: message.id, value });
  } catch (error) { process.send({ id: message.id, error: String(error.stack ?? error).slice(0, 8192) }); }
});
