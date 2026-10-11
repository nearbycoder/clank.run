import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import * as shadow from '../dist/managed-shadow.js';
const hash=value=>createHash('sha256').update(value).digest('hex'),sign=value=>createHmac('sha256','test-native-key').update('clank-shadow-review/1\n').update(value).digest();
const configured=()=>shadow.normalizeShadowPolicy({revision:1,readPaths:['/','/healthz'],methods:['HEAD','GET'],maxSamplePercent:5.25,maxDurationMs:1800000,maxAttempts:10000,maxConcurrent:16,maxResponseBytes:65536,maxRequestMs:10000,maxReports:100});
function fixture(policy=configured(),id='project'){
  const effective=shadow.narrowShadowPolicy(policy,{}),principal=hash(JSON.stringify({version:1,domain:'clank-shadow-principal',projectId:id,userId:'user',sessionId:'browser-session'})),issuedAt=Date.now();
  const initial=shadow.normalizeShadowReview({version:1,projectId:id,releaseId:'candidate',artifactSha256:hash('artifact'),primaryReleaseId:'primary',primaryGeneration:1,primaryFence:2,primaryIncarnation:randomUUID(),primaryArtifactSha256:hash('primary'),nodeId:'node',providerBindingDigest:hash('binding'),credentialGeneration:1,principalBindingDigest:principal,policyRevision:policy.revision,policyDigest:hash(JSON.stringify(policy)),selection:shadow.shadowReviewSelection(policy,effective),expectedEpoch:0,issuedAt,expiresAt:issuedAt+120000,nonce:randomBytes(16).toString('base64url'),reviewDigest:'0'.repeat(64)});
  const payload=shadow.normalizeShadowReview({...initial,reviewDigest:shadow.shadowReviewDigest(initial,principal,effective,hash)}),token=shadow.shadowReviewToken(payload,sign);
  return{policy,effective,principal,payload,token};
}
test('bounded signed review round trip preserves fractional sampling and canonical sorted selection',()=>{
  const f=fixture(),parsed=shadow.parseShadowReviewToken(f.token);assert.deepEqual(parsed.payload,f.payload);assert.deepEqual(Buffer.from(parsed.signature),sign(parsed.canonical));
  assert.deepEqual(shadow.expandShadowReviewSelection(f.policy,parsed.payload.selection),f.effective);assert.equal(parsed.payload.selection.samplePercent,5.25);assert.ok(Object.isFrozen(parsed.payload.selection.pathIndices));
});
for(const [label,change]of[
  ['unknown payload',p=>({...p,extra:1})],['unknown selection',p=>({...p,selection:{...p.selection,extra:1}})],['duplicate indices',p=>({...p,selection:{...p.selection,pathIndices:[0,0]}})],
  ['descending indices',p=>({...p,selection:{...p.selection,pathIndices:[1,0]}})],['unused method bits',p=>({...p,selection:{...p.selection,methodMask:4}})],['zero mask',p=>({...p,selection:{...p.selection,methodMask:0}})],
  ['wrong expiry',p=>({...p,expiresAt:p.expiresAt+1})],['unsupported version',p=>({...p,version:2})],['wrong generation',p=>({...p,credentialGeneration:2})],['bad incarnation',p=>({...p,primaryIncarnation:'not-a-uuid'})],
  ['oversized identity',p=>({...p,nodeId:'x'.repeat(129)})],['noncanonical nonce',p=>({...p,nonce:'x'.repeat(22)})],['nonfinite percentage',p=>({...p,selection:{...p.selection,samplePercent:Infinity}})],
])test('review refuses '+label,()=>assert.throws(()=>shadow.normalizeShadowReview(change(fixture().payload))));
for(const [label,change]of[
  ['duplicate JSON key',json=>'{'+'"version":1,'+json.slice(1)],['alternate order',json=>JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(json)).reverse()))],
  ['whitespace',json=>' '+json],['unknown JSON key',json=>json.slice(0,-1)+',"unknown":false}'],
])test('wire token refuses '+label,()=>{const f=fixture(),json=change(JSON.stringify(f.payload)),token='clankshr1.'+Buffer.from(json).toString('base64url')+'.'+sign(json).toString('base64url');assert.throws(()=>shadow.parseShadowReviewToken(token))});
test('wire token refuses padding, noncanonical signatures and oversized bytes',()=>{const f=fixture();for(const token of[f.token+'=',f.token.replace('clankshr1.','clankshr2.'),'clankshr1.'+Buffer.alloc(3073,32).toString('base64url')+'.'+sign('x').toString('base64url')])assert.throws(()=>shadow.parseShadowReviewToken(token))});
test('selection never expands beyond configured paths or methods',()=>{const f=fixture();assert.throws(()=>shadow.expandShadowReviewSelection({...f.policy,readPaths:['/']},f.payload.selection));assert.throws(()=>shadow.expandShadowReviewSelection({...f.policy,methods:['GET']},f.payload.selection))});
test('retained digest binds current original user/session without interpreting current policy or HMAC key',()=>{
  const f=fixture(),p=f.payload,identity={projectId:p.projectId,releaseId:p.releaseId,artifactSha256:p.artifactSha256,primaryReleaseId:p.primaryReleaseId,primaryGeneration:p.primaryGeneration,policyRevision:p.policyRevision,policyDigest:p.policyDigest,policy:f.effective,controllerEpoch:1,reviewDigest:p.reviewDigest,primary:null};
  shadow.assertShadowReviewReplay(p,identity,f.principal,hash);
  for(const principal of[hash('another-user'),hash('same-user-new-session')])assert.throws(()=>shadow.assertShadowReviewReplay(p,identity,principal,hash));
  for(const changed of[{...identity,artifactSha256:hash('different')},{...identity,policy:{...f.effective,samplePercent:1}},{...identity,projectId:'other'},{...identity,primary:{fence:9,incarnation:randomUUID()}}])assert.throws(()=>shadow.assertShadowReviewReplay(p,changed,f.principal,hash));
});
test('maximum identity and 32 full paths fit review wire and canonical start body bounds',t=>{
  const policy={...configured(),readPaths:Array.from({length:32},(_,i)=>'/'+String(i).padStart(3,'0')+'x'.repeat(252))},f=fixture(policy,'p'.repeat(128));
  const input={...f.payload,releaseId:'c'.repeat(128),primaryReleaseId:'r'.repeat(128),nodeId:'n'.repeat(128),primaryGeneration:Number.MAX_SAFE_INTEGER,credentialGeneration:Number.MAX_SAFE_INTEGER,primaryFence:Number.MAX_SAFE_INTEGER,expectedEpoch:Number.MAX_SAFE_INTEGER-1,policyRevision:Number.MAX_SAFE_INTEGER};
  const p=shadow.normalizeShadowReview(input),token=shadow.shadowReviewToken(p,sign),body=JSON.stringify({reviewToken:token,idempotencyKey:'k'.repeat(128)});
  assert.ok(Buffer.byteLength(JSON.stringify(p))<=3072);assert.ok(token.length<=4150);assert.ok(Buffer.byteLength(body)<=4316);assert.deepEqual(shadow.parseShadowReviewToken(token).payload,p);
  t.diagnostic(JSON.stringify({payloadBytes:Buffer.byteLength(JSON.stringify(p)),tokenBytes:token.length,canonicalStartBytes:Buffer.byteLength(body),effectivePolicyBytes:Buffer.byteLength(JSON.stringify(f.effective))}));
});
