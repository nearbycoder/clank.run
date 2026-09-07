export interface TourStep { id: string; title: string; body: string; target(): Element | null; prepare?(signal: AbortSignal): void | Promise<void>; }
export interface TourProgress { version: string; stepId: string; status: "active" | "completed" | "skipped"; }
export interface TourController { start(restart?: boolean): Promise<void>; next(): Promise<void>; back(): Promise<void>; pause(): void; skip(): void; progress(): TourProgress; dispose(): void; }
export interface TourOptions { id: string; version: string; steps: readonly TourStep[]; storage?: Pick<Storage,"getItem"|"setItem">; onFinish?(status: "completed" | "skipped"): void; }
export declare function restoreTourProgress(snapshot: string | null, version: string, stepIds: readonly string[]): TourProgress;
export declare function createTour(document: Document, options: TourOptions): TourController;
