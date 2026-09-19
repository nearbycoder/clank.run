import type {RehearsalOptions,RehearsalApplication} from "./rehearsal.js";
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

export declare function rehearseResilience(options:ResilienceOptions):Promise<ResilienceReport>;
