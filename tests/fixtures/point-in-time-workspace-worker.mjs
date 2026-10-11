import {readFileSync,readdirSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createSQLiteTaskScope} from '../../dist/sqlite-task.js';
import {restorePointInTimeArchive} from '../../dist/point-in-time.js';
const [inputPath,readyPath,resultPath,phase]=process.argv.slice(2),input=JSON.parse(readFileSync(inputPath,'utf8'));
const initial=new Set(readdirSync(input.root)),encrypted=input.archive.files.find(file=>file.name.endsWith('/database.enc')).name;
const scope=await createSQLiteTaskScope('trusted-process');
try{
  await scope.run(()=>restorePointInTimeArchive(input.archive,{...input.options,encryptionKey:new Uint8Array(input.key),assertCurrent(){
    for(const name of readdirSync(input.root)){
      if(initial.has(name))continue;
      const archive=name.startsWith('clank-pitr-archive-')||name.startsWith('.clank-pitr-')&&name.endsWith('-archive');
      const replay=name.startsWith('clank-pitr-')&&!archive||name.startsWith('.clank-pitr-')&&name.endsWith('-replay');
      if((phase==='archive'&&archive&&existsSync(join(input.root,name,encrypted)))||(phase==='replay'&&replay&&existsSync(join(input.root,name,'replay.sqlite')))){
        writeFileSync(readyPath,JSON.stringify({pid:process.pid,workspace:name,phase}),{flag:'wx',mode:0o600});
        // Hold the actual post-extraction/replay boundary until this owned child is killed.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);
        throw new Error('Owned interruption fixture was not killed at its boundary.');
      }
    }
  }}));
  writeFileSync(resultPath,JSON.stringify({restored:true}),{flag:'wx'});
}catch(error){writeFileSync(resultPath,JSON.stringify({code:error.code??null,message:error.message}),{flag:'wx'});}
