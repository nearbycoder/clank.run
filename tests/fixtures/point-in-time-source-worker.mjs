import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {openSQLite,defineDatabase,defineTable} from '../../dist/backend.js';
import {s} from '../../dist/ai.js';
import {createSQLiteTaskScope} from '../../dist/sqlite-task.js';
import {openPointInTimeRecovery,exportPointInTimeRecovery,openPointInTimeTransferSource} from '../../dist/point-in-time.js';
const root=process.argv[2],mode=process.argv[3],key=new Uint8Array(32).fill(73),identity={handoffId:'source_fixture',source:{projectId:'project',nodeId:'source',releaseId:'release',generation:1},targetNodeId:'target',targetGeneration:2,artifactSha256:'a'.repeat(64)};
const scope=await createSQLiteTaskScope('trusted-process');
await scope.run(async()=>{
 const db=await openSQLite(defineDatabase({records:defineTable({value:s.string()})}),{path:join(root,'source.sqlite'),changePollIntervalMs:0,busyTimeout:25});
 const authority=new DatabaseSync(join(root,'authority.sqlite'));authority.exec('CREATE TABLE owner(id INTEGER PRIMARY KEY,active INTEGER);INSERT INTO owner VALUES(1,1)');
 const assertSourceCurrent=()=>{if(authority.prepare('SELECT active FROM owner WHERE id=1').get().active!==1)throw new Error('native authority lost');};
 const recovery=await openPointInTimeRecovery(db,{directory:join(root,'journal'),encryptionKey:key,exportIntervalMs:false}),archive=await exportPointInTimeRecovery(recovery,{operationId:'base_1',binding:identity.source});
 const binding={identity,baseOperationId:'base_1',baseArchiveSha256:createHash('sha256').update(JSON.stringify(archive)).digest('hex'),initialCursor:{epoch:archive.epoch,sequence:archive.sequence,digest:archive.digest}};
 const source=openPointInTimeTransferSource(recovery,{...binding,assertSourceCurrent});
 const ledger=[];for(let i=0;i<3;i++){const value=`acknowledged-${i}`;db.transaction(tx=>tx.table('records').insert({value}));ledger.push(value);}
 process.send({event:'ready',binding,archive,ledger});
 const halt=event=>{process.send({event});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
 let sealing=false;const exec=DatabaseSync.prototype.exec;
 DatabaseSync.prototype.exec=function(sql){
  if(sealing&&mode==='before'&&sql==='BEGIN IMMEDIATE')halt('before');
  const value=Reflect.apply(exec,this,[sql]);
  if(sealing&&mode==='uncommitted'&&sql.startsWith('CREATE TABLE clank_pitr_source_seal'))halt('uncommitted');
  if(sealing&&mode==='committed'&&sql==='COMMIT')halt('committed');
  return value;
 };
 process.once('message',message=>{if(message!=='seal')throw new Error('unexpected fixture command');sealing=true;const receipt=source.seal(binding.initialCursor);process.send({event:'receipt',receipt});});
});
