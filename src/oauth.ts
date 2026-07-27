import {
  AuthError,
  type AuthRequest,
  type AuthRuntime,
  type AuthUser,
  type AuthUserId,
  type DefaultAuthProfile,
} from "./auth.ts";
import type { SQLiteDatabase } from "./backend.ts";
import type { McpAuthentication, McpScope } from "./mcp.ts";
import {
  RequestInputError,
  readRequestBytes,
} from "./security.ts";
import {
  SQLITE_INTERNAL,
  type SQLiteInternal,
} from "./sqlite-internal.ts";

export interface ProjectOAuthOptions<Profile extends object = DefaultAuthProfile> {
  database: SQLiteDatabase<any>;
  auth: AuthRuntime<Profile>;
  mcpPath?: string;
  oauthPrefix?: string;
  applicationName?: string;
  accessTokenLifetimeMs?: number;
  refreshTokenLifetimeMs?: number;
  authorizationCodeLifetimeMs?: number;
  maxClients?: number;
}

export interface ProjectOAuth<Profile extends object = DefaultAuthProfile> {
  readonly mcpPath: string;
  readonly oauthPrefix: string;
  handles(request: Request): boolean;
  handle(request: Request): Promise<Response>;
  authenticate(request: Request): Promise<McpAuthentication<AuthRequest<Profile>> | null>;
  challenge(request: Request, scope: McpScope): Response;
  forbidden(request: Request, scope: McpScope): Response;
  protectedResourceMetadata(request: Request): Record<string, unknown>;
  authorizationServerMetadata(request: Request): Record<string, unknown>;
}

const AGENT_SCOPES = Object.freeze(["agent:read", "agent:write"] as const);
const AGENT_SCOPE_SET = new Set<string>(AGENT_SCOPES);

export function createProjectOAuth<Profile extends object = DefaultAuthProfile>(
  options: ProjectOAuthOptions<Profile>,
): ProjectOAuth<Profile> {
  const internal = (options.database as SQLiteDatabase<any> & { [SQLITE_INTERNAL]: SQLiteInternal })[SQLITE_INTERNAL];
  if (!internal) throw new Error("Agent OAuth requires a Clank SQLite database.");
  const mcpPath = absolutePath(options.mcpPath ?? "/__clank/mcp", "mcpPath");
  const oauthPrefix = absolutePath(options.oauthPrefix ?? "/__clank/oauth", "oauthPrefix");
  const accessTokenLifetimeMs = positiveDuration(options.accessTokenLifetimeMs ?? 60 * 60 * 1_000, "accessTokenLifetimeMs");
  const refreshTokenLifetimeMs = positiveDuration(options.refreshTokenLifetimeMs ?? 30 * 24 * 60 * 60 * 1_000, "refreshTokenLifetimeMs");
  const authorizationCodeLifetimeMs = positiveDuration(options.authorizationCodeLifetimeMs ?? 5 * 60 * 1_000, "authorizationCodeLifetimeMs");
  const maxClients = positiveInteger(options.maxClients ?? 1_000, "maxClients");
  const applicationName = boundedPlainText(options.applicationName ?? "Clank application", "applicationName", 120);
  createOAuthTables(internal);
  pruneOAuthState(internal);

  const resourceFor = (request: Request) => `${new URL(request.url).origin}${mcpPath}`;
  const resourceMetadataUrl = (request: Request) =>
    `${new URL(request.url).origin}/.well-known/oauth-protected-resource${mcpPath}`;

  const protectedResourceMetadata = (request: Request): Record<string, unknown> => {
    const url = new URL(request.url);
    return {
      resource: `${url.origin}${mcpPath}`,
      authorization_servers: [url.origin],
      bearer_methods_supported: ["header"],
      scopes_supported: [...AGENT_SCOPES],
      resource_name: `${applicationName} agent actions`,
      resource_documentation: `${url.origin}/.well-known/clank`,
    };
  };

  const authorizationServerMetadata = (request: Request): Record<string, unknown> => {
    const origin = new URL(request.url).origin;
    return {
      issuer: origin,
      authorization_endpoint: `${origin}${oauthPrefix}/authorize`,
      token_endpoint: `${origin}${oauthPrefix}/token`,
      registration_endpoint: `${origin}${oauthPrefix}/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...AGENT_SCOPES],
      service_documentation: `${origin}/.well-known/clank`,
    };
  };

  const oauth: ProjectOAuth<Profile> = {
    mcpPath,
    oauthPrefix,
    handles(request) {
      const path = new URL(request.url).pathname;
      return path === "/.well-known/oauth-protected-resource"
        || path === `/.well-known/oauth-protected-resource${mcpPath}`
        || path === "/.well-known/oauth-authorization-server"
        || path === "/.well-known/openid-configuration"
        || path === `${oauthPrefix}/register`
        || path === `${oauthPrefix}/authorize`
        || path === `${oauthPrefix}/token`;
    },
    async handle(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && (
        url.pathname === "/.well-known/oauth-protected-resource"
        || url.pathname === `/.well-known/oauth-protected-resource${mcpPath}`
      )) {
        return publicJson(protectedResourceMetadata(request));
      }
      if (request.method === "GET" && (
        url.pathname === "/.well-known/oauth-authorization-server"
        || url.pathname === "/.well-known/openid-configuration"
      )) {
        return publicJson(authorizationServerMetadata(request));
      }
      if (url.pathname === `${oauthPrefix}/register`) {
        return registerClient(request, internal, maxClients);
      }
      if (url.pathname === `${oauthPrefix}/authorize`) {
        return authorize(request, internal, options.auth, {
          applicationName,
          resource: resourceFor(request),
          codeLifetimeMs: authorizationCodeLifetimeMs,
          authorizePath: `${oauthPrefix}/authorize`,
        });
      }
      if (url.pathname === `${oauthPrefix}/token`) {
        return exchangeToken(request, internal, {
          resource: resourceFor(request),
          accessTokenLifetimeMs,
          refreshTokenLifetimeMs,
        });
      }
      return oauthProblem(404, "invalid_request", "OAuth endpoint not found.");
    },
    async authenticate(request) {
      const authorization = request.headers.get("authorization");
      if (!authorization) return null;
      const matched = /^Bearer ([A-Za-z0-9._~-]{20,2048})$/u.exec(authorization);
      if (!matched) return null;
      const tokenHash = await digest(matched[1]);
      const now = Date.now();
      const row = internal.prepare(`SELECT
          t.client_id, t.scope, t.resource, t.expires_at, t.last_used_at,
          u.id AS user_id, u.email, u.email_verified_at, u.role, u.profile, u.disabled,
          u.created_at AS user_created_at, u.updated_at
        FROM clank_oauth_tokens t
        JOIN clank_auth_users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.kind = 'access' AND t.consumed_at IS NULL`)
        .get(tokenHash);
      if (
        !row
        || Number(row.disabled) !== 0
        || Number(row.expires_at) <= now
        || String(row.resource) !== resourceFor(request)
      ) return null;
      if (now - Number(row.last_used_at ?? 0) >= 60_000) {
        internal.prepare("UPDATE clank_oauth_tokens SET last_used_at = ? WHERE token_hash = ?")
          .run(now, tokenHash);
      }
      return {
        context: oauthAuthFromRow(options.auth, row),
        scopes: new Set(parseScopes(String(row.scope))),
      };
    },
    challenge(request, scope) {
      const metadata = resourceMetadataUrl(request);
      return Response.json({
        error: "invalid_token",
        error_description: "Authenticate this MCP connection before invoking application actions.",
      }, {
        status: 401,
        headers: oauthHeaders({
          "www-authenticate": `Bearer resource_metadata="${metadata}", scope="${scope}"`,
        }),
      });
    },
    forbidden(request, scope) {
      const metadata = resourceMetadataUrl(request);
      return Response.json({
        error: "insufficient_scope",
        error_description: `The ${scope} scope is required.`,
      }, {
        status: 403,
        headers: oauthHeaders({
          "www-authenticate": `Bearer resource_metadata="${metadata}", error="insufficient_scope", scope="${scope}"`,
        }),
      });
    },
    protectedResourceMetadata,
    authorizationServerMetadata,
  };
  return oauth;
}

async function registerClient(
  request: Request,
  internal: SQLiteInternal,
  maxClients: number,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  let raw: unknown;
  try {
    raw = await readBoundedJson(request, 32 * 1024);
  } catch (error) {
    return oauthError(error);
  }
  if (!isRecord(raw)) return oauthProblem(400, "invalid_client_metadata", "Client metadata must be a JSON object.");
  try {
    const redirectUris = validateRedirectUris(raw.redirect_uris);
    const clientName = boundedPlainText(
      raw.client_name === undefined ? "MCP client" : raw.client_name,
      "client_name",
      120,
    );
    validateRegistrationSet(raw.grant_types, ["authorization_code", "refresh_token"], "grant_types");
    validateRegistrationSet(raw.response_types, ["code"], "response_types");
    if (Array.isArray(raw.grant_types) && !raw.grant_types.includes("authorization_code")) {
      throw new OAuthRequestError("invalid_client_metadata", "grant_types must include authorization_code.");
    }
    if (Array.isArray(raw.response_types) && !raw.response_types.includes("code")) {
      throw new OAuthRequestError("invalid_client_metadata", "response_types must include code.");
    }
    if (raw.token_endpoint_auth_method !== undefined && raw.token_endpoint_auth_method !== "none") {
      throw new OAuthRequestError("invalid_client_metadata", "Only public PKCE clients are supported.");
    }
    const clientId = `clank_client_${randomToken(18)}`;
    const createdAt = Date.now();
    const registered = internal.transaction(() => {
      const count = Number(internal.prepare("SELECT COUNT(*) AS count FROM clank_oauth_clients").get()?.count ?? 0);
      if (count >= maxClients) {
        internal.prepare(`DELETE FROM clank_oauth_clients WHERE client_id IN (
          SELECT c.client_id FROM clank_oauth_clients c
          LEFT JOIN clank_oauth_codes a ON a.client_id = c.client_id
          LEFT JOIN clank_oauth_tokens t ON t.client_id = c.client_id
          WHERE a.client_id IS NULL AND t.client_id IS NULL
          ORDER BY c.created_at ASC LIMIT 100
        )`).run();
      }
      const afterPrune = Number(internal.prepare("SELECT COUNT(*) AS count FROM clank_oauth_clients").get()?.count ?? 0);
      if (afterPrune >= maxClients) return false;
      internal.prepare(`INSERT INTO clank_oauth_clients
        (client_id, client_name, redirect_uris, created_at)
        VALUES (?, ?, ?, ?)`)
        .run(clientId, clientName, JSON.stringify(redirectUris), createdAt);
      return true;
    });
    if (!registered) {
      return oauthProblem(503, "temporarily_unavailable", "Client registration capacity is temporarily unavailable.");
    }
    return Response.json({
      client_id: clientId,
      client_id_issued_at: Math.floor(createdAt / 1_000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, {
      status: 201,
      headers: oauthHeaders(),
    });
  } catch (error) {
    return oauthError(error);
  }
}

async function authorize<Profile extends object>(
  request: Request,
  internal: SQLiteInternal,
  authRuntime: AuthRuntime<Profile>,
  options: {
    applicationName: string;
    resource: string;
    codeLifetimeMs: number;
    authorizePath: string;
  },
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed("GET, POST");
  try {
    const input = request.method === "GET"
      ? Object.fromEntries(new URL(request.url).searchParams)
      : await readBoundedForm(request, 32 * 1024);
    const parameters = validateAuthorizationRequest(input, internal, options.resource);
    const auth = await authRuntime.resolve(request);
    if (!auth.user) {
      if (request.method === "POST") throw new OAuthRequestError("access_denied", "Sign in before approving agent access.", 401);
      const authError = typeof input.auth_error === "string" ? input.auth_error : undefined;
      return authorizationHtml(signInPage(
        parameters,
        options.applicationName,
        options.authorizePath,
        authRuntime.definition.mfa.required || Boolean(authRuntime.definition.botProtection),
        authError,
      ));
    }
    if (authRuntime.definition.emailVerification.required) auth.requireVerified();
    if (request.method === "GET") {
      if (!auth.session) throw new OAuthRequestError("access_denied", "Sign in before approving agent access.", 401);
      const consentToken = await issueConsentProof(
        internal,
        auth.session.id,
        parameters,
        options.codeLifetimeMs,
      );
      return authorizationHtml(
        consentPage(parameters, auth, options.applicationName, consentToken),
        200,
        new URL(parameters.redirectUri).origin,
      );
    }
    if (!auth.csrfToken || !constantTimeEqual(String(input.csrf_token ?? ""), auth.csrfToken)) {
      throw new OAuthRequestError("invalid_request", "The authorization request could not be verified.", 403);
    }
    if (
      !auth.session
      || !await consumeConsentProof(internal, auth.session.id, parameters, input.consent_token)
    ) {
      throw new OAuthRequestError("invalid_request", "The authorization request could not be verified.", 403);
    }
    if (input.decision !== "approve") {
      return authorizationRedirect(parameters, { error: "access_denied" });
    }
    const rawCode = `clank_code_${randomToken(32)}`;
    const codeHash = await digest(rawCode);
    const now = Date.now();
    internal.prepare(`INSERT INTO clank_oauth_codes
      (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(
        codeHash,
        parameters.clientId,
        auth.user.id,
        parameters.redirectUri,
        parameters.codeChallenge,
        parameters.scope,
        parameters.resource,
        now + options.codeLifetimeMs,
        now,
      );
    return authorizationRedirect(parameters, { code: rawCode });
  } catch (error) {
    if (error instanceof OAuthRedirectError) {
      return authorizationRedirect(error.parameters, { error: error.oauthCode });
    }
    return request.method === "GET"
      ? authorizationHtml(errorPage(error), error instanceof OAuthRequestError ? error.status : 400)
      : oauthError(error);
  }
}

async function exchangeToken(
  request: Request,
  internal: SQLiteInternal,
  options: {
    resource: string;
    accessTokenLifetimeMs: number;
    refreshTokenLifetimeMs: number;
  },
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  try {
    const input = await readBoundedForm(request, 32 * 1024);
    const grantType = requiredString(input.grant_type, "grant_type", 64);
    if (grantType === "authorization_code") {
      const clientId = requiredString(input.client_id, "client_id", 512);
      const rawCode = requiredString(input.code, "code", 2_048);
      const redirectUri = validateRedirectUri(requiredString(input.redirect_uri, "redirect_uri", 2_048));
      const verifier = requiredString(input.code_verifier, "code_verifier", 128);
      const resource = requiredString(input.resource, "resource", 2_048);
      if (resource !== options.resource) throw new OAuthRequestError("invalid_target", "The requested resource is not this MCP server.");
      if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) {
        throw new OAuthRequestError("invalid_grant", "The PKCE verifier is invalid.");
      }
      const codeHash = await digest(rawCode);
      const row = internal.prepare(`SELECT c.code_hash, c.client_id, c.user_id, c.redirect_uri,
          c.code_challenge, c.scope, c.resource, c.expires_at, c.consumed_at, u.disabled
        FROM clank_oauth_codes c
        JOIN clank_auth_users u ON u.id = c.user_id
        WHERE c.code_hash = ?`).get(codeHash);
      if (
        !row
        || Number(row.disabled) !== 0
        || row.consumed_at !== null
        || Number(row.expires_at) <= Date.now()
        || String(row.client_id) !== clientId
        || String(row.redirect_uri) !== redirectUri
        || String(row.resource) !== resource
        || !constantTimeEqual(String(row.code_challenge), await pkceChallenge(verifier))
      ) throw new OAuthRequestError("invalid_grant", "The authorization code is invalid or expired.");
      const pair = await prepareTokenPair(String(row.user_id), clientId, String(row.scope), resource, options);
      internal.transaction(() => {
        const consumed = internal.prepare(`UPDATE clank_oauth_codes SET consumed_at = ?
          WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`)
          .run(Date.now(), codeHash, Date.now());
        if (Number(consumed.changes) !== 1) throw new OAuthRequestError("invalid_grant", "The authorization code was already used.");
        insertTokenPair(internal, pair);
      });
      return tokenResponse(pair);
    }
    if (grantType === "refresh_token") {
      const clientId = requiredString(input.client_id, "client_id", 512);
      const rawRefresh = requiredString(input.refresh_token, "refresh_token", 2_048);
      const resource = requiredString(input.resource, "resource", 2_048);
      if (resource !== options.resource) throw new OAuthRequestError("invalid_target", "The requested resource is not this MCP server.");
      const refreshHash = await digest(rawRefresh);
      const row = internal.prepare(`SELECT t.token_hash, t.client_id, t.user_id, t.scope, t.resource,
          t.family_id, t.expires_at, t.consumed_at, u.disabled
        FROM clank_oauth_tokens t
        JOIN clank_auth_users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.kind = 'refresh'`).get(refreshHash);
      if (row?.consumed_at !== null && row?.consumed_at !== undefined) {
        internal.prepare("UPDATE clank_oauth_tokens SET consumed_at = ? WHERE family_id = ? AND consumed_at IS NULL")
          .run(Date.now(), row.family_id);
        throw new OAuthRequestError("invalid_grant", "Refresh token reuse was detected.");
      }
      if (
        !row
        || Number(row.disabled) !== 0
        || Number(row.expires_at) <= Date.now()
        || String(row.client_id) !== clientId
        || String(row.resource) !== resource
      ) throw new OAuthRequestError("invalid_grant", "The refresh token is invalid or expired.");
      const pair = await prepareTokenPair(
        String(row.user_id),
        clientId,
        String(row.scope),
        resource,
        options,
        String(row.family_id),
      );
      internal.transaction(() => {
        const consumed = internal.prepare(`UPDATE clank_oauth_tokens SET consumed_at = ?
          WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`)
          .run(Date.now(), refreshHash, Date.now());
        if (Number(consumed.changes) !== 1) {
          internal.prepare("UPDATE clank_oauth_tokens SET consumed_at = ? WHERE family_id = ? AND consumed_at IS NULL")
            .run(Date.now(), row.family_id);
          throw new OAuthRequestError("invalid_grant", "Refresh token reuse was detected.");
        }
        insertTokenPair(internal, pair);
      });
      return tokenResponse(pair);
    }
    throw new OAuthRequestError("unsupported_grant_type", "Only authorization_code and refresh_token grants are supported.");
  } catch (error) {
    return oauthError(error);
  }
}

interface PreparedTokenPair {
  accessToken: string;
  accessHash: string;
  refreshToken: string;
  refreshHash: string;
  userId: string;
  clientId: string;
  scope: string;
  resource: string;
  familyId: string;
  createdAt: number;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

async function prepareTokenPair(
  userId: string,
  clientId: string,
  scope: string,
  resource: string,
  options: { accessTokenLifetimeMs: number; refreshTokenLifetimeMs: number },
  familyId = randomToken(18),
): Promise<PreparedTokenPair> {
  const accessToken = `clank_at_${randomToken(32)}`;
  const refreshToken = `clank_rt_${randomToken(32)}`;
  const createdAt = Date.now();
  return {
    accessToken,
    accessHash: await digest(accessToken),
    refreshToken,
    refreshHash: await digest(refreshToken),
    userId,
    clientId,
    scope,
    resource,
    familyId,
    createdAt,
    accessExpiresAt: createdAt + options.accessTokenLifetimeMs,
    refreshExpiresAt: createdAt + options.refreshTokenLifetimeMs,
  };
}

function insertTokenPair(internal: SQLiteInternal, pair: PreparedTokenPair): void {
  const insert = internal.prepare(`INSERT INTO clank_oauth_tokens
    (token_hash, kind, family_id, client_id, user_id, scope, resource, expires_at, consumed_at, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`);
  insert.run(
    pair.accessHash,
    "access",
    pair.familyId,
    pair.clientId,
    pair.userId,
    pair.scope,
    pair.resource,
    pair.accessExpiresAt,
    pair.createdAt,
  );
  insert.run(
    pair.refreshHash,
    "refresh",
    pair.familyId,
    pair.clientId,
    pair.userId,
    pair.scope,
    pair.resource,
    pair.refreshExpiresAt,
    pair.createdAt,
  );
}

function tokenResponse(pair: PreparedTokenPair): Response {
  return Response.json({
    access_token: pair.accessToken,
    token_type: "Bearer",
    expires_in: Math.floor((pair.accessExpiresAt - pair.createdAt) / 1_000),
    refresh_token: pair.refreshToken,
    scope: pair.scope,
  }, {
    headers: oauthHeaders(),
  });
}

interface AuthorizationParameters {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
  scopes: string[];
  resource: string;
}

function validateAuthorizationRequest(
  input: Record<string, unknown>,
  internal: SQLiteInternal,
  expectedResource: string,
): AuthorizationParameters {
  const clientId = requiredString(input.client_id, "client_id", 512);
  const client = internal.prepare("SELECT client_name, redirect_uris FROM clank_oauth_clients WHERE client_id = ?")
    .get(clientId);
  if (!client) throw new OAuthRequestError("invalid_request", "The OAuth client is not registered.");
  const redirectUri = validateRedirectUri(requiredString(input.redirect_uri, "redirect_uri", 2_048));
  const allowedRedirects = parseStringArray(String(client.redirect_uris));
  if (!allowedRedirects.includes(redirectUri)) {
    throw new OAuthRequestError("invalid_request", "The redirect URI is not registered.");
  }
  const responseType = requiredString(input.response_type, "response_type", 32);
  const state = optionalString(input.state, "state", 1_024);
  const base: AuthorizationParameters = {
    clientId,
    clientName: boundedPlainText(String(client.client_name), "client_name", 120),
    redirectUri,
    ...(state ? { state } : {}),
    codeChallenge: "",
    scope: "",
    scopes: [],
    resource: "",
  };
  if (responseType !== "code") throw new OAuthRedirectError("unsupported_response_type", base);
  const method = requiredString(input.code_challenge_method, "code_challenge_method", 16);
  const codeChallenge = requiredString(input.code_challenge, "code_challenge", 128);
  if (method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)) {
    throw new OAuthRedirectError("invalid_request", base);
  }
  const resource = requiredString(input.resource, "resource", 2_048);
  if (resource !== expectedResource) throw new OAuthRedirectError("invalid_target", base);
  const scopes = normalizeScopes(input.scope);
  return {
    ...base,
    codeChallenge,
    scope: scopes.join(" "),
    scopes,
    resource,
  };
}

function normalizeScopes(input: unknown): string[] {
  const scopes = typeof input === "string" && input.trim()
    ? [...new Set(input.trim().split(/\s+/u))]
    : ["agent:read"];
  if (!scopes.includes("agent:read") || scopes.some((scope) => !AGENT_SCOPE_SET.has(scope))) {
    throw new OAuthRequestError("invalid_scope", "Only agent:read and agent:write scopes are supported.");
  }
  return AGENT_SCOPES.filter((scope) => scopes.includes(scope));
}

function authorizationRedirect(
  parameters: AuthorizationParameters,
  result: { code?: string; error?: string },
): Response {
  const target = new URL(parameters.redirectUri);
  if (result.code) target.searchParams.set("code", result.code);
  if (result.error) target.searchParams.set("error", result.error);
  if (parameters.state) target.searchParams.set("state", parameters.state);
  return Response.redirect(target, 303);
}

function signInPage(
  parameters: AuthorizationParameters,
  applicationName: string,
  authorizePath: string,
  advancedLoginRequired: boolean,
  authError?: string,
): string {
  const retry = `${authorizePath}${authorizationRequestUrl(parameters)}`;
  const error = authError === "invalid_credentials"
    ? "Email or password is incorrect."
    : authError === "rate_limited"
      ? "Too many sign-in attempts. Wait a moment and try again."
      : authError
        ? "Sign-in could not be completed. Try again."
        : "";
  return pageShell(
    `Sign in to ${escapeHtml(applicationName)}`,
    `<p>Your agent requested access through <strong>${escapeHtml(parameters.clientName)}</strong>.</p>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
    ${advancedLoginRequired
      ? `<p>This application requires its full sign-in flow. Sign in there, then return to this page.</p>
        <div class="actions">
          <a class="button primary" href="/" target="_blank" rel="noopener">Open application sign in</a>
          <a class="button" href="${escapeAttribute(retry)}">Recheck signed-in session</a>
        </div>`
      : `<p>Sign in here to review and approve the requested permissions.</p>
        <form method="post" action="/__clank/auth/login">
          <input type="hidden" name="return_to" value="${escapeAttribute(retry)}">
          <label class="field">Email
            <input name="email" type="email" autocomplete="username" maxlength="254" required>
          </label>
          <label class="field">Password
            <input name="password" type="password" autocomplete="current-password" required>
          </label>
          <div class="actions">
            <button class="button primary" type="submit">Sign in and continue</button>
            <a class="button" href="/" target="_blank" rel="noopener">Other sign-in options</a>
          </div>
        </form>`}
    <p class="meta">Requested permissions: ${parameters.scopes.map(scopeLabel).join(", ")}</p>`,
  );
}

function consentPage<Profile extends object>(
  parameters: AuthorizationParameters,
  auth: AuthRequest<Profile>,
  applicationName: string,
  consentToken: string,
): string {
  return pageShell(
    `Connect ${escapeHtml(parameters.clientName)}`,
    `<p><strong>${escapeHtml(parameters.clientName)}</strong> wants to act on
    <strong>${escapeHtml(applicationName)}</strong> as ${escapeHtml(auth.user!.email)}.</p>
    <p class="meta">Unverified client identity · callback: ${escapeHtml(new URL(parameters.redirectUri).origin)}</p>
    <ul>${parameters.scopes.map((scope) => `<li>${scope === "agent:write"
      ? "Create, change, and delete data through documented server actions."
      : "Read data through documented server actions."}</li>`).join("")}</ul>
    <p>No password or browser session is shared with the agent. It receives a resource-bound,
    expiring token that can only be used by this application’s MCP endpoint.</p>
    <form method="post">
      ${authorizationHiddenFields(parameters)}
      <input type="hidden" name="csrf_token" value="${escapeAttribute(auth.csrfToken ?? "")}">
      <input type="hidden" name="consent_token" value="${escapeAttribute(consentToken)}">
      <div class="actions">
        <button class="button primary" name="decision" value="approve" type="submit">Approve access</button>
        <button class="button" name="decision" value="deny" type="submit">Deny</button>
      </div>
    </form>`,
  );
}

function authorizationHiddenFields(parameters: AuthorizationParameters): string {
  const entries: Array<[string, string | undefined]> = [
    ["client_id", parameters.clientId],
    ["redirect_uri", parameters.redirectUri],
    ["response_type", "code"],
    ["state", parameters.state],
    ["code_challenge", parameters.codeChallenge],
    ["code_challenge_method", "S256"],
    ["scope", parameters.scope],
    ["resource", parameters.resource],
  ];
  return entries
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeAttribute(value)}">`)
    .join("");
}

function authorizationRequestUrl(parameters: AuthorizationParameters): string {
  const query = new URLSearchParams();
  query.set("client_id", parameters.clientId);
  query.set("redirect_uri", parameters.redirectUri);
  query.set("response_type", "code");
  if (parameters.state) query.set("state", parameters.state);
  query.set("code_challenge", parameters.codeChallenge);
  query.set("code_challenge_method", "S256");
  query.set("scope", parameters.scope);
  query.set("resource", parameters.resource);
  return `?${query}`;
}

function errorPage(error: unknown): string {
  const message = error instanceof OAuthRequestError
    ? error.message
    : "The authorization request could not be completed.";
  return pageShell(
    "Agent connection failed",
    `<p>${escapeHtml(message)}</p><div class="actions"><a class="button" href="/">Return to application</a></div>`,
  );
}

function pageShell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title><style>
  :root{color-scheme:light dark;font:16px/1.55 system-ui,sans-serif}
  body{margin:0;background:#080b12;color:#e8edf7;min-height:100vh;display:grid;place-items:center}
  main{width:min(38rem,calc(100% - 2rem));box-sizing:border-box;padding:2rem;border:1px solid #273249;border-radius:1rem;background:#101724}
  h1{font-size:1.6rem;margin:0 0 1rem}.meta{color:#a8b4ca}.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.5rem}
  .field{display:grid;gap:.4rem;margin-top:1rem;font-weight:650}.field input{box-sizing:border-box;width:100%;border:1px solid #50617d;border-radius:.65rem;background:#080d18;color:#fff;padding:.75rem;font:inherit}
  .error{border:1px solid #ef6d7a;border-radius:.65rem;background:#35151c;color:#ffd9dd;padding:.75rem}
  .button{appearance:none;border:1px solid #50617d;border-radius:.65rem;background:#182238;color:#fff;padding:.7rem 1rem;text-decoration:none;font:inherit;cursor:pointer}
  .primary{background:#6ee7c7;color:#07110f;border-color:#6ee7c7;font-weight:700}li+li{margin-top:.5rem}
  </style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
}

function authorizationHtml(value: string, status = 200, callbackOrigin?: string): Response {
  const formAction = callbackOrigin ? `'self' ${callbackOrigin}` : "'self'";
  return new Response(value, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function oauthAuthFromRow<Profile extends object>(
  runtime: AuthRuntime<Profile>,
  row: Record<string, unknown>,
): AuthRequest<Profile> {
  const user: AuthUser<Profile> = {
    id: String(row.user_id) as AuthUserId,
    email: String(row.email),
    emailVerified: row.email_verified_at !== null && row.email_verified_at !== undefined,
    role: String(row.role),
    profile: runtime.definition.profile.parse(JSON.parse(String(row.profile))),
    createdAt: Number(row.user_created_at),
    updatedAt: Number(row.updated_at),
  };
  return {
    user,
    session: null,
    requireUser: () => user,
    requireVerified() {
      if (!user.emailVerified) throw new AuthError("EMAIL_UNVERIFIED", "Verify your email address to continue.", 403);
      return user;
    },
    requireRole(...roles) {
      if (runtime.definition.emailVerification.required && !user.emailVerified) {
        throw new AuthError("EMAIL_UNVERIFIED", "Verify your email address to continue.", 403);
      }
      if (!roles.includes(user.role)) throw new AuthError("FORBIDDEN", "This account does not have the required role.", 403);
      return user;
    },
  };
}

function createOAuthTables(internal: SQLiteInternal): void {
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL CHECK (json_valid(redirect_uris)),
    created_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clank_oauth_clients(client_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL
  ) WITHOUT ROWID`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_oauth_consents (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES clank_auth_sessions(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES clank_oauth_clients(client_id) ON DELETE CASCADE,
    request_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL
  ) WITHOUT ROWID`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    family_id TEXT NOT NULL,
    client_id TEXT NOT NULL REFERENCES clank_oauth_clients(client_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  ) WITHOUT ROWID`);
  internal.exec("CREATE INDEX IF NOT EXISTS clank_oauth_codes_expiry ON clank_oauth_codes (expires_at)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_oauth_consents_expiry ON clank_oauth_consents (expires_at)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_oauth_consents_session ON clank_oauth_consents (session_id, created_at)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_oauth_tokens_expiry ON clank_oauth_tokens (expires_at)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_oauth_tokens_user ON clank_oauth_tokens (user_id)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_oauth_tokens_family ON clank_oauth_tokens (family_id)");
}

function pruneOAuthState(internal: SQLiteInternal): void {
  const now = Date.now();
  internal.prepare("DELETE FROM clank_oauth_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(now);
  internal.prepare("DELETE FROM clank_oauth_consents WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(now);
  // Retain rotated refresh-token digests until their original expiry. Reuse can
  // then revoke the active family for the full lifetime of the old credential.
  internal.prepare("DELETE FROM clank_oauth_tokens WHERE expires_at <= ?").run(now);
}

const MAX_PENDING_CONSENTS = 5_000;
const MAX_SESSION_PENDING_CONSENTS = 20;

async function issueConsentProof(
  internal: SQLiteInternal,
  sessionId: string,
  parameters: AuthorizationParameters,
  lifetimeMs: number,
): Promise<string> {
  const token = `clank_consent_${randomToken(24)}`;
  const tokenHash = await digest(token);
  const requestHash = await digest(authorizationRequestBinding(parameters));
  const now = Date.now();
  internal.transaction(() => {
    internal.prepare("DELETE FROM clank_oauth_consents WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(now);
    internal.prepare(`DELETE FROM clank_oauth_consents WHERE token_hash IN (
      SELECT token_hash FROM clank_oauth_consents
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT -1 OFFSET ?
    )`).run(sessionId, MAX_SESSION_PENDING_CONSENTS - 1);
    const count = Number(internal.prepare("SELECT COUNT(*) AS count FROM clank_oauth_consents").get()?.count ?? 0);
    if (count >= MAX_PENDING_CONSENTS) {
      internal.prepare(`DELETE FROM clank_oauth_consents WHERE token_hash IN (
        SELECT token_hash FROM clank_oauth_consents
        ORDER BY created_at ASC
        LIMIT ?
      )`).run(count - MAX_PENDING_CONSENTS + 1);
    }
    internal.prepare(`INSERT INTO clank_oauth_consents
      (token_hash, session_id, client_id, request_hash, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)`)
      .run(tokenHash, sessionId, parameters.clientId, requestHash, now + lifetimeMs, now);
  });
  return token;
}

async function consumeConsentProof(
  internal: SQLiteInternal,
  sessionId: string,
  parameters: AuthorizationParameters,
  value: unknown,
): Promise<boolean> {
  if (typeof value !== "string" || !/^clank_consent_[A-Za-z0-9_-]{32}$/u.test(value)) return false;
  const tokenHash = await digest(value);
  const requestHash = await digest(authorizationRequestBinding(parameters));
  const now = Date.now();
  const result = internal.prepare(`UPDATE clank_oauth_consents SET consumed_at = ?
    WHERE token_hash = ?
      AND session_id = ?
      AND client_id = ?
      AND request_hash = ?
      AND expires_at > ?
      AND consumed_at IS NULL`)
    .run(now, tokenHash, sessionId, parameters.clientId, requestHash, now);
  return Number(result.changes) === 1;
}

function authorizationRequestBinding(parameters: AuthorizationParameters): string {
  return JSON.stringify([
    parameters.clientId,
    parameters.redirectUri,
    parameters.state ?? "",
    parameters.codeChallenge,
    parameters.scope,
    parameters.resource,
  ]);
}

function validateRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    throw new OAuthRequestError("invalid_client_metadata", "redirect_uris must contain between 1 and 10 entries.");
  }
  const values = value.map((entry) => validateRedirectUri(requiredString(entry, "redirect_uri", 2_048)));
  if (new Set(values).size !== values.length) {
    throw new OAuthRequestError("invalid_client_metadata", "redirect_uris cannot contain duplicates.");
  }
  return values;
}

function validateRedirectUri(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new OAuthRequestError("invalid_request", "The redirect URI is invalid."); }
  if (url.hash || url.username || url.password) {
    throw new OAuthRequestError("invalid_request", "Redirect URIs cannot contain fragments or user information.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new OAuthRequestError("invalid_request", "Redirect URIs must use HTTPS or an HTTP loopback address.");
  }
  return url.href;
}

function validateRegistrationSet(value: unknown, allowed: string[], name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !allowed.includes(entry))) {
    throw new OAuthRequestError("invalid_client_metadata", `${name} contains an unsupported value.`);
  }
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new OAuthRequestError("invalid_request", "Expected application/json.");
  const text = await readBoundedText(request, maxBytes);
  try { return JSON.parse(text); }
  catch { throw new OAuthRequestError("invalid_request", "Request body must be valid JSON."); }
}

async function readBoundedForm(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new OAuthRequestError("invalid_request", "Expected application/x-www-form-urlencoded.");
  }
  const params = new URLSearchParams(await readBoundedText(request, maxBytes));
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key)) throw new OAuthRequestError("invalid_request", `Duplicate parameter: ${key}`);
    result[key] = value;
  }
  return result;
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await readRequestBytes(request, maxBytes);
  } catch (error) {
    if (error instanceof RequestInputError) {
      throw new OAuthRequestError("invalid_request", "Request body is too large.", error.status);
    }
    throw error;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OAuthRequestError("invalid_request", "Request body must be valid UTF-8.");
  }
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OAuthRequestError("invalid_request", `${name} is missing or invalid.`);
  }
  return value;
}

function optionalString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === "") return undefined;
  return requiredString(value, name, max);
}

function boundedPlainText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OAuthRequestError("invalid_request", `${name} is invalid.`);
  }
  return value.trim();
}

function parseStringArray(input: string): string[] {
  try {
    const value = JSON.parse(input);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseScopes(value: string): string[] {
  return value.split(/\s+/u).filter((scope) => AGENT_SCOPE_SET.has(scope));
}

function absolutePath(value: string, name: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#") || value.includes("..")) {
    throw new TypeError(`${name} must be an absolute URL path.`);
  }
  return value.length > 1 ? value.replace(/\/+$/u, "") : value;
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1_000) throw new TypeError(`${name} must be at least one second.`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(bytes));
}

async function pkceChallenge(verifier: string): Promise<string> {
  return digest(verifier);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index++) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scopeLabel(scope: string): string {
  return scope === "agent:write" ? "read and change application data" : "read application data";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function publicJson(value: unknown): Response {
  return Response.json(value, {
    headers: {
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}

function oauthHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function methodNotAllowed(allow: string): Response {
  return oauthProblem(405, "invalid_request", "Method not allowed.", { allow });
}

function oauthProblem(
  status: number,
  error: string,
  description: string,
  extraHeaders?: HeadersInit,
): Response {
  return Response.json({ error, error_description: description }, {
    status,
    headers: oauthHeaders(extraHeaders),
  });
}

function oauthError(error: unknown): Response {
  if (error instanceof OAuthRequestError) {
    return oauthProblem(error.status, error.oauthCode, error.message);
  }
  return oauthProblem(400, "invalid_request", "The OAuth request could not be completed.");
}

class OAuthRequestError extends Error {
  constructor(
    readonly oauthCode: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

class OAuthRedirectError extends Error {
  constructor(
    readonly oauthCode: string,
    readonly parameters: AuthorizationParameters,
  ) {
    super(oauthCode);
  }
}
