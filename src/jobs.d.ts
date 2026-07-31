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
    Workflows extends WorkflowTree = {},
> {
    readonly schema: DB;
    readonly jobs: Jobs;
    readonly workflows: Workflows;
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

export interface WorkflowAgentOptions {
    title?: string;
    description?: string;
    openWorld?: boolean;
    idempotent?: boolean;
}
export interface WorkflowStepContext<Input> {
    readonly input: Input;
    result<Step extends AnyWorkflowStepDefinition>(step: Step): JobOutput<Step["job"]>;
}
export interface WorkflowStepDefinition<Input, Job extends AnyJobDefinition> {
    readonly kind: "workflow-step";
    readonly job: Job;
    readonly needs: readonly AnyWorkflowStepDefinition[];
    readonly description?: string;
    readonly args: (context: WorkflowStepContext<Input>) => JobInput<Job>;
}
export type AnyWorkflowStepDefinition = WorkflowStepDefinition<any, AnyJobDefinition>;
export type WorkflowStepTree = Readonly<Record<string, AnyWorkflowStepDefinition>>;
export type WorkflowResults<Steps extends WorkflowStepTree> = Readonly<{
    [Name in keyof Steps]: JobOutput<Steps[Name]["job"]>;
}>;
export interface WorkflowOutputContext<Input, Steps extends WorkflowStepTree> {
    readonly input: Input;
    readonly results: WorkflowResults<Steps>;
    result<Step extends Steps[keyof Steps]>(step: Step): JobOutput<Step["job"]>;
}
export interface WorkflowDefinition<
    Input,
    Output,
    Steps extends WorkflowStepTree = WorkflowStepTree,
> {
    readonly kind: "workflow";
    readonly args: Schema<Input>;
    readonly returns?: Schema<Output>;
    readonly steps: Steps;
    readonly description?: string;
    readonly agent: false | Readonly<WorkflowAgentOptions>;
    readonly output: (context: WorkflowOutputContext<Input, Steps>) => Output;
}
export type AnyWorkflowDefinition = WorkflowDefinition<any, any, any>;
export type WorkflowTree = {
    readonly [key: string]: AnyWorkflowDefinition | WorkflowTree;
};
export type WorkflowOfTree<Tree> = Tree extends AnyWorkflowDefinition
    ? Tree
    : Tree extends Readonly<Record<string, unknown>>
        ? { [Key in keyof Tree]: WorkflowOfTree<Tree[Key]> }[keyof Tree]
        : never;
export type WorkflowInput<Workflow> = Workflow extends WorkflowDefinition<infer Input, any, any>
    ? Input
    : never;
export type WorkflowOutput<Workflow> = Workflow extends WorkflowDefinition<any, infer Output, any>
    ? Output
    : never;
export interface WorkflowGraphBuilder<Input> {
    step<Job extends AnyJobDefinition>(job: Job, definition: {
        needs?: readonly AnyWorkflowStepDefinition[];
        description?: string;
        args: (context: WorkflowStepContext<Input>) => JobInput<Job>;
    }): WorkflowStepDefinition<Input, Job>;
}
export declare function defineWorkflow<
    const Args extends JobArgs,
    const Steps extends WorkflowStepTree,
    Output = WorkflowResults<Steps>,
>(definition: {
    args: Args;
    graph: (builder: WorkflowGraphBuilder<InferJobArgs<Args>>) => Steps;
    returns?: Schema<Output>;
    description?: string;
    agent?: false | WorkflowAgentOptions;
    output?: (context: WorkflowOutputContext<InferJobArgs<Args>, Steps>) => Output;
}): WorkflowDefinition<InferJobArgs<Args>, Output, Steps>;
export declare function defineWorkflows<
    DB extends DatabaseSchema<any>,
    Jobs extends JobTree,
    const Workflows extends WorkflowTree,
>(
    definition: JobSystemDefinition<DB, Jobs, any>,
    workflows: Workflows,
): JobSystemDefinition<DB, Jobs, Workflows>;

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

export type WorkflowState = "running" | "succeeded" | "failed" | "cancelled";
export type WorkflowStepState = "blocked" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface WorkflowStartOptions {
    idempotencyKey?: string;
}
export interface WorkflowHandle {
    readonly id: string;
    readonly deduplicated: boolean;
}
export interface StoredWorkflowStep {
    readonly name: string;
    readonly job: string;
    readonly needs: readonly string[];
    readonly state: WorkflowStepState;
    readonly jobId: string | null;
    readonly result?: unknown;
    readonly error?: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly startedAt: number | null;
    readonly completedAt: number | null;
}
export interface StoredWorkflowRun {
    readonly id: string;
    readonly name: string;
    readonly state: WorkflowState;
    readonly input: unknown;
    readonly output?: unknown;
    readonly error?: string;
    readonly ownerId: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly completedAt: number | null;
    readonly cancelRequested: boolean;
    readonly steps: readonly StoredWorkflowStep[];
}
export interface WorkflowListOptions {
    state?: WorkflowState;
    name?: string;
    limit?: number;
}
export interface WorkflowEvent {
    readonly id: number;
    readonly workflowId: string;
    readonly event: string;
    readonly step: string | null;
    readonly details: Readonly<Record<string, unknown>>;
    readonly createdAt: number;
}
export interface WorkflowPurgeOptions {
    states?: readonly Extract<WorkflowState, "succeeded" | "failed" | "cancelled">[];
    before?: number;
    limit?: number;
}

export interface JobPublisher<Definition extends JobSystemDefinition<any, any>> {
    enqueue<Job extends JobOfTree<Definition["jobs"]>>(
        job: Job,
        args: JobInput<Job>,
        options?: EnqueueOptions,
    ): JobHandle;
    startWorkflow<Workflow extends WorkflowOfTree<Definition["workflows"]>>(
        workflow: Workflow,
        input: WorkflowInput<Workflow>,
        options?: WorkflowStartOptions,
    ): WorkflowHandle;
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
    workflowSucceededMs?: number | false;
    workflowCancelledMs?: number | false;
    workflowFailedMs?: number | false;
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
export interface WorkflowManifestEntry {
    readonly name: string;
    readonly description?: string;
    readonly args: Record<string, unknown>;
    readonly returns?: Record<string, unknown>;
    readonly steps: readonly {
        readonly name: string;
        readonly job: string;
        readonly needs: readonly string[];
        readonly description?: string;
    }[];
    readonly agent: false | Readonly<WorkflowAgentOptions>;
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
    getWorkflow(id: string): StoredWorkflowRun | null;
    listWorkflows(options?: WorkflowListOptions): StoredWorkflowRun[];
    workflowEvents(id: string, options?: { limit?: number }): WorkflowEvent[];
    cancelWorkflow(id: string): boolean;
    purgeWorkflows(options?: WorkflowPurgeOptions): number;
    advanceWorkflows(options?: { limit?: number }): number;
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
export declare function workflowPath(workflow: AnyWorkflowDefinition): string;
export declare function workflowManifest(definition: JobSystemDefinition<any, any, any>): readonly WorkflowManifestEntry[];
export declare function normalizeCron(input: string): string;
export declare function nextCronOccurrence(
    expression: string,
    after: number | Date,
    timezone?: string,
): number;
