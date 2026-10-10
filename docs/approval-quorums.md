# Approval quorum policies

An application can require several distinct human approvals before a reviewed action
changes its data. Quorums extend the existing [reviewed-action workflow](governance.md),
including record-bound previews, its native browser inbox and exact committed receipts.
An action without `approvalQuorum` keeps its established single-approver behavior.

The initial implementation uses one native SQLite application store. Authentication,
membership, security policy, votes and the application mutation must share that store.
It does not provide remote consensus or accept votes from external identity transports.
There are no additional NPM dependencies.

## Define current membership and required roles

Pass the database schema to `defineReviewedAction` so membership reads, preview and
execution retain their consumer types. This example assumes that trusted application
administration maintains a tenant-scoped membership table with a monotonic security
policy version and a unique membership incarnation. Its public CRUD API must not let
members grant themselves roles or change those authority fields.

```ts
import {defineReviewedAction} from '@clank.run/framework/reviewed-actions';
import {defineAuth,defineBackend,defineDatabase,defineTable,openBackend,s} from '@clank.run/framework';

const schema=defineDatabase({
  tasks:defineTable({done:s.boolean()}).owned(),
  members:defineTable({userId:s.string(),scope:s.string(),role:s.string(),
    incarnation:s.string(),policyVersion:s.string()}),
});
const scope='reviewed_workspace_01'; // Trusted application binding, never a browser claim.
const finish=defineReviewedAction(schema,{
  revision:'finish-v2',title:'Finish a reviewed task',
  args:s.object({id:s.id('tasks')}),previewDependencies:'records',
  authorize:({auth})=>Boolean(auth.user),
  preview:({db},{id})=>{
    const task=db.table('tasks').get(id);
    if(!task)throw new Error('Task not found.');
    return {id,before:task.done};
  },
  authorizeApproval:({db,auth})=>{
    const member=db.table('members').query().where('scope',scope)
      .where('userId',auth.user!.id).first();
    return Boolean(member && ['reviewer','operator'].includes(member.role));
  },
  approvalQuorum:{revision:'review-policy-v1',minimum:2,
    requiredRoles:['reviewer','operator'],separateRequester:true,voteTtlMs:300000,
    membership:({db,auth})=>{
      const member=db.table('members').query().where('scope',scope)
        .where('userId',auth.user!.id).first();
      return member?{scope,role:member.role,
        version:member.incarnation+':'+member._version,
        policyVersion:member.policyVersion}:null;
    }},
  execute:({db},{id},preview)=>{
    db.table('tasks').patch(id,{done:true});return {id,before:preview.before};
  },
});
const definition=defineBackend({schema,auth:defineAuth()}).functions(()=>({}));
const backend=await openBackend(definition,{
  path:'app.sqlite',reviewedActions:{actions:{finish}},
});
```

The requester needs current membership in the same scope; they need not have an
approver role. Keep the scope and security-policy version consistent across all
members of that policy. Never reuse a removed membership incarnation, reduce its
policy version, derive roles from `AuthState` JSON, or query an external service from
the resolver. Identifiers and versions are bounded plain tokens up to 200 characters.

Both `membership` and `authorizeApproval` run synchronously with current native
authentication and scoped read-only database access. Membership must actually read
through `context.db`, retaining 1–128 generated-table dependencies. A Promise or
untracked constant cannot establish approval authority. A table query conservatively
tracks the visible table, so membership changes can invalidate other recorded votes.
Use bounded point reads when your membership schema supports them.

Applications bound through `openBackend.organizationSecurity` also apply their
current native [organization security policy](organization-security-policies.md) to
the requester and every approver. The membership resolver must return the current
security-policy version from its trusted native adapter. Policy tightening invalidates
identity dependencies and can require a new preview or new authentication. A direct
`openReviewedActions` integration must bind native auth to this database and configure
`authorizeCaller` to enforce its current organization-security controller.

## Human votes and commit

The agent or application requests the usual `review.plan.ACTION` plan. Authorized
humans inspect its preview at `/__clank/approvals`, then submit native approve/deny
forms with their current session and CSRF proof. The browser inbox shows recorded
vote progress, required roles and expiry. It uses ordinary keyboard-accessible HTML
controls and does not require JavaScript. Its displayed recorded count is historical
progress; commit always checks current authority again.

Quorum policies require 2–8 distinct humans. Each person supplies one current role,
and each required role must be represented; a second session for the same person
does not create a second vote. `requiredRoles` is a unique list no longer than
`minimum`. Requester/approver separation defaults to enabled and applies to denial
as well. Set `separateRequester:false` only when your reviewed business policy allows
self-voting. Machine principals, OAuth grants and sessionless identities cannot vote.
They do not inherit a human session through a serialized object.

Repeating an unchanged valid vote for the same person and plan returns the current
plan without adding a vote or event. That covers a lost response. A stale or expired
vote requires another current human review; it may replace that person's retained
vote but never increases the distinct count. A denial is terminal. A plan retains at
most eight actor entries, including expired entries; request a new preview if that
capacity is reached. Vote lifetime defaults to five minutes, accepts one second to
one day, and never outlives the plan's own deadline.

The requester calls the established `review.commit` tool or `backend.reviewedActions.commit`.
The native transaction verifies the current action/policy revision, requester access,
preview dependencies, scope, all qualifying native sessions, role requirements,
membership incarnations, security-policy versions and expiry. Revoked or expired
sessions and removed/rejoined members cannot contribute. Relevant generated-table
changes and journal-retention gaps conservatively invalidate votes, including a role
change followed by restoration to its previous value.

Synchronous execution receives the existing recording writer. The transaction checks
approval authority again after execution and after storing the receipt/event, so an
execution-time membership change cannot authorize its own commit. Transaction-local
dependency checks see pending native writes before the change journal flushes. An
action that changes an approval dependency therefore fails conservatively; redesign
that operation as a separately reviewed action. All callbacks must avoid external
effects. Use the existing transactional job/outbox mechanism for later external work.

The application write, vote consumption, exact result receipt and audit event commit
together. Ignored or altered native acknowledgment writes cause rollback. Retrying a
consumed plan returns its exact receipt after checking the requester's current access;
it never executes again. The representative `approvedBy` field is retained for
compatibility and does not replace the required distinct quorum.

## Restart, migration and rollback

Opening the controller retires every previously live quorum vote. Plans, historical
votes, events and exact committed receipts remain durable; pending quorum plans need
new current human votes after restart. This is conservative authority retirement,
including after a crash or failed expiry transaction. A running controller's observed
clock never decreases, even when a denied transaction rolls back. A wall-clock rollback
and subsequent reopening cannot revive a prior vote. Single-approver actions keep
their existing restart behavior. The same retirement applies when another controller
opens against this store; stage process restarts before asking people to vote again.

Migration adds nullable quorum metadata to existing plans plus bounded protocol/state
and vote tables. The application table names `reviewed_votes` and
`reviewed_quorum_state` are reserved for this native metadata. Existing plans are
not silently upgraded to quorum. Unknown retained
protocols fail closed without deleting evidence. Change the quorum's `revision` whenever
its roles, resolver semantics or separation rules change. Changes to the action still
require its existing action revision. Pending plans cannot be reinterpreted after
disabling or replacing a quorum configuration.

The legacy `approved_session` column remains null for quorum approvals, so an older
single-approver binary cannot consume them as one person's approval. A native SQLite
trigger rejects non-null legacy session updates and removal/replacement of retained
quorum metadata, including attempts by an older decision path. Before downgrade,
quiesce reviewed operations and close pending quorum plans through the current binary.
Retain native historical evidence and committed receipts; do not manually manufacture
legacy session fields. Terminal-plan cleanup removes its votes under the existing
bounded reviewed-action retention policy.

Quorum receipts advertise `compensationAvailable:false`, and direct compensation
returns `QUORUM_COMPENSATION_REVIEW`. Define a compensation as another reviewed quorum
action with its own current preview and votes; it cannot inherit the original votes.
Existing non-quorum compensation remains unchanged.

Native authentication, SQLite mutation/replay, revocation, policy-tightening and
restart checks are separate from browser and production acceptance. Native fixtures
and rendered inbox HTML do not certify physical authenticators, real keyboard/focus
interaction or production host behavior. Check the current implementation ledger for
the feature's remaining acceptance evidence.
