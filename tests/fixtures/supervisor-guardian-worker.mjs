import {join} from 'node:path';
import {readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {defineDatabase,openSQLite} from '../../dist/backend.js';
import {openSupervisorLease,armSupervisorGuardian,waitForSupervisorCleanup} from '../../dist/platform-supervisor.js';
const root=process.env.CLANK_SUPERVISOR_FIXTURE_ROOT;
if(!root||!process.send)throw new Error('Owned supervisor fixture root and IPC are required');
const lease=await openSupervisorLease(join(root,'catalog.sqlite'),{configurationId:'actual-process-cluster',configurationRevision:1,leaseMs:5000,pollIntervalMs:50});
const deadline=Date.now()+12000;
while(!lease.acquire()){
  if(Date.now()>=deadline)throw new Error('Owned fixture failed to acquire leadership');
  await new Promise(resolve=>setTimeout(resolve,50));
}
if(process.env.CLANK_SUPERVISOR_PAUSE_AFTER_ACQUIRE==='1'){
  process.send({kind:'acquired',status:lease.status('starting')});await new Promise(()=>{});
}
const renewal=setInterval(()=>lease.renew(),100);
await waitForSupervisorCleanup(root,lease);
let armingLease=lease;
if(process.env.CLANK_SUPERVISOR_ARM_EXPIRY==='1'){
  const operator=new DatabaseSync(join(root,'catalog.sqlite'));operator.exec('PRAGMA busy_timeout=5000');
  armingLease=Object.freeze({...lease,assertCurrent(connection){
    if(readdirSync(join(root,'supervisor-guardians')).some(name=>name.endsWith('.json'))){
      // Inject actual persisted expiry after the preparing fence is published.
      operator.prepare('UPDATE clank_platform_supervisor_lease SET expires_at=0 WHERE singleton=1').run();
    }
    return lease.assertCurrent(connection);
  }});
}
const guardian=await armSupervisorGuardian(root,armingLease);
const database=await openSQLite(defineDatabase({}),{path:join(root,'catalog.sqlite'),changePollIntervalMs:0}),sql=database[Symbol.for('clank.sqlite.internal')];
sql.guardWrites(connection=>lease.assertCurrent(connection));
sql.exec('CREATE TABLE IF NOT EXISTS actual_supervisor_writes(epoch INTEGER NOT NULL,controller INTEGER NOT NULL,at INTEGER NOT NULL)');
const write=()=>sql.prepare('INSERT INTO actual_supervisor_writes VALUES(?,?,?)').run(lease.status('leader').epoch,process.pid,Date.now());write();
const writes=setInterval(write,100);
process.on('message',async message=>{if(message?.kind!=='stop')return;clearInterval(writes);database.close();await guardian.stop();clearInterval(renewal);lease.release();lease.close();process.send({kind:'stopped'});process.disconnect();});
process.send({kind:'ready',status:lease.status('leader')});
