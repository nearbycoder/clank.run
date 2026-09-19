import assert from 'node:assert/strict';
import test from 'node:test';
import {compareContracts} from '../dist/contract-compatibility.js';
import {defineBackend,defineDatabase,defineTable,openBackend} from '../dist/backend.js';
import {s} from '../dist/ai.js';
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const action=(overrides={})=>({name:'tickets.add',kind:'mutation',access:'public',agent:true,args:object({title:{type:'string'}},['title']),returns:object({id:{type:'string'}},['id']),...overrides});
const backend=(functions)=>({protocol:'clank-live/1',functions});
const diff=(a,b)=>compareContracts(backend([a]),backend([b]));
test('compatibility checks real generated backend manifests and safe optional argument additions',async()=>{
 const schema=defineDatabase({tickets:defineTable({title:s.string()})});
 const before=await openBackend(defineBackend({schema}).functions(({query})=>({list:query({args:{},returns:s.array(s.string()),handler:()=>[]})})));
 const after=await openBackend(defineBackend({schema}).functions(({query})=>({list:query({args:{filter:s.optional(s.string())},returns:s.array(s.string()),handler:()=>[]})})));
 try{
  const manifest=async runtime=>(await runtime.handle(new Request('http://localhost/__clank/manifest'))).json();
  assert.equal(compareContracts(await manifest(before),await manifest(after)).ok,true);
 }finally{before.close();after.close();}
});
test('removed actions, kind, auth, agent exposure, required input and output loss block compatibility',()=>{
 assert.equal(compareContracts(backend([action()]),backend([])).ok,false);
 for(const changed of [{kind:'query'},{access:'required'},{agent:false},{args:object({title:{type:'string'},owner:{type:'string'}},['title','owner'])},{returns:object({id:{type:'number'}},['id'])},{returns:object({id:{type:'string'}},[])},{returns:undefined}]) assert.equal(diff(action(),action(changed)).ok,false,JSON.stringify(changed));
});
test('input widening and output narrowing use opposite compatibility directions',()=>{
 assert.equal(diff(action({args:object({title:{type:'string',maxLength:10}},['title'])}),action({args:object({title:{type:'string',maxLength:20}},['title'])})).ok,true);
 assert.equal(diff(action({args:object({title:{type:'string',maxLength:20}},['title'])}),action({args:object({title:{type:'string',maxLength:10}},['title'])})).ok,false);
 assert.equal(diff(action({returns:{type:'number'}}),action({returns:{type:'integer'}})).ok,true);
 assert.equal(diff(action({returns:{type:'integer'}}),action({returns:{type:'number'}})).ok,false);
 assert.equal(diff(action({returns:{type:'string',enum:['a','b']}}),action({returns:{type:'string',enum:['a']}})).ok,true);
 assert.equal(diff(action({returns:{type:'string',enum:['a']}}),action({returns:{type:'string',enum:['a','b']}})).ok,false);
});
test('nested arrays and additional properties are checked; uncertain schemas require review',()=>{
 assert.equal(diff(action({args:object({items:{type:'array',items:{type:'string'}}})}),action({args:object({items:{type:'array',items:{type:'integer'}}})})).ok,false);
 assert.equal(diff(action({args:{type:'object'}}),action({args:object()})).ok,false);
 const report=diff(action({args:{anyOf:[{type:'string'},{type:'null'}]}}),action({args:{type:'string'}}));
 assert.equal(report.ok,false);assert.ok(report.findings.some(x=>x.severity==='review'));
 assert.equal(diff(action({args:{type:'string',description:'Before'}}),action({args:{type:'string',description:'After'}})).ok,true);
 assert.equal(diff(action({args:{type:'string',default:'before'}}),action({args:{type:'string',default:'after'}})).ok,false);
});
test('MCP scope changes, aliases and incomplete catalogs cannot silently pass',()=>{
 const tool={name:'tickets_add',inputSchema:object(),outputSchema:{type:'string'},requiredScope:'agent:read',actionPath:'tickets.add'};
 const manifest=tool=>({protocol:'mcp',tools:[tool]});
 assert.equal(compareContracts(manifest(tool),manifest(tool)).ok,true);
 for(const changed of [{requiredScope:'agent:write'},{requiredScope:undefined},{actionPath:'tickets.delete'}]) assert.equal(compareContracts(manifest(tool),manifest({...tool,...changed})).ok,false);
 assert.throws(()=>compareContracts({...manifest(tool),nextCursor:'more'},manifest(tool)));
 assert.throws(()=>compareContracts({tools:[tool,tool]},manifest(tool)));
 assert.throws(()=>compareContracts(backend([action()]),manifest(tool)));
});
