// Frozen actual src/managed-shadow.ts at99226b4; SHA256fdc79c59eea13ccf37ac20f60595453a1a8fdfa036abd7f0a514b35bddec3b2b.
// Native TypeScript stripping only; supervisor validator import URLs point to its matching frozen fixture.
                                                           

/** @internal Explicit platform maxima; no implicit widening or enablement. */
                                       
                            
                                        
                                                
                                    
                                 
                               
                                 
                                    
                                
                              
 

/** @internal A review may narrow these limits, never broaden platform policy. */
                                      
                                        
                                                
                                 
                              
                               
                                 
                                    
                             
 

                                                                                                                   
                                                                                                                                                   
                                                                                                                        
/** @internal Transport aggregates carry no response body, identity or arbitrary header key. */
                               
                                                                                                                                              
                                                                                                                                        
                                                                                   
 

export const shadowLatencyBuckets                    = Object.freeze([1,5,10,25,50,100,250,500,1000,2500,5000,10000]);
const shadowUnknownReasons                                 = Object.freeze(["not-submitted","candidate-timeout","candidate-oversized","candidate-error",
  "primary-incomplete","primary-oversized","cancelled","authority-lost","interrupted","persistence-uncertain","content-type-invalid"]);

function shadowInvalid(code        )        { const error = new TypeError(code === "SHADOW_POLICY_INVALID" ? "Shadow policy may only narrow explicit public reads and bounded limits." : "Retained shadow transport aggregates are invalid."); Object.assign(error,{code}); throw error; }
function closedShadowObject(value         , keys                   , code        , required = true)                         {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key))
    || required && keys.some(key=>!Object.hasOwn(value,key))) shadowInvalid(code);
  return value                          ;
}
function shadowNumber(value         , maximum        , code        , minimum = 1)         {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) shadowInvalid(code);
  return value;
}
function shadowPercentage(value         , maximum        )         {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.01 || value > maximum) shadowInvalid("SHADOW_POLICY_INVALID");
  return value;
}
function shadowReads(value         , methods         , allowed                    )                    {
  if (!Array.isArray(value)) shadowInvalid("SHADOW_POLICY_INVALID");
  const items = [...value];
  if (items.length < 1 || items.length > (methods ? 2 : 32) || new Set(items).size !== items.length
    || items.some(path=>typeof path !== "string" || (methods ? !["GET","HEAD"].includes(path)
      : path.length > 256 || !/^\/[A-Za-z0-9/_.~-]*$/u.test(path) || path.includes("//") || path.split("/").some(segment=>segment === "." || segment === ".."))
      || allowed && !allowed.includes(path))) shadowInvalid("SHADOW_POLICY_INVALID");
  return Object.freeze(items.sort());
}

/** @internal Normalize before creating schema, ownership or artifact side effects. */
export function normalizeShadowPolicy(value         )                       {
  const fields = ["revision","readPaths","methods","maxSamplePercent","maxDurationMs","maxAttempts","maxConcurrent","maxResponseBytes","maxRequestMs","maxReports"];
  const input = closedShadowObject(value,fields,"SHADOW_POLICY_INVALID");
  const result = {revision:shadowNumber(input.revision,Number.MAX_SAFE_INTEGER,"SHADOW_POLICY_INVALID"),readPaths:shadowReads(input.readPaths,false),
    methods:shadowReads(input.methods,true)                             ,maxSamplePercent:shadowPercentage(input.maxSamplePercent,100),
    maxDurationMs:shadowNumber(input.maxDurationMs,1800000,"SHADOW_POLICY_INVALID"),maxAttempts:shadowNumber(input.maxAttempts,10000,"SHADOW_POLICY_INVALID"),
    maxConcurrent:shadowNumber(input.maxConcurrent,16,"SHADOW_POLICY_INVALID"),maxResponseBytes:shadowNumber(input.maxResponseBytes,65536,"SHADOW_POLICY_INVALID"),
    maxRequestMs:shadowNumber(input.maxRequestMs,10000,"SHADOW_POLICY_INVALID"),maxReports:shadowNumber(input.maxReports,100,"SHADOW_POLICY_INVALID")};
  return Object.freeze(result);
}

export function narrowShadowPolicy(policy                      , value         )                      {
  const current = normalizeShadowPolicy(policy),input = closedShadowObject(value,["readPaths","methods","samplePercent","durationMs","maxAttempts","maxConcurrent","maxResponseBytes","requestMs"],"SHADOW_POLICY_INVALID",false);
  const number = (key        , maximum        ) => shadowNumber(Object.hasOwn(input,key)?input[key]:maximum,maximum,"SHADOW_POLICY_INVALID");
  return Object.freeze({readPaths:shadowReads(Object.hasOwn(input,"readPaths")?input.readPaths:current.readPaths,false,current.readPaths),
    methods:shadowReads(Object.hasOwn(input,"methods")?input.methods:current.methods,true,current.methods)                             ,samplePercent:shadowPercentage(Object.hasOwn(input,"samplePercent")?input.samplePercent:current.maxSamplePercent,current.maxSamplePercent),
    durationMs:number("durationMs",current.maxDurationMs),maxAttempts:number("maxAttempts",current.maxAttempts),maxConcurrent:number("maxConcurrent",current.maxConcurrent),
    maxResponseBytes:number("maxResponseBytes",current.maxResponseBytes),requestMs:number("requestMs",current.maxRequestMs)});
}

export function emptyShadowReport()               {
  const unknown = Object.fromEntries(shadowUnknownReasons.map(reason=>[reason,0]))                                      ;
  const latency = () => ({cumulative:shadowLatencyBuckets.map(()=>0),overflow:0,unknown:0});
  return normalizeShadowReport({counters:{reserved:0,settled:0,comparable:0,statusClassEqual:0,statusClassDifferent:0,mediaTypeEqual:0,mediaTypeDifferent:0,bothComplete:0,unknown},latency:{primary:latency(),candidate:latency()}},10000);
}

/** @internal Fail closed before publishing or replaying a retained aggregate. */
export function normalizeShadowReport(value         , maxAttempts        )               {
  const code = "SHADOW_REPORT_INVALID",maximum = shadowNumber(maxAttempts,10000,code),input = closedShadowObject(value,["counters","latency"],code);
  const counterKeys = ["reserved","settled","comparable","statusClassEqual","statusClassDifferent","mediaTypeEqual","mediaTypeDifferent","bothComplete","unknown"];
  const raw = closedShadowObject(input.counters,counterKeys,code),rawUnknown = closedShadowObject(raw.unknown,shadowUnknownReasons,code);
  const count = (number         ) => shadowNumber(number,maximum,code,0);
  const unknown = Object.freeze(Object.fromEntries(shadowUnknownReasons.map(reason=>[reason,count(rawUnknown[reason])]))                                      );
  const counters = Object.freeze({reserved:count(raw.reserved),settled:count(raw.settled),comparable:count(raw.comparable),statusClassEqual:count(raw.statusClassEqual),
    statusClassDifferent:count(raw.statusClassDifferent),mediaTypeEqual:count(raw.mediaTypeEqual),mediaTypeDifferent:count(raw.mediaTypeDifferent),bothComplete:count(raw.bothComplete),unknown});
  // Completion requires actual EOF for both bounded bodies. Invalid media or later authority/persistence loss
  // can follow EOF, but a non-submission, timeout, transport error or incomplete/oversized body cannot.
  const incomplete = unknown["not-submitted"]+unknown["candidate-timeout"]+unknown["candidate-oversized"]
    +unknown["candidate-error"]+unknown["primary-incomplete"]+unknown["primary-oversized"];
  if (counters.settled > counters.reserved || counters.bothComplete > counters.settled-incomplete || counters.comparable > counters.bothComplete
    || counters.statusClassEqual+counters.statusClassDifferent !== counters.comparable || counters.mediaTypeEqual+counters.mediaTypeDifferent !== counters.comparable
    || counters.comparable+Object.values(unknown).reduce((sum,value)=>sum+value,0) !== counters.settled) shadowInvalid(code);
  const latency = closedShadowObject(input.latency,["primary","candidate"],code);
  const histogram = (value         )                => {
    const raw = closedShadowObject(value,["cumulative","overflow","unknown"],code);
    if (!Array.isArray(raw.cumulative) || raw.cumulative.length !== shadowLatencyBuckets.length) shadowInvalid(code);
    const cumulative = [...raw.cumulative].map(count),overflow = count(raw.overflow),unknown = count(raw.unknown);
    if (cumulative.some((value,index)=>index > 0 && value < cumulative[index-1]) || cumulative[cumulative.length-1]+overflow+unknown !== counters.settled) shadowInvalid(code);
    return Object.freeze({cumulative:Object.freeze(cumulative),overflow,unknown});
  };
  return Object.freeze({counters,latency:Object.freeze({primary:histogram(latency.primary),candidate:histogram(latency.candidate)})});
}

/** @internal Schema identity is separate from per-session policy and enablement. */
export const shadowSchemaIdentity = "clank-platform-shadow/1";

/** @internal Read only: protocol-three startup must never reconstruct missing state. */
export function assertProviderShadowSchema(connection                                 )         {
  const invalid = ()        => { const error = new Error("Retained shadow schema is missing or invalid; preserve it for recovery."); Object.assign(error, { code: "SUPERVISOR_SHADOW_SCHEMA" }); throw error; };
  const schemas = {
    clank_platform_shadow_state: ["singleton:INTEGER:0:1", "protocol:INTEGER:1:0", "enrollment_id:TEXT:1:0", "schema_id:TEXT:1:0"],
    clank_platform_shadow_reports: ["project_id:TEXT:1:1", "session_id:TEXT:1:2", "idempotency_key_digest:TEXT:1:0", "input_digest:TEXT:1:0", "receipt_json:TEXT:1:0", "report_json:TEXT:0:0"],
  };
  const tables = connection.prepare("PRAGMA table_list").all();
  for (const [name, expected] of Object.entries(schemas)) {
    if (!tables.some(table => table.schema === "main" && table.name === name && table.type === "table" && table.strict === 1)) invalid();
    const columns = connection.prepare(`PRAGMA main.table_info(${name})`).all();
    if (columns.length !== expected.length || columns.some((column, index) => `${column.name}:${column.type}:${column.notnull}:${column.pk}` !== expected[index])) invalid();
  }
  if (!tables.some(table => table.schema === "main" && table.name === "clank_platform_provider_canaries" && table.type === "table")) invalid();
  const candidateColumns = connection.prepare("PRAGMA main.table_info(clank_platform_provider_canaries)").all();
  const expectedCandidateColumns = ["project_id:TEXT:0:1", "protocol:INTEGER:1:0", "epoch:INTEGER:1:0", "operation:TEXT:1:0", "updated_at:INTEGER:1:0"];
  if (candidateColumns.length !== expectedCandidateColumns.length || candidateColumns.some((column, index) => `${column.name}:${column.type}:${column.notnull}:${column.pk}` !== expectedCandidateColumns[index])) invalid();
  const indices = connection.prepare("PRAGMA main.index_list(clank_platform_shadow_reports)").all();
  if (!indices.some(index => {
    if (index.unique !== 1 || index.partial !== 0 || typeof index.name !== "string") return false;
    const columns = connection.prepare(`PRAGMA main.index_info("${index.name.replaceAll('"', '""')}")`).all();
    return columns.length === 2 && columns[0].name === "project_id" && columns[1].name === "idempotency_key_digest";
  })) invalid();
  const projects = connection.prepare("PRAGMA main.table_info(clank_platform_projects)").all();
  const releases = connection.prepare("PRAGMA main.table_info(clank_platform_releases)").all();
  if (!projects.some(column => column.name === "provider_canary_epoch" && column.type === "INTEGER" && column.notnull === 1 && column.dflt_value === "0")
    || !projects.some(column => column.name === "shadow_replay_receipt" && column.type === "TEXT" && column.notnull === 0)
    || !releases.some(column => column.name === "purpose" && column.type === "TEXT" && column.notnull === 1 && column.dflt_value === "'deployment'")
    || !releases.some(column => column.name === "upload_request_digest" && column.type === "TEXT" && column.notnull === 0)) invalid();
  const rows = connection.prepare("SELECT * FROM clank_platform_shadow_state LIMIT 2").all();
  const row = rows[0];
  if (rows.length !== 1 || row.singleton !== 1 || row.protocol !== 1 || row.schema_id !== shadowSchemaIdentity
    || typeof row.enrollment_id !== "string" || !/^[a-f0-9]{64}$/u.test(row.enrollment_id)) invalid();
  return row.enrollment_id          ;
}
