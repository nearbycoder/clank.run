// Local browser benchmark for a bounded viewport versus mounting every row.
import { serve, staticFiles } from '../../dist/node.js';
const modules = staticFiles(new URL('../../dist/', import.meta.url).pathname, { prefix: '/modules' });
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clank list usability benchmark</title><style>
body{font:16px system-ui;background:#101312;color:#e9ede9;max-width:1000px;margin:40px auto;padding:0 20px}button{font:inherit;padding:10px 16px;background:#bbef89;border:0;border-radius:5px;color:#182014}#viewport{height:480px;border:1px solid #657063;margin:24px 0;overflow:auto}.row{height:36px;box-sizing:border-box;display:flex;align-items:center;gap:14px;padding:0 12px;border-bottom:1px solid #303930}.row span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}button:disabled{opacity:.5}</style>
<h1>Large-list usability</h1><p>Compare full rendering with Clank's virtualized list. Synthetic rows; local browser timing.</p>
<button id="run">Run A/B comparison</button><p id="status" role="status">Ready</p><div id="viewport"></div><pre id="results"></pre>
<script type="module">
import {h,render} from '/modules/dom.js';
import {mountVirtualCollection} from '/modules/virtual-collections.js';
const container=document.querySelector('#viewport'),status=document.querySelector('#status');
let dispose=()=>{},current;
const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
function mount(mode,count){
 dispose();container.replaceChildren();container.scrollTop=0;
 const items=Array.from({length:count},(_,id)=>({id,title:'Task '+id+' — synthetic list item'}));
 const started=performance.now();
 if(mode==='full'){
  dispose=render(container,h('div',{},...items.map(item=>h('div',{class:'row','data-id':item.id},h('input',{type:'checkbox','aria-label':'Complete task '+item.id}),h('span',{},item.title)))));
 }else{
  current=mountVirtualCollection(container,{items,key:item=>item.id,rowHeight:36,overscan:5,label:'Tasks',render(item){
   const element=document.createElement('div');element.className='row';element.dataset.id=item.id;
   const input=document.createElement('input');input.type='checkbox';input.setAttribute('aria-label','Complete task '+item.id);
   const text=document.createElement('span');text.textContent=item.title;element.append(input,text);
   return{element,update(value){text.textContent=value.title}};
  }});dispose=()=>current.dispose();
 }
 container.getBoundingClientRect();const height=container.scrollHeight;
 return{mode,count,mountMs:performance.now()-started,rowsInDom:container.querySelectorAll('.row').length,domElements:container.querySelectorAll('*').length,height};
}
document.querySelector('#run').onclick=async()=>{
 const button=document.querySelector('#run');button.disabled=true;window.benchmarkDone=false;const samples=[];
 try{
  for(const count of [1000,10000])for(let round=0;round<3;round++)for(const mode of round%2?['virtual','full']:['full','virtual']){
   status.textContent=mode+' · '+count+' rows · round '+(round+1);await frame();
   samples.push({...mount(mode,count),round:round+1});await frame();
  }
  mount('virtual',10000);current.viewport.focus();
  current.viewport.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));await frame();
  const keyboardEnd=current.model.snapshot().activeIndex===9999&&document.activeElement?.dataset.virtualIndex==='9999';
  const boundedRows=container.querySelectorAll('.row').length<50;
  const visible=container.querySelector('.row input');visible.click();const usable=visible.checked;
  window.benchmarkResult={samples,keyboardEnd,boundedRows,usable,overflow:document.documentElement.scrollWidth>innerWidth,viewport:innerWidth,userAgent:navigator.userAgent};
  document.querySelector('#results').textContent=JSON.stringify(window.benchmarkResult,null,2);
  status.textContent='Complete — keyboard navigation and checkbox interaction '+(keyboardEnd&&boundedRows&&usable?'passed':'FAILED');
 }catch(error){window.benchmarkResult={error:String(error)};status.textContent=String(error)}finally{button.disabled=false;window.benchmarkDone=true}
};
</script></html>`;
const server = await serve(request => new URL(request.url).pathname === '/' ? new Response(page, { headers: { 'content-type': 'text/html' } }) : modules.handle(request), { hostname: '127.0.0.1', port: 33940 });
console.log(server.url);
process.on('SIGTERM', () => void server.close().then(() => process.exit(0)));
