import { functionPath, type FunctionReference, type SyncClient } from "./backend.ts";
import type { BucketAttachmentReference, BucketClient, BucketObject } from "./buckets.ts";
type InputOf<R> = R extends FunctionReference<any, infer Input, any> ? Input : never;

export type OfflineAttachmentStatus = "pending" | "uploading" | "attaching" | "failed";
export interface OfflineAttachment {
  readonly id: string;
  readonly path: string;
  readonly bucket: string;
  readonly key: string;
  readonly size: number;
  readonly status: OfflineAttachmentStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly errorCode?: string;
}
export interface OfflineAttachmentQueueOptions {
  namespace: string;
  userId: string;
  bucketName: string;
  bucket: Pick<BucketClient, "stat" | "upload">;
  client: Pick<SyncClient, "mutateOnce">;
  currentUser(): string | null;
  online?(): boolean;
  maxItems?: number;
  maxBlobBytes?: number;
  maxTotalBytes?: number;
  /** Defaults to the browser's native IndexedDB and Web Locks. */
  indexedDB?: IDBFactory;
  locks?: Pick<LockManager, "request">;
}
export interface OfflineAttachmentQueue {
  snapshot(): Promise<readonly OfflineAttachment[]>;
  enqueue<R extends FunctionReference<"mutation", any, any>>(reference: R,
    input: InputOf<R> extends {attachment: BucketAttachmentReference} ? Omit<InputOf<R>, "attachment"> : never, blob: Blob): Promise<string>;
  flush(): Promise<void>;
  retry(id: string): Promise<void>;
  discard(id: string): Promise<void>;
  subscribe(listener: (items: readonly OfflineAttachment[]) => void): () => void;
  dispose(): void;
}
interface StoredAttachment extends OfflineAttachment {
  owner: string;
  input: Record<string, unknown>;
  blob: Blob;
  sha256: string;
  object: BucketAttachmentReference | null;
}
const bounded = (value: number, name: string, min: number, max: number) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}.`);
  return value;
};
const idPattern = /^\d{13}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const shaPattern = /^[0-9a-f]{64}$/u;
const metadata = (items: readonly StoredAttachment[]) => Object.freeze(items.map(({id,path,bucket,key,size,status,attempts,nextAttemptAt,errorCode}) =>
  Object.freeze({id,path,bucket,key,size,status,attempts,nextAttemptAt,...(errorCode ? {errorCode} : {})})));
const waitFor = <T>(work: Promise<T>, signal: AbortSignal) => new Promise<T>((resolve,reject) => {
  const abort = () => { cleanup(); reject(signal.reason); }, cleanup = () => signal.removeEventListener("abort",abort);
  signal.addEventListener("abort",abort,{once:true}); if (signal.aborted) abort();
  void work.then(value => {cleanup();signal.aborted ? reject(signal.reason) : resolve(value);},error => {cleanup();reject(error);});
});

/** Bounded account-local binary work. Upload and record attachment have separate exact acknowledgments. */
export async function openOfflineAttachmentQueue(options: OfflineAttachmentQueueOptions): Promise<OfflineAttachmentQueue> {
  const {namespace,userId,bucketName,bucket,client,currentUser,online} = options;
  if (typeof namespace !== "string" || !namespace || namespace.length > 200 || typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/u.test(userId)
    || !/^[a-z][a-z0-9-]{0,62}$/u.test(bucketName) || typeof currentUser !== "function" || !bucket || typeof bucket.stat !== "function" || typeof bucket.upload !== "function"
    || !client || typeof client.mutateOnce !== "function" || online !== undefined && typeof online !== "function") throw new TypeError("A bounded application, account, bucket and client are required.");
  const maximum = bounded(options.maxItems ?? 100,"maxItems",1,100), blobMaximum = bounded(options.maxBlobBytes ?? 8*1024*1024,"maxBlobBytes",1,64*1024*1024);
  const totalMaximum = bounded(options.maxTotalBytes ?? 50*1024*1024,"maxTotalBytes",blobMaximum,256*1024*1024);
  const factory = options.indexedDB ?? globalThis.indexedDB, locks = options.locks ?? globalThis.navigator?.locks;
  if (!factory || !locks) throw new Error("Offline attachments require IndexedDB and Web Locks.");
  const name = `clank.attachments.v1:${encodeURIComponent(namespace)}:${encodeURIComponent(userId)}`;
  let closed = false, database: IDBDatabase | undefined;
  const lifecycle = new AbortController(), listeners = new Set<(items: readonly OfflineAttachment[]) => void>();
  const notify = (items: readonly OfflineAttachment[]) => { for (const listener of listeners) { try { listener(items); } catch {} } };
  const dispose = () => { if (closed) return; closed = true; lifecycle.abort(); database?.close(); notify([]); listeners.clear(); };
  const current = () => { if (closed) throw new Error("Offline attachment queue is disposed."); if (currentUser() !== userId) { dispose(); throw new Error("Offline attachments belong to another account."); } };
  current();
  database = await new Promise<IDBDatabase>((resolve,reject) => {
    const request = factory.open(name,1);
    request.onupgradeneeded = event => { if (event.oldVersion === 0) request.result.createObjectStore("items",{keyPath:"id"}); };
    request.onerror = () => reject(request.error ?? new Error("Could not open offline attachment storage."));
    request.onblocked = () => reject(new Error("Close older attachment queue tabs before upgrading storage."));
    request.onsuccess = () => { if (closed || currentUser() !== userId) { request.result.close(); reject(new Error("Offline attachment account changed.")); } else resolve(request.result); };
  }).catch(error => {dispose();throw error;});
  database.onversionchange = dispose;
  const validate = (rows: StoredAttachment[]) => {
    let bytes = 0, jsonBytes = 0;
    if (!Array.isArray(rows) || rows.length > maximum || new Set(rows.map(row => row?.id)).size !== rows.length) throw new Error("Invalid offline attachment storage.");
    for (const row of rows) {
      if (!row || typeof row.id !== "string" || !idPattern.test(row.id) || row.owner !== userId || row.bucket !== bucketName || row.key !== "offline-"+row.id.split(".")[1]
        || Object.keys(row).some(key => !["id","path","bucket","key","size","status","attempts","nextAttemptAt","errorCode","owner","input","blob","sha256","object"].includes(key))
        || typeof row.path !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(row.path) || !(row.blob instanceof Blob) || row.size !== row.blob.size || row.size > blobMaximum
        || typeof row.sha256 !== "string" || !shaPattern.test(row.sha256) || !["pending","uploading","attaching","failed"].includes(row.status) || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > 1000
        || !Number.isSafeInteger(row.nextAttemptAt) || row.nextAttemptAt < 0 || row.errorCode !== undefined && (typeof row.errorCode !== "string" || !/^[A-Z0-9_]{1,100}$/u.test(row.errorCode))
        || !row.input || typeof row.input !== "object" || Array.isArray(row.input) || Object.hasOwn(row.input,"attachment")) throw new Error("Invalid offline attachment storage.");
      if (row.object && (Object.keys(row.object).sort().join(",") !== "bucket,generation,key,objectId,sha256" || row.object.bucket !== bucketName || row.object.key !== row.key
        || row.object.sha256 !== row.sha256 || typeof row.object.objectId !== "string" || typeof row.object.generation !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(row.object.objectId) || !/^[A-Za-z0-9_-]{1,256}$/u.test(row.object.generation))) throw new Error("Invalid stored attachment acknowledgment.");
      if (row.object !== null && !row.object || row.status === "attaching" && !row.object) throw new Error("Invalid stored attachment state.");
      const size = new TextEncoder().encode(JSON.stringify(row.input)).length; if (size > 16384) throw new Error("Attachment arguments exceed their bound.");
      bytes += row.size; jsonBytes += size;
    }
    if (bytes > totalMaximum || jsonBytes > 1024*1024) throw new Error("Offline attachments exceed their storage bound.");
  };
  const access = <T>(write: boolean, work: (rows: StoredAttachment[]) => {rows: StoredAttachment[]; result: T}) => new Promise<T>((resolve,reject) => {
    current(); const transaction = database!.transaction("items",write ? "readwrite" : "readonly"), store = transaction.objectStore("items"), request = store.getAll(undefined,maximum+1);
    let result: T, error: unknown;
    request.onsuccess = () => {
      try {
        current(); const previous = request.result as StoredAttachment[]; validate(previous); const changed = work(previous); validate(changed.rows); result = changed.result;
        if (write) { const old = new Map(previous.map(row => [row.id,row])), retained = new Set(changed.rows.map(row => row.id));
          for (const id of old.keys()) if (!retained.has(id)) store.delete(id);
          for (const row of changed.rows) if (old.get(row.id) !== row) store.put(row);
        }
      } catch (caught) { error = caught; transaction.abort(); }
    };
    transaction.onerror = () => { error ??= transaction.error; };
    transaction.onabort = () => reject(error ?? transaction.error ?? new Error("Attachment storage transaction aborted."));
    transaction.oncomplete = () => { try { current(); resolve(result); } catch (caught) { reject(caught); } };
  });
  const snapshot = () => access(false, rows => ({rows,result:metadata(rows)}));
  const change = async (work: (rows: StoredAttachment[]) => StoredAttachment[]) => { const items = await access(true, rows => {const next=work(rows);return {rows:next,result:metadata(next)};}); current(); notify(items); };
  const update = (id: string, work: (item: StoredAttachment) => StoredAttachment) => change(rows => rows.map(row => row.id === id ? work(row) : row));
  const checked = (object: BucketObject, row: StoredAttachment): BucketAttachmentReference => {
    if (!object) throw Object.assign(new Error("Upload acknowledgment is unknown."),{status:502,code:"ATTACHMENT_ACK_UNKNOWN"});
    if (!object || object.ownerId !== userId || object.bucket !== bucketName || object.key !== row.key || object.size !== row.size || object.sha256 !== row.sha256
      || object.contentType !== row.blob.type || object.visibility !== "private" || typeof object.generation !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(object.generation)
      || !/^[A-Za-z0-9_-]{1,256}$/u.test(object.id)) throw Object.assign(new Error("Uploaded attachment does not match the queued object."),{status:409,code:"ATTACHMENT_CHANGED"});
    return Object.freeze({bucket:bucketName,key:row.key,objectId:object.id,sha256:row.sha256,generation:object.generation});
  };
  const queue: OfflineAttachmentQueue = {
    snapshot,
    async enqueue(reference,input,value) {
      current(); if (!(value instanceof Blob) || value.size > blobMaximum) throw new Error("Attachment exceeds its Blob bound.");
      const path = functionPath(reference), serialized = JSON.stringify(input);
      if (!serialized || new TextEncoder().encode(serialized).length > 16384) throw new Error("Attachment arguments exceed their bound.");
      const captured = JSON.parse(serialized); if (!captured || typeof captured !== "object" || Array.isArray(captured) || Object.hasOwn(captured,"attachment")) throw new TypeError("Attachment arguments must be a JSON object without attachment.");
      const contentType=(value.type.split(";",1)[0]||"application/octet-stream").trim().toLowerCase();
      if(!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u.test(contentType))throw new TypeError("Invalid attachment content type.");
      const blob = new Blob([value],{type:contentType}), bytes = await blob.arrayBuffer(); current();
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(byte => byte.toString(16).padStart(2,"0")).join(""); current();
      const id = `${Date.now()}.${crypto.randomUUID()}`;
      await change(rows => [...rows,{id,path,bucket:bucketName,key:"offline-"+id.split(".")[1],owner:userId,input:captured,blob,size:blob.size,sha256,object:null,status:"pending",attempts:0,nextAttemptAt:0}]); return id;
    },
    async flush() {
      current(); await locks.request(name,{signal:lifecycle.signal},async () => {
        while (true) {
          current(); if (!(online?.() ?? globalThis.navigator?.onLine ?? true)) return;
          const row = await access(false, rows => ({rows,result:rows[0]})); if (!row || row.status === "failed" || row.nextAttemptAt > Date.now()) return;
          if (row.attempts >= 1000) { await update(row.id,item => ({...item,status:"failed",errorCode:"ATTEMPTS_EXHAUSTED"})); return; }
          const cancellation = new AbortController(), abort = () => cancellation.abort(), timer = setTimeout(abort,60000);
          lifecycle.signal.addEventListener("abort",abort,{once:true});
          try {
            await update(row.id,item => ({...item,status:item.object ? "attaching" : "uploading",attempts:item.attempts+1,errorCode:undefined})); current();
            let object = row.object;
            if (!object) {
              const existing = await waitFor(bucket.stat(row.key),cancellation.signal); current(); cancellation.signal.throwIfAborted();
              object = checked(existing ?? await waitFor(bucket.upload({key:row.key,value:row.blob,contentType:row.blob.type,expectedSha256:row.sha256,ifSha256:null,signal:cancellation.signal,assertCurrent:current}),cancellation.signal),row);
              current(); cancellation.signal.throwIfAborted();
              await update(row.id,item => ({...item,object,status:"attaching"}));
            }
            current();
            await waitFor(client.mutateOnce({kind:"mutation",path:row.path},{...row.input,attachment:object},{key:row.id,userId,signal:cancellation.signal}),cancellation.signal); current();
            await change(rows => rows.filter(item => item.id !== row.id));
          } catch (error) {
            current(); const failure = (error && typeof error === "object" ? error : {}) as {status?:number;code?:string}, retryable = failure.status === undefined || failure.status >= 500 || failure.status === 408 || failure.status === 429;
            await update(row.id,item => ({...item,status:retryable ? "pending" : "failed",errorCode:typeof failure.code === "string" && /^[A-Z0-9_]{1,100}$/u.test(failure.code) ? failure.code : "ATTACHMENT_SEND_FAILED",nextAttemptAt:retryable ? Date.now()+Math.min(60000,1000*2**Math.min(item.attempts,6)) : 0})); return;
          } finally { clearTimeout(timer); lifecycle.signal.removeEventListener("abort",abort); }
        }
      });
    },
    async retry(id) { current(); await locks.request(name,{signal:lifecycle.signal},()=>update(id,item => {if(item.attempts >= 1000) throw new Error("Attachment attempts exhausted.");return {...item,status:"pending",nextAttemptAt:0,errorCode:undefined};})); },
    async discard(id) { current(); await locks.request(name,{signal:lifecycle.signal},()=>change(rows => rows.filter(row => row.id !== id))); },
    subscribe(listener) { current(); listeners.add(listener); return () => listeners.delete(listener); },
    dispose,
  };
  try { await snapshot(); } catch (error) { dispose(); throw error; }
  return Object.freeze(queue);
}

/** Accessible metadata-only view. Dispose this view and queue when the authenticated account changes. */
export function mountOfflineAttachmentQueue(container: HTMLElement, queue: OfflineAttachmentQueue): () => void {
  const document = container.ownerDocument, section = document.createElement("section"), heading=document.createElement("h2"), status = document.createElement("p"), list = document.createElement("ol"), synchronize=document.createElement("button");
  section.setAttribute("aria-label","Pending attachments");section.style.minWidth="0";heading.textContent="Pending attachments";status.setAttribute("role","status");status.tabIndex=-1;synchronize.type="button";synchronize.textContent="Synchronize attachments";section.append(heading,status,synchronize,list);container.append(section);
  let closed = false, generation = 0, previous: string | undefined;
  synchronize.onclick=async()=>{synchronize.disabled=true;try{await queue.flush();}catch{if(!closed){list.replaceChildren();previous=undefined;status.textContent="Attachments unavailable. Check the current account before synchronizing.";status.focus();}}finally{if(!closed)synchronize.disabled=false;}};
  const render = (items: readonly OfflineAttachment[]) => { generation++;const serialized=JSON.stringify(items);if(serialized===previous)return;previous=serialized;
    const focused=document.activeElement as HTMLElement|null,tag=focused?.dataset.attachmentAction,identity=focused?.dataset.attachmentId;let restored:HTMLButtonElement|undefined;
    list.replaceChildren(); status.textContent = `${new Intl.NumberFormat().format(items.length)} pending attachment${items.length === 1 ? "" : "s"}`;
    for (const item of items) { const row=document.createElement("li"), copy=document.createElement("span");row.style.overflowWrap="anywhere";copy.textContent=`${item.path} · ${new Intl.NumberFormat().format(item.size)} bytes · ${item.status}${item.errorCode ? " · "+item.errorCode : ""}`;row.append(copy);
      for (const [label,action] of [["Retry",() => queue.retry(item.id)],["Discard local copy",() => queue.discard(item.id)]] as const) { const button=document.createElement("button");button.type="button";button.textContent=label;button.setAttribute("aria-label",`${label} for attachment ${item.key}`);button.style.touchAction="manipulation";button.dataset.attachmentAction=label;button.dataset.attachmentId=item.id;button.disabled=item.status==="uploading"||item.status==="attaching";if(identity===item.id&&tag===label)restored=button;
        button.onclick=async()=>{if(label==="Discard local copy"&&!document.defaultView?.confirm("Discard this device’s pending copy? An uploaded file or an unknown attachment acknowledgment may already exist on the server."))return;button.disabled=true;try{await action();}catch{if(!closed){status.textContent="Could not change pending attachment. Refresh its state.";status.focus();}}finally{if(!closed)button.disabled=false;}};row.append(button); }list.append(row);
    }
    if(identity&&tag){if(restored&&!restored.disabled)restored.focus();else status.focus();}
  };
  const refresh = async () => {const expected=++generation;try{const items=await queue.snapshot();if(!closed&&expected===generation)render(items);}catch{if(!closed){generation++;previous=undefined;list.replaceChildren();synchronize.disabled=true;status.textContent="Attachments unavailable for this account.";}}};
  const unsubscribe = queue.subscribe(render), timer=setInterval(()=>{void refresh();},1000); void refresh();
  return () => {closed=true;generation++;clearInterval(timer);unsubscribe();section.remove();};
}
