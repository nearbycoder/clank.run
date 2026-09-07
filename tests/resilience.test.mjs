import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {rehearseResilience} from '../dist/resilience.js';
async function fixture(){const root=await mkdtemp(join(tmpdir(),'clank-resilience-')),databasePath=join(root,'app.sqlite');const db=new DatabaseSync(databasePath);db.exec('CREATE TABLE items(id TEXT PRIMARY KEY); CREATE TABLE pending(id TEXT PRIMARY KEY);');db.close();return{root,databasePath};}
const workerScript=`import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=1000');setInterval(()=>{db.exec('BEGIN IMMEDIATE');try{db.exec('INSERT OR IGNORE INTO items SELECT id FROM pending; DELETE FROM pending; COMMIT');}catch{db.exec('ROLLBACK');}},10);console.log('ready');`;
async function boot({databasePath,signal,fetchDependency}){
 const db=new DatabaseSync(databasePath);db.exec('PRAGMA busy_timeout=1000');let worker;
 const start=async()=>{worker=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','-e',workerScript,databasePath],{stdio:['ignore','pipe','ignore']});await once(worker.stdout,'data');};
 const stop=async()=>{if(worker&&worker.exitCode===null){const exited=once(worker,'exit');worker.kill('SIGKILL');await exited;}};
 await start();
 return{async handle(request){if(new URL(request.url).pathname==='/state')return Response.json({count:Number(db.prepare('SELECT count(*) AS count FROM items').get().count)});try{const body=await request.json();const dependency=await fetchDependency('https://partner.example.invalid/');if(!dependency.ok)return new Response('dependency unavailable',{status:503});db.prepare('INSERT OR IGNORE INTO pending(id) VALUES(?)').run(body.id);return Response.json({queued:true});}catch{return new Response('invalid input',{status:400})}},crashWorker:stop,restartWorker:start,async close(){await stop();db.close();}};
}
const operation={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'synthetic-event'})};
async function verify(context){if(context.phase==='baseline'){assert.equal((await(await context.request('/state')).json()).count,0);return;}assert.equal((await context.request('/enqueue',operation)).status,200);for(let i=0;i<100;i++){if((await(await context.request('/state')).json()).count===1)return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Worker did not recover');}
test('all five faults run against disposable copies and recover real durable work after a worker process is killed',async()=>{
 const fixtureApp=await fixture(),original=await readFile(fixtureApp.databasePath);
 try{const scenarios=['offline','lost-response','dependency-unavailable','worker-restart','interrupted-upload'].map(fault=>({name:fault,fault,verify,async exercise(context){if(fault==='offline'||fault==='lost-response')await assert.rejects(context.request('/enqueue',operation));else{const response=await context.request('/enqueue',operation);assert.equal(response.status,fault==='dependency-unavailable'?503:fault==='interrupted-upload'?400:200);if(fault==='worker-restart')assert.equal((await(await context.request('/state')).json()).count,0);}}}));
 const result=await rehearseResilience({source:{databasePath:fixtureApp.databasePath},boot,dependencies:{'https://partner.example.invalid':()=>new Response('fixture')},scenarios});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.scenarios.length,5);assert.ok(result.scenarios.every(s=>s.injected>0&&s.requests>=3));assert.deepEqual(await readFile(fixtureApp.databasePath),original);
 }finally{await rm(fixtureApp.root,{recursive:true,force:true})}
});
test('missing fault evidence and escaped paths fail instead of reporting an unexercised recovery',async()=>{
 const app=await fixture();
 try{const options={source:{databasePath:app.databasePath},boot:async()=>({handle:()=>new Response('ok'),close(){}})};
 const result=await rehearseResilience({...options,scenarios:[{name:'No dependency call',fault:'dependency-unavailable',verify:async ctx=>{await ctx.request('/healthz')},exercise:async ctx=>{await ctx.request('/healthz')}},{name:'Escaped path',fault:'offline',verify:async ctx=>{await ctx.request('//outside.test')},exercise:async()=>{}}]});assert.equal(result.ok,false);assert.deepEqual(result.scenarios.map(s=>s.phase),['fault','baseline']);
 await assert.rejects(rehearseResilience({...options,dependencies:{'https://real.example':()=>new Response()},scenarios:[]}),/Declare/);
 }finally{await rm(app.root,{recursive:true,force:true})}
});

test('an unresponsive exercise is bounded by the rehearsal deadline and still closes its app',async()=>{
 const app=await fixture();let closed=0;
 try{const result=await rehearseResilience({source:{databasePath:app.databasePath},timeoutMs:1000,boot:async()=>({handle:()=>new Response('ok'),close(){closed++}}),scenarios:[{name:'Hung exercise',fault:'offline',verify:async ctx=>{await ctx.request('/healthz')},exercise:async()=>new Promise(()=>{})}]});assert.equal(result.ok,false);assert.equal(result.scenarios[0].phase,'fault');assert.equal(closed,1);
 }finally{await rm(app.root,{recursive:true,force:true})}
});

 test('a timed out worker restart is not retried after cancellation',async()=>{
 const app=await fixture();let closed=0,restarts=0;
 try{const result=await rehearseResilience({source:{databasePath:app.databasePath},timeoutMs:1000,boot:async()=>({handle:()=>new Response('ok'),crashWorker:async()=>{},restartWorker:async()=>{restarts++;return new Promise(()=>{})},close(){closed++}}),scenarios:[{name:'Hung worker restart',fault:'worker-restart',verify:async ctx=>{await ctx.request('/healthz')},exercise:async ctx=>{await ctx.request('/healthz')}}]});assert.equal(result.ok,false);assert.equal(result.scenarios[0].phase,'recovery');assert.equal(closed,1);assert.equal(restarts,1);
 }finally{await rm(app.root,{recursive:true,force:true})}
 });
