import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateProjectSlo,validateProjectSloConfiguration} from '../src/project-slo.ts';
const until=600000;
const policy={name:'Checkout success',objective:{kind:'request-success'},targetBasisPoints:9900,windowMinutes:5,minimumRequests:100,burnThreshold:2,enabled:true};
const sample=(index,requests=200,successful=198)=>({startedAt:until-(5-index)*60000,complete:true,requests,completed:requests,successful,latency:[0,50,100,150,175,190,requests]});
test('SLO request and latency arithmetic preserves the exact good/total and burn fraction',()=>{
 const buckets=Array.from({length:5},(_,i)=>sample(i));
 const success=evaluateProjectSlo(policy,buckets,until);
 assert.deepEqual([success.requests,success.good,success.bad,success.allowedBadRequests,success.remainingBudgetRequests,success.burnRate,success.status,success.burning],[1000,990,10,10,0,1,'within-budget',false]);
 buckets[0].successful=188;
 const burning=evaluateProjectSlo(policy,buckets,until);
 assert.deepEqual([burning.bad,burning.burnRate,burning.status,burning.burning],[20,2,'budget-exhausted',true]);
 const latency=evaluateProjectSlo({...policy,objective:{kind:'latency',maximumMs:500}},buckets,until);
 assert.deepEqual([latency.good,latency.bad,latency.burnRate],[750,250,25]);
 // A cancelled 200 response is neither success nor a completed latency outcome.
 buckets[0].requests++;const cancelled=evaluateProjectSlo(policy,buckets,until);assert.equal(cancelled.bad,21);
});
test('missing, partial, empty and low-traffic minutes never establish compliance or resolve a burn',()=>{
 const buckets=Array.from({length:5},(_,i)=>sample(i));
 for(const value of [buckets.slice(1),buckets.map((b,i)=>({...b,complete:i!==2}))]) {
  const result=evaluateProjectSlo(policy,value,until);
  assert.equal(result.status,'insufficient-data');assert.equal(result.reason,'missing-measurements');assert.equal(result.coverage.missingMinutes,1);
  for(const key of ['allowedBadRequests','remainingBudgetRequests','burnRate','burning'])assert.equal(result[key],null);
 }
 const empty=Array.from({length:5},(_,i)=>({...sample(i,0,0),latency:[0,0,0,0,0,0,0]}));
 const result=evaluateProjectSlo(policy,empty,until);assert.equal(result.observedGoodFraction,null);assert.equal(result.reason,'not-enough-requests');
 const low=empty.map(b=>({...b,requests:1,completed:1,successful:1}));assert.equal(evaluateProjectSlo(policy,low,until).burning,null);
});
test('malformed and ambiguous histograms, duplicate minutes, extra fields and arithmetic overflow fail closed',()=>{
 const buckets=Array.from({length:5},(_,i)=>sample(i));
 for(const transform of [b=>({...b,successful:201}),b=>({...b,completed:199}),b=>({...b,latency:[50,49,100,150,175,190,200]}),b=>({...b,startedAt:b.startedAt+1}),b=>({...b,payload:'private'}),b=>({...b,complete:'yes'})])assert.throws(()=>evaluateProjectSlo(policy,[transform(buckets[0]),...buckets.slice(1)],until),TypeError);
 assert.throws(()=>evaluateProjectSlo(policy,[buckets[0],buckets[0]],until),TypeError);
 assert.throws(()=>evaluateProjectSlo(policy,buckets,until+1),TypeError);
 const huge=()=>({...sample(0),requests:Number.MAX_SAFE_INTEGER,completed:Number.MAX_SAFE_INTEGER,successful:Number.MAX_SAFE_INTEGER,latency:Array(7).fill(Number.MAX_SAFE_INTEGER)});
 assert.throws(()=>evaluateProjectSlo(policy,[huge(),{...huge(),startedAt:until-60000}],until),TypeError);
 for(const mutation of [{targetBasisPoints:10000},{targetBasisPoints:9899.5},{windowMinutes:6},{minimumRequests:0},{burnThreshold:Infinity},{objective:{kind:'latency',maximumMs:501}},{objective:{kind:'request-success',payload:'private'}},{name:'a'.repeat(161)},{enabled:1}])assert.throws(()=>validateProjectSloConfiguration({...policy,...mutation}),TypeError);
 const validated=validateProjectSloConfiguration(policy);assert.notEqual(validated,policy);assert.notEqual(validated.objective,policy.objective);
});
test('SLO budget and decimal burn decisions use exact ratios near the safe integer count ceiling',()=>{
 const requests=9000000000000000,bad=99000000000001,good=requests-bad;
 const buckets=Array.from({length:5},(_,i)=>({...sample(i,0,0),latency:[0,0,0,0,0,0,0]}));buckets[0]={...buckets[0],requests,successful:good,completed:requests};
 const above=evaluateProjectSlo({...policy,burnThreshold:1.1},buckets,until);assert.equal(above.burning,true);assert.equal(above.status,'budget-exhausted');
 buckets[0].successful=good+2;const below=evaluateProjectSlo({...policy,burnThreshold:1.1},buckets,until);assert.equal(below.burning,false);
 // One bad request above a tiny fractional allowance must not disappear in rounding.
 const edgeRequests=8999999999999999,edgeBad=900000000000;
 buckets[0]={...buckets[0],requests:edgeRequests,completed:edgeRequests,successful:edgeRequests-edgeBad};
 const edge=evaluateProjectSlo({...policy,targetBasisPoints:9999,burnThreshold:1},buckets,until);assert.equal(edge.status,'budget-exhausted');assert.equal(edge.burning,true);assert.equal(edge.remainingBudgetRequests,-0.0001);
});
