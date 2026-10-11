// Owned native controller process; not native human authentication or host certification.
import {join} from 'node:path';
import {defineDatabase,openSQLite} from '../../dist/backend.js';
import {createSQLiteTaskScope} from '../../dist/sqlite-task.js';
import {openPlatformPointInTime} from '../../dist/platform-point-in-time.js';
const input=JSON.parse(process.argv[2]),scope=await createSQLiteTaskScope('trusted-process');
await scope.run(async()=>{
  const database=await openSQLite(defineDatabase({}),{path:join(input.root,'controller.sqlite')}),internal=database[Symbol.for('clank.sqlite.internal')];
  internal.exec('CREATE TABLE IF NOT EXISTS owned_native_authority(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,active INTEGER,generation INTEGER) STRICT');internal.prepare('INSERT OR IGNORE INTO owned_native_authority VALUES(1,?,1,?)').run('owner_native',input.binding.generation);
  const current=()=>{const row=internal.prepare('SELECT * FROM owned_native_authority WHERE id=1').get();if(row?.owner!=='owner_native'||row.active!==1||row.generation!==input.binding.generation)throw new Error('Owned native authority changed.');};
  const controller=await openPlatformPointInTime({internal,directory:join(input.root,'recovery'),configuration:{maxArchiveBytes:1024*1024,source:async()=>{current();return {binding:input.binding,origin:input.origin,token:input.token,encryptionKey:new Uint8Array(32).fill(71),assertCurrent:current};}},assertOwner(project,owner){if(project!==input.binding.projectId||owner!=='owner_native')throw new Error('Owned native scope changed.');current();}});
  if(!controller.policy(input.binding.projectId))controller.configure(input.binding.projectId,'owner_native',{operationId:'configure_process_01',expectedVersion:0,enabled:true,intervalMs:60000},current);
  process.send({ready:true});
  process.on('message',message=>void scope.run(async()=>{
    if(message.capture){const checkpoint=await controller.capture(input.binding.projectId,'checkpoint_process_01',current);if(input.holdAcknowledgment){process.send({accepted:true,checkpoint});await new Promise(()=>{});}process.send({captured:true,checkpoint,archives:internal.prepare('SELECT count(*) AS n FROM clank_platform_pitr_archives').get().n});}
    if(message.close){await controller.close();database.close();process.exit(0);}
  }).catch(error=>{process.send({failed:String(error)});process.exitCode=1;}));
});
