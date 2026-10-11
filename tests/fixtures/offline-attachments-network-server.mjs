// Disposable loopback app. Browser uses ordinary public auth and bucket routes.
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defineBackend,defineDatabase,defineTable,openBackend} from '../../dist/backend.js';
import {defineAuth} from '../../dist/auth.js';
import {s} from '../../dist/ai.js';
import {defineBucket,openBucketManager,resolveBucketAttachment} from '../../dist/buckets.js';
import {openLocalObjectStore} from '../../dist/object-storage.js';
import {serve} from '../../dist/node.js';
const port=Number(process.argv[2]);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Supply an owned disposable loopback port.');
const origin='http://127.0.0.1:'+port,root=await mkdtemp(join(tmpdir(),'clank-attachment-network-')),databasePath=join(root,'app.sqlite');
const reference=s.object({bucket:s.string(),key:s.string(),objectId:s.string(),sha256:s.string(),generation:s.string()});
const definition=defineBackend({schema:defineDatabase({records:defineTable({name:s.string(),attachment:reference}).owned()}),auth:defineAuth({password:{cost:1024,maxMemory:4*1024*1024}})}).functions(({mutation,query})=>({
  attach:mutation({args:{name:s.string(),attachment:reference},agent:false,handler(context,args){resolveBucketAttachment(context,args.attachment);return context.db.table('records').insert(args);}}),
  list:query({args:{},handler:({db})=>db.table('records').collect()}),
}));
const store=await openLocalObjectStore({directory:join(root,'objects')}),manager=await openBucketManager({definitions:[defineBucket({name:'files',ownership:'user',visibility:'private',browserAccess:'authenticated',resumable:true,maxChunkBytes:3,maxObjectBytes:1000,allowedContentTypes:['text/plain']})],store,databasePath,stagingDirectory:join(root,'staging'),signingKey:'owned_network_attachment_signing_credential_0123456789',publicOrigin:origin});
const runtime=await openBackend(definition,{path:databasePath,buckets:manager,offlineMutations:{},agent:false});
const page='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native attachment HTTP verification</title><style>body{font:16px system-ui;max-width:60rem;margin:2rem auto;padding:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{margin:.5rem}button:focus-visible{outline:3px solid #125bcc;outline-offset:3px}li{margin:.75rem 0}</style><main><h1>Native attachment HTTP verification</h1><p>Disposable native browser storage → ordinary authenticated HTTP → native object store and SQLite. Automatic fixture checks do not establish keyboard or phone acceptance.</p><pre id="report" role="status" data-status="running">Running native HTTP checks…</pre><ol id="results"></ol><div id="view"></div></main><script type="module" src="/fixture.js"></script></html>';
const server=await serve(async request=>{
  const pathname=new URL(request.url).pathname;
  if(pathname==='/')return new Response(page,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(pathname==='/fixture.js')return new Response(await readFile(new URL('./offline-attachments-network-client.mjs',import.meta.url)),{headers:{'content-type':'text/javascript','cache-control':'no-store'}});
  if(/^\/runtime\/[a-z0-9-]+\.js$/u.test(pathname))return new Response(await readFile(new URL('../../dist/'+pathname.slice(9),import.meta.url)),{headers:{'content-type':'text/javascript','cache-control':'no-store'}});
  const response=await runtime.handle(request);console.log(JSON.stringify({method:request.method,path:pathname.includes('/cap/')?pathname.split('/cap/',1)[0]+'/cap/[redacted]':pathname.slice(0,200),status:response.status}));return response;
},{hostname:'127.0.0.1',port,maxBodySize:64*1024});
console.log(JSON.stringify({fixture:'owned-native-attachment-network',url:server.url,root,databasePath}));
let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{if(closing)return;closing=true;await server.close();runtime.close();manager.close();await rm(root,{recursive:true,force:true});process.exit(0);});
