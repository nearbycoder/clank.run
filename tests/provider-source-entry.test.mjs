import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Readable} from 'node:stream';
import {readSourceStartupFrame,decodeSourceStartupEnvelope} from '../dist/provider-source-entry.js';

const slot=Symbol.for('clank.provider.source.startup.v1');
const bootstrap=()=>({protocol:'clank-provider-source-bootstrap/2',binding:{},bindingSha256:'a'.repeat(64),containerId:'b'.repeat(64),catalogPath:'/run/clank-source/catalog.sqlite',grantSecret:'private-grant',controlSecret:'private-control',recoveryKey:'private-recovery',workerChannel:{}});
const envelope=(environment={APP_VALUE:'雪\nvalue'})=>({environment,bootstrap:bootstrap()});
const frame=value=>Buffer.from(JSON.stringify(value)+'\n');

test('private transport import and parsing grant no process source authority',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,slot),old=process.env.APP_VALUE;
 const value=envelope(),parsed=decodeSourceStartupEnvelope(await readSourceStartupFrame(Readable.from([frame(value)])));
 assert.deepEqual(parsed.environment,value.environment);assert.equal(parsed.source,JSON.stringify(value.bootstrap));
 assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,slot),original);assert.equal(process.env.APP_VALUE,old);
});
test('source reader waits for EOF after a complete line and retains split UTF-8 bytes',async()=>{
 const stream=new PassThrough(),body=frame(envelope());let settled=false;
 const pending=readSourceStartupFrame(stream).then(value=>{settled=true;return value;});
 const split=body.indexOf(Buffer.from('雪'))+1;
 stream.write(body.subarray(0,split));stream.write(body.subarray(split));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
 stream.end();assert.equal(await pending,body.subarray(0,-1).toString());assert.equal(stream.destroyed,true);
});
test('a later second frame is refused before a bootstrap can be decoded',async()=>{
 const stream=new PassThrough(),pending=readSourceStartupFrame(stream);
 const denied=assert.rejects(pending,/startup refused/);
 stream.write(frame(envelope()));await new Promise(resolve=>setImmediate(resolve));
 stream.end(frame(envelope()));await denied;assert.equal(stream.destroyed,true);
});
for(const [name,chunks]of [
 ['empty EOF',[]],['empty line',[Buffer.from('\n')]],['unterminated frame',[Buffer.from('{}')]],
 ['two frames in one chunk',[Buffer.from('{}\n{}\n')]],['trailing byte',[Buffer.from('{}\nx')]],
 ['CRLF',[Buffer.from('{}\r\n')]],['invalid UTF-8',[Buffer.from([0xc3,0x28,10])]],
 ['oversized allocation',[Buffer.alloc(3*1024*1024+16384+130,65)]],
 ['deep structure',[Buffer.from('['.repeat(9)+']'.repeat(9)+'\n')]],
 ['excess structural tokens',[Buffer.from('['+'0,'.repeat(4097)+'0]\n')]],
 ['unclosed string',[Buffer.from('{"x":"unfinished}\n')]],
 ['nonbuffer input',['{}\n']],
])test('source frame rejects '+name,async()=>{
 const stream=Readable.from(chunks);await assert.rejects(readSourceStartupFrame(stream));assert.equal(stream.destroyed,true);
});
test('stream errors propagate and close without publishing a startup slot',async()=>{
 const stream=new PassThrough(),pending=readSourceStartupFrame(stream),denied=assert.rejects(pending,/owned input failed/);
 stream.destroy(Error('owned input failed'));await denied;assert.equal(Object.hasOwn(globalThis,slot),false);
});
for(const [name,mutate]of [
 ['unknown root',value=>{value.extra=true;}],['missing root',value=>{delete value.environment;}],
 ['null environment',value=>{value.environment=null;}],['array environment',value=>{value.environment=[];}],
 ['lowercase environment',value=>{value.environment={lower:'x'};}],
 ['NUL environment',value=>{value.environment={APP:'x\0y'};}],
 ['nonstring environment',value=>{value.environment={APP:7};}],
 ['too many environment keys',value=>{value.environment=Object.fromEntries(Array.from({length:513},(_,i)=>['APP_'+i,'x']));}],
 ['oversized environment',value=>{value.environment={APP:'x'.repeat(3*1024*1024)};}],
 ['unknown bootstrap',value=>{value.bootstrap.sql='SELECT 1';}],
 ['missing bootstrap',value=>{delete value.bootstrap.recoveryKey;}],
 ['old protocol',value=>{value.bootstrap.protocol='clank-provider-source-bootstrap/1';}],
 ['arbitrary catalog',value=>{value.bootstrap.catalogPath='/data/catalog.sqlite';}],
 ['oversized bootstrap',value=>{value.bootstrap.recoveryKey='x'.repeat(16384);}],
])test('startup envelope rejects '+name+' without process mutation',()=>{
 const value=envelope();mutate(value);assert.throws(()=>decodeSourceStartupEnvelope(JSON.stringify(value)));
 assert.equal(Object.hasOwn(globalThis,slot),false);
});
for(const value of [' '+JSON.stringify(envelope()),JSON.stringify(envelope()).replace('"environment":','"environment":{},"environment":'),'{"environment":{},"bootstrap":null}'])test('noncanonical or malformed bootstrap is refused',()=>assert.throws(()=>decodeSourceStartupEnvelope(value)));
