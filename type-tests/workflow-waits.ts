import { defineDatabase, defineJobs, defineTable, defineWorkflow, defineWorkflows, s } from "../src/index.ts";
import type { JobRuntime, OpenJobsOptions, WorkflowWaitTicket, WorkflowWaitResume, WorkflowState } from "../src/jobs.ts";

const schema = defineDatabase({ events: defineTable({ value: s.string() }) });
const jobs = defineJobs({ schema }).jobs(({ job }) => ({ save: job({ args: { value: s.string() }, returns: s.string(), handler: (_, input) => input.value }) }));
const workflow = defineWorkflow({ args: { label: s.string() }, graph: ({ wait, step }) => {
  const decision = wait({ mode: "decision", timeoutMs: 60_000, returns: s.object({ value: s.string(), accepted: s.boolean() }),
    request: ({ input }) => ({ title: input.label, data: { requested: true } }) });
  const save = step(jobs.jobs.save, { needs: [decision], args: context => {
    const value: string = context.result(decision).value;
    const accepted: boolean = context.result(decision).accepted;
    // @ts-expect-error Wait results retain their schema types.
    const incorrect: number = context.result(decision).value;
    void [accepted, incorrect]; return { value };
  } });
  return { decision, save };
}, returns: s.string(), output: ({ results }) => {
  const allowed: boolean = results.decision.accepted;
  const value: string = results.save;
  void [allowed, value]; return results.save;
} });
const definition = defineWorkflows(jobs, { flow: workflow });
declare const runtime: JobRuntime<typeof definition>;
const options: OpenJobsOptions = { workflowWaits: { signingKey: "persistent-signing-key", policyRevision: 2 } };
const ticket: WorkflowWaitTicket | null = runtime.getWorkflowWait("workflow-id", "decision");
const state: WorkflowState = "waiting";
runtime.listWorkflows({ state });
if (ticket) {
  const input: WorkflowWaitResume = { waitId: ticket.id, expectedVersion: ticket.version, resumeToken: ticket.resumeToken,
    idempotencyKey: "unique-operation-key", choice: "resume", result: { value: "yes", accepted: true } };
  const receipt = runtime.resumeWorkflowWait(input);
  const acceptedAt: number = receipt.acceptedAt;
  const plan: string | null = receipt.reviewPlanId;
  void [acceptedAt, plan];
}
// @ts-expect-error The wait policy revision is a number.
const invalidPolicy: OpenJobsOptions = { workflowWaits: { signingKey: "secret", policyRevision: "2" } };
// @ts-expect-error A durable resume requires an exact version, token and idempotency key.
runtime.resumeWorkflowWait({ waitId: "wait-id", choice: "resume" });
// @ts-expect-error Only the declared wait modes are accepted.
defineWorkflow({ args: {}, graph: ({ wait }) => ({ invalid: wait({ mode: "timer", timeoutMs: 10_000, returns: s.string(), request: () => ({ title: "Wrong mode" }) }) }) });
void [options, invalidPolicy, state];
