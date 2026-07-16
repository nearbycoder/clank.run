export interface ProcessRunnerOptions {
    kind?: "process";
}
export interface DockerRunnerOptions {
    kind: "docker";
    executable?: string;
    image?: string;
    memory?: string;
    cpus?: string;
    pidsLimit?: number;
}
export type PlatformRunnerOptions = ProcessRunnerOptions | DockerRunnerOptions;
export interface ClankPlatformOptions {
    dataDirectory: string;
    publicUrl: string;
    appHostname?: string;
    /** Public application URL pattern. Supports {slug} and {port}. */
    appUrlTemplate?: string;
    appPortStart?: number;
    appPortEnd?: number;
    runner?: PlatformRunnerOptions;
    /** Defaults to "bootstrap": only the first platform account may self-register. */
    signup?: boolean | "bootstrap";
    masterKey?: string | Uint8Array;
    maxArtifactBytes?: number;
    /** Operator-only escape hatch for configs that request unrestricted SQLite SQL. */
    allowUnsafeMigrations?: boolean;
    deviceCodeLifetimeMs?: number;
    accessTokenLifetimeMs?: number;
    exposeErrors?: boolean;
    onError?: (error: unknown) => void;
}
export interface PlatformRuntime {
    readonly handle: (request: Request) => Promise<Response>;
    readonly publicUrl: string;
    readonly dataDirectory: string;
    close(): Promise<void>;
}
/** Opens Clank's self-hostable deployment control plane and release supervisor. */
export declare function openPlatform(options: ClankPlatformOptions): Promise<PlatformRuntime>;
