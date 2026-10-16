// Disposable in-process A/B profiles. No listener, existing database, or production data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const match = /^--(baseline|candidate|rounds|output)=(.+)$/u.exec(argument);
  if (!match) throw new Error('Use --baseline, --candidate, --rounds, or --output.');
  return [match[1], match[2]];
}));
if (!options.baseline || !options.candidate) throw new Error('Specify both distribution directories.');
const rounds = Number(options.rounds ?? 5);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 9) throw new Error('Use 1–9 alternating rounds.');
const variants = {};
for (const variant of ['baseline', 'candidate']) {
  const directory = resolve(options[variant]);
  const load = name => import(pathToFileURL(join(directory, name + '.js')));
  variants[variant] = { directory, ...await load('local-search'), ...await load('backend'), ...await load('platform-status-pages') };
}
const percentile = (values, fraction) => [...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*fraction))];
const queries = ['entry09', 'tag09', 'detail099', 'zzmissing', 'entry0007', 'tag045'];
const documents = count => Array.from({length:count},(_,i)=>{const key=String(i).padStart(5,'0');return {id:'row-'+key,title:'Entry'+key+' catalogue',body:'Searchable record tag'+key+' detail'+key+'.'};});
const report = { protocol:'clank-search-status-performance/1', node:process.version,
  machine:{platform:platform(),arch:arch(),cpu:cpus()[0]?.model}, rounds, profiles:[] };
report.distributions = Object.fromEntries(await Promise.all(Object.entries(variants).map(async ([name,module])=>[name,{directory:module.directory,
  sha256:Object.fromEntries(await Promise.all(['local-search','platform-status-pages'].map(async file=>[file,createHash('sha256').update(await readFile(join(module.directory,file+'.js'))).digest('hex')])))}])));

function searchSample(module, count, kind) {
  const input=documents(count), index=module.createLocalSearchIndex();index.replace(input);
  const expected=queries.map(query=>index.search(query));
  assert.equal(index.size,count);assert.equal(index.search('catalogue',{prefix:false}).total,count);
  const iterations=kind==='replace'?10:kind==='cold-prefix'?10:300, durations=[];
  for(let i=0;i<3;i++)kind==='replace'?index.replace(input):index.search(queries[i]);
  let cpuMs=0,checksum=0;
  for(let i=0;i<iterations;i++){
    if(kind==='cold-prefix')index.replace(input); // excluded setup; vocabulary must be rebuilt
    const cpu=process.cpuUsage(),started=performance.now();
    const result=kind==='replace'?index.replace(input):index.search(queries[i%queries.length]);
    durations.push(performance.now()-started);const used=process.cpuUsage(cpu);cpuMs+=(used.user+used.system)/1000;
    checksum+=kind==='replace'?index.size:result.total+result.hits.length;
  }
  assert.ok(checksum>0);assert.equal(index.size,count);
  for(let i=0;i<queries.length;i++)assert.deepEqual(index.search(queries[i]),expected[i]);
  return {iterations,elapsedMs:durations.reduce((a,b)=>a+b,0),cpuMs,p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),checksum,expected};
}

async function statusSample(module, populated, kind) {
  const database=await module.openSQLite(module.defineDatabase({})),sql=database[Symbol.for('clank.sqlite.internal')];
  const project='performance_target_project',foreign='performance_foreign_project',binding='synthetic-private-binding';
  sql.exec('CREATE TABLE clank_platform_projects(id TEXT PRIMARY KEY)');
  sql.prepare('INSERT INTO clank_platform_projects VALUES(?),(?)').run(project,foreign);
  const authority={userId:'performance_subscriber',authorize(){},binding:()=>binding,audit(){}};
  const controller=module.openPlatformStatusPages(sql,{}, {hash:value=>createHash('sha256').update(value).digest('hex'),scope:()=>binding,incidentVersion:()=>1,domainReserved:()=>false,slo(){throw Error('No private source in this fixture.');}});
  try {
    const now=Date.now(),configuration={slug:'target-health',title:'Synthetic health',description:'Approved synthetic public text.',components:[{key:'checkout',label:'Checkout',source:{kind:'manual',health:'operational',observedAt:now-1000,expiresAt:now+3599000}}]};
    const page=controller.create(project,authority,{configuration,operationId:'performance_create_target'});
    const preview=controller.preview(project,authority,{expectedVersion:page.version,publication:{kind:'page'}});
    controller.publish(project,authority,{expectedVersion:preview.expectedVersion,previewId:preview.id,previewDigest:preview.digest,operationId:'performance_publish_target'});
    controller.create(foreign,authority,{configuration:{...configuration,slug:'foreign-health'},operationId:'performance_create_foreign'});
    const target=sql.prepare('SELECT id FROM clank_platform_status_pages WHERE project_id=?').get(project).id,other=sql.prepare('SELECT id FROM clank_platform_status_pages WHERE project_id=?').get(foreign).id;
    const updates=populated?10000:40,notifications=populated?50000:25,copy={title:'Synthetic update',message:'Approved public update.',state:'monitoring',components:['checkout']};
    const seedCpu=process.cpuUsage(),seedStarted=performance.now();
    sql.transaction(()=>{
      const update=sql.prepare('INSERT INTO clank_platform_status_updates(id,page_id,scope,copy,incident_id,incident_version,published_at) VALUES(?,?,?,?,NULL,NULL,?)');
      for(let i=0;i<updates;i++)update.run('performance_update_'+i,i<40?target:other,binding,JSON.stringify(copy),now);
      const notification=sql.prepare('INSERT INTO clank_platform_status_notifications(id,page_id,subscriber_id,update_id,record,created_at) VALUES(?,?,?,?,?,?)');
      for(let i=0;i<notifications;i++){
        const mine=i<25,updateId='performance_update_'+(mine?i:40+(i-25)%(updates-40)),record={id:'performance_notification_'+i,update:{...copy,id:updateId,publishedAt:now},createdAt:now};
        notification.run(record.id,mine?target:other,mine?authority.userId:'foreign_reader_'+Math.floor((i-25)/(updates-40)),updateId,JSON.stringify(record),now);
      }
    });
    const seedUsed=process.cpuUsage(seedCpu),seed={elapsedMs:performance.now()-seedStarted,cpuMs:(seedUsed.user+seedUsed.system)/1000};
    const cursor=kind==='empty-inbox'?0:20,reader=kind==='empty-inbox'?{...authority,userId:'performance_empty_subscriber'}:authority;
    const read=()=>kind==='public'?controller.publicPage(configuration.slug):controller.notifications(configuration.slug,reader,cursor);
    const validate=value=>{if(kind==='public')assert.deepEqual(value.updates.map(v=>v.id),Array.from({length:20},(_,i)=>'performance_update_'+(39-i)));else{assert.deepEqual(value.notifications.map(v=>v.id),kind==='empty-inbox'?[]:Array.from({length:5},(_,i)=>'performance_notification_'+(20+i)));assert.equal(value.next,null);const first=controller.notifications(configuration.slug,authority,0);assert.equal(first.notifications.length,20);assert.equal(first.next,20);}};
    validate(read());for(let i=0;i<10;i++)read();
    const durations=[],iterations=200,cpu=process.cpuUsage();let checksum=0;
    for(let i=0;i<iterations;i++){const started=performance.now(),value=read();durations.push(performance.now()-started);checksum+=kind==='public'?value.updates.length:value.notifications.length;}
    const used=process.cpuUsage(cpu);assert.equal(checksum,iterations*(kind==='public'?20:kind==='empty-inbox'?0:5));validate(read());
    const query=kind==='public'?'SELECT * FROM clank_platform_status_updates WHERE page_id=? AND scope=? ORDER BY sequence DESC LIMIT 20':'SELECT sequence,record FROM clank_platform_status_notifications WHERE page_id=? AND subscriber_id=? AND sequence>? ORDER BY sequence LIMIT 21';
    const parameters=kind==='public'?[target,binding]:[target,reader.userId,cursor];
    return {iterations,updates,notifications,elapsedMs:durations.reduce((a,b)=>a+b,0),cpuMs:(used.user+used.system)/1000,p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),checksum,seed,queryPlan:sql.prepare('EXPLAIN QUERY PLAN '+query).all(...parameters).map(row=>row.detail)};
  } finally {controller.close();database.close();}
}

const profiles=[
  {name:'replace-1000',run:module=>searchSample(module,1000,'replace')},
  {name:'replace-10000',run:module=>searchSample(module,10000,'replace')},
  {name:'warm-prefix-10000',run:module=>searchSample(module,10000,'prefix')},
  {name:'cold-prefix-10000',run:module=>searchSample(module,10000,'cold-prefix')},
  {name:'public-history-small',run:module=>statusSample(module,false,'public')},
  {name:'public-history-populated',run:module=>statusSample(module,true,'public')},
  {name:'inbox-tail-small',run:module=>statusSample(module,false,'inbox')},
  {name:'inbox-tail-populated',run:module=>statusSample(module,true,'inbox')},
  {name:'inbox-empty-populated',run:module=>statusSample(module,true,'empty-inbox')},
];
for(const profile of profiles){
  const samples=[];let expected;
  for(let round=0;round<rounds;round++)for(const variant of round%2?['candidate','baseline']:['baseline','candidate']){
    const sample=await profile.run(variants[variant]);if(sample.expected){if(expected)assert.deepEqual(sample.expected,expected);else expected=sample.expected;delete sample.expected;}
    samples.push({round:round+1,variant,...sample});
  }
  const medians=Object.fromEntries(['baseline','candidate'].map(variant=>[variant,Object.fromEntries(['elapsedMs','cpuMs','p50Ms','p95Ms'].map(key=>[key,percentile(samples.filter(s=>s.variant===variant).map(s=>s[key]),.5)]))]));
  const result={name:profile.name,samples,medians,elapsedReductionPercent:100*(1-medians.candidate.elapsedMs/medians.baseline.elapsedMs)};
  report.profiles.push(result);console.log(JSON.stringify({profile:result.name,medians,elapsedReductionPercent:result.elapsedReductionPercent}));
  if(options.output)await writeFile(resolve(options.output),JSON.stringify(report,null,2)+'\n');
}
