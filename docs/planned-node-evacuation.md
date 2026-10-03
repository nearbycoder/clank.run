# Planned provider node evacuation

A platform administrator can move a reachable provider node's deployed SQLite projects onto other healthy nodes. This is a maintenance operation with downtime: the source web process, workers, and scheduler stop before the final snapshot. Existing generations never restart on the source. Configure managed ingress, provider placement, encrypted backups, and enough compatible capacity on other nodes before starting.

The provider must run the current complete provider service, including its authenticated evacuation control endpoint. A provider bridge that only supports ordinary live snapshots cannot prove that all writers stopped and is rejected. External processes writing the same SQLite file outside the managed provider runtimes are unsupported.

## Review a plan

Use an authenticated platform administrator browser session, the matching `x-clank-csrf` header, and same-origin requests. Platform API keys and project tokens cannot administer this operation. When `freshAuthentication.required` is configured, complete a fresh passkey or MFA challenge first. Otherwise the session must have been created within the past 30 minutes.

```http
POST /api/admin/runners/source-node/evacuations
Content-Type: application/json
x-clank-csrf: <session-csrf>

{"confirmation":"evacuate source-node"}
```

The response contains a durable `plan` with its ID, source node, exact project/release/generation list, and `state: "planned"`. Planning supports 1–100 deployed projects with databases. It checks source health, stable running generations, target labels, region, and process capacity. The source must have no additional running placements outside the plan. Capacity is checked again when execution starts; it is not reserved during review.

Review the response, or read it using `GET /api/admin/runners/source-node/evacuations/<plan-id>`. The collection GET lists the newest 20 plans. While a plan is unfinished, normal mutations of its projects are blocked, including deployments, secret changes, and destructive operations. Only one unfinished plan per source is allowed.

## Execute and resume

```http
POST /api/admin/runners/source-node/evacuations/<plan-id>/run
Content-Type: application/json
x-clank-csrf: <session-csrf>

{"confirmation":"<plan-id>"}
```

Execution drains new placement from the source. For each project, the provider writes a private, fsynced evacuation barrier, removes ingress, and stops every managed runtime. It verifies that no runtime remains before taking the exact generation's final snapshot. The platform checks the response's plan, release, generation, digest, and writer-stop proof, encrypts the backup, and verifies that the encrypted copy restores successfully.

Only after every project's final backup is recorded does the platform revoke the source node's credentials and start the existing fenced-source failover workflow. Each target receives a replacement database capsule bound to that final backup; it must activate successfully before the project is marked relocated. Current administrator authority, project leases, source identity, and recovery lineage are checked throughout. A durable renewable execution lease prevents simultaneous runs.

A failed operation becomes `paused`. GET the plan to see its phase, stored backup IDs, completed target generations, and a bounded error summary; administrator audit events record planning, source snapshots, fencing, cancellation, and completion. Correct the provider transport, capacity, or target activation failure, then POST the same `/run` request. Completed projects are not moved twice, and completed plans return their stored result. Process restart retains the plan, source barriers, and snapshots. A crashed execution lease expires after 30 seconds before another run can claim it. Active-plan final backups are excluded from ordinary backup retention pruning.

A lost or rejected snapshot proof never permits target recovery. If a request times out after stopping the source, retry the same plan: the durable source barrier prevents accidental restart and permits an authenticated retry for that exact generation. Older providers fail before authorizing target placement.

## Cancellation and rollback boundaries

A plan can be cancelled only before execution reaches source quiescing:

```http
POST /api/admin/runners/source-node/evacuations/<plan-id>/cancel
Content-Type: application/json
x-clank-csrf: <session-csrf>

{"confirmation":"<plan-id>"}
```

After quiescing begins, recovery proceeds forward by resuming the plan. Automatically restarting a donor after a target may have accepted writes would create two independent writers. The source therefore remains fenced even if snapshot creation or target activation fails. Reversing a completed move requires a new controlled migration or the documented backup recovery workflow, using the current authoritative database.

Retire or explicitly clean up the evacuated source under your provider operations procedure. Do not remove its evacuation barrier, copy its stale database back into service, or re-enroll the unchanged source data directory. This release does not provide automatic source re-enrollment or a zero-downtime handoff. Unreachable sources use the existing explicit provider failover/recovery procedure instead of planned evacuation.

## Upgrade and restore

Startup creates the evacuation plan table and its one-active-plan-per-node index. Upgrade the source provider service before planning and preserve its private `service/*.evacuation.json` files through restarts and backups. Retain the control-plane database and encrypted final backups together. Do not downgrade either component while an evacuation is unfinished: older code does not enforce the durable source barrier or project freeze. A control-plane restore must be reconciled against actual target generations and source barriers before allowing any writer to start.
