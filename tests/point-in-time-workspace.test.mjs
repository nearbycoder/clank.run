import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {s} from '../dist/ai.js';
import {openSQLite,defineDatabase,defineTable} from '../dist/backend.js';
import {createSQLiteTaskScope} from '../dist/sqlite-task.js';
import {openPointInTimeRecovery,exportPointInTimeRecovery,restorePointInTimeArchive} from '../dist/point-in-time.js';
const schema=defineDatabase({records:defineTable({value:s.string()})}),worker=fileURLToPath(new URL('./fixtures/point-in-time-workspace-worker.mjs',import.meta.url));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function exists(path){try{await readFile(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
for(const phase of ['archive','replay'])test(`SIGKILL after native ${phase} materialization blocks exact retry without another workspace`,async t=>{
  const scope=await createSQLiteTaskScope('trusted-process');
  await scope.run(async()=>{
    const root=await mkdtemp(join(tmpdir(),'clank-pitr-workspace-proof-')),key=new Uint8Array(32).fill(71),database=await openSQLite(schema,{path:join(root,'source.sqlite')});let recovery;
    t.after(()=>scope.run(async()=>{await recovery?.close();database.close();await rm(root,{recursive:true,force:true});}));
    recovery=await openPointInTimeRecovery(database,{directory:join(root,'repository'),encryptionKey:key,exportIntervalMs:false});
    database.transaction(db=>db.table('records').insert({value:'Owned workspace interruption ledger'}));const archive=await exportPointInTimeRecovery(recovery),targetPath=join(root,'destination.sqlite');
    const input=join(root,'request.json');await writeFile(input,JSON.stringify({root,key:Array.from(key),archive,options:{targetPath,confirmation:'restore point in time',throughSequence:archive.sequence,expectedEpoch:archive.epoch,expectedSequence:archive.sequence,expectedDigest:archive.digest}}),{flag:'wx',mode:0o600});
    await writeFile(join(root,'unrelated-sentinel'),'preserve unrelated owned sentinel',{flag:'wx'});
    const attempts=[];
    for(let attempt=1;attempt<=2;attempt++){
      const readyPath=join(root,'ready-'+attempt+'.json'),resultPath=join(root,'result-'+attempt+'.json');
      const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',worker,input,readyPath,resultPath,phase],{env:{...process.env,TMPDIR:root},stdio:['ignore','pipe','pipe']});
      let diagnostic='';child.stdout.on('data',value=>diagnostic+=value);child.stderr.on('data',value=>diagnostic+=value);
      const exit=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('exit',(code,signal)=>resolve({code,signal}));});
      t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit;}});
      const until=Date.now()+15000;let ready;
      while(Date.now()<until&&child.exitCode===null&&child.signalCode===null){if(await exists(readyPath)){ready=JSON.parse(await readFile(readyPath,'utf8'));break;}await delay(10);}
      if(ready){assert.equal(ready.pid,child.pid);assert.equal(ready.phase,phase);assert.equal(child.kill('SIGKILL'),true);assert.equal((await exit).signal,'SIGKILL');attempts.push({killed:true,workspace:ready.workspace});}
      else{const ended=await exit;assert.equal(ended.error,undefined);assert.equal(ended.code,0,diagnostic);attempts.push(JSON.parse(await readFile(resultPath,'utf8')));}
    }
    assert.equal(attempts[0].killed,true,'First attempt must reach actual materialized native files.');
    const workspaces=(await readdir(root)).filter(name=>name.startsWith('clank-pitr-')||name.startsWith('.clank-pitr-'));
    assert.equal(workspaces.length,phase==='archive'?1:2,'Killed attempts must not accumulate more materialized workspaces: '+JSON.stringify({attempts,workspaces}));
    assert.equal(attempts[1].code,'EEXIST','Exact retry must preserve the possible old worker workspace and refuse a new one.');
    assert.equal(await exists(targetPath),false);assert.equal(await readFile(join(root,'unrelated-sentinel'),'utf8'),'preserve unrelated owned sentinel');
  });
});

test('an unknown symbolic-link workspace is preserved without following it or publishing a destination',async t=>{
  const scope=await createSQLiteTaskScope('trusted-process');await scope.run(async()=>{
    const root=await mkdtemp(join(tmpdir(),'clank-pitr-workspace-link-')),key=new Uint8Array(32).fill(71),database=await openSQLite(schema,{path:join(root,'source.sqlite')});let recovery;
    t.after(()=>scope.run(async()=>{await recovery?.close();database.close();await rm(root,{recursive:true,force:true});}));
    recovery=await openPointInTimeRecovery(database,{directory:join(root,'repository'),encryptionKey:key,exportIntervalMs:false});database.transaction(db=>db.table('records').insert({value:'owned ledger'}));const archive=await exportPointInTimeRecovery(recovery),targetPath=join(root,'destination.sqlite'),foreign=join(root,'unknown-files');await mkdir(foreign);await writeFile(join(foreign,'sentinel'),'preserve unknown linked contents',{flag:'wx'});
    const workspace=join(root,'.clank-pitr-'+createHash('sha256').update(targetPath).digest('hex')+'-archive');await symlink(foreign,workspace);
    await assert.rejects(restorePointInTimeArchive(archive,{encryptionKey:key,targetPath,confirmation:'restore point in time',throughSequence:archive.sequence,expectedEpoch:archive.epoch,expectedSequence:archive.sequence,expectedDigest:archive.digest}),{code:'EEXIST'});
    assert.equal(await readFile(join(foreign,'sentinel'),'utf8'),'preserve unknown linked contents');assert.equal(await exists(targetPath),false);
  });
});
