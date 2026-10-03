export interface DevelopmentStateAdapter<Value> { snapshot(): Value; restore(value: Value): void; }
/** Opt-in JSON state recovery across local development reloads. Never register credentials. */
export declare function preserveDevelopmentState<Value>(key: string, adapter: DevelopmentStateAdapter<Value>): () => void;
