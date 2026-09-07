import test from 'node:test';import assert from 'node:assert/strict';
import{exportCsv,streamCsvExport,csvExportResponse}from'../dist/csv-export.js';
const columns=[{field:'name',label:'Name'},{field:'value',label:'Value'}];
test('CSV exports selected own fields with quotes, Unicode, multiline text and spreadsheet-safe formulas',()=>{
 const csv=exportCsv([{name:'Café, "team"',value:'line 1\nline 2'},{name:' =HYPERLINK("bad")',value:-4},{name:'\t@formula',value:true},{name:'ordinary',value:new Date('2026-09-07T00:00:00Z')}],columns,{bom:false});
 assert.equal(csv,'"Name","Value"\r\n"Café, ""team""","line 1\nline 2"\r\n"\' =HYPERLINK(""bad"")","-4"\r\n"\'\t@formula","true"\r\n"ordinary","2026-09-07T00:00:00.000Z"\r\n');
 assert.equal(exportCsv([Object.create({value:'private'})],[{field:'value',label:'=Label'}],{bom:false}),'"\'=Label"\r\n""\r\n');
 assert.equal(exportCsv([],columns).charCodeAt(0),0xfeff);
});
test('exports fail before returning partial buffered content and reject unsafe attachment filenames',()=>{
 assert.throws(()=>exportCsv([{name:'ok',value:Infinity}],columns),/finite/);assert.throws(()=>exportCsv([{name:'ok',value:{secret:true}}],columns),/cells/);
 assert.throws(()=>exportCsv([{name:'ok'},{name:'other'}],columns,{maxRows:1}),/row limit/);assert.throws(()=>exportCsv([],columns,{maxBytes:1}),/byte limit/);
 assert.throws(()=>csvExportResponse((async function*(){})(),columns,{filename:'../bad.csv'}),/filename/);
});
test('streaming honors backpressure and cancellation, and errors close the source iterator',async()=>{
 let reads=0,returns=0;const source={[Symbol.asyncIterator](){return {async next(){reads++;return{done:false,value:{name:'row',value:reads}}},async return(){returns++;return{done:true}}}}};
 const reader=streamCsvExport(source,columns,{bom:false}).getReader();await reader.read();assert.equal(reads,0);await reader.read();assert.equal(reads,1);await reader.cancel();assert.equal(returns,1);
 const limited=streamCsvExport(source,columns,{maxRows:1}).getReader();await limited.read();await limited.read();await assert.rejects(limited.read(),/row limit/);assert.equal(returns,2);
 const response=csvExportResponse((async function*(){yield{name:'a',value:2}})(),columns,{filename:'report.csv',bom:false});assert.equal(response.headers.get('content-disposition'),'attachment; filename="report.csv"');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(await response.text(),exportCsv([{name:'a',value:2}],columns,{bom:false}));
});
