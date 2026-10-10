import {AuthError, type AuthClient, type AuthRequest, type AuthRuntime} from "./auth.ts";
import type {SQLiteDatabase} from "./backend.ts";
import {SQLITE_INTERNAL, type SQLiteInternal} from "./sqlite-internal.ts";

export type OrganizationFactorRequirement = "none" | "mfa-or-passkey" | "passkey";
export interface OrganizationSecurityRequirements {
  readonly factor: OrganizationFactorRequirement;
  readonly ssoOnly: boolean;
  /** Hard session age, measured from creation rather than last activity or step-up. */
  readonly sessionMaxAgeMs: number;
  readonly enrollmentGraceMs: number;
}
export interface OrganizationSecurityPolicy extends OrganizationSecurityRequirements {
  readonly organizationId: string;
  readonly version: number;
  readonly updatedAt: number;
}
export interface OrganizationSecurityDecision {
  readonly allowed: boolean;
  readonly reasons: readonly ("membership" | "session" | "session-age" | "factor" | "organization-sso")[];
  readonly graceEndsAt: number | null;
  readonly policyVersion: number;
}
export interface OrganizationSecurityMembership {readonly role: "owner" | "admin" | "developer" | "viewer"; readonly createdAt: number;}
export interface OrganizationSecurityPolicyOptions {
  /** Synchronous current membership lookups in this same transactional store. */
  readonly membership: (organizationId: string, userId: string) => OrganizationSecurityMembership | null;
  /** A bounded complete inventory. Exceeding the limit must reject, never truncate. */
  readonly members: (organizationId: string) => readonly {readonly userId: string; readonly membership: OrganizationSecurityMembership}[];
  readonly exists: (organizationId: string) => boolean;
  readonly audit: (actorId: string, organizationId: string, action: string, metadata: Readonly<Record<string, unknown>>) => undefined;
  /** Independent operator authority, repeated inside recovery's transaction. */
  readonly authorizeRecovery?: (current: AuthRequest<any>, organizationId: string) => undefined;
  /** Restore this verified active enrolled-passkey account as an owner atomically. */
  readonly recoverOwner?: (organizationId: string, userId: string) => undefined;
  readonly maxPolicies?: number;
  readonly maxReceipts?: number;
  readonly maxDelegations?: number;
  readonly maxEnrollments?: number;
  readonly now?: () => number;
}
export interface OrganizationSecurityPolicyChange {
  readonly requirements: OrganizationSecurityRequirements;
  readonly expectedVersion: number;
  readonly operationId: string;
}
export interface OrganizationSecurityPolicyRecovery {
  readonly ownerId: string;
  readonly confirmation: string;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly operationId: string;
}
export interface OrganizationSecurityPreview {
  readonly policy: OrganizationSecurityPolicy;
  readonly capableAdministrators: number;
  readonly recoveryAvailable: boolean;
  readonly affectedMembers: number;
  readonly current: OrganizationSecurityDecision;
  readonly proposed: OrganizationSecurityDecision;
}
export interface OrganizationSecurityPolicyController {
  read(organizationId: string, caller: AuthRequest<any>): OrganizationSecurityPolicy;
  preview(organizationId: string, caller: AuthRequest<any>, requirements: OrganizationSecurityRequirements): OrganizationSecurityPreview;
  change(organizationId: string, caller: AuthRequest<any>, input: OrganizationSecurityPolicyChange): OrganizationSecurityPolicy;
  recover(organizationId: string, caller: AuthRequest<any>, input: OrganizationSecurityPolicyRecovery): OrganizationSecurityPolicy;
  /** Trusted server boundary. JSON AuthState cannot prove a current session. */
  authorizeAuth(organizationId: string, caller: AuthRequest<any> | null): void;
  /** Captures the actual live human session; callers must authenticate the credential separately. */
  captureDelegation(organizationId: string, credentialId: string, caller: AuthRequest<any>): void;
  /** Carry an already admitted exact delegation into a new credential family. */
  continueDelegation(organizationId: string, sourceId: string, targetId: string, userId: string): void;
  authorizeDelegation(organizationId: string, credentialId: string, userId: string): void;
  /** Internal OAuth integration: identity is already authenticated independently. */
  bindDelegationAuth(organizationId: string, credentialId: string, caller: AuthRequest<any>): void;
  close(): void;
}

export interface OrganizationSecurityClientOptions {
  readonly auth: Pick<AuthClient<any>, 'user' | 'session' | 'csrfHeader' | 'reload'>;
  readonly url?: string;
  /** Platform default; use /__clank/organizations for a bound application backend. */
  readonly prefix?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}
export interface OrganizationSecurityClient {
  read(organizationId: string): Promise<OrganizationSecurityPolicy>;
  preview(organizationId: string, requirements: OrganizationSecurityRequirements): Promise<OrganizationSecurityPreview>;
  change(organizationId: string, input: OrganizationSecurityPolicyChange): Promise<OrganizationSecurityPolicy>;
  recover(organizationId: string, input: OrganizationSecurityPolicyRecovery): Promise<OrganizationSecurityPolicy>;
}

/** Session-bound transport. A returned change is historical; read current policy after a retry. */
export function createOrganizationSecurityClient(options: OrganizationSecurityClientOptions): OrganizationSecurityClient {
  const transport=options.fetch??globalThis.fetch, prefix=options.prefix??'/api/organizations', timeout=options.timeoutMs??15000;
  if(!/^\/[A-Za-z0-9_/-]+$/u.test(prefix) || prefix.endsWith('/') || prefix.includes('//') || !Number.isSafeInteger(timeout) || timeout<100 || timeout>30000) throw new TypeError('Invalid organization security transport limits.');
  const request=async(organizationId:string,operation:string,input?:unknown) => {
    identifier(organizationId);
    const userId=options.auth.user.peek()?.id, sessionId=options.auth.session.peek()?.id;
    if(!userId || !sessionId) throw new AuthError('UNAUTHENTICATED','Sign in to manage organization security.',401);
    const current=()=>options.auth.user.peek()?.id===userId && options.auth.session.peek()?.id===sessionId;
    try {
      const response=await transport(`${options.url??''}${prefix}/${organizationId}/security-policy${operation}`,{method:input===undefined?'GET':'POST',credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(timeout),headers:input===undefined?{}:{'content-type':'application/json',...options.auth.csrfHeader()},...(input===undefined?{}:{body:JSON.stringify(input)})});
      let text='',bytes=0; const reader=response.body?.getReader(),decoder=new TextDecoder();
      if(reader) {try {for(;;) {const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>32768){void reader.cancel().catch(()=>{});throw new AuthError('ORGANIZATION_POLICY_RESPONSE','Security response exceeds its supported bound.',502);}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}}
      if(!current()) throw new AuthError('AUTH_CHANGED','Account changed before the security operation completed.',409);
      let body:any;try{body=JSON.parse(text);}catch{throw new AuthError('ORGANIZATION_POLICY_RESPONSE','Invalid security response.',502);}
      if(!response.ok || body?.ok!==true) throw new AuthError(typeof body?.error?.code==='string'?body.error.code:'ORGANIZATION_POLICY_FAILED',typeof body?.error?.message==='string'?body.error.message:'The security operation failed.',response.status);
      const policy=operation==='/preview'?body.preview?.policy:body.policy;
      if(policy?.organizationId!==organizationId || !Number.isSafeInteger(policy.version) || policy.version<0 || !Number.isSafeInteger(policy.updatedAt)) throw new AuthError('ORGANIZATION_POLICY_RESPONSE','Security response does not match this organization.',502);
      normalize({factor:policy.factor,ssoOnly:policy.ssoOnly,sessionMaxAgeMs:policy.sessionMaxAgeMs,enrollmentGraceMs:policy.enrollmentGraceMs});
      if(operation==='/preview') {
        const preview=body.preview,reasons=['membership','session','session-age','factor','organization-sso'];
        const decision=(value:any)=>typeof value?.allowed==='boolean' && Array.isArray(value.reasons) && value.reasons.length<=5 && new Set(value.reasons).size===value.reasons.length
          && value.reasons.every((reason:unknown)=>reasons.includes(String(reason))) && value.allowed===(value.reasons.length===0) && value.policyVersion===policy.version
          && (value.graceEndsAt===null || Number.isSafeInteger(value.graceEndsAt) && value.graceEndsAt>=0);
        if(!Number.isInteger(preview.affectedMembers) || preview.affectedMembers<0 || preview.affectedMembers>1000 || !Number.isInteger(preview.capableAdministrators) || preview.capableAdministrators<0 || preview.capableAdministrators>preview.affectedMembers
          || typeof preview.recoveryAvailable!=='boolean' || !decision(preview.current) || !decision(preview.proposed)) throw new AuthError('ORGANIZATION_POLICY_RESPONSE','Invalid effective security preview.',502);
      }
      await options.auth.reload();if(!current()) throw new AuthError('AUTH_CHANGED','Account changed before the security operation completed.',409);
      return body;
    } catch(error) {
      if(current()) await options.auth.reload();
      throw error;
    }
  };
  return {async read(id){return (await request(id,'')).policy;},async preview(id,requirements){return (await request(id,'/preview',{requirements})).preview;},
    async change(id,input){return (await request(id,'',input)).policy;},async recover(id,input){return (await request(id,'/recover',input)).policy;}};
}

const policyError = (code: string, message: string, status = 403): never => {throw new AuthError(code, message, status);};
const number = (value: unknown, min: number, max: number) => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) policyError("ORGANIZATION_POLICY_INPUT", "Choose supported security policy limits.", 422);
  return Number(value);
};
const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,160}$/u.test(value)) policyError("ORGANIZATION_POLICY_INPUT", "Choose a valid policy identifier.", 422);
  return value as string;
};
const exact = (value: unknown, keys: readonly string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) policyError("ORGANIZATION_POLICY_INPUT", "Choose exact security policy fields.", 422);
  return value as Record<string, unknown>;
};
const normalize = (value: unknown): OrganizationSecurityRequirements => {
  const input = exact(value, ["factor", "ssoOnly", "sessionMaxAgeMs", "enrollmentGraceMs"]);
  if (!["none", "mfa-or-passkey", "passkey"].includes(String(input.factor)) || typeof input.ssoOnly !== "boolean") policyError("ORGANIZATION_POLICY_INPUT", "Choose supported factor and SSO requirements.", 422);
  return {factor: input.factor as OrganizationFactorRequirement, ssoOnly: input.ssoOnly as boolean,
    sessionMaxAgeMs: number(input.sessionMaxAgeMs, 60_000, 30 * 86400000), enrollmentGraceMs: number(input.enrollmentGraceMs, 0, 7 * 86400000)};
};
const defaults: OrganizationSecurityRequirements = Object.freeze({factor: "none", ssoOnly: false, sessionMaxAgeMs: 30 * 86400000, enrollmentGraceMs: 0});
/** @internal Shared fail-closed storage guard for native integrations. */
export function assertOrganizationSecurityProtocol(sql: SQLiteInternal): void {
  if (sql.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_organization_security_state' AND type='table'").get()
    && sql.prepare("SELECT protocol FROM clank_organization_security_state WHERE singleton=1").get()?.protocol !== 1) policyError("ORGANIZATION_POLICY_PROTOCOL", "Unsupported organization security storage protocol.", 409);
}

/** Native single-store policy authority. Never derive it from serialized browser claims. */
export function openOrganizationSecurityPolicies(database: SQLiteDatabase<any>, auth: AuthRuntime<any>, options: OrganizationSecurityPolicyOptions): OrganizationSecurityPolicyController {
  const sql = database[SQLITE_INTERNAL], now = options.now ?? Date.now;
  assertOrganizationSecurityProtocol(sql);
  const bounds = {policies: number(options.maxPolicies ?? 1000, 1, 10000), receipts: number(options.maxReceipts ?? 10000, 1, 100000),
    delegations: number(options.maxDelegations ?? 50000, 1, 100000), enrollments: number(options.maxEnrollments ?? 10000, 1, 100000)};
  if (!!options.authorizeRecovery !== !!options.recoverOwner) throw new TypeError("Configure recovery authority and owner restoration together.");
  sql.transaction(() => sql.exec(`CREATE TABLE IF NOT EXISTS clank_organization_security_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL);
    INSERT OR IGNORE INTO clank_organization_security_state VALUES(1,1);
    CREATE TABLE IF NOT EXISTS clank_organization_security_policies(organization_id TEXT PRIMARY KEY,version INTEGER NOT NULL,requirements TEXT NOT NULL CHECK(json_valid(requirements)),updated_at INTEGER NOT NULL,factor_at INTEGER,sso_at INTEGER);
    CREATE TABLE IF NOT EXISTS clank_organization_security_enrollments(organization_id TEXT NOT NULL,user_id TEXT NOT NULL,first_seen_at INTEGER NOT NULL,factor_deadline INTEGER,sso_deadline INTEGER,PRIMARY KEY(organization_id,user_id));
    CREATE TABLE IF NOT EXISTS clank_organization_security_delegations(organization_id TEXT NOT NULL,credential_id TEXT NOT NULL,user_id TEXT NOT NULL,session_id TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(organization_id,credential_id));
    CREATE TABLE IF NOT EXISTS clank_organization_security_receipts(organization_id TEXT NOT NULL,actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,intent TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(organization_id,actor_id,operation_id));`));
  let closed = false;
  const delegated = new WeakMap<AuthRequest<any>, {organizationId: string; assertCurrent(): void}>();
  const synchronous = <T>(value: T): T => {if (value && typeof (value as any).then === "function") throw new TypeError("Organization security hooks must be synchronous."); return value;};
  const effect = (value: undefined) => {if (synchronous(value) !== undefined) throw new TypeError("Organization security authority/audit hooks must complete synchronously without a result.");};
  const check = () => {if (closed) policyError("ORGANIZATION_POLICY_CLOSED", "Organization security controller is closed.", 503); assertOrganizationSecurityProtocol(sql);};
  const member = (organizationId: string, userId: string) => synchronous(options.membership(organizationId, userId));
  const inventory = (organizationId: string) => {
    const rows = synchronous(options.members(organizationId));
    if (!Array.isArray(rows) || rows.length > 1000 || new Set(rows.map(row => row.userId)).size !== rows.length) policyError("ORGANIZATION_POLICY_CAPACITY", "The complete membership preview exceeds its supported bound.", 409);
    return rows;
  };
  const capacity = (table: string, maximum: number) => {
    if (Number(sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n) >= maximum) policyError("ORGANIZATION_POLICY_CAPACITY", "Security policy storage capacity is full.", 409);
  };
  const rowFor = (organizationId: string) => sql.prepare("SELECT * FROM clank_organization_security_policies WHERE organization_id=?").get(organizationId);
  const policyFor = (organizationId: string): OrganizationSecurityPolicy => {
    const row = rowFor(organizationId);
    return {organizationId, ...(row ? normalize(JSON.parse(String(row.requirements))) : defaults), version: Number(row?.version ?? 0), updatedAt: Number(row?.updated_at ?? 0)};
  };
  const currentSession = (caller: AuthRequest<any> | null) => {
    if (!caller || typeof caller.requireUser !== 'function' || typeof caller.requireVerified !== 'function' || typeof caller.requireRole !== 'function') policyError("ORGANIZATION_POLICY_SESSION", "Supply a trusted server authentication result.", 401);
    const current = caller?.session ? auth.refreshSession(caller.session.id) : null;
    if (!current?.user || current.user.id !== caller?.user?.id) policyError("ORGANIZATION_POLICY_SESSION", "Sign in with a current human session.", 401);
    return current!;
  };
  const ssoBound = (organizationId: string, userId: string, sessionId?: string) => {
    if (!sql.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_sso_session_bindings' AND type='table'").get()) return false;
    return !!sql.prepare(`SELECT 1 FROM clank_sso_session_bindings b JOIN clank_sso_identities i ON i.id=b.identity_id
      JOIN clank_sso_offboarding_credentials p ON p.organization=i.organization AND p.issuer=i.issuer
      WHERE b.organization=? AND b.user_id=? AND b.session_id=? AND i.user_id=b.user_id AND i.organization=b.organization AND i.active=1 AND i.version=b.identity_version`).get(organizationId, userId, sessionId ?? "");
  };
  const capable = (organizationId: string, userId: string, requirements: OrganizationSecurityRequirements) => {
    if (!sql.prepare("SELECT 1 FROM clank_auth_users WHERE id=? AND disabled=0").get(userId)) return false;
    const passkey = !!sql.prepare("SELECT 1 FROM clank_auth_passkeys WHERE user_id=? LIMIT 1").get(userId);
    if (requirements.factor === "passkey" && !passkey || requirements.factor === "mfa-or-passkey" && !passkey && !auth.definition.mfa.send) return false;
    if (requirements.ssoOnly) {
      if (!sql.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_sso_identities' AND type='table'").get()) return false;
      if (!sql.prepare(`SELECT 1 FROM clank_sso_identities i JOIN clank_sso_offboarding_credentials p ON p.organization=i.organization AND p.issuer=i.issuer WHERE i.organization=? AND i.user_id=? AND i.active=1 LIMIT 1`).get(organizationId, userId)) return false;
    }
    return true;
  };
  const administrators = (organizationId: string, requirements: OrganizationSecurityRequirements) => inventory(organizationId).filter(row => ["owner", "admin"].includes(row.membership.role) && capable(organizationId, row.userId, requirements)).length;
  const enrollment = (organizationId: string, userId: string, membership: OrganizationSecurityMembership) => {
    let row = sql.prepare("SELECT * FROM clank_organization_security_enrollments WHERE organization_id=? AND user_id=?").get(organizationId, userId);
    if (!row) {
      capacity("clank_organization_security_enrollments", bounds.enrollments);
      number(membership.createdAt, 0, now());
      const policy = rowFor(organizationId), requirements = policyFor(organizationId);
      const deadline = (at: unknown) => at === null || at === undefined ? null : Math.max(Number(at), membership.createdAt + requirements.enrollmentGraceMs);
      sql.prepare("INSERT INTO clank_organization_security_enrollments VALUES(?,?,?,?,?)").run(organizationId, userId, membership.createdAt, deadline(policy?.factor_at), deadline(policy?.sso_at));
      row = sql.prepare("SELECT * FROM clank_organization_security_enrollments WHERE organization_id=? AND user_id=?").get(organizationId, userId);
    }
    return row!;
  };
  const decision = (organizationId: string, caller: AuthRequest<any>, requirements = policyFor(organizationId), preview = false): OrganizationSecurityDecision => {
    const reasons: OrganizationSecurityDecision["reasons"][number][] = [], at = now(), membership = caller.user ? member(organizationId, caller.user.id) : null;
    if (!membership) reasons.push("membership");
    let current: AuthRequest<any> | null = null;
    try {current = currentSession(caller);} catch {reasons.push("session");}
    if (current && (current.session!.createdAt > at || current.session!.createdAt + requirements.sessionMaxAgeMs <= at)) reasons.push("session-age");
    const stored = membership && caller.user ? enrollment(organizationId, caller.user.id, membership) : null;
    const grace = (key: "factor_deadline" | "sso_deadline") => preview ? Math.min(Number(stored?.[key] ?? Infinity), at + requirements.enrollmentGraceMs) : Number(stored?.[key] ?? 0);
    const factorAt = grace("factor_deadline"), ssoAt = grace("sso_deadline");
    if (current && requirements.factor !== "none" && factorAt <= at && !(requirements.factor === "passkey" ? current.session!.authenticationMethod === "passkey" : ["passkey", "mfa"].includes(current.session!.authenticationMethod ?? ""))) reasons.push("factor");
    if (current && requirements.ssoOnly && ssoAt <= at && !ssoBound(organizationId, current.user!.id, current.session!.id)) reasons.push("organization-sso");
    const deadlines = [requirements.factor !== "none" ? factorAt : 0, requirements.ssoOnly ? ssoAt : 0].filter(value => Number.isFinite(value) && value > at);
    return {allowed: reasons.length === 0, reasons, graceEndsAt: deadlines.length ? Math.min(...deadlines) : null, policyVersion: policyFor(organizationId).version};
  };
  const allowed = (organizationId: string, caller: AuthRequest<any>) => {
    const result = decision(organizationId, caller);
    if (!result.allowed) policyError("ORGANIZATION_POLICY_REQUIRED", "Complete the current organization security requirements.");
  };
  const administrator = (organizationId: string, caller: AuthRequest<any>, write = false) => {
    check(); identifier(organizationId); const current = currentSession(caller);
    if (!synchronous(options.exists(organizationId)) || !["owner", "admin"].includes(member(organizationId, current.user!.id)?.role ?? "")) policyError("ORGANIZATION_POLICY_UNAVAILABLE", "Organization security administration is unavailable.", 404);
    // A noncompliant administrator can inspect remediation, but cannot change policy.
    if (write) {auth.requireFreshAuthentication(current, 300000); allowed(organizationId, current);}
    return current;
  };
  const retained = (organizationId: string, actorId: string, operationId: string, intent: string) => {
    const row = sql.prepare("SELECT intent,result FROM clank_organization_security_receipts WHERE organization_id=? AND actor_id=? AND operation_id=?").get(organizationId, actorId, operationId);
    if (!row) return undefined;
    if (row.intent !== intent) policyError("ORGANIZATION_POLICY_OPERATION_CONFLICT", "That operation ID already represents another policy change.", 409);
    return JSON.parse(String(row.result)) as OrganizationSecurityPolicy;
  };
  const publish = (organizationId: string, actorId: string, operationId: string, intent: string, requirements: OrganizationSecurityRequirements, expected: number, action: string, metadata: Record<string, unknown>) => {
    const prior = rowFor(organizationId), at = now();
    if (Number(prior?.version ?? 0) !== expected) policyError("ORGANIZATION_POLICY_VERSION_CONFLICT", "Security policy changed; refresh before saving.", 409);
    capacity("clank_organization_security_receipts", bounds.receipts); if (!prior) capacity("clank_organization_security_policies", bounds.policies);
    const rows = inventory(organizationId);
    for (const row of rows) enrollment(organizationId, row.userId, row.membership);
    const deadline = (old: unknown, enabled: boolean) => enabled ? Math.min(Number(old ?? Infinity), at + requirements.enrollmentGraceMs) : old ?? null;
    const factorAt = deadline(prior?.factor_at, requirements.factor !== "none"), ssoAt = deadline(prior?.sso_at, requirements.ssoOnly);
    sql.prepare(`INSERT INTO clank_organization_security_policies VALUES(?,?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET version=excluded.version,requirements=excluded.requirements,updated_at=excluded.updated_at,factor_at=excluded.factor_at,sso_at=excluded.sso_at`).run(organizationId, expected + 1, JSON.stringify(requirements), at, factorAt, ssoAt);
    const tighten = (column: "factor_deadline" | "sso_deadline", deadline: unknown) => {
      if (deadline !== null) sql.prepare(`UPDATE clank_organization_security_enrollments SET ${column}=min(coalesce(${column},?),?) WHERE organization_id=?`).run(deadline, deadline, organizationId);
    };
    tighten("factor_deadline", factorAt); tighten("sso_deadline", ssoAt);
    const result = policyFor(organizationId);
    sql.prepare("INSERT INTO clank_organization_security_receipts VALUES(?,?,?,?,?)").run(organizationId, actorId, operationId, intent, JSON.stringify(result));
    effect(options.audit(actorId, organizationId, action, {version: result.version, requirements, ...metadata}));
    return result;
  };
  const atomic = <T>(operation: () => T): T => sql.inTransaction ? operation() : sql.transaction(operation);
  const authorizeDelegation = (organizationId: string, credentialId: string, userId: string) => atomic(() => {
    check(); identifier(organizationId); identifier(credentialId); identifier(userId);
    const proof = sql.prepare("SELECT * FROM clank_organization_security_delegations WHERE organization_id=? AND credential_id=?").get(organizationId, credentialId), policy = policyFor(organizationId);
    if (policy.version === 0) {if (!member(organizationId, userId)) policyError("ORGANIZATION_POLICY_REQUIRED", "Organization membership is required."); return;}
    if (!proof || proof.user_id !== userId || Number(proof.version) !== policy.version) policyError("ORGANIZATION_POLICY_DELEGATION", "Reauthorize this credential under the current organization policy.", 401);
    const current = auth.refreshSession(String(proof!.session_id));
    if (!current?.user || current.user.id !== userId) policyError("ORGANIZATION_POLICY_DELEGATION", "The authorizing human session is no longer current.", 401);
    allowed(organizationId, current!);
  });
  return {
    read(organizationId, caller) {return atomic(() => {administrator(organizationId, caller); return policyFor(organizationId);});},
    preview(organizationId, caller, value) {return atomic(() => {
      const current = administrator(organizationId, caller), requirements = normalize(value), rows = inventory(organizationId);
      return {policy: policyFor(organizationId), capableAdministrators: administrators(organizationId, requirements), recoveryAvailable: !!options.authorizeRecovery,
        affectedMembers: rows.length, current: decision(organizationId, current), proposed: decision(organizationId, current, {...policyFor(organizationId), ...requirements}, true)};
    });},
    change(organizationId, caller, value) {
      const input = exact(value, ["requirements", "expectedVersion", "operationId"]), requirements = normalize(input.requirements), expected = number(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1), operationId = identifier(input.operationId);
      administrator(organizationId, caller, true); const intent = JSON.stringify({kind: "change", requirements, expectedVersion: expected});
      return sql.transaction(changes => {
        const current = administrator(organizationId, caller, true), actorId = current.user!.id, retry = retained(organizationId, actorId, operationId, intent);
        if (retry) return retry;
        if (!administrators(organizationId, requirements) && !options.authorizeRecovery) policyError("ORGANIZATION_POLICY_LAST_ADMIN", "Enroll an administrator or configure independent operator recovery before saving.", 409);
        const result = publish(organizationId, actorId, operationId, intent, requirements, expected, "organization.security-policy.change", {});
        for (const row of inventory(organizationId)) changes.record("__auth", row.userId, row.userId);
        return result;
      });
    },
    recover(organizationId, caller, value) {
      check(); identifier(organizationId); const input = exact(value, ["ownerId", "confirmation", "reason", "expectedVersion", "operationId"]), ownerId = identifier(input.ownerId), expected = number(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1), operationId = identifier(input.operationId);
      if (input.confirmation !== organizationId || typeof input.reason !== "string" || input.reason.trim().length < 10 || new TextEncoder().encode(input.reason).length > 500 || /[\u0000-\u001f\u007f]/u.test(input.reason)) policyError("ORGANIZATION_POLICY_INPUT", "Confirm the organization and record a recovery reason.", 422);
      const recovery = () => {const current = currentSession(caller); auth.requireFreshAuthentication(current, 300000); if (!options.authorizeRecovery || !options.recoverOwner) policyError("ORGANIZATION_POLICY_RECOVERY_DISABLED", "Independent operator recovery is not configured."); effect(options.authorizeRecovery!(current, organizationId)); return current;};
      recovery(); const intent = JSON.stringify({kind: "recover", ownerId, confirmation: organizationId, reason: input.reason, expectedVersion: expected});
      return sql.transaction(changes => {
        check(); const current = recovery(), retry = retained(organizationId, current.user!.id, operationId, intent); if (retry) return retry;
        if (!synchronous(options.exists(organizationId))) policyError("ORGANIZATION_POLICY_UNAVAILABLE", "Organization recovery is unavailable.", 404);
        if (administrators(organizationId, policyFor(organizationId))) policyError("ORGANIZATION_POLICY_RECOVERY_UNNEEDED", "A capable organization administrator must handle this policy.", 409);
        if (!capable(organizationId, ownerId, {...defaults, factor: "passkey"})) policyError("ORGANIZATION_POLICY_RECOVERY_OWNER", "Choose an enabled account with an enrolled passkey.", 409);
        effect(options.recoverOwner!(organizationId, ownerId));
        const result = publish(organizationId, current.user!.id, operationId, intent, {...defaults, factor: "passkey"}, expected, "organization.security-policy.recover", {ownerId, reason: input.reason});
        for (const row of inventory(organizationId)) changes.record("__auth", row.userId, row.userId);
        return result;
      });
    },
    authorizeAuth(organizationId, caller) {atomic(() => {check(); identifier(organizationId); if (caller && delegated.has(caller)) {const proof = delegated.get(caller)!; if (proof.organizationId !== organizationId) policyError("ORGANIZATION_POLICY_DELEGATION", "Delegation belongs to another organization.", 401); proof.assertCurrent(); return;} const current = currentSession(caller); allowed(organizationId, current);});},
    captureDelegation(organizationId, credentialId, caller) {
      check(); identifier(organizationId); identifier(credentialId); const current = currentSession(caller); allowed(organizationId, current);
      const capture = () => {
        check(); const refreshed = currentSession(current); allowed(organizationId, refreshed);
        const existing = sql.prepare("SELECT 1 FROM clank_organization_security_delegations WHERE organization_id=? AND credential_id=?").get(organizationId, credentialId);
        if (existing) policyError("ORGANIZATION_POLICY_DELEGATION_CONFLICT", "Delegation proof is immutable.", 409);
        capacity("clank_organization_security_delegations", bounds.delegations);
        sql.prepare("INSERT INTO clank_organization_security_delegations VALUES(?,?,?,?,?)").run(organizationId, credentialId, refreshed.user!.id, refreshed.session!.id, policyFor(organizationId).version);
      };
      if (sql.inTransaction) capture(); else sql.transaction(capture);
    },
    continueDelegation(organizationId, sourceId, targetId, userId) {
      const carry = () => {
        authorizeDelegation(organizationId, sourceId, userId); identifier(targetId);
        const source = sql.prepare("SELECT * FROM clank_organization_security_delegations WHERE organization_id=? AND credential_id=?").get(organizationId, sourceId);
        if (!source) policyError("ORGANIZATION_POLICY_DELEGATION", "The original human authorization proof is missing.", 401);
        capacity("clank_organization_security_delegations", bounds.delegations);
        sql.prepare("INSERT INTO clank_organization_security_delegations VALUES(?,?,?,?,?)").run(organizationId, targetId, userId, source!.session_id, source!.version);
      };
      if (sql.inTransaction) carry(); else sql.transaction(carry);
    },
    authorizeDelegation,
    bindDelegationAuth(organizationId, credentialId, caller) {
      if (!caller.user || caller.session || typeof caller.requireUser !== 'function' || typeof caller.requireVerified !== 'function' || typeof caller.requireRole !== 'function') policyError("ORGANIZATION_POLICY_DELEGATION", "Supply independently authenticated OAuth identity.", 401);
      const userId = caller.user!.id; authorizeDelegation(organizationId, credentialId, userId);
      delegated.set(caller, {organizationId, assertCurrent() {if (caller.user?.id !== userId || caller.session) policyError("ORGANIZATION_POLICY_DELEGATION", "Delegated identity changed.", 401); authorizeDelegation(organizationId, credentialId, userId);}});
    },
    close() {closed = true;},
  };
}
