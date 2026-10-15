import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,copyFileSync,fstatSync,linkSync,lstatSync,mkdirSync,readdirSync,readlinkSync,renameSync,symlinkSync,unlinkSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createSQLiteDatabase,defineDatabase,defineTable,nativeSQLiteIdentityContext,openSQLite} from '../dist/backend.js';
import {s} from '../dist/ai.js';
import {SQLITE_INTERNAL} from '../dist/sqlite-internal.js';

const linux={skip:process.platform!=='linux'};
const schema=defineDatabase({records:defineTable({value:s.string()})});
const privateError=/genuine live unambiguous file-backed|identity changed|private namespace changed|closed/;
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'clank-native-identity-'));
  const path=join(root,'database.sqlite'),database=await openSQLite(schema,{path,changePollIntervalMs:0});
  t.after(async()=>{database.close();await rm(root,{recursive:true,force:true});});
  return {root,path,database};
}
function descriptors(path){
  return readdirSync('/proc/self/fd').flatMap(name=>{
    try{return readlinkSync(`/proc/self/fd/${name}`)===path?[{fd:Number(name),stat:fstatSync(Number(name))}]:[];}
    catch{return [];}
  });
}

test('native identity uses the original SQLite FD, stays immutable across commits, and releases its parent pin',linux,async t=>{
  const {root,path,database}=await fixture(t),context=nativeSQLiteIdentityContext(database);
  const file=lstatSync(path),parent=lstatSync(root);
  assert.deepEqual(context.identity,{canonicalPath:path,databaseDev:file.dev,databaseIno:file.ino,parentDev:parent.dev,parentIno:parent.ino,uid:process.getuid()});
  assert.ok(Object.isFrozen(context));assert.ok(Object.isFrozen(context.identity));
  assert.throws(()=>{context.identity.databaseIno=0;},TypeError);
  assert.throws(()=>{context.check=()=>{};},TypeError);
  assert.equal(descriptors(path).length,1,'identity must not open another database FD');
  assert.equal(descriptors(root).length,1,'only the original parent pin is retained');
  database.transaction(db=>db.table('records').insert({value:'managed commit'}));
  assert.equal(database.read(db=>db.table('records').collect())[0].value,'managed commit');
  assert.equal(nativeSQLiteIdentityContext(database),context);context.check();
  database.close();
  assert.throws(()=>nativeSQLiteIdentityContext(database),privateError);
  assert.throws(()=>context.check(),privateError);
  assert.equal(descriptors(path).length,0);assert.equal(descriptors(root).length,0);
});

test('native identity refuses structural copies, proxies, and getter-based claims without inspecting them',linux,async t=>{
  const {database}=await fixture(t);let reads=0;
  const claimed={get identity(){reads++;throw Error('must not inspect');},get [SQLITE_INTERNAL](){reads++;throw Error('must not inspect');}};
  const revoked=Proxy.revocable(database,{});revoked.revoke();
  for(const value of [{...database},new Proxy(database,{}),revoked.proxy,claimed,database[SQLITE_INTERNAL],{},null,undefined]){
    assert.throws(()=>nativeSQLiteIdentityContext(value),privateError);
  }
  assert.equal(reads,0);nativeSQLiteIdentityContext(database).check();
});

test('native identity refuses replaced database and internal methods before invoking replacement getters',linux,async t=>{
  const {database}=await fixture(t),context=nativeSQLiteIdentityContext(database),internal=database[SQLITE_INTERNAL];
  const original=Object.getOwnPropertyDescriptor(internal,'prepare');let reads=0;
  Object.defineProperty(internal,'prepare',{configurable:true,enumerable:true,get(){reads++;throw Error('must not invoke');}});
  assert.throws(()=>context.check(),privateError);assert.equal(reads,0);
  Object.defineProperty(internal,'prepare',original);context.check();
  const originalRead=database.read;database.read=()=>{};
  assert.throws(()=>nativeSQLiteIdentityContext(database),privateError);
  database.read=originalRead;context.check();
});

test('native identity rejects same-byte database replacement while its original descriptor remains open',linux,async t=>{
  const {path,database}=await fixture(t),context=nativeSQLiteIdentityContext(database),original=lstatSync(path);
  renameSync(path,`${path}.original`);copyFileSync(`${path}.original`,path);
  assert.notEqual(lstatSync(path).ino,original.ino);
  assert.equal(descriptors(`${path}.original`).length,1);
  assert.throws(()=>context.check(),privateError);
  assert.throws(()=>nativeSQLiteIdentityContext(database),privateError);
});

test('native identity rejects parent replacement even when the database retains its original inode and path',linux,async t=>{
  const {root,path,database}=await fixture(t),context=nativeSQLiteIdentityContext(database),original=lstatSync(path),moved=`${root}.original`;
  t.after(()=>rm(moved,{recursive:true,force:true}));
  renameSync(root,moved);mkdirSync(root,{mode:0o700});renameSync(join(moved,'database.sqlite'),path);
  assert.equal(lstatSync(path).ino,original.ino);assert.equal(lstatSync(path).nlink,1);
  assert.notEqual(lstatSync(root).ino,context.identity.parentIno);
  assert.throws(()=>context.check(),privateError);
});

test('native identity rejects extra database hardlinks and loss of private file or parent permissions',linux,async t=>{
  const {root,path,database}=await fixture(t),context=nativeSQLiteIdentityContext(database),alias=join(root,'alias.sqlite');
  linkSync(path,alias);assert.equal(lstatSync(path).nlink,2);assert.throws(()=>context.check(),privateError);
  unlinkSync(alias);context.check();
  for(const target of [path,root]){
    const mode=lstatSync(target).mode&0o777;chmodSync(target,mode|0o040);
    assert.throws(()=>context.check(),privateError);chmodSync(target,mode);context.check();
  }
});

test('in-memory and caller-created SQLite databases retain ordinary support without native identity',async()=>{
  const memory=await openSQLite(schema,{path:':memory:'}),compatible=createSQLiteDatabase(schema,new DatabaseSync(':memory:'));
  try{
    for(const database of [memory,compatible]){
      assert.throws(()=>nativeSQLiteIdentityContext(database),privateError);
      database.transaction(db=>db.table('records').insert({value:'ordinary'}));
      assert.equal(database.read(db=>db.table('records').collect()).length,1);
    }
  }finally{memory.close();compatible.close();}
});

test('noncanonical parent paths retain ordinary SQLite support without inferring native identity',linux,async t=>{
  const root=await mkdtemp(join(tmpdir(),'clank-native-identity-alias-'));t.after(()=>rm(root,{recursive:true,force:true}));
  mkdirSync(join(root,'actual'),{mode:0o700});symlinkSync(join(root,'actual'),join(root,'alias'));
  const database=await openSQLite(schema,{path:join(root,'alias','database.sqlite'),changePollIntervalMs:0});
  try{
    assert.throws(()=>nativeSQLiteIdentityContext(database),privateError);
    database.transaction(db=>db.table('records').insert({value:'ordinary alias'}));
    assert.equal(database.read(db=>db.table('records').collect())[0].value,'ordinary alias');
  }finally{database.close();}
});

test('a genuine SQLite open that reuses a deferred descriptor stays writable without inferred identity',linux,async t=>{
  const {path,database}=await fixture(t),original=nativeSQLiteIdentityContext(database);
  const second=await openSQLite(schema,{path,changePollIntervalMs:0});second.close();
  // SQLite retains the second connection's descriptor while the first remains
  // open, then reuses it. No newly opened FD can identify this constructor.
  const reused=await openSQLite(schema,{path,changePollIntervalMs:0});
  try{
    assert.throws(()=>nativeSQLiteIdentityContext(reused),privateError);
    reused.transaction(db=>db.table('records').insert({value:'deferred descriptor'}));
    assert.equal(database.read(db=>db.table('records').collect())[0].value,'deferred descriptor');
    original.check();
  }finally{reused.close();}
});
