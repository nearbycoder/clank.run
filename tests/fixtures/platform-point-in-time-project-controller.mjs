// Actual owned platform process. Native provider registration and independent
// keys come from the fixture's real registry, outside its deleted node volume.
import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';
import {access,writeFile} from 'node:fs/promises';import {setTimeout} from 'node:timers/promises';
import {openPlatform} from '../../dist/platform.js';
const input=JSON.parse(process.argv[2]),registered=input.pointInTime,registry=new DatabaseSync(registered.catalog,{readOnly:true});registry.exec('PRAGMA busy_timeout=5000');
const exists=async path=>{try{await access(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const platform=await openPlatform({...input,pointInTime:{maxArchiveBytes:1024*1024,
  async source(projectId){
    const row=registry.prepare('SELECT release,generation,active,token FROM current_binding WHERE project=?').get(projectId),key=registry.prepare('SELECT key FROM retained_keys WHERE project=?').get(projectId)?.key;
    if(!row||row.active!==1||!(key instanceof Uint8Array))throw new Error('Native registered captured source unavailable.');
    return {origin:registered.origin,token:row.token,encryptionKey:new Uint8Array(key),binding:{projectId,nodeId:'owned-native-pitr-provider',releaseId:row.release,generation:row.generation},assertCurrent(){const current=registry.prepare('SELECT release,generation,active FROM current_binding WHERE project=?').get(projectId);if(current?.active!==1||current.release!==row.release||current.generation!==row.generation)throw new Error('Native registered capture ownership changed.');}};
  },
  async restoreKey(projectId){
    if(registered.holdDirectory&&!await exists(join(registered.holdDirectory,'resume'))){
      await writeFile(join(registered.holdDirectory,'entered'),'Actual independent native key lookup entered.\n',{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
      const deadline=performance.now()+60000;while(!await exists(join(registered.holdDirectory,'resume'))){if(performance.now()>=deadline)throw new Error('Owned native key barrier expired.');await setTimeout(25);}
    }
    const key=registry.prepare('SELECT key FROM retained_keys WHERE project=?').get(projectId)?.key;if(!(key instanceof Uint8Array))throw new Error('Native independent recovery key unavailable.');return new Uint8Array(key);
  }},onError(error){console.error('Owned native project recovery diagnostic:',error?.stack??error);}});
process.on('message',message=>{
  if(message.close){void platform.close().then(()=>{registry.close();process.exit(0);},()=>process.exit(1));return;}
  void(async()=>{const request=new Request(message.url,{method:message.method,headers:message.headers,...(message.body===null?{}:{body:Buffer.from(message.body,'base64')})}),response=await platform.handle(request);process.send({id:message.id,status:response.status,headers:[...response.headers],bodyEncoding:'base64',body:response.body?Buffer.from(await response.arrayBuffer()).toString('base64'):null});})().catch(()=>process.send({id:message.id,error:true}));
});process.send({ready:true});
