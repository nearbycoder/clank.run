import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

// Private first-base transport. Formatting/authentication is not source,
// filesystem, process, readiness or provider ownership authority. The producer
// and dispatcher must retain their genuine owners around every asynchronous step.
export interface SourceSQLiteTaskRequest {
  readonly protocol: "clank-source-sqlite-task/1";
  readonly operation: "backup" | "inspect" | "verify";
  readonly backupId: string;
  readonly temporaryId: string | null;
}
export interface SourceWorkerIdentity {
  readonly bindingSha256: string;
  readonly containerId: string;
  readonly sourceIncarnation: string;
}
export interface SourceWorkerChannelBinding extends SourceWorkerIdentity {
  readonly channelId: string;
}
export interface SourceWorkerInspection {
  readonly revision: number | null;
  readonly migrationCount: number;
  readonly latestMigration: string | null;
}
export interface AcceptedSourceWorkerRequest { readonly task: SourceSQLiteTaskRequest }

export const SOURCE_WORKER_REQUEST_MAX_BYTES = 2048;
export const SOURCE_WORKER_RESPONSE_MAX_BYTES = 8192;
const PROTOCOL = "clank-provider-source-worker/1";
const DIGEST = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const TEMPORARY = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const NONCE = /^[A-Za-z0-9_-]{24}$/u;
const OPERATIONS = ["backup", "inspect", "verify"] as const;
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typed, "byteLength")!.get!;
const backingBuffer = Object.getOwnPropertyDescriptor(typed, "buffer")!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
function invalid(): never { throw new Error("Invalid private source worker protocol."); }

function own(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const fields = Reflect.ownKeys(value);
  if (fields.length !== names.length || fields.some(name => typeof name !== "string" || !names.includes(name))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(value, name);
    if (!field || !("value" in field)) invalid();
    result[name] = field.value;
  }
  return result;
}
function match(value: unknown, expression: RegExp): value is string {
  return typeof value === "string" && expression.test(value);
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0);
}
function binding(value: unknown): SourceWorkerChannelBinding {
  const data = own(value, ["bindingSha256", "containerId", "sourceIncarnation", "channelId"]);
  if (!match(data.bindingSha256, DIGEST) || !match(data.containerId, DIGEST)
    || !match(data.sourceIncarnation, UUID) || !match(data.channelId, TEMPORARY)) invalid();
  return Object.freeze({ bindingSha256: data.bindingSha256, containerId: data.containerId,
    sourceIncarnation: data.sourceIncarnation, channelId: data.channelId });
}
export function sourceSQLiteTaskRequest(value: unknown): SourceSQLiteTaskRequest {
  const data = own(value, ["protocol", "operation", "backupId", "temporaryId"]);
  if (data.protocol !== "clank-source-sqlite-task/1" || !OPERATIONS.includes(data.operation as any)
    || typeof data.backupId !== "string" || data.backupId.length > 45) invalid();
  const id = /^bk_([1-9][0-9]{0,15})_[A-Za-z0-9_-]{24}$/u.exec(data.backupId);
  if (!id || !Number.isSafeInteger(Number(id[1]))) invalid();
  if (data.operation === "backup" ? !match(data.temporaryId, TEMPORARY) : data.temporaryId !== null) invalid();
  return Object.freeze({ protocol: "clank-source-sqlite-task/1", operation: data.operation as SourceSQLiteTaskRequest["operation"],
    backupId: data.backupId, temporaryId: data.temporaryId as string | null });
}
function inspection(value: unknown): SourceWorkerInspection {
  const data = own(value, ["revision", "migrationCount", "latestMigration"]);
  if (data.revision !== null && !integer(data.revision) || !integer(data.migrationCount)
    || data.latestMigration !== null && (typeof data.latestMigration !== "string"
      || !data.latestMigration || data.latestMigration.length > 1024
      || /[\u0000-\u001f\u007f]/u.test(data.latestMigration))) invalid();
  return Object.freeze({ revision: data.revision as number | null, migrationCount: data.migrationCount,
    latestMigration: data.latestMigration as string | null });
}
function parse(encoded: unknown, maximum: number): unknown {
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > maximum) invalid();
  try { return JSON.parse(encoded); } catch { invalid(); }
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function keys(controlSecret: Uint8Array, value: SourceWorkerChannelBinding) {
  // Native typed-array slots avoid key getters/iterators and reject shared or
  // oversized backing input before copying. Never mutate the caller's key.
  if (!(controlSecret instanceof Uint8Array) || !ArrayBuffer.isView(controlSecret)) invalid();
  try {
    if (byteLength.call(controlSecret) !== 32) invalid();
    arrayBufferLength.call(backingBuffer.call(controlSecret));
  } catch { invalid(); }
  const copy = new Uint8Array(controlSecret);
  try {
    const derive = (direction: string) => createHmac("sha256", copy)
      .update(JSON.stringify({ protocol: "clank-provider-source-worker-key/1", direction, binding: value })).digest();
    return { request: derive("request"), response: derive("response") };
  } finally { copy.fill(0); }
}
function authenticator(key: Uint8Array, body: object): string {
  return createHmac("sha256", key).update(JSON.stringify(body)).digest("hex");
}
function authenticated(encoded: string, body: object, mac: unknown, key: Uint8Array): void {
  if (!match(mac, DIGEST) || JSON.stringify({ ...body, mac }) !== encoded
    || !timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(authenticator(key, body), "hex"))) invalid();
}
function assertTaskOrder(value: SourceSQLiteTaskRequest, sequence: number, backupId: string | undefined): void {
  if (value.operation !== OPERATIONS[sequence - 1] || backupId !== undefined && value.backupId !== backupId) invalid();
}
interface Request {
  readonly protocol: typeof PROTOCOL;
  readonly kind: "request";
  readonly binding: SourceWorkerChannelBinding;
  readonly sequence: number;
  readonly nonce: string;
  readonly task: SourceSQLiteTaskRequest;
}
function request(encoded: string, expected: SourceWorkerChannelBinding, key: Uint8Array): Request {
  const data = own(parse(encoded, SOURCE_WORKER_REQUEST_MAX_BYTES),
    ["protocol", "kind", "binding", "sequence", "nonce", "task", "mac"]);
  if (data.protocol !== PROTOCOL || data.kind !== "request" || !integer(data.sequence, 1)
    || data.sequence > 3 || !match(data.nonce, NONCE)) invalid();
  const declared = binding(data.binding);
  if (JSON.stringify(declared) !== JSON.stringify(expected)) invalid();
  const body: Request = { protocol: PROTOCOL, kind: "request", binding: declared,
    sequence: data.sequence, nonce: data.nonce, task: sourceSQLiteTaskRequest(data.task) };
  authenticated(encoded, body, data.mac, key);
  return Object.freeze(body);
}
interface Response {
  readonly protocol: typeof PROTOCOL;
  readonly kind: "response";
  readonly binding: SourceWorkerChannelBinding;
  readonly sequence: number;
  readonly nonce: string;
  readonly requestSha256: string;
  readonly status: "ok" | "refused";
  readonly result: SourceWorkerInspection | null;
}
interface Pending { readonly request: Request; readonly sha256: string }

/** Wire state only; no native authority, work, filesystem or network is minted. */
export function createSourceWorkerClientProtocol(controlSecret: Uint8Array, channel: SourceWorkerChannelBinding) {
  const scope = binding(channel), secret = keys(controlSecret, scope);
  let closed = false, sequence = 0, backupId: string | undefined, pending: Pending | undefined;
  const close = () => { closed = true; pending = undefined; secret.request.fill(0); secret.response.fill(0); };
  const current = () => { if (closed) invalid(); };
  return Object.freeze({
    begin(value: SourceSQLiteTaskRequest): string {
      current(); if (pending || sequence >= 3) invalid();
      const approved = sourceSQLiteTaskRequest(value); assertTaskOrder(approved, sequence + 1, backupId);
      const body: Request = { protocol: PROTOCOL, kind: "request", binding: scope,
        sequence: sequence + 1, nonce: randomBytes(18).toString("base64url"), task: approved };
      const encoded = JSON.stringify({ ...body, mac: authenticator(secret.request, body) });
      if (Buffer.byteLength(encoded, "utf8") > SOURCE_WORKER_REQUEST_MAX_BYTES) invalid();
      pending = { request: Object.freeze(body), sha256: digest(encoded) };
      sequence++; backupId ??= approved.backupId;
      return encoded;
    },
    finish(encoded: string): SourceWorkerInspection | undefined {
      current(); if (!pending) invalid();
      try {
        const data = own(parse(encoded, SOURCE_WORKER_RESPONSE_MAX_BYTES),
          ["protocol", "kind", "binding", "sequence", "nonce", "requestSha256", "status", "result", "mac"]);
        const original = pending.request;
        if (data.protocol !== PROTOCOL || data.kind !== "response"
          || JSON.stringify(binding(data.binding)) !== JSON.stringify(scope)
          || data.sequence !== original.sequence || data.nonce !== original.nonce
          || data.requestSha256 !== pending.sha256 || !["ok", "refused"].includes(data.status as any)) invalid();
        const result = data.status === "ok" && original.task.operation === "inspect" ? inspection(data.result) : null;
        if (result === null && data.result !== null) invalid();
        const body: Response = { protocol: PROTOCOL, kind: "response", binding: scope, sequence: original.sequence,
          nonce: original.nonce, requestSha256: pending.sha256, status: data.status as Response["status"], result };
        authenticated(encoded, body, data.mac, secret.response);
        pending = undefined;
        if (data.status === "refused") { close(); throw new Error("Private source worker refused initialization."); }
        if (sequence === 3) close();
        return result ?? undefined;
      } catch (error) { close(); throw error; }
    },
    close,
  });
}

/** Authenticated task receipts are wire correlation, never worker authority. */
export function createSourceWorkerServerProtocol(controlSecret: Uint8Array, identity: SourceWorkerIdentity) {
  // A new server never adopts an old channel epoch or its replay history.
  const fields = own(identity, ["bindingSha256", "containerId", "sourceIncarnation"]);
  const scope = binding({ ...fields, channelId: randomUUID() }), secret = keys(controlSecret, scope);
  const receipts = new WeakMap<AcceptedSourceWorkerRequest, Pending>(), nonces = new Set<string>();
  let closed = false, sequence = 0, backupId: string | undefined, active: AcceptedSourceWorkerRequest | undefined;
  const close = () => { closed = true; if (active) receipts.delete(active); active = undefined;
    nonces.clear(); secret.request.fill(0); secret.response.fill(0); };
  const current = () => { if (closed) invalid(); };
  const complete = (accepted: AcceptedSourceWorkerRequest, status: Response["status"], value?: unknown): string => {
    current(); const held = receipts.get(accepted);
    if (!held || active !== accepted) invalid();
    const result = status === "ok" && held.request.task.operation === "inspect" ? inspection(value) : null;
    if (result === null && value !== undefined && value !== null) invalid();
    const body: Response = { protocol: PROTOCOL, kind: "response", binding: scope,
      sequence: held.request.sequence, nonce: held.request.nonce, requestSha256: held.sha256, status, result };
    const encoded = JSON.stringify({ ...body, mac: authenticator(secret.response, body) });
    if (Buffer.byteLength(encoded, "utf8") > SOURCE_WORKER_RESPONSE_MAX_BYTES) invalid();
    receipts.delete(accepted); active = undefined;
    if (status === "refused" || sequence === 3) close();
    return encoded;
  };
  return Object.freeze({
    binding: scope,
    accept(encoded: string): AcceptedSourceWorkerRequest {
      current(); if (active || sequence >= 3) invalid();
      const approved = request(encoded, scope, secret.request);
      if (approved.sequence !== sequence + 1 || nonces.has(approved.nonce)) invalid();
      assertTaskOrder(approved.task, approved.sequence, backupId);
      const accepted = Object.freeze({ task: approved.task });
      receipts.set(accepted, { request: approved, sha256: digest(encoded) });
      active = accepted; sequence++; backupId ??= approved.task.backupId; nonces.add(approved.nonce);
      return accepted;
    },
    reply(accepted: AcceptedSourceWorkerRequest, result?: unknown): string { return complete(accepted, "ok", result); },
    refuse(accepted: AcceptedSourceWorkerRequest): string { return complete(accepted, "refused"); },
    close,
  });
}


// Raw bounded UNIX transport only. Neither filesystem capabilities nor wire
// formatting mint provider/source authority. Its caller must retain the genuine
// grant/container/worker and use the authenticated protocol before execution.
const SOCKET_BROKER_BOOTSTRAP = `
const net=await import('node:net'),fs=await import('node:fs');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let client,used=false,pending=false,closed=false,input='',command='',requests=0,frameBytes=0,frameTimer;
const incoming=new TextDecoder('utf-8',{fatal:true}),commands=new TextDecoder('utf-8',{fatal:true});
const dispose=()=>{if(closed)return;closed=true;clearTimeout(frameTimer);client?.destroy();process.chdir('/proc/self/fd/4');server.close(()=>process.exit(0));};
process.chdir('/proc/self/fd/3');
const server=net.createServer(socket=>{
 if(closed||used){socket.destroy();return;}used=true;client=socket;frameTimer=setTimeout(dispose,10000);
 socket.on('error',dispose);socket.on('close',dispose);
 socket.on('data',chunk=>{
  if(closed||pending||(frameBytes+=chunk.length)>2049){dispose();return;}
  try{input+=incoming.decode(chunk,{stream:true});}catch{dispose();return;}const end=input.indexOf('\\n');if(end<0)return;
  // A streaming decoder can hide an incomplete suffix after the newline.
  if(chunk[chunk.length-1]!==10||end!==input.length-1||Buffer.byteLength(input.slice(0,end))>2048||input.includes('\\r')||input.includes('\\uFFFD')){dispose();return;}
  if(++requests>3){dispose();return;}clearTimeout(frameTimer);frameTimer=setTimeout(dispose,30000);pending=true;send({kind:'request',body:input.slice(0,end)});input='';
 });
});
server.on('error',()=>process.exit(1));server.listen('socket',()=>{fs.chmodSync('socket',0o600);send({kind:'ready'});});
process.stdin.on('end',dispose);process.stdin.on('data',chunk=>{
 if(closed||chunk.length>50176||Buffer.byteLength(command)+chunk.length>50176){dispose();return;}
 try{command+=commands.decode(chunk,{stream:true});}catch{dispose();return;}const end=command.indexOf('\\n');if(end<0)return;
 if(end!==command.length-1){dispose();return;}let value;try{value=JSON.parse(command.slice(0,end));}catch{dispose();return;}command='';
 if(value.kind==='close'){dispose();return;}
 if(value.kind!=='reply'||!pending||!client||typeof value.body!=='string'||Buffer.byteLength(value.body)>8192||value.body.includes('\\n')||value.body.includes('\\r')){dispose();return;}
 pending=false;frameBytes=0;clearTimeout(frameTimer);frameTimer=setTimeout(dispose,10000);client.write(value.body+'\\n');
});
`;
export interface SourceWorkerSocketBroker {
  readonly socketPath:string;
  receive():Promise<string>;
  reply(encoded:string):void;
  close():Promise<void>;
}
/** Internal transport; the three directories must be original retained capabilities. */
export async function openSourceWorkerSocketBroker(
  listener:import("./sqlite-sandbox.ts").PinnedSQLiteDirectory,
  disposal:import("./sqlite-sandbox.ts").PinnedSQLiteDirectory,
  mount:import("./sqlite-sandbox.ts").PinnedSQLiteDirectory,
):Promise<SourceWorkerSocketBroker> {
  const sandbox=await import("./sqlite-sandbox.ts"),fs=await import("node:fs"),cp=await import("node:child_process");
  const process=(globalThis as any).process;
  if(process.platform!=="linux"||!process.getuid?.()||!process.getgid?.())throw new Error("Private UNIX transport requires its native non-root Linux owner.");
  const pins=[listener,disposal,mount],identities=pins.map(pin=>{sandbox.assertPinnedSQLiteDirectory(pin);const held=fs.fstatSync(pin.fd),visible=fs.lstatSync(pin.path);
    if(!held.isDirectory()||!visible.isDirectory()||held.dev!==visible.dev||held.ino!==visible.ino||held.uid!==process.getuid()||held.gid!==process.getgid()
      ||(held.mode&0o777)!==0o700||fs.realpathSync(pin.path)!==pin.path)throw new Error("Private UNIX transport directory differs.");return {dev:held.dev,ino:held.ino};});
  if(new Set(identities.map(p=>p.dev+":"+p.ino)).size!==3)throw new Error("Private UNIX transport directories must be distinct.");
  // Change only the original, retained disposal inode. The broker then closes
  // its relative binding from this empty non-writable directory, so Node never
  // unlinks a replacement at the listener or public endpoint pathname.
  if(fs.readdirSync(disposal.anchor).length)throw new Error("Private UNIX disposal directory must be empty.");
  const original=listener.anchor+"/socket",endpoint=mount.anchor+"/sqlite.sock";
  for(const path of [original,endpoint]){let present=false;try{fs.lstatSync(path);present=true;}catch(error){if((error as any).code!=="ENOENT")throw error;}
    if(present)throw new Error("Private UNIX endpoint cannot be adopted.");}
  fs.fchmodSync(disposal.fd,0o500);
  let closed=false,ready=false,published=false,socketFd:number|undefined,socketIdentity:{dev:number;ino:number}|undefined;
  const outputDecoder=new TextDecoder("utf-8",{fatal:true});
  let active=false;
  let partial='',waiting:((value:string)=>void)|undefined,rejectWaiting:((error:Error)=>void)|undefined,queued:string|undefined;
  let readyResolve!:()=>void,readyReject!:(error:Error)=>void;const readiness=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const child=cp.spawn("/usr/bin/setpriv",["--inh-caps=-all","--ambient-caps=-all","--no-new-privs","/usr/bin/prlimit",...sandbox.SQLITE_RESOURCE_LIMITS,"--",process.execPath,"--jitless","--max-old-space-size=64","--input-type=module","--eval",SOCKET_BROKER_BOOTSTRAP],{
    stdio:["pipe","pipe","pipe",listener.fd,disposal.fd],env:{NODE_NO_WARNINGS:"1"},windowsHide:true,
  });
  let closeResolve!:()=>void;const actualClose=new Promise<void>(resolve=>closeResolve=resolve);
  const fail=(error:Error)=>{closed=true;readyReject(error);rejectWaiting?.(error);waiting=undefined;rejectWaiting=undefined;queued=undefined;child.kill("SIGKILL");};
  // These three streams are pipes in the fixed spawn configuration above.
  const stdin=child.stdin!,stdout=child.stdout!,stderr=child.stderr!;
  child.on("error",fail);stdin.on("error",fail);stderr.resume();
  stdout.on("data",(chunk:Uint8Array)=>{
    if(chunk.length>16384||Buffer.byteLength(partial)+chunk.length>16384){fail(new Error("Private UNIX broker output exceeds its bound."));return;}
    try{partial+=outputDecoder.decode(chunk,{stream:true});}catch{fail(new Error("Invalid private UNIX output encoding."));return;}let end;while((end=partial.indexOf("\n"))>=0){
    const line=partial.slice(0,end);partial=partial.slice(end+1);let value:Record<string,unknown>;
    try{value=JSON.parse(line);if(JSON.stringify(value)!==line)throw Error();}catch{fail(new Error("Invalid private UNIX broker output."));return;}
    if(value.kind==="ready"&&Object.keys(value).length===1&&!ready){ready=true;readyResolve();continue;}
    if(value.kind!=="request"||Object.keys(value).length!==2||typeof value.body!=="string"||Buffer.byteLength(value.body)>2048||queued!==undefined){fail(new Error("Invalid private UNIX request frame."));return;}
    try{current();}catch(error){fail(error as Error);return;}
    if(waiting){const resolve=waiting;waiting=undefined;rejectWaiting=undefined;active=true;resolve(value.body);}else queued=value.body;
    }
  });
  child.on("close",()=>{closed=true;readyReject(new Error("Private UNIX broker closed."));rejectWaiting?.(new Error("Private UNIX broker closed."));closeResolve();});
  const current=()=>{
    if(closed)throw new Error("Private UNIX broker is closed.");
    for(let i=0;i<pins.length;i++){sandbox.assertPinnedSQLiteDirectory(pins[i]!);const held=fs.fstatSync(pins[i]!.fd),visible=fs.lstatSync(pins[i]!.path),expected=identities[i]!;
      if(held.dev!==expected.dev||held.ino!==expected.ino||visible.dev!==expected.dev||visible.ino!==expected.ino||!visible.isDirectory()
        ||held.uid!==process.getuid()||held.gid!==process.getgid()||(held.mode&0o777)!==(i===1?0o500:0o700)||fs.realpathSync(pins[i]!.path)!==pins[i]!.path)throw new Error("Private UNIX directory changed.");}
    if(published){const held=fs.fstatSync(socketFd!),visible=fs.lstatSync(endpoint),source=fs.lstatSync(original);
      if(!held.isSocket()||!visible.isSocket()||!source.isSocket()||[held,visible,source].some(p=>p.dev!==socketIdentity!.dev||p.ino!==socketIdentity!.ino||p.uid!==process.getuid()||p.gid!==process.getgid()||(p.mode&0o777)!==0o600||p.nlink!==2))throw new Error("Private UNIX socket identity changed.");}
  };
  const close=async()=>{
    if(!closed){closed=true;try{stdin.end(JSON.stringify({kind:"close"})+"\n");}catch{child.kill("SIGKILL");}}
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([actualClose,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Private UNIX broker close is unsettled after 10000ms."));},10000);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
    // A pathname is cleanup authority only while it still names the pinned
    // socket. Preserve unknown replacements and partial acquisition evidence.
    if(socketFd!==undefined){const held=fs.fstatSync(socketFd);
      for(const [directory,path,index] of [[mount,endpoint,2],[listener,original,0]] as const){
        // Caller-owned directory capabilities must outlive actual broker close;
        // an FD number reused after their closure is never cleanup authority.
        sandbox.assertPinnedSQLiteDirectory(directory);const parent=fs.fstatSync(directory.fd),expected=identities[index]!;
        if(!parent.isDirectory()||parent.dev!==expected.dev||parent.ino!==expected.ino)throw new Error("Private UNIX cleanup directory changed.");
        let visible;try{visible=fs.lstatSync(path);}catch(error){if((error as any).code==="ENOENT")continue;throw error;}
        if(visible.isSocket()&&visible.dev===held.dev&&visible.ino===held.ino)fs.unlinkSync(path);}
      fs.closeSync(socketFd);socketFd=undefined;}
  };
  try{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([readiness,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Private UNIX broker readiness exceeded 10000ms.")),10000);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
    current();const before=fs.lstatSync(original);if(!before.isSocket()||before.uid!==process.getuid()||before.gid!==process.getgid()||(before.mode&0o777)!==0o600||before.nlink!==1)throw new Error("Private UNIX listener differs.");
    // Linux O_PATH pins a socket inode without attempting a filesystem open
    // as a stream. O_NOFOLLOW prevents a substituted symbolic link.
    socketFd=fs.openSync(original,0x200000|fs.constants.O_NOFOLLOW);const held=fs.fstatSync(socketFd);if(!held.isSocket()||held.dev!==before.dev||held.ino!==before.ino)throw new Error("Private UNIX listener changed.");
    socketIdentity={dev:held.dev,ino:held.ino};fs.linkSync(original,endpoint);published=true;current();
    return Object.freeze({socketPath:mount.path+"/sqlite.sock",receive(){current();if(active)return Promise.reject(new Error("Private UNIX broker already has an unanswered frame."));if(waiting)return Promise.reject(new Error("Private UNIX broker already has a receiver."));if(queued!==undefined){const body=queued;queued=undefined;active=true;return Promise.resolve(body);}return new Promise<string>((resolve,reject)=>{waiting=resolve;rejectWaiting=reject;});},
      reply(encoded:string){current();if(!active)throw new Error("Private UNIX broker has no unanswered frame.");if(typeof encoded!=="string"||Buffer.byteLength(encoded)>8192||/[\r\n]/u.test(encoded))throw new Error("Private UNIX response exceeds its frame.");active=false;stdin.write(JSON.stringify({kind:"reply",body:encoded})+"\n");},close});
  }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],"Private UNIX broker acquisition and cleanup failed.");}throw error;}
}
