import test from 'node:test';
import assert from 'node:assert/strict';
import {createOrganizationServiceAccountClient} from '../dist/service-accounts.js';
test('service account clients bind fresh authorization to exact organization-scoped requests without automatic retries',async()=>{
  let credential='first',csrf='first-csrf';const calls=[];
  const client=createOrganizationServiceAccountClient({url:'https://platform.test/',headers:()=>({authorization:credential}),auth:{csrfHeader:()=>({'x-clank-csrf':csrf})},fetch:async(url,request)=>{calls.push({url,request});return Response.json({ok:true,accounts:[],detail:{account:{version:2},credentials:[]},account:{version:2},issued:{accessToken:'fixture-only'}});}});
  const input={projectId:'project_exact_01',permissions:['read'],expiresAt:Date.now()+600000,expectedVersion:1,operationId:'credential_exact_01'};
  await client.issue('organization_01','machine_account_01',input);credential='second';csrf='second-csrf';await client.issue('organization_01','machine_account_01',input);
  assert.equal(calls[0].url,'https://platform.test/api/organizations/organization_01/service-accounts/machine_account_01/credentials');assert.equal(calls[0].request.body,calls[1].request.body);
  assert.equal(calls[1].request.headers.get('authorization'),'second');assert.equal(calls[1].request.headers.get('x-clank-csrf'),'second-csrf');assert.equal(calls[0].request.credentials,'same-origin');assert.equal(calls[0].request.redirect,'error');
  assert.deepEqual(await client.list('organization_01'),[]);assert.equal((await client.read('organization_01','machine_account_01')).account.version,2);
  await assert.rejects(client.read('../foreign','machine_account_01'),/identifier/);
  await assert.rejects(client.create('organization_01',{name:'x'.repeat(20000)}),/bounded envelope/);
  const before=calls.length;await assert.rejects(createOrganizationServiceAccountClient({fetch:async()=>{calls.push('failure');return Response.json({ok:false,error:{message:'private machine detail'}},{status:403});}}).list('organization_01'),error=>error.status===403&&!error.message.includes('private'));
  assert.equal(calls.length,before+1);
});
test('service account transports bound ignored cancellation, response size and invalid JSON without exposing server details',async()=>{
  for(const fetch of [()=>new Promise(()=>{}),()=>Promise.resolve(new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}})))]){
    const started=Date.now();await assert.rejects(createOrganizationServiceAccountClient({timeoutMs:500,fetch}).list('organization_01'),/timed out/);assert.ok(Date.now()-started<1000);
  }
  await assert.rejects(createOrganizationServiceAccountClient({fetch:async()=>new Response('x'.repeat(1024*1024+1))}).list('organization_01'),/bounded envelope/);
  await assert.rejects(createOrganizationServiceAccountClient({fetch:async()=>new Response('private malformed response')}).list('organization_01'),error=>error.message.includes('invalid JSON')&&!error.message.includes('private'));
});
