import { AuthError, type AuthRuntime, type AuthUserId } from "./auth.ts";
import type { SQLiteDatabase } from "./backend.ts";
import { readJsonRequest } from "./security.ts";
import { SQLITE_INTERNAL } from "./sqlite-internal.ts";

export interface OrganizationSsoProvider {
  readonly organizationId: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  /** Exact additional origins hosting this issuer's authorization/token/JWKS endpoints. */
  readonly endpointOrigins?: readonly string[];
  /** A separate server-to-server secret used by the offboarding endpoint; at least 32 characters. */
  readonly offboardingToken: string;
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
}
export interface OrganizationIdentity { readonly id: string; readonly organizationId: string; readonly issuer: string; readonly subject: string; readonly active: boolean; readonly version: number; readonly linkedAt: number; }
export interface OrganizationIdentityInventory { readonly enabled: boolean; readonly policyRevision: number | null; readonly providers: readonly { organizationId: string; issuer: string }[]; readonly identities: readonly OrganizationIdentity[]; }
export interface OrganizationIdentityUnlink { readonly identityId: string; readonly expectedVersion: number; readonly idempotencyKey: string; }
export interface OrganizationSso { handles(request: Request): boolean; handle(request: Request): Promise<Response>; }

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
    return [provider.organizationId, { ...provider, allowed }] as const;
  }));
  if (!providers.size || providers.size !== options.providers.length || providers.size > 100) throw new TypeError("Configure 1–100 unique organization SSO providers.");
  const linking = options.identityLinking ? Object.freeze({...options.identityLinking}) : undefined;
  const maxActive = linking?.maxActiveIdentities ?? 10, maxRetained = linking?.maxRetainedIdentities ?? 50;
  if (linking && (!Number.isSafeInteger(linking.policyRevision) || linking.policyRevision < 1
    || !Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 10
    || !Number.isSafeInteger(maxRetained) || maxRetained < maxActive || maxRetained > 100)) throw new TypeError("Invalid identity-linking policy.");
  const publicConfiguration = JSON.stringify([applicationOrigin, prefix, maxActive, maxRetained,
    [...providers.values()].map(provider => [provider.organizationId, provider.issuer, provider.clientId, [...provider.allowed].sort()]).sort((a,b) => String(a[0]).localeCompare(String(b[0])))]);
  // Transactional table replacement removes the legacy global user UNIQUE constraint.
  // Original issuer/subject ownership, revocations and audit rows are retained.
  sql.transaction(() => {
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
  });
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
  return {
    handles(request) { const path = new URL(request.url).pathname; return path === prefix || path.startsWith(`${prefix}/`); },
    async handle(request) {
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
              if(sql.prepare("SELECT 1 FROM clank_sso_identities WHERE issuer=? AND subject=? AND user_id<>?").get(provider.issuer,claims.sub,id)) throw new AuthError("SSO_IDENTITY_COLLISION","This provider identity belongs to another account.",409);
              const existing=sql.prepare("SELECT * FROM clank_sso_identities WHERE organization=? AND issuer=? AND subject=?").get(provider.organizationId,provider.issuer,claims.sub);
              if(sql.prepare("SELECT 1 FROM clank_sso_identities WHERE organization=? AND user_id=? AND active=1").get(provider.organizationId,id)) throw new AuthError("SSO_ALREADY_LINKED","An active identity already exists for this organization.",409);
              if(Number(sql.prepare("SELECT count(*) AS n FROM clank_sso_identities WHERE user_id=? AND active=1").get(id)!.n)>=maxActive || !existing && Number(sql.prepare("SELECT count(*) AS n FROM clank_sso_identities WHERE user_id=?").get(id)!.n)>=maxRetained) throw new AuthError("SSO_CAPACITY","Identity capacity is full.",409);
              const identityId=existing?String(existing.id):`sso_${crypto.randomUUID().replaceAll("-","")}`,version=existing?Number(existing.version)+1:1;
              if(existing) sql.prepare("UPDATE clank_sso_identities SET active=1,version=?,linked_at=? WHERE id=?").run(version,Date.now(),identityId);
              else sql.prepare("INSERT INTO clank_sso_identities(id,organization,issuer,subject,user_id,version,linked_at) VALUES(?,?,?,?,?,?,?)").run(identityId,provider.organizationId,provider.issuer,claims.sub,id,version,Date.now());
              advance(id,true);sync(options.onProvision?.(id,provider.organizationId));
              sql.prepare("UPDATE clank_sso_states SET identity_id=?,identity_version=?,code_hash=? WHERE state=? AND consumed=1").run(identityId,version,codeHash,stateHash);
              changes.record("__auth",id,id);audit(provider.organizationId,id,"linked");
            });
            return new Response(null,{status:303,headers:{...headers,location:`${applicationOrigin}/`}});
          }
          const userId = sql.transaction(changes => {
            if (sql.prepare("SELECT 1 FROM clank_sso_revocations WHERE organization = ? AND issuer = ? AND subject = ?").get(provider.organizationId, provider.issuer, claims.sub)) throw new AuthError("SSO_OFFBOARDED", "This organization identity has been offboarded.", 403);
            const existing = sql.prepare("SELECT id, version, user_id, active FROM clank_sso_identities WHERE organization = ? AND issuer = ? AND subject = ?").get(provider.organizationId, provider.issuer, claims.sub);
            let userId: string;
            if (existing) {
              userId = String(existing.user_id);
              if (Number(existing.active) !== 1 || Number(sql.prepare("SELECT disabled FROM clank_auth_users WHERE id = ?").get(userId)?.disabled ?? 1) !== 0) throw new AuthError("SSO_OFFBOARDED", "This organization account has been disabled.", 403);
            } else {
              if(sql.prepare("SELECT 1 FROM clank_sso_identities WHERE issuer=? AND subject=? LIMIT 1").get(provider.issuer,claims.sub)) throw new AuthError("SSO_ACCOUNT_EXISTS","This provider identity already belongs to an account; use explicit verified linking.",409);
              // Verified email alone never links an external identity to an existing local account.
              if (sql.prepare("SELECT 1 FROM clank_auth_users WHERE email = ?").get(email)) throw new AuthError("SSO_ACCOUNT_EXISTS", "An account with this email already exists; contact your administrator.", 409);
              const profile = auth.definition.profile.parse(provider.profile ? provider.profile(claims) : { ...(typeof claims.name === "string" ? { name: claims.name.slice(0, 200) } : {}) });
              userId = random().slice(0, 24); const now = Date.now();
              sql.prepare("INSERT INTO clank_auth_users(id, email, email_verified_at, password_hash, role, profile, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)").run(userId, email, now, `federated:${random()}`, auth.definition.defaultRole, JSON.stringify(profile), now, now);
              sql.prepare("INSERT INTO clank_sso_identities(id, organization, issuer, subject, user_id, linked_at) VALUES (?, ?, ?, ?, ?, ?)").run(`sso_${crypto.randomUUID().replaceAll("-","")}`,provider.organizationId, provider.issuer, claims.sub, userId,now);
            }
            sync(options.onProvision?.(userId, provider.organizationId));
            changes.record("__auth", userId, userId); audit(provider.organizationId, userId, "login"); return userId;
          });
          const binding=sql.prepare("SELECT id,version FROM clank_sso_identities WHERE organization=? AND issuer=? AND subject=? AND user_id=? AND active=1").get(provider.organizationId,provider.issuer,claims.sub,userId);
          if(!binding) throw new AuthError("SSO_OFFBOARDED","The organization identity is no longer active.",403);
          const generation=Number(sql.prepare("SELECT generation FROM clank_sso_accounts WHERE user_id=?").get(userId)?.generation??0);
          const session = await auth.issueFederatedSession(userId as AuthUserId, request);
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

function sync(value: unknown): void { if (value && typeof (value as any).then === "function") throw new TypeError("SSO hooks must be synchronous."); }
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
