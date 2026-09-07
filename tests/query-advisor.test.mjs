import assert from 'node:assert/strict';
import test from 'node:test';
import { defineDatabase, defineTable, openSQLite, defineBackend, openBackend } from '../dist/backend.js';
import { s } from '../dist/ai.js';
import { adviseQueries } from '../dist/query-advisor.js';
import { createDevtools, renderDevtools } from '../dist/devtools.js';
import { SQLITE_INTERNAL } from '../dist/sqlite-internal.js';
const schema = () => defineDatabase({ rows: defineTable({ category: s.string(), title: s.string() }).owned() });
test('real SQLite plans identify a candidate index without retaining query values or owners', async () => {
 const db = await openSQLite(schema(), { queryDiagnostics: true });
 try {
  db.transaction(w => { for(let i=0;i<100;i++) w.table('rows').insert({category:'private-category',title:'private-title-'+i}); },{userId:'private-owner'});
  const query=()=>db.read(r=>r.table('rows').query().where('category','private-category').orderBy('title').collect(),{userId:'private-owner'});
  for(let i=0;i<25;i++) assert.equal(query().length,100);
  const [evidence]=db.inspectDatabaseQueries();
  assert.equal(evidence.runs,25);
  assert.equal(evidence.rows,2500);
  assert.ok(evidence.maximumMs>=0);
  assert.match(evidence.suggestedIndex,/_owner_id/);
  assert.match(evidence.suggestedIndex,/category/);
  assert.match(evidence.suggestedIndex,/title/);
  const [advice]=adviseQueries([evidence],{slowMs:0});
  assert.ok(advice.findings.some(x=>x.includes('Repeated')));
  assert.ok(advice.findings.some(x=>x.includes('Slow')));
  assert.doesNotMatch(JSON.stringify(advice),/private-category|private-title|private-owner/);
  db[SQLITE_INTERNAL].exec(evidence.suggestedIndex);
  const improved=db[SQLITE_INTERNAL].prepare('EXPLAIN QUERY PLAN '+evidence.sql).all('private-owner','private-category').map(row=>row.detail).join(' ');
  assert.match(improved,/clank_rows_advisor/);
  assert.doesNotMatch(improved,/TEMP B-TREE/);
  assert.equal(query().length,100);
 } finally { db.close(); }
});
test('disabled diagnostics remain empty and point lookups show repetitions without exposing IDs',async()=>{
 const db=await openSQLite(schema());
 try { db.read(r=>r.table('rows').collect()); assert.deepEqual(db.inspectDatabaseQueries(),[]); } finally { db.close(); }
 const observed=await openSQLite(schema(),{queryDiagnostics:true});
 try {
  const id=observed.transaction(w=>w.table('rows').insert({category:'hidden',title:'hidden'}),{userId:'owner-hidden'});
  for(let i=0;i<30;i++) observed.read(r=>r.table('rows').get(id),{userId:'owner-hidden'});
  const [query]=observed.inspectDatabaseQueries();
  assert.equal(query.runs,30);assert.equal(query.suggestedIndex,null);
  assert.doesNotMatch(JSON.stringify(query),new RegExp(id));
  assert.ok(query.plan.some(p=>p.startsWith('SEARCH ')));
  assert.throws(()=>adviseQueries([query],{slowMs:NaN}));
 } finally { observed.close(); }
});
test('backend and local DevTools expose SQL advice and escape custom diagnostic text',async()=>{
 const definition=defineBackend({schema:defineDatabase({rows:defineTable({title:s.string()})})}).functions(({query})=>({list:query({args:{},handler:({db})=>db.table('rows').collect()})}));
 const backend=await openBackend(definition,{queryDiagnostics:true,diagnostics:true});
 const inspector=createDevtools({queries:()=>backend.inspectQueries(),databaseQueries:()=>backend.inspectDatabaseQueries()});
 try {
  backend.query('list',{});
  const snapshot=inspector.snapshot();assert.equal(snapshot.queryAdvice.length,1);
  assert.match(renderDevtools(snapshot),/Database query advisor/);
  const malicious={...snapshot,queryAdvice:[{query:{...snapshot.queryAdvice[0].query,sql:'<script>bad</script>'},findings:['<img>']}]};
  assert.doesNotMatch(renderDevtools(malicious),/<script>|<img>/);
  inspector.dispose();assert.equal(inspector.snapshot().queryAdvice,undefined);
 } finally { inspector.dispose();backend.close(); }
});
