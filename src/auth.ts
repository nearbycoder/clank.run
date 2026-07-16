import { batch, computed, signal, type Computed, type ReactiveSignal } from "./core.ts";
import { h, type Component, type Renderable } from "./dom.ts";
import {
  ValidationError,
  s,
  type InferSchemaShape,
  type Schema,
  type SchemaShape,
} from "./ai.ts";
import type { DatabaseSchema, SQLiteDatabase } from "./backend.ts";
import {
  RequestInputError,
  readJsonRequest,
  requestOriginAllowed,
} from "./security.ts";
import {
  SQLITE_INTERNAL,
  type SQLiteInternal,
} from "./sqlite-internal.ts";
import type { Middleware } from "./server.ts";
import {
  authenticationOptionsForBrowser,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  registrationOptionsForBrowser,
  serializeAuthenticationCredential,
  serializeRegistrationCredential,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
  type PasskeyAuthenticationCredential,
  type PasskeyRegistrationCredential,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type StoredPasskey,
} from "./webauthn.ts";

declare const AUTH_USER_ID: unique symbol;
export type AuthUserId = string & { readonly [AUTH_USER_ID]: true };

export interface DefaultAuthProfile {
  name?: string;
}

export interface AuthUser<Profile extends object = DefaultAuthProfile> {
  id: AuthUserId;
  email: string;
  emailVerified: boolean;
  role: string;
  profile: Profile;
  createdAt: number;
  updatedAt: number;
}

export interface AuthSession {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface AuthState<Profile extends object = DefaultAuthProfile> {
  user: AuthUser<Profile> | null;
  session: AuthSession | null;
  csrfToken?: string;
}

export interface AuthRequest<Profile extends object = DefaultAuthProfile> extends AuthState<Profile> {
  requireUser(): AuthUser<Profile>;
  requireVerified(): AuthUser<Profile>;
  requireRole(...roles: string[]): AuthUser<Profile>;
}

export interface AuthCookieOptions {
  name?: string;
  secure?: boolean | "auto";
  sameSite?: "Strict" | "Lax";
}

export interface PasswordOptions {
  minLength?: number;
  maxBytes?: number;
  cost?: number;
  blockSize?: number;
  parallelization?: number;
  maxMemory?: number;
  concurrency?: number;
  maxQueue?: number;
  pepper?: string;
}

export interface AuthRateLimitOptions {
  attempts?: number;
  windowMs?: number;
  store?: AuthRateLimitStore;
}

export interface AuthRateLimitStore {
  consume(key: string, limit: number, windowMs: number): number | undefined | Promise<number | undefined>;
  clear?(key: string): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface AuthDelivery {
  userId: AuthUserId;
  email: string;
  token: string;
  expiresAt: number;
}

export interface AuthEmailVerificationOptions {
  required?: boolean;
  tokenLifetimeMs?: number;
  send?: (delivery: AuthDelivery) => void | Promise<void>;
}

export interface AuthPasswordRecoveryOptions {
  tokenLifetimeMs?: number;
  send?: (delivery: AuthDelivery) => void | Promise<void>;
}

export interface AuthMfaOptions {
  required?: boolean;
  codeLifetimeMs?: number;
  send?: (delivery: AuthDelivery & { code: string }) => void | Promise<void>;
}

export interface AuthPasskeyOptions {
  enabled?: boolean;
  rpName?: string;
  rpId?: string;
  allowedOrigins?: readonly string[];
  challengeLifetimeMs?: number;
  requireUserVerification?: boolean;
}

export interface AuthBotProtectionOptions {
  verify(input: {
    request: Request;
    action: "register" | "login" | "recover";
    token?: string;
  }): boolean | Promise<boolean>;
}

export interface AuthDefinitionOptions<ProfileShape extends SchemaShape> {
  profile?: ProfileShape;
  signup?: boolean;
  defaultRole?: string;
  sessionDurationMs?: number;
  idleTimeoutMs?: number;
  touchIntervalMs?: number;
  cookie?: AuthCookieOptions;
  password?: PasswordOptions;
  rateLimit?: AuthRateLimitOptions;
  emailVerification?: AuthEmailVerificationOptions;
  passwordRecovery?: AuthPasswordRecoveryOptions;
  mfa?: AuthMfaOptions;
  passkeys?: AuthPasskeyOptions;
  botProtection?: AuthBotProtectionOptions;
}

export interface AuthDefinition<Profile extends object = DefaultAuthProfile> {
  readonly profile: Schema<Profile>;
  readonly signup: boolean;
  readonly defaultRole: string;
  readonly sessionDurationMs: number;
  readonly idleTimeoutMs: number;
  readonly touchIntervalMs: number;
  readonly cookie: Required<Omit<AuthCookieOptions, "name">> & { name?: string };
  readonly password: Required<Omit<PasswordOptions, "pepper">> & { pepper?: string };
  readonly rateLimit: Required<Omit<AuthRateLimitOptions, "store">> & { store?: AuthRateLimitStore };
  readonly emailVerification: Required<Omit<AuthEmailVerificationOptions, "send">> & {
    send?: AuthEmailVerificationOptions["send"];
  };
  readonly passwordRecovery: Required<Omit<AuthPasswordRecoveryOptions, "send">> & {
    send?: AuthPasswordRecoveryOptions["send"];
  };
  readonly mfa: Required<Omit<AuthMfaOptions, "send">> & { send?: AuthMfaOptions["send"] };
  readonly passkeys: Required<Omit<AuthPasskeyOptions, "rpId" | "allowedOrigins">> & {
    rpId?: string;
    allowedOrigins: readonly string[];
  };
  readonly botProtection?: AuthBotProtectionOptions;
}

export function defineAuth(): AuthDefinition<DefaultAuthProfile>;
export function defineAuth<const ProfileShape extends SchemaShape>(
  options: AuthDefinitionOptions<ProfileShape>,
): AuthDefinition<InferSchemaShape<ProfileShape>>;
export function defineAuth<const ProfileShape extends SchemaShape>(
  options: AuthDefinitionOptions<ProfileShape> = {},
): AuthDefinition<InferSchemaShape<ProfileShape> | DefaultAuthProfile> {
  const profile = options.profile
    ? s.object(options.profile)
    : s.object({ name: s.optional(s.string({ max: 120 })) });
  const password = {
    minLength: options.password?.minLength ?? 12,
    maxBytes: options.password?.maxBytes ?? 1_024,
    cost: options.password?.cost ?? 2 ** 17,
    blockSize: options.password?.blockSize ?? 8,
    parallelization: options.password?.parallelization ?? 1,
    maxMemory: options.password?.maxMemory ?? 256 * 1024 * 1024,
    concurrency: options.password?.concurrency ?? 2,
    maxQueue: options.password?.maxQueue ?? 16,
    ...(options.password?.pepper === undefined ? {} : { pepper: options.password.pepper }),
  };
  validatePasswordOptions(password);
  const definition = {
    profile,
    signup: options.signup ?? true,
    defaultRole: validateRole(options.defaultRole ?? "user"),
    sessionDurationMs: positiveDuration(options.sessionDurationMs ?? 30 * 24 * 60 * 60 * 1_000, "sessionDurationMs"),
    idleTimeoutMs: positiveDuration(options.idleTimeoutMs ?? 7 * 24 * 60 * 60 * 1_000, "idleTimeoutMs"),
    touchIntervalMs: positiveDuration(options.touchIntervalMs ?? 5 * 60 * 1_000, "touchIntervalMs"),
    cookie: {
      secure: options.cookie?.secure ?? "auto",
      sameSite: options.cookie?.sameSite ?? "Strict",
      ...(options.cookie?.name === undefined ? {} : { name: validateCookieName(options.cookie.name) }),
    },
    password,
    rateLimit: {
      attempts: positiveInteger(options.rateLimit?.attempts ?? 10, "rateLimit.attempts"),
      windowMs: positiveDuration(options.rateLimit?.windowMs ?? 10 * 60 * 1_000, "rateLimit.windowMs"),
      ...(options.rateLimit?.store ? { store: options.rateLimit.store } : {}),
    },
    emailVerification: {
      required: options.emailVerification?.required ?? false,
      tokenLifetimeMs: positiveDuration(
        options.emailVerification?.tokenLifetimeMs ?? 24 * 60 * 60 * 1_000,
        "emailVerification.tokenLifetimeMs",
      ),
      ...(options.emailVerification?.send ? { send: options.emailVerification.send } : {}),
    },
    passwordRecovery: {
      tokenLifetimeMs: positiveDuration(
        options.passwordRecovery?.tokenLifetimeMs ?? 30 * 60 * 1_000,
        "passwordRecovery.tokenLifetimeMs",
      ),
      ...(options.passwordRecovery?.send ? { send: options.passwordRecovery.send } : {}),
    },
    mfa: {
      required: options.mfa?.required ?? false,
      codeLifetimeMs: positiveDuration(options.mfa?.codeLifetimeMs ?? 10 * 60 * 1_000, "mfa.codeLifetimeMs"),
      ...(options.mfa?.send ? { send: options.mfa.send } : {}),
    },
    passkeys: {
      enabled: options.passkeys?.enabled ?? true,
      rpName: options.passkeys?.rpName?.trim() || "Clank application",
      ...(options.passkeys?.rpId ? { rpId: validateRpId(options.passkeys.rpId) } : {}),
      allowedOrigins: Object.freeze([...(options.passkeys?.allowedOrigins ?? [])].map(validateOrigin)),
      challengeLifetimeMs: positiveDuration(
        options.passkeys?.challengeLifetimeMs ?? 5 * 60 * 1_000,
        "passkeys.challengeLifetimeMs",
      ),
      requireUserVerification: options.passkeys?.requireUserVerification ?? true,
    },
    ...(options.botProtection ? { botProtection: options.botProtection } : {}),
  };
  if (definition.emailVerification.required && !definition.emailVerification.send) {
    throw new TypeError("emailVerification.send is required when email verification is required.");
  }
  if (definition.mfa.required && !definition.mfa.send) {
    throw new TypeError("mfa.send is required when MFA is required.");
  }
  if (definition.idleTimeoutMs > definition.sessionDurationMs) {
    throw new TypeError("idleTimeoutMs cannot exceed sessionDurationMs.");
  }
  return Object.freeze(definition) as AuthDefinition<InferSchemaShape<ProfileShape> | DefaultAuthProfile>;
}

type RegisterProfile<Profile extends object> = {} extends Profile
  ? { profile?: Profile }
  : { profile: Profile };
export type AuthRegisterInput<Profile extends object> = {
  email: string;
  password: string;
  botToken?: string;
} & RegisterProfile<Profile>;

export interface AuthLoginInput {
  email: string;
  password: string;
  botToken?: string;
}

export interface AuthMfaChallenge {
  required: true;
  challengeId: string;
  expiresAt: number;
}

export interface AuthPasskeyRecord {
  id: string;
  name: string;
  transports: readonly string[];
  createdAt: number;
  lastUsedAt?: number;
}

export class AuthError extends Error {
  readonly name = "AuthError";
  constructor(readonly code: string, message: string, readonly status = 400, readonly retryAfter?: number) {
    super(message);
  }
}

interface StoredSession<Profile extends object> extends AuthRequest<Profile> {
  csrfToken: string;
}

/** Returns the serializable subset intended for SSR boot state. */
export function authState<Profile extends object>(auth: AuthRequest<Profile>): AuthState<Profile> {
  return {
    user: auth.user,
    session: auth.session,
    ...(auth.csrfToken ? { csrfToken: auth.csrfToken } : {}),
  };
}

export interface AuthRuntime<Profile extends object = DefaultAuthProfile> {
  readonly definition: AuthDefinition<Profile>;
  resolve(request: Request): Promise<AuthRequest<Profile>>;
  handle(request: Request, prefix?: string): Promise<Response>;
  middleware<State extends Record<string, unknown> & { auth?: AuthRequest<Profile> }>(): Middleware<State>;
  setRole(userId: AuthUserId, role: string): void;
  disableUser(userId: AuthUserId, disabled?: boolean): void;
  revokeUserSessions(userId: AuthUserId): void;
  verifyCsrf(request: Request, auth: AuthRequest<Profile>): Promise<void>;
  isSessionActive(sessionId: string): boolean;
  refreshSession(sessionId: string): AuthRequest<Profile> | null;
  subscribeSession(sessionId: string, listener: () => void): () => void;
  subscribeUser(userId: AuthUserId, listener: () => void): () => void;
  /** @internal Called when the persisted database journal observes an auth change. */
  notifyUserChange(userId: AuthUserId): void;
  /** @internal Conservatively invalidates every live identity after a journal gap. */
  notifyAllUserChanges(): void;
  close(): void;
}

export interface OpenAuthOptions {
  onError?: (error: unknown) => void;
}

export async function openAuth<Profile extends object, DB extends DatabaseSchema<any>>(
  definition: AuthDefinition<Profile>,
  database: SQLiteDatabase<DB>,
  options: OpenAuthOptions = {},
): Promise<AuthRuntime<Profile>> {
  const internal = (database as SQLiteDatabase<DB> & { [SQLITE_INTERNAL]: SQLiteInternal })[SQLITE_INTERNAL];
  if (!internal) throw new Error("Auth requires a Clank SQLite database.");
  createAuthTables(internal);
  const passwordQueue = createWorkQueue(definition.password.concurrency, definition.password.maxQueue);
  const dummyHash = await passwordQueue(() => hashPassword("A deliberately invalid Clank password.", definition.password));
  const limiter = createRateLimiter(definition.rateLimit.store);
  const sessionListeners = new Map<string, Set<() => void>>();
  const userListeners = new Map<string, Set<() => void>>();
  let closed = false;
  const reportError = (error: unknown) => {
    try { options.onError?.(error); } catch { /* Observability hooks cannot affect auth behavior. */ }
  };

  const ensureOpen = () => {
    if (closed) throw new Error("Auth runtime is closed.");
  };

  const notifySession = (id: string) => {
    for (const listener of [...(sessionListeners.get(id) ?? [])]) {
      try { listener(); } catch (error) { reportError(error); }
    }
    sessionListeners.delete(id);
  };

  const notifyUser = (userId: string) => {
    for (const listener of [...(userListeners.get(userId) ?? [])]) {
      try { listener(); } catch (error) { reportError(error); }
    }
  };

  const notifyUserSessions = (userId: string) => {
    const rows = internal.prepare("SELECT id FROM clank_auth_sessions WHERE user_id = ?").all(userId);
    for (const row of rows) notifySession(String(row.id));
  };

  const revokeSessions = (userId: string, exceptId?: string) => {
    const rows = internal.prepare(`SELECT id FROM clank_auth_sessions WHERE user_id = ?${exceptId ? " AND id != ?" : ""}`)
      .all(...(exceptId ? [userId, exceptId] : [userId]));
    internal.transaction((changes) => {
      const result = internal.prepare(`DELETE FROM clank_auth_sessions WHERE user_id = ?${exceptId ? " AND id != ?" : ""}`)
        .run(...(exceptId ? [userId, exceptId] : [userId]));
      if (Number(result.changes) > 0) changes.record("__auth", userId, userId);
    });
    for (const row of rows) notifySession(String(row.id));
  };

  const createSession = async (userId: AuthUserId): Promise<{ rawToken: string; auth: StoredSession<Profile> }> => {
    const now = Date.now();
    const rawToken = await randomToken(32);
    const csrfToken = await randomToken(24);
    const id = await randomToken(18);
    const tokenHash = await digest(rawToken);
    const expiresAt = now + definition.sessionDurationMs;
    const idleExpiresAt = Math.min(expiresAt, now + definition.idleTimeoutMs);
    internal.transaction((changes) => {
      internal.prepare(`INSERT INTO clank_auth_sessions
        (id, token_hash, user_id, csrf_token, created_at, last_seen_at, idle_expires_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tokenHash, userId, csrfToken, now, now, idleExpiresAt, expiresAt);
      changes.record("__auth", userId, userId);
    });
    const row = sessionRow(internal, tokenHash);
    if (!row) throw new Error("New auth session could not be read.");
    return { rawToken, auth: authFromRow(definition, row) };
  };

  const issueToken = async (
    userId: AuthUserId,
    type: "email_verification" | "password_recovery",
    lifetimeMs: number,
  ): Promise<{ token: string; expiresAt: number }> => {
    const token = await randomToken(32);
    const tokenHash = await digest(token);
    const expiresAt = Date.now() + lifetimeMs;
    internal.transaction((changes) => {
      internal.prepare("DELETE FROM clank_auth_tokens WHERE user_id = ? AND type = ?").run(userId, type);
      internal.prepare(`INSERT INTO clank_auth_tokens
        (token_hash, user_id, type, expires_at, consumed_at, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)`)
        .run(tokenHash, userId, type, expiresAt, Date.now());
      changes.record("__auth", userId, userId);
    });
    return { token, expiresAt };
  };

  const consumeToken = async (
    token: unknown,
    type: "email_verification" | "password_recovery",
  ): Promise<AuthUserId> => {
    if (typeof token !== "string" || token.length < 20 || token.length > 512) {
      throw new AuthError("INVALID_TOKEN", "This authentication link is invalid or expired.", 400);
    }
    const tokenHash = await digest(token);
    const row = internal.prepare(`SELECT token_hash, user_id, expires_at, consumed_at
      FROM clank_auth_tokens WHERE token_hash = ? AND type = ?`).get(tokenHash, type);
    if (!row || row.consumed_at !== null || Number(row.expires_at) <= Date.now()) {
      throw new AuthError("INVALID_TOKEN", "This authentication link is invalid or expired.", 400);
    }
    const userId = String(row.user_id) as AuthUserId;
    let consumed = false;
    internal.transaction((changes) => {
      const result = internal.prepare(`UPDATE clank_auth_tokens SET consumed_at = ?
        WHERE token_hash = ? AND type = ? AND consumed_at IS NULL AND expires_at > ?`)
        .run(Date.now(), tokenHash, type, Date.now());
      consumed = Number(result.changes) === 1;
      if (consumed) changes.record("__auth", userId, userId);
    });
    if (!consumed) throw new AuthError("INVALID_TOKEN", "This authentication link is invalid or expired.", 400);
    return userId;
  };

  const deliverVerification = async (userId: AuthUserId, email: string): Promise<void> => {
    if (!definition.emailVerification.send) return;
    const issued = await issueToken(userId, "email_verification", definition.emailVerification.tokenLifetimeMs);
    await definition.emailVerification.send({ userId, email, token: issued.token, expiresAt: issued.expiresAt });
  };

  const passkeyContext = (request: Request): { origin: string; rpId: string } => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") ?? url.origin;
    let parsed: URL;
    try { parsed = new URL(origin); }
    catch { throw new AuthError("ORIGIN_MISMATCH", "Passkey origin is invalid.", 403); }
    if (parsed.origin !== origin || !["https:", "http:"].includes(parsed.protocol)) {
      throw new AuthError("ORIGIN_MISMATCH", "Passkey origin is invalid.", 403);
    }
    if (definition.passkeys.allowedOrigins.length > 0 && !definition.passkeys.allowedOrigins.includes(origin)) {
      throw new AuthError("ORIGIN_MISMATCH", "Passkey origin is not allowed.", 403);
    }
    const rpId = definition.passkeys.rpId ?? validateRpId(parsed.hostname);
    if (parsed.hostname !== rpId && !parsed.hostname.endsWith(`.${rpId}`)) {
      throw new AuthError("ORIGIN_MISMATCH", "Passkey RP ID does not match this origin.", 403);
    }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new AuthError("ORIGIN_MISMATCH", "Passkeys require a secure origin.", 403);
    }
    return { origin, rpId };
  };

  const createPasskeyChallenge = async (
    type: "registration" | "authentication",
    request: Request,
    userId?: AuthUserId,
  ): Promise<{ id: string; challenge: string; expiresAt: number; origin: string; rpId: string }> => {
    const { origin, rpId } = passkeyContext(request);
    const id = await randomToken(18);
    const challenge = await randomToken(32);
    const expiresAt = Date.now() + definition.passkeys.challengeLifetimeMs;
    internal.prepare(`INSERT INTO clank_auth_passkey_challenges
      (id, type, challenge_hash, user_id, origin, rp_id, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(id, type, await digest(challenge), userId ?? null, origin, rpId, expiresAt, Date.now());
    return { id, challenge, expiresAt, origin, rpId };
  };

  const consumePasskeyChallenge = async (
    id: unknown,
    challenge: unknown,
    type: "registration" | "authentication",
  ): Promise<Record<string, unknown>> => {
    if (typeof id !== "string" || typeof challenge !== "string") {
      throw new AuthError("INVALID_PASSKEY", "Passkey challenge is invalid or expired.", 400);
    }
    const row = internal.prepare(`SELECT * FROM clank_auth_passkey_challenges
      WHERE id = ? AND type = ?`).get(id, type);
    const valid = row
      && row.consumed_at === null
      && Number(row.expires_at) > Date.now()
      && await timingSafeStringEqual(String(row.challenge_hash), await digest(challenge));
    if (!valid) throw new AuthError("INVALID_PASSKEY", "Passkey challenge is invalid or expired.", 400);
    const result = internal.prepare(`UPDATE clank_auth_passkey_challenges SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`).run(Date.now(), id, Date.now());
    if (Number(result.changes) !== 1) {
      throw new AuthError("INVALID_PASSKEY", "Passkey challenge is invalid or expired.", 400);
    }
    return row;
  };

  const resolve = async (request: Request): Promise<AuthRequest<Profile>> => {
    ensureOpen();
    const cookieHeader = request.headers.get("cookie");
    const token = cookieValue(cookieHeader, cookieName(definition, request))
      ?? (definition.cookie.name ? undefined : cookieValue(cookieHeader, legacyCookieName(definition, request)));
    if (!token) return anonymousAuth();
    const tokenHash = await digest(token);
    const row = sessionRow(internal, tokenHash);
    if (!row) return anonymousAuth();
    const now = Date.now();
    const sessionId = String(row.session_id);
    if (Number(row.disabled) !== 0 || Number(row.expires_at) <= now || Number(row.idle_expires_at) <= now) {
      internal.transaction((changes) => {
        const result = internal.prepare("DELETE FROM clank_auth_sessions WHERE id = ?").run(sessionId);
        if (Number(result.changes) > 0) changes.record("__auth", String(row.user_id), String(row.user_id));
      });
      notifySession(sessionId);
      return anonymousAuth();
    }
    if (now - Number(row.last_seen_at) >= definition.touchIntervalMs) {
      const idle = Math.min(Number(row.expires_at), now + definition.idleTimeoutMs);
      internal.prepare("UPDATE clank_auth_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?")
        .run(now, idle, sessionId);
      row.last_seen_at = now;
      row.idle_expires_at = idle;
    }
    return authFromRow(definition, row);
  };

  const verifyBot = async (
    request: Request,
    action: "register" | "login" | "recover",
    raw: unknown,
  ): Promise<void> => {
    if (!definition.botProtection) return;
    const token = raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).botToken
      : undefined;
    const allowed = await definition.botProtection.verify({
      request,
      action,
      ...(typeof token === "string" ? { token } : {}),
    });
    if (!allowed) throw new AuthError("BOT_CHECK_FAILED", "The request could not be verified.", 403);
  };

  const beginMfa = async (userId: AuthUserId, email: string): Promise<AuthMfaChallenge> => {
    const id = await randomToken(18);
    const code = String(await randomInteger(0, 1_000_000)).padStart(6, "0");
    const expiresAt = Date.now() + definition.mfa.codeLifetimeMs;
    internal.prepare("DELETE FROM clank_auth_mfa_challenges WHERE user_id = ?").run(userId);
    internal.prepare(`INSERT INTO clank_auth_mfa_challenges
      (id, user_id, code_hash, attempts, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, 0, ?, NULL, ?)`)
      .run(id, userId, await digest(`${id}:${code}`), expiresAt, Date.now());
    await definition.mfa.send!({ userId, email, token: id, code, expiresAt });
    return { required: true, challengeId: id, expiresAt };
  };

  const register = async (raw: unknown, request: Request): Promise<{ rawToken: string; auth: StoredSession<Profile> }> => {
    if (!definition.signup) throw new AuthError("SIGNUP_DISABLED", "Account registration is disabled.", 403);
    await verifyBot(request, "register", raw);
    const input = credentialInput(raw, definition, true);
    await enforceRateLimit(limiter, definition.rateLimit, request, input.email, "register");
    const passwordHash = await passwordQueue(() => hashPassword(input.password, definition.password));
    const userId = await randomToken(18) as AuthUserId;
    const now = Date.now();
    const emailVerifiedAt = definition.emailVerification.send ? null : now;
    try {
      internal.transaction((changes) => {
        internal.prepare(`INSERT INTO clank_auth_users
          (id, email, email_verified_at, password_hash, role, profile, disabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`)
          .run(userId, input.email, emailVerifiedAt, passwordHash, definition.defaultRole, JSON.stringify(input.profile), now, now);
        changes.record("__auth", userId, userId);
      });
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) {
        throw new AuthError("ACCOUNT_UNAVAILABLE", "An account could not be created with those credentials.", 409);
      }
      throw error;
    }
    await deliverVerification(userId, input.email);
    return createSession(userId);
  };

  const login = async (
    raw: unknown,
    request: Request,
  ): Promise<{ session: { rawToken: string; auth: StoredSession<Profile> } } | { mfa: AuthMfaChallenge }> => {
    await verifyBot(request, "login", raw);
    const input = credentialInput(raw, definition, false);
    await enforceRateLimit(limiter, definition.rateLimit, request, input.email, "login");
    const row = internal.prepare("SELECT id, email, password_hash, disabled FROM clank_auth_users WHERE email = ?").get(input.email);
    const stored = row && Number(row.disabled) === 0 ? String(row.password_hash) : dummyHash;
    const valid = await passwordQueue(() => verifyPassword(input.password, stored, definition.password));
    if (!row || Number(row.disabled) !== 0 || !valid) {
      throw new AuthError("INVALID_CREDENTIALS", "Email or password is incorrect.", 401);
    }
    await limiter.clear(rateLimitKey(request, input.email, "login"));
    const userId = String(row.id) as AuthUserId;
    if (definition.mfa.required) return { mfa: await beginMfa(userId, String(row.email)) };
    return { session: await createSession(userId) };
  };

  const runtime: AuthRuntime<Profile> = {
    definition,
    resolve,
    async handle(request, prefix = "/__clank/auth") {
      const url = new URL(request.url);
      const normalizedPrefix = `/${prefix.replace(/^\/+|\/+$/g, "")}`;
      if (url.pathname !== normalizedPrefix && !url.pathname.startsWith(`${normalizedPrefix}/`)) {
        return authProblem(404, "NOT_FOUND", "Auth endpoint not found.");
      }
      const operation = url.pathname.slice(normalizedPrefix.length).replace(/^\/+/, "");
      try {
        if (request.method === "GET" && operation === "session") {
          const auth = await resolve(request);
          return authJson({ ok: true, user: auth.user, session: auth.session, csrfToken: auth.csrfToken });
        }
        if (request.method === "GET" && operation === "passkeys") {
          if (!definition.passkeys.enabled) throw new AuthError("PASSKEYS_DISABLED", "Passkeys are disabled.", 404);
          const auth = await resolve(request);
          const user = auth.requireVerified();
          const rows = internal.prepare(`SELECT credential_id, name, transports, created_at, last_used_at
            FROM clank_auth_passkeys WHERE user_id = ? ORDER BY created_at, credential_id`).all(user.id);
          return authJson({
            ok: true,
            passkeys: rows.map(passkeyRecordFromRow),
          });
        }
        if (request.method !== "POST") return authProblem(405, "METHOD_NOT_ALLOWED", "Method not allowed.", undefined, { allow: "GET, POST" });
        if (!requestOriginAllowed(request)) throw new AuthError("ORIGIN_MISMATCH", "Cross-origin auth request rejected.", 403);
        if (operation === "register") {
          const result = await register(await readJsonRequest(request, 16 * 1024), request);
          return sessionResponse(definition, request, result.rawToken, result.auth, 201);
        }
        if (operation === "login") {
          const result = await login(await readJsonRequest(request, 16 * 1024), request);
          if ("mfa" in result) return authJson({ ok: true, mfa: result.mfa }, { status: 202 });
          return sessionResponse(definition, request, result.session.rawToken, result.session.auth);
        }
        if (operation === "mfa/verify") {
          const input = objectInput(await readJsonRequest(request, 8 * 1024), "Invalid MFA input.");
          const challengeId = boundedString(input.challengeId, "MFA challenge is required.", 512);
          const code = boundedString(input.code, "MFA code is required.", 16);
          const row = internal.prepare(`SELECT id, user_id, code_hash, attempts, expires_at, consumed_at
            FROM clank_auth_mfa_challenges WHERE id = ?`).get(challengeId);
          const expected = await digest(`${challengeId}:${code}`);
          const valid = row
            && row.consumed_at === null
            && Number(row.expires_at) > Date.now()
            && Number(row.attempts) < 5
            && await timingSafeStringEqual(String(row.code_hash), expected);
          if (!valid) {
            if (row && row.consumed_at === null) {
              internal.prepare(`UPDATE clank_auth_mfa_challenges
                SET attempts = attempts + 1, consumed_at = CASE WHEN attempts + 1 >= 5 THEN ? ELSE NULL END
                WHERE id = ?`).run(Date.now(), challengeId);
            }
            throw new AuthError("INVALID_MFA", "The verification code is invalid or expired.", 401);
          }
          const consumed = internal.prepare(`UPDATE clank_auth_mfa_challenges SET consumed_at = ?
            WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < 5`)
            .run(Date.now(), challengeId, Date.now());
          if (Number(consumed.changes) !== 1) {
            throw new AuthError("INVALID_MFA", "The verification code is invalid or expired.", 401);
          }
          const result = await createSession(String(row.user_id) as AuthUserId);
          return sessionResponse(definition, request, result.rawToken, result.auth);
        }
        if (operation === "email/verify") {
          const input = objectInput(await readJsonRequest(request, 8 * 1024), "Invalid verification input.");
          const userId = await consumeToken(input.token, "email_verification");
          internal.transaction((changes) => {
            internal.prepare(`UPDATE clank_auth_users
              SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?`)
              .run(Date.now(), Date.now(), userId);
            changes.record("__auth", userId, userId);
          });
          notifyUserSessions(userId);
          return authJson({ ok: true, verified: true });
        }
        if (operation === "password/recover") {
          const input = objectInput(await readJsonRequest(request, 8 * 1024), "Invalid recovery input.");
          await verifyBot(request, "recover", input);
          const email = normalizeEmail(input.email);
          await enforceRateLimit(limiter, definition.rateLimit, request, email, "recover");
          const row = internal.prepare("SELECT id, email, disabled FROM clank_auth_users WHERE email = ?").get(email);
          if (row && Number(row.disabled) === 0 && definition.passwordRecovery.send) {
            const userId = String(row.id) as AuthUserId;
            const issued = await issueToken(userId, "password_recovery", definition.passwordRecovery.tokenLifetimeMs);
            await definition.passwordRecovery.send({
              userId,
              email: String(row.email),
              token: issued.token,
              expiresAt: issued.expiresAt,
            });
          }
          return authJson({ ok: true, accepted: true }, { status: 202 });
        }
        if (operation === "password/reset") {
          const input = objectInput(await readJsonRequest(request, 16 * 1024), "Invalid reset input.");
          const password = validatePassword(input.password, definition.password);
          const userId = await consumeToken(input.token, "password_recovery");
          const next = await passwordQueue(() => hashPassword(password, definition.password));
          internal.transaction((changes) => {
            internal.prepare("UPDATE clank_auth_users SET password_hash = ?, updated_at = ? WHERE id = ?")
              .run(next, Date.now(), userId);
            changes.record("__auth", userId, userId);
          });
          revokeSessions(userId);
          const result = await createSession(userId);
          return sessionResponse(definition, request, result.rawToken, result.auth);
        }
        if (operation === "passkeys/authenticate/start") {
          if (!definition.passkeys.enabled) throw new AuthError("PASSKEYS_DISABLED", "Passkeys are disabled.", 404);
          const input = objectInput(await readJsonRequest(request, 8 * 1024), "Invalid passkey input.");
          const email = normalizeEmail(input.email);
          await enforceRateLimit(limiter, definition.rateLimit, request, email, "passkey");
          const userRow = internal.prepare("SELECT id FROM clank_auth_users WHERE email = ? AND disabled = 0").get(email);
          const userId = userRow ? String(userRow.id) as AuthUserId : undefined;
          const challenge = await createPasskeyChallenge("authentication", request, userId);
          const credentials = userId
            ? internal.prepare("SELECT credential_id, transports FROM clank_auth_passkeys WHERE user_id = ?").all(userId)
            : [];
          const options = passkeyAuthenticationOptions({
            challenge: challenge.challenge,
            rpId: challenge.rpId,
            credentialIds: credentials.map((row) => ({
              id: String(row.credential_id),
              transports: parseStringArray(row.transports),
            })),
            timeoutMs: definition.passkeys.challengeLifetimeMs,
            requireUserVerification: definition.passkeys.requireUserVerification,
          });
          return authJson({ ok: true, challengeId: challenge.id, expiresAt: challenge.expiresAt, options });
        }
        if (operation === "passkeys/authenticate/finish") {
          if (!definition.passkeys.enabled) throw new AuthError("PASSKEYS_DISABLED", "Passkeys are disabled.", 404);
          const input = objectInput(await readJsonRequest(request, 96 * 1024), "Invalid passkey input.");
          const credential = input.credential as PasskeyAuthenticationCredential;
          const challengeRow = await consumePasskeyChallenge(input.challengeId, input.challenge, "authentication");
          if (!challengeRow.user_id || !credential || typeof credential.rawId !== "string") {
            throw new AuthError("INVALID_PASSKEY", "Passkey authentication failed.", 401);
          }
          const passkey = internal.prepare(`SELECT credential_id, user_id, public_key, algorithm, counter, transports
            FROM clank_auth_passkeys WHERE credential_id = ? AND user_id = ?`)
            .get(credential.rawId, challengeRow.user_id);
          if (!passkey) throw new AuthError("INVALID_PASSKEY", "Passkey authentication failed.", 401);
          let verified;
          try {
            verified = await verifyPasskeyAuthentication({
              credential,
              challenge: boundedString(input.challenge, "Passkey challenge is required.", 512),
              origin: String(challengeRow.origin),
              rpId: String(challengeRow.rp_id),
              stored: storedPasskeyFromRow(passkey),
              requireUserVerification: definition.passkeys.requireUserVerification,
            });
          } catch {
            throw new AuthError("INVALID_PASSKEY", "Passkey authentication failed.", 401);
          }
          const advanced = internal.prepare(`UPDATE clank_auth_passkeys SET counter = ?, last_used_at = ?
            WHERE credential_id = ? AND user_id = ? AND counter = ?`)
            .run(
              verified.counter,
              Date.now(),
              passkey.credential_id,
              passkey.user_id,
              Number(passkey.counter),
            );
          if (Number(advanced.changes) !== 1) {
            throw new AuthError("INVALID_PASSKEY", "Passkey authentication failed.", 401);
          }
          const result = await createSession(String(passkey.user_id) as AuthUserId);
          return sessionResponse(definition, request, result.rawToken, result.auth);
        }
        const auth = await resolve(request);
        if (!auth.user || !auth.session) throw new AuthError("UNAUTHENTICATED", "Authentication is required.", 401);
        await runtime.verifyCsrf(request, auth);
        if (operation === "email/resend") {
          if (auth.user.emailVerified) return authJson({ ok: true, accepted: true });
          await enforceRateLimit(limiter, definition.rateLimit, request, auth.user.email, "verify");
          await deliverVerification(auth.user.id, auth.user.email);
          return authJson({ ok: true, accepted: true }, { status: 202 });
        }
        if (operation === "passkeys/register/start") {
          if (!definition.passkeys.enabled) throw new AuthError("PASSKEYS_DISABLED", "Passkeys are disabled.", 404);
          const user = auth.requireVerified();
          const challenge = await createPasskeyChallenge("registration", request, user.id);
          const existing = internal.prepare("SELECT credential_id FROM clank_auth_passkeys WHERE user_id = ?").all(user.id);
          const displayName = typeof (user.profile as Record<string, unknown>).name === "string"
            ? String((user.profile as Record<string, unknown>).name)
            : user.email;
          const options = passkeyRegistrationOptions({
            challenge: challenge.challenge,
            rpId: challenge.rpId,
            rpName: definition.passkeys.rpName,
            userId: user.id,
            userName: user.email,
            userDisplayName: displayName,
            excludeCredentialIds: existing.map((row) => String(row.credential_id)),
            timeoutMs: definition.passkeys.challengeLifetimeMs,
            requireUserVerification: definition.passkeys.requireUserVerification,
          });
          return authJson({ ok: true, challengeId: challenge.id, expiresAt: challenge.expiresAt, options });
        }
        if (operation === "passkeys/register/finish") {
          if (!definition.passkeys.enabled) throw new AuthError("PASSKEYS_DISABLED", "Passkeys are disabled.", 404);
          const user = auth.requireVerified();
          const input = objectInput(await readJsonRequest(request, 96 * 1024), "Invalid passkey input.");
          const challengeRow = await consumePasskeyChallenge(input.challengeId, input.challenge, "registration");
          if (String(challengeRow.user_id) !== user.id) {
            throw new AuthError("INVALID_PASSKEY", "Passkey registration failed.", 400);
          }
          let stored: StoredPasskey;
          try {
            stored = await verifyPasskeyRegistration({
              credential: input.credential as PasskeyRegistrationCredential,
              challenge: boundedString(input.challenge, "Passkey challenge is required.", 512),
              origin: String(challengeRow.origin),
              rpId: String(challengeRow.rp_id),
              requireUserVerification: definition.passkeys.requireUserVerification,
            });
          } catch {
            throw new AuthError("INVALID_PASSKEY", "Passkey registration failed.", 400);
          }
          const name = typeof input.name === "string" && input.name.trim()
            ? input.name.trim().slice(0, 120)
            : "Passkey";
          const id = await randomToken(18);
          try {
            internal.transaction((changes) => {
              internal.prepare(`INSERT INTO clank_auth_passkeys
                (id, credential_id, user_id, name, public_key, algorithm, counter, transports, created_at, last_used_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
                .run(
                  id,
                  stored.credentialId,
                  user.id,
                  name,
                  JSON.stringify(stored.publicKey),
                  stored.algorithm,
                  stored.counter,
                  JSON.stringify(stored.transports),
                  Date.now(),
                );
              changes.record("__auth", user.id, user.id);
            });
          } catch (error) {
            if (String(error).toLowerCase().includes("unique")) {
              throw new AuthError("PASSKEY_EXISTS", "This passkey is already registered.", 409);
            }
            throw error;
          }
          return authJson({ ok: true, passkey: passkeyRecordFromRow({
            credential_id: stored.credentialId,
            name,
            transports: JSON.stringify(stored.transports),
            created_at: Date.now(),
            last_used_at: null,
          }) }, { status: 201 });
        }
        if (operation === "passkeys/delete") {
          const user = auth.requireVerified();
          const input = objectInput(await readJsonRequest(request, 8 * 1024), "Invalid passkey input.");
          const id = boundedString(input.id, "Passkey ID is required.", 512);
          let deleted = 0;
          internal.transaction((changes) => {
            const result = internal.prepare("DELETE FROM clank_auth_passkeys WHERE credential_id = ? AND user_id = ?")
              .run(id, user.id);
            deleted = Number(result.changes);
            if (deleted) changes.record("__auth", user.id, user.id);
          });
          if (!deleted) throw new AuthError("PASSKEY_NOT_FOUND", "Passkey not found.", 404);
          return authJson({ ok: true, deleted: true });
        }
        if (operation === "logout") {
          internal.transaction((changes) => {
            const result = internal.prepare("DELETE FROM clank_auth_sessions WHERE id = ?").run(auth.session!.id);
            if (Number(result.changes) > 0) changes.record("__auth", auth.user!.id, auth.user!.id);
          });
          notifySession(auth.session.id);
          return clearSessionResponse(definition, request);
        }
        if (operation === "logout-all") {
          revokeSessions(auth.user.id);
          return clearSessionResponse(definition, request);
        }
        if (operation === "change-password") {
          const input = changePasswordInput(await readJsonRequest(request, 16 * 1024), definition);
          const row = internal.prepare("SELECT password_hash FROM clank_auth_users WHERE id = ?").get(auth.user.id);
          const valid = row && await passwordQueue(() => verifyPassword(input.currentPassword, String(row.password_hash), definition.password));
          if (!valid) throw new AuthError("INVALID_CREDENTIALS", "Current password is incorrect.", 401);
          const next = await passwordQueue(() => hashPassword(input.newPassword, definition.password));
          internal.transaction((changes) => {
            internal.prepare("UPDATE clank_auth_users SET password_hash = ?, updated_at = ? WHERE id = ?")
              .run(next, Date.now(), auth.user!.id);
            changes.record("__auth", auth.user!.id, auth.user!.id);
          });
          revokeSessions(auth.user.id);
          const result = await createSession(auth.user.id);
          return sessionResponse(definition, request, result.rawToken, result.auth);
        }
        return authProblem(404, "NOT_FOUND", "Auth endpoint not found.");
      } catch (error) {
        if (error instanceof RequestInputError) return authProblem(error.status, error.code, error.message);
        if (error instanceof AuthError) {
          return authProblem(error.status, error.code, error.message, error.retryAfter);
        }
        reportError(error);
        return authProblem(500, "AUTH_FAILED", "The authentication operation failed.");
      }
    },
    middleware() {
      return async (context, next) => {
        context.state.auth = await resolve(context.request);
        return next();
      };
    },
    setRole(userId, role) {
      ensureOpen();
      const nextRole = validateRole(role);
      let changed = false;
      internal.transaction((changes) => {
        const current = internal.prepare("SELECT role FROM clank_auth_users WHERE id = ?").get(userId);
        if (!current) throw new AuthError("USER_NOT_FOUND", "User not found.", 404);
        if (String(current.role) !== nextRole) {
          internal.prepare("UPDATE clank_auth_users SET role = ?, updated_at = ? WHERE id = ?")
            .run(nextRole, Date.now(), userId);
          changes.record("__auth", userId, userId);
          changed = true;
        }
      });
      if (changed) notifyUserSessions(userId);
    },
    disableUser(userId, disabled = true) {
      ensureOpen();
      const sessions = disabled
        ? internal.prepare("SELECT id FROM clank_auth_sessions WHERE user_id = ?").all(userId)
        : [];
      internal.transaction((changes) => {
        const current = internal.prepare("SELECT disabled FROM clank_auth_users WHERE id = ?").get(userId);
        if (!current) throw new AuthError("USER_NOT_FOUND", "User not found.", 404);
        const next = disabled ? 1 : 0;
        const userChanged = Number(current.disabled) !== next;
        if (userChanged) {
          internal.prepare("UPDATE clank_auth_users SET disabled = ?, updated_at = ? WHERE id = ?")
            .run(next, Date.now(), userId);
        }
        const deleted = disabled
          ? Number(internal.prepare("DELETE FROM clank_auth_sessions WHERE user_id = ?").run(userId).changes)
          : 0;
        if (userChanged || deleted > 0) changes.record("__auth", userId, userId);
      });
      if (disabled) for (const session of sessions) notifySession(String(session.id));
    },
    revokeUserSessions(userId) {
      ensureOpen();
      revokeSessions(userId);
    },
    async verifyCsrf(request, auth) {
      if (!auth.session || !auth.csrfToken) throw new AuthError("UNAUTHENTICATED", "Authentication is required.", 401);
      const supplied = request.headers.get("x-clank-csrf")
        ?? request.headers.get("x-proact-csrf")
        ?? "";
      if (!await timingSafeStringEqual(supplied, auth.csrfToken)) {
        throw new AuthError("INVALID_CSRF", "The request could not be verified.", 403);
      }
    },
    isSessionActive(sessionId) {
      ensureOpen();
      const row = internal.prepare(`SELECT 1 AS active FROM clank_auth_sessions s
        JOIN clank_auth_users u ON u.id = s.user_id
        WHERE s.id = ? AND u.disabled = 0 AND s.expires_at > ? AND s.idle_expires_at > ?`)
        .get(sessionId, Date.now(), Date.now());
      return Boolean(row);
    },
    refreshSession(sessionId) {
      ensureOpen();
      const row = sessionRowById(internal, sessionId);
      if (!row) return null;
      const now = Date.now();
      if (Number(row.disabled) !== 0 || Number(row.expires_at) <= now || Number(row.idle_expires_at) <= now) {
        return null;
      }
      return authFromRow(definition, row);
    },
    subscribeSession(sessionId, listener) {
      ensureOpen();
      let listeners = sessionListeners.get(sessionId);
      if (!listeners) sessionListeners.set(sessionId, listeners = new Set());
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) sessionListeners.delete(sessionId);
      };
    },
    subscribeUser(userId, listener) {
      ensureOpen();
      let listeners = userListeners.get(userId);
      if (!listeners) userListeners.set(userId, listeners = new Set());
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) userListeners.delete(userId);
      };
    },
    notifyUserChange(userId) {
      ensureOpen();
      notifyUser(userId);
    },
    notifyAllUserChanges() {
      ensureOpen();
      for (const userId of [...userListeners.keys()]) notifyUser(userId);
    },
    close() {
      closed = true;
      sessionListeners.clear();
      userListeners.clear();
      void limiter.close().catch(reportError);
    },
  };
  return runtime;
}

export interface AuthClient<Profile extends object = DefaultAuthProfile> {
  readonly user: ReactiveSignal<AuthUser<Profile> | null>;
  readonly session: ReactiveSignal<AuthSession | null>;
  readonly mfa: ReactiveSignal<AuthMfaChallenge | null>;
  readonly loading: ReactiveSignal<boolean>;
  readonly error: ReactiveSignal<unknown>;
  readonly authenticated: Computed<boolean>;
  reload(): Promise<AuthState<Profile>>;
  register(input: AuthRegisterInput<Profile>): Promise<AuthUser<Profile> | null>;
  login(input: AuthLoginInput): Promise<AuthUser<Profile> | null>;
  verifyMfa(code: string, challengeId?: string): Promise<AuthUser<Profile> | null>;
  requestEmailVerification(): Promise<void>;
  verifyEmail(token: string): Promise<void>;
  requestPasswordReset(email: string, botToken?: string): Promise<void>;
  resetPassword(token: string, password: string): Promise<AuthUser<Profile> | null>;
  listPasskeys(): Promise<readonly AuthPasskeyRecord[]>;
  registerPasskey(name?: string): Promise<AuthPasskeyRecord>;
  loginWithPasskey(email: string): Promise<AuthUser<Profile> | null>;
  deletePasskey(id: string): Promise<void>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<void>;
  csrfHeader(): Record<string, string>;
}

export interface AuthClientOptions<Profile extends object> {
  url?: string;
  prefix?: string;
  fetch?: typeof fetch;
  initial?: AuthState<Profile>;
  immediate?: boolean;
}

export function createAuthClient<Profile extends object = DefaultAuthProfile>(
  options: AuthClientOptions<Profile> = {},
): AuthClient<Profile> {
  const user = signal<AuthUser<Profile> | null>(options.initial?.user ?? null);
  const session = signal<AuthSession | null>(options.initial?.session ?? null);
  const mfa = signal<AuthMfaChallenge | null>(null);
  const loading = signal(options.initial === undefined);
  const error = signal<unknown>(undefined);
  const authenticated = computed(() => user.value !== null);
  const fetcher = options.fetch ?? globalThis.fetch;
  const prefix = `/${(options.prefix ?? "__clank/auth").replace(/^\/+|\/+$/g, "")}`;
  const base = (options.url ?? "").replace(/\/$/, "");
  let csrfToken = options.initial?.csrfToken;

  const apply = (state: AuthState<Profile>) => {
    batch(() => {
      user.value = state.user;
      session.value = state.session;
      csrfToken = state.csrfToken;
      error.value = undefined;
      loading.value = false;
    });
    return state;
  };

  type Payload = Partial<AuthState<Profile>> & {
    ok?: boolean;
    error?: { message?: string; code?: string };
    mfa?: AuthMfaChallenge;
    [key: string]: unknown;
  };

  const requestPayload = async (operation: string, input?: unknown, csrf = false): Promise<Payload> => {
    if (!fetcher) throw new Error("fetch is not available in this runtime.");
    loading.value = true;
    try {
      const response = await fetcher(`${base}${prefix}/${operation}`, {
        method: input === undefined ? "GET" : "POST",
        credentials: "same-origin",
        headers: input === undefined ? undefined : {
          "content-type": "application/json",
          ...(csrf && csrfToken ? { "x-clank-csrf": csrfToken } : {}),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      const payload = await response.json() as Payload;
      if (!response.ok || payload.ok === false) throw new AuthError(payload.error?.code ?? "AUTH_FAILED", payload.error?.message ?? "Authentication failed.", response.status);
      if ("user" in payload && "session" in payload) apply(payload as AuthState<Profile>);
      else loading.value = false;
      return payload;
    } catch (reason) {
      batch(() => {
        error.value = reason;
        loading.value = false;
      });
      throw reason;
    }
  };

  const request = async (operation: string, input?: unknown, csrf = false): Promise<AuthState<Profile>> => {
    const payload = await requestPayload(operation, input, csrf);
    return payload as AuthState<Profile>;
  };

  const browserCredentials = (): CredentialsContainer => {
    if (typeof navigator === "undefined" || !navigator.credentials) {
      throw new AuthError("PASSKEY_UNAVAILABLE", "Passkeys are not available in this browser.", 400);
    }
    return navigator.credentials;
  };

  const client: AuthClient<Profile> = {
    user,
    session,
    mfa,
    loading,
    error,
    authenticated,
    reload: () => request("session"),
    async register(input) { return (await request("register", input)).user; },
    async login(input) {
      const payload = await requestPayload("login", input);
      if (payload.mfa) {
        mfa.value = payload.mfa;
        return null;
      }
      mfa.value = null;
      return payload.user ?? null;
    },
    async verifyMfa(code, challengeId) {
      const id = challengeId ?? mfa.value?.challengeId;
      if (!id) throw new AuthError("MFA_REQUIRED", "Start a password sign-in before verifying MFA.", 400);
      const payload = await request("mfa/verify", { challengeId: id, code });
      mfa.value = null;
      return payload.user;
    },
    async requestEmailVerification() {
      await requestPayload("email/resend", {}, true);
    },
    async verifyEmail(token) {
      await requestPayload("email/verify", { token });
      await client.reload();
    },
    async requestPasswordReset(email, botToken) {
      await requestPayload("password/recover", { email, ...(botToken ? { botToken } : {}) });
    },
    async resetPassword(token, password) {
      return (await request("password/reset", { token, password })).user;
    },
    async listPasskeys() {
      const payload = await requestPayload("passkeys");
      return (payload.passkeys ?? []) as readonly AuthPasskeyRecord[];
    },
    async registerPasskey(name) {
      const start = await requestPayload("passkeys/register/start", {}, true);
      const options = start.options as PublicKeyCredentialCreationOptionsJSON;
      const credential = await browserCredentials().create({
        publicKey: registrationOptionsForBrowser(options),
      }) as PublicKeyCredential | null;
      if (!credential) throw new AuthError("PASSKEY_CANCELLED", "Passkey registration was cancelled.", 400);
      const finish = await requestPayload("passkeys/register/finish", {
        challengeId: start.challengeId,
        challenge: options.challenge,
        credential: serializeRegistrationCredential(credential),
        ...(name ? { name } : {}),
      }, true);
      return finish.passkey as AuthPasskeyRecord;
    },
    async loginWithPasskey(email) {
      const start = await requestPayload("passkeys/authenticate/start", { email });
      const options = start.options as PublicKeyCredentialRequestOptionsJSON;
      const credential = await browserCredentials().get({
        publicKey: authenticationOptionsForBrowser(options),
      }) as PublicKeyCredential | null;
      if (!credential) throw new AuthError("PASSKEY_CANCELLED", "Passkey sign-in was cancelled.", 400);
      const finish = await request("passkeys/authenticate/finish", {
        challengeId: start.challengeId,
        challenge: options.challenge,
        credential: serializeAuthenticationCredential(credential),
      });
      return finish.user;
    },
    async deletePasskey(id) {
      await requestPayload("passkeys/delete", { id }, true);
    },
    async logout() {
      await request("logout", {}, true);
      apply({ user: null, session: null });
      mfa.value = null;
    },
    async logoutAll() {
      await request("logout-all", {}, true);
      apply({ user: null, session: null });
      mfa.value = null;
    },
    async changePassword(input) { await request("change-password", input, true); },
    csrfHeader(): Record<string, string> {
      return csrfToken ? { "x-clank-csrf": csrfToken } : {};
    },
  };
  if (options.initial === undefined && options.immediate !== false) {
    void client.reload().catch(() => batch(() => {
      user.value = null;
      session.value = null;
      csrfToken = undefined;
      loading.value = false;
    }));
  }
  return client;
}

export interface AuthGateProps<Profile extends object> {
  auth: AuthClient<Profile>;
  children: Renderable | Renderable[];
  loading?: Renderable;
  signedOut?: Renderable;
}

export function AuthGate<Profile extends object>(props: AuthGateProps<Profile>): Renderable {
  return () => {
    if (props.auth.loading.value) return props.loading ?? null;
    if (!props.auth.user.value) return props.signedOut ?? h(AuthForm as Component<any>, { auth: props.auth });
    return props.children;
  };
}

/** A secure, accessible default email/password screen for generated applications. */
export function AuthForm(props: { auth: AuthClient<DefaultAuthProfile> }): Renderable {
  const mode = signal<"login" | "register">("login");
  const email = signal("");
  const password = signal("");
  const name = signal("");
  const mfaCode = signal("");
  const submit = async (event: Event) => {
    event.preventDefault();
    try {
      if (props.auth.mfa.value) await props.auth.verifyMfa(mfaCode.value);
      else if (mode.value === "login") await props.auth.login({ email: email.value, password: password.value });
      else await props.auth.register({ email: email.value, password: password.value, profile: { name: name.value || undefined } });
      password.value = "";
    } catch { /* AuthClient exposes the safe error through its signal. */ }
  };
  const field = "w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-950 shadow-sm focus:border-slate-950";
  return h("main", { class: "mx-auto flex min-h-screen max-w-md items-center px-6 py-12" },
    h("section", { class: "w-full rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-200/60" },
      h("p", { class: "text-xs font-semibold uppercase tracking-[0.2em] text-slate-500" }, "Secure account"),
      h("h1", { class: "mt-2 text-3xl font-semibold tracking-tight text-slate-950" }, () =>
        props.auth.mfa.value ? "Verify it’s you" : mode.value === "login" ? "Welcome back" : "Create your account"),
      h("form", { class: "mt-7 space-y-4", onSubmit: submit },
        () => !props.auth.mfa.value && mode.value === "register"
          ? h("label", { class: "block text-sm font-medium text-slate-700" }, "Name",
              h("input", { class: `${field} mt-1`, autocomplete: "name", "bind:value": name, agentId: "auth-name", agentLabel: "Name" }))
          : null,
        () => props.auth.mfa.value
          ? h("label", { class: "block text-sm font-medium text-slate-700" }, "Verification code",
              h("input", {
                class: `${field} mt-1`,
                inputmode: "numeric",
                autocomplete: "one-time-code",
                maxlength: 6,
                required: true,
                "bind:value": mfaCode,
                agentId: "auth-mfa-code",
                agentLabel: "Verification code",
              }))
          : [
              h("label", { class: "block text-sm font-medium text-slate-700" }, "Email",
                h("input", { class: `${field} mt-1`, type: "email", autocomplete: "email", required: true, "bind:value": email, agentId: "auth-email", agentLabel: "Email" })),
              h("label", { class: "block text-sm font-medium text-slate-700" }, "Password",
                h("input", { class: `${field} mt-1`, type: "password", autocomplete: () => mode.value === "login" ? "current-password" : "new-password", minlength: 12, required: true, "bind:value": password, agentId: "auth-password", agentLabel: "Password" })),
            ],
        h("p", { class: "min-h-5 text-sm text-rose-600", role: "alert" }, () => props.auth.error.value instanceof Error ? props.auth.error.value.message : ""),
        h("button", {
          class: "w-full rounded-xl bg-slate-950 px-4 py-3 font-semibold text-white disabled:opacity-50",
          type: "submit",
          disabled: () => props.auth.loading.value,
          agentId: "auth-submit",
          agentLabel: () => props.auth.mfa.value ? "Verify code" : mode.value === "login" ? "Sign in" : "Create account",
        }, () => props.auth.loading.value ? "Working…" : props.auth.mfa.value ? "Verify" : mode.value === "login" ? "Sign in" : "Create account"),
      ),
      () => props.auth.mfa.value ? null : h("button", {
        class: "mt-5 w-full text-sm font-medium text-slate-600",
        type: "button",
        onClick: () => {
          mode.value = mode.value === "login" ? "register" : "login";
          props.auth.error.value = undefined;
        },
        agentId: "auth-switch",
        agentLabel: () => mode.value === "login" ? "Create an account" : "Use an existing account",
      }, () => mode.value === "login" ? "Need an account? Create one" : "Already have an account? Sign in"),
    ),
  );
}

function createAuthTables(internal: SQLiteInternal): void {
  migrateLegacyTable(internal, "proact_auth_users", "clank_auth_users");
  migrateLegacyTable(internal, "proact_auth_sessions", "clank_auth_sessions");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_auth_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    email_verified_at INTEGER,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    profile TEXT NOT NULL CHECK (json_valid(profile)),
    disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const userColumns = internal.prepare("PRAGMA table_info(clank_auth_users)").all();
  if (!userColumns.some((column) => column.name === "email_verified_at")) {
    internal.exec("ALTER TABLE clank_auth_users ADD COLUMN email_verified_at INTEGER");
    internal.prepare("UPDATE clank_auth_users SET email_verified_at = created_at").run();
  }
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_auth_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    idle_expires_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('email_verification', 'password_recovery')),
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL
  ) WITHOUT ROWID`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_auth_mfa_challenges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_auth_passkeys (
    id TEXT PRIMARY KEY,
    credential_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    public_key TEXT NOT NULL CHECK (json_valid(public_key)),
    algorithm INTEGER NOT NULL CHECK (algorithm IN (-7, -257)),
    counter INTEGER NOT NULL CHECK (counter >= 0),
    transports TEXT NOT NULL CHECK (json_valid(transports)),
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_auth_passkey_challenges (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('registration', 'authentication')),
    challenge_hash TEXT NOT NULL,
    user_id TEXT REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    origin TEXT NOT NULL,
    rp_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  internal.exec("DROP INDEX IF EXISTS proact_auth_sessions_user");
  internal.exec("DROP INDEX IF EXISTS proact_auth_sessions_expiry");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_auth_sessions_user ON clank_auth_sessions (user_id)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_auth_sessions_expiry ON clank_auth_sessions (expires_at)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_auth_tokens_user_type ON clank_auth_tokens (user_id, type)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_auth_tokens_expiry ON clank_auth_tokens (expires_at)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_auth_mfa_expiry ON clank_auth_mfa_challenges (expires_at)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_auth_passkeys_user ON clank_auth_passkeys (user_id)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_auth_passkey_challenges_expiry ON clank_auth_passkey_challenges (expires_at)");
  internal.prepare("DELETE FROM clank_auth_sessions WHERE expires_at <= ? OR idle_expires_at <= ?").run(Date.now(), Date.now());
  internal.prepare("DELETE FROM clank_auth_tokens WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(Date.now());
  internal.prepare("DELETE FROM clank_auth_mfa_challenges WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(Date.now());
  internal.prepare("DELETE FROM clank_auth_passkey_challenges WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(Date.now());
}

function sessionRow(internal: SQLiteInternal, tokenHash: string): Record<string, unknown> | undefined {
  return internal.prepare(`SELECT
      s.id AS session_id, s.token_hash, s.csrf_token, s.created_at AS session_created_at,
      s.last_seen_at, s.idle_expires_at, s.expires_at,
      u.id AS user_id, u.email, u.email_verified_at, u.role, u.profile, u.disabled,
      u.created_at AS user_created_at, u.updated_at
    FROM clank_auth_sessions s
    JOIN clank_auth_users u ON u.id = s.user_id
    WHERE s.token_hash = ?`)
    .get(tokenHash);
}

function sessionRowById(internal: SQLiteInternal, sessionId: string): Record<string, unknown> | undefined {
  return internal.prepare(`SELECT
      s.id AS session_id, s.token_hash, s.csrf_token, s.created_at AS session_created_at,
      s.last_seen_at, s.idle_expires_at, s.expires_at,
      u.id AS user_id, u.email, u.email_verified_at, u.role, u.profile, u.disabled,
      u.created_at AS user_created_at, u.updated_at
    FROM clank_auth_sessions s
    JOIN clank_auth_users u ON u.id = s.user_id
    WHERE s.id = ?`)
    .get(sessionId);
}

function authFromRow<Profile extends object>(
  definition: AuthDefinition<Profile>,
  row: Record<string, unknown>,
): StoredSession<Profile> {
  const user: AuthUser<Profile> = {
    id: String(row.user_id) as AuthUserId,
    email: String(row.email),
    emailVerified: row.email_verified_at !== null && row.email_verified_at !== undefined,
    role: String(row.role),
    profile: definition.profile.parse(JSON.parse(String(row.profile))),
    createdAt: Number(row.user_created_at),
    updatedAt: Number(row.updated_at),
  };
  const session: AuthSession = {
    id: String(row.session_id),
    createdAt: Number(row.session_created_at),
    lastSeenAt: Number(row.last_seen_at),
    expiresAt: Number(row.expires_at),
  };
  return {
    user,
    session,
    csrfToken: String(row.csrf_token),
    requireUser: () => user,
    requireVerified() {
      if (!user.emailVerified) throw new AuthError("EMAIL_UNVERIFIED", "Verify your email address to continue.", 403);
      return user;
    },
    requireRole(...roles) {
      if (definition.emailVerification.required && !user.emailVerified) {
        throw new AuthError("EMAIL_UNVERIFIED", "Verify your email address to continue.", 403);
      }
      if (!roles.includes(user.role)) throw new AuthError("FORBIDDEN", "This account does not have the required role.", 403);
      return user;
    },
  };
}

function anonymousAuth<Profile extends object>(): AuthRequest<Profile> {
  return {
    user: null,
    session: null,
    requireUser() { throw new AuthError("UNAUTHENTICATED", "Authentication is required.", 401); },
    requireVerified() { throw new AuthError("UNAUTHENTICATED", "Authentication is required.", 401); },
    requireRole() { throw new AuthError("UNAUTHENTICATED", "Authentication is required.", 401); },
  };
}

function objectInput(raw: unknown, message: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AuthError("INVALID_INPUT", message, 422);
  }
  return raw as Record<string, unknown>;
}

function boundedString(input: unknown, message: string, maxLength: number): string {
  if (typeof input !== "string" || input.length === 0 || input.length > maxLength) {
    throw new AuthError("INVALID_INPUT", message, 422);
  }
  return input;
}

function parseStringArray(input: unknown): string[] {
  try {
    const value = JSON.parse(String(input));
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function storedPasskeyFromRow(row: Record<string, unknown>): StoredPasskey {
  let publicKey: JsonWebKey;
  try {
    const parsed = JSON.parse(String(row.public_key));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    publicKey = parsed as JsonWebKey;
  } catch {
    throw new AuthError("INVALID_PASSKEY", "Stored passkey data is invalid.", 500);
  }
  return {
    credentialId: String(row.credential_id),
    publicKey,
    algorithm: Number(row.algorithm),
    counter: Number(row.counter),
    transports: parseStringArray(row.transports),
  };
}

function passkeyRecordFromRow(row: Record<string, unknown>): AuthPasskeyRecord {
  const lastUsedAt = row.last_used_at === null || row.last_used_at === undefined
    ? undefined
    : Number(row.last_used_at);
  return {
    id: String(row.credential_id),
    name: String(row.name),
    transports: parseStringArray(row.transports),
    createdAt: Number(row.created_at),
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
  };
}

function credentialInput<Profile extends object>(
  raw: unknown,
  definition: AuthDefinition<Profile>,
  includeProfile: boolean,
): { email: string; password: string; profile: Profile } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AuthError("INVALID_INPUT", "Invalid authentication input.", 422);
  const source = raw as Record<string, unknown>;
  const email = normalizeEmail(source.email);
  const password = validatePassword(source.password, definition.password);
  let profile = {} as Profile;
  if (includeProfile) {
    try {
      profile = definition.profile.parse(source.profile ?? {});
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new AuthError("INVALID_INPUT", "The account profile is invalid.", 422);
      }
      throw error;
    }
  }
  return { email, password, profile };
}

function changePasswordInput(raw: unknown, definition: AuthDefinition<any>): { currentPassword: string; newPassword: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AuthError("INVALID_INPUT", "Invalid password input.", 422);
  const source = raw as Record<string, unknown>;
  if (typeof source.currentPassword !== "string") throw new AuthError("INVALID_INPUT", "Current password is required.", 422);
  return {
    currentPassword: source.currentPassword,
    newPassword: validatePassword(source.newPassword, definition.password),
  };
}

function normalizeEmail(input: unknown): string {
  if (typeof input !== "string") throw new AuthError("INVALID_INPUT", "A valid email address is required.", 422);
  const value = input.trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    throw new AuthError("INVALID_INPUT", "A valid email address is required.", 422);
  }
  return value;
}

function validatePassword(input: unknown, options: AuthDefinition["password"]): string {
  if (typeof input !== "string") throw new AuthError("INVALID_INPUT", "A password is required.", 422);
  if ([...input].length < options.minLength) {
    throw new AuthError("WEAK_PASSWORD", `Password must contain at least ${options.minLength} characters.`, 422);
  }
  if (new TextEncoder().encode(input).byteLength > options.maxBytes) {
    throw new AuthError("PASSWORD_TOO_LONG", `Password must not exceed ${options.maxBytes} UTF-8 bytes.`, 422);
  }
  return input;
}

function validatePasswordOptions(options: AuthDefinition["password"]): void {
  if (!Number.isSafeInteger(options.minLength) || options.minLength < 8) throw new TypeError("password.minLength must be at least 8.");
  positiveInteger(options.maxBytes, "password.maxBytes");
  if (!Number.isSafeInteger(options.cost) || options.cost < 2 || (options.cost & (options.cost - 1)) !== 0) {
    throw new TypeError("password.cost must be a power of two.");
  }
  positiveInteger(options.blockSize, "password.blockSize");
  positiveInteger(options.parallelization, "password.parallelization");
  positiveInteger(options.maxMemory, "password.maxMemory");
  positiveInteger(options.concurrency, "password.concurrency");
  positiveInteger(options.maxQueue, "password.maxQueue");
  if (128 * options.cost * options.blockSize > options.maxMemory) {
    throw new TypeError("password.maxMemory is too small for the configured scrypt cost.");
  }
}

async function hashPassword(password: string, options: AuthDefinition["password"]): Promise<string> {
  const salt = await randomBytes(16);
  const derived = await scryptPassword(password, salt, options);
  return [
    "scrypt",
    options.cost,
    options.blockSize,
    options.parallelization,
    base64Url(salt),
    base64Url(derived),
  ].join("$");
}

async function verifyPassword(password: string, stored: string, options: AuthDefinition["password"]): Promise<boolean> {
  const [algorithm, costText, blockText, parallelText, saltText, hashText] = stored.split("$");
  if (algorithm !== "scrypt") return false;
  const cost = Number(costText);
  const blockSize = Number(blockText);
  const parallelization = Number(parallelText);
  if (!Number.isSafeInteger(cost) || cost < 2 || cost > 2 ** 20 || (cost & (cost - 1)) !== 0) return false;
  if (!Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 32) return false;
  if (!Number.isSafeInteger(parallelization) || parallelization < 1 || parallelization > 16) return false;
  try {
    if (saltText.length > 128 || hashText.length > 256) return false;
    const salt = fromBase64Url(saltText);
    const expected = fromBase64Url(hashText);
    if (salt.byteLength < 16 || salt.byteLength > 64 || expected.byteLength !== 64) return false;
    const derived = await scryptPassword(password, salt, {
      ...options,
      cost,
      blockSize,
      parallelization,
      maxMemory: Math.max(options.maxMemory, 128 * cost * blockSize + 1024 * 1024),
    });
    return expected.byteLength === derived.byteLength && await timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

async function scryptPassword(
  password: string,
  salt: Uint8Array,
  options: AuthDefinition["password"],
): Promise<Uint8Array> {
  const cryptoName = "node:crypto";
  const crypto = await import(cryptoName) as unknown as {
    createHmac(name: string, key: string): { update(value: Uint8Array): { digest(): Uint8Array } };
    scrypt(
      password: Uint8Array,
      salt: Uint8Array,
      length: number,
      options: { N: number; r: number; p: number; maxmem: number },
      callback: (error: Error | null, value: Uint8Array) => void,
    ): void;
  };
  let input: Uint8Array = new TextEncoder().encode(password);
  if (options.pepper) input = crypto.createHmac("sha256", options.pepper).update(input).digest();
  return new Promise<Uint8Array>((resolve, reject) => {
    crypto.scrypt(input, salt, 64, {
      N: options.cost,
      r: options.blockSize,
      p: options.parallelization,
      maxmem: options.maxMemory,
    }, (error, value) => error ? reject(error) : resolve(value));
  });
}

async function digest(value: string): Promise<string> {
  const cryptoName = "node:crypto";
  const crypto = await import(cryptoName) as unknown as {
    createHash(name: string): { update(value: string, encoding: string): { digest(encoding: string): string } };
  };
  return crypto.createHash("sha256").update(value, "utf8").digest("base64url");
}

async function randomToken(bytes: number): Promise<string> {
  return base64Url(await randomBytes(bytes));
}

async function randomInteger(min: number, max: number): Promise<number> {
  const cryptoName = "node:crypto";
  const crypto = await import(cryptoName) as unknown as { randomInt(minimum: number, maximum: number): number };
  return crypto.randomInt(min, max);
}

async function randomBytes(bytes: number): Promise<Uint8Array> {
  const cryptoName = "node:crypto";
  const crypto = await import(cryptoName) as unknown as { randomBytes(size: number): Uint8Array };
  return crypto.randomBytes(bytes);
}

async function timingSafeStringEqual(left: string, right: string): Promise<boolean> {
  return timingSafeEqual(new TextEncoder().encode(left), new TextEncoder().encode(right));
}

async function timingSafeEqual(left: Uint8Array, right: Uint8Array): Promise<boolean> {
  if (left.byteLength !== right.byteLength) return false;
  const cryptoName = "node:crypto";
  const crypto = await import(cryptoName) as unknown as { timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean };
  return crypto.timingSafeEqual(left, right);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url.");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function createWorkQueue(concurrency: number, maxQueue: number) {
  let active = 0;
  const queued: Array<() => void> = [];
  const acquire = () => new Promise<void>((resolve, reject) => {
    if (active < concurrency) {
      active++;
      resolve();
      return;
    }
    if (queued.length >= maxQueue) {
      reject(new AuthError("AUTH_BUSY", "Authentication is temporarily busy. Try again shortly.", 503));
      return;
    }
    queued.push(() => {
      active++;
      resolve();
    });
  });
  const release = () => {
    active--;
    queued.shift()?.();
  };
  return async <Value>(task: () => Promise<Value>): Promise<Value> => {
    await acquire();
    try { return await task(); }
    finally { release(); }
  };
}

function createRateLimiter(store?: AuthRateLimitStore) {
  if (store) {
    return {
      consume: async (key: string, limit: number, windowMs: number) =>
        await store.consume(key, limit, windowMs),
      clear: async (key: string) => { await store.clear?.(key); },
      close: async () => { await store.close?.(); },
    };
  }
  const entries = new Map<string, number[]>();
  const consume = (key: string, attempts: number, windowMs: number): number | undefined => {
    const now = Date.now();
    const recent = (entries.get(key) ?? []).filter((time) => now - time < windowMs);
    if (recent.length >= attempts) return Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1_000));
    recent.push(now);
    entries.set(key, recent);
    if (entries.size > 10_000) {
      for (const [entry, times] of entries) {
        if (times.every((time) => now - time >= windowMs)) entries.delete(entry);
        if (entries.size <= 8_000) break;
      }
    }
    return undefined;
  };
  return {
    consume: async (key: string, attempts: number, windowMs: number) => consume(key, attempts, windowMs),
    clear: async (key: string) => { entries.delete(key); },
    close: async () => { entries.clear(); },
  };
}

async function enforceRateLimit(
  limiter: ReturnType<typeof createRateLimiter>,
  options: AuthDefinition["rateLimit"],
  request: Request,
  email: string,
  action: string,
): Promise<void> {
  const key = rateLimitKey(request, email, action);
  const retry = await limiter.consume(key, options.attempts, options.windowMs);
  if (retry !== undefined) throw new AuthError("RATE_LIMITED", "Too many authentication attempts. Try again later.", 429, retry);
}

function rateLimitKey(request: Request, email: string, action: string): string {
  const ip = request.headers.get("x-clank-client-ip")
    ?? request.headers.get("x-proact-client-ip")
    ?? "unknown";
  return `${action}\n${ip}\n${email}`;
}

function sessionResponse<Profile extends object>(
  definition: AuthDefinition<Profile>,
  request: Request,
  rawToken: string,
  auth: StoredSession<Profile>,
  status = 200,
): Response {
  const headers = authHeaders();
  headers.append("set-cookie", serializeSessionCookie(definition, request, rawToken, auth.session!.expiresAt));
  return Response.json({
    ok: true,
    user: auth.user,
    session: auth.session,
    csrfToken: auth.csrfToken,
  }, { status, headers });
}

function clearSessionResponse(definition: AuthDefinition<any>, request: Request): Response {
  const headers = authHeaders();
  headers.append("set-cookie", serializeSessionCookie(definition, request, "", 0));
  if (!definition.cookie.name) {
    headers.append("set-cookie", serializeNamedSessionCookie(
      definition,
      request,
      legacyCookieName(definition, request),
      "",
      0,
    ));
  }
  return Response.json({ ok: true, user: null, session: null }, { headers });
}

function authJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = authHeaders(init.headers);
  return Response.json(value, { ...init, headers });
}

function authProblem(
  status: number,
  code: string,
  message: string,
  retryAfter?: number,
  extraHeaders?: HeadersInit,
): Response {
  const headers = authHeaders(extraHeaders);
  if (retryAfter !== undefined) headers.set("retry-after", String(retryAfter));
  return Response.json({ ok: false, error: { code, message } }, { status, headers });
}

function authHeaders(input?: HeadersInit): Headers {
  const headers = new Headers(input);
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return headers;
}

function serializeSessionCookie(
  definition: AuthDefinition<any>,
  request: Request,
  value: string,
  expiresAt: number,
): string {
  return serializeNamedSessionCookie(definition, request, cookieName(definition, request), value, expiresAt);
}

function serializeNamedSessionCookie(
  definition: AuthDefinition<any>,
  request: Request,
  name: string,
  value: string,
  expiresAt: number,
): string {
  const secure = secureCookie(definition, request);
  const maxAge = value ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1_000)) : 0;
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${definition.cookie.sameSite}`,
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function cookieName(definition: AuthDefinition<any>, request: Request): string {
  if (definition.cookie.name) return definition.cookie.name;
  return secureCookie(definition, request) ? "__Host-clank-id" : "clank-id";
}

function legacyCookieName(definition: AuthDefinition<any>, request: Request): string {
  return secureCookie(definition, request) ? "__Host-proact-id" : "proact-id";
}

function secureCookie(definition: AuthDefinition<any>, request: Request): boolean {
  return definition.cookie.secure === "auto"
    ? new URL(request.url).protocol === "https:"
    : definition.cookie.secure;
}

function cookieValue(header: string | null, name: string): string | undefined {
  if (!header || header.length > 16 * 1024) return undefined;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    if (entry.slice(0, separator).trim() === name) return entry.slice(separator + 1).trim();
  }
  return undefined;
}

function migrateLegacyTable(internal: SQLiteInternal, legacy: string, current: string): void {
  const exists = (name: string) => Boolean(internal.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
  if (!exists(legacy)) return;
  if (exists(current)) {
    throw new Error(`Cannot migrate legacy auth table ${legacy}: ${current} already exists.`);
  }
  internal.exec(`ALTER TABLE "${legacy}" RENAME TO "${current}"`);
}

function validateRole(role: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(role)) throw new TypeError(`Invalid auth role: ${role}`);
  return role;
}

function validateCookieName(name: string): string {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new TypeError("Invalid auth cookie name.");
  return name;
}

function validateOrigin(input: string): string {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new TypeError(`Invalid passkey origin: ${input}`); }
  if (
    url.origin !== input
    || url.username
    || url.password
    || (url.protocol !== "https:"
      && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
  ) throw new TypeError(`Invalid passkey origin: ${input}`);
  return url.origin;
}

function validateRpId(input: string): string {
  const value = input.trim().toLowerCase();
  if (
    value.length === 0
    || value.length > 253
    || value.includes("/")
    || value.includes(":")
    || value.startsWith(".")
    || value.endsWith(".")
  ) throw new TypeError(`Invalid passkey RP ID: ${input}`);
  let url: URL;
  try { url = new URL(`https://${value}`); }
  catch { throw new TypeError(`Invalid passkey RP ID: ${input}`); }
  if (url.hostname !== value) throw new TypeError(`Invalid passkey RP ID: ${input}`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function positiveDuration(value: number, name: string): number {
  return positiveInteger(value, name);
}
