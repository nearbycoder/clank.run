import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fixture} from './fixtures/platform-environment-fixture.mjs';

function message(child,predicate){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error('Owned incident HTTP fixture timed out.')),10000);
    const receive=value=>{if(predicate(value))finish(null,value);},exit=()=>finish(new Error('Owned incident HTTP fixture exited before acknowledgement.'));
    const finish=(error,value)=>{clearTimeout(timer);child.off('message',receive);child.off('exit',exit);error?reject(error):resolve(value);};
    child.on('message',receive);child.once('exit',exit);
  });
}
async function controller(options){
  const child=fork(new URL('./fixtures/project-incidents-http-controller.mjs',import.meta.url),[JSON.stringify(options)],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',value=>stderr=(stderr+value).slice(-4096));
  const closed=new Promise(resolve=>child.once('close',resolve));
  try{return {child,closed,...await message(child,value=>value.ready),diagnostics:()=>stderr};}catch(error){child.kill('SIGKILL');await closed;throw new Error(error.message+' '+stderr);}
}
test('actual SIGKILL after incident commit and before HTTP delivery replays one durable receipt without reviving later state',{timeout:30000},async t=>{
  const f=await fixture(t),endpoint=`/api/projects/${f.development.id}/incidents`;
  let first,second;
  t.after(async()=>{for(const entry of [first,second])if(entry&&entry.child.exitCode===null&&entry.child.signalCode===null){entry.child.kill('SIGKILL');await entry.closed;}});
  first=await controller(f.options);
  const input={title:'Interrupted recovery',severity:'critical',ownerId:f.owner.user.id,operationId:'incident_killed_exact_01'};
  const headers={origin:first.url,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf,'content-type':'application/json','x-clank-fixture-hold':'after-commit'};
  const acknowledged=message(first.child,value=>value.committed);
  const delivery=fetch(first.url+endpoint,{method:'POST',headers,body:JSON.stringify(input)}).then(()=>({delivered:true}),()=>({delivered:false}));
  const committed=await acknowledged;assert.equal(committed.version,1);
  first.child.kill('SIGKILL');await first.closed;assert.deepEqual(await delivery,{delivered:false});
  second=await controller(f.options);
  const replay=async()=>{const response=await fetch(second.url+endpoint,{method:'POST',headers:{...headers,origin:second.url,'x-clank-fixture-hold':''},body:JSON.stringify(input)});assert.equal(response.status,201,second.diagnostics());return (await response.json()).incident;};
  const recovered=await replay();assert.equal(recovered.id,committed.id);assert.equal(recovered.version,1);
  await f.call(endpoint+'/'+committed.id+'/change',{expectedVersion:1,operationId:'incident_after_kill_note_01',change:{kind:'note',text:'Recovery verified after restart.'}});
  await f.call(endpoint+'/'+committed.id+'/change',{expectedVersion:2,operationId:'incident_after_kill_resolve_01',change:{kind:'resolve',resolution:'Current resolved state must survive an older receipt.'}});
  assert.equal((await replay()).state,'open');
  const current=(await f.call(endpoint+'/'+committed.id)).detail;assert.equal(current.incident.state,'resolved');assert.equal(current.incident.version,3);assert.equal(current.notes.length,1);assert.equal((await f.call(endpoint)).incidents.length,1);
  second.child.send({close:true});await second.closed;
});
test('actual SIGKILL after SLO commit and before HTTP delivery preserves one policy and current configuration',{timeout:30000},async t=>{
  const f=await fixture(t),endpoint=`/api/projects/${f.development.id}/slo-policies`;let first,second;
  t.after(async()=>{for(const entry of [first,second])if(entry&&entry.child.exitCode===null&&entry.child.signalCode===null){entry.child.kill('SIGKILL');await entry.closed;}});
  first=await controller(f.options);
  const configuration={name:'Interrupted objective',objective:{kind:'request-success'},targetBasisPoints:9900,windowMinutes:5,minimumRequests:100,burnThreshold:2,enabled:true};
  const input={configuration,operationId:'slo_killed_exact_01'},headers={origin:first.url,cookie:f.owner.cookie,'x-clank-csrf':f.owner.csrf,'content-type':'application/json','x-clank-fixture-hold':'after-commit'};
  const acknowledged=message(first.child,value=>value.committed),delivery=fetch(first.url+endpoint,{method:'POST',headers,body:JSON.stringify(input)}).then(()=>({delivered:true}),()=>({delivered:false}));
  const committed=await acknowledged;assert.equal(committed.version,1);first.child.kill('SIGKILL');await first.closed;assert.deepEqual(await delivery,{delivered:false});
  second=await controller(f.options);
  const replay=async()=>{const response=await fetch(second.url+endpoint,{method:'POST',headers:{...headers,origin:second.url,'x-clank-fixture-hold':''},body:JSON.stringify(input)});assert.equal(response.status,201,second.diagnostics());return (await response.json()).policy;};
  assert.equal((await replay()).id,committed.id);
  await f.call(endpoint+'/'+committed.id+'/change',{configuration:{...configuration,name:'Current paused objective',enabled:false},expectedVersion:1,operationId:'slo_after_kill_pause_01'});
  const historical=await replay();assert.equal(historical.version,1);assert.equal(historical.enabled,true);
  const current=(await f.call(endpoint+'/'+committed.id)).assessment;assert.equal(current.policy.version,2);assert.equal(current.policy.enabled,false);assert.equal(current.evaluation.burning,null);assert.equal((await f.call(endpoint)).policies.length,1);
  second.child.send({close:true});await second.closed;
});
