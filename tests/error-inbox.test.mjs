import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defineDatabase,openSQLite} from '../dist/backend.js';
import {openErrorInbox,renderErrorInbox} from '../dist/error-inbox.js';
import {createDevtools,renderDevtools} from '../dist/devtools.js';
function error(){const error=new Error('secret bearer token and private payload');error.stack='Error: secret message\n    at handler (file:///private/release/app.js?token=secret:1:1)';return error;}
test('error groups persist, map source locations, link releases/traces and reopen on recurrence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'clank-errors-')),path=join(root,'app.sqlite');let db=await openSQLite(defineDatabase({}),{path});let at=1000;
 try{
  let inbox=await openErrorInbox(db,{now:()=>at});
  for(const release of ['one','two'])inbox.registerSourceMap(release,'/private/release/app.js',{version:3,sources:['src/action.ts'],names:[],mappings:'AAAA',sourcesContent:['secret source code']});
  const fingerprint=inbox.capture(error(),{release:'one',code:'ACTION_FAILURE',traceId:'a'.repeat(32)});
  inbox.capture(error(),{release:'one',code:'ACTION_FAILURE'});
  assert.equal(inbox.snapshot().groups[0].occurrences,2);assert.equal(inbox.snapshot().groups[0].recent[0].frames[0].file,'src/action.ts');
  assert.equal(inbox.resolve(fingerprint,'two'),true);assert.equal(inbox.snapshot().groups[0].state,'resolved');
  at++;assert.equal(inbox.capture(error(),{release:'two',code:'ACTION_FAILURE'}),fingerprint);
  const report=inbox.snapshot({release:'two'});assert.equal(report.groups[0].state,'regressed');assert.equal(report.groups[0].releases.length,2);assert.equal(report.groups[0].resolvedIn,'two');
  assert.doesNotMatch(JSON.stringify(report),/secret|payload|bearer|private/);
  db.close();db=await openSQLite(defineDatabase({}),{path});inbox=await openErrorInbox(db,{now:()=>at});assert.equal(inbox.snapshot().groups[0].occurrences,3);
  const inspector=createDevtools({errorInbox:()=>inbox.snapshot()});assert.match(renderDevtools(inspector.snapshot()),/Release error inbox/);inspector.dispose();
 }finally{db.close();await rm(root,{recursive:true,force:true})}
});
test('retention bounds events/groups, rejects untrusted metadata and escapes rendering',async()=>{
 const db=await openSQLite(defineDatabase({}));let at=1000;
 try{const inbox=await openErrorInbox(db,{maxEvents:2,maxAgeMs:1000,now:()=>at});for(const code of ['ONE','TWO','THREE'])inbox.capture(error(),{release:'v1',code});assert.equal(inbox.snapshot().retainedEvents,2);assert.equal(inbox.snapshot().groups.length,2);
  assert.throws(()=>inbox.capture(error(),{release:'v1',traceId:'secret'}));assert.throws(()=>inbox.registerSourceMap('v1','/x.js',{version:2}));
  assert.doesNotMatch(renderErrorInbox({retainedEvents:1,groups:[{code:'<SCRIPT>',state:'open',occurrences:1,resolvedIn:null,releases:[],recent:[]}]}),/<script\b/iu);
  at+=1001;assert.equal(inbox.snapshot().groups.length,0);assert.equal(inbox.snapshot().retainedEvents,0);
 }finally{db.close()}
});
