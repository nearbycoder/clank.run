# Project service objectives and error budgets

Project operators can define request-success and completion-latency objectives, inspect rolling request budgets and retain burn alerts. Open **Service objectives** in a project's console navigation, or use the same project-scoped REST contract through `createProjectSloClient`.

An objective measures terminal outcomes observed by Clank's native managed ingress. It is not an external uptime measurement. Traffic that never reaches this ingress, time when collection is unavailable, and unfinished requests are outside the completed observation cohort. Missing observations cannot establish compliance. Existing descriptive metrics and their percentile estimates remain separate.

## Choose an objective

A request-success objective counts a terminal response as good only when its body completed and its status was 200–399. Errors, cancelled bodies, unsuccessful statuses and native admission denials count as unsuccessful terminal outcomes. A completion-latency objective counts a completed response within its declared duration boundary as good; its status is independent of that latency objective. Configure both policies when both success and latency matter.

Latency boundaries are 50, 100, 250, 500, 1,000, 2,500 and 5,000 milliseconds. The collector records exact cumulative counts at those boundaries, rather than inferring a good-request fraction from a percentile. Completion time selects the measurement minute; a long request does not amend a previously closed request-start minute.

Targets use integer basis points from 9,000 to 9,999, corresponding to 90% through 99.99%. Choose a rolling window of five minutes, one hour, one day or seven days, a minimum from one to 1,000,000 observed terminal requests, and a burn threshold from 1 to 1,000. The window ends at the most recent closed UTC minute. Names are limited to 160 UTF-8 bytes. The console previews the configured values and shows the latest measurement arithmetic before an operator replaces a policy.

Creating or changing a policy requires a fresh complete window after that policy revision. Changing a target does not retroactively certify an older window. Disabling a policy stops its burn evaluation; it does not claim that the service recovered.

```ts
import {
  createProjectSloClient,
  type ProjectSloConfiguration,
} from "@clank.run/framework/project-slo";

const client = createProjectSloClient({ auth });
const configuration: ProjectSloConfiguration = {
  name: "Checkout successful responses",
  objective: { kind: "request-success" },
  targetBasisPoints: 9900,
  windowMinutes: 60,
  minimumRequests: 100,
  burnThreshold: 2,
  enabled: true,
};
const policy = await client.create(projectId, {
  configuration,
  operationId: crypto.randomUUID(),
});
const assessment = await client.read(projectId, policy.id);
```

For a CLI integration, resolve its current scoped credential through `headers()` for each request. The browser-safe client resolves current CSRF headers, bounds requests to 16 KiB and responses to 1 MiB, refuses redirects and bounds both fetch and body intake even when a transport ignores cancellation. Its default timeout is ten seconds, configurable from 500 milliseconds through thirty seconds. It never retries a mutation automatically.

## Inspect the arithmetic and coverage

The console and client expose observed requests, good and unsuccessful counts, expected and complete measurement minutes, the allowed unsuccessful-request budget, remaining budget and burn rate. The arithmetic is:

```text
bad = observed requests - good requests
allowed bad = observed requests × (10,000 - target basis points) / 10,000
remaining budget = allowed bad - bad
burn rate = bad / allowed bad
```

For 1,000 observations and a 99% target, ten unsuccessful requests consume the entire request budget. Twenty unsuccessful requests have a burn rate of two. Fractional request budgets remain fractional; rounding the displayed value does not change evaluation. A complete window can exhaust its budget without reaching a higher configured burn-alert threshold.

`evaluateProjectSlo(configuration, buckets, until)` provides the same deterministic arithmetic for bounded replay or agent inspection. It validates unique aligned minutes, safe counts and monotonic cumulative histograms. Its inputs contain seven latency counts and only operational counts; they contain no request bodies, URLs or credentials. Duplicate, out-of-window or malformed measurements fail explicitly.

An empty or low-traffic window returns `insufficient-data`. A missing or partial minute also returns `insufficient-data`, even when the observed request fraction looks favorable. In those cases, budget allowance, remaining budget, burn rate and the burn decision are `null`. Observed counts remain visible and are not presented as compliance.

The durable collector writes explicit zero buckets only after it observed a full minute for an enabled objective. Deleting a required bucket therefore produces missing measurements; an absent row is never silently substituted for an observed zero. Collection begins with a partial minute and establishes coverage only for subsequent complete minutes. Recording failures, capacity exhaustion, heartbeat gaps, clock discontinuities, overlapping collectors and restarts invalidate affected coverage. A sole collector uses a persisted owner and epoch inside the same transactional control store. A stale collector cannot record alongside another registered collector. Multiple active ingress coordinators against this control store make coverage unavailable; this does not provide supervisor leadership or multi-region consensus.

The default heartbeat is one second, configurable from 100 milliseconds to five seconds. A gap beyond three heartbeat intervals, or a mismatch between wall and monotonic elapsed time, starts fresh incomplete coverage. Metrics are observational: a recording failure does not interrupt application traffic or deny admission.

## Burn alerts and incident references

Complete sufficient measurements at or above the configured burn threshold create or open a retained alert. Later sufficient measurements below the threshold resolve it. Incomplete measurements move it to `unknown`, retaining its identity rather than claiming recovery. Disabling its policy marks it `disabled`. Alert metadata identifies the project, policy and current policy version, transition version and observation time.

Background evaluation sweeps at most ten policies per heartbeat. A larger policy inventory therefore takes multiple passes; inspect the evaluation's window and alert observation time. Reading an objective evaluates its current window immediately. The initial delivery retains burn metadata and does not send external notifications or change traffic admission.

Copy the displayed alert ID into an `alert` reference in the [incident workspace](project-incidents.md). Incident diagnostics retain only scoped metadata. Reading or changing that reference requires the additional diagnostic permission; another project's alert is unavailable. Unknown or disabled SLO alerts project as unknown diagnostic state and do not establish incident recovery.

## Permissions, versions and uncertain responses

Reading objectives requires current project `read` authority. Policy mutations require the dedicated project `slo` permission, which owners and administrators receive by default. Other roles need an explicit grant. Project-scoped tokens need the same permissions. Support impersonation remains read-only.

Every operation checks the current session or exact presented token, membership, permission and persisted protocol. Mutations repeat those checks after body intake and inside the policy/receipt/audit transaction. Rotating a token during a held request invalidates that request. A failed audit rolls back both the policy and receipt.

Changes require `expectedVersion` and a new `operationId`. The receipt binds its exact normalized configuration to the actor, project and operation ID. An exact historical retry returns its original acknowledgement after revalidating current authority. It never replaces a newer configuration. Reusing the operation ID for a different change fails. A stale expected version fails instead of overwriting a newer policy.

After a lost response, inspect current state before explicitly retrying the exact change. The console retains the original expected version and request identity, then reads current state after a historical acknowledgement. Refreshing measurements preserves an unsaved edit's original version; select the objective again to review the new configuration before discarding or replacing that edit. Switching accounts/projects or losing access clears private objective state and cancels queued confirmations. Draft navigation uses the shared accessible in-page confirmation dialog.

## Bounded storage and deployment

`openPlatform({ slos: { ... } })` accepts `maxPolicies`, `maxReceipts`, `maxBuckets` and `heartbeatMs`. Defaults are 1,000 total policies, 10,000 retained mutation receipts, 200,000 measurement buckets and a one-second heartbeat. Each project has at most ten policies. New policies and changes reserve their enabled project windows plus two boundary minutes against measurement capacity; an oversized configuration fails before mutation. Retention follows each project's longest enabled window plus two minutes, with an absolute eight-day ceiling. Coverage is bounded to that ceiling. Exact retained retries remain valid when mutation capacity is full; new effects are refused.

Managed ingress must be enabled to collect observations. With ingress disabled, objective administration is available and measurements remain insufficient. The collector stores only completion counts and histogram boundaries in additive protocol-versioned control SQLite tables. Policy configurations, exact receipts, coverage epochs and alert metadata are private control state. Existing application schemas and descriptive metric records are unchanged. There are no additional NPM dependencies.

Unknown persisted protocols reject startup and current operations before altering SLO tables. Back up the control database before a rollback or schema removal. An older release may leave this new state untouched; it cannot certify a newer protocol or reconstruct lost measurements. Restore the matching application version and control-store backup together when recovering policy administration.
