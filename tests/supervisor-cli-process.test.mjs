import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {reservePlatformTestPorts} from './fixtures/platform-test-ports.mjs';

test('actual packaged platform CLI environment starts leader/standby HTTP listeners and automatically takes over after SIGSTOP',{timeout:25000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'clank-supervisor-cli-')),ports=await reservePlatformTestPorts(),children=[];
  t.after(async()=>{
    for(const entry of children)if(entry.child.exitCode===null&&entry.child.signalCode===null){entry.child.kill('SIGTERM');await entry.exited;}
    assert.deepEqual(await readdir(join(root,'supervisor-guardians')),[]);await rm(root,{recursive:true,force:true});await ports.release();
  });
  const start=async port=>{
    const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','scripts/clank-platform.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),
      CLANK_PLATFORM_URL:'http://127.0.0.1:'+ports.start,CLANK_PLATFORM_DATA:root,CLANK_SIGNUP:'disabled',CLANK_HOSTING_PROFILE:'trusted',CLANK_RUNNER:'process',CLANK_SQLITE_ISOLATION:'trusted-process',
      CLANK_SUPERVISOR_ID:'actual-cli-cluster',CLANK_SUPERVISOR_REVISION:'1',CLANK_SUPERVISOR_LEASE_MS:'5000',CLANK_SUPERVISOR_POLL_MS:'50',
      CLANK_APP_PORT_START:String(ports.start+2),CLANK_APP_PORT_END:String(ports.end),CLANK_BACKUP_INTERVAL_MS:'0',CLANK_PREVIEW_CLEANUP_INTERVAL_MS:'0'},stdio:['ignore','pipe','pipe']});
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));children.push({child,exited});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',value=>output=(output+value).slice(-16384));
    const until=Date.now()+10000;while(!output.includes('Automatic supervisor:')){assert.equal(child.exitCode,null,output);assert.ok(Date.now()<until,output);await new Promise(resolve=>setTimeout(resolve,25));}
    return {child,exited,url:'http://127.0.0.1:'+port,output};
  };
  const first=await start(ports.start),standby=await start(ports.start+1);assert.match(first.output,/Automatic supervisor: leader/);assert.match(standby.output,/Automatic supervisor: standby/);
  assert.equal((await fetch(first.url)).status,200);const unavailable=await fetch(standby.url);assert.equal(unavailable.status,503);assert.ok(unavailable.headers.get('retry-after'));
  first.child.kill('SIGSTOP');let until=Date.now()+12000;
  while(first.child.signalCode===null){assert.ok(Date.now()<until,'Owned stopped CLI must be fenced by its guardian.');await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal((await first.exited).signal,'SIGKILL');
  while((await fetch(standby.url)).status!==200){assert.ok(Date.now()<until,'The existing CLI standby must recover.');await new Promise(resolve=>setTimeout(resolve,25));}
  standby.child.kill('SIGTERM');assert.deepEqual(await standby.exited,{code:0,signal:null});
});
