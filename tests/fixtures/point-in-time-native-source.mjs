import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {openSQLite,defineDatabase,defineTable} from '../../dist/backend.js';
import {s} from '../../dist/ai.js';
import {openSupervisorLease,linuxProcessBirth} from '../../dist/platform-supervisor.js';
import {openPointInTimeRecovery,exportPointInTimeRecovery,openPointInTimeTransferSource} from '../../dist/point-in-time.js';

// This is a capture-process crash fixture, not a provider runtime/stop fixture.
// Do not select trusted-process scope: every recovery worker uses its default
// production namespace boundary. The capture process itself runs on the host.
const root=process.argv[2],mode=process.argv[3],key=new Uint8Array(32).fill(83);
const identity={handoffId:'native_source_fixture',source:{projectId:'project',nodeId:'source',releaseId:'release',generation:1},targetNodeId:'target',targetGeneration:2,artifactSha256:'a'.repeat(64)};
const lease=await openSupervisorLease(join(root,'capture-owner.sqlite'),{configurationId:'native-source-proof',configurationRevision:1,leaseMs:120000,pollIntervalMs:500});
if(!lease.acquire())throw new Error('The fixture did not acquire its native source lease.');
const db=await openSQLite(defineDatabase({records:defineTable({value:s.string()})}),{path:join(root,'source.sqlite'),changePollIntervalMs:0,busyTimeout:25});
const recovery=await openPointInTimeRecovery(db,{directory:join(root,'journal'),encryptionKey:key,exportIntervalMs:false});
const archive=await exportPointInTimeRecovery(recovery,{operationId:'base_1',binding:identity.source});
const binding={identity,baseOperationId:'base_1',baseArchiveSha256:createHash('sha256').update(JSON.stringify(archive)).digest('hex'),initialCursor:{epoch:archive.epoch,sequence:archive.sequence,digest:archive.digest}};
const source=openPointInTimeTransferSource(recovery,{...binding,assertSourceCurrent:()=>lease.assertCurrent()});
const ledger=[];
const send=value=>new Promise((resolve,reject)=>process.send(value,error=>error?reject(error):resolve()));
await send({event:'ready',archive,binding,pid:process.pid,birth:await linuxProcessBirth(process.pid)});

let sealing=false;
const nativeExec=DatabaseSync.prototype.exec;
const halt=event=>{process.send({event});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
DatabaseSync.prototype.exec=function(sql){
  const value=Reflect.apply(nativeExec,this,[sql]);
  if(sealing&&mode==='uncommitted'&&sql.startsWith('CREATE TABLE clank_pitr_source_seal'))halt('uncommitted');
  if(sealing&&mode==='committed'&&sql==='COMMIT')halt('committed');
  return value;
};
let work=Promise.resolve();
process.on('message',message=>{
  work=work.then(async()=>{
    lease.renew();
    if(message.operation==='batch'||message.operation==='tail'){
      if(!Number.isSafeInteger(message.count)||message.count<1||message.count>3)throw new Error('Invalid fixture count.');
      for(let index=0;index<message.count;index++){
        const value=`acknowledged-${ledger.length+1}`;
        db.transaction(tx=>tx.table('records').insert({value}));ledger.push(value);
      }
      const batch=message.operation==='batch'?await source.export({after:message.after,throughSequence:recovery.status().committedThrough,maxEntries:3}):undefined;
      await send({event:message.operation,ledger:[...ledger],batch,throughSequence:recovery.status().committedThrough});
    }else if(message.operation==='seal'){
      sealing=true;const receipt=source.seal(message.after);
      await send({event:'unexpected-seal-response',receipt});
      throw new Error('Crash hook did not interrupt the terminal decision.');
    }else throw new Error('Unknown fixture operation.');
  }).catch(async error=>{
    await send({event:'failure',message:error.message}).catch(()=>{});
    try{await recovery.close();}catch{}try{db.close();}catch{}lease.close();
    process.exitCode=1;process.disconnect();
  });
});
