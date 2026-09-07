import type { AuthDefinition } from "./auth.js";
import type { SyncClientOptions } from "./backend.js";
export interface Reminder { id: string; title: string; dueAt: number; completed: boolean; version: number; }
export interface ReminderClient {
  list(): Promise<readonly Reminder[]>;
  save(input: { id?: string; expectedVersion?: number; title: string; dueAt: number; key?: string }): Promise<Reminder>;
  complete(id: string, completed: boolean, expectedVersion: number): Promise<void>;
  snooze(id: string, minutes: number, expectedVersion: number): Promise<void>;
  remove(id: string, expectedVersion: number): Promise<void>;
}
export interface ReminderOptions { path: string; auth: AuthDefinition<any>; prefix?: string; }
export declare function dueReminders(reminders: readonly Reminder[], now?: number): readonly Reminder[];
export declare function parseReminderTime(value: string): number;
export declare function openReminders(options: ReminderOptions): Promise<{ handle(request: Request): Promise<Response>; close(): void }>;
export declare function createReminderClient(options?: SyncClientOptions): ReminderClient;
export declare function mountReminders(container: HTMLElement, client: ReminderClient): () => void;
