// This exact file is included in the verified artifact and run by the owned
// trusted provider. Its framework modules are bundled beside it for portability.
import {DatabaseSync} from 'node:sqlite';
import {join,dirname} from 'node:path';
import {s} from './framework/ai.js';
import {defineDatabase,defineTable,openSQLite} from './framework/backend.js';
import {openPointInTimeRecovery,createPointInTimeRecoveryProvider} from './framework/point-in-time.js';
import {createSQLiteTaskScope} from './framework/sqlite-task.js';
import {serve} from './framework/node.js';
const scope=await createSQLiteTaskScope('trusted-process');
await scope.run(async()=>{
  const database=await openSQLite(defineDatabase({records:defineTable({value:s.string()})}),{path:process.env.CLANK_DATABASE_PATH});let recovery,provider,control;
  if(process.env.OWNED_RECOVERY_TOKEN){
    control=new DatabaseSync(process.env.OWNED_PROVIDER_CATALOG);const binding=JSON.parse(process.env.OWNED_PROVIDER_BINDING);
    recovery=await openPointInTimeRecovery(database,{directory:join(dirname(process.env.CLANK_DATABASE_PATH),'journal'),encryptionKey:Buffer.from(process.env.OWNED_RECOVERY_KEY,'base64'),exportIntervalMs:false,maxJournalEntries:100,maxJournalBytes:1024*1024});
    provider=createPointInTimeRecoveryProvider(recovery,{binding,token:process.env.OWNED_RECOVERY_TOKEN,assertCurrent(){const row=control.prepare('SELECT release,generation,active FROM current_binding WHERE project=?').get(binding.projectId);if(row?.release!==binding.releaseId||row.generation!==binding.generation||row.active!==1)throw new Error('Native captured provider ownership changed.');}});
    if(!database.read(tx=>tx.table('records').collect()).length){const id=database.transaction(tx=>tx.table('records').insert({value:'mutation one'}));database.transaction(tx=>tx.table('records').patch(id,{value:'mutation two'}));database.transaction(tx=>tx.table('records').patch(id,{value:'mutation three'}));}
  }
  const server=await serve(request=>scope.run(()=>{
    if(new URL(request.url).pathname.startsWith('/__clank/pitr/'))return provider?provider.handle(request):new Response(null,{status:404});
    return Response.json({value:database.read(tx=>tx.table('records').collect()).map(row=>row.value)});
  }),{hostname:'127.0.0.1',port:Number(process.env.PORT??0)});
  let closeFlight;const close=()=>closeFlight??=scope.run(async()=>{await server.close();await recovery?.close();database.close();control?.close();});
  process.once('SIGTERM',()=>void close().then(()=>process.exit(0),()=>process.exit(71)));process.once('disconnect',()=>void close().then(()=>process.exit(0),()=>process.exit(71)));
  if(process.send)process.send({ready:true,origin:'http://127.0.0.1:'+server.port});
});
