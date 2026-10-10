// Owned trusted application/provider process; not an untrusted-host certificate.
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {s} from '../../dist/ai.js';
import {openSQLite,defineDatabase,defineTable} from '../../dist/backend.js';
import {createSQLiteTaskScope} from '../../dist/sqlite-task.js';
import {openPointInTimeRecovery,createPointInTimeRecoveryProvider} from '../../dist/point-in-time.js';
import {serve} from '../../dist/node.js';
const input=JSON.parse(process.argv[2]),scope=await createSQLiteTaskScope('trusted-process');
await scope.run(async()=>{
  const binding={projectId:'project_native',nodeId:'node_native',releaseId:'release_native',generation:3},control=new DatabaseSync(join(input.root,'provider-control.sqlite'));
  control.exec('CREATE TABLE IF NOT EXISTS provider_binding(id INTEGER PRIMARY KEY CHECK(id=1),project TEXT,node TEXT,release TEXT,generation INTEGER,active INTEGER) STRICT');
  control.prepare('INSERT OR IGNORE INTO provider_binding VALUES(1,?,?,?,?,1)').run(binding.projectId,binding.nodeId,binding.releaseId,binding.generation);
  const database=await openSQLite(defineDatabase({records:defineTable({value:s.string()})}),{path:join(input.root,'source.sqlite')}),recovery=await openPointInTimeRecovery(database,{directory:join(input.root,'repository'),encryptionKey:new Uint8Array(32).fill(71),exportIntervalMs:false,maxJournalEntries:100,maxJournalBytes:1024*1024,maxRemoteExports:8});
  if(!database.read(db=>db.table('records').collect()).length){
    const id=database.transaction(db=>db.table('records').insert({value:'mutation one'}));
    database.transaction(db=>db.table('records').patch(id,{value:'mutation two'}));
    database.transaction(db=>db.table('records').patch(id,{value:'mutation three'}));
  }
  let revokeAfterAssertion=false;
  const provider=createPointInTimeRecoveryProvider(recovery,{binding,token:input.token,assertCurrent(){
    const current=control.prepare('SELECT * FROM provider_binding WHERE id=1').get();
    if(!current||current.project!==binding.projectId||current.node!==binding.nodeId||current.release!==binding.releaseId||current.generation!==binding.generation||current.active!==1)throw new Error('Native provider ownership changed.');
    if(revokeAfterAssertion){revokeAfterAssertion=false;queueMicrotask(()=>control.prepare('UPDATE provider_binding SET active=0 WHERE id=1').run());}
  }});
  const server=await serve(request=>scope.run(async()=>{
    const response=await provider.handle(request);
    if(request.headers.get('x-owned-fixture-hold')==='after-receipt'&&response.status===200){
      const archive=await response.clone().json();process.send({published:true,sequence:archive.sequence,digest:archive.digest,sha256:createHash('sha256').update(JSON.stringify(archive)).digest('hex')});
      await new Promise(()=>{});
    }
    return response;
  }),{hostname:'127.0.0.1',port:0});
  process.on('message',message=>void scope.run(async()=>{
    if(message.write){database.transaction(db=>db.table('records').insert({value:message.write}));process.send({wrote:true,sequence:recovery.status().committedThrough});}
    if(message.armRevocation){revokeAfterAssertion=true;process.send({armed:true});}
    if(message.deactivate){control.prepare('UPDATE provider_binding SET active=0 WHERE id=1').run();process.send({deactivated:true});}
    if(message.close){await server.close();await recovery.close();database.close();control.close();process.exit(0);}
  }).catch(error=>{process.send({failed:String(error)});process.exitCode=1;}));
  process.send({ready:true,url:'http://127.0.0.1:'+server.port,binding});
});
