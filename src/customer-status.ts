import type {AuthClient} from "./auth.ts";

export type CustomerStatusHealth = "operational" | "degraded" | "major-outage" | "maintenance" | "unknown";
export type CustomerStatusUpdateState = "investigating" | "identified" | "monitoring" | "resolved";
export interface CustomerStatusComponentInput {
  readonly key: string;
  readonly label: string;
  readonly source: {readonly kind: "manual"; readonly health: CustomerStatusHealth; readonly observedAt: number; readonly expiresAt: number}
    | {readonly kind: "slo"; readonly policyId: string; readonly expectedVersion: number};
}
export interface CustomerStatusConfiguration {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly components: readonly CustomerStatusComponentInput[];
}
/** Public health contains no native project, policy, subscriber or incident identity. */
export interface CustomerStatusComponent {
  readonly key: string;
  readonly label: string;
  readonly health: CustomerStatusHealth;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly complete: boolean;
}
export interface CustomerStatusCopy {
  readonly title: string;
  readonly message: string;
  readonly state: CustomerStatusUpdateState;
  readonly components: readonly string[];
}
export interface CustomerStatusUpdate extends CustomerStatusCopy {
  readonly id: string;
  readonly publishedAt: number;
}
export interface CustomerStatusSnapshot {
  readonly protocol: "clank-customer-status/1";
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly components: readonly CustomerStatusComponent[];
  readonly updates: readonly CustomerStatusUpdate[];
  readonly publishedAt: number;
}
/** Administration metadata is authenticated and never projected by the public page. */
export interface CustomerStatusPage {
  readonly projectId: string;
  readonly version: number;
  readonly configuration: CustomerStatusConfiguration;
  readonly published: boolean;
  readonly publishedVersion: number | null;
  readonly updatedAt: number;
}
export type CustomerStatusPublication = {readonly kind: "page"}
  | {readonly kind: "update"; readonly copy: CustomerStatusCopy; readonly incident: {readonly id: string; readonly expectedVersion: number} | null};
export interface CustomerStatusPreview {
  readonly id: string;
  readonly digest: string;
  readonly expectedVersion: number;
  readonly expiresAt: number;
  readonly page: CustomerStatusSnapshot;
  readonly update: CustomerStatusCopy | null;
}
export interface CustomerStatusPublishRequest {
  readonly expectedVersion: number;
  readonly previewId: string;
  readonly previewDigest: string;
  readonly operationId: string;
}
export interface CustomerStatusPreferences {
  readonly version: number;
  readonly subscribed: boolean;
  /** Empty means all public components. Only the native inbox channel is supported. */
  readonly components: readonly string[];
  readonly updatedAt: number;
}
export interface CustomerStatusNotification {
  readonly id: string;
  readonly update: CustomerStatusUpdate;
  readonly createdAt: number;
}
export interface CustomerStatusDomain {
  readonly id: string;
  readonly hostname: string;
  readonly recordName: string;
  readonly recordValue: string;
  readonly expiresAt: number;
  readonly ownership: "pending" | "verified";
  readonly routing: "pending" | "ready";
}
export interface CustomerStatusClient {
  publicPage(slug: string): Promise<CustomerStatusSnapshot>;
  page(projectId: string): Promise<CustomerStatusPage | null>;
  create(projectId: string, input: {readonly configuration: CustomerStatusConfiguration; readonly operationId: string}): Promise<CustomerStatusPage>;
  configure(projectId: string, input: {readonly configuration: CustomerStatusConfiguration; readonly expectedVersion: number; readonly operationId: string}): Promise<CustomerStatusPage>;
  preview(projectId: string, input: {readonly expectedVersion: number; readonly publication: CustomerStatusPublication}): Promise<CustomerStatusPreview>;
  publish(projectId: string, input: CustomerStatusPublishRequest): Promise<CustomerStatusPage>;
  unpublish(projectId: string, input: {readonly expectedVersion: number; readonly operationId: string}): Promise<CustomerStatusPage>;
  domains(projectId: string): Promise<readonly CustomerStatusDomain[]>;
  beginDomain(projectId: string, input: {readonly hostname: string; readonly expectedVersion: number; readonly operationId: string}): Promise<CustomerStatusDomain>;
  verifyDomain(projectId: string, domainId: string, input: {readonly expectedVersion: number; readonly operationId: string}): Promise<CustomerStatusDomain>;
  preferences(slug: string): Promise<CustomerStatusPreferences>;
  subscribe(slug: string, input: {readonly subscribed: boolean; readonly components: readonly string[]; readonly expectedVersion: number; readonly operationId: string}): Promise<CustomerStatusPreferences>;
  notifications(slug: string, after?: number): Promise<{readonly notifications: readonly CustomerStatusNotification[]; readonly next: number | null}>;
}
export interface CustomerStatusClientOptions {
  url?: string;
  fetch?: typeof fetch;
  auth?: Pick<AuthClient<any>, "csrfHeader">;
  headers?: () => HeadersInit;
  timeoutMs?: number;
}
export class CustomerStatusError extends Error {
  readonly name = "CustomerStatusError";
  declare readonly status: number;
  declare readonly code: string;
  constructor(status: number, code: string, message: string) {super(message); this.status=status; this.code=code;}
}
const health = new Set<CustomerStatusHealth>(["operational", "degraded", "major-outage", "maintenance", "unknown"]);
const updateStates = new Set<CustomerStatusUpdateState>(["investigating", "identified", "monitoring", "resolved"]);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const plain = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value!=="object" || Array.isArray(value) || Object.getPrototypeOf(value)!==Object.prototype
    || Object.keys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(value,key))) throw new TypeError("Choose exact status-page fields.");
  return value as Record<string,unknown>;
};
const number = (value: unknown, min=0, max=4_102_444_800_000): number => {
  if (!Number.isSafeInteger(value) || Number(value)<min || Number(value)>max) throw new TypeError("Choose a bounded status-page number.");
  return Number(value);
};
const text = (value: unknown, max: number, empty=false): string => {
  if (typeof value!=="string" || !empty&&!value.trim() || bytes(value)>max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new TypeError("Choose bounded public text.");
  return value;
};
const token = (value: unknown): string => {
  if (typeof value!=="string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value)) throw new TypeError("Choose a valid status-page identifier.");
  return value;
};
const slug = (value: unknown): string => {
  if (typeof value!=="string" || !/^[a-z][a-z0-9-]{2,63}$/u.test(value)) throw new TypeError("Choose a lowercase public page slug.");
  return value;
};
const key = (value: unknown): string => {
  if (typeof value!=="string" || !/^[a-z][a-z0-9-]{0,47}$/u.test(value)) throw new TypeError("Choose a public component key.");
  return value;
};
const keys = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length>20) throw new TypeError("Choose at most 20 public components.");
  const result=value.map(key); if(new Set(result).size!==result.length) throw new TypeError("Choose distinct public components.");return result.sort();
};
/** Validate and detach dedicated public copy; never accept a private incident object. */
export function validateCustomerStatusCopy(value: unknown): CustomerStatusCopy {
  const input=plain(value,["title","message","state","components"]);
  if(!updateStates.has(input.state as CustomerStatusUpdateState))throw new TypeError("Choose a public incident update state.");
  return {title:text(input.title,160),message:text(input.message,4000),state:input.state as CustomerStatusUpdateState,components:keys(input.components)};
}
export function validateCustomerStatusConfiguration(value: unknown): CustomerStatusConfiguration {
  const input=plain(value,["slug","title","description","components"]);
  if(!Array.isArray(input.components)||input.components.length<1||input.components.length>20)throw new TypeError("Choose 1–20 public components.");
  const components=input.components.map(value=>{
    const component=plain(value,["key","label","source"]),kind=(component.source as any)?.kind;
    const source=plain(component.source,kind==="manual"?["kind","health","observedAt","expiresAt"]:["kind","policyId","expectedVersion"]);
    let selected:CustomerStatusComponentInput["source"];
    if(kind==="manual"){
      if(!health.has(source.health as CustomerStatusHealth))throw new TypeError("Choose a public health state.");
      const observedAt=number(source.observedAt),expiresAt=number(source.expiresAt,observedAt+1000,Math.min(4102444800000,observedAt+3600000));
      selected={kind,health:source.health as CustomerStatusHealth,observedAt,expiresAt};
    }else if(kind==="slo")selected={kind,policyId:token(source.policyId),expectedVersion:number(source.expectedVersion,1,Number.MAX_SAFE_INTEGER)};
    else throw new TypeError("Choose a manual or native SLO health source.");
    return {key:key(component.key),label:text(component.label,120),source:selected};
  });
  if(new Set(components.map(x=>x.key)).size!==components.length)throw new TypeError("Choose distinct public component keys.");
  return {slug:slug(input.slug),title:text(input.title,160),description:text(input.description,1000,true),components};
}
/** Strict public projection also rejects unexpected private fields in an HTTP response. */
export function validateCustomerStatusSnapshot(value: unknown): CustomerStatusSnapshot {
  const input=plain(value,["protocol","slug","title","description","components","updates","publishedAt"]);
  if(input.protocol!=="clank-customer-status/1"||!Array.isArray(input.components)||input.components.length>20||!Array.isArray(input.updates)||input.updates.length>20)throw new TypeError("Unsupported public status snapshot.");
  const components=input.components.map(value=>{
    const c=plain(value,["key","label","health","observedAt","expiresAt","complete"]);
    if(!health.has(c.health as CustomerStatusHealth)||typeof c.complete!=="boolean")throw new TypeError("Invalid public health coverage.");
    return {key:key(c.key),label:text(c.label,120),health:c.health as CustomerStatusHealth,observedAt:number(c.observedAt),expiresAt:number(c.expiresAt),complete:c.complete};
  });
  if(new Set(components.map(x=>x.key)).size!==components.length)throw new TypeError("Duplicate public component.");
  const updates=input.updates.map(value=>{
    const u=plain(value,["id","title","message","state","components","publishedAt"]);
    const copy=validateCustomerStatusCopy({title:u.title,message:u.message,state:u.state,components:u.components});
    return {...copy,id:token(u.id),publishedAt:number(u.publishedAt)};
  });
  return {protocol:"clank-customer-status/1",slug:slug(input.slug),title:text(input.title,160),description:text(input.description,1000,true),components,updates,publishedAt:number(input.publishedAt)};
}
/** Native session/CSRF is supplied by the application's auth client, never by a status DTO. */
export function createCustomerStatusClient(options:CustomerStatusClientOptions={}):CustomerStatusClient {
  const fetcher=options.fetch??globalThis.fetch;if(!fetcher)throw new Error("fetch is unavailable.");
  const base=options.url?new URL(options.url):null;
  if(base&&(base.pathname!=="/"||base.search||base.hash||base.username||base.password||base.protocol!=="https:"&&!(base.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(base.hostname))))throw new TypeError("Choose a trusted canonical status origin.");
  const timeout=number(options.timeoutMs??15000,100,30000);
  const project=(id:string)=>"/api/projects/"+encodeURIComponent(token(id))+"/status-page";
  const page=(name:string)=>"/api/status/"+encodeURIComponent(slug(name));
  const request=async(path:string,body?:unknown,publicRead=false):Promise<any>=>{
    const controller=new AbortController(),headers=new Headers(publicRead?{}:options.headers?.());
    headers.set("accept","application/json");
    let encoded:string|undefined;
    if(body!==undefined){encoded=JSON.stringify(body);if(bytes(encoded)>32768)throw new TypeError("Status request is too large.");headers.set("content-type","application/json");for(const [name,value]of Object.entries(options.auth?.csrfHeader()??{}))headers.set(name,value);}
    let timer:ReturnType<typeof setTimeout>;
    const expiry=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new CustomerStatusError(0,"STATUS_TIMEOUT","The response is unknown. Retry the exact same operation ID and input."));},timeout);});
    const work=(async()=>{
      const response=await fetcher(base?new URL(path,base).href:path,{method:body===undefined?"GET":"POST",headers,body:encoded,credentials:publicRead?"omit":"include",signal:controller.signal,cache:"no-store",redirect:"error"});
      const reader=response.body?.getReader();let collected="",total=0;const decoder=new TextDecoder("utf-8",{fatal:true});
      if(reader)try{while(true){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.byteLength;if(total>128*1024){await reader.cancel();throw new CustomerStatusError(response.status,"STATUS_RESPONSE_BOUND","The status response exceeds its bound.");}collected+=decoder.decode(chunk.value,{stream:true});}collected+=decoder.decode();}finally{reader.releaseLock();}
      let input:any;try{input=JSON.parse(collected);}catch{throw new CustomerStatusError(response.status,"STATUS_RESPONSE_INVALID","The status response is invalid. Preserve any pending operation for exact retry.");}
      if(!response.ok)throw new CustomerStatusError(response.status,typeof input?.error?.code==="string"?input.error.code:"STATUS_REQUEST_FAILED",typeof input?.error?.message==="string"?input.error.message:"The status request was rejected.");
      if(publicRead)return validateCustomerStatusSnapshot(input);
      if(input?.ok!==true)throw new CustomerStatusError(response.status,"STATUS_RESPONSE_INVALID","The status response is invalid.");return input;
    })();
    try{return await Promise.race([work,expiry]);}finally{clearTimeout(timer!);}
  };
  return {
    publicPage:name=>request(page(name),undefined,true),
    page:async id=>(await request(project(id))).page,
    create:async(id,input)=>(await request(project(id)+"/create",{configuration:validateCustomerStatusConfiguration(input.configuration),operationId:token(input.operationId)})).page,
    configure:async(id,input)=>(await request(project(id)+"/configure",{configuration:validateCustomerStatusConfiguration(input.configuration),expectedVersion:number(input.expectedVersion,1,Number.MAX_SAFE_INTEGER),operationId:token(input.operationId)})).page,
    preview:async(id,input)=>(await request(project(id)+"/preview",input)).preview,
    publish:async(id,input)=>(await request(project(id)+"/publish",input)).page,
    unpublish:async(id,input)=>(await request(project(id)+"/unpublish",input)).page,
    domains:async id=>(await request(project(id)+"/domains")).domains,
    beginDomain:async(id,input)=>(await request(project(id)+"/domains/begin",input)).domain,
    verifyDomain:async(id,domainId,input)=>(await request(project(id)+"/domains/"+encodeURIComponent(token(domainId))+"/verify",input)).domain,
    preferences:async name=>(await request(page(name)+"/preferences")).preferences,
    subscribe:async(name,input)=>(await request(page(name)+"/subscribe",input)).preferences,
    notifications:async(name,after=0)=>(await request(page(name)+"/notifications?after="+number(after,0,Number.MAX_SAFE_INTEGER))).page,
  };
}
