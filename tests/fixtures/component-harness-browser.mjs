import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { renderComponentSpecimen, exportComponentAssertions } from '../../dist/component-harness.js';
import { serializeState } from '../../dist/ssr.js';
import { specimens } from './component-harness-specimens.mjs';
const project = fileURLToPath(new URL('../../', import.meta.url)), assets = new Map();
for (const file of await readdir(join(project, 'dist'))) if (file.endsWith('.js')) assets.set('/dist/'+file, await readFile(join(project, 'dist', file)));
for (const name of ['component-harness-browser-entry.mjs', 'component-harness-specimens.mjs']) assets.set('/tests/fixtures/'+name, await readFile(new URL(name, import.meta.url)));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (assets.has(url.pathname)) { response.setHeader('content-type','text/javascript'); response.end(assets.get(url.pathname)); return; }
    if (url.pathname === '/assertions.json') { response.setHeader('content-type','application/json'); response.end(exportComponentAssertions(specimens.find(entry => entry.name === url.searchParams.get('specimen')) ?? specimens[0])); return; }
    if (url.pathname !== '/') { response.writeHead(404); response.end('Not found'); return; }
    const specimen = specimens.find(entry => entry.name === url.searchParams.get('specimen')) ?? specimens[0], rendered = await renderComponentSpecimen(specimen);
    let html = rendered.html;
    if (url.searchParams.get('mismatch') === '1') html = html.replace('<button', '<a').replace('</button>', '</a>');
    const tools = url.searchParams.get('bare') !== '1' ? '<aside id="controls"></aside><button id="lifecycle-check">Check lifecycle</button><button id="pulse-fixture">Pulse fixture resources</button><button id="remove-controls">Remove harness controls</button><button id="check-across-reset">Check across reset</button><button id="check-across-disposal">Check across disposal</button>' : '<button id="lifecycle-check">Check lifecycle</button>';
    response.setHeader('content-type','text/html; charset=utf-8'); response.setHeader('cache-control','no-store');
    response.end('<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Component harness</title><style>body{font:16px system-ui;margin:0;padding:20px;box-sizing:border-box}main{max-width:850px;margin:auto}button,select,input,textarea{font:inherit;max-width:100%;box-sizing:border-box}button,select,input{padding:8px;margin:5px}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #315fc0}section{display:flex;gap:8px;flex-wrap:wrap;padding:12px 0}p{overflow-wrap:anywhere}textarea{width:100%;min-height:220px}.specimen{border:1px solid #aaa;padding:16px}.visually-hidden{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}.modal{position:fixed;left:5%;right:5%;top:15%;max-width:550px;margin:auto;padding:20px;background:white;border:2px solid #444;box-shadow:0 0 0 100vmax #0008;box-sizing:border-box}label{display:block}</style></head><body><main><h1>Component specimens</h1><div id="specimen-root">'+html+'</div><p id="proof" role="status"></p>'+tools+'</main><script type="application/json" id="__CLANK_STATE__">'+serializeState({ name: specimen.name, snapshot: rendered.snapshot, mode: url.searchParams.get("mode") })+'</script><script type="module" src="/tests/fixtures/component-harness-browser-entry.mjs"></script></body></html>');
  } catch { response.writeHead(500, { 'content-type':'text/plain' }); response.end('Fixture unavailable'); }
});
server.listen(Number(process.env.CLANK_HARNESS_PORT ?? 43178), '127.0.0.1', () => console.log('Component harness at http://127.0.0.1:'+server.address().port));
process.once('SIGTERM', () => server.close()); process.once('SIGINT', () => server.close());
