# Changelog

Clank follows semantic versioning. Entries describe user-visible framework, CLI, protocol, storage, security, and deployment changes.

## Unreleased

- Added an integrated `clank dev` supervisor that runs the deployment-configured build and entry,
  watches relevant project files, health-checks replacements on private loopback ports, atomically
  swaps the local proxy, reloads connected browsers, preserves the last good process after build or
  candidate failures, bounds crash restarts and reload clients, and emits agent-readable
  `clank-dev-event/1` lifecycle records.
- Removed the browser package barrel's eager `node:fs/promises` import so generated module
  applications execute hydration instead of stalling while resolving a Node-only module.
- AI blueprints now generate every declared static route and entity instead of collapsing the
  contract to one primary table. Generated apps include SSR/hydration state per route, role-aware
  navigation and field forms, reference selectors, live subscriptions or request/response refresh,
  exact declared action names, sparse updates, and safe CRUD fallbacks shared by browser RPC and
  each app's OAuth-scoped MCP server.
- Blueprint relationships now resolve an explicit or unambiguous reference field and enforce
  bounded transactional `restrict`, `nullify`, and acyclic recursive `cascade` behavior. Invalid
  or other-owner reference inputs return a public bounded error; ambiguous relationship storage,
  cross-ownership deletion, non-nullable nullification, cascade cycles, empty role policies,
  reserved routes, and generated type-name collisions fail before generation.
- Generated service requirements now participate in startup and readiness. `clank dev` supplies
  explicit development-only placeholders, while production fails closed when a required driver
  has not been provisioned.
- Added bounded `BackendActionError` failures for intentional application guards. Their safe
  status/code/message survive browser RPC and MCP tool calls without reporting them as internal
  faults, while the surrounding mutation still rolls back atomically.
- Reworked the AI blueprint guide and generated project/agent READMEs to document exact action,
  relationship, route, service, authorization, and per-app MCP behavior plus unresolved boundaries.
- Select bindings now attach after their options, so programmatic resets preserve declared defaults
  and empty reference placeholders. Generated development servers also serve framework modules with
  revalidation instead of production's immutable cache policy.
- Generated route navigation now wraps on narrow viewports instead of clipping the active route.
  Shutdown closes live runtime streams alongside the HTTP server and service drivers so long-lived
  connections cannot stall process termination.

## 0.10.0 - 2026-07-30

### Added

- `clank templates --json` now exposes the versioned `clank-template-catalog/1` starter catalog,
  and `clank create --json` returns a `clank-create-result/1` project/file/next-command manifest.
  Scaffold names are now length/control bounded and inserted into TypeScript, TSX, and Markdown
  with context-safe encoding instead of raw placeholder replacement.
- Provider-hosted runtimes now expose a generation-bound private diagnostics surface. The complete
  provider keeps a 128 KiB/1,000-entry in-memory output tail, samples all current
  web/worker/scheduler containers through one bounded Docker stats call, and reports memory,
  memory limits, CPU, PIDs, network I/O, and block I/O without container IDs or environment
  values. The control plane authenticates the exact node/release/generation, refuses redirects or
  unbounded/malformed responses, rechecks placement after transfer, redacts project secrets, and
  shows provider resources and logs in the existing project UI.
- Provider-hosted recovery points can now be restored through the ordinary platform and CLI API.
  The control plane verifies the target, creates an encrypted provider safety backup, freezes the
  target ID/digest/size and safety ID into a durable replacement generation, and re-verifies the
  recovery point while building the private runtime capsule. The provider then drains the prior
  writer, takes its own exact safety snapshot, replaces SQLite, reapplies current migrations,
  health-checks the candidate, and publishes only the new generation.
- Provider restore timeouts resume the same durable intent without creating another safety copy.
  Failed exact operations can allocate a new monotonically fenced attempt only after both target
  and safety recovery points verify again. Pending retention protects both recovery points, queue
  and completion are audited, and successful completion keeps the ordinary immediate data
  rollback available.
- The built-in control plane now creates, schedules, lists, and verifies encrypted backups for
  provider-hosted projects. It binds export to the exact active pinned node/release/generation and
  allowlisted origin, refuses redirects and encoded/unbounded/mismatched responses, rechecks
  placement after transfer, and imports directly into local or S3-compatible encrypted recovery
  without plaintext disk staging.
- Brand-new provider projects now initialize their isolated SQLite database instead of incorrectly
  requesting preservation of data that cannot exist. Later and retry generations preserve the
  committed provider database.
- Runtime capsules can carry a distinct provider-control credential, and the complete provider
  service now exposes a private, generation-bound consistent SQLite snapshot endpoint. The
  credential is retained only as an in-memory digest, never shares public-ingress authority, and
  is revoked on drain, stop, failure, deletion, close, or restart until exact reconciliation.
- Encrypted recovery repositories can now import a bounded consistent SQLite byte snapshot without
  a local live-database path or plaintext staging file. Authenticated bounded reads make the same
  recovery point available to a fenced remote restore capsule, including through chunked
  S3-compatible object storage.
- The built-in control plane can now opt immutable projects and inherited previews into stateful
  provider placement. It freezes encrypted generation inputs, emits sensitive capsules only to a
  current lease, publishes only exact allowlisted observations, resumes pending deploys, supports
  fenced code/data rollback, survives restart, and confirms provider deletion before removing
  metadata. Local placement remains the default and existing projects never move.
- The CLI and control-plane project dialog expose explicit `local | provider` creation. Persisted
  deploy-attempt keys now survive provider-pending responses so an exact retry cannot create a
  duplicate release.
- A packaged `clank-provider` process runs the complete Docker provider lifecycle bridge and
  generation-bound private runtime ingress with environment-only resource and trust-boundary
  configuration.
- Deployment desired state now distinguishes portable from stateful placement. Stateful projects
  reserve one node identity across releases, stopped state, expiry, and credential revocation;
  unsafe implicit failover, mode changes, and pinned-region changes are rejected.
- Desired placement can durably require a private node endpoint and exact capability labels.
  Delayed placement keeps those constraints, and assigned nodes cannot shed required capabilities
  through heartbeat or credential rotation.
- A complete zero-dependency `@clank.run/framework/provider-service` composition now binds
  independently verified runtime capsules, durable operation/generation/fence intent, provider
  data recovery and migrations, isolated Docker activation, stopped desired state, and
  generation-bound private ingress. Exact response-lost and restart retries recover without
  process adoption; failed post-commit activation removes the candidate and remains retryable.
- The complete provider service now owns fenced rollback and confirmed project deletion instead
  of requiring callers to reach beneath a live runtime boundary. Both operations revoke traffic,
  drain requests, stop every writer, persist restart-safe destructive intent, and resume safely
  when a process exits after the data commit point.
- Provider agents and the authenticated HTTP bridge now carry canonical `rollback` and `delete`
  operations to those lifecycle methods. Confirmations are derived after lease validation,
  request bodies are forbidden, coordinator credentials never cross the provider boundary, and
  existing operation tables migrate in place without losing history or fence high-water marks.
- Docker runtime launch can defer workers and the scheduler until `activate()` runs after provider
  data commits. Provider data validation has a cleanup hook that must quiesce an exposed candidate
  before uncommitted SQLite rollback and leaves recovery journaled when cleanup is uncertain.
- Docker cleanup now re-enumerates exact owner/project/release/generation labels before forgetting a
  runtime, including when `docker create` persisted a container but reported failure.
- A zero-dependency `@clank.run/framework/provider-docker` reference launcher now starts the exact
  verified web, worker, and scheduler topology inside resource-bounded Docker containers, checks
  private health over loopback, and exposes only non-secret candidate metadata. Immutable images,
  non-root execution, read-only releases/root filesystems, project-only data mounts, bounded logs,
  owner-scoped orphan cleanup, generation fencing, graceful stop, close-race fencing, and restart
  reconciliation are enforced.
- Provider-prepared runtime data now carries the exact normalized config decoded from the verified
  capsule, so launchers cannot accidentally substitute another entry, database path, or job
  topology.
- A provider-private `@clank.run/framework/provider-runtime` registry now publishes overlapping
  application generations, validates the complete managed-ingress binding before dispatch, retains
  only a route-token digest, proxies only to loopback origins, and revokes then drains exact
  generations. URL/body/time/capacity bounds, reserved-header stripping, generic unavailable
  failures, response streaming, pre-auth activation-race leases, close fencing, retry-safe
  deactivation, and timed-out-drain retention are covered end to end.
- Managed ingress can now bind an allowlisted remote provider origin to an exact
  `clank-runtime/1` generation and provider-local path. It overwrites reserved
  project/protocol/generation/ingress-token headers, binds health checks identically, keeps the
  secret out of public failures and metrics, rejects encoded path traversal, and fences circuit
  state from both generation changes and late replaced-generation responses.
- A zero-dependency provider data lifecycle now consumes independently verified
  `clank-runtime/1` capsules, stages immutable releases, initializes/preserves/replaces
  project-isolated SQLite, applies immutable migrations, exports consistent snapshots, retains
  one rollback generation, and requires exact confirmations for rollback and deletion. Durable
  apply/rollback journals recover crashes around the atomic metadata commit point, while
  generation/fence high-water marks reject stale work.
- A versioned `clank-runtime/1` binary capsule now binds one desired project generation to its
  verified release, final process environment, SQLite initialization/preservation/replacement
  intent, optional integrity-checked snapshot, and managed-ingress identity. The codec has strict
  section/aggregate limits and is exported as `@clank.run/framework/runtime-placement`.
- Current operation leases can fetch an exact no-store runtime capsule through the coordinator,
  and provider agents plus the authenticated HTTP provider bridge independently verify and bind it
  before infrastructure code runs. `clank-runner` exposes separate runtime transfer deadline and
  byte-ceiling settings.
- The remote deployment coordinator now supports administrator-created one-time enrollment tokens
  bound to an exact node and region. The responsive control-plane fleet panel reports node health,
  capacity, placement, work, and pending enrollment metadata and provides audited drain,
  reactivate, enrollment-revoke, and credential-revoke controls.
- `clank-runner --check [--json]` validates local configuration without consuming a fresh
  enrollment and authenticates an existing saved node credential when present. The packaged
  platform has an explicit `CLANK_RUNNER_COORDINATOR=1` switch while preserving the closed,
  zero-cost single-host default and legacy shared enrollment compatibility.
- Production `clank-platform` starts in an explicit `isolated` hosting profile by default and
  selects the constrained Docker runner unless the operator deliberately chooses the low-cost
  `trusted` profile. Programmatic platform runtimes expose their resolved hosting profile and
  runner kind for diagnostics.
- Durable deployment coordination now has an optional, versioned HTTP transport and bounded client
  for remote nodes. A separate enrollment secret provisions hashed node credentials; authenticated
  nodes can heartbeat, drain, claim, renew, complete, fail, and report generation-fenced
  observations without access to the control database.
- A provider-neutral remote deployment-agent loop now handles credential-only restart and
  deliberate re-enrollment, heartbeats, bounded claims/concurrency, automatic operation renewal,
  fenced observations and settlement, redacted failures, graceful drain, and abortable shutdown.
  Persistent node credentials use a serialized, atomic, owner-only validated file store; a running
  node stops safely when credential rotation revokes its session.
- Current operation leases can fetch their exact content-addressed release through a bounded binary
  coordinator call. The platform optionally retains owner-only original uploads when remote
  enrollment is enabled, accounts for that storage, and verifies identity, node scope, lease fence,
  length, media type, and SHA-256 across the complete transfer.
- A provider-neutral `ObjectStore` now includes atomic owner-only local envelopes and a
  zero-dependency S3-compatible adapter. The S3 subset signs exact single-chunk payloads with SigV4,
  supports virtual-hosted and path-style endpoints plus temporary credentials, bounds retries,
  deadlines, and error bodies, and rehashes every downloaded object.
- Remote deployment enrollment can retain original release uploads in a configured `ObjectStore`
  instead of the control-plane volume. Each release persists its repository namespace and exact
  content-addressed key; leased reads, release cleanup, project deletion, legacy local releases,
  quota accounting, and provider failures are verified end to end.
- Encrypted SQLite recovery points can use a local or S3-compatible object repository. Remote
  backups use an authenticated per-database catalog and bounded immutable chunks, promote legacy
  local copies, retain a usable local copy after upload failure, verify the complete remote copy,
  apply retention across both locations, survive restarts, and are erased with platform-managed
  project storage.
- Deployed projects now have a responsive Jobs console plus `clank jobs status|list|cancel|retry`.
  The bounded API reports queue health, overdue work, expired leases, dead letters, and cron
  schedule state; cancellation/retry use conditional live-database transitions and durable audit
  events.
- Remote infrastructure integrations now have a credential-free `DeploymentProvider` contract,
  canonical desired-state validation, independent artifact verification, fenced observation, and
  the `openProviderDeploymentAgent` lifecycle wrapper.
- A zero-dependency authenticated HTTP provider bridge carries the original bounded binary release
  through a redirect-safe, retry-safe protocol, and the packaged `clank-runner` command connects
  that bridge to a remote control plane with persistent node credentials and graceful drain.
- Projects now support isolated, expiring preview environments through the control-plane UI/API
  and `clank preview deploy|list|remove`. Reusing a preview name refreshes its TTL and publishes a
  normal atomic release without changing the production project link.
- Generated templates and blueprint apps now compile minified Tailwind CSS during the ordinary
  Clank build, serve a same-origin static stylesheet, and omit the development-only browser CDN.
  `clank build --tailwind=<source>` can use the local CLI module or an explicitly configured
  standalone executable.
- Workspaces now have a durable `clank-usage/1` monthly ledger, responsive server-rendered Usage
  console, and `clank usage [--org] [--month] [--json]`. It reports admitted requests, request
  bodies, declared response bytes, traffic-limit rejections, retained deleted-project totals, and
  current resource inventory without inventing streamed-byte or pricing data.
- Managed ingress now enforces inherited workspace UTC-month request/known-transfer limits and a
  per-project UTC-minute request ceiling in one SQLite admission transaction. New installation,
  account, and workspace limits appear in the existing operator editor; retention is bounded and
  pruned at startup and during traffic.

### Fixed

- Deployment operation fences are now allocated from a durable per-project sequence instead of
  restarting at one for each operation. Successive releases, concurrent claims, expired-lease
  reclamation, and process restarts therefore preserve the provider's stale-writer ordering
  contract; project deletion removes the matching sequence.
- Object-backed project backups now map URL-safe project IDs that begin with `-` or `_` to a stable
  portable repository identity, instead of intermittently rejecting valid generated projects.
- Docker application environment is now delivered through one inert, name-only encoded envelope
  that the in-container Node bootstrap deletes before importing application code. Application
  variables such as `DOCKER_HOST`, `LD_PRELOAD`, proxy settings, and TLS settings can no longer
  control the host-side Docker client or executable, and secret values remain absent from process
  arguments.
- The first-account bootstrap response now waits for winner retention before reconciling the
  configured platform-administrator allowlist, so a new operator receives administrator access
  immediately instead of only after the control plane restarts.
- Revoked or expired runner placement is reconsidered transactionally, expired operation leases
  become retryable on the current assigned node with a higher fence, and running desired state
  without capacity remains durable until an eligible node appears.
- Draining deployment nodes can no longer claim queued operations. Lost/expired leases and shutdown
  deadlines abandon work without stale settlement, while a missing completion response no longer
  converts a possibly committed success into an explicit failure and duplicate retry.

### Security

- Provider-service metadata stores only exact non-secret desired-state bindings in bounded,
  owner-only, no-follow, atomically replaced files. Capsules are rehashed and decoded before that
  intent advances; lower generations/fences, conflicting same-generation capsules, and
  same-fence operation substitution fail before infrastructure mutation. Reconciliation drains
  before stopping a writer, defers background effects until commit, and activates ingress last.
- The provider Docker launcher delivers the final application environment through bounded
  container stdin after Node starts. Secret values are absent from host Docker environment
  variables, command arguments, labels, and persisted container environment metadata; the
  in-container bootstrap validates names and values before importing the verified entry. The host
  Docker process receives only an operator-controlled connection/context/proxy/locale allowlist.
- Provider data metadata is exact-field decoded, size-bounded, project-bound, owner-only, and
  confined to typed data/generation/recovery paths. Unsafe permissions, symbolic-link storage,
  conflicting capsule/desired-state bindings, changed database paths, stale fences, and corrupted
  state relationships fail closed. Runtime environment values and ingress tokens remain
  memory-only, and committed cleanup can never roll database bytes back under newer metadata.
- Runtime capsules require the exact current node and operation lease, use canonical stored desired
  state, recheck the lease after capsule loading, verify whole-body and nested section digests, and
  bind project/release/generation at the provider hop. Application secrets, SQLite bytes, and
  ingress tokens remain only in bounded HTTPS bodies and never enter URLs, headers, public
  failures, or durable operation results. Built-in provider activation is explicit and
  fail-closed; generation-bound backup and deletion are integrated, while provider restore awaits
  a separately fenced replacement-generation path.
- Managed runner enrollment stores only a high-entropy digest, caps active grants, requires a
  recent same-origin browser administrator session plus CSRF, rejects bearer/admin impersonation,
  expires automatically, reserves transactionally, commits once, rolls back failed registration,
  and excludes enrollment and node credentials from API and audit records.
- Unknown `CLANK_RUNNER` and `CLANK_HOSTING_PROFILE` values now fail at startup instead of silently
  selecting process execution. The isolated profile rejects the process runner, and the packaged
  control plane rejects public signup when applications share the platform Unix trust boundary.
- Remote-runner requests are HTTPS-only outside loopback, JSON-only, size- and time-bounded,
  redirect-safe, no-store, and disabled unless a dedicated high-entropy enrollment token is
  configured. Node and operation credentials remain plaintext only to their holder and hashed at
  rest; expired nodes and stale operation fences fail closed.
- File-backed node credentials reject symbolic links, non-files, oversized or malformed data,
  unsafe owners/modes, inode/path swaps, unsupported versions, and invalid tokens; reads use a
  no-follow descriptor and writes replace a `0600` file atomically. Executor exceptions stay in
  private node diagnostics by default instead of durable control-plane state.
- A node credential alone cannot fetch a release: artifact access also requires its exact unexpired
  operation token and fence. The provider never receives that token, redirects remain disabled,
  and platform-managed secrets and databases are not included in retained release archives.
- Remote object storage refuses insecure non-loopback endpoints, embedded credentials, redirects,
  unsigned payloads, dotted virtual-host ambiguity, unsafe keys, oversized streams, and incomplete
  or inconsistent Clank integrity metadata. Provider response bodies never become public errors.
- Failed or ambiguous release-object writes are cleaned before their quota reservation is released.
  A repository namespace mismatch refuses reads and deletion rather than silently interpreting an
  old release through a newly configured bucket or prefix.
- Object backups authenticate catalog and manifest metadata, verify every chunk's exact key, media
  type, length, and SHA-256, then recheck AES-GCM, plaintext length/digest, and SQLite integrity
  before restore. The platform persists its backup namespace and logical root and refuses startup
  after repository configuration drifts or disappears.
- Hosted job inspection omits arguments, results, error text, owner/group identity, worker
  identity, and lease credentials. Mutations require the dedicated `jobs` permission, remain
  blocked during support impersonation, serialize with deployment/data operations, and never place
  application payloads in platform audit metadata.
- Provider adapters never receive control-plane node or operation credentials. Their HTTP bridge
  requires a distinct high-entropy token, HTTPS outside loopback, exact bounded headers and bodies,
  fresh artifact digest/config verification, no redirects, generic public failures, and private
  diagnostics.
- Preview environments never inherit production databases or secrets, cannot be nested, count
  toward existing account/workspace project limits, are hidden under their production parent, and
  expire through the same path-safe storage, token-revocation, and audit lifecycle as manual
  deletion.
- Tailwind builds execute an exact local binary and argument array without a shell, restrict the
  source to the compiler input tree, write output atomically, and fail deployment when the compiler
  is unavailable instead of silently shipping unprocessed production CSS.
- Traffic admission receives only project/route IDs, normalized method, request bytes, and receipt
  time; paths, hosts, headers, cookies, IP addresses, query strings, and body content never enter
  its ledger. Invalid policy decisions fail closed, project-scoped tokens cannot read workspace
  usage, and deleted-project rows contain only bounded operational aggregates until expiry.

## 0.9.4 - 2026-07-28

### Added

- Typed durable jobs now support transactional mutation enqueue, owner-scoped handlers, queue and
  group routing, priorities, delays, idempotency keys, renewable visibility leases, heartbeats,
  cooperative timeout/cancellation, fenced settlement, bounded exponential retry, dead letters,
  event history, retention cleanup, and operator retry/purge controls.
- Time-zone-aware five-field cron schedules now provide deterministic occurrence keys, deadlines,
  bounded catch-up, suspension, and allow/forbid/replace concurrency through an independently
  leased scheduler.
- Deployment config can declare independent worker processes and a scheduler. The platform
  supervises and restarts the process group, quiesces background code across rolling releases,
  resumes the prior set after candidate failure, attributes per-role memory, and exposes tagged
  logs. `clank jobs worker|scheduler` runs the same process contract on any provider.
- The authenticated starter now includes an atomic background job, standalone process entry,
  deployment topology, local scripts, and human/agent guidance.
- Platform administrators can issue personal-only signup invitations as an explicit alternative to
  workspace invitations. Personal invitations create an isolated account and its own workspace
  without granting membership in an operator workspace; both types remain email-bound,
  single-use, expiring, hashed at rest, revocable, and auditable.
- Platform administrators can now set durable, audited account and workspace quota overrides from
  the Control plane. Workspace capacity inherits from its owning account and then installation
  defaults; projects, domains, release count/storage, and encrypted-backup retention all enforce
  the resolved value at their transactional or locked mutation boundary.
- The documentation now includes a practical per-app MCP guide covering automatic query and
  mutation tools, application-specific auth and data isolation, Codex connection, and contract
  freshness as UI actions change.
- Clank now ships a shared three-color brand mark with favicon, compact UI, and Apple touch
  variants. The deployment control plane and documentation site both publish and display the
  same generated identity.

### Fixed

- The legacy `openJobQueue` service now uses an isolated compatibility table and migrates its old
  table name, allowing it to coexist with the typed job runtime without a schema collision.
- Running cancellation now fences a handler that returns before its next heartbeat, and a
  cancelled job left by a crashed worker becomes cancelled rather than an unclaimable retry.
- Sidebar navigation now uses one consistently sized SVG icon system instead of font glyphs with
  mismatched baselines and visual bounds.
- The control-plane sidebar now keeps the Clank mark and name together in one compact lockup
  while preserving the descriptor alignment.
- The protected-main documentation workflow now removes one oldest inactive artifact only when
  the docs project reaches its release limit, preserving uninterrupted automatic deployments
  without deleting the active release or bypassing immediate rollback protection.

## 0.9.3 - 2026-07-27

### Added

- MCP-visible backend contracts now receive deterministic revisions derived from server identity,
  tool names, schemas, descriptions, scopes, and annotations. Revisions are exposed through
  runtime manifests, discovery documents, Server Cards, response headers, list-result metadata,
  and deployment-sensitive `serverInfo.version` values.
- Bounded MCP Streamable HTTP sessions and authenticated SSE notification streams now support
  `notifications/tools/list_changed`. A new application process rejects a prior release's session
  so compliant clients automatically reinitialize and rediscover actions after rolling deploys.

### Changed

- `tools/list`, `resources/list`, and `resources/read` now publish `ttlMs: 0` and private cache
  scope, while public discovery requires revalidation. Unknown tool errors include a structured
  refresh hint instead of leaving clients with an unexplained stale call.
- Generated agent guides now require every UI operation that reads or persists server state to use
  the same typed backend query or mutation exposed through MCP, with manifest/tool parity included
  in the definition of done.

## 0.9.2 - 2026-07-27

### Fixed

- MCP OAuth consent pages now permit form navigation to the exact validated callback origin.
  This prevents Chromium from blocking the successful `303` loopback redirect after consuming
  the one-time consent proof, while retaining same-origin form restrictions everywhere else.

## 0.9.1 - 2026-07-27

### Added

- `docs.clank.run` now exposes a public, read-only MCP server with bounded list, search, and
  canonical Markdown retrieval tools plus stable Clank and MCP Server Card discovery.

### Fixed

- MCP OAuth consent no longer depends on extension or embedded-browser Origin behavior. Consent
  pages now receive a one-time, expiring proof bound to the authenticated session and exact OAuth
  request; approval consumes it atomically alongside the existing session CSRF check.
- Signed-out MCP OAuth now offers a same-origin password form that advances directly to consent,
  while retaining strict Origin checks, credential throttling, secure cookies, generic failures,
  and same-origin-only return paths.
- MCP authorization remains a direct, standards-based exchange between the application and the
  MCP client. Connecting an agent never requires the Clank deployment CLI, the Clank control
  plane, a callback relay, Tailscale, or copying an authorization response.

## 0.9.0 - 2026-07-26

### Added

- Automatic MCP Streamable HTTP tools for every Clank backend function, public server discovery,
  typed action resources, conservative side-effect annotations, and an OAuth authorization-code
  flow with PKCE, resource-bound access tokens, read/write scopes, rotating refresh tokens, and
  authenticated application-user isolation.
- Successful protected-main CI revisions now automatically build, validate, and deploy `docs.clank.run` through a dedicated GitHub environment and a least-privilege project token.
- Documentation code fences now use dependency-free, server-rendered syntax highlighting for TypeScript, TSX, JavaScript, shell, JSON, SQL, HTML, CSS, configuration, and Mermaid examples.
- Code-only application deployments now launch and health-check candidates on spare ports, atomically switch managed ingress, drain requests already assigned to the prior upstream, and stop the prior release only after the route change.
- Platform administrators can now attribute live container memory across the control plane, each hosted application process, V8 heap, file cache, kernel memory, swap, and per-process peaks from the responsive admin console.
- Platform administrators can now reconcile mounted-volume usage with the control database, isolated project databases, releases, migration snapshots, encrypted recovery backups, orphaned directories, and filesystem overhead without exposing paths or file contents.

### Fixed

- The deployment platform now reserves its own HTTP listener from the application port allocator
  and deterministically reassigns persisted project conflicts during startup.
- Deployment artifact collection now ignores the compiler's atomic temporary files, preventing a concurrent framework build from producing a transient file or `ENOENT` failure in an otherwise deterministic bundle.
- Deployment packaging now retries a complete, metadata-verified source snapshot when files or directory entries change during collection, preventing concurrent cleanup or replacement from producing partial artifacts.
- Railway startup recovers project runtimes concurrently without delaying the public listener, shutdown drains HTTP and platform resources together, and automatic crash recovery can no longer race a user deployment.
- Managed-ingress circuit breakers no longer carry an unhealthy prior upstream's open circuit into a newly activated release.

## 0.8.0 - 2026-07-26

### Added

- A dependency-free interactive launcher when `clank` runs in a terminal, with guided create, readiness, login, deploy, and help workflows plus authenticated and minimal full-stack templates.
- A secure managed-platform default for `clank login`, so normal hosted use connects to `https://clank.run` without a `--server` flag while self-hosted platforms retain an explicit override.
- The framework now publishes from the `@clank.run` npm organization as `@clank.run/framework`, with explicit public-registry, provenance, repository, documentation, and package-export metadata.
- A fully authenticated deployment dashboard with site status, 1-hour through 30-day ingress charts, releases, logs, and guided custom-domain setup.
- Transactionally enforced per-organization site and per-project custom-domain limits, with operator-configurable metric retention.
- Minute-level fixed-histogram ingress metrics plus DNS routing inspection and a Caddy On-Demand TLS permission endpoint for deployed built-in and verified custom hosts.
- Packaged-release conformance covering scaffold, browser and CLI auth, live synchronization, isolation, deployment, migration, failed health activation, rollback, and data restoration.
- GitHub CI and OIDC trusted-publishing release workflows.
- Security reporting, contribution, conduct, ownership, and release-governance documentation.
- Deterministic AI blueprints with plan, explain, and generated authenticated application files.
- Email verification, password recovery, email-code MFA, WebAuthn passkeys, organizations, RBAC, invitations, and project-scoped CLI tokens.
- Typed file, email, job, webhook, observability, encrypted backup, orchestration, ingress, custom-domain, external PostgreSQL, and database-provisioning drivers.
- ASVS-oriented evidence, threat modeling, chaos tests, CodeQL, immutable GitHub Actions, package/credential auditing, and a public-beta gate.
- Enforced line, branch, and function coverage floors plus a documentation audit that verifies local links, guide indexing, declaration synchronization, and package export targets.
- Storage-backed `/healthz` and `/readyz` probes alongside the process-only `/livez` endpoint.
- Bounded automatic custom-domain routing reconciliation with durable cross-control-plane leases, lookup deadlines, operator configuration, and dashboard status.
- Automatic verified encrypted database backups with durable cross-control-plane leases, configurable cadence and retention, private failure reporting, and dashboard controls.
- Enforced per-project release count/byte quotas plus rollback-scoped dashboard and CLI cleanup for inactive runtime artifacts and pre-deploy snapshots.
- Owner/admin-only permanent site deletion in the dashboard, API, and CLI with exact confirmation, explicit data-loss acknowledgement, scoped-token denial, path-safe storage removal, token revocation, and retained audit evidence.
- A role-filtered, cursor-paginated workspace activity feed in the dashboard, API, and CLI that retains deleted-site history and upgrades existing audit rows with organization attribution.
- Workspace people administration in the dashboard and CLI, including browser acceptance, member role changes, immediate removal, safe pending-invitation listing, one-time token copy, replacement, and revocation.
- Quota-aware workspace creation in the People console with safe slug preview and immediate selection.
- Durable SQLite-backed deployment-platform authentication and CLI device-start rate limits shared across control-plane runtimes and restarts.
- Command-aware human and JSON CLI help, agent-readable readiness diagnostics, generated `README.md`/`AGENTS.md` guides, and local-checkout scaffolding that does not require an npm release.
- Offline deterministic deployment dry-runs, structured deployment results with timing, one-command first-project naming/workspace selection, and retry-safe persisted idempotency attempts.

### Changed

- Authentication now defaults to an eight-character password minimum across framework and platform forms; applications can still require a higher value, and scrypt hashing, bounded concurrency, rate limits, and optional server-only peppering remain in place.
- The documentation site now begins with the published npm package and generated-app workflow, with hosted login examples consistently using the managed `clank.run` service.

### Fixed

- Deployment-console header controls now center their labels and icons consistently, while account quota totals retain readable spacing at narrow widths.
- Workspace invitations can now create their email-bound account and accept membership in one browser flow even when public registration is disabled or the one-time bootstrap is complete.
- First-account bootstrap is now protected by an expiring SQLite claim across control-plane runtimes, preventing concurrent processes from creating multiple initial accounts.
- Platform signup policy now evaluates the same normalized auth operation as the low-level router, closing repeated-slash registration bypasses.
- Sign-out and expired-session transitions now reload the deployment console at the identity boundary, clearing prior-account dashboard DOM and recomputing bootstrap availability before another account signs in.
- Successful password login now clears the exact failed-attempt rate-limit key instead of leaving the account throttled.
- CLI profile and project-link state is now bounded, structurally validated, URL-canonicalized, privately and atomically replaced, and never reflected in parse errors.
- CLI control-plane responses are streaming-bounded, decoded as strict UTF-8/JSON, and protected by finite request and deployment timeouts.
- Platform signal handling now closes both the HTTP listener and control-plane state, reports shutdown failures, and enforces a 30-second termination deadline.
- Project navigation now resets scroll position and closes the mobile drawer; the detail tab row stays within narrow viewports without a page-level horizontal scrollbar or clipped breadcrumb, and the console explicitly serves no favicon asset.
- The deployment console no longer renders or requests a logo asset or letter-mark treatment.
- Backup API responses no longer expose private host database paths.
- Repeated deployments can no longer grow retained release storage without an installation-defined ceiling.
- Site quotas can now be reclaimed without operator-side SQLite or filesystem edits.
- Managed ingress now fixes the upstream origin before applying a request path and streaming-bounds bodies without `Content-Length`, closing scheme-relative SSRF and unbounded-buffer paths.
- Pending custom-domain assignments can no longer be moved between projects; platform-owned DNS namespaces are reserved.
- Reissuing an invitation now revokes every older active token for that workspace/email, existing members cannot be reinvited, and active invitations are capped at 100 per workspace.
- Refreshed dashboard sessions now render one consistent authentication state and return to sign-in when a session expires.
- Failed distributed-lease acquisition now releases the local project queue.
- Managed ingress strips `Connection`-nominated headers and retries safe requests after transient upstream 5xx responses.
- WebAuthn CBOR parsing now bounds collection size and nesting, and passkey counter advancement is atomic.
- Blueprint suffix parsing and local-file endpoint normalization are linear on adversarial input.
- Unexpected deployment-platform failures are logged privately and never reflected to HTTP clients.
- Every HTTP/runtime adapter now keeps unexpected exception text private, and adversarial prefix, identifier, URL, and numeric-literal parsing is linear.
- CLI device login prints its browser approval URL without launching an operating-system command.
- The minimum runtime is Node 22.16, the first Node 22 release with the built-in SQLite backup API used by migrations and recovery.
- The official package name is `@clank.run/framework`, avoiding collision with unrelated unscoped packages while leaving the binaries as `clank` and `clank-platform`.
- Command-specific `--help` no longer authenticates or executes the command, dry-run deploys no longer require login, asynchronous CLI failures now reliably exit non-zero without stack traces, and unknown long options fail with spelling guidance instead of being ignored.
- Generated authenticated apps and bundled SSR examples now map the browser's actual `@clank.run/framework` module specifier, allowing their server-rendered screens to hydrate and become interactive.
- Hydration now cleans partially attached listeners, directives, keyed rows, and component ownership before fallback; only structural mismatches remount, lifecycle/application errors remain visible, and case-sensitive SVG plus `foreignObject` namespaces preserve their server nodes.
- Local deployment artifacts are now written through a private atomic replacement, preventing a pre-existing output symlink from redirecting CLI writes.

## 0.7.0 - 2026-07-16

### Added

- AI-first runtime schemas, actions, semantic UI, forms, headless UI primitives, SSR, hydration, routing, SQLite backend, authentication, migrations, and the Clank deployment platform.
- Deterministic deployment artifacts, encrypted platform secrets, device authorization, health-gated activation, logs, audit history, and rollback.

### Changed

- Renamed the complete framework, CLI, storage, protocol, documentation, and deployment UI from Proact to Clank while preserving legacy data through compatibility readers and in-place migration.
