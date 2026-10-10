// Owned loopback fixture exercising native sessions, status routes and actual form requests.
// Controlled native UV is not a physical passkey or production-host certificate.
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture} from './platform-environment-fixture.mjs';
import {step} from './customer-status-passkey.mjs';
const callbacks=[],port=Number(process.env.PORT??42647),t={after(callback){callbacks.push(callback);},diagnostic(message){process.stderr.write(String(message)+'\n');}};
const f=await fixture(t,false,{publicUrl:'http://127.0.0.1:'+port}),db=new DatabaseSync(join(f.options.dataDirectory,'control.sqlite'));callbacks.push(()=>db.close());
await step(f,db,f.owner);
const customer=await f.account('status-browser-customer@example.test'),outsider=await f.account('status-browser-outside@example.test');
const configuration={slug:'customer-health',title:'Customer service health',description:'Approved information for customers.',components:[{key:'checkout',label:'Checkout',source:{kind:'manual',health:'operational',observedAt:Date.now()-1000,expiresAt:Date.now()+3600000-1000}}]},path='/api/projects/'+f.development.id+'/status-page';
const page=(await f.call(path+'/create',{configuration,operationId:'status_browser_create_01'},201)).page,preview=(await f.call(path+'/preview',{expectedVersion:page.version,publication:{kind:'page'}})).preview;
await f.call(path+'/publish',{expectedVersion:preview.expectedVersion,previewId:preview.id,previewDigest:preview.digest,operationId:'status_browser_publish_01'});
let posts=0;await f.serve(async(request,response)=>{
 const url=new URL(request.url);if(request.method==='POST'&&(url.pathname.includes('/status')||url.pathname.includes('/status-page')))posts++;
 const account=url.pathname==='/fixture/as/owner'?f.owner:url.pathname==='/fixture/as/customer'?customer:url.pathname==='/fixture/as/outside'?outsider:null;
 if(account)return new Response(null,{status:303,headers:{location:account===f.owner?'/projects/'+f.development.id+'/status':'/status/customer-health/preferences','set-cookie':account.cookie+'; HttpOnly; SameSite=Lax; Path=/','cache-control':'no-store'}});
 if(url.pathname==='/fixture/inspect')return Response.json({posts,pageVersion:db.prepare('SELECT version FROM clank_platform_status_pages').get().version,updates:db.prepare('SELECT count(*) AS n FROM clank_platform_status_updates').get().n,subscribers:db.prepare('SELECT count(*) AS n FROM clank_platform_status_subscribers WHERE subscribed=1').get().n,notifications:db.prepare('SELECT count(*) AS n FROM clank_platform_status_notifications').get().n});
 return response;
});
process.stdout.write(JSON.stringify({origin:f.options.publicUrl,root:f.root,projectId:f.development.id,public:'/status/customer-health',operator:'/fixture/as/owner',subscriber:'/fixture/as/customer',posts:0})+'\n');
let closing=false;async function close(){if(closing)return;closing=true;for(const callback of callbacks)await callback();process.exit(0);}process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
