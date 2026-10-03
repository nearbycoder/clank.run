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
