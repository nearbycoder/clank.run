import { type InferSchema, type InferSchemaShape, type Schema, type SchemaShape } from "./ai.js";
import {
    type DatabaseSchema,
    type DatabaseScope,
    type ReadDatabase,
    type SQLiteDatabase,
    type WriteDatabase,
} from "./backend.js";

export type JobArgs = Schema<any> | SchemaShape;
export type InferJobArgs<Args extends JobArgs> = Args extends Schema<any>
    ? InferSchema<Args>
    : Args extends SchemaShape
        ? InferSchemaShape<Args>
        : never;
export type JobState = "queued" | "running" | "retry" | "succeeded" | "dead" | "cancelled";
export type CronConcurrency = "allow" | "forbid" | "replace";

export interface JobRetryOptions {
    maxAttempts?: number;
    initialDelayMs?: number;
    factor?: number;
    maxDelayMs?: number;
    jitter?: number;
}

export interface CronDefinition<Input> {
    name: string;
    cron: string;
    timezone?: string;
    args: Input;
    concurrency?: CronConcurrency;
    startingDeadlineMs?: number;
    maxCatchUp?: number;
    suspended?: boolean;
}

export interface JobMetadata {
    readonly id: string;
    readonly name: string;
    readonly queue: string;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly createdAt: number;
    readonly scheduledAt: number | null;
    readonly cron: string | null;
    readonly ownerId: string | null;
}

export interface JobDatabase<DB extends DatabaseSchema<any>> {
    read<Value>(handler: (db: ReadDatabase<DB>) => Value): Value;
    transaction<Value>(handler: (db: WriteDatabase<DB>) => Value): Value;
}

export interface JobHandlerContext<
    DB extends DatabaseSchema<any>,
    Definition extends JobSystemDefinition<DB, any>,
> {
    readonly db: JobDatabase<DB>;
    readonly job: JobMetadata;
    readonly signal: AbortSignal;
    readonly jobs: JobPublisher<Definition>;
}

export interface JobAgentOptions {
    title?: string;
    description?: string;
    openWorld?: boolean;
    idempotent?: boolean;
}

export interface JobDefinition<
    Input,
    Output,
    DB extends DatabaseSchema<any>,
    Definition extends JobSystemDefinition<DB, any> = JobSystemDefinition<DB, any>,
> {
    readonly kind: "job";
    readonly args: Schema<Input>;
    readonly returns?: Schema<Output>;
    readonly queue: string;
    readonly priority: number;
    readonly timeoutMs: number;
    readonly retry: Readonly<Required<JobRetryOptions>>;
    readonly schedules: readonly Readonly<CronDefinition<Input>>[];
    readonly description?: string;
    readonly agent: false | Readonly<JobAgentOptions>;
    readonly handler: (context: JobHandlerContext<DB, Definition>, args: Input) => Output | Promise<Output>;
}

export type AnyJobDefinition = JobDefinition<any, any, any, any>;
export type JobTree = {
    readonly [key: string]: AnyJobDefinition | JobTree;
};
export type JobOfTree<Tree> = Tree extends AnyJobDefinition
    ? Tree
    : Tree extends Readonly<Record<string, unknown>>
        ? { [Key in keyof Tree]: JobOfTree<Tree[Key]> }[keyof Tree]
        : never;

export interface JobBuilders<
    DB extends DatabaseSchema<any>,
    Definition extends JobSystemDefinition<DB, any> = JobSystemDefinition<DB, any>,
> {
    job<const Args extends JobArgs, Output>(definition: {
        args: Args;
        returns?: Schema<Output>;
        queue?: string;
        priority?: number;
        timeoutMs?: number;
        retry?: JobRetryOptions;
        schedules?: readonly CronDefinition<InferJobArgs<Args>>[];
        description?: string;
        agent?: false | JobAgentOptions;
        handler: (
            context: JobHandlerContext<DB, Definition>,
            args: InferJobArgs<Args>,
        ) => Output | Promise<Output>;
    }): JobDefinition<InferJobArgs<Args>, Output, DB, Definition>;
}

export interface JobSystemDefinition<
    DB extends DatabaseSchema<any>,
    Jobs extends JobTree,
> {
    readonly schema: DB;
    readonly jobs: Jobs;
}

export interface JobSystemBuilder<DB extends DatabaseSchema<any>> {
    jobs<const Jobs extends JobTree>(
        define: (builders: JobBuilders<DB>) => Jobs,
    ): JobSystemDefinition<DB, Jobs>;
}

export declare function defineJobs<DB extends DatabaseSchema<any>>(
    options: { schema: DB },
): JobSystemBuilder<DB>;

export type JobInput<Job> = Job extends JobDefinition<infer Input, any, any, any> ? Input : never;
export type JobOutput<Job> = Job extends JobDefinition<any, infer Output, any, any> ? Output : never;

export interface EnqueueOptions {
    runAt?: number;
    delayMs?: number;
    priority?: number;
    queue?: string;
    idempotencyKey?: string;
    group?: string;
}

export interface JobHandle {
    readonly id: string;
    readonly deduplicated: boolean;
}

export interface JobPublisher<Definition extends JobSystemDefinition<any, any>> {
    enqueue<Job extends JobOfTree<Definition["jobs"]>>(
        job: Job,
        args: JobInput<Job>,
        options?: EnqueueOptions,
    ): JobHandle;
}

export interface StoredJob {
    readonly id: string;
    readonly name: string;
    readonly queue: string;
    readonly state: JobState;
    readonly args: unknown;
    readonly result?: unknown;
    readonly error?: string;
    readonly ownerId: string | null;
    readonly priority: number;
    readonly group: string | null;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly runAt: number;
    readonly scheduledAt: number | null;
    readonly cron: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly startedAt: number | null;
    readonly completedAt: number | null;
    readonly leaseOwner: string | null;
    readonly leaseUntil: number | null;
    readonly cancelRequested: boolean;
}

export interface JobListOptions {
    state?: JobState;
    queue?: string;
    name?: string;
    limit?: number;
}

export interface JobStats {
    readonly queued: number;
    readonly running: number;
    readonly retry: number;
    readonly succeeded: number;
    readonly dead: number;
    readonly cancelled: number;
    readonly due: number;
    readonly oldestDueAt: number | null;
}
export interface JobEvent {
    readonly id: number;
    readonly jobId: string;
    readonly event: string;
    readonly details: Readonly<Record<string, unknown>>;
    readonly createdAt: number;
}
export interface JobPurgeOptions {
    states?: readonly Extract<JobState, "succeeded" | "dead" | "cancelled">[];
    before?: number;
    limit?: number;
}
export interface JobRetentionOptions {
    succeededMs?: number | false;
    cancelledMs?: number | false;
    deadMs?: number | false;
    cleanupIntervalMs?: number;
}
export interface JobManifestEntry {
    readonly name: string;
    readonly queue: string;
    readonly description?: string;
    readonly args: Record<string, unknown>;
    readonly returns?: Record<string, unknown>;
    readonly retry: Readonly<Required<JobRetryOptions>>;
    readonly timeoutMs: number;
    readonly schedules: readonly {
        readonly name: string;
        readonly cron: string;
        readonly timezone: string;
        readonly concurrency: CronConcurrency;
        readonly suspended: boolean;
    }[];
    readonly agent: false | Readonly<JobAgentOptions>;
}

export interface JobWorkerOptions {
    concurrency?: number;
    queues?: readonly string[];
    leaseMs?: number;
    pollIntervalMs?: number;
    workerId?: string;
}

export interface JobSchedulerOptions {
    leaseMs?: number;
    pollIntervalMs?: number;
    batchSize?: number;
    schedulerId?: string;
}

export interface JobProcessHandle {
    readonly role: "worker" | "scheduler";
    readonly id: string;
    close(): Promise<void>;
}
export type JobProcessRole = "worker" | "scheduler";
export interface RunJobProcessOptions {
    role?: JobProcessRole;
    worker?: JobWorkerOptions;
    scheduler?: JobSchedulerOptions;
    onReady?: (role: JobProcessRole, id: string) => void;
}

export interface OpenJobsOptions {
    now?: () => number;
    random?: () => number;
    onError?: (error: unknown, job?: StoredJob) => void;
    maxPayloadBytes?: number;
    maxResultBytes?: number;
    maxErrorBytes?: number;
    retention?: JobRetentionOptions;
}

export interface JobRuntime<Definition extends JobSystemDefinition<any, any>>
    extends JobPublisher<Definition> {
    readonly definition: Definition;
    readonly database: SQLiteDatabase<Definition["schema"]>;
    publisher(scope?: DatabaseScope): JobPublisher<Definition>;
    get(id: string): StoredJob | null;
    list(options?: JobListOptions): StoredJob[];
    events(id: string, options?: { limit?: number }): JobEvent[];
    stats(): JobStats;
    cancel(id: string): boolean;
    retry(id: string, options?: { runAt?: number }): boolean;
    purge(options?: JobPurgeOptions): number;
    workOnce(options?: Omit<JobWorkerOptions, "concurrency" | "pollIntervalMs">): Promise<boolean>;
    scheduleOnce(options?: Omit<JobSchedulerOptions, "pollIntervalMs">): Promise<number>;
    startWorker(options?: JobWorkerOptions): JobProcessHandle;
    startScheduler(options?: JobSchedulerOptions): JobProcessHandle;
    close(): void;
}

export declare function openJobs<Definition extends JobSystemDefinition<any, any>>(
    definition: Definition,
    options: OpenJobsOptions & { database: SQLiteDatabase<Definition["schema"]> },
): JobRuntime<Definition>;
export declare function runJobProcess(runtime: JobRuntime<any>, options?: RunJobProcessOptions): Promise<void>;

export declare function jobPath(job: AnyJobDefinition): string;
export declare function jobManifest(definition: JobSystemDefinition<any, any>): readonly JobManifestEntry[];
export declare function normalizeCron(input: string): string;
export declare function nextCronOccurrence(
    expression: string,
    after: number | Date,
    timezone?: string,
): number;
