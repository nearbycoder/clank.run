import {DatabaseSync} from 'node:sqlite';
import {existsSync,readlinkSync} from 'node:fs';

// Executed as source text in an actual prepareSQLiteSandbox namespace, not
// imported into the host controller. Only this tenant directory is granted.
const input=JSON.parse(process.argv[1]);
const namespaces=Object.fromEntries(['mnt','pid','net','user'].map(name=>[name,readlinkSync(`/proc/self/ns/${name}`)]));
const visible=input.denied.map(path=>existsSync(path));
const db=new DatabaseSync(input.path,{readOnly:input.mode!=='write-probe'});
let result;
try{
  db.exec('PRAGMA busy_timeout=25');
  if(input.mode==='write-probe'){
    try{db.exec("INSERT INTO clank_meta VALUES('foreign_namespace_probe',1)");result={committed:true};}
    catch(error){result={committed:false,code:error.code,errcode:error.errcode,message:error.message};}
  }else{
    db.exec('PRAGMA query_only=ON;BEGIN');
    const has=name=>Boolean(db.prepare('SELECT 1 FROM sqlite_schema WHERE type=\'table\' AND name=?').get(name));
    result={rows:db.prepare('SELECT _data FROM clank_records ORDER BY _data').all().map(row=>JSON.parse(row._data).value),
      capture:db.prepare('SELECT epoch,sequence,digest,state_hash,committed_at,remote_exports_protocol FROM clank_pitr_state').get(),
      journal:db.prepare('SELECT * FROM clank_pitr_journal ORDER BY sequence').all(),
      seal:has('clank_pitr_source_seal')?db.prepare('SELECT * FROM clank_pitr_source_seal').all():[],
      transfer:has('clank_pitr_transfer_state')?db.prepare('SELECT * FROM clank_pitr_transfer_state').all():[],
      receipts:has('clank_pitr_transfer_receipts')?db.prepare('SELECT * FROM clank_pitr_transfer_receipts ORDER BY sequence').all():[],
      integrity:db.prepare('PRAGMA integrity_check').get().integrity_check};
    db.exec('COMMIT');
  }
}finally{db.close();}
process.stdout.write(JSON.stringify({namespaces,visible,result})+'\n');
// Keep both observation namespaces alive concurrently, so inode inequality
// cannot be explained by destruction and later namespace inode reuse.
await new Promise(resolve=>process.stdin.once('data',resolve));
process.stdin.destroy();
