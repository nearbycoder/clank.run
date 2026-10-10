import {pointInTimeReceiptCount} from './fixtures/point-in-time-receipts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,mkdir,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {defineDatabase,openSQLite} from '../dist/backend.js';
import {createSQLiteTaskScope} from '../dist/sqlite-task.js';
import {openPlatformPointInTime} from '../dist/platform-point-in-time.js';
const token='owned_native_provider_credential_0123456789';

async function fixture(run,configuration={}){
  const root=await mkdtemp(join(tmpdir(),'clank-platform-pitr-')),node=join(root,'provider');await mkdir(node);
  const scope=await createSQLiteTaskScope('trusted-process');
  await scope.run(async()=>{
    const worker=fork(new URL('./fixtures/point-in-time-provider-worker.mjs',import.meta.url),[JSON.stringify({root:node,token})],{stdio:['ignore','ignore','pipe','ipc']});
    const closed=new Promise(resolve=>worker.once('close',resolve));let output='';worker.stderr.on('data',part=>output=(output+part).slice(-4096));let database,controller,keyStore;
    try{
      const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned native provider startup deadline: '+output)),10000);worker.once('message',value=>{clearTimeout(timer);resolve(value);});worker.once('exit',()=>{clearTimeout(timer);reject(new Error('Owned native provider exited: '+output));});});assert.equal(ready.ready,true);
      const catalog=join(root,'controller.sqlite'),directory=join(root,'recovery');
      let resolutions=0,sourceOverride,keyResolutions=0,keyOverride;
      keyStore=new DatabaseSync(join(root,'operator-keys.sqlite'));keyStore.exec('CREATE TABLE retained_keys(project TEXT PRIMARY KEY,key BLOB) STRICT');keyStore.prepare('INSERT INTO retained_keys VALUES(?,?)').run('project_native',new Uint8Array(32).fill(71));
      const restoreKey=async(project,checkpoint)=>{keyResolutions++;assert.equal(checkpoint.projectId,project);if(keyOverride)return keyOverride(project,checkpoint);const stored=keyStore.prepare('SELECT key FROM retained_keys WHERE project=?').get(project)?.key;if(!(stored instanceof Uint8Array))throw new Error('Independent operator key unavailable.');return new Uint8Array(stored);};
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
        controller=await openPlatformPointInTime({internal,directory,configuration:{source,restoreKey,maxArchiveBytes:1024*1024,...configuration},assertOwner(project,owner){assert.equal(project,'project_native');assert.equal(owner,'owner_native');current();}});
      };
      await reopen();
      const f={root,node,current,reopen,get internal(){return internal;},get controller(){return controller;},get resolutions(){return resolutions;},get keyResolutions(){return keyResolutions;},set keyOverride(value){keyOverride=value;},set sourceOverride(value){sourceOverride=value;},async loseSource(){if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');await closed;await rm(node,{recursive:true,force:true});internal.prepare('UPDATE registered_source SET active=0').run();},enable(input={}){return controller.configure('project_native','owner_native',{operationId:'configure_native_01',expectedVersion:0,enabled:true,intervalMs:60000,...input},current);},capture(operation='checkpoint_native_01',claim=current){return controller.capture('project_native',operation,claim);}};
      await run(f);
    }finally{
      await controller?.close();database?.close();keyStore?.close();if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');await closed;await rm(root,{recursive:true,force:true});
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
  assert.deepEqual(await readdir(join(f.root,'recovery')),['protocol']);
}));

test('a native failure at final acknowledgment rolls back the archive and horizon together; the exact provider receipt is recoverable',async()=>fixture(async f=>{
  f.enable();f.internal.exec("CREATE TRIGGER refuse_ack BEFORE UPDATE OF state ON clank_platform_pitr_operations WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'owned native acknowledgment fault'); END;");
  await assert.rejects(f.capture(),/owned native acknowledgment fault/);
  assert.equal(f.controller.checkpoints('project_native').length,0);assert.equal(f.internal.prepare('SELECT count(*) AS n FROM clank_platform_pitr_archives').get().n,0);assert.equal(f.controller.policy('project_native').epoch,null);assert.equal(f.controller.policy('project_native').pendingOperationId,'checkpoint_native_01');
  const pending=f.internal.prepare('SELECT receipt FROM clank_platform_pitr_operations WHERE id=?').get('checkpoint_native_01');assert.equal(JSON.parse(pending.receipt).binding.generation,3);assert.equal(pointInTimeReceiptCount(f.node),1);
  f.internal.exec('DROP TRIGGER refuse_ack');await f.reopen();const accepted=await f.capture();assert.equal(accepted.sequence,3);assert.equal(pointInTimeReceiptCount(f.node),1);
}));

test('a native ignored checkpoint acknowledgment cannot publish an archive or advance the retained horizon',async()=>fixture(async f=>{
  f.enable();f.internal.exec("CREATE TRIGGER ignore_checkpoint_ack BEFORE UPDATE OF state ON clank_platform_pitr_operations WHEN NEW.state='accepted' BEGIN SELECT RAISE(IGNORE); END;");
  await assert.rejects(f.capture(),/checkpoint acknowledgment changed/);assert.equal(f.controller.checkpoints('project_native').length,0);assert.equal(f.internal.prepare('SELECT count(*) AS n FROM clank_platform_pitr_archives').get().n,0);assert.equal(f.controller.policy('project_native').epoch,null);assert.equal(f.controller.policy('project_native').pendingOperationId,'checkpoint_native_01');assert.equal(pointInTimeReceiptCount(f.node),1);
  f.internal.exec('DROP TRIGGER ignore_checkpoint_ack');await f.reopen();assert.equal((await f.capture()).sequence,3);assert.equal(pointInTimeReceiptCount(f.node),1);
}));

test('ignored native policy writes cannot accept a configuration or change its current version',async()=>fixture(async f=>{
  f.internal.exec("CREATE TRIGGER ignore_policy_insert BEFORE INSERT ON clank_platform_pitr_policies BEGIN SELECT RAISE(IGNORE); END;");
  assert.throws(()=>f.enable(),/policy acknowledgment changed/);assert.equal(f.controller.policy('project_native'),null);assert.equal(f.internal.prepare("SELECT count(*) AS n FROM clank_platform_pitr_operations WHERE kind='configure'").get().n,0);
  f.internal.exec('DROP TRIGGER ignore_policy_insert');f.enable();
  f.internal.exec("CREATE TRIGGER ignore_policy_update BEFORE UPDATE ON clank_platform_pitr_policies BEGIN SELECT RAISE(IGNORE); END;");
  assert.throws(()=>f.enable({operationId:'disable_ignored',expectedVersion:1,enabled:false}),/policy acknowledgment changed/);assert.equal(f.controller.policy('project_native').enabled,true);assert.equal(f.controller.policy('project_native').version,1);assert.equal(f.internal.prepare('SELECT count(*) AS n FROM clank_platform_pitr_operations WHERE id=?').get('disable_ignored').n,0);
  f.internal.exec('DROP TRIGGER ignore_policy_update');assert.equal(f.enable({operationId:'disable_ignored',expectedVersion:1,enabled:false}).version,2);
}));

test('ignored native resolution writes preserve the pending export, reservation and disabled policy atomically',async()=>fixture(async f=>{
  f.enable();f.internal.exec("CREATE TRIGGER refuse_ack BEFORE UPDATE OF state ON clank_platform_pitr_operations WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'owned native acknowledgment fault'); END;");await assert.rejects(f.capture());f.internal.exec('DROP TRIGGER refuse_ack');f.enable({operationId:'disable_native_02',expectedVersion:1,enabled:false});
  const input={operationId:'resolve_ignored',pendingOperationId:'checkpoint_native_01',expectedVersion:2},before=f.internal.prepare('SELECT receipt,reserved_bytes FROM clank_platform_pitr_operations WHERE id=?').get(input.pendingOperationId);
  for(const table of ['operations','policies']){
    f.internal.exec("CREATE TRIGGER ignore_resolution BEFORE UPDATE ON clank_platform_pitr_"+table+" BEGIN SELECT RAISE(IGNORE); END;");
    assert.throws(()=>f.controller.resolve('project_native','owner_native',input,f.current),/resolution acknowledgment changed/);assert.equal(f.controller.policy('project_native').version,2);assert.equal(f.controller.policy('project_native').pendingOperationId,input.pendingOperationId);assert.deepEqual(f.internal.prepare('SELECT receipt,reserved_bytes FROM clank_platform_pitr_operations WHERE id=?').get(input.pendingOperationId),before);assert.equal(f.internal.prepare('SELECT state FROM clank_platform_pitr_operations WHERE id=?').get(input.pendingOperationId).state,'pending');assert.equal(f.internal.prepare("SELECT count(*) AS n FROM clank_platform_pitr_operations WHERE kind='resolve'").get().n,0);f.internal.exec('DROP TRIGGER ignore_resolution');
  }
  assert.equal(f.controller.resolve('project_native','owner_native',input,f.current).version,3);
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

test('disabling scheduling retains exact accepted checkpoint retries without resolving the provider again',async()=>fixture(async f=>{
  f.enable();const accepted=await f.capture();f.enable({operationId:'disable_native_02',expectedVersion:1,enabled:false});
  assert.deepEqual(await f.capture(),accepted);assert.equal(f.resolutions,1);await assert.rejects(f.capture('disabled_new_capture'),/enabled retained policy/);assert.equal(f.resolutions,1);
}));

test('closing during a stalled registered-source lookup aborts the manual export before the native catalog closes and retains its pending operation',async()=>fixture(async f=>{
  f.enable();let entered;const started=new Promise(resolve=>{entered=resolve;});f.sourceOverride=()=>{entered();return new Promise(()=>{});};
  const pending=f.capture('closing_native_capture'),rejected=assert.rejects(pending,/controller closed/);await started;await f.controller.close();await rejected;
  assert.equal(f.controller.checkpoints('project_native').length,0);assert.equal(f.controller.policy('project_native').pendingOperationId,'closing_native_capture');assert.equal(f.internal.prepare('SELECT lease,lease_until FROM clank_platform_pitr_policies').get().lease,null);
}));

test('the independent enrollment marker refuses a reset after all native recovery tables are lost',async()=>fixture(async f=>{
  f.enable();await f.capture();const marker=await readFile(join(f.root,'recovery/protocol'));
  for(const suffix of ['archives','checkpoints','operations','policies','state'])f.internal.exec('DROP TABLE clank_platform_pitr_'+suffix);
  await assert.rejects(f.reopen(),/Partial platform recovery protocol/);assert.deepEqual(await readFile(join(f.root,'recovery/protocol')),marker);
  assert.equal(f.internal.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'clank_platform_pitr_%'").get().n,0);
}));

test('a missing or malformed enrollment marker preserves an existing native catalog and refuses automatic migration',async()=>fixture(async f=>{
  f.enable();const accepted=await f.capture(),marker=join(f.root,'recovery/protocol');await writeFile(marker,'unknown protocol\n');
  await assert.rejects(f.reopen(),/Invalid retained platform recovery enrollment/);assert.equal(f.internal.prepare('SELECT length(contents) AS n FROM clank_platform_pitr_archives WHERE id=?').get(accepted.id).n,accepted.bytes);
  await rm(marker);await assert.rejects(f.reopen(),/Unmarked retained platform recovery protocol/);assert.equal(f.internal.prepare('SELECT sequence FROM clank_platform_pitr_checkpoints').get().sequence,3);
  await assert.rejects(readFile(marker),{code:'ENOENT'});
}));

test('a disabled failed export can be abandoned once with its original binding retained, then scheduling resumes under a new policy',async()=>fixture(async f=>{
  f.enable();f.internal.exec("CREATE TRIGGER refuse_ack BEFORE UPDATE OF state ON clank_platform_pitr_operations WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'owned native acknowledgment fault'); END;");
  await assert.rejects(f.capture());f.internal.exec('DROP TRIGGER refuse_ack');const before=f.internal.prepare('SELECT receipt FROM clank_platform_pitr_operations WHERE id=?').get('checkpoint_native_01').receipt;
  const input={operationId:'resolve_native_01',pendingOperationId:'checkpoint_native_01',expectedVersion:1};assert.throws(()=>f.controller.resolve('project_native','owner_native',input,f.current),/Disable and review/);
  f.enable({operationId:'disable_native_02',expectedVersion:1,enabled:false});assert.throws(()=>f.controller.resolve('project_native','owner_native',input,f.current),/Disable and review/);
  const receipt=f.controller.resolve('project_native','owner_native',{...input,expectedVersion:2},f.current);assert.equal(receipt.version,3);assert.equal(receipt.state,'abandoned');assert.equal(f.controller.policy('project_native').pendingOperationId,null);
  const abandoned=f.internal.prepare('SELECT state,receipt,reserved_bytes FROM clank_platform_pitr_operations WHERE id=?').get('checkpoint_native_01');assert.equal(abandoned.state,'abandoned');assert.equal(abandoned.reserved_bytes,0);assert.equal(abandoned.receipt,before);assert.equal(pointInTimeReceiptCount(f.node),1);
  await f.reopen();assert.deepEqual(f.controller.resolve('project_native','owner_native',{...input,expectedVersion:2},f.current),receipt);assert.equal(f.resolutions,1);
  assert.throws(()=>f.controller.resolve('project_native','owner_native',{...input,expectedVersion:3},f.current),/retry conflict/);
  f.enable({operationId:'reenable_native_04',expectedVersion:3,enabled:true});assert.equal((await f.capture('checkpoint_after_resolution')).sequence,3);assert.equal(pointInTimeReceiptCount(f.node),2);
}));

test('resolution refuses a live native export lease and revoked current authority without changing its retained intent',async()=>fixture(async f=>{
  f.enable();f.internal.exec("CREATE TRIGGER refuse_ack BEFORE UPDATE OF state ON clank_platform_pitr_operations WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'owned native acknowledgment fault'); END;");await assert.rejects(f.capture());f.internal.exec('DROP TRIGGER refuse_ack');
  f.enable({operationId:'disable_native_02',expectedVersion:1,enabled:false});f.internal.prepare('UPDATE clank_platform_pitr_policies SET lease=?,lease_until=?').run('native_live_lease',Date.now()+120000);
  const input={operationId:'resolve_native_01',pendingOperationId:'checkpoint_native_01',expectedVersion:2};assert.throws(()=>f.controller.resolve('project_native','owner_native',input,f.current),/active native lease/);
  f.internal.prepare('UPDATE clank_platform_pitr_policies SET lease=NULL,lease_until=NULL').run();f.internal.prepare('UPDATE native_owners SET active=0').run();assert.throws(()=>f.controller.resolve('project_native','owner_native',input,f.current),/revoked/);
  assert.equal(f.internal.prepare('SELECT state FROM clank_platform_pitr_operations WHERE id=?').get('checkpoint_native_01').state,'pending');assert.equal(f.internal.prepare('SELECT count(*) AS n FROM clank_platform_pitr_operations WHERE kind=?').get('resolve').n,0);
}));

test('the native controller restores a retained known sequence after actual provider SIGKILL and complete source-volume removal using independent operator keys',async()=>fixture(async f=>{
  f.enable();const checkpoint=await f.capture(),retained=f.controller.archive('project_native',checkpoint.id,f.current);await f.loseSource();await f.reopen();
  const target=join(f.root,'separate-stopped.sqlite'),result=await f.controller.restore('project_native',checkpoint.id,{targetPath:target,throughSequence:2},f.current);assert.equal(result.sequence,2);assert.equal(result.epoch,checkpoint.epoch);assert.equal(f.resolutions,1);assert.equal(f.keyResolutions,1);
  const database=new DatabaseSync(target,{readOnly:true});try{assert.deepEqual(database.prepare('SELECT json_extract(_data,\'$.value\') AS value FROM clank_records').all().map(row=>row.value),['mutation two']);assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name GLOB 'clank_pitr_*'").get().n,0);}finally{database.close();}
  assert.deepEqual(f.controller.archive('project_native',checkpoint.id,f.current),retained);assert.equal(f.controller.checkpoints('project_native').length,1);assert.equal(f.controller.policy('project_native').sequence,3);
}));

test('controller restore refuses corrupted ciphertext and out-of-horizon or relative destinations before consulting the independent key resolver',async()=>fixture(async f=>{
  f.enable();const checkpoint=await f.capture(),targetPath=join(f.root,'never-restored.sqlite');await assert.rejects(f.controller.restore('project_native',checkpoint.id,{targetPath,throughSequence:4},f.current),/retained horizon/);await assert.rejects(f.controller.restore('project_native',checkpoint.id,{targetPath:'relative.sqlite',throughSequence:2},f.current),/reserved stopped destination/);
  f.internal.prepare('UPDATE clank_platform_pitr_archives SET contents=? WHERE id=?').run(new Uint8Array([1,2]),checkpoint.id);await assert.rejects(f.controller.restore('project_native',checkpoint.id,{targetPath,throughSequence:2},f.current),/missing or corrupt/);assert.equal(f.keyResolutions,0);await assert.rejects(readFile(targetPath),{code:'ENOENT'});
}));

test('native policy ownership is revalidated after held key resolution before any destination publication',async()=>fixture(async f=>{
  f.enable();const checkpoint=await f.capture();let entered,deliver;const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{deliver=resolve;});f.keyOverride=()=>{entered();return held;};const targetPath=join(f.root,'revoked-restore.sqlite'),pending=f.controller.restore('project_native',checkpoint.id,{targetPath,throughSequence:2},f.current),rejected=assert.rejects(pending,/revoked/);
  await started;f.internal.prepare('UPDATE native_owners SET active=0').run();deliver(new Uint8Array(32).fill(71));await rejected;await assert.rejects(readFile(targetPath),{code:'ENOENT'});assert.equal(f.controller.checkpoints('project_native').length,1);
}));

test('controller shutdown cancels a stalled independent key lookup before its native catalog closes',async()=>fixture(async f=>{
  f.enable();const checkpoint=await f.capture();let entered;const started=new Promise(resolve=>{entered=resolve;});f.keyOverride=()=>{entered();return new Promise(()=>{});};const targetPath=join(f.root,'closed-restore.sqlite'),pending=f.controller.restore('project_native',checkpoint.id,{targetPath,throughSequence:2},f.current),rejected=assert.rejects(pending,/controller closed/);
  await started;await f.controller.close();await rejected;await assert.rejects(readFile(targetPath),{code:'ENOENT'});assert.equal(f.controller.checkpoints('project_native').length,1);
}));

test('the durable scheduler captures a due native provider checkpoint and advances its retained horizon once',async()=>fixture(async f=>{
  f.enable({intervalMs:1000});f.controller.start();const until=Date.now()+10000;let checkpoints=[];
  while(Date.now()<until){checkpoints=f.controller.checkpoints('project_native');if(checkpoints.length)break;await new Promise(resolve=>setTimeout(resolve,20));}
  await f.controller.close();assert.equal(checkpoints.length,1);assert.equal(checkpoints[0].sequence,3);assert.match(checkpoints[0].operationId,/^scheduled_[0-9a-f]{32}$/u);assert.equal(f.controller.policy('project_native').digest,checkpoints[0].digest);assert.equal(f.controller.policy('project_native').pendingOperationId,null);assert.equal(pointInTimeReceiptCount(f.node),1);
}));
