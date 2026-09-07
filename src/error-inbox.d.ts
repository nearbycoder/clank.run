import type { SQLiteDatabase } from "./backend.js";
export interface ErrorFrame { readonly file: string; readonly line: number; readonly column: number; readonly mapped: boolean; }
export interface ErrorOccurrence { readonly id: number; readonly release: string; readonly at: number; readonly traceId: string | null; readonly frames: readonly ErrorFrame[]; }
export interface ErrorGroup { readonly fingerprint: string; readonly code: string; readonly state: "open" | "resolved" | "regressed"; readonly resolvedIn: string | null; readonly firstSeen: number; readonly lastSeen: number; readonly occurrences: number; readonly releases: readonly { readonly release: string; readonly count: number; readonly lastSeen: number }[]; readonly recent: readonly ErrorOccurrence[]; }
export interface ErrorInboxSnapshot { readonly protocol: "clank-error-inbox/1"; readonly groups: readonly ErrorGroup[]; readonly retainedEvents: number; readonly maxEvents: number; }
export interface ErrorInbox {
  registerSourceMap(release:string,generatedFile:string,payload:unknown):void;
  capture(error:unknown,context:{release:string;code?:string;traceId?:string}):string;
  resolve(fingerprint:string,release:string):boolean;
  snapshot(options?:{release?:string;state?:ErrorGroup["state"]}):ErrorInboxSnapshot;
}

export declare function openErrorInbox(database:SQLiteDatabase<any>,options?:{maxEvents?:number;maxAgeMs?:number;now?:()=>number}):Promise<ErrorInbox>;
export declare function renderErrorInbox(snapshot:ErrorInboxSnapshot):string;
