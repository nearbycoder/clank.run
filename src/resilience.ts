import {rehearseRecovery,type RehearsalOptions,type RehearsalApplication} from "./rehearsal.ts";
export type ResilienceFault="offline"|"lost-response"|"dependency-unavailable"|"worker-restart"|"interrupted-upload";
export interface ResilienceContext { readonly signal:AbortSignal; readonly phase:"baseline"|"fault"|"recovered"; request(path:string,init?:RequestInit):Promise<Response>; }
export interface ResilienceScenario { readonly name:string;readonly fault:ResilienceFault;exercise(context:ResilienceContext):Promise<void>;verify(context:ResilienceContext):Promise<void>; }
export interface ResilienceApplication extends RehearsalApplication { crashWorker?():Promise<void>;restartWorker?():Promise<void>; }
export interface ResilienceOptions {
 source:RehearsalOptions["source"];timeoutMs?:number;maxDatabaseBytes?:number;
 /** The factory receives only a disposable database and injected dependency transport. */
 boot(context:{databasePath:string;signal:AbortSignal;fetchDependency:typeof fetch}):Promise<ResilienceApplication>;
 /** Fixture dependency implementations. No network fallback exists. */
 dependencies?:Readonly<Record<string,(request:Request)=>Response|Promise<Response>>>;
 scenarios:readonly ResilienceScenario[];
}
export interface ResilienceReport { readonly protocol:"clank-resilience/1";readonly ok:boolean;readonly scenarios:readonly {readonly name:string;readonly fault:ResilienceFault;readonly ok:boolean;readonly phase:string;readonly injected:number;readonly requests:number;readonly durationMs:number}[]; }

/** Run each fault against a fresh disposable app copy, requiring real injection and recovery checks. */
export async function rehearseResilience(options:ResilienceOptions):Promise<ResilienceReport>{
 const faults=new Set(["offline","lost-response","dependency-unavailable","worker-restart","interrupted-upload"]);
 if(!Array.isArray(options.scenarios)||!options.scenarios.length||options.scenarios.length>20||new Set(options.scenarios.map(s=>s.name)).size!==options.scenarios.length||options.scenarios.some(s=>!s||!/^[A-Za-z0-9 ._-]{1,100}$/.test(s.name)||!faults.has(s.fault)||typeof s.exercise!=="function"||typeof s.verify!=="function"))throw new TypeError("Declare 1–20 uniquely named resilience scenarios with exercise and verification callbacks.");
 const dependencies=new Map(Object.entries(options.dependencies??{}));if(dependencies.size>20||[...dependencies].some(([name,handler])=>!/^https:\/\/[a-z0-9-]+\.example\.invalid$/.test(name)||typeof handler!=="function"))throw new TypeError("Dependencies must be named synthetic example.invalid origins.");
 const results:ResilienceReport["scenarios"][number][]=[];
 for(const scenario of options.scenarios){
  const started=performance.now();let phase="restore",injected=0,requests=0,verified=false,activeFault=false;
  const report=await rehearseRecovery({source:options.source,timeoutMs:options.timeoutMs,maxDatabaseBytes:options.maxDatabaseBytes,checks:[{name:scenario.name,path:"/__clank_resilience_run",status:200}],boot:async({databasePath,signal})=>{
    phase="boot";
    const fetchDependency:typeof fetch=async(input,init)=>{signal.throwIfAborted();const request=new Request(input,init),url=new URL(request.url),handler=dependencies.get(url.origin);if(!handler)throw new Error("Undeclared rehearsal dependency.");if(activeFault&&scenario.fault==="dependency-unavailable"){injected++;return new Response("Fixture dependency unavailable",{status:503});}return handler(request);};
    const app=await options.boot({databasePath,signal,fetchDependency});let disposed=false,run:Promise<Response>|undefined;
    const request=async(path:string,init:RequestInit={}):Promise<Response>=>{
      signal.throwIfAborted();if(disposed)throw new Error("Rehearsal app is closed.");
      if(typeof path!=="string"||!path.startsWith("/")||path.startsWith("//")||/[\\\u0000-\u0020]/.test(path)||path.length>2048)throw new TypeError("Rehearsal requests require safe local paths.");
      const url=new URL(path,"http://rehearsal.example.invalid");if(url.origin!=="http://rehearsal.example.invalid")throw new TypeError("Rehearsal request escaped its app.");
      requests++;
      if(activeFault&&scenario.fault==="offline"){injected++;throw new TypeError("Injected offline transport.");}
      let input=new Request(url,{...init,signal:AbortSignal.any([signal,...(init.signal?[init.signal]:[])])});
      if(activeFault&&scenario.fault==="interrupted-upload"&&input.body){
        const bytes=new Uint8Array(await input.arrayBuffer());if(bytes.length>65536)throw new Error("Rehearsal upload exceeds 64 KiB.");let sent=false;
        const body=new ReadableStream<Uint8Array>({pull(controller){if(!sent){sent=true;controller.enqueue(bytes.slice(0,Math.max(1,Math.floor(bytes.length/2))));}else controller.error(new Error("Injected upload interruption."));}});
        input=new Request(url,{...init,body,signal,duplex:"half"} as RequestInit);injected++;
      }
      const response=await app.handle(input);
      if(activeFault&&scenario.fault==="lost-response"){injected++;await response.body?.cancel();throw new TypeError("Injected lost response after application execution.");}
      return response;
    };
    const within=async<Value>(operation:Promise<Value>):Promise<Value>=>{
      signal.throwIfAborted();let stop=()=>{};
      const aborted=new Promise<never>((_resolve,reject)=>{const abort=()=>reject(new Error("Rehearsal aborted."));signal.addEventListener("abort",abort,{once:true});stop=()=>signal.removeEventListener("abort",abort);});
      try{return await Promise.race([operation,aborted]);}finally{stop();}
    };
    const execute=async()=>{
      let workerStopped=false;
      try{
        phase="baseline";const before=requests;await within(scenario.verify({signal,phase:"baseline",request}));if(requests===before)throw new Error("Baseline verification made no application request.");
        phase="fault";activeFault=true;
        if(scenario.fault==="worker-restart"){if(!app.crashWorker||!app.restartWorker)throw new Error("Worker fault requires crash/restart adapters.");workerStopped=true;await within(app.crashWorker());injected++;}
        await within(scenario.exercise({signal,phase:"fault",request}));if(!injected)throw new Error("Scenario did not exercise its declared fault.");
        activeFault=false;phase="recovery";if(workerStopped){await within(app.restartWorker!());workerStopped=false;}
        const beforeRecovery=requests;await within(scenario.verify({signal,phase:"recovered",request}));if(requests===beforeRecovery)throw new Error("Recovery verification made no application request.");
        verified=true;phase="complete";return new Response("Recovery verified");
      }catch{return new Response("Scenario failed",{status:500});}
      finally{activeFault=false;if(workerStopped&&!signal.aborted)try{await within(app.restartWorker!());}catch{verified=false;phase="cleanup";}}
    };
    return{handle(request){if(new URL(request.url).pathname==="/__clank_resilience_run"){run??=execute();return run.then(response=>response.clone());}return app.handle(request);},async close(){disposed=true;await app.close();}};
  }});
  results.push(Object.freeze({name:scenario.name,fault:scenario.fault,ok:report.ok&&verified,phase:report.failurePhase&&phase==="complete"?report.failurePhase:phase,injected,requests,durationMs:performance.now()-started}));
 }
 return Object.freeze({protocol:"clank-resilience/1",ok:results.every(result=>result.ok),scenarios:Object.freeze(results)});
}
