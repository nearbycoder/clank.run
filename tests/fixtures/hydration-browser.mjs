import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { compile } from '../../scripts/compiler.mjs';
import { h } from '../../dist/dom.js';
import { renderToString } from '../../dist/ssr.js';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const assets = new Map(await Promise.all((await readdir(join(repository, 'dist'))).filter(name => /^[a-z0-9-]+\.js$/u.test(name)).map(async name => ['/dist/'+name, await readFile(join(repository, 'dist', name))])));
const source = `import { signal } from ${JSON.stringify(new URL('../../dist/core.js', import.meta.url).href)};
export const state = signal(0);
export const lifecycle = { attached: 0, cleaned: 0 };
export function MatchingCounter() {
  return <button onClick={() => state.value++}>Matching counter {state.value}</button>;
}
export function Mismatch() {
  return <section><button use={() => { lifecycle.attached++; return () => lifecycle.cleaned++; }}>Fallback control</button><p>Client replacement</p></section>;
}
export function TextPatch() { return <span>Client corrected label</span>; }
`;
const nodeModule = await import('data:text/javascript,'+encodeURIComponent(compile(source, { filename: '/private/fixture/HydrationDemo.tsx', sourceMap: false, hydrationDiagnostics: true, jsxImportSource: new URL('../../dist/index.js', import.meta.url).href })));
assets.set('/fixture-view.js', compile(source.replace(new URL('../../dist/core.js', import.meta.url).href, '/dist/core.js'), { filename: '/private/fixture/HydrationDemo.tsx', sourceMap: false, hydrationDiagnostics: true, jsxImportSource: '/dist/index.js' }));
const matched = await renderToString(h(nodeModule.MatchingCounter));
const mismatched = await renderToString(h('section', {}, h('button', {}, 'Fallback control'), h('span', { 'data-private': 'synthetic-private-attribute' }, 'synthetic-private-SSR-content')));
const patch = await renderToString(h('span', {}, 'synthetic-private-old-text'));
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hydration inspection verification</title><style>body{font:16px system-ui;max-width:960px;margin:24px auto;padding:0 16px}button{padding:10px;margin:8px 8px 8px 0;max-width:100%}button:focus-visible,textarea:focus-visible{outline:3px solid #345bc6}p{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px;border-bottom:1px solid #ccc;white-space:nowrap}.scroll{overflow:auto}aside{border:1px solid #aaa;padding:12px;margin-top:20px}textarea{min-height:180px}</style><h1>Hydration inspection</h1><p>Disposable SSR fixture. Reports contain structure and source coordinates.</p><div id="matched">${matched}</div><div id="mismatched">${mismatched}</div><div id="patch">${patch}</div><p id="proof" role="status"></p><button id="remove">Remove inspected apps</button><button id="dispose">Dispose inspector</button><div id="tools"></div><script type="module">
import { h, hydrate, createDevtools, mountDevtools } from '/dist/index.js';
import { MatchingCounter, Mismatch, TextPatch, lifecycle } from '/fixture-view.js';
const inspector=createDevtools({hydration:true,maxEvents:20}), matched=document.querySelector('#matched'), original=matched.firstElementChild;
const disposeMatch=hydrate(matched,h(MatchingCounter)), disposeMismatch=hydrate(document.querySelector('#mismatched'),h(Mismatch)), disposePatch=hydrate(document.querySelector('#patch'),h(TextPatch));
const disposePanel=mountDevtools(document.querySelector('#tools'),inspector), proof=document.querySelector('#proof');
proof.textContent='Matching node preserved: '+(matched.firstElementChild===original)+'; fallback attachments: '+lifecycle.attached+'; abandoned cleanup: '+lifecycle.cleaned;
document.querySelector('#remove').addEventListener('click',()=>{disposeMatch();disposeMismatch();disposePatch();proof.textContent='Apps removed; cleanup count: '+lifecycle.cleaned;document.querySelector('#remove').disabled=true});
document.querySelector('#dispose').addEventListener('click',()=>{disposePanel();inspector.dispose();proof.textContent+='; inspector disposed with '+(inspector.snapshot().hydration?.length??0)+' retained mismatches';document.querySelector('#dispose').disabled=true});
addEventListener('pagehide',()=>{disposeMatch();disposeMismatch();disposePatch();disposePanel();inspector.dispose()},{once:true});
</script></html>`;
const server = createServer((request,response)=>{
  if(request.url==='/'){response.setHeader('content-type','text/html; charset=utf-8');response.end(html);}
  else if(request.url==='/favicon.ico'){response.statusCode=204;response.end();}
  else if(assets.has(request.url)){response.setHeader('content-type','text/javascript');response.end(assets.get(request.url));}
  else{response.statusCode=404;response.end('Not found');}
});
server.listen(43173,'127.0.0.1',()=>console.log('Hydration verification at http://127.0.0.1:43173'));
process.once('SIGINT',()=>server.close());process.once('SIGTERM',()=>server.close());
