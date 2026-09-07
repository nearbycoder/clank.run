import test from 'node:test';import assert from 'node:assert/strict';
import{parseCsv,planCsvImport,commitCsvImport}from'../dist/csv-import.js';
const columns=[{source:'name',target:'name',type:'text',required:true},{source:'age',target:'age',type:'integer',required:true},{source:'active',target:'active',type:'boolean'},{source:'date',target:'date',type:'date'}];
test('CSV supports quoted delimiters, doubled quotes, multiline cells, BOM, and configurable separators',()=>{
 const parsed=parseCsv('\uFEFFname,note\r\n"Ada, A.","Line one\nLine ""two"""\r\n');assert.deepEqual(parsed.headers,['name','note']);assert.deepEqual(parsed.rows, [['Ada, A.','Line one\nLine "two"']]);
 assert.deepEqual(parseCsv('a;b\n1;2',{delimiter:';'}).rows,[['1','2']]);
 for(const input of ['a,a\n1,2','a,b\n1','a\n"unclosed','a\n"closed"extra','a\nno"quote'])assert.throws(()=>parseCsv(input));
 assert.throws(()=>parseCsv('a\n1\n2',{maxRows:1}),/row limit/);
});
test('import reports required/type/duplicate evidence, excludes invalid rows, and detects duplicates against existing records',()=>{
 const text='name,age,active,date\nAda,30,true,2026-09-07\nBen,no,false,2026-02-30\n,2,perhaps,\nAda,40,1,2026-09-08';
 const plan=planCsvImport(text,{columns,uniqueBy:['name']});assert.equal(plan.ok,false);assert.equal(plan.records.length,1);assert.deepEqual(plan.records[0],{name:'Ada',age:30,active:true,date:'2026-09-07'});assert.ok(plan.issues.some(issue=>issue.row===3&&issue.column==='date'&&issue.code==='type'));assert.ok(plan.issues.some(issue=>issue.code==='duplicate'));assert.doesNotMatch(JSON.stringify(plan.issues),/perhaps|Ben/);
 const skipped=planCsvImport('name,age,active,date\nAda,30,true,\nBen,40,false,',{columns,uniqueBy:['name'],existing:[{name:'Ada'}],duplicates:'skip'});assert.equal(skipped.ok,true);assert.equal(skipped.skipped,1);assert.equal(skipped.records[0].name,'Ben');
 assert.throws(()=>planCsvImport('name\nA',{columns:[{source:'name',target:'__proto__',type:'text'}]}),/mapping/);
});
test('commit requires a real valid plan, serializes writes, retains retry identity, and rejects repeat success',async()=>{
 const plan=planCsvImport('name,age,active,date\nAda,30,true,2026-09-07',{columns});const keys=[];let release;const gate=new Promise(resolve=>release=resolve);
 const running=commitCsvImport(plan,async(records,context)=>{keys.push(context.idempotencyKey);assert.ok(Object.isFrozen(records[0]));await gate;throw new Error('transport failed')});
 await assert.rejects(commitCsvImport(plan,async()=>{}),/uncommitted/);release();await assert.rejects(running,/transport/);
 assert.equal(await commitCsvImport(plan,async(_records,context)=>{keys.push(context.idempotencyKey)}),1);assert.deepEqual(keys,[plan.id,plan.id]);await assert.rejects(commitCsvImport(plan,async()=>{}),/uncommitted/);
 await assert.rejects(commitCsvImport({...plan},async()=>{}),/uncommitted/);
 const bad=planCsvImport('name,age,active,date\nAda,bad,true,',{columns});await assert.rejects(commitCsvImport(bad,async()=>assert.fail('Must not write')));
});

test('a SQLite host transaction deduplicates a retried import after its committed response is lost',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE people(name TEXT PRIMARY KEY,age INTEGER);CREATE TABLE receipts(id TEXT PRIMARY KEY)');
 const plan=planCsvImport('name,age,active,date\nAda,30,true,2026-09-07',{columns});let lost=true;
 const commit=async(records,{idempotencyKey})=>{db.exec('BEGIN IMMEDIATE');try{if(!db.prepare('SELECT id FROM receipts WHERE id=?').get(idempotencyKey)){for(const row of records)db.prepare('INSERT INTO people(name,age)VALUES(?,?)').run(row.name,row.age);db.prepare('INSERT INTO receipts(id)VALUES(?)').run(idempotencyKey);}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error}if(lost){lost=false;throw new Error('response lost')}};
 try{await assert.rejects(commitCsvImport(plan,commit),/response lost/);assert.equal(await commitCsvImport(plan,commit),1);assert.equal(db.prepare('SELECT count(*) AS count FROM people').get().count,1);assert.equal(db.prepare('SELECT count(*) AS count FROM receipts').get().count,1);}finally{db.close()}
});
