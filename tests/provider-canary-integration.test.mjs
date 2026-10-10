import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { chown, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLinuxDockerNetworkPlan } from '../dist/linux-project-isolation.js';

const execute = promisify(execFile);
const executable = name => existsSync(`/usr/bin/${name}`) ? `/usr/bin/${name}` : `/usr/sbin/${name}`;
async function command(name, args, allowFailure = false) {
  try { return { code: 0, ...await execute(executable(name), args, { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 }) }; }
  catch (error) { if (!allowFailure) throw error; return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, description, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    assert.ok(Date.now() < deadline, description);
    await pause(25);
  }
}
function controller() {
  const framework = dirname(dirname(fileURLToPath(import.meta.url)));
  const fixture = join(framework, 'tests/fixtures/provider-canary-controller.mjs');
  const child = spawn('/usr/bin/unshare', ['--mount', '--propagation', 'private', '/usr/bin/setpriv',
    '--reuid=1000', '--regid=1000', '--clear-groups',
    '--inh-caps=+sys_admin,+net_admin,+dac_override', '--ambient-caps=+sys_admin,+net_admin,+dac_override',
    '--bounding-set=-all,+sys_admin,+net_admin,+dac_override', '--no-new-privs', process.execPath, fixture],
  { cwd: framework, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C', NODE_NO_WARNINGS: '1' } });
  let sequence = 0, stderr = '';
  const pending = new Map();
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-16384); });
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`Owned provider exited (${code}/${signal}): ${stderr}`)); }
    pending.clear(); resolve({ code, signal });
  }));
  child.on('error', error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  });
  child.on('message', message => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.value);
  });
  return { child, exited, rpc(method, input) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Owned provider ${method} timed out: ${stderr}`)); }, 60000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, method, input }, error => { if (error) { pending.delete(id); clearTimeout(timer); reject(error); } });
    });
  } };
}
const routeHeaders = route => ({ 'x-clank-project-id': route.projectId, 'x-clank-runtime-protocol': 'clank-runtime/1',
  'x-clank-runtime-generation': String(route.generation), 'x-clank-runtime-ingress': route.token });
async function ownedContainers(owner, projectId) {
  const result = await command('docker', ['container', 'ls', '--all', '--quiet', '--filter', `label=run.clank.owner=${owner}`,
    ...(projectId ? ['--filter', `label=run.clank.project=${projectId}`] : [])]);
  return result.stdout.trim().split('\n').filter(Boolean);
}
async function readJournal(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function counts(databasePath) {
  // SELECT may need a writable handle to recover a hot rollback journal after SIGKILL.
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout=5000');
    return database.prepare('SELECT label,kind,COUNT(*) AS total FROM events GROUP BY label,kind ORDER BY label,kind').all();
  } finally { database.close(); }
}

for (const phase of ['preparing', 'running', 'stopping']) test(`real provider controller SIGKILL during ${phase} retires the isolated candidate before primary admission`, {
  skip: process.env.CLANK_DOCKER_INTEGRATION !== '1' ? 'requires CLANK_DOCKER_INTEGRATION=1 on a disposable VM' : false,
  timeout: 180000,
}, async () => {
  assert.equal(process.env.CLANK_DISPOSABLE_TEST_HOST, '1');
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const image = process.env.CLANK_DOCKER_TEST_IMAGE ?? 'node:24-bookworm-slim';
  await command('docker', ['image', 'inspect', image]); // Never pull an unverified or mutable image implicitly.
  const root = await mkdtemp(join(tmpdir(), 'clank-provider-canary-native-'));
  // SQLite workers clear the controller's administrative capabilities before
  // resolving pinned mounts, so their uid must also own this private ancestor.
  await chown(root, 1000, 1000);
  const providerRoot = join(root, 'provider'); await mkdir(providerRoot, { mode: 0o700 }); await chown(providerRoot, 1000, 1000);
  const owner = `canary-native-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const projectId = 'native_canary_primary', releaseId = 'native_primary_release', candidateReleaseId = 'native_candidate_release';
  const configuration = { root: providerRoot, owner, projectId, image,
    ingressToken: 'clanki_owned_provider_canary_native_1234567890123456789', controlToken: 'clankc_owned_provider_canary_native_1234567890123456789' };
  const primaryRoute = { projectId, generation: 1, token: configuration.ingressToken, path: `/v1/clank/apps/${projectId}` };
  const databasePath = join(providerRoot, 'projects', projectId, 'data/app.sqlite');
  const journalPath = join(providerRoot, 'service', `${projectId}.canary.json`);
  const plans = new Map(), children = [];
  plans.set(projectId, await createLinuxDockerNetworkPlan(owner, projectId, { allowCidrs: [] }));
  let activeController, prepared, candidateId, held, pendingOperation;
  try {
    activeController = controller(); children.push(activeController);
    let { origin } = await activeController.rpc('open', configuration);
    await activeController.rpc('create-runtime', { releaseId, generation: 1, label: 'primary', mode: 'initialize' });
    await activeController.rpc('reconcile', { releaseId, fence: 1 });
    const primary = await fetch(origin + primaryRoute.path + '/healthz', { headers: routeHeaders(primaryRoute) });
    assert.equal(primary.status, 200); assert.equal((await primary.json()).label, 'primary');
    await until(() => counts(databasePath).some(row => row.label === 'primary' && row.kind === 'tick' && row.total > 1), 'The real primary must write before checkpointing.');
    await activeController.rpc('create-runtime', { releaseId: candidateReleaseId, generation: 2, label: 'candidate', mode: 'preserve', holdHealth: phase === 'preparing' });
    pendingOperation = activeController.rpc('prepare', { releaseId: candidateReleaseId, operationId: `native_canary_${phase}`, controllerEpoch: 1 });
    pendingOperation.catch(() => {});
    if (phase === 'preparing') {
      const journal = await until(async () => {
        const value = await readJournal(journalPath);
        if (value?.current.phase !== 'preparing') return false;
        const ids = await ownedContainers(owner, value.current.candidateProjectId);
        if (ids.length !== 1) return false;
        const details = JSON.parse((await command('docker', ['container', 'inspect', ids[0]])).stdout)[0];
        return details.State.Running ? value : false;
      }, 'An actual candidate container must exist while its health admission is still pending.');
      candidateId = journal.current.candidateProjectId;
    } else {
      prepared = await pendingOperation; pendingOperation = undefined;
      candidateId = prepared.candidateProjectId;
      assert.equal(prepared.phase, 'running');
      const response = await fetch(origin + prepared.route.path + '/readonly', { headers: { ...routeHeaders(prepared.route), 'x-private-fixture': 'must-be-stripped' } });
      assert.equal(response.status, 200); assert.equal(response.headers.has('set-cookie'), false); assert.equal(response.headers.has('clear-site-data'), false);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const candidate = await response.json();
      assert.equal(candidate.label, 'candidate'); assert.equal(candidate.writer, false); assert.equal(candidate.secret, null);
      assert.equal(candidate.sqlite.ok, false); assert.match(candidate.sqlite.message, /readonly/iu); assert.equal(candidate.file.code, 'EROFS');
      assert.equal(candidate.headers['x-private-fixture'], undefined);
      assert.ok(candidate.rows.length > 0); assert.ok(candidate.rows.every(row => row.label === 'primary'));
      const write = await fetch(origin + primaryRoute.path + '/write', { method: 'POST', headers: routeHeaders(primaryRoute) });
      assert.equal(write.status, 200); assert.equal((await write.json()).written, true);
      assert.ok(counts(databasePath).some(row => row.kind === 'after-checkpoint'));
      if (phase === 'stopping') {
        held = await fetch(origin + prepared.route.path + '/held', { headers: routeHeaders(prepared.route) });
        assert.equal(held.status, 200);
        // A real incomplete upstream HTTP stream holds the native ingress drain.
        pendingOperation = activeController.rpc('stop', {
          primary: prepared.primary, operationId: prepared.operationId, controllerEpoch: prepared.controllerEpoch,
          releaseId: prepared.releaseId, capsuleSha256: prepared.capsuleSha256, retirementEpoch: prepared.controllerEpoch,
        });
        pendingOperation.catch(() => {});
        await until(async () => (await readJournal(journalPath))?.current.phase === 'stopping', 'Cleanup intent must precede the native stream drain.');
      }
    }
    plans.set(candidateId, await createLinuxDockerNetworkPlan(owner, candidateId, { allowCidrs: [] }));
    const beforeIds = await ownedContainers(owner);
    assert.equal(beforeIds.length, 2, 'The native primary and isolated candidate must both be real owned containers at the crash boundary.');
    for (const id of beforeIds) {
      const details = JSON.parse((await command('docker', ['container', 'inspect', id])).stdout)[0];
      assert.equal(details.Config.Labels['run.clank.owner'], owner);
      if (details.Config.Labels['run.clank.project'] === candidateId) {
        assert.equal(details.Mounts.find(mount => mount.Destination === '/data').RW, false);
        assert.equal(details.HostConfig.ReadonlyRootfs, true);
      }
    }
    activeController.child.kill('SIGKILL');
    assert.equal((await activeController.exited).signal, 'SIGKILL');
    await pendingOperation?.catch(() => {}); pendingOperation = undefined;
    await held?.body?.cancel().catch(() => {}); held = undefined;
    activeController = controller(); children.push(activeController);
    ({ origin } = await activeController.rpc('open', configuration));
    for (const id of beforeIds) assert.notEqual((await command('docker', ['container', 'inspect', id], true)).code, 0, 'No pre-crash container may survive provider readiness.');
    assert.deepEqual(await ownedContainers(owner), [], 'Provider readiness precedes any replacement primary launch.');
    assert.equal((await activeController.rpc('inspect')).canary.phase, 'stopped');
    assert.equal(existsSync(join(providerRoot, 'projects', candidateId)), false, 'The isolated candidate data must be removed before admitting the primary.');
    const candidatePlan = plans.get(candidateId);
    assert.notEqual((await command('docker', ['network', 'inspect', candidatePlan.network], true)).code, 0, 'Restart must remove the candidate bridge.');
    assert.notEqual((await command('nft', ['list', 'table', 'inet', candidatePlan.table], true)).code, 0, 'Restart must remove the candidate outbound policy after its bridge is gone.');
    const unavailable = await fetch(origin + primaryRoute.path + '/healthz', { headers: routeHeaders(primaryRoute) });
    assert.equal(unavailable.status, 503, 'The previous primary is not admitted merely by opening the controller.');
    assert.equal((await unavailable.json()).error.code, 'RUNTIME_UNAVAILABLE');
    const stoppedRows = counts(databasePath);
    assert.ok(stoppedRows.every(row => row.label === 'primary'), 'Candidate writes must never reach the production database.');
    await pause(150); assert.deepEqual(counts(databasePath), stoppedRows, 'Old primary writers must remain stopped until explicit reconciliation.');
    await activeController.rpc('reconcile', { releaseId, fence: 2 });
    const resumed = await fetch(origin + primaryRoute.path + '/healthz', { headers: routeHeaders(primaryRoute) });
    assert.equal(resumed.status, 200); assert.equal((await resumed.json()).label, 'primary');
    await until(() => counts(databasePath).some(row => row.kind === 'startup' && row.total === 2), 'The original primary resumes only after verified candidate cleanup.');
    assert.ok(counts(databasePath).every(row => row.label === 'primary'));
    if (phase !== 'preparing') assert.ok(counts(databasePath).some(row => row.kind === 'after-checkpoint'), 'Recovery preserves writes accepted by the live primary after the candidate checkpoint.');
    await activeController.rpc('close'); await activeController.exited;
    assert.deepEqual(await ownedContainers(owner), []);
    for (const plan of plans.values()) {
      assert.notEqual((await command('docker', ['network', 'inspect', plan.network], true)).code, 0);
      assert.notEqual((await command('nft', ['list', 'table', 'inet', plan.table], true)).code, 0);
    }
  } finally {
    await held?.body?.cancel().catch(() => {});
    for (const worker of children) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
      await worker.exited;
    }
    await pendingOperation?.catch(() => {});
    // Clean only exact resources from this fixture, even when an assertion fails.
    for (const id of await ownedContainers(owner)) await command('docker', ['container', 'rm', '--force', id], true);
    const retained = await readJournal(journalPath);
    if (retained) plans.set(retained.current.candidateProjectId, await createLinuxDockerNetworkPlan(owner, retained.current.candidateProjectId, { allowCidrs: [] }));
    for (const plan of plans.values()) {
      await command('docker', ['network', 'rm', plan.network], true);
      await command('nft', ['delete', 'table', 'inet', plan.table], true);
    }
    await rm(root, { recursive: true, force: true });
  }
});
