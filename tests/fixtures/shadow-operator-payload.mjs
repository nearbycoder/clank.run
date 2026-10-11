// UI/CLI contract fixture only. No provider, authorization or backend acceptance proof.
export const policy={revision:2,readPaths:['/healthz'],methods:['GET','HEAD'],maxSamplePercent:5,maxDurationMs:60000,maxAttempts:100,maxConcurrent:2,maxResponseBytes:4096,maxRequestMs:1000,maxReports:20};
export const effective={readPaths:['/healthz'],methods:['GET'],samplePercent:1,durationMs:30000,maxAttempts:10,maxConcurrent:1,maxResponseBytes:4096,requestMs:1000};
export const unknown=Object.fromEntries(['not-submitted','candidate-timeout','candidate-oversized','candidate-error','primary-incomplete','primary-oversized','cancelled','authority-lost','interrupted','persistence-uncertain','content-type-invalid'].map(name=>[name,name==='candidate-timeout'?1:0]));
export const session={sessionId:'shadow_session_exact_01',operationId:'shadow_operation_exact_01',controllerEpoch:7,epoch:31,policyRevision:2,releaseId:'release_shadow_candidate',artifactSha256:'a'.repeat(64),primary:{releaseId:'release_primary',generation:3},phase:'retiring',outcome:'stopped',stopRequested:true,cleanupRequired:true,reportAvailable:true,policy:effective,snapshot:{sha256:'b'.repeat(64),bytes:8192,providerStartedAt:100,providerCompletedAt:103,platformObservedAt:110,elapsedSinceObservationMs:null,crossHostFreshness:'unknown'},report:{counters:{reserved:4,settled:3,comparable:2,statusClassEqual:1,statusClassDifferent:1,mediaTypeEqual:2,mediaTypeDifferent:0,bothComplete:2,unknown},latency:{primary:{cumulative:[0,0,0,1,2,3,3,3,3,3,3,3],overflow:0,unknown:0},candidate:{cumulative:[0,0,0,0,1,2,2,2,2,2,2,2],overflow:0,unknown:1}}},createdAt:100,expiresAt:30100,updatedAt:190,nextAction:'recover'};
export const payload={ok:true,enabled:true,epoch:31,policy,sessions:[session],nextBefore:null};
export const preview={ok:true,reviewToken:'opaque_review_receipt',expiresAt:Date.now()+120000,review:{projectId:'project_a',releaseId:session.releaseId,artifactSha256:session.artifactSha256,primary:session.primary,expectedEpoch:31,policyRevision:2,policy:effective}};


// Genuine retained history for linked operator interoperability; no public-start/isolation claim.
export async function nativeOperatorHistory(t,{version=2,maximumPolicy=false}={}){
 const {shadowPlatformFixture,appendShadowHistory,request}=await import('./platform-shadow-native.mjs');
 const f=await shadowPlatformFixture(t);await f.pausePlatform();const ids=await appendShadowHistory(f,21,{version,maxReports:20,maximumPolicy});await f.successor();
 const status=async(suffix='')=>{const response=await f.platform.nativeRequest(request('/api/projects/'+f.project.id+'/shadow'+suffix,{cookie:f.owner.cookie}));if(response.status!==200)throw new Error('Native operator status failed: '+response.status);return response.json()};
 const retained=()=>JSON.stringify({journal:f.raw(),reports:f.control.prepare('SELECT * FROM clank_platform_shadow_reports ORDER BY session_id').all(),controls:f.controlCounts});
 return{f,ids,status,retained};
}

export const skips=Object.fromEntries(['ineligible','sampled-out','capacity','attempt-limit','handoff-timeout','withdrawn'].map(key=>[key,0]));
export function versionedPayload(){const result=structuredClone(payload);result.sessions[0].report={protocol:2,...result.sessions[0].report,skips:{...skips,'sampled-out':2147483647}};return result}
export function malformedStatuses(){
 const results=[],add=(name,change)=>{const value=versionedPayload();change(value,value.sessions[0]);results.push([name,value])};
 for(const value of[1,3,'2',null])add('protocol '+value,(p,s)=>s.report.protocol=value);
 add('missing skip',(p,s)=>delete s.report.skips.capacity);add('extra skip',(p,s)=>s.report.skips.private=1);
 for(const value of[-1,0.5,2147483648])add('skip bound '+value,(p,s)=>s.report.skips.capacity=value);
 add('legacy skips',(p,s)=>delete s.report.protocol);add('unknown report',(p,s)=>s.report.private=1);
 add('page capacity',p=>p.sessions=Array.from({length:21},(_,i)=>({...p.sessions[0],sessionId:'s_'+i})));
 add('duplicate session',p=>p.sessions.push({...p.sessions[0]}));add('duplicate original epoch',p=>p.sessions.push({...p.sessions[0],sessionId:'other'}));
 add('ascending original epoch',p=>p.sessions.push({...p.sessions[0],sessionId:'other',controllerEpoch:8}));
 for(const value of['cursor_older','clankshc1.e30.'+'B'.repeat(43),'clankshc1.e30.'+'A'.repeat(44),'x'.repeat(513)])add('cursor '+value,p=>p.nextBefore=value);
 for(const key of['createdAt','updatedAt','expiresAt'])add('null '+key,(p,s)=>s[key]=null);
 for(const key of['providerStartedAt','providerCompletedAt','platformObservedAt'])add('null '+key,(p,s)=>s.snapshot[key]=null);
 add('elapsed fractional',(p,s)=>s.snapshot.elapsedSinceObservationMs=.5);add('elapsed negative',(p,s)=>s.snapshot.elapsedSinceObservationMs=-1);
 add('reversed checkpoint',(p,s)=>s.snapshot.providerCompletedAt=99);add('future observation',(p,s)=>s.snapshot.platformObservedAt=191);
 add('snapshot bound',(p,s)=>s.snapshot.bytes=2*1024*1024*1024);add('wrong freshness',(p,s)=>s.snapshot.crossHostFreshness='fresh');
 add('wrong duration',(p,s)=>s.expiresAt++);add('wrong next action',(p,s)=>s.nextAction='stop');add('missing terminal outcome',(p,s)=>s.outcome=null);
 add('unknown outcome',(p,s)=>s.outcome='passed');add('false cleanup',(p,s)=>s.cleanupRequired=false);add('unavailable full report',(p,s)=>s.reportAvailable=false);
 add('primary equals candidate',(p,s)=>s.primary.releaseId=s.releaseId);add('unsorted methods',(p,s)=>s.policy.methods=['HEAD','GET']);
 add('binding with skipped observation',(p,s)=>{s.phase='binding';s.outcome=null;s.stopRequested=false;s.nextAction='stop';s.snapshot=null;for(const key of Object.keys(s.report.counters))if(key==='unknown')for(const reason of Object.keys(s.report.counters.unknown))s.report.counters.unknown[reason]=0;else s.report.counters[key]=0;s.report.latency={primary:{cumulative:Array(12).fill(0),overflow:0,unknown:0},candidate:{cumulative:Array(12).fill(0),overflow:0,unknown:0}};});
 return results;
}
