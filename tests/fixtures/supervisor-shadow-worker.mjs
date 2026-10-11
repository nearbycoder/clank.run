import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { prepareShadowSchema } from './shadow-schema.mjs';

const root=process.env.CLANK_SHADOW_SUPERVISOR_ROOT,mode=process.env.CLANK_SHADOW_SUPERVISOR_MODE;
if(!root||!process.send)throw new Error('Owned root and IPC required');
const runtime=mode.startsWith('new-guardian')?await import('../../dist/platform-supervisor.js'):await import('./supervisor-protocol2-215f594.mjs');
let lease,sql,guardian,timer;
try {
  lease=await runtime.openSupervisorLease(join(root,'catalog.sqlite'),{configurationId:'shadow-capability',configurationRevision:1,leaseMs:5000,pollIntervalMs:50});
  sql=new DatabaseSync(join(root,'catalog.sqlite'));sql.exec('PRAGMA busy_timeout=5000');
  if(mode!=='standby'&&!lease.acquire())throw new Error('Owned child was not admitted');
  if(mode==='new-guardian-enrolled'){prepareShadowSchema(sql);lease.enrollProviderShadow();}
  if(mode==='new-guardian'||mode==='new-guardian-enrolled'||mode==='old-guardian'){guardian=await runtime.armSupervisorGuardian(root,lease);if(mode.startsWith('new-guardian'))timer=setInterval(()=>{lease.renew();},250);}
  const finish=result=>{clearInterval(timer);sql?.close();lease?.close();process.send(result,()=>process.disconnect());};
  process.on('message',async message=>{
    try {
      if(message?.kind==='stop'){await guardian?.stop();lease.release();return finish({kind:'stopped'});}
      if(message?.kind==='enroll'){
        prepareShadowSchema(sql);lease.enrollProviderShadow();return process.send({kind:'enrolled'});
      }
      if(message?.kind!=='write')return;
      if(mode==='standby'&&!lease.acquire())throw new Error('Old owner remained standby');
      sql.exec('BEGIN IMMEDIATE');
      try{lease.assertCurrent(sql);sql.prepare('INSERT INTO baseline_writer_effects VALUES(?)').run(process.pid);lease.assertCurrent(sql);sql.exec('COMMIT');}
      catch(error){sql.exec('ROLLBACK');throw error;}
      finish({kind:'written'});
    }catch(error){finish({kind:'refused',code:error.code,message:error.message});}
  });
  process.send({kind:'ready'});
}catch(error){sql?.close();lease?.close();process.send({kind:'refused',code:error.code,message:error.message},()=>process.disconnect());}
