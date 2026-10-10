import {createServer} from 'node:http';
import {openPlatform} from '../../dist/platform.js';
const root=process.env.CLANK_SUPERVISOR_FIXTURE_ROOT;
if(!root||!process.send)throw new Error('Owned platform supervisor fixture root and IPC are required');
const errors=[];
const overrides=JSON.parse(process.env.CLANK_SUPERVISOR_FIXTURE_OPTIONS??'{}');
const input={dataDirectory:root,publicUrl:'http://127.0.0.1:42431',hostingProfile:'trusted',sqliteIsolation:'trusted-process',signup:false,
  ...overrides,supervisor:{configurationId:'actual-platform-cluster',configurationRevision:1,leaseMs:5000,pollIntervalMs:50,...overrides.supervisor},onError:error=>errors.push(String(error))};
const opening=openPlatform(input);
if(process.env.CLANK_SUPERVISOR_MUTATE_OPTIONS==='1'){
  input.supervisor.configurationRevision=99;input.supervisor=undefined;input.hostingProfile='isolated';input.signup=true;
  input.backups.intervalMs=1;input.ingress.baseDomain='changed.example.test';
}
const platform=await opening;
const server=createServer(async(request,response)=>{
  try{const result=await platform.handle(new Request('http://127.0.0.1:42431'+request.url,{method:request.method}));response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));}
  catch{response.writeHead(500);response.end('Owned platform failed');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
process.on('message',async message=>{
  try{
    if(message?.kind==='status')process.send({kind:'status',id:message.id,status:platform.supervisor(),errors});
    if(message?.kind==='request'){
      const result=await platform.handle(new Request(message.url,{method:message.method,headers:message.headers,
        ...(message.body===null?{}:{body:Buffer.from(message.body,'base64')})}));
      if(process.env.CLANK_SUPERVISOR_PAUSE_RELEASE_RESPONSE==='1'&&message.method==='POST'&&new URL(message.url).pathname.endsWith('/releases')&&result.status===201){
        process.send({kind:'release-published',id:message.id});await new Promise(()=>{});
      }
      process.send({kind:'response',id:message.id,status:result.status,headers:[...result.headers],body:Buffer.from(await result.arrayBuffer()).toString('base64')});
    }
    if(message?.kind==='stop'){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await platform.close();process.send({kind:'stopped'});process.disconnect();}
  }catch(error){process.send({kind:'error',id:message?.id,error:String(error)});}
});
process.send({kind:'ready',url:'http://127.0.0.1:'+server.address().port,status:platform.supervisor()});
