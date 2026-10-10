import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDeploymentBundle,deploymentDigest,parseDeploymentConfig} from '../dist/deploy.js';
import {reservePlatformTestPorts} from './fixtures/platform-test-ports.mjs';
import {openPlatform} from '../dist/platform.js';

const origin='http://127.0.0.1:42431',sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'clank-supervisor-runtime-')),ports=await reservePlatformTestPorts(),children=[];
  const dataDirectory=join(root,'platform'),options={signup:'bootstrap',appPortStart:ports.start,appPortEnd:ports.start+3,
    ingress:{baseDomain:'apps.example.test',domainRecheckIntervalMs:false},previews:{cleanupIntervalMs:false},
    backups:{intervalMs:60_000,batchSize:1,maxBackups:2},supervisor:{configurationRevision:1}};
  t.after(async()=>{
    for(const entry of children)if(entry.child.exitCode===null&&entry.child.signalCode===null){entry.child.send({kind:'stop'});let timer;
      await Promise.race([entry.exited,new Promise(resolve=>{timer=setTimeout(()=>{entry.child.kill('SIGKILL');resolve();},10000);})]).finally(()=>clearTimeout(timer));await entry.exited;}
    const until=Date.now()+10000;
    while((await readdir(join(dataDirectory,'runtime-guardians')).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).length){assert.ok(Date.now()<until,'Owned tenant cleanup must finish before removing evidence.');await sleep(25);}
    assert.deepEqual(await readdir(join(dataDirectory,'supervisor-guardians')).catch(error=>{if(error.code==='ENOENT')return [];throw error;}),[]);
    await rm(root,{recursive:true,force:true});await ports.release();
  });
  const start=async(overrides={},onSpawn,mutate=false,pauseRelease=false)=>{
    const child=fork(new URL('./fixtures/supervisor-platform-worker.mjs',import.meta.url),[],{env:{...process.env,CLANK_SUPERVISOR_FIXTURE_ROOT:dataDirectory,
      CLANK_SUPERVISOR_FIXTURE_OPTIONS:JSON.stringify({...options,...overrides,supervisor:{...options.supervisor,...overrides.supervisor}}),CLANK_SUPERVISOR_MUTATE_OPTIONS:mutate?'1':'0',CLANK_SUPERVISOR_PAUSE_RELEASE_RESPONSE:pauseRelease?'1':'0'},stdio:['ignore','pipe','pipe','ipc']});
    let output='',sequence=0;const pending=new Map(),exited=new Promise(resolve=>child.once('exit',(code,signal)=>{
      for(const entry of pending.values())entry.reject(new Error('Owned coordinator exited: '+output));pending.clear();resolve({code,signal});}));
    children.push({child,exited});onSpawn?.(child);for(const stream of [child.stdout,child.stderr])stream.on('data',value=>output=(output+value).slice(-8192));
    const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned coordinator not ready: '+output)),45000);
      child.once('message',message=>{clearTimeout(timer);resolve(message);});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Owned coordinator exited before ready: '+output));});});
    assert.equal(ready.kind,'ready');
    child.on('message',message=>{if(message.kind==='release-published')return;const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);if(message.kind==='error')entry.reject(new Error(message.error));else entry.resolve(message);});
    const rpc=message=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});child.send({...message,id},error=>{if(error){pending.delete(id);reject(error);}});});
    return {child,exited,ready,async status(){return rpc({kind:'status'});},async handle(request){
      const result=await rpc({kind:'request',url:request.url,method:request.method,headers:[...request.headers],body:request.body?Buffer.from(await request.arrayBuffer()).toString('base64'):null});
      return new Response(Buffer.from(result.body,'base64'),{status:result.status,headers:result.headers});
    },async stop(){child.send({kind:'stop'});assert.deepEqual(await exited,{code:0,signal:null});}};
  };
  const artifact=async()=>{
    const source=join(root,'release');await mkdir(join(source,'dist'),{recursive:true});await mkdir(join(source,'migrations'));
    await writeFile(join(source,'migrations/0001_ledger.sql'),"CREATE TABLE writer_events(id INTEGER PRIMARY KEY,pid INTEGER,at INTEGER);CREATE TABLE tenant_data(value TEXT NOT NULL);INSERT INTO tenant_data VALUES('retained tenant data');");
    await writeFile(join(source,'dist/server.mjs'),`import{createServer}from'node:http';import{DatabaseSync}from'node:sqlite';import{existsSync,writeFileSync}from'node:fs';const db=new DatabaseSync(process.env.CLANK_DATABASE_PATH);db.exec('PRAGMA busy_timeout=5000');createServer(async(q,s)=>{if(q.url==='/healthz'&&existsSync(${JSON.stringify(join(root,'health-hold'))})){writeFileSync(${JSON.stringify(join(root,'health-entered'))},String(process.pid));while(existsSync(${JSON.stringify(join(root,'health-hold'))}))await new Promise(resolve=>setTimeout(resolve,10));}s.end(q.url==='/healthz'?'ok':JSON.stringify({pid:process.pid,value:db.prepare('SELECT value FROM tenant_data').get().value}));}).listen(Number(process.env.PORT),process.env.HOST);`);
    await writeFile(join(source,'dist/worker.mjs'),"import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(process.env.CLANK_DATABASE_PATH);db.exec('PRAGMA busy_timeout=5000');const add=db.prepare('INSERT INTO writer_events(pid,at)VALUES(?,?)'),write=()=>add.run(process.pid,Date.now());write();setInterval(write,20);");
    return createDeploymentBundle(source,parseDeploymentConfig({version:1,entry:'dist/server.mjs',include:['dist','migrations'],
      database:{path:'app.sqlite',migrations:'migrations'},health:{path:'/healthz',timeoutMs:10000},env:{},
      jobs:{entry:'dist/worker.mjs',workers:1,scheduler:false,concurrency:1,queues:[]}}));
  };
  return {root,dataDirectory,start,artifact,children};
}
function request(path,body,session){return new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{origin,
  ...(body===undefined?{}:{'content-type':'application/json'}),...(session?{cookie:session.cookie,'x-clank-csrf':session.csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function json(controller,path,body,session,expected=200){const response=await controller.handle(request(path,body,session)),data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;}

for(const interruption of ['SIGKILL','SIGSTOP'])test(`existing standby restores the deployed tenant, one job writer and a due durable backup after actual ${interruption}`,{timeout:90000},async t=>{
  const f=await fixture(t),first=await f.start(),second=await f.start();assert.equal(first.ready.status.state,'leader');assert.equal(second.ready.status.state,'standby');
  const signup=await first.handle(request('/__clank/auth/register',{email:'supervisor-owner@example.test',password:'correct horse battery staple'}));assert.equal(signup.status,201);
  const account=await signup.json(),session={cookie:signup.headers.get('set-cookie').split(';')[0],csrf:account.csrfToken};
  const {project}=await json(first,'/api/projects',{name:'Supervisor fixture',slug:'supervisor-fixture'},session,201),bytes=await f.artifact();
  const uploaded=await first.handle(new Request(origin+`/api/projects/${project.id}/releases`,{method:'POST',headers:{origin,cookie:session.cookie,'x-clank-csrf':session.csrf,
    'content-type':'application/vnd.clank.deploy+gzip','x-clank-content-sha256':await deploymentDigest(bytes),'x-clank-idempotency-key':'supervisor-actual-release-0001'},body:bytes}));
  const deployment=await uploaded.json();assert.equal(uploaded.status,201,JSON.stringify(deployment));
  const observer=new DatabaseSync(join(f.dataDirectory,'projects',project.id,'data/app.sqlite'));observer.exec('PRAGMA busy_timeout=5000');t.after(()=>observer.close());
  const control=new DatabaseSync(join(f.dataDirectory,'control.sqlite'));control.exec('PRAGMA busy_timeout=5000');t.after(()=>control.close());
  const writers=observer.prepare('SELECT DISTINCT pid FROM writer_events'),count=observer.prepare('SELECT count(*) AS count FROM writer_events WHERE pid=?');
  let until=Date.now()+10000;while(!writers.all().length){assert.ok(Date.now()<until);await sleep(25);}const old=writers.all().map(row=>row.pid);assert.equal(old.length,1);
  const probe=controller=>controller.handle(new Request('https://supervisor-fixture.apps.example.test/'));
  const before=await (await probe(first)).json();assert.equal(before.value,'retained tenant data');assert.deepEqual((await json(first,`/api/projects/${project.id}/backups`,undefined,session)).backups,[]);
  // Make the persisted schedule genuinely due before replacement startup; this
  // is a database timing fault injection, not a mocked backup or clock.
  assert.equal(Number(control.prepare('UPDATE clank_platform_backup_schedules SET next_backup_at=? WHERE project_id=?').run(Date.now(),project.id).changes),1);
  first.child.kill(interruption);let timer;const killed=await Promise.race([first.exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Old coordinator was not fenced')),12000);})]).finally(()=>clearTimeout(timer));assert.equal(killed.signal,'SIGKILL');
  const priorFences=new Set(await readdir(join(f.dataDirectory,'runtime-guardians'))),cleanupUntil=Date.now()+10000;
  while((await readdir(join(f.dataDirectory,'runtime-guardians'))).some(name=>priorFences.has(name))){assert.ok(Date.now()<cleanupUntil,'Old runtime guardians must complete cleanup.');await sleep(25);}
  const oldCount=count.get(old[0]).count;until=Date.now()+60000;let status;
  do{assert.equal(count.get(old[0]).count,oldCount,'Old job writers cannot overlap replacement admission.');status=(await fetch(second.ready.url+'/')).status;if(status===200)break;assert.equal(status,503);assert.ok(Date.now()<until,'Existing standby must become authoritative.');await sleep(25);}while(true);
  const current=await second.status();assert.equal(current.status.state,'leader');assert.equal(current.status.epoch,2);assert.deepEqual(current.errors,[]);
  const afterResponse=await probe(second);assert.equal(afterResponse.status,200);const after=await afterResponse.json();assert.equal(after.value,before.value);assert.notEqual(after.pid,before.pid);
  until=Date.now()+10000;while(writers.all().length!==2){assert.ok(Date.now()<until,'A single replacement job worker must resume.');await sleep(25);}assert.equal(count.get(old[0]).count,oldCount);
  let backups;do{backups=await json(second,`/api/projects/${project.id}/backups`,undefined,session);if(backups.backups.length)break;assert.ok(Date.now()<until,'A due durable backup must run under the new owner.');await sleep(25);}while(true);
  assert.equal(backups.backups.length,1);assert.equal(backups.backups[0].reason,'automatic scheduled backup');assert.equal(backups.automation.lastBackupId,backups.backups[0].id);assert.equal(backups.automation.lastError,null);
  const encrypted=await readFile(join(f.dataDirectory,'projects',project.id,'recovery',backups.backups[0].id,'database.enc'));assert.equal(encrypted.includes(Buffer.from('retained tenant data')),false);
  await sleep(150);assert.equal(writers.all().length,2);assert.equal(count.get(old[0]).count,oldCount);assert.equal((await json(second,`/api/projects/${project.id}/backups`,undefined,session)).backups.length,1);
  assert.equal((await json(second,`/api/projects/${project.id}`,undefined,session)).project.activeReleaseId,deployment.release.id);
  await second.stop();assert.deepEqual(await readdir(join(f.dataDirectory,'runtime-guardians')),[]);
});

test('a higher configured revision fences the actual active coordinator before takeover and a superseded standby can close safely',{timeout:30000},async t=>{
  const f=await fixture(t),first=await f.start(),standby=await f.start();assert.equal(standby.ready.status.state,'standby');
  const replacement=await f.start({supervisor:{configurationRevision:2}});
  assert.equal((await first.exited).signal,'SIGKILL');assert.equal(replacement.ready.status.state,'leader');assert.equal(replacement.ready.status.epoch,2);
  const observer=new DatabaseSync(join(f.dataDirectory,'control.sqlite'),{readOnly:true});
  try{assert.equal(observer.prepare('SELECT configuration_revision FROM clank_platform_supervisor_state').get().configuration_revision,2);}finally{observer.close();}
  const unavailable=await standby.handle(request('/'));assert.equal(unavailable.status,503);assert.ok(unavailable.headers.get('retry-after'));
  await standby.stop();assert.equal((await replacement.handle(request('/'))).status,200);await replacement.stop();
});

test('actual leader death during application health recovery cannot publish or launch its job writer before standby recovery',{timeout:90000},async t=>{
  const f=await fixture(t),seed=await f.start(),signup=await seed.handle(request('/__clank/auth/register',{email:'starting-owner@example.test',password:'correct horse battery staple'}));assert.equal(signup.status,201);
  const account=await signup.json(),session={cookie:signup.headers.get('set-cookie').split(';')[0],csrf:account.csrfToken},
    {project}=await json(seed,'/api/projects',{name:'Starting fixture',slug:'starting-fixture'},session,201),bytes=await f.artifact();
  const response=await seed.handle(new Request(origin+`/api/projects/${project.id}/releases`,{method:'POST',headers:{origin,cookie:session.cookie,'x-clank-csrf':session.csrf,
    'content-type':'application/vnd.clank.deploy+gzip','x-clank-content-sha256':await deploymentDigest(bytes),'x-clank-idempotency-key':'supervisor-starting-release-0001'},body:bytes}));assert.equal(response.status,201,await response.text());
  await seed.stop();
  const observer=new DatabaseSync(join(f.dataDirectory,'projects',project.id,'data/app.sqlite'));observer.exec('PRAGMA busy_timeout=5000');t.after(()=>observer.close());
  const writers=observer.prepare('SELECT DISTINCT pid FROM writer_events');assert.equal(writers.all().length,1);
  const hold=join(f.root,'health-hold'),entered=join(f.root,'health-entered');await writeFile(hold,'hold');let interrupted;
  const starting=f.start({},child=>{interrupted=child;});const rejected=assert.rejects(starting,/exited before ready/);let until=Date.now()+10000;
  while(true){try{await readFile(entered);break;}catch(error){if(error.code!=='ENOENT')throw error;}assert.ok(Date.now()<until,'Actual recovering application must enter its health request.');await sleep(25);}
  const standby=await f.start();assert.equal(standby.ready.status.state,'standby');assert.equal(writers.all().length,1,'Jobs cannot launch before candidate health succeeds.');
  interrupted.kill('SIGKILL');await rejected;await rm(hold);until=Date.now()+60000;
  while((await fetch(standby.ready.url+'/')).status!==200){assert.ok(Date.now()<until,'Existing standby must finish interrupted startup recovery.');await sleep(25);}
  const state=await standby.status();assert.equal(state.status.state,'leader');assert.equal(state.status.epoch,3);assert.deepEqual(state.errors,[]);
  const probe=await standby.handle(new Request('https://starting-fixture.apps.example.test/'));assert.equal(probe.status,200);assert.equal((await probe.json()).value,'retained tenant data');
  until=Date.now()+10000;while(writers.all().length!==2){assert.ok(Date.now()<until);await sleep(25);}await sleep(150);assert.equal(writers.all().length,2,'Interrupted recovery must never have started a third job writer.');
  await standby.stop();
});

test('caller input changes after open cannot disable leadership or change the delayed standby trust and timing configuration',{timeout:20000},async t=>{
  const f=await fixture(t),first=await f.start(),standby=await f.start({},undefined,true);assert.equal(standby.ready.status.state,'standby');
  await first.stop();let until=Date.now()+10000;
  while((await fetch(standby.ready.url+'/')).status!==200){assert.ok(Date.now()<until);await sleep(25);}
  const state=await standby.status();assert.equal(state.status.state,'leader');assert.equal(state.status.epoch,2);assert.deepEqual(state.errors,[]);
  const response=await standby.handle(request('/__clank/auth/register',{email:'captured-owner@example.test',password:'correct horse battery staple'}));assert.equal(response.status,201);
  await standby.stop();
});

test('ordinary mode refuses an enabled catalog before touching live tenant cleanup or supervisor authority',{timeout:20000},async t=>{
  const f=await fixture(t),first=await f.start();
  const fences=await readdir(join(f.dataDirectory,'supervisor-guardians'));
  await assert.rejects(openPlatform({dataDirectory:f.dataDirectory,publicUrl:origin,hostingProfile:'trusted',sqliteIsolation:'trusted-process',signup:false}),error=>error.code==='SUPERVISOR_MODE_REQUIRED');
  assert.deepEqual(await readdir(join(f.dataDirectory,'supervisor-guardians')),fences);assert.equal((await first.handle(request('/'))).status,200);assert.equal((await first.status()).status.epoch,1);
  await first.stop();
});

test('unresolved tenant cleanup kills the new dedicated coordinator before active service bootstrap and preserves its failure evidence',{timeout:20000},async t=>{
  const f=await fixture(t),directory=join(f.dataDirectory,'runtime-guardians'),file=join(directory,'runtime-unresolved.json');
  await mkdir(directory,{recursive:true});await writeFile(file,'{}');
  try{
    await assert.rejects(f.start(),/exited before ready/);assert.equal((await f.children.at(-1).exited).signal,'SIGKILL');assert.equal(await readFile(file,'utf8'),'{}');
    const observer=new DatabaseSync(join(f.dataDirectory,'control.sqlite'),{readOnly:true});
    try{assert.equal(observer.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_platform_projects'").get(),undefined);}finally{observer.close();}
    await assert.rejects(readFile(join(f.dataDirectory,'master.key')),{code:'ENOENT'});
    let until=Date.now()+10000;while((await readdir(join(f.dataDirectory,'supervisor-guardians'))).length){assert.ok(Date.now()<until);await sleep(25);}
  }finally{await rm(file);} // Remove only this owned injected test record.
});

test('SIGKILL after durable release publication before response is recovered once by the existing standby and exact retry',{timeout:60000},async t=>{
  const f=await fixture(t),first=await f.start({},undefined,false,true),standby=await f.start();
  const signup=await first.handle(request('/__clank/auth/register',{email:'published-owner@example.test',password:'correct horse battery staple'}));assert.equal(signup.status,201);
  const account=await signup.json(),session={cookie:signup.headers.get('set-cookie').split(';')[0],csrf:account.csrfToken},{project}=await json(first,'/api/projects',{name:'Published fixture',slug:'published-fixture'},session,201),bytes=await f.artifact();
  const input=()=>new Request(origin+`/api/projects/${project.id}/releases`,{method:'POST',headers:{origin,cookie:session.cookie,'x-clank-csrf':session.csrf,'content-type':'application/vnd.clank.deploy+gzip',
    'x-clank-content-sha256':digest,'x-clank-idempotency-key':'supervisor-published-exact-0001'},body:bytes}),digest=await deploymentDigest(bytes);
  const published=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Actual durable release never reached response barrier')),15000);const receive=message=>{if(message.kind!=='release-published')return;first.child.off('message',receive);clearTimeout(timer);resolve();};first.child.on('message',receive);});
  const pending=first.handle(input()),rejected=assert.rejects(pending,/Owned coordinator exited/);await published;
  const observer=new DatabaseSync(join(f.dataDirectory,'control.sqlite'),{readOnly:true});observer.exec('PRAGMA busy_timeout=5000');t.after(()=>observer.close());
  const prior=observer.prepare('SELECT active_release_id FROM clank_platform_projects WHERE id=?').get(project.id).active_release_id;assert.ok(prior);
  first.child.kill('SIGKILL');await rejected;assert.equal((await first.exited).signal,'SIGKILL');let until=Date.now()+45000;
  while((await fetch(standby.ready.url+'/')).status!==200){assert.ok(Date.now()<until);await sleep(25);}
  const retry=await standby.handle(input()),result=await retry.json();assert.ok(retry.ok,JSON.stringify(result));assert.equal(result.release.id,prior);
  assert.equal(observer.prepare('SELECT count(*) AS count FROM clank_platform_releases WHERE project_id=?').get(project.id).count,1);
  const probe=await standby.handle(new Request('https://published-fixture.apps.example.test/'));assert.equal(probe.status,200);assert.equal((await probe.json()).value,'retained tenant data');await standby.stop();
});
