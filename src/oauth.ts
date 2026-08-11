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
  maxUserGrants?: number;
}

export interface AgentOAuthGrant {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly scopes: readonly McpScope[];
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly expiresAt: number;
}

export interface AgentOAuthGrantList {
  readonly protocol: "clank-agent-grants/1";
  readonly grants: readonly AgentOAuthGrant[];
  readonly hasMore: boolean;
  readonly managementPath: string;
  readonly grantsPath: string;
}

export interface ProjectOAuth<Profile extends object = DefaultAuthProfile> {
  readonly mcpPath: string;
  readonly oauthPrefix: string;
  readonly grantManagementPath: string;
  readonly grantsPath: string;
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
  const maxUserGrants = boundedInteger(options.maxUserGrants ?? 100, 1, 1_000, "maxUserGrants");
  const applicationName = boundedPlainText(options.applicationName ?? "Clank application", "applicationName", 120);
  const grantManagementPath = `${oauthPrefix}/access`;
  const grantsPath = `${oauthPrefix}/grants`;
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
      clank_agent_access_url: `${url.origin}${grantManagementPath}`,
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
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${origin}/.well-known/clank`,
      clank_agent_grants_endpoint: `${origin}${grantsPath}`,
      clank_agent_access_url: `${origin}${grantManagementPath}`,
    };
  };

  const oauth: ProjectOAuth<Profile> = {
    mcpPath,
    oauthPrefix,
    grantManagementPath,
    grantsPath,
    handles(request) {
      const path = new URL(request.url).pathname;
      return path === "/.well-known/oauth-protected-resource"
        || path === `/.well-known/oauth-protected-resource${mcpPath}`
        || path === "/.well-known/oauth-authorization-server"
        || path === "/.well-known/openid-configuration"
        || path === `${oauthPrefix}/register`
        || path === `${oauthPrefix}/authorize`
        || path === `${oauthPrefix}/token`
        || path === grantManagementPath
        || path === grantsPath
        || path.startsWith(`${grantsPath}/`);
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
        if (request.method === "OPTIONS") return oauthMachinePreflight();
        return oauthMachineResponse(await registerClient(request, internal, maxClients));
      }
      if (url.pathname === `${oauthPrefix}/authorize`) {
        return authorize(request, internal, options.auth, {
          applicationName,
          resource: resourceFor(request),
          codeLifetimeMs: authorizationCodeLifetimeMs,
          authorizePath: `${oauthPrefix}/authorize`,
          grantManagementPath,
        });
      }
      if (url.pathname === `${oauthPrefix}/token`) {
        if (request.method === "OPTIONS") return oauthMachinePreflight();
        return oauthMachineResponse(await exchangeToken(request, internal, {
          resource: resourceFor(request),
          accessTokenLifetimeMs,
          refreshTokenLifetimeMs,
          maxUserGrants,
        }));
      }
      if (url.pathname === grantManagementPath) {
        return manageAgentAccess(request, internal, options.auth, {
          applicationName,
          grantManagementPath,
          grantsPath,
        });
      }
      if (url.pathname === grantsPath || url.pathname.startsWith(`${grantsPath}/`)) {
        return agentGrantApi(request, internal, options.auth, {
          grantManagementPath,
          grantsPath,
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
    const applicationType = registrationApplicationType(raw.application_type, raw.redirect_uris);
    const redirectUris = validateRedirectUris(raw.redirect_uris, applicationType);
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
      application_type: applicationType,
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
    grantManagementPath: string;
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
      if (input.clank_login_recheck !== "1" && authError === undefined) {
        const target = new URL(request.url);
        target.searchParams.set("clank_login_recheck", "1");
        return authorizationHtml(sameSiteLoginRecheckPage(target.href));
      }
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
        consentPage(
          parameters,
          auth,
          options.applicationName,
          consentToken,
          options.grantManagementPath,
        ),
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
      return authorizationRedirect(parameters, { error: "access_denied" }, new URL(request.url).origin);
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
    return authorizationRedirect(parameters, { code: rawCode }, new URL(request.url).origin);
  } catch (error) {
    if (error instanceof OAuthRedirectError) {
      return authorizationRedirect(
        error.parameters,
        { error: error.oauthCode },
        new URL(request.url).origin,
      );
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
    maxUserGrants: number;
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
        if (activeGrantCount(internal, String(row.user_id), Date.now()) >= options.maxUserGrants) {
          throw new OAuthRequestError(
            "temporarily_unavailable",
            "This account has reached its active agent grant limit. Revoke an existing grant and try again.",
            503,
          );
        }
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

const MAX_VISIBLE_AGENT_GRANTS = 100;
const AGENT_GRANT_ID = /^clank_grant_([A-Za-z0-9_-]{24})$/u;

async function agentGrantApi<Profile extends object>(
  request: Request,
  internal: SQLiteInternal,
  authRuntime: AuthRuntime<Profile>,
  options: { grantManagementPath: string; grantsPath: string },
): Promise<Response> {
  try {
    const auth = await authRuntime.resolve(request);
    if (!auth.user) return agentGrantProblem(401, "UNAUTHENTICATED", "Sign in to manage agent access.");
    const path = new URL(request.url).pathname;
    if (path === options.grantsPath) {
      if (request.method !== "GET") return agentGrantMethodNotAllowed("GET");
      return privateJson(listAgentGrants(
        internal,
        auth.user.id,
        options.grantManagementPath,
        options.grantsPath,
      ));
    }
    const familyId = agentGrantFamily(path.slice(options.grantsPath.length + 1));
    if (!familyId) return agentGrantProblem(404, "GRANT_NOT_FOUND", "Agent grant not found.");
    if (request.method !== "PATCH" && request.method !== "DELETE") {
      return agentGrantMethodNotAllowed("PATCH, DELETE");
    }
    await authRuntime.verifyCsrf(request, auth);
    const action = request.method === "DELETE" ? "revoke" : await grantPatchAction(request);
    if (!mutateAgentGrant(internal, auth.user.id, familyId, action)) {
      return agentGrantProblem(404, "GRANT_NOT_FOUND", "Agent grant not found.");
    }
    return privateJson({
      ...listAgentGrants(internal, auth.user.id, options.grantManagementPath, options.grantsPath),
      updated: {
        grantId: grantId(familyId),
        action: action === "read" ? "reduced_to_read_only" : "revoked",
      },
    });
  } catch (error) {
    if (error instanceof AuthError) return agentGrantProblem(error.status, error.code, error.message);
    if (error instanceof OAuthRequestError) {
      return agentGrantProblem(error.status, "INVALID_GRANT_REQUEST", error.message);
    }
    return agentGrantProblem(400, "INVALID_GRANT_REQUEST", "The agent grant request could not be completed.");
  }
}

async function manageAgentAccess<Profile extends object>(
  request: Request,
  internal: SQLiteInternal,
  authRuntime: AuthRuntime<Profile>,
  options: {
    applicationName: string;
    grantManagementPath: string;
    grantsPath: string;
  },
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return methodNotAllowed("GET, POST");
  }
  try {
    const auth = await authRuntime.resolve(request);
    if (!auth.user) {
      return authorizationHtml(pageShell(
        "Agent access",
        `<p>Sign in to <strong>${escapeHtml(options.applicationName)}</strong> before reviewing agent access.</p>
        <div class="actions"><a class="button primary" href="/">Open application sign in</a></div>`,
      ), 401);
    }
    if (request.method === "POST") {
      const input = await readBoundedForm(request, 8 * 1024);
      if (
        !auth.session
        || !auth.csrfToken
        || !constantTimeEqual(String(input.csrf_token ?? ""), auth.csrfToken)
      ) {
        throw new OAuthRequestError("invalid_request", "The agent access request could not be verified.", 403);
      }
      const familyId = agentGrantFamily(requiredString(input.grant_id, "grant_id", 256));
      const decision = requiredString(input.decision, "decision", 32);
      const action = decision === "revoke" ? "revoke" : decision === "read" ? "read" : null;
      if (!familyId || !action) throw new OAuthRequestError("invalid_request", "The agent access action is invalid.");
      if (!mutateAgentGrant(internal, auth.user.id, familyId, action)) {
        throw new OAuthRequestError("invalid_request", "The agent grant is no longer active.", 404);
      }
      return new Response(null, {
        status: 303,
        headers: oauthHeaders({
          location: `${options.grantManagementPath}?updated=${action === "read" ? "read" : "revoked"}`,
        }),
      });
    }
    const listed = listAgentGrants(
      internal,
      auth.user.id,
      options.grantManagementPath,
      options.grantsPath,
    );
    const notice = new URL(request.url).searchParams.get("updated");
    return authorizationHtml(agentAccessPage(
      listed,
      auth,
      options.applicationName,
      notice === "read" ? "Grant reduced to read-only access."
        : notice === "revoked" ? "Agent access revoked."
          : undefined,
    ));
  } catch (error) {
    const message = error instanceof OAuthRequestError
      ? error.message
      : error instanceof AuthError
        ? error.message
        : "The agent access request could not be completed.";
    const status = error instanceof OAuthRequestError || error instanceof AuthError ? error.status : 400;
    return authorizationHtml(pageShell(
      "Agent access failed",
      `<p class="error" role="alert">${escapeHtml(message)}</p>
      <div class="actions"><a class="button" href="${escapeAttribute(options.grantManagementPath)}">Return to agent access</a></div>`,
    ), status);
  }
}

function listAgentGrants(
  internal: SQLiteInternal,
  userId: string,
  managementPath: string,
  grantsPath: string,
): AgentOAuthGrantList {
  const now = Date.now();
  const rows = internal.prepare(`SELECT
      t.family_id,
      t.client_id,
      c.client_name,
      MIN(t.created_at) AS created_at,
      MAX(CASE WHEN t.consumed_at IS NULL AND t.expires_at > ? THEN t.expires_at ELSE 0 END) AS expires_at,
      MAX(t.last_used_at) AS last_used_at,
      MAX(CASE
        WHEN t.consumed_at IS NULL AND t.expires_at > ?
          AND (' ' || t.scope || ' ') LIKE '% agent:write %'
        THEN 1 ELSE 0 END) AS can_write
    FROM clank_oauth_tokens t
    JOIN clank_oauth_clients c ON c.client_id = t.client_id
    WHERE t.user_id = ?
      AND EXISTS (
        SELECT 1 FROM clank_oauth_tokens active
        WHERE active.family_id = t.family_id
          AND active.user_id = t.user_id
          AND active.consumed_at IS NULL
          AND active.expires_at > ?
      )
    GROUP BY t.family_id, t.client_id, c.client_name
    ORDER BY COALESCE(MAX(t.last_used_at), MIN(t.created_at)) DESC, t.family_id ASC
    LIMIT ?`).all(now, now, userId, now, MAX_VISIBLE_AGENT_GRANTS + 1);
  return {
    protocol: "clank-agent-grants/1",
    grants: rows.slice(0, MAX_VISIBLE_AGENT_GRANTS).map((row) => ({
      id: grantId(String(row.family_id)),
      clientId: String(row.client_id),
      clientName: String(row.client_name),
      scopes: Number(row.can_write) === 1
        ? ["agent:read", "agent:write"] as const
        : ["agent:read"] as const,
      createdAt: Number(row.created_at),
      lastUsedAt: row.last_used_at === null || row.last_used_at === undefined
        ? null
        : Number(row.last_used_at),
      expiresAt: Number(row.expires_at),
    })),
    hasMore: rows.length > MAX_VISIBLE_AGENT_GRANTS,
    managementPath,
    grantsPath,
  };
}

function activeGrantCount(internal: SQLiteInternal, userId: string, now: number): number {
  return Number(internal.prepare(`SELECT COUNT(DISTINCT family_id) AS count
    FROM clank_oauth_tokens
    WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?`).get(userId, now)?.count ?? 0);
}

function mutateAgentGrant(
  internal: SQLiteInternal,
  userId: string,
  familyId: string,
  action: "read" | "revoke",
): boolean {
  const now = Date.now();
  const active = internal.prepare(`SELECT 1 AS active FROM clank_oauth_tokens
    WHERE family_id = ? AND user_id = ? AND consumed_at IS NULL AND expires_at > ?
    LIMIT 1`).get(familyId, userId, now);
  if (!active) return false;
  if (action === "read") {
    internal.prepare(`UPDATE clank_oauth_tokens SET scope = 'agent:read'
      WHERE family_id = ? AND user_id = ? AND consumed_at IS NULL`).run(familyId, userId);
  } else {
    internal.prepare(`UPDATE clank_oauth_tokens SET consumed_at = ?
      WHERE family_id = ? AND user_id = ? AND consumed_at IS NULL`).run(now, familyId, userId);
  }
  return true;
}

async function grantPatchAction(request: Request): Promise<"read"> {
  const input = await readBoundedJson(request, 8 * 1024);
  if (
    !isRecord(input)
    || Object.keys(input).length !== 1
    || !Array.isArray(input.scopes)
    || input.scopes.length !== 1
    || input.scopes[0] !== "agent:read"
  ) {
    throw new OAuthRequestError(
      "invalid_request",
      "A grant can only be reduced with scopes set to [\"agent:read\"].",
      422,
    );
  }
  return "read";
}

function agentGrantFamily(value: string): string | null {
  return AGENT_GRANT_ID.exec(value)?.[1] ?? null;
}

function grantId(familyId: string): string {
  return `clank_grant_${familyId}`;
}

function agentAccessPage<Profile extends object>(
  listed: AgentOAuthGrantList,
  auth: AuthRequest<Profile>,
  applicationName: string,
  notice?: string,
): string {
  const grants = listed.grants.length === 0
    ? `<div class="empty"><strong>No active agent access</strong><p>Connecting an MCP client will create a scoped, expiring grant here.</p></div>`
    : `<div class="grant-list">${listed.grants.map((grant) => {
        const writable = grant.scopes.includes("agent:write");
        return `<article class="grant">
          <div><h2>${escapeHtml(grant.clientName)} <span class="badge">Unverified client</span></h2>
          <p class="meta mono">${escapeHtml(grant.clientId)}</p></div>
          <dl><div><dt>Access</dt><dd>${writable ? "Read and write" : "Read-only"}</dd></div>
          <div><dt>Last used</dt><dd>${grant.lastUsedAt ? timeElement(grant.lastUsedAt) : "Not used yet"}</dd></div>
          <div><dt>Expires</dt><dd>${timeElement(grant.expiresAt)}</dd></div></dl>
          <form method="post">
            <input type="hidden" name="grant_id" value="${escapeAttribute(grant.id)}">
            <input type="hidden" name="csrf_token" value="${escapeAttribute(auth.csrfToken ?? "")}">
            <div class="actions">
              ${writable ? `<button class="button" name="decision" value="read" type="submit">Make read-only</button>` : ""}
              <button class="button danger" name="decision" value="revoke" type="submit">Revoke</button>
            </div>
          </form>
        </article>`;
      }).join("")}</div>`;
  return pageShell(
    `Agent access · ${escapeHtml(applicationName)}`,
    `<p>Review MCP clients acting as <strong>${escapeHtml(auth.user!.email)}</strong>. Changes take effect on the next agent request.</p>
    ${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ""}
    ${grants}
    ${listed.hasMore ? `<p class="meta">Only the ${MAX_VISIBLE_AGENT_GRANTS} most recent grants are shown.</p>` : ""}
    <div class="actions"><a class="button" href="/">Return to application</a>
    <a class="button" href="${escapeAttribute(listed.grantsPath)}">View JSON contract</a></div>`,
  );
}

function timeElement(value: number): string {
  const iso = new Date(value).toISOString();
  return `<time datetime="${iso}">${iso.replace("T", " ").replace(".000Z", " UTC")}</time>`;
}

function privateJson(value: unknown): Response {
  return Response.json(value, { headers: oauthHeaders() });
}

function agentGrantMethodNotAllowed(allow: string): Response {
  return agentGrantProblem(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { allow });
}

function agentGrantProblem(
  status: number,
  code: string,
  message: string,
  extraHeaders?: HeadersInit,
): Response {
  return Response.json({
    protocol: "clank-agent-grants/1",
    ok: false,
    error: { code, message },
  }, {
    status,
    headers: oauthHeaders(extraHeaders),
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
  issuer: string,
): Response {
  const target = new URL(parameters.redirectUri);
  if (result.code) target.searchParams.set("code", result.code);
  if (result.error) target.searchParams.set("error", result.error);
  if (parameters.state) target.searchParams.set("state", parameters.state);
  target.searchParams.set("iss", issuer);
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
  grantManagementPath: string,
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
    </form>
    <p class="meta"><a href="${escapeAttribute(grantManagementPath)}">Review existing agent access</a></p>`,
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

function sameSiteLoginRecheckPage(target: string): string {
  const escapedTarget = escapeAttribute(target);
  return pageShell(
    "Checking sign-in",
    `<p>Checking for an existing application session…</p>
    <p class="meta"><a href="${escapedTarget}">Continue if this page does not advance</a></p>`,
    `<meta http-equiv="refresh" content="0;url=${escapedTarget}">`,
  );
}

function pageShell(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${head}<title>${title}</title><style>
  :root{color-scheme:light dark;font:16px/1.55 system-ui,sans-serif}
  body{margin:0;background:#080b12;color:#e8edf7;min-height:100vh;display:grid;place-items:center}
  main{width:min(38rem,calc(100% - 2rem));box-sizing:border-box;padding:2rem;border:1px solid #273249;border-radius:1rem;background:#101724}
  h1{font-size:1.6rem;margin:0 0 1rem}.meta{color:#a8b4ca}.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.5rem}
  .field{display:grid;gap:.4rem;margin-top:1rem;font-weight:650}.field input{box-sizing:border-box;width:100%;border:1px solid #50617d;border-radius:.65rem;background:#080d18;color:#fff;padding:.75rem;font:inherit}
  .error{border:1px solid #ef6d7a;border-radius:.65rem;background:#35151c;color:#ffd9dd;padding:.75rem}
  .button{appearance:none;border:1px solid #50617d;border-radius:.65rem;background:#182238;color:#fff;padding:.7rem 1rem;text-decoration:none;font:inherit;cursor:pointer}
  .primary{background:#6ee7c7;color:#07110f;border-color:#6ee7c7;font-weight:700}.danger{border-color:#a94d5a;color:#ffd9dd}li+li{margin-top:.5rem}
  .notice,.empty{border:1px solid #315f57;border-radius:.75rem;background:#102821;padding:.85rem}.empty{border-color:#273249;background:#0b111d}.empty p{margin-bottom:0}
  .grant-list{display:grid;gap:1rem;margin-top:1.5rem}.grant{border:1px solid #273249;border-radius:.85rem;padding:1rem;background:#0b111d}.grant h2{font-size:1.05rem;margin:0}.grant p{margin:.2rem 0 0;overflow-wrap:anywhere}.grant dl{display:grid;gap:.5rem;margin:1rem 0}.grant dl div{display:flex;justify-content:space-between;gap:1rem}.grant dt{color:#a8b4ca}.grant dd{margin:0;text-align:right}.grant form .actions{margin-top:.75rem}.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.8rem}a{color:#9aead5}
  .badge{display:inline-block;margin-left:.35rem;border:1px solid #50617d;border-radius:999px;padding:.08rem .42rem;color:#a8b4ca;font-size:.7rem;font-weight:500;vertical-align:.1rem}@media(max-width:30rem){main{padding:1.25rem}.grant dl div{display:grid;gap:.1rem}.grant dd{text-align:left}}
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

function registrationApplicationType(
  value: unknown,
  redirectUris: unknown,
): "native" | "web" {
  if (value !== undefined && value !== "native" && value !== "web") {
    throw new OAuthRequestError("invalid_client_metadata", "application_type must be native or web.");
  }
  if (value === "native" || value === "web") return value;
  if (Array.isArray(redirectUris) && redirectUris.every((entry) => {
    if (typeof entry !== "string") return false;
    try {
      const url = new URL(entry);
      return url.protocol === "http:" && isLoopbackHost(url.hostname);
    } catch {
      return false;
    }
  })) return "native";
  return "web";
}

function validateRedirectUris(value: unknown, applicationType: "native" | "web"): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    throw new OAuthRequestError("invalid_client_metadata", "redirect_uris must contain between 1 and 10 entries.");
  }
  const values = value.map((entry) => validateRedirectUri(requiredString(entry, "redirect_uri", 2_048)));
  if (applicationType === "web" && values.some((entry) => new URL(entry).protocol !== "https:")) {
    throw new OAuthRequestError(
      "invalid_client_metadata",
      "Web clients must use HTTPS redirect URIs; loopback HTTP redirects require application_type native.",
    );
  }
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
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new OAuthRequestError("invalid_request", "Redirect URIs must use HTTPS or an HTTP loopback address.");
  }
  return url.href;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
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

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
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

function oauthMachineResponse(response: Response): Response {
  response.headers.set("access-control-allow-origin", "*");
  return response;
}

function oauthMachinePreflight(): Response {
  return oauthMachineResponse(new Response(null, {
    status: 204,
    headers: oauthHeaders({
      "access-control-allow-headers": "accept, authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-max-age": "600",
    }),
  }));
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
