import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {openSourceWorkerSocketClient,createSourceWorkerServerProtocol} from '../dist/provider-source-worker-wire.js';

const root='/run/clank-source-worker',secret=new Uint8Array(32).fill(47);
const identity={bindingSha256:'a'.repeat(64),containerId:'b'.repeat(64),sourceIncarnation:randomUUID()};
const backupId='bk_1791750000000_abcdefghijklmnopqrstuvwx';
const task=operation=>({protocol:'clank-source-sqlite-task/1',operation,backupId,temporaryId:operation==='backup'?randomUUID():null});
const inspected={revision:7,migrationCount:1,latestMigration:'0001_café_日本'};

// Real native sockets, hard links, inode pins and byte streams. Only the fixed
// mount pathname/read-only mountinfo are modeled here; the container fixture
// independently proves those kernel properties on the actual source mount.
async function fixture(t,reply){
 const directory=fs.mkdtempSync(join(tmpdir(),'clank-source-client-')),mount=join(directory,'mount'),listener=join(directory,'listener');
 fs.mkdirSync(mount,{mode:0o700});fs.mkdirSync(listener,{mode:0o700});
 const protocol=createSourceWorkerServerProtocol(secret,identity),original={};
 let peer,connections=0,requests=0,mountOptions='ro',propagation='',client;
 const server=net.createServer(socket=>{
  connections++;peer=socket;socket.on('error',()=>{});let input='';
  socket.on('data',chunk=>{input+=chunk.toString('utf8');if(!input.endsWith('\n'))return;
   try{const accepted=protocol.accept(input.slice(0,-1));input='';requests++;
    const response=protocol.reply(accepted,accepted.task.operation==='inspect'?inspected:undefined);
    if(reply)reply(socket,response,requests);else socket.write(response+'\n');
   }catch{socket.destroy();}
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(join(listener,'socket'),resolve);});
 fs.chmodSync(join(listener,'socket'),0o600);fs.linkSync(join(listener,'socket'),join(mount,'sqlite.sock'));
 const map=path=>typeof path==='string'&&path.startsWith(root)?mount+path.slice(root.length):path;
 for(const name of ['readFileSync','lstatSync','openSync','realpathSync'])original[name]=fs[name];
 fs.readFileSync=(path,...args)=>path==='/proc/self/mountinfo'?`1 0 1:1 / ${root} ${mountOptions} ${propagation}- tmpfs tmpfs ro\n`:original.readFileSync(path,...args);
 fs.lstatSync=(path,...args)=>original.lstatSync(map(path),...args);
 fs.openSync=(path,...args)=>original.openSync(map(path),...args);
 fs.realpathSync=(path,...args)=>path===root?(original.realpathSync(mount,...args)===mount?root:mount):original.realpathSync(path,...args);
 syncBuiltinESMExports();
 t.after(async()=>{
  client?.close();peer?.destroy();protocol.close();
  for(const [name,value]of Object.entries(original))fs[name]=value;syncBuiltinESMExports();
  await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});
 });
 const open=async()=>client=await openSourceWorkerSocketClient(secret,protocol.binding,process.getuid(),process.getgid());
 return {open,mount,peer:()=>peer,connections:()=>connections,requests:()=>requests,options(value){mountOptions=value;},propagation(value){propagation=value;}};
}

test('fixed client settles three actual native responses with segmented UTF-8 and no reconnect',async t=>{
 const f=await fixture(t,(socket,response)=>{const data=Buffer.from(response+'\n'),split=data.includes(0xc3)?data.indexOf(0xc3)+1:31;socket.write(data.subarray(0,split));setImmediate(()=>socket.write(data.subarray(split)));});
 const client=await f.open();assert.deepEqual(secret,new Uint8Array(32).fill(47));
 for(const operation of ['backup','inspect','verify'])assert.deepEqual(await client.execute(task(operation)),operation==='inspect'?inspected:undefined);
 client.assertCurrent();client.complete();client.assertCurrent();assert.equal(f.connections(),1);assert.equal(f.requests(),3);await assert.rejects(client.execute(task('backup')));client.close();
});

test('three authenticated worker replies cannot survive peer loss before original native completion',async t=>{
 const f=await fixture(t),client=await f.open();
 for(const operation of ['backup','inspect','verify'])await client.execute(task(operation));
 await new Promise(r=>setTimeout(r,25));assert.equal(f.peer().destroyed,false,'worker replies must keep the original peer live');
 f.peer().destroy();await new Promise(r=>setTimeout(r,25));
 assert.throws(()=>client.complete(),/disconnected/);assert.throws(()=>client.assertCurrent());assert.equal(f.connections(),1);assert.equal(f.requests(),3);
});

for(const kind of ['bad-mac','oversized','hidden-utf8-suffix','extra-frame','invalid-utf8','carriage-return','disconnect'])test('client refuses '+kind+' and never retries a lost result',async t=>{
 const f=await fixture(t,(socket,response)=>{
  if(kind==='bad-mac'){const value=JSON.parse(response);value.mac='0'.repeat(64);socket.write(JSON.stringify(value)+'\n');}
  if(kind==='oversized')socket.write(Buffer.alloc(8194,65));
  if(kind==='hidden-utf8-suffix')socket.write(Buffer.concat([Buffer.from(response+'\n'),Buffer.from([0xc3])]));
  if(kind==='extra-frame')socket.write(response+'\n'+response+'\n');
  if(kind==='invalid-utf8')socket.write(Buffer.from([0xff,10]));
  if(kind==='carriage-return')socket.write(response+'\r\n');
  if(kind==='disconnect')socket.destroy();
 });
 const client=await f.open();await assert.rejects(client.execute(task('backup')));await assert.rejects(client.execute(task('backup')));assert.throws(()=>client.assertCurrent());assert.equal(f.connections(),1);assert.equal(f.requests(),1);
});

test('concurrent request refuses without consuming the next operation',async t=>{
 let respond;const f=await fixture(t,(socket,response)=>{respond=()=>socket.write(response+'\n');}),client=await f.open();
 const first=client.execute(task('backup'));await assert.rejects(client.execute(task('inspect')),/owned request/);
 while(!respond)await new Promise(r=>setImmediate(r));respond();await first;client.close();assert.equal(f.requests(),1);
});
test('original client close rejects an in-flight response and retains one connection',async t=>{
 const f=await fixture(t,()=>{}),client=await f.open(),first=client.execute(task('backup'));
 client.close();await assert.rejects(first,/closed/);assert.throws(()=>client.assertCurrent());assert.equal(f.connections(),1);
});
for(const kind of ['writable','shared','directory-mode','socket-replaced'])test('client refuses native identity drift '+kind+' without adopting bytes',async t=>{
 const f=await fixture(t),client=await f.open();
 if(kind==='writable')f.options('rw');
 if(kind==='shared')f.propagation('shared:1 ');
 if(kind==='directory-mode')fs.chmodSync(f.mount,0o755);
 if(kind==='socket-replaced'){fs.renameSync(join(f.mount,'sqlite.sock'),join(f.mount,'retained'));fs.writeFileSync(join(f.mount,'sqlite.sock'),'unknown replacement',{mode:0o600});}
 assert.throws(()=>client.assertCurrent());await assert.rejects(client.execute(task('backup')));assert.equal(f.requests(),0);
 if(kind==='socket-replaced')assert.equal(fs.readFileSync(join(f.mount,'sqlite.sock'),'utf8'),'unknown replacement');
});
test('wrong native owner refuses before connecting',async t=>{
 const f=await fixture(t),server=createSourceWorkerServerProtocol(secret,identity);
 await assert.rejects(openSourceWorkerSocketClient(secret,server.binding,process.getuid()+1,process.getgid()));assert.equal(f.connections(),0);server.close();
});
