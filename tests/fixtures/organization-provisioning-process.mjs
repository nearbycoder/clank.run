import {join} from 'node:path';
import {openPlatform} from '../../dist/platform.js';
import {AuthError,defineAuth,defineBackend,defineDatabase,openBackend} from '../../dist/index.js';
import {serve} from '../../dist/node.js';

// Only the parent test can provide this private, numeric-loopback fixture's
// configuration. No fixture route creates, binds or authenticates identities.
const config=JSON.parse(process.env.CLANK_SCIM_PROCESS_FIXTURE);
const platform=await openPlatform({dataDirectory:config.directory,publicUrl:config.options.applicationOrigin,
 signup:true,backups:{intervalMs:false},organizationSso:config.options});
let runtime;
runtime=await openBackend(defineBackend({schema:defineDatabase({}),auth:defineAuth({password:{cost:1024,maxMemory:4*1024*1024}})}).functions(({query})=>({
 protected:query({args:{},handler:({auth})=>{
  const user=auth.requireUser(),role=runtime.database[Symbol.for('clank.sqlite.internal')].prepare(
   'SELECT role FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').get(config.organizationId,user.id)?.role;
  if(!role)throw new AuthError('WORKSPACE_DENIED','Workspace access has been removed.',403);
  return{userId:user.id,role};
 }})
})),{path:join(config.directory,'control.sqlite'),changePollIntervalMs:25});
const server=await serve(async request=>{
 const path=new URL(request.url).pathname;
 const response=await (/^\/__clank\/(?:live|query|mcp|oauth)(?:\/|$)/u.test(path)?runtime:platform).handle(request);
 if(path.startsWith('/scim/v2/')&&response.ok&&request.method==='PATCH'&&request.headers.get('x-fixture-lose-response')==='accepted'){
  process.send({accepted:true});await new Promise(()=>{});
 }
 return response;
},{hostname:'127.0.0.1',port:0,trustProxy:true,allowedHosts:[new URL(config.options.applicationOrigin).host]});
process.send({ready:true,port:server.port,pid:process.pid});
let stopping=false;
async function close(){if(stopping)return;stopping=true;await server.close();runtime.close();await platform.close();process.disconnect();}
process.once('SIGTERM',()=>{void close().catch(error=>{console.error(error);process.exitCode=1;process.disconnect()})});
