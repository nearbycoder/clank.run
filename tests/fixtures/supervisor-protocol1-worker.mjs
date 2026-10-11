import {DatabaseSync} from 'node:sqlite';
import {openSupervisorLease} from './supervisor-protocol1-baseline.mjs';

// This child executes the actual frozen previous runtime against the same native
// catalog as the current coordinator. It never imports the current supervisor.
const path=process.env.CLANK_SUPERVISOR_BASELINE_CATALOG;
if(!path||!process.send)throw new Error('Owned baseline catalog and IPC are required');
let lease,sql;
try{
  lease=await openSupervisorLease(path,{configurationId:'provider-capability',configurationRevision:1,leaseMs:5000,pollIntervalMs:50});
  if(process.env.CLANK_SUPERVISOR_BASELINE_ACTIVE==='1'&&!lease.acquire())throw new Error('Baseline owner was not admitted');
  sql=new DatabaseSync(path);sql.exec('PRAGMA busy_timeout=5000');
  process.on('message',message=>{
    if(message?.kind!=='write'&&message?.kind!=='acquire-and-write')return;
    let result;
    try{
      if(message.kind==='acquire-and-write'&&!lease.acquire())throw new Error('Baseline remained standby');
      sql.exec('BEGIN IMMEDIATE');
      try{
        lease.assertCurrent(sql);
        sql.prepare('INSERT INTO baseline_writer_effects VALUES(?)').run(process.pid);
        lease.assertCurrent(sql);sql.exec('COMMIT');
      }catch(error){sql.exec('ROLLBACK');throw error;}
      result={kind:'written'};
    }catch(error){result={kind:'refused',code:error.code,message:error.message};}
    finally{sql.close();lease.close();}
    process.send(result,()=>process.disconnect());
  });
  process.send({kind:'ready'});
}catch(error){
  sql?.close();lease?.close();process.send({kind:'refused',code:error.code,message:error.message},()=>process.disconnect());
}
