import type { AuthDefinition } from "./auth.js";
import type { SyncClientOptions } from "./backend.js";
export interface DashboardPlacement { id: string; visible: boolean; span: 1 | 2; collapsed: boolean; }
export interface DashboardLayout { id: string; name: string; widgets: readonly DashboardPlacement[]; isDefault: boolean; version: number; }
export interface DashboardClient { list(): Promise<readonly DashboardLayout[]>; save(input: { id?: string; expectedVersion?: number; name: string; widgets: readonly DashboardPlacement[] }): Promise<DashboardLayout>; remove(id: string, expectedVersion: number): Promise<void>; setDefault(id: string | null): Promise<void>; }
export interface DashboardOptions { path: string; auth: AuthDefinition<any>; widgetIds: readonly string[]; prefix?: string; }
export interface DashboardWidget { id: string; title: string; mount(container: HTMLElement): void | (() => void); }
export declare function validateDashboardLayout(value:unknown,widgetIds:readonly string[]):readonly DashboardPlacement[];
export declare function openDashboardLayouts(options:DashboardOptions):Promise<{handle(request:Request):Promise<Response>;close():void}>;
export declare function createDashboardClient(options?:SyncClientOptions):DashboardClient;
export declare function mountDashboard(container:HTMLElement,client:DashboardClient,widgets:readonly DashboardWidget[]):()=>void;
