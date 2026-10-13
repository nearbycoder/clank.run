import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { deploymentDigest } from '../dist/index.js';
import { inspectLinuxHostCertification } from '../dist/host-certification.js';
import { fixture, artifact, command, until, ownedContainers } from './fixtures/platform-provider-docker-native.mjs';

const enabled = process.env.CLANK_DOCKER_INTEGRATION === '1' && process.env.CLANK_DISPOSABLE_TEST_HOST === '1' && Boolean(process.env.CLANK_SHADOW_CERTIFICATE_CONFIG);
const settings = { skip: enabled ? false : 'requires disposable Docker host and independently generated CLANK_SHADOW_CERTIFICATE_CONFIG', timeout: 240000 };
async function fresh(f) {
  // Fixture signing key, never physical-device acceptance. Freshness is granted
  // only by the actual native authentication HTTP challenge/signature exchange.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const id = 'docker-shadow-' + randomUUID(), credentialId = Buffer.from(id).toString('base64url');
  f.control.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)')
    .run(id, credentialId, f.user.id, 'Owned Docker shadow key', JSON.stringify(publicKey.export({ format: 'jwk' })), '[]', Date.now());
  const auth = { method: 'POST', cookie: f.cookie, csrf: f.csrf };
  const started = (await f.json('/__clank/auth/reauthenticate/passkey/start', { ...auth, body: {} })).value;
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: started.options.challenge, origin: f.origin, crossOrigin: false }));
  const data = Buffer.concat([createHash('sha256').update(new URL(f.origin).hostname).digest(), Buffer.from([5, 0, 0, 0, 1])]);
  const credential = { id: credentialId, rawId: credentialId, type: 'public-key', response: {
    clientDataJSON: client.toString('base64url'), authenticatorData: data.toString('base64url'),
    signature: sign('sha256', Buffer.concat([data, createHash('sha256').update(client).digest()]), privateKey).toString('base64url'), userHandle: null,
  } };
  await f.json('/__clank/auth/reauthenticate/passkey/finish', { ...auth, body: { challengeId: started.challengeId, challenge: started.options.challenge, credential } });
}
async function setup(t) {
  const certificate = JSON.parse(await readFile(process.env.CLANK_SHADOW_CERTIFICATE_CONFIG, 'utf8'));
  const inspected = await inspectLinuxHostCertification(certificate);
  assert.equal(inspected.current, true, JSON.stringify(inspected)); assert.equal(inspected.report.status, 'passed');
  assert.ok(inspected.report.expiresAt > Date.now() + settings.timeout);
  const selectedImage = JSON.parse((await command('docker', ['image', 'inspect', process.env.CLANK_DOCKER_TEST_IMAGE ?? 'node:24-bookworm-slim'])).stdout)[0];
  const certifiedImage = JSON.parse((await command('docker', ['image', 'inspect', certificate.profile.image])).stdout)[0];
  assert.equal(selectedImage.Id, certifiedImage.Id, 'Actual provider image must match the independently certified profile.');
  const f = await fixture(t, undefined, { shadowCertificate: certificate }); await fresh(f);
  const bytes = await artifact(f.root, 'shadow');
  const response = await fetch(f.origin + '/api/projects/' + f.project.id + '/releases/stage', { method: 'POST',
    headers: { origin: f.origin, cookie: f.cookie, 'x-clank-csrf': f.csrf, 'content-type': 'application/vnd.clank.deploy+gzip',
      'x-clank-content-sha256': await deploymentDigest(bytes), 'x-clank-idempotency-key': 'docker-shadow-stage-0001' }, body: bytes, signal: AbortSignal.timeout(30000) });
  const staged = await response.json(); assert.equal(response.status, 201, JSON.stringify(staged));
  f.shadow = async (path, body, expected = 200) => (await f.json('/api/projects/' + f.project.id + '/shadow/' + path,
    { method: 'POST', body, cookie: f.cookie, csrf: f.csrf }, expected)).value;
  const review = await f.shadow('preview', { releaseId: staged.release.id, expectedEpoch: 0, policy: {} });
  f.shadowSession = (await f.shadow('start', { reviewToken: review.reviewToken, idempotencyKey: 'docker-shadow-start-0001' }, 202)).session;
  await until(() => f.raw()?.operation.phase === 'observing', 'Real Docker shadow candidate observation');
  f.candidateId = await f.candidate();
  t.diagnostic(JSON.stringify({ runtime: process.version, certificateId: inspected.report.id, candidateId: f.candidateId }));
  return f;
}
async function stop(f) {
  const s = f.shadowSession;
  await f.shadow(s.sessionId + '/stop', { operationId: s.operationId, controllerEpoch: s.controllerEpoch }, 202);
  await until(() => f.raw()?.operation.phase === 'complete', 'Public shadow stop and actual Docker retirement');
  await f.absent(f.candidateId);
}

test('public shadow comparisons use actual read-only Docker isolation, bounded sanitized traffic and exact retirement', settings, async t => {
  const f = await setup(t), ids = await ownedContainers(f.owner, f.candidateId); assert.equal(ids.length, 1);
  const details = JSON.parse((await command('docker', ['container', 'inspect', ids[0]])).stdout)[0];
  assert.equal(details.State.Running, true); assert.equal(details.Config.User, '1000:1000');
  assert.equal(details.Mounts.find(m => m.Destination === '/data').RW, false); assert.equal(details.HostConfig.ReadonlyRootfs, true);
  assert.equal(details.HostConfig.Memory, 256 * 1024 * 1024); assert.equal(details.HostConfig.NanoCpus, 1e9); assert.equal(details.HostConfig.PidsLimit, 64);
  assert.ok(details.HostConfig.CapDrop.includes('ALL')); assert.ok(details.HostConfig.SecurityOpt.some(value => /^no-new-privileges(?:[:=]true)?$/.test(value)));
  assert.equal(details.Config.Env.some(value => value.startsWith('CANARY_FIXTURE_')), false);
  // The denied endpoint belongs to this test on the real host bridge. No
  // public external service is contacted and no provider policy is modified.
  let connections = 0;
  const endpoint = createServer(socket => { connections++; socket.end(); });
  await new Promise((resolve, reject) => { endpoint.once('error', reject); endpoint.listen(0, '0.0.0.0', resolve); });
  t.after(() => new Promise(resolve => endpoint.close(resolve)));
  const networks = Object.values(details.NetworkSettings.Networks); assert.equal(networks.length, 1);
  const probe = `const fs=require('node:fs'),net=require('node:net'),{DatabaseSync}=require('node:sqlite');
    const attempt=fn=>{try{fn();return{ok:true}}catch(e){return{ok:false,code:e.code,message:e.message}}};
    const db=new DatabaseSync('/data/app.sqlite');
    const value={uid:process.getuid(),status:fs.readFileSync('/proc/self/status','utf8'),
      file:attempt(()=>fs.writeFileSync('/data/shadow-forbidden','x')),
      sqlite:attempt(()=>db.prepare("INSERT INTO events(label,kind) VALUES('shadow-probe','forbidden-candidate-write')").run())};
    db.close();const socket=net.connect({host:process.argv[1],port:Number(process.argv[2])});
    let finished=false;const done=state=>{if(finished)return;finished=true;socket.destroy();console.log(JSON.stringify({...value,network:state}))};
    socket.setTimeout(700,()=>done('timeout'));socket.once('connect',()=>done('connected'));socket.once('error',e=>done(e.code));`;
  const denied = JSON.parse((await command('docker', ['container', 'exec', ids[0], 'node', '--eval', probe,
    networks[0].Gateway, String(endpoint.address().port)])).stdout);
  assert.equal(denied.uid, 1000); assert.match(denied.status, /^NoNewPrivs:\s+1$/m); assert.match(denied.status, /^CapEff:\s+0+$/m);
  assert.equal(denied.file.code, 'EROFS'); assert.equal(denied.sqlite.ok, false); assert.match(denied.sqlite.message, /readonly/i);
  assert.equal(denied.network, 'timeout'); assert.equal(connections, 0);
  t.diagnostic(JSON.stringify({actualIsolation: { uid: denied.uid, file: denied.file.code, sqlite: denied.sqlite.ok, outbound: denied.network, hostConnections: connections } }));
  const before = (await (await f.traffic('GET', '/', { authorization: 'Bearer primary-observation' })).json()).rows;
  for (const [method, path, headers] of [['GET', '/', { authorization: 'Bearer private-owned-secret' }], ['GET', '/', { cookie: 'private-owned-secret' }],
    ['GET', '/?private=owned-secret', {}], ['GET', '/', { 'x-owned-secret': 'private-owned-secret' }], ['POST', '/write', {}]]) {
    const response = await f.traffic(method, path, headers); assert.equal((await response.json()).label, 'primary');
  }
  for (let n = 0; n < 6; n++) {
    const method = n === 5 ? 'HEAD' : 'GET';
    const response = await f.traffic(method, '/', { accept: 'application/json' });
    assert.equal(response.status, 200);
    if (method === 'GET') assert.equal((await response.json()).label, 'primary'); else assert.equal(await response.text(), '');
    await until(() => f.raw().operation.report.counters.settled >= n + 1, 'Bounded genuine comparison settled');
  }
  const logs = (await command('docker', ['container', 'logs', ids[0]])).stdout;
  assert.equal(logs.includes('private-owned-secret'), false); assert.equal(logs.includes('owned-secret'), false);
  const requests = logs.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(requests.some(r => r.kind === 'candidate-request' && r.path === '/' && r.headers.accept === 'application/json'));
  assert.ok(requests.every(r => ['GET', 'HEAD'].includes(r.method) && ['/', '/healthz'].includes(r.path)));
  const report = f.raw().operation.report;
  assert.equal(report.counters.comparable, 6); assert.ok(report.counters.reserved <= 20); assert.equal(report.counters.statusClassEqual, 6);
  const primary = await (await f.traffic('GET', '/', { authorization: 'Bearer primary-observation' })).json();
  assert.equal(primary.rows.length, before.length + 1); assert.ok(primary.rows.every(row => row.kind !== 'forbidden-candidate-write'));
  const snapshot = JSON.parse((await command('docker', ['container', 'exec', ids[0], 'node', '--eval',
    "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/app.sqlite',{readOnly:true});console.log(JSON.stringify(d.prepare('SELECT label,kind FROM events ORDER BY id').all()));d.close()"])).stdout);
  assert.deepEqual(snapshot, before, 'Candidate reads its original isolated snapshot, excluding later primary writes.');
  await stop(f); assert.equal((await (await f.traffic()).json()).label, 'primary');
  assert.equal((await ownedContainers(f.owner, f.project.id)).length, 1);
});

test('actual browser-session revocation retires a real Docker shadow candidate and preserves the primary', settings, async t => {
  const f = await setup(t);
  const response = await f.traffic(); assert.equal((await response.json()).label, 'primary');
  await until(() => f.raw().operation.report.counters.settled === 1, 'Original authenticated owner comparison');
  assert.equal(f.control.prepare('DELETE FROM clank_auth_sessions WHERE id=?').run(f.session.id).changes, 1);
  await until(() => f.raw().operation.phase === 'complete', 'Revoked session forces native shadow retirement');
  const complete = f.raw(); assert.equal(complete.operation.report.counters.comparable, 1);
  await f.absent(f.candidateId);
  for (let i = 0; i < 3; i++) assert.equal((await (await f.traffic()).json()).label, 'primary');
  assert.equal(f.raw().epoch, complete.epoch); assert.equal(f.raw().operation.report.counters.reserved, 1);
  assert.equal((await ownedContainers(f.owner, f.project.id)).length, 1);
});
