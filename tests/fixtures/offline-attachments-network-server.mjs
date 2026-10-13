// Disposable loopback app. Browser uses ordinary public auth and bucket routes.
import {mkdtemp,readFile,rm,lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defineBackend,defineDatabase,defineTable,openBackend} from '../../dist/backend.js';
import {defineAuth} from '../../dist/auth.js';
import {s} from '../../dist/ai.js';
import {defineBucket,openBucketManager,resolveBucketAttachment} from '../../dist/buckets.js';
import {openLocalObjectStore} from '../../dist/object-storage.js';
import {serve} from '../../dist/node.js';
import {DatabaseSync} from 'node:sqlite';
const port=Number(process.argv[2]);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Supply an owned disposable loopback port.');
const existingRoot=process.argv[3];
if(existingRoot&&!/^\/var\/tmp\/clank-attachment-network-[A-Za-z0-9]{6}$/u.test(existingRoot))throw Error('Only an explicitly owned native fixture root can be resumed.');
const origin='http://127.0.0.1:'+port,root=existingRoot??await mkdtemp(join(tmpdir(),'clank-attachment-network-')),databasePath=join(root,'app.sqlite');
if(existingRoot){const directory=await lstat(root),database=await lstat(databasePath);if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid()||(directory.mode&0o777)!==0o700||await realpath(root)!==root||!database.isFile()||database.isSymbolicLink()||database.nlink!==1||database.uid!==process.getuid())throw Error('The original native fixture namespace differs.');}
const reference=s.object({bucket:s.string(),key:s.string(),objectId:s.string(),sha256:s.string(),generation:s.string()});
const definition=defineBackend({schema:defineDatabase({records:defineTable({name:s.string(),attachment:reference}).owned()}),auth:defineAuth({password:{cost:1024,maxMemory:4*1024*1024}})}).functions(({mutation,query})=>({
  attach:mutation({args:{name:s.string(),attachment:reference},agent:false,handler(context,args){resolveBucketAttachment(context,args.attachment);return context.db.table('records').insert(args);}}),
  list:query({args:{},handler:({db})=>db.table('records').collect()}),
}));
const store=await openLocalObjectStore({directory:join(root,'objects')}),manager=await openBucketManager({definitions:[defineBucket({name:'files',ownership:'user',visibility:'private',browserAccess:'authenticated',resumable:true,maxChunkBytes:3,maxObjectBytes:1000,allowedContentTypes:['text/plain']})],store,databasePath,stagingDirectory:join(root,'staging'),signingKey:'owned_network_attachment_signing_credential_0123456789',publicOrigin:origin,...(process.env.CLANK_ATTACHMENT_SHORT_CAPABILITIES==='1'?{capabilityTtlMs:1000}:{})});
const runtime=await openBackend(definition,{path:databasePath,buckets:manager,offlineMutations:{},agent:false});
const page='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native attachment HTTP verification</title><style>body{font:16px system-ui;max-width:60rem;margin:2rem auto;padding:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{margin:.5rem}button:focus-visible{outline:3px solid #125bcc;outline-offset:3px}li{margin:.75rem 0}</style><main><h1>Native attachment HTTP verification</h1><p>Disposable native browser storage → ordinary authenticated HTTP → native object store and SQLite. Automatic fixture checks do not establish keyboard or phone acceptance.</p><pre id="report" role="status" data-status="running">Running native HTTP checks…</pre><ol id="results"></ol><div id="view"></div></main><script type="module" src="/fixture.js"></script></html>';
let partialChunks=0;
const handler=async request=>{
  const pathname=new URL(request.url).pathname;
  if(pathname==='/')return new Response(page,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(pathname==='/fixture.js')return new Response(await readFile(new URL('./offline-attachments-network-client.mjs',import.meta.url)),{headers:{'content-type':'text/javascript','cache-control':'no-store'}});
  if(/^\/runtime\/[a-z0-9-]+\.js$/u.test(pathname))return new Response(await readFile(new URL('../../dist/'+pathname.slice(9),import.meta.url)),{headers:{'content-type':'text/javascript','cache-control':'no-store'}});
  if(['/fixture/expire-session','/fixture/arm-partial-upload','/fixture/sweep'].includes(pathname)&&request.method==='POST'){
    if(request.headers.get('origin')!==origin)return Response.json({ok:false},{status:403});
    const response=await runtime.handle(new Request(origin+'/__clank/auth/session',{headers:{cookie:request.headers.get('cookie')??''}})),state=await response.json();
    if(!response.ok||typeof state.user?.id!=='string'||typeof state.session?.id!=='string'||state.csrfToken!==request.headers.get('x-clank-csrf'))return Response.json({ok:false},{status:403});
    if(pathname==='/fixture/expire-session'){const db=new DatabaseSync(databasePath);try{db.exec('PRAGMA busy_timeout=1000');if(db.prepare('UPDATE clank_auth_sessions SET expires_at=? WHERE id=? AND user_id=?').run(Date.now()-1,state.session.id,state.user.id).changes!==1)throw Error('Original fixture session differs.');}finally{db.close();}}
    else if(pathname==='/fixture/arm-partial-upload')partialChunks=2;
    else await manager.sweep();
    return Response.json({ok:true});
  }
  const response=await runtime.handle(request);console.log(JSON.stringify({method:request.method,path:pathname.includes('/cap/')?pathname.split('/cap/',1)[0]+'/cap/[redacted]':pathname.slice(0,200),status:response.status}));
  if(partialChunks>0&&request.method==='PATCH'&&pathname.includes('/cap/')&&response.status===204&&--partialChunks===0){console.log(JSON.stringify({acceptedPartialBytes:Number(response.headers.get('upload-offset')),withheldChunkAcknowledgment:true}));return new Response(null,{status:204});}
  return response;
};
const serverOptions={hostname:'127.0.0.1',port,maxBodySize:64*1024};let server=await serve(handler,serverOptions),online=true,toggling=false,offlineHold;
console.log(JSON.stringify({fixture:'owned-native-attachment-network',url:server.url,root,databasePath,pid:process.pid}));
// Owned process signal stops/reopens only this HTTP listener. Native SQLite,
// authentication and object-store state remain in the original live runtime.
process.on('SIGUSR2',async()=>{if(toggling)return;toggling=true;try{if(online){offlineHold=setInterval(()=>{},1000);await server.close();}else{server=await serve(handler,serverOptions);clearInterval(offlineHold);offlineHold=undefined;}online=!online;console.log(JSON.stringify({fixtureTransport:online?'online':'offline',pid:process.pid}));}catch(error){console.error(String(error));}finally{toggling=false;}});
let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{if(closing)return;closing=true;if(online)await server.close();clearInterval(offlineHold);runtime.close();manager.close();await rm(root,{recursive:true,force:true});process.exit(0);});
