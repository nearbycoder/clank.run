import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Builds are read-only inputs. Open the printed loopback URL in a real browser.
// node scripts/load/performance-dom.mjs BASELINE_DIST CANDIDATE_DIST [PORT=33941]
const [baselinePath, candidatePath, portInput = "33941"] = process.argv.slice(2);
if (!baselinePath || !candidatePath) throw new Error("Provide baseline and candidate dist directories.");
const port = Number(portInput);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
const directories = { baseline: resolve(baselinePath), candidate: resolve(candidatePath) };
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clank keyed DOM performance</title><style>
body{font:16px system-ui;max-width:960px;margin:32px auto;padding:0 16px}button{font:inherit;padding:8px 16px}#viewport{height:360px;overflow:auto;border:1px solid;margin:16px 0}.row{height:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere}
</style><h1>Keyed DOM performance</h1><p>Synthetic loopback-only baseline/candidate comparison. Includes layout, retained node identity, index/label updates, and cleanup checks.</p>
<button id="run">Run A/B comparison</button><p id="status" role="status">Ready</p><div id="viewport"></div><pre id="results"></pre>
<script type="module">
const implementations = {};
for (const label of ['baseline','candidate']) {
 const [dom,core]=await Promise.all([import('/'+label+'/dom.js'),import('/'+label+'/core.js')]);
 implementations[label]={...dom,...core};
}
const viewport=document.querySelector('#viewport'),status=document.querySelector('#status');
const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const check=(condition,message)=>{if(!condition)throw new Error(message)};
function fixture(label,count){
 const {h,For,render,expression,signal}=implementations[label];
 const initial=Array.from({length:count},(_,id)=>({id,label:'Row '+id}));
 const state=signal(initial), root=document.createElement('div');viewport.replaceChildren(root);
 let mounted=0,cleaned=0;
 const stop=render(root,h(For,{each:state,by:'id'},(item,index)=>h('div',{
  class:'row','data-id':item.id,ref:node=>{if(node)mounted++;else cleaned++}
 },expression(()=>item.label+':'+index()))));
 root.offsetHeight;
 return {root,state,stop,mounted:()=>mounted,cleaned:()=>cleaned};
}
function nextItems(current,scenario,iteration,count){
 if(scenario==='last-to-first')return [current.at(-1),...current.slice(0,-1)];
 if(scenario==='prepend')return [{id:count+iteration,label:'New '+iteration},...current.slice(0,-1)];
 const next=current.slice(),index=iteration%count;
 next[index]={...next[index],label:'Edited '+iteration};return next;
}
function verify(f,previous,identities){
 const next=f.state.peek(),elements=Array.from(f.root.children);
 check(elements.length===next.length,'Wrong row count');
 for(let index=0;index<next.length;index++){
  const item=next[index],element=elements[index];
  check(element.dataset.id===String(item.id),'Wrong row order');
  check(element.textContent===item.label+':'+index,'Stale row label/index');
  if(identities.has(item.id))check(element===identities.get(item.id),'Retained row was remounted');
 }
 check(f.mounted()===previous.length+next.filter(item=>!identities.has(item.id)).length,'Unexpected mounts');
}
function runSample(label,count,scenario,iterations,instrument=false){
 const f=fixture(label,count),identities=new Map(Array.from(f.root.children,element=>[Number(element.dataset.id),element]));
 const initial=f.state.peek();let domInsertions=0,scriptMs=0,layoutMs=0;
 if(instrument){const insert=f.root.insertBefore;f.root.insertBefore=function(...args){domInsertions++;return insert.apply(this,args)}}
 try{
  for(let iteration=0;iteration<iterations;iteration++){
   const next=nextItems(f.state.peek(),scenario,iteration,count);
   let started=performance.now();f.state.value=next;scriptMs+=performance.now()-started;
   started=performance.now();f.root.offsetHeight;layoutMs+=performance.now()-started;
  }
  // Prepend samples may remove previously prepended rows only when iterations
  // exceed count; the bounded fixture below always keeps iterations < count.
  verify(f,initial,identities);
  check(f.cleaned()===(scenario==='prepend'?iterations:0),'Wrong disposal count');
 }finally{f.stop();check(f.cleaned()===f.mounted(),'Cleanup leak');check(f.root.childNodes.length===0,'Unmount left DOM nodes')}
 return {label,count,scenario,iterations,scriptMs,layoutMs,totalMs:scriptMs+layoutMs,...(instrument?{domInsertions}:{})};
}
document.querySelector('#run').onclick=async()=>{
 const button=document.querySelector('#run');button.disabled=true;window.benchmarkDone=false;
 const samples=[],work=[];
 try{
  for(const count of [1000,10000])for(const scenario of ['last-to-first','prepend','same-order-edit']){
   for(const label of ['baseline','candidate']){
    status.textContent='Warmup: '+label+' / '+count+' / '+scenario;await frame();
    work.push(runSample(label,count,scenario,1,true));runSample(label,count,scenario,3);
   }
   for(let round=0;round<5;round++)for(const label of round%2?['candidate','baseline']:['baseline','candidate']){
    status.textContent=label+' / '+count+' / '+scenario+' / round '+(round+1);await frame();
    samples.push({...runSample(label,count,scenario,10),round:round+1});
   }
  }
  window.benchmarkResult={protocol:'clank-keyed-dom-performance/1',userAgent:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight},rounds:5,iterations:10,work,samples};
  status.textContent='Complete — order, identity, reactivity, and cleanup checks passed';
 }catch(error){window.benchmarkResult={error:String(error),work,samples};status.textContent=String(error)}
 finally{document.querySelector('#results').textContent=JSON.stringify(window.benchmarkResult,null,2);window.benchmarkDone=true;button.disabled=false}
};
</script></html>`;
const server = createServer(async (request, response) => {
  try {
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page); return; }
    const match = /^\/(baseline|candidate)\/([a-z0-9-]+\.js)$/.exec(pathname);
    if (!match) { response.writeHead(404).end(); return; }
    const content = await readFile(resolve(directories[match[1]], match[2]));
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }).end(content);
  } catch { response.writeHead(404).end(); }
});
server.listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}`));
process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());
