import { createApi, createSyncClient, defineBackend, defineDatabase, defineTable, openBackend, type OpenBackendOptions, type SyncClientOptions } from "./backend.ts";
import { defineJobs, type JobProcessHandle } from "./jobs.ts";
import { signWebhook } from "./services.ts";
import type { AuthDefinition } from "./auth.ts";
import { s } from "./ai.ts";
import { SQLITE_INTERNAL } from "./sqlite-internal.ts";

export interface WebhookAttempt { readonly attempt: number; readonly generation: number; readonly status: number | null; readonly secretVersion: string | null; readonly outcome: string; readonly createdAt: number; }
export interface WebhookDelivery { readonly id: string; readonly endpoint: string; readonly event: string; readonly state: string; readonly attempts: number; readonly jobId: string; readonly generation: number; readonly status: number | null; readonly secretVersion: string | null; readonly createdAt: number; }
export interface WebhookOutboxOptions {
  path: string; auth: AuthDefinition<any>; prefix?: string; maxPerUser?: number;
  /** Trusted server configuration only. Secrets are resolved anew for every attempt. */
  endpoints: Readonly<Record<string, { url: string; secret: () => { version: string; value: string | Uint8Array } | Promise<{ version: string; value: string | Uint8Array }> }>>;
  fetch?: typeof fetch; onError?: OpenBackendOptions["onError"];
}
export interface WebhookOutbox { handle(request: Request): Promise<Response>; publish(input: { userId: string; key: string; endpoint: string; event: string; payload: unknown }): string; workOnce(): Promise<boolean>; startWorker(): JobProcessHandle; close(): void; }
const schema=defineDatabase({webhookDeliveries:defineTable({key:s.string({min:1,max:200}),endpoint:s.string({min:1,max:80}),event:s.string({min:1,max:120}),payload:s.string({max:65536}),jobId:s.string({max:128}),generation:s.number({integer:true,min:0,max:100}),outcome:s.string({max:20}),status:s.nullable(s.number()),secretVersion:s.nullable(s.string({max:128}))}).owned().index("by_key",["key"]),webhookAttempts:defineTable({deliveryId:s.id("webhookDeliveries"),attempt:s.number(),generation:s.number(),status:s.nullable(s.number()),secretVersion:s.nullable(s.string({max:128})),outcome:s.string({max:32})}).owned().index("by_delivery",["deliveryId"])});

/** Durable user-owned delivery metadata over the application's auth database and fenced job queue. */
export async function openWebhookOutbox(options: WebhookOutboxOptions): Promise<WebhookOutbox> {
 const endpoints=new Map(Object.entries(options.endpoints??{}));
 const maximum=options.maxPerUser??1000;
 if(!endpoints.size||endpoints.size>100||!Number.isSafeInteger(maximum)||maximum<1||maximum>10000)throw new TypeError("Declare 1–100 endpoints and a bounded retention limit.");
 for(const[name,endpoint]of endpoints){const url=new URL(endpoint.url);if(!/^[a-z][a-z0-9._-]{0,79}$/.test(name)||url.protocol!=="https:"||url.username||url.password||url.hash||typeof endpoint.secret!=="function")throw new TypeError("Webhook endpoints require trusted HTTPS URLs and secret resolvers.");endpoints.set(name,{url:url.href,secret:endpoint.secret});}
 let runtime: Awaited<ReturnType<typeof openBackend>>;
 const jobs=defineJobs({schema}).jobs(({job})=>({deliver:job({args:{id:s.id("webhookDeliveries")},agent:false,timeoutMs:15000,retry:{maxAttempts:5,initialDelayMs:1000,factor:2,maxDelayMs:60000,jitter:0.2},async handler({db,job,signal},{id}){
   const record=db.read(tx=>tx.table("webhookDeliveries").get(id));
   if(!record||record.jobId!==job.id||record.outcome==="delivered")return;
   const endpoint=endpoints.get(record.endpoint);if(!endpoint)throw new Error("WEBHOOK_ENDPOINT_UNAVAILABLE");
   const user=runtime.database[SQLITE_INTERNAL].prepare("SELECT disabled FROM clank_auth_users WHERE id = ?").get(record._ownerId);
   if(!user||Number(user.disabled)!==0)throw new Error("WEBHOOK_OWNER_UNAVAILABLE");
   let secret;try{secret=await endpoint.secret();}catch{throw new Error("WEBHOOK_SECRET_UNAVAILABLE");}
   if(!secret||typeof secret.version!=="string"||!/^[a-zA-Z0-9._-]{1,128}$/.test(secret.version))throw new Error("WEBHOOK_SECRET_UNAVAILABLE");
   const signed=await signWebhook(record.payload,secret.value);
   signal.throwIfAborted();
   const recordAttempt=(status:number|null,outcome:string)=>db.transaction(tx=>{const current=tx.table("webhookDeliveries").get(id);if(current?.jobId!==job.id)return;
     tx.table("webhookAttempts").insert({deliveryId:id,attempt:job.attempt,generation:record.generation,status,secretVersion:secret.version,outcome});
     for(const old of tx.table("webhookAttempts").query().where("deliveryId",id).orderBy("_creationTime","desc").collect().slice(100))tx.table("webhookAttempts").delete(old._id);
   });
   let response:Response;
   try{response=await(options.fetch??fetch)(endpoint.url,{method:"POST",redirect:"error",signal,headers:{"content-type":"application/json","x-clank-webhook-event":record.event,"x-clank-webhook-timestamp":String(signed.timestamp),"x-clank-webhook-signature":signed.signature,"x-clank-delivery":id,"x-clank-webhook-key-version":secret.version},body:record.payload});}
   catch{if(!signal.aborted)recordAttempt(null,"network-failure");throw new Error("WEBHOOK_NETWORK_FAILURE");}
   try{
     signal.throwIfAborted();
     recordAttempt(response.status,response.ok?"delivered":"http-failure");
     db.transaction(tx=>{const latest=tx.table("webhookDeliveries").get(id);if(latest?.jobId===job.id)tx.table("webhookDeliveries").patch(id,{status:response.status,secretVersion:secret.version,outcome:response.ok?"delivered":response.status===429||response.status>=500?"pending":"rejected"});});
     if(!response.ok&&(response.status===429||response.status>=500))throw new Error("WEBHOOK_TRANSIENT_RESPONSE");
   }finally{await response.body?.cancel().catch(()=>undefined);}
 }})}));
 const describe=(record:any):WebhookDelivery=>{const job=runtime.jobs!.get(record.jobId);return{id:record._id,endpoint:record.endpoint,event:record.event,state:record.outcome==="delivered"?"delivered":record.outcome==="rejected"?"failed":job?.state==="dead"||job?.state==="cancelled"?"failed":job?.state??"unavailable",attempts:job?.attempt??0,jobId:record.jobId,generation:record.generation,status:record.status,secretVersion:record.secretVersion,createdAt:record._creationTime};};
 const definition=defineBackend({schema,auth:options.auth,jobs}).functions(({query,mutation})=>({
   list:query({args:{refresh:s.string({min:1,max:128})},handler:({db})=>db.table("webhookDeliveries").query().orderBy("_creationTime","desc").limit(100).collect().map(describe)}),
   inspect:query({args:{id:s.id("webhookDeliveries"),refresh:s.string({min:1,max:128})},handler:({db},{id})=>{if(!db.table("webhookDeliveries").get(id))return [];return db.table("webhookAttempts").query().where("deliveryId",id).orderBy("_creationTime","desc").limit(100).collect().map(({attempt,generation,status,secretVersion,outcome,_creationTime})=>({attempt,generation,status,secretVersion,outcome,createdAt:_creationTime}));}}),
   replay:mutation({args:{id:s.id("webhookDeliveries"),expectedJobId:s.string({min:1,max:128})},handler:({db,jobs},{id,expectedJobId})=>{
     const record=db.table("webhookDeliveries").get(id);if(!record||record.jobId!==expectedJobId||record.generation>=100)return false;
     const current=runtime.jobs!.get(record.jobId);
     if(!current||!["dead","cancelled","succeeded"].includes(current.state)||record.outcome==="delivered")return false;
     const generation=record.generation+1;
     const next=jobs.enqueue(jobsDefinition(),{id},{idempotencyKey:`${id}:${generation}`});
     db.table("webhookDeliveries").patch(id,{jobId:next.id,generation,outcome:"pending",status:null,secretVersion:null});return true;
   }}),
 }));
 function jobsDefinition(){return jobs.jobs.deliver;}
 runtime=await openBackend(definition,{path:options.path,prefix:options.prefix??"__clank/webhooks",onError:options.onError});
 return{handle:request=>runtime.handle(request),publish(input){
   if(!endpoints.has(input.endpoint)||!/^[A-Za-z0-9._-]{1,120}$/.test(input.event))throw new TypeError("Unknown webhook endpoint or invalid event.");
   const payload=JSON.stringify(input.payload);if(payload===undefined||new TextEncoder().encode(payload).length>65536)throw new TypeError("Webhook payload must be bounded JSON.");
   return runtime.database.transaction(db=>{
     const user=runtime.database[SQLITE_INTERNAL].prepare("SELECT disabled FROM clank_auth_users WHERE id = ?").get(input.userId);if(!user||Number(user.disabled)!==0)throw new Error("Webhook owner is unavailable.");
     const existing=db.table("webhookDeliveries").query().where("key",input.key).first();if(existing)return existing._id;
     const records=db.table("webhookDeliveries").query().orderBy("_creationTime","desc").collect();
     if(records.length>=maximum){const removable=[...records].reverse().find(record=>{const state=describe(record).state;return state==="delivered"||state==="failed";});if(!removable)throw new Error("Webhook outbox is full.");for(const attempt of db.table("webhookAttempts").query().where("deliveryId",removable._id).collect())db.table("webhookAttempts").delete(attempt._id);db.table("webhookDeliveries").delete(removable._id);}
     const id=db.table("webhookDeliveries").insert({key:input.key,endpoint:input.endpoint,event:input.event,payload,jobId:"",generation:0,outcome:"pending",status:null,secretVersion:null});
     const queued=runtime.jobs!.publisher({userId:input.userId}).enqueue(jobs.jobs.deliver,{id},{idempotencyKey:`${id}:0`});
     db.table("webhookDeliveries").patch(id,{jobId:queued.id});return id;
   },{userId:input.userId});
 },workOnce:()=>runtime.jobs!.workOnce(),startWorker:()=>runtime.jobs!.startWorker(),close:()=>runtime.close()};
}

export interface WebhookClient { list(): Promise<readonly WebhookDelivery[]>; inspect(id:string):Promise<readonly WebhookAttempt[]>; replay(id:string,expectedJobId:string):Promise<boolean>; }
export function createWebhookClient(options:SyncClientOptions={}):WebhookClient {
 const prefix=(options.url??"/__clank/webhooks").replace(/\/$/,"");
 const client=createSyncClient({...options,url:"",fetch:(url,init)=>(options.fetch??fetch)(`${prefix}${String(url).replace(/^\/__clank/,"")}`,init)}),api=createApi<any>();
 return{list:()=>client.query(api.list,{refresh:crypto.randomUUID()}),inspect:id=>client.query(api.inspect,{id,refresh:crypto.randomUUID()}),replay:(id,expectedJobId)=>client.mutate(api.replay,{id,expectedJobId})};
}
export function renderWebhookConsole(deliveries:readonly WebhookDelivery[]):string {
 const escape=(value:unknown)=>String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
 return `<section aria-label="Webhook deliveries"><h2>Webhook deliveries</h2><p>Payloads, destination URLs, and secret values are excluded.</p>${deliveries.length?deliveries.map(item=>`<article><h3>${escape(item.event)} → ${escape(item.endpoint)}</h3><p>${escape(item.state)} · ${escape(item.attempts)} attempts · HTTP ${escape(item.status??"pending")} · key ${escape(item.secretVersion??"pending")}</p><button type="button" data-inspect="${escape(item.id)}">Inspect attempts</button>${item.state==="failed"?`<button type="button" data-delivery="${escape(item.id)}" data-job="${escape(item.jobId)}">Retry failed delivery</button>`:""}</article>`).join(""):"<p>No deliveries yet.</p>"}</section>`;
}
export function mountWebhookConsole(container:HTMLElement,client:WebhookClient):()=>void {
 const refresh=container.ownerDocument.createElement("button"),content=container.ownerDocument.createElement("div"),status=container.ownerDocument.createElement("p");refresh.type="button";refresh.textContent="Refresh deliveries";status.setAttribute("role","status");container.append(refresh,status,content);
 let disposed=false,generation=0;
 const update=async()=>{const current=++generation;try{const deliveries=await client.list();if(!disposed&&current===generation){content.innerHTML=renderWebhookConsole(deliveries);status.textContent="Deliveries refreshed.";}}catch{if(!disposed&&current===generation)status.textContent="Unable to refresh deliveries.";}};
 const reload=()=>{void update();};
 const click=async(event:Event)=>{const inspect=(event.target as Element).closest<HTMLButtonElement>("button[data-inspect]");if(inspect){try{const attempts=await client.inspect(inspect.dataset.inspect!);if(!disposed){status.textContent=attempts.length?attempts.map(attempt=>`Replay ${attempt.generation}, attempt ${attempt.attempt}: ${attempt.outcome}, HTTP ${attempt.status??"unavailable"}, key ${attempt.secretVersion??"unavailable"}.`).join(" "):"No completed attempts yet.";}}catch{if(!disposed)status.textContent="Unable to inspect attempts.";}return;}const button=(event.target as Element).closest<HTMLButtonElement>("button[data-delivery]");if(!button||button.disabled)return;button.disabled=true;try{await client.replay(button.dataset.delivery!,button.dataset.job!);await update();}catch{if(!disposed)status.textContent="Unable to retry delivery.";}finally{button.disabled=false;}};
 refresh.addEventListener("click",reload);content.addEventListener("click",click);void update();return()=>{disposed=true;generation++;refresh.removeEventListener("click",reload);content.removeEventListener("click",click);refresh.remove();content.remove();status.remove();};
}
