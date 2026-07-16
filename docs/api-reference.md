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

## Deployment platform

- `openPlatform(options)`: device authorization, tokens, projects, encrypted secrets, audit, release transaction, logs, rollback, and supervision.
- `PlatformRuntime`: Fetch `.handle`, `.publicUrl`, `.dataDirectory`, async `.close()`.
- Runners: dependency-free process runner or constrained Docker runner.
- Types: `ClankPlatformOptions`, `PlatformRunnerOptions`, `ProcessRunnerOptions`, `DockerRunnerOptions`.

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
