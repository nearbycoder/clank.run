import type {SQLiteInternal} from "./sqlite-internal.ts";
import type {CustomerStatusConfiguration,CustomerStatusCopy,CustomerStatusPage,CustomerStatusPublication,CustomerStatusSnapshot,CustomerStatusUpdate,CustomerStatusPreferences,CustomerStatusNotification,CustomerStatusDomain} from "./customer-status.ts";
import {CustomerStatusError,validateCustomerStatusConfiguration,validateCustomerStatusCopy,validateCustomerStatusSnapshot} from "./customer-status.ts";
import type {DomainChallenge,DomainRoutingReport} from "./data-plane.ts";
import type {ProjectSloAssessment} from "./project-slo.ts";

export interface PlatformStatusPagesOptions {
  maxPages?: number;
  maxReceipts?: number;
  maxPreviews?: number;
  maxUpdates?: number;
  maxSubscribers?: number;
  maxNotifications?: number;
}
/** Private, request-local native authority. Never reconstructed from a browser DTO. */
export interface StatusPageAuthority {
  readonly userId: string;
  authorize(write?: boolean): void;
  binding(): string;
  audit(action: string, metadata: Record<string,unknown>): void | (()=>void);
}
export interface StatusPageHooks {
  hash(value: string): string;
  /** Stable native ownership/organization/parent binding, without a browser claim. */
  scope(projectId: string): string | null;
  incidentVersion(projectId: string, incidentId: string, authority: StatusPageAuthority): number;
  domainReserved(hostname: string): boolean;
  slo(projectId: string, policyId: string, authority: StatusPageAuthority): ProjectSloAssessment;
}
function fail(status:number,code:string,message:string):never{throw new CustomerStatusError(status,code,message);}
const exact=(value:unknown,fields:readonly string[]):Record<string,unknown>=>{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==fields.length||fields.some(field=>!Object.hasOwn(value,field)))fail(422,"STATUS_INPUT_INVALID","Choose exact status-page fields.");
  return value as Record<string,unknown>;
};
const integer=(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):number=>{
  if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)fail(422,"STATUS_INPUT_INVALID","Choose a bounded status-page number.");return Number(value);
};
const id=(value:unknown):string=>{
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]{8,128}$/u.test(value))fail(422,"STATUS_INPUT_INVALID","Choose a valid status-page identifier.");return value as string;
};
const parse=<T>(value:unknown):T=>{
  if(typeof value!=="string"||new TextEncoder().encode(value).byteLength>128*1024)fail(409,"STATUS_STATE_INVALID","Retained status data exceeds its supported bound.");
  try{return JSON.parse(value as string) as T;}catch{return fail(409,"STATUS_STATE_INVALID","Retain the invalid status data for operator recovery.");}
};
const configuration=(value:unknown)=>{try{return validateCustomerStatusConfiguration(value);}catch{return fail(422,"STATUS_INPUT_INVALID","Choose bounded public labels and health sources.");}};
const copy=(value:unknown)=>{try{return validateCustomerStatusCopy(value);}catch{return fail(422,"STATUS_INPUT_INVALID","Choose dedicated bounded public update text.");}};
const ack=(result:{changes:unknown})=>{if(Number(result.changes)!==1)fail(409,"STATUS_ACKNOWLEDGEMENT","Native status acknowledgment failed; no change was accepted.");};
type Row=Record<string,unknown>;

/** One bounded native catalog. Public reads project stored approved data only. */
export function openPlatformStatusPages(sql:SQLiteInternal,options:PlatformStatusPagesOptions,hooks:StatusPageHooks){
  const maxPages=integer(options.maxPages??1000,1,10000),maxReceipts=integer(options.maxReceipts??20000,1,100000),maxPreviews=integer(options.maxPreviews??5000,1,20000),maxUpdates=integer(options.maxUpdates??10000,1,50000),maxSubscribers=integer(options.maxSubscribers??5000,1,20000),maxNotifications=integer(options.maxNotifications??50000,1,100000);
  let closed=false,observedClock=0,epoch=0;
  if(sql.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_platform_status_state'").get()&&sql.prepare('SELECT protocol FROM clank_platform_status_state WHERE singleton=1').get()?.protocol!==1)fail(409,"STATUS_PROTOCOL","Unsupported status protocol; retain its state.");
  sql.transaction(()=>{
    sql.exec(`CREATE TABLE IF NOT EXISTS clank_platform_status_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL,epoch INTEGER NOT NULL,clock INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS clank_platform_status_pages(id TEXT PRIMARY KEY,project_id TEXT NOT NULL UNIQUE REFERENCES clank_platform_projects(id) ON DELETE CASCADE,slug TEXT NOT NULL UNIQUE,version INTEGER NOT NULL,configuration TEXT NOT NULL CHECK(json_valid(configuration)),scope TEXT NOT NULL,snapshot TEXT CHECK(snapshot IS NULL OR json_valid(snapshot)),published_version INTEGER,health_epoch INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS clank_platform_status_previews(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES clank_platform_status_pages(id) ON DELETE CASCADE,actor_id TEXT NOT NULL,epoch INTEGER NOT NULL,expected_version INTEGER NOT NULL,request TEXT NOT NULL CHECK(json_valid(request)),sources TEXT NOT NULL CHECK(json_valid(sources)),result TEXT NOT NULL CHECK(json_valid(result)),digest TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS clank_platform_status_updates(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,page_id TEXT NOT NULL REFERENCES clank_platform_status_pages(id) ON DELETE CASCADE,scope TEXT NOT NULL,copy TEXT NOT NULL CHECK(json_valid(copy)),incident_id TEXT,incident_version INTEGER,published_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS clank_platform_status_subscribers(page_id TEXT NOT NULL REFERENCES clank_platform_status_pages(id) ON DELETE CASCADE,actor_id TEXT NOT NULL,scope TEXT NOT NULL,version INTEGER NOT NULL,subscribed INTEGER NOT NULL CHECK(subscribed IN(0,1)),components TEXT NOT NULL CHECK(json_valid(components)),updated_at INTEGER NOT NULL,PRIMARY KEY(page_id,actor_id)) STRICT;
      CREATE TABLE IF NOT EXISTS clank_platform_status_notifications(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,page_id TEXT NOT NULL REFERENCES clank_platform_status_pages(id) ON DELETE CASCADE,subscriber_id TEXT NOT NULL,update_id TEXT NOT NULL REFERENCES clank_platform_status_updates(id) ON DELETE CASCADE,record TEXT NOT NULL CHECK(json_valid(record)),created_at INTEGER NOT NULL,UNIQUE(update_id,subscriber_id)) STRICT;
      CREATE TABLE IF NOT EXISTS clank_platform_status_domains(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES clank_platform_status_pages(id) ON DELETE CASCADE,hostname TEXT NOT NULL UNIQUE,scope TEXT NOT NULL,challenge TEXT NOT NULL CHECK(json_valid(challenge)),routing TEXT NOT NULL CHECK(routing IN('pending','ready')),checked_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS clank_platform_status_receipts(page_id TEXT NOT NULL,actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,scope TEXT NOT NULL,request TEXT NOT NULL CHECK(json_valid(request)),result TEXT NOT NULL CHECK(json_valid(result)),PRIMARY KEY(page_id,actor_id,operation_id)) STRICT;`);
    const prior=sql.prepare('SELECT * FROM clank_platform_status_state WHERE singleton=1').get();
    if(prior){if(prior.protocol!==1||!Number.isSafeInteger(prior.epoch)||Number(prior.epoch)<1||Number(prior.epoch)>=Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(prior.clock)||Number(prior.clock)<0||Number(prior.clock)>4102444800000)fail(409,"STATUS_STATE_INVALID","Invalid retained status clock or epoch.");observedClock=Number(prior.clock);epoch=Number(prior.epoch)+1;}
    else epoch=1;
    observedClock=Math.max(observedClock,integer(Date.now(),0,4102444800000));
    ack(sql.prepare('INSERT INTO clank_platform_status_state VALUES(1,1,?,?) ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch,clock=excluded.clock').run(epoch,observedClock));
    const retained=sql.prepare('SELECT epoch,clock FROM clank_platform_status_state WHERE singleton=1').get();if(retained?.epoch!==epoch||retained.clock!==observedClock)fail(409,"STATUS_ACKNOWLEDGEMENT","Native status clock was not retained.");
  });
  const protocol=(requireCurrent=true)=>{if(closed)fail(503,"STATUS_CLOSED","Status publishing is closed.");const state=sql.prepare('SELECT * FROM clank_platform_status_state WHERE singleton=1').get();if(state?.protocol!==1)fail(409,"STATUS_PROTOCOL","Unsupported retained status protocol.");if(!Number.isSafeInteger(state.clock)||Number(state.clock)<0||Number(state.clock)>4102444800000||!Number.isSafeInteger(state.epoch)||Number(state.epoch)<1)fail(409,'STATUS_STATE_INVALID','Invalid retained native status clock or epoch.');if(requireCurrent&&state.epoch!==epoch)fail(409,"STATUS_CONTROLLER_REPLACED","Current status controller authority is required.");return state;};
  const clock=()=>{const state=protocol();observedClock=Math.max(observedClock,Number(state.clock),integer(Date.now(),0,4102444800000));return observedClock;};
  const persistClock=()=>{const at=clock();ack(sql.prepare('UPDATE clank_platform_status_state SET clock=? WHERE singleton=1 AND epoch=?').run(at,epoch));if(sql.prepare('SELECT clock FROM clank_platform_status_state WHERE singleton=1').get()?.clock!==at)fail(409,"STATUS_ACKNOWLEDGEMENT","Native status clock was not retained.");if(finalChecks)remember('SELECT * FROM clank_platform_status_state WHERE singleton=1',[]);return at;};
  const check=(authority?:StatusPageAuthority,write=false)=>{protocol();authority?.authorize(write);};
  let finalChecks:(()=>void)[]|undefined;
  let authorityChecks:(()=>void)[]|undefined;
  const transaction=<T>(handler:()=>T):T=>{
    const parent=finalChecks,parentAuthority=authorityChecks,checks:(()=>void)[]=[],sources:(()=>void)[]=[];finalChecks=checks;authorityChecks=sources;
    try{return sql.transaction(()=>{const result=handler();for(const verify of sources)verify();for(const verify of checks)verify();return result;});}
    finally{finalChecks=parent;authorityChecks=parentAuthority;}
  };
  const remember=(query:string,parameters:readonly (string|number)[])=>{
    if(!finalChecks)fail(500,"STATUS_TRANSACTION_REQUIRED","Native status verification requires its write transaction.");
    const statement=sql.prepare(query),expected=JSON.stringify(statement.get(...parameters));
    finalChecks.push(()=>{if(JSON.stringify(statement.get(...parameters))!==expected)fail(409,"STATUS_ACKNOWLEDGEMENT","An accepted native status record changed before commit.");});
  };
  const scope=(projectId:string)=>{const value=hooks.scope(projectId);if(typeof value!=="string"||value.length>2000)fail(404,"STATUS_PROJECT_NOT_FOUND","Current status project not found.");return value as string;};
  const load=(projectId:string):Row=>{const row=sql.prepare('SELECT * FROM clank_platform_status_pages WHERE project_id=?').get(id(projectId));if(!row)fail(404,"STATUS_PAGE_NOT_FOUND","Create this project's status page first.");return row!;};
  const admin=(row:Row):CustomerStatusPage=>({projectId:String(row.project_id),version:integer(row.version,1),configuration:configuration(parse(row.configuration)),published:row.snapshot!==null&&row.scope===hooks.scope(String(row.project_id)),publishedVersion:row.published_version===null?null:integer(row.published_version,1),updatedAt:integer(row.updated_at)});
  const requireVersion=(row:Row,value:unknown)=>{const expected=integer(value,1,Number.MAX_SAFE_INTEGER-1);if(row.version!==expected)fail(409,"STATUS_VERSION_CONFLICT","Status page changed; keep your draft and refresh its version.");return expected;};
  const receipt=(pageId:string,authority:StatusPageAuthority,operationId:string,request:string,currentScope:string):unknown=>{
    const saved=sql.prepare('SELECT * FROM clank_platform_status_receipts WHERE page_id=? AND actor_id=? AND operation_id=?').get(pageId,authority.userId,operationId);
    if(!saved)return null;if(saved.scope!==currentScope)fail(409,"STATUS_SCOPE_CHANGED","The original status ownership binding changed.");if(saved.request!==request)fail(409,"STATUS_OPERATION_CONFLICT","This operation ID represents different status input.");return parse(saved.result);
  };
  const capacity=(table:string,maximum:number)=>{if(Number(sql.prepare('SELECT count(*) AS n FROM '+table).get()?.n)>=maximum)fail(409,"STATUS_CAPACITY","Status capacity is full; retain history and contact the operator.");};
  const save=<T>(pageId:string,authority:StatusPageAuthority,operationId:string,request:string,currentScope:string,result:T,action:string):T=>{
    check(authority,true);capacity('clank_platform_status_receipts',maxReceipts);const encoded=JSON.stringify(result);
    ack(sql.prepare('INSERT INTO clank_platform_status_receipts VALUES(?,?,?,?,?,?)').run(pageId,authority.userId,operationId,currentScope,request,encoded));
    const saved=sql.prepare('SELECT scope,request,result FROM clank_platform_status_receipts WHERE page_id=? AND actor_id=? AND operation_id=?').get(pageId,authority.userId,operationId);
    if(!saved||saved.scope!==currentScope||saved.request!==request||saved.result!==encoded)fail(409,"STATUS_ACKNOWLEDGEMENT","The exact status receipt was not retained.");
    remember('SELECT * FROM clank_platform_status_receipts WHERE page_id=? AND actor_id=? AND operation_id=?',[pageId,authority.userId,operationId]);
    const page=sql.prepare('SELECT project_id FROM clank_platform_status_pages WHERE project_id=? OR id=?').get(pageId,pageId);
    const verifyAudit=authority.audit(action,{operationId});if(verifyAudit)finalChecks!.push(verifyAudit);check(authority,true);
    if(!page||hooks.scope(String(page.project_id))!==currentScope)fail(409,"STATUS_SCOPE_CHANGED","Status ownership changed before acknowledgment.");
    persistClock();return structuredClone(result);
  };
  const updates=(row:Row):CustomerStatusUpdate[]=>sql.prepare('SELECT * FROM clank_platform_status_updates WHERE page_id=? AND scope=? ORDER BY sequence DESC LIMIT 20').all(row.id,row.scope).map(r=>({...copy(parse(r.copy)),id:id(r.id),publishedAt:integer(r.published_at)}));
  const projectPublic=(row:Row):CustomerStatusSnapshot=>{
    if(row.snapshot===null||row.scope!==hooks.scope(String(row.project_id)))fail(404,"STATUS_PAGE_NOT_FOUND","This status page is not published.");
    const snapshot=validateCustomerStatusSnapshot(parse(row.snapshot)),at=clock();
    return {...snapshot,components:snapshot.components.map(c=>row.health_epoch===epoch&&c.observedAt<=at&&c.expiresAt>at?c:{...c,health:'unknown',complete:false}),updates:updates(row)};
  };
  const selected=(row:Row,authority:StatusPageAuthority,includeUpdates=true)=>{
    check(authority,true);if(row.scope!==scope(String(row.project_id)))fail(409,"STATUS_SCOPE_CHANGED","Reconfigure and review this page after its native ownership binding changes.");
    const config=configuration(parse(row.configuration)),sources:unknown[]=[];const at=clock();
    const components=config.components.map(component=>{
      if(component.source.kind==='manual'){
        const source=component.source;if(source.observedAt>at)fail(409,"STATUS_HEALTH_FUTURE","Choose an observed health time that has occurred.");sources.push({key:component.key,source});
        return {key:component.key,label:component.label,health:source.expiresAt>at?source.health:'unknown' as const,observedAt:source.observedAt,expiresAt:source.expiresAt,complete:source.expiresAt>at&&source.health!=='unknown'};
      }
      const assessment=hooks.slo(String(row.project_id),component.source.policyId,authority);check(authority,true);
      if(assessment.policy.version!==component.source.expectedVersion)fail(409,"STATUS_SOURCE_CHANGED","The selected SLO policy changed; review its new version.");
      const e=assessment.evaluation,valid=assessment.policy.enabled&&e.coverage.complete&&e.status!=='insufficient-data'&&e.until<=at&&e.until+120000>at;
      sources.push({key:component.key,policyId:assessment.policy.id,version:assessment.policy.version,evaluation:e,enabled:assessment.policy.enabled});
      return {key:component.key,label:component.label,health:!valid?'unknown' as const:e.status==='within-budget'?'operational' as const:'degraded' as const,observedAt:e.until,expiresAt:e.until+120000,complete:valid};
    });
    const page:CustomerStatusSnapshot={protocol:'clank-customer-status/1',slug:config.slug,title:config.title,description:config.description,components,updates:includeUpdates?updates(row):[],publishedAt:0};return {page,sources};
  };
  const publication=(value:unknown):CustomerStatusPublication=>{
    const kind=(value as any)?.kind,input=exact(value,kind==='page'?['kind']:['kind','copy','incident']);if(kind==='page')return {kind};
    if(kind!=='update')return fail(422,"STATUS_INPUT_INVALID","Choose page publication or dedicated public update copy.");
    const incident=input.incident===null?null:exact(input.incident,['id','expectedVersion']);return {kind,copy:copy(input.copy),incident:incident?{id:id(incident.id),expectedVersion:integer(incident.expectedVersion,1,Number.MAX_SAFE_INTEGER-1)}:null};
  };
  const sourcePreview=(row:Row,authority:StatusPageAuthority,p:CustomerStatusPublication)=>{
    const selectedPage=selected(row,authority);let incidentVersion:number|null=null;
    if(p.kind==='update'){
      if(row.snapshot===null)fail(409,"STATUS_NOT_PUBLISHED","Publish the reviewed page before adding an incident update.");
      const available=new Set(selectedPage.page.components.map(c=>c.key));if(p.copy.components.some(k=>!available.has(k)))fail(422,"STATUS_COMPONENT_NOT_FOUND","Choose components configured on this status page.");
      if(p.incident){incidentVersion=hooks.incidentVersion(String(row.project_id),p.incident.id,authority);if(incidentVersion!==p.incident.expectedVersion)fail(409,"STATUS_SOURCE_CHANGED","Private incident changed; review its current context again.");}
    }
    check(authority,true);return {...selectedPage,sources:{health:selectedPage.sources,incidentVersion,authority:authority.binding()},update:p.kind==='update'?p.copy:null};
  };
  const updatePage=(row:Row,fields:{configuration?:CustomerStatusConfiguration;snapshot?:CustomerStatusSnapshot|null;publishedVersion?:number|null;scope?:string;healthEpoch?:number})=>{
    const next={configuration:fields.configuration??configuration(parse(row.configuration)),snapshot:fields.snapshot===undefined?row.snapshot:fields.snapshot===null?null:JSON.stringify(fields.snapshot),publishedVersion:fields.publishedVersion===undefined?row.published_version:fields.publishedVersion,scope:fields.scope??String(row.scope),healthEpoch:fields.healthEpoch??Number(row.health_epoch),version:integer(row.version,1,Number.MAX_SAFE_INTEGER-1)+1,updatedAt:clock()};
    ack(sql.prepare('UPDATE clank_platform_status_pages SET version=?,configuration=?,scope=?,snapshot=?,published_version=?,health_epoch=?,updated_at=? WHERE id=? AND version=?').run(next.version,JSON.stringify(next.configuration),next.scope,next.snapshot,next.publishedVersion,next.healthEpoch,next.updatedAt,row.id,row.version));
    const saved=load(String(row.project_id));if(saved.version!==next.version||saved.configuration!==JSON.stringify(next.configuration)||saved.scope!==next.scope||saved.snapshot!==next.snapshot||saved.published_version!==next.publishedVersion||saved.health_epoch!==next.healthEpoch||saved.updated_at!==next.updatedAt)fail(409,"STATUS_ACKNOWLEDGEMENT","Native status page acknowledgment was altered.");remember("SELECT * FROM clank_platform_status_pages WHERE id=?",[String(row.id)]);return saved;
  };
  const subscriber=(row:Row,authority:StatusPageAuthority):CustomerStatusPreferences=>{
    const saved=sql.prepare('SELECT * FROM clank_platform_status_subscribers WHERE page_id=? AND actor_id=?').get(row.id,authority.userId);
    if(!saved)return {version:0,subscribed:false,components:[],updatedAt:0};
    const componentList=parse<string[]>(saved.components);if(!Array.isArray(componentList)||componentList.length>20||componentList.some(k=>typeof k!=='string'))fail(409,"STATUS_STATE_INVALID","Invalid retained subscriber preferences.");
    return {version:integer(saved.version,1),subscribed:saved.subscribed===1&&saved.scope===row.scope,components:componentList,updatedAt:integer(saved.updated_at)};
  };
  const bySlug=(name:string):Row=>{if(!/^[a-z][a-z0-9-]{2,63}$/u.test(name))fail(404,"STATUS_PAGE_NOT_FOUND","Status page not found.");const row=sql.prepare('SELECT * FROM clank_platform_status_pages WHERE slug=?').get(name);if(!row)fail(404,"STATUS_PAGE_NOT_FOUND","Status page not found.");return row!;};
  const domainDto=(row:Row):CustomerStatusDomain=>{
    const challenge=parse<DomainChallenge>(row.challenge);
    return {id:id(row.id),hostname:String(row.hostname),recordName:challenge.recordName,recordValue:challenge.recordValue,expiresAt:integer(challenge.expiresAt),ownership:challenge.status,routing:row.routing==='ready'?'ready':'pending'};
  };
  const domainRow=(projectId:string,domainId:string):Row=>{const page=load(projectId),row=sql.prepare('SELECT * FROM clank_platform_status_domains WHERE page_id=? AND id=?').get(page.id,id(domainId));if(!row)fail(404,'STATUS_DOMAIN_NOT_FOUND','Status domain not found.');if(row.scope!==scope(projectId))fail(409,'STATUS_SCOPE_CHANGED','Review this domain again after its native ownership binding changes.');return row;};
  const writeDomain=(row:Row,challenge:DomainChallenge,routing:'pending'|'ready',checkedAt:number)=>{
    if(hooks.domainReserved(challenge.hostname))fail(409,'STATUS_DOMAIN_UNAVAILABLE','This hostname is reserved or assigned to an application.');
    const binding=scope(String(row.project_id)),encoded=JSON.stringify(challenge);
    ack(sql.prepare('INSERT INTO clank_platform_status_domains VALUES(?,?,?,?,?,?,?) ON CONFLICT(hostname) DO UPDATE SET id=excluded.id,scope=excluded.scope,challenge=excluded.challenge,routing=excluded.routing,checked_at=excluded.checked_at WHERE page_id=excluded.page_id').run(challenge.id,row.id,challenge.hostname,binding,encoded,routing,checkedAt));
    const saved=sql.prepare('SELECT * FROM clank_platform_status_domains WHERE id=?').get(challenge.id);
    if(!saved||saved.page_id!==row.id||saved.hostname!==challenge.hostname||saved.scope!==binding||saved.challenge!==encoded||saved.routing!==routing||saved.checked_at!==checkedAt)fail(409,'STATUS_ACKNOWLEDGEMENT','Native domain acknowledgment was altered.');
    remember('SELECT * FROM clank_platform_status_domains WHERE id=?',[challenge.id]);
    authorityChecks!.push(()=>{if(hooks.domainReserved(challenge.hostname)||scope(String(row.project_id))!==binding)fail(409,'STATUS_DOMAIN_UNAVAILABLE','Domain authority changed before commit.');});return saved;
  };
  return {
    close(){closed=true;},
    reservedHostname(hostname:string){protocol(false);return Boolean(sql.prepare('SELECT 1 FROM clank_platform_status_domains WHERE hostname=?').get(hostname));},
    publicHostname(hostname:string){check();if(hooks.domainReserved(hostname))return null;const row=sql.prepare('SELECT p.* FROM clank_platform_status_domains d JOIN clank_platform_status_pages p ON p.id=d.page_id WHERE d.hostname=? AND d.routing=\'ready\' AND json_extract(d.challenge,\'$.status\')=\'verified\' AND d.scope=p.scope').get(hostname);return row?projectPublic(row):null;},
    domains(projectId:string,authority:StatusPageAuthority){check(authority);const row=load(projectId);return sql.prepare('SELECT * FROM clank_platform_status_domains WHERE page_id=? ORDER BY hostname LIMIT 5').all(row.id).map(domainDto);},
    async beginDomain(projectId:string,authority:StatusPageAuthority,value:unknown,make:(existing:DomainChallenge|undefined)=>Promise<DomainChallenge>):Promise<CustomerStatusDomain>{
      check(authority,true);const input=exact(value,['hostname','expectedVersion','operationId']),expectedVersion=integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER-1),operationId=id(input.operationId);
      if(typeof input.hostname!=='string'||input.hostname.length>253||!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u.test(input.hostname))fail(422,'STATUS_INPUT_INVALID','Choose an exact lowercase DNS hostname.');
      const hostname=input.hostname as string,request=JSON.stringify({kind:'domain.begin',hostname,expectedVersion}),row=load(projectId),binding=scope(projectId),retained=receipt(projectId,authority,operationId,request,binding);if(retained)return retained as CustomerStatusDomain;requireVersion(row,expectedVersion);
      if(hooks.domainReserved(hostname))fail(409,'STATUS_DOMAIN_UNAVAILABLE','This hostname is reserved or assigned to an application.');
      const existing=sql.prepare('SELECT * FROM clank_platform_status_domains WHERE hostname=?').get(hostname);if(existing&&existing.page_id!==row.id)fail(409,'STATUS_DOMAIN_UNAVAILABLE','This hostname belongs to another status page.');
      if(!existing&&Number(sql.prepare('SELECT count(*) AS n FROM clank_platform_status_domains WHERE page_id=?').get(row.id)?.n)>=5)fail(409,'STATUS_CAPACITY','This page has five retained domains.');
      const challenge=await make(existing&&existing.scope===binding?parse<DomainChallenge>(existing.challenge):undefined);
      return transaction(()=>{check(authority,true);const current=load(projectId),scopeNow=scope(projectId),saved=receipt(projectId,authority,operationId,request,scopeNow);if(saved)return saved as CustomerStatusDomain;requireVersion(current,expectedVersion);
        if(scopeNow!==binding||challenge.projectId!==projectId||challenge.hostname!==hostname||challenge.recordName!=='_clank.'+hostname||challenge.recordType!=='TXT'||challenge.status!=='pending'&&challenge.status!=='verified'||!/^clank-domain=[A-Za-z0-9_-]{20,128}$/u.test(challenge.recordValue))fail(409,'STATUS_DOMAIN_INVALID','A current native domain challenge is required.');
        id(challenge.id);integer(challenge.expiresAt,challenge.status==='verified'?0:clock()+1,Math.min(4102444800000,clock()+7*86400000));
        const latest=sql.prepare('SELECT * FROM clank_platform_status_domains WHERE hostname=?').get(hostname);if(latest&&(latest.page_id!==row.id||existing?.id!==latest.id))fail(409,'STATUS_DOMAIN_UNAVAILABLE','Domain reservation changed.');
        const result=domainDto(writeDomain(current,challenge,'pending',0));updatePage(current,{});return save(projectId,authority,operationId,request,binding,result,'status.domain.begin');});
    },
    async verifyDomain(projectId:string,domainId:string,authority:StatusPageAuthority,value:unknown,verify:(challenge:DomainChallenge)=>Promise<{challenge:DomainChallenge;report:DomainRoutingReport}>):Promise<CustomerStatusDomain>{
      check(authority,true);const input=exact(value,['expectedVersion','operationId']),expectedVersion=integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER-1),operationId=id(input.operationId),request=JSON.stringify({kind:'domain.verify',domainId:id(domainId),expectedVersion}),row=load(projectId),binding=scope(projectId),retained=receipt(projectId,authority,operationId,request,binding);if(retained)return retained as CustomerStatusDomain;requireVersion(row,expectedVersion);
      const original=domainRow(projectId,domainId),challenge=parse<DomainChallenge>(original.challenge),resolved=await verify(structuredClone(challenge));
      return transaction(()=>{check(authority,true);const current=load(projectId),scopeNow=scope(projectId),saved=receipt(projectId,authority,operationId,request,scopeNow);if(saved)return saved as CustomerStatusDomain;requireVersion(current,expectedVersion);const latest=domainRow(projectId,domainId);
        if(scopeNow!==binding||JSON.stringify(latest)!==JSON.stringify(original)||resolved.challenge.id!==challenge.id||resolved.challenge.projectId!==projectId||resolved.challenge.hostname!==challenge.hostname||resolved.challenge.recordValue!==challenge.recordValue||resolved.challenge.recordName!==challenge.recordName||resolved.challenge.expiresAt!==challenge.expiresAt||resolved.challenge.status!=='verified'||resolved.report.hostname!==challenge.hostname)fail(409,'STATUS_DOMAIN_CHANGED','Domain proof changed during verification.');
        if(challenge.status!=='verified'&&challenge.expiresAt<=clock())fail(409,'STATUS_DOMAIN_EXPIRED','Begin a new current ownership challenge.');
        const checkedAt=integer(resolved.report.checkedAt,clock()-60000,clock()),result=domainDto(writeDomain(current,resolved.challenge,resolved.report.status==='ready'?'ready':'pending',checkedAt));updatePage(current,{});return save(projectId,authority,operationId,request,binding,result,'status.domain.verify');});
    },
    reservedSlug(name:string){check();return Boolean(sql.prepare('SELECT 1 FROM clank_platform_status_pages WHERE slug=?').get(name));},
    publicPage(name:string){check();return projectPublic(bySlug(name));},
    page(projectId:string,authority:StatusPageAuthority){check(authority);const row=sql.prepare('SELECT * FROM clank_platform_status_pages WHERE project_id=?').get(id(projectId));return row?admin(row):null;},
    create(projectId:string,authority:StatusPageAuthority,value:unknown):CustomerStatusPage{
      check(authority,true);const input=exact(value,['configuration','operationId']),config=configuration(input.configuration),operationId=id(input.operationId),project=id(projectId),binding=scope(project),request=JSON.stringify({kind:'create',configuration:config});
      return transaction(()=>{check(authority,true);const retained=receipt(project,authority,operationId,request,binding);if(retained)return retained as CustomerStatusPage;
        if(sql.prepare('SELECT 1 FROM clank_platform_status_pages WHERE project_id=? OR slug=?').get(project,config.slug))fail(409,"STATUS_PAGE_EXISTS","This project or public slug already has a retained status page.");capacity('clank_platform_status_pages',maxPages);const at=clock(),pageId=crypto.randomUUID(),encoded=JSON.stringify(config);
        ack(sql.prepare('INSERT INTO clank_platform_status_pages VALUES(?,?,?,1,?,?,NULL,NULL,0,?)').run(pageId,project,config.slug,encoded,binding,at));const row=load(project);
        if(row.id!==pageId||row.configuration!==encoded||row.scope!==binding||row.version!==1||row.snapshot!==null)fail(409,"STATUS_ACKNOWLEDGEMENT","Native status creation was altered.");remember("SELECT * FROM clank_platform_status_pages WHERE id=?",[pageId]);return save(project,authority,operationId,request,binding,admin(row),'status.page.create');});
    },
    configure(projectId:string,authority:StatusPageAuthority,value:unknown):CustomerStatusPage{
      check(authority,true);const input=exact(value,['configuration','expectedVersion','operationId']),config=configuration(input.configuration),operationId=id(input.operationId),request=JSON.stringify({kind:'configure',configuration:config,expectedVersion:integer(input.expectedVersion,1)});
      return transaction(()=>{check(authority,true);const row=load(projectId),binding=scope(projectId),retained=receipt(projectId,authority,operationId,request,binding);if(retained)return retained as CustomerStatusPage;requireVersion(row,input.expectedVersion);
        if(config.slug!==row.slug)fail(409,"STATUS_SLUG_IMMUTABLE","Retained subscriber URLs keep their original public slug.");const rebinding=row.scope!==binding;const next=updatePage(row,{configuration:config,scope:binding,...(rebinding?{snapshot:null,publishedVersion:null,healthEpoch:0}:{})});return save(projectId,authority,operationId,request,binding,admin(next),'status.page.configure');});
    },
    preview(projectId:string,authority:StatusPageAuthority,value:unknown){
      check(authority,true);const input=exact(value,['expectedVersion','publication']),p=publication(input.publication);
      return transaction(()=>{check(authority,true);const row=load(projectId);requireVersion(row,input.expectedVersion);const at=clock();sql.prepare('DELETE FROM clank_platform_status_previews WHERE expires_at<=? OR epoch<>?').run(at,epoch);capacity('clank_platform_status_previews',maxPreviews);
        const prepared=sourcePreview(row,authority,p),previewId=crypto.randomUUID(),expiresAt=at+300000,request=JSON.stringify(p),sources=JSON.stringify(prepared.sources),digest=hooks.hash(JSON.stringify([row.id,authority.userId,row.version,row.scope,request,sources,prepared.page,expiresAt])),result={id:previewId,digest,expectedVersion:Number(row.version),expiresAt,page:prepared.page,update:prepared.update},encoded=JSON.stringify(result);
        ack(sql.prepare('INSERT INTO clank_platform_status_previews VALUES(?,?,?,?,?,?,?,?,?,?)').run(previewId,row.id,authority.userId,epoch,row.version,request,sources,encoded,digest,expiresAt));const saved=sql.prepare('SELECT * FROM clank_platform_status_previews WHERE id=?').get(previewId);
        if(!saved||saved.result!==encoded||saved.sources!==sources||saved.actor_id!==authority.userId||saved.epoch!==epoch||saved.digest!==digest||saved.expected_version!==row.version||saved.expires_at!==expiresAt)fail(409,"STATUS_ACKNOWLEDGEMENT","Native public review preview was altered.");remember('SELECT * FROM clank_platform_status_previews WHERE id=?',[previewId]);check(authority,true);persistClock();authorityChecks!.push(()=>{if(JSON.stringify(sourcePreview(row,authority,p).sources)!==sources)fail(409,'STATUS_SOURCE_CHANGED','Preview authority changed before commit.');});return result;});
    },
    publish(projectId:string,authority:StatusPageAuthority,value:unknown):CustomerStatusPage{
      check(authority,true);const input=exact(value,['expectedVersion','previewId','previewDigest','operationId']),operationId=id(input.operationId),previewId=id(input.previewId),expectedVersion=integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER-1);
      if(typeof input.previewDigest!=='string'||!/^[a-f0-9]{64}$/u.test(input.previewDigest))fail(422,"STATUS_INPUT_INVALID","Choose the exact native public review digest.");const request=JSON.stringify({kind:'publish',expectedVersion,previewId,previewDigest:input.previewDigest});
      return transaction(()=>{check(authority,true);const row=load(projectId),binding=scope(projectId),retained=receipt(projectId,authority,operationId,request,binding);if(retained)return retained as CustomerStatusPage;requireVersion(row,expectedVersion);const at=clock(),preview=sql.prepare('SELECT * FROM clank_platform_status_previews WHERE id=? AND page_id=? AND actor_id=?').get(previewId,row.id,authority.userId);
        if(!preview||preview.epoch!==epoch||preview.expected_version!==expectedVersion||Number(preview.expires_at)<=at||preview.digest!==input.previewDigest)fail(409,"STATUS_PREVIEW_STALE","Inspect a new current public preview before publishing.");
        const p=publication(parse(preview.request)),prepared=sourcePreview(row,authority,p),original=parse<{page:CustomerStatusSnapshot}>(preview.result);
        if(JSON.stringify(prepared.sources)!==preview.sources||JSON.stringify(prepared.page)!==JSON.stringify(original.page))fail(409,"STATUS_SOURCE_CHANGED","Public health or private provenance changed after review.");
        if(p.kind==='update'){
          capacity('clank_platform_status_updates',maxUpdates);const update:CustomerStatusUpdate={...p.copy,id:crypto.randomUUID(),publishedAt:at},encoded=JSON.stringify(p.copy);
          ack(sql.prepare('INSERT INTO clank_platform_status_updates(id,page_id,scope,copy,incident_id,incident_version,published_at) VALUES(?,?,?,?,?,?,?)').run(update.id,row.id,binding,encoded,p.incident?.id??null,p.incident?.expectedVersion??null,at));const saved=sql.prepare('SELECT * FROM clank_platform_status_updates WHERE id=?').get(update.id);
          if(!saved||saved.page_id!==row.id||saved.scope!==binding||saved.copy!==encoded||saved.incident_id!==(p.incident?.id??null)||saved.incident_version!==(p.incident?.expectedVersion??null)||saved.published_at!==at)fail(409,"STATUS_ACKNOWLEDGEMENT","Native public update was altered.");remember("SELECT * FROM clank_platform_status_updates WHERE id=?",[update.id]);
          const subscribers=sql.prepare('SELECT actor_id,components FROM clank_platform_status_subscribers WHERE page_id=? AND scope=? AND subscribed=1 LIMIT 201').all(row.id,binding);if(subscribers.length>200)fail(409,"STATUS_CAPACITY","This page exceeds its bounded subscriber fanout.");
          for(const subscriber of subscribers){const selected=parse<string[]>(subscriber.components);if(selected.length&&p.copy.components.length&&!selected.some(k=>p.copy.components.includes(k)))continue;capacity('clank_platform_status_notifications',maxNotifications);const notification:CustomerStatusNotification={id:crypto.randomUUID(),update,createdAt:at},record=JSON.stringify(notification);
            ack(sql.prepare('INSERT INTO clank_platform_status_notifications(id,page_id,subscriber_id,update_id,record,created_at) VALUES(?,?,?,?,?,?)').run(notification.id,row.id,subscriber.actor_id,update.id,record,at));const saved=sql.prepare('SELECT * FROM clank_platform_status_notifications WHERE id=?').get(notification.id);if(!saved||saved.page_id!==row.id||saved.subscriber_id!==subscriber.actor_id||saved.update_id!==update.id||saved.record!==record||saved.created_at!==at)fail(409,"STATUS_ACKNOWLEDGEMENT","Native subscriber notification was altered.");remember("SELECT * FROM clank_platform_status_notifications WHERE id=?",[notification.id]);}
        }
        const next=updatePage(row,{snapshot:{...prepared.page,updates:updates(row),publishedAt:at},publishedVersion:expectedVersion,healthEpoch:epoch});check(authority,true);
        ack(sql.prepare('DELETE FROM clank_platform_status_previews WHERE id=? AND digest=?').run(previewId,input.previewDigest));if(sql.prepare('SELECT 1 FROM clank_platform_status_previews WHERE id=?').get(previewId))fail(409,"STATUS_ACKNOWLEDGEMENT","Public review was not consumed.");remember("SELECT * FROM clank_platform_status_previews WHERE id=?",[previewId]);authorityChecks!.push(()=>{if(JSON.stringify(selected(row,authority,false).sources)!==JSON.stringify(prepared.sources.health)||p.kind==="update"&&p.incident&&hooks.incidentVersion(projectId,p.incident.id,authority)!==p.incident.expectedVersion)fail(409,"STATUS_SOURCE_CHANGED","Publication authority changed before commit.");});return save(projectId,authority,operationId,request,binding,admin(next),'status.page.publish');});
    },
    unpublish(projectId:string,authority:StatusPageAuthority,value:unknown):CustomerStatusPage{
      check(authority,true);const input=exact(value,['expectedVersion','operationId']),operationId=id(input.operationId),request=JSON.stringify({kind:'unpublish',expectedVersion:integer(input.expectedVersion,1)});
      return transaction(()=>{check(authority,true);const row=load(projectId),binding=scope(projectId),retained=receipt(projectId,authority,operationId,request,binding);if(retained)return retained as CustomerStatusPage;requireVersion(row,input.expectedVersion);const next=updatePage(row,{snapshot:null,publishedVersion:null,healthEpoch:0});return save(projectId,authority,operationId,request,binding,admin(next),'status.page.unpublish');});
    },
    preferences(name:string,authority:StatusPageAuthority){check(authority);const row=bySlug(name);if(row.snapshot===null&&!sql.prepare('SELECT 1 FROM clank_platform_status_subscribers WHERE page_id=? AND actor_id=?').get(row.id,authority.userId))fail(404,"STATUS_PAGE_NOT_FOUND","Status page not found.");return subscriber(row,authority);},
    subscribe(name:string,authority:StatusPageAuthority,value:unknown):CustomerStatusPreferences{
      check(authority,true);const input=exact(value,['subscribed','components','expectedVersion','operationId']),operationId=id(input.operationId),expectedVersion=integer(input.expectedVersion,0,Number.MAX_SAFE_INTEGER-1);
      if(typeof input.subscribed!=='boolean'||!Array.isArray(input.components)||input.components.length>20||input.components.some(k=>typeof k!=='string'||!/^[a-z][a-z0-9-]{0,47}$/u.test(k))||new Set(input.components).size!==input.components.length)fail(422,"STATUS_INPUT_INVALID","Choose distinct public component preferences.");const components=[...input.components as string[]].sort(),request=JSON.stringify({kind:'subscribe',subscribed:input.subscribed,components,expectedVersion});
      return transaction(()=>{check(authority,true);const row=bySlug(name),binding=scope(String(row.project_id)),retained=receipt(String(row.id),authority,operationId,request,binding);if(retained)return retained as CustomerStatusPreferences;const prior=subscriber(row,authority);if(prior.version!==expectedVersion)fail(409,"STATUS_VERSION_CONFLICT","Subscriber preferences changed; refresh before saving.");
        if(input.subscribed){const publicPage=projectPublic(row),available=new Set(publicPage.components.map(c=>c.key));if(components.some(k=>!available.has(k)))fail(422,"STATUS_COMPONENT_NOT_FOUND","Choose public components on this page.");}
        const exists=sql.prepare('SELECT 1 FROM clank_platform_status_subscribers WHERE page_id=? AND actor_id=?').get(row.id,authority.userId);if(!exists){capacity('clank_platform_status_subscribers',maxSubscribers);if(Number(sql.prepare('SELECT count(*) AS n FROM clank_platform_status_subscribers WHERE page_id=?').get(row.id)?.n)>=200)fail(409,"STATUS_CAPACITY","This page's bounded subscriber capacity is full.");}
        const at=clock(),encoded=JSON.stringify(components);ack(sql.prepare('INSERT INTO clank_platform_status_subscribers VALUES(?,?,?,?,?,?,?) ON CONFLICT(page_id,actor_id) DO UPDATE SET scope=excluded.scope,version=excluded.version,subscribed=excluded.subscribed,components=excluded.components,updated_at=excluded.updated_at').run(row.id,authority.userId,binding,expectedVersion+1,input.subscribed?1:0,encoded,at));const saved=sql.prepare('SELECT * FROM clank_platform_status_subscribers WHERE page_id=? AND actor_id=?').get(row.id,authority.userId);
        if(!saved||saved.scope!==binding||saved.version!==expectedVersion+1||saved.subscribed!==(input.subscribed?1:0)||saved.components!==encoded||saved.updated_at!==at)fail(409,"STATUS_ACKNOWLEDGEMENT","Native subscriber preferences were altered.");remember("SELECT * FROM clank_platform_status_subscribers WHERE page_id=? AND actor_id=?",[String(row.id),authority.userId]);return save(String(row.id),authority,operationId,request,binding,subscriber(row,authority),'status.subscriber.preferences');});
    },
    notifications(name:string,authority:StatusPageAuthority,after:number){check(authority);const row=bySlug(name),cursor=integer(after);const rows=sql.prepare('SELECT sequence,record FROM clank_platform_status_notifications WHERE page_id=? AND subscriber_id=? AND sequence>? ORDER BY sequence LIMIT 21').all(row.id,authority.userId,cursor);const notifications=rows.slice(0,20).map(r=>parse<CustomerStatusNotification>(r.record));check(authority);return {notifications,next:rows.length>20?integer(rows[19]!.sequence):null};},
  };
}
