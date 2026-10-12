import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openBackend,defineBackend,defineDatabase,defineTable} from '../../dist/backend.js';
import {defineJobs} from '../../dist/jobs.js';
import {s} from '../../dist/ai.js';
const [mode,root]=process.argv.slice(2),path=join(root,'source.sqlite');
const schema=defineDatabase({records:defineTable({value:s.string()})});
let backend=defineBackend({schema}).functions(()=>({})),options={path,agent:false,changePollIntervalMs:0},reads=0,closes=0;
if(mode==='ordinary'){
 const first=await openBackend(backend,options),second=await openBackend(backend,{...options,path:join(root,'ordinary.sqlite')});
 try{for(const runtime of [first,second]){runtime.database.transaction(tx=>tx.table('records').insert({value:'ordinary'}));assert.equal(runtime.database.read(tx=>tx.table('records').collect()).length,1);}}finally{first.close();second.close();}
}else{
 const slot=Symbol.for('clank.provider.source.startup.v1'),descriptor={value:'{}',writable:false,enumerable:false,configurable:true};
 if(['accessor','polluted-accessor'].includes(mode)){delete descriptor.value;delete descriptor.writable;descriptor.get=()=>{reads++;throw Error('must not invoke bootstrap getter');};}
 if(mode==='writable')descriptor.writable=true;
 if(mode==='enumerable')descriptor.enumerable=true;
 if(mode==='fixed')descriptor.configurable=false;
 if(mode==='non-string')descriptor.value=Object.freeze({get protocol(){reads++;throw Error('must not inspect supplied value');}});
 if(mode==='oversized')descriptor.value=' '.repeat(16385);
 if(mode==='utf8')descriptor.value='界'.repeat(6000);
 if(mode==='jobs')backend={...backend,jobs:defineJobs({schema}).jobs(()=>({}))};
 const supplied={get database(){reads++;throw Error('must not read supplied database');}};
 if(mode==='database')Object.defineProperty(options,'database',Object.getOwnPropertyDescriptor(supplied,'database'));
 if(mode==='inherited-database')options=Object.assign(Object.create(supplied),options);
 const originalClose=DatabaseSync.prototype.close,cleanup=Error('original native close acknowledgment lost');
 DatabaseSync.prototype.close=function(){originalClose.call(this);closes++;if(mode==='cleanup')throw cleanup;};
 Object.defineProperty(globalThis,slot,descriptor);
 if(mode==='polluted-accessor')Object.defineProperty(Object.prototype,'value',{get(){reads++;throw Error('must not read inherited descriptor value');},configurable:true});
 const pending=openBackend(backend,options);pending.catch(()=>{});
 assert.equal(fs.existsSync(path),false,'claim must run before the first native open await');
 await assert.rejects(openBackend(backend,{path:join(root,'retry.sqlite'),agent:false,changePollIntervalMs:0}),/constructor is already reserved/);
 let failed;await assert.rejects(pending,error=>{failed=error;return true;});
 if(mode==='polluted-accessor')delete Object.prototype.value;
 if(mode==='cleanup'){assert.ok(failed instanceof AggregateError);assert.equal(failed.errors.length,2);assert.match(failed.errors[0].message,/Invalid source bootstrap/);assert.equal(failed.errors[1],cleanup);}
 else assert.match(failed.message,mode==='bad-protocol'?/Invalid source bootstrap/:mode==='fixed'?/could not be consumed/:['jobs','database','inherited-database'].includes(mode)?/native database without background jobs/:/bounded own data/);
 assert.equal(reads,0);assert.equal(fs.existsSync(join(root,'retry.sqlite')),false);
 assert.equal(Object.hasOwn(globalThis,slot),mode==='fixed');
 assert.equal(closes,['bad-protocol','cleanup'].includes(mode)?1:0);
 assert.equal(fs.existsSync(path),['bad-protocol','cleanup'].includes(mode));
 const retained=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{const p=fs.readlinkSync('/proc/self/fd/'+fd);return p===path||p.startsWith(path+'-')?[p]:[];}catch{return [];}});
 assert.deepEqual(retained,[]);DatabaseSync.prototype.close=originalClose;
}
process.stdout.write(JSON.stringify({mode,passed:true,reads,closes})+'\n');
