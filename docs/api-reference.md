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

- `clank dev [directory]`: run the deployment-configured build and entry, watch the project,
  health-swap successful replacements, preserve the last good process after errors, and reload
  connected browser tabs.
- `clank build [input] [output]`: compile `.ts`/`.tsx` and copy static files once.
- `clank watch [input] [output]`: rebuild after source changes.
- `--jsx-import-source=specifier`: choose the generated runtime module.
- `compile(source, options?)`: programmatic TypeScript/TSX compilation.
- `transformTSX(source, options?)`: programmatic TSX-only lowering.

## Semantic browser journeys

- `defineJourney(input)` → immutable `JourneyDefinition`: validate and snapshot a bounded,
  data-only semantic acceptance flow.
- `runJourney(journey, driver, options)` → `JourneyReport`: execute with same-origin navigation,
  overall/step timeouts, optional secret resolution, redacted failure surfaces, and step events.
- `createDomJourneyDriver(window, agentSurface)` → `JourneyDriver`: adapt a mounted browser app.
- `clank journey [file]`: run JSON or trusted local module suites in isolated real Chrome.
- Types: `JourneyInput`, `JourneyDefinition`, `JourneyStep`, `JourneyExpectation`,
  `JourneyInputValue`, `JourneySecretReference`, `JourneyDriver`, `JourneyReport`,
  `JourneyStepReport`, `RunJourneyOptions`.

## Realtime collaboration

- `createCollaborationHub(options)` → `CollaborationHub`: authenticated, CSRF-protected,
  same-origin presence and ephemeral signal rooms over bounded Fetch + SSE.
- `createAuthCollaborationHub(auth, options?)`: reuse Clank sessions and CSRF checks with an
  application-supplied exact-room authorization callback.
- `createCollaborationClient(options)` → `CollaborationClient`: reconnecting reactive browser
  state with immutable participants, event/error signals, presence replacement, and signals.
- `CollaborationHub.diagnostics()`: aggregate room/participant/stream counts without identities,
  room names, connection IDs, or payloads.
- Types: `CollaborationValue`, `CollaborationPrincipal`, `CollaborationParticipant`,
  `CollaborationEvent`, `CollaborationOperation`, `CollaborationLimits`, `CollaborationHub`,
  `CollaborationClient`, `CollaborationClientState`, `CreateCollaborationHubOptions`,
  `CreateAuthCollaborationHubOptions`, `CreateCollaborationClientOptions`.

## Product analytics

- `defineAnalytics({ events, funnels? })` → immutable typed event/funnel contract with bounded,
  aggregate-safe properties and a `clank-analytics/1` manifest.
- `openAnalytics(definition, database, options)` → per-app SQLite analytics runtime with
  consent/DNT gates, HMAC pseudonyms, idempotency, sampling, expiry, erasure, and storage bounds.
- `AnalyticsRuntime.track(name, properties, context)`: validate and conditionally persist one event.
- `AnalyticsRuntime.ingest(events, context)`: ingest at most 25 typed memory-only client events
  after server-side identity and consent resolution.
- `AnalyticsRuntime.query(input)`: cohort-protected time series, finite dimension breakdown, and
  bounded numeric average; no raw-event read API exists.
- `AnalyticsRuntime.funnel(name, range)`: ordered, windowed, bounded, cohort-protected conversion.
- `AnalyticsRuntime.forgetSubject(input)`, `.purge(now?)`, `.diagnostics()`: privacy erasure,
  retention, and identity-free aggregate operations.
- `createAnalyticsClient(definition, options)`: typed memory-only consent/DNT-aware batching client
  with application-owned transport and no browser identity or local persistence.
- Types: `AnalyticsDefinition`, `AnalyticsEventInput`, `AnalyticsFunnelInput`,
  `AnalyticsRuntime`, `AnalyticsManifest`, `AnalyticsTrackContext`, `AnalyticsTrackResult`,
  `AnalyticsQueryInput`, `AnalyticsQueryResult`, `AnalyticsFunnelResult`, `AnalyticsClient`,
  `AnalyticsClientEvent`, `OpenAnalyticsOptions`.

## Deployment artifacts

- `readDeploymentConfig(root, filename?)`: read and normalize `clank.deploy.json`.
- `parseDeploymentConfig(value)`: validate a config already in memory.
- `createDeploymentBundle(root, config, options?)`: deterministic gzip artifact with checked files and provenance.
- `decodeDeploymentBundle(bytes, limits?)`: bounded protocol, path, size, base64, and SHA-256 verification.
- `extractDeploymentBundle(bundle, directory)`: exclusive extraction into a release root.
- `deploymentDigest(bytes)`: SHA-256 artifact digest.
- Types: `DeploymentConfig`, `DeployDatabaseConfig`, `DeployPreviewDataConfig`,
  `DeployPreviewDataTableConfig`, `DeployPreviewDataTransform`, `DeployPreviewJsonTransform`,
  `DeploymentBundle`, `DeploymentFile`, `BundleLimits`.

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
- `BackupManager.createFromSnapshot(options)`: validate and directly encrypt a bounded consistent
  SQLite byte snapshot without plaintext repository staging; `databasePath` may be omitted for an
  import-only repository.
- `BackupManager.read(id)`: authenticate and decrypt one recovery point into bounded memory for a
  fenced remote restore path without writing plaintext staging data.
- `BackupManager.purge({ confirmation: "delete all backups" })`: explicit repository-wide cleanup,
  including incomplete object promotions.
- Local mode commits owner-only envelope/manifest directories atomically. Object mode promotes
  existing local copies, publishes an HMAC-authenticated per-database catalog, verifies every
  chunk and the reconstructed database, and retains the local copy after provider failure.
- Types: `BackupManager`, `BackupManagerOptions`, `BackupManifest`, `BackupVerification`,
  `BackupSnapshotInput`, `BackupReadResult`, `BackupObjectRepositoryOptions`.

## Deployment platform

- `openPlatform(options)`: browser dashboard, workspace people/invitation administration and
  activity, transparent monthly usage, device authorization, tokens, projects, transactionally
  enforced capacity and traffic limits, ingress metrics, DNS/domain lifecycle, TLS eligibility,
  encrypted secrets, role-filtered audit, release transaction, logs, rollback, and supervision.
- `PlatformRuntime`: Fetch `.handle`, `.publicUrl`, `.dataDirectory`, resolved `.hostingProfile`,
  `.runnerKind`, and async `.close()`.
- Runners: dependency-free process runner or constrained Docker runner.
- `openPlatform({ invitations })`: durable, encrypted, cross-instance-leased invitation delivery
  through any `EmailService`, while retaining manual copy-once fallback.
- Types: `ClankPlatformOptions`, `PlatformBackupOptions`, `PlatformJobOperationsOptions`,
  `PlatformInvitationDeliveryOptions`, `PlatformLimits`, `PlatformHostingProfile`,
  `PlatformRunnerOptions`, `ProcessRunnerOptions`, `DockerRunnerOptions`,
  `PlatformProjectPlacement`.
- `openPlatform({ deploymentAgents: { placement } })`: enables immutable per-project
  `local | provider` selection. Provider projects use stateful endpoint/label placement, an
  encrypted frozen environment per generation, lease-scoped `clank-runtime/1`, exact observed
  activation, allowlisted managed-ingress publication, fenced rollback/delete, and resumable
  pending deploys. Generation-bound provider snapshots feed the same encrypted local or object
  recovery repository used by local projects; create, schedule, list, verify, and fenced restore
  are supported. Restore verifies the selected point, creates a safety recovery point, and
  publishes a replacement generation only after provider data replacement, current migrations,
  and health succeed. The same exact active generation supplies bounded logs and Docker
  memory/CPU/PID/network/block-I/O diagnostics plus shared provider-filesystem capacity to a
  platform-administrator browser session; token, project-member, and support-impersonation
  responses redact shared capacity to an unavailable record. Secret values are redacted at the control plane. `placement.maxDatabaseBytes` bounds snapshot transfer, recovery reads, and
  runtime-capsule capacity. Provider placement requires managed ingress.
- `POST /api/admin/projects/:projectId/provider-failover`: browser-admin-only emergency recovery
  from a revoked and independently fenced exact source. Requires recent authentication, CSRF,
  `backupId`, `sourceNodeId`, exact `confirmation`, `acknowledgeSourceFenced: true`, and
  `acknowledgeDataLoss: true`. It verifies the encrypted recovery point, preserves target
  requirements/capacity, removes old ingress, and publishes only an exactly observed higher
  generation. Bearer tokens and support impersonation are rejected.

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
- `DeploymentOrchestrator.relocateStateful({ projectId, sourceNodeId, runtimeProtocol })`: advances
  an exact running stateful placement to a different compatible node only after the source is
  offline or expired, preserves region/capability/process-slot requirements, cancels stale work,
  clears observed state, and queues one higher-generation reconcile. This low-level primitive does
  not move data or prove physical fencing; platform callers must supply and verify recovery data
  and enforce the operator boundary.
- `DeploymentOrchestrator.setDesired({ nodeRequirements })`: persists endpoint and exact-label
  capability requirements so initial and delayed placement select only compatible nodes.
- Types: `DeploymentCoordinatorHandler`, `DeploymentCoordinatorHandlerOptions`,
  `DeploymentCoordinatorClient`, `DeploymentCoordinatorClientOptions`,
  `DeploymentArtifact`, `DeploymentArtifactRequest`, `DeploymentArtifactProvider`,
  `DeploymentNodeCredentialStore`, `DeploymentExecutionContext`, `DeploymentAgentOptions`,
  `DeploymentAgentRuntime`.

## Deployment providers

- `openProviderDeploymentAgent(options)`: validates canonical desired-state plus rollback/delete
  operations, verifies running artifacts, derives destructive confirmations, strips coordinator
  credentials before adapter execution, and returns only fixed non-secret results.
- `executeDeploymentProvider(provider, operation, context)`: reusable dispatcher for reconcile,
  rollback, and delete operations.
- `reconcileDeploymentProvider(provider, operation, context)`: reusable validation/execution
  boundary for custom reconcile-only agent loops.
- `createHttpDeploymentProvider(options)`: HTTPS/loopback-only binary client with a separate bearer
  token, redirect refusal, deadlines, exact idempotent retries, and bounded failure responses.
- `createDeploymentProviderHandler(provider, options)`: authenticated fixed-path bridge that
  independently bounds, hashes, and decodes reconcile content while requiring empty-body,
  generation/fence-bound rollback and deletion.
- `DEPLOYMENT_PROVIDER_RECONCILE_PATH`, `DEPLOYMENT_PROVIDER_ROLLBACK_PATH`, and
  `DEPLOYMENT_PROVIDER_DELETE_PATH`: fixed provider protocol paths.
- `DeploymentProviderError`: stable HTTP `status` and `code` without a provider response body.
- Types: `DeploymentProvider`, `DeploymentProviderRequest`,
  `DeploymentProviderLifecycleRequest`, `DeploymentProviderOperation`,
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
- `diagnostics(projectId, logLimit?, signal?)`: returns a bounded memory-only output tail and one
  non-streaming per-role Docker resource sample plus a path-free shared-filesystem capacity sample,
  or `null` when no runtime is tracked. An optional abort signal cancels the one-shot Docker
  command.
- `inspect()`, `stop(projectId, generation?)`, `forget(projectId, generation)`, and `close()`:
  non-secret state, verified container removal, deletion cleanup, and fail-closed shutdown.
- Types: `DockerDeploymentRuntimeLauncherOptions`, `DockerDeploymentRuntimeCandidate`,
  `DockerDeploymentRuntimeState`, `DockerDeploymentRuntimeDiagnostics`,
  `DockerDeploymentFilesystemDiagnostics`, `DockerDeploymentRuntimeLauncher`.

## Complete deployment provider service

- `openDockerDeploymentProviderService(options)`: opens provider data, exact-owner Docker cleanup
  and launch, private runtime ingress, and durable service fencing with secure defaults.
- `openDeploymentProviderService(options)`: composes injected data, Docker-runtime, and ingress
  components for custom hosting and deterministic tests.
- `reconcile(request)`: independently verifies the capsule, persists exact operation/fence intent,
  drains before stopping a writer, recovers/stages/migrates data, defers jobs until commit,
  activates ingress last, and supports exact retry after response loss or restart.
- `rollback(request)`: requires the exact current data generation, project-wide operation fence,
  confirmation, and abort signal; it drains all writers, durably records intent, restores the
  immediate predecessor, and resumes an interrupted post-commit attempt.
- `delete(request)`: requires the same fenced lifecycle envelope plus exact project confirmation,
  then drains all writers and removes provider data and service state idempotently.
- `handle(request)`: generation-bound private application ingress plus separately authenticated
  active-generation snapshot and diagnostics control boundaries.
- `deploymentProviderSnapshotPath(projectId)`: exact provider-private path for the consistent
  SQLite snapshot endpoint. It requires the memory-only control token carried by the active
  runtime capsule and returns `DEPLOYMENT_PROVIDER_SNAPSHOT_MEDIA_TYPE`.
- `deploymentProviderDiagnosticsPath(projectId)`: exact provider-private path for current
  generation logs and resource attribution. It uses the separate memory-only control token and
  returns `DEPLOYMENT_PROVIDER_DIAGNOSTICS_MEDIA_TYPE`.
- `inspect(projectId)`, `snapshot(projectId)`, `diagnostics(projectId, logLimit?)`, and `close()`:
  serialized non-secret durable progress, consistent backup input, bounded runtime visibility, and
  revoke/drain/verified-stop shutdown.
- `DeploymentProviderDataStore.apply(input, validate, discard?)`: optional cleanup hook runs before
  uncommitted SQLite rollback; failed cleanup leaves the journal intact.
- Types: `DeploymentProviderService`, `DeploymentProviderServiceLifecycleRequest`,
  `DeploymentProviderServiceOptions`, `DockerDeploymentProviderServiceOptions`, and
  `DeploymentProviderServiceState`.

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
- `AppAdminStudioDefinition`: configure the generated studio's static path, application roles,
  entity allowlist, and mutation-control visibility. Backend action roles and ownership remain
  authoritative.
- Blueprint fixtures: `AppFixtureDefinition`, `AppFixtureUserDefinition`,
  `AppFixtureRecordDefinition`, and `AppFixtureValue` describe bounded synthetic states. Normalized
  `AppFixture`, `AppFixtureUser`, and `AppFixtureRecord` values are frozen, included in plan
  checksums, written under `fixtures/`, and exercised by the generated app-owned test.

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
- `McpServerOptions.metadata`: optional bounded immutable contract data published inside the
  authenticated `clank://actions` resource; framework workflow graphs use this channel.
- `McpServer.revision`: deterministic identity of server metadata, contract metadata, and the
  complete visible tool contract.
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
- Authenticated backends expose a server-rendered agent access inbox at
  `/__clank/oauth/access` and the no-store `clank-agent-grants/1` contract at
  `/__clank/oauth/grants`. `agent.maxUserGrants` sets the per-user active-family ceiling from 1
  through 1,000; the default is 100.
- `agentActionPath(reference)`: resolve a literal or typed backend function reference to its exact
  browser/MCP path.
- `inspectAgentActions(htmlOrRoot)`: collect bounded `data-clank-action` controls from SSR HTML or
  a rendered DOM.
- `checkAgentActionParity(surface, manifest, options?)`: return a frozen
  `clank-agent-action-parity/1` report without throwing.
- `assertAgentActionParity(...)`: throw `AgentActionParityError` when a rendered action is stale,
  internal, undocumented, missing a stable ID, or absent when required.
- `verifyAgentActionParity(surface, options?)`: fetch the no-store backend manifest with a bounded
  response, bind its contract-revision header, and assert the current rendered surface.
- Types: `AgentActionTarget`, `AgentActionControl`, `AgentBackendManifest`,
  `AgentActionParityOptions`, `AgentActionParityReport`, and `VerifyAgentActionParityOptions`.

See [Agent protocol](agent-protocol.md) for connection, OAuth, scope, discovery, and security
details, and [Agent access](agent-access.md) for grant inspection, reduction, and revocation.

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
- Read table: `.get`, `.query`, `.collect`, `.history(id?, options?)`.
- Write table: `.insert`, `.patch`, `.replace`, `.delete`, `.restore(id, cursor, options?)`.
- `DocumentWriteOptions`: `{ ifVersion }` optimistic concurrency for patch, replace, and delete.
- `DatabaseConflictError`: stale-write error exposed as HTTP `409 VERSION_CONFLICT`.
- `DocumentRevision`, `DocumentRevisionCursor`, `DocumentHistoryOptions`, and
  `DocumentRestoreOptions`: typed immutable snapshots, bounded pagination, and compensating restore.
- `DatabaseRevisionNotFoundError`: unavailable or ownership-hidden history exposed as
  `404 REVISION_NOT_FOUND`.
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

## Service drivers

- `createServiceRegistry(drivers)`: named capability registry with startup assertions, isolated
  health checks, and reverse-order shutdown.
- `openFileEmailService({ directory })`: owner-only development outbox; it does not send mail.
- `createHttpEmailService(options)`: normalized HTTPS JSON delivery with bounded transport retry,
  optional bearer authorization, and idempotency forwarding.
- `createResendEmailService(options)`: zero-SDK Resend `POST /emails` driver with provider recipient
  and tag validation plus idempotency forwarding.
- Types: `ServiceDriver`, `ServiceRequirement`, `ServiceRegistry`, `EmailAddress`, `EmailMessage`,
  `EmailReceipt`, and `EmailService`.

See [Service drivers](services.md) and [Invitations and email delivery](invitations.md).

## Durable jobs and cron

- `defineJobs({ schema }).jobs(builders)`: inference-first nested job tree sharing an application
  database schema.
- `defineWorkflow({ args, graph, returns?, output?, agent? })`: typed acyclic graph over ordinary
  jobs. `step(job, { needs?, args })` declares explicit result flow and parallel-ready work.
- `defineWorkflows(jobSystem, tree)`: registers stable nested workflow paths on a job system.
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
- `workflowPath(definition)` / `workflowManifest(system)`: stable graph identity, schemas, step job
  paths, dependency edges, descriptions, and agent metadata.
- `JobRuntime`: `.enqueue`, `.publisher`, `.get`, `.list`, `.events`, `.stats`, `.cancel`, `.retry`,
  `.purge`, `.startWorkflow`, `.getWorkflow`, `.listWorkflows`, `.workflowEvents`,
  `.cancelWorkflow`, `.purgeWorkflows`, `.advanceWorkflows`, `.workOnce`, `.scheduleOnce`,
  `.startWorker`, `.startScheduler`, `.close`.
- `openPlatform({ jobs: { alertDueAfterMs } })`: sets the hosted overdue-work alert threshold
  without changing application retry or scheduling policy.
- Hosted job API:
  `GET /api/projects/<id>/jobs?state=&queue=&limit=`,
  `POST /api/projects/<id>/jobs/<job-id>/cancel`, and
  `POST /api/projects/<id>/jobs/<job-id>/retry`. Responses omit arguments, results, error text,
  owner/group identity, worker identity, and lease tokens. Provider projects use the identical
  contract through an exact-generation authenticated private control route and fail closed with
  `PROVIDER_JOBS_UNAVAILABLE` during node or generation instability.
- Types: `JobDefinition`, `JobHandlerContext`, `JobPublisher`, `JobHandle`, `StoredJob`, `JobEvent`,
  `JobStats`, `JobRetryOptions`, `CronDefinition`, `JobWorkerOptions`, `JobSchedulerOptions`,
  `JobRetentionOptions`, `WorkflowDefinition`, `WorkflowStepDefinition`, `WorkflowHandle`,
  `StoredWorkflowRun`, `StoredWorkflowStep`, `WorkflowEvent`, and `WorkflowManifestEntry`.

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
