import type {SQLiteInternal} from "./sqlite-internal.ts";
import type {OrganizationServiceAccount, ServiceAccountCredential, ServiceAccountIdentity, ServiceAccountPermission, AuthenticatedServiceAccount} from "./service-accounts.ts";
export type {AuthenticatedServiceAccount} from "./service-accounts.ts";

export interface PlatformServiceAccountOptions {maxAccounts?: number; maxCredentials?: number; maxReceipts?: number;}
export interface ServiceAccountAuthority {readonly userId: string; authorize(organizationId: string, write: boolean): void; audit(action: string, metadata: Record<string, unknown>): void;}
export class ServiceAccountError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) {super(message);this.status=status;this.code=code;}
}
const fail=(status:number,code:string,message:string):never=>{throw new ServiceAccountError(status,code,message);};
const integer=(value:unknown,min:number,max:number):number=>{
  if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)fail(422,"SERVICE_ACCOUNT_INPUT","Choose a supported service account number.");return Number(value);
};
const id=(value:unknown):string=>{
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]{8,128}$/u.test(value))fail(422,"SERVICE_ACCOUNT_INPUT","Choose a valid service account identifier.");return value as string;
};
const name=(value:unknown):string=>{
  if(typeof value!=="string"||!value.trim()||new TextEncoder().encode(value).byteLength>160||/[\u0000-\u001f\u007f]/u.test(value))fail(422,"SERVICE_ACCOUNT_INPUT","Choose a service account name up to 160 UTF-8 bytes.");return value as string;
};
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail(422,"SERVICE_ACCOUNT_INPUT","Choose exact service account fields.");return value as Record<string,unknown>;
};
const supported:readonly ServiceAccountPermission[]=['read','logs','deploy','rollback','jobs','secrets','audit'];
const permissions=(value:unknown):readonly ServiceAccountPermission[]=>{
  if(!Array.isArray(value)||!value.length||value.length>supported.length||!value.includes('read')||new Set(value).size!==value.length||value.some(p=>!supported.includes(p)))fail(422,"SERVICE_ACCOUNT_INPUT","Choose explicit supported permissions including read.");return [...value as ServiceAccountPermission[]].sort();
};
export function assertServiceAccountProtocol(sql:SQLiteInternal):void {
  if(sql.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='clank_platform_machine_state'").get()&&sql.prepare('SELECT protocol FROM clank_platform_machine_state WHERE singleton=1').get()?.protocol!==1)fail(409,"SERVICE_ACCOUNT_PROTOCOL_UNSUPPORTED","Unsupported service account storage protocol.");
}

/** Dedicated identities own credentials, never human passwords or sessions. */
export function openPlatformServiceAccounts(sql:SQLiteInternal,options:PlatformServiceAccountOptions,hooks:{
  hash(value:string):string; encrypt(value:string):string; decrypt(value:string):string;
  eligibleOwner(organizationId:string,ownerId:string,projectId?:string,permissions?:readonly ServiceAccountPermission[]):boolean;
  now?():number;
}) {
  assertServiceAccountProtocol(sql);
  const maxAccounts=integer(options.maxAccounts??1000,1,10000),maxCredentials=integer(options.maxCredentials??5000,1,50000),maxReceipts=integer(options.maxReceipts??10000,1,100000),now=hooks.now??Date.now;
  sql.exec(`CREATE TABLE IF NOT EXISTS clank_platform_machine_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL);
    INSERT OR IGNORE INTO clank_platform_machine_state VALUES(1,1);
    CREATE TABLE IF NOT EXISTS clank_platform_machine_accounts(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES clank_platform_organizations(id) ON DELETE CASCADE,owner_id TEXT NOT NULL,name TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),version INTEGER NOT NULL,generation INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS clank_platform_machine_accounts_org ON clank_platform_machine_accounts(organization_id,id);
    CREATE TABLE IF NOT EXISTS clank_platform_machine_credentials(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES clank_platform_machine_accounts(id) ON DELETE CASCADE,token_id TEXT UNIQUE REFERENCES clank_platform_tokens(id) ON DELETE SET NULL,token_hash TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,permissions TEXT NOT NULL CHECK(json_valid(permissions)),generation INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,last_used_at INTEGER,authenticated_requests INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS clank_platform_machine_credentials_account ON clank_platform_machine_credentials(account_id,generation);
    CREATE TABLE IF NOT EXISTS clank_platform_machine_receipts(organization_id TEXT NOT NULL REFERENCES clank_platform_organizations(id) ON DELETE CASCADE,actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(organization_id,actor_id,operation_id));`);
  let closed=false;
  const check=(authority?:ServiceAccountAuthority,organizationId?:string,write=false)=>{
    if(closed)fail(503,"SERVICE_ACCOUNT_CLOSED","Service account controller is closed.");
    assertServiceAccountProtocol(sql);if(authority)authority.authorize(organizationId!,write);
  };
  const accountFrom=(row:Record<string,unknown>):OrganizationServiceAccount=>({id:String(row.id),organizationId:String(row.organization_id),ownerId:String(row.owner_id),name:String(row.name),enabled:Number(row.enabled)===1,version:Number(row.version),credentialGeneration:Number(row.generation),createdAt:Number(row.created_at),updatedAt:Number(row.updated_at)});
  const current=(organizationId:string,accountId:string)=>{
    const row=sql.prepare('SELECT * FROM clank_platform_machine_accounts WHERE organization_id=? AND id=?').get(organizationId,accountId);
    if(!row)fail(404,"SERVICE_ACCOUNT_NOT_FOUND","Service account not found.");return accountFrom(row!);
  };
  const credentialFrom=(row:Record<string,unknown>):ServiceAccountCredential=>({id:String(row.id),serviceAccountId:String(row.account_id),projectId:String(row.project_id),permissions:permissions(JSON.parse(String(row.permissions))),generation:Number(row.generation),createdAt:Number(row.created_at),expiresAt:Number(row.expires_at),lastUsedAt:row.last_used_at===null?null:Number(row.last_used_at),authenticatedRequests:Number(row.authenticated_requests),status:Number(row.expires_at)<=now()?'expired':row.revoked_at!==null||row.token_id===null?'revoked':'active'});
  const owner=(organizationId:string,ownerId:string,projectId?:string,grant?:readonly ServiceAccountPermission[])=>{
    if(!hooks.eligibleOwner(organizationId,ownerId,projectId,grant))fail(403,"SERVICE_ACCOUNT_OWNER_INELIGIBLE","Choose a current eligible owner and project grant.");
  };
  const retry=(organizationId:string,authority:ServiceAccountAuthority,operationId:string,request:string):any=>{
    const row=sql.prepare('SELECT request,result FROM clank_platform_machine_receipts WHERE organization_id=? AND actor_id=? AND operation_id=?').get(organizationId,authority.userId,operationId);
    if(!row)return undefined;if(row.request!==request)fail(409,"SERVICE_ACCOUNT_OPERATION_CONFLICT","That operation ID already represents another change.");
    try{return JSON.parse(hooks.decrypt(String(row.result)));}catch{return fail(409,"SERVICE_ACCOUNT_RECEIPT_UNAVAILABLE","The retained acknowledgement cannot be read.");}
  };
  const capacity=()=>{if(Number(sql.prepare('SELECT count(*) AS n FROM clank_platform_machine_receipts').get()?.n)>=maxReceipts)fail(409,"SERVICE_ACCOUNT_CAPACITY","Service account receipt capacity is full.");};
  const save=(organizationId:string,authority:ServiceAccountAuthority,operationId:string,request:string,result:unknown,action:string,metadata:Record<string,unknown>)=>{
    const serialized=JSON.stringify(result);if(new TextEncoder().encode(serialized).byteLength>16384)fail(409,"SERVICE_ACCOUNT_CAPACITY","Service account acknowledgement exceeds its bounded envelope.");
    sql.prepare('INSERT INTO clank_platform_machine_receipts VALUES(?,?,?,?,?)').run(organizationId,authority.userId,operationId,request,hooks.encrypt(serialized));
    authority.audit(action,{organizationId,...metadata});return result;
  };
  const revoke=(accountId:string)=>{
    sql.prepare('UPDATE clank_platform_tokens SET revoked_at=? WHERE id IN (SELECT token_id FROM clank_platform_machine_credentials WHERE account_id=?) AND revoked_at IS NULL').run(now(),accountId);
    sql.prepare('UPDATE clank_platform_machine_credentials SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL').run(now(),accountId);
  };
  const assertCredential=(credentialId:string,hash:string):ServiceAccountIdentity=>{
    check();const row=sql.prepare(`SELECT c.*,a.organization_id,a.owner_id,a.enabled,a.generation AS current_generation,t.token_hash AS current_hash,t.user_id AS token_owner,t.project_id AS token_project,t.organization_id AS token_org,t.permissions AS token_permissions,t.expires_at AS token_expiry,t.revoked_at AS token_revoked,t.preview_name AS token_preview
      FROM clank_platform_machine_credentials c JOIN clank_platform_machine_accounts a ON a.id=c.account_id JOIN clank_platform_tokens t ON t.id=c.token_id WHERE c.id=?`).get(credentialId);
    if(!row||row.token_hash!==hash||row.current_hash!==hash||row.token_owner!==row.owner_id||row.token_org!==row.organization_id||row.token_project!==row.project_id||row.token_permissions!==row.permissions||row.token_expiry!==row.expires_at||row.token_preview!==null||row.revoked_at!==null||row.token_revoked!==null||Number(row.enabled)!==1||Number(row.generation)!==Number(row.current_generation)||Number(row.expires_at)<=now())fail(401,"SERVICE_ACCOUNT_INVALID_CREDENTIAL","Service account credential is invalid or expired.");
    const grant=permissions(JSON.parse(String(row!.permissions)));owner(String(row!.organization_id),String(row!.owner_id),String(row!.project_id),grant);
    return Object.freeze({kind:'service-account' as const,id:String(row!.account_id),organizationId:String(row!.organization_id),ownerId:String(row!.owner_id),credentialId:String(row!.id),projectId:String(row!.project_id),permissions:Object.freeze([...grant]),expiresAt:Number(row!.expires_at)});
  };
  return {
    list(organizationId:string,authority:ServiceAccountAuthority){check(authority,id(organizationId));return sql.prepare('SELECT * FROM clank_platform_machine_accounts WHERE organization_id=? ORDER BY created_at,id LIMIT 50').all(organizationId).map(accountFrom);},
    read(organizationId:string,accountId:string,authority:ServiceAccountAuthority){check(authority,id(organizationId));const account=current(organizationId,id(accountId));return {account,credentials:sql.prepare('SELECT * FROM clank_platform_machine_credentials WHERE account_id=? ORDER BY generation DESC LIMIT 50').all(accountId).map(credentialFrom)};},
    create(organizationId:string,authority:ServiceAccountAuthority,value:unknown):OrganizationServiceAccount{
      check(authority,id(organizationId),true);const input=exact(value,['name','ownerId','operationId']),label=name(input.name),ownerId=id(input.ownerId),operationId=id(input.operationId),request=JSON.stringify({kind:'create',name:label,ownerId});
      return sql.transaction(()=>{check(authority,organizationId,true);const retained=retry(organizationId,authority,operationId,request);if(retained!==undefined)return retained;capacity();owner(organizationId,ownerId);
        if(Number(sql.prepare('SELECT count(*) AS n FROM clank_platform_machine_accounts').get()?.n)>=maxAccounts||Number(sql.prepare('SELECT count(*) AS n FROM clank_platform_machine_accounts WHERE organization_id=?').get(organizationId)?.n)>=50)fail(409,"SERVICE_ACCOUNT_CAPACITY","Service account inventory is full.");
        const accountId=crypto.randomUUID(),at=now();sql.prepare('INSERT INTO clank_platform_machine_accounts VALUES(?,?,?,?,1,1,0,?,?)').run(accountId,organizationId,ownerId,label,at,at);
        return save(organizationId,authority,operationId,request,current(organizationId,accountId),'service-account.create',{serviceAccountId:accountId}) as OrganizationServiceAccount;
      });
    },
    change(organizationId:string,accountId:string,authority:ServiceAccountAuthority,value:unknown):OrganizationServiceAccount{
      check(authority,id(organizationId),true);id(accountId);const input=exact(value,['name','ownerId','enabled','expectedVersion','operationId']),label=name(input.name),ownerId=id(input.ownerId),expected=integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER-1),operationId=id(input.operationId);
      if(typeof input.enabled!=='boolean')fail(422,"SERVICE_ACCOUNT_INPUT","Service account enabled must be boolean.");const request=JSON.stringify({kind:'change',accountId,name:label,ownerId,enabled:input.enabled,expectedVersion:expected});
      return sql.transaction(()=>{check(authority,organizationId,true);const retained=retry(organizationId,authority,operationId,request);if(retained!==undefined)return retained;capacity();const prior=current(organizationId,accountId);if(prior.version!==expected)fail(409,"SERVICE_ACCOUNT_VERSION_CONFLICT","Service account changed; refresh before saving.");
        if(input.enabled||ownerId!==prior.ownerId)owner(organizationId,ownerId);if(!input.enabled||ownerId!==prior.ownerId)revoke(accountId);
        sql.prepare('UPDATE clank_platform_machine_accounts SET name=?,owner_id=?,enabled=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(label,ownerId,Number(input.enabled),now(),accountId,expected);
        return save(organizationId,authority,operationId,request,current(organizationId,accountId),'service-account.change',{serviceAccountId:accountId,version:expected+1}) as OrganizationServiceAccount;
      });
    },
    issue(organizationId:string,accountId:string,authority:ServiceAccountAuthority,value:unknown){
      check(authority,id(organizationId),true);id(accountId);const input=exact(value,['projectId','permissions','expiresAt','expectedVersion','operationId']),projectId=id(input.projectId),grant=permissions(input.permissions),expiresAt=integer(input.expiresAt,0,Number.MAX_SAFE_INTEGER),expected=integer(input.expectedVersion,1,Number.MAX_SAFE_INTEGER-1),operationId=id(input.operationId),request=JSON.stringify({kind:'issue',accountId,projectId,permissions:grant,expiresAt,expectedVersion:expected});
      return sql.transaction(()=>{check(authority,organizationId,true);const retained=retry(organizationId,authority,operationId,request);if(retained!==undefined)return retained;capacity();const account=current(organizationId,accountId);if(account.version!==expected)fail(409,"SERVICE_ACCOUNT_VERSION_CONFLICT","Service account changed; refresh before rotating.");
        if(!account.enabled)fail(409,"SERVICE_ACCOUNT_DISABLED","Enable the service account before issuing a credential.");owner(organizationId,account.ownerId,projectId,grant);
        integer(expiresAt,now()+300000,now()+30*86400000);
        if(Number(sql.prepare('SELECT count(*) AS n FROM clank_platform_machine_credentials').get()?.n)>=maxCredentials||Number(sql.prepare('SELECT count(*) AS n FROM clank_platform_machine_credentials WHERE account_id=?').get(accountId)?.n)>=50)fail(409,"SERVICE_ACCOUNT_CAPACITY","Service account credential history is full.");
        const credentialId=crypto.randomUUID(),at=now(),generation=integer(account.credentialGeneration+1,1,Number.MAX_SAFE_INTEGER-1),random=crypto.getRandomValues(new Uint8Array(32));
        const accessToken='clsa_'+btoa(String.fromCharCode(...random)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,''),hash=hooks.hash(accessToken);revoke(accountId);
        sql.prepare('INSERT INTO clank_platform_tokens(id,token_hash,user_id,name,created_at,expires_at,organization_id,project_id,permissions) VALUES(?,?,?,?,?,?,?,?,?)').run(credentialId,hash,account.ownerId,account.name,at,expiresAt,organizationId,projectId,JSON.stringify(grant));
        sql.prepare('INSERT INTO clank_platform_machine_credentials(id,account_id,token_id,token_hash,project_id,permissions,generation,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(credentialId,accountId,credentialId,hash,projectId,JSON.stringify(grant),generation,at,expiresAt);
        sql.prepare('UPDATE clank_platform_machine_accounts SET generation=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(generation,at,accountId,expected);
        const issued={account:current(organizationId,accountId),credential:credentialFrom(sql.prepare('SELECT * FROM clank_platform_machine_credentials WHERE id=?').get(credentialId)!),accessToken};
        return save(organizationId,authority,operationId,request,issued,'service-account.credential',{serviceAccountId:accountId,credentialId,generation,projectId,permissions:grant,expiresAt});
      });
    },
    resolve(accessToken:string):AuthenticatedServiceAccount{
      check();if(!/^clsa_[A-Za-z0-9_-]{43}$/u.test(accessToken))fail(401,"SERVICE_ACCOUNT_INVALID_CREDENTIAL","Service account credential is invalid or expired.");const hash=hooks.hash(accessToken);
      return sql.transaction(()=>{check();const row=sql.prepare('SELECT id,authenticated_requests FROM clank_platform_machine_credentials WHERE token_hash=?').get(hash);if(!row)fail(401,"SERVICE_ACCOUNT_INVALID_CREDENTIAL","Service account credential is invalid or expired.");
        const credentialId=String(row!.id),identity=assertCredential(credentialId,hash),requests=integer(Number(row!.authenticated_requests)+1,1,Number.MAX_SAFE_INTEGER);
        sql.prepare('UPDATE clank_platform_machine_credentials SET last_used_at=?,authenticated_requests=? WHERE id=?').run(now(),requests,credentialId);
        return Object.freeze({identity,assertCurrent(){const current=assertCredential(credentialId,hash);if(JSON.stringify(current)!==JSON.stringify(identity))fail(401,"SERVICE_ACCOUNT_INVALID_CREDENTIAL","Service account authority changed.");}});
      });
    },
    close(){closed=true;},
  };
}
