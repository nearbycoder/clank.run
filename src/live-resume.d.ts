export interface LiveSplice { readonly start: number; readonly deleteCount: number; readonly insert: string; }
export interface LiveResumeOptions { maxEntries?: number; maxBytes?: number; maxAgeMs?: number; }
export interface LiveReplayStore { encode(scope:string,previousId:string|null,value:unknown,version:number):{id:string;payload:unknown}; clear():void; }

export declare function createLiveReplayStore(options?:LiveResumeOptions):LiveReplayStore;
export declare function applyLiveSplice(previous:unknown,splice:LiveSplice,maximumBytes?:number):unknown;
