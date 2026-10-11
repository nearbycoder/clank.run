// Frozen b44a5d7 emitted protocol-1 reader. Only its private dependency path is relocated.
/** Private provider-root ownership/catalog foundation. No runtime grant or stop proof. */
import{runProviderDockerClient,}from "../../dist/provider-docker-client.js";
const OWNER_SQL="CREATE TABLE clank_provider_service_owner (protocol INTEGER NOT NULL CHECK(protocol=1)) STRICT";
const MARKER_SQL=`CREATE TABLE clank_provider_handoff_owner (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol INTEGER NOT NULL CHECK(protocol=1),
  index_id TEXT NOT NULL CHECK(length(index_id)=36),
  domain_json TEXT NOT NULL CHECK(length(CAST(domain_json AS BLOB)) BETWEEN 1 AND 4096),
  domain_sha256 TEXT NOT NULL CHECK(length(domain_sha256)=64)
) STRICT`;
const INDEX_SQL=`CREATE TABLE clank_provider_handoff_index (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol INTEGER NOT NULL CHECK(protocol=1),
  index_id TEXT NOT NULL CHECK(length(index_id)=36),
  domain_sha256 TEXT NOT NULL CHECK(length(domain_sha256)=64)
) STRICT`;
const PROJECTS_SQL=`CREATE TABLE clank_provider_handoff_projects (
  project_id TEXT PRIMARY KEY NOT NULL CHECK(length(project_id) BETWEEN 1 AND 128),
  catalog_id TEXT NOT NULL UNIQUE CHECK(length(catalog_id)=36),
  installation TEXT NOT NULL CHECK(installation IN ('reserved','ready'))
) STRICT`;
const CATALOG_SQL=`CREATE TABLE clank_provider_handoff_catalog (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol INTEGER NOT NULL CHECK(protocol=1),
  index_id TEXT NOT NULL CHECK(length(index_id)=36),
  catalog_id TEXT NOT NULL CHECK(length(catalog_id)=36),
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 128),
  domain_sha256 TEXT NOT NULL CHECK(length(domain_sha256)=64),
  barrier_sha256 TEXT CHECK(barrier_sha256 IS NULL OR length(barrier_sha256)=64)
) STRICT`;
const BARRIER_SQL=`CREATE TABLE clank_provider_handoff_barrier (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol INTEGER NOT NULL CHECK(protocol=1),
  handoff_id TEXT NOT NULL CHECK(length(handoff_id) BETWEEN 1 AND 128),
  step_id TEXT NOT NULL CHECK(length(step_id) BETWEEN 1 AND 128),
  identity_json TEXT NOT NULL CHECK(length(CAST(identity_json AS BLOB)) BETWEEN 1 AND 2048),
  source_capsule_sha256 TEXT NOT NULL CHECK(length(source_capsule_sha256)=64),
  source_incarnation TEXT NOT NULL CHECK(length(source_incarnation)=36),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
  version INTEGER NOT NULL CHECK(version=1)
) STRICT`;
const ID=/^[A-Za-z0-9_-]{1,128}$/u,OWNER=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u,DAEMON=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,DIGEST=/^[a-f0-9]{64}$/u;
const OWNER_MAX=65536,INDEX_MAX=262144,CATALOG_MAX=65536;






const owners=new WeakMap();
const domains=new WeakMap();
const schemaCache=new Map();
function fail(message="Provider handoff state is unavailable."){throw new Error(message);}
function code(error){return(error)?.code;}
function exact(value,keys){return !!value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
function match(value,pattern){return typeof value==="string"&&pattern.test(value);}
function positive(value){return Number.isSafeInteger(value)&&Number(value)>0;}
function boundedJSON(value,maximum){const text=JSON.stringify(value);if(new TextEncoder().encode(text).length>maximum)fail();return text;}
function singleton(database,table){const rows=database.prepare(`SELECT * FROM ${table} LIMIT 2`).all();if(rows.length!==1)fail();return rows[0];}
function current(owner,preAdmission=false){
const c=owners.get(owner);if(!c||c.closed||c.failed||!c.database.isTransaction||preAdmission&&c.admitted)fail("A current pre-admission native provider owner is required.");
for(const pin of c.pins)assertPin(c,pin);return c;
}
function privateStat(c,stat,directory,maximum,normalize=false){
if((directory?!stat.isDirectory():!stat.isFile()||stat.nlink!==1)||stat.isSymbolicLink()||stat.uid!==(globalThis).process.getuid?.()||!normalize&&(stat.mode&0o077)!==0||c.marked&&(stat.mode&0o777)!==(directory?0o700:0o600)||!directory&&stat.size>maximum)fail("Provider service ownership must use private bounded native SQLite files.");
}
function assertPin(c,pin){const retained=c.fs.fstatSync(pin.fd),visible=c.fs.lstatSync(pin.path);privateStat(c,retained,pin.directory,pin.maximum,pin.normalize);privateStat(c,visible,pin.directory,pin.maximum,pin.normalize);if(retained.dev!==pin.dev||retained.ino!==pin.ino||visible.dev!==pin.dev||visible.ino!==pin.ino)fail("Provider handoff file identity changed.");}
function pin(c,path,directory,maximum=0,normalize=false){
const before=c.fs.lstatSync(path);privateStat(c,before,directory,maximum,normalize);
const fd=c.fs.openSync(path,c.fs.constants.O_RDONLY|c.fs.constants.O_NOFOLLOW|(directory?c.fs.constants.O_DIRECTORY:0));
const result={fd,path,anchor:(globalThis).process.platform==="linux"?`/proc/self/fd/${fd}`:path,dev:before.dev,ino:before.ino,directory,maximum,normalize};
try{assertPin(c,result);c.pins.push(result);return result;}catch(error){c.fs.closeSync(fd);throw error;}
}
function releasePins(c,from){for(const p of c.pins.splice(from).reverse())c.fs.closeSync(p.fd);}
function absent(c,path){try{c.fs.lstatSync(path);return false;}catch(error){if(code(error)==="ENOENT")return true;throw error;}}
function directory(c,parent,name,create=false){
assertPin(c,parent);const path=c.path.join(parent.path,name),anchor=`${parent.anchor}/${name}`;
if(create)c.fs.mkdirSync(anchor,{mode:0o700});
// No JavaScript callback/await between exclusive creation and retained inode.
return pin(c,path,true);
}
function entries(c,parent,maximum){
assertPin(c,parent);const dir=c.fs.opendirSync(parent.anchor),names =[];
try{let entry;while((entry=dir.readSync())!==null){if(names.length===maximum)fail("Provider handoff directory capacity exceeded.");names.push(entry.name);}}finally{dir.closeSync();}return names.sort();
}
function schemaSignature(database,limit){
const objects=database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name LIMIT ${limit+1}`).all();if(objects.length>limit)fail();
if(objects.some((row)=>typeof row.name!=="string"||!/^[A-Za-z0-9_]+$/u.test(row.name)))fail();
return JSON.stringify(objects.map((row)=>({row,columns:row.type==="table"?database.prepare(`PRAGMA table_xinfo(${JSON.stringify(row.name)})`).all():[],foreign:row.type==="table"?database.prepare(`PRAGMA foreign_key_list(${JSON.stringify(row.name)})`).all():[],indexes:row.type==="table"?database.prepare(`PRAGMA index_list(${JSON.stringify(row.name)})`).all():[],indexed:row.type==="index"?database.prepare(`PRAGMA index_xinfo(${JSON.stringify(row.name)})`).all():[]})));
}
function strictSchema(c,database,sqls){
const key=sqls.join(";"),maximum=sqls.length+2;let expected=schemaCache.get(key);
if(!expected){const sample=new c.Database(":memory:");try{sample.exec(key);expected=schemaSignature(sample,maximum);schemaCache.set(key,expected);}finally{sample.close();}}
if(schemaSignature(database,maximum)!==expected)fail("Provider handoff schema is unsupported.");
}
function domainValue(value){
if(!exact(value,["protocol","nodeId","daemonId","owner"])||value.protocol!=="clank-provider-handoff-domain/1"||!match(value.nodeId,ID)||!match(value.daemonId,DAEMON)||!match(value.owner,OWNER))fail("Provider handoff domain is invalid.");
return Object.freeze({protocol:"clank-provider-handoff-domain/1",nodeId:value.nodeId,daemonId:value.daemonId,owner:value.owner});
}
function marker(c){
const present=c.database.prepare("SELECT type FROM sqlite_schema WHERE name='clank_provider_handoff_owner'").get();
if(!present){const objects=c.database.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 2").all();if(objects.length!==1||objects[0].name!=="clank_provider_service_owner"||objects[0].type!=="table"||singleton(c.database,"clank_provider_service_owner").protocol!==1)fail("Provider service ownership protocol is unsupported.");return null;}
strictSchema(c,c.database,[OWNER_SQL,MARKER_SQL]);const row=singleton(c.database,"clank_provider_handoff_owner"),legacy=singleton(c.database,"clank_provider_service_owner");
if(!exact(legacy,["protocol"])||legacy.protocol!==1||row.id!==1||row.protocol!==1||!match(row.index_id,UUID)||!match(row.domain_sha256,DIGEST)||typeof row.domain_json!=="string")fail();
let domain;try{domain=domainValue(JSON.parse(row.domain_json));}catch{fail();}
if(boundedJSON(domain,4096)!==row.domain_json||c.hash(row.domain_json)!==row.domain_sha256)fail();c.marked=true;for(const p of c.pins)assertPin(c,p);return{...row,domain};
}
function sidecars(c,parent,name,maximum,allowWAL=false){
for(const suffix of["-journal","-wal","-shm"]){const path=c.path.join(parent.path,name+suffix);if(absent(c,path))continue;if(suffix!=="-journal"&&!allowWAL)fail("Provider handoff WAL sidecars are unsupported.");const stat=c.fs.lstatSync(path);privateStat(c,stat,false,maximum);}
}
function databaseAt(c,parent,name,maximum,write,action){
const from=c.pins.length;assertPin(c,parent);sidecars(c,parent,name,maximum*2);let database;
try{const file=pin(c,c.path.join(parent.path,name),false,maximum);database=new c.Database(`${parent.anchor}/${name}`,{readOnly:!write});database.exec("PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF");if(database.prepare("PRAGMA journal_mode").get()?.journal_mode!=="delete")fail("Provider handoff journal mode is unsupported.");
if(write){database.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");const page=database.prepare("PRAGMA page_size").get()?.page_size;if(!positive(page)||page>maximum)fail();database.exec(`PRAGMA max_page_count=${Math.floor(maximum/page)}`);}
const result=action(database,file);assertPin(c,file);return result;
}finally{database?.close();releasePins(c,from);}
}
function sync(c,file,parent){assertPin(c,file);assertPin(c,parent);c.fs.fsyncSync(file.fd);c.fs.fsyncSync(parent.fd);assertPin(c,file);assertPin(c,parent);}
function createDatabase(c,parent,name,maximum,sqls,seed){
assertPin(c,parent);const filename=`${parent.anchor}/${name}`,fd=c.fs.openSync(filename,c.fs.constants.O_CREAT|c.fs.constants.O_EXCL|c.fs.constants.O_RDWR|c.fs.constants.O_NOFOLLOW,0o600);c.fs.closeSync(fd);
databaseAt(c,parent,name,maximum,true,(database,file)=>{database.exec("BEGIN IMMEDIATE");try{database.exec(sqls.join(";"));seed(database);strictSchema(c,database,sqls);database.exec("COMMIT");sync(c,file,parent);}catch(error){if(database.isTransaction)database.exec("ROLLBACK");throw error;}});
}
/** Acquire the same durable owner used by ordinary services; never return its native connection. */
export async function acquireProviderServiceOwnership(rootDirectory,createRoot=false){
const fsName="node:fs",promisesName="node:fs/promises",pathName="node:path",sqliteName="node:sqlite",cryptoName="node:crypto";
const[fs,promises,path,{DatabaseSync},nativeCrypto]=await Promise.all([import(fsName),import(promisesName),import(pathName),import(sqliteName),import(cryptoName)]);
if(typeof rootDirectory!=="string"||!rootDirectory.trim()||rootDirectory.includes("\0"))throw new TypeError("rootDirectory is required.");
const c ={fs,path,Database:DatabaseSync,hash:text=>nativeCrypto.createHash("sha256").update(text).digest("hex"),randomUUID:nativeCrypto.randomUUID,root:null,service:null,file:null,database:null,pins:[],closed:false,admitted:false,marked:false,failed:false,queued:0,tail:Promise.resolve()};
try{
const requested=path.resolve(rootDirectory);if(createRoot)fs.mkdirSync(requested,{recursive:true,mode:0o700});
const rootStat=fs.lstatSync(requested);if(rootStat.isSymbolicLink()||!rootStat.isDirectory()||rootStat.uid!==(globalThis).process.getuid?.())fail("rootDirectory must be a private owner-controlled directory.");
c.root=pin(c,fs.realpathSync(requested),true,0,createRoot);let service=path.join(c.root.path,"service");if(absent(c,service)){if(createRoot)fs.fchmodSync(c.root.fd,0o700);fs.mkdirSync(`${c.root.anchor}/service`,{mode:0o700});}else{const stat=fs.lstatSync(service);if(stat.isSymbolicLink()||!stat.isDirectory()||stat.uid!==(globalThis).process.getuid?.())fail("provider service directory must be an owner-controlled real directory.");}
c.service=pin(c,service,true,0,true);const filename=path.join(service,".writer.sqlite"),missing=absent(c,filename),normalize=(rootStat.mode&0o777)!==0o700||(fs.fstatSync(c.service.fd).mode&0o777)!==0o700;
if(missing){inspect(c,null);if(createRoot)fs.fchmodSync(c.root.fd,0o700);fs.fchmodSync(c.service.fd,0o700);const fd=fs.openSync(`${c.service.anchor}/.writer.sqlite`,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.closeSync(fd);fs.fsyncSync(c.service.fd);}
sidecars(c,c.service,".writer.sqlite",OWNER_MAX,true);c.file=pin(c,filename,false,OWNER_MAX);
if(normalize&&!missing){
// Plain readOnly can create WAL/SHM. EXCLUSIVE before first access avoids that;
// native refusal is uncertainty, never permission to retry writable/immutable.
c.database=new DatabaseSync(`${c.service.anchor}/.writer.sqlite`,{readOnly:true});
try{c.database.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA query_only=ON; PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF");if(c.database.prepare("SELECT name FROM sqlite_schema LIMIT 1").all().length!==0)marker(c);inspect(c,null);}finally{c.database.close();c.database=null;}
}
c.database=new DatabaseSync(`${c.service.anchor}/.writer.sqlite`);
c.database.exec("PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
if(c.database.prepare("SELECT name FROM sqlite_schema LIMIT 1").all().length===0)c.database.exec(OWNER_SQL+"; INSERT INTO clank_provider_service_owner VALUES(1)");
marker(c);if(!c.marked){if(createRoot)fs.fchmodSync(c.root.fd,0o700);fs.fchmodSync(c.service.fd,0o700);}c.root.normalize=false;c.service.normalize=false;for(const p of c.pins)assertPin(c,p);
c.database.exec("COMMIT; BEGIN IMMEDIATE");sync(c,c.file,c.service);
const owner =Object.freeze({fs:promises,path,root:c.root.path,serviceDirectory:service,close(){if(c.closed)return;c.closed=true;try{c.database.close();}finally{releasePins(c,0);}}});owners.set(owner,c);return owner;
}catch(error){try{c.database?.close();}finally{releasePins(c,0);}if(typeof(error)?.errcode==="number"&&((error).errcode&255)===5)throw new Error("Provider service root already has an active writer.");throw error;}
}
function identity(input){
if(!exact(input,["handoffId","source","targetNodeId","targetGeneration","artifactSha256"])||!match(input.handoffId,ID)||!exact(input.source,["projectId","nodeId","releaseId","generation"])||![input.source.projectId,input.source.nodeId,input.source.releaseId,input.targetNodeId].every(value=>match(value,ID))||!positive(input.source.generation)||!positive(input.targetGeneration)||input.targetGeneration<=input.source.generation||input.targetNodeId===input.source.nodeId||!match(input.artifactSha256,DIGEST))fail("Provider handoff identity is invalid.");
return{handoffId:input.handoffId,source:{projectId:input.source.projectId,nodeId:input.source.nodeId,releaseId:input.source.releaseId,generation:input.source.generation},targetNodeId:input.targetNodeId,targetGeneration:input.targetGeneration,artifactSha256:input.artifactSha256};
}
function catalog(c,db,root,project){
strictSchema(c,db,[CATALOG_SQL,BARRIER_SQL]);const row=singleton(db,"clank_provider_handoff_catalog");
if(row.id!==1||row.protocol!==1||row.index_id!==root.index_id||row.catalog_id!==project.catalog_id||row.project_id!==project.project_id||row.domain_sha256!==root.domain_sha256)fail();
const rows=db.prepare("SELECT * FROM clank_provider_handoff_barrier LIMIT 2").all();if(rows.length===0){if(row.barrier_sha256!==null)fail();return{metadata:row,barrier:null};}if(rows.length!==1)fail();const b=rows[0];let id;try{id=identity(JSON.parse(b.identity_json));}catch{fail();}
if(b.id!==1||b.protocol!==1||b.version!==1||!match(b.step_id,ID)||!match(b.source_capsule_sha256,DIGEST)||!match(b.source_incarnation,UUID)||!match(b.input_sha256,DIGEST)||b.handoff_id!==id.handoffId||id.source.projectId!==project.project_id||id.source.nodeId!==root.domain.nodeId||boundedJSON(id,2048)!==b.identity_json||row.barrier_sha256!==b.input_sha256)fail();
const envelope=barrierEnvelope(root,project,{identity:id,stepId:b.step_id,sourceCapsuleSha256:b.source_capsule_sha256,sourceIncarnation:b.source_incarnation});if(c.hash(boundedJSON(envelope,8192))!==b.input_sha256)fail();return{metadata:row,barrier:b};
}
function index(c,db,root){
strictSchema(c,db,[INDEX_SQL,PROJECTS_SQL]);const row=singleton(db,"clank_provider_handoff_index");if(row.id!==1||row.protocol!==1||row.index_id!==root.index_id||row.domain_sha256!==root.domain_sha256)fail();
const rows=db.prepare("SELECT * FROM clank_provider_handoff_projects ORDER BY project_id LIMIT 101").all();if(rows.length>100)fail("Provider handoff project capacity exceeded.");const ids=new Set();for(const project of rows){if(!match(project.project_id,ID)||!match(project.catalog_id,UUID)||ids.has(project.catalog_id)||project.installation!=="ready")fail("Provider handoff catalog installation is incomplete.");ids.add(project.catalog_id);}return rows;
}
function inspect(c,root){
const target=c.path.join(c.service.path,"handoff");if(!root){if(!absent(c,target))fail("Provider handoff namespace exists without its owner marker.");return{barriers:0,projects:[]};}
const from=c.pins.length;try{const handoff=directory(c,c.service,"handoff"),names=entries(c,handoff,4);if(names.some(name=>!["index.sqlite","index.sqlite-journal","catalogs"].includes(name))||!names.includes("catalogs")||!names.includes("index.sqlite"))fail();const catalogs=directory(c,handoff,"catalogs");
const projects=databaseAt(c,handoff,"index.sqlite",INDEX_MAX,false,db=>index(c,db,root));const actual=entries(c,catalogs,101);if(JSON.stringify(actual)!==JSON.stringify(projects.map(row=>row.catalog_id).sort()))fail();let barriers=0;
for(const project of projects){const before=c.pins.length;try{const dir=directory(c,catalogs,project.catalog_id);if(entries(c,dir,3).some(name=>!["catalog.sqlite","catalog.sqlite-journal"].includes(name)))fail();const result=databaseAt(c,dir,"catalog.sqlite",CATALOG_MAX,false,db=>catalog(c,db,root,project));if(result.barrier)barriers++;}finally{releasePins(c,before);}}
return{barriers,projects};
}finally{releasePins(c,from);}
}
async function probe(owner,client,nodeId,ownerLabel){
current(owner,true);if(!match(nodeId,ID)||!match(ownerLabel,OWNER))fail("Provider handoff domain identity is invalid.");
const result=await runProviderDockerClient(client,["info","--format","{{json .ID}}"],{timeoutMs:15000,maxOutputBytes:4096});current(owner,true);
const output=result.stdout.endsWith("\n")?result.stdout.slice(0,-1):result.stdout;let daemonId;try{daemonId=JSON.parse(output);}catch{fail("Native Docker daemon identity is unavailable.");}
if(typeof daemonId!=="string"||JSON.stringify(daemonId)!==output||!match(daemonId,DAEMON))fail("Native Docker daemon identity is unavailable.");return domainValue({protocol:"clank-provider-handoff-domain/1",nodeId,daemonId,owner:ownerLabel});
}
export async function createProviderHandoffDomain(owner,client,nodeId,ownerLabel){
const value=await probe(owner,client,nodeId,ownerLabel);current(owner,true);domains.set(value,{owner,client});return value;
}
async function verifyDomain(owner,value){const registered=domains.get(value);if(!registered||registered.owner!==owner)fail("A genuine owner-bound Docker domain is required.");const observed=await probe(owner,registered.client,value.nodeId,value.owner);if(boundedJSON(observed,4096)!==boundedJSON(value,4096))fail("Provider handoff Docker execution domain changed.");}
async function exclusive(owner,task){const c=current(owner,true);if(c.queued>=16)fail("Provider handoff private operation capacity exceeded.");c.queued++;const previous=c.tail;let release;c.tail=new Promise(resolve=>{release=resolve;});try{await previous;current(owner,true);const result=await task();current(owner);const retained=marker(c),state=inspect(c,retained);if(c.admitted&&state.barriers)fail("Provider handoff barrier refuses ordinary root startup.");current(owner);return result;}catch(error){c.failed=true;throw error;}finally{c.queued--;release();}}
/** Ordinary startup has no install path. Structural adapters cannot prove a retained domain. */
export async function admitProviderService(owner,client,ownerLabel){
return exclusive(owner,async()=>{const c=current(owner,true),root=marker(c);inspect(c,root);if(root){if(!client||typeof ownerLabel!=="string"||ownerLabel!==root.domain.owner)fail("Provider handoff requires the original native Docker domain.");const observed=await probe(owner,client,root.domain.nodeId,ownerLabel);if(boundedJSON(observed,4096)!==root.domain_json)fail("Provider handoff Docker execution domain changed.");current(owner,true);const fresh=marker(c);if(!fresh||fresh.domain_sha256!==root.domain_sha256||fresh.index_id!==root.index_id||inspect(c,fresh).barriers!==0)fail("Provider handoff barrier refuses ordinary root startup.");}current(owner,true);c.admitted=true;});
}
export async function initializeProviderHandoff(owner,domain){
return exclusive(owner,async()=>{await verifyDomain(owner,domain);const c=current(owner,true);let root=marker(c);if(root){if(root.domain_json!==boundedJSON(domain,4096))fail("Provider handoff domain cannot be rebound.");inspect(c,root);}else{
inspect(c,null);strictSchema(c,c.database,[OWNER_SQL]);const id=c.randomUUID(),json=boundedJSON(domain,4096),hash=c.hash(json);c.database.exec(MARKER_SQL);const result=c.database.prepare("INSERT INTO clank_provider_handoff_owner VALUES(1,1,?,?,?)").run(id,json,hash);if(result.changes!==1)fail();root=marker(c);if(root?.index_id!==id||root.domain_json!==json)fail();current(owner,true);c.database.exec("COMMIT; BEGIN IMMEDIATE");sync(c,c.file,c.service);
const from=c.pins.length;try{const handoff=directory(c,c.service,"handoff",true),catalogs=directory(c,handoff,"catalogs",true);createDatabase(c,handoff,"index.sqlite",INDEX_MAX,[INDEX_SQL,PROJECTS_SQL],db=>{const result=db.prepare("INSERT INTO clank_provider_handoff_index VALUES(1,1,?,?)").run(id,hash);if(result.changes!==1)fail();});c.fs.fsyncSync(catalogs.fd);c.fs.fsyncSync(handoff.fd);c.fs.fsyncSync(c.service.fd);}finally{releasePins(c,from);}inspect(c,root);
}
await verifyDomain(owner,domain);current(owner,true);return Object.freeze({indexId:root .index_id,domainSha256:root .domain_sha256});});
}
function barrierEnvelope(root,project,input){return{protocol:"clank-provider-handoff-barrier/1",indexId:root.index_id,catalogId:project.catalog_id,projectId:project.project_id,domainSha256:root.domain_sha256,identity:identity(input.identity),stepId:input.stepId,sourceCapsuleSha256:input.sourceCapsuleSha256,sourceIncarnation:input.sourceIncarnation};}
export async function installProviderHandoffProject(owner,domain,projectId){
if(!match(projectId,ID))fail("Provider handoff project identity is invalid.");return exclusive(owner,async()=>{await verifyDomain(owner,domain);const c=current(owner,true),root=marker(c);if(!root||root.domain_json!==boundedJSON(domain,4096))fail();const state=inspect(c,root),existing=state.projects.find(row=>row.project_id===projectId);if(existing)return Object.freeze({projectId,catalogId:existing.catalog_id});if(state.projects.length===100)fail("Provider handoff project capacity exceeded.");
const from=c.pins.length,id=c.randomUUID();try{const handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs");databaseAt(c,handoff,"index.sqlite",INDEX_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{index(c,db,root);if(db.prepare("INSERT INTO clank_provider_handoff_projects VALUES(?,?,'reserved')").run(projectId,id).changes!==1)fail();const row=db.prepare("SELECT * FROM clank_provider_handoff_projects WHERE project_id=?").get(projectId);if(row?.catalog_id!==id||row.installation!=="reserved")fail();current(owner,true);db.exec("COMMIT");sync(c,file,handoff);}catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
const target=directory(c,catalogs,id,true);createDatabase(c,target,"catalog.sqlite",CATALOG_MAX,[CATALOG_SQL,BARRIER_SQL],db=>{if(db.prepare("INSERT INTO clank_provider_handoff_catalog VALUES(1,1,?,?,?,?,NULL)").run(root.index_id,id,projectId,root.domain_sha256).changes!==1)fail();catalog(c,db,root,{project_id:projectId,catalog_id:id});});c.fs.fsyncSync(catalogs.fd);
databaseAt(c,handoff,"index.sqlite",INDEX_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{strictSchema(c,db,[INDEX_SQL,PROJECTS_SQL]);if(db.prepare("UPDATE clank_provider_handoff_projects SET installation='ready' WHERE project_id=? AND catalog_id=? AND installation='reserved'").run(projectId,id).changes!==1)fail();index(c,db,root);current(owner,true);db.exec("COMMIT");sync(c,file,handoff);}catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});
}finally{releasePins(c,from);}inspect(c,root);await verifyDomain(owner,domain);current(owner,true);return Object.freeze({projectId,catalogId:id});});
}
export async function insertProviderHandoffBarrier(owner,domain,projectId,input){
if(!match(projectId,ID)||!exact(input,["identity","stepId","sourceCapsuleSha256","sourceIncarnation"])||!match(input.stepId,ID)||!match(input.sourceCapsuleSha256,DIGEST)||!match(input.sourceIncarnation,UUID))fail("Provider handoff barrier is invalid.");
const captured=JSON.parse(boundedJSON(input,8192));identity(captured.identity);
return exclusive(owner,async()=>{await verifyDomain(owner,domain);const c=current(owner,true),root=marker(c);if(!root||root.domain_json!==boundedJSON(domain,4096))fail();const project=inspect(c,root).projects.find(row=>row.project_id===projectId);if(!project)fail();const envelope=barrierEnvelope(root,project,captured),hash=c.hash(boundedJSON(envelope,8192));if(envelope.identity.source.projectId!==projectId||envelope.identity.source.nodeId!==domain.nodeId)fail();
const from=c.pins.length;try{const handoff=directory(c,c.service,"handoff"),catalogs=directory(c,handoff,"catalogs"),target=directory(c,catalogs,project.catalog_id);databaseAt(c,target,"catalog.sqlite",CATALOG_MAX,true,(db,file)=>{db.exec("BEGIN IMMEDIATE");try{const before=catalog(c,db,root,project);if(before.barrier){if(before.barrier.input_sha256!==hash)fail("Provider handoff barrier input conflicts.");}else{if(db.prepare("INSERT INTO clank_provider_handoff_barrier VALUES(1,1,?,?,?,?,?,?,1)").run(captured.identity.handoffId,captured.stepId,boundedJSON(identity(captured.identity),2048),captured.sourceCapsuleSha256,captured.sourceIncarnation,hash).changes!==1||db.prepare("UPDATE clank_provider_handoff_catalog SET barrier_sha256=? WHERE id=1 AND barrier_sha256 IS NULL").run(hash).changes!==1)fail();if(catalog(c,db,root,project).barrier?.input_sha256!==hash)fail();}current(owner,true);db.exec("COMMIT");sync(c,file,target);}catch(error){if(db.isTransaction)db.exec("ROLLBACK");throw error;}});}finally{releasePins(c,from);}await verifyDomain(owner,domain);current(owner,true);return Object.freeze({inputSha256:hash});});
}
