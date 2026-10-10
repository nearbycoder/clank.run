import { defineDatabase, defineJobs, defineTable, defineWorkflow, defineWorkflows, s } from "../src/index.ts";
import type { JobRuntime, WorkflowCompensationState, WorkflowCompensationContext } from "../src/jobs.ts";

const schema = defineDatabase({ events: defineTable({ value: s.string() }) });
const jobs = defineJobs({ schema }).jobs(({ job }) => ({
  reserve: job({ args: { name: s.string() }, returns: s.object({ reservation: s.number() }), handler: () => ({ reservation: 4 }) }),
  release: job({ args: { original: s.string(), key: s.string(), value: s.number() }, agent: { idempotent: true }, handler: () => true }),
}));
const workflow = defineWorkflow({ args: { name: s.string() }, graph: graph => {
  const reserve = graph.step(jobs.jobs.reserve, {
    args: ({ input }) => ({ name: input.name }),
    compensate: { job: jobs.jobs.release, args: context => {
      const name: string = context.input.name;
      let value = 0;
      if (context.outcome.state === "succeeded") {
        value = context.outcome.result.reservation;
        // @ts-expect-error Forward results retain the declared output schema.
        const wrong: string = context.outcome.result.reservation;
        void wrong;
      } else {
        // @ts-expect-error An uncertain failed/cancelled effect has no claimed result.
        context.outcome.result;
      }
      void name;
      return { original: context.forwardJobId, key: context.operationKey, value };
    } },
  });
  const irreversible = graph.step(jobs.jobs.reserve, { needs: [reserve], args: ({ input }) => ({ name: input.name }),
    compensate: { manual: "Review an irreversible external operation" } });
  return { reserve, irreversible };
} });
const definition = defineWorkflows(jobs, { flow: workflow });
declare const runtime: JobRuntime<typeof definition>;
const run = runtime.getWorkflow("id");
if (run?.compensation) {
  const state: WorkflowCompensationState = run.compensation.state;
  const id: string | null = run.compensation.steps[0]!.forwardJobId;
  void [state, id];
}
runtime.purgeWorkflows({ states: ["failed"], includeUnresolvedCompensations: true });
// @ts-expect-error Operator evidence deletion requires a boolean opt-in.
runtime.purgeWorkflows({ includeUnresolvedCompensations: "yes" });
defineWorkflow({ args: { name: s.string() }, graph: graph => ({ invalid: graph.step(jobs.jobs.reserve, {
  args: ({ input }) => ({ name: input.name }),
  compensate: { job: jobs.jobs.release,
    // @ts-expect-error Compensation arguments retain the selected cleanup job's input contract.
    args: context => ({ original: context.forwardJobId, key: context.operationKey, value: "wrong" }),
  },
}) }) });
declare const uncertain: WorkflowCompensationContext<{ name: string }, { reservation: number }>;
const operationKey: string = uncertain.operationKey;
void operationKey;

const noResult = defineJobs({ schema }).jobs(({ job }) => ({
  forward: job({ args: {}, handler: () => {} }),
  undo: job({ args: { key: s.string() }, agent: { idempotent: true }, handler: () => {} }),
}));
defineWorkflow({ args: {}, graph: graph => ({ forward: graph.step(noResult.jobs.forward, {
  args: () => ({}),
  compensate: { job: noResult.jobs.undo, args: context => {
    if (context.outcome.state === "succeeded") {
      const empty: null = context.outcome.result;
      // @ts-expect-error Void forward results are persisted as null.
      const nonexistent: number = context.outcome.result;
      void [empty, nonexistent];
    }
    return { key: context.operationKey };
  } },
}) }) });
