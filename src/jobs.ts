import { s, type InferSchema, type InferSchemaShape, type Schema, type SchemaShape } from "./ai.ts";
import {
  type DatabaseSchema,
  type DatabaseScope,
  type ReadDatabase,
  type SQLiteDatabase,
  type WriteDatabase,
} from "./backend.ts";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.ts";

export type JobArgs = Schema<any> | SchemaShape;
export type InferJobArgs<Args extends JobArgs> = Args extends Schema<any>
  ? InferSchema<Args>
  : Args extends SchemaShape
    ? InferSchemaShape<Args>
    : never;

export type JobState = "queued" | "running" | "retry" | "succeeded" | "dead" | "cancelled";
export type CronConcurrency = "allow" | "forbid" | "replace";

export interface JobRetryOptions {
  /** Total attempts including the first execution. Defaults to 5. */
  maxAttempts?: number;
  /** Delay before the second attempt. Defaults to 1 second. */
  initialDelayMs?: number;
  /** Exponential multiplier. Defaults to 2. */
  factor?: number;
  /** Maximum retry delay. Defaults to 15 minutes. */
  maxDelayMs?: number;
  /** Random delay ratio from 0 through 1. Defaults to 0.2. */
  jitter?: number;
}

export interface CronDefinition<Input> {
  /** Stable name within this job. */
  name: string;
  /** Five-field cron expression or @hourly/@daily/@weekly/@monthly/@yearly. */
  cron: string;
  /** IANA time zone. Defaults to Etc/UTC. */
  timezone?: string;
  /** Validated arguments enqueued for each occurrence. */
  args: Input;
  /** Behavior when an earlier occurrence is still active. Defaults to allow. */
  concurrency?: CronConcurrency;
  /** Do not start an occurrence later than this. Defaults to 1 hour. */
  startingDeadlineMs?: number;
  /** Maximum missed occurrences created by one scheduler pass. Defaults to 10. */
  maxCatchUp?: number;
  /** Keep future occurrences disabled without deleting the definition. */
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

export interface JobDatabase<Schema extends DatabaseSchema<any>> {
  read<Value>(handler: (db: ReadDatabase<Schema>) => Value): Value;
  transaction<Value>(handler: (db: WriteDatabase<Schema>) => Value): Value;
}

export interface JobHandlerContext<
  Schema extends DatabaseSchema<any>,
  Definition extends JobSystemDefinition<Schema, any>,
> {
  readonly db: JobDatabase<Schema>;
  readonly job: JobMetadata;
  readonly signal: AbortSignal;
  readonly jobs: JobPublisher<Definition>;
}

export interface JobAgentOptions {
  /** Human-readable title for manifests and operator tools. */
  title?: string;
  /** Human-readable behavior and side-effect description. */
  description?: string;
  /** Whether the job communicates outside this application. */
  openWorld?: boolean;
  /** Whether duplicate delivery is safe. */
  idempotent?: boolean;
}

export interface JobDefinition<
  Input,
  Output,
  DB extends DatabaseSchema<any>,
  Definition extends JobSystemDefinition<DB, any> = JobSystemDefinition<DB, any>,
> {
  readonly kind: "job";
  readonly args: SchemaType<Input>;
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

type SchemaType<Value> = Schema<Value>;
export type AnyJobDefinition = JobDefinition<any, any, any, any>;
export type JobTree = { readonly [key: string]: AnyJobDefinition | JobTree };
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

const JOB_PATH = Symbol.for("clank.job.path");
const WORKFLOW_PATH = Symbol.for("clank.workflow.path");

export function defineJobs<DB extends DatabaseSchema<any>>(
  options: { schema: DB },
): JobSystemBuilder<DB> {
  const builder: JobBuilders<DB> = {
    job(definition) {
      return createJobDefinition(definition) as any;
    },
  };
  return {
    jobs(define) {
      const jobs = define(builder);
      const registry = flattenJobs(jobs);
      if (registry.size > 1_000) throw new TypeError("A job system cannot contain more than 1,000 jobs.");
      const definitions = new Set<AnyJobDefinition>();
      for (const [path, job] of registry) {
        if (path.length > 512) throw new TypeError(`Job path exceeds 512 characters: ${path}`);
        if (definitions.has(job)) {
          throw new TypeError(`A job definition cannot be reused at more than one path: ${path}`);
        }
        definitions.add(job);
        Object.defineProperty(job, JOB_PATH, { value: path, enumerable: false });
        Object.freeze(job);
      }
      return Object.freeze({
        schema: options.schema,
        jobs: freezeJobTree(jobs) as typeof jobs,
        workflows: Object.freeze({}),
      });
    },
  };
}

function createJobDefinition(definition: {
  args: JobArgs;
  returns?: Schema<any>;
  queue?: string;
  priority?: number;
  timeoutMs?: number;
  retry?: JobRetryOptions;
  schedules?: readonly CronDefinition<any>[];
  description?: string;
  agent?: false | JobAgentOptions;
  handler: (context: any, args: any) => unknown;
}): AnyJobDefinition {
  if (typeof definition.handler !== "function") throw new TypeError("job requires a handler.");
  const queue = identifier(definition.queue ?? "default", "job queue", 128);
  const priority = integer(definition.priority ?? 0, "job priority", -1_000, 1_000);
  const timeoutMs = integer(definition.timeoutMs ?? 5 * 60_000, "job timeoutMs", 100, 24 * 60 * 60_000);
  const retry = normalizeRetry(definition.retry);
  const args = toSchema(definition.args);
  if ((definition.schedules?.length ?? 0) > 100) {
    throw new TypeError("A job cannot contain more than 100 schedules.");
  }
  const schedules = (definition.schedules ?? []).map((schedule, index) =>
    normalizeSchedule(schedule, args, index));
  const names = new Set<string>();
  for (const schedule of schedules) {
    if (names.has(schedule.name)) throw new TypeError(`Duplicate job schedule: ${schedule.name}`);
    names.add(schedule.name);
  }
  const description = optionalText(definition.description, "job description", 16 * 1024);
  const agent = normalizeAgent(definition.agent);
  const job = {
    kind: "job" as const,
    args,
    ...(definition.returns ? { returns: definition.returns } : {}),
    queue,
    priority,
    timeoutMs,
    retry,
    schedules: Object.freeze(schedules),
    ...(description ? { description } : {}),
    agent,
    handler: definition.handler,
  };
  return job as AnyJobDefinition;
}

export type JobInput<Job> = Job extends JobDefinition<infer Input, any, any, any> ? Input : never;
export type JobOutput<Job> = Job extends JobDefinition<any, infer Output, any, any> ? Output : never;

export interface WorkflowAgentOptions {
  /** Human-readable title for manifests and agent planning. */
  title?: string;
  /** Human-readable business outcome and side-effect description. */
  description?: string;
  /** Whether one or more steps communicate outside this application. */
  openWorld?: boolean;
  /** Whether repeated starts with the same key safely converge. */
  idempotent?: boolean;
}

export interface WorkflowStepContext<Input> {
  readonly input: Input;
  /** Read the validated result of a declared dependency. */
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
  step<Job extends AnyJobDefinition>(
    job: Job,
    definition: {
      needs?: readonly AnyWorkflowStepDefinition[];
      description?: string;
      args: (context: WorkflowStepContext<Input>) => JobInput<Job>;
    },
  ): WorkflowStepDefinition<Input, Job>;
}

export function defineWorkflow<
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
}): WorkflowDefinition<InferJobArgs<Args>, Output, Steps> {
  const args = toSchema(definition.args);
  const created = new Set<AnyWorkflowStepDefinition>();
  const builder: WorkflowGraphBuilder<InferJobArgs<Args>> = Object.freeze({
    step(job, stepDefinition) {
      if (!isJobDefinition(job)) throw new TypeError("Workflow steps require a job from defineJobs().");
      if (typeof stepDefinition?.args !== "function") throw new TypeError("Workflow steps require an args mapper.");
      if ((stepDefinition.needs?.length ?? 0) > 100) {
        throw new TypeError("A workflow step cannot have more than 100 dependencies.");
      }
      const description = optionalText(stepDefinition.description, "workflow step description", 16 * 1024);
      const step = {
        kind: "workflow-step" as const,
        job,
        needs: Object.freeze([...(stepDefinition.needs ?? [])]),
        ...(description ? { description } : {}),
        args: stepDefinition.args,
      };
      created.add(step);
      return Object.freeze(step) as WorkflowStepDefinition<InferJobArgs<Args>, typeof job>;
    },
  });
  const steps = definition.graph(builder);
  if (!steps || typeof steps !== "object" || Array.isArray(steps)) {
    throw new TypeError("Workflow graph must return a named step object.");
  }
  const entries = Object.entries(steps);
  if (entries.length === 0 || entries.length > 100) {
    throw new TypeError("A workflow must contain from 1 through 100 steps.");
  }
  const names = new Map<AnyWorkflowStepDefinition, string>();
  for (const [name, step] of entries) {
    identifier(name, "workflow step name", 128);
    if (!created.has(step)) throw new TypeError(`Workflow step ${name} was not created by this graph.`);
    if (names.has(step)) throw new TypeError(`Workflow step ${name} is reused as ${names.get(step)}.`);
    names.set(step, name);
  }
  for (const [name, step] of entries) {
    const dependencies = new Set<AnyWorkflowStepDefinition>();
    for (const dependency of step.needs) {
      if (!names.has(dependency)) throw new TypeError(`Workflow step ${name} depends on a step outside its graph.`);
      if (dependency === step) throw new TypeError(`Workflow step ${name} cannot depend on itself.`);
      if (dependencies.has(dependency)) throw new TypeError(`Workflow step ${name} repeats a dependency.`);
      dependencies.add(dependency);
    }
  }
  assertAcyclicWorkflow(entries, names);
  const frozenSteps = Object.freeze(Object.fromEntries(entries)) as Steps;
  const description = optionalText(definition.description, "workflow description", 16 * 1024);
  const agent = normalizeWorkflowAgent(definition.agent);
  const output = definition.output ?? ((context: WorkflowOutputContext<any, any>) => context.results as Output);
  if (typeof output !== "function") throw new TypeError("Workflow output must be a function.");
  return {
    kind: "workflow" as const,
    args,
    ...(definition.returns ? { returns: definition.returns } : {}),
    steps: frozenSteps,
    ...(description ? { description } : {}),
    agent,
    output,
  } as WorkflowDefinition<InferJobArgs<Args>, Output, Steps>;
}

export function defineWorkflows<
  DB extends DatabaseSchema<any>,
  Jobs extends JobTree,
  const Workflows extends WorkflowTree,
>(
  definition: JobSystemDefinition<DB, Jobs, any>,
  workflows: Workflows,
): JobSystemDefinition<DB, Jobs, Workflows> {
  const registry = flattenWorkflows(workflows);
  const jobs = flattenJobs(definition.jobs);
  if (registry.size > 1_000) throw new TypeError("A job system cannot contain more than 1,000 workflows.");
  const seen = new Set<AnyWorkflowDefinition>();
  for (const [path, workflow] of registry) {
    if (path.length > 512) throw new TypeError(`Workflow path exceeds 512 characters: ${path}`);
    if (seen.has(workflow)) throw new TypeError(`A workflow definition cannot be reused at more than one path: ${path}`);
    seen.add(workflow);
    for (const [stepName, step] of Object.entries(workflow.steps)) {
      const jobName = jobPath(step.job);
      if (jobs.get(jobName) !== step.job) {
        throw new TypeError(`Workflow step ${path}.${stepName} uses a job outside this job system.`);
      }
    }
    Object.defineProperty(workflow, WORKFLOW_PATH, { value: path, enumerable: false });
    Object.freeze(workflow);
  }
  return Object.freeze({
    schema: definition.schema,
    jobs: definition.jobs,
    workflows: freezeWorkflowTree(workflows) as Workflows,
  });
}

export interface EnqueueOptions {
  /** Earliest execution time as an epoch millisecond timestamp. */
  runAt?: number;
  /** Delay from now; mutually exclusive with runAt. */
  delayMs?: number;
  /** Higher values are claimed first. */
  priority?: number;
  /** Queue override for operational partitioning. */
  queue?: string;
  /** Stable caller key. Repeated enqueue returns the existing retained job. */
  idempotencyKey?: string;
  /** Serializes active jobs sharing the same group. */
  group?: string;
}

export interface JobHandle {
  readonly id: string;
  readonly deduplicated: boolean;
}

export type WorkflowState = "running" | "succeeded" | "failed" | "cancelled";
export type WorkflowStepState = "blocked" | "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface WorkflowStartOptions {
  /** Stable caller key. Repeated starts return the existing retained run. */
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
  /** Terminal run states to remove. Defaults to succeeded and cancelled. */
  states?: readonly Extract<WorkflowState, "succeeded" | "failed" | "cancelled">[];
  /** Remove runs completed before this timestamp. Defaults to now. */
  before?: number;
  /** Maximum runs removed in this transaction. Defaults to 1,000. */
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
  /** Terminal states to remove. Defaults to succeeded and cancelled. */
  states?: readonly Extract<JobState, "succeeded" | "dead" | "cancelled">[];
  /** Remove jobs completed before this epoch millisecond. Defaults to now. */
  before?: number;
  /** Maximum jobs removed in this transaction. Defaults to 1,000. */
  limit?: number;
}

export interface JobRetentionOptions {
  /** Successful-job history retention. Defaults to 7 days. False keeps it indefinitely. */
  succeededMs?: number | false;
  /** Cancelled-job history retention. Defaults to 7 days. False keeps it indefinitely. */
  cancelledMs?: number | false;
  /** Dead-letter retention. Defaults to indefinite. */
  deadMs?: number | false;
  /** Successful workflow history retention. Defaults to 30 days. */
  workflowSucceededMs?: number | false;
  /** Cancelled workflow history retention. Defaults to 7 days. */
  workflowCancelledMs?: number | false;
  /** Failed workflow history retention. Defaults to indefinite. */
  workflowFailedMs?: number | false;
  /** Opportunistic cleanup interval. Defaults to 1 hour. */
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
  /** Parallel handlers inside this worker process. Defaults to 1. */
  concurrency?: number;
  /** Claim only these queues. Defaults to all queues. */
  queues?: readonly string[];
  /** Visibility lease length. Defaults to 30 seconds. */
  leaseMs?: number;
  /** Empty-queue polling interval. Defaults to 500 ms. */
  pollIntervalMs?: number;
  /** Stable process identity used in diagnostics. */
  workerId?: string;
}

export interface JobSchedulerOptions {
  /** Scheduler lease length. Defaults to 30 seconds. */
  leaseMs?: number;
  /** Due-schedule polling interval. Defaults to 1 second. */
  pollIntervalMs?: number;
  /** Maximum schedule claims in one pass. Defaults to 50. */
  batchSize?: number;
  /** Stable process identity used in diagnostics. */
  schedulerId?: string;
}

export interface JobProcessHandle {
  readonly role: "worker" | "scheduler";
  readonly id: string;
  close(): Promise<void>;
}

export type JobProcessRole = "worker" | "scheduler";

export interface RunJobProcessOptions {
  /** Defaults to CLANK_PROCESS_ROLE and must be worker or scheduler. */
  role?: JobProcessRole;
  worker?: JobWorkerOptions;
  scheduler?: JobSchedulerOptions;
  /** Called after the process loop is ready. */
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
  /** Reconcile bounded durable workflow state; workers call this automatically. */
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

interface JobRow extends Record<string, unknown> {
  id: string;
  name: string;
  queue: string;
  state: JobState;
  payload: string;
  result: string | null;
  error: string | null;
  owner_id: string | null;
  priority: number;
  group_key: string | null;
  attempts: number;
  max_attempts: number;
  timeout_ms: number;
  run_at: number;
  scheduled_at: number | null;
  cron_name: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  lease_token: string | null;
  lease_owner: string | null;
  lease_until: number | null;
  cancel_requested: number;
}

interface ClaimedJob {
  row: JobRow;
  token: string;
}

interface ScheduleRow extends Record<string, unknown> {
  name: string;
  job_name: string;
  expression: string;
  timezone: string;
  payload: string;
  concurrency: CronConcurrency;
  starting_deadline_ms: number;
  max_catch_up: number;
  next_run_at: number;
  last_scheduled_at: number | null;
  lease_token: string | null;
  lease_owner: string | null;
  lease_until: number | null;
}

interface WorkflowRow extends Record<string, unknown> {
  id: string;
  name: string;
  definition_hash: string;
  state: WorkflowState;
  input: string;
  output: string | null;
  error: string | null;
  owner_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  cancel_requested: number;
}

interface WorkflowStepRow extends Record<string, unknown> {
  workflow_id: string;
  step_name: string;
  job_name: string;
  needs: string;
  state: WorkflowStepState;
  job_id: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export function openJobs<Definition extends JobSystemDefinition<any, any>>(
  definition: Definition,
  options: OpenJobsOptions & { database: SQLiteDatabase<Definition["schema"]> },
): JobRuntime<Definition> {
  const database = options.database;
  if (database.schema !== definition.schema) {
    throw new TypeError("The job definition and backend must use the same database schema.");
  }
  const internal = database[SQLITE_INTERNAL];
  ensureJobSchema(internal);
  const registry = flattenJobs(definition.jobs);
  const workflowRegistry = flattenWorkflows(definition.workflows ?? {});
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const maxPayloadBytes = integer(options.maxPayloadBytes ?? 256 * 1024, "maxPayloadBytes", 1_024, 4 * 1024 * 1024);
  const maxResultBytes = integer(options.maxResultBytes ?? 256 * 1024, "maxResultBytes", 1_024, 4 * 1024 * 1024);
  const maxErrorBytes = integer(options.maxErrorBytes ?? 16 * 1024, "maxErrorBytes", 256, 256 * 1024);
  const retention = normalizeRetention(options.retention);
  const handles = new Set<{ abort: AbortController; done: Promise<void> }>();
  let lastCleanupAt = now();
  let closed = false;

  const ensureOpen = () => {
    if (closed) throw new Error("Job runtime is closed.");
  };

  const report = (error: unknown, row?: JobRow) => {
    try { options.onError?.(error, row ? storedJob(row) : undefined); } catch { /* Reporting must not change queue state. */ }
  };

  const enqueue = (
    scope: DatabaseScope | undefined,
    job: AnyJobDefinition,
    input: unknown,
    enqueueOptions: EnqueueOptions = {},
    cron?: { name: string; scheduledAt: number },
  ): JobHandle => {
    ensureOpen();
    const name = jobPath(job);
    if (registry.get(name) !== job) throw new TypeError(`Job ${name} does not belong to this runtime.`);
    const args = job.args.parse(input ?? {});
    const payload = boundedJson(args, maxPayloadBytes, "Job arguments");
    if (enqueueOptions.runAt !== undefined && enqueueOptions.delayMs !== undefined) {
      throw new TypeError("enqueue runAt and delayMs are mutually exclusive.");
    }
    const queuedAt = now();
    const runAt = enqueueOptions.runAt === undefined
      ? queuedAt + integer(enqueueOptions.delayMs ?? 0, "job delayMs", 0, 365 * 24 * 60 * 60_000)
      : integer(enqueueOptions.runAt, "job runAt", 0, Number.MAX_SAFE_INTEGER);
    const queue = identifier(enqueueOptions.queue ?? job.queue, "job queue", 128);
    const priority = integer(enqueueOptions.priority ?? job.priority, "job priority", -1_000, 1_000);
    const idempotencyKey = enqueueOptions.idempotencyKey === undefined
      ? cron ? `${cron.name}:${cron.scheduledAt}` : null
      : identifier(enqueueOptions.idempotencyKey, "job idempotencyKey", 512, true);
    const group = enqueueOptions.group === undefined
      ? null
      : identifier(enqueueOptions.group, "job group", 512, true);
    const id = jobId();
    const result = internal.prepare(`INSERT OR IGNORE INTO clank_jobs (
      id, name, queue, state, payload, owner_id, priority, group_key,
      attempts, max_attempts, timeout_ms, run_at, idempotency_key,
      scheduled_at, cron_name, created_at, updated_at, cancel_requested
    ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
      id,
      name,
      queue,
      payload,
      scope?.userId ?? null,
      priority,
      group,
      job.retry.maxAttempts,
      job.timeoutMs,
      runAt,
      idempotencyKey,
      cron?.scheduledAt ?? null,
      cron?.name ?? null,
      queuedAt,
      queuedAt,
    );
    if (Number(result.changes) === 1) {
      event(internal, id, "enqueued", queuedAt, {
        name,
        queue,
        runAt,
        ...(cron ? { cron: cron.name, scheduledAt: cron.scheduledAt } : {}),
      });
      return Object.freeze({ id, deduplicated: false });
    }
    if (idempotencyKey === null) throw new Error("Could not allocate a unique job ID.");
    const existing = internal.prepare(
      "SELECT id FROM clank_jobs WHERE name = ? AND idempotency_key = ?",
    ).get(name, idempotencyKey);
    if (!existing) throw new Error("Job enqueue lost its idempotency record.");
    return Object.freeze({ id: String(existing.id), deduplicated: true });
  };

  const startWorkflow = (
    scope: DatabaseScope | undefined,
    workflow: AnyWorkflowDefinition,
    rawInput: unknown,
    startOptions: WorkflowStartOptions = {},
  ): WorkflowHandle => {
    ensureOpen();
    const name = workflowPath(workflow);
    if (workflowRegistry.get(name) !== workflow) {
      throw new TypeError(`Workflow ${name} does not belong to this runtime.`);
    }
    const input = workflow.args.parse(rawInput ?? {});
    const serializedInput = boundedJson(input, maxPayloadBytes, "Workflow input");
    const idempotencyKey = startOptions.idempotencyKey === undefined
      ? null
      : identifier(startOptions.idempotencyKey, "workflow idempotencyKey", 512, true);
    const ownerId = scope?.userId ?? null;
    const startedAt = now();
    const create = (): WorkflowHandle => {
      const id = workflowId();
      const inserted = internal.prepare(`INSERT OR IGNORE INTO clank_workflow_runs (
        id, name, definition_hash, state, input, output, error, owner_id, idempotency_key,
        created_at, updated_at, completed_at, cancel_requested
      ) VALUES (?, ?, ?, 'running', ?, NULL, NULL, ?, ?, ?, ?, NULL, 0)`).run(
        id,
        name,
        workflowDefinitionRevision(workflow),
        serializedInput,
        ownerId,
        idempotencyKey,
        startedAt,
        startedAt,
      );
      if (Number(inserted.changes) !== 1) {
        if (idempotencyKey === null) throw new Error("Could not allocate a unique workflow ID.");
        const existing = internal.prepare(`SELECT id FROM clank_workflow_runs
          WHERE name = ? AND owner_id IS ? AND idempotency_key = ?`).get(
          name,
          ownerId,
          idempotencyKey,
        );
        if (!existing) throw new Error("Workflow start lost its idempotency record.");
        return Object.freeze({ id: String(existing.id), deduplicated: true });
      }
      const names = workflowStepNames(workflow);
      for (const [stepName, step] of Object.entries(workflow.steps)) {
        internal.prepare(`INSERT INTO clank_workflow_steps (
          workflow_id, step_name, job_name, needs, state, job_id, result, error,
          created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, 'blocked', NULL, NULL, NULL, ?, ?, NULL, NULL)`).run(
          id,
          stepName,
          jobPath(step.job),
          JSON.stringify(step.needs.map((dependency) => names.get(dependency))),
          startedAt,
          startedAt,
        );
      }
      workflowEvent(internal, id, "started", null, startedAt, { name });
      reconcileWorkflowCore(id);
      return Object.freeze({ id, deduplicated: false });
    };
    return internal.inTransaction ? create() : internal.transaction(create);
  };

  const publisher = (scope?: DatabaseScope): JobPublisher<Definition> => Object.freeze({
    enqueue<Job extends JobOfTree<Definition["jobs"]>>(job: Job, args: JobInput<Job>, enqueueOptions?: EnqueueOptions) {
      return enqueue(scope, job, args, enqueueOptions);
    },
    startWorkflow(workflow, input, startOptions) {
      return startWorkflow(scope, workflow, input, startOptions);
    },
  });

  const requestJobCancellation = (jobId: string, requestedAt: number): boolean => {
    const result = internal.prepare(`UPDATE clank_jobs
      SET cancel_requested = 1,
        state = CASE WHEN state IN ('queued', 'retry') THEN 'cancelled' ELSE state END,
        completed_at = CASE WHEN state IN ('queued', 'retry') THEN ? ELSE completed_at END,
        updated_at = ?
      WHERE id = ? AND state IN ('queued', 'retry', 'running') AND cancel_requested = 0`).run(
      requestedAt,
      requestedAt,
      jobId,
    );
    if (Number(result.changes) === 1) event(internal, jobId, "cancel_requested", requestedAt, {});
    return Number(result.changes) === 1;
  };

  const cancelWorkflowChildren = (workflowIdValue: string, requestedAt: number): void => {
    const rows = internal.prepare(`SELECT * FROM clank_workflow_steps
      WHERE workflow_id = ?`).all(workflowIdValue) as WorkflowStepRow[];
    for (const step of rows) {
      if ((step.state === "queued" || step.state === "running") && step.job_id) {
        const job = internal.prepare("SELECT state FROM clank_jobs WHERE id = ?").get(step.job_id);
        requestJobCancellation(step.job_id, requestedAt);
        if (job?.state === "queued" || job?.state === "retry") {
          updateWorkflowStep(internal, step, "cancelled", requestedAt);
        }
      }
      if (step.state === "blocked") updateWorkflowStep(internal, step, "cancelled", requestedAt);
    }
  };

  const reconcileWorkflowCore = (workflowIdValue: string): number => {
    const row = internal.prepare("SELECT * FROM clank_workflow_runs WHERE id = ?").get(
      workflowIdValue,
    ) as WorkflowRow | undefined;
    if (!row || row.state !== "running") return 0;
    const current = now();
    const workflow = workflowRegistry.get(row.name);
    if (!workflow) {
      const message = "Workflow definition is not present in this release.";
      cancelWorkflowChildren(row.id, current);
      internal.prepare(`UPDATE clank_workflow_runs SET state = 'failed', error = ?,
        updated_at = ?, completed_at = ? WHERE id = ? AND state = 'running'`).run(
        message,
        current,
        current,
        row.id,
      );
      workflowEvent(internal, row.id, "failed", null, current, { error: message });
      return 1;
    }
    if (row.definition_hash !== workflowDefinitionRevision(workflow)) {
      const message = "Workflow definition changed before the retained run completed.";
      cancelWorkflowChildren(row.id, current);
      failWorkflowRun(internal, row.id, message, current);
      return 1;
    }
    const definitionEntries = Object.entries(workflow.steps);
    const names = workflowStepNames(workflow);
    const rows = internal.prepare(`SELECT * FROM clank_workflow_steps
      WHERE workflow_id = ? ORDER BY step_name ASC`).all(row.id) as WorkflowStepRow[];
    const byName = new Map(rows.map((step) => [step.step_name, step]));
    if (rows.length !== definitionEntries.length
      || definitionEntries.some(([name, step]) => byName.get(name)?.job_name !== jobPath(step.job))) {
      const message = "Workflow graph does not match the retained run.";
      cancelWorkflowChildren(row.id, current);
      failWorkflowRun(internal, row.id, message, current);
      return 1;
    }
    let changed = 0;
    const cancellationRequested = Number(row.cancel_requested) === 1;

    for (const [stepName] of definitionEntries) {
      const stepRow = byName.get(stepName)!;
      if ((stepRow.state !== "queued" && stepRow.state !== "running") || !stepRow.job_id) continue;
      const job = internal.prepare("SELECT * FROM clank_jobs WHERE id = ?").get(stepRow.job_id) as JobRow | undefined;
      if (!job) {
        updateWorkflowStep(internal, stepRow, "failed", current, {
          error: "Workflow step job was removed before the run completed.",
        });
        changed++;
        continue;
      }
      if (cancellationRequested && (job.state === "queued" || job.state === "retry" || job.state === "running")) {
        if (requestJobCancellation(job.id, current)) changed++;
        if (job.state === "queued" || job.state === "retry") {
          updateWorkflowStep(internal, stepRow, "cancelled", current);
          workflowEvent(internal, row.id, "step_cancelled", stepName, current, { jobId: job.id });
          changed++;
          continue;
        }
      }
      if (job.state === "running" && stepRow.state !== "running") {
        updateWorkflowStep(internal, stepRow, "running", current, {
          startedAt: job.started_at ?? current,
        });
        changed++;
      } else if (job.state === "succeeded") {
        const result = job.result === null ? null : JSON.parse(job.result);
        updateWorkflowStep(internal, stepRow, "succeeded", current, { result });
        workflowEvent(internal, row.id, "step_succeeded", stepName, current, { jobId: job.id });
        changed++;
      } else if (job.state === "dead") {
        updateWorkflowStep(internal, stepRow, "failed", current, {
          error: job.error ?? "Workflow step exhausted its retries.",
        });
        workflowEvent(internal, row.id, "step_failed", stepName, current, { jobId: job.id });
        changed++;
      } else if (job.state === "cancelled") {
        const state = cancellationRequested ? "cancelled" : "failed";
        updateWorkflowStep(internal, stepRow, state, current, {
          ...(state === "failed" ? { error: "Workflow step was cancelled outside its workflow." } : {}),
        });
        workflowEvent(internal, row.id, `step_${state}`, stepName, current, { jobId: job.id });
        changed++;
      }
    }

    const refreshed = () => internal.prepare(`SELECT * FROM clank_workflow_steps
      WHERE workflow_id = ? ORDER BY step_name ASC`).all(row.id) as WorkflowStepRow[];
    let currentRows = refreshed();
    const currentByName = () => new Map(currentRows.map((step) => [step.step_name, step]));

    if (cancellationRequested) {
      for (const stepRow of currentRows) {
        if (stepRow.state === "blocked") {
          updateWorkflowStep(internal, stepRow, "cancelled", current);
          changed++;
        }
      }
      currentRows = refreshed();
      if (currentRows.every((step) => isTerminalWorkflowStep(step.state))) {
        internal.prepare(`UPDATE clank_workflow_runs SET state = 'cancelled', updated_at = ?,
          completed_at = ? WHERE id = ? AND state = 'running'`).run(current, current, row.id);
        workflowEvent(internal, row.id, "cancelled", null, current, {});
        changed++;
      }
      return changed;
    }

    const failed = currentRows.find((step) => step.state === "failed" || step.state === "cancelled");
    if (failed) {
      for (const stepRow of currentRows) {
        if (stepRow.state === "queued" || stepRow.state === "running") {
          if (stepRow.job_id && requestJobCancellation(stepRow.job_id, current)) changed++;
        } else if (stepRow.state === "blocked") {
          updateWorkflowStep(internal, stepRow, "cancelled", current);
          changed++;
        }
      }
      const message = failed.error ?? `Workflow step ${failed.step_name} did not succeed.`;
      failWorkflowRun(internal, row.id, message, current);
      return changed + 1;
    }

    const parsedInput = workflow.args.parse(JSON.parse(row.input));
    for (const [stepName, step] of definitionEntries) {
      const stepRow = currentByName().get(stepName)!;
      if (stepRow.state !== "blocked") continue;
      const dependencyNames = step.needs.map((dependency) => names.get(dependency)!);
      if (!dependencyNames.every((name) => currentByName().get(name)?.state === "succeeded")) continue;
      try {
        const rawArgs = step.args(workflowStepContext(
          parsedInput,
          workflow,
          step,
          currentByName(),
        ));
        const parsedArgs = step.job.args.parse(rawArgs);
        const handle = enqueue(
          row.owner_id === null ? undefined : { userId: row.owner_id },
          step.job,
          parsedArgs,
          { idempotencyKey: `workflow:${row.id}:${stepName}` },
        );
        internal.prepare(`UPDATE clank_workflow_steps SET state = 'queued', job_id = ?,
          updated_at = ? WHERE workflow_id = ? AND step_name = ? AND state = 'blocked'`).run(
          handle.id,
          current,
          row.id,
          stepName,
        );
        workflowEvent(internal, row.id, "step_queued", stepName, current, { jobId: handle.id });
        changed++;
      } catch (error) {
        const message = safeError(error, maxErrorBytes);
        updateWorkflowStep(internal, stepRow, "failed", current, { error: message });
        workflowEvent(internal, row.id, "step_failed", stepName, current, { error: message });
        for (const remaining of refreshed()) {
          if ((remaining.state === "queued" || remaining.state === "running") && remaining.job_id) {
            requestJobCancellation(remaining.job_id, current);
          } else if (remaining.state === "blocked" && remaining.step_name !== stepName) {
            updateWorkflowStep(internal, remaining, "cancelled", current);
          }
        }
        failWorkflowRun(internal, row.id, message, current);
        return changed + 2;
      }
    }

    currentRows = refreshed();
    if (currentRows.every((step) => step.state === "succeeded")) {
      try {
        const context = workflowOutputContext(parsedInput, workflow, new Map(
          currentRows.map((step) => [step.step_name, step]),
        ));
        const rawOutput = workflow.output(context);
        const output = workflow.returns ? workflow.returns.parse(rawOutput) : rawOutput;
        const serialized = boundedJson(output ?? null, maxResultBytes, "Workflow output");
        internal.prepare(`UPDATE clank_workflow_runs SET state = 'succeeded', output = ?,
          error = NULL, updated_at = ?, completed_at = ?
          WHERE id = ? AND state = 'running'`).run(serialized, current, current, row.id);
        workflowEvent(internal, row.id, "succeeded", null, current, {});
        changed++;
      } catch (error) {
        const message = safeError(error, maxErrorBytes);
        failWorkflowRun(internal, row.id, message, current);
        changed++;
      }
    }
    return changed;
  };

  const reconcileWorkflow = (workflowIdValue: string): number =>
    internal.inTransaction
      ? reconcileWorkflowCore(workflowIdValue)
      : internal.transaction(() => reconcileWorkflowCore(workflowIdValue));

  const advanceWorkflows = (advanceOptions: { limit?: number } = {}): number => {
    ensureOpen();
    const limit = integer(advanceOptions.limit ?? 100, "workflow advance limit", 1, 1_000);
    const rows = internal.prepare(`SELECT id FROM clank_workflow_runs
      WHERE state = 'running' ORDER BY updated_at ASC, id ASC LIMIT ?`).all(limit);
    let changed = 0;
    for (const row of rows) changed += reconcileWorkflow(String(row.id));
    return changed;
  };

  const purgeWorkflows = (purgeOptions: WorkflowPurgeOptions = {}): number => {
    ensureOpen();
    const states = purgeOptions.states ?? ["succeeded", "cancelled"];
    if (states.length === 0) return 0;
    const normalizedStates = [...new Set(states.map((state) => {
      if (state !== "succeeded" && state !== "failed" && state !== "cancelled") {
        throw new TypeError(`Only terminal workflows can be purged: ${String(state)}`);
      }
      return state;
    }))];
    const before = integer(purgeOptions.before ?? now(), "workflow purge before", 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(purgeOptions.limit ?? 1_000, "workflow purge limit", 1, 10_000);
    return internal.transaction(() => {
      const rows = internal.prepare(`SELECT id FROM clank_workflow_runs
        WHERE state IN (${normalizedStates.map(() => "?").join(", ")})
          AND completed_at IS NOT NULL AND completed_at < ?
        ORDER BY completed_at ASC, id ASC LIMIT ?`).all(...normalizedStates, before, limit);
      if (rows.length === 0) return 0;
      const ids = rows.map((row) => String(row.id));
      const placeholders = ids.map(() => "?").join(", ");
      internal.prepare(`DELETE FROM clank_workflow_events
        WHERE workflow_id IN (${placeholders})`).run(...ids);
      internal.prepare(`DELETE FROM clank_workflow_steps
        WHERE workflow_id IN (${placeholders})`).run(...ids);
      internal.prepare(`DELETE FROM clank_workflow_runs
        WHERE id IN (${placeholders})`).run(...ids);
      return ids.length;
    });
  };

  const purge = (purgeOptions: JobPurgeOptions = {}): number => {
    ensureOpen();
    const states = purgeOptions.states ?? ["succeeded", "cancelled"];
    if (states.length === 0) return 0;
    const normalizedStates = [...new Set(states.map((state) => {
      if (state !== "succeeded" && state !== "dead" && state !== "cancelled") {
        throw new TypeError(`Only terminal jobs can be purged: ${String(state)}`);
      }
      return state;
    }))];
    const before = integer(purgeOptions.before ?? now(), "job purge before", 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(purgeOptions.limit ?? 1_000, "job purge limit", 1, 10_000);
    return internal.transaction(() => {
      const rows = internal.prepare(`SELECT id FROM clank_jobs
        WHERE state IN (${normalizedStates.map(() => "?").join(", ")})
          AND completed_at IS NOT NULL AND completed_at < ?
        ORDER BY completed_at ASC, id ASC LIMIT ?`).all(
        ...normalizedStates,
        before,
        limit,
      );
      if (rows.length === 0) return 0;
      const ids = rows.map((row) => String(row.id));
      const placeholders = ids.map(() => "?").join(", ");
      internal.prepare(`DELETE FROM clank_job_events WHERE job_id IN (${placeholders})`).run(...ids);
      internal.prepare(`DELETE FROM clank_jobs WHERE id IN (${placeholders})`).run(...ids);
      return ids.length;
    });
  };

  const maybeCleanup = () => {
    const current = now();
    if (current < lastCleanupAt || current - lastCleanupAt < retention.cleanupIntervalMs) return;
    lastCleanupAt = current;
    for (const [state, duration] of [
      ["succeeded", retention.succeededMs],
      ["cancelled", retention.cancelledMs],
      ["dead", retention.deadMs],
    ] as const) {
      if (duration === false) continue;
      // One bounded batch per tick keeps cleanup from delaying normal claims.
      purge({ states: [state], before: Math.max(0, current - duration), limit: 1_000 });
    }
    for (const [state, duration] of [
      ["succeeded", retention.workflowSucceededMs],
      ["cancelled", retention.workflowCancelledMs],
      ["failed", retention.workflowFailedMs],
    ] as const) {
      if (duration === false) continue;
      purgeWorkflows({ states: [state], before: Math.max(0, current - duration), limit: 1_000 });
    }
  };

  const claim = (workerId: string, queues: readonly string[], leaseMs: number): ClaimedJob | null => {
    maybeCleanup();
    return internal.transaction(() => {
      const claimedAt = now();
      reclaimExpired(internal, registry, claimedAt, random, maxErrorBytes);
      const queueClause = queues.length
        ? ` AND queue IN (${queues.map(() => "?").join(", ")})`
        : "";
      const row = internal.prepare(`SELECT * FROM clank_jobs AS candidate
        WHERE state IN ('queued', 'retry')
          AND run_at <= ?
          AND cancel_requested = 0
          ${queueClause}
          AND (
            group_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM clank_jobs AS active
              WHERE active.queue = candidate.queue
                AND active.group_key = candidate.group_key
                AND active.state = 'running'
                AND active.lease_until > ?
            )
          )
        ORDER BY priority DESC, run_at ASC, created_at ASC, id ASC
        LIMIT 1`).get(claimedAt, ...queues, claimedAt) as JobRow | undefined;
      if (!row) return null;
      const token = crypto.randomUUID();
      const updated = internal.prepare(`UPDATE clank_jobs
        SET state = 'running', attempts = attempts + 1, lease_token = ?,
          lease_owner = ?, lease_until = ?, started_at = coalesce(started_at, ?),
          updated_at = ?
        WHERE id = ? AND state IN ('queued', 'retry') AND cancel_requested = 0`).run(
        token,
        workerId,
        claimedAt + leaseMs,
        claimedAt,
        claimedAt,
        row.id,
      );
      if (Number(updated.changes) !== 1) return null;
      const claimed = internal.prepare("SELECT * FROM clank_jobs WHERE id = ?").get(row.id) as JobRow;
      event(internal, row.id, "claimed", claimedAt, {
        workerId,
        attempt: Number(claimed.attempts),
        leaseUntil: claimedAt + leaseMs,
      });
      return { row: claimed, token };
    });
  };

  const workOnce = async (
    workerOptions: Omit<JobWorkerOptions, "concurrency" | "pollIntervalMs"> = {},
  ): Promise<boolean> => {
    ensureOpen();
    const workflowChanges = advanceWorkflows();
    const workerId = identifier(
      workerOptions.workerId ?? `worker-${processId()}-${crypto.randomUUID()}`,
      "workerId",
      256,
      true,
    );
    const queues = workerQueues(workerOptions.queues);
    const leaseMs = integer(workerOptions.leaseMs ?? 30_000, "worker leaseMs", 1_000, 60 * 60_000);
    const claimed = claim(workerId, queues, leaseMs);
    if (!claimed) return workflowChanges > 0;
    await executeClaim(claimed, workerId, leaseMs);
    advanceWorkflows();
    return true;
  };

  const executeClaim = async (claimed: ClaimedJob, workerId: string, leaseMs: number): Promise<void> => {
    const definition = registry.get(claimed.row.name);
    if (!definition) {
      settleFailure(internal, claimed, now(), "Job definition is not present in this release.", 0, true, maxErrorBytes);
      return;
    }
    let input: unknown;
    try {
      input = definition.args.parse(JSON.parse(claimed.row.payload));
    } catch (error) {
      settleFailure(internal, claimed, now(), safeError(error, maxErrorBytes), 0, true, maxErrorBytes);
      return;
    }
    const controller = new AbortController();
    const heartbeatMs = Math.max(250, Math.floor(leaseMs / 3));
    let stale = false;
    const heartbeat = setInterval(() => {
      try {
        const renewedAt = now();
        const renewed = internal.prepare(`UPDATE clank_jobs
          SET lease_until = ?, updated_at = ?
          WHERE id = ? AND state = 'running' AND lease_token = ?
            AND lease_owner = ? AND cancel_requested = 0`).run(
          renewedAt + leaseMs,
          renewedAt,
          claimed.row.id,
          claimed.token,
          workerId,
        );
        if (Number(renewed.changes) !== 1) {
          stale = true;
          controller.abort(new Error("Job lease was lost or cancellation was requested."));
        }
      } catch (error) {
        stale = true;
        controller.abort(error);
      }
    }, heartbeatMs);
    (heartbeat as any).unref?.();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Job exceeded its ${definition.timeoutMs}ms timeout.`));
    }, definition.timeoutMs);
    (timeout as any).unref?.();
    const scope = claimed.row.owner_id === null ? undefined : { userId: claimed.row.owner_id };
    const scopedPublisher = publisher(scope);
    const context: JobHandlerContext<any, any> = Object.freeze({
      db: Object.freeze({
        read<Value>(handler: (db: ReadDatabase<any>) => Value): Value {
          return database.read(handler, scope);
        },
        transaction<Value>(handler: (db: WriteDatabase<any>) => Value): Value {
          return database.transaction(handler, scope);
        },
      }),
      job: jobMetadata(claimed.row),
      signal: controller.signal,
      jobs: scopedPublisher,
    });
    try {
      const output = await Promise.race([
        Promise.resolve(definition.handler(context, input)),
        aborted(controller.signal),
      ]);
      if (stale) return;
      const parsed = definition.returns ? definition.returns.parse(output) : output;
      const result = boundedJson(parsed ?? null, maxResultBytes, "Job result");
      const completedAt = now();
      const settled = internal.prepare(`UPDATE clank_jobs
        SET state = 'succeeded', result = ?, error = NULL, completed_at = ?,
          updated_at = ?, lease_token = NULL, lease_owner = NULL, lease_until = NULL
        WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_owner = ?
          AND cancel_requested = 0`).run(
        result,
        completedAt,
        completedAt,
        claimed.row.id,
        claimed.token,
        workerId,
      );
      if (Number(settled.changes) === 1) {
        event(internal, claimed.row.id, "succeeded", completedAt, {
          workerId,
          attempt: Number(claimed.row.attempts),
        });
      } else {
        const cancelled = Number(internal.prepare(
          "SELECT cancel_requested FROM clank_jobs WHERE id = ?",
        ).get(claimed.row.id)?.cancel_requested ?? 0) === 1;
        if (cancelled) settleCancelled(internal, claimed, completedAt, workerId);
      }
    } catch (error) {
      const failedAt = now();
      const cancelled = Number(internal.prepare(
        "SELECT cancel_requested FROM clank_jobs WHERE id = ?",
      ).get(claimed.row.id)?.cancel_requested ?? 0) === 1;
      if (cancelled) {
        settleCancelled(internal, claimed, failedAt, workerId);
      } else if (!stale) {
        const delay = retryDelay(definition.retry, Number(claimed.row.attempts), random);
        settleFailure(
          internal,
          claimed,
          failedAt,
          safeError(error, maxErrorBytes),
          delay,
          false,
          maxErrorBytes,
          workerId,
        );
        report(error, claimed.row);
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }
  };

  const scheduleOnce = async (
    schedulerOptions: Omit<JobSchedulerOptions, "pollIntervalMs"> = {},
  ): Promise<number> => {
    ensureOpen();
    maybeCleanup();
    syncSchedules(internal, registry, now());
    const schedulerId = identifier(
      schedulerOptions.schedulerId ?? `scheduler-${processId()}-${crypto.randomUUID()}`,
      "schedulerId",
      256,
      true,
    );
    const leaseMs = integer(schedulerOptions.leaseMs ?? 30_000, "scheduler leaseMs", 1_000, 10 * 60_000);
    const batchSize = integer(schedulerOptions.batchSize ?? 50, "scheduler batchSize", 1, 1_000);
    let created = 0;
    for (let index = 0; index < batchSize; index++) {
      const claimed = claimSchedule(internal, schedulerId, now(), leaseMs);
      if (!claimed) break;
      try {
        created += processSchedule(internal, registry, claimed, now(), enqueue);
      } catch (error) {
        report(error);
        releaseSchedule(internal, claimed, now(), safeError(error, maxErrorBytes));
      }
    }
    return created;
  };

  const startLoop = (
    role: "worker" | "scheduler",
    id: string,
    concurrency: number,
    pollIntervalMs: number,
    tick: () => Promise<boolean>,
  ): JobProcessHandle => {
    ensureOpen();
    const abort = new AbortController();
    const loops = Array.from({ length: concurrency }, async () => {
      while (!abort.signal.aborted) {
        let progressed = false;
        try {
          progressed = await tick();
        } catch (error) {
          report(error);
        }
        if (!progressed && !abort.signal.aborted) {
          await delay(pollIntervalMs, abort.signal);
        }
      }
    });
    const done = Promise.allSettled(loops).then(() => undefined);
    const tracked = { abort, done };
    handles.add(tracked);
    void done.finally(() => handles.delete(tracked));
    return Object.freeze({
      role,
      id,
      async close() {
        abort.abort();
        await done;
      },
    });
  };

  syncSchedules(internal, registry, now());

  const runtime: JobRuntime<Definition> = {
    definition,
    database,
    enqueue(job, args, enqueueOptions) {
      return enqueue(undefined, job, args, enqueueOptions);
    },
    startWorkflow(workflow, input, startOptions) {
      return startWorkflow(undefined, workflow, input, startOptions);
    },
    publisher,
    get(id) {
      ensureOpen();
      const row = internal.prepare("SELECT * FROM clank_jobs WHERE id = ?").get(
        identifier(id, "job id", 128, true),
      ) as JobRow | undefined;
      return row ? storedJob(row) : null;
    },
    list(listOptions = {}) {
      ensureOpen();
      const clauses: string[] = [];
      const values: unknown[] = [];
      if (listOptions.state !== undefined) {
        if (!JOB_STATES.has(listOptions.state)) throw new TypeError(`Invalid job state: ${listOptions.state}`);
        clauses.push("state = ?");
        values.push(listOptions.state);
      }
      if (listOptions.queue !== undefined) {
        clauses.push("queue = ?");
        values.push(identifier(listOptions.queue, "job queue", 128));
      }
      if (listOptions.name !== undefined) {
        clauses.push("name = ?");
        values.push(identifier(listOptions.name, "job name", 512, true));
      }
      const limit = integer(listOptions.limit ?? 100, "job list limit", 1, 1_000);
      return (internal.prepare(`SELECT * FROM clank_jobs
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`).all(...values, limit) as JobRow[]).map(storedJob);
    },
    events(id, eventOptions = {}) {
      ensureOpen();
      const jobId = identifier(id, "job id", 128, true);
      const limit = integer(eventOptions.limit ?? 100, "job event limit", 1, 1_000);
      return internal.prepare(`SELECT id, job_id, event, details, created_at
        FROM clank_job_events WHERE job_id = ?
        ORDER BY id DESC LIMIT ?`).all(jobId, limit).map((row) => Object.freeze({
          id: Number(row.id),
          jobId: String(row.job_id),
          event: String(row.event),
          details: Object.freeze(JSON.parse(String(row.details)) as Record<string, unknown>),
          createdAt: Number(row.created_at),
        }));
    },
    getWorkflow(id) {
      ensureOpen();
      const workflowIdValue = identifier(id, "workflow id", 128, true);
      const row = internal.prepare("SELECT * FROM clank_workflow_runs WHERE id = ?").get(
        workflowIdValue,
      ) as WorkflowRow | undefined;
      return row ? storedWorkflow(internal, row) : null;
    },
    listWorkflows(listOptions = {}) {
      ensureOpen();
      const clauses: string[] = [];
      const values: unknown[] = [];
      if (listOptions.state !== undefined) {
        if (!WORKFLOW_STATES.has(listOptions.state)) {
          throw new TypeError(`Invalid workflow state: ${listOptions.state}`);
        }
        clauses.push("state = ?");
        values.push(listOptions.state);
      }
      if (listOptions.name !== undefined) {
        clauses.push("name = ?");
        values.push(identifier(listOptions.name, "workflow name", 512, true));
      }
      const limit = integer(listOptions.limit ?? 100, "workflow list limit", 1, 1_000);
      return (internal.prepare(`SELECT * FROM clank_workflow_runs
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`).all(...values, limit) as WorkflowRow[])
        .map((entry) => storedWorkflow(internal, entry));
    },
    workflowEvents(id, eventOptions = {}) {
      ensureOpen();
      const workflowIdValue = identifier(id, "workflow id", 128, true);
      const limit = integer(eventOptions.limit ?? 100, "workflow event limit", 1, 1_000);
      return internal.prepare(`SELECT id, workflow_id, event, step_name, details, created_at
        FROM clank_workflow_events WHERE workflow_id = ?
        ORDER BY id DESC LIMIT ?`).all(workflowIdValue, limit).map((entry) => Object.freeze({
          id: Number(entry.id),
          workflowId: String(entry.workflow_id),
          event: String(entry.event),
          step: entry.step_name === null ? null : String(entry.step_name),
          details: Object.freeze(JSON.parse(String(entry.details)) as Record<string, unknown>),
          createdAt: Number(entry.created_at),
        }));
    },
    cancelWorkflow(id) {
      ensureOpen();
      const workflowIdValue = identifier(id, "workflow id", 128, true);
      const cancelledAt = now();
      const changed = internal.transaction(() => {
        const result = internal.prepare(`UPDATE clank_workflow_runs
          SET cancel_requested = 1, updated_at = ?
          WHERE id = ? AND state = 'running' AND cancel_requested = 0`).run(
          cancelledAt,
          workflowIdValue,
        );
        if (Number(result.changes) === 1) {
          workflowEvent(internal, workflowIdValue, "cancel_requested", null, cancelledAt, {});
          reconcileWorkflow(workflowIdValue);
        }
        return Number(result.changes) === 1;
      });
      return changed;
    },
    purgeWorkflows,
    advanceWorkflows,
    stats() {
      ensureOpen();
      const current = now();
      const rows = internal.prepare(
        "SELECT state, count(*) AS count FROM clank_jobs GROUP BY state",
      ).all();
      const counts = Object.fromEntries(rows.map((row) => [String(row.state), Number(row.count)]));
      const due = internal.prepare(`SELECT count(*) AS count, min(run_at) AS oldest
        FROM clank_jobs WHERE state IN ('queued', 'retry') AND run_at <= ?`).get(current);
      return Object.freeze({
        queued: counts.queued ?? 0,
        running: counts.running ?? 0,
        retry: counts.retry ?? 0,
        succeeded: counts.succeeded ?? 0,
        dead: counts.dead ?? 0,
        cancelled: counts.cancelled ?? 0,
        due: Number(due?.count ?? 0),
        oldestDueAt: due?.oldest === null || due?.oldest === undefined ? null : Number(due.oldest),
      });
    },
    cancel(id) {
      ensureOpen();
      const cancelledAt = now();
      return internal.transaction(() => {
        return requestJobCancellation(identifier(id, "job id", 128, true), cancelledAt);
      });
    },
    retry(id, retryOptions = {}) {
      ensureOpen();
      const retriedAt = now();
      const runAt = integer(retryOptions.runAt ?? retriedAt, "job retry runAt", 0, Number.MAX_SAFE_INTEGER);
      return internal.transaction(() => {
        const result = internal.prepare(`UPDATE clank_jobs
          SET state = 'queued', attempts = 0, run_at = ?, result = NULL, error = NULL,
            completed_at = NULL, lease_token = NULL, lease_owner = NULL, lease_until = NULL,
            cancel_requested = 0, updated_at = ?
          WHERE id = ? AND state IN ('dead', 'cancelled')`).run(
          runAt,
          retriedAt,
          identifier(id, "job id", 128, true),
        );
        if (Number(result.changes) === 1) event(internal, id, "retried", retriedAt, { runAt });
        return Number(result.changes) === 1;
      });
    },
    purge,
    workOnce,
    scheduleOnce,
    startWorker(workerOptions = {}) {
      const workerId = identifier(
        workerOptions.workerId ?? `worker-${processId()}-${crypto.randomUUID()}`,
        "workerId",
        256,
        true,
      );
      const concurrency = integer(workerOptions.concurrency ?? 1, "worker concurrency", 1, 64);
      const pollIntervalMs = integer(workerOptions.pollIntervalMs ?? 500, "worker pollIntervalMs", 10, 60_000);
      const queues = workerQueues(workerOptions.queues);
      const leaseMs = integer(workerOptions.leaseMs ?? 30_000, "worker leaseMs", 1_000, 60 * 60_000);
      return startLoop("worker", workerId, concurrency, pollIntervalMs, async () => {
        const workflowChanges = advanceWorkflows();
        const claimed = claim(workerId, queues, leaseMs);
        if (!claimed) return workflowChanges > 0;
        await executeClaim(claimed, workerId, leaseMs);
        advanceWorkflows();
        return true;
      });
    },
    startScheduler(schedulerOptions = {}) {
      const schedulerId = identifier(
        schedulerOptions.schedulerId ?? `scheduler-${processId()}-${crypto.randomUUID()}`,
        "schedulerId",
        256,
        true,
      );
      const pollIntervalMs = integer(schedulerOptions.pollIntervalMs ?? 1_000, "scheduler pollIntervalMs", 50, 60_000);
      return startLoop("scheduler", schedulerId, 1, pollIntervalMs, async () =>
        (await scheduleOnce({ ...schedulerOptions, schedulerId })) > 0);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const handle of handles) handle.abort.abort();
      handles.clear();
    },
  };
  return runtime;
}

/**
 * Runs one long-lived provider-neutral job process until SIGTERM or SIGINT.
 *
 * Cloud providers only need to run the same compiled entry with
 * CLANK_PROCESS_ROLE=worker or CLANK_PROCESS_ROLE=scheduler.
 */
export async function runJobProcess(
  runtime: JobRuntime<any>,
  options: RunJobProcessOptions = {},
): Promise<void> {
  const processObject = (globalThis as any).process;
  const role = options.role ?? processObject?.env?.CLANK_PROCESS_ROLE;
  if (role !== "worker" && role !== "scheduler") {
    throw new TypeError("Job process role must be worker or scheduler.");
  }
  const handle = role === "worker"
    ? runtime.startWorker({
        ...options.worker,
        concurrency: environmentInteger(
          processObject?.env?.CLANK_WORKER_CONCURRENCY,
          options.worker?.concurrency,
          "CLANK_WORKER_CONCURRENCY",
          1,
          64,
        ),
        queues: options.worker?.queues
          ?? environmentList(processObject?.env?.CLANK_WORKER_QUEUES, "CLANK_WORKER_QUEUES"),
      })
    : runtime.startScheduler(options.scheduler);
  options.onReady?.(role, handle.id);
  await new Promise<void>((resolve) => {
    let finished = false;
    const stop = () => {
      if (finished) return;
      finished = true;
      processObject?.removeListener?.("SIGTERM", stop);
      processObject?.removeListener?.("SIGINT", stop);
      resolve();
    };
    processObject?.once?.("SIGTERM", stop);
    processObject?.once?.("SIGINT", stop);
  });
  await handle.close();
}

const JOB_STATES = new Set<JobState>(["queued", "running", "retry", "succeeded", "dead", "cancelled"]);
const WORKFLOW_STATES = new Set<WorkflowState>(["running", "succeeded", "failed", "cancelled"]);

function ensureJobSchema(internal: SQLiteInternal): void {
  migrateLegacyServiceJobs(internal);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 512),
    queue TEXT NOT NULL CHECK (length(queue) BETWEEN 1 AND 128),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'retry', 'succeeded', 'dead', 'cancelled')),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    result TEXT CHECK (result IS NULL OR json_valid(result)),
    error TEXT,
    owner_id TEXT,
    priority INTEGER NOT NULL,
    group_key TEXT,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
    timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 100 AND 86400000),
    run_at INTEGER NOT NULL,
    idempotency_key TEXT,
    scheduled_at INTEGER,
    cron_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    lease_token TEXT,
    lease_owner TEXT,
    lease_until INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1))
  )`);
  internal.exec(`CREATE UNIQUE INDEX IF NOT EXISTS clank_jobs_idempotency
    ON clank_jobs (name, idempotency_key) WHERE idempotency_key IS NOT NULL`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_jobs_claim
    ON clank_jobs (state, run_at, priority DESC, created_at)`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_jobs_groups
    ON clank_jobs (queue, group_key, state, lease_until) WHERE group_key IS NOT NULL`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_jobs_cron_active
    ON clank_jobs (cron_name, state) WHERE cron_name IS NOT NULL`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    event TEXT NOT NULL,
    details TEXT NOT NULL CHECK (json_valid(details)),
    created_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_job_events_job
    ON clank_job_events (job_id, id)`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_job_schedules (
    name TEXT PRIMARY KEY,
    job_name TEXT NOT NULL,
    expression TEXT NOT NULL,
    timezone TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    concurrency TEXT NOT NULL CHECK (concurrency IN ('allow', 'forbid', 'replace')),
    starting_deadline_ms INTEGER NOT NULL,
    max_catch_up INTEGER NOT NULL,
    definition_hash TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    next_run_at INTEGER NOT NULL,
    last_scheduled_at INTEGER,
    last_error TEXT,
    lease_token TEXT,
    lease_owner TEXT,
    lease_until INTEGER,
    updated_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_job_schedules_due
    ON clank_job_schedules (enabled, next_run_at, lease_until)`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_workflow_runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 512),
    definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 16),
    state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled')),
    input TEXT NOT NULL CHECK (json_valid(input)),
    output TEXT CHECK (output IS NULL OR json_valid(output)),
    error TEXT,
    owner_id TEXT,
    idempotency_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1))
  )`);
  internal.exec(`CREATE UNIQUE INDEX IF NOT EXISTS clank_workflow_runs_idempotency
    ON clank_workflow_runs (name, coalesce(owner_id, ''), idempotency_key)
    WHERE idempotency_key IS NOT NULL`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_workflow_runs_active
    ON clank_workflow_runs (state, updated_at, id)`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_workflow_steps (
    workflow_id TEXT NOT NULL,
    step_name TEXT NOT NULL CHECK (length(step_name) BETWEEN 1 AND 128),
    job_name TEXT NOT NULL CHECK (length(job_name) BETWEEN 1 AND 512),
    needs TEXT NOT NULL CHECK (json_valid(needs)),
    state TEXT NOT NULL CHECK (state IN ('blocked', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
    job_id TEXT,
    result TEXT CHECK (result IS NULL OR json_valid(result)),
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    PRIMARY KEY (workflow_id, step_name)
  ) WITHOUT ROWID`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_workflow_steps_job
    ON clank_workflow_steps (job_id) WHERE job_id IS NOT NULL`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    event TEXT NOT NULL,
    step_name TEXT,
    details TEXT NOT NULL CHECK (json_valid(details)),
    created_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_workflow_events_run
    ON clank_workflow_events (workflow_id, id)`);
}

function migrateLegacyServiceJobs(internal: SQLiteInternal): void {
  const existing = internal.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clank_jobs'",
  ).get();
  if (!existing) return;
  const columns = new Set(
    internal.prepare("PRAGMA table_info(clank_jobs)").all().map((column) => String(column.name)),
  );
  if (!columns.has("type") || columns.has("name")) return;
  const target = internal.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clank_service_jobs'",
  ).get();
  if (target) {
    throw new Error("Both legacy and current service job tables exist; migrate them before startup.");
  }
  internal.exec("ALTER TABLE clank_jobs RENAME TO clank_service_jobs");
}

function syncSchedules(
  internal: SQLiteInternal,
  registry: ReadonlyMap<string, AnyJobDefinition>,
  current: number,
): void {
  const present = new Set<string>();
  internal.transaction(() => {
    for (const [jobName, job] of registry) {
      for (const schedule of job.schedules) {
        const name = `${jobName}:${schedule.name}`;
        present.add(name);
        const payload = JSON.stringify(schedule.args);
        const hash = scheduleHash(jobName, schedule, payload);
        const existing = internal.prepare(
          "SELECT definition_hash, next_run_at FROM clank_job_schedules WHERE name = ?",
        ).get(name);
        const next = !existing || String(existing.definition_hash) !== hash
          ? nextCronOccurrence(schedule.cron, current, schedule.timezone)
          : Number(existing.next_run_at);
        internal.prepare(`INSERT INTO clank_job_schedules (
          name, job_name, expression, timezone, payload, concurrency,
          starting_deadline_ms, max_catch_up, definition_hash, enabled,
          next_run_at, last_scheduled_at, last_error, lease_token, lease_owner,
          lease_until, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)
        ON CONFLICT(name) DO UPDATE SET
          job_name = excluded.job_name,
          expression = excluded.expression,
          timezone = excluded.timezone,
          payload = excluded.payload,
          concurrency = excluded.concurrency,
          starting_deadline_ms = excluded.starting_deadline_ms,
          max_catch_up = excluded.max_catch_up,
          enabled = excluded.enabled,
          next_run_at = CASE
            WHEN clank_job_schedules.definition_hash = excluded.definition_hash
              THEN clank_job_schedules.next_run_at
            ELSE excluded.next_run_at
          END,
          definition_hash = excluded.definition_hash,
          lease_token = CASE
            WHEN clank_job_schedules.definition_hash = excluded.definition_hash
              THEN clank_job_schedules.lease_token
            ELSE NULL
          END,
          lease_owner = CASE
            WHEN clank_job_schedules.definition_hash = excluded.definition_hash
              THEN clank_job_schedules.lease_owner
            ELSE NULL
          END,
          lease_until = CASE
            WHEN clank_job_schedules.definition_hash = excluded.definition_hash
              THEN clank_job_schedules.lease_until
            ELSE NULL
          END,
          last_error = CASE
            WHEN clank_job_schedules.definition_hash = excluded.definition_hash
              THEN clank_job_schedules.last_error
            ELSE NULL
          END,
          updated_at = excluded.updated_at`).run(
          name,
          jobName,
          schedule.cron,
          schedule.timezone,
          payload,
          schedule.concurrency,
          schedule.startingDeadlineMs,
          schedule.maxCatchUp,
          hash,
          schedule.suspended ? 0 : 1,
          next,
          current,
        );
      }
    }
    if (present.size === 0) {
      internal.prepare("UPDATE clank_job_schedules SET enabled = 0, updated_at = ?").run(current);
    } else {
      const parameters = [...present];
      internal.prepare(`UPDATE clank_job_schedules SET enabled = 0, updated_at = ?
        WHERE name NOT IN (${parameters.map(() => "?").join(", ")})`).run(current, ...parameters);
    }
  });
}

function claimSchedule(
  internal: SQLiteInternal,
  schedulerId: string,
  current: number,
  leaseMs: number,
): { row: ScheduleRow; token: string } | null {
  return internal.transaction(() => {
    const row = internal.prepare(`SELECT * FROM clank_job_schedules
      WHERE enabled = 1 AND next_run_at <= ?
        AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY next_run_at ASC, name ASC LIMIT 1`).get(current, current) as ScheduleRow | undefined;
    if (!row) return null;
    const token = crypto.randomUUID();
    const result = internal.prepare(`UPDATE clank_job_schedules
      SET lease_token = ?, lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE name = ? AND enabled = 1 AND next_run_at = ?
        AND (lease_until IS NULL OR lease_until <= ?)`).run(
      token,
      schedulerId,
      current + leaseMs,
      current,
      row.name,
      row.next_run_at,
      current,
    );
    if (Number(result.changes) !== 1) return null;
    return {
      row: internal.prepare("SELECT * FROM clank_job_schedules WHERE name = ?").get(row.name) as ScheduleRow,
      token,
    };
  });
}

function processSchedule(
  internal: SQLiteInternal,
  registry: ReadonlyMap<string, AnyJobDefinition>,
  claim: { row: ScheduleRow; token: string },
  current: number,
  enqueue: (
    scope: DatabaseScope | undefined,
    job: AnyJobDefinition,
    input: unknown,
    options: EnqueueOptions,
    cron: { name: string; scheduledAt: number },
  ) => JobHandle,
): number {
  const job = registry.get(claim.row.job_name);
  if (!job) {
    releaseSchedule(internal, claim, current, "Scheduled job definition is not present in this release.");
    return 0;
  }
  let occurrence = Number(claim.row.next_run_at);
  let considered = 0;
  let created = 0;
  let lastScheduled = claim.row.last_scheduled_at === null ? null : Number(claim.row.last_scheduled_at);
  while (occurrence <= current && considered < Number(claim.row.max_catch_up)) {
    considered++;
    const lateBy = current - occurrence;
    if (lateBy <= Number(claim.row.starting_deadline_ms)) {
      const active = Number(internal.prepare(`SELECT count(*) AS count FROM clank_jobs
        WHERE cron_name = ? AND state IN ('queued', 'retry', 'running')`).get(claim.row.name)?.count ?? 0);
      if (claim.row.concurrency === "replace" && active > 0) {
        internal.prepare(`UPDATE clank_jobs
          SET cancel_requested = 1,
            state = CASE WHEN state IN ('queued', 'retry') THEN 'cancelled' ELSE state END,
            completed_at = CASE WHEN state IN ('queued', 'retry') THEN ? ELSE completed_at END,
            updated_at = ?
          WHERE cron_name = ? AND state IN ('queued', 'retry', 'running')`).run(
          current,
          current,
          claim.row.name,
        );
      }
      if (claim.row.concurrency === "allow" || active === 0 || claim.row.concurrency === "replace") {
        const result = enqueue(
          undefined,
          job,
          JSON.parse(claim.row.payload),
          {},
          { name: claim.row.name, scheduledAt: occurrence },
        );
        if (!result.deduplicated) created++;
      }
      lastScheduled = occurrence;
    }
    occurrence = nextCronOccurrence(claim.row.expression, occurrence, claim.row.timezone);
  }
  // Bound catch-up even when the configured deadline is large. Skipped
  // occurrences are intentionally advanced so one stale schedule cannot starve
  // every other schedule forever.
  if (occurrence <= current) {
    occurrence = nextCronOccurrence(claim.row.expression, current, claim.row.timezone);
  }
  const result = internal.prepare(`UPDATE clank_job_schedules
    SET next_run_at = ?, last_scheduled_at = ?, last_error = NULL,
      lease_token = NULL, lease_owner = NULL, lease_until = NULL, updated_at = ?
    WHERE name = ? AND lease_token = ?`).run(
    occurrence,
    lastScheduled,
    current,
    claim.row.name,
    claim.token,
  );
  if (Number(result.changes) !== 1) throw new Error("Schedule lease was lost before completion.");
  return created;
}

function releaseSchedule(
  internal: SQLiteInternal,
  claim: { row: ScheduleRow; token: string },
  current: number,
  error: string,
): void {
  internal.prepare(`UPDATE clank_job_schedules
    SET last_error = ?, lease_token = NULL, lease_owner = NULL,
      lease_until = NULL, updated_at = ?
    WHERE name = ? AND lease_token = ?`).run(
    error,
    current,
    claim.row.name,
    claim.token,
  );
}

function reclaimExpired(
  internal: SQLiteInternal,
  registry: ReadonlyMap<string, AnyJobDefinition>,
  current: number,
  random: () => number,
  maxErrorBytes: number,
): void {
  const rows = internal.prepare(`SELECT * FROM clank_jobs
    WHERE state = 'running' AND lease_until <= ?
    ORDER BY lease_until ASC LIMIT 100`).all(current) as JobRow[];
  for (const row of rows) {
    const definition = registry.get(row.name);
    const cancelled = Number(row.cancel_requested) === 1;
    const exhausted = Number(row.attempts) >= Number(row.max_attempts) || !definition;
    const retryAt = exhausted
      ? current
      : current + retryDelay(definition.retry, Number(row.attempts), random);
    const error = safeError(
      new Error("The worker lease expired before the job settled."),
      maxErrorBytes,
    );
    const result = internal.prepare(`UPDATE clank_jobs
      SET state = ?, run_at = ?, error = ?, completed_at = ?,
        lease_token = NULL, lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_until <= ?`).run(
      cancelled ? "cancelled" : exhausted ? "dead" : "retry",
      retryAt,
      error,
      cancelled || exhausted ? current : null,
      current,
      row.id,
      row.lease_token,
      current,
    );
    if (Number(result.changes) === 1) {
      event(internal, row.id, cancelled ? "cancelled" : exhausted ? "dead" : "lease_expired", current, {
        attempt: Number(row.attempts),
        ...(cancelled || exhausted ? {} : { retryAt }),
      });
    }
  }
}

function settleFailure(
  internal: SQLiteInternal,
  claimed: ClaimedJob,
  failedAt: number,
  rawError: string,
  retryMs: number,
  forceDead: boolean,
  maxErrorBytes: number,
  workerId?: string,
): void {
  const exhausted = forceDead || Number(claimed.row.attempts) >= Number(claimed.row.max_attempts);
  const error = rawError.slice(0, maxErrorBytes);
  const retryAt = failedAt + Math.max(0, retryMs);
  const result = internal.prepare(`UPDATE clank_jobs
    SET state = ?, run_at = ?, error = ?, completed_at = ?,
      updated_at = ?, lease_token = NULL, lease_owner = NULL, lease_until = NULL
    WHERE id = ? AND state = 'running' AND lease_token = ?`).run(
    exhausted ? "dead" : "retry",
    retryAt,
    error,
    exhausted ? failedAt : null,
    failedAt,
    claimed.row.id,
    claimed.token,
  );
  if (Number(result.changes) === 1) {
    event(internal, claimed.row.id, exhausted ? "dead" : "failed", failedAt, {
      attempt: Number(claimed.row.attempts),
      ...(workerId ? { workerId } : {}),
      ...(exhausted ? {} : { retryAt }),
      error,
    });
  }
}

function settleCancelled(
  internal: SQLiteInternal,
  claimed: ClaimedJob,
  cancelledAt: number,
  workerId: string,
): void {
  const result = internal.prepare(`UPDATE clank_jobs
    SET state = 'cancelled', completed_at = ?, updated_at = ?,
      lease_token = NULL, lease_owner = NULL, lease_until = NULL
    WHERE id = ? AND state = 'running' AND lease_token = ?`).run(
    cancelledAt,
    cancelledAt,
    claimed.row.id,
    claimed.token,
  );
  if (Number(result.changes) === 1) {
    event(internal, claimed.row.id, "cancelled", cancelledAt, { workerId });
  }
}

function event(
  internal: SQLiteInternal,
  jobId: string,
  name: string,
  createdAt: number,
  details: Record<string, unknown>,
): void {
  internal.prepare(
    "INSERT INTO clank_job_events (job_id, event, details, created_at) VALUES (?, ?, ?, ?)",
  ).run(jobId, name, JSON.stringify(details), createdAt);
  internal.prepare(`DELETE FROM clank_job_events WHERE id <= (
    SELECT max(id) - 100000 FROM clank_job_events
  )`).run();
}

function storedJob(row: JobRow): StoredJob {
  return Object.freeze({
    id: String(row.id),
    name: String(row.name),
    queue: String(row.queue),
    state: String(row.state) as JobState,
    args: JSON.parse(String(row.payload)),
    ...(row.result === null || row.result === undefined ? {} : { result: JSON.parse(String(row.result)) }),
    ...(row.error === null || row.error === undefined ? {} : { error: String(row.error) }),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    priority: Number(row.priority),
    group: row.group_key === null || row.group_key === undefined ? null : String(row.group_key),
    attempt: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    runAt: Number(row.run_at),
    scheduledAt: row.scheduled_at === null || row.scheduled_at === undefined ? null : Number(row.scheduled_at),
    cron: row.cron_name === null || row.cron_name === undefined ? null : String(row.cron_name),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
    leaseOwner: row.lease_owner === null || row.lease_owner === undefined ? null : String(row.lease_owner),
    leaseUntil: row.lease_until === null || row.lease_until === undefined ? null : Number(row.lease_until),
    cancelRequested: Number(row.cancel_requested) === 1,
  });
}

function storedWorkflow(internal: SQLiteInternal, row: WorkflowRow): StoredWorkflowRun {
  const steps = internal.prepare(`SELECT * FROM clank_workflow_steps
    WHERE workflow_id = ? ORDER BY step_name ASC`).all(row.id) as WorkflowStepRow[];
  return Object.freeze({
    id: String(row.id),
    name: String(row.name),
    state: String(row.state) as WorkflowState,
    input: JSON.parse(String(row.input)),
    ...(row.output === null || row.output === undefined ? {} : { output: JSON.parse(String(row.output)) }),
    ...(row.error === null || row.error === undefined ? {} : { error: String(row.error) }),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
    cancelRequested: Number(row.cancel_requested) === 1,
    steps: Object.freeze(steps.map((step) => Object.freeze({
      name: String(step.step_name),
      job: String(step.job_name),
      needs: Object.freeze(JSON.parse(String(step.needs)) as string[]),
      state: String(step.state) as WorkflowStepState,
      jobId: step.job_id === null || step.job_id === undefined ? null : String(step.job_id),
      ...(step.result === null || step.result === undefined ? {} : { result: JSON.parse(String(step.result)) }),
      ...(step.error === null || step.error === undefined ? {} : { error: String(step.error) }),
      createdAt: Number(step.created_at),
      updatedAt: Number(step.updated_at),
      startedAt: step.started_at === null || step.started_at === undefined ? null : Number(step.started_at),
      completedAt: step.completed_at === null || step.completed_at === undefined ? null : Number(step.completed_at),
    }))),
  });
}

function updateWorkflowStep(
  internal: SQLiteInternal,
  row: WorkflowStepRow,
  state: WorkflowStepState,
  updatedAt: number,
  options: { result?: unknown; error?: string; startedAt?: number } = {},
): void {
  const terminal = isTerminalWorkflowStep(state);
  internal.prepare(`UPDATE clank_workflow_steps SET state = ?, result = ?, error = ?,
    started_at = coalesce(started_at, ?), completed_at = ?, updated_at = ?
    WHERE workflow_id = ? AND step_name = ?`).run(
    state,
    Object.hasOwn(options, "result") ? JSON.stringify(options.result ?? null) : row.result,
    options.error ?? null,
    options.startedAt ?? (state === "running" ? updatedAt : null),
    terminal ? updatedAt : null,
    updatedAt,
    row.workflow_id,
    row.step_name,
  );
}

function failWorkflowRun(
  internal: SQLiteInternal,
  workflowIdValue: string,
  error: string,
  failedAt: number,
): void {
  const result = internal.prepare(`UPDATE clank_workflow_runs SET state = 'failed', error = ?,
    updated_at = ?, completed_at = ? WHERE id = ? AND state = 'running'`).run(
    error,
    failedAt,
    failedAt,
    workflowIdValue,
  );
  if (Number(result.changes) === 1) {
    workflowEvent(internal, workflowIdValue, "failed", null, failedAt, { error });
  }
}

function workflowEvent(
  internal: SQLiteInternal,
  workflowIdValue: string,
  name: string,
  step: string | null,
  createdAt: number,
  details: Record<string, unknown>,
): void {
  internal.prepare(`INSERT INTO clank_workflow_events
    (workflow_id, event, step_name, details, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    workflowIdValue,
    name,
    step,
    JSON.stringify(details),
    createdAt,
  );
  internal.prepare(`DELETE FROM clank_workflow_events WHERE id <= (
    SELECT max(id) - 100000 FROM clank_workflow_events
  )`).run();
}

function isTerminalWorkflowStep(state: WorkflowStepState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function jobMetadata(row: JobRow): JobMetadata {
  return Object.freeze({
    id: String(row.id),
    name: String(row.name),
    queue: String(row.queue),
    attempt: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    createdAt: Number(row.created_at),
    scheduledAt: row.scheduled_at === null || row.scheduled_at === undefined ? null : Number(row.scheduled_at),
    cron: row.cron_name === null || row.cron_name === undefined ? null : String(row.cron_name),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
  });
}

function normalizeRetry(options: JobRetryOptions = {}): Readonly<Required<JobRetryOptions>> {
  const initialDelayMs = integer(options.initialDelayMs ?? 1_000, "job retry initialDelayMs", 0, 24 * 60 * 60_000);
  const maxDelayMs = integer(options.maxDelayMs ?? 15 * 60_000, "job retry maxDelayMs", 0, 7 * 24 * 60 * 60_000);
  if (maxDelayMs < initialDelayMs) throw new TypeError("job retry maxDelayMs must be at least initialDelayMs.");
  const factor = finite(options.factor ?? 2, "job retry factor", 1, 100);
  const jitter = finite(options.jitter ?? 0.2, "job retry jitter", 0, 1);
  return Object.freeze({
    maxAttempts: integer(options.maxAttempts ?? 5, "job retry maxAttempts", 1, 100),
    initialDelayMs,
    factor,
    maxDelayMs,
    jitter,
  });
}

function normalizeRetention(options: JobRetentionOptions = {}): Readonly<{
  succeededMs: number | false;
  cancelledMs: number | false;
  deadMs: number | false;
  workflowSucceededMs: number | false;
  workflowCancelledMs: number | false;
  workflowFailedMs: number | false;
  cleanupIntervalMs: number;
}> {
  const duration = (value: number | false | undefined, fallback: number | false, name: string) => {
    const selected = value === undefined ? fallback : value;
    return selected === false
      ? false
      : integer(selected, name, 0, 10 * 365 * 24 * 60 * 60_000);
  };
  return Object.freeze({
    succeededMs: duration(options.succeededMs, 7 * 24 * 60 * 60_000, "job retention succeededMs"),
    cancelledMs: duration(options.cancelledMs, 7 * 24 * 60 * 60_000, "job retention cancelledMs"),
    deadMs: duration(options.deadMs, false, "job retention deadMs"),
    workflowSucceededMs: duration(
      options.workflowSucceededMs,
      30 * 24 * 60 * 60_000,
      "job retention workflowSucceededMs",
    ),
    workflowCancelledMs: duration(
      options.workflowCancelledMs,
      7 * 24 * 60 * 60_000,
      "job retention workflowCancelledMs",
    ),
    workflowFailedMs: duration(
      options.workflowFailedMs,
      false,
      "job retention workflowFailedMs",
    ),
    cleanupIntervalMs: integer(
      options.cleanupIntervalMs ?? 60 * 60_000,
      "job retention cleanupIntervalMs",
      10_000,
      30 * 24 * 60 * 60_000,
    ),
  });
}

function retryDelay(options: Required<JobRetryOptions>, attempt: number, random: () => number): number {
  const exponential = Math.min(
    options.maxDelayMs,
    options.initialDelayMs * (options.factor ** Math.max(0, attempt - 1)),
  );
  const sampled = Number(random());
  const ratio = Number.isFinite(sampled) ? Math.max(0, Math.min(1, sampled)) : 0.5;
  return Math.round(exponential * (1 - options.jitter + ratio * options.jitter * 2));
}

function normalizeSchedule<Input>(
  schedule: CronDefinition<Input>,
  args: Schema<Input>,
  index: number,
): Readonly<CronDefinition<Input>> & {
  timezone: string;
  concurrency: CronConcurrency;
  startingDeadlineMs: number;
  maxCatchUp: number;
  suspended: boolean;
} {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    throw new TypeError(`job schedule[${index}] must be an object.`);
  }
  const name = identifier(schedule.name, `job schedule[${index}].name`, 128);
  const cron = normalizeCron(schedule.cron);
  const timezone = validateTimezone(schedule.timezone ?? "Etc/UTC");
  const concurrency = schedule.concurrency ?? "allow";
  if (!["allow", "forbid", "replace"].includes(concurrency)) {
    throw new TypeError(`job schedule ${name} has an invalid concurrency policy.`);
  }
  const startingDeadlineMs = integer(
    schedule.startingDeadlineMs ?? 60 * 60_000,
    `job schedule ${name} startingDeadlineMs`,
    0,
    365 * 24 * 60 * 60_000,
  );
  const maxCatchUp = integer(schedule.maxCatchUp ?? 10, `job schedule ${name} maxCatchUp`, 1, 100);
  const parsed = args.parse(schedule.args);
  boundedJson(parsed, 256 * 1024, `job schedule ${name} args`);
  return Object.freeze({
    name,
    cron,
    timezone,
    args: parsed,
    concurrency,
    startingDeadlineMs,
    maxCatchUp,
    suspended: schedule.suspended === true,
  });
}

function normalizeAgent(value: false | JobAgentOptions | undefined): false | Readonly<JobAgentOptions> {
  if (value === false) return false;
  const source = value ?? {};
  if (source.idempotent !== undefined && typeof source.idempotent !== "boolean") {
    throw new TypeError("job agent idempotent must be boolean.");
  }
  if (source.openWorld !== undefined && typeof source.openWorld !== "boolean") {
    throw new TypeError("job agent openWorld must be boolean.");
  }
  const title = optionalText(source.title, "job agent title", 256);
  const description = optionalText(source.description, "job agent description", 16 * 1024);
  return Object.freeze({
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(source.idempotent === undefined ? {} : { idempotent: source.idempotent }),
    ...(source.openWorld === undefined ? {} : { openWorld: source.openWorld }),
  });
}

function normalizeWorkflowAgent(
  value: false | WorkflowAgentOptions | undefined,
): false | Readonly<WorkflowAgentOptions> {
  if (value === false) return false;
  const source = value ?? {};
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("workflow agent metadata must be an object or false.");
  }
  if (source.idempotent !== undefined && typeof source.idempotent !== "boolean") {
    throw new TypeError("workflow agent idempotent must be boolean.");
  }
  if (source.openWorld !== undefined && typeof source.openWorld !== "boolean") {
    throw new TypeError("workflow agent openWorld must be boolean.");
  }
  const title = optionalText(source.title, "workflow agent title", 256);
  const description = optionalText(source.description, "workflow agent description", 16 * 1024);
  return Object.freeze({
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(source.idempotent === undefined ? {} : { idempotent: source.idempotent }),
    ...(source.openWorld === undefined ? {} : { openWorld: source.openWorld }),
  });
}

function flattenJobs(
  tree: JobTree,
  prefix: string[] = [],
  output = new Map<string, AnyJobDefinition>(),
  stack = new Set<object>(),
): Map<string, AnyJobDefinition> {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw new TypeError(`Job namespace ${prefix.join(".") || "<root>"} must be an object.`);
  }
  if (stack.has(tree)) throw new TypeError("Job trees cannot contain cycles.");
  if (prefix.length > 16) throw new TypeError("Job namespaces cannot be deeper than 16 segments.");
  stack.add(tree);
  try {
    for (const [key, value] of Object.entries(tree)) {
      identifier(key, "job segment", 128);
      const path = [...prefix, key];
      if (path.length > 16) throw new TypeError("Job namespaces cannot be deeper than 16 segments.");
      if (isJobDefinition(value)) {
        const name = path.join(".");
        if (output.has(name)) throw new TypeError(`Duplicate job path: ${name}`);
        output.set(name, value);
      } else {
        flattenJobs(value, path, output, stack);
      }
    }
  } finally {
    stack.delete(tree);
  }
  return output;
}

function isJobDefinition(value: AnyJobDefinition | JobTree): value is AnyJobDefinition {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as AnyJobDefinition).kind === "job"
    && typeof (value as AnyJobDefinition).handler === "function"
    && typeof (value as AnyJobDefinition).args?.parse === "function",
  );
}

function freezeJobTree(tree: JobTree): JobTree {
  return Object.freeze(Object.fromEntries(
    Object.entries(tree).map(([key, value]) => [
      key,
      isJobDefinition(value) ? value : freezeJobTree(value),
    ]),
  ));
}

function flattenWorkflows(
  tree: WorkflowTree,
  prefix: string[] = [],
  output = new Map<string, AnyWorkflowDefinition>(),
  stack = new Set<object>(),
): Map<string, AnyWorkflowDefinition> {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw new TypeError(`Workflow namespace ${prefix.join(".") || "<root>"} must be an object.`);
  }
  if (stack.has(tree)) throw new TypeError("Workflow trees cannot contain cycles.");
  if (prefix.length > 16) throw new TypeError("Workflow namespaces cannot be deeper than 16 segments.");
  stack.add(tree);
  try {
    for (const [key, value] of Object.entries(tree)) {
      identifier(key, "workflow segment", 128);
      const path = [...prefix, key];
      if (path.length > 16) throw new TypeError("Workflow namespaces cannot be deeper than 16 segments.");
      if (isWorkflowDefinition(value)) {
        const name = path.join(".");
        if (output.has(name)) throw new TypeError(`Duplicate workflow path: ${name}`);
        output.set(name, value);
      } else {
        flattenWorkflows(value, path, output, stack);
      }
    }
  } finally {
    stack.delete(tree);
  }
  return output;
}

function isWorkflowDefinition(value: AnyWorkflowDefinition | WorkflowTree): value is AnyWorkflowDefinition {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as AnyWorkflowDefinition).kind === "workflow"
    && typeof (value as AnyWorkflowDefinition).args?.parse === "function"
    && typeof (value as AnyWorkflowDefinition).output === "function",
  );
}

function freezeWorkflowTree(tree: WorkflowTree): WorkflowTree {
  return Object.freeze(Object.fromEntries(
    Object.entries(tree).map(([key, value]) => [
      key,
      isWorkflowDefinition(value) ? value : freezeWorkflowTree(value),
    ]),
  ));
}

function workflowStepNames(workflow: AnyWorkflowDefinition): Map<AnyWorkflowStepDefinition, string> {
  return new Map(Object.entries(workflow.steps).map(([name, step]) => [step, name]));
}

function workflowDefinitionRevision(workflow: AnyWorkflowDefinition): string {
  const names = workflowStepNames(workflow);
  const source = JSON.stringify({
    args: workflow.args.toJSONSchema(),
    returns: workflow.returns?.toJSONSchema() ?? null,
    output: Function.prototype.toString.call(workflow.output),
    steps: Object.entries(workflow.steps).sort(([left], [right]) => left.localeCompare(right)).map(([name, step]) => ({
      name,
      job: jobPath(step.job),
      args: step.job.args.toJSONSchema(),
      returns: step.job.returns?.toJSONSchema() ?? null,
      needs: step.needs.map((dependency) => names.get(dependency)).sort(),
      mapper: Function.prototype.toString.call(step.args),
    })),
  });
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return first.toString(16).padStart(8, "0") + second.toString(16).padStart(8, "0");
}

function workflowStepContext(
  input: unknown,
  workflow: AnyWorkflowDefinition,
  currentStep: AnyWorkflowStepDefinition,
  rows: ReadonlyMap<string, WorkflowStepRow>,
): WorkflowStepContext<any> {
  const names = workflowStepNames(workflow);
  return Object.freeze({
    input,
    result(step: AnyWorkflowStepDefinition) {
      if (!currentStep.needs.includes(step)) {
        throw new Error("A workflow step can only read results from its declared dependencies.");
      }
      const name = names.get(step);
      const row = name ? rows.get(name) : undefined;
      if (!row || row.state !== "succeeded" || row.result === null) {
        throw new Error(`Workflow dependency ${name ?? "<unknown>"} has no successful result.`);
      }
      return JSON.parse(row.result);
    },
  });
}

function workflowOutputContext(
  input: unknown,
  workflow: AnyWorkflowDefinition,
  rows: ReadonlyMap<string, WorkflowStepRow>,
): WorkflowOutputContext<any, any> {
  const names = workflowStepNames(workflow);
  const result = (step: AnyWorkflowStepDefinition) => {
    const name = names.get(step);
    const row = name ? rows.get(name) : undefined;
    if (!row || row.state !== "succeeded" || row.result === null) {
      throw new Error(`Workflow step ${name ?? "<unknown>"} has no successful result.`);
    }
    return JSON.parse(row.result);
  };
  return Object.freeze({
    input,
    results: Object.freeze(Object.fromEntries(
      Object.entries(workflow.steps).map(([name, step]) => [name, result(step)]),
    )),
    result,
  });
}

function assertAcyclicWorkflow(
  entries: readonly [string, AnyWorkflowStepDefinition][],
  names: ReadonlyMap<AnyWorkflowStepDefinition, string>,
): void {
  const visiting = new Set<AnyWorkflowStepDefinition>();
  const visited = new Set<AnyWorkflowStepDefinition>();
  const visit = (step: AnyWorkflowStepDefinition) => {
    if (visited.has(step)) return;
    if (visiting.has(step)) throw new TypeError(`Workflow graph contains a cycle at ${names.get(step)}.`);
    visiting.add(step);
    for (const dependency of step.needs) visit(dependency);
    visiting.delete(step);
    visited.add(step);
  };
  for (const [, step] of entries) visit(step);
}

export function jobPath(job: AnyJobDefinition): string {
  const value = (job as unknown as Record<PropertyKey, unknown>)[JOB_PATH];
  if (typeof value !== "string" || !value) throw new TypeError("Expected a job from defineJobs().");
  return value;
}

export function workflowPath(workflow: AnyWorkflowDefinition): string {
  const value = (workflow as unknown as Record<PropertyKey, unknown>)[WORKFLOW_PATH];
  if (typeof value !== "string" || !value) {
    throw new TypeError("Expected a workflow registered with defineWorkflows().");
  }
  return value;
}

/** Returns the agent- and operator-readable background work contract. */
export function jobManifest(
  definition: JobSystemDefinition<any, any>,
): readonly JobManifestEntry[] {
  return Object.freeze([...flattenJobs(definition.jobs)].map(([name, job]) => Object.freeze({
    name,
    queue: job.queue,
    ...(job.description ? { description: job.description } : {}),
    args: job.args.toJSONSchema(),
    ...(job.returns ? { returns: job.returns.toJSONSchema() } : {}),
    retry: job.retry,
    timeoutMs: job.timeoutMs,
    schedules: Object.freeze(job.schedules.map((schedule) => Object.freeze({
      name: schedule.name,
      cron: schedule.cron,
      timezone: schedule.timezone ?? "Etc/UTC",
      concurrency: schedule.concurrency ?? "allow",
      suspended: schedule.suspended === true,
    }))),
    agent: job.agent,
  })));
}

/** Returns the agent- and operator-readable durable workflow graph contract. */
export function workflowManifest(
  definition: JobSystemDefinition<any, any, any>,
): readonly WorkflowManifestEntry[] {
  return Object.freeze([...flattenWorkflows(definition.workflows ?? {})]
    .sort(([left], [right]) => left.localeCompare(right)).map(([name, workflow]) => {
    const names = workflowStepNames(workflow);
    return Object.freeze({
      name,
      ...(workflow.description ? { description: workflow.description } : {}),
      args: workflow.args.toJSONSchema(),
      ...(workflow.returns ? { returns: workflow.returns.toJSONSchema() } : {}),
      steps: Object.freeze(Object.entries(workflow.steps)
        .sort(([left], [right]) => left.localeCompare(right)).map(([stepName, step]) => Object.freeze({
        name: stepName,
        job: jobPath(step.job),
        needs: Object.freeze(step.needs.map((dependency) => names.get(dependency)!).sort()),
        ...(step.description ? { description: step.description } : {}),
      }))),
      agent: workflow.agent,
    });
  }));
}

const CRON_MACROS: Readonly<Record<string, string>> = Object.freeze({
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
});
const MONTH_NAMES = Object.freeze({ jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 });
const WEEKDAY_NAMES = Object.freeze({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 });

interface ParsedCron {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  day: ReadonlySet<number>;
  month: ReadonlySet<number>;
  weekday: ReadonlySet<number>;
  anyDay: boolean;
  anyWeekday: boolean;
}

const cronCache = new Map<string, ParsedCron>();
const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();

export function normalizeCron(input: string): string {
  if (typeof input !== "string") throw new TypeError("Cron expression must be a string.");
  const value = input.trim().toLowerCase().replace(/\s+/g, " ");
  const expanded = CRON_MACROS[value] ?? value;
  const fields = expanded.split(" ");
  if (fields.length !== 5) throw new TypeError("Cron expressions must contain exactly five fields.");
  parseCron(expanded);
  return expanded;
}

export function nextCronOccurrence(
  expression: string,
  after: number | Date,
  timezone = "Etc/UTC",
): number {
  const normalized = normalizeCron(expression);
  const parsed = parseCron(normalized);
  const zone = validateTimezone(timezone);
  const afterMs = after instanceof Date ? after.getTime() : Number(after);
  if (!Number.isFinite(afterMs)) throw new TypeError("Cron cursor must be a finite timestamp.");
  let candidate = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  const deadline = candidate + 5 * 366 * 24 * 60 * 60_000;
  while (candidate <= deadline) {
    const parts = zonedParts(candidate, zone);
    const dayMatches = parsed.day.has(parts.day);
    const weekdayMatches = parsed.weekday.has(parts.weekday);
    const calendarMatches = parsed.anyDay && parsed.anyWeekday
      ? true
      : parsed.anyDay
        ? weekdayMatches
        : parsed.anyWeekday
          ? dayMatches
          : dayMatches || weekdayMatches;
    if (
      parsed.minute.has(parts.minute)
      && parsed.hour.has(parts.hour)
      && parsed.month.has(parts.month)
      && calendarMatches
    ) {
      return candidate;
    }
    candidate += 60_000;
  }
  throw new Error(`Cron expression ${normalized} has no occurrence within five years.`);
}

function parseCron(expression: string): ParsedCron {
  const cached = cronCache.get(expression);
  if (cached) return cached;
  const [minute, hour, day, month, weekday] = expression.split(" ");
  const parsed = Object.freeze({
    minute: parseCronField(minute!, 0, 59, undefined, "minute"),
    hour: parseCronField(hour!, 0, 23, undefined, "hour"),
    day: parseCronField(day!, 1, 31, undefined, "day of month"),
    month: parseCronField(month!, 1, 12, MONTH_NAMES, "month"),
    weekday: parseCronField(weekday!, 0, 7, WEEKDAY_NAMES, "day of week", true),
    anyDay: day === "*" || day === "?",
    anyWeekday: weekday === "*" || weekday === "?",
  });
  if (cronCache.size >= 1_000) cronCache.delete(cronCache.keys().next().value!);
  cronCache.set(expression, parsed);
  return parsed;
}

function parseCronField(
  field: string,
  minimum: number,
  maximum: number,
  names: Readonly<Record<string, number>> | undefined,
  label: string,
  sundaySeven = false,
): ReadonlySet<number> {
  const values = new Set<number>();
  const normalized = field === "?" ? "*" : field;
  for (const item of normalized.split(",")) {
    if (!item) throw new TypeError(`Cron ${label} contains an empty list item.`);
    const [rangePart, stepPart, extra] = item.split("/");
    if (extra !== undefined) throw new TypeError(`Cron ${label} contains too many step separators.`);
    const step = stepPart === undefined ? 1 : cronNumber(stepPart, 1, maximum - minimum + 1, names, label);
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = minimum;
      end = maximum;
    } else {
      const bounds = rangePart!.split("-");
      if (bounds.length > 2) throw new TypeError(`Cron ${label} has an invalid range.`);
      start = cronNumber(bounds[0]!, minimum, maximum, names, label);
      end = bounds.length === 2
        ? cronNumber(bounds[1]!, minimum, maximum, names, label)
        : start;
      if (end < start) throw new TypeError(`Cron ${label} ranges cannot wrap.`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(sundaySeven && value === 7 ? 0 : value);
    }
  }
  if (values.size === 0) throw new TypeError(`Cron ${label} selects no values.`);
  return Object.freeze(values);
}

function cronNumber(
  raw: string,
  minimum: number,
  maximum: number,
  names: Readonly<Record<string, number>> | undefined,
  label: string,
): number {
  const named = names?.[raw.toLowerCase()];
  const value = named ?? Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Cron ${label} value ${raw} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function validateTimezone(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 128 || input.includes("\0")) {
    throw new TypeError("Cron timezone must be a valid IANA time zone.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input }).format(0);
  } catch {
    throw new TypeError(`Unknown IANA time zone: ${input}`);
  }
  return input;
}

function zonedParts(timestamp: number, timezone: string): {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
} {
  const date = new Date(timestamp);
  if (timezone === "Etc/UTC" || timezone === "UTC") {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      weekday: date.getUTCDay(),
    };
  }
  let formatter = timezoneFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      minute: "2-digit",
      hour: "2-digit",
      day: "2-digit",
      month: "2-digit",
      weekday: "short",
    });
    timezoneFormatters.set(timezone, formatter);
  }
  const output: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") output[part.type] = part.value;
  }
  return {
    minute: Number(output.minute),
    hour: Number(output.hour),
    day: Number(output.day),
    month: Number(output.month),
    weekday: WEEKDAY_NAMES[output.weekday!.toLowerCase().slice(0, 3) as keyof typeof WEEKDAY_NAMES],
  };
}

function scheduleHash(jobName: string, schedule: Readonly<CronDefinition<unknown>>, payload: string): string {
  // Persist the exact canonical definition rather than a truncated digest.
  // Schedule count/payload bounds keep this comparison value finite.
  return JSON.stringify([
    jobName,
    schedule.name,
    schedule.cron,
    schedule.timezone,
    payload,
    schedule.concurrency,
    schedule.startingDeadlineMs,
    schedule.maxCatchUp,
    schedule.suspended,
  ]);
}

function toSchema<Args extends JobArgs>(args: Args): Schema<InferJobArgs<Args>> {
  if (args && typeof args === "object" && "parse" in args && typeof args.parse === "function") {
    return args as Schema<InferJobArgs<Args>>;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Job args must be a schema or schema shape.");
  return s.object(args as SchemaShape) as Schema<InferJobArgs<Args>>;
}

function boundedJson(value: unknown, maximum: number, label: string): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be JSON serializable.`);
  }
  if (json === undefined) throw new TypeError(`${label} must be JSON serializable.`);
  if (new TextEncoder().encode(json).byteLength > maximum) {
    throw new TypeError(`${label} exceeds ${maximum} bytes.`);
  }
  return json;
}

function identifier(
  value: unknown,
  label: string,
  maximum: number,
  flexible = false,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const normalized = value.trim();
  const pattern = flexible
    ? /^[\x20-\x7e]+$/u
    : /^[a-z0-9][a-z0-9._-]*$/iu;
  if (!normalized || normalized.length > maximum || normalized.includes("\0") || !pattern.test(normalized)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return normalized;
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || normalized.includes("\0")) {
    throw new TypeError(`${label} is invalid.`);
  }
  return normalized;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function jobId(): string {
  return `job_${crypto.randomUUID().replaceAll("-", "")}`;
}

function workflowId(): string {
  return `workflow_${crypto.randomUUID().replaceAll("-", "")}`;
}

function processId(): number {
  return Number((globalThis as any).process?.pid ?? 0);
}

function safeError(error: unknown, maximum = 16 * 1024): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").slice(0, maximum);
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Job aborted."));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", abortedDelay);
      resolve();
    }
    function abortedDelay() {
      clearTimeout(timer);
      done();
    }
    signal.addEventListener("abort", abortedDelay, { once: true });
  });
}

function environmentInteger(
  raw: unknown,
  fallback: number | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return integer(value, label, minimum, maximum);
}

function workerQueues(input: readonly string[] | undefined): readonly string[] {
  const values = input ?? [];
  if (values.length > 64) throw new TypeError("worker queues cannot contain more than 64 queues.");
  return Object.freeze([...new Set(values.map((queue) => identifier(queue, "worker queue", 128)))]);
}

function environmentList(raw: unknown, label: string): readonly string[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 4_096 || raw.includes("\0")) {
    throw new TypeError(`${label} is invalid.`);
  }
  const values = raw.split(",").map((value) => identifier(value, `${label} queue`, 128));
  if (values.length > 64) throw new TypeError(`${label} cannot contain more than 64 queues.`);
  return Object.freeze([...new Set(values)]);
}
