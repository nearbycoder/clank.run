// Run from the repository root: node reports/twenty-improvements-2026-10-17/benchmark.mjs
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createLocalSearchIndex as after} from '../../dist/local-search.js';
const directory=await mkdtemp(join(tmpdir(),'clank-search-baseline-'));
try{
 const path=join(directory,'baseline.ts');
 await writeFile(path,execFileSync('git',['show','d0efb303489a5bf430da3d84a4cb66d899dde1f3:src/local-search.ts']));
 const {createLocalSearchIndex:before}=await import(pathToFileURL(path).href);
 const docs=Array.from({length:3000},(_,i)=>({id:String(i),title:`Document ${i}`,body:`prefix${i} alpha beta gamma`}));
 const measurements={before:[],after:[]};
 for(let round=0;round<9;round++)for(const [name,create] of (round%2?[['after',after],['before',before]]:[['before',before],['after',after]])){
  const index=create();let start=performance.now();index.replace(docs);const replaceMs=performance.now()-start;
  start=performance.now();for(let i=0;i<100;i++)index.search('pre');const prefix100Ms=performance.now()-start;
  if(round>1)measurements[name].push({replaceMs,prefix100Ms});
 }
 const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
 console.log(JSON.stringify({node:process.versions.node,documents:docs.length,runs:7,medians:Object.fromEntries(Object.entries(measurements).map(([name,runs])=>[name,{replaceMs:median(runs.map(x=>x.replaceMs)),prefix100Ms:median(runs.map(x=>x.prefix100Ms))}]))},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
