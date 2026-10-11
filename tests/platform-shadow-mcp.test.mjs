import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {shadowPlatformFixture,request,appendShadowHistory,until} from './fixtures/platform-shadow-native.mjs';
const path=f=>`/api/projects/${f.project.id}/shadow/mcp`;
function rpcRequest(f,method,params={},settings={}){const value=request(path(f),{method:'POST',token:f.owner.accessToken,body:{jsonrpc:'2.0',id:1,method,params},...settings});value.headers.set('mcp-protocol-version','2025-11-25');value.headers.set('accept','application/json, text/event-stream');return value}
async function rpc(f,method,params={},settings={}){const response=await f.platform.nativeRequest(rpcRequest(f,method,params,settings));return{status:response.status,body:await response.json(),headers:response.headers}}
test('actual native bearer MCP exposes exactly the read-only shadow status tool',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),before=f.raw(),calls=f.controlCounts,result=await rpc(f,'tools/list');assert.equal(result.status,200,JSON.stringify(result));assert.deepEqual(result.body.result.tools.map(tool=>tool.name),['shadow_status']);assert.deepEqual(result.body.result.tools[0].annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});assert.deepEqual(f.raw(),before);assert.deepEqual(f.controlCounts,calls);
});
test('direct Fetch MCP refuses absent native target proof without reading the request body',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),result=await f.platform.rpc({kind:'direct-unread-request',url:'http://127.0.0.1:4200'+path(f),headers:{authorization:'Bearer '+f.owner.accessToken,'content-type':'application/json'}});assert.equal(result.status,403,result.body);assert.equal(result.pulls,0);assert.equal(JSON.parse(result.body).error.code,'SHADOW_MCP_TRANSPORT_UNAVAILABLE');
});

async function token(f,permissions,name='MCP reader'){const response=await f.platform.nativeRequest(request(`/api/projects/${f.project.id}/tokens`,{method:'POST',body:{name,permissions},cookie:f.owner.cookie,csrf:f.owner.csrf}));const value=await response.json();assert.equal(response.status,201,JSON.stringify(value));return value.token}
function decode(wire){const split=wire.indexOf('\r\n\r\n'),head=wire.slice(0,split);let body=wire.slice(split+4);if(/transfer-encoding: chunked/i.test(head)){let at=0,result='';while(at<body.length){const end=body.indexOf('\r\n',at),size=parseInt(body.slice(at,end),16);if(!size)break;result+=body.slice(end+2,end+2+size);at=end+2+size+2;}body=result;}return{status:Number(head.split(' ')[1]),body:body?JSON.parse(body):null,bytes:Buffer.byteLength(wire)}}
function raw(f,target,{method='POST',host='127.0.0.1:4200',headers={},body='',hold=false,length=Buffer.byteLength(body)}={}){
 let socket,complete;const response=new Promise((resolve,reject)=>{socket=connect({host:'127.0.0.1',port:Number(new URL(f.platform.url).port)});let wire='';socket.setTimeout(8000,()=>socket.destroy(new Error('Owned native MCP response timed out.')));socket.on('error',reject);socket.on('data',chunk=>{wire+=chunk.toString('utf8');if(Buffer.byteLength(wire)>1052672)socket.destroy(new Error('MCP native response exceeded bound.'))});socket.on('end',()=>{try{resolve(decode(wire))}catch(error){reject(error)}});socket.on('connect',()=>{socket.write(`${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\nMCP-Protocol-Version: 2025-11-25\r\n${Object.entries(headers).map(([key,value])=>`${key}: ${value}\r\n`).join('')}\r\n${hold?'':body}`);complete?.();});});response.catch(()=>{});return{response,send(value=body){socket.write(value)},close(){socket.destroy()},connected:new Promise(resolve=>complete=resolve)};
}
const message=(method,params={},id=1)=>JSON.stringify({jsonrpc:'2.0',id,method,params});
const state=f=>({raw:f.raw(),counts:f.controlCounts,replay:f.control.prepare('SELECT * FROM clank_platform_shadow_reports ORDER BY session_id').all()});
test('native MCP initialize/list/call use read bearer scope and preserve the GET DTO without mutation',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),reader=await token(f,['read']),before=state(f);
 const initialized=await rpc(f,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'native-shadow-test',version:'1'}},{token:reader.accessToken});assert.equal(initialized.status,200,JSON.stringify(initialized));assert.equal(initialized.headers.has('mcp-session-id'),false);assert.equal(initialized.headers.has('access-control-allow-origin'),false);
 const list=await rpc(f,'tools/list',{}, {token:reader.accessToken});assert.equal(list.status,200);assert.deepEqual(list.body.result.tools.map(value=>value.name),['shadow_status']);
 const result=await rpc(f,'tools/call',{name:'shadow_status',arguments:{}},{token:reader.accessToken});assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.result.isError,false);
 const get=await f.platform.nativeRequest(request(path(f).slice(0,-4),{token:reader.accessToken})),expected=await get.json();assert.equal(get.status,200);assert.deepEqual(result.body.result.structuredContent,expected);assert.deepEqual(JSON.parse(result.body.result.content[0].text),expected);assert.deepEqual(state(f),before);
 const notification=rpcRequest(f,'notifications/initialized');const payload=JSON.parse(await notification.text());delete payload.id;const response=await f.platform.nativeRequest(new Request(notification,{body:JSON.stringify(payload)}));assert.equal(response.status,202);assert.equal(await response.text(),'');assert.deepEqual(state(f),before);
});
test('native MCP refuses absent/mixed/cross-site credentials before any held body is parsed',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),reader=await token(f,['read']),before=state(f);
 for(const headers of[{}, {Cookie:f.owner.cookie},{Authorization:'Bearer '+reader.accessToken,Cookie:f.owner.cookie},{Authorization:'Bearer '+reader.accessToken,Origin:'https://foreign.test'},{Authorization:'Bearer '+reader.accessToken,'Sec-Fetch-Site':'cross-site'},{Authorization:'Bearer invalid'}]){
  await f.platform.rpc({kind:'observe-next-native-reply'});const held=raw(f,path(f),{headers,hold:true,length:1024});try{await until(async()=>Boolean((await f.platform.rpc({kind:'native-reply'})).reply),'actual platform refusal before held body');const observed=(await f.platform.rpc({kind:'native-reply'})).reply;assert.equal(observed.bodyUsed,false);held.send('!'.repeat(1024));const result=await held.response;assert.equal(result.status,observed.status);assert.ok([401,403].includes(result.status),JSON.stringify(result));assert.equal(Object.hasOwn(result.body,'result'),false)}finally{held.close()}
 }
 assert.deepEqual(state(f),before);
});
test('native MCP raw aliases and wrong methods cannot enter framework parsing',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),base=path(f),headers={Authorization:'Bearer '+f.owner.accessToken},before=state(f);
 const variants=[base.replace('/shadow/','/shadow/%2e/'),base.replace('/shadow/','/shadow/./'),base.replace('/shadow/','/shadow/a/%2e%2e/'),base.replace('/shadow/','/%73hadow/'),base+'?',base+'?x=1',base+'#fragment',base.replace('/shadow/','/shadow\\'),'/'+base,base.replace('/shadow/','/'+ 'a'.repeat(1024)+'/../shadow/')];
 for(const target of variants){await f.platform.rpc({kind:'observe-next-native-reply'});const held=raw(f,target,{headers,hold:true,length:2048});try{await until(async()=>Boolean((await f.platform.rpc({kind:'native-reply'})).reply),'actual alias refusal before held body');const observed=(await f.platform.rpc({kind:'native-reply'})).reply;assert.equal(observed.bodyUsed,false);held.send('!'.repeat(2048));const result=await held.response;assert.equal(result.status,observed.status);assert.ok([400,403,404].includes(result.status),JSON.stringify({target,result}));assert.equal(Object.hasOwn(result.body,'result'),false)}finally{held.close()}}
 for(const method of['GET','DELETE','OPTIONS']){const held=raw(f,base,{method,headers});try{assert.equal((await held.response).status,405)}finally{held.close()}}
 assert.deepEqual(state(f),before);
});
test('native MCP current token revocation during held parsing refuses initialize, list, call and invalid tool replies',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),before=state(f);
 for(const [method,params] of[['initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'held-native',version:'1'}}],['tools/list',{}],['tools/call',{name:'shadow_status',arguments:{}}],['tools/call',{name:'shadow_status',arguments:{unexpected:true}}]]){
  const reader=await token(f,['read']);f.control.prepare('UPDATE clank_platform_tokens SET last_used_at=0 WHERE id=?').run(reader.id);const held=raw(f,path(f),{headers:{Authorization:'Bearer '+reader.accessToken},body:message(method,params),hold:true});
  try{await held.connected;await until(()=>Number(f.control.prepare('SELECT last_used_at FROM clank_platform_tokens WHERE id=?').get(reader.id).last_used_at)>0,'actual pre-body bearer admission');f.control.prepare('UPDATE clank_platform_tokens SET revoked_at=? WHERE id=?').run(Date.now(),reader.id);held.send();const result=await held.response;assert.equal(result.status,401,JSON.stringify(result));assert.equal(Object.hasOwn(result.body,'result'),false)}finally{held.close()}
 }
 assert.deepEqual(state(f),before);
});
test('native MCP refuses deploy-only, preview-only, foreign project, disabled user and held membership loss',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),before=state(f);
 for(const permission of['deploy','previews']){const limited=await token(f,[permission]);const result=await rpc(f,'tools/list',{}, {token:limited.accessToken});assert.equal(result.status,403,JSON.stringify(result))}
 const reader=await token(f,['read']);const foreign=rpcRequest(f,'tools/list',{}, {token:reader.accessToken,url:'http://127.0.0.1:4200/api/projects/other_project/shadow/mcp'});assert.equal((await f.platform.nativeRequest(foreign)).status,403);
 const member=await f.invite('mcp-reader-member@example.test');const session=await f.platform.nativeRequest(request('/api/device/start',{method:'POST',body:{clientName:'mcp-member'}})),started=await session.json();assert.equal(session.status,201);
 const approval=await f.platform.nativeRequest(request('/api/device/approve',{method:'POST',body:{code:started.userCode},cookie:member.cookie,csrf:member.csrf}));assert.equal(approval.status,200);
 const issued=await f.platform.nativeRequest(request('/api/device/token',{method:'POST',body:{deviceCode:started.deviceCode}})),credential=await issued.json();assert.equal(issued.status,200);const row=f.control.prepare('SELECT id FROM clank_platform_tokens WHERE user_id=?').get(member.user.id);f.control.prepare('UPDATE clank_platform_tokens SET last_used_at=0 WHERE id=?').run(row.id);
 const held=raw(f,path(f),{headers:{Authorization:'Bearer '+credential.accessToken},body:message('tools/call',{name:'shadow_status',arguments:{}}),hold:true});try{await held.connected;await until(()=>Number(f.control.prepare('SELECT last_used_at FROM clank_platform_tokens WHERE id=?').get(row.id).last_used_at)>0,'member body admission');f.control.prepare("UPDATE clank_platform_project_members SET permissions='[]' WHERE project_id=? AND user_id=?").run(f.project.id,member.user.id);held.send();assert.equal((await held.response).status,403)}finally{held.close()}
 f.control.prepare('UPDATE clank_auth_users SET disabled=1 WHERE id=?').run(member.user.id);assert.equal((await rpc(f,'tools/list',{}, {token:credential.accessToken})).status,401);assert.deepEqual(state(f),before);
});
test('native MCP checks admitted header identity and final token authority after native read completion',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),reader=await token(f,['read']),before=state(f);await f.platform.rpc({kind:'mutate-native-header',header:['authorization','Bearer '+reader.accessToken]});const changed=await rpc(f,'tools/list');assert.equal(changed.status,403,JSON.stringify(changed));assert.equal(changed.body.error.code,'SHADOW_REQUEST_CHANGED');
 f.control.exec(`CREATE TRIGGER mcp_revoke AFTER DELETE ON clank_distributed_leases WHEN OLD.resource='project:${f.project.id}' BEGIN UPDATE clank_platform_tokens SET revoked_at=${Date.now()} WHERE id='${reader.id}';END`);
 const revoked=await rpc(f,'tools/call',{name:'shadow_status',arguments:{}},{token:reader.accessToken});assert.equal(revoked.status,401,JSON.stringify(revoked));assert.equal(Object.hasOwn(revoked.body,'result'),false);assert.deepEqual(state(f),before);
});
test('native MCP runtime closed arguments and bounded body have no provider effects',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),before=state(f);
 for(const input of[{projectId:f.project.id},{sessionId:'valid',limit:1},{sessionId:null},{limit:0},{limit:21},{limit:1.5},{before:''},{before:'x'.repeat(513)},{before:'%alias'},{unknown:true}]){const result=await rpc(f,'tools/call',{name:'shadow_status',arguments:input});assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.result.isError,true);assert.equal(result.body.result.structuredContent.error.code,'SHADOW_INPUT_INVALID');}
 const unknown=await rpc(f,'tools/call',{name:'shadow_stop',arguments:{}});assert.ok(unknown.body.error);assert.equal(Object.hasOwn(unknown.body,'result'),false);
 const huge=rpcRequest(f,'tools/list',{padding:'x'.repeat(8192)}),refused=await f.platform.nativeRequest(huge);assert.equal(refused.status,413,await refused.text());assert.deepEqual(state(f),before);
});
test('native MCP returns exact legacy/v2/pruned detail and maximum-page duplicated envelope after disabled restart',{timeout:60000},async t=>{
 const f=await shadowPlatformFixture(t);await f.pausePlatform();const legacy=await appendShadowHistory(f,1);await appendShadowHistory(f,21,{version:2,maxReports:20,maximumPolicy:true});await f.successor();const before=state(f);
 const result=await rpc(f,'tools/call',{name:'shadow_status',arguments:{}});assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.result.isError,false);const payload=result.body.result.structuredContent;assert.equal(payload.enabled,false);assert.equal(payload.policy,null);assert.equal(payload.sessions.length,20);assert.equal(payload.sessions[0].report.protocol,2);assert.deepEqual(JSON.parse(result.body.result.content[0].text),payload);const bytes=Buffer.byteLength(JSON.stringify(result.body));assert.ok(bytes>350000&&bytes<=1048576);
 const next=await rpc(f,'tools/call',{name:'shadow_status',arguments:{before:payload.nextBefore}});assert.equal(next.body.result.isError,false);assert.equal(next.body.result.structuredContent.sessions.length,2);
 const detail=await rpc(f,'tools/call',{name:'shadow_status',arguments:{sessionId:legacy[0].sessionId}}),get=await f.platform.nativeRequest(request(path(f).slice(0,-4)+'/'+legacy[0].sessionId,{token:f.owner.accessToken}));assert.deepEqual(detail.body.result.structuredContent,await get.json());assert.equal(detail.body.result.structuredContent.session.report,null);assert.deepEqual(state(f),before);t.diagnostic(JSON.stringify({pageSessions:20,entireMcpBytes:bytes,sessionBytes:Buffer.byteLength(JSON.stringify(payload.sessions[0]))}));
});

test('current native token authority is checked after actual framework response serialization, including errors',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t),before=state(f);
 for(const [method,params] of[['initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'serialization-native',version:'1'}}],['tools/list',{}],['tools/call',{name:'shadow_status',arguments:{}}],['tools/call',{name:'shadow_status',arguments:{bad:true}}],['tools/call',{name:'unknown',arguments:{}}]]){
  const reader=await token(f,['read']);await f.platform.rpc({kind:'revoke-mcp-serialization',tokenId:reader.id});const result=await rpc(f,method,params,{token:reader.accessToken});assert.equal(result.status,401,JSON.stringify({method,result}));assert.equal(Object.hasOwn(result.body,'result'),false);assert.ok(f.control.prepare('SELECT revoked_at FROM clank_platform_tokens WHERE id=?').get(reader.id).revoked_at);
 }
 assert.deepEqual(state(f),before);
});
test('native MCP accepts only current explicit service-account read scope',{timeout:60000},async t=>{
 const f=await shadowPlatformFixture(t,undefined,undefined,{serviceAccounts:true});await f.fresh();
 const mutate=async(path,body)=>{const response=await f.platform.nativeRequest(request(path,{method:'POST',body,cookie:f.owner.cookie,csrf:f.owner.csrf}));const value=await response.json();assert.equal(response.status,201,JSON.stringify(value));return value};
 const base=`/api/organizations/${f.project.organizationId}/service-accounts`,account=(await mutate(base,{name:'MCP status bot',ownerId:f.owner.user.id,operationId:'shadow_mcp_machine_create_01'})).account;
 const issued=(await mutate(base+'/'+account.id+'/credentials',{projectId:f.project.id,permissions:['read'],expiresAt:Date.now()+600000,expectedVersion:account.version,operationId:'shadow_mcp_machine_issue_01'})).issued,before=state(f);
 const result=await rpc(f,'tools/call',{name:'shadow_status',arguments:{}},{token:issued.accessToken});assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.result.isError,false);
 f.control.prepare('UPDATE clank_platform_machine_credentials SET revoked_at=? WHERE id=?').run(Date.now(),issued.credential.id);assert.equal((await rpc(f,'tools/list',{}, {token:issued.accessToken})).status,401);assert.deepEqual(state(f),before);
});
test('native MCP preserves available legacy report bytes and refuses invalid cursor/detail without effects',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t);await f.pausePlatform();const legacy=await appendShadowHistory(f,1);await f.successor();const before=state(f),id=legacy[0].sessionId;
 const detail=await rpc(f,'tools/call',{name:'shadow_status',arguments:{sessionId:id}}),get=await f.platform.nativeRequest(request(path(f).slice(0,-4)+'/'+id,{token:f.owner.accessToken}));assert.equal(detail.body.result.isError,false);assert.deepEqual(detail.body.result.structuredContent,await get.json());assert.equal(Object.hasOwn(detail.body.result.structuredContent.session.report,'skips'),false);assert.equal(JSON.stringify(detail.body.result.structuredContent.session.report),before.replay[0].report_json);
 for(const input of[{sessionId:'missing_session'},{before:'clankshc1.invalid.invalid'}]){const result=await rpc(f,'tools/call',{name:'shadow_status',arguments:input});assert.equal(result.status,200);assert.equal(result.body.result.isError,true);assert.equal(Object.hasOwn(result.body.result.structuredContent,'session'),false)}assert.deepEqual(state(f),before);
});

test('native MCP stays on the control host when ingress and shadow policy are disabled',{timeout:45000},async t=>{
 const f=await shadowPlatformFixture(t);await f.pausePlatform();f.options.ingress=undefined;f.options.deploymentAgents.placement=undefined;await f.successor();const before=state(f),body=message('tools/list');
 const alternate=raw(f,path(f),{host:'localhost:4200',headers:{Authorization:'Bearer '+f.owner.accessToken},body});try{const result=await alternate.response;assert.equal(result.status,403,JSON.stringify(result));assert.equal(Object.hasOwn(result.body,'result'),false)}finally{alternate.close()}
 assert.equal((await rpc(f,'tools/list')).status,200);assert.deepEqual(state(f),before);
});
