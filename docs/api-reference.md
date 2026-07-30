# API reference

This is the compact index of every public export. The focused guides contain behavioral details and examples.

## Core

- `signal(value, options?)` → `ReactiveSignal<T>`: mutable tracked value.
- `ReactiveSignal`: `.value`, `.get()`, `.peek()`, `.set()`, `.update()`, `.subscribe()`, `.toJSON()`.
- `isSignal(value)`: detects signals and computed values.
- `computed(derive, options?)` → `Computed<T>`: lazy cached derived value.
- `effect(callback, options?)` → disposer: tracked synchronous side effect with cleanup.
- `batch(callback)`: coalesces dependent effects.
- `transaction(callback)`: batch with signal rollback on throw.
- `untrack(callback)`: disables dependency capture in the callback.
- `createRoot(callback)`: creates an ownership scope.
- `onCleanup(callback)`: registers owned cleanup.
- `getOwner()` / `runWithOwner(owner, callback)`: capture and restore ownership for advanced integrations.
- `store(object)`: creates a lazy deep reactive proxy.
- `isStore(value)`, `toRaw(value)`, `snapshot(value)`: store inspection and serialization.
- `resource(loader, options?)`: async state with abort and stale-result protection.
- `consumeStream(iterable, initial, reduce?)`: folds an async iterable into a signal.
- `SIGNAL`, `STORE`: global protocol symbols for integrations.

## DOM

- TSX: preferred component syntax; dynamic braces become fine-grained bindings automatically.
- `h(type, props?, ...children)` / `createElement`: lower-level VNode construction.
- `jsx`, `jsxs`, `jsxDEV`: compiler runtime entry points.
- `expression(read)`, `isExpression(value)`: compiler/runtime reactive boundary.
- `Fragment`: groups children without an element.
- `render(root, view)` → disposer: mounts an application.
- `hydrate(root, view)` → disposer: attaches to marker-compatible SSR DOM; warns and remounts on a structural mismatch.
- `isVNode(value)`: VNode detection.
- `onMount(callback)`: post-mount lifecycle with optional cleanup.
- `createContext(defaultValue)`, `provideContext(context, value)`, `useContext(context)`.
- `Show`, `Match`, `Switch`: reactive conditional control flow.
- `For`: O(n) keyed reconciliation with row identity preservation; use `by="id"` or a key function.
- `lazy(loader)`: promise-backed component.
- Types: `Renderable`, `Component`, `VNode`, `ReactiveExpression`, `KeyedBlock`, `ElementType`, `ClankContext`.

Element protocols include `onClick`/`on:click`, `bind:value`, `classList`, object `style`, callback/signal `ref`, directive `use`, `dangerouslySetInnerHTML`, and the `agent*` properties.

## Forms

- `createForm(options)` → typed headless form controller.
- Controller state: `values`, `dirty`, `valid`, `pending`, `submitted`, `submitCount`, `status`, `result`, `error`, `formErrors`.
- Controller methods: `field`, `setValue`, `setValues`, `setErrors`, `validate`, `submit`, `reset`, `focusFirstError`, `props`.
- Field state: `value`, `errors`, `touched`, `dirty`, `invalid`, `message`.
- Field helpers: `input`, `textarea`, `select`, `checkbox`, `radio`, `error`.
- `manifest`: `clank-form/1` schema and field contract without live values.
- Types: `FormController`, `FormField`, `FormManifest`, `FormErrorMap`, `FormStatus`, `CreateFormOptions`.

## Headless UI

- `createDisclosure(options)`: expandable state with trigger/panel ARIA props.
- `createDialog(options)`: modal state, focus trap, Escape/backdrop handling, scroll lock, and focus restoration.
- `createTabs(options)`: inferred tab values, panel relationships, roving tab index, and keyboard navigation.
- `createPagination(options)`: page clamping, ranges, controls, and compact page items.
- `clickOutside(handler)`: outside-pointer directive.
- `autoFocus(element)`: mount-time focus directive.
- Types: `DisclosureController`, `DialogController`, `TabsController`, `PaginationController`.

## Compiler

- `clank build [input] [output]`: compile `.ts`/`.tsx` and copy static files once.
- `clank watch [input] [output]`: rebuild after source changes.
- `--jsx-import-source=specifier`: choose the generated runtime module.
- `compile(source, options?)`: programmatic TypeScript/TSX compilation.
- `transformTSX(source, options?)`: programmatic TSX-only lowering.

## Deployment artifacts

- `readDeploymentConfig(root, filename?)`: read and normalize `clank.deploy.json`.
- `parseDeploymentConfig(value)`: validate a config already in memory.
- `createDeploymentBundle(root, config, options?)`: deterministic gzip artifact with checked files and provenance.
- `decodeDeploymentBundle(bytes, limits?)`: bounded protocol, path, size, base64, and SHA-256 verification.
- `extractDeploymentBundle(bundle, directory)`: exclusive extraction into a release root.
- `deploymentDigest(bytes)`: SHA-256 artifact digest.
- Types: `DeploymentConfig`, `DeploymentBundle`, `DeploymentFile`, `BundleLimits`.

## Migrations

- `loadMigrations(directory, options?)`: ordered SQL files and SHA-256 checksums.
- `planMigrations(path, migrations)`: applied/pending state with immutable-history verification.
- `applyMigrations(options)`: apply pending SQL in one immediate transaction.
- `assertSafeMigrationSql(sql, id?)`: reject cross-database and transaction controls.
- `backupSQLite(source, destination)`: consistent built-in SQLite backup.
- `restoreSQLiteBackup(source, destination)`: replace a stopped database and clear WAL sidecars.
- Types: `Migration`, `MigrationRecord`, `MigrationPlan`, `ApplyMigrationsOptions`.

## Recovery

- `openBackupManager(options)`: consistent AES-256-GCM SQLite recovery points with authenticated
  manifests, retention, verification, explicit restore confirmation, and optional chunked
  `ObjectStore` persistence.
- `BackupManager.purge({ confirmation: "delete all backups" })`: explicit repository-wide cleanup,
  including incomplete object promotions.
- Local mode commits owner-only envelope/manifest directories atomically. Object mode promotes
  existing local copies, publishes an HMAC-authenticated per-database catalog, verifies every
  chunk and the reconstructed database, and retains the local copy after provider failure.
- Types: `BackupManager`, `BackupManagerOptions`, `BackupManifest`, `BackupVerification`,
  `BackupObjectRepositoryOptions`.

## Deployment platform

- `openPlatform(options)`: browser dashboard, workspace people/invitation administration and
  activity, transparent monthly usage, device authorization, tokens, projects, transactionally
  enforced capacity and traffic limits, ingress metrics, DNS/domain lifecycle, TLS eligibility,
  encrypted secrets, role-filtered audit, release transaction, logs, rollback, and supervision.
- `PlatformRuntime`: Fetch `.handle`, `.publicUrl`, `.dataDirectory`, resolved `.hostingProfile`,
  `.runnerKind`, and async `.close()`.
- Runners: dependency-free process runner or constrained Docker runner.
- Types: `ClankPlatformOptions`, `PlatformBackupOptions`, `PlatformJobOperationsOptions`,
  `PlatformLimits`, `PlatformHostingProfile`, `PlatformRunnerOptions`, `ProcessRunnerOptions`,
  `DockerRunnerOptions`.

## Object storage

- `openLocalObjectStore(options)`: atomic, owner-only, no-follow local object envelopes with
  verified metadata, length, and SHA-256.
- `createS3ObjectStore(options)`: zero-dependency S3-compatible `HEAD`/`GET`/`PUT`/`DELETE` adapter
  with SigV4 payload signing, virtual-hosted or path-style URLs, retries, deadlines, response
  bounds, and independent download integrity checks.
- `ObjectStoreError`: stable `status` and `code` without provider response details.
- Types: `ObjectStore`, `ObjectMetadata`, `StoredObject`, `LocalObjectStoreOptions`,
  `S3ObjectStoreOptions`.
- `openPlatform({ deploymentAgents: { artifacts: { namespace, store } } })`: retains each new
  remote-runner upload under a persisted repository identity and content-addressed key. Existing
  local releases remain readable; mismatched repositories fail closed.
- `openPlatform({ backups: { objects: { namespace, store } } })`: gives every project an isolated
  authenticated backup catalog and binds the repository identity/root in the control database.

## Remote deployment coordination

- `createDeploymentCoordinatorHandler(orchestrator, options)`: optional versioned HTTP boundary for
  deployment-node enrollment, heartbeat, draining, operation claims, renewal, settlement, and
  desired-state observation.
- `createDeploymentCoordinatorClient(options)`: HTTPS/loopback-only, redirect-refusing, bounded
  remote-node client. `.artifact(...)` verifies the leased, content-addressed binary release before
  returning it.
- `openDeploymentAgent(options)`: provider-neutral enrollment, credential recovery, heartbeat,
  bounded claim/concurrency, lease-renewal, fenced settlement, and graceful-drain loop. The
  provider-specific `execute` callback receives the current claim, an abort signal, verified
  leased `artifact()`, and generation-fenced `observe`.
- `fileDeploymentNodeCredentials(path)`: serialized, atomic, owner-only persistent node credential
  store with file type, mode, size, version, token, and symlink validation.
- `memoryDeploymentNodeCredentials(initial?)`: ephemeral credential store for tests and temporary
  nodes.
- `DEPLOYMENT_COORDINATOR_PREFIX`: fixed `/api/runner/v1` protocol namespace.
- `DeploymentCoordinatorError`: safe client error with HTTP `status` and stable `code`.
- `DeploymentOrchestrator.authenticateNode(id, token)`: verifies the current node credential and
  heartbeat lease without extending it.
- `DeploymentOrchestrator.authenticateOperation(operation)`: returns the canonical stored lease
  only when the exact node/token/fence/expiry tuple is current, without extending or settling it.
- Operation claims allocate a durable, monotonically increasing fence across every operation for
  the same project. Retries and later releases cannot reuse an earlier provider fence; separate
  projects retain independent sequences.
- `DeploymentOrchestrator.setDesired({ placementMode })`: `portable` placements may move after node
  loss; `stateful` placements durably reserve one node identity and fail closed instead of moving
  node-local data implicitly.
- `DeploymentOrchestrator.setDesired({ nodeRequirements })`: persists endpoint and exact-label
  capability requirements so initial and delayed placement select only compatible nodes.
- Types: `DeploymentCoordinatorHandler`, `DeploymentCoordinatorHandlerOptions`,
  `DeploymentCoordinatorClient`, `DeploymentCoordinatorClientOptions`,
  `DeploymentArtifact`, `DeploymentArtifactRequest`, `DeploymentArtifactProvider`,
  `DeploymentNodeCredentialStore`, `DeploymentExecutionContext`, `DeploymentAgentOptions`,
  `DeploymentAgentRuntime`.

## Deployment providers

- `openProviderDeploymentAgent(options)`: validates canonical desired-state operations, verifies
  running artifacts, strips coordinator credentials before adapter execution, and reports only the
  matching generation after provider convergence.
- `reconcileDeploymentProvider(provider, operation, context)`: reusable validation/execution
  boundary for custom agent loops.
- `createHttpDeploymentProvider(options)`: HTTPS/loopback-only binary client with a separate bearer
  token, redirect refusal, deadlines, exact idempotent retries, and bounded failure responses.
- `createDeploymentProviderHandler(provider, options)`: authenticated
  `POST /v1/clank/reconcile` bridge that independently bounds, hashes, and decodes every artifact.
- `DEPLOYMENT_PROVIDER_RECONCILE_PATH`: fixed `/v1/clank/reconcile` provider protocol path.
- `DeploymentProviderError`: stable HTTP `status` and `code` without a provider response body.
- Types: `DeploymentProvider`, `DeploymentProviderRequest`, `DeploymentProviderOperation`,
  `DeploymentProviderDesiredState`, `DeploymentProviderArtifact`,
  `ProviderDeploymentAgentOptions`, `HttpDeploymentProviderOptions`,
  `DeploymentProviderHandler`, and `DeploymentProviderHandlerOptions`.

## Provider Docker runtime

- `openDockerDeploymentRuntimeLauncher(options)`: exact-owner orphan cleanup, immutable-image
  Docker launch, private health, worker/scheduler topology, generation fencing, stop, and shutdown.
- `launch({ prepared, signal, deferBackground? })`: starts the config embedded in verified
  provider data and returns a non-secret loopback candidate. Deferred mode health-checks only web.
- `activate(candidate, signal)`: starts a deferred candidate's workers/scheduler after provider
  data commits, verifies them, releases the memory-only activation plan, and marks it active.
- `commit(candidate)`: marks the exact healthy candidate active after provider data commits.
- `inspect()`, `stop(projectId, generation?)`, `forget(projectId, generation)`, and `close()`:
  non-secret state, verified container removal, deletion cleanup, and fail-closed shutdown.
- Types: `DockerDeploymentRuntimeLauncherOptions`, `DockerDeploymentRuntimeCandidate`,
  `DockerDeploymentRuntimeState`, `DockerDeploymentRuntimeLauncher`.

## Complete deployment provider service

- `openDockerDeploymentProviderService(options)`: opens provider data, exact-owner Docker cleanup
  and launch, private runtime ingress, and durable service fencing with secure defaults.
- `openDeploymentProviderService(options)`: composes injected data, Docker-runtime, and ingress
  components for custom hosting and deterministic tests.
- `reconcile(request)`: independently verifies the capsule, persists exact operation/fence intent,
  drains before stopping a writer, recovers/stages/migrates data, defers jobs until commit,
  activates ingress last, and supports exact retry after response loss or restart.
- `handle(request)`: generation-bound private application ingress.
- `inspect(projectId)`, `snapshot(projectId)`, and `close()`: non-secret durable progress,
  consistent backup input, and revoke/drain/verified-stop shutdown.
- `DeploymentProviderDataStore.apply(input, validate, discard?)`: optional cleanup hook runs before
  uncommitted SQLite rollback; failed cleanup leaves the journal intact.
- Types: `DeploymentProviderService`, `DeploymentProviderServiceOptions`,
  `DockerDeploymentProviderServiceOptions`, and `DeploymentProviderServiceState`.

## Managed data plane

- `createManagedIngress(options)`: exact-host reverse proxy with fixed upstream origins, bounded
  streaming request bodies, metadata-minimal fail-closed `admitRequest`, hop-header stripping, safe
  retries, circuits, health, and admitted/denied request observation.
- `inspectDomainRouting(hostname, target, resolver?)`: compare live CNAME/A/AAAA results to a configured edge target.
- `createDomainManager(options)`: project-bound random TXT ownership challenges.
- `createMemoryDomainStore()`: in-memory domain challenge store for local use and tests.
- Types: `IngressRoute`, `IngressRequestMetric`, `IngressAdmissionRequest`,
  `IngressAdmissionDecision`, `IngressAdmissionPolicy`, `ManagedIngress`, `DomainChallenge`,
  `DomainDnsResolver`, `DomainRoutingReport`.

## AI

- `defineApp(input)`: normalize and freeze a `clank-app/1` application blueprint.
- `parseAppBlueprint(source, filename?)`: statically parse a JSON or constrained TypeScript data module without executing it.
- `generateAppFiles(blueprint, options?)`: return deterministic full-stack application files.
- `createAppPlan(blueprint, options?)`: checksum every generated file and return a `clank-plan/1` review artifact.
- `explainApp(blueprint)`: summarize identity, data, routes, services, deployment requirements, and warnings.

- `s`: runtime schema builders and JSON Schema generation. Includes string, email, URL, date, date-time, number, boolean, literal, enum, array, record, object, optional, nullable, default, refinement, union, and numeric/boolean coercion.
- `ValidationError`: aggregate issues with paths.
- `defineAction(definition)` → callable `Action` with `.manifest` and `.definition`.
- `ActionError`: explicit code/status/details error.
- `createAgentBridge(actions, options?)`: registry, discovery, bounded/origin-aware invocation, confirmation enforcement, and Fetch handler.
- `actionRunner(action)`: reactive pending/data/error execution state.
- `defineView(definition)`: component with machine-readable `viewManifest`.
- `inspectAgentSurface(root)`: compact semantic UI tree with native labels/roles and form state; omits password/file values.
- `createAgentSurface(root)`: inspect, activate, and input operations through explicit agent IDs or native element IDs.
- Types: `Schema`, `Action`, `ActionContext`, `AgentBridge`, `ActionRunner`, `AgentNode`, `AgentSurface`.

## MCP

- `createMcpServer(options)`: zero-dependency MCP Streamable HTTP server for custom typed tools.
- `McpServer.revision`: deterministic identity of server metadata and the complete visible tool
  contract.
- `McpServer.notifyToolsChanged()`: sends `notifications/tools/list_changed` to initialized
  stateful clients; `close()` terminates bounded sessions and streams.
- `MCP_PROTOCOL_VERSION`: current stable protocol revision (`2025-11-25`).
- `MCP_SUPPORTED_PROTOCOL_VERSIONS`: compatible stable revisions accepted by the transport.
- `McpToolError`: public, redacted application-level tool failure.
- Types: `McpServer`, `McpServerOptions`, `McpTool`, `McpToolAnnotations`,
  `McpAuthentication`, and `McpScope`.
- `defineBackend()` functions accept `description` and `agent` metadata.
- `openBackend()` exposes eligible functions at `/__clank/mcp` by default and installs OAuth
  discovery automatically when the backend uses Clank auth. `BackendRuntime.contractRevision`
  is the same revision published by MCP discovery and `GET /__clank/manifest`.

See [Agent protocol](agent-protocol.md) for connection, OAuth, scope, discovery, and security
details.

## Router

- `createRouter(options)` → router with `state`, `current`, `navigate`, `resolve`, `start`, `View`, and `Link`.
- `matchPath(pattern, pathname)`: parameter matcher.
- `matchRoutes(routes, URL, base?)`: route selection and URL decoding.
- `redirect(to, status?)`: Fetch redirect response.
- Types: `RouteDefinition`, `RouteMatch`, `RouteState`, `RouteLoadContext`, `RouteGuardContext`, `Router`.

## Server

- `createApp(options?)` → Fetch request router with redacted errors and an error hook.
- `.use`, `.route`, `.get`, `.post`, `.put`, `.patch`, `.delete`, `.handle`.
- `json(value, init?)`, `text(value, init?)`, `html(value, init?)`.
- `cors(options?)`, `securityHeaders(options?)`, `logger(write?)`: built-in middleware.
- Types: `RequestContext`, `RequestHandler`, `Middleware`, `RequestApp`.

## Authentication

- `defineAuth(options?)`: default or custom-profile auth contract.
- `openAuth(definition, database, options?)`: low-level SQLite auth runtime; normally opened automatically by `openBackend`.
- `authState(requestAuth)`: safe serializable SSR subset.
- `createAuthClient(options?)`: reactive auth-only client.
- `createClient<typeof authenticatedBackend>(options?)`: combined typed API, auth, CSRF mutation, seeding, and live client.
- `AuthGate`: reactive signed-in boundary with default auth screen.
- `AuthForm`: default accessible email/password registration/login UI.
- `AuthRuntime`: `.resolve`, `.handle`, `.middleware`, `.setRole`, `.disableUser`, `.revokeUserSessions`, `.verifyCsrf`, current-session refresh and subscription/status, `.close`.
- `AuthClient`: `.user`, `.session`, `.authenticated`, `.loading`, `.error`, `.reload`, `.register`, `.login`, `.logout`, `.logoutAll`, `.changePassword`.
- `AuthRequest`: `.user`, `.session`, `.csrfToken`, `.requireUser()`, `.requireRole()`.
- `AuthError`: explicit safe auth code, status, and optional retry delay.
- Types: `AuthDefinition`, `AuthDefinitionOptions`, `AuthUser`, `AuthSession`, `AuthState`, `AuthRegisterInput`, `AuthLoginInput`, `AuthUserId`, `DefaultAuthProfile`.

## Full-stack backend

- `defineTable(fields)`: validated document table definition; `.index(name, fields)` declares SQLite JSON expression indexes; `.owned()` scopes documents to the authenticated user.
- `defineDatabase(tables)`: preserves table names and field schemas as the inference root.
- `DocumentFor<Database, Table>`: inferred fields plus branded `_id`, `_creationTime`, `_version`, and `_ownerId` for owned tables.
- `Id<Table>` / `DocumentId<Table>` / `s.id(table)`: nominal table-specific IDs.
- `openSQLite(schema, options?)`: opens Node's built-in synchronous SQLite engine.
- `createSQLiteDatabase(schema, connection, options?)`: wraps a compatible connection.
- `SQLiteDatabase`: `.read`, `.tracked`, `.transaction`, `.subscribe`, `.version`, `.close`.
- Read table: `.get`, `.query`, `.collect`.
- Write table: `.insert`, `.patch`, `.replace`, `.delete`.
- `DocumentWriteOptions`: `{ ifVersion }` optimistic concurrency for patch, replace, and delete.
- `DatabaseConflictError`: stale-write error exposed as HTTP `409 VERSION_CONFLICT`.
- Query builder: `.where`, `.orderBy`, `.limit`, `.collect`, `.first`.
- `defineBackend({ schema, auth? }).functions(builders)`: inference-first nested function tree. Auth backends make `query`/`mutation` required and expose explicit `publicQuery`/`publicMutation`.
- `createApi<typeof backend>()`: zero-codegen typed function-reference proxy.
- `openBackend(definition, options?)`: consistent query cache, owner-scoped/persisted dependency invalidation, atomic mutations, manifest, bounded RPC, and SSE handler.
- `BackendRuntime`: `.auth`, `.caller(request)`, `.query`, `.mutation`, `.subscribe`, `.handle`, `.version`, `.close`.
- `createSyncClient(options?)`: typed browser/Fetch client with `.query`, `.mutate`, `.live`, and `.seed`.
- `createClient<typeof backend>(options?)`: authenticated combined client with `.api` and `.auth`.
- `BackendClientError`: safe RPC error with code/status.
- `LiveQuery`: reactive `.data`, `.loading`, `.error`, `.version`, plus `.dispose()`.
- `functionPath`, `functionKey`, `stableStringify`: reference and canonical argument helpers.
- Types: `DatabaseSchema`, `TableDefinition`, `DocumentWriteOptions`, `DatabaseChange`, `SQLiteOptions`, `QueryBuilder`, `ReadDatabase`, `WriteDatabase`, `BackendFunction`, `BackendDefinition`, `FunctionReference`, `ApiOf`, `BackendRuntime`.

## Durable jobs and cron

- `defineJobs({ schema }).jobs(builders)`: inference-first nested job tree sharing an application
  database schema.
- `job({ args, returns?, queue?, priority?, timeoutMs?, retry?, schedules?, handler })`: validated
  async handler definition with agent/operator metadata.
- Mutation `context.jobs.enqueue(definition, args, options?)`: transactional, owner-scoped enqueue.
- `openJobs(definition, { database, ...options })`: low-level durable runtime for an already-open
  Clank SQLite database.
- `runJobProcess(runtime, options?)`: provider-neutral worker/scheduler entry with environment role
  selection and graceful signals.
- `normalizeCron(expression)` / `nextCronOccurrence(expression, after, timezone?)`: strict
  five-field cron parser and IANA-zone occurrence calculation.
- `jobPath(definition)` / `jobManifest(system)`: stable definition identity and agent-readable
  metadata.
- `JobRuntime`: `.enqueue`, `.publisher`, `.get`, `.list`, `.events`, `.stats`, `.cancel`, `.retry`,
  `.purge`, `.workOnce`, `.scheduleOnce`, `.startWorker`, `.startScheduler`, `.close`.
- `openPlatform({ jobs: { alertDueAfterMs } })`: sets the hosted overdue-work alert threshold
  without changing application retry or scheduling policy.
- Hosted job API:
  `GET /api/projects/<id>/jobs?state=&queue=&limit=`,
  `POST /api/projects/<id>/jobs/<job-id>/cancel`, and
  `POST /api/projects/<id>/jobs/<job-id>/retry`. Responses omit arguments, results, error text,
  owner/group identity, worker identity, and lease tokens.
- Types: `JobDefinition`, `JobHandlerContext`, `JobPublisher`, `JobHandle`, `StoredJob`, `JobEvent`,
  `JobStats`, `JobRetryOptions`, `CronDefinition`, `JobWorkerOptions`, `JobSchedulerOptions`,
  `JobRetentionOptions`.

See [Durable jobs and cron](jobs-and-cron.md) for transaction, lease, retry, scheduling, process,
deployment, and at-least-once semantics.

## SSR

- `renderToString(view, options?)`: escaped async HTML rendering with hydration markers by default.
- `renderDocument(view, options?)`: complete document template with title, head content, stylesheets, state, module scripts, and optional CSP nonce.
- `serializeState(value)`: JSON serialization safe for an HTML script element.
- `readState<Value>(id?, root?)`: reads a serialized application state script.
- Types: `RenderStringOptions`, `RenderDocumentOptions`.

## Node

- `serve(app, options?)`: bounded Fetch-standard Node HTTP server with streaming, timeouts, Host allowlists, proxy controls, and redacted errors.
- `staticFiles(root, options?)`: traversal/symlink-aware static GET/HEAD handler with dotfile policy.
- Types: `FetchApplication`, `ServeOptions`, `ServerHandle`, `StaticFilesOptions`.
