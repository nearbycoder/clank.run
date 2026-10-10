import {AuthError} from './auth.ts';
import type {SQLiteInternal} from './sqlite-internal.ts';
import {validateTemporaryAccessGrant, type TemporaryAccessCreate, type TemporaryAccessGrant, type TemporaryAccessResult, type TemporaryAccessRevoke, type TemporaryAccessSnapshot} from './temporary-access.ts';

/** Private native adapter. Browser JSON, tokens and machine principals cannot create it. */
export interface TemporaryAccessAuthority {readonly userId: string; assertCurrent(fresh: boolean): void;}
export interface TemporaryAccessMembership {readonly organizationId: string; readonly role: string; readonly createdAt: number; readonly updatedAt: number; readonly policyVersion: number;}
export interface PlatformTemporaryAccessOptions {
  readonly membership: (projectId: string, userId: string) => TemporaryAccessMembership | null;
  /** Must insert and verify the native audit row within this transaction. */
  readonly audit: (actorId: string, projectId: string, action: string, metadata: Readonly<Record<string, unknown>>) => void;
  readonly maxGrants?: number;
  readonly maxReceipts?: number;
  readonly now?: () => number;
}
interface StoredGrant extends Omit<TemporaryAccessGrant, 'active'> {readonly issuerMembership: string; readonly recipientMembership: string; readonly policyVersion: number; readonly createdVersion: number; readonly revocation?: {readonly actorId: string; readonly operationId: string; readonly intent: string; readonly acceptedVersion: number};}
const fail = (code: string, message: string, status = 409): never => {throw new AuthError(code, message, status);};
const id = (value: unknown): string => {if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(value)) fail('TEMPORARY_ACCESS_INPUT', 'Invalid temporary access identifier.', 422);return value as string;};
const reason = (value: unknown): string => {if (typeof value !== 'string' || value.length < 1 || value.length > 200 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail('TEMPORARY_ACCESS_INPUT', 'Record a reason of 1–200 plain characters.', 422);return value as string;};
const version = (value: unknown): number => {if (!Number.isSafeInteger(value) || (value as number) < 0) fail('TEMPORARY_ACCESS_INPUT', 'Invalid expected version.', 422);return value as number;};
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) fail('TEMPORARY_ACCESS_INPUT', 'Unexpected temporary access fields.', 422);return value as Record<string, unknown>;};
const pin = (member: TemporaryAccessMembership) => JSON.stringify([member.organizationId, member.role, member.createdAt, member.updatedAt]);

export function openPlatformTemporaryAccess(sql: SQLiteInternal, options: PlatformTemporaryAccessOptions) {
  const maxGrants = options.maxGrants ?? 1000, maxReceipts = options.maxReceipts ?? 10000, now = options.now ?? Date.now;
  for (const bound of [maxGrants,maxReceipts]) if (!Number.isSafeInteger(bound) || bound < 1 || bound > 100000) throw new TypeError('Invalid temporary access storage bound.');
  let closed = false, observedClock = 0;
  const atomic = <T>(handler: () => T): T => sql.inTransaction ? handler() : sql.transaction(handler);
  if (sql.prepare("SELECT 1 FROM sqlite_schema WHERE name='clank_platform_temporary_access_state'").get()
    && sql.prepare('SELECT protocol FROM clank_platform_temporary_access_state WHERE singleton=1').get()?.protocol !== 1) fail('TEMPORARY_ACCESS_PROTOCOL', 'Unsupported retained temporary access protocol.', 503);
  atomic(() => {
    sql.exec(`CREATE TABLE IF NOT EXISTS clank_platform_temporary_access_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL,clock INTEGER NOT NULL);
      INSERT OR IGNORE INTO clank_platform_temporary_access_state VALUES(1,1,0);
      CREATE TABLE IF NOT EXISTS clank_platform_temporary_access_versions(project_id TEXT PRIMARY KEY,version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS clank_platform_temporary_access_grants(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,organization_id TEXT NOT NULL,issuer_id TEXT NOT NULL,recipient_id TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS clank_platform_temporary_access_project ON clank_platform_temporary_access_grants(project_id,id);
      CREATE TABLE IF NOT EXISTS clank_platform_temporary_access_receipts(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,intent TEXT NOT NULL,grant_id TEXT NOT NULL,accepted_version INTEGER NOT NULL,PRIMARY KEY(project_id,actor_id,operation_id));`);
    protocol();
    // Sticky invalidation catches even a delete/rejoin with identical timestamps.
    for (const event of ['DELETE','UPDATE']) sql.exec(`CREATE TRIGGER IF NOT EXISTS clank_platform_temporary_access_member_${event.toLowerCase()} BEFORE ${event} ON clank_platform_memberships BEGIN
      UPDATE clank_platform_temporary_access_versions SET version=version+1 WHERE project_id IN(SELECT project_id FROM clank_platform_temporary_access_grants WHERE state='active' AND organization_id=OLD.organization_id AND (issuer_id=OLD.user_id OR recipient_id=OLD.user_id));
      UPDATE clank_platform_temporary_access_grants SET state='revoked' WHERE state='active' AND organization_id=OLD.organization_id AND (issuer_id=OLD.user_id OR recipient_id=OLD.user_id);
    END;`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS clank_platform_temporary_access_project_change BEFORE UPDATE OF organization_id,parent_project_id ON clank_platform_projects BEGIN
      UPDATE clank_platform_temporary_access_versions SET version=version+1 WHERE project_id=OLD.id;
      UPDATE clank_platform_temporary_access_grants SET state='revoked' WHERE project_id=OLD.id AND state='active';
    END;`);
    // Reopening retires prior authority, including after an interrupted transaction
    // whose expiry write rolled back. Receipts remain historical acknowledgments.
    const prior = sql.prepare("SELECT * FROM clank_platform_temporary_access_grants WHERE state='active' LIMIT ?").all(maxGrants+1);
    if (prior.length > maxGrants) fail('TEMPORARY_ACCESS_CAPACITY','Retained grants exceed the configured startup bound.',503);
    for (const row of prior) {let grant: unknown;try {grant=JSON.parse(String(row.record));validateTemporaryAccessGrant({...grant as object,active:false},String(row.project_id));}catch {fail('TEMPORARY_ACCESS_STATE','Invalid retained grant at restart.',503);}}
    const projects = new Set(prior.map(row => String(row.project_id)));
    for (const projectId of projects) {
      const previous = Number(sql.prepare('SELECT version FROM clank_platform_temporary_access_versions WHERE project_id=?').get(projectId)?.version);
      if (!Number.isSafeInteger(previous) || previous < 1 || previous >= Number.MAX_SAFE_INTEGER) fail('TEMPORARY_ACCESS_STATE','Invalid retained grant version at restart.',503);
      const update = sql.prepare('UPDATE clank_platform_temporary_access_versions SET version=version+1 WHERE project_id=? AND version=?').run(projectId,previous);
      if (Number(update.changes)!==1 || sql.prepare('SELECT version FROM clank_platform_temporary_access_versions WHERE project_id=?').get(projectId)?.version!==previous+1) fail('TEMPORARY_ACCESS_WRITE','Restart invalidation was not stored.',503);
    }
    const retired = sql.prepare("UPDATE clank_platform_temporary_access_grants SET state='revoked' WHERE state='active'").run();
    if (Number(retired.changes)!==prior.length || sql.prepare("SELECT 1 FROM clank_platform_temporary_access_grants WHERE state='active' LIMIT 1").get()) fail('TEMPORARY_ACCESS_WRITE','Restart did not retire prior temporary authority.',503);
    const persistedClock=sql.prepare('SELECT clock FROM clank_platform_temporary_access_state WHERE singleton=1').get()?.clock;
    if (!Number.isSafeInteger(persistedClock) || Number(persistedClock)<0) fail('TEMPORARY_ACCESS_STATE','Invalid retained grant clock.',503);
    observedClock=Number(persistedClock);
  });
  function protocol() {if (closed || sql.prepare('SELECT protocol FROM clank_platform_temporary_access_state WHERE singleton=1').get()?.protocol !== 1) fail('TEMPORARY_ACCESS_PROTOCOL', 'Temporary access is closed or has an unsupported protocol.', 503);}
  const clock = () => {
    protocol();const value = now(), previous = sql.prepare('SELECT clock FROM clank_platform_temporary_access_state WHERE singleton=1').get()?.clock;
    if (!Number.isSafeInteger(value) || value < 946684800000 || value > 4102444800000 || !Number.isSafeInteger(previous) || value < Math.max(Number(previous),observedClock)) fail('TEMPORARY_ACCESS_CLOCK', 'Clock rollback blocks temporary privileges.', 503);
    observedClock=value;
    if (value > Number(previous)) {const write = sql.prepare('UPDATE clank_platform_temporary_access_state SET clock=? WHERE singleton=1 AND clock=?').run(value,previous);if (Number(write.changes) !== 1 || sql.prepare('SELECT clock FROM clank_platform_temporary_access_state WHERE singleton=1').get()?.clock !== value) fail('TEMPORARY_ACCESS_WRITE', 'Temporary access clock was not stored.', 503);}
    return value;
  };
  const currentVersion = (projectId: string) => Number(sql.prepare('SELECT version FROM clank_platform_temporary_access_versions WHERE project_id=?').get(projectId)?.version ?? 0);
  const member = (projectId: string, userId: string) => {
    const value = options.membership(projectId,userId);
    if (!value || !['owner','admin','developer','viewer'].includes(value.role) || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt) || !Number.isSafeInteger(value.policyVersion) || value.policyVersion < 0) fail('TEMPORARY_ACCESS_MEMBERSHIP', 'Current project membership is required.', 403);
    id(value!.organizationId);return value!;
  };
  const caller = (projectId: string, authority: TemporaryAccessAuthority, fresh: boolean, administrator = false) => {
    id(projectId);id(authority.userId);authority.assertCurrent(fresh);const current = member(projectId,authority.userId);
    if (administrator && !['owner','admin'].includes(current.role)) fail('TEMPORARY_ACCESS_ADMIN', 'A current project owner or administrator is required.', 403);
    return current;
  };
  const stored = (row: Record<string,unknown>): StoredGrant => {
    let value: any;try {value = JSON.parse(String(row.record));validateTemporaryAccessGrant({...value,active:false},String(row.project_id));}catch {fail('TEMPORARY_ACCESS_STATE', 'Invalid retained temporary access state.', 503);}
    if (value.id !== row.id || value.organizationId !== row.organization_id || value.issuerId !== row.issuer_id || value.recipientId !== row.recipient_id || !['active','revoked','expired'].includes(String(row.state)) || typeof value.issuerMembership !== 'string' || typeof value.recipientMembership !== 'string' || !Number.isSafeInteger(value.policyVersion) || value.policyVersion < 0 || !Number.isSafeInteger(value.createdVersion) || value.createdVersion < 1 || value.revocation && (value.state !== 'revoked' || !Number.isSafeInteger(value.revocation.acceptedVersion) || typeof value.revocation.intent !== 'string' || !Number.isSafeInteger(value.revocation.acceptedVersion))) fail('TEMPORARY_ACCESS_STATE', 'Temporary access bindings do not match.', 503);
    return {...value,state:row.state} as StoredGrant;
  };
  const grantFor = (grantId: string): StoredGrant => {const row = sql.prepare('SELECT * FROM clank_platform_temporary_access_grants WHERE id=?').get(grantId);if (!row) fail('TEMPORARY_ACCESS_NOT_FOUND', 'Temporary access grant not found.', 404);return stored(row!);};
  const active = (grant: StoredGrant, at: number) => {
    if (grant.state !== 'active' || at >= grant.expiresAt) return false;
    try {const issuer = member(grant.projectId,grant.issuerId),recipient = member(grant.projectId,grant.recipientId);return ['owner','admin'].includes(issuer.role) && pin(issuer) === grant.issuerMembership && pin(recipient) === grant.recipientMembership && issuer.policyVersion === grant.policyVersion && recipient.policyVersion === grant.policyVersion;}catch (error) {if (error instanceof AuthError && error.status === 403) return false;throw error;}
  };
  const publicGrant = (grant: StoredGrant, at: number): TemporaryAccessGrant => {const {issuerMembership:_,recipientMembership:__,policyVersion:___,createdVersion:____,revocation:_____,...output} = grant;return {...output,active:active(grant,at)};};
  const expire = (projectId: string, at: number) => {
    const rows = sql.prepare("SELECT * FROM clank_platform_temporary_access_grants WHERE project_id=? AND state='active' ORDER BY id LIMIT 101").all(projectId);
    if (rows.length > 100) fail('TEMPORARY_ACCESS_CAPACITY', 'This project exceeds its temporary access inventory bound.');
    for (const row of rows) {const grant = stored(row);if (active(grant,at)) continue;const state = at >= grant.expiresAt ? 'expired' : 'revoked';const write = sql.prepare("UPDATE clank_platform_temporary_access_grants SET state=? WHERE id=? AND state='active'").run(state,grant.id);if (Number(write.changes) !== 1 || sql.prepare('SELECT state FROM clank_platform_temporary_access_grants WHERE id=?').get(grant.id)?.state !== state) fail('TEMPORARY_ACCESS_WRITE', 'Grant invalidation was not stored.', 503);bump(projectId,currentVersion(projectId));}
  };
  const bump = (projectId: string, expected: number) => {
    if (expected >= Number.MAX_SAFE_INTEGER) fail('TEMPORARY_ACCESS_CAPACITY', 'Temporary access version capacity is full.');
    if (currentVersion(projectId) !== expected) fail('TEMPORARY_ACCESS_VERSION', 'Read the current temporary access version.');
    const write = expected === 0 ? sql.prepare('INSERT INTO clank_platform_temporary_access_versions VALUES(?,1)').run(projectId) : sql.prepare('UPDATE clank_platform_temporary_access_versions SET version=version+1 WHERE project_id=? AND version=?').run(projectId,expected);
    if (Number(write.changes) !== 1 || currentVersion(projectId) !== expected+1) fail('TEMPORARY_ACCESS_WRITE', 'Temporary access version was not stored.', 503);
    return expected+1;
  };
  const capacity = (table: string, maximum: number) => {if (Number(sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n) >= maximum) fail('TEMPORARY_ACCESS_CAPACITY', 'Temporary access retained storage is full.');};
  const receipt = (projectId: string, authority: TemporaryAccessAuthority, operationId: string, intent: string, at: number): TemporaryAccessResult | null => {
    const row = sql.prepare('SELECT * FROM clank_platform_temporary_access_receipts WHERE project_id=? AND actor_id=? AND operation_id=?').get(projectId,authority.userId,operationId);
    if (!row) return null;if (row.intent !== intent) fail('TEMPORARY_ACCESS_RETRY', 'Operation ID belongs to a different temporary access intent.');
    const grant = grantFor(String(row.grant_id));if (grant.projectId !== projectId || !Number.isSafeInteger(row.accepted_version) || Number(row.accepted_version) < 1 || Number(row.accepted_version) > currentVersion(projectId)) fail('TEMPORARY_ACCESS_STATE', 'Invalid retained temporary access receipt.', 503);
    let parsed: unknown;try {parsed = JSON.parse(intent);}catch {fail('TEMPORARY_ACCESS_STATE','Invalid temporary access intent.',503);}
    const intentParts = parsed as unknown[];
    if (!Array.isArray(intentParts) || (intentParts[0] === 'create'
      ? authority.userId !== grant.issuerId || intentParts.length !== 6 || intentParts[1] !== grant.recipientId || intentParts[2] !== grant.action || intentParts[3] !== grant.expiresAt-grant.createdAt || intentParts[4] !== grant.reason || Number(intentParts[5])+1 !== row.accepted_version || grant.createdVersion !== row.accepted_version
      : intentParts[0] !== 'revoke' || intentParts.length !== 4 || intentParts[1] !== grant.id || Number(intentParts[3])+1 !== row.accepted_version || grant.revocation?.actorId !== authority.userId || grant.revocation?.operationId !== operationId || grant.revocation?.intent !== intent || grant.revocation?.acceptedVersion !== row.accepted_version)) fail('TEMPORARY_ACCESS_STATE','Temporary access receipt is not bound to its accepted grant.',503);
    return {grant:publicGrant(grant,at),acceptedVersion:Number(row.accepted_version)};
  };
  const saveReceipt = (projectId: string, authority: TemporaryAccessAuthority, operationId: string, intent: string, grantId: string, acceptedVersion: number, at: number) => {
    capacity('clank_platform_temporary_access_receipts',maxReceipts);
    const write = sql.prepare('INSERT INTO clank_platform_temporary_access_receipts VALUES(?,?,?,?,?,?)').run(projectId,authority.userId,operationId,intent,grantId,acceptedVersion);
    const saved = receipt(projectId,authority,operationId,intent,at);
    if (Number(write.changes) !== 1 || !saved || saved.grant.id !== grantId || saved.acceptedVersion !== acceptedVersion) fail('TEMPORARY_ACCESS_WRITE', 'Temporary access receipt was not stored.', 503);
    return saved!;
  };
  return {
    read(projectId: string, authority: TemporaryAccessAuthority): TemporaryAccessSnapshot {return atomic(() => {const current = caller(projectId,authority,false), at = clock();expire(projectId,at);const rows = sql.prepare('SELECT * FROM clank_platform_temporary_access_grants WHERE project_id=? ORDER BY id LIMIT 101').all(projectId);if (rows.length > 100) fail('TEMPORARY_ACCESS_CAPACITY', 'Temporary access inventory exceeds its bound.');const snapshot={projectId,version:currentVersion(projectId),observedAt:at,grants:rows.map(stored).filter(grant => ['owner','admin'].includes(current.role) || grant.recipientId === authority.userId).map(grant => publicGrant(grant,at))};if(new TextEncoder().encode(JSON.stringify({ok:true,snapshot})).byteLength>65536)fail('TEMPORARY_ACCESS_CAPACITY','Grant inventory exceeds the bounded response size.');return snapshot;});},
    create(projectId: string, authority: TemporaryAccessAuthority, input: TemporaryAccessCreate): TemporaryAccessResult {
      const body = exact(input,['recipientId','action','durationMs','reason','expectedVersion','operationId']);const recipientId = id(body.recipientId),operationId = id(body.operationId),expected = version(body.expectedVersion),why = reason(body.reason);
      if (body.action !== 'preview.create' || !Number.isSafeInteger(body.durationMs) || Number(body.durationMs) < 1000 || Number(body.durationMs) > 3600000) fail('TEMPORARY_ACCESS_INPUT', 'Only preview creation for 1 second to 1 hour is supported.', 422);
      const intent = JSON.stringify(['create',recipientId,'preview.create',body.durationMs,why,expected]);
      return atomic(() => {const issuer = caller(projectId,authority,true,true),at = clock();expire(projectId,at);const replay = receipt(projectId,authority,operationId,intent,at);if (replay) return replay;const recipient = member(projectId,recipientId);if (recipient.organizationId !== issuer.organizationId || recipientId === authority.userId) fail('TEMPORARY_ACCESS_INPUT', 'Select another current member of this project.', 422);
        capacity('clank_platform_temporary_access_grants',maxGrants);if (Number(sql.prepare('SELECT count(*) AS n FROM clank_platform_temporary_access_grants WHERE project_id=?').get(projectId)?.n) >= 100) fail('TEMPORARY_ACCESS_CAPACITY', 'This project has retained 100 grants.');
        const grant: StoredGrant = {id:'elevation_'+crypto.randomUUID().replaceAll('-',''),projectId,organizationId:issuer.organizationId,issuerId:authority.userId,recipientId,action:'preview.create',reason:why,createdAt:at,expiresAt:at+Number(body.durationMs),version:1,state:'active',issuerMembership:pin(issuer),recipientMembership:pin(recipient),policyVersion:issuer.policyVersion,createdVersion:expected+1};
        const accepted = bump(projectId,expected),encoded = JSON.stringify(grant);const write = sql.prepare('INSERT INTO clank_platform_temporary_access_grants VALUES(?,?,?,?,?,?,?)').run(grant.id,projectId,grant.organizationId,grant.issuerId,recipientId,'active',encoded);
        if (Number(write.changes) !== 1 || sql.prepare('SELECT record FROM clank_platform_temporary_access_grants WHERE id=?').get(grant.id)?.record !== encoded) fail('TEMPORARY_ACCESS_WRITE', 'Temporary access grant was not stored.', 503);
        authority.assertCurrent(true);options.audit(authority.userId,projectId,'temporary-access.create',{grantId:grant.id,recipientId,action:grant.action,reason:why,expiresAt:grant.expiresAt,acceptedVersion:accepted});return saveReceipt(projectId,authority,operationId,intent,grant.id,accepted,at);
      });
    },
    revoke(projectId: string, authority: TemporaryAccessAuthority, input: TemporaryAccessRevoke): TemporaryAccessResult {
      const body = exact(input,['grantId','reason','expectedVersion','operationId']);const grantId = id(body.grantId),operationId = id(body.operationId),expected = version(body.expectedVersion),why = reason(body.reason),intent = JSON.stringify(['revoke',grantId,why,expected]);
      return atomic(() => {caller(projectId,authority,true,true);const at = clock();expire(projectId,at);const replay = receipt(projectId,authority,operationId,intent,at);if (replay) return replay;const grant = grantFor(grantId);if (grant.projectId !== projectId) fail('TEMPORARY_ACCESS_NOT_FOUND','Temporary access grant not found.',404);if (grant.state !== 'active') fail('TEMPORARY_ACCESS_INACTIVE','This grant is already inactive. Read its current state.');const accepted = bump(projectId,expected),record = JSON.stringify({...grant,state:'revoked',version:grant.version+1,revocation:{actorId:authority.userId,operationId,intent,acceptedVersion:accepted}});const write = sql.prepare('UPDATE clank_platform_temporary_access_grants SET state=\'revoked\',record=? WHERE id=? AND record=?').run(record,grantId,sql.prepare('SELECT record FROM clank_platform_temporary_access_grants WHERE id=?').get(grantId)?.record);if (Number(write.changes) !== 1 || sql.prepare('SELECT record FROM clank_platform_temporary_access_grants WHERE id=?').get(grantId)?.record !== record) fail('TEMPORARY_ACCESS_WRITE','Grant revocation was not stored.',503);authority.assertCurrent(true);options.audit(authority.userId,projectId,'temporary-access.revoke',{grantId,reason:why,acceptedVersion:accepted});return saveReceipt(projectId,authority,operationId,intent,grantId,accepted,at);});
    },
    capture(projectId: string, authority: TemporaryAccessAuthority, grantId: string): () => void {
      id(grantId);const captured = atomic(() => {caller(projectId,authority,true);const at = clock();expire(projectId,at);const grant = grantFor(grantId);if (grant.projectId !== projectId || grant.recipientId !== authority.userId || !active(grant,at)) fail('TEMPORARY_ACCESS_DENIED','This preview creation grant is unavailable.',403);return JSON.stringify(grant);});
      return () => {atomic(() => {caller(projectId,authority,true);const at = clock();expire(projectId,at);const grant = grantFor(grantId);if (JSON.stringify(grant) !== captured || !active(grant,at)) fail('TEMPORARY_ACCESS_DENIED','Temporary access changed before preview creation.',403);});};
    },
    close() {closed = true;},
  };
}
