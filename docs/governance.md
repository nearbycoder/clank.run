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
