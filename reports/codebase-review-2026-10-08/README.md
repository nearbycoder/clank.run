# Clank codebase review

Reviewed October 8, 2026 against `4b990199965204f1200fcd0fb4ca2b7eb0b02bbc`, the freshly fetched `origin/main`. The checkout already matched that commit, so no merge was needed. The review and roadmap are on `codex/codebase-review-forty-features-2026-10-08`.

Clank 0.24.0 has a broad, well-tested runtime and a substantial deployment platform. It is ready for continued controlled evaluation, with useful primitives for application development, agents, and operations. The main engineering needs are semantic type checking, bounded retention in newer data services, permission-aware search, and successful deployment verification. The next feature cycle should deepen these existing workflows before expanding the platform's operational scope.

This document preserves the findings and validation at the reviewed main commit. The [implementation ledger](IMPLEMENTATION.md) records the subsequent fixes, new features, current verification and hosting limitation. The [40 feature plan](FEATURE_PLAN.md) describes new capabilities separately from the fixes below. [Structured verification](verification.json), [reproduction output](reproduction.json), and a [disposable reproduction script](reproduce.mjs) accompany this review.

Twenty-three features are merged across twenty feature batches; seventeen remain. [Durable workflow waits (19)](workflow-waits.json) merged in [PR #295](https://github.com/nearbycoder/clank.run/pull/295) after both complete Node 26/22 release checks, all six fresh hosted checks and a protected expected-head squash. Accepted commit `e058e72015f890f15858efc8f96ce2390602d542` exactly matches reviewed tree `607d47ea4580bcb193923a48f306e3035aae0cc9`; both main checkouts match it and all 23 existing local files are preserved. The original checkout had already moved to main; its earlier mobile branch reference is absent, and our synchronization changed no other branch reference. Workflow compensation (20), under [proposal #296](https://github.com/nearbycoder/clank.run/issues/296) and draft [PR #297](https://github.com/nearbycoder/clank.run/pull/297), passes complete final Node 26/22 release checks, all 70 focused checks, 31 packed fixtures and actual documentation/browser/process acceptance; final hosted checks, author COMMENT and protected merge remain required. Feature 20 is not counted yet. Production Railway remains uncertified; earlier snapshots retain their original scope.

[Verified identity linking (11)](identity-linking.json) is merged in PR #285. [Scoped provisioning (12)](scim-provisioning.json) is merged in PR #289. The package after the separately verified credential-fencing repair is 405 files / 6,194,050 unpacked bytes, with 97,406 bytes below the unchanged 6 MiB ceiling.

## Follow-up review of merged main

The maintenance pass starts from `1e6e62acbf2e59400c023bd3a33125fe1fc2c7d4`, after PRs #245–247 merged. Fresh fetches confirmed that the checkout matched remote main. It reviews Task cancellation and cleanup, auth guards and account changes, delivery retries/revocation, Fetch/Node error handling, and selected data, storage, recovery and release boundaries. Whole-source semantic analysis and the complete release gate supplement these targeted manual reads; this is not a claim that every implementation line was independently audited.

Confirmed fixes preserve the first `Task.all` failure, await timed-task cleanup during parent cancellation, retain timeout cleanup defects, and release completed child cancellation listeners. Webhook and notification keys now reject changed content instead of silently discarding a different event. Webhook dispatch rechecks owner availability after asynchronous signing-key resolution. Account security clears private inventory and form state on account/session changes and discards stale replies. Anonymous in-process callers implement `requireVerified()`, and failed synchronous or asynchronous error observers cannot prevent Fetch/Node error responses.

The type baseline is reduced from 290 to 278 diagnostics by retaining the webhook schema type, correcting optional history ownership, and preserving performance-resource types through freezing. No new baseline allowances, dependencies, wire formats or database migrations are introduced. Existing identical delivery retries remain valid; applications that reuse a retained key for different content now receive an error and must choose distinct event keys. Final validation and the remaining source-type backlog are recorded in [maintenance review](maintenance-review.json).

Full-suite fault checks also exposed two fixture timing defects. Canary rollback verification now waits for the restored worker's initialization marker before requiring exactly one active worker. Real network namespace probes use the same two-second observation window for allowed and denied destinations, with an enclosing forty-second test budget. Baseline reachability, public allowlisting, private/host blocking and policy cleanup must all still pass; neither isolation enforcement nor privileged-test admission is bypassed.

Final local verification passed: 1,657 tests reported, 1,654 passed, zero failures/cancellations and three expected privileged-host skips. Coverage is 91.96% lines, 79.69% branches and 89.86% functions. All 126 focused tests passed, as did the pinned semantic gate with 278 existing diagnostics and all 13 packed consumer fixtures. Documentation, package conformance, the unchanged dependency contract and package/tree/history security checks passed. The publish allowlist remains 393 files within the existing 394-file / 6 MiB limits. The current Railway host's namespace restriction still prevents deployment certification.

## Auth and job continuation

The next maintenance pass starts from merged main `59bf25908864112ab733ba09a01cb9fea34b904d` (PR #248).
Controlled regressions reproduce delayed auth snapshots restoring a logged-out account, an initial
lookup failure clearing a later login, stale MFA challenges, and job contexts writing/enqueuing
after timeout, cancellation, lease replacement or completion. Separate regressions reproduce
unhandled rejections from backend and job error observers.

The fixes fence client state by the newest auth intent, eligible snapshot and account/session;
passkey flows stop before finishing against another identity. Job database writes and child/workflow
publication validate the current claim under SQLite's write lock, preserving atomic rollback with
application writes. Auth, backend and job error observers contain synchronous throws and rejected
promises; a failed job observer no longer suppresses the backend observer. These are local state
and SQLite safeguards; browser cookies and external API effects remain separate boundaries.

All 88 focused checks pass. The pinned semantic gate drops from 278 to 246 existing diagnostics,
removing all 32 diagnostics in `jobs.ts` while preserving public declarations and all 13 packed
consumer fixtures. No allowances, dependencies, wire formats or database migrations are added.
The complete release gate passes with 1,679 tests reported, 1,676 passed, zero failures/cancellations
and three expected privileged-host skips. Coverage is 92.07% lines, 79.72% branches and 90.03%
functions. Package, dependency, documentation, conformance and security checks pass. The
[continuation review](continuation-review.json) records complete release results and scope.
This pass adds no new roadmap feature; six remain implemented and thirty-four planned.

## Storage and runner continuation

This review starts from freshly fetched main `7aeedc7d8c82575541672f55e853613d5a9fedd9`,
after PR #249 merged. It fixes mutable object-write inputs, Blob upload options and CSRF capture,
invalid resumable progress, S3 body deadlines and transport-error redaction, unread response
cleanup, non-byte object inputs, and artifact/runtime bytes changing during lease revalidation.
Bucket, coordinator and runner-agent error observers now contain rejected promises.

All 80 focused tests pass. Source diagnostics decrease from 246 to 163, resolving all 83
diagnostics in buckets, object storage and runner code without new baseline allowances. Public
declarations, wire formats, persistent schemas and the zero-dependency contract are preserved.
The full release gate passes with 1,705 tests reported, 1,702 passed, zero failures/cancellations
and three expected privileged-host skips. Coverage is 92.09% lines, 79.78% branches and 90.04%
functions; documentation, package conformance and security checks pass. The
[storage and runner review](storage-runner-review.json) records validation and remaining limits. This maintenance batch adds no roadmap feature: six remain implemented and
thirty-four planned. Hosted deployment and disposable Docker/XFS certification remain separate
requirements.

## Current implementation

| Area | Implemented capability | Remaining boundary |
| --- | --- | --- |
| Reactive UI | Fine-grained reactivity, direct DOM updates, keyed collections, SSR and hydration, forms, headless controls, virtual collections, localization | Consumer contract testing and source typing need a stronger continuous gate. |
| Application data | SQLite transactions, owned rows, revisions/history, selective live queries, resumable sync, offline mutation receipts, durable imports, FTS search, shared text editing | PostgreSQL is an external driver rather than a transparent replacement for the generated backend. New metadata services need retention controls. |
| Identity and teams | Sessions, CSRF, password recovery, MFA, passkeys, organization roles, invitations, scoped tokens, OIDC sign-in and offboarding | Enterprise identity linking, standardized provisioning, and organization policy administration need explicit contracts. |
| Agent workflows | Typed manifests, per-app OAuth/MCP, MCP Apps, activity records, durable reviewed actions, receipts and compensation hooks | Multi-approver decisions, operation budgets, and durable waits across workflows remain opportunities. |
| Deployment and recovery | Verified artifacts, migrations, encrypted backups, local managed canaries, provider placement, leases/fencing, remote jobs, provider recovery, planned node evacuation, PITR primitives | One active built-in supervisor per project/data directory; planned evacuation can involve downtime; provider canaries and automatic control-plane leadership are not complete product workflows. |
| Operations | Logs, traces, metrics, error inbox, alert rules, usage forecasts, quota admission, runner diagnostics, storage cleanup, deployment comparisons | Target-host certification and a successful rollout must accompany source validation. Multi-region consensus remains a separate architecture decision. |
| Developer experience | Zero-dependency build/CLI, executable blueprints and recipes, DevTools, schema/contract workbench, documentation and Design Studio | Some historical documentation describes capabilities that have since shipped. Runtime build success does not establish semantic TypeScript correctness. |

The repository contains 140 implementation files and 95,732 implementation lines under `src`, 117 declaration files, 145 package export entries, and 218 `tests/*.test.mjs` files. There are no NPM runtime, development, peer, or optional dependencies. `platform.ts` contains 16,059 lines, about 16.8% of the implementation. That concentration makes deployment and permission changes expensive to review; extract a boundary when a concrete change needs it, rather than scheduling a wholesale mechanical split.

## Validation and rollout status

The complete local `npm run check` passed on Node 26.10.0: 1,607 tests were reported, 1,604 passed, zero failed or cancelled, and three were skipped. Coverage was 91.89% lines, 79.37% branches, and 89.69% functions, above the enforced 80/65/80 thresholds. Framework, documentation, Design Studio and Synth builds, runnable documentation, declaration/export integrity checks, packed-release conformance, and package/tree/history security checks passed.

The three skipped tests require a disposable XFS mount or an explicitly enabled disposable Docker environment. This run therefore does not establish fresh XFS quota enforcement or real Docker isolation/crash cleanup. Those scenarios have historical evidence in the repository, but should be exercised again for a release that changes the relevant boundaries.

The strict semantic project check failed with **290 TypeScript diagnostics**, using an externally installed TypeScript 5.9.3 compiler and Node declarations that include `node:sqlite`. An initial check with older Node declarations produced 293 diagnostics; the 290 count excludes that avoidable declaration mismatch. The failure includes branded ID mismatches, implicit `any`, generic query-field errors, and unknown-property accesses. It is source typing debt; it does not by itself prove every published declaration or runtime path is broken.

GitHub [CI](https://github.com/nearbycoder/clank.run/actions/runs/37149966835), [CodeQL](https://github.com/nearbycoder/clank.run/actions/runs/37286115756), and [documentation rollout verification](https://github.com/nearbycoder/clank.run/actions/runs/37150204514) succeeded for the reviewed main commit. The [Design Studio deployment](https://github.com/nearbycoder/clank.run/actions/runs/37150204531) failed with `DEPLOYMENT_FAILED`: `SQLite task exited before completing (resource limit or worker failure).` Its log does not identify the exact cause. Resolve that rollout and verify the served version before describing all surfaces as deployed from current main. The latest GitHub release inspected is [v0.24.0](https://github.com/nearbycoder/clank.run/releases/tag/v0.24.0).

This is a source and release-evidence review. It did not rerun production load tests, alter hosted infrastructure, certify production backup recovery, or perform a new independent CodeQL scan. Green CodeQL workflow completion also does not mean the repository has zero findings; the previous detailed scan documents remaining triage.

## Actionable findings

### P2 Search candidate limits precede record authorization

[`search.ts:38`](https://github.com/nearbycoder/clank.run/blob/4b990199965204f1200fcd0fb4ca2b7eb0b02bbc/src/search.ts#L38-L54) limits raw FTS matches and then applies `authorizeRecord`. If the earliest matching records are inaccessible, later accessible matches never reach ranking. The response's `truncated` flag also depends on inaccessible matches: with a candidate limit of one and no readable records, adding a second denied match changes it from false to true.

The disposable reproduction shows zero hits when a denied match precedes a visible match; removing the denied match makes the visible record appear. The default limit of 5,000 postpones this boundary but does not remove it. No denied document text or ID is returned by this reproduction.

**Fix:** partition candidate retrieval by current access where possible. If arbitrary policies require scanning, define a separate bounded scan budget and an explicit incomplete-result contract; do not present hidden-corpus-derived counts or truncation as authorized result metadata. Test a denied prefix larger than the candidate window, current ACL revocation, and identical authorized results under changes to a hidden corpus.

### P2 Collaborative edit receipts grow without an admission or retention limit

[`collaborative-documents.ts:36`](https://github.com/nearbycoder/clank.run/blob/4b990199965204f1200fcd0fb4ca2b7eb0b02bbc/src/collaborative-documents.ts#L34-L37) creates a persistent receipt table; each new edit adds a receipt while only operation history is pruned at [line 66](https://github.com/nearbycoder/clank.run/blob/4b990199965204f1200fcd0fb4ca2b7eb0b02bbc/src/collaborative-documents.ts#L62-L66). There is no receipt TTL, maximum entry count, or cleanup API. With `retainedOperations: 2`, eight edits retain two operations and eight receipts. Long-lived documents keep accumulating metadata even when their text and rebase history remain bounded.

**Fix:** add per-document/per-user and application admission limits plus a documented replay horizon. Preserve rejection of expired operation IDs; merely deleting receipts can allow an old no-op or otherwise still-applicable request to execute again. Add restart, expiry-boundary, capacity, and old-retry tests before changing the protocol.

### P2 Cancelled and completed imports retain full payload chunks indefinitely

[`durable-import.ts:48`](https://github.com/nearbycoder/clank.run/blob/4b990199965204f1200fcd0fb4ca2b7eb0b02bbc/src/durable-import.ts#L45-L49) limits only nonterminal jobs. [Cancellation](https://github.com/nearbycoder/clank.run/blob/4b990199965204f1200fcd0fb4ca2b7eb0b02bbc/src/durable-import.ts#L96-L100) changes state without removing uploaded chunks, and completion similarly preserves them. The public service has no terminal cleanup operation or aggregate byte/entry bound. The reproduction creates and cancels 22 one-row imports despite the active limit of 20, retaining all 22 payload chunks.

**Fix:** retain a small terminal receipt for retry identity while retiring payload bytes after a configured window; provide a bounded purge and aggregate admission accounting. Preserve exact retry behavior during the documented resume window, and test cancellation, completion, restart, failed cleanup, and replay after payload expiry.

### P2 Semantic type checking is outside the continuous release gate

The [build](https://github.com/nearbycoder/clank.run/blob/4b990199965204f1200fcd0fb4ca2b7eb0b02bbc/scripts/build.mjs#L31-L41) strips TypeScript, while [CI](https://github.com/nearbycoder/clank.run/blob/4b990199965204f1200fcd0fb4ca2b7eb0b02bbc/.github/workflows/ci.yml#L51-L80) runs runtime tests and the existing release gate. The [declaration audit](https://github.com/nearbycoder/clank.run/blob/4b990199965204f1200fcd0fb4ca2b7eb0b02bbc/scripts/docs-audit.mjs#L59-L72) establishes that checked-in declarations were copied faithfully; it does not compare their semantics with the implementation. The current strict check has 290 diagnostics even though the runtime gate passes. This limitation is documented and predates this review.

**Fix:** provision a pinned compiler outside the framework package, establish a normalized baseline with no new diagnostics, and add positive/negative fixtures against the packed consumer declarations. Then remove the baseline errors in bounded areas until strict checking is green. Keep the zero-dependency runtime contract intact.

### P3 Search ranking and snippets disagree with FTS diacritic matching

SQLite's `unicode61` tokenizer retrieves `Café` for `cafe`, but [ranking and snippet placement](https://github.com/nearbycoder/clank.run/blob/4b990199965204f1200fcd0fb4ca2b7eb0b02bbc/src/search.ts#L47-L51) use unnormalized string matching. The reproduction returns a real match with score zero and a snippet that omits the matching word. Case folding and token normalization should be consistent with retrieval, with offsets mapped back into original text.

**Fix:** share a deliberate normalization strategy across query parsing, scoring, and snippet location. Test accents, combining marks, case expansion, and title-only/body-only matches without changing authorization ordering.

### P3 The historical code audit presents obsolete limits as current

[`docs/code-audit.md:116`](https://github.com/nearbycoder/clank.run/blob/4b990199965204f1200fcd0fb4ca2b7eb0b02bbc/docs/code-audit.md#L114-L123) says no virtualized list is included and identifies remote secret/data delivery as future work. `virtual-collections.ts` and the provider runtime/data/service modules now implement relevant capabilities. The page has an August audit date but also contains later additions, so readers cannot reliably treat every limitation as an August snapshot.

**Fix:** retain the historical record with explicit dated scope, and link a current capability/operational-limit ledger. Reconcile current guides with shipped modules rather than deleting meaningful past audit evidence.

## Recommended work before expansion

1. Diagnose the failed Studio rollout in its actual hosting environment and verify the published revision.
2. Fix search candidate authorization and establish explicit retention/replay policies for collaborative receipts and terminal imports.
3. Add the semantic type baseline and packed-consumer fixtures to CI, then reduce source diagnostics by module.
4. Reconcile the current capability ledger and refresh the affected operational documentation.
5. Start the first ten features in the roadmap through narrow proposals and small reviewed changes.

For new public APIs, schemas, authentication behavior, and deployment transitions, follow `CONTRIBUTING.md`: each proposal needs the user/agent workflow, minimal contract, authorization boundary, migration/rollback, alternatives, and acceptance evidence. The findings below remain historical; see the implementation ledger for the fixes now present on this branch.

## Reproduction

After building this implementation branch:

```sh
npm run check
node --disable-warning=ExperimentalWarning reports/codebase-review-2026-10-08/reproduce.mjs
```

The script creates synthetic users and disposable databases, verifies the four repaired behaviors, and removes its fixtures. `reproduction.json` preserves the original failing behavior; `fix-verification.json` records the current passing behavior.

The semantic check used a separately installed compiler, not a repository dependency:

```sh
node /path/to/typescript/lib/tsc.js --pretty false --typeRoots /path/to/current-node-types/@types
```

The original validation logs are retained at `/tmp/clank-review-2026-10-08/`; their hashes and summaries are recorded in `verification.json`. The roadmap is a prioritized engineering proposal, not a release-date commitment.
