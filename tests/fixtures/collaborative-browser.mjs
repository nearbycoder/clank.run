import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineAuth } from "../../dist/auth.js";
import { defineBackend, defineDatabase, defineTable, openBackend } from "../../dist/backend.js";
import { s } from "../../dist/ai.js";
import { openCollaborativeDocuments, createCollaborativeDocumentsClient } from "../../dist/collaborative-documents.js";
const directory = await mkdtemp(join(tmpdir(), "clank-document-browser-")), repository = fileURLToPath(new URL("../../", import.meta.url)), origin = "http://127.0.0.1:43172";
const assets = new Map(await Promise.all((await readdir(join(repository, "dist"))).filter(name => /^[a-z0-9-]+\.js$/u.test(name)).map(async name => ["/dist/" + name, await readFile(join(repository, "dist", name))])));
const auth = defineAuth({ password: { cost: 1024, maxMemory: 4 * 1024 * 1024 } }), schema = defineDatabase({ fixture: defineTable({ value: s.string() }) });
const runtime = await openBackend(defineBackend({ schema, auth }).functions(() => ({})), { path: join(directory, "app.sqlite"), agent: false });
const members = new Set(), service = await openCollaborativeDocuments({ path: join(directory, "app.sqlite"), auth, schema, authorize: ({ auth }) => members.has(auth.user.id) });
async function user(email) {
  const response = await runtime.handle(new Request(`${origin}/__clank/auth/register`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email, password: "disposable browser fixture password" }) }));
  if (response.status !== 201) throw new Error("Fixture registration failed.");
  const result = await response.json(); members.add(result.user.id);
  return { id: result.user.id, csrf: result.csrfToken, setCookie: response.headers.get("set-cookie"), cookie: response.headers.get("set-cookie").split(";", 1)[0] };
}
const alice = await user("browser-alice@example.invalid"), bob = await user("browser-bob@example.invalid");
const client = identity => createCollaborativeDocumentsClient({ url: `${origin}/__clank/documents`, auth: { csrfHeader: () => ({ "x-clank-csrf": identity.csrf }) }, fetch: (url, init) => service.handle(new Request(url, { ...init, headers: { ...init.headers, origin, cookie: identity.cookie } })) });
const a = client(alice), b = client(bob);
await a.create("shared", "Hello world");
let branch = await a.createBranch("shared", "proposal", "Improve greeting", 1); branch = await a.saveBranch("shared", branch.id, branch.version, "Hello earth"); await a.proposeBranch("shared", branch.id, branch.version);
await b.edit({ documentId: "shared", operationId: "salutation", baseRevision: 1, start: 0, deleteCount: 0, insert: "Dear " });
await b.setCursor("shared", { revision: 2, anchor: 11, head: 16 });
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Document coordination verification</title><style>body{font:16px system-ui;max-width:720px;margin:24px auto;padding:0 16px}pre,p,li{white-space:pre-wrap;overflow-wrap:anywhere}textarea{width:100%;box-sizing:border-box}button{margin:6px 8px 6px 0;padding:12px;max-width:100%}section{margin:20px 0;padding:12px;border:1px solid #ccc}button:focus-visible{outline:3px solid #3463e7}</style><h1>Document proposal review</h1><p>Disposable local fixture with two real authenticated sessions.</p><label for="selection">Select text to publish a cursor</label><textarea id="selection" readonly>Dear Hello world</textarea><p id="persisted" aria-label="Persisted document">Dear Hello world · revision 2</p><div id="presence"></div><div id="review"></div><button id="change">Change server document</button><button id="revoke">Revoke my fixture access</button><script type="module">
import { createCollaborativeDocumentsClient, mountDocumentBranchReview, mountDocumentCursorPresence } from '/dist/collaborative-documents.js';
const csrf=${JSON.stringify(alice.csrf)}, client=createCollaborativeDocumentsClient({auth:{csrfHeader:()=>({'x-clank-csrf':csrf})}}), field=document.querySelector('#selection');
let revision=2;
const disposeReview=mountDocumentBranchReview(document.querySelector('#review'),client,'shared','proposal');
const disposePresence=mountDocumentCursorPresence(document.querySelector('#presence'),client,'shared',()=>revision===null?null:{revision,anchor:field.selectionStart,head:field.selectionEnd},500);
const timer=setInterval(async()=>{try{const next=await client.read('shared');if(next.revision!==revision){revision=next.revision;field.value=next.text}document.querySelector('#persisted').textContent=next.text+' · revision '+next.revision}catch{revision=null;field.value='';document.querySelector('#persisted').textContent='Document access revoked.'}},500);
for(const action of ['change','revoke']) document.querySelector('#'+action).addEventListener('click',()=>fetch('/__fixture/'+action,{method:'POST',headers:{'x-clank-csrf':csrf}}));
addEventListener('pagehide',()=>{clearInterval(timer);disposeReview();disposePresence()},{once:true});
</script></html>`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/") { response.setHeader("content-type", "text/html; charset=utf-8"); response.setHeader("set-cookie", alice.setCookie); response.end(html); return; }
    if (request.url === "/favicon.ico") { response.statusCode = 204; response.end(); return; }
    if (assets.has(request.url)) { response.setHeader("content-type", "text/javascript"); response.end(assets.get(request.url)); return; }
    if (request.url.startsWith("/__fixture/") && request.method === "POST") {
      if (request.headers.origin !== origin || request.headers["x-clank-csrf"] !== alice.csrf || !String(request.headers.cookie ?? "").split(/;\s*/u).includes(alice.cookie)) { response.statusCode = 403; response.end(); return; }
      if (request.url === "/__fixture/revoke") members.delete(alice.id);
      else if (request.url === "/__fixture/change") { const current = await b.read("shared"); await b.edit({ documentId: "shared", operationId: crypto.randomUUID(), baseRevision: current.revision, start: 0, deleteCount: 0, insert: "!" }); }
      else { response.statusCode = 404; }
      response.end(); return;
    }
    if (request.url.startsWith("/__clank/documents/")) {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { response.statusCode = 413; response.end(); return; } chunks.push(chunk); }
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([, value]) => value !== undefined).map(([name, value]) => [name, Array.isArray(value) ? value.join(",") : value]));
      const result = await service.handle(new Request(origin + request.url, { method: request.method, headers, ...(["GET", "HEAD"].includes(request.method) ? {} : { body: Buffer.concat(chunks) }) }));
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer())); return;
    }
    response.statusCode = 404; response.end("Not found");
  } catch { response.statusCode = 500; response.end("Fixture request failed."); }
});
server.listen(43172, "127.0.0.1", () => console.log(`Document verification at ${origin}`));
async function stop() { server.close(); service.close(); runtime.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); }
process.once("SIGINT", stop); process.once("SIGTERM", stop);
