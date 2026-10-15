import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoppedProviderTarget,assertProviderStoppedTarget,createProviderTransferTarget,stageProviderTransferBase,applyProviderTransferTail,assertProviderTargetTransferReceipt,verifyProviderTargetTransferReceipt,activateProviderTransferTarget,assertProviderActivatedTarget} from '../dist/provider-target-stage.js';
import {providerSourceTransferContext,acknowledgeProviderSourceTargetReceipt,quiesceProviderSourceForTarget,assertProviderSourceQuiescenceLease,stopQuiescentProviderSource,assertProviderSourceStopLease,publishProviderSourceTerminalTail,providerSourceStopActivationContext} from '../dist/provider-handoff.js';

test('target construction rejects copied authority before consulting caller fields',async()=>{
 const fake=new Proxy({}, {get(){throw new Error('caller field was evaluated');}});
 await assert.rejects(createStoppedProviderTarget(fake,fake,fake,fake),/genuine original provider target workspace/);
});

test('a serialized stopped target never grants suspension authority',()=>{
 assert.throws(()=>assertProviderStoppedTarget({targetId:'original',assertCurrent(){throw new Error('caller method was invoked');}}),/genuine original stopped target/);
});
test('source-bound construction rejects workspace copies before caller bytes',async()=>{
 const fake=new Proxy({}, {get(){throw new Error('caller field was evaluated');}});
 await assert.rejects(createProviderTransferTarget(fake,fake,fake,fake,fake),/genuine original provider target workspace/);
});
test('source rows cannot supply an original transfer reader',()=>{
 assert.throws(()=>providerSourceTransferContext({assertCurrent(){throw new Error('caller method was invoked');}}),/genuine original source transfer lease/);
});
test('base, tail and receipt APIs reject serialized capabilities before their fields',()=>{
 const fake=new Proxy({}, {get(){throw new Error('caller field was evaluated');}});
 assert.throws(()=>stageProviderTransferBase(fake),/genuine original transfer target/);
 assert.throws(()=>applyProviderTransferTail(fake,fake),/genuine original transfer target/);
 assert.throws(()=>assertProviderTargetTransferReceipt(fake),/genuine original target transfer receipt/);
 assert.throws(()=>verifyProviderTargetTransferReceipt(fake),/genuine original target transfer receipt/);
});
test('source acknowledgement rejects a copied receipt without invoking caller fields',async()=>{
 const fake=new Proxy({}, {get(){throw new Error('caller field was evaluated');}});
 await assert.rejects(acknowledgeProviderSourceTargetReceipt(fake),/genuine original target transfer receipt/);
});

test('quiescence rejects copied receipts and caller fields before source authority',async()=>{
 const fake=new Proxy({}, {get(){throw Error('caller field was evaluated');}});
 await assert.rejects(quiesceProviderSourceForTarget(fake),/genuine original target transfer receipt/);
 assert.throws(()=>assertProviderSourceQuiescenceLease(fake),/genuine original source quiescence lease/);
});

test('native source stop rejects copied quiescence/launch and stop rows before fields',async()=>{
 const fake=new Proxy({}, {get(){throw Error('caller field was evaluated');}});
 await assert.rejects(stopQuiescentProviderSource(fake,fake),/genuine original source quiescence lease/);
 assert.throws(()=>assertProviderSourceStopLease(fake),/genuine original native source stop lease/);
});

test('terminal tail publication rejects copied native stop authority before caller fields',async()=>{
 const fake=new Proxy({}, {get(){throw Error('caller field was evaluated');}});
 await assert.rejects(publishProviderSourceTerminalTail(fake),/genuine original native source stop lease/);
});

test('activation rejects copied targets, stops and active facades before caller fields',async()=>{
 const fake=new Proxy({}, {get(){throw Error('caller field was evaluated');}});
 await assert.rejects(activateProviderTransferTarget(fake,fake,fake),/genuine original transfer target/);
 assert.throws(()=>providerSourceStopActivationContext(fake),/genuine original native source stop/);
 assert.throws(()=>assertProviderActivatedTarget(fake),/genuine original activated target/);
});

test('provider ingress composition refuses forged source launch before inspecting caller fields', async () => {
 const {openProviderSourceHandoffIngress}=await import('../dist/provider-service.js');
 let reads=0;const value=new Proxy({}, {get(){reads++;throw Error('caller field read');}});
 await assert.rejects(openProviderSourceHandoffIngress(value),/genuine original source launch/);
 assert.equal(reads,0);
});
test('provider ingress routes require original target and activated capabilities', async () => {
 const {providerTargetHandoffContext,providerActivatedTargetIngressContext}=await import('../dist/provider-target-stage.js');
 let reads=0;const value=new Proxy({}, {get(){reads++;throw Error('caller field read');}});
 assert.throws(()=>providerTargetHandoffContext(value,value),/genuine original target/);
 assert.throws(()=>providerActivatedTargetIngressContext(value),/genuine original activated target/);
 assert.equal(reads,0);
});

test('normal source admission refuses copied or injected provider authority before caller fields',async()=>{
 const {prepareDockerProviderSource}=await import('../dist/provider-service.js');
 let reads=0;const fake=new Proxy({}, {get(){reads++;throw Error('caller field read');}});
 await assert.rejects(prepareDockerProviderSource(fake,fake,fake,fake,fake),/genuine original Docker provider/);
 assert.equal(reads,0);
});

test('platform handoff refuses copied runtime capabilities before consulting their fields',async()=>{
 const {platformProviderHandoffContext}=await import('../dist/platform.js');
 let reads=0;const fake=new Proxy({}, {get(){reads++;throw Error('caller field read');}});
 assert.throws(()=>platformProviderHandoffContext(fake),/genuine original platform runtime/);assert.equal(reads,0);
});

test('target restart permission rejects copied coordinator and permit capabilities before caller fields',async()=>{
 const {prepareProviderHandoffTargetRestart}=await import('../dist/orchestration.js');
 const {persistProviderTargetRestart}=await import('../dist/provider-handoff.js');
 let reads=0;const fake=new Proxy({}, {get(){reads++;throw Error('caller field read');}});
 await assert.rejects(prepareProviderHandoffTargetRestart(fake),/genuine original handoff placement/);
 await assert.rejects(persistProviderTargetRestart(fake),/genuine original target restart permit/);
 assert.equal(reads,0);
});
test('restart data reader uses the ordinary strict state decoder',async()=>{
 const {providerDataRestartBinding}=await import('../dist/provider-data.js');
 const fence=JSON.stringify({protocol:'clank-provider-data-fence/1',projectId:'project',fence:2});
 assert.throws(()=>providerDataRestartBinding(JSON.stringify({active:{projectId:'project',fence:2}}),fence,'project'),/provider data state/);
});

test('live adoption refuses copied target, coordinator and publication authority before caller fields',async()=>{
 const {providerActivatedTargetAdoptionContext}=await import('../dist/provider-target-stage.js');
 const {prepareProviderHandoffTargetAdoption,providerHandoffTargetAdoptionContext}=await import('../dist/orchestration.js');
 const {persistProviderTargetAdoption}=await import('../dist/provider-handoff.js');
 let reads=0;const fake=new Proxy({}, {get(){reads++;throw Error('caller field read');}});
 assert.throws(()=>providerActivatedTargetAdoptionContext(fake),/genuine original activated target/);
 await assert.rejects(prepareProviderHandoffTargetAdoption(fake),/genuine original handoff placement/);
 assert.throws(()=>providerHandoffTargetAdoptionContext(fake),/genuine original target adoption permit/);
 await assert.rejects(persistProviderTargetAdoption(fake),/genuine original target adoption permit/);
 assert.equal(reads,0);
});

test('live ownership move, runtime and launcher reject structural authority before fields',async()=>{
 const h=await import('../dist/provider-handoff.js'),stage=await import('../dist/provider-target-stage.js');
 const {openDockerDeploymentRuntimeLauncher}=await import('../dist/provider-docker.js');
 const {adoptDockerDeploymentProviderTarget}=await import('../dist/provider-service.js');
 let reads=0;const fake=new Proxy({}, {get(){reads++;throw Error('caller field read');}});
 await assert.rejects(h.moveProviderTargetOwnership(fake),/genuine original target adoption receipt/);
 assert.throws(()=>h.providerTargetAdoptionMoveContext(fake),/genuine in-progress target adoption move/);
 assert.throws(()=>stage.transferProviderTargetRuntime(fake),/genuine in-progress target adoption move/);
 assert.throws(()=>stage.providerAdoptedTargetRuntimeContext(fake),/genuine original adopted target runtime/);
 await assert.rejects(stage.closeProviderAdoptedTargetRuntime(fake),/genuine original adopted target runtime/);
 await assert.rejects(openDockerDeploymentRuntimeLauncher(fake,fake),/genuine original adopted target runtime/);
 await assert.rejects(adoptDockerDeploymentProviderTarget(fake),/genuine original target adoption receipt/);assert.equal(reads,0);
});

for(const marker of ['.handoff-target-restart.sqlite','.handoff-target-adoption.sqlite'])test('retained '+marker+' without target ownership never admits ordinary cleanup',async()=>{
 const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');
 const h=await import('../dist/provider-handoff.js'),root=await fs.mkdtemp(path.join(os.tmpdir(),'clank-incomplete-target-'));let owner;
 try{owner=await h.acquireProviderServiceOwnership(root,true);await fs.writeFile(path.join(root,'service',marker),'unverified',{mode:0o600});await assert.rejects(h.admitProviderService(owner),/metadata is incomplete/);}finally{owner?.close();await fs.rm(root,{recursive:true,force:true});}
});
