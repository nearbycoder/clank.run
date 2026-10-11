import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {defineDatabase,defineTable,defineBackend,defineAuth,openBackend,openSQLite,openPostgres,DatabaseConflictError,s} from '../dist/index.js';
const privateSettings=process.env.CLANK_POSTGRES_TEST_SETTINGS;
const settings=privateSettings?JSON.parse(await readFile(privateSettings,'utf8')):undefined;
const namespace=()=> 'contract_'+randomBytes(12).toString('hex');
const schema=()=>defineDatabase({notes:defineTable({title:s.string({min:1}),count:s.number(),done:s.boolean()}),secrets:defineTable({title:s.string()}).owned()});

for(const dialect of ['sqlite','postgres']) {
  const options={skip:dialect==='postgres'&&!settings?'Run scripts/verify-postgres.mjs against an owned native cluster.':false};
  async function fixture(t,definition=schema()) {
    const root=await mkdtemp(join(tmpdir(),'clank-portable-contract-')),n=namespace(),instances=[];
    const open=async()=>{const db=dialect==='sqlite'?await openSQLite(definition,{path:join(root,'db.sqlite'),changePollIntervalMs:0}):await openPostgres(definition,{...settings,namespace:n,changePollIntervalMs:0});instances.push(db);return db;};
    t.after(async()=>{for(const db of instances)db.close();await rm(root,{recursive:true,force:true});});
    return {db:await open(),open,definition};
  }
  test(`${dialect}: generated tables validate inputs and roll back all tables and revisions`,options,async t=>{
    const f=await fixture(t),version=f.db.version;
    assert.throws(()=>f.db.transaction(db=>{db.table('notes').insert({title:'rolled back',count:1,done:false});db.table('secrets').insert({title:'private'});throw new Error('abort');},{userId:'alice'}),/abort/);
    assert.equal(f.db.version,version);assert.deepEqual(f.db.read(db=>db.table('notes').collect()),[]);assert.deepEqual(f.db.read(db=>db.table('secrets').collect(),{userId:'alice'}),[]);
    assert.throws(()=>f.db.transaction(db=>db.table('notes').insert({title:'',count:1,done:false})));assert.equal(f.db.version,version);
    const id=f.db.transaction(db=>db.table('notes').insert({title:"parameter ' $1 ; DROP TABLE",count:2,done:false}));
    assert.equal(f.db.read(db=>db.table('notes').get(id)).title,"parameter ' $1 ; DROP TABLE");assert.equal(f.db.version,version+1);
  });
  test(`${dialect}: server owner scopes isolate get, queries, writes and tracked dependencies`,options,async t=>{
    const {db}=await fixture(t);const alice=db.transaction(tx=>tx.table('secrets').insert({title:'alice'}),{userId:'alice'}),bob=db.transaction(tx=>tx.table('secrets').insert({title:'bob'}),{userId:'bob'});
    assert.equal(db.read(tx=>tx.table('secrets').get(bob),{userId:'alice'}),null);assert.deepEqual(db.read(tx=>tx.table('secrets').collect(),{userId:'alice'}).map(row=>row.title),['alice']);
    assert.equal(db.transaction(tx=>tx.table('secrets').patch(bob,{title:'stolen'}),{userId:'alice'}),null);assert.equal(db.transaction(tx=>tx.table('secrets').delete(bob),{userId:'alice'}),false);
    assert.throws(()=>db.read(tx=>tx.table('secrets').get(alice),{userId:null}));assert.throws(()=>db.transaction(tx=>tx.table('secrets').insert({title:'anonymous'}),{userId:null}));
    assert.equal(db.read(tx=>tx.table('secrets').collect()).length,2);
    const tracked=db.tracked(tx=>tx.table('secrets').get(alice),{userId:'alice'});assert.equal(tracked.dependencies[0].ownerId,'alice');assert.equal(tracked.value.title,'alice');
  });
  test(`${dialect}: immutable snapshots, no-op writes and optimistic conflicts agree`,options,async t=>{
    const {db}=await fixture(t);const id=db.transaction(tx=>tx.table('notes').insert({title:'original',count:1,done:false})),revision=db.version;
    const before=db.read(tx=>tx.table('notes').get(id));assert.ok(Object.isFrozen(before));assert.throws(()=>{before.title='changed';},TypeError);
    const noOp=db.transaction(tx=>tx.table('notes').patch(id,{count:1},{ifVersion:1}));assert.equal(noOp._version,1);assert.equal(db.version,revision);
    const updated=db.transaction(tx=>tx.table('notes').patch(id,{count:2},{ifVersion:1}));assert.equal(updated._version,2);assert.equal(db.version,revision+1);
    assert.throws(()=>db.transaction(tx=>tx.table('notes').replace(id,{title:'stale',count:3,done:false},{ifVersion:1})),DatabaseConflictError);
    assert.equal(db.read(tx=>tx.table('notes').get(id)).count,2);assert.equal(db.version,revision+1);
  });
  test(`${dialect}: bounded scalar selection and deterministic metadata ordering`,options,async t=>{
    const {db}=await fixture(t);db.transaction(tx=>{for(let count=0;count<6;count++)tx.table('notes').insert({title:'row '+count,count,done:count%2===0});});
    assert.deepEqual(db.read(tx=>tx.table('notes').query().where('count','gte',2).where('done',true).orderBy('count','desc').limit(2).collect()).map(row=>row.count),[4,2]);
    assert.equal(db.read(tx=>tx.table('notes').query().where('count','gt',9).first()),null);assert.throws(()=>db.read(tx=>tx.table('notes').query().where('unknown',1).collect()));
  });
  test(`${dialect}: retained contexts and async/nested callbacks cannot write after closure`,options,async t=>{
    const {db}=await fixture(t);let table,query;
    db.transaction(tx=>{table=tx.table('notes');query=table.query();});assert.throws(()=>table.insert({title:'escaped',count:1,done:false}));
    // PostgreSQL's documented subset additionally expires read/query handles.
    // Existing SQLite compatibility permits deferred standalone read builders.
    if(dialect==='postgres')assert.throws(()=>query.collect(),error=>error.code==='PG_CONTEXT_EXPIRED');
    assert.throws(()=>db.transaction(()=>db.transaction(()=>1)));assert.throws(()=>db.transaction(async tx=>{tx.table('notes').insert({title:'async',count:1,done:false});return 1;}),/synchronous/);
    assert.deepEqual(db.read(tx=>tx.table('notes').collect()),[]);
  });
  test(`${dialect}: two native sessions retain data, version conflicts and selective external changes`,options,async t=>{
    const f=await fixture(t),second=await f.open(),events=[];second.subscribe(event=>events.push(event));
    const id=f.db.transaction(tx=>tx.table('notes').insert({title:'durable',count:1,done:false}));assert.equal(second.version,f.db.version);assert.equal(events.length,1);assert.equal(events[0].all,undefined);assert.equal(events[0].records[0].id,id);
    const old=second.read(tx=>tx.table('notes').get(id));f.db.transaction(tx=>tx.table('notes').patch(id,{count:2},{ifVersion:old._version}));
    assert.throws(()=>second.transaction(tx=>tx.table('notes').delete(id,{ifVersion:old._version})),DatabaseConflictError);
    f.db.close();const reopened=await f.open();assert.equal(reopened.read(tx=>tx.table('notes').get(id)).count,2);assert.equal(reopened.version,2);
  });
  test(`${dialect}: actual generated HTTP functions share transactions and query invalidation`,options,async t=>{
    const definition=defineDatabase({notes:defineTable({title:s.string(),count:s.number(),done:s.boolean()})}),f=await fixture(t,definition);
    const contract=defineBackend({schema:definition}).functions(({publicQuery,publicMutation})=>({list:publicQuery({args:{},handler:({db})=>db.table('notes').query().orderBy('count').collect()}),add:publicMutation({args:{title:s.string(),count:s.number()},handler:({db},{title,count})=>db.table('notes').insert({title,count,done:false})})}));
    const runtime=await openBackend(contract,{database:f.db,agent:false});t.after(()=>runtime.close());
    assert.deepEqual(runtime.query('list',{}).value,[]);
    const request=(path,body)=>new Request('https://app.example.test/__clank/'+path,{method:'POST',headers:{origin:'https://app.example.test','content-type':'application/json'},body:JSON.stringify(body)});
    const response=await runtime.handle(request('mutation/add',{title:'native HTTP',count:7}));assert.equal(response.status,200);
    const result=await runtime.handle(request('query/list',{}));assert.equal(result.status,200);assert.equal((await result.json()).value[0].title,'native HTTP');assert.equal(runtime.query('list',{}).value.length,1);
    assert.equal((await runtime.handle(request('mutation/add',{title:'bad',count:'invalid'}))).status,422);assert.equal(f.db.version,1);
  });
}

test('PostgreSQL refuses invalid transport options without opening a socket',async()=>{
  const definition=schema(),base={host:'127.0.0.1',database:'unused',user:'unused',password:'unused'};
  for(const extra of [{host:'localhost',tls:'loopback'},{password:'non-ASCII-ä'},{tls:{rejectUnauthorized:false}},{timeoutMs:1},{maxRows:0},{namespace:'invalid;sql'},{host:'user@host'}])await assert.rejects(openPostgres(definition,{...base,...extra}),TypeError);
});

test('native PostgreSQL opens from an inline module entry point',{skip:!settings},async()=>{
  const entry=new URL('../dist/index.js',import.meta.url).href;
  const source=`import {readFile} from 'node:fs/promises';
    import {openPostgres,defineDatabase,defineTable,s} from ${JSON.stringify(entry)};
    const options=JSON.parse(await readFile(process.env.CLANK_POSTGRES_TEST_SETTINGS,'utf8'));
    const db=await openPostgres(defineDatabase({records:defineTable({title:s.string()})}),{...options,namespace:${JSON.stringify(namespace())}});
    try {const id=db.transaction(tx=>tx.table('records').insert({title:'inline native write'}));
      console.log(JSON.stringify({revision:db.version,title:db.read(tx=>tx.table('records').get(id)).title}));}
    finally {db.close();}`;
  for(const inputType of [['--input-type=module'],['--input-type','module']]) {
    const {stdout}=await promisify(execFile)(process.execPath,[...inputType,'--eval',source.replace(/contract_[a-f0-9]{24}/u,namespace())],{env:process.env,timeout:20000,maxBuffer:65536});
    assert.deepEqual(JSON.parse(stdout),{revision:1,title:'inline native write'});
  }
});

test('native PostgreSQL refuses unsupported services and operations before changing data',{skip:!settings},async t=>{
  const definition=schema(),db=await openPostgres(definition,{...settings,namespace:namespace()});t.after(()=>db.close());
  assert.deepEqual(db.unsupported,['history','aggregate','sqlite-services']);
  assert.throws(()=>db.read(tx=>tx.table('notes').history()),error=>error.code==='PG_OPERATION_UNSUPPORTED');
  assert.throws(()=>db.read(tx=>tx.table('notes').query().aggregate({})),error=>error.code==='PG_OPERATION_UNSUPPORTED');
  await assert.rejects(openBackend(defineBackend({schema:definition}).functions(({publicQuery})=>({list:publicQuery({args:{},handler:()=>[]})})),{database:db}),/public-table schema/);
  assert.equal(db.version,0);
  const publicSchema=defineDatabase({records:defineTable({title:s.string()})}),publicDb=await openPostgres(publicSchema,{...settings,namespace:namespace()});t.after(()=>publicDb.close());
  const publicDefinition=defineBackend({schema:publicSchema}).functions(({publicQuery})=>({list:publicQuery({args:{},handler:()=>[]})}));
  await assert.rejects(openBackend(publicDefinition,{database:publicDb,agentActivity:{maxEntries:2}}),/public functions/);
  await assert.rejects(openBackend(publicDefinition,{database:publicDb,organizationSecurity:{organizationId:"portable_company_01",policy:{}}}),/organization security/);
  const privateDefinition=defineBackend({schema:publicSchema,auth:defineAuth()}).functions(({query})=>({list:query({args:{},handler:()=>[]})}));
  await assert.rejects(openBackend(privateDefinition,{database:publicDb}),/public functions/);assert.equal(publicDb.version,0);
});

test('native PostgreSQL verifies TLS certificates and rejects credentials without disclosure',{skip:!settings},async()=>{
  const definition=schema();
  for(const extra of [{password:settings.password+'-incorrect'},{tls:{serverName:'wrong.example.invalid',ca:settings.tls.ca}},{tls:{}}]) {
    await assert.rejects(openPostgres(definition,{...settings,...extra,namespace:namespace()}),error=>{assert.ok(!String(error).includes(settings.password));assert.ok(!String(error).includes(settings.user));assert.ok(error.code.startsWith('PG_'));return true;});
  }
});

test('native PostgreSQL bounds rows/documents/writes and reconnects without replay',{skip:!settings},async t=>{
  const definition=schema(),db=await openPostgres(definition,{...settings,namespace:namespace(),maxRows:2,maxWrites:2});t.after(()=>db.close());
  assert.throws(()=>db.transaction(tx=>{for(let n=0;n<3;n++)tx.table('notes').insert({title:'row',count:n,done:false});}),error=>error.code==='PG_WRITE_LIMIT');assert.equal(db.version,0);
  assert.throws(()=>db.transaction(tx=>tx.table('notes').insert({title:'x'.repeat(65536),count:1,done:false})),error=>error.code==='PG_DOCUMENT_LIMIT');assert.equal(db.version,0);
  for(let n=0;n<3;n++)db.transaction(tx=>tx.table('notes').insert({title:'row',count:n,done:false}));
  assert.throws(()=>db.read(tx=>tx.table('notes').collect()),error=>error.code==='PG_ROW_LIMIT');assert.equal(db.read(tx=>tx.table('notes').query().limit(2).collect()).length,2);
  const revision=db.version;await db.reconnect();assert.equal(db.version,revision);assert.equal(db.read(tx=>tx.table('notes').query().orderBy('count').first()).count,0);
});

test('native PostgreSQL refuses another table operation after a real callback deadline',{skip:!settings},async t=>{
  const db=await openPostgres(schema(),{...settings,namespace:namespace(),timeoutMs:1000});t.after(()=>db.close());let refused=false;
  assert.throws(()=>db.transaction(tx=>{
    const table=tx.table('notes'),until=Date.now()+1100;
    while(Date.now()<until){ /* Actual caller delay, without replacing the clock. */ }
    assert.throws(()=>table.insert({title:'expired callback',count:1,done:false}),error=>error.code==='PG_TIMEOUT');refused=true;
  }),error=>error.code==='PG_TIMEOUT');
  assert.equal(refused,true);await db.reconnect();assert.equal(db.version,0);assert.deepEqual(db.read(tx=>tx.table('notes').collect()),[]);
});

async function message(child,kind) {
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(new Error('Owned PostgreSQL fixture message timed out.')),10000);const receive=value=>{if(value.kind===kind)finish(null,value);};const exited=()=>finish(new Error('Owned PostgreSQL fixture exited before its native observation.'));const finish=(error,value)=>{clearTimeout(timer);child.off('message',receive);child.off('exit',exited);error?reject(error):resolve(value);};child.on('message',receive);child.once('exit',exited);});
}

test('actual PostgreSQL COMMIT response loss reports unknown, poisons and reconnects without another write',{skip:!settings},async t=>{
  const child=fork(new URL('./fixtures/postgres-response-loss.mjs',import.meta.url),[],{env:{...process.env,CLANK_POSTGRES_PROXY_PORT:String(settings.port)},stdio:['ignore','ignore','ignore','ipc']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.send({kind:'stop'});await exited;}});
  const ready=await message(child,'ready'),n=namespace(),definition=defineDatabase({records:defineTable({title:s.string()})});
  const db=await openPostgres(definition,{...settings,host:'127.0.0.1',port:ready.port,tls:'loopback',namespace:n});t.after(()=>db.close());
  const armed=message(child,'armed');child.send({kind:'arm'});await armed;const dropped=message(child,'native-commit-acknowledgement-dropped');let id;
  assert.throws(()=>db.transaction(tx=>{id=tx.table('records').insert({title:'one actual write'});return id;}),error=>error.code==='PG_COMMIT_UNKNOWN');await dropped;
  assert.throws(()=>db.read(tx=>tx.table('records').get(id)),error=>error.code==='PG_RECONNECT_REQUIRED');
  await db.reconnect();assert.equal(db.version,1);const rows=db.read(tx=>tx.table('records').collect());assert.equal(rows.length,1);assert.equal(rows[0]._id,id);assert.equal(rows[0]._version,1);
});

test('actual writer SIGKILL retains native PostgreSQL data and revisions',{skip:!settings},async t=>{
  const n=namespace(),child=fork(new URL('./fixtures/postgres-process-write.mjs',import.meta.url),[],{env:{...process.env,CLANK_POSTGRES_PROCESS_NAMESPACE:n},stdio:['ignore','ignore','ignore','ipc']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal}))),committed=await message(child,'committed');
  child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');
  const definition=defineDatabase({records:defineTable({title:s.string()})}),db=await openPostgres(definition,{...settings,namespace:n});t.after(()=>db.close());
  assert.equal(db.version,committed.revision);assert.equal(db.read(tx=>tx.table('records').get(committed.id)).title,'actual committed process');assert.equal(db.read(tx=>tx.table('records').collect()).length,1);
});

test('native PostgreSQL rejects changed schemas and conservatively invalidates missed revisions',{skip:!settings},async t=>{
  const definition=schema(),n=namespace(),first=await openPostgres(definition,{...settings,namespace:n,changeRetentionRevisions:1}),second=await openPostgres(definition,{...settings,namespace:n}),events=[];
  t.after(()=>{first.close();second.close();});second.subscribe(event=>events.push(event));
  for(let count=0;count<3;count++)first.transaction(tx=>tx.table('notes').insert({title:'retained',count,done:false}));assert.equal(second.version,3);assert.equal(events.length,1);assert.equal(events[0].all,true);
  const reordered=defineDatabase({secrets:defineTable({title:s.string()}).owned(),notes:defineTable({done:s.boolean(),count:s.number(),title:s.string({min:1})})});
  const equivalent=await openPostgres(reordered,{...settings,namespace:n});t.after(()=>equivalent.close());assert.equal(equivalent.version,3);assert.equal(equivalent.read(tx=>tx.table('notes').collect()).length,3);
  const changed=defineDatabase({notes:defineTable({different:s.string()})});await assert.rejects(openPostgres(changed,{...settings,namespace:n}),error=>error.code==='PG_SCHEMA_MISMATCH');assert.equal(first.version,3);
});

test('actual native retention pruning cannot hide an observed PostgreSQL revision',{skip:!settings},async t=>{
  const n=namespace(),definition=defineDatabase({records:defineTable({title:s.string()})});
  const first=await openPostgres(definition,{...settings,namespace:n,changeRetentionRevisions:1});t.after(()=>first.close());
  const child=fork(new URL('./fixtures/postgres-retention-race.mjs',import.meta.url),[],{env:{...process.env,CLANK_POSTGRES_PROCESS_NAMESPACE:n},stdio:['ignore','ignore','ignore','ipc']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.send({kind:'stop'});await exited;}});
  const ready=await message(child,'ready');
  const reader=await openPostgres(definition,{...settings,namespace:n,host:'127.0.0.1',port:ready.port,tls:'loopback'});t.after(()=>reader.close());
  const events=[];reader.subscribe(event=>events.push(event));const id=first.transaction(tx=>tx.table('records').insert({title:'observed first'}));
  const armed=message(child,'armed');child.send({kind:'arm'});await armed;const pruning=message(child,'native-retention-pruned');
  assert.equal(reader.version,1);assert.deepEqual(await pruning,{kind:'native-retention-pruned',before:1,after:3});
  assert.equal(events.length,1);assert.ok(events[0].all===true||events[0].records.some(record=>record.id===id),'The observed revision must invalidate its actual changed record.');
  assert.equal(reader.version,3);assert.equal(reader.read(tx=>tx.table('records').collect()).length,3);
});
