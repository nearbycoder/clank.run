// Opt-in native /app entry checks; the ordinary test suite needs no bwrap.
// This exercises the loader, not container identity or bootstrap authenticity.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,copyFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
assert.equal(process.platform,'linux');assert.ok(process.getuid());assert.ok(process.getgid());
const root=await mkdtemp(join(tmpdir(),'clank-source-entry-cli-'));
const bootstrap={protocol:'clank-provider-source-bootstrap/2',binding:{},bindingSha256:'a'.repeat(64),containerId:'b'.repeat(64),catalogPath:'/run/clank-source/catalog.sqlite',grantSecret:'owned-test-grant',controlSecret:'owned-test-control',recoveryKey:'owned-test-recovery',workerChannel:{}};
const body=JSON.stringify({environment:{CLANK_ENTRY_TEST:'雪\nstdin'},bootstrap})+'\n';
const failure='Clank source entry startup refused.\n',records=[];
try{
 await copyFile(new URL('../../dist/provider-source-entry.js',import.meta.url),join(root,'entry.mjs'));
 await writeFile(join(root,'app.mjs'),`const slot=Symbol.for('clank.provider.source.startup.v1'),d=Object.getOwnPropertyDescriptor(globalThis,slot);process.stdout.write(JSON.stringify({imported:true,environment:process.env.CLANK_ENTRY_TEST,mask:process.umask(),descriptor:{writable:d.writable,enumerable:d.enumerable,configurable:d.configurable},bootstrap:JSON.parse(d.value).protocol})+'\\n');`);
 await writeFile(join(root,'throw.mjs'),`throw Error('owned-test-grant owned-test-control owned-test-recovery');`);
 await writeFile(join(root,'preload.mjs'),`Object.defineProperty(globalThis,Symbol.for('clank.provider.source.startup.v1'),{get(){throw Error('must not evaluate accessor');},configurable:true});`);
 await symlink('app.mjs',join(root,'link.mjs'));
 async function run(name,{entry='app.mjs',cwd='/app',input=body,preload=false,extra=[],late=false,success=false}={}){
  const args=['--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind','/tmp','/tmp','--proc','/proc','--dev','/dev','--ro-bind',root,'/app','--unshare-user','--unshare-pid','--die-with-parent','--chdir',cwd,process.execPath];
  if(preload)args.push('--import','/app/preload.mjs');
  args.push('/app/entry.mjs',entry,...extra);
  const child=spawn('/usr/bin/bwrap',args,{stdio:['pipe','pipe','pipe']});let out='',err='';
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.stdin.on('error',()=>{});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),5000);
  try{
   if(late){child.stdin.write(body);await new Promise(resolve=>setTimeout(resolve,100));assert.equal(out,'','App imported before EOF');child.stdin.end('{}\n');}
   else child.stdin.end(input);
   const result=await closed;assert.equal(result.signal,null);
   if(success){assert.equal(result.code,0,err);assert.equal(err,'');assert.deepEqual(JSON.parse(out),{imported:true,environment:'雪\nstdin',mask:63,descriptor:{writable:false,enumerable:false,configurable:true},bootstrap:'clank-provider-source-bootstrap/2'});}
   else{assert.equal(result.code,1);assert.equal(err,failure);assert.equal(out,'');}
   records.push({name,...result,applicationReturned:success});
  }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}}
 }
 await run('canonical stdin bootstrap',{success:true});
 await run('wrong working directory',{cwd:'/tmp'});
 await run('absolute entry',{entry:'/app/app.mjs'});
 await run('parent traversal',{entry:'../app/app.mjs'});
 await run('symlink entry',{entry:'link.mjs'});
 await run('missing entry',{entry:'missing.mjs'});
 await run('loader self entry',{entry:'entry.mjs'});
 await run('extra argv',{extra:['unexpected']});
 await run('preexisting accessor',{preload:true});
 await run('incomplete stdin',{input:body.trimEnd()});
 await run('extra frame in later write',{late:true});
 await run('invalid UTF-8',{input:Buffer.from([0xc3,0x28,10])});
 await run('unknown bootstrap root',{input:JSON.stringify({environment:{},bootstrap,extra:'owned-test-control'})+'\n'});
 await run('application throws secret-bearing error',{entry:'throw.mjs'});
 console.log(JSON.stringify({version:process.version,passed:true,cases:records,qualification:'Real native loader stdin/path/descriptor/error checks only. The syntactic fake bootstrap grants no authority or readiness.'}));
}finally{await rm(root,{recursive:true,force:true});}
