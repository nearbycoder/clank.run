import type { AuthDefinition } from "./auth.js";
import type { SyncClientOptions } from "./backend.js";
export interface TimeWindow { startAt: number; endAt: number; }
export interface AvailabilityWindow extends TimeWindow { id: string; title: string; version: number; }
export interface SlotOptions extends TimeWindow { durationMinutes: number; stepMinutes?: number; bufferMinutes?: number; blocked?: readonly TimeWindow[]; limit?: number; }
export interface AvailabilityClient { list(): Promise<readonly AvailabilityWindow[]>; save(input: { id?: string; expectedVersion?: number; title: string; startAt: number; endAt: number }): Promise<AvailabilityWindow>; remove(id: string, expectedVersion: number): Promise<void>; }
export interface AvailabilityOptions { path: string; auth: AuthDefinition<any>; prefix?: string; }
export declare function availableSlots(windows:readonly TimeWindow[],options:SlotOptions):{slots:readonly TimeWindow[];truncated:boolean};
export declare function openAvailability(options:AvailabilityOptions):Promise<{handle(request:Request):Promise<Response>;close():void}>;
export declare function createAvailabilityClient(options?:SyncClientOptions):AvailabilityClient;
export declare function mountAvailability(container:HTMLElement,client:AvailabilityClient,options?:{blocked?():readonly TimeWindow[];onSelect?(slot:TimeWindow):void}):()=>void;
