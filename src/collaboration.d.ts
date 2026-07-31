import type { ReactiveSignal } from "./core.js";
import type { AuthRequest, AuthRuntime, AuthUser } from "./auth.js";
export type CollaborationValue = null | boolean | number | string | readonly CollaborationValue[] | {
    readonly [key: string]: CollaborationValue;
};
export interface CollaborationPrincipal {
    readonly id: string;
    readonly name: string;
}
export interface CollaborationParticipant {
    readonly id: string;
    readonly name: string;
    readonly data: Readonly<Record<string, CollaborationValue>>;
    readonly connectedAt: string;
    readonly updatedAt: string;
}
export type CollaborationOperation = "connect" | "stream" | "presence" | "signal" | "heartbeat" | "disconnect";
export interface CollaborationAuthorizationAttempt {
    readonly room: string;
    readonly operation: CollaborationOperation;
}
export type CollaborationEvent = Readonly<{
    protocol: "clank-collaboration/1";
    room: string;
    revision: number;
    type: "snapshot";
    participants: readonly CollaborationParticipant[];
    at: string;
}> | Readonly<{
    protocol: "clank-collaboration/1";
    room: string;
    revision: number;
    type: "join" | "presence";
    participant: CollaborationParticipant;
    at: string;
}> | Readonly<{
    protocol: "clank-collaboration/1";
    room: string;
    revision: number;
    type: "leave";
    participantId: string;
    at: string;
}> | Readonly<{
    protocol: "clank-collaboration/1";
    room: string;
    revision: number;
    type: "signal";
    participantId: string;
    participantName: string;
    channel: string;
    payload: CollaborationValue;
    at: string;
}>;
export interface CollaborationLimits {
    maxRooms?: number;
    maxParticipantsPerRoom?: number;
    maxConnectionsPerPrincipal?: number;
    maxPresenceBytes?: number;
    maxSignalBytes?: number;
    maxEventsPerMinute?: number;
    idleTimeoutMs?: number;
}
export interface CreateCollaborationHubOptions {
    path?: string;
    authorize(request: Request, attempt: CollaborationAuthorizationAttempt): CollaborationPrincipal | null | Promise<CollaborationPrincipal | null>;
    verifyCsrf(request: Request, principal: CollaborationPrincipal): boolean | Promise<boolean>;
    limits?: CollaborationLimits;
    now?: () => number;
}
export interface CreateAuthCollaborationHubOptions<Profile extends object> {
    path?: string;
    limits?: CollaborationLimits;
    now?: () => number;
    authorizeRoom?(auth: AuthRequest<Profile>, attempt: CollaborationAuthorizationAttempt): boolean | Promise<boolean>;
    displayName?(user: AuthUser<Profile>): string;
}
export interface CollaborationDiagnostics {
    readonly protocol: "clank-collaboration-diagnostics/1";
    readonly rooms: number;
    readonly participants: number;
    readonly streams: number;
    readonly limits: Required<CollaborationLimits>;
}
export interface CollaborationHub {
    handle(request: Request): Promise<Response>;
    diagnostics(): CollaborationDiagnostics;
    close(): void;
}
export interface CreateCollaborationClientOptions {
    url?: string;
    room: string;
    initialPresence?: Readonly<Record<string, CollaborationValue>>;
    csrfToken: string | (() => string | Promise<string>);
    fetch?: typeof fetch;
    reconnect?: boolean;
}
export type CollaborationClientState = "idle" | "connecting" | "connected" | "reconnecting" | "closed" | "error";
export interface CollaborationClient {
    readonly state: ReactiveSignal<CollaborationClientState>;
    readonly participants: ReactiveSignal<readonly CollaborationParticipant[]>;
    readonly lastEvent: ReactiveSignal<CollaborationEvent | null>;
    readonly error: ReactiveSignal<Error | null>;
    connect(): Promise<void>;
    update(presence: Readonly<Record<string, CollaborationValue>>): Promise<void>;
    signal(channel: string, payload: CollaborationValue): Promise<void>;
    disconnect(): Promise<void>;
}
export declare function createCollaborationHub(options: CreateCollaborationHubOptions): CollaborationHub;
export declare function createAuthCollaborationHub<Profile extends object>(auth: Pick<AuthRuntime<Profile>, "resolve" | "verifyCsrf">, options?: CreateAuthCollaborationHubOptions<Profile>): CollaborationHub;
export declare function createCollaborationClient(options: CreateCollaborationClientOptions): CollaborationClient;
