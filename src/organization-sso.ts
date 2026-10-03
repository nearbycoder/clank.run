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
  /** HTTP is allowed only for numeric loopback development fixtures, never arbitrary hosts. */
  readonly allowInsecureLoopback?: boolean;
  /** Synchronous hooks share the identity/offboarding transaction. */
  readonly onProvision?: (userId: string, organizationId: string) => void;
  readonly onOffboard?: (userId: string, organizationId: string) => void;
}
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
  sql.exec(`CREATE TABLE IF NOT EXISTS clank_sso_identities (organization TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
    user_id TEXT NOT NULL UNIQUE REFERENCES clank_auth_users(id) ON DELETE CASCADE, active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(organization, issuer, subject))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS clank_sso_states (state TEXT PRIMARY KEY, organization TEXT NOT NULL, browser TEXT NOT NULL,
    nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0)`);
  sql.exec("CREATE TABLE IF NOT EXISTS clank_sso_revocations (organization TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(organization, issuer, subject))");
  sql.exec(`CREATE TABLE IF NOT EXISTS clank_sso_events (id INTEGER PRIMARY KEY AUTOINCREMENT, organization TEXT NOT NULL,
    user_id TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL)`);
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
          const stateHash = await hash(state), browserHash = await hash(browser);
          const row = sql.transaction(() => {
            const stored = sql.prepare("SELECT * FROM clank_sso_states WHERE state = ? AND browser = ? AND consumed = 0 AND expires > ?").get(stateHash, browserHash, Date.now());
            if (!stored) throw new AuthError("SSO_STATE", "SSO state expired or was already used.", 400);
            sql.prepare("UPDATE clank_sso_states SET consumed = 1 WHERE state = ?").run(stateHash); return stored;
          });
          const provider = providers.get(String(row.organization)); if (!provider) throw new AuthError("SSO_NOT_FOUND", "SSO provider not found.", 404);
          const metadata = await discovery(provider);
          const token = await networkJson(metadata.token, new URLSearchParams({ grant_type: "authorization_code", client_id: provider.clientId, ...(provider.clientSecret ? { client_secret: provider.clientSecret } : {}), redirect_uri: callback, code, code_verifier: String(row.verifier) }).toString(), options.allowInsecureLoopback);
          const keys = await networkJson(metadata.keys, undefined, options.allowInsecureLoopback);
          const claims = await verifyIdToken(token.id_token, keys, provider.issuer, provider.clientId, String(row.nonce));
          const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
          if (claims.email_verified !== true || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new AuthError("SSO_EMAIL", "A verified email is required.", 403);
          const profile = auth.definition.profile.parse(provider.profile ? provider.profile(claims) : { ...(typeof claims.name === "string" ? { name: claims.name.slice(0, 200) } : {}) });
          const userId = sql.transaction(changes => {
            if (sql.prepare("SELECT 1 FROM clank_sso_revocations WHERE organization = ? AND issuer = ? AND subject = ?").get(provider.organizationId, provider.issuer, claims.sub)) throw new AuthError("SSO_OFFBOARDED", "This organization identity has been offboarded.", 403);
            const existing = sql.prepare("SELECT user_id, active FROM clank_sso_identities WHERE organization = ? AND issuer = ? AND subject = ?").get(provider.organizationId, provider.issuer, claims.sub);
            let userId: string;
            if (existing) {
              userId = String(existing.user_id);
              if (Number(existing.active) !== 1 || Number(sql.prepare("SELECT disabled FROM clank_auth_users WHERE id = ?").get(userId)?.disabled ?? 1) !== 0) throw new AuthError("SSO_OFFBOARDED", "This organization account has been disabled.", 403);
            } else {
              // Verified email alone never links an external identity to an existing local account.
              if (sql.prepare("SELECT 1 FROM clank_auth_users WHERE email = ?").get(email)) throw new AuthError("SSO_ACCOUNT_EXISTS", "An account with this email already exists; contact your administrator.", 409);
              userId = random().slice(0, 24); const now = Date.now();
              sql.prepare("INSERT INTO clank_auth_users(id, email, email_verified_at, password_hash, role, profile, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)").run(userId, email, now, `federated:${random()}`, auth.definition.defaultRole, JSON.stringify(profile), now, now);
              sql.prepare("INSERT INTO clank_sso_identities(organization, issuer, subject, user_id) VALUES (?, ?, ?, ?)").run(provider.organizationId, provider.issuer, claims.sub, userId);
            }
            sync(options.onProvision?.(userId, provider.organizationId));
            changes.record("__auth", userId, userId); audit(provider.organizationId, userId, "login"); return userId;
          });
          const session = await auth.issueFederatedSession(userId as AuthUserId, request);
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
            sql.prepare("UPDATE clank_sso_identities SET active = 0 WHERE user_id = ?").run(id);
            sql.prepare("UPDATE clank_auth_users SET disabled = 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
            sql.prepare("DELETE FROM clank_auth_sessions WHERE user_id = ?").run(id);
            sql.prepare("DELETE FROM clank_auth_tokens WHERE user_id = ?").run(id);
            sql.prepare("DELETE FROM clank_auth_mfa_challenges WHERE user_id = ?").run(id);
            if (sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'clank_oauth_tokens'").get()) sql.prepare("UPDATE clank_oauth_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL").run(Date.now(), id);
            sync(options.onOffboard?.(id, provider.organizationId));
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
