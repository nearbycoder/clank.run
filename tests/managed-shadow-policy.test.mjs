import test from 'node:test';
import assert from 'node:assert/strict';
import * as shadow from '../dist/managed-shadow.js';

const policy=()=>({revision:1,readPaths:['/health','/'],methods:['HEAD','GET'],maxSamplePercent:25,maxDurationMs:60000,maxAttempts:100,maxConcurrent:4,maxResponseBytes:16384,maxRequestMs:2000,maxReports:20});

test('shadow policy is explicit, canonical and deeply immutable',()=>{
  const input=policy(),result=shadow.normalizeShadowPolicy(input);input.readPaths.push('/later');input.methods.reverse();
  assert.deepEqual(result.readPaths,['/','/health']);assert.deepEqual(result.methods,['GET','HEAD']);
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.readPaths)&&Object.isFrozen(result.methods));
  assert.deepEqual(result,shadow.normalizeShadowPolicy({...policy(),readPaths:['/','/health'],methods:['GET','HEAD']}));
});

for(const percentage of [0.01,0.5,1.25])test(`fractional shadow percentage ${percentage} is retained and can only be narrowed`,()=>{
  const current=shadow.normalizeShadowPolicy({...policy(),maxSamplePercent:percentage});
  assert.equal(current.maxSamplePercent,percentage);
  assert.equal(shadow.narrowShadowPolicy(current,{}).samplePercent,percentage);
  assert.equal(shadow.narrowShadowPolicy(current,{samplePercent:0.01}).samplePercent,0.01);
  assert.throws(()=>shadow.narrowShadowPolicy(current,{samplePercent:percentage+0.01}),{code:'SHADOW_POLICY_INVALID'});
});
test('fractional shadow percentage bounds reject nonfinite and out-of-range values',()=>{
  for(const value of [0,0.009999,-1,100.0001,NaN,Infinity,-Infinity,null,undefined,'0.5']){
    assert.throws(()=>shadow.normalizeShadowPolicy({...policy(),maxSamplePercent:value}),{code:'SHADOW_POLICY_INVALID'});
    assert.throws(()=>shadow.narrowShadowPolicy(policy(),{samplePercent:value}),{code:'SHADOW_POLICY_INVALID'});
  }
  assert.equal(shadow.normalizeShadowPolicy({...policy(),maxSamplePercent:100}).maxSamplePercent,100);
});
test('fractional shadow percentages do not relax integer count and duration bounds',()=>{
  for(const field of ['revision','maxDurationMs','maxAttempts','maxConcurrent','maxResponseBytes','maxRequestMs','maxReports'])
    assert.throws(()=>shadow.normalizeShadowPolicy({...policy(),[field]:1.5}),{code:'SHADOW_POLICY_INVALID'});
  for(const field of ['durationMs','maxAttempts','maxConcurrent','maxResponseBytes','requestMs'])
    assert.throws(()=>shadow.narrowShadowPolicy(policy(),{[field]:1.5}),{code:'SHADOW_POLICY_INVALID'});
});

for(const [field,value] of [['revision',0],['revision',Number.MAX_SAFE_INTEGER+1],['maxSamplePercent',101],['maxDurationMs',1800001],['maxAttempts',10001],['maxConcurrent',17],['maxResponseBytes',65537],['maxRequestMs',10001],['maxReports',101],['methods',['POST']],['readPaths',['/','/']],['readPaths',['/health?']],['readPaths',['/a/../b']],['readPaths',['/a//b']],['readPaths',['/%68ealth']],['readPaths',['/a\\b']],['readPaths',['/é']],['readPaths',Array.from({length:33},(_,i)=>'/'+i)]]){
  test(`shadow policy refuses invalid ${field}: ${JSON.stringify(value)}`,()=>assert.throws(()=>shadow.normalizeShadowPolicy({...policy(),[field]:value}),{code:'SHADOW_POLICY_INVALID'}));
}
test('shadow policy rejects missing and unknown configuration without defaults',()=>{
  const input=policy();delete input.maxConcurrent;
  assert.throws(()=>shadow.normalizeShadowPolicy(input),{code:'SHADOW_POLICY_INVALID'});
  assert.throws(()=>shadow.normalizeShadowPolicy({...policy(),enabled:true}),{code:'SHADOW_POLICY_INVALID'});
  assert.throws(()=>shadow.normalizeShadowPolicy({...policy(),methods:new Array(1)}),{code:'SHADOW_POLICY_INVALID'});
  assert.throws(()=>shadow.normalizeShadowPolicy({...policy(),readPaths:new Array(1)}),{code:'SHADOW_POLICY_INVALID'});
});
test('session policy can only narrow the configured paths, methods and limits',()=>{
  const current=shadow.normalizeShadowPolicy(policy());
  assert.deepEqual(shadow.narrowShadowPolicy(current,{}),{readPaths:['/','/health'],methods:['GET','HEAD'],samplePercent:25,durationMs:60000,maxAttempts:100,maxConcurrent:4,maxResponseBytes:16384,requestMs:2000});
  const narrowed=shadow.narrowShadowPolicy(current,{readPaths:['/health'],methods:['HEAD'],samplePercent:1,durationMs:1000,maxAttempts:5,maxConcurrent:1,maxResponseBytes:128,requestMs:100});
  assert.ok(Object.isFrozen(narrowed)&&Object.isFrozen(narrowed.readPaths));assert.equal(narrowed.maxAttempts,5);
  for(const [field,value] of [['readPaths',['/other']],['methods',['POST']],['samplePercent',26],['durationMs',60001],['maxAttempts',101],['maxConcurrent',5],['maxResponseBytes',16385],['requestMs',2001],['samplePercent',0],['maxAttempts',1.5],['unknown',1]])assert.throws(()=>shadow.narrowShadowPolicy(current,{[field]:value}),{code:'SHADOW_POLICY_INVALID'});
  for(const field of ['readPaths','methods'])for(const value of [null,undefined,new Array(1)])assert.throws(()=>shadow.narrowShadowPolicy(current,{[field]:value}),{code:'SHADOW_POLICY_INVALID'});
});
test('empty report distinguishes zero observations from unavailable evidence',()=>{
  const result=shadow.emptyShadowReport();assert.deepEqual(shadow.normalizeShadowReport(result,100),result);
  assert.equal(result.counters.reserved,0);assert.equal(result.counters.comparable,0);assert.equal(result.latency.primary.unknown,0);
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.counters.unknown)&&Object.isFrozen(result.latency.primary.cumulative));
  assert.deepEqual(shadow.shadowLatencyBuckets,[1,5,10,25,50,100,250,500,1000,2500,5000,10000]);
});
function report(){
  const result=structuredClone(shadow.emptyShadowReport());Object.assign(result.counters,{reserved:3,settled:2,comparable:1,statusClassEqual:1,mediaTypeDifferent:1,bothComplete:2});
  result.counters.unknown['content-type-invalid']=1;
  result.latency.primary.cumulative=result.latency.primary.cumulative.map((_,i)=>i>=4?2:0);
  result.latency.candidate.cumulative=result.latency.candidate.cumulative.map((_,i)=>i>=5?2:0);return result;
}
test('report normalization retains fixed aggregates without treating invalid media as a match',()=>{
  const input=report(),result=shadow.normalizeShadowReport(input,100);input.counters.comparable=999;
  assert.equal(result.counters.comparable,1);assert.equal(result.counters.bothComplete,2);assert.equal(result.counters.unknown['content-type-invalid'],1);
  assert.ok(Object.isFrozen(result.latency.candidate));
});
for(const reason of ['not-submitted','candidate-timeout','candidate-oversized','candidate-error','primary-incomplete','primary-oversized'])
test(`retained report cannot count ${reason} as both completed bodies`,()=>{
  const input=structuredClone(shadow.emptyShadowReport());
  Object.assign(input.counters,{reserved:1,settled:1,bothComplete:1});input.counters.unknown[reason]=1;
  input.latency.primary.unknown=1;input.latency.candidate.unknown=1;
  assert.throws(()=>shadow.normalizeShadowReport(input,100),{code:'SHADOW_REPORT_INVALID'});
});
for(const [label,change] of [
  ['capacity',r=>r.counters.reserved=101],['comparison denominator',r=>r.counters.statusClassEqual=2],['settlement denominator',r=>r.counters.settled=3],
  ['completion denominator',r=>r.counters.bothComplete=0],['negative',r=>r.counters.unknown.cancelled=-1],['unknown reason',r=>r.counters.unknown.custom=1],
  ['histogram population',r=>r.latency.primary.unknown=1],['histogram monotonicity',r=>r.latency.primary.cumulative[0]=2],['arbitrary header',r=>r.contentType='private'],
  ['sparse histogram',r=>delete r.latency.primary.cumulative[0]],
])test(`retained report refuses invalid ${label}`,()=>{const input=report();change(input);assert.throws(()=>shadow.normalizeShadowReport(input,100),{code:'SHADOW_REPORT_INVALID'});});
