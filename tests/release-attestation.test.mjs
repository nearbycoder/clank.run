import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { generateReleaseSigningKey, signReleaseAttestation, verifyReleaseAttestation, encodeReleaseAttestation, decodeReleaseAttestation } from '../dist/release-attestation.js';
const hash = value => createHash('sha256').update(value).digest('hex');
function artifact(text = 'export const app = 1;') {
  return gzipSync(JSON.stringify({ protocol: 'clank-deploy/1', config: { version: 1, entry: 'server.mjs', include: ['server.mjs', 'migrations'], database: { path: 'app.sqlite', migrations: 'migrations', allowUnsafeMigrations: false }, health: { path: '/healthz', timeoutMs: 5000 }, env: {} }, provenance: { builder: 'clank-cli/1', frameworkVersion: '0.23.0', nodeVersion: process.version, sourceRevision: 'abc123' }, files: [{ path: 'server.mjs', size: Buffer.byteLength(text), sha256: hash(text), mode: 420, content: Buffer.from(text).toString('base64') }] }));
}
test('release signatures bind artifact, project, schema, capabilities, builder and expiration', async () => {
  const key = await generateReleaseSigningKey('release-key'), data = artifact(), now = Date.now();
  const policy = { keys: [{ keyId: key.keyId, publicKey: key.publicKey, projects: ['project-a'], builders: ['local-ci'] }] };
  const signature = await signReleaseAttestation(data, key, { projectId: 'project-a', builder: 'local-ci', buildId: 'build-123', now, lifetimeMs: 60000 });
  assert.deepEqual(await verifyReleaseAttestation(data, decodeReleaseAttestation(encodeReleaseAttestation(signature)), policy, 'project-a', now), signature);
  await assert.rejects(verifyReleaseAttestation(artifact('export const changed = true;'), signature, policy, 'project-a', now), /artifact digest/);
  await assert.rejects(verifyReleaseAttestation(data, signature, policy, 'project-b', now), /different project/);
  await assert.rejects(verifyReleaseAttestation(data, signature, policy, 'project-a', now + 60000), /expired/);
  for (const change of [{ schemaSha256: 'a'.repeat(64) }, { capabilities: ['network:any'] }, { buildId: 'other' }, { sourceRevision: 'changed' }]) await assert.rejects(verifyReleaseAttestation(data, { ...signature, statement: { ...signature.statement, ...change } }, policy, 'project-a', now), /signature/);
  await assert.rejects(verifyReleaseAttestation(data, signature, { keys: [{ ...policy.keys[0], builders: ['other'] }] }, 'project-a', now), /authorized/);
  await assert.rejects(verifyReleaseAttestation(data, signature, { keys: [{ ...policy.keys[0], notAfter: now }] }, 'project-a', now), /authorized/);
  await assert.rejects(verifyReleaseAttestation(data, { ...signature, extra: true }, policy, 'project-a', now));
  assert.throws(() => decodeReleaseAttestation('!bad'));
});

test('platform admission rejects unsigned artifacts and records a valid signature before running the release', async () => {
  const { openPlatform } = await import('../dist/platform.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'clank-attestation-'));
  const key = await generateReleaseSigningKey('local-test');
  const projects = [], policy = { keys: [{ keyId: key.keyId, publicKey: key.publicKey, projects, builders: ['local-ci'] }] };
  const platform = await openPlatform({ dataDirectory: root, publicUrl: 'http://127.0.0.1:4200', signup: true, appPortStart: 55000, appPortEnd: 55010, backups: { intervalMs: false }, releaseAttestations: policy });
  const request = (path, method = 'GET', body, auth = {}) => new Request(`http://127.0.0.1:4200${path}`, { method, headers: { origin: 'http://127.0.0.1:4200', 'content-type': 'application/json', 'x-clank-client-ip': '127.0.0.1', ...auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (path, method, body, auth, status = 200) => { const response = await platform.handle(request(path, method, body, auth)); const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value; };
  try {
    const response = await platform.handle(request('/__clank/auth/register', 'POST', { email: 'attest@example.invalid', password: 'correct horse battery staple', profile: { name: 'Builder' } }));
    assert.equal(response.status, 201); const session = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
    const started = await json('/api/device/start', 'POST', { clientName: 'attestation test' }, {}, 201);
    await json('/api/device/approve', 'POST', { code: started.userCode }, { cookie, 'x-clank-csrf': session.csrfToken });
    const token = await json('/api/device/token', 'POST', { deviceCode: started.deviceCode });
    const auth = { authorization: `Bearer ${token.accessToken}` };
    const { project } = await json('/api/projects', 'POST', { name: 'Signed app', slug: 'signed-app' }, auth, 201); projects.push(project.id);
    const data = artifact(`import { createServer } from 'node:http'; const server = createServer((req,res) => res.end('ok')); server.listen(Number(process.env.PORT),process.env.HOST); process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
    const signature = await signReleaseAttestation(data, key, { projectId: project.id, builder: 'local-ci', buildId: 'verified-local-build' });
    const upload = signed => platform.handle(new Request(`http://127.0.0.1:4200/api/projects/${project.id}/releases`, { method: 'POST', headers: { ...auth, 'content-type': 'application/vnd.clank.deploy+gzip', 'x-clank-content-sha256': hash(data), 'x-clank-idempotency-key': 'signed-release-attempt-123', ...(signed ? { 'x-clank-release-attestation': encodeReleaseAttestation(signed) } : {}) }, body: data }));
    assert.equal((await upload()).status, 403);
    assert.equal((await upload({ ...signature, statement: { ...signature.statement, builder: 'other' } })).status, 403);
    const admitted = await upload(signature), result = await admitted.json(); assert.equal(admitted.status, 201, JSON.stringify(result));
    const receipt = await json(`/api/projects/${project.id}/releases/${result.release.id}/attestation`, 'GET', undefined, auth);
    assert.deepEqual(receipt.attestation, signature); assert.ok(receipt.verifiedAt > 0);
    assert.equal((await upload()).status, 403, 'idempotent retries still require the current admission policy');
  } finally { await platform.close(); await rm(root, { recursive: true, force: true }); }
});

test('CLI refuses included, aliased or copied private signing keys before writing a dry-run artifact', async () => {
  const { mkdtemp, mkdir, writeFile, rename, rm, symlink, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { spawn } = await import('node:child_process'); const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'clank-attest-cli-')), key = await generateReleaseSigningKey('private-test');
  const output = join(root, 'artifact.clank.gz');
  const run = keyPath => new Promise((resolve,reject) => {
    const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/clank.mjs',import.meta.url)),'deploy',root,'--dry-run','--json','--signing-key',keyPath,'--output',output],{stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',value=>text+=value);child.stderr.on('data',value=>text+=value);child.on('error',reject);child.on('close',code=>resolve({code,text}));
  });
  try {
    await mkdir(join(root,'dist')); await mkdir(join(root,'migrations')); await mkdir(join(root,'.clank','keys'),{recursive:true});
    await writeFile(join(root,'dist','server.mjs'),'export const app = 1;');
    await writeFile(join(root,'clank.deploy.json'),JSON.stringify({version:1,entry:'dist/server.mjs',include:['dist','migrations'],database:{path:'app.sqlite',migrations:'migrations'},health:{path:'/healthz',timeoutMs:5000},env:{}}));
    const included=join(root,'dist','builder.json');await writeFile(included,JSON.stringify(key));
    assert.match((await run(included)).text,/inside an included artifact/);await assert.rejects(access(output));
    await symlink(join(root,'dist'),join(root,'alias'),'dir');assert.match((await run(join(root,'alias','builder.json'))).text,/inside an included artifact/);
    const privateFile=join(root,'.clank','keys','builder.json');await rename(included,privateFile);
    await writeFile(join(root,'dist','copied-key.txt'),key.privateKey);
    const copied=await run(privateFile);assert.notEqual(copied.code,0);assert.match(copied.text,/contains release signing key material/);assert.ok(!copied.text.includes(key.privateKey));await assert.rejects(access(output));
    await rm(join(root,'dist','copied-key.txt'));const safe=await run(privateFile);assert.equal(safe.code,0,safe.text);await access(output);
  } finally { await rm(root,{recursive:true,force:true}); }
});
