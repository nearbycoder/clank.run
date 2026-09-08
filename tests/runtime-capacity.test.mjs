import test from 'node:test';
import assert from 'node:assert/strict';
import { defineAuth } from '../dist/auth.js';
import { defineBackend, defineDatabase, openBackend } from '../dist/backend.js';
import { parseDeploymentConfig } from '../dist/deploy.js';

test('capacity environment settings are bounded and explicit application options win', async t => {
  const names=['CLANK_AUTH_CONCURRENCY','CLANK_AUTH_MAX_QUEUE','CLANK_MAX_LIVE_CONNECTIONS'];
  const before=names.map(name=>process.env[name]);
  t.after(()=>names.forEach((name,index)=>before[index]===undefined?delete process.env[name]:process.env[name]=before[index]));
  for(const name of names)delete process.env[name];
  assert.equal(defineAuth().password.concurrency,2);
  process.env.CLANK_AUTH_CONCURRENCY='8';process.env.CLANK_AUTH_MAX_QUEUE='32';
  const auth=defineAuth();assert.equal(auth.password.concurrency,8);assert.equal(auth.password.maxQueue,32);
  assert.equal(auth.password.cost,2**17);assert.equal(auth.password.blockSize,8);
  assert.equal(defineAuth({password:{concurrency:1,maxQueue:1}}).password.concurrency,1);
  for(const value of ['0','17','1.5','NaN','']){
    process.env.CLANK_AUTH_CONCURRENCY=value;assert.throws(()=>defineAuth(),/CLANK_AUTH_CONCURRENCY/);
  }
  process.env.CLANK_AUTH_CONCURRENCY='2';process.env.CLANK_AUTH_MAX_QUEUE='129';
  assert.throws(()=>defineAuth(),/CLANK_AUTH_MAX_QUEUE/);delete process.env.CLANK_AUTH_MAX_QUEUE;
  const backend=defineBackend({schema:defineDatabase({})}).functions(({query})=>({read:query({args:{},handler:()=>1})}));
  process.env.CLANK_MAX_LIVE_CONNECTIONS='20001';
  await assert.rejects(openBackend(backend),/CLANK_MAX_LIVE_CONNECTIONS/);
  process.env.CLANK_MAX_LIVE_CONNECTIONS='1';
  for(const explicit of [false,true]){
    const runtime=await openBackend(backend,{agent:false,...(explicit?{maxLiveConnections:2}:{})});
    const bodies=[];
    try {
      for(let index=0;index<3;index++){
        const response=await runtime.handle(new Request('http://localhost/__clank/live/read?args=%7B%7D'));
        assert.equal(response.status,index<(explicit?2:1)?200:503);
        if(response.status===200)bodies.push(response.body);else await response.text();
      }
    }finally{await Promise.all(bodies.map(body=>body.cancel()));runtime.close();}
  }
});

test('deployment configuration permits only bounded application capacity names in the reserved namespace',()=>{
  const config=env=>({version:1,entry:'dist/server.js',include:['dist','migrations'],database:{path:'app.sqlite',migrations:'migrations'},env});
  const env={CLANK_AUTH_CONCURRENCY:'8',CLANK_AUTH_MAX_QUEUE:'32',CLANK_MAX_LIVE_CONNECTIONS:'6000',UV_THREADPOOL_SIZE:'16'};
  assert.deepEqual({...parseDeploymentConfig(config(env)).env},env);
  for(const [name,value] of [['CLANK_DATABASE_PATH','/tmp/other'],['CLANK_PLATFORM_MASTER_KEY','secret'],['CLANK_AUTH_CONCURRENCY','17'],['CLANK_AUTH_MAX_QUEUE','129'],['CLANK_MAX_LIVE_CONNECTIONS','20001'],['CLANK_MAX_LIVE_CONNECTIONS','0']]){
    assert.throws(()=>parseDeploymentConfig(config({[name]:value})),/reserved|integer/);
  }
});
