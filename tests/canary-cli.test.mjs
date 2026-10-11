import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../scripts/clank.mjs',import.meta.url));
const provider={operationId:'canary_exact_operation_001',controllerEpoch:17,releaseId:'release_exact',phase:'retiring',outcome:null,cleanupRequired:true,retryable:true,reason:'Cleanup still uncertain',updatedAt:123};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'clank-canary-cli-')),config=join(root,'config'),project=join(root,'project'),calls=[];
  await mkdir(config);await mkdir(join(project,'.clank'),{recursive:true});let failure=null;
  const server=createServer(async(req,res)=>{let bytes='';for await(const part of req)bytes+=part;calls.push({url:req.url,method:req.method,authorization:req.headers.authorization,body:bytes?JSON.parse(bytes):null});res.setHeader('content-type','application/json');
    if(failure){res.statusCode=failure;res.end(JSON.stringify({error:{code:'PROVIDER_CANARY_RECOVERY_REQUIRED',message:'Retained candidate cleanup is uncertain'}}));return;}
    res.end(JSON.stringify({ok:true,enabled:false,provider,canaries:[{releaseId:'release_exact',state:'interrupted',stage:0,trafficPercent:0,samples:3,errorRate:1/3,p95Ms:40,reason:'Restart interrupted measurement'}]}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  await writeFile(join(config,'config.json'),JSON.stringify({version:1,current:origin,profiles:{[origin]:{token:'clnk_private_canary_fixture',expiresAt:Date.now()+60000}}}));
  await writeFile(join(project,'.clank','project.json'),JSON.stringify({version:1,server:origin,projectId:'project_exact'}));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})});
  const run=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[cli,...args],{cwd:project,env:{...process.env,CLANK_HOME:config},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),15000);child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr})})});
  return {run,calls,project,fail(status){failure=status}};
}
test('canary CLI reads disabled-policy reports and sends only the explicit cleanup identity',async t=>{
  const f=await fixture(t),status=await f.run(['canary','status','--json']);assert.equal(status.code,0,status.stderr);assert.deepEqual(JSON.parse(status.stdout).provider,provider);
  const result=await f.run(['canary','recover',provider.operationId,'--expected-epoch','17','--json']);assert.equal(result.code,0,result.stderr);
  assert.deepEqual(f.calls.map(c=>[c.method,c.url,c.body]),[['GET','/api/projects/project_exact/canary',null],['POST','/api/projects/project_exact/canary/recover',{operationId:provider.operationId,expectedEpoch:17}]]);
  assert.ok(f.calls.every(c=>c.authorization==='Bearer clnk_private_canary_fixture'));assert.doesNotMatch(status.stdout+status.stderr+result.stdout+result.stderr,/clnk_private/);
});
test('canary CLI validates action-specific identity and epoch before any HTTP request',async t=>{
  const f=await fixture(t);
  for(const args of [['status','--expected-epoch','1'],['recover'],['recover','../bad','--expected-epoch','1'],['recover',provider.operationId],...['0','-1','1.5','9007199254740992'].map(v=>['recover',provider.operationId,'--expected-epoch',v]),['status',f.project,'extra'],['recover',provider.operationId,'--expected-epoch','17','--force']]){
    const result=await f.run(['canary',...args]);assert.equal(result.code,1,JSON.stringify({args,result}));
  }
  assert.equal(f.calls.length,0);
});
test('canary cleanup failures never auto-fetch a new epoch or resend the mutation',async t=>{
  const f=await fixture(t);f.fail(503);const result=await f.run(['canary','recover',provider.operationId,'--expected-epoch','17','--json']);assert.equal(result.code,1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.expectedEpoch,17);assert.match(result.stderr,/PROVIDER_CANARY_RECOVERY_REQUIRED/);assert.doesNotMatch(result.stdout+result.stderr,/clnk_private/);
});
test('canary CLI human output explains retained measurements and cleanup without promotion',async t=>{
  const f=await fixture(t),status=await f.run(['canary','status']);assert.equal(status.code,0,status.stderr);assert.match(status.stdout,/policy: disabled/);assert.match(status.stdout,/3 samples/);assert.match(status.stdout,/33.33% errors/);
  const result=await f.run(['canary','recover',provider.operationId,'--expected-epoch','17']);assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/does not promote a release/);
});
