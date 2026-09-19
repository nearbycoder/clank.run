import type { AuthDefinition } from "./auth.js";
import type { OpenBackendOptions, SyncClientOptions } from "./backend.js";
import type { JobProcessHandle } from "./jobs.js";
export interface NotificationItem {
  readonly _id: string; readonly _creationTime: number; readonly category: string; readonly title: string;
  readonly body: string; readonly url: string | null; readonly readAt: number | null;
  readonly emailState: string;
}
export interface NotificationPreferences { category: string; inApp: boolean; email: boolean; }
export interface NotificationCenterOptions {
  path: string;
  auth: AuthDefinition<any>;
  categories: readonly string[];
  prefix?: string;
  maxPerUser?: number;
  sendEmail?: (message: { to: string; subject: string; text: string; url: string | null; idempotencyKey: string; signal: AbortSignal }) => Promise<void>;
  onError?: OpenBackendOptions["onError"];
}
export interface NotificationCenter {
  handle(request: Request): Promise<Response>;
  publish(input: { userId: string; key: string; category: string; title: string; body: string; url?: string }): string | null;
  workEmailOnce(): Promise<boolean>;
  startEmailWorker(): JobProcessHandle;
  close(): void;
}

export interface NotificationClient {
  list(unreadOnly?: boolean): Promise<readonly NotificationItem[]>;
  unreadCount(): Promise<number>;
  markRead(id: string, read?: boolean): Promise<boolean>;
  markAllRead(): Promise<number>;
  preferences(): Promise<readonly NotificationPreferences[]>;
  setPreference(preferences: NotificationPreferences): Promise<NotificationPreferences>;
}

export declare function openNotificationCenter(options: NotificationCenterOptions): Promise<NotificationCenter>;
export declare function createNotificationClient(options?: SyncClientOptions): NotificationClient;
export declare function renderNotificationCenter(items: readonly NotificationItem[]): string;
export declare function mountNotificationCenter(container: HTMLElement, client: NotificationClient): () => void;
