import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { defineDatabase, defineJobs, defineTable, defineWorkflow, defineWorkflows, openJobs, openSQLite, s } from '../dist/index.js';
import { compensationProcessSchema, compensationProcessDefinition } from './fixtures/workflow-compensation-process.mjs';
import { legacyCompensationCompatibility } from './fixtures/workflow-compensation-legacy.mjs';
import * as framework from '../dist/index.js';

const internal = Symbol.for('clank.sqlite.internal');
const waitPolicy = { signingKey: 'compensation-test-signing-key-00001', policyRevision: 1 };

test('ordinary graph retains the exact pre-compensation persisted revision and needs no recovery tables',async()=>{
  const {schema,workflow,definition}=legacyCompensationCompatibility(framework);
  const database=await openSQLite(schema,{path:':memory:'}),runtime=openJobs(definition,{database});
  try{
    const handle=runtime.startWorkflow(workflow,{value:'legacy'});
    // Recorded from the accepted durable-wait binary using the shared fixture source.
    assert.equal(database[internal].prepare('SELECT definition_hash FROM clank_workflow_runs WHERE id=?').get(handle.id).definition_hash,'d2c2d017ac196bbb');
    assert.equal(database[internal].prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE 'clank_workflow_compensation%'").get().count,0);
    while(await runtime.workOnce());
    assert.equal(runtime.getWorkflow(handle.id).state,'succeeded');assert.equal(runtime.getWorkflow(handle.id).compensation,undefined);
  }finally{runtime.close();database.close();}
});
function declaration(schema, options = {}) {
  const jobs = defineJobs({schema}).jobs(({job})=>({
    forward:job({args:{step:s.string(),index:s.number(),failAt:s.number()},returns:s.number(),retry:{maxAttempts:1},
      handler:options.forwardHandler ?? (async(context,{step,index,failAt})=>{
        const {db}=context;
        if(index===0&&options.hold)await options.hold(context);
        db.transaction(tx=>tx.table('events').insert({value:`forward:${step}`,ordinal:tx.table('events').collect().length}));
        if (index===failAt) throw new Error(`Injected failure at ${step}`);
        return index;
      })}),
    undo:job({args:{step:s.string(),state:s.string(),original:s.string(),key:s.string()},returns:s.string(),
      retry:{maxAttempts:1},agent:{idempotent:true},handler:({db},{step,state})=>{
        if (step===options.undoFailure) throw new Error('Injected compensation failure');
        return db.transaction(tx=>{tx.table('events').insert({value:`undo:${step}:${state}`,ordinal:tx.table('events').collect().length});return step;});
      }}),
  }));
  const workflow=defineWorkflow({args:{failAt:s.number()},graph:graph=>{
    const step=(name,index,needs)=>graph.step(jobs.jobs.forward,{needs,
      args:({input})=>({step:name,index,failAt:input.failAt}),
      compensate:index===options.manualAt ? {manual:`Inspect irreversible step ${name}`} : {job:jobs.jobs.undo,
        args:context=>options.mapper ? options.mapper(context) : ({step:context.step,state:context.outcome.state,original:context.forwardJobId,key:context.operationKey})},
    });
    const a=step('a',0,[]);
    const gate=options.wait ? graph.wait({mode:'event',needs:[a],timeoutMs:1000,returns:s.boolean(),request:()=>({title:'Continue?'})}) : null;
    const b=step('b',1,[gate??a]),c=step('c',2,[b]);
    return gate ? {a,gate,b,c} : {a,b,c};
  },...(options.outputFailure ? {output:()=>{throw new Error('Injected output failure');}} : {})});
  return {definition:defineWorkflows(jobs,{flow:workflow}),workflow};
}
async function fixture(options={}) {
  const root=await mkdtemp(join(tmpdir(),'clank-compensation-'));
  const schema=defineDatabase({events:defineTable({value:s.string(),ordinal:s.number()}).owned()});
  const database=await openSQLite(schema,{path:join(root,'app.sqlite'),changePollIntervalMs:0});
  const {definition,workflow}=declaration(schema,options);
  let clock=10000,runtime=openJobs(definition,{database,now:()=>clock,...(options.wait?{workflowWaits:waitPolicy}:{})});
  return {root,schema,database,definition,workflow,get runtime(){return runtime;},
    advanceTime(){clock+=10000;},
    reopen(){runtime.close();runtime=openJobs(definition,{database,now:()=>clock,...(options.wait?{workflowWaits:waitPolicy}:{})});},
    values(owner){return database.read(db=>db.table('events').collect().sort((a,b)=>a.ordinal-b.ordinal).map(row=>row.value),owner?{userId:owner}:undefined);},
    async drain(){for(let n=0;n<20;n++)if(!await runtime.workOnce())return;assert.fail('Recovery did not settle in its bounded test steps');},
    async close(){runtime.close();database.close();await rm(root,{recursive:true,force:true});},
  };
}

test('each injected forward failure compensates attempted effects in reverse dependency order once',async()=>{
  for(const failed of [0,1,2]) {
    const f=await fixture();try{
      const handle=f.runtime.publisher({userId:'owner-a'}).startWorkflow(f.workflow,{failAt:failed},{idempotencyKey:'forward-run-00001'});
      await f.drain();const run=f.runtime.getWorkflow(handle.id);
      assert.equal(run.state,'failed');assert.match(run.error,/Injected failure/);
      assert.equal(run.compensation.state,'succeeded');
      const forward=['a','b','c'].slice(0,failed+1),reverse=[...forward].reverse();
      assert.deepEqual(f.values('owner-a'),[...forward.map(name=>`forward:${name}`),...reverse.map((name,index)=>`undo:${name}:${index===0?'failed':'succeeded'}`)]);
      assert.deepEqual(f.values('owner-b'),[]);
      assert.deepEqual(run.compensation.steps.map(row=>row.step),['c','b','a']);
      for(const row of run.compensation.steps) {
        assert.equal(row.state,forward.includes(row.step)?'succeeded':'skipped');
        if(row.jobId){const job=f.runtime.get(row.jobId);assert.equal(job.ownerId,'owner-a');assert.equal(job.args.key,row.operationKey);assert.equal(job.args.original,row.forwardJobId);}
      }
      const before=f.values('owner-a');f.reopen();await f.drain();assert.deepEqual(f.values('owner-a'),before);
      assert.deepEqual(f.runtime.publisher({userId:'owner-a'}).startWorkflow(f.workflow,{failAt:failed},{idempotencyKey:'forward-run-00001'}),{id:handle.id,deduplicated:true});
    }finally{await f.close();}
  }
});

test('successful workflows retain dormant declarations as not-needed without scheduling cleanup',async()=>{
  const f=await fixture();try{
    const handle=f.runtime.publisher({userId:'owner-a'}).startWorkflow(f.workflow,{failAt:-1});await f.drain();
    const run=f.runtime.getWorkflow(handle.id);assert.equal(run.state,'succeeded');assert.equal(run.compensation.state,'not-needed');
    assert.deepEqual(f.values('owner-a'),['forward:a','forward:b','forward:c']);
    assert.ok(run.compensation.steps.every(row=>row.state==='skipped'&&row.jobId===null));
  }finally{await f.close();}
});

test('manual barriers and exhausted compensation preserve evidence until explicit inactive operator purge',async()=>{
  for(const options of [{manualAt:1},{undoFailure:'b'}]) {
    const f=await fixture(options);try{
      const handle=f.runtime.publisher({userId:'owner-a'}).startWorkflow(f.workflow,{failAt:2});await f.drain();
      const run=f.runtime.getWorkflow(handle.id);assert.equal(run.state,'failed');assert.equal(run.compensation.state,'manual');
      assert.deepEqual(f.values('owner-a'),['forward:a','forward:b','forward:c','undo:c:failed']);
      assert.equal(run.compensation.steps.find(row=>row.step==='a').state,'manual');
      assert.match(run.compensation.steps.find(row=>row.step==='b').error,/irreversible|compensation failure/);
      f.advanceTime();assert.equal(f.runtime.purgeWorkflows({states:['failed']}),0);
      assert.equal(f.runtime.purge({states:['succeeded','dead','cancelled']}),0);
      for(const job of f.runtime.list().filter(row=>['dead','cancelled'].includes(row.state))){
        const retained=f.runtime.get(job.id);assert.equal(f.runtime.retry(job.id),false);assert.deepEqual(f.runtime.get(job.id),retained);
      }
      f.reopen();await f.drain();assert.equal(f.runtime.getWorkflow(handle.id).compensation.state,'manual');
      assert.equal(f.runtime.purgeWorkflows({states:['failed'],includeUnresolvedCompensations:true}),1);
      assert.equal(f.runtime.getWorkflow(handle.id),null);
      assert.equal(f.database[internal].prepare('SELECT count(*) AS count FROM clank_workflow_compensations').get().count,0);
      assert.ok(f.runtime.purge({states:['succeeded','dead','cancelled']})>0);
    }finally{await f.close();}
  }
});

test('cancelled, denied and timed-out waits and output failure recover already attempted predecessors',async()=>{
  for(const trigger of ['cancel','deny','timeout','output']) {
    const f=await fixture(trigger==='output'?{outputFailure:true}:{wait:true});try{
      const handle=f.runtime.publisher({userId:'owner-a'}).startWorkflow(f.workflow,{failAt:-1});
      if(trigger==='output')await f.drain();else{
        await f.runtime.workOnce();assert.equal(f.runtime.getWorkflow(handle.id).state,'waiting');
        const ticket=f.runtime.getWorkflowWait(handle.id,'gate');
        if(trigger==='cancel')f.runtime.cancelWorkflow(handle.id);
        else if(trigger==='timeout'){f.advanceTime();f.runtime.advanceWorkflows();}
        else f.runtime.resumeWorkflowWait({waitId:ticket.id,expectedVersion:ticket.version,resumeToken:ticket.resumeToken,idempotencyKey:'compensation-denial-0001',choice:'deny'});
        await f.drain();
      }
      const run=f.runtime.getWorkflow(handle.id);assert.equal(run.state,trigger==='cancel'?'cancelled':'failed');assert.equal(run.compensation.state,'succeeded');
      assert.deepEqual(f.values('owner-a'),trigger==='output'?['forward:a','forward:b','forward:c','undo:c:succeeded','undo:b:succeeded','undo:a:succeeded']:['forward:a','undo:a:succeeded']);
    }finally{await f.close();}
  }
});

function childFixture(mode,root,origin){
  // Intentionally killed workers must not leave partial V8 coverage artifacts in the parent's report.
  const env={...process.env};delete env.NODE_V8_COVERAGE;delete env.CLANK_COMPENSATION_HOLD;
  const child=fork(new URL('./fixtures/workflow-compensation-process.mjs',import.meta.url),[mode,root,...(origin?[origin]:[])],
    {execArgv:['--disable-warning=ExperimentalWarning'],env,stdio:['ignore','pipe','pipe','ipc']});
  const events=[],waiters=[],pending=new Map();let counter=0,exited=null,output='';
  const capture=chunk=>{output=(output+chunk).slice(-16000);};child.stdout.on('data',capture);child.stderr.on('data',capture);
  child.on('message',message=>{
    if(message.id){const callback=pending.get(message.id);if(callback){pending.delete(message.id);clearTimeout(callback.timer);message.error?callback.reject(new Error(message.error)):callback.resolve(message.result);}return;}
    const index=waiters.findIndex(waiter=>waiter.event===message.event);
    if(index>=0){const waiter=waiters.splice(index,1)[0];clearTimeout(waiter.timer);waiter.resolve(message);}else events.push(message);
  });
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{
    exited={code,signal};resolve(exited);
    for(const callback of pending.values()){clearTimeout(callback.timer);callback.reject(new Error(`Fixture exited before reply: ${signal??code}; ${output}`));}pending.clear();
    for(const waiter of waiters){clearTimeout(waiter.timer);waiter.reject(new Error(`Fixture exited before ${waiter.event}: ${output}`));}waiters.length=0;
  }));
  return {child,exit,
    event(event){const index=events.findIndex(message=>message.event===event);if(index>=0)return Promise.resolve(events.splice(index,1)[0]);
      if(exited)return Promise.reject(new Error(`Fixture already exited: ${output}`));
      return new Promise((resolve,reject)=>{const waiter={event,resolve,reject,timer:null};waiter.timer=setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(new Error(`Fixture event deadline: ${event}; ${output}`));},8000);waiters.push(waiter);});},
    call(command){if(exited)return Promise.reject(new Error('Fixture already exited'));const id=`call-${++counter}`;
      return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Fixture reply deadline: ${command}; ${output}`));},8000);
        pending.set(id,{resolve,reject,timer});child.send({id,command});});},
    async close(){if(!exited){child.kill('SIGTERM');await Promise.race([exit,delay(1000)]);if(!exited){child.kill('SIGKILL');await exit;}}},
  };
}
async function processFixture(){
  const root=await mkdtemp(join(tmpdir(),'clank-compensation-process-'));
  const provider=childFixture('provider',root),{origin}=await provider.event('ready');
  const schema=compensationProcessSchema(),{definition,workflow}=compensationProcessDefinition(schema,origin);
  const database=await openSQLite(schema,{path:join(root,'app.sqlite'),changePollIntervalMs:0});
  const runtime=openJobs(definition,{database}),workers=[];
  return {root,origin,provider,database,runtime,definition,workflow,
    async worker(hold=false){const worker=childFixture(hold?'worker-hold':'worker',root,origin);workers.push(worker);await worker.event('ready');return worker;},
    async snapshot(){const response=await fetch(origin+'/snapshot',{headers:{authorization:'Bearer compensation-fixture-adapter'}});assert.equal(response.status,200);return response.json();},
    async drain(runId,workers){const deadline=Date.now()+7000;while(Date.now()<deadline){
      await Promise.all(workers.map(worker=>worker.call('work')));
      if(runtime.getWorkflow(runId).compensation.state==='succeeded')return;
      await delay(20);
    }assert.fail('Actual process recovery did not complete before its deadline');},
    async close(){for(const worker of workers)await worker.close();runtime.close();database.close();await provider.close();await rm(root,{recursive:true,force:true});},
  };
}

test('actual SIGKILL after provider compensation acceptance replays one stable external operation after lease recovery',async()=>{
  const f=await processFixture();try{
    const run=f.runtime.publisher({userId:'owner-a'}).startWorkflow(f.workflow,{fail:true}),first=await f.worker(true);
    assert.equal(await first.call('work'),true);assert.equal(await first.call('work'),true);
    const queued=f.runtime.getWorkflow(run.id).compensation.steps.find(row=>row.step==='b');assert.equal(queued.state,'queued');
    const interrupted=first.call('work');interrupted.catch(()=>{});
    const accepted=await f.provider.event('provider-accepted');assert.equal(accepted.duplicate,false);assert.equal(accepted.receipt.key,queued.operationKey);
    assert.equal(f.runtime.get(queued.jobId).state,'running');
    const before=await f.snapshot();assert.equal(before.operations.length,1);assert.equal(before.resources.find(row=>row.name==='b').state,'released');
    first.child.kill('SIGKILL');const exited=await first.exit;assert.equal(exited.signal,'SIGKILL');assert.equal(exited.code,null);
    await assert.rejects(interrupted,/exited before reply/);
    const second=await f.worker();await f.drain(run.id,[second]);
    const recovered=f.runtime.getWorkflow(run.id);assert.equal(recovered.state,'failed');assert.equal(recovered.compensation.state,'succeeded');
    const b=recovered.compensation.steps.find(row=>row.step==='b');assert.equal(b.jobId,queued.jobId);assert.equal(f.runtime.get(b.jobId).attempt,2);
    assert.deepEqual(b.result,accepted.receipt);
    const snapshot=await f.snapshot();assert.equal(snapshot.operations.length,2);assert.ok(snapshot.resources.every(row=>row.state==='released'));
    const bRequests=snapshot.requests.filter(row=>row.key===b.operationKey);assert.equal(bRequests.length,2);assert.deepEqual(bRequests.map(row=>row.duplicate),[0,1]);
    assert.equal(snapshot.operations.filter(row=>row.key===b.operationKey).length,1);
    await second.call('work');assert.deepEqual(await f.snapshot(),snapshot);
  }finally{await f.close();}
});

test('two actual controllers racing failure reconciliation create one compensation occurrence per step',async()=>{
  for(let race=0;race<4;race++){
    const f=await processFixture();try{
      const run=f.runtime.publisher({userId:'owner-a'}).startWorkflow(f.workflow,{fail:true});
      const workers=[await f.worker(),await f.worker()];await f.drain(run.id,workers);
      const recovered=f.runtime.getWorkflow(run.id),snapshot=await f.snapshot();
      assert.equal(recovered.compensation.state,'succeeded');assert.equal(snapshot.operations.length,2);assert.equal(snapshot.requests.length,2);
      assert.equal(new Set(recovered.compensation.steps.map(row=>row.jobId)).size,2);
      for(const row of recovered.compensation.steps){assert.equal(snapshot.operations.filter(operation=>operation.key===row.operationKey).length,1);assert.equal(f.runtime.get(row.jobId).attempt,1);}
      assert.deepEqual(snapshot.resources.map(row=>row.state),['released','released']);
    }finally{await f.close();}
  }
});

test('changed definitions stop an in-flight forward write and cannot purge its active manual recovery',async()=>{
  let entered,release;const admitted=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
  const f=await fixture({hold:async()=>{entered();await held;}});let replacement;
  try{
    const handle=f.runtime.publisher({userId:'owner-a'}).startWorkflow(f.workflow,{failAt:2});
    const running=f.runtime.workOnce({leaseMs:1000});await admitted;
    const updated=declaration(f.schema,{manualAt:0});replacement=openJobs(updated.definition,{database:f.database,now:()=>20000});
    replacement.advanceWorkflows();assert.equal(replacement.getWorkflow(handle.id).compensation.state,'manual');
    f.advanceTime();assert.equal(replacement.purgeWorkflows({states:['failed'],before:30000,includeUnresolvedCompensations:true}),0);
    release();await running;assert.deepEqual(f.values('owner-a'),[]);
    assert.equal(replacement.getWorkflow(handle.id).steps.find(row=>row.name==='a').state,'cancelled');
    assert.equal(replacement.purgeWorkflows({states:['failed'],before:30000,includeUnresolvedCompensations:true}),1);
  }finally{release();replacement?.close();await f.close();}
});

test('changed forward handler cannot reinterpret a retained compensation-enabled occurrence',async()=>{
  const f=await fixture();let replacement;
  try{
    const handle=f.runtime.publisher({userId:'owner-a'}).startWorkflow(f.workflow,{failAt:2});
    const changed=declaration(f.schema,{forwardHandler:()=>99});
    replacement=openJobs(changed.definition,{database:f.database,now:()=>10000});
    replacement.advanceWorkflows();
    const run=replacement.getWorkflow(handle.id);
    assert.equal(run.state,'failed');assert.equal(run.compensation.state,'manual');
    assert.deepEqual(f.values('owner-a'),[]);assert.equal(replacement.stats().queued,0);
  }finally{replacement?.close();await f.close();}
});

test('queued cleanup must match its frozen payload before any handler effect',async()=>{
  const f=await fixture();try{
    const handle=f.runtime.publisher({userId:'owner-a'}).startWorkflow(f.workflow,{failAt:0});await f.runtime.workOnce();
    const queued=f.runtime.getWorkflow(handle.id).compensation.steps.find(row=>row.step==='a');assert.equal(queued.state,'queued');
    const payload={...f.runtime.get(queued.jobId).args,step:'substituted-resource'};
    f.database[internal].prepare('UPDATE clank_jobs SET payload=? WHERE id=?').run(JSON.stringify(payload),queued.jobId);
    await f.drain();assert.equal(f.runtime.getWorkflow(handle.id).compensation.state,'manual');
    assert.deepEqual(f.values('owner-a'),['forward:a']);assert.equal(f.runtime.get(queued.jobId).attempt,0);
  }finally{await f.close();}
});

test('unknown compensation protocol rejects startup, stale-controller admission and advancement without partial state',async()=>{
  const f=await fixture();try{
    const handle=f.runtime.publisher({userId:'owner-a'}).startWorkflow(f.workflow,{failAt:0});
    const db=f.database[internal];db.prepare('UPDATE clank_workflow_compensation_state SET protocol=2').run();
    assert.throws(()=>openJobs(f.definition,{database:f.database}),/Unsupported persisted/);
    assert.throws(()=>f.runtime.startWorkflow(f.workflow,{failAt:1}),/Current workflow compensation protocol/);
    assert.throws(()=>f.runtime.advanceWorkflows(),/Current workflow compensation protocol/);
    assert.equal(db.prepare('SELECT count(*) AS count FROM clank_workflow_runs').get().count,1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM clank_workflow_compensations').get().count,3);
    assert.equal(f.runtime.getWorkflow(handle.id).state,'running');assert.equal(f.runtime.stats().queued,1);
    assert.equal(db.prepare('SELECT protocol FROM clank_workflow_compensation_state').get().protocol,2);
  }finally{await f.close();}
});

test('recovery capacity is reserved atomically without evicting retained declarations',async()=>{
  const f=await fixture();try{
    const db=f.database[internal];db.transaction(()=>{
      const insert=db.prepare("INSERT INTO clank_workflow_compensations VALUES(?,'held',0,'manual',NULL,NULL,NULL,NULL,NULL,'retained evidence',10000,NULL)");
      for(let n=0;n<10000;n++)insert.run(`retained-${n}`);
    });
    const retained=db.prepare("SELECT * FROM clank_workflow_compensations WHERE workflow_id='retained-0'").get();
    assert.throws(()=>f.runtime.startWorkflow(f.workflow,{failAt:0}),/capacity is full/);
    assert.equal(db.prepare('SELECT count(*) AS count FROM clank_workflow_runs').get().count,0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM clank_workflow_compensation_runs').get().count,0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM clank_jobs').get().count,0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM clank_workflow_compensations').get().count,10000);
    assert.deepEqual(db.prepare("SELECT * FROM clank_workflow_compensations WHERE workflow_id='retained-0'").get(),retained);
  }finally{await f.close();}
});

test('invalid and asynchronous cleanup mappers become visible manual failures without partial queue state',async()=>{
  for(const mapper of [()=>Promise.reject(new Error('Async cleanup rejected')),()=>({step:'a',state:'failed',original:4,key:'invalid'}),()=>({step:'a',state:'failed',original:'job',key:'x'.repeat(65536)})]){
    const f=await fixture({mapper});try{
      const handle=f.runtime.publisher({userId:'owner-a'}).startWorkflow(f.workflow,{failAt:0});await f.drain();
      const run=f.runtime.getWorkflow(handle.id);assert.equal(run.state,'failed');assert.equal(run.compensation.state,'manual');
      const row=run.compensation.steps.find(row=>row.step==='a');assert.equal(row.state,'failed');assert.equal(row.jobId,null);assert.ok(row.error);
      assert.equal(f.runtime.stats().queued,0);assert.equal(f.runtime.list({name:'undo'}).length,0);
    }finally{await f.close();}
  }
});

test('compensation definitions reject undeclared idempotency, foreign jobs and malformed manual contracts',()=>{
  const schema=defineDatabase({events:defineTable({value:s.string()})});
  const jobs=defineJobs({schema}).jobs(({job})=>({forward:job({args:{},handler:()=>null}),undo:job({args:{},agent:{idempotent:true},handler:()=>null})}));
  for(const compensate of [{job:jobs.jobs.forward,args:()=>({})},{manual:''},{manual:'x'.repeat(2001)},{manual:'Reason',job:jobs.jobs.undo,args:()=>({})}]){
    assert.throws(()=>defineWorkflow({args:{},graph:graph=>({step:graph.step(jobs.jobs.forward,{args:()=>({}),compensate})})}),/compensation|Automatic|Manual/);
  }
  const foreign=defineJobs({schema}).jobs(({job})=>({undo:job({args:{},agent:{idempotent:true},handler:()=>null})}));
  const workflow=defineWorkflow({args:{},graph:graph=>({step:graph.step(jobs.jobs.forward,{args:()=>({}),compensate:{job:foreign.jobs.undo,args:()=>({})}})})});
  assert.throws(()=>defineWorkflows(jobs,{flow:workflow}),/outside this job system/);
  for(const name of ['workflow_compensations','workflow_compensation_runs','workflow_compensation_state']){
    assert.throws(()=>defineDatabase({[name]:defineTable({value:s.string()})}),/reserved/i);
  }
});
