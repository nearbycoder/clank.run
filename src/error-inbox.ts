import { SQLITE_INTERNAL } from "./sqlite-internal.ts";
import type { SQLiteDatabase } from "./backend.ts";

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

/** Operator-only error metadata. Message text, source contents and raw stacks never enter storage. */
export async function openErrorInbox(database:SQLiteDatabase<any>,options:{maxEvents?:number;maxAgeMs?:number;now?:()=>number}={}):Promise<ErrorInbox>{
 const maximum=options.maxEvents??1000,age=options.maxAgeMs??7*86400000;
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>10000||!Number.isSafeInteger(age)||age<1000||age>90*86400000)throw new TypeError("Invalid error inbox retention.");
 const {SourceMap}=await import("node:module"),{createHash}=await import("node:crypto");
 const sql=database[SQLITE_INTERNAL],maps=new Map<string,InstanceType<typeof SourceMap>>();
 const now=()=>{const at=(options.now??Date.now)();if(!Number.isSafeInteger(at)||at<0)throw new TypeError("Invalid error inbox clock.");return at;};
 sql.exec("CREATE TABLE IF NOT EXISTS clank_error_groups (fingerprint TEXT PRIMARY KEY, code TEXT NOT NULL, state TEXT NOT NULL, resolved_in TEXT, resolved_at INTEGER)");
 sql.exec("CREATE TABLE IF NOT EXISTS clank_error_occurrences (id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL, release TEXT NOT NULL, at INTEGER NOT NULL, trace_id TEXT, frames TEXT NOT NULL)");
 sql.exec("CREATE INDEX IF NOT EXISTS clank_error_occurrence_group ON clank_error_occurrences(fingerprint, id DESC)");
 const prune=()=>{sql.prepare("DELETE FROM clank_error_occurrences WHERE at < ?").run(now()-age);sql.prepare("DELETE FROM clank_error_occurrences WHERE id NOT IN (SELECT id FROM clank_error_occurrences ORDER BY id DESC LIMIT ?)").run(maximum);sql.prepare("DELETE FROM clank_error_groups WHERE fingerprint NOT IN (SELECT fingerprint FROM clank_error_occurrences)").run();};
 return{
  registerSourceMap(release,generatedFile,payload){
   identifier(release,"release");const file=sourceFile(generatedFile);if(!file)throw new TypeError("Invalid generated filename.");
   const data=payload as any;
   if(!data||data.version!==3||!Array.isArray(data.sources)||data.sources.length>1000||!Array.isArray(data.names)||data.names.length>10000||typeof data.mappings!=="string"||data.mappings.length>1000000)throw new TypeError("Expected a bounded version 3 source map.");
   if(data.sources.some((value:unknown)=>typeof value!=="string"||value.length>2048)||data.names.some((value:unknown)=>typeof value!=="string"||value.length>256))throw new TypeError("Invalid source map metadata.");
   const key=`${release}\n${file}`;if(!maps.has(key)&&maps.size>=100)maps.delete(maps.keys().next().value!);
   // Never retain sourcesContent or arbitrary extension fields.
   maps.set(key,new SourceMap({version:3,file,sources:[...data.sources],names:[...data.names],mappings:data.mappings}));
  },
  capture(error,context){
   const release=identifier(context.release,"release"),code=identifier(context.code??(error instanceof Error&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.name)?error.name:"Error"),"error code");
   if(context.traceId!==undefined&&!/^[0-9a-f]{32}$/.test(context.traceId))throw new TypeError("Trace ID must be 32 lowercase hexadecimal characters.");
   const frames:ErrorFrame[]=[];
   const stack=error instanceof Error?String(error.stack??"").slice(0,32000):"";
   for(const line of stack.split("\n").slice(1,33)){
    const match=/(?:\(|\s)([^()\s]+):(\d+):(\d+)\)?$/.exec(line);if(!match)continue;
    const file=sourceFile(match[1]!);let lineNumber=Number(match[2]),column=Number(match[3]);if(!file||!Number.isSafeInteger(lineNumber)||lineNumber<1||!Number.isSafeInteger(column)||column<1)continue;
    const original=maps.get(`${release}\n${file}`)?.findOrigin(lineNumber,column);
    const mappedFile=original?.fileName?sourceFile(original.fileName):null;
    if(mappedFile&&original?.lineNumber&&original.columnNumber){frames.push({file:mappedFile,line:original.lineNumber,column:original.columnNumber,mapped:true});}
    else frames.push({file,line:lineNumber,column,mapped:false});
    if(frames.length===8)break;
   }
   const fingerprint=createHash("sha256").update(JSON.stringify([code,frames.slice(0,3).map(({file,line,column})=>({file,line,column}))])).digest("hex"),at=now();
   sql.transaction(()=>{
    sql.prepare("INSERT OR IGNORE INTO clank_error_groups(fingerprint,code,state) VALUES(?,?,'open')").run(fingerprint,code);
    sql.prepare("UPDATE clank_error_groups SET state='regressed' WHERE fingerprint=? AND state='resolved'").run(fingerprint);
    sql.prepare("INSERT INTO clank_error_occurrences(fingerprint,release,at,trace_id,frames) VALUES(?,?,?,?,?)").run(fingerprint,release,at,context.traceId??null,JSON.stringify(frames));prune();
   });return fingerprint;
  },
  resolve(fingerprint,release){identifier(release,"release");if(!/^[0-9a-f]{64}$/.test(fingerprint))throw new TypeError("Invalid error fingerprint.");let changed=false;sql.transaction(()=>{const result=sql.prepare("UPDATE clank_error_groups SET state='resolved',resolved_in=?,resolved_at=? WHERE fingerprint=?").run(release,now(),fingerprint);changed=Number(result.changes)>0;});return changed;},
  snapshot(filter={}){
   if(filter.release!==undefined)identifier(filter.release,"release");if(filter.state!==undefined&&!["open","resolved","regressed"].includes(filter.state))throw new TypeError("Invalid error state.");
   return sql.transaction(()=>{prune();
   const all=sql.prepare("SELECT id,fingerprint,release,at,trace_id,frames FROM clank_error_occurrences ORDER BY id DESC LIMIT ?").all(maximum);
   const buckets=new Map<string,typeof all>();for(const row of all){const key=String(row.fingerprint);const bucket=buckets.get(key)??[];bucket.push(row);buckets.set(key,bucket);}
   const groups:ErrorGroup[]=[];
   for(const group of sql.prepare("SELECT fingerprint,code,state,resolved_in FROM clank_error_groups").all()){
    const events=buckets.get(String(group.fingerprint))??[];if(filter.state&&group.state!==filter.state||filter.release&&!events.some(event=>event.release===filter.release))continue;
    const releases=new Map<string,{release:string;count:number;lastSeen:number}>();for(const event of events){const release=String(event.release),old=releases.get(release);releases.set(release,{release,count:(old?.count??0)+1,lastSeen:Math.max(old?.lastSeen??0,Number(event.at))});}
    groups.push(Object.freeze({fingerprint:String(group.fingerprint),code:String(group.code),state:group.state as ErrorGroup["state"],resolvedIn:group.resolved_in===null?null:String(group.resolved_in),firstSeen:Math.min(...events.map(event=>Number(event.at))),lastSeen:Math.max(...events.map(event=>Number(event.at))),occurrences:events.length,releases:Object.freeze([...releases.values()].map(Object.freeze)),recent:Object.freeze(events.slice(0,10).map(event=>Object.freeze({id:Number(event.id),release:String(event.release),at:Number(event.at),traceId:event.trace_id===null?null:String(event.trace_id),frames:Object.freeze(JSON.parse(String(event.frames)).map(Object.freeze))})))}));
   }
   return Object.freeze({protocol:"clank-error-inbox/1",groups:Object.freeze(groups.sort((a,b)=>b.lastSeen-a.lastSeen)),retainedEvents:all.length,maxEvents:maximum});});
  },
 };
}
function identifier(value:string,name:string):string{if(typeof value!=="string"||!/^[A-Za-z0-9._-]{1,128}$/.test(value))throw new TypeError(`Invalid ${name}.`);return value;}
function sourceFile(value:string):string|null{
 let path=value;try{if(/^[a-z]+:/i.test(path))path=new URL(path).pathname;}catch{return null;}
 path=path.split(/[?#]/,1)[0]!.replace(/\\/g,"/");
 // Keep only the final source directory and filename; absolute deployment roots are excluded.
 const parts=path.split("/").filter(part=>part&&part!=="."&&part!=="..").slice(-2);
 if(!parts.length||parts.some(part=>!/^[A-Za-z0-9_.@-]{1,128}$/.test(part)))return null;return parts.join("/");
}
export function renderErrorInbox(snapshot:ErrorInboxSnapshot):string{
 const escape=(value:unknown)=>String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
 return `<section aria-label="Release error inbox"><h2>Release error inbox</h2><p>${escape(snapshot.retainedEvents)} retained occurrences. No new occurrences is not proof of a fix without comparable traffic.</p>${snapshot.groups.length?snapshot.groups.map(group=>`<article style="border-top:1px solid #555;padding:16px 0;overflow-wrap:anywhere"><h3>${escape(group.code)} · ${escape(group.state)}</h3><p>${escape(group.occurrences)} occurrences · resolved in ${escape(group.resolvedIn??"no release")}</p><ul>${group.releases.map(release=>`<li>${escape(release.release)}: ${escape(release.count)} occurrences</li>`).join("")}</ul><details><summary>Recent locations and traces</summary>${group.recent.map(event=>`<p>${escape(event.release)} · trace ${escape(event.traceId??"unavailable")}</p><pre style="white-space:pre-wrap">${event.frames.map(frame=>escape(`${frame.file}:${frame.line}:${frame.column}${frame.mapped?" (source map)":""}`)).join("\n")}</pre>`).join("")}</details></article>`).join(""):"<p>No retained errors.</p>"}</section>`;
}
