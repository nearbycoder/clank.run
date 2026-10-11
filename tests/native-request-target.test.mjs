import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {serve} from '../dist/node.js';
import * as security from '../dist/security.js';
async function raw(url,target,{method='POST',host='control.test',headers=[],body=''}={}){
 return new Promise((resolve,reject)=>{const socket=connect({host:'127.0.0.1',port:Number(new URL(url).port)});let wire='';socket.setTimeout(5000,()=>socket.destroy(new Error('Owned raw target probe timed out.')));socket.on('error',reject);socket.on('data',chunk=>{wire+=chunk.toString('latin1');if(wire.length>16384)socket.destroy(new Error('Owned raw response exceeded bound.'))});socket.on('end',()=>{const [head,...parts]=wire.split('\r\n\r\n');let body=parts.join('\r\n\r\n');if(/transfer-encoding: chunked/i.test(head)){let at=0,decoded='';while(at<body.length){const end=body.indexOf('\r\n',at),size=parseInt(body.slice(at,end),16);if(!size)break;decoded+=body.slice(end+2,end+2+size);at=end+2+size+2;}body=decoded;}resolve({status:Number(head.split(' ')[1]),body})});socket.on('connect',()=>socket.write(`${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${method==='POST'?`Content-Length: ${Buffer.byteLength(body)}\r\n`:''}${headers.map(([key,value])=>`${key}: ${value}\r\n`).join('')}\r\n${body}`));});
}
test('actual native POST target proof is separate from anonymous proof and absent on clones',async t=>{
 const listener=await serve(request=>Response.json({proof:security.hasCanonicalRequestTarget?.(request)??false,clone:security.hasCanonicalRequestTarget?.(request.clone())??false,anonymous:Boolean(security.exactRequest(request))}),{hostname:'127.0.0.1',port:0,allowedHosts:['control.test']});t.after(()=>listener.close());
 const result=await raw(listener.url,'/api/projects/project_123/shadow/mcp',{headers:[['Authorization','Bearer actual-native-target-fixture']]});assert.equal(result.status,200);assert.deepEqual(JSON.parse(result.body),{proof:true,clone:false,anonymous:false});
});

test('actual raw targets refuse every normalized spelling alias without changing ordinary dispatch',async t=>{
 const seen=[];const listener=await serve(request=>{const value={method:request.method,url:request.url,proof:security.hasCanonicalRequestTarget(request)};seen.push(value);return Response.json(value)},{hostname:'127.0.0.1',port:0,allowedHosts:['control.test']});t.after(()=>listener.close());
 const canonical='/api/projects/project_123/shadow/mcp';
 for(const target of['/api/projects/project_123/shadow/%2e/mcp','/api/projects/project_123/shadow/./mcp','/api/projects/project_123/shadow/discard/%2e%2e/mcp','/api/projects/project_123/%73hadow/mcp',canonical+'?',canonical+'?x=1',canonical+'#part','/api/projects/project_123/shadow\\mcp','//api/projects/project_123/shadow/mcp','/'+ 'x'.repeat(1024)]){
  const result=await raw(listener.url,target);assert.equal(result.status,200,JSON.stringify({target,result}));assert.equal(JSON.parse(result.body).proof,false,target);
 }
 const before=seen.length;assert.equal((await raw(listener.url,'/caf\xe9')).status,400);assert.equal(seen.length,before,'Node HTTP parser rejects raw non-ASCII before dispatch.');
 assert.equal((await raw(listener.url,canonical)).status,200);assert.equal(seen.at(-1).proof,true);
 assert.ok(seen.slice(0,3).every(row=>new URL(row.url).pathname===canonical),'These actual native targets collapse to the same Fetch pathname.');
});
test('native target proof leaves ordinary POST body and anonymous observation unchanged',async t=>{
 const listener=await serve(async request=>Response.json({body:request.method==='POST'?await request.text():null,proof:security.hasCanonicalRequestTarget(request),anonymous:security.exactRequest(request)??null}),{hostname:'127.0.0.1',port:0,allowedHosts:['control.test']});t.after(()=>listener.close());
 const post=await raw(listener.url,'/ordinary',{body:'unchanged payload'});assert.deepEqual(JSON.parse(post.body),{body:'unchanged payload',proof:true,anonymous:null});
 const get=await raw(listener.url,'/catalog',{method:'GET'});assert.deepEqual(JSON.parse(get.body),{body:null,proof:false,anonymous:{method:'GET',path:'/catalog',accept:null}});
});
test('target attachment is one-shot, bounded and rechecks exact object identity without retaining headers',()=>{
 const target='/'+ 'x'.repeat(1023),attach=security.captureCanonicalRequestTarget('POST',target);assert.equal(typeof attach,'function');
 const request=new Request('http://control.test'+target,{method:'POST'}),replacement=new Request(request);attach(request);attach(replacement);assert.equal(security.hasCanonicalRequestTarget(request),true);assert.equal(security.hasCanonicalRequestTarget(replacement),false);
 request.headers.set('authorization','changed');assert.equal(security.hasCanonicalRequestTarget(request),true,'Target proof is deliberately not header/auth authority.');assert.equal(security.exactRequest(request),undefined);
 Object.defineProperty(request,'url',{value:'http://control.test/changed'});assert.equal(security.hasCanonicalRequestTarget(request),false);
 for(const [method,value] of[['GET','/'],['post','/'],['POST',''],['POST','x'],['POST','/'+ 'x'.repeat(1024)],['POST','/a b'],['POST','/a\t'],['POST','/\u0100']])assert.equal(security.captureCanonicalRequestTarget(method,value),undefined);
 const long=new Request('http://'+'a'.repeat(2040)+'/x',{method:'POST'});security.captureCanonicalRequestTarget('POST','/x')(long);assert.equal(security.hasCanonicalRequestTarget(long),false);
 const broken=new Request('http://control.test/x',{method:'POST'});Object.defineProperty(broken,'url',{get(){throw new Error('Untrusted getter')}});assert.doesNotThrow(()=>security.captureCanonicalRequestTarget('POST','/x')(broken));assert.equal(security.hasCanonicalRequestTarget(broken),false);
 const changed=new Request('http://control.test/x',{method:'POST'});security.captureCanonicalRequestTarget('POST','/x')(changed);Object.defineProperty(changed,'method',{value:'GET'});assert.equal(security.hasCanonicalRequestTarget(changed),false);
});
