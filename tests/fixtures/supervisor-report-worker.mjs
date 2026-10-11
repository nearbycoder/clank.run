import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {prepareShadowSchema} from './shadow-schema.mjs';

const root=process.env.CLANK_REPORT_SUPERVISOR_ROOT,mode=process.env.CLANK_REPORT_SUPERVISOR_MODE;
if(!root||!process.send)throw new Error('Owned root and IPC required');
const runtime=mode.startsWith('old')?await import('./supervisor-shadow-schema2-a9016df.mjs'):await import('../../dist/platform-supervisor.js');
const options={configurationId:'report-capability',configurationRevision:1,leaseMs:30000,pollIntervalMs:50};
let lease,sql,guardian,timer;
const upgrade=()=>{sql.exec("BEGIN IMMEDIATE;UPDATE clank_platform_shadow_state SET schema_id='clank-platform-shadow/3';COMMIT");};
try{
  lease=await runtime.openSupervisorLease(join(root,'catalog.sqlite'),options);sql=new DatabaseSync(join(root,'catalog.sqlite'));sql.exec('PRAGMA busy_timeout=5000');
  if(!lease.acquire())throw new Error('Owned child was not admitted');
  if(!sql.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_platform_shadow_state'").get()){prepareShadowSchema(sql);sql.exec("ALTER TABLE clank_platform_releases ADD COLUMN upload_publication_receipt TEXT;UPDATE clank_platform_shadow_state SET schema_id='clank-platform-shadow/2'");}
  lease.enrollProviderShadow();
  if(mode==='new-enrolled-guardian'){upgrade();lease.assertCurrent();}
  if(mode.includes('guardian'))guardian=await runtime.armSupervisorGuardian(root,lease);
  timer=setInterval(()=>{try{lease.renew()}catch(error){process.send?.({kind:'renew-refused',code:error.code});clearInterval(timer)}},250);
  const finish=result=>{clearInterval(timer);sql.close();lease.close();process.send(result,()=>process.disconnect());};
  process.on('message',async message=>{
    try{
      if(message?.kind==='upgrade'){upgrade();lease.assertCurrent();return process.send({kind:'upgraded'});}
      if(message?.kind==='stop'){await guardian?.stop();lease.release();return finish({kind:'stopped'});}
      if(message?.kind==='write'){
        sql.exec('BEGIN IMMEDIATE');try{lease.assertCurrent(sql);sql.prepare('INSERT INTO baseline_writer_effects VALUES(?)').run(process.pid);lease.assertCurrent(sql);sql.exec('COMMIT')}
        catch(error){sql.exec('ROLLBACK');throw error}
        return finish({kind:'written'});
      }
    }catch(error){finish({kind:'refused',code:error.code,message:error.message});}
  });
  process.send({kind:'ready'});
}catch(error){sql?.close();lease?.close();process.send({kind:'refused',code:error.code,message:error.message},()=>process.disconnect());}
