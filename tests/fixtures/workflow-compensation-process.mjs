import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineDatabase, defineJobs, defineTable, defineWorkflow, defineWorkflows, openJobs, openSQLite, s } from '../../dist/index.js';

const credential='Bearer compensation-fixture-adapter';
export function compensationProcessSchema(){return defineDatabase({events:defineTable({value:s.string()}).owned()});}
export function compensationProcessDefinition(schema,providerUrl){
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(providerUrl))throw new Error('Fixture provider must use numeric loopback');
  const post=async(path,input,signal)=>{
    const response=await fetch(providerUrl+path,{method:'POST',headers:{authorization:credential,'content-type':'application/json',
      ...(path==='/undo'&&process.env.CLANK_COMPENSATION_HOLD==='1'?{'x-fixture-hold':'1'}:{})},
      body:JSON.stringify(input),signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
    if(!response.ok)throw new Error(`Fixture provider refused ${response.status}`);
    return response.json();
  };
  const jobs=defineJobs({schema}).jobs(({job})=>({
    reserve:job({args:{name:s.string(),fail:s.boolean()},returns:s.string(),agent:{idempotent:true},retry:{maxAttempts:1},
      handler:async(context,args)=>{await post('/reserve',{key:context.job.id,name:args.name},context.signal);
        if(args.fail)throw new Error('Injected later forward failure');return context.job.id;}}),
    release:job({args:{key:s.string(),original:s.string(),name:s.string()},
      returns:s.object({key:s.string(),original:s.string(),released:s.boolean()}),agent:{idempotent:true},
      retry:{maxAttempts:3,initialDelayMs:10,maxDelayMs:10,jitter:0},timeoutMs:10000,
      handler:(context,args)=>post('/undo',args,context.signal)}),
  }));
  const workflow=defineWorkflow({args:{fail:s.boolean()},graph:graph=>{
    const compensate={job:jobs.jobs.release,args:context=>({key:context.operationKey,original:context.forwardJobId,name:context.step})};
    const a=graph.step(jobs.jobs.reserve,{args:()=>({name:'a',fail:false}),compensate});
    const b=graph.step(jobs.jobs.reserve,{needs:[a],args:({input})=>({name:'b',fail:input.fail}),compensate});
    return {a,b};
  }});
  return {definition:defineWorkflows(jobs,{flow:workflow}),workflow};
}

async function provider(root){
  const db=new DatabaseSync(join(root,'provider.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,name TEXT NOT NULL,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY,input TEXT NOT NULL,receipt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT NOT NULL,duplicate INTEGER NOT NULL);`);
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!==credential){res.writeHead(401).end();return;}
    if(req.method==='GET'&&req.url==='/snapshot'){
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({resources:db.prepare('SELECT * FROM resources ORDER BY name').all(),
        operations:db.prepare('SELECT * FROM operations ORDER BY key').all(),requests:db.prepare('SELECT * FROM requests ORDER BY id').all()}));return;
    }
    if(req.method!=='POST'||!['/reserve','/undo'].includes(req.url)){res.writeHead(404).end();return;}
    let size=0,chunks=[];
    try{
      for await(const chunk of req){size+=chunk.length;if(size>8192)throw new Error('Body limit');chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!input||typeof input.key!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/.test(input.key)||!['a','b'].includes(input.name))throw new Error('Invalid operation');
      if(req.url==='/reserve'){
        const old=db.prepare('SELECT * FROM resources WHERE id=?').get(input.key);
        if(old&&old.name!==input.name){res.writeHead(409).end();return;}
        db.prepare("INSERT OR IGNORE INTO resources VALUES(?,?,'reserved')").run(input.key,input.name);
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:input.key}));return;
      }
      if(typeof input.original!=='string'||input.original.length>128)throw new Error('Invalid original identity');
      const resource=db.prepare('SELECT * FROM resources WHERE id=?').get(input.original);
      if(!resource||resource.name!==input.name){res.writeHead(409).end();return;}
      const canonical=JSON.stringify([input.key,input.original,input.name]);let receipt,duplicate=false;
      db.exec('BEGIN IMMEDIATE');
      try{
        const old=db.prepare('SELECT * FROM operations WHERE key=?').get(input.key);
        if(old){if(old.input!==canonical)throw new Error('Changed retry');receipt=JSON.parse(old.receipt);duplicate=true;}
        else{
          receipt={key:input.key,original:input.original,released:true};
          db.prepare("UPDATE resources SET state='released' WHERE id=?").run(input.original);
          db.prepare('INSERT INTO operations VALUES(?,?,?)').run(input.key,canonical,JSON.stringify(receipt));
        }
        db.prepare('INSERT INTO requests(key,duplicate) VALUES(?,?)').run(input.key,Number(duplicate));db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      process.send?.({event:'provider-accepted',receipt,duplicate});
      if(req.headers['x-fixture-hold']==='1')return;
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(receipt));
    }catch(error){res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({error:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.send?.({event:'ready',origin:`http://127.0.0.1:${server.address().port}`});
  const close=()=>{server.closeAllConnections();server.close(()=>{db.close();process.exit(0);});};
  process.once('SIGTERM',close);process.once('disconnect',close);
}
async function worker(root,origin,hold){
  if(hold)process.env.CLANK_COMPENSATION_HOLD='1';
  const schema=compensationProcessSchema(),{definition}=compensationProcessDefinition(schema,origin);
  const database=await openSQLite(schema,{path:join(root,'app.sqlite'),changePollIntervalMs:0});
  const runtime=openJobs(definition,{database});let chain=Promise.resolve();
  process.on('message',message=>{
    chain=chain.then(async()=>{
      try{
        const result=message.command==='work'?await runtime.workOnce({workerId:`fixture-${process.pid}`,leaseMs:1000})
          :message.command==='advance'?runtime.advanceWorkflows():null;
        process.send?.({id:message.id,result});
      }catch(error){process.send?.({id:message.id,error:error.message});}
    });
  });
  process.send?.({event:'ready',pid:process.pid});
  const close=()=>{runtime.close();database.close();process.exit(0);};
  process.once('SIGTERM',close);process.once('disconnect',close);
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [mode,root,origin]=process.argv.slice(2);
  if(mode==='provider')await provider(root);
  else if(mode==='worker'||mode==='worker-hold')await worker(root,origin,mode==='worker-hold');
  else throw new Error('Unknown fixture process role');
}
