import type { SQLiteInternal } from "./sqlite-internal.ts";

export interface PlatformSupervisorOptions {
  /** Same-host coordinators must use the same operator-selected configuration identity. */
  readonly configurationId: string;
  /** Increase when changing configuration identity or timing bounds. */
  readonly configurationRevision: number;
  /** Defaults to 15 seconds; bounded from 5 seconds to 2 minutes. */
  readonly leaseMs?: number;
  /** Defaults to 500ms; must not exceed one third of the lease. */
  readonly pollIntervalMs?: number;
}
export interface PlatformSupervisorStatus {
  readonly state: "standby" | "starting" | "leader" | "closing" | "closed" | "fenced";
  readonly epoch: number;
  readonly expiresAt: number;
  readonly responsibilities: readonly string[];
}
const responsibilities=Object.freeze(["startup-recovery","tenant-runtimes","domain-reconciliation","preview-cleanup",
  "idle-sweep","release-windows","scheduled-backups","invitation-delivery","audit-export","retention","operations-monitor"]);
type Connection=Pick<SQLiteInternal,"prepare">;
type NativeDatabase=Connection&{exec(sql:string):void;close():void};
export class PlatformSupervisorError extends Error {
  readonly name="PlatformSupervisorError";
  declare readonly code:string;
  constructor(code:string,message:string){super(message);this.code=code;}
}
function fail(code:string,message:string):never {throw new PlatformSupervisorError(code,message);}
function integer(value:unknown,label:string,min:number,max:number):number {
  if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw new TypeError(`Invalid supervisor ${label}.`);
  return Number(value);
}
export function normalizeSupervisorOptions(input:PlatformSupervisorOptions):Required<PlatformSupervisorOptions> {
  if(!input||typeof input.configurationId!=="string"||! /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(input.configurationId))throw new TypeError("Invalid supervisor configuration identity.");
  const leaseMs=integer(input.leaseMs??15000,"leaseMs",5000,120000);
  return Object.freeze({configurationId:input.configurationId,configurationRevision:integer(input.configurationRevision,"configurationRevision",1,Number.MAX_SAFE_INTEGER),
    leaseMs,pollIntervalMs:integer(input.pollIntervalMs??500,"pollIntervalMs",50,Math.floor(leaseMs/3))});
}
/** @internal Native server-held authority; a serialized status never becomes this capability. */
export interface SupervisorLease {
  readonly options:Required<PlatformSupervisorOptions>;
  readonly databasePath:string;
  readonly owner:string;
  readonly processBirth:string;
  acquire():boolean;
  renew():void;
  assertCurrent(connection?:Connection):undefined;
  status(state:PlatformSupervisorStatus["state"]):PlatformSupervisorStatus;
  release():boolean;
  close():void;
  /** Private guardian specification; never returned by platform status. */
  guardianIdentity():Readonly<{epoch:number;owner:string;tokenHash:string;configurationRevision:number;configurationId:string;controllerPid:number;controllerBirth:string}>;
}

/** @internal One local kernel/process identity; PID reuse cannot authorize cleanup. */
export async function linuxProcessBirth(pid:number):Promise<string> {
  const name="node:fs/promises",fs=await import(name),data=await fs.readFile(`/proc/${integer(pid,"process PID",1,2147483647)}/stat`,"utf8");
  const birth=data.slice(data.lastIndexOf(")")+2).split(" ")[19];
  if(!/^[0-9]{1,30}$/u.test(birth??""))fail("SUPERVISOR_PROCESS_IDENTITY","Cannot establish the actual Linux process birth identity.");
  return birth;
}

/** @internal Lease store is used before opening any active platform service. */
export async function openSupervisorLease(databasePath:string,input:PlatformSupervisorOptions):Promise<SupervisorLease> {
  const options=normalizeSupervisorOptions(input),proc=(globalThis as any).process;
  if(proc?.platform!=="linux")throw new TypeError("Automatic supervisor leadership requires the supported same-host Linux topology.");
  const processBirth=await linuxProcessBirth(proc.pid),sqliteName="node:sqlite",cryptoName="node:crypto",fsName="node:fs/promises",pathName="node:path";
  const [sqlite,nodeCrypto,fs,path]=await Promise.all([import(sqliteName),import(cryptoName),import(fsName),import(pathName)]);
  const catalog=path.resolve(databasePath);
  try{const file=await fs.open(catalog,"wx",0o600);await file.close();}catch(error){if((error as {code?:string}).code!=="EEXIST")throw error;}
  const stat=await fs.lstat(catalog);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||await fs.realpath(catalog)!==catalog||stat.uid!==proc.getuid())throw new TypeError("Supervisor leadership requires an exact private native SQLite catalog on this host.");
  const native=new sqlite.DatabaseSync(catalog) as NativeDatabase;
  try {
    await fs.chmod(catalog,0o600);
    native.exec("PRAGMA busy_timeout=250;PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL");
    const transaction=<Value>(handler:()=>Value):Value=>{
      native.exec("BEGIN IMMEDIATE");try{const value=handler();native.exec("COMMIT");return value;}catch(error){try{native.exec("ROLLBACK");}catch{}throw error;}
    };
    let closed=false,epoch=0,tokenHash:string|undefined,lastNow=Date.now();
    const owner=`supervisor-${proc.pid}-${nodeCrypto.randomUUID()}`;
    const now=()=>{const value=integer(Date.now(),"clock",0,Number.MAX_SAFE_INTEGER-options.leaseMs);if(value<lastNow)fail("SUPERVISOR_CLOCK_REGRESSION","Supervisor clock moved backwards; leadership is fenced.");lastNow=value;return value;};
    const ensureOpen=()=>{if(closed)fail("SUPERVISOR_CLOSED","Supervisor leadership is closed.");};
    const assertConfiguration=(connection:Connection=native)=>{
      const row=connection.prepare("SELECT * FROM clank_platform_supervisor_state WHERE singleton=1").get();
      if(row?.protocol!==1)fail("SUPERVISOR_PROTOCOL","Unsupported supervisor protocol.");
      if(row.configuration_id!==options.configurationId||row.configuration_revision!==options.configurationRevision
        ||row.lease_ms!==options.leaseMs||row.poll_ms!==options.pollIntervalMs)fail("SUPERVISOR_CONFIGURATION_CHANGED","Current supervisor configuration is required.");
    };
    const configured=Boolean(native.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_platform_supervisor_state'").get()),retained=Boolean(native.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_platform_supervisor_lease'").get());
    if(configured!==retained)fail("SUPERVISOR_STATE_INVALID","Incomplete persisted supervisor ownership; preserve it for operator recovery.");
    if(configured
      &&native.prepare("SELECT protocol FROM clank_platform_supervisor_state WHERE singleton=1").get()?.protocol!==1)fail("SUPERVISOR_PROTOCOL","Unsupported supervisor protocol.");
    transaction(()=>{
      native.exec(`CREATE TABLE IF NOT EXISTS clank_platform_supervisor_state(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL,configuration_id TEXT NOT NULL,
        configuration_revision INTEGER NOT NULL,lease_ms INTEGER NOT NULL,poll_ms INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS clank_platform_supervisor_lease(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 9007199254740991),
        owner TEXT,token_hash TEXT,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,controller_pid INTEGER,controller_birth TEXT) STRICT;`);
      const prior=native.prepare("SELECT * FROM clank_platform_supervisor_state WHERE singleton=1").get();
      if(prior&&!native.prepare("SELECT 1 FROM clank_platform_supervisor_lease WHERE singleton=1").get())fail("SUPERVISOR_STATE_INVALID","Missing retained supervisor ownership; its epoch cannot be reset.");
      if(prior&&(prior.protocol!==1||typeof prior.configuration_id!=="string"||! /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(prior.configuration_id)
        ||!Number.isSafeInteger(prior.configuration_revision)||Number(prior.configuration_revision)<1
        ||!Number.isSafeInteger(prior.lease_ms)||Number(prior.lease_ms)<5000||Number(prior.lease_ms)>120000
        ||!Number.isSafeInteger(prior.poll_ms)||Number(prior.poll_ms)<50||Number(prior.poll_ms)>Math.floor(Number(prior.lease_ms)/3))) {
        fail("SUPERVISOR_STATE_INVALID","Invalid persisted supervisor configuration.");
      }
      if(prior)readLease();
      if(prior&&(Number(prior.configuration_revision)>options.configurationRevision
        ||prior.configuration_revision===options.configurationRevision&&(prior.configuration_id!==options.configurationId||prior.lease_ms!==options.leaseMs||prior.poll_ms!==options.pollIntervalMs))) {
        fail("SUPERVISOR_CONFIGURATION_CHANGED","Increase the supervisor configuration revision for changed configuration.");
      }
      native.prepare("INSERT INTO clank_platform_supervisor_state VALUES(1,1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET configuration_id=excluded.configuration_id,configuration_revision=excluded.configuration_revision,lease_ms=excluded.lease_ms,poll_ms=excluded.poll_ms")
        .run(options.configurationId,options.configurationRevision,options.leaseMs,options.pollIntervalMs);
      native.prepare("INSERT INTO clank_platform_supervisor_lease VALUES(1,0,NULL,NULL,0,?,NULL,NULL) ON CONFLICT(singleton) DO NOTHING").run(now());
      if(prior&&prior.configuration_revision!==options.configurationRevision)native.prepare("UPDATE clank_platform_supervisor_lease SET expires_at=0 WHERE singleton=1").run();
    });
    function readLease(connection:Connection=native){
      const row=connection.prepare("SELECT * FROM clank_platform_supervisor_lease WHERE singleton=1").get();
      if(!row||!Number.isSafeInteger(row.epoch)||Number(row.epoch)<0||!Number.isSafeInteger(row.expires_at)||Number(row.expires_at)<0
        ||!Number.isSafeInteger(row.updated_at)||Number(row.updated_at)<0
        ||row.owner!==null&&(typeof row.owner!=="string"||!/^supervisor-[0-9]+-[a-f0-9-]{36}$/u.test(row.owner))
        ||row.token_hash!==null&&(typeof row.token_hash!=="string"||! /^[a-f0-9]{64}$/u.test(row.token_hash))
        ||row.controller_pid!==null&&(!Number.isSafeInteger(row.controller_pid)||Number(row.controller_pid)<1)
        ||row.controller_birth!==null&&(typeof row.controller_birth!=="string"||! /^[0-9]{1,30}$/u.test(row.controller_birth))
        ||(row.owner===null)!==(row.token_hash===null)||(row.owner===null)!==(row.controller_pid===null)||(row.owner===null)!==(row.controller_birth===null)) {
        fail("SUPERVISOR_STATE_INVALID","Invalid persisted supervisor ownership.");
      }
      return row;
    }
    const assertCurrent=(connection:Connection=native):undefined=>{
      ensureOpen();assertConfiguration(connection);const at=now(),row=readLease(connection);
      if(!tokenHash||row.epoch!==epoch||row.owner!==owner||row.token_hash!==tokenHash||row.controller_pid!==proc.pid
        ||row.controller_birth!==processBirth||Number(row.expires_at)<=at||Number(row.updated_at)>at)fail("SUPERVISOR_LEASE_LOST","Supervisor ownership or availability changed.");
      return undefined;
    };
    return Object.freeze<SupervisorLease>({options,databasePath:catalog,owner,processBirth,
      acquire(){ensureOpen();try{return transaction(()=>{
        assertConfiguration();const at=now(),row=readLease();
        if(tokenHash){assertCurrent();return true;}
        if(Number(row.updated_at)>at)fail("SUPERVISOR_CLOCK_REGRESSION","Persisted supervisor clock is in the future.");
        if(Number(row.expires_at)>at)return false;
        if(row.epoch===Number.MAX_SAFE_INTEGER)fail("SUPERVISOR_EPOCH_EXHAUSTED","Supervisor epoch capacity is exhausted; ownership was retained.");
        const candidateHash=nodeCrypto.createHash("sha256").update(nodeCrypto.randomBytes(32)).digest("hex"),candidateEpoch=Number(row.epoch)+1;
        native.prepare("UPDATE clank_platform_supervisor_lease SET epoch=?,owner=?,token_hash=?,expires_at=?,updated_at=?,controller_pid=?,controller_birth=? WHERE singleton=1")
          .run(candidateEpoch,owner,candidateHash,at+options.leaseMs,at,proc.pid,processBirth);
        epoch=candidateEpoch;tokenHash=candidateHash;return true;
      });}catch(error){
        // A standby owns no duties while another native writer holds the catalog.
        // Its next poll can retry; an existing owner must still fence on failure.
        if(!tokenHash&&(error as {code?:string}).code==="ERR_SQLITE_ERROR"&&(error as {errcode?:number}).errcode===5)return false;
        throw error;
      }},
      renew(){ensureOpen();transaction(()=>{assertCurrent();const at=now();native.prepare("UPDATE clank_platform_supervisor_lease SET expires_at=?,updated_at=? WHERE singleton=1 AND epoch=? AND owner=? AND token_hash=?")
        .run(at+options.leaseMs,at,epoch,owner,tokenHash);});},
      assertCurrent,
      status(state){ensureOpen();assertConfiguration();const row=readLease();return Object.freeze({state,epoch:Number(row.epoch),expiresAt:Number(row.expires_at),responsibilities});},
      release(){ensureOpen();return transaction(()=>{assertConfiguration();const row=readLease();if(!tokenHash||row.epoch!==epoch||row.owner!==owner||row.token_hash!==tokenHash)return false;
        native.prepare("UPDATE clank_platform_supervisor_lease SET owner=NULL,token_hash=NULL,expires_at=0,updated_at=?,controller_pid=NULL,controller_birth=NULL WHERE singleton=1").run(now());tokenHash=undefined;return true;
      });},
      guardianIdentity(){assertCurrent();return Object.freeze({epoch,owner,tokenHash:tokenHash!,configurationRevision:options.configurationRevision,configurationId:options.configurationId,controllerPid:proc.pid,controllerBirth:processBirth});},
      close(){if(closed)return;closed=true;native.close();},
    });
  }catch(error){native.close();throw error;}
}

/** @internal Removes only proved-dead coordinator fences; tenant cleanup remains independently required. */
export async function waitForSupervisorCleanup(root:string,lease:SupervisorLease):Promise<void> {
  const fsName="node:fs/promises",pathName="node:path",[fs,path]=await Promise.all([import(fsName),import(pathName)]);
  const directory=path.join(root,"supervisor-guardians"),deadline=Date.now()+8000;
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const status=await fs.lstat(directory);
  if(!status.isDirectory()||status.isSymbolicLink()||await fs.realpath(directory)!==directory)fail("SUPERVISOR_CLEANUP_REQUIRED","Supervisor guardian directory must be private and canonical.");
  await fs.chmod(directory,0o700);
  while(true){
    lease.assertCurrent();const names=await fs.readdir(directory);
    if(names.length>64)fail("SUPERVISOR_CLEANUP_REQUIRED","Supervisor guardian fence capacity is exhausted.");
    let waiting=false;
    for(const name of names){
      if(!/^supervisor-[a-f0-9-]{36}\.json(?:\.tmp)?$/u.test(name))fail("SUPERVISOR_CLEANUP_REQUIRED","Unexpected supervisor guardian fence; preserve it for operator recovery.");
      if(name.endsWith(".tmp"))fail("SUPERVISOR_CLEANUP_REQUIRED","Interrupted guardian record publication requires operator recovery.");
      const file=path.join(directory,name);let record:any;
      try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>4096)throw new Error("Invalid fence");record=JSON.parse(await fs.readFile(file,"utf8"));}
      catch(error){if((error as {code?:string}).code==="ENOENT")continue;fail("SUPERVISOR_CLEANUP_REQUIRED","Invalid supervisor guardian fence; preserve it for operator recovery.");}
      if(record.protocol!==1||!Number.isSafeInteger(record.controllerPid)||record.controllerPid<1||typeof record.controllerBirth!=="string"||! /^[0-9]{1,30}$/u.test(record.controllerBirth)
        ||!Number.isSafeInteger(record.epoch)||record.epoch<1||!['preparing','armed','failed'].includes(record.phase))fail("SUPERVISOR_CLEANUP_REQUIRED","Unsupported supervisor guardian record.");
      if(record.phase==='failed')fail("SUPERVISOR_CLEANUP_REQUIRED","Previous supervisor cleanup is unresolved; preserve its fence.");
      let alive=false;
      try{alive=await linuxProcessBirth(record.controllerPid)===record.controllerBirth;}catch(error){if(!['ENOENT','ESRCH'].includes((error as {code?:string}).code??''))throw error;}
      if(alive){waiting=true;continue;}
      // This is a coordinator-only fence. Its tenant guardian files are checked
      // by platform startup before any replacement application can be launched.
      await fs.unlink(file).catch((error:any)=>{if(error.code!=="ENOENT")throw error;});
      const folder=await fs.open(directory,"r");try{await folder.sync();}finally{await folder.close();}
    }
    if(!waiting)return;
    if(Date.now()>=deadline)fail("SUPERVISOR_CLEANUP_REQUIRED","A previous coordinator has not proved process cleanup.");
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}

/** @internal Must be armed in a dedicated coordinator process, after acquiring a lease. */
export async function armSupervisorGuardian(root:string,lease:SupervisorLease):Promise<{stop():Promise<void>}> {
  const fsName="node:fs/promises",pathName="node:path",childName="node:child_process",[fs,path,childProcess]=await Promise.all([import(fsName),import(pathName),import(childName)]);
  const proc=(globalThis as any).process,identity=lease.guardianIdentity();
  if(identity.controllerPid!==proc.pid||identity.controllerBirth!==await linuxProcessBirth(proc.pid))fail("SUPERVISOR_PROCESS_IDENTITY","A guardian can only own its actual coordinator process.");
  const directory=path.join(root,"supervisor-guardians");await fs.mkdir(directory,{recursive:true,mode:0o700});
  const stat=await fs.lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(directory)!==directory||(await fs.readdir(directory)).length>=64)fail("SUPERVISOR_CLEANUP_REQUIRED","Supervisor guardian directory is unavailable or full.");
  await fs.chmod(directory,0o700);lease.assertCurrent();
  const nonce=crypto.randomUUID(),fence=path.join(directory,`supervisor-${nonce}.json`),record={protocol:1,controllerPid:proc.pid,controllerBirth:identity.controllerBirth,epoch:identity.epoch,phase:"preparing"};
  const file=await fs.open(fence,"wx",0o600);
  try {
  try{await file.writeFile(JSON.stringify(record));await file.sync();}finally{await file.close();}
  const folder=await fs.open(directory,"r");try{await folder.sync();}finally{await folder.close();}
  lease.assertCurrent();
  const specification={...identity,databasePath:lease.databasePath,fence,leaseMs:lease.options.leaseMs,pollMs:lease.options.pollIntervalMs};
  const child=childProcess.spawn(proc.execPath,["--disable-warning=ExperimentalWarning","--input-type=module","--eval",SUPERVISOR_GUARDIAN],{
    env:{...proc.env,CLANK_SUPERVISOR_GUARDIAN:btoa(unescape(encodeURIComponent(JSON.stringify(specification))))},stdio:["ignore","ignore","pipe","ipc"],
  });
  let finishing=false,stopped=false;
  const terminate=()=>{if(!finishing)proc.kill(proc.pid,"SIGKILL");};
  child.once("error",terminate);child.once("exit",terminate);
  let diagnostic="";child.stderr.on("data",(chunk:unknown)=>{diagnostic=(diagnostic+String(chunk)).slice(-4096);});
  const ready=await new Promise<boolean>(resolve=>{
    let settled=false;const finish=(value:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>finish(false),8000);child.once("message",(message:any)=>finish(message?.kind==="supervisor-guardian-ready"));child.once("error",()=>finish(false));child.once("exit",()=>finish(false));
  });
  if(!ready){terminate();fail("SUPERVISOR_GUARDIAN_FAILED",diagnostic||"Supervisor guardian did not become ready.");}
  lease.assertCurrent();
  return Object.freeze({async stop(){
    if(stopped)return;lease.assertCurrent();finishing=true;
    const exited=new Promise<number|null>(resolve=>child.once("exit",(code:number|null)=>resolve(code)));
    child.send({kind:"supervisor-guardian-finish"});
    let timer:ReturnType<typeof setTimeout>;
    const code=await Promise.race([exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new PlatformSupervisorError("SUPERVISOR_CLEANUP_REQUIRED","Supervisor guardian cleanup timed out.")),8000);})]).finally(()=>clearTimeout(timer));
    if(code!==0)fail("SUPERVISOR_CLEANUP_REQUIRED","Supervisor guardian did not prove graceful cleanup.");stopped=true;
  }});
  }catch(error){
    // A published preparing fence must not keep a live, unguarded coordinator
    // blocking all future admission when arming fails or authority expires.
    proc.kill(proc.pid,"SIGKILL");throw error;
  }
}

const SUPERVISOR_GUARDIAN=`
const {DatabaseSync}=await import('node:sqlite');
const {readFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync,fsyncSync}=await import('node:fs');
const {dirname}=await import('node:path');
const spec=JSON.parse(Buffer.from(process.env.CLANK_SUPERVISOR_GUARDIAN,'base64').toString('utf8'));delete process.env.CLANK_SUPERVISOR_GUARDIAN;
const record=JSON.parse(readFileSync(spec.fence,'utf8'));
if(process.ppid!==spec.controllerPid||record.controllerPid!==spec.controllerPid||record.controllerBirth!==spec.controllerBirth||record.epoch!==spec.epoch)throw new Error('Guardian process identity mismatch');
const native=new DatabaseSync(spec.databasePath,{readOnly:true});native.exec('PRAGMA busy_timeout=250;PRAGMA trusted_schema=OFF');
let stopping=false,lastNow=Date.now();
const birth=()=>{try{const data=readFileSync('/proc/'+spec.controllerPid+'/stat','utf8'),fields=data.slice(data.lastIndexOf(')')+2).split(' ');return fields[0]==='Z'||fields[0]==='X'?null:fields[19];}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;}};
const save=phase=>{const temporary=spec.fence+'.tmp';writeFileSync(temporary,JSON.stringify({...record,phase,guardianPid:process.pid}),{mode:0o600});const fd=openSync(temporary,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,spec.fence);const folder=openSync(dirname(spec.fence),'r');try{fsyncSync(folder);}finally{closeSync(folder);}};
const clear=()=>{try{unlinkSync(spec.fence);}catch(error){if(error.code!=='ENOENT')throw error;}const folder=openSync(dirname(spec.fence),'r');try{fsyncSync(folder);}finally{closeSync(folder);}};
// Renewals can commit while the guardian waits for its native read. Evaluate
// that observed row against the clock after reading, retaining strict expiry.
const current=()=>{const state=native.prepare('SELECT * FROM clank_platform_supervisor_state WHERE singleton=1').get(),lease=native.prepare('SELECT * FROM clank_platform_supervisor_lease WHERE singleton=1').get(),now=Date.now();if(now<lastNow)throw new Error('Clock regression');lastNow=now;return state?.protocol===1&&state.configuration_id===spec.configurationId&&state.configuration_revision===spec.configurationRevision&&state.lease_ms===spec.leaseMs&&state.poll_ms===spec.pollMs&&lease?.epoch===spec.epoch&&lease.owner===spec.owner&&lease.token_hash===spec.tokenHash&&lease.controller_pid===spec.controllerPid&&lease.controller_birth===spec.controllerBirth&&lease.expires_at>now&&lease.updated_at<=now;};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fence=async()=>{if(stopping)return;stopping=true;clearInterval(timer);try{if(birth()===spec.controllerBirth)process.kill(spec.controllerPid,'SIGKILL');const until=Date.now()+5000;while(birth()===spec.controllerBirth&&Date.now()<until)await pause(25);if(birth()===spec.controllerBirth)throw new Error('Coordinator cleanup unresolved');clear();native.close();process.exit(0);}catch{try{save('failed');}catch{}process.exit(72);}};
const check=()=>{try{if(!process.connected||!current())void fence();}catch{void fence();}};
process.once('disconnect',()=>{void fence();});process.once('SIGTERM',()=>{void fence();});process.once('SIGINT',()=>{void fence();});
const timer=setInterval(check,Math.min(spec.pollMs,250));
process.on('message',message=>{if(message?.kind!=='supervisor-guardian-finish'||stopping)return;try{if(!current())return void fence();stopping=true;clearInterval(timer);clear();native.close();process.exit(0);}catch{void fence();}});
save('armed');check();if(!stopping&&process.connected)process.send({kind:'supervisor-guardian-ready'});
`;
