import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import * as handoff from '../dist/provider-handoff.js';
import * as platform from '../dist/platform.js';
import * as orchestration from '../dist/orchestration.js';
import {providerActivatedTargetConditionalContext} from '../dist/provider-target-stage.js';

test('conditional recovery refuses structural platform, native and restart capabilities before caller fields',async()=>{
 let reads=0;const fake=new Proxy({}, {get(){reads++;throw Error('caller field read');}});
 await assert.rejects(orchestration.recoverProviderHandoffTarget(fake,fake,fake,fake),/genuine original platform/);
 assert.throws(()=>platform.platformConditionalRecoveryAuthority(fake,'{}','0'.repeat(64)),/genuine original platform conditional/);
 assert.throws(()=>handoff.assertProviderConditionalNativeRecovery(fake,fake,'{}','0'.repeat(64)),/genuine verified native/);
 assert.throws(()=>orchestration.providerConditionalRestartPermitContext(fake),/genuine recovered coordinator restart permit/);
 assert.throws(()=>handoff.providerSourceStopRecoveryContext(fake),/genuine original native source stop/);
 assert.throws(()=>providerActivatedTargetConditionalContext(fake),/genuine original activated target/);
 assert.equal(reads,0);
});

test('pending conditional journal cannot admit an ordinary unowned target root',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'clank-pending-conditional-'));let owner;
 try{owner=await handoff.acquireProviderServiceOwnership(root,true);await fs.writeFile(join(root,'service','.handoff-target-conditional.sqlite'),'unverified pending journal',{mode:0o600});await assert.rejects(handoff.admitProviderService(owner),/metadata is incomplete/);}
 finally{owner?.close();await fs.rm(root,{recursive:true,force:true});}
});

test('conditional recovery preserves the existing strict cold restart validator',async()=>{
 const source=await fs.readFile(new URL('../src/provider-handoff.ts',import.meta.url),'utf8'),start=source.indexOf('async function verifyTargetRestartAdmission('),end=source.indexOf('\n/** Durable',start);
 assert.ok(start>0&&end>start);assert.equal(createHash('sha256').update(source.slice(start,end)).digest('hex'),'dce26736443a2ba8543495349ecb10220f474cca8957b5173057f8764f76c96e');
});
