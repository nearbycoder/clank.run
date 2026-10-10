import test from 'node:test';
import assert from 'node:assert/strict';
import {openSQLite,defineDatabase,defineTable,s} from '../dist/index.js';
const original=/original active database transaction/u;

test('retained native SQLite writers refuse every mutation outside the original transaction',async t=>{
  const db=await openSQLite(defineDatabase({records:defineTable({title:s.string()}).owned()}));t.after(()=>db.close());
  const scope={userId:'alice'},id=db.transaction(tx=>tx.table('records').insert({title:'original'}),scope);
  const cursor=db.read(tx=>tx.table('records').history(id)[0].cursor,scope);let context,table;
  db.transaction(tx=>{context=tx;table=tx.table('records');},scope);const revision=db.version;
  const operations=[()=>table.insert({title:'escaped'}),()=>table.patch(id,{title:'escaped'}),()=>table.replace(id,{title:'escaped'}),()=>table.delete(id),()=>table.purgeDeleted(id,cursor),()=>table.restore(id,cursor,{ifVersion:1})];
  assert.throws(()=>context.table('records'),original);
  for(const operation of operations)assert.throws(operation,original);
  assert.equal(db.version,revision);assert.equal(db.read(tx=>tx.table('records').get(id),scope).title,'original');assert.equal(db.read(tx=>tx.table('records').history(id),scope).length,1);
  // Read-only builders keep their existing deferred-read compatibility.
  assert.equal(table.query().collect()[0].title,'original');
});

test('an old SQLite writer cannot borrow another read, write or owner transaction',async t=>{
  const db=await openSQLite(defineDatabase({records:defineTable({title:s.string()}).owned()}));t.after(()=>db.close());
  let stale;db.transaction(tx=>{stale=tx.table('records');},{userId:'alice'});
  assert.throws(()=>db.transaction(()=>stale.insert({title:'borrowed writer'}),{userId:'alice'}),original);
  assert.throws(()=>db.transaction(()=>stale.insert({title:'borrowed owner'}),{userId:'bob'}),original);
  assert.throws(()=>db.read(()=>stale.insert({title:'borrowed reader'}),{userId:'alice'}),original);
  assert.equal(db.version,0);assert.deepEqual(db.read(tx=>tx.table('records').collect()),[]);
  db.transaction(tx=>tx.table('records').insert({title:'current writer'}),{userId:'bob'});assert.equal(db.version,1);assert.deepEqual(db.read(tx=>tx.table('records').collect(),{userId:'alice'}),[]);
});

test('an actually deferred async callback cannot commit through its retained SQLite table',async t=>{
  const db=await openSQLite(defineDatabase({records:defineTable({title:s.string()})}));t.after(()=>db.close());let deferred;
  assert.throws(()=>db.transaction(tx=>{
    const table=tx.table('records');deferred=(async()=>{await new Promise(resolve=>setTimeout(resolve,10));table.insert({title:'after rollback'});})();return deferred;
  }),/synchronous/u);
  await assert.rejects(deferred,original);assert.equal(db.version,0);assert.deepEqual(db.read(tx=>tx.table('records').collect()),[]);
});
