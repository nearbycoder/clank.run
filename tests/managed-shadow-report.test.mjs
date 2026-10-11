import test from 'node:test';
import assert from 'node:assert/strict';
import * as shadow from '../dist/managed-shadow.js';

const names=['ineligible','sampled-out','capacity','attempt-limit','handoff-timeout','withdrawn'];
const skips=value=>Object.fromEntries(names.map(name=>[name,value]));
const legacy=()=>structuredClone(shadow.emptyShadowReport());
const version2=()=>({protocol:2,...legacy(),skips:skips(0)});

test('version-two report is an exact immutable discriminated DTO while legacy bytes stay unchanged',()=>{
  const old=legacy(),bytes=JSON.stringify(old);assert.equal(JSON.stringify(shadow.normalizeShadowReport(old,10000)),bytes);
  const input=version2(),normalized=shadow.normalizeShadowReport(input,10000);assert.deepEqual(Object.keys(normalized),['protocol','counters','latency','skips']);assert.deepEqual(Object.keys(normalized.skips),names);
  assert.deepEqual(shadow.emptyShadowReport(2),normalized);assert.equal(JSON.stringify(shadow.emptyShadowReport()),bytes);
  input.skips.ineligible=99;assert.equal(normalized.skips.ineligible,0);assert.ok(Object.isFrozen(normalized)&&Object.isFrozen(normalized.skips));
});

test('version-two skipped observations saturate independently and never change sample arithmetic',()=>{
  let report=shadow.normalizeShadowReport({...version2(),skips:skips(2147483646)},1);const before=JSON.stringify({counters:report.counters,latency:report.latency});
  report=shadow.addShadowSkips(report,skips(2),1);assert.deepEqual(report.skips,skips(2147483647));
  report=shadow.addShadowSkips(report,skips(2147483647),1);assert.deepEqual(report.skips,skips(2147483647));assert.equal(JSON.stringify({counters:report.counters,latency:report.latency}),before);
  assert.throws(()=>shadow.addShadowSkips(shadow.emptyShadowReport(),skips(1),1));
});

for(const [label,mutate]of[
  ['missing protocol',r=>delete r.protocol],['protocol one',r=>r.protocol=1],['string protocol',r=>r.protocol='2'],['future protocol',r=>r.protocol=3],['missing skips',r=>delete r.skips],
  ['missing fixed key',r=>delete r.skips.withdrawn],['unknown fixed key',r=>r.skips.secret=1],['negative',r=>r.skips.ineligible=-1],['fraction',r=>r.skips.ineligible=0.5],
  ['overflow',r=>r.skips.ineligible=2147483648],['unsafe',r=>r.skips.ineligible=Number.MAX_SAFE_INTEGER+1],['nonfinite',r=>r.skips.ineligible=Infinity],
  ['array',r=>r.skips=[]],['null',r=>r.skips=null],['unknown report key',r=>r.headers={}],['reserved arithmetic',r=>r.counters.settled=1],
])test('version-two closed report refuses '+label,()=>{const input=version2();mutate(input);assert.throws(()=>shadow.normalizeShadowReport(input,10),{code:'SHADOW_REPORT_INVALID'})});
