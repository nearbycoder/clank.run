import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defineDatabase, openSQLite } from '../dist/index.js';
import { SQLITE_INTERNAL } from '../dist/sqlite-internal.js';
import { createManagedCanary } from '../dist/managed-canary.js';
import { createManagedIngress } from '../dist/data-plane.js';
import { openSupervisorLease } from '../dist/platform-supervisor.js';

const gate = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };

async function fixture(t, { provider = false, streaming = false, durationMs = 10000, minimumSamples = 1, healthCheck = async () => undefined } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clank-managed-canary-drain-'));
  const database = await openSQLite(defineDatabase({}), { path: join(root, 'control.sqlite') });
  const lease = await openSupervisorLease(join(root, 'lease.sqlite'), { configurationId: 'canary-drain', configurationRevision: 1, leaseMs: 30000, pollIntervalMs: 50 });
  assert.equal(lease.acquire(), true);
  const revoker = new DatabaseSync(join(root, 'lease.sqlite'));
  const policy = { stages: [{ trafficPercent: 100, durationMs, minimumSamples }], maximumErrorRate: 0.1, maximumP95Ms: 10000 };
  const canaries = createManagedCanary(database[SQLITE_INTERNAL], policy);
  const received = gate(), disconnected = gate(), failures = [], metrics = [], selections = [], requests = [];
  let held, run, source, candidateRequests = 0;
  const server = createServer((request, response) => {
    requests.push(request.url); candidateRequests++;
    if (request.url.endsWith('/fail')) { response.writeHead(500); response.end('failed'); return; }
    if (request.url.endsWith('/ok')) { response.writeHead(200); response.end('ok'); return; }
    held = response; response.on('close', () => disconnected.resolve());
    if (streaming) { response.writeHead(200); response.write('first'); }
    received.resolve();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${server.address().port}`;
  const runtime = (project, generation) => ({ protocol: 'clank-runtime/1', generation, path: `/v1/clank/apps/${project}`, token: `${project}-private-ingress-token-12345678901234567890` });
  const primary = { id: 'route_01', projectId: 'project_primary', releaseId: 'release_primary', upstream, hosts: ['app.example.test'], active: true,
    ...(provider ? { runtime: runtime('project_primary', 1) } : {}) };
  const candidate = { upstream, releaseId: 'release_candidate', ...(provider ? { projectId: 'project_candidate', runtime: runtime('project_candidate', 1), readPaths: ['/held', '/fail'] } : {}) };
  source = () => [{ ...primary, canary: canaries.route(primary.projectId) }];
  const assertion = route => { selections.push(route); return canaries.assertCurrent(route); };
  const ingress = createManagedIngress({ routes: () => source(), retries: 0, assertCanaryCurrent: assertion,
    onRequest: metric => { metrics.push(metric); canaries.record(metric); } });
  t.after(async () => {
    canaries.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await run; revoker.close(); lease.close(); database.close(); await rm(root, { recursive: true, force: true });
  });
  run = canaries.run(primary.projectId, candidate.releaseId, upstream, healthCheck,
    { assertCurrent: () => lease.assertCurrent(), ...(provider ? { route: candidate, primary } : {}) }).catch(error => { failures.push(error); });
  // The first asynchronous health boundary precedes publishing the stage.
  while (canaries.route(primary.projectId)?.trafficPercent !== 100) await new Promise(resolve => setTimeout(resolve, 1));
  return {
    ingress, canaries, metrics, selections, requests, received, disconnected, assertion,
    catalogPath: join(root, 'control.sqlite'), settle: () => run, failures,
    assertLeaseCurrent: () => lease.assertCurrent(),
    ingressWithRetries: retries => createManagedIngress({ routes: () => source(), retries, timeoutMs: 2000,
      assertCanaryCurrent: assertion, onRequest: metric => { metrics.push(metric); canaries.record(metric); } }),
    get held() { return held; }, get candidateRequests() { return candidateRequests; },
    request: path => new Request(`https://app.example.test${path}`),
    reuseSelection: route => { source = () => [route]; },
    revoke(mode = 'replace') {
      if (mode === 'delete') revoker.exec('DELETE FROM clank_platform_supervisor_lease');
      else revoker.prepare('UPDATE clank_platform_supervisor_lease SET token_hash=?,epoch=epoch+1').run('9'.repeat(64));
    },
    async fail() {
      const response = await ingress.handle(new Request('https://app.example.test/fail'));
      assert.equal(response.status, 500); assert.equal(await response.text(), 'failed');
      await run;
      assert.equal(failures.length, 1); assert.match(failures[0].message, /Canary guardrail failed/);
      assert.equal(canaries.route(primary.projectId), undefined);
      assert.equal(canaries.reports(primary.projectId)[0].state, 'failed');
    },
  };
}

for (const retries of [0, 2]) test(`withdrawn local canary cannot turn a failed admitted fetch into ${retries} fresh retries`, { timeout: 15000 }, async t => {
  const f = await fixture(t), ingress = f.ingressWithRetries(retries);
  const pending = ingress.handle(f.request('/held')); await f.received.promise;
  await f.fail(); f.assertLeaseCurrent();
  const before = f.candidateRequests;assert.equal(before, 2);
  f.held.destroy();const response = await pending;
  assert.equal(f.candidateRequests, before, 'Drain admission must never authorize a new candidate fetch.');
  assert.equal(response.status, 503);assert.equal((await response.json()).error.code, 'CANARY_UNAVAILABLE');
  assert.equal(ingress.activeRequests(f.selections[0].canary.upstream), 0);
});

test('an admitted local request drains while even its exact cached selection cannot admit a new request', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const pending = f.ingress.handle(f.request('/held')); await f.received.promise;
  const admitted = f.selections[0]; assert.equal(Object.isFrozen(admitted), true);
  await f.fail();
  const before = f.candidateRequests;
  // Deliberately return the actual previously admitted callback object, rather
  // than merely an equal route. The ingress must allocate a request-local key.
  f.reuseSelection(admitted);
  for (let index = 0; index < 2; index++) {
    const response = await f.ingress.handle(f.request('/held'));
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'CANARY_UNAVAILABLE');
    assert.notEqual(f.selections.at(-1), admitted);
  }
  assert.equal(f.candidateRequests, before, 'Withdrawn route reuse cannot submit another candidate fetch.');
  f.held.end('drained'); const response = await pending;
  assert.equal(response.status, 200); assert.equal(await response.text(), 'drained');
  assert.equal(f.metrics.at(-1).releaseId, 'release_candidate'); assert.equal(f.metrics.at(-1).responseOutcome, 'complete');
  assert.equal(await f.ingress.drain(admitted.canary.upstream, 100), true);
});

for (const mode of ['replace', 'delete']) test(`an admitted local request loses native authority during drain after lease ${mode}`, { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const pending = f.ingress.handle(f.request('/held')); await f.received.promise;
  await f.fail(); f.revoke(mode); f.held.end('stale');
  const response = await pending;
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'CANARY_UNAVAILABLE');
  assert.equal(f.candidateRequests, 2); assert.equal(f.metrics.at(-1).releaseId, 'release_candidate');
});

test('an admitted local body completes after measurement withdraws it while native authority remains current', { timeout: 15000 }, async t => {
  const f = await fixture(t, { streaming: true });
  const response = await f.ingress.handle(f.request('/held')), reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
  await f.fail(); f.held.end('last');
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'last'); assert.equal((await reader.read()).done, true);
  assert.equal(f.metrics.at(-1).responseBytes, 9); assert.equal(f.metrics.at(-1).responseOutcome, 'complete');
});

for (const when of ['before read', 'during read']) test(`native lease loss ${when} cancels an admitted local body after route withdrawal`, { timeout: 15000 }, async t => {
  const f = await fixture(t, { streaming: true });
  const response = await f.ingress.handle(f.request('/held')), reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first'); await f.fail();
  const pending = when === 'during read' ? reader.read() : undefined;
  pending?.catch(() => undefined);
  // Let an actual read cross its awaited native HTTP boundary before revoking.
  if (pending) await new Promise(resolve => setImmediate(resolve));
  f.revoke(); const rejected = assert.rejects(pending ?? reader.read(), error => error.code === 'SUPERVISOR_LEASE_LOST');
  if (pending) f.held.write('stale');
  await rejected; await f.disconnected.promise;
  assert.equal(f.metrics.at(-1).responseBytes, 5); assert.equal(f.metrics.at(-1).responseOutcome, 'error');
});

test('provider responses remain invalid after measurement withdrawal even while native authority is current', { timeout: 15000 }, async t => {
  const f = await fixture(t, { provider: true });
  const pending = f.ingress.handle(f.request('/held')); await f.received.promise;
  await f.fail(); f.held.end('withdrawn provider response');
  const response = await pending;
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'CANARY_UNAVAILABLE');
  assert.equal(f.candidateRequests, 2);
});

test('closing the local coordinator invalidates even its already admitted drain continuation', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const pending = f.ingress.handle(f.request('/held')); await f.received.promise;
  await f.fail(); f.canaries.close(); f.held.end('closed coordinator');
  const response = await pending;
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'CANARY_UNAVAILABLE');
});

for (const status of [200, 500]) test(`canary assessment includes ${status} responses completed during an awaited health check`, { timeout: 15000 }, async t => {
  const entered = gate(), release = gate();
  // Release a failed assertion's held health check before fixture teardown waits.
  t.after(() => release.resolve());
  let checks = 0;
  const durationMs = 1500;
  const f = await fixture(t, { durationMs, minimumSamples: 2, healthCheck: async () => {
    if (++checks === 2) { entered.resolve(); await release.promise; }
  } });
  await entered.promise;
  const observer = new DatabaseSync(f.catalogPath, { readOnly: true });
  const retained = () => JSON.parse(observer.prepare('SELECT report FROM clank_platform_canaries WHERE release_id=?').get('release_candidate').report);
  try {
    const stage = retained();
    for (let index = 0; index < 2; index++) {
      const response = await f.ingress.handle(f.request(status === 500 ? '/fail' : '/ok'));
      assert.equal(response.status, status);
      assert.equal(await response.text(), status === 500 ? 'failed' : 'ok');
    }
    assert.equal(f.metrics.length, 2);
    assert.ok(f.metrics.every(metric => metric.admitted && metric.releaseId === 'release_candidate'
      && metric.recordedAt <= stage.updatedAt + durationMs), 'Both native responses must finish inside the original stage window.');
    // Keep the health await open past the original deadline. Its earlier empty
    // snapshot cannot decide the stage after these real responses complete.
    await new Promise(resolve => setTimeout(resolve, Math.max(1, stage.updatedAt + durationMs + 100 - Date.now())));
    release.resolve(); await f.settle();
    const final = retained();
    assert.equal(final.samples, 2);
    assert.equal(final.errorRate, status === 500 ? 1 : 0);
    assert.equal(final.state, status === 500 ? 'failed' : 'passed');
    if (status === 500) {
      assert.equal(f.failures.length, 1); assert.match(f.failures[0].message, /Canary guardrail/);
    } else assert.deepEqual(f.failures, []);
  } finally { observer.close(); }
});

for (const mode of ['close', 'lease replacement']) test(`canary cannot publish after ${mode} during an awaited health check`, { timeout: 15000 }, async t => {
  const entered = gate(), release = gate();
  t.after(() => release.resolve());
  let checks = 0;
  const f = await fixture(t, { durationMs: 1500, minimumSamples: 2, healthCheck: async () => {
    if (++checks === 2) { entered.resolve(); await release.promise; }
  } });
  for (let index = 0; index < 2; index++) {
    const response = await f.ingress.handle(f.request('/ok'));
    assert.equal(response.status, 200); assert.equal(await response.text(), 'ok');
  }
  await entered.promise;
  if (mode === 'close') f.canaries.close(); else f.revoke();
  // Cross the stage deadline while health is held; no later loop iteration
  // can repair an authority or shutdown check omitted after this await.
  await new Promise(resolve => setTimeout(resolve, 650));
  release.resolve(); await f.settle();
  const observer = new DatabaseSync(f.catalogPath, { readOnly: true });
  try {
    const final = JSON.parse(observer.prepare('SELECT report FROM clank_platform_canaries WHERE release_id=?').get('release_candidate').report);
    assert.equal(final.state, mode === 'close' ? 'failed' : 'running');
    // A lost lease cannot publish a failed report either; its retained running
    // row belongs to the next owner. Closing a current owner records failure.
    assert.equal(f.failures.length, 1);
    assert.match(f.failures[0].message, mode === 'close' ? /Platform closed/ : /leadership|lease|ownership/i);
  } finally { observer.close(); }
});


test('canary final health check cannot publish an earlier healthy sample snapshot', { timeout: 15000 }, async t => {
  const measured = gate(), resumeMeasurement = gate(), entered = gate(), release = gate();
  t.after(() => { resumeMeasurement.resolve(); release.resolve(); });
  let checks = 0;
  const f = await fixture(t, { durationMs: 1500, minimumSamples: 2, healthCheck: async () => {
    checks++;
    if (checks === 2) { measured.resolve(); await resumeMeasurement.promise; }
    if (checks === 3) { entered.resolve(); await release.promise; }
  } });
  // Observe genuine stage progress before sending healthy samples. Requests
  // completed in the stage's initial wall-clock millisecond are excluded.
  await measured.promise;
  const stage = f.canaries.reports('project_primary')[0];
  for (let index = 0; index < 2; index++) {
    const response = await f.ingress.handle(f.request('/ok'));
    assert.equal(response.status, 200); assert.equal(await response.text(), 'ok');
  }
  assert.equal(f.metrics.length, 2);
  assert.ok(f.metrics.every(metric => metric.admitted && metric.recordedAt > stage.updatedAt));
  resumeMeasurement.resolve();
  await Promise.race([entered.promise, f.settle().then(() => { throw new Error('Canary completed before the final health gate: ' + f.failures.map(error => error.message).join('; ')); })]);
  for (let index = 0; index < 2; index++) {
    const response = await f.ingress.handle(f.request('/fail'));
    assert.equal(response.status, 500); assert.equal(await response.text(), 'failed');
  }
  release.resolve(); await f.settle();
  const observer = new DatabaseSync(f.catalogPath, { readOnly: true });
  try {
    const final = JSON.parse(observer.prepare('SELECT report FROM clank_platform_canaries WHERE release_id=?').get('release_candidate').report);
    assert.equal(final.state, 'failed');
    assert.equal(final.samples, 4); assert.equal(final.errorRate, 0.5);
    assert.equal(f.failures.length, 1); assert.match(f.failures[0].message, /Canary guardrail/);
  } finally { observer.close(); }
});
