import type { OpenBackendOptions, SyncClientOptions } from "./backend.js";
import type { AuthDefinition } from "./auth.js";
import type { JobProcessHandle } from "./jobs.js";
export interface WebhookAttempt { readonly attempt: number; readonly generation: number; readonly status: number | null; readonly secretVersion: string | null; readonly outcome: string; readonly createdAt: number; }
export interface WebhookDelivery { readonly id: string; readonly endpoint: string; readonly event: string; readonly state: string; readonly attempts: number; readonly jobId: string; readonly generation: number; readonly status: number | null; readonly secretVersion: string | null; readonly createdAt: number; }
export interface WebhookOutboxOptions {
  path: string; auth: AuthDefinition<any>; prefix?: string; maxPerUser?: number;
  /** Trusted server configuration only. Secrets are resolved anew for every attempt. */
  endpoints: Readonly<Record<string, { url: string; secret: () => { version: string; value: string | Uint8Array } | Promise<{ version: string; value: string | Uint8Array }> }>>;
  fetch?: typeof fetch; onError?: OpenBackendOptions["onError"];
}
export interface WebhookOutbox { handle(request: Request): Promise<Response>; publish(input: { userId: string; key: string; endpoint: string; event: string; payload: unknown }): string; workOnce(): Promise<boolean>; startWorker(): JobProcessHandle; close(): void; }
export declare function openWebhookOutbox(options: WebhookOutboxOptions): Promise<WebhookOutbox>;
export interface WebhookClient { list(): Promise<readonly WebhookDelivery[]>; inspect(id:string):Promise<readonly WebhookAttempt[]>; replay(id:string,expectedJobId:string):Promise<boolean>; }
export declare function createWebhookClient(options?:SyncClientOptions):WebhookClient;
export declare function renderWebhookConsole(deliveries:readonly WebhookDelivery[]):string;
export declare function mountWebhookConsole(container:HTMLElement,client:WebhookClient):()=>void;
