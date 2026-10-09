import { AuthError, type AuthRuntime, type AuthUserId } from "./auth.ts";
import type { SQLiteDatabase } from "./backend.ts";
import { readJsonRequest, readRequestBytes, RequestInputError } from "./security.ts";
import { SQLITE_INTERNAL, type SQLiteInternal, type SQLiteInternalChangeRecorder } from "./sqlite-internal.ts";
import { createHash } from "node:crypto";

export interface OrganizationProvisioningPolicy {
  /** Separate expiring SCIM credential; never an OIDC or offboarding credential. */
  readonly token: string;
  readonly expiresAt: number;
  readonly groupRoles?: readonly { readonly externalId: string; readonly role: "viewer" | "developer" }[];
}
export interface OrganizationProvisioningAssignment {
  readonly resourceId: string;
  readonly active: boolean;
  /** An explicit SCIM disable/delete, distinct from a pending or independently unlinked binding. */
  readonly deactivated: boolean;
  readonly role: "viewer" | "developer" | null;
}

export interface OrganizationSsoProvider {
  readonly organizationId: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  /** Exact additional origins hosting this issuer's authorization/token/JWKS endpoints. */
  readonly endpointOrigins?: readonly string[];
  /** A separate server-to-server secret used by the offboarding endpoint; at least 32 characters. */
  readonly offboardingToken: string;
  /** Opt-in organization-scoped SCIM; requires a current identityLinking revision. */
  readonly provisioning?: OrganizationProvisioningPolicy;
  readonly profile?: (claims: Readonly<Record<string, unknown>>) => object;
}
export interface OrganizationSsoOptions {
  readonly applicationOrigin: string;
  readonly providers: readonly OrganizationSsoProvider[];
  readonly prefix?: string;
  /** Opt-in policy; increase revision whenever provider configuration or linking policy changes. */
  readonly identityLinking?: { readonly policyRevision: number; readonly maxActiveIdentities?: number; readonly maxRetainedIdentities?: number };
  /** HTTP is allowed only for numeric loopback development fixtures, never arbitrary hosts. */
  readonly allowInsecureLoopback?: boolean;
  /** Synchronous hooks share the identity/offboarding transaction. */
  readonly onProvision?: (userId: string, organizationId: string) => void;
  readonly onOffboard?: (userId: string, organizationId: string, context?: { accountMode: "dedicated" | "linked"; reason: "offboard" | "unlink" }) => void;
  /** Required for provisioning; preserve manual assignment ownership in this synchronous transaction. */
  readonly onProvisioning?: (userId: string, organizationId: string, assignment: OrganizationProvisioningAssignment) => undefined;
}
export interface OrganizationIdentity { readonly id: string; readonly organizationId: string; readonly issuer: string; readonly subject: string; readonly active: boolean; readonly version: number; readonly linkedAt: number; }
export interface OrganizationIdentityInventory { readonly enabled: boolean; readonly policyRevision: number | null; readonly providers: readonly { organizationId: string; issuer: string }[]; readonly identities: readonly OrganizationIdentity[]; }
export interface OrganizationIdentityUnlink { readonly identityId: string; readonly expectedVersion: number; readonly idempotencyKey: string; }
export interface OrganizationSso {
  handles(request: Request): boolean;
  handle(request: Request): Promise<Response>;
  /** Server-only current assignment lookup; the caller must authorize its own administrative API. */
  provisioningAssignment?(userId: string, organizationId: string): OrganizationProvisioningAssignment | null;
}

/** OIDC authorization-code+PKCE sign-in with durable issuer/subject bindings and atomic offboarding. */
export function openOrganizationSso(database: SQLiteDatabase<any>, auth: AuthRuntime<any>, options: OrganizationSsoOptions): OrganizationSso {
  const sql = database[SQLITE_INTERNAL], prefix = options.prefix ?? "/__clank/sso";
  if (!/^\/[A-Za-z0-9_/-]+$/u.test(prefix) || prefix.endsWith("/") || prefix.includes("//")) throw new TypeError("Invalid SSO prefix.");
  const applicationOrigin = endpoint(options.applicationOrigin, options.allowInsecureLoopback).origin;
  if (applicationOrigin !== options.applicationOrigin) throw new TypeError("Use an exact application origin.");
  const providers = new Map(options.providers.map(provider => {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(provider.organizationId) || !provider.clientId || provider.clientId.length > 256 || !provider.offboardingToken || provider.offboardingToken.length < 32 || provider.offboardingToken.length > 1024) throw new TypeError("Invalid organization SSO configuration.");
    const issuer = endpoint(provider.issuer, options.allowInsecureLoopback);
    if (issuer.search || issuer.hash) throw new TypeError("SSO issuer cannot contain query or fragment.");
    const allowed = new Set([issuer.origin, ...(provider.endpointOrigins ?? []).map(value => { const url = endpoint(value, options.allowInsecureLoopback); if (url.origin !== value) throw new TypeError("Use exact SSO endpoint origins."); return url.origin; })]);
    const provisioning = normalizeProvisioningPolicy(provider.provisioning, provider);
    return [provider.organizationId, { ...provider, provisioning, allowed }] as const;
  }));
  if (!providers.size || providers.size !== options.providers.length || providers.size > 100) throw new TypeError("Configure 1–100 unique organization SSO providers.");
  const linking = options.identityLinking ? Object.freeze({...options.identityLinking}) : undefined;
  const maxActive = linking?.maxActiveIdentities ?? 10, maxRetained = linking?.maxRetainedIdentities ?? 50;
  if (linking && (!Number.isSafeInteger(linking.policyRevision) || linking.policyRevision < 1
    || !Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 10
    || !Number.isSafeInteger(maxRetained) || maxRetained < maxActive || maxRetained > 100)) throw new TypeError("Invalid identity-linking policy.");
  if ([...providers.values()].some(provider => provider.provisioning)
    && (!linking || typeof options.onProvisioning !== "function")) throw new TypeError("Provisioning requires a current identity-linking revision and a synchronous membership hook.");
  const publicConfiguration = JSON.stringify([applicationOrigin, prefix, maxActive, maxRetained,
    [...providers.values()].map(provider => [provider.organizationId, provider.issuer, provider.clientId, [...provider.allowed].sort(),
      ...(provider.provisioning ? [["scim", provider.provisioning.expiresAt, createHash("sha256").update(provider.provisioning.token).digest("hex"), provider.provisioning.groupRoles]] : [])]).sort((a,b) => String(a[0]).localeCompare(String(b[0])))]);
  // Transactional table replacement removes the legacy global user UNIQUE constraint.
  // Original issuer/subject ownership, revocations and audit rows are retained.
  const initializeIdentity = () => {
    sql.exec(`CREATE TABLE IF NOT EXISTS clank_sso_identities (organization TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      user_id TEXT NOT NULL UNIQUE REFERENCES clank_auth_users(id) ON DELETE CASCADE, active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(organization, issuer, subject))`);
    if (!sql.prepare("PRAGMA table_info(clank_sso_identities)").all().some(column => column.name === "id")) {
      sql.exec(`CREATE TABLE clank_sso_identities_upgrade (id TEXT NOT NULL UNIQUE, organization TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE, active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1, linked_at INTEGER NOT NULL, PRIMARY KEY(organization,issuer,subject))`);
      sql.exec(`INSERT INTO clank_sso_identities_upgrade SELECT 'sso_'||lower(hex(randomblob(16))), organization,issuer,subject,user_id,active,1,0 FROM clank_sso_identities`);
      sql.exec("DROP TABLE clank_sso_identities; ALTER TABLE clank_sso_identities_upgrade RENAME TO clank_sso_identities");
    }
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS clank_sso_active_organization_user ON clank_sso_identities(organization,user_id) WHERE active=1");
    sql.exec(`CREATE TABLE IF NOT EXISTS clank_sso_states (state TEXT PRIMARY KEY, organization TEXT NOT NULL, browser TEXT NOT NULL,
      nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0)`);
    const columns = sql.prepare("PRAGMA table_info(clank_sso_states)").all();
    for (const [name,type] of Object.entries({user_id:"TEXT",session_id:"TEXT",created_at:"INTEGER",configuration:"TEXT",generation:"INTEGER",code_hash:"TEXT",identity_id:"TEXT",identity_version:"INTEGER"})) {
      if (!columns.some(column => column.name === name)) sql.exec(`ALTER TABLE clank_sso_states ADD COLUMN ${name} ${type}`);
    }
    sql.exec("CREATE TABLE IF NOT EXISTS clank_sso_accounts (user_id TEXT PRIMARY KEY REFERENCES clank_auth_users(id) ON DELETE CASCADE, linked INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0)");
    sql.exec("CREATE TABLE IF NOT EXISTS clank_sso_policy (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, enabled INTEGER NOT NULL, configuration TEXT NOT NULL)");
    const policy = sql.prepare("SELECT * FROM clank_sso_policy WHERE singleton=1").get();
    if (linking && policy && (Number(policy.revision) > linking.policyRevision || Number(policy.revision) === linking.policyRevision && String(policy.configuration) !== publicConfiguration)) throw new TypeError("Increase identity-linking policyRevision before changing configuration.");
    if (linking) sql.prepare("INSERT INTO clank_sso_policy VALUES(1,?,1,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,enabled=1,configuration=excluded.configuration").run(linking.policyRevision,publicConfiguration);
    else if (policy) sql.prepare("UPDATE clank_sso_policy SET enabled=0 WHERE singleton=1").run();
    sql.exec("CREATE TABLE IF NOT EXISTS clank_sso_unlinks (user_id TEXT NOT NULL, key TEXT NOT NULL, input TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(user_id,key))");
    sql.exec("CREATE TABLE IF NOT EXISTS clank_sso_revocations (organization TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(organization, issuer, subject))");
    sql.exec(`CREATE TABLE IF NOT EXISTS clank_sso_events (id INTEGER PRIMARY KEY AUTOINCREMENT, organization TEXT NOT NULL, user_id TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL)`);
  };
  const policyCurrent = () => {
    const policy = sql.prepare("SELECT * FROM clank_sso_policy WHERE singleton=1").get();
    return Boolean(linking && policy && Number(policy.enabled)===1 && Number(policy.revision)===linking.policyRevision && policy.configuration===publicConfiguration);
  };
  const requirePolicy = () => { if(!policyCurrent()) throw new AuthError("SSO_LINKING_DISABLED","Identity linking is disabled or its policy changed.",403); };
  const currentBrowser = async (request: Request, fresh = false) => {
    if (request.headers.has("authorization")) throw new AuthError("UNAUTHENTICATED","A live browser session is required.",401);
    const context = await auth.resolve(request);
    if (!context.user || !context.session) throw new AuthError("UNAUTHENTICATED","A live browser session is required.",401);
    return fresh ? auth.requireFreshAuthentication(context,300_000) : context;
  };
  const currentLinkBrowser = async (request: Request, row: Record<string,unknown>) => {
    requirePolicy(); const context = await currentBrowser(request,true);
    if (context.user!.id!==row.user_id || context.session!.id!==row.session_id) throw new AuthError("SSO_STATE","Linking must finish in its original verified browser session.",403);
    const provider=providers.get(String(row.organization));
    if(!provider || row.configuration!==await hash(JSON.stringify([publicConfiguration,linking!.policyRevision,provider.clientSecret??""]))) throw new AuthError("SSO_POLICY","Identity provider configuration changed during verification.",409);
    requirePolicy();return auth.requireFreshAuthentication(context,300_000);
  };
  const identity = (row: Record<string,unknown>): OrganizationIdentity => ({id:String(row.id),organizationId:String(row.organization),issuer:String(row.issuer),subject:String(row.subject),active:Number(row.active)===1,version:Number(row.version),linkedAt:Number(row.linked_at)});
  const revoke = (id: string) => {
    sql.prepare("DELETE FROM clank_auth_sessions WHERE user_id=?").run(id);
    sql.prepare("DELETE FROM clank_auth_tokens WHERE user_id=?").run(id);
    sql.prepare("DELETE FROM clank_auth_mfa_challenges WHERE user_id=?").run(id);
    if (sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='clank_oauth_tokens'").get()) sql.prepare("UPDATE clank_oauth_tokens SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL").run(Date.now(),id);
  };
  const advance = (id: string, linked = false) => sql.prepare("INSERT INTO clank_sso_accounts(user_id,linked,generation) VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET linked=max(linked,excluded.linked),generation=generation+1").run(id,linked?1:0);
  const fallback = (id: string, excluded: string) => {
    if (auth.definition.passkeys.enabled && sql.prepare("SELECT 1 FROM clank_auth_passkeys WHERE user_id=? LIMIT 1").get(id)) return true;
    const password = String(sql.prepare("SELECT password_hash FROM clank_auth_users WHERE id=? AND disabled=0").get(id)?.password_hash ?? "").split("$");
    if (password.length===6 && password[0]==="scrypt" && password[4]!.length<=128 && password[5]!.length<=256) {
      const cost=Number(password[1]),block=Number(password[2]),parallel=Number(password[3]);
      try { if (Number.isSafeInteger(cost) && cost>=2 && cost<=2**20 && (cost&(cost-1))===0 && Number.isSafeInteger(block) && block>=1 && block<=32 && Number.isSafeInteger(parallel) && parallel>=1 && parallel<=16 && decode(password[4]!).length>=16 && decode(password[4]!).length<=64 && decode(password[5]!).length===64) return true; } catch { /* malformed credentials are not a recovery method */ }
    }
    return sql.prepare("SELECT * FROM clank_sso_identities WHERE user_id=? AND id<>? AND active=1").all(id,excluded).some(row => providers.get(String(row.organization))?.issuer===row.issuer && !sql.prepare("SELECT 1 FROM clank_sso_revocations WHERE organization=? AND issuer=? AND subject=?").get(row.organization,row.issuer,row.subject));
  };
  const callback = `${applicationOrigin}${prefix}/callback`;
  const cookieName = applicationOrigin.startsWith("https:") ? "__Host-clank-sso" : "clank-sso";
  const cookie = (value: string, age = 600) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${applicationOrigin.startsWith("https:") ? "; Secure" : ""}`;
  const trustedEndpoint = (input: unknown, provider: { allowed: Set<string> }) => {
    if (typeof input !== "string") throw new Error("Missing OIDC endpoint.");
    const url = endpoint(input, options.allowInsecureLoopback);
    if (!provider.allowed.has(url.origin)) throw new Error("OIDC endpoint origin is not allowlisted.");
    return url;
  };
  const discovery = async (provider: (typeof providers extends Map<any, infer P> ? P : never)) => {
    const document = await networkJson(new URL(`${provider.issuer.replace(/\/$/u, "")}/.well-known/openid-configuration`), undefined, options.allowInsecureLoopback);
    if (document.issuer !== provider.issuer || !Array.isArray(document.response_types_supported) || !document.response_types_supported.includes("code") || !Array.isArray(document.id_token_signing_alg_values_supported) || !document.id_token_signing_alg_values_supported.some((value: unknown) => value === "RS256" || value === "ES256")) throw new Error("OIDC discovery does not match the configured issuer.");
    return { authorization: trustedEndpoint(document.authorization_endpoint, provider), token: trustedEndpoint(document.token_endpoint, provider), keys: trustedEndpoint(document.jwks_uri, provider) };
  };
  const audit = (organization: string, user: string, event: string) => {
    sql.prepare("INSERT INTO clank_sso_events(organization, user_id, event, at) VALUES (?, ?, ?, ?)").run(organization, user, event, Date.now());
    sql.prepare("DELETE FROM clank_sso_events WHERE id NOT IN (SELECT id FROM clank_sso_events ORDER BY id DESC LIMIT 10000)").run();
  };
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
  const scim = openScim(sql, providers, applicationOrigin, {
    initialize: initializeIdentity,
    currentPolicy: policyCurrent,
    membership(userId, organizationId, assignment) { sync(options.onProvisioning?.(userId, organizationId, assignment)); },
    deactivate(userId, changes) {
      if (sql.prepare("SELECT 1 FROM clank_auth_users WHERE id=?").get(userId)) {
        advance(userId, true); revoke(userId); changes.record("__auth", userId, userId);
      }
    },
    notify(userId) { auth.notifyUserChange(userId as AuthUserId); },
  });
  return {
    provisioningAssignment(userId, organizationId) { return scim.assignment(userId, organizationId); },
    handles(request) { const path = new URL(request.url).pathname; return path === prefix || path.startsWith(`${prefix}/`) || scim.handles(path); },
    async handle(request) {
      if (scim.handles(new URL(request.url).pathname)) return scim.handle(request);
      try {
        const url = new URL(request.url);
        if (url.origin !== applicationOrigin) throw new AuthError("SSO_ORIGIN", "Invalid SSO application origin.", 400);
        const start = new RegExp(`^${prefix}/start/([A-Za-z0-9_-]{1,128})$`, "u").exec(url.pathname);
        const offboard = new RegExp(`^${prefix}/offboard/([A-Za-z0-9_-]{1,128})$`, "u").exec(url.pathname);
        const link = new RegExp(`^${prefix}/link/([A-Za-z0-9_-]{1,128})$`, "u").exec(url.pathname);
        if (url.pathname===`${prefix}/identities` && request.method==="GET") {
          const context=await currentBrowser(request);
          return Response.json({ok:true,enabled:policyCurrent(),policyRevision:linking?.policyRevision??null,
            providers:policyCurrent()?[...providers.values()].map(provider=>({organizationId:provider.organizationId,issuer:provider.issuer})):[],identities:sql.prepare("SELECT * FROM clank_sso_identities WHERE user_id=? ORDER BY organization,id LIMIT 100").all(context.user!.id).map(identity)}, {headers});
        }
        if (url.pathname===`${prefix}/unlink` && request.method==="POST") {
          requirePolicy(); const context=await currentBrowser(request,true);
          if (request.headers.get("origin")!==applicationOrigin) throw new AuthError("INVALID_ORIGIN","Use the application origin.",403);
          await auth.verifyCsrf(request,context);
          const input=await readJsonRequest(request,8192) as OrganizationIdentityUnlink;
          if (!input || typeof input.identityId!=="string" || !/^sso_[a-f0-9]{32}$/u.test(input.identityId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion<1 || typeof input.idempotencyKey!=="string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(input.idempotencyKey) || Object.keys(input).some(key=>!["identityId","expectedVersion","idempotencyKey"].includes(key))) throw new AuthError("INVALID_INPUT","Provide an identity, current version and stable retry key.",422);
          const exact=JSON.stringify([input.identityId,input.expectedVersion]); let changed=false;
          const receipt=sql.transaction(changes=>{
            requirePolicy(); const current=auth.requireFreshAuthentication(context,300_000),id=current.user!.id;
            const previous=sql.prepare("SELECT input,receipt FROM clank_sso_unlinks WHERE user_id=? AND key=?").get(id,input.idempotencyKey);
            if (previous) {if (previous.input!==exact) throw new AuthError("SSO_RETRY_CONFLICT","This retry key belongs to another unlink.",409);return JSON.parse(String(previous.receipt));}
            const row=sql.prepare("SELECT * FROM clank_sso_identities WHERE id=? AND user_id=?").get(input.identityId,id);
            if (!row) throw new AuthError("SSO_NOT_FOUND","Identity not found.",404);
            if (Number(row.version)!==input.expectedVersion || Number(row.active)!==1) throw new AuthError("SSO_VERSION","Refresh the current identity before unlinking.",409);
            if (!fallback(id,input.identityId)) throw new AuthError("SSO_LAST_IDENTITY","Keep a usable local credential or another organization identity before unlinking.",409);
            if (Number(sql.prepare("SELECT count(*) AS n FROM clank_sso_unlinks WHERE user_id=?").get(id)!.n)>=100) throw new AuthError("SSO_CAPACITY","Retained unlink capacity is full.",409);
            sql.prepare("UPDATE clank_sso_identities SET active=0,version=version+1 WHERE id=?").run(row.id);
            advance(id,true); sync(options.onOffboard?.(id,String(row.organization),{accountMode:"linked",reason:"unlink"}));revoke(id);
            changes.record("__auth",id,id);audit(String(row.organization),id,"unlinked");changed=true;
            const result={ok:true,identity:identity({...row,active:0,version:Number(row.version)+1}),signedOut:true};
            sql.prepare("INSERT INTO clank_sso_unlinks VALUES(?,?,?,?)").run(id,input.idempotencyKey,exact,JSON.stringify(result));return result;
          });
          if(changed) auth.notifyUserChange(context.user!.id);return Response.json(receipt,{headers});
        }
        if (link && request.method==="POST") {
          requirePolicy();const context=await currentBrowser(request,true);
          if(request.headers.get("origin")!==applicationOrigin) throw new AuthError("INVALID_ORIGIN","Use the application origin.",403);
          await auth.verifyCsrf(request,context);
          const input=await readJsonRequest(request,8192);if(!input || typeof input!=="object" || Array.isArray(input) || Object.keys(input).length) throw new AuthError("INVALID_INPUT","Identity linking accepts an empty object.",422);
          const provider=providers.get(link[1]!);if(!provider) throw new AuthError("SSO_NOT_FOUND","SSO provider not found.",404);
          const metadata=await discovery(provider),state=random(),browser=random(),nonce=random(),verifier=random();
          const [challenge,stateHash,browserHash,configuration]=await Promise.all([hash(verifier),hash(state),hash(browser),hash(JSON.stringify([publicConfiguration,linking!.policyRevision,provider.clientSecret??""]))]);
          const expires=Date.now()+600_000;
          sql.transaction(()=>{
            requirePolicy();const current=auth.requireFreshAuthentication(context,300_000),id=current.user!.id;
            sql.prepare("DELETE FROM clank_sso_states WHERE expires<=?").run(Date.now());
            if(Number(sql.prepare("SELECT count(*) AS n FROM clank_sso_states").get()!.n)>=1000 || Number(sql.prepare("SELECT count(*) AS n FROM clank_sso_states WHERE user_id=?").get(id)!.n)>=10) throw new AuthError("SSO_BUSY","Identity verification capacity is full.",503);
            if(sql.prepare("SELECT 1 FROM clank_sso_identities WHERE organization=? AND user_id=? AND active=1").get(provider.organizationId,id)) throw new AuthError("SSO_ALREADY_LINKED","An active identity already exists for this organization.",409);
            if(Number(sql.prepare("SELECT count(*) AS n FROM clank_sso_identities WHERE user_id=? AND active=1").get(id)!.n)>=maxActive) throw new AuthError("SSO_CAPACITY","Active identity capacity is full.",409);
            sql.prepare("INSERT INTO clank_sso_states(state,organization,browser,nonce,verifier,expires,user_id,session_id,created_at,configuration,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(stateHash,provider.organizationId,browserHash,nonce,verifier,expires,id,current.session!.id,Date.now(),configuration,sql.prepare("SELECT generation FROM clank_sso_accounts WHERE user_id=?").get(id)?.generation??0);
          });
          metadata.authorization.search=new URLSearchParams({response_type:"code",client_id:provider.clientId,redirect_uri:callback,scope:"openid email profile",state,nonce,code_challenge:challenge,code_challenge_method:"S256",prompt:"login",max_age:"0"}).toString();
          return Response.json({ok:true,authorizationUrl:metadata.authorization.href,expiresAt:expires},{headers:{...headers,"set-cookie":cookie(browser)}});
        }
        if (start && request.method === "GET") {
          const provider = providers.get(start[1]!); if (!provider) throw new AuthError("SSO_NOT_FOUND", "SSO provider not found.", 404);
          const metadata = await discovery(provider), state = random(), browser = random(), nonce = random(), verifier = random();
          const challenge = await hash(verifier), stateHash = await hash(state), browserHash = await hash(browser);
          sql.transaction(() => {
            sql.prepare("DELETE FROM clank_sso_states WHERE expires <= ?").run(Date.now());
            if (Number(sql.prepare("SELECT COUNT(*) AS n FROM clank_sso_states").get()!.n) >= 1000) throw new AuthError("SSO_BUSY", "SSO sign-in capacity is full.", 503);
            sql.prepare("INSERT INTO clank_sso_states(state, organization, browser, nonce, verifier, expires) VALUES (?, ?, ?, ?, ?, ?)").run(stateHash, provider.organizationId, browserHash, nonce, verifier, Date.now() + 600_000);
          });
          metadata.authorization.search = new URLSearchParams({ response_type: "code", client_id: provider.clientId, redirect_uri: callback, scope: "openid email profile", state, nonce, code_challenge: challenge, code_challenge_method: "S256" }).toString();
          return new Response(null, { status: 303, headers: { ...headers, location: metadata.authorization.href, "set-cookie": cookie(browser) } });
        }
        if (request.method === "GET" && url.pathname === `${prefix}/callback`) {
          if (url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length !== 1) throw new AuthError("SSO_CALLBACK", "Invalid SSO callback.", 400);
          const state = url.searchParams.get("state")!, code = url.searchParams.get("code")!;
          if (!/^[A-Za-z0-9_-]{43}$/u.test(state) || !code || code.length > 4096) throw new AuthError("SSO_CALLBACK", "Invalid SSO callback.", 400);
          const browser = request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
          if (!browser || !/^[A-Za-z0-9_-]{43}$/u.test(browser)) throw new AuthError("SSO_STATE", "SSO browser binding is missing.", 400);
          const stateHash = await hash(state), browserHash = await hash(browser), codeHash = await hash(code);
          const stored = sql.prepare("SELECT * FROM clank_sso_states WHERE state=? AND browser=? AND expires>?").get(stateHash,browserHash,Date.now());
          if (stored?.user_id) {
            await currentLinkBrowser(request,stored);
            if (stored.identity_id) {
              const accepted=sql.prepare("SELECT * FROM clank_sso_identities WHERE id=? AND user_id=? AND active=1 AND version=?").get(stored.identity_id,stored.user_id,stored.identity_version);
              if(stored.code_hash!==codeHash || !accepted) throw new AuthError("SSO_STATE","The accepted identity receipt is stale or does not match this callback.",409);
              scim.guardSubject(String(accepted.organization),String(accepted.issuer),String(accepted.subject));
              return new Response(null,{status:303,headers:{...headers,location:`${applicationOrigin}/`}});
            }
          }
          const row = sql.transaction(() => {
            const stored = sql.prepare("SELECT * FROM clank_sso_states WHERE state = ? AND browser = ? AND consumed = 0 AND expires > ?").get(stateHash, browserHash, Date.now());
            if (!stored) throw new AuthError("SSO_STATE", "SSO state expired or was already used.", 400);
            sql.prepare("UPDATE clank_sso_states SET consumed = 1 WHERE state = ?").run(stateHash); return stored;
          });
          const provider = providers.get(String(row.organization)); if (!provider) throw new AuthError("SSO_NOT_FOUND", "SSO provider not found.", 404);
          if(row.user_id) await currentLinkBrowser(request,row);
          const metadata = await discovery(provider);
          const token = await networkJson(metadata.token, new URLSearchParams({ grant_type: "authorization_code", client_id: provider.clientId, ...(provider.clientSecret ? { client_secret: provider.clientSecret } : {}), redirect_uri: callback, code, code_verifier: String(row.verifier) }).toString(), options.allowInsecureLoopback);
          const keys = await networkJson(metadata.keys, undefined, options.allowInsecureLoopback);
          const claims = await verifyIdToken(token.id_token, keys, provider.issuer, provider.clientId, String(row.nonce));
          const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
          if (claims.email_verified !== true || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new AuthError("SSO_EMAIL", "A verified email is required.", 403);
          if(row.user_id) {
            const now=Math.floor(Date.now()/1000);
            if(!Number.isSafeInteger(claims.auth_time) || Number(claims.auth_time)<Math.floor(Number(row.created_at)/1000)-30 || Number(claims.auth_time)>now+30 || Number(claims.auth_time)<=now-300) throw new AuthError("SSO_FRESH_PROVIDER","A fresh provider authentication is required.",403);
            const context=await currentLinkBrowser(request,row);
            sql.transaction(changes=>{
              requirePolicy();const current=auth.requireFreshAuthentication(context,300_000),id=current.user!.id;
              if(Number(row.expires)<=Date.now() || Number(sql.prepare("SELECT generation FROM clank_sso_accounts WHERE user_id=?").get(id)?.generation??0)!==Number(row.generation)) throw new AuthError("SSO_STATE","Account identities changed during verification.",409);
              if(sql.prepare("SELECT 1 FROM clank_sso_revocations WHERE organization=? AND issuer=? AND subject=?").get(provider.organizationId,provider.issuer,claims.sub)) throw new AuthError("SSO_OFFBOARDED","This organization identity has been offboarded.",403);
              scim.guardSubject(provider.organizationId,provider.issuer,String(claims.sub));
              if(sql.prepare("SELECT 1 FROM clank_sso_identities WHERE issuer=? AND subject=? AND user_id<>?").get(provider.issuer,claims.sub,id)) throw new AuthError("SSO_IDENTITY_COLLISION","This provider identity belongs to another account.",409);
              const existing=sql.prepare("SELECT * FROM clank_sso_identities WHERE organization=? AND issuer=? AND subject=?").get(provider.organizationId,provider.issuer,claims.sub);
              if(sql.prepare("SELECT 1 FROM clank_sso_identities WHERE organization=? AND user_id=? AND active=1").get(provider.organizationId,id)) throw new AuthError("SSO_ALREADY_LINKED","An active identity already exists for this organization.",409);
              if(Number(sql.prepare("SELECT count(*) AS n FROM clank_sso_identities WHERE user_id=? AND active=1").get(id)!.n)>=maxActive || !existing && Number(sql.prepare("SELECT count(*) AS n FROM clank_sso_identities WHERE user_id=?").get(id)!.n)>=maxRetained) throw new AuthError("SSO_CAPACITY","Identity capacity is full.",409);
              const identityId=existing?String(existing.id):`sso_${crypto.randomUUID().replaceAll("-","")}`,version=existing?Number(existing.version)+1:1;
              if(existing) sql.prepare("UPDATE clank_sso_identities SET active=1,version=?,linked_at=? WHERE id=?").run(version,Date.now(),identityId);
              else sql.prepare("INSERT INTO clank_sso_identities(id,organization,issuer,subject,user_id,version,linked_at) VALUES(?,?,?,?,?,?,?)").run(identityId,provider.organizationId,provider.issuer,claims.sub,id,version,Date.now());
              advance(id,true);if (!scim.bind(provider.organizationId,provider.issuer,String(claims.sub),id)) sync(options.onProvision?.(id,provider.organizationId));
              sql.prepare("UPDATE clank_sso_states SET identity_id=?,identity_version=?,code_hash=? WHERE state=? AND consumed=1").run(identityId,version,codeHash,stateHash);
              changes.record("__auth",id,id);audit(provider.organizationId,id,"linked");
            });
            return new Response(null,{status:303,headers:{...headers,location:`${applicationOrigin}/`}});
          }
          const userId = sql.transaction(changes => {
            scim.guardSubject(provider.organizationId,provider.issuer,String(claims.sub));
            if (sql.prepare("SELECT 1 FROM clank_sso_revocations WHERE organization = ? AND issuer = ? AND subject = ?").get(provider.organizationId, provider.issuer, claims.sub)) throw new AuthError("SSO_OFFBOARDED", "This organization identity has been offboarded.", 403);
            const existing = sql.prepare("SELECT * FROM clank_sso_identities WHERE organization = ? AND issuer = ? AND subject = ?").get(provider.organizationId, provider.issuer, claims.sub);
            let userId: string;
            if (existing) {
              userId = String(existing.user_id);
              if (Number(sql.prepare("SELECT disabled FROM clank_auth_users WHERE id = ?").get(userId)?.disabled ?? 1) !== 0
                || Number(existing.active) !== 1 && !scim.mayReactivate(provider.organizationId,provider.issuer,String(claims.sub),existing)) throw new AuthError("SSO_OFFBOARDED", "This organization account has been disabled.", 403);
              if (Number(existing.active)!==1) sql.prepare("UPDATE clank_sso_identities SET active=1,version=version+1,linked_at=? WHERE id=?").run(Date.now(),existing.id);
            } else {
              if(sql.prepare("SELECT 1 FROM clank_sso_identities WHERE issuer=? AND subject=? LIMIT 1").get(provider.issuer,claims.sub)) throw new AuthError("SSO_ACCOUNT_EXISTS","This provider identity already belongs to an account; use explicit verified linking.",409);
              // Verified email alone never links an external identity to an existing local account.
              if (sql.prepare("SELECT 1 FROM clank_auth_users WHERE email = ?").get(email)) throw new AuthError("SSO_ACCOUNT_EXISTS", "An account with this email already exists; contact your administrator.", 409);
              const profile = auth.definition.profile.parse(provider.profile ? provider.profile(claims) : { ...(typeof claims.name === "string" ? { name: claims.name.slice(0, 200) } : {}) });
              userId = random().slice(0, 24); const now = Date.now();
              sql.prepare("INSERT INTO clank_auth_users(id, email, email_verified_at, password_hash, role, profile, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)").run(userId, email, now, `federated:${random()}`, auth.definition.defaultRole, JSON.stringify(profile), now, now);
              sql.prepare("INSERT INTO clank_sso_identities(id, organization, issuer, subject, user_id, linked_at) VALUES (?, ?, ?, ?, ?, ?)").run(`sso_${crypto.randomUUID().replaceAll("-","")}`,provider.organizationId, provider.issuer, claims.sub, userId,now);
            }
            if (scim.bind(provider.organizationId,provider.issuer,String(claims.sub),userId)) advance(userId,true);
            else sync(options.onProvision?.(userId, provider.organizationId));
            changes.record("__auth", userId, userId); audit(provider.organizationId, userId, "login"); return userId;
          });
          const binding=sql.prepare("SELECT id,version FROM clank_sso_identities WHERE organization=? AND issuer=? AND subject=? AND user_id=? AND active=1").get(provider.organizationId,provider.issuer,claims.sub,userId);
          if(!binding) throw new AuthError("SSO_OFFBOARDED","The organization identity is no longer active.",403);
          const generation=Number(sql.prepare("SELECT generation FROM clank_sso_accounts WHERE user_id=?").get(userId)?.generation??0);
          const session = await auth.issueFederatedSession(userId as AuthUserId, request);
          try { scim.guardSubject(provider.organizationId,provider.issuer,String(claims.sub)); }
          catch (error) { auth.revokeUserSessions(userId as AuthUserId); throw error; }
          if(Number(sql.prepare("SELECT generation FROM clank_sso_accounts WHERE user_id=?").get(userId)?.generation??0)!==generation || !sql.prepare("SELECT 1 FROM clank_sso_identities WHERE id=? AND version=? AND active=1").get(binding.id,binding.version) || sql.prepare("SELECT 1 FROM clank_sso_revocations WHERE organization=? AND issuer=? AND subject=?").get(provider.organizationId,provider.issuer,claims.sub)) {
            auth.revokeUserSessions(userId as AuthUserId);throw new AuthError("SSO_OFFBOARDED","This identity changed before the session was published.",403);
          }
          return new Response(null, { status: 303, headers: { ...headers, location: `${applicationOrigin}/`, "set-cookie": session.headers.get("set-cookie")! } });
        }
        if (offboard && request.method === "POST") {
          const provider = providers.get(offboard[1]!); if (!provider) throw new AuthError("SSO_NOT_FOUND", "SSO provider not found.", 404);
          const token = request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
          if (token.length > 1024 || !await equal(token, provider.offboardingToken)) throw new AuthError("UNAUTHENTICATED", "Offboarding authentication failed.", 401);
          const input = await readJsonRequest(request, 8192) as { subject?: unknown };
          if (!input || typeof input.subject !== "string" || !input.subject || input.subject.length > 255) throw new AuthError("INVALID_INPUT", "An exact subject is required.", 422);
          const userId = sql.transaction(changes => {
            sql.prepare("INSERT OR IGNORE INTO clank_sso_revocations(organization, issuer, subject, at) VALUES (?, ?, ?, ?)").run(provider.organizationId, provider.issuer, input.subject, Date.now());
            const row = sql.prepare("SELECT user_id FROM clank_sso_identities WHERE organization = ? AND issuer = ? AND subject = ?").get(provider.organizationId, provider.issuer, input.subject);
            if (!row) { audit(provider.organizationId, "unprovisioned", "offboarded"); return null; }
            const id = String(row.user_id);
            const linked=Number(sql.prepare("SELECT linked FROM clank_sso_accounts WHERE user_id=?").get(id)?.linked??0)===1;
            if(linked) sql.prepare("UPDATE clank_sso_identities SET active=0,version=version+1 WHERE organization=? AND issuer=? AND subject=? AND active=1").run(provider.organizationId,provider.issuer,input.subject);
            else {
              sql.prepare("UPDATE clank_sso_identities SET active=0,version=version+1 WHERE user_id=? AND active=1").run(id);
              sql.prepare("UPDATE clank_auth_users SET disabled=1,updated_at=? WHERE id=?").run(Date.now(),id);
            }
            advance(id);revoke(id);
            sync(options.onOffboard?.(id,provider.organizationId,{accountMode:linked?"linked":"dedicated",reason:"offboard"}));
            changes.record("__auth", id, id); audit(provider.organizationId, id, "offboarded"); return id;
          });
          if (userId) auth.notifyUserChange(userId as AuthUserId);
          return Response.json({ ok: true, offboarded: true }, { headers });
        }
        throw new AuthError("NOT_FOUND", "SSO endpoint not found.", 404);
      } catch (error) {
        return Response.json({ ok: false, error: { code: error instanceof AuthError ? error.code : "SSO_FAILED", message: error instanceof AuthError ? error.message : "SSO authentication failed." } }, { status: error instanceof AuthError ? error.status : 400, headers });
      }
    },
  };
}

const SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const SCIM_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const SCIM_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_ID = /^scim_[a-f0-9]{32}$/u;
type ScimRow = Record<string, unknown>;
type ScimUser = { externalId: string; userName: string; active: boolean; displayName?: string; name?: Record<string, string>; emails?: Record<string, unknown>[] };
type ScimGroup = { externalId: string; displayName: string; members: string[] };
class ScimError extends Error {
  readonly status: number;
  readonly scimType?: string;
  constructor(status: number, message: string, scimType?: string) { super(message); this.status = status; this.scimType = scimType; }
}
function normalizeProvisioningPolicy(value: OrganizationProvisioningPolicy | undefined, provider: OrganizationSsoProvider): OrganizationProvisioningPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value.token !== "string" || value.token.length < 32 || value.token.length > 1024
    || value.token === provider.offboardingToken || value.token === provider.clientSecret
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1 || value.expiresAt > Date.now() + 366 * 86_400_000
    || value.groupRoles !== undefined && (!Array.isArray(value.groupRoles) || value.groupRoles.length > 100)) throw new TypeError("Invalid separate expiring provisioning policy.");
  const seen = new Set<string>();
  const groupRoles = (value.groupRoles ?? []).map(mapping => {
    if (!mapping || typeof mapping.externalId !== "string" || !mapping.externalId || mapping.externalId.length > 255
      || /[\u0000-\u001f\u007f]/u.test(mapping.externalId) || seen.has(mapping.externalId)
      || !["viewer", "developer"].includes(mapping.role)) throw new TypeError("Invalid provisioning group role.");
    seen.add(mapping.externalId); return Object.freeze({ externalId: mapping.externalId, role: mapping.role });
  }).sort((a, b) => a.externalId.localeCompare(b.externalId));
  return Object.freeze({ token: value.token, expiresAt: value.expiresAt, groupRoles: Object.freeze(groupRoles) });
}
function scimObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScimError(400, "Provide a SCIM object.", "invalidSyntax");
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const folded = key.toLowerCase();
    if (Object.hasOwn(result, folded)) throw new ScimError(400, "Duplicate case-insensitive attribute.", "invalidSyntax");
    result[folded] = item;
  }
  return result;
}
function scimKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ScimError(400, "Unsupported SCIM attribute or extension.", "invalidValue");
}
function scimText(value: unknown, maximum = 255, empty = false): string {
  if (typeof value !== "string" || !empty && !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new ScimError(400, "Invalid bounded SCIM text.", "invalidValue");
  return value;
}
function scimSchemas(value: unknown, expected: string): void {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== expected) throw new ScimError(400, "Use the supported SCIM schema.", "invalidValue");
}
function scimUser(value: unknown, previous?: ScimUser, requireSchema = true): ScimUser {
  const input = scimObject(value);
  scimKeys(input, ["schemas", "id", "meta", "externalid", "username", "active", "displayname", "name", "emails", "groups"]);
  if (requireSchema) scimSchemas(input.schemas, SCIM_USER);
  const externalId = scimText(input.externalid ?? previous?.externalId), userName = scimText(input.username);
  if (externalId !== (previous?.externalId ?? externalId)) throw new ScimError(400, "externalId is an immutable OIDC subject.", "mutability");
  if (userName !== userName.trim()) throw new ScimError(400, "userName cannot have surrounding whitespace.", "invalidValue");
  const active = input.active ?? previous?.active ?? true;
  if (typeof active !== "boolean") throw new ScimError(400, "active must be a boolean.", "invalidValue");
  const result: ScimUser = { externalId, userName, active };
  if (input.displayname !== undefined && input.displayname !== null) result.displayName = scimText(input.displayname, 200, true);
  if (input.name !== undefined && input.name !== null) {
    const name = scimObject(input.name), values: Record<string, string> = {};
    const names: Record<string, string> = { formatted: "formatted", givenname: "givenName", familyname: "familyName", middlename: "middleName", honorificprefix: "honorificPrefix", honorificsuffix: "honorificSuffix" };
    scimKeys(name, Object.keys(names));
    for (const [key, item] of Object.entries(name)) values[names[key]!] = scimText(item, 200, true);
    result.name = values;
  }
  if (input.emails !== undefined && input.emails !== null) {
    if (!Array.isArray(input.emails) || input.emails.length > 10) throw new ScimError(400, "Keep at most ten email metadata values.", "invalidValue");
    let primaries = 0;
    result.emails = input.emails.map((item: unknown) => {
      const email = scimObject(item); scimKeys(email, ["value", "type", "primary", "display"]);
      const value = scimText(email.value, 254);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) || email.primary !== undefined && typeof email.primary !== "boolean") throw new ScimError(400, "Invalid email metadata.", "invalidValue");
      if (email.primary === true && ++primaries > 1) throw new ScimError(400, "Only one email can be primary.", "invalidValue");
      return { value, ...(email.type === undefined ? {} : { type: scimText(email.type, 40) }),
        ...(email.primary === undefined ? {} : { primary: email.primary }), ...(email.display === undefined ? {} : { display: scimText(email.display, 200, true) }) };
    });
  }
  return result;
}
function scimMembers(value: unknown, base: string): string[] {
  if (!Array.isArray(value) || value.length > 128) throw new ScimError(400, "Keep at most 128 direct User members.", "invalidValue");
  const members = value.map(item => {
    const member = scimObject(item); scimKeys(member, ["value", "$ref", "display", "type"]);
    const id = scimText(member.value, 64);
    if (!SCIM_ID.test(id) || member.type !== undefined && member.type !== "User"
      || member.$ref !== undefined && member.$ref !== `${base}/Users/${id}`) throw new ScimError(400, "Members must reference direct Users in this organization.", "invalidValue");
    // display is read-only metadata; identity comes solely from the resource ID.
    return id;
  });
  return [...new Set(members)].sort();
}
function scimGroup(value: unknown, base: string, previous?: ScimGroup, requireSchema = true): ScimGroup {
  const input = scimObject(value); scimKeys(input, ["schemas", "id", "meta", "externalid", "displayname", "members"]);
  if (requireSchema) scimSchemas(input.schemas, SCIM_GROUP);
  const externalId = scimText(input.externalid ?? previous?.externalId);
  if (externalId !== (previous?.externalId ?? externalId)) throw new ScimError(400, "externalId is immutable.", "mutability");
  return { externalId, displayName: scimText(input.displayname, 200), members: scimMembers(input.members ?? [], base) };
}
function scimCanonical(value: unknown, depth = 0): string {
  if (depth > 20) throw new ScimError(400, "SCIM input nesting exceeds its bound.", "invalidSyntax");
  if (Array.isArray(value)) return `[${value.map(item => scimCanonical(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${scimCanonical((value as any)[key], depth + 1)}`).join(",")}}`;
  return JSON.stringify(value);
}
function scimPatch(type: "Users" | "Groups", value: unknown, previous: ScimUser | ScimGroup, base: string): ScimUser | ScimGroup {
  const input = scimObject(value); scimKeys(input, ["schemas", "operations"]); scimSchemas(input.schemas, SCIM_PATCH);
  if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 20) throw new ScimError(400, "Use one to twenty atomic PATCH operations.", "invalidValue");
  let result: any = structuredClone(previous);
  for (const item of input.operations) {
    const operation = scimObject(item); scimKeys(operation, ["op", "path", "value"]);
    const op = scimText(operation.op, 16).toLowerCase(), path = operation.path === undefined ? "" : scimText(operation.path, 512).toLowerCase();
    if (!["add", "replace", "remove"].includes(op)) throw new ScimError(400, "Unsupported PATCH operation.", "invalidSyntax");
    if (!path && op !== "remove") {
      const changes = scimObject(operation.value);
      const current = scimObject(result);
      if (type === "Groups" && changes.members !== undefined) {
        const members = scimMembers(changes.members, base);
        changes.members = op === "add" ? [...new Set([...result.members, ...members])].sort() : members;
      }
      if (type === "Users" && op === "add" && changes.emails !== undefined) {
        if (!Array.isArray(changes.emails)) throw new ScimError(400, "emails must be an array.", "invalidValue");
        changes.emails = [...(result.emails ?? []), ...changes.emails];
      }
      result = { ...current, ...changes };
    } else if (type === "Users") {
      const names: Record<string, string> = { username: "userName", externalid: "externalId", active: "active", displayname: "displayName", name: "name", emails: "emails" };
      const nested = /^name\.(formatted|givenname|familyname|middlename|honorificprefix|honorificsuffix)$/u.exec(path);
      if (nested) {
        const keys: Record<string, string> = { formatted: "formatted", givenname: "givenName", familyname: "familyName", middlename: "middleName", honorificprefix: "honorificPrefix", honorificsuffix: "honorificSuffix" };
        result.name ??= {}; if (op === "remove") delete result.name[keys[nested[1]!]!]; else result.name[keys[nested[1]!]!] = operation.value;
      } else if (names[path]) {
        if (op === "remove") {
          if (["username", "externalid", "active"].includes(path)) throw new ScimError(400, "Required attributes cannot be removed.", "mutability");
          delete result[names[path]!];
        } else if (path === "emails" && op === "add") {
          if (!Array.isArray(operation.value)) throw new ScimError(400, "emails must be an array.", "invalidValue");
          result.emails = [...(result.emails ?? []), ...operation.value];
        } else result[names[path]!] = operation.value;
      } else throw new ScimError(400, "Unsupported User PATCH path.", "invalidPath");
    } else if (path === "displayname") {
      if (op === "remove") throw new ScimError(400, "displayName is required.", "mutability");
      result.displayName = operation.value;
    } else if (path === "members") {
      const members = op === "remove" ? [] : scimMembers(operation.value, base);
      result.members = op === "add" ? [...new Set([...result.members, ...members])].sort() : members;
    } else {
      // Keep the selector's value case-sensitive: resource IDs are opaque.
      const selected = /^members\[value\s+eq\s+("(?:\\.|[^"\\])*")\]$/iu.exec(String(operation.path ?? ""));
      if (op !== "remove" || !selected) throw new ScimError(400, "Unsupported Group PATCH path.", "invalidPath");
      let id: unknown; try { id = JSON.parse(selected[1]!); } catch { throw new ScimError(400, "Invalid member selector.", "invalidPath"); }
      if (!result.members.includes(id)) throw new ScimError(400, "The selected member is absent.", "noTarget");
      result.members = result.members.filter((member: string) => member !== id);
    }
    if (type === "Users") result = scimUser(result, previous as ScimUser, false);
    else {
      const members = result.members;
      result = scimGroup({ ...result, members: [] }, base, previous as ScimGroup, false);
      if (!Array.isArray(members) || members.length > 128 || members.some(member => typeof member !== "string" || !SCIM_ID.test(member))) throw new ScimError(400, "Invalid bounded members.", "invalidValue");
      result.members = [...new Set(members)].sort();
    }
  }
  return result;
}

function scimFilter(type: "Users" | "Groups", value: string | null): { column: string; value: string | number } | undefined {
  if (value === null) return undefined;
  if (value.length > 1024) throw new ScimError(400, "Filter exceeds its bound.", "invalidFilter");
  const match = /^\s*(id|externalId|userName|displayName|active)\s+eq\s+("(?:\\.|[^"\\])*"|true|false)\s*$/iu.exec(value);
  if (!match) throw new ScimError(400, "Only declared equality filters are supported.", "invalidFilter");
  const attribute = match[1]!.toLowerCase(); let literal: unknown;
  try { literal = JSON.parse(match[2]!); } catch { throw new ScimError(400, "Invalid filter literal.", "invalidFilter"); }
  const columns: Record<string, string> = type === "Users" ? { id: "id", externalid: "external_id", username: "username_key", active: "active" }
    : { id: "id", externalid: "external_id", displayname: "display_key" };
  if (!columns[attribute] || (attribute === "active" ? typeof literal !== "boolean" : typeof literal !== "string")) throw new ScimError(400, "Filter attribute or literal is unsupported.", "invalidFilter");
  return { column: columns[attribute]!, value: attribute === "active" ? literal ? 1 : 0 : ["username", "displayname"].includes(attribute)
    ? String(literal).normalize("NFC").toLowerCase() : String(literal) };
}
function scimSchemaDefinitions(base: string) {
  const attribute = (name: string, type = "string", extra: Record<string, unknown> = {}) => ({ name, type, multiValued: false,
    description: `${name} provisioning attribute`, required: false, caseExact: false, mutability: "readWrite", returned: "default", uniqueness: "none", ...extra });
  const common = [attribute("id", "string", { required: true, caseExact: true, mutability: "readOnly", returned: "always", uniqueness: "global" }),
    attribute("externalId", "string", { required: true, caseExact: true, mutability: "immutable", uniqueness: "server" }),
    attribute("meta", "complex", { mutability: "readOnly", subAttributes: [attribute("resourceType"), attribute("created", "dateTime"), attribute("lastModified", "dateTime"), attribute("location", "reference"), attribute("version")] })];
  return [{ schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"], id: SCIM_USER, name: "User", description: "Bounded subject-based User provisioning",
    attributes: [...common, attribute("userName", "string", { required: true, uniqueness: "server" }), attribute("active", "boolean"), attribute("displayName"),
      attribute("name", "complex", { subAttributes: ["formatted", "givenName", "familyName", "middleName", "honorificPrefix", "honorificSuffix"].map(name => attribute(name)) }),
      attribute("emails", "complex", { multiValued: true, subAttributes: [attribute("value"), attribute("type"), attribute("primary", "boolean"), attribute("display")] }),
      attribute("groups", "complex", { multiValued: true, mutability: "readOnly", subAttributes: [attribute("value"), attribute("$ref", "reference", { referenceTypes: ["Group"] }), attribute("display"), attribute("type")] })],
    meta: { resourceType: "Schema", location: `${base}/Schemas/${SCIM_USER}` } },
  { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"], id: SCIM_GROUP, name: "Group", description: "Direct User membership with server-configured bounded roles",
    attributes: [...common, attribute("displayName", "string", { required: true }), attribute("members", "complex", { multiValued: true,
      subAttributes: [attribute("value", "string", { required: true, caseExact: true }), attribute("$ref", "reference", { referenceTypes: ["User"] }), attribute("display", "string", { mutability: "readOnly" }), attribute("type")] })],
    meta: { resourceType: "Schema", location: `${base}/Schemas/${SCIM_GROUP}` } }];
}
function openScim(sql: SQLiteInternal, providers: ReadonlyMap<string, OrganizationSsoProvider>, applicationOrigin: string, hooks: {
  initialize(): void;
  currentPolicy(): boolean;
  membership(userId: string, organizationId: string, assignment: OrganizationProvisioningAssignment): void;
  deactivate(userId: string, changes: SQLiteInternalChangeRecorder): void;
  notify(userId: string): void;
}) {
  const retained = Boolean(sql.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='clank_scim_state'").get());
  const installed = retained || [...providers.values()].some(provider => provider.provisioning);
  const initializeScim = () => { if (installed) {
    if (applicationOrigin.length > 512) throw new TypeError("Provisioning application origin exceeds its bound.");
      sql.exec("CREATE TABLE IF NOT EXISTS clank_scim_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol INTEGER NOT NULL)");
      const state = sql.prepare("SELECT protocol FROM clank_scim_state WHERE singleton=1").get();
      if (state && state.protocol !== 1) throw new TypeError("Unsupported retained provisioning protocol.");
      sql.prepare("INSERT OR IGNORE INTO clank_scim_state VALUES(1,1)").run();
      sql.exec(`CREATE TABLE IF NOT EXISTS clank_scim_users(id TEXT PRIMARY KEY,organization TEXT NOT NULL,issuer TEXT NOT NULL,
        external_id TEXT NOT NULL,username_key TEXT NOT NULL,data TEXT NOT NULL,active INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,
        user_id TEXT,version INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
      sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS clank_scim_username ON clank_scim_users(organization,issuer,username_key) WHERE deleted=0");
      // Keep ownership even if a local account is deleted. A new account cannot
      // inherit that subject merely by reusing its email or provisioning name.
      sql.exec(`CREATE TABLE IF NOT EXISTS clank_scim_subjects(organization TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,
        resource_id TEXT NOT NULL,user_id TEXT,disabled_version INTEGER,PRIMARY KEY(organization,issuer,subject))`);
      sql.exec(`CREATE TABLE IF NOT EXISTS clank_scim_groups(id TEXT PRIMARY KEY,organization TEXT NOT NULL,issuer TEXT NOT NULL,
        external_id TEXT NOT NULL,display_key TEXT NOT NULL,data TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
      sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS clank_scim_group_external ON clank_scim_groups(organization,issuer,external_id) WHERE deleted=0");
      sql.exec(`CREATE TABLE IF NOT EXISTS clank_scim_members(group_id TEXT NOT NULL REFERENCES clank_scim_groups(id),
        resource_id TEXT NOT NULL REFERENCES clank_scim_users(id),PRIMARY KEY(group_id,resource_id))`);
      sql.exec("CREATE INDEX IF NOT EXISTS clank_scim_member_user ON clank_scim_members(resource_id,group_id)");
      sql.exec(`CREATE TABLE IF NOT EXISTS clank_scim_receipts(organization TEXT NOT NULL,key TEXT NOT NULL,issuer TEXT NOT NULL,
        input TEXT NOT NULL,status INTEGER NOT NULL,body TEXT,etag TEXT,location TEXT,PRIMARY KEY(organization,key))`);
  } };
  const baseFor = (organization: string) => `${applicationOrigin}/scim/v2/${organization}`;
  const tableFor = (type: "Users" | "Groups") => type === "Users" ? "clank_scim_users" : "clank_scim_groups";
  const userFor = (organization: string, issuer: string, subject: string): ScimRow | undefined => !installed ? undefined : sql.prepare(`SELECT u.* FROM clank_scim_subjects s
    JOIN clank_scim_users u ON u.id=s.resource_id WHERE s.organization=? AND s.issuer=? AND s.subject=?`).get(organization, issuer, subject);
  const identityFor = (row: ScimRow) => sql.prepare("SELECT * FROM clank_sso_identities WHERE organization=? AND issuer=? AND subject=?").get(row.organization, row.issuer, row.external_id);
  const desiredRole = (row: ScimRow): "viewer" | "developer" | null => {
    const mappings = providers.get(String(row.organization))?.provisioning?.groupRoles ?? [];
    const groups = sql.prepare(`SELECT g.external_id FROM clank_scim_members m JOIN clank_scim_groups g ON g.id=m.group_id
      WHERE m.resource_id=? AND g.organization=? AND g.issuer=? AND g.deleted=0 LIMIT 100`).all(row.id, row.organization, row.issuer);
    const roles = groups.map(group => mappings.find(mapping => mapping.externalId === group.external_id)?.role);
    return roles.includes("developer") ? "developer" : roles.includes("viewer") ? "viewer" : null;
  };
  const assignmentFor = (row: ScimRow): OrganizationProvisioningAssignment | null => {
    if (!row.user_id) return null;
    const provider = providers.get(String(row.organization));
    if (!provider?.provisioning || provider.issuer !== row.issuer || !hooks.currentPolicy()) return null;
    const identity = identityFor(row);
    const active = Number(row.active) === 1 && Number(row.deleted) === 0 && Number(identity?.active) === 1
      && identity?.user_id === row.user_id && Number(sql.prepare("SELECT disabled FROM clank_auth_users WHERE id=?").get(row.user_id)?.disabled ?? 1) === 0
      && !sql.prepare("SELECT 1 FROM clank_sso_revocations WHERE organization=? AND issuer=? AND subject=?").get(row.organization, row.issuer, row.external_id);
    const deactivated = Number(row.active) !== 1 || Number(row.deleted) !== 0;
    return { resourceId: String(row.id), active, deactivated, role: deactivated ? null : desiredRole(row) };
  };
  const project = (row: ScimRow) => {
    const assignment = assignmentFor(row);
    if (assignment) hooks.membership(String(row.user_id), String(row.organization), assignment);
  };
  const guardSubject = (organization: string, issuer: string, subject: string) => {
    const provider = providers.get(organization), row = userFor(organization, issuer, subject);
    if (provider?.provisioning && (!hooks.currentPolicy() || !row)) throw new AuthError("SSO_NOT_PROVISIONED", "This identity has no current provisioning grant.", 403);
    if (row && (Number(row.deleted) !== 0 || Number(row.active) !== 1)) throw new AuthError("SSO_OFFBOARDED", "This organization identity is inactive in provisioning.", 403);
    return row;
  };
  const version = (row: ScimRow) => {
    const value = Number(row.version);
    if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) throw new ScimError(409, "Resource version capacity is unavailable.");
    return value;
  };
  const etag = (row: ScimRow) => `"${String(row.id)}-${version(row)}"`;
  const resource = (type: "Users" | "Groups", row: ScimRow) => {
    const base = baseFor(String(row.organization)), data = JSON.parse(String(row.data));
    const result: Record<string, unknown> = { schemas: [type === "Users" ? SCIM_USER : SCIM_GROUP], id: row.id, ...data,
      meta: { resourceType: type === "Users" ? "User" : "Group", created: new Date(Number(row.created_at)).toISOString(),
        lastModified: new Date(Number(row.updated_at)).toISOString(), location: `${base}/${type}/${row.id}`, version: etag(row) } };
    if (type === "Users") result.groups = sql.prepare(`SELECT g.id,g.data FROM clank_scim_members m JOIN clank_scim_groups g ON g.id=m.group_id
      WHERE m.resource_id=? AND g.organization=? AND g.issuer=? AND g.deleted=0 ORDER BY g.id LIMIT 100`).all(row.id, row.organization, row.issuer)
      .map(group => ({ value: group.id, $ref: `${base}/Groups/${group.id}`, display: JSON.parse(String(group.data)).displayName, type: "direct" }));
    else result.members = sql.prepare(`SELECT u.id,u.data FROM clank_scim_members m JOIN clank_scim_users u ON u.id=m.resource_id
      WHERE m.group_id=? AND u.organization=? AND u.issuer=? AND u.deleted=0 ORDER BY u.id LIMIT 128`).all(row.id, row.organization, row.issuer)
      .map(user => ({ value: user.id, $ref: `${base}/Users/${user.id}`, display: JSON.parse(String(user.data)).displayName ?? JSON.parse(String(user.data)).userName, type: "User" }));
    if (new TextEncoder().encode(JSON.stringify(result)).length > 131_072) throw new ScimError(409, "Resource response exceeds its retained bound.");
    return result;
  };
  const dataFor = (type: "Users" | "Groups", row: ScimRow): ScimUser | ScimGroup => {
    const data = JSON.parse(String(row.data));
    if (type === "Users") return data as ScimUser;
    return { ...data, members: sql.prepare("SELECT resource_id FROM clank_scim_members WHERE group_id=? ORDER BY resource_id LIMIT 128").all(row.id).map(member => String(member.resource_id)) };
  };
  const response = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), { status,
    headers: { "content-type": "application/scim+json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra } });
  const discovery = (organization: string, path: string) => {
    const base = baseFor(organization), types = [
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: SCIM_USER, schemaExtensions: [], meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` } },
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: SCIM_GROUP, schemaExtensions: [], meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/Group` } },
    ];
    if (path === "ServiceProviderConfig") return { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"], patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: 100 }, changePassword: { supported: false },
      sort: { supported: false }, etag: { supported: true }, authenticationSchemes: [{ type: "oauthbearertoken", name: "Organization provisioning bearer", description: "Separate expiring organization-scoped credential", primary: true }] };
    const schemas = scimSchemaDefinitions(base);
    if (path === "ResourceTypes" || path === "Schemas") {
      const resources = path === "ResourceTypes" ? types : schemas;
      return { schemas: [SCIM_LIST], totalResults: resources.length, startIndex: 1, itemsPerPage: resources.length, Resources: resources };
    }
    if (path.startsWith("ResourceTypes/")) return types.find(type => type.id === path.slice(14));
    if (path.startsWith("Schemas/")) {
      let id: string; try { id = decodeURIComponent(path.slice(8)); } catch { throw new ScimError(400, "Invalid schema resource encoding.", "invalidSyntax"); }
      return schemas.find(schema => schema.id === id);
    }
    return undefined;
  };
  const refreshed = new Set<string>();
  // Policy publication and native role reconciliation share one write lock.
  // A failing hook must not publish a policy while leaving stale grants live.
  sql.transaction(changes => {
    hooks.initialize(); initializeScim();
    if (!installed) return;
    for (const provider of providers.values()) {
      if (!provider.provisioning) continue;
      const rows = sql.prepare(`SELECT u.* FROM clank_scim_users u JOIN clank_scim_subjects s ON s.resource_id=u.id
        WHERE u.organization=? AND u.issuer=? AND u.user_id IS NOT NULL LIMIT 1001`).all(provider.organizationId, provider.issuer);
      if (rows.length > 1000) throw new TypeError("Retained provisioning resources exceed their bound.");
      for (const row of rows) { project(row); changes.record("__auth", String(row.user_id), String(row.user_id)); refreshed.add(String(row.user_id)); }
    }
  });
  for (const userId of refreshed) hooks.notify(userId);
  return {
    handles(path: string) { return installed && (path === "/scim/v2" || path.startsWith("/scim/v2/")); },
    assignment(userId: string, organizationId: string): OrganizationProvisioningAssignment | null {
      const provider = providers.get(organizationId);
      if (!installed || !provider?.provisioning) return null;
      const row = sql.prepare(`SELECT u.* FROM clank_scim_users u JOIN clank_scim_subjects s ON s.resource_id=u.id
        WHERE u.organization=? AND u.issuer=? AND u.user_id=? AND u.deleted=0`).get(organizationId,provider.issuer,userId);
      return row ? assignmentFor(row) : null;
    },
    guardSubject,
    mayReactivate(organization: string, issuer: string, subject: string, identity: ScimRow): boolean {
      const row = guardSubject(organization, issuer, subject);
      const provenance = installed ? sql.prepare("SELECT user_id,disabled_version FROM clank_scim_subjects WHERE organization=? AND issuer=? AND subject=?").get(organization, issuer, subject) : undefined;
      return Boolean(row && providers.get(organization)?.provisioning && hooks.currentPolicy() && row.user_id === identity.user_id
        && provenance?.user_id === identity.user_id && provenance?.disabled_version === identity.version && Number(identity.active) === 0);
    },
    bind(organization: string, issuer: string, subject: string, userId: string): boolean {
      const row = guardSubject(organization, issuer, subject);
      if (!row) return false;
      const ownership = sql.prepare("SELECT user_id FROM clank_scim_subjects WHERE organization=? AND issuer=? AND subject=?").get(organization, issuer, subject)!;
      if (row.user_id && row.user_id !== userId || ownership.user_id && ownership.user_id !== userId) throw new AuthError("SSO_IDENTITY_COLLISION", "This provisioned subject belongs to another account.", 409);
      if (!row.user_id) sql.prepare("UPDATE clank_scim_users SET user_id=?,version=version+1,updated_at=? WHERE id=?").run(userId, Date.now(), row.id);
      sql.prepare("UPDATE clank_scim_subjects SET user_id=?,disabled_version=NULL WHERE organization=? AND issuer=? AND subject=?").run(userId, organization, issuer, subject);
      project({ ...row, user_id: userId }); return true;
    },
    async handle(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url), route = /^\/scim\/v2\/([A-Za-z0-9_-]{1,128})\/(.+)$/u.exec(url.pathname);
        if (url.origin !== applicationOrigin || url.href.length > 4096 || !route) throw new ScimError(404, "SCIM endpoint not found.");
        const organization = route[1]!, path = route[2]!, provider = providers.get(organization);
        const credential = request.headers.get("authorization") ?? "";
        if (!installed || !provider?.provisioning || !/^Bearer [^\s]{32,1024}$/iu.test(credential)
          || !await equal(credential.slice(7), provider.provisioning.token)) throw new ScimError(401, "Provisioning authorization failed.");
        const current = () => {
          if (!hooks.currentPolicy() || provider.provisioning!.expiresAt <= Date.now()) throw new ScimError(401, "Provisioning policy or credential is no longer current.");
        };
        current();
        if (request.method === "GET" && /^(?:ServiceProviderConfig|ResourceTypes(?:\/[^/]+)?|Schemas(?:\/.+)?)$/u.test(path)) {
          if (url.search) throw new ScimError(400, "Discovery query options are unsupported.", "invalidValue");
          const document = discovery(organization, path); if (!document) throw new ScimError(404, "Discovery resource not found.");
          return response(document);
        }
        const selected = /^(Users|Groups)(?:\/(scim_[a-f0-9]{32}))?$/u.exec(path);
        if (!selected) throw new ScimError(404, "SCIM resource endpoint not found.");
        const type = selected[1] as "Users" | "Groups", id = selected[2], table = tableFor(type), base = baseFor(organization);
        const find = () => id ? sql.prepare(`SELECT * FROM ${table} WHERE id=? AND organization=? AND issuer=?`).get(id, organization, provider.issuer) : undefined;
        if (request.method === "GET") {
          return sql.transaction(() => {
            current();
            if (id) {
              if (url.search) throw new ScimError(400, "Resource projection options are unsupported.", "invalidValue");
              const row = find(); if (!row || Number(row.deleted) !== 0) throw new ScimError(404, "Resource not found.");
              return response(resource(type, row), 200, { etag: etag(row) });
            }
            const allowed = ["filter", "startIndex", "count"];
            if ([...url.searchParams.keys()].some(key => !allowed.includes(key)) || allowed.some(key => url.searchParams.getAll(key).length > 1)) throw new ScimError(400, "Unsupported or repeated list option.", "invalidValue");
            const integer = (key: string, fallback: number, minimum: number, maximum: number) => {
              const raw = url.searchParams.get(key); if (raw === null) return fallback;
              if (!/^\d{1,6}$/u.test(raw) || Number(raw) < minimum || Number(raw) > maximum) throw new ScimError(400, "List page exceeds its bound.", "invalidValue");
              return Number(raw);
            };
            const start = integer("startIndex", 1, 1, 10001), count = integer("count", 100, 0, 100);
            const filter = scimFilter(type, url.searchParams.get("filter")), predicate = filter ? ` AND ${filter.column}=?` : "", parameters = [organization, provider.issuer, ...(filter ? [filter.value] : [])];
            const total = Number(sql.prepare(`SELECT count(*) AS n FROM ${table} WHERE organization=? AND issuer=? AND deleted=0${predicate}`).get(...parameters)!.n);
            const rows = sql.prepare(`SELECT * FROM ${table} WHERE organization=? AND issuer=? AND deleted=0${predicate} ORDER BY created_at,id LIMIT ? OFFSET ?`).all(...parameters, count, start - 1);
            const resources = []; let bytes = 1024;
            for (const row of rows) { const item = resource(type, row), size = new TextEncoder().encode(JSON.stringify(item)).length; if (bytes + size > 1_048_576) break; resources.push(item); bytes += size; }
            return response({ schemas: [SCIM_LIST], totalResults: total, startIndex: start, itemsPerPage: resources.length, Resources: resources });
          });
        }
        if (url.search || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method) || request.method === "POST" && id || request.method !== "POST" && !id) throw new ScimError(400, "Unsupported resource mutation.", "invalidValue");
        const key = request.headers.get("x-clank-idempotency-key"), match = request.headers.get("if-match");
        if (key !== null && !/^[A-Za-z0-9_-]{16,128}$/u.test(key)) throw new ScimError(400, "Use a bounded stable retry key.", "invalidValue");
        let input: unknown = null;
        if (request.method !== "DELETE") {
          if (!/^(?:application\/scim\+json|application\/json)(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("content-type") ?? "")) throw new ScimError(415, "Use SCIM JSON content.");
          input = await readJsonRequest(request, 65_536);
        } else if (request.body && (await readRequestBytes(request, 1)).length) throw new ScimError(400, "DELETE does not accept a nonempty body.", "invalidSyntax");
        const exact = await hash(scimCanonical([request.method, path, match, input])), notified = new Set<string>();
        const accepted = sql.transaction(changes => {
          current();
          if (key) {
            const old = sql.prepare("SELECT * FROM clank_scim_receipts WHERE organization=? AND key=?").get(organization, key);
            if (old) {
              if (old.issuer !== provider.issuer || old.input !== exact) throw new ScimError(409, "Retry key belongs to a different accepted mutation.", "uniqueness");
              return { status: Number(old.status), body: old.body === null ? null : JSON.parse(String(old.body)), etag: old.etag, location: old.location };
            }
            if (Number(sql.prepare("SELECT count(*) AS n FROM clank_scim_receipts WHERE organization=?").get(organization)!.n) >= 1000
              || Number(sql.prepare("SELECT count(*) AS n FROM clank_scim_receipts").get()!.n) >= 10000) throw new ScimError(409, "Retained receipt capacity is full.");
          }
          const row = find(), created = request.method === "POST";
          if (!created && (!row || Number(row.deleted) !== 0)) throw new ScimError(404, "Resource not found.");
          if (!created && match === null) throw new ScimError(428, "Provide the exact current resource If-Match.");
          if (!created && match !== etag(row!)) throw new ScimError(412, "Resource version changed; retrieve the current resource.");
          if (created && match !== null) throw new ScimError(400, "Creation does not accept If-Match.", "invalidValue");
          if (created) {
            const orgCount = Number(sql.prepare(`SELECT count(*) AS n FROM ${table} WHERE organization=?`).get(organization)!.n), maximum = type === "Users" ? 1000 : 100;
            const total = Number(sql.prepare("SELECT (SELECT count(*) FROM clank_scim_users)+(SELECT count(*) FROM clank_scim_groups) AS n").get()!.n);
            if (orgCount >= maximum || total >= 10000) throw new ScimError(409, "Retained resource capacity is full.");
          }
          const deleted = request.method === "DELETE", previous = row ? dataFor(type, row) : undefined;
          const data = deleted ? previous! : request.method === "PATCH" ? scimPatch(type, input, previous!, base)
            : type === "Users" ? scimUser(input, previous as ScimUser | undefined) : scimGroup(input, base, previous as ScimGroup | undefined);
          const resourceId = created ? `scim_${crypto.randomUUID().replaceAll("-", "")}` : id!, now = Date.now(), nextVersion = created ? 1 : version(row!) + 1;
          const affected = new Set<string>();
          if (type === "Users") {
            const user = data as ScimUser, active = !deleted && user.active;
            const ownership = sql.prepare("SELECT * FROM clank_scim_subjects WHERE organization=? AND issuer=? AND subject=?").get(organization, provider.issuer, user.externalId);
            if (created && ownership && Number(sql.prepare("SELECT deleted FROM clank_scim_users WHERE id=?").get(ownership.resource_id)?.deleted) !== 1) throw new ScimError(409, "externalId already belongs to a retained User.", "uniqueness");
            const duplicate = sql.prepare("SELECT id FROM clank_scim_users WHERE organization=? AND issuer=? AND username_key=? AND deleted=0 AND id<>?").get(organization, provider.issuer, user.userName.normalize("NFC").toLowerCase(), resourceId);
            if (!deleted && duplicate) throw new ScimError(409, "userName is already assigned.", "uniqueness");
            const binding = sql.prepare("SELECT user_id FROM clank_sso_identities WHERE organization=? AND issuer=? AND subject=?").get(organization, provider.issuer, user.externalId);
            const userId = row?.user_id ?? ownership?.user_id ?? binding?.user_id ?? null;
            if (ownership?.user_id && binding?.user_id && ownership.user_id !== binding.user_id) throw new ScimError(409, "Retained subject ownership conflicts.", "uniqueness");
            const persisted = JSON.stringify({ ...user, active });
            if (created) sql.prepare("INSERT INTO clank_scim_users VALUES(?,?,?,?,?,?,?,0,?,?,?,?)").run(resourceId, organization, provider.issuer, user.externalId, user.userName.normalize("NFC").toLowerCase(), persisted, active ? 1 : 0, userId, nextVersion, now, now);
            else sql.prepare("UPDATE clank_scim_users SET username_key=?,data=?,active=?,deleted=?,version=?,updated_at=? WHERE id=?").run(user.userName.normalize("NFC").toLowerCase(), persisted, active ? 1 : 0, deleted ? 1 : 0, nextVersion, now, resourceId);
            sql.prepare(`INSERT INTO clank_scim_subjects(organization,issuer,subject,resource_id,user_id) VALUES(?,?,?,?,?)
              ON CONFLICT(organization,issuer,subject) DO UPDATE SET resource_id=excluded.resource_id`).run(organization, provider.issuer, user.externalId, resourceId, userId);
            if (!active && userId) {
              const identity = identityFor({ organization, issuer: provider.issuer, external_id: user.externalId });
              if (Number(identity?.active) === 1 && identity?.user_id === userId) {
                const inactiveVersion = version(identity!) + 1;
                sql.prepare("UPDATE clank_sso_identities SET active=0,version=? WHERE id=?").run(inactiveVersion, identity!.id);
                sql.prepare("UPDATE clank_scim_subjects SET disabled_version=? WHERE organization=? AND issuer=? AND subject=?").run(inactiveVersion, organization, provider.issuer, user.externalId);
              }
              if (created || Number(row!.active) === 1) { hooks.deactivate(String(userId), changes); notified.add(String(userId)); }
            }
            // A User's displayed attributes are embedded in Group.members.
            // Advance every affected Group representation in this same commit.
            const groups = sql.prepare("SELECT g.* FROM clank_scim_groups g JOIN clank_scim_members m ON m.group_id=g.id WHERE m.resource_id=?").all(resourceId);
            for (const group of groups) sql.prepare("UPDATE clank_scim_groups SET version=?,updated_at=? WHERE id=?").run(version(group) + 1, now, group.id);
            if (deleted) sql.prepare("DELETE FROM clank_scim_members WHERE resource_id=?").run(resourceId);
            affected.add(resourceId);
          } else {
            const group = data as ScimGroup;
            const duplicate = sql.prepare("SELECT id FROM clank_scim_groups WHERE organization=? AND issuer=? AND external_id=? AND deleted=0 AND id<>?").get(organization, provider.issuer, group.externalId, resourceId);
            if (!deleted && duplicate) throw new ScimError(409, "Group externalId is already assigned.", "uniqueness");
            for (const member of row ? (previous as ScimGroup).members : []) affected.add(member);
            const members = deleted ? [] : group.members;
            for (const member of members) {
              const currentUser = sql.prepare(`SELECT u.id FROM clank_scim_users u JOIN clank_scim_subjects s ON s.resource_id=u.id
                WHERE u.id=? AND u.organization=? AND u.issuer=? AND u.deleted=0`).get(member, organization, provider.issuer);
              if (!currentUser) throw new ScimError(400, "Member is not a current User of this organization.", "invalidValue");
              affected.add(member);
            }
            const persisted = JSON.stringify({ externalId: group.externalId, displayName: group.displayName });
            if (created) sql.prepare("INSERT INTO clank_scim_groups VALUES(?,?,?,?,?,?,0,?,?,?)").run(resourceId, organization, provider.issuer, group.externalId, group.displayName.normalize("NFC").toLowerCase(), persisted, nextVersion, now, now);
            else sql.prepare("UPDATE clank_scim_groups SET display_key=?,data=?,deleted=?,version=?,updated_at=? WHERE id=?").run(group.displayName.normalize("NFC").toLowerCase(), persisted, deleted ? 1 : 0, nextVersion, now, resourceId);
            sql.prepare("DELETE FROM clank_scim_members WHERE group_id=?").run(resourceId);
            for (const member of members) sql.prepare("INSERT INTO clank_scim_members VALUES(?,?)").run(resourceId, member);
          }
          for (const member of affected) {
            let user = sql.prepare("SELECT * FROM clank_scim_users WHERE id=?").get(member)!;
            // Group membership and display are embedded in User.groups. Its
            // If-Match must fence this representation, not only User writes.
            if (type === "Groups") {
              sql.prepare("UPDATE clank_scim_users SET version=?,updated_at=? WHERE id=?").run(version(user) + 1, now, member);
              user = { ...user, version: version(user) + 1, updated_at: now };
            }
            project(user);
            if (user.user_id) { changes.record("__auth", String(user.user_id), String(user.user_id)); notified.add(String(user.user_id)); }
          }
          const updated = sql.prepare(`SELECT * FROM ${table} WHERE id=?`).get(resourceId)!;
          const accepted = { status: deleted ? 204 : created ? 201 : 200, body: deleted ? null : resource(type, updated), etag: etag(updated), location: `${base}/${type}/${resourceId}` };
          if (key) sql.prepare("INSERT INTO clank_scim_receipts VALUES(?,?,?,?,?,?,?,?)").run(organization, key, provider.issuer, exact, accepted.status, accepted.body === null ? null : JSON.stringify(accepted.body), accepted.etag, accepted.location);
          return accepted;
        });
        for (const userId of notified) hooks.notify(userId);
        return response(accepted.body, accepted.status, { ...(accepted.etag ? { etag: String(accepted.etag) } : {}), ...(accepted.location ? { location: String(accepted.location) } : {}) });
      } catch (error) {
        const known = error instanceof ScimError || error instanceof RequestInputError || error instanceof AuthError;
        const status = known ? error.status : 500;
        return response({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: String(status), detail: known ? error.message : "SCIM request failed.",
          ...(error instanceof ScimError && error.scimType ? { scimType: error.scimType }
            : error instanceof RequestInputError && status === 400 ? { scimType: "invalidSyntax" } : {}) }, status, status === 401 ? { "www-authenticate": "Bearer" } : {});
      }
    },
  };
}

function sync(value: unknown): void {
  if (value && typeof (value as any).then === "function") {
    void Promise.resolve(value).catch(() => undefined);
    throw new TypeError("SSO hooks must be synchronous.");
  }
}
function endpoint(value: string, loopback = false): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(loopback && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw new TypeError("SSO endpoints require HTTPS; insecure numeric loopback is development-only.");
  return url;
}
function random(): string { return bytes64(crypto.getRandomValues(new Uint8Array(32))); }
function bytes64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, ""); }
async function hash(value: string): Promise<string> { return bytes64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
async function equal(left: string, right: string): Promise<boolean> { const moduleName = "node:crypto"; const { timingSafeEqual } = await import(moduleName); return timingSafeEqual(new TextEncoder().encode(await hash(left)), new TextEncoder().encode(await hash(right))); }
function decode(value: string): Uint8Array<ArrayBuffer> { if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid JWT encoding."); return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), c => c.charCodeAt(0)); }
function jsonPart(value: string): Record<string, any> { const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(value))); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid JWT claims."); return parsed; }
async function verifyIdToken(input: unknown, keys: any, issuer: string, audience: string, nonce: string): Promise<Record<string, unknown>> {
  if (typeof input !== "string" || input.length > 65536) throw new Error("Missing ID token.");
  const parts = input.split("."); if (parts.length !== 3) throw new Error("Invalid ID token.");
  const header = jsonPart(parts[0]!), claims = jsonPart(parts[1]!);
  if (!["RS256", "ES256"].includes(header.alg) || typeof header.kid !== "string" || header.kid.length > 200 || header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined || !Array.isArray(keys.keys) || keys.keys.length > 20) throw new Error("Unsupported ID token signature.");
  const matching = keys.keys.filter((key: any) => key.kid === header.kid && (key.alg === undefined || key.alg === header.alg) && (key.use === undefined || key.use === "sig") && key.d === undefined && (key.key_ops === undefined || (Array.isArray(key.key_ops) && key.key_ops.includes("verify"))));
  if (matching.length !== 1) throw new Error("Ambiguous ID token key.");
  const jwk = matching[0];
  if (header.alg === "RS256" ? jwk.kty !== "RSA" || decode(jwk.n).byteLength < 256 : jwk.kty !== "EC" || jwk.crv !== "P-256") throw new Error("Invalid ID token key type.");
  const algorithm = header.alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } : { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
  if (!await crypto.subtle.verify(algorithm, key, decode(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new Error("Invalid ID token signature.");
  const now = Math.floor(Date.now() / 1000), audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (claims.iss !== issuer || !Array.isArray(audiences) || audiences.length > 10 || !audiences.includes(audience) || audiences.some((value: unknown) => typeof value !== "string") || (audiences.length > 1 && claims.azp !== audience) || (claims.azp !== undefined && claims.azp !== audience)
    || claims.nonce !== nonce || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255
    || !Number.isSafeInteger(claims.exp) || claims.exp <= now || !Number.isSafeInteger(claims.iat) || claims.iat > now + 30 || claims.iat < now - 3600
    || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + 30))) throw new Error("Invalid ID token claims.");
  return claims;
}

/** Resolve once, reject non-public addresses, and pin the actual connection to that result. */
async function networkJson(url: URL, body?: string, loopback = false): Promise<any> {
  const dnsModule = "node:dns/promises", netModule = "node:net";
  const { lookup } = await import(dnsModule);
  const { isIP } = await import(netModule);
  const entries = isIP(url.hostname.replace(/^\[|\]$/g, "")) ? [{ address: url.hostname.replace(/^\[|\]$/g, ""), family: isIP(url.hostname.replace(/^\[|\]$/g, "")) }]  : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OIDC DNS resolution timed out.")), 5000);
    lookup(url.hostname, { all: true }).then(resolve, reject).finally(() => clearTimeout(timer));
  });
  const privateAddress = (address: string) => {
    if (address.includes(":")) return !/^[23][0-9a-f]{0,3}:/iu.test(address) || /^2001:(?:0:|db8:)/iu.test(address) || /^2002:/iu.test(address);
    const octets = address.split(".").map(Number), [a,b] = octets;
    return a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && [0,168].includes(b!)) || (a === 198 && [18,19,51].includes(b!)) || (a === 203 && b === 0);
  };
  if (!entries.length || entries.some(entry => privateAddress(entry.address) && !(loopback && ["127.0.0.1", "::1"].includes(entry.address) && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("OIDC endpoint resolves to a private address.");
  const transport = await import(url.protocol === "https:" ? "node:https" : "node:http");
  return new Promise((resolve, reject) => {
    const selected = entries[0]!;
    const req = transport.request(url, { method: body === undefined ? "GET" : "POST", headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded", "content-length": String(new TextEncoder().encode(body).byteLength) }) },
      lookup: (_hostname: string, config: any, callback: any) => config?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family) }, (response: { statusCode?: number; resume(): void; on(event: string, callback: (...args: any[]) => void): void }) => {
      const chunks: Uint8Array[] = []; let size = 0;
      if (response.statusCode !== 200) { response.resume(); reject(new Error("OIDC endpoint rejected the request.")); return; }
      response.on("data", (chunk: Uint8Array) => { size += chunk.byteLength; if (size > 1048576) { req.destroy(new Error("OIDC response too large.")); return; } chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => { try { const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch (error) { reject(error); } });
    });
    const timer = setTimeout(() => req.destroy(new Error("OIDC request timed out.")), 5000); req.on("close", () => clearTimeout(timer)); req.on("error", reject); req.end(body);
  });
}
