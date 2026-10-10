import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLinuxDockerNetworkPlan, enforceLinuxProjectDiskQuota, removeLinuxDockerNetworkPolicy } from '../dist/linux-project-isolation.js';

test('nft cleanup verifies exact ownership and absence, including retries and lost delete acknowledgments', {skip:process.platform!=='linux'}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'clank-nft-cleanup-'));
  const plan=await createLinuxDockerNetworkPlan('cleanup-provider','cleanup_project',{allowCidrs:[]}),statePath=join(root,'state.json'),executable=join(root,'nft.mjs');
  const other={family:'inet',name:'unrelated_operator_policy',comment:'leave-intact'};
  try {
    await writeFile(executable,`#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
const file=${JSON.stringify(statePath)},state=JSON.parse(await readFile(file,'utf8')),args=process.argv.slice(2);
state.commands.push(args);await writeFile(file,JSON.stringify(state));
if(args.join(' ')==='-j list tables'){
 if(state.mode==='list-failure'){process.stderr.write('controlled listing failure');process.exit(1);}
 process.stdout.write(JSON.stringify(state.mode==='malformed'?{nftables:[{table:{name:state.table.name}}]}:{nftables:[{table:state.other},...(state.present?[{table:state.table}]:[])]}));
}else if(args.join(' ')==='-j list table inet '+state.table.name){process.stdout.write(JSON.stringify({nftables:state.present?[{table:state.table}]:[]}));}
else if(args.join(' ')==='delete table inet '+state.table.name){if(state.mode!=='retained'){state.present=false;await writeFile(file,JSON.stringify(state));}if(state.mode==='uncertain'){process.stderr.write('controlled lost delete acknowledgment');process.exit(2);}}
else process.exit(3);
`,{mode:0o700});
    for(const mode of ['normal','absent','uncertain','foreign','retained','malformed','list-failure']) {
      const original={mode,present:mode!=='absent',table:{family:'inet',name:plan.table,comment:mode==='foreign'?'another-owner':plan.ownership},other,commands:[]};
      await writeFile(statePath,JSON.stringify(original));
      if(['normal','absent','uncertain'].includes(mode)){
        await removeLinuxDockerNetworkPolicy(plan,executable);await removeLinuxDockerNetworkPolicy(plan,executable);
        const state=JSON.parse(await readFile(statePath,'utf8'));assert.equal(state.present,false);assert.equal(state.commands.filter(args=>args[0]==='delete').length,mode==='absent'?0:1);
      }else{
        await assert.rejects(removeLinuxDockerNetworkPolicy(plan,executable),mode==='foreign'?/ownership/:mode==='retained'?/did not converge/:mode==='malformed'?/verify.*absence/:/listing failure/);
        const state=JSON.parse(await readFile(statePath,'utf8'));assert.equal(state.present,true);assert.equal(state.commands.filter(args=>args[0]==='delete').length,mode==='retained'?1:0);
      }
      assert.deepEqual(JSON.parse(await readFile(statePath,'utf8')).other,other);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('outbound policies strictly validate routes and pinned hostnames', async () => {
  const plan = await createLinuxDockerNetworkPlan('provider', 'project', { allowCidrs: ['1.1.1.0/24'], hosts: { 'api.example.com': '1.1.1.1' } });
  assert.equal(plan.bridge.length, 15);
  assert.match(plan.rules, /ct state established,related accept/);
  assert.ok(plan.rules.indexOf('169.254.0.0/16') < plan.rules.indexOf('ip daddr 1.1.1.0/24 accept'));
  for (const bad of ['1.1.1.1/24', '256.1.1.1/32', '1.1.1.1/33', '::/0', '1.1.1.0/24; flush ruleset']) {
    await assert.rejects(createLinuxDockerNetworkPlan('provider', 'project', { allowCidrs: [bad] }), /Invalid|canonical/);
  }
  for (const hosts of [{ 'api.example.com': '127.0.0.1' }, { 'bad;command': '1.1.1.1' }]) {
    await assert.rejects(createLinuxDockerNetworkPlan('provider', 'project', { allowCidrs: ['0.0.0.0/0'], hosts }), /Invalid|allowed/);
  }
  await assert.rejects(createLinuxDockerNetworkPlan('provider', 'project', { allowCidrs: ['1.1.1.0/24'], hosts: { 'api.example.com': '9.9.9.9' } }), /allowed/);
  const another = await createLinuxDockerNetworkPlan('provider', 'another', { allowCidrs: [] });
  assert.notEqual(plan.bridge, another.bridge);
  assert.equal(another.rules.includes(' ip daddr 1.1.1.0/24 accept'), false);
});

test('disk quota policy refuses non-XFS storage and invalid limits before invoking privileged commands', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-quota-'));
  try {
    const base = { mountDirectory: root, quotaId: 1001, hardBytes: 1024 * 1024, hardFiles: 100 };
    for (const mutation of [{ quotaId: 0 }, { hardBytes: 1024 * 1024 + 1 }, { hardFiles: 0 }]) {
      await assert.rejects(enforceLinuxProjectDiskQuota({ ...base, ...mutation }, join(root, 'project'), join(root, 'registry'), 'project'), /Invalid|aligned/);
    }
    if (Number((await statfs(root)).type) !== 0x58465342) {
      await assert.rejects(enforceLinuxProjectDiskQuota(base, join(root, 'project'), join(root, 'registry'), 'project'), /require.*XFS/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real kernel egress policy permits allowed destinations and blocks private, host, and denied traffic', { skip: process.platform !== 'linux', timeout: 40_000 }, async (context) => {
  const fixture = fileURLToPath(new URL('./fixtures/linux-egress-kernel.mjs', import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/unshare', ['--user', '--map-root-user', '--net', process.execPath, fixture], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    context.signal.addEventListener('abort', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, { once: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (value) => stdout += value); child.stderr.on('data', (value) => stderr += value);
    child.once('error', reject); child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`namespace test exited ${code}: ${stderr} ${stdout}`)));
  });
  assert.equal(JSON.parse(result).realKernel, true);
});

test('real XFS project hard limits reject ordinary and SQLite/WAL allocations', {
  skip: !process.env.CLANK_XFS_TEST_MOUNT ? 'requires an empty disposable XFS mount in CLANK_XFS_TEST_MOUNT' : false,
  timeout: 30_000,
}, async () => {
  const { readdir, mkdir, writeFile, unlink } = await import('node:fs/promises');
  const { DatabaseSync } = await import('node:sqlite');
  const mount = process.env.CLANK_XFS_TEST_MOUNT;
  assert.equal(Number((await statfs(mount)).type), 0x58465342, 'the explicit test mount must be XFS');
  assert.deepEqual(await readdir(mount), [], 'refuse any populated test mount');
  const root = await mkdtemp(join(mount, 'clank-quota-proof-'));
  const project = join(root, 'project');
  const quotaId = 2147483000;
  try {
    await mkdir(project);
    await enforceLinuxProjectDiskQuota({ mountDirectory: mount, quotaId, hardBytes: 4 * 1024 * 1024, hardFiles: 64 }, project, join(root, 'registry'), 'test-project');
    const ordinary = join(project, 'ordinary');
    const outside = join(root, 'outside-quota');
    const capacity = await statfs(mount);
    assert.ok(Number(capacity.bavail) * Number(capacity.bsize) > 16 * 1024 * 1024, 'volume has room beyond the project limit');
    await writeFile(outside, Buffer.alloc(8 * 1024 * 1024));
    await assert.rejects(writeFile(ordinary, Buffer.alloc(8 * 1024 * 1024)), (error) => ['EDQUOT', 'ENOSPC'].includes(error.code));
    await unlink(outside);
    await unlink(ordinary);
    const database = new DatabaseSync(join(project, 'app.sqlite'));
    try {
      database.exec('PRAGMA journal_mode=WAL; CREATE TABLE records(value BLOB)');
      assert.throws(() => database.exec('INSERT INTO records VALUES(randomblob(8388608))'), /full|quota/i);
      assert.equal(database.prepare('SELECT count(*) AS n FROM records').get().n, 0);
    } finally { database.close(); }
    for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(join(project, `app.sqlite${suffix}`), { force: true });
    // Isolate inode exhaustion from any remaining delayed allocation and XFS
    // inode-chunk allocation headroom after the intentionally full WAL write.
    await enforceLinuxProjectDiskQuota({ mountDirectory: mount, quotaId, hardBytes: 64 * 1024 * 1024, hardFiles: 64 }, project, join(root, 'registry'), 'test-project');
    let created = 0, rejected = false;
    for (; created < 128; created++) {
      try { await writeFile(join(project, `inode-${created}`), ''); }
      catch (error) { assert.ok(['EDQUOT', 'ENOSPC'].includes(error.code)); rejected = true; break; }
    }
    assert.ok(rejected && created > 0 && created < 64, `project inode hard limit applies: created=${created}, rejected=${rejected}`);
    await writeFile(join(root, 'outside-inode-quota'), 'still writable');
  } finally { await rm(root, { recursive: true, force: true }); }
});
