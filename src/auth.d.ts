import { type Computed, type ReactiveSignal } from "./core.js";
import { type Renderable } from "./dom.js";
import { type InferSchemaShape, type Schema, type SchemaShape } from "./ai.js";
import type { DatabaseSchema, SQLiteDatabase } from "./backend.js";
import type { Middleware } from "./server.js";
declare const AUTH_USER_ID: unique symbol;
export type AuthUserId = string & {
    readonly [AUTH_USER_ID]: true;
};
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
    send?: (delivery: AuthDelivery & {
        code: string;
    }) => void | Promise<void>;
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
    readonly cookie: Required<Omit<AuthCookieOptions, "name">> & {
        name?: string;
    };
    readonly password: Required<Omit<PasswordOptions, "pepper">> & {
        pepper?: string;
    };
    readonly rateLimit: Required<Omit<AuthRateLimitOptions, "store">> & {
        store?: AuthRateLimitStore;
    };
    readonly emailVerification: Required<Omit<AuthEmailVerificationOptions, "send">> & {
        send?: AuthEmailVerificationOptions["send"];
    };
    readonly passwordRecovery: Required<Omit<AuthPasswordRecoveryOptions, "send">> & {
        send?: AuthPasswordRecoveryOptions["send"];
    };
    readonly mfa: Required<Omit<AuthMfaOptions, "send">> & {
        send?: AuthMfaOptions["send"];
    };
    readonly passkeys: Required<Omit<AuthPasskeyOptions, "rpId" | "allowedOrigins">> & {
        rpId?: string;
        allowedOrigins: readonly string[];
    };
    readonly botProtection?: AuthBotProtectionOptions;
}
export declare function defineAuth(): AuthDefinition<DefaultAuthProfile>;
export declare function defineAuth<const ProfileShape extends SchemaShape>(options: AuthDefinitionOptions<ProfileShape>): AuthDefinition<InferSchemaShape<ProfileShape>>;
type RegisterProfile<Profile extends object> = {} extends Profile ? {
    profile?: Profile;
} : {
    profile: Profile;
};
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
export declare class AuthError extends Error {
    readonly code: string;
    readonly status: number;
    readonly retryAfter?: number | undefined;
    readonly name = "AuthError";
    constructor(code: string, message: string, status?: number, retryAfter?: number | undefined);
}
/** Returns the serializable subset intended for SSR boot state. */
export declare function authState<Profile extends object>(auth: AuthRequest<Profile>): AuthState<Profile>;
export interface AuthRuntime<Profile extends object = DefaultAuthProfile> {
    readonly definition: AuthDefinition<Profile>;
    resolve(request: Request): Promise<AuthRequest<Profile>>;
    handle(request: Request, prefix?: string): Promise<Response>;
    middleware<State extends Record<string, unknown> & {
        auth?: AuthRequest<Profile>;
    }>(): Middleware<State>;
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
export declare function openAuth<Profile extends object, DB extends DatabaseSchema<any>>(definition: AuthDefinition<Profile>, database: SQLiteDatabase<DB>, options?: OpenAuthOptions): Promise<AuthRuntime<Profile>>;
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
    changePassword(input: {
        currentPassword: string;
        newPassword: string;
    }): Promise<void>;
    csrfHeader(): Record<string, string>;
}
export interface AuthClientOptions<Profile extends object> {
    url?: string;
    prefix?: string;
    fetch?: typeof fetch;
    initial?: AuthState<Profile>;
    immediate?: boolean;
}
export declare function createAuthClient<Profile extends object = DefaultAuthProfile>(options?: AuthClientOptions<Profile>): AuthClient<Profile>;
export interface AuthGateProps<Profile extends object> {
    auth: AuthClient<Profile>;
    children: Renderable | Renderable[];
    loading?: Renderable;
    signedOut?: Renderable;
}
export declare function AuthGate<Profile extends object>(props: AuthGateProps<Profile>): Renderable;
/** A secure, accessible default email/password screen for generated applications. */
export declare function AuthForm(props: {
    auth: AuthClient<DefaultAuthProfile>;
}): Renderable;
export {};
