import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pinSQLiteDirectory} from '../dist/sqlite-sandbox.js';
import {openSourceWorkerSocketBroker} from '../dist/provider-source-worker-wire.js';
const linux={skip:process.platform!=='linux'||!process.getuid?.()};
async function fixture(t){
 const root=fs.mkdtempSync(join(tmpdir(),'clank-worker-transport-')),dirs=[];
 for(const name of ['listener','disposal','mount']){const path=join(root,name);fs.mkdirSync(path,{mode:0o700});dirs.push(await pinSQLiteDirectory(path));}
 let broker;const sockets=[];
 t.after(async()=>{for(const socket of sockets)socket.destroy();try{await broker?.close();}finally{await Promise.allSettled(dirs.map(p=>p.close()));fs.rmSync(root,{recursive:true,force:true});}});
 return {root,dirs,async open(){broker=await openSourceWorkerSocketBroker(...dirs);return broker;},connect(){const socket=net.createConnection(join(root,'mount','sqlite.sock'));socket.on('error',()=>{});sockets.push(socket);return socket;}};
}
function line(socket){return new Promise((resolve,reject)=>{let text='';socket.setEncoding('utf8');const data=value=>{text+=value;const end=text.indexOf('\n');if(end>=0){socket.off('data',data);resolve(text.slice(0,end));}};socket.on('data',data);socket.once('error',reject);socket.once('close',()=>reject(Error('peer closed before response')));});}
function connected(socket){return new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});}
test('native private UNIX broker exchanges exactly three bounded frames and preserves fragmented UTF-8',linux,async t=>{
 const f=await fixture(t),b=await f.open(),s=f.connect();await connected(s);
 for(const value of ['first','caf\u00e9','last']){const incoming=b.receive(),reply=line(s),bytes=Buffer.from(value+'\n');for(const byte of bytes)s.write(Buffer.from([byte]));assert.equal(await incoming,value);b.reply('ack '+value);assert.equal(await reply,'ack '+value);}
 const refused=b.receive();s.write('fourth\n');await assert.rejects(refused,/closed/);await b.close();assert.equal(fs.existsSync(join(f.root,'listener','socket')),false);assert.equal(fs.existsSync(b.socketPath),false);
});
test('native broker close settles a waiting receiver and removes only its pinned socket links',linux,async t=>{
 const f=await fixture(t),b=await f.open(),waiting=b.receive(),rejected=assert.rejects(waiting,/closed/);await b.close();await rejected;await b.close();assert.deepEqual(fs.readdirSync(join(f.root,'mount')),[]);
});
test('native broker preserves a replaced public endpoint while closing the actual listener',linux,async t=>{
 const f=await fixture(t),b=await f.open();fs.unlinkSync(b.socketPath);fs.writeFileSync(b.socketPath,'unknown replacement',{mode:0o600});await assert.rejects(async()=>b.receive(),/identity/);await b.close();assert.equal(fs.readFileSync(b.socketPath,'utf8'),'unknown replacement');assert.equal(fs.existsSync(join(f.root,'listener','socket')),false);
});
test('native broker preserves a replaced listener name instead of relying on Node automatic unlink',linux,async t=>{
 const f=await fixture(t),b=await f.open(),original=join(f.root,'listener','socket');fs.unlinkSync(original);fs.writeFileSync(original,'unknown listener replacement',{mode:0o600});await b.close();assert.equal(fs.readFileSync(original,'utf8'),'unknown listener replacement');assert.equal(fs.existsSync(b.socketPath),false);
});
test('broker rejects copied directory capabilities and aliased directories before spawning',linux,async t=>{
 const f=await fixture(t);await assert.rejects(openSourceWorkerSocketBroker({...f.dirs[0]},f.dirs[1],f.dirs[2]),/capability/);await assert.rejects(openSourceWorkerSocketBroker(f.dirs[0],f.dirs[0],f.dirs[2]),/distinct/);assert.deepEqual(fs.readdirSync(join(f.root,'listener')),[]);
});
test('broker refuses unknown pre-existing endpoints without changing their bytes or disposal permissions',linux,async t=>{
 const f=await fixture(t),path=join(f.root,'mount','sqlite.sock');fs.writeFileSync(path,'existing',{mode:0o600});await assert.rejects(f.open(),/adopted/);assert.equal(fs.readFileSync(path,'utf8'),'existing');assert.equal(fs.statSync(join(f.root,'disposal')).mode&0o777,0o700);
});
test('broker refuses a non-empty disposal directory without changing it',linux,async t=>{
 const f=await fixture(t),path=join(f.root,'disposal','existing');fs.writeFileSync(path,'retained');await assert.rejects(f.open(),/empty/);assert.equal(fs.readFileSync(path,'utf8'),'retained');assert.equal(fs.statSync(join(f.root,'disposal')).mode&0o777,0o700);
});
for(const [name,bytes]of[['oversized',Buffer.from('x'.repeat(2049)+'\n')],['invalid UTF-8',Buffer.from([255,10])],['multiple frames',Buffer.from('one\ntwo\n')]])test('native broker refuses '+name+' before forwarding a frame',linux,async t=>{
 const f=await fixture(t),b=await f.open(),s=f.connect();await connected(s);const pending=b.receive(),rejected=assert.rejects(pending,/closed/);s.write(bytes);await rejected;await b.close();
});
test('native broker refuses a second peer without disrupting its first peer',linux,async t=>{
 const f=await fixture(t),b=await f.open(),first=f.connect();await connected(first);const second=f.connect(),closed=new Promise(resolve=>second.once('close',resolve));await connected(second);await closed;const request=b.receive(),response=line(first);first.write('owned\n');assert.equal(await request,'owned');b.reply('ok');assert.equal(await response,'ok');await b.close();
});


test('broker permits one reply per received frame and bounds IPC reply occupancy',linux,async t=>{
 const f=await fixture(t),b=await f.open(),s=f.connect();await connected(s);assert.throws(()=>b.reply('unowned'),/unanswered/);const incoming=b.receive();s.write('one\n');assert.equal(await incoming,'one');await assert.rejects(b.receive(),/unanswered/);assert.throws(()=>b.reply('x'.repeat(8193)),/exceeds/);const response=line(s);b.reply('ok');assert.throws(()=>b.reply('replay'),/unanswered/);assert.equal(await response,'ok');await b.close();
});

test('native broker bounds a partial request by an absolute deadline despite ongoing input',linux,async t=>{
 const f=await fixture(t),b=await f.open(),s=f.connect();await connected(s);const start=performance.now(),pending=b.receive(),rejected=assert.rejects(pending,/closed/);s.write('x');const trickle=setInterval(()=>s.write('x'),500);
 try{await rejected;const elapsed=performance.now()-start;assert.ok(elapsed>=9900&&elapsed<12000);await b.close();}finally{clearInterval(trickle);}
});

for(const location of ['listener','mount'])test('broker preserves a dangling '+location+' endpoint before acquisition',linux,async t=>{
 const f=await fixture(t),path=join(f.root,location,location==='listener'?'socket':'sqlite.sock');fs.symlinkSync('missing-target',path);await assert.rejects(f.open(),/adopted/);assert.equal(fs.readlinkSync(path),'missing-target');assert.equal(fs.statSync(join(f.root,'disposal')).mode&0o777,0o700);
});
test('broker carries the maximum reply even when every byte requires JSON escaping',linux,async t=>{
 const f=await fixture(t),b=await f.open(),s=f.connect();await connected(s);const incoming=b.receive(),response=line(s);s.write('one\n');assert.equal(await incoming,'one');const body='\u0001'.repeat(8192);b.reply(body);assert.equal(await response,body);await b.close();
});
test('broker refuses directory replacement before delivering a waiting frame',linux,async t=>{
 const f=await fixture(t),b=await f.open(),s=f.connect();await connected(s);const incoming=b.receive(),rejected=assert.rejects(incoming,/directory changed/),mount=join(f.root,'mount');fs.renameSync(mount,mount+'-retained');fs.mkdirSync(mount,{mode:0o700});fs.writeFileSync(join(mount,'unknown'),'retained');s.write('one\n');await rejected;await b.close();assert.equal(fs.readFileSync(join(mount,'unknown'),'utf8'),'retained');assert.equal(fs.existsSync(join(mount+'-retained','sqlite.sock')),false);
});

test('broker checks the pinned socket mode before delivering a waiting frame',linux,async t=>{
 const f=await fixture(t),b=await f.open(),s=f.connect();await connected(s);const incoming=b.receive(),rejected=assert.rejects(incoming,/socket identity/);fs.chmodSync(b.socketPath,0o666);s.write('one\n');await rejected;await b.close();assert.equal(fs.existsSync(b.socketPath),false);
});
