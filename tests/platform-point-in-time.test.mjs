import {pointInTimeReceiptCount} from './fixtures/point-in-time-receipts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,mkdir,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {defineDatabase,openSQLite} from '../dist/backend.js';
import {createSQLiteTaskScope} from '../dist/sqlite-task.js';
import {openPlatformPointInTime} from '../dist/platform-point-in-time.js';
const token='owned_native_provider_credential_0123456789';

async function fixture(run,configuration={}){
  const root=await mkdtemp(join(tmpdir(),'clank-platform-pitr-')),node=join(root,'provider');await mkdir(node);
  const scope=await createSQLiteTaskScope('trusted-process');
  await scope.run(async()=>{
    const worker=fork(new URL('./fixtures/point-in-time-provider-worker.mjs',import.meta.url),[JSON.stringify({root:node,token})],{stdio:['ignore','ignore','pipe','ipc']});
    const closed=new Promise(resolve=>worker.once('close',resolve));let output='';worker.stderr.on('data',part=>output=(output+part).slice(-4096));let database,controller;
    try{
      const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned native provider startup deadline: '+output)),10000);worker.once('message',value=>{clearTimeout(timer);resolve(value);});worker.once('exit',()=>{clearTimeout(timer);reject(new Error('Owned native provider exited: '+output));});});assert.equal(ready.ready,true);
      const catalog=join(root,'controller.sqlite'),directory=join(root,'recovery');
      let resolutions=0,sourceOverride;
      const current=()=>{if(internal.prepare('SELECT active FROM native_owners WHERE project=? AND owner=?').get('project_native','owner_native')?.active!==1)throw new Error('Native owner was revoked.');};
      const source=async()=>{
        resolutions++;if(sourceOverride)return sourceOverride();
        const row=internal.prepare('SELECT generation,active FROM registered_source WHERE id=1').get();if(row?.active!==1)throw new Error('Registered native provider was revoked.');
        const binding={...ready.binding,generation:row.generation};
        return {binding,origin:ready.url,token,encryptionKey:new Uint8Array(32).fill(71),assertCurrent(){const actual=internal.prepare('SELECT generation,active FROM registered_source WHERE id=1').get();if(actual?.active!==1||actual.generation!==binding.generation)throw new Error('Registered native generation changed.');}};
      };
      let internal;
      const reopen=async()=>{
        await controller?.close();database?.close();database=await openSQLite(defineDatabase({}),{path:catalog});internal=database[Symbol.for('clank.sqlite.internal')];
        internal.exec('CREATE TABLE IF NOT EXISTS native_owners(project TEXT PRIMARY KEY,owner TEXT,active INTEGER) STRICT;CREATE TABLE IF NOT EXISTS registered_source(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER,active INTEGER) STRICT;');
        internal.prepare('INSERT OR IGNORE INTO native_owners VALUES(?,?,1)').run('project_native','owner_native');internal.prepare('INSERT OR IGNORE INTO registered_source VALUES(1,3,1)').run();
        controller=await openPlatformPointInTime({internal,directory,configuration:{source,maxArchiveBytes:1024*1024,...configuration},assertOwner(project,owner){assert.equal(project,'project_native');assert.equal(owner,'owner_native');current();}});
      };
      await reopen();
      const f={root,node,current,reopen,get internal(){return internal;},get controller(){return controller;},get resolutions(){return resolutions;},set sourceOverride(value){sourceOverride=value;},enable(input={}){return controller.configure('project_native','owner_native',{operationId:'configure_native_01',expectedVersion:0,enabled:true,intervalMs:60000,...input},current);},capture(operation='checkpoint_native_01',claim=current){return controller.capture('project_native',operation,claim);}};
      await run(f);
    }finally{
      await controller?.close();database?.close();if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');await closed;await rm(root,{recursive:true,force:true});
    }
  });
}

test('real provider HTTP commits an encrypted archive, checkpoint, receipt and horizon atomically and retries after catalog reopen',async()=>fixture(async f=>{
  f.enable();const checkpoint=await f.capture();assert.equal(checkpoint.sequence,3);assert.equal(checkpoint.binding.generation,3);assert.equal(f.resolutions,1);
  const bytes=f.controller.archive('project_native',checkpoint.id,f.current);assert.equal(createHash('sha256').update(bytes).digest('hex'),checkpoint.sha256);assert.equal(Buffer.from(bytes).includes(Buffer.from('mutation three')),false);
  assert.equal(f.controller.policy('project_native').pendingOperationId,null);assert.equal(f.controller.policy('project_native').digest,checkpoint.digest);
  assert.equal(f.internal.prepare('SELECT state,reserved_bytes FROM clank_platform_pitr_operations WHERE id=?').get('checkpoint_native_01').state,'accepted');
  await f.reopen();assert.deepEqual(await f.capture(),checkpoint);assert.equal(f.resolutions,1);assert.deepEqual(f.controller.archive('project_native',checkpoint.id,f.current),bytes);
  for(const table of ['checkpoints','archives'])assert.equal(f.internal.prepare('SELECT count(*) AS n FROM clank_platform_pitr_'+table).get().n,1);
  assert.deepEqual(await readdir(join(f.root,'recovery')),[]);
}));

test('a native failure at final acknowledgment rolls back the archive and horizon together; the exact provider receipt is recoverable',async()=>fixture(async f=>{
  f.enable();f.internal.exec("CREATE TRIGGER refuse_ack BEFORE UPDATE OF state ON clank_platform_pitr_operations WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'owned native acknowledgment fault'); END;");
  await assert.rejects(f.capture(),/owned native acknowledgment fault/);
  assert.equal(f.controller.checkpoints('project_native').length,0);assert.equal(f.internal.prepare('SELECT count(*) AS n FROM clank_platform_pitr_archives').get().n,0);assert.equal(f.controller.policy('project_native').epoch,null);assert.equal(f.controller.policy('project_native').pendingOperationId,'checkpoint_native_01');
  const pending=f.internal.prepare('SELECT receipt FROM clank_platform_pitr_operations WHERE id=?').get('checkpoint_native_01');assert.equal(JSON.parse(pending.receipt).binding.generation,3);assert.equal(pointInTimeReceiptCount(f.node),1);
  f.internal.exec('DROP TRIGGER refuse_ack');await f.reopen();const accepted=await f.capture();assert.equal(accepted.sequence,3);assert.equal(pointInTimeReceiptCount(f.node),1);
}));

test('a pending checkpoint preserves its original provider generation through a controller restart and refuses a changed source before another request',async()=>fixture(async f=>{
  f.enable();f.internal.exec("CREATE TRIGGER refuse_ack BEFORE UPDATE OF state ON clank_platform_pitr_operations WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'owned native acknowledgment fault'); END;");
  await assert.rejects(f.capture());f.internal.exec('DROP TRIGGER refuse_ack');await f.reopen();
  f.internal.prepare('UPDATE registered_source SET generation=4 WHERE id=1').run();await assert.rejects(f.capture(),/original provider binding/);
  assert.equal(f.controller.checkpoints('project_native').length,0);assert.equal(pointInTimeReceiptCount(f.node),1);
  assert.equal(JSON.parse(f.internal.prepare('SELECT receipt FROM clank_platform_pitr_operations WHERE id=?').get('checkpoint_native_01').receipt).binding.generation,3);
  f.internal.prepare('UPDATE registered_source SET generation=3 WHERE id=1').run();assert.equal((await f.capture()).sequence,3);
}));

test('current native owner loss prevents new exports and private archive reads, including accepted retries',async()=>fixture(async f=>{
  f.enable();const accepted=await f.capture();f.internal.prepare('UPDATE native_owners SET active=0 WHERE project=?').run('project_native');
  await assert.rejects(f.capture(),/revoked/);await assert.rejects(f.capture('another_checkpoint'),/revoked/);assert.throws(()=>f.controller.archive('project_native',accepted.id,f.current),/revoked/);assert.equal(f.resolutions,1);
}));

test('asynchronous authorization claims are refused before source resolution and create no native operation',async()=>fixture(async f=>{
  assert.throws(()=>f.controller.configure('project_native','owner_native',{operationId:'async_config',expectedVersion:0,enabled:true,intervalMs:60000},async()=>{}),/synchronously/);
  f.enable();await assert.rejects(f.capture('async_capture',async()=>{}),/synchronously/);assert.equal(f.resolutions,0);assert.equal(f.internal.prepare('SELECT count(*) AS n FROM clank_platform_pitr_operations WHERE kind=?').get('export').n,0);
}));

test('bounded archive capacity refuses another native intent and preserves the accepted encrypted checkpoint',async()=>fixture(async f=>{
  f.enable();const accepted=await f.capture();await assert.rejects(f.capture('second_checkpoint'),/checkpoint capacity/);assert.equal(f.resolutions,1);assert.equal(f.internal.prepare('SELECT count(*) AS n FROM clank_platform_pitr_operations WHERE kind=?').get('export').n,1);assert.equal(f.controller.archive('project_native',accepted.id,f.current).byteLength,accepted.bytes);
},{maxArchivesPerProject:1}));

test('corrupted encrypted catalog bytes refuse replay without changing accepted receipts or the retained horizon',async()=>fixture(async f=>{
  f.enable();const accepted=await f.capture(),before=f.controller.policy('project_native');f.internal.prepare('UPDATE clank_platform_pitr_archives SET contents=? WHERE id=?').run(new Uint8Array([1,2,3]),accepted.id);
  await assert.rejects(f.capture(),/missing or corrupt/);assert.throws(()=>f.controller.archive('project_native',accepted.id,f.current),/missing or corrupt/);assert.deepEqual(f.controller.policy('project_native'),before);assert.equal(f.resolutions,1);
}));

test('partial retained controller schemas fail closed and preserve the encrypted archive',async()=>fixture(async f=>{
  f.enable();const accepted=await f.capture();f.internal.exec('DROP TABLE clank_platform_pitr_operations');await assert.rejects(f.reopen(),/Partial platform recovery protocol/);
  assert.equal(f.internal.prepare('SELECT length(contents) AS n FROM clank_platform_pitr_archives WHERE id=?').get(accepted.id).n,accepted.bytes);
  assert.equal(f.internal.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='clank_platform_pitr_operations'").get().n,0);
}));
