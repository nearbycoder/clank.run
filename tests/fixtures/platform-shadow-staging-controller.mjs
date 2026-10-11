import {writeSync} from 'node:fs';
import {openPlatform} from '../../dist/platform.js';
import {createS3ObjectStore} from '../../dist/object-storage.js';
import {linuxProcessBirth} from '../../dist/platform-supervisor.js';

// Only the owned child constructs the genuine adapter; no serialized capability,
// injected fetch, application runtime or synthetic native ownership is involved.
const config=JSON.parse(process.env.CLANK_STAGE_PROCESS_OPTIONS);
const store=createS3ObjectStore({endpoint:config.endpoint,region:'test-region',bucket:'stage-bucket',pathStyle:true,
  accessKeyId:'stage-fixture',secretAccessKey:'stage-fixture-secret',timeoutMs:120000,retries:2});
const platform=await openPlatform({dataDirectory:config.dataDirectory,publicUrl:config.origin,signup:true,
  appPortStart:config.portStart,appPortEnd:config.portEnd,backups:{intervalMs:false},previews:{cleanupIntervalMs:false},
  supervisor:{configurationId:'shadow-stage-process-native',configurationRevision:1,leaseMs:30000,pollIntervalMs:50},
  deploymentAgents:{registrationToken:'shadow-stage-native-registration-123456',artifacts:{namespace:'stage-test',store}},
  onError:error=>writeSync(2,String(error.stack??error)+'\n')});
let stopping=false;
const reply=message=>{if(process.connected)process.send(message)};
process.on('message',message=>{
  void (async()=>{
    if(!message||!Number.isSafeInteger(message.id)||message.id<1||stopping)throw new Error('Invalid owned controller request.');
    if(message.kind==='status'){reply({id:message.id,status:platform.supervisor()});return}
    if(message.kind==='stop'){stopping=true;await platform.close();reply({id:message.id,stopped:true});process.disconnect();return}
    if(message.kind!=='request'||typeof message.url!=='string'||!message.url.startsWith(config.origin+'/')
      ||typeof message.method!=='string'||!Array.isArray(message.headers)||message.headers.length>32
      ||message.body!==null&&(typeof message.body!=='string'||message.body.length>1024*1024))throw new Error('Invalid bounded owned request.');
    const response=await platform.handle(new Request(message.url,{method:message.method,headers:message.headers,
      ...(message.body===null?{}:{body:Buffer.from(message.body,'base64')})}));
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>1024*1024)throw new Error('Owned response exceeds fixture bound.');
    reply({id:message.id,status:response.status,headers:[...response.headers],body:bytes.toString('base64')});
  })().catch(error=>reply({id:message?.id,error:String(error.message)}));
});
reply({kind:'ready',pid:process.pid,birth:await linuxProcessBirth(process.pid),status:platform.supervisor()});
