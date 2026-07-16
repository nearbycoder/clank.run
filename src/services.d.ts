import type { DatabaseSchema, SQLiteDatabase } from "./backend.js";
export type ServiceKind = "files" | "images" | "email" | "jobs" | "cron" | "search" | "webhooks" | "custom";
export interface ServiceDriver<Service = unknown> {
    readonly name: string;
    readonly kind: ServiceKind;
    readonly capabilities: readonly string[];
    readonly service: Service;
    health?(): Promise<{
        ok: boolean;
        detail?: string;
    }>;
    close?(): void | Promise<void>;
}
export interface ServiceRequirement {
    name: string;
    kind: ServiceKind;
    capabilities?: readonly string[];
    required?: boolean;
}
export interface ServiceRegistry {
    get<Service = unknown>(name: string): Service;
    has(name: string): boolean;
    describe(): readonly {
        name: string;
        kind: ServiceKind;
        capabilities: readonly string[];
    }[];
    assert(requirements: readonly ServiceRequirement[]): void;
    health(): Promise<Record<string, {
        ok: boolean;
        detail?: string;
    }>>;
    close(): Promise<void>;
}
export declare function defineServiceDriver<Service>(driver: ServiceDriver<Service>): ServiceDriver<Service>;
export declare function createServiceRegistry(input: readonly ServiceDriver[] | Record<string, ServiceDriver>): ServiceRegistry;
export interface EmailAddress {
    email: string;
    name?: string;
}
export interface EmailMessage {
    from: EmailAddress;
    to: readonly EmailAddress[];
    subject: string;
    text?: string;
    html?: string;
    replyTo?: EmailAddress;
    headers?: Record<string, string>;
    idempotencyKey?: string;
    tags?: Record<string, string>;
}
export interface EmailReceipt {
    id: string;
    acceptedAt: number;
    provider?: string;
}
export interface EmailService {
    send(message: EmailMessage): Promise<EmailReceipt>;
}
export declare function openFileEmailService(options: {
    directory: string;
}): Promise<EmailService>;
export declare function createHttpEmailService(options: {
    url: string;
    token?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    retries?: number;
    headers?: Record<string, string>;
}): EmailService;
export interface FileMetadata {
    key: string;
    size: number;
    sha256: string;
    contentType: string;
    createdAt: number;
    updatedAt: number;
}
export interface FileObject {
    metadata: FileMetadata;
    bytes: Uint8Array;
}
export interface FileStore {
    put(key: string, value: Uint8Array | ArrayBuffer, options?: {
        contentType?: string;
    }): Promise<FileMetadata>;
    get(key: string): Promise<FileObject | null>;
    stat(key: string): Promise<FileMetadata | null>;
    delete(key: string): Promise<boolean>;
    sign(input: {
        key: string;
        operation: "read" | "write";
        expiresAt: number;
    }): Promise<string>;
    verify(token: string, operation: "read" | "write"): Promise<{
        key: string;
        expiresAt: number;
    }>;
    handle(request: Request, prefix?: string): Promise<Response>;
}
export declare function openLocalFileStore(options: {
    directory: string;
    signingKey: string | Uint8Array;
    maxFileBytes?: number;
}): Promise<FileStore>;
export interface JobContext {
    id: string;
    attempt: number;
    signal: AbortSignal;
}
export type JobHandler<Payload = unknown> = (payload: Payload, context: JobContext) => void | Promise<void>;
export interface JobRecord {
    id: string;
    type: string;
    status: "queued" | "running" | "retry" | "completed" | "dead";
    attempts: number;
    maxAttempts: number;
    runAt: number;
    createdAt: number;
    updatedAt: number;
    lastError?: string;
}
export interface JobQueue {
    enqueue<Payload>(type: string, payload: Payload, options?: {
        runAt?: number;
        maxAttempts?: number;
        uniqueKey?: string;
    }): Promise<{
        id: string;
        existing: boolean;
    }>;
    runOnce(limit?: number): Promise<number>;
    inspect(id: string): JobRecord | null;
    retry(id: string, runAt?: number): boolean;
    start(intervalMs?: number): () => void;
    close(): void;
}
export declare function openJobQueue<DB extends DatabaseSchema<any>>(database: SQLiteDatabase<DB>, handlers: Record<string, JobHandler>, options?: {
    workerId?: string;
    leaseMs?: number;
    handlerTimeoutMs?: number;
    retryBaseMs?: number;
    maxBatch?: number;
    onError?: (error: unknown, job: JobRecord) => void;
}): JobQueue;
export interface WebhookSender {
    send(input: {
        url: string;
        event: string;
        payload: unknown;
        secret: string | Uint8Array;
        idempotencyKey?: string;
    }): Promise<{
        status: number;
        attempts: number;
    }>;
}
export declare function signWebhook(body: string | Uint8Array, secret: string | Uint8Array, timestamp?: number): Promise<{
    timestamp: number;
    signature: string;
}>;
export declare function verifyWebhook(input: {
    body: string | Uint8Array;
    secret: string | Uint8Array;
    timestamp: number | string;
    signature: string;
    now?: number;
    toleranceSeconds?: number;
}): Promise<boolean>;
export declare function createWebhookSender(options?: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    retries?: number;
}): WebhookSender;
