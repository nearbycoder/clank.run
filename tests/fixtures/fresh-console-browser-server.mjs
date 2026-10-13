// Disposable native console acceptance environment. Fixture UV is not device certification.
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {fixture} from './platform-environment-fixture.mjs';
import {stepUpProjectCosts} from './project-costs-step-up.mjs';
const port=Number(process.argv[2]);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Supply an owned loopback port.');
const callbacks=[],t={after(fn){callbacks.push(fn)},diagnostic(message){console.log(String(message))}};
const f=await fixture(t,false,{publicUrl:'http://localhost:'+port,organizationSecurity:{operatorRecovery:true},temporaryAccess:{},freshAuthentication:{required:false}});
const db=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));db.exec('PRAGMA busy_timeout=1000');
callbacks.push(()=>db.close());
const viewer=await f.account('fresh-console-viewer@example.test');
db.prepare("INSERT INTO clank_platform_memberships VALUES(?,?,'viewer',?,?)").run(f.development.organizationId,viewer.user.id,Date.now(),Date.now());
await stepUpProjectCosts({...f,db});
const routes={project:'/projects/'+f.development.slug,settings:'/projects/'+f.development.slug+'/settings',incidents:'/projects/'+f.development.slug+'/incidents',slo:'/projects/'+f.development.slug+'/slo',shadow:'/projects/'+f.development.slug+'/shadow',recovery:'/projects/'+f.development.slug+'/recovery'};
await f.serve(async(request,response)=>{
 const url=new URL(request.url);
 const account=url.pathname==='/fixture/as/owner'?f.owner:url.pathname==='/fixture/as/viewer'?viewer:null;
 if(account)return new Response(null,{status:303,headers:{location:routes.project,'set-cookie':account.cookie+'; HttpOnly; SameSite=Lax; Path=/','cache-control':'no-store'}});
 if(/^\/runtime\/[a-z0-9-]+\.js$/u.test(url.pathname))return new Response(await readFile(new URL('../../dist/'+url.pathname.slice(9),import.meta.url)),{headers:{'content-type':'text/javascript','cache-control':'no-store'}});
 if(url.pathname==='/fixture')return new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Disposable console controls</title><h1>Disposable console controls</h1><p>Native fixture UV verifies a test assertion and does not certify a physical authenticator.</p><button id="step">Verify fixture authentication and return to People</button><p id="status" role="status"></p><a href="/fixture/as/owner">Open owner console</a><a href="/fixture/as/viewer">Open viewer console</a><script type="module">import{createAuthClient}from'/runtime/auth.js';const auth=createAuthClient({immediate:false});document.querySelector('#step').onclick=async()=>{try{await auth.reload();const response=await fetch('/fixture/step-up',{method:'POST',headers:auth.csrfHeader()});if(!response.ok)throw Error('Native authentication refused');location.href='/overview';}catch(error){document.querySelector('#status').textContent=error.message;}};</script></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
 if(url.pathname==='/fixture/step-up'&&request.method==='POST'){
  const account={cookie:request.headers.get('cookie')??'',csrf:request.headers.get('x-clank-csrf')??'',user:f.owner.user};
  const dashboard=await f.call('/api/dashboard',undefined,200,'GET',account),current=dashboard.account.id===f.owner.user.id?f.owner:dashboard.account.id===viewer.user.id?viewer:null;
  if(!current||request.headers.get('origin')!==f.options.publicUrl)return Response.json({ok:false},{status:403});
  // The fixture form submits the owning CSRF header via the inline native client.
  await stepUpProjectCosts({...f,db,owner:current,call:(path,body)=>f.call(path,body,200,'POST',account)});
  return Response.json({ok:true});
 }
 if(url.pathname==='/fixture/info')return Response.json({projectId:f.development.id,organizationId:f.development.organizationId,ownerId:f.owner.user.id,viewerId:viewer.user.id,routes});
 if(url.pathname==='/fixture/inspect'){
  const caller=await f.call('/api/dashboard',undefined,200,'GET',{cookie:request.headers.get('cookie')??'',csrf:'',user:f.owner.user});
  if(caller.account.id!==f.owner.user.id)return Response.json({ok:false},{status:403});
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%incident%' OR name LIKE '%slo%' OR name LIKE '%temporary%' OR name LIKE '%security_polic%') ORDER BY name").all();
  return Response.json({counts:tables.map(({name})=>({table:name,count:db.prepare('SELECT count(*) AS n FROM "'+name+'"').get().n})),audit:db.prepare('SELECT action FROM clank_platform_audit ORDER BY rowid DESC LIMIT 30').all()});
 }
 console.log(JSON.stringify({method:request.method,path:url.pathname,status:response.status}));return response;
});
console.log(JSON.stringify({fixture:'fresh-native-console',origin:f.options.publicUrl,root:f.root,pid:process.pid,project:f.development,viewerId:viewer.user.id,routes}));
let closing=false;for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{if(closing)return;closing=true;for(const fn of callbacks)await fn();process.exit(0)});
