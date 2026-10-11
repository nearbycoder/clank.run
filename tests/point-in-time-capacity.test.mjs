import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {s} from '../dist/ai.js';
import {openSQLite,defineDatabase,defineTable} from '../dist/backend.js';
import {createSQLiteTaskScope} from '../dist/sqlite-task.js';
import {openPointInTimeRecovery} from '../dist/point-in-time.js';

async function fixture(t,bounds){
  // All files and data here are owned trusted test inputs. Resource limits still
  // apply; this scope does not claim a namespace or untrusted-code boundary.
  const scope=await createSQLiteTaskScope('trusted-process');
  return scope.run(async()=>{
    const root=await mkdtemp(join(tmpdir(),'clank-pitr-capacity-')),path=join(root,'source.sqlite'),directory=join(root,'archive'),key=new Uint8Array(32).fill(17),
      schema=defineDatabase({records:defineTable({value:s.string()})}),database=await openSQLite(schema,{path}),
      recovery=await openPointInTimeRecovery(database,{directory,encryptionKey:key,exportIntervalMs:false,...bounds});
    t.after(()=>scope.run(async()=>{await recovery.close();database.close();await rm(root,{recursive:true,force:true});}));
    return {scope,root,path,directory,key,database,recovery};
  });
}

test('actual journal entry capacity rolls back data/revision/history and retains the exact encrypted epoch after reopening',async t=>{
  const f=await fixture(t,{maxJournalEntries:1});
  await f.scope.run(async()=>{
    const id=f.database.transaction(db=>db.table('records').insert({value:'accepted'})),version=f.database.version,before=f.recovery.status();
    const observer=new DatabaseSync(f.path,{readOnly:true});try{
      const envelope=observer.prepare('SELECT envelope FROM clank_pitr_journal WHERE sequence=1').get().envelope;
      assert.throws(()=>f.database.transaction(db=>db.table('records').patch(id,{value:'refused'})),/journal capacity/);
      assert.equal(f.database.version,version);assert.equal(f.database.read(db=>db.table('records').get(id)).value,'accepted');
      assert.deepEqual(f.recovery.status(),before);assert.equal(observer.prepare('SELECT envelope FROM clank_pitr_journal WHERE sequence=1').get().envelope,envelope);
      assert.equal(observer.prepare('SELECT count(*) AS count FROM clank_pitr_journal').get().count,1);
    }finally{observer.close();}
    await f.recovery.close();f.database.close();const reopened=await openSQLite(defineDatabase({records:defineTable({value:s.string()})}),{path:f.path}),manager=await openPointInTimeRecovery(reopened,{directory:f.directory,encryptionKey:f.key,exportIntervalMs:false,maxJournalEntries:1});
    try{assert.equal(manager.status().epoch,before.epoch);assert.throws(()=>reopened.transaction(db=>db.table('records').insert({value:'still refused'})),/journal capacity/);}
    finally{await manager.close();reopened.close();}
  });
});

test('actual encrypted envelope byte capacity refuses a first oversized commit without admitting data or a journal head',async t=>{
  const f=await fixture(t,{maxJournalBytes:1024});await f.scope.run(async()=>{
    const before=f.recovery.status(),version=f.database.version;
    assert.throws(()=>f.database.transaction(db=>db.table('records').insert({value:'x'.repeat(3000)})),/journal capacity/);
    assert.equal(f.database.version,version);assert.deepEqual(f.recovery.status(),before);assert.equal(f.database.read(db=>db.table('records').collect()).length,0);
    const observer=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(observer.prepare('SELECT count(*) AS count FROM clank_pitr_journal').get().count,0);}finally{observer.close();}
  });
});
