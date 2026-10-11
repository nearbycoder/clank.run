# Governance, approvals, entitlements, and feature flags

Clank uses one data-only policy vocabulary for browser users, agents, services, hosted limits,
and staged feature delivery. Evaluation is deterministic and deny-by-default.

```ts
import {
  defineGovernancePolicy,
  entitlement,
  evaluateFeatureFlag,
  evaluatePolicy,
} from "@clank.run/framework/governance";

const policy = defineGovernancePolicy({
  revision: "workspace-18",
  rules: [
    {
      id: "agents-delete-production",
      actions: ["todos.delete"],
      principalKinds: ["agent"],
      resource: "production:*",
      effect: "approval",
      approvalTtlMs: 5 * 60_000,
    },
    {
      id: "members-write",
      actions: ["todos.*"],
      roles: ["member"],
      effect: "allow",
    },
  ],
  entitlements: [
    { key: "projects", limit: 10 },
    { key: "custom-domains", limit: true },
  ],
  flags: [{
    key: "new-board",
    enabled: true,
    default: "classic",
    variants: [{ name: "new", weight: 2_500, value: "new" }],
    allowRoles: ["operator"],
  }],
});

const decision = evaluatePolicy(policy, {
  action: "todos.delete",
  resource: "production:todos",
  principal: { id: "codex", kind: "agent", roles: ["member"] },
});

const projectLimit = entitlement(policy, "projects");
const board = evaluateFeatureFlag(policy, "new-board", {
  subject: "workspace_4",
});
```

Rules use exact actions or a trailing wildcard. They can select roles, principal kinds, resource
patterns, and exact request attributes. Rules are first-match, so put specific deny or approval
rules before broader allows. Policies reject unknown fields, duplicate IDs, invalid schedules,
ambiguous variant totals, and non-JSON values.

## Agent action approval

`issueApproval()` creates a short-lived HMAC grant bound to an action, principal, resource, rule,
and policy revision. `verifyApproval()` checks those bindings, lifetime, signature, and an optional
used-nonce set. Store a consumed nonce transactionally to enforce one-time use. Use a dedicated
random secret of at least 32 bytes; never reuse a session key or store it in policy JSON.

```ts
const grant = await issueApproval({
  policy,
  request,
  approvedBy: signedInUser.id,
  secret: process.env.APPROVAL_HMAC_KEY!,
});

const accepted = await verifyApproval({
  grant,
  policy,
  request,
  secret: process.env.APPROVAL_HMAC_KEY!,
  usedNonces,
});
```

## Durable agent operation budgets

`openAgentBudgets()` attaches expiring, owner/principal-bound capacity to a grant. Registered
actions automatically debit one accepted call, each write invocation and each distinct affected
record. An action can also declare a fixed external-operation cost for transactional outbox
work. Client arguments cannot choose these costs. Budget debit, owned application writes and
the replay receipt commit in the same SQLite transaction, including across independent processes.

```ts
import { s, type AuthRequest } from "@clank.run/framework";
import { openAgentBudgets, defineAgentBudgetAction, type AgentBudgetContext } from "@clank.run/framework/agent-budgets";

interface BudgetCaller { auth: AuthRequest; principalId: string; }

const actions = {
  create: defineAgentBudgetAction(schema, {
    revision: "create-v1",
    args: s.object({ text: s.string() }),
    authorize: ({ caller }: AgentBudgetContext<BudgetCaller, typeof schema>) => Boolean(caller.auth.requireUser()),
    execute: ({ db }, input) => ({ id: db.table("items").insert(input) }),
  }),
};

const budgets = await openAgentBudgets(database, {
  actions,
  // caller comes from your authenticated server adapter, never raw request JSON.
  // auth.requireUser() must revalidate current session/delegated credentials.
  identity(caller: BudgetCaller) {
    const user = caller.auth.requireUser();
    return { ownerId: user.id, principalId: caller.principalId };
  },
  authorizeManage: ({ caller }) => Boolean(caller.auth.requireRole("admin")),
});

const grant = budgets.grant({
  principalId: "agent-grant-7", actions: ["create"],
  limits: { calls: 10, writes: 10, records: 10, externalOperations: 0 },
  expiresAt: Date.now() + 60_000, reason: "Create ten reviewed follow-up items",
}, administratorContext);

const remaining = budgets.preview(grant.id, agentContext).remaining;
const receipt = budgets.execute({
  grantId: grant.id, operationId: "request-1", action: "create", input: { text: "Follow up" },
}, agentContext);
```

The identity resolver runs again inside the write transaction. It must resolve **current** trusted
credentials and revocation from the authenticated adapter, including for an exact receipt retry.
A grant does not replace action authorization or row ownership. The assigned principal may inspect
its grant; administration requires `authorizeManage`. Other owners receive `BUDGET_NOT_FOUND`.
Named actions are bound to their definition revisions. Change the revision when execution,
authorization or external-operation costs change; old grants then receive `BUDGET_ACTION_CHANGED`.

`execute()` accepts only synchronous callbacks and finite, bounded JSON inputs/results. Keep all
local writes inside `context.db`; retained writer/read/query handles stop working when the
transaction ends. Async execution, history purges, unsupported JSON and overspending roll back
the entire action. Even a callback that catches a budget error cannot commit excess records.
Write calls that affect no existing record still count as writes; distinct affected records count
once per action. Deleting an existing row counts that row too.

An exact `(grantId, operationId)` retry with the same action revision and canonical parsed input
returns the durable receipt without executing or debiting again, including after restart.
Changed retries receive `BUDGET_RETRY_CONFLICT`. Action authorization is rechecked before replay.
Revoked or expired grants reject execution/replay with `BUDGET_CLOSED`; their remaining preview
shows zero. `revoke()` is immediately effective and survives restart. A preview is a current
snapshot, not a capacity reservation; execution always checks the balance under the write lock.

External-operation costs measure accepted **transactional outbox work**, not successful network
responses. Set `externalOperations` on the registered action to the number of outbox operations
it enqueues. Its execution context supplies a stable `operationId` including the grant ID; pass
that key to an idempotent provider. Do not perform network requests directly in the action.
Budgets do not make unrelated external APIs exactly once.

Limits are explicit integers from zero through one million for all four dimensions. Grants expire
within 30 days and require a bounded reason. Defaults retain at most 1,000 grants, 10,000 receipts
and 16 KiB per input/output. At capacity, new admission fails with `BUDGET_CAPACITY` while exact
live receipts remain replayable. Configure smaller limits for sensitive applications.
`prune()` and grant admission retire only the current owner's grants after expiry/revocation plus
`retentionMs` (default one day). The bounded purge handles at most 500 grants per call. Retired
IDs are never reused, so their old retries cannot create new operations.

The additive `clank_agent_budget_grants` and `clank_agent_budget_receipts` tables participate in
ordinary SQLite backups and recovery capture. Bootstrap the service before opening the first
`openPointInTimeRecovery()` epoch, which seals the schema. Restores preserve grant counters and
receipts together at the selected commit. Restoring an older point also restores older grant and
revocation state; reconcile current credentials and remote effects before resuming operations.
Rollback should disable protected actions until
the budget adapter is restored; routing them to an unbudgeted fallback removes their protection.
Keep untrusted client IDs/costs out of the identity and management callbacks.

## Typed feature delivery

Flags can be disabled, scheduled, targeted, or assigned to weighted variants. A stable hash of
policy revision, flag key, and subject keeps assignment consistent across servers. Weights use
10,000 basis points; unallocated traffic receives the declared default. Every evaluation records
its variant and reason for audits and revision traces.

## CLI evaluation

```sh
clank workbench policy policy.json todos.delete \
  --principal=codex --kind=agent --roles=member \
  --resource=production:todos --json

clank workbench flag policy.json new-board \
  --subject=workspace_4 --json
```

The workbench reads bounded JSON files and prints protocol-versioned output for humans, agents,
and CI.

## Durable previews, approvals, and receipts

Actions can opt into [approval quorum policies](approval-quorums.md) for distinct
current human approvers, required roles, requester separation and expiring votes.

For application mutations that require review, configure `openBackend({ ... },
{ reviewedActions: { actions } })`. The backend mounts a browser approval inbox at
`/__clank/approvals` (or the configured backend prefix), its JSON/event endpoints,
and MCP preview, commit, receipt, and compensation tools. Authentication is required.
Pass your database schema to `defineReviewedAction(schema, action)` to preserve table fields, validated IDs, and the inferred input, preview, and output types:

```ts
import { defineReviewedAction } from "@clank.run/framework/reviewed-actions";
import { defineAuth, defineBackend, defineDatabase, defineTable, openBackend, s } from "@clank.run/framework";

const schema = defineDatabase({ tasks: defineTable({ done: s.boolean() }).owned() });
const definition = defineBackend({ schema, auth: defineAuth() }).functions(() => ({}));
const finish = defineReviewedAction(schema, {
  revision: "finish-v1",
  title: "Finish a task",
  args: s.object({ id: s.id("tasks") }),
  authorize: ({ auth }) => Boolean(auth.user),
  preview: ({ db }, { id }) => {
    const task = db.table("tasks").get(id);
    if (!task) throw new Error("Task not found.");
    return { id, before: task.done, after: true };
  },
  authorizeApproval: ({ auth }, plan) => auth.user?.id === plan.requestedBy,
  execute: ({ db }, { id }, preview) => {
    db.table("tasks").patch(id, { done: true });
    return { id, before: preview.before };
  },
  compensate: ({ db }, receipt) => {
    db.table("tasks").patch(receipt.output.id, { done: receipt.output.before });
    return { restored: receipt.output.id };
  },
});

const backend = await openBackend(definition, {
  path: "app.sqlite",
  reviewedActions: { actions: { finish } },
  agentActivity: {},
});
```

Define `preview` before callbacks that consume its type (`authorizeApproval` and `execute`), and `execute` before `compensate`, so TypeScript can infer them in object-property order. Alternatively, annotate callback return types. The one-argument helper remains available for actions that do not need schema-specific database fields.

The agent calls `review_plan_finish` to obtain a persistent plan containing the
preview and the exact database revision. A browser user inspects its preview at
`/__clank/approvals` and chooses approve or deny. The agent then calls
`review_commit` with the plan ID. Applications can also use
`backend.reviewedActions.plan()`, `.decide()`, `.commit()`, `.receipt()`, and
`.compensate()` with trusted, current `AuthRequest` values obtained from the
application auth runtime. Never construct those objects from user input.

Approval decisions require a real browser session and CSRF proof. Both requester
and approver authorization are checked again when execution starts; the approver's
session must still be active, and their scoped reads use their own identity. An
OAuth agent cannot approve itself. Whether a browser user may approve their own
request is an explicit `authorizeApproval` policy choice. Denial is terminal.

Any application database revision change between preview and execution rejects the
plan with `PREVIEW_STALE`, including changes made by another process. This
conservative fence covers inserts and query predicates as well as individual
record versions. Request a new preview and review it again after a conflict. Bump
the action's `revision` when changing its behavior or permission rules; old plans
then fail with `ACTION_CHANGED`.

An action may explicitly declare `previewDependencies: "records"` when **all** data read by
its preview and requester policy goes through `context.db`. In this mode, planning retains
up to 1,024 read dependencies. A point read fences that record, including a missing record;
queries and history reads conservatively fence the entire visible table. Unrelated records
and other owners' writes can proceed without invalidating a point-read review. Relevant
mutations, deletion/restoration and journal-retention gaps still return `PREVIEW_STALE`.
The requester and approver policies and live sessions are always checked again at commit.
Policies that read external state or have undeclared dependencies must keep the default
`"database"` mode. Bump the action revision when changing the dependency declaration.
The nullable `dependencies` column is added to the existing plans table; older plans retain
the global fence. Rolling back restores the conservative global fence for every plan.

The mutation, one-time approval consumption, exact changed record versions, audit
event, and result receipt commit in one SQLite transaction. Retrying the same
consumed plan returns the stored receipt after rechecking the requester's current
permissions; it never repeats the mutation. Exceptions, oversized results, or
Promise-returning callbacks roll back the complete transaction. Preview contexts
provide read methods only. All callbacks must be synchronous and must not perform
external effects such as sending email or HTTP requests; schedule those separately
through an existing transactional job/outbox mechanism.

Receipts expose record IDs and before/after versions, without retaining full record
contents unless the action explicitly returns them. `review_receipt` retrieves an
owner's receipt. `review_compensate` performs an explicitly defined compensating
action only while its original database revision and every changed record version
still match. The operation produces another durable receipt and executes once;
retries return that receipt. Concurrent edits reject compensation with
`RECEIPT_STALE`. A compensating action is a new business operation, not an automatic
reversal of arbitrary side effects. Without `compensate`, the receipt advertises
that no undo is available. With `agentActivity` enabled, successful review tools
link activity entries to their receipt, exact record versions, and undo availability.

`GET /__clank/approvals` returns authorized plans as JSON, or a server-rendered
inbox for `Accept: text/html`. `POST /__clank/approvals/decide` accepts
`{ "id": "review_...", "decision": "approve" }` (or `deny`) with the current
session cookie and `x-clank-csrf` token. `GET /__clank/approvals/events?after=0`
provides an authorized, persistent event feed. Stored previews, events, execution receipts and compensation receipts recheck current action authorization; revoking workspace or resource access also revokes access to this history. Missing or revised action definitions fail closed. Save the last `sequence` to resume
notifications after restart. `onChange(event)` is a best-effort wakeup callback;
errors do not roll back decisions, and durable polling is the recovery mechanism.

Plans expire after five minutes by default (`ttlMs`, 1 second–24 hours). Expiry is
enforced at each decision/execution; inbox reads and new plans also persist expiry
events. `maxEntries` bounds durable admission (10,000 by default). Terminal plans,
receipts, and events are pruned after `retentionMs` (30 days by default; at least
the plan TTL and at most a year). A retry after pruning returns not found, never
executes again. The inbox shows up to 100 entries, prioritizes the requester's own
plans, and scans at most 1,000 recent requests for additional approver-visible
plans; durable event polling supports notification delivery beyond that view.

Persistence adds `clank_reviewed_plans`, `clank_reviewed_receipts`, and
`clank_reviewed_events` tables without changing application records. Back up the
whole application database so approvals and mutations recover together. Removing
the option disables its routes/tools while preserving stored history. Do not expose
a second unreviewed backend mutation that performs the same protected operation.
