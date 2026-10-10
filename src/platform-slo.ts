import type { SQLiteInternal } from "./sqlite-internal.ts";
import type { IngressRequestMetric } from "./data-plane.ts";
import {evaluateProjectSlo, validateProjectSloConfiguration, type ProjectSloBucket, type ProjectSloConfiguration, type ProjectSloEvaluation, type ProjectSloPolicy, type ProjectSloAlert} from "./project-slo.ts";

export interface PlatformSloOptions { maxPolicies?: number; maxReceipts?: number; maxBuckets?: number; heartbeatMs?: number; }
export interface SloAuthority { readonly userId: string; authorize(write?: boolean): void; audit(action: string, metadata: Record<string, unknown>): void; }
export type StoredSloPolicy = ProjectSloPolicy;
export type StoredSloAlert = ProjectSloAlert;
export class ProjectSloError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) {super(message); this.status=status; this.code=code;}
}
const fail=(status: number, code: string, message: string): never=>{throw new ProjectSloError(status,code,message);};
const integer=(value: unknown, low: number, high: number): number=>{
  if(!Number.isSafeInteger(value)||Number(value)<low||Number(value)>high)fail(422,"SLO_INPUT_INVALID","Choose a supported SLO number.");
  return Number(value);
};
const id=(value: unknown): string=>{
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]{8,128}$/u.test(value))fail(422,"SLO_INPUT_INVALID","Choose a valid SLO identifier.");return value as string;
};
const exact=(value: unknown, keys: readonly string[]): Record<string,unknown>=>{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail(422,"SLO_INPUT_INVALID","Choose exact SLO fields.");return value as Record<string,unknown>;
};
const minute=60000, retention=8*24*60*minute, boundaries=[50,100,250,500,1000,2500,5000];
const configurationInput=(value:unknown):ProjectSloConfiguration=>{
  try{return validateProjectSloConfiguration(value);}catch{return fail(422,"SLO_INPUT_INVALID","Choose a supported SLO policy.");}
};

/** Private bounded state. Coverage is sealed only after an uninterrupted sole collector observes a complete minute. */
export function openProjectSlos(sql: SQLiteInternal, options: PlatformSloOptions, hooks: {
  collecting: boolean;
  clock?: {wall(): number; monotonic(): number};
  manual?: boolean;
  onError?(error: unknown): void;
}) {
  const maxPolicies=integer(options.maxPolicies??1000,1,10000),maxReceipts=integer(options.maxReceipts??10000,1,100000),maxBuckets=integer(options.maxBuckets??200000,1,500000);
  const heartbeat=integer(options.heartbeatMs??1000,100,5000),lease=heartbeat*3;
  const clock=hooks.clock??{wall:()=>Date.now(),monotonic:()=>performance.now()};
  const protocol=()=>{if(sql.prepare('SELECT protocol FROM clank_platform_slo_state WHERE singleton=1').get()?.protocol!==1)fail(409,"SLO_PROTOCOL_UNSUPPORTED","Unsupported SLO storage protocol.");};
  if(sql.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='clank_platform_slo_state'").get())protocol();
  sql.exec(`CREATE TABLE IF NOT EXISTS clank_platform_slo_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL,owner TEXT,epoch TEXT);
    INSERT OR IGNORE INTO clank_platform_slo_state(singleton,protocol) VALUES(1,1);
    CREATE TABLE IF NOT EXISTS clank_platform_slo_collectors(id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS clank_platform_slo_coverage(started_at INTEGER PRIMARY KEY,complete INTEGER NOT NULL CHECK(complete IN(0,1)),epoch TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS clank_platform_slo_buckets(project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,started_at INTEGER NOT NULL,requests INTEGER NOT NULL,completed INTEGER NOT NULL,successful INTEGER NOT NULL,latency TEXT NOT NULL CHECK(json_valid(latency)),PRIMARY KEY(project_id,started_at));
    CREATE INDEX IF NOT EXISTS clank_platform_slo_buckets_time ON clank_platform_slo_buckets(started_at);
    CREATE TABLE IF NOT EXISTS clank_platform_slo_policies(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,version INTEGER NOT NULL,configuration TEXT NOT NULL CHECK(json_valid(configuration)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS clank_platform_slo_policies_project ON clank_platform_slo_policies(project_id,id);
    CREATE TABLE IF NOT EXISTS clank_platform_slo_receipts(project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result)),PRIMARY KEY(project_id,actor_id,operation_id));
    CREATE TABLE IF NOT EXISTS clank_platform_slo_alerts(id TEXT PRIMARY KEY,policy_id TEXT NOT NULL UNIQUE REFERENCES clank_platform_slo_policies(id) ON DELETE CASCADE,project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,policy_version INTEGER NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,observed_at INTEGER NOT NULL);`);
  const owner=crypto.randomUUID();let epoch=crypto.randomUUID(),closed=false,timer:ReturnType<typeof setTimeout>|undefined;
  let previousWall:number|undefined,previousMono:number|undefined,lastPrunedAt:number|undefined,nextSeal=0,fault=false,sweepAfter="";
  const report=(error:unknown)=>{try{hooks.onError?.(error);}catch{}};
  const check=(authority?:SloAuthority,write=false)=>{if(closed)fail(503,"SLO_CLOSED","SLO collector is closed.");protocol();authority?.authorize(write);};
  const invalidate=(from:number,until:number)=>{
    sql.prepare('UPDATE clank_platform_slo_coverage SET complete=0 WHERE started_at>=? AND started_at<=?').run(Math.floor(from/minute)*minute,Math.floor(until/minute)*minute);
    sql.prepare('INSERT INTO clank_platform_slo_coverage(started_at,complete,epoch) VALUES(?,0,?) ON CONFLICT(started_at) DO UPDATE SET complete=0').run(Math.floor(until/minute)*minute,epoch);
  };
  const pulse=():boolean=>{
    check();if(!hooks.collecting)return false;
    const now=integer(clock.wall(),0,Number.MAX_SAFE_INTEGER-retention),mono=clock.monotonic();
    if(!Number.isFinite(mono)||mono<0)throw new TypeError("Invalid collector monotonic clock.");
    const gap=previousWall!==undefined&&(now<previousWall||mono<previousMono!||now-previousWall>lease||Math.abs((now-previousWall)-(mono-previousMono!))>heartbeat*2);
    const sole=sql.transaction(()=>{
      check();
      sql.prepare('DELETE FROM clank_platform_slo_collectors WHERE expires_at<=?').run(now);
      sql.prepare('INSERT INTO clank_platform_slo_collectors VALUES(?,?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at').run(owner,now+lease);
      const collectors=sql.prepare('SELECT id FROM clank_platform_slo_collectors ORDER BY id LIMIT 2').all();
      const state=sql.prepare('SELECT owner,epoch FROM clank_platform_slo_state WHERE singleton=1').get()!;
      if(collectors.length!==1||collectors[0]!.id!==owner){
        invalidate(Math.min(previousWall??now,now),Math.max(previousWall??now,now));
        sql.prepare('UPDATE clank_platform_slo_state SET owner=NULL,epoch=NULL WHERE singleton=1').run();nextSeal=0;return false;
      }
      if(state.owner!==owner||state.epoch!==epoch||gap||fault||!nextSeal){
        invalidate(Math.min(previousWall??now,now),Math.max(previousWall??now,now));epoch=crypto.randomUUID();
        sql.prepare('UPDATE clank_platform_slo_state SET owner=?,epoch=? WHERE singleton=1').run(owner,epoch);
        nextSeal=(Math.floor(now/minute)+1)*minute;fault=false;
      }else{
        // At most one complete minute can elapse without the heartbeat gap guard firing.
        if(nextSeal+minute<=now){
          const missing=Number(sql.prepare(`SELECT count(DISTINCT p.project_id) AS n FROM clank_platform_slo_policies p
            WHERE json_extract(p.configuration,'$.enabled')=1 AND p.created_at<=?
            AND NOT EXISTS(SELECT 1 FROM clank_platform_slo_buckets b WHERE b.project_id=p.project_id AND b.started_at=?)`).get(nextSeal,nextSeal)?.n);
          const retained=Number(sql.prepare('SELECT count(*) AS n FROM clank_platform_slo_buckets').get()?.n);
          if(retained+missing>maxBuckets)invalidate(nextSeal,nextSeal);
          else{
            sql.prepare(`INSERT OR IGNORE INTO clank_platform_slo_buckets
              SELECT DISTINCT project_id,?,0,0,0,'[0,0,0,0,0,0,0]' FROM clank_platform_slo_policies
              WHERE json_extract(configuration,'$.enabled')=1 AND created_at<=?`).run(nextSeal,nextSeal);
            sql.prepare('INSERT OR IGNORE INTO clank_platform_slo_coverage VALUES(?,1,?)').run(nextSeal,epoch);
          }
          nextSeal+=minute;
        }
      }
      if(lastPrunedAt===undefined||now<lastPrunedAt||now-lastPrunedAt>=minute){
        sql.prepare('DELETE FROM clank_platform_slo_coverage WHERE started_at<?').run(now-retention);
        sql.prepare('DELETE FROM clank_platform_slo_buckets WHERE started_at<?').run(now-retention);
        sql.prepare(`DELETE FROM clank_platform_slo_buckets WHERE started_at<?-60000*(2+coalesce(
          (SELECT max(CAST(json_extract(configuration,'$.windowMinutes') AS INTEGER)) FROM clank_platform_slo_policies p
            WHERE p.project_id=clank_platform_slo_buckets.project_id AND json_extract(configuration,'$.enabled')=1),0))`).run(now);
        lastPrunedAt=now;
      }
      return true;
    });
    previousWall=now;previousMono=mono;return sole;
  };
  const record=(metric:IngressRequestMetric):void=>{
    if(closed)return;
    try{
      check();
      if(!sql.prepare("SELECT 1 FROM clank_platform_slo_policies WHERE project_id=? AND json_extract(configuration,'$.enabled')=1 LIMIT 1").get(metric.projectId))return;
      if(!pulse())return;
      const now=clock.wall(),start=Math.floor(now/minute)*minute;
      if(now<previousWall!||Math.abs((now-previousWall!)-(clock.monotonic()-previousMono!))>heartbeat*2)throw new Error("SLO clock changed during observation.");
      if(!Number.isSafeInteger(metric.statusCode)||metric.statusCode<100||metric.statusCode>599||!Number.isFinite(metric.durationMs)||metric.durationMs<0||!['complete','cancelled','error'].includes(metric.responseOutcome))throw new TypeError("Invalid ingress SLO outcome.");
      id(metric.projectId);
      const completed=Number(metric.responseOutcome==='complete'),successful=Number(completed===1&&metric.statusCode>=200&&metric.statusCode<400);
      const latency=boundaries.map(bound=>Number(completed===1&&metric.durationMs<=bound));
      sql.transaction(()=>{
        check();const state=sql.prepare('SELECT owner,epoch FROM clank_platform_slo_state WHERE singleton=1').get()!;
        const collectors=sql.prepare('SELECT id FROM clank_platform_slo_collectors WHERE expires_at>? ORDER BY id LIMIT 2').all(now);
        if(state.owner!==owner||state.epoch!==epoch||collectors.length!==1||collectors[0]!.id!==owner)throw new Error("SLO collector ownership changed.");
        const row=sql.prepare('SELECT * FROM clank_platform_slo_buckets WHERE project_id=? AND started_at=?').get(metric.projectId,start);
        if(!row){
          if(Number(sql.prepare('SELECT count(*) AS n FROM clank_platform_slo_buckets').get()?.n)>=maxBuckets)throw new Error("SLO measurement capacity is full.");
          sql.prepare('INSERT INTO clank_platform_slo_buckets VALUES(?,?,1,?,?,?)').run(metric.projectId,start,completed,successful,JSON.stringify(latency));
        }else{
          const prior=JSON.parse(String(row.latency));if(!Array.isArray(prior)||prior.length!==7)throw new Error("Malformed retained SLO histogram.");
          const counts=latency.map((count,index)=>integer(prior[index]+count,0,Number.MAX_SAFE_INTEGER));
          sql.prepare('UPDATE clank_platform_slo_buckets SET requests=?,completed=?,successful=?,latency=? WHERE project_id=? AND started_at=?').run(integer(Number(row.requests)+1,0,Number.MAX_SAFE_INTEGER),integer(Number(row.completed)+completed,0,Number.MAX_SAFE_INTEGER),integer(Number(row.successful)+successful,0,Number.MAX_SAFE_INTEGER),JSON.stringify(counts),metric.projectId,start);
        }
      });
    }catch(error){fault=true;try{protocol();const now=clock.wall();invalidate(Math.min(previousWall??now,now),Math.max(previousWall??now,now));}catch{}report(error);}
  };
  const policyFrom=(row:Record<string,unknown>):StoredSloPolicy=>({...validateProjectSloConfiguration(JSON.parse(String(row.configuration))),id:String(row.id),projectId:String(row.project_id),version:Number(row.version),createdAt:Number(row.created_at),updatedAt:Number(row.updated_at)});
  const current=(projectId:string,policyId:string):StoredSloPolicy=>{
    const row=sql.prepare('SELECT * FROM clank_platform_slo_policies WHERE project_id=? AND id=?').get(projectId,policyId);
    if(!row)fail(404,"SLO_NOT_FOUND","SLO policy not found.");return policyFrom(row!);
  };
  const evaluate=(policy:StoredSloPolicy):ProjectSloEvaluation=>{
    const until=Math.floor(clock.wall()/minute)*minute,from=until-policy.windowMinutes*minute;
    const project=sql.prepare('SELECT created_at FROM clank_platform_projects WHERE id=?').get(policy.projectId);
    if(!project)fail(404,"PROJECT_NOT_FOUND","Project not found.");
    const rows=new Map(sql.prepare('SELECT * FROM clank_platform_slo_buckets WHERE project_id=? AND started_at>=? AND started_at<? ORDER BY started_at').all(policy.projectId,from,until).map(row=>[Number(row.started_at),row]));
    const coverage=new Set(sql.prepare('SELECT started_at FROM clank_platform_slo_coverage WHERE complete=1 AND started_at>=? AND started_at<? ORDER BY started_at').all(from,until).map(row=>Number(row.started_at)));
    const buckets:ProjectSloBucket[]=[];
    for(let start=from;start<until;start+=minute){
      const row=rows.get(start);
      buckets.push({startedAt:start,complete:!!row&&coverage.has(start)&&Number(project!.created_at)<=start&&policy.updatedAt<=start,requests:Number(row?.requests??0),completed:Number(row?.completed??0),successful:Number(row?.successful??0),latency:row?JSON.parse(String(row.latency)):[0,0,0,0,0,0,0]});
    }
    return evaluateProjectSlo(policyConfiguration(policy),buckets,until);
  };
  const policyConfiguration=(policy:StoredSloPolicy):ProjectSloConfiguration=>({name:policy.name,objective:policy.objective,targetBasisPoints:policy.targetBasisPoints,windowMinutes:policy.windowMinutes,minimumRequests:policy.minimumRequests,burnThreshold:policy.burnThreshold,enabled:policy.enabled});
  const alertFrom=(row:Record<string,unknown>):StoredSloAlert=>({id:String(row.id),policyId:String(row.policy_id),projectId:String(row.project_id),policyVersion:Number(row.policy_version),state:row.state as StoredSloAlert['state'],version:Number(row.version),observedAt:Number(row.observed_at)});
  const assess=(policy:StoredSloPolicy,authority?:SloAuthority)=>{
    check(authority);const evaluation=evaluate(policy);
    const alert=sql.transaction(()=>{
      check(authority);if(current(policy.projectId,policy.id).version!==policy.version)fail(409,"SLO_VERSION_CONFLICT","SLO policy changed; refresh its measurements.");
      const prior=sql.prepare('SELECT * FROM clank_platform_slo_alerts WHERE policy_id=?').get(policy.id);
      const state:StoredSloAlert['state']=!policy.enabled?'disabled':evaluation.burning===null?'unknown':evaluation.burning?'open':'resolved';
      if(!prior&&state!=='open')return null;
      if(prior&&prior.state===state&&Number(prior.policy_version)===policy.version)return alertFrom(prior);
      const alertId=prior?String(prior.id):crypto.randomUUID(),version=prior?Number(prior.version)+1:1;
      sql.prepare('INSERT INTO clank_platform_slo_alerts VALUES(?,?,?,?,?,?,?) ON CONFLICT(policy_id) DO UPDATE SET policy_version=excluded.policy_version,state=excluded.state,version=excluded.version,observed_at=excluded.observed_at').run(alertId,policy.id,policy.projectId,policy.version,state,version,clock.wall());
      return alertFrom(sql.prepare('SELECT * FROM clank_platform_slo_alerts WHERE policy_id=?').get(policy.id)!);
    });check(authority);return {policy,evaluation,alert};
  };
  const receipt=(projectId:string,authority:SloAuthority,operationId:string,request:string):StoredSloPolicy|null=>{
    const row=sql.prepare('SELECT request,result FROM clank_platform_slo_receipts WHERE project_id=? AND actor_id=? AND operation_id=?').get(projectId,authority.userId,operationId);
    if(!row)return null;if(row.request!==request)fail(409,"SLO_OPERATION_CONFLICT","That operation ID already represents another SLO change.");return JSON.parse(String(row.result));
  };
  const save=(policy:StoredSloPolicy,authority:SloAuthority,operationId:string,request:string)=>{
    sql.prepare('INSERT INTO clank_platform_slo_receipts VALUES(?,?,?,?,?)').run(policy.projectId,authority.userId,operationId,request,JSON.stringify(policy));
    authority.audit('slo.policy',{policyId:policy.id,version:policy.version,operationId});return policy;
  };
  const capacity=()=>{if(Number(sql.prepare('SELECT count(*) AS n FROM clank_platform_slo_receipts').get()?.n)>=maxReceipts)fail(409,"SLO_CAPACITY","SLO receipt capacity is full.");};
  const reserve=(projectId:string,policyId:string|null,configuration:ProjectSloConfiguration)=>{
    const rows=sql.prepare(`SELECT project_id,max(CAST(json_extract(configuration,'$.windowMinutes') AS INTEGER)) AS minutes
      FROM clank_platform_slo_policies WHERE (? IS NULL OR id<>?) AND json_extract(configuration,'$.enabled')=1 GROUP BY project_id`).all(policyId,policyId);
    const windows=new Map(rows.map(row=>[String(row.project_id),Number(row.minutes)]));
    if(configuration.enabled)windows.set(projectId,Math.max(configuration.windowMinutes,windows.get(projectId)??0));
    const required=[...windows.values()].reduce((sum,value)=>sum+value+2,0);
    if(required>maxBuckets)fail(409,"SLO_CAPACITY","Configured SLO windows exceed bounded measurement capacity.");
  };
  const api={
    pulse,record,
    list(projectId:string,authority:SloAuthority){check(authority);id(projectId);const policies=sql.prepare('SELECT * FROM clank_platform_slo_policies WHERE project_id=? ORDER BY created_at,id LIMIT 10').all(projectId).map(policyFrom);return policies.map(policy=>assess(policy,authority));},
    read(projectId:string,policyId:string,authority:SloAuthority){check(authority);id(projectId);id(policyId);return assess(current(projectId,policyId),authority);},
    create(projectId:string,authority:SloAuthority,value:unknown):StoredSloPolicy{
      check(authority,true);id(projectId);const input=exact(value,['configuration','operationId']),operationId=id(input.operationId);
      const configuration=configurationInput(input.configuration);
      const request=JSON.stringify({kind:'create',configuration});
      return sql.transaction(()=>{
        check(authority,true);const retained=receipt(projectId,authority,operationId,request);if(retained)return retained;capacity();
        reserve(projectId,null,configuration);
        if(Number(sql.prepare('SELECT count(*) AS n FROM clank_platform_slo_policies').get()?.n)>=maxPolicies||Number(sql.prepare('SELECT count(*) AS n FROM clank_platform_slo_policies WHERE project_id=?').get(projectId)?.n)>=10)fail(409,"SLO_CAPACITY","SLO policy capacity is full.");
        const policyId=crypto.randomUUID(),now=clock.wall();sql.prepare('INSERT INTO clank_platform_slo_policies VALUES(?,?,1,?,?,?)').run(policyId,projectId,JSON.stringify(configuration),now,now);
        return save(current(projectId,policyId),authority,operationId,request);
      });
    },
    change(projectId:string,policyId:string,authority:SloAuthority,value:unknown):StoredSloPolicy{
      check(authority,true);id(projectId);id(policyId);const input=exact(value,['configuration','expectedVersion','operationId']),operationId=id(input.operationId),expectedVersion=integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER-1);
      const configuration=configurationInput(input.configuration);
      const request=JSON.stringify({kind:'change',policyId,expectedVersion,configuration});
      return sql.transaction(()=>{
        check(authority,true);const retained=receipt(projectId,authority,operationId,request);if(retained)return retained;capacity();
        const prior=current(projectId,policyId);if(prior.version!==expectedVersion)fail(409,"SLO_VERSION_CONFLICT","SLO policy changed; refresh before saving.");
        reserve(projectId,policyId,configuration);
        sql.prepare('UPDATE clank_platform_slo_policies SET version=version+1,configuration=?,updated_at=? WHERE project_id=? AND id=? AND version=?').run(JSON.stringify(configuration),clock.wall(),projectId,policyId,expectedVersion);
        return save(current(projectId,policyId),authority,operationId,request);
      });
    },
    alert(projectId:string,alertId:string):StoredSloAlert|null{check();const row=sql.prepare('SELECT * FROM clank_platform_slo_alerts WHERE project_id=? AND id=?').get(projectId,alertId);return row?alertFrom(row):null;},
    start(){if(closed||timer||!hooks.collecting||hooks.manual)return;const run=()=>{timer=undefined;if(closed)return;try{
      pulse();const rows=sql.prepare('SELECT * FROM clank_platform_slo_policies WHERE id>? ORDER BY id LIMIT 10').all(sweepAfter);for(const row of rows)assess(policyFrom(row));sweepAfter=rows.length?String(rows.at(-1)!.id):'';
    }catch(error){fault=true;report(error);}finally{if(!closed){timer=setTimeout(run,heartbeat);(timer as any).unref?.();}}};timer=setTimeout(run,heartbeat);(timer as any).unref?.();},
    close(){if(closed)return;closed=true;if(timer)clearTimeout(timer);try{sql.transaction(()=>{protocol();if(hooks.collecting)invalidate(clock.wall(),clock.wall());sql.prepare('DELETE FROM clank_platform_slo_collectors WHERE id=?').run(owner);sql.prepare('UPDATE clank_platform_slo_state SET owner=NULL,epoch=NULL WHERE singleton=1 AND owner=?').run(owner);});}catch(error){report(error);}},
  };
  if(hooks.collecting)pulse();return api;
}
