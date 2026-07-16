import { defineAuth, openAuth, type AuthRequest, type AuthRuntime, type DefaultAuthProfile } from "./auth.ts";
import { defineDatabase, openSQLite, type SQLiteDatabase } from "./backend.ts";
import {
  decodeDeploymentBundle,
  deploymentDigest,
  extractDeploymentBundle,
  type DeploymentBundle,
} from "./deploy.ts";
import {
  applyMigrations,
  backupSQLite,
  restoreSQLiteBackup,
} from "./migrations.ts";
import { requestOriginAllowed, RequestInputError, readJsonRequest } from "./security.ts";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.ts";

export interface ProcessRunnerOptions {
  kind?: "process";
}

export interface DockerRunnerOptions {
  kind: "docker";
  executable?: string;
  image?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
}

export type PlatformRunnerOptions = ProcessRunnerOptions | DockerRunnerOptions;

export interface ClankPlatformOptions {
  dataDirectory: string;
  publicUrl: string;
  appHostname?: string;
  /** Public application URL pattern. Supports {slug} and {port}. */
  appUrlTemplate?: string;
  appPortStart?: number;
  appPortEnd?: number;
  runner?: PlatformRunnerOptions;
  /** Defaults to "bootstrap": only the first platform account may self-register. */
  signup?: boolean | "bootstrap";
  masterKey?: string | Uint8Array;
  maxArtifactBytes?: number;
  /** Operator-only escape hatch for configs that request unrestricted SQLite SQL. */
  allowUnsafeMigrations?: boolean;
  deviceCodeLifetimeMs?: number;
  accessTokenLifetimeMs?: number;
  exposeErrors?: boolean;
  onError?: (error: unknown) => void;
}

export interface PlatformRuntime {
  readonly handle: (request: Request) => Promise<Response>;
  readonly publicUrl: string;
  readonly dataDirectory: string;
  close(): Promise<void>;
}

interface NativeChild {
  readonly pid?: number;
  readonly stdout?: AsyncIterable<Uint8Array> & { setEncoding?(encoding: string): void };
  readonly stderr?: AsyncIterable<Uint8Array> & { setEncoding?(encoding: string): void };
  readonly exitCode?: number | null;
  kill(signal?: string): boolean;
  once(event: "error" | "exit", listener: (...arguments_: any[]) => void): void;
}

interface ActiveProcess {
  projectId: string;
  releaseId: string;
  port: number;
  child: NativeChild;
  expectedStop: boolean;
}

interface ProjectRow {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  port: number;
  activeReleaseId: string | null;
  databasePath: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ReleaseRow {
  id: string;
  projectId: string;
  previousReleaseId: string | null;
  status: string;
  digest: string;
  artifactBytes: number;
  frameworkVersion: string;
  nodeVersion: string;
  config: DeploymentBundle["config"];
  directory: string;
  backupPath: string | null;
  createdAt: number;
  activatedAt: number | null;
  failure: string | null;
}

interface TokenPrincipal {
  tokenId: string;
  userId: string;
  email: string;
}

interface PlatformDatabase {
  database: SQLiteDatabase<ReturnType<typeof defineDatabase<{}>>>;
  internal: SQLiteInternal;
  auth: AuthRuntime<DefaultAuthProfile>;
}

class PlatformError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

const TOKEN_PREFIX = "clnk_";
const DEVICE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const PROJECT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** Opens Clank's self-hostable deployment control plane and release supervisor. */
export async function openPlatform(options: ClankPlatformOptions): Promise<PlatformRuntime> {
  // The platform is a dedicated control-plane process. A private umask keeps
  // SQLite journals, backups, logs, and generated launchers owner-readable only.
  (globalThis as any).process.umask?.(0o077);
  const publicUrl = normalizePublicUrl(options.publicUrl);
  const appUrlTemplate = normalizeAppUrlTemplate(
    options.appUrlTemplate ?? `http://${options.appHostname ?? "127.0.0.1"}:{port}`,
  );
  const paths = await prepareDirectories(options.dataDirectory);
  const masterKey = await resolveMasterKey(paths.root, options.masterKey);
  const signupMode = options.signup ?? "bootstrap";
  const storage = await openPlatformDatabase(paths.controlDatabase, signupMode !== false);
  const active = new Map<string, ActiveProcess>();
  const locks = new Map<string, Promise<unknown>>();
  const restartState = new Map<string, {
    count: number;
    windowStartedAt: number;
    cancelled: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  const deviceLimiter = new Map<string, { count: number; resetAt: number }>();
  let bootstrapRegistrationActive = false;
  let closed = false;

  const withProjectLock = async <Value>(projectId: string, operation: () => Promise<Value>): Promise<Value> => {
    const previous = locks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    locks.set(projectId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(projectId) === queued) locks.delete(projectId);
    }
  };

  const stopProject = async (projectId: string): Promise<void> => {
    const running = active.get(projectId);
    if (!running) return;
    running.expectedStop = true;
    active.delete(projectId);
    await stopChild(running.child);
  };

  const cancelRestart = (projectId: string) => {
    const state = restartState.get(projectId);
    if (state) state.cancelled = true;
    if (state?.timer) clearTimeout(state.timer);
    restartState.delete(projectId);
  };

  const recordLog = (projectId: string, releaseId: string, stream: string, message: string) => {
    const safe = message.replace(/[\u0000]/g, "").slice(0, 16_384);
    if (!safe) return;
    storage.internal.prepare(
      "INSERT INTO clank_platform_logs (project_id, release_id, stream, message, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(projectId, releaseId, stream, safe, Date.now());
    storage.internal.prepare(`DELETE FROM clank_platform_logs
      WHERE project_id = ? AND id NOT IN (
        SELECT id FROM clank_platform_logs WHERE project_id = ? ORDER BY id DESC LIMIT 5000
      )`).run(projectId, projectId);
  };

  const startRelease = async (
    project: ProjectRow,
    release: ReleaseRow,
    secrets: Record<string, string>,
  ): Promise<ActiveProcess> => {
    const current = active.get(project.id);
    if (current) await stopProject(project.id);
    const dataRoot = await projectDataDirectory(paths.projects, project.id);
    const databaseHostPath = await safeProjectDataPath(dataRoot, release.config.database.path);
    const environment = {
      ...release.config.env,
      ...secrets,
      NODE_ENV: "production",
      PORT: String(project.port),
      CLANK_DATABASE_PATH: databaseHostPath,
      CLANK_DATABASE: databaseHostPath,
      PROACT_DATABASE_PATH: databaseHostPath,
      PROACT_DATABASE: databaseHostPath,
      ALLOWED_HOSTS: `localhost,127.0.0.1,${options.appHostname ?? "127.0.0.1"}`,
      TRUST_PROXY: "0",
    };
    await assertPortAvailable(project.port);
    const child = await spawnRelease(
      options.runner ?? { kind: "process" },
      release,
      dataRoot,
      project.port,
      environment,
    );
    const running: ActiveProcess = {
      projectId: project.id,
      releaseId: release.id,
      port: project.port,
      child,
      expectedStop: false,
    };
    active.set(project.id, running);
    captureOutput(child.stdout, (line) => recordLog(project.id, release.id, "stdout", redact(line, secrets)));
    captureOutput(child.stderr, (line) => recordLog(project.id, release.id, "stderr", redact(line, secrets)));
    child.once("error", (error) => {
      recordLog(project.id, release.id, "platform", `Process error: ${safeError(error)}`);
    });
    child.once("exit", (code, signal) => {
      if (active.get(project.id) === running) active.delete(project.id);
      recordLog(project.id, release.id, "platform", `Process exited (${String(code ?? signal ?? "unknown")}).`);
      if (!running.expectedStop && !closed) {
        storage.internal.prepare("UPDATE clank_platform_releases SET status = 'crashed', failure = ? WHERE id = ?")
          .run(`Process exited (${String(code ?? signal ?? "unknown")}).`, release.id);
        scheduleRestart(project.id, release.id);
      }
    });
    await waitForHealth(project.port, release.config.health.path, release.config.health.timeoutMs, child);
    return running;
  };

  const scheduleRestart = (projectId: string, releaseId: string): void => {
    if (closed) return;
    const now = Date.now();
    let state = restartState.get(projectId);
    if (!state || now - state.windowStartedAt > 60_000) {
      state = { count: 0, windowStartedAt: now, cancelled: false };
      restartState.set(projectId, state);
    }
    if (state.cancelled) return;
    if (state.timer || state.count >= 5) {
      if (state.count >= 5) {
        recordLog(projectId, releaseId, "platform", "Automatic restart limit reached (5 per minute).");
      }
      return;
    }
    state.count++;
    const delay = Math.min(10_000, 250 * 2 ** (state.count - 1));
    state.timer = setTimeout(() => {
      state!.timer = undefined;
      void (async () => {
        if (closed || state!.cancelled) return;
        const project = projectById(storage.internal, projectId);
        if (!project || project.activeReleaseId !== releaseId) return;
        const release = releaseById(storage.internal, releaseId);
        if (!release) return;
        try {
          await startRelease(project, release, decryptProjectSecrets(storage.internal, project.id, masterKey));
          storage.internal.prepare(
            "UPDATE clank_platform_releases SET status = 'active', failure = NULL WHERE id = ?",
          ).run(release.id);
          recordLog(project.id, release.id, "platform", `Automatically restarted after ${delay}ms.`);
        } catch (error) {
          options.onError?.(error);
          if (state!.cancelled || closed) return;
          if (active.get(project.id)?.releaseId === release.id) await stopProject(project.id);
          recordLog(project.id, release.id, "platform", `Automatic restart failed: ${safeError(error)}`);
          if (!state!.cancelled) scheduleRestart(project.id, release.id);
        }
      })();
    }, delay);
  };

  const deploy = async (
    principal: TokenPrincipal,
    project: ProjectRow,
    bytes: Uint8Array,
    claimedDigest: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> => withProjectLock(project.id, async () => {
    cancelRestart(project.id);
    const digest = await deploymentDigest(bytes);
    if (claimedDigest !== digest) throw new PlatformError(400, "DIGEST_MISMATCH", "Artifact digest does not match its header.");
    const existing = storage.internal.prepare(
      "SELECT id, status FROM clank_platform_releases WHERE project_id = ? AND idempotency_key = ?",
    ).get(project.id, idempotencyKey);
    if (existing) {
      const release = releaseById(storage.internal, String(existing.id));
      return releasePayload(project, release!, appUrlTemplate);
    }
    let bundle: DeploymentBundle;
    try {
      bundle = await decodeDeploymentBundle(bytes, {
        maxTotalBytes: options.maxArtifactBytes ?? 100 * 1024 * 1024,
      });
    } catch (error) {
      throw new PlatformError(422, "INVALID_ARTIFACT", safeError(error));
    }
    if (bundle.config.database.allowUnsafeMigrations && options.allowUnsafeMigrations !== true) {
      throw new PlatformError(
        403,
        "UNSAFE_MIGRATIONS_DISABLED",
        "This platform does not allow unrestricted migration SQL.",
      );
    }
    if (project.databasePath && project.databasePath !== bundle.config.database.path) {
      throw new PlatformError(
        409,
        "DATABASE_PATH_CHANGED",
        "Changing database.path would create a second production database. Migrate it explicitly before deploying.",
      );
    }
    const releaseId = await randomId(18);
    const releaseDirectory = await newReleaseDirectory(paths.projects, project.id, releaseId);
    const previousReleaseId = project.activeReleaseId;
    const createdAt = Date.now();
    storage.internal.prepare(`INSERT INTO clank_platform_releases
      (id, project_id, previous_release_id, status, digest, artifact_bytes, framework_version,
       node_version, config, directory, backup_path, idempotency_key, created_at)
      VALUES (?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(
        releaseId,
        project.id,
        previousReleaseId,
        digest,
        bytes.byteLength,
        bundle.provenance.frameworkVersion,
        bundle.provenance.nodeVersion,
        JSON.stringify(bundle.config),
        releaseDirectory,
        idempotencyKey,
        createdAt,
      );
    let backupPath: string | null = null;
    let databaseExisted = false;
    try {
      await extractDeploymentBundle(bundle, releaseDirectory);
      const dataRoot = await projectDataDirectory(paths.projects, project.id);
      await stopProject(project.id);
      const databasePath = await safeProjectDataPath(dataRoot, bundle.config.database.path);
      databaseExisted = await fileExists(databasePath);
      if (databaseExisted) {
        backupPath = await releaseBackupPath(paths.projects, project.id, releaseId);
        await backupSQLite(databasePath, backupPath);
        storage.internal.prepare("UPDATE clank_platform_releases SET backup_path = ? WHERE id = ?")
          .run(backupPath, releaseId);
      }
      const migrationDirectory = await safeReleasePath(releaseDirectory, bundle.config.database.migrations);
      await applyMigrations({
        path: databasePath,
        directory: migrationDirectory,
        allowUnsafe: bundle.config.database.allowUnsafeMigrations,
      });
      const refreshedProject = { ...project, databasePath: bundle.config.database.path };
      const release = releaseById(storage.internal, releaseId)!;
      const secrets = decryptProjectSecrets(storage.internal, project.id, masterKey);
      await startRelease(refreshedProject, release, secrets);
      const activatedAt = Date.now();
      storage.internal.transaction((changes) => {
        storage.internal.prepare(
          "UPDATE clank_platform_releases SET status = 'active', activated_at = ?, failure = NULL WHERE id = ?",
        ).run(activatedAt, releaseId);
        if (previousReleaseId) {
          storage.internal.prepare(
            "UPDATE clank_platform_releases SET status = 'inactive' WHERE id = ? AND status = 'active'",
          ).run(previousReleaseId);
        }
        storage.internal.prepare(
          "UPDATE clank_platform_projects SET active_release_id = ?, database_path = ?, updated_at = ? WHERE id = ?",
        ).run(releaseId, bundle.config.database.path, activatedAt, project.id);
        changes.record("__platform", project.id);
      });
      audit(storage.internal, principal.userId, principal.tokenId, project.id, "release.activate", {
        releaseId,
        digest,
        previousReleaseId,
      });
      return releasePayload(
        { ...refreshedProject, activeReleaseId: releaseId, updatedAt: activatedAt },
        { ...release, status: "active", activatedAt, backupPath },
        appUrlTemplate,
      );
    } catch (error) {
      options.onError?.(error);
      await stopProject(project.id);
      try {
        const dataRoot = await projectDataDirectory(paths.projects, project.id);
        const databasePath = await safeProjectDataPath(dataRoot, bundle.config.database.path);
        if (backupPath) await restoreSQLiteBackup(backupPath, databasePath);
        else if (!databaseExisted) await removeDatabaseFiles(databasePath);
        if (previousReleaseId) {
          const previous = releaseById(storage.internal, previousReleaseId);
          if (previous) {
            await startRelease(project, previous, decryptProjectSecrets(storage.internal, project.id, masterKey));
          }
        }
      } catch (restoreError) {
        options.onError?.(restoreError);
      }
      const failure = safeError(error);
      storage.internal.prepare(
        "UPDATE clank_platform_releases SET status = 'failed', failure = ? WHERE id = ?",
      ).run(failure, releaseId);
      audit(storage.internal, principal.userId, principal.tokenId, project.id, "release.fail", {
        releaseId,
        digest,
        failure,
      });
      throw new PlatformError(422, "DEPLOYMENT_FAILED", failure);
    }
  });

  const rollback = async (
    principal: TokenPrincipal,
    project: ProjectRow,
    targetId: string,
    restoreData: boolean,
    confirmation: string | undefined,
  ): Promise<Record<string, unknown>> => withProjectLock(project.id, async () => {
    cancelRestart(project.id);
    const current = project.activeReleaseId ? releaseById(storage.internal, project.activeReleaseId) : null;
    const target = releaseById(storage.internal, targetId);
    if (!current || !target || target.projectId !== project.id) {
      throw new PlatformError(404, "RELEASE_NOT_FOUND", "Release not found.");
    }
    if (target.id === current.id) return releasePayload(project, current, appUrlTemplate);
    if (restoreData) {
      if (target.id !== current.previousReleaseId || !current.backupPath) {
        throw new PlatformError(409, "DATA_RESTORE_UNAVAILABLE", "Data restore is available only for the immediately previous release with a snapshot.");
      }
      if (confirmation !== `restore ${project.slug}`) {
        throw new PlatformError(400, "CONFIRMATION_REQUIRED", `Pass confirmation "restore ${project.slug}".`);
      }
    }
    await stopProject(project.id);
    const dataRoot = await projectDataDirectory(paths.projects, project.id);
    const currentDatabasePath = await safeProjectDataPath(dataRoot, current.config.database.path);
    let safetyBackup: string | null = null;
    try {
      if (restoreData) {
        safetyBackup = await releaseBackupPath(paths.projects, project.id, `rollback-${await randomId(8)}`);
        await backupSQLite(currentDatabasePath, safetyBackup);
        await restoreSQLiteBackup(current.backupPath!, currentDatabasePath);
      }
      await startRelease(project, target, decryptProjectSecrets(storage.internal, project.id, masterKey));
      const now = Date.now();
      storage.internal.transaction((changes) => {
        storage.internal.prepare("UPDATE clank_platform_releases SET status = 'inactive' WHERE id = ?").run(current.id);
        storage.internal.prepare("UPDATE clank_platform_releases SET status = 'active', activated_at = ? WHERE id = ?")
          .run(now, target.id);
        storage.internal.prepare("UPDATE clank_platform_projects SET active_release_id = ?, database_path = ?, updated_at = ? WHERE id = ?")
          .run(target.id, target.config.database.path, now, project.id);
        changes.record("__platform", project.id);
      });
      audit(storage.internal, principal.userId, principal.tokenId, project.id, "release.rollback", {
        from: current.id,
        to: target.id,
        restoreData,
      });
      return releasePayload(
        { ...project, activeReleaseId: target.id, updatedAt: now },
        { ...target, status: "active", activatedAt: now },
        appUrlTemplate,
      );
    } catch (error) {
      await stopProject(project.id);
      if (safetyBackup) await restoreSQLiteBackup(safetyBackup, currentDatabasePath);
      await startRelease(project, current, decryptProjectSecrets(storage.internal, project.id, masterKey));
      throw new PlatformError(422, "ROLLBACK_FAILED", safeError(error));
    }
  });

  const handle = async (request: Request): Promise<Response> => {
    if (closed) return problem(503, "PLATFORM_CLOSED", "Platform is closed.");
    try {
      const url = new URL(request.url);
      if (url.pathname === "/healthz" && request.method === "GET") {
        return api({ ok: true, status: "ready" });
      }
      const authPrefix = url.pathname === "/__proact/auth" || url.pathname.startsWith("/__proact/auth/")
        ? "/__proact/auth"
        : "/__clank/auth";
      if (url.pathname === authPrefix || url.pathname.startsWith(`${authPrefix}/`)) {
        const registering = request.method === "POST" && url.pathname === `${authPrefix}/register`;
        if (registering && signupMode === "bootstrap") {
          const count = Number(storage.internal.prepare("SELECT count(*) AS count FROM clank_auth_users").get()?.count ?? 0);
          if (count > 0) return problem(403, "SIGNUP_DISABLED", "Platform registration is closed.");
          if (bootstrapRegistrationActive) return problem(409, "SIGNUP_IN_PROGRESS", "The first account is already being created.");
          bootstrapRegistrationActive = true;
          try {
            return await storage.auth.handle(request, authPrefix);
          } finally {
            bootstrapRegistrationActive = false;
          }
        }
        return storage.auth.handle(request, authPrefix);
      }
      if (url.pathname === "/" && request.method === "GET") {
        const auth = await storage.auth.resolve(request);
        const userCount = Number(storage.internal.prepare("SELECT count(*) AS count FROM clank_auth_users").get()?.count ?? 0);
        return consolePage(
          publicUrl,
          auth,
          url.searchParams.get("code") ?? "",
          signupMode === true || (signupMode === "bootstrap" && userCount === 0),
        );
      }
      if (url.pathname === "/api/device/start" && request.method === "POST") {
        enforceDeviceRateLimit(deviceLimiter, request);
        const input = plainObject(await readJsonRequest(request, 8 * 1024));
        exact(input, ["clientName"]);
        const clientName = boundedString(input.clientName, "clientName", 1, 100);
        const deviceCode = await randomToken(32);
        const userCode = await randomUserCode();
        const now = Date.now();
        const expiresAt = now + (options.deviceCodeLifetimeMs ?? 10 * 60 * 1_000);
        storage.internal.prepare(`INSERT INTO clank_platform_device_codes
          (device_hash, user_code, client_name, status, user_id, created_at, expires_at, last_poll_at, consumed_at)
          VALUES (?, ?, ?, 'pending', NULL, ?, ?, 0, NULL)`)
          .run(await hash(deviceCode), userCode, clientName, now, expiresAt);
        return api({
          ok: true,
          deviceCode,
          userCode,
          verificationUri: `${publicUrl}/?code=${encodeURIComponent(userCode)}`,
          expiresIn: Math.floor((expiresAt - now) / 1_000),
          interval: 3,
        }, 201);
      }
      if (url.pathname === "/api/device/token" && request.method === "POST") {
        const input = plainObject(await readJsonRequest(request, 8 * 1024));
        exact(input, ["deviceCode"]);
        const deviceCode = boundedString(input.deviceCode, "deviceCode", 20, 200);
        const deviceHash = await hash(deviceCode);
        const row = storage.internal.prepare(
          "SELECT * FROM clank_platform_device_codes WHERE device_hash = ?",
        ).get(deviceHash);
        if (!row || Number(row.expires_at) <= Date.now()) {
          throw new PlatformError(400, "EXPIRED_TOKEN", "Device authorization expired.");
        }
        if (row.consumed_at !== null) throw new PlatformError(400, "EXPIRED_TOKEN", "Device authorization was already consumed.");
        const lastPoll = Number(row.last_poll_at);
        if (lastPoll && Date.now() - lastPoll < 2_500) {
          throw new PlatformError(429, "SLOW_DOWN", "Poll less frequently.", 3);
        }
        storage.internal.prepare("UPDATE clank_platform_device_codes SET last_poll_at = ? WHERE device_hash = ?")
          .run(Date.now(), deviceHash);
        if (row.status === "denied") throw new PlatformError(403, "ACCESS_DENIED", "Device authorization was denied.");
        if (row.status !== "approved" || !row.user_id) {
          throw new PlatformError(428, "AUTHORIZATION_PENDING", "Authorization is still pending.", 3);
        }
        const rawToken = `${TOKEN_PREFIX}${await randomToken(32)}`;
        const tokenId = await randomId(18);
        const expiresAt = Date.now() + (options.accessTokenLifetimeMs ?? 90 * 24 * 60 * 60 * 1_000);
        storage.internal.transaction((changes) => {
          const result = storage.internal.prepare(
            "UPDATE clank_platform_device_codes SET consumed_at = ? WHERE device_hash = ? AND consumed_at IS NULL",
          ).run(Date.now(), deviceHash);
          if (Number(result.changes) !== 1) throw new PlatformError(409, "TOKEN_CONSUMED", "Device authorization was already consumed.");
          storage.internal.prepare(`INSERT INTO clank_platform_tokens
            (id, token_hash, user_id, name, created_at, last_used_at, expires_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`)
            .run(tokenId, syncHash(rawToken), row.user_id, row.client_name, Date.now(), expiresAt);
          changes.record("__platform", String(row.user_id));
        });
        audit(storage.internal, String(row.user_id), tokenId, null, "token.create", {
          name: String(row.client_name),
        });
        return api({ ok: true, accessToken: rawToken, tokenType: "Bearer", expiresAt });
      }
      if (url.pathname === "/api/device/info" && request.method === "GET") {
        const auth = await requireBrowserAuth(storage.auth, request);
        const code = normalizeUserCode(url.searchParams.get("code") ?? "");
        const row = storage.internal.prepare(
          "SELECT user_code, client_name, status, expires_at FROM clank_platform_device_codes WHERE user_code = ?",
        ).get(code);
        if (!row || Number(row.expires_at) <= Date.now()) throw new PlatformError(404, "CODE_NOT_FOUND", "Device code not found or expired.");
        return api({ ok: true, code: row.user_code, clientName: row.client_name, status: row.status, user: auth.user });
      }
      if ((url.pathname === "/api/device/approve" || url.pathname === "/api/device/deny") && request.method === "POST") {
        const auth = await requireBrowserAuth(storage.auth, request);
        await storage.auth.verifyCsrf(request, auth);
        const input = plainObject(await readJsonRequest(request, 8 * 1024));
        exact(input, ["code"]);
        const code = normalizeUserCode(boundedString(input.code, "code", 8, 20));
        const status = url.pathname.endsWith("/approve") ? "approved" : "denied";
        const result = storage.internal.prepare(`UPDATE clank_platform_device_codes
          SET status = ?, user_id = ?
          WHERE user_code = ? AND status = 'pending' AND expires_at > ?`)
          .run(status, auth.user!.id, code, Date.now());
        if (Number(result.changes) !== 1) throw new PlatformError(409, "CODE_UNAVAILABLE", "Device code is expired or already handled.");
        audit(storage.internal, auth.user!.id, null, null, `device.${status}`, { code });
        return api({ ok: true, status });
      }

      const principal = await requireToken(storage.internal, request);
      if (url.pathname === "/api/account" && request.method === "GET") {
        return api({ ok: true, account: { id: principal.userId, email: principal.email } });
      }
      if (url.pathname === "/api/tokens" && request.method === "GET") {
        const rows = storage.internal.prepare(`SELECT id, name, created_at, last_used_at, expires_at
          FROM clank_platform_tokens
          WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY created_at DESC`).all(principal.userId, Date.now());
        return api({ ok: true, tokens: rows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          createdAt: Number(row.created_at),
          lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
          expiresAt: Number(row.expires_at),
          current: String(row.id) === principal.tokenId,
        })) });
      }
      if (url.pathname === "/api/tokens/current" && request.method === "DELETE") {
        storage.internal.prepare("UPDATE clank_platform_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?")
          .run(Date.now(), principal.tokenId, principal.userId);
        audit(storage.internal, principal.userId, principal.tokenId, null, "token.revoke", {
          tokenId: principal.tokenId,
        });
        return api({ ok: true });
      }
      const tokenMatch = /^\/api\/tokens\/([A-Za-z0-9_-]{8,128})$/.exec(url.pathname);
      if (tokenMatch && request.method === "DELETE") {
        const result = storage.internal.prepare(
          "UPDATE clank_platform_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
        ).run(Date.now(), tokenMatch[1], principal.userId);
        if (Number(result.changes) !== 1) throw new PlatformError(404, "TOKEN_NOT_FOUND", "Token not found.");
        audit(storage.internal, principal.userId, principal.tokenId, null, "token.revoke", {
          tokenId: tokenMatch[1],
        });
        return api({ ok: true });
      }
      if (url.pathname === "/api/projects" && request.method === "GET") {
        const rows = storage.internal.prepare(
          "SELECT * FROM clank_platform_projects WHERE owner_id = ? ORDER BY created_at",
        ).all(principal.userId);
        return api({ ok: true, projects: rows.map((row) => projectPayload(projectRow(row))) });
      }
      if (url.pathname === "/api/projects" && request.method === "POST") {
        const input = plainObject(await readJsonRequest(request, 16 * 1024));
        exact(input, ["name", "slug"]);
        const name = boundedString(input.name, "name", 1, 100);
        const slug = normalizeSlug(input.slug === undefined ? name : boundedString(input.slug, "slug", 1, 50));
        const id = await randomId(18);
        const port = allocatePort(storage.internal, options.appPortStart ?? 4300, options.appPortEnd ?? 4999);
        const now = Date.now();
        try {
          storage.internal.prepare(`INSERT INTO clank_platform_projects
            (id, owner_id, name, slug, port, active_release_id, database_path, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`)
            .run(id, principal.userId, name, slug, port, now, now);
        } catch (error) {
          if (safeError(error).toLowerCase().includes("unique")) {
            throw new PlatformError(409, "SLUG_UNAVAILABLE", "That project slug is unavailable.");
          }
          throw error;
        }
        const project = projectById(storage.internal, id)!;
        audit(storage.internal, principal.userId, principal.tokenId, id, "project.create", { name, slug, port });
        return api({ ok: true, project: projectPayload(project) }, 201);
      }

      const matched = /^\/api\/projects\/([A-Za-z0-9_-]{8,128})(?:\/(.*))?$/.exec(url.pathname);
      if (!matched) throw new PlatformError(404, "NOT_FOUND", "Platform endpoint not found.");
      const project = ownedProject(storage.internal, matched[1]!, principal.userId);
      const operation = matched[2] ?? "";
      if (!operation && request.method === "GET") {
        const release = project.activeReleaseId ? releaseById(storage.internal, project.activeReleaseId) : null;
        return api({ ok: true, project: projectPayload(project), activeRelease: release ? publicRelease(release) : null });
      }
      if (operation === "releases" && request.method === "GET") {
        const rows = storage.internal.prepare(
          "SELECT * FROM clank_platform_releases WHERE project_id = ? ORDER BY created_at DESC LIMIT 100",
        ).all(project.id);
        return api({ ok: true, releases: rows.map((row) => publicRelease(releaseRow(row))) });
      }
      if (operation === "releases" && request.method === "POST") {
        const contentType = request.headers.get("content-type")?.split(";", 1)[0];
        if (contentType !== "application/vnd.clank.deploy+gzip"
          && contentType !== "application/vnd.proact.deploy+gzip") {
          throw new PlatformError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected application/vnd.clank.deploy+gzip.");
        }
        const claimedDigest = request.headers.get("x-clank-content-sha256")
          ?? request.headers.get("x-proact-content-sha256")
          ?? "";
        if (!/^[a-f0-9]{64}$/.test(claimedDigest)) throw new PlatformError(400, "DIGEST_REQUIRED", "A SHA-256 artifact digest is required.");
        const idempotencyKey = request.headers.get("x-clank-idempotency-key")
          ?? request.headers.get("x-proact-idempotency-key")
          ?? "";
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) throw new PlatformError(400, "IDEMPOTENCY_REQUIRED", "A valid idempotency key is required.");
        const declared = Number(request.headers.get("content-length"));
        const max = options.maxArtifactBytes ?? 100 * 1024 * 1024;
        if (Number.isFinite(declared) && declared > max) throw new PlatformError(413, "ARTIFACT_TOO_LARGE", `Artifact exceeds ${max} bytes.`);
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength > max) throw new PlatformError(413, "ARTIFACT_TOO_LARGE", `Artifact exceeds ${max} bytes.`);
        return api({ ok: true, release: await deploy(principal, project, bytes, claimedDigest, idempotencyKey) }, 201);
      }
      if (operation === "rollback" && request.method === "POST") {
        const input = plainObject(await readJsonRequest(request, 16 * 1024));
        exact(input, ["releaseId", "restoreData", "confirmation"]);
        const releaseId = boundedString(input.releaseId, "releaseId", 8, 128);
        const restoreData = input.restoreData === true;
        const confirmation = input.confirmation === undefined
          ? undefined
          : boundedString(input.confirmation, "confirmation", 1, 200);
        return api({ ok: true, release: await rollback(principal, project, releaseId, restoreData, confirmation) });
      }
      if (operation === "logs" && request.method === "GET") {
        const limit = Math.min(1_000, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
        const rows = storage.internal.prepare(`SELECT id, release_id, stream, message, created_at
          FROM clank_platform_logs WHERE project_id = ? ORDER BY id DESC LIMIT ?`)
          .all(project.id, limit)
          .reverse();
        return api({ ok: true, logs: rows.map((row) => ({
          id: Number(row.id),
          releaseId: String(row.release_id),
          stream: String(row.stream),
          message: String(row.message),
          createdAt: Number(row.created_at),
        })) });
      }
      if (operation === "secrets" && request.method === "GET") {
        const rows = storage.internal.prepare(
          "SELECT name, updated_at FROM clank_platform_secrets WHERE project_id = ? ORDER BY name",
        ).all(project.id);
        return api({ ok: true, secrets: rows.map((row) => ({ name: row.name, updatedAt: row.updated_at })) });
      }
      if (operation === "secrets" && request.method === "PUT") {
        const input = plainObject(await readJsonRequest(request, 256 * 1024));
        exact(input, ["values"]);
        const values = plainObject(input.values);
        if (Object.keys(values).length > 100) throw new PlatformError(422, "TOO_MANY_SECRETS", "At most 100 secrets may be changed at once.");
        const names: string[] = [];
        storage.internal.transaction((changes) => {
          for (const [name, rawValue] of Object.entries(values)) {
            validateSecretName(name);
            const value = boundedString(rawValue, `values.${name}`, 0, 64 * 1024);
            const encrypted = encryptSecret(value, masterKey);
            storage.internal.prepare(`INSERT INTO clank_platform_secrets
              (project_id, name, encrypted_value, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(project_id, name) DO UPDATE SET encrypted_value = excluded.encrypted_value, updated_at = excluded.updated_at`)
              .run(project.id, name, encrypted, Date.now());
            names.push(name);
          }
          changes.record("__platform", project.id);
        });
        audit(storage.internal, principal.userId, principal.tokenId, project.id, "secrets.update", { names });
        return api({ ok: true, names });
      }
      if (operation.startsWith("secrets/") && request.method === "DELETE") {
        let name: string;
        try {
          name = decodeURIComponent(operation.slice("secrets/".length));
        } catch {
          throw new PlatformError(400, "INVALID_SECRET_NAME", "Secret name is not valid URL encoding.");
        }
        validateSecretName(name);
        storage.internal.prepare("DELETE FROM clank_platform_secrets WHERE project_id = ? AND name = ?")
          .run(project.id, name);
        audit(storage.internal, principal.userId, principal.tokenId, project.id, "secrets.delete", { name });
        return api({ ok: true });
      }
      if (operation === "audit" && request.method === "GET") {
        const rows = storage.internal.prepare(`SELECT id, action, metadata, created_at, actor_user_id, actor_token_id
          FROM clank_platform_audit WHERE project_id = ? ORDER BY id DESC LIMIT 500`).all(project.id);
        return api({ ok: true, events: rows.map((row) => ({
          id: Number(row.id),
          action: String(row.action),
          metadata: JSON.parse(String(row.metadata)),
          createdAt: Number(row.created_at),
          actorUserId: String(row.actor_user_id),
          actorTokenId: row.actor_token_id === null ? null : String(row.actor_token_id),
        })) });
      }
      throw new PlatformError(404, "NOT_FOUND", "Platform endpoint not found.");
    } catch (error) {
      if (error instanceof PlatformError) return problem(error.status, error.code, error.message, error.retryAfter);
      if (error instanceof RequestInputError) return problem(error.status, error.code, error.message);
      options.onError?.(error);
      return problem(
        500,
        "PLATFORM_ERROR",
        options.exposeErrors ? safeError(error) : "The platform operation failed.",
      );
    }
  };

  const projects = storage.internal.prepare(
    "SELECT * FROM clank_platform_projects WHERE active_release_id IS NOT NULL",
  ).all().map(projectRow);
  for (const project of projects) {
    const release = project.activeReleaseId ? releaseById(storage.internal, project.activeReleaseId) : null;
    if (!release) continue;
    try {
      await startRelease(project, release, decryptProjectSecrets(storage.internal, project.id, masterKey));
    } catch (error) {
      options.onError?.(error);
      storage.internal.prepare("UPDATE clank_platform_releases SET status = 'crashed', failure = ? WHERE id = ?")
        .run(`Startup recovery failed: ${safeError(error)}`, release.id);
    }
  }

  return {
    handle,
    publicUrl,
    dataDirectory: paths.root,
    async close() {
      if (closed) return;
      closed = true;
      for (const state of restartState.values()) {
        state.cancelled = true;
        if (state.timer) clearTimeout(state.timer);
      }
      restartState.clear();
      await Promise.all([...active.keys()].map(stopProject));
      storage.auth.close();
      storage.database.close();
    },
  };
}

async function openPlatformDatabase(path: string, signup: boolean): Promise<PlatformDatabase> {
  const schema = defineDatabase({});
  const database = await openSQLite(schema, { path });
  const internal = database[SQLITE_INTERNAL];
  const authDefinition = defineAuth({ signup });
  const auth = await openAuth(authDefinition, database);
  for (const table of [
    "tokens",
    "device_codes",
    "projects",
    "releases",
    "secrets",
    "logs",
    "audit",
  ]) {
    migrateLegacyTable(internal, `proact_platform_${table}`, `clank_platform_${table}`);
  }
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`);
  internal.exec("DROP INDEX IF EXISTS proact_platform_tokens_user");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_platform_tokens_user ON clank_platform_tokens (user_id)");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_device_codes (
    device_hash TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    client_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
    user_id TEXT REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_poll_at INTEGER NOT NULL,
    consumed_at INTEGER
  )`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_projects (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    port INTEGER NOT NULL UNIQUE,
    active_release_id TEXT,
    database_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_releases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,
    previous_release_id TEXT,
    status TEXT NOT NULL,
    digest TEXT NOT NULL,
    artifact_bytes INTEGER NOT NULL,
    framework_version TEXT NOT NULL,
    node_version TEXT NOT NULL,
    config TEXT NOT NULL CHECK (json_valid(config)),
    directory TEXT NOT NULL,
    backup_path TEXT,
    idempotency_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    activated_at INTEGER,
    failure TEXT,
    UNIQUE(project_id, idempotency_key)
  )`);
  internal.exec("DROP INDEX IF EXISTS proact_platform_releases_project");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_platform_releases_project ON clank_platform_releases (project_id, created_at)");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_secrets (
    project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, name)
  )`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,
    release_id TEXT NOT NULL,
    stream TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  internal.exec("DROP INDEX IF EXISTS proact_platform_logs_project");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_platform_logs_project ON clank_platform_logs (project_id, id)");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id TEXT NOT NULL,
    actor_token_id TEXT,
    project_id TEXT,
    action TEXT NOT NULL,
    metadata TEXT NOT NULL CHECK (json_valid(metadata)),
    created_at INTEGER NOT NULL
  )`);
  internal.prepare("DELETE FROM clank_platform_device_codes WHERE expires_at <= ?").run(Date.now());
  internal.prepare("DELETE FROM clank_platform_tokens WHERE expires_at <= ?").run(Date.now());
  return { database, internal, auth };
}

async function requireBrowserAuth(
  authRuntime: AuthRuntime<DefaultAuthProfile>,
  request: Request,
): Promise<AuthRequest<DefaultAuthProfile>> {
  if (!requestOriginAllowed(request)) throw new PlatformError(403, "ORIGIN_MISMATCH", "Cross-origin request rejected.");
  const auth = await authRuntime.resolve(request);
  if (!auth.user || !auth.session) throw new PlatformError(401, "UNAUTHENTICATED", "Sign in is required.");
  return auth;
}

async function requireToken(internal: SQLiteInternal, request: Request): Promise<TokenPrincipal> {
  const authorization = request.headers.get("authorization") ?? "";
  const matched = /^Bearer ((?:clnk|prct)_[A-Za-z0-9_-]{40,200})$/.exec(authorization);
  if (!matched) throw new PlatformError(401, "INVALID_TOKEN", "A valid CLI access token is required.");
  const row = internal.prepare(`SELECT t.id, t.user_id, t.expires_at, t.revoked_at, u.email, u.disabled
    FROM clank_platform_tokens t
    JOIN clank_auth_users u ON u.id = t.user_id
    WHERE t.token_hash = ?`).get(syncHash(matched[1]!));
  if (!row || row.revoked_at !== null || Number(row.expires_at) <= Date.now() || Number(row.disabled) !== 0) {
    throw new PlatformError(401, "INVALID_TOKEN", "The CLI access token is invalid or expired.");
  }
  internal.prepare("UPDATE clank_platform_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return { tokenId: String(row.id), userId: String(row.user_id), email: String(row.email) };
}

function projectRow(row: Record<string, unknown>): ProjectRow {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    slug: String(row.slug),
    port: Number(row.port),
    activeReleaseId: row.active_release_id === null ? null : String(row.active_release_id),
    databasePath: row.database_path === null ? null : String(row.database_path),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function releaseRow(row: Record<string, unknown>): ReleaseRow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    previousReleaseId: row.previous_release_id === null ? null : String(row.previous_release_id),
    status: String(row.status),
    digest: String(row.digest),
    artifactBytes: Number(row.artifact_bytes),
    frameworkVersion: String(row.framework_version),
    nodeVersion: String(row.node_version),
    config: JSON.parse(String(row.config)),
    directory: String(row.directory),
    backupPath: row.backup_path === null ? null : String(row.backup_path),
    createdAt: Number(row.created_at),
    activatedAt: row.activated_at === null ? null : Number(row.activated_at),
    failure: row.failure === null ? null : String(row.failure),
  };
}

function projectById(internal: SQLiteInternal, id: string): ProjectRow | null {
  const row = internal.prepare("SELECT * FROM clank_platform_projects WHERE id = ?").get(id);
  return row ? projectRow(row) : null;
}

function releaseById(internal: SQLiteInternal, id: string): ReleaseRow | null {
  const row = internal.prepare("SELECT * FROM clank_platform_releases WHERE id = ?").get(id);
  return row ? releaseRow(row) : null;
}

function ownedProject(internal: SQLiteInternal, id: string, userId: string): ProjectRow {
  const row = internal.prepare(
    "SELECT * FROM clank_platform_projects WHERE id = ? AND owner_id = ?",
  ).get(id, userId);
  if (!row) throw new PlatformError(404, "PROJECT_NOT_FOUND", "Project not found.");
  return projectRow(row);
}

function projectPayload(project: ProjectRow): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    port: project.port,
    activeReleaseId: project.activeReleaseId,
    databasePath: project.databasePath,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function publicRelease(release: ReleaseRow): Record<string, unknown> {
  return {
    id: release.id,
    previousReleaseId: release.previousReleaseId,
    status: release.status,
    digest: release.digest,
    artifactBytes: release.artifactBytes,
    frameworkVersion: release.frameworkVersion,
    nodeVersion: release.nodeVersion,
    createdAt: release.createdAt,
    activatedAt: release.activatedAt,
    failure: release.failure,
    migrations: release.config.database.migrations,
  };
}

function releasePayload(
  project: ProjectRow,
  release: ReleaseRow,
  appUrlTemplate: string,
): Record<string, unknown> {
  return {
    ...publicRelease(release),
    project: projectPayload(project),
    url: appUrlTemplate.replaceAll("{slug}", project.slug).replaceAll("{port}", String(project.port)),
    directUrl: `http://127.0.0.1:${project.port}`,
  };
}

function audit(
  internal: SQLiteInternal,
  userId: string,
  tokenId: string | null,
  projectId: string | null,
  action: string,
  metadata: Record<string, unknown>,
): void {
  internal.prepare(`INSERT INTO clank_platform_audit
    (actor_user_id, actor_token_id, project_id, action, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, tokenId, projectId, action, JSON.stringify(metadata), Date.now());
}

function api(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function problem(status: number, code: string, message: string, retryAfter?: number): Response {
  return api({ ok: false, error: { code, message, ...(retryAfter ? { retryAfter } : {}) } }, status);
}

function consolePage(
  publicUrl: string,
  auth: AuthRequest<DefaultAuthProfile>,
  deviceCode: string,
  signupAllowed: boolean,
): Response {
  const nonce = syncRandomToken(18);
  const state = JSON.stringify({
    authenticated: Boolean(auth.user),
    email: auth.user?.email ?? null,
    csrfToken: auth.csrfToken ?? null,
    deviceCode,
    publicUrl,
    signupAllowed,
  }).replaceAll("<", "\\u003c");
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clank Deploy</title><style>
*{box-sizing:border-box}body{margin:0;background:#070b14;color:#e8edf7;font:16px/1.5 ui-sans-serif,system-ui,sans-serif}
[hidden]{display:none!important}
main{max-width:720px;margin:0 auto;padding:64px 24px}.eyebrow{color:#75e6c4;font-size:12px;font-weight:800;letter-spacing:.18em;text-transform:uppercase}
h1{font-size:clamp(38px,8vw,72px);line-height:1;margin:.15em 0}.card{background:#111827;border:1px solid #263247;border-radius:22px;padding:24px;margin-top:28px}
label{display:block;margin:14px 0 6px;color:#b9c5d8}input{width:100%;padding:13px;border-radius:10px;border:1px solid #3a4962;background:#09101e;color:white}
button{margin-top:16px;padding:12px 18px;border:0;border-radius:10px;background:#75e6c4;color:#062019;font-weight:800;cursor:pointer}
button.secondary{background:#263247;color:white;margin-left:8px}.muted{color:#91a0b7}.error{color:#ff9eaa;min-height:24px}code{color:#75e6c4}
</style></head><body><main><p class="eyebrow">Open-source control plane</p><h1>Clank Deploy</h1>
<p class="muted">Authenticate once in the browser, then deploy deterministic Clank releases from the CLI.</p>
<section class="card" id="auth-card"><h2 id="auth-title">${auth.user ? "Account" : "Sign in"}</h2>
<form id="auth-form"><label>Email</label><input id="email" type="email" autocomplete="email" required>
<label>Password</label><input id="password" type="password" autocomplete="current-password" minlength="12" required>
<label id="name-label" hidden>Name</label><input id="name" autocomplete="name" hidden>
<p class="error" id="auth-error"></p><button type="submit" id="auth-submit">Sign in</button>
<button type="button" class="secondary" id="auth-switch">Create account</button></form>
<div id="signed-in" hidden><p>Signed in as <strong id="account-email"></strong>.</p><button id="sign-out">Sign out</button></div></section>
<section class="card" id="device-card" hidden><p class="eyebrow">CLI authorization</p><h2>Authorize this device?</h2>
<p>Code <code id="device-code"></code> requested by <strong id="client-name"></strong>.</p>
<p class="error" id="device-error"></p><button id="approve">Authorize</button><button class="secondary" id="deny">Deny</button></section>
<section class="card"><h2>Transparent by design</h2><p class="muted">Every artifact is checksummed, every release is auditable, migrations are immutable, secrets are encrypted, and rollback behavior is explicit.</p></section>
</main><script nonce="${nonce}">const state=${state};
const q=(s)=>document.querySelector(s);let register=false;
function showAuth(){q("#auth-title").textContent=state.authenticated?"Account":register?"Create account":"Sign in";q("#auth-form").hidden=state.authenticated;q("#signed-in").hidden=!state.authenticated;q("#account-email").textContent=state.email||"";q("#auth-switch").hidden=!state.signupAllowed}
async function request(path,body,csrf=false){const response=await fetch(path,{method:body===undefined?"GET":"POST",headers:body===undefined?{}:{"content-type":"application/json",...(csrf&&state.csrfToken?{"x-clank-csrf":state.csrfToken}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error?.message||"Request failed.");return data}
q("#auth-switch").onclick=()=>{register=!register;q("#auth-submit").textContent=register?"Create account":"Sign in";q("#auth-switch").textContent=register?"Use existing account":"Create account";q("#name").hidden=q("#name-label").hidden=!register;showAuth()};
q("#auth-form").onsubmit=async(e)=>{e.preventDefault();q("#auth-error").textContent="";try{const data=await request("/__clank/auth/"+(register?"register":"login"),{email:q("#email").value,password:q("#password").value,...(register?{profile:{name:q("#name").value||undefined}}:{})});state.authenticated=true;state.email=data.user.email;state.csrfToken=data.csrfToken;showAuth();await loadDevice()}catch(error){q("#auth-error").textContent=error.message}};
q("#sign-out").onclick=async()=>{await request("/__clank/auth/logout",{},true);state.authenticated=false;state.email=null;state.csrfToken=null;register=false;q("#auth-submit").textContent="Sign in";q("#auth-switch").textContent="Create account";q("#name").hidden=q("#name-label").hidden=true;showAuth();q("#device-card").hidden=true};
async function loadDevice(){if(!state.authenticated||!state.deviceCode)return;try{const data=await request("/api/device/info?code="+encodeURIComponent(state.deviceCode));q("#device-card").hidden=false;q("#device-code").textContent=data.code;q("#client-name").textContent=data.clientName}catch(error){q("#device-card").hidden=false;q("#device-error").textContent=error.message}}
async function decide(action){try{await request("/api/device/"+action,{code:state.deviceCode},true);q("#device-error").textContent=action==="approve"?"Device authorized. Return to the CLI.":"Device denied.";q("#approve").disabled=q("#deny").disabled=true}catch(error){q("#device-error").textContent=error.message}}
q("#approve").onclick=()=>decide("approve");q("#deny").onclick=()=>decide("deny");showAuth();loadDevice();</script></body></html>`;
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "cross-origin-opener-policy": "same-origin",
    },
  });
}

async function prepareDirectories(directory: string): Promise<{
  root: string;
  projects: string;
  controlDatabase: string;
}> {
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
  };
  const path = await import(pathName) as unknown as {
    resolve(...segments: string[]): string;
    join(...segments: string[]): string;
  };
  const root = path.resolve(directory);
  const projects = path.join(root, "projects");
  await fs.mkdir(projects, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  return { root, projects, controlDatabase: path.join(root, "control.sqlite") };
}

async function resolveMasterKey(root: string, supplied?: string | Uint8Array): Promise<Uint8Array> {
  if (supplied !== undefined) return parseMasterKey(supplied);
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array, options: { flag: "wx"; mode: number }): Promise<void>;
  };
  const path = await import(pathName) as unknown as { join(...segments: string[]): string };
  const keyPath = path.join(root, "master.key");
  try {
    return parseMasterKey(await fs.readFile(keyPath));
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const key = crypto.getRandomValues(new Uint8Array(32));
  try {
    await fs.writeFile(keyPath, key, { flag: "wx", mode: 0o600 });
    return key;
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    return parseMasterKey(await fs.readFile(keyPath));
  }
}

function parseMasterKey(value: string | Uint8Array): Uint8Array {
  let bytes: Uint8Array;
  if (typeof value === "string") {
    try {
      const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
      const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
      const binary = atob(padded);
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      throw new Error("Platform master key must be base64/base64url.");
    }
  } else {
    bytes = new Uint8Array(value);
  }
  if (bytes.byteLength !== 32) throw new Error("Platform master key must contain exactly 32 bytes.");
  return bytes;
}

function encryptSecret(value: string, key: Uint8Array): string {
  const cryptoName = "node:crypto";
  const requireName = "node:module";
  // Node's synchronous AEAD keeps SQLite transactions synchronous.
  const require = (globalThis as unknown as { process: { getBuiltinModule?: (name: string) => any } })
    .process.getBuiltinModule?.(requireName)?.createRequire(import.meta.url);
  const module = require?.(cryptoName) ?? (globalThis as any).process.getBuiltinModule?.(cryptoName);
  if (!module) throw new Error("Node crypto module is unavailable.");
  const iv = module.randomBytes(12);
  const cipher = module.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = BufferLike.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${base64Url(iv)}.${base64Url(encrypted)}.${base64Url(tag)}`;
}

function decryptSecret(value: string, key: Uint8Array): string {
  const cryptoName = "node:crypto";
  const module = (globalThis as any).process.getBuiltinModule?.(cryptoName);
  if (!module) throw new Error("Node crypto module is unavailable.");
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Stored secret envelope is invalid.");
  const iv = fromBase64Url(parts[1]!);
  const encrypted = fromBase64Url(parts[2]!);
  const tag = fromBase64Url(parts[3]!);
  const decipher = module.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return BufferLike.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

const BufferLike = {
  concat(values: Uint8Array[]): Uint8Array & { toString(encoding: string): string } {
    const module = (globalThis as any).process.getBuiltinModule?.("node:buffer");
    return module.Buffer.concat(values);
  },
};

function decryptProjectSecrets(internal: SQLiteInternal, projectId: string, key: Uint8Array): Record<string, string> {
  const output = Object.create(null) as Record<string, string>;
  for (const row of internal.prepare(
    "SELECT name, encrypted_value FROM clank_platform_secrets WHERE project_id = ?",
  ).all(projectId)) {
    output[String(row.name)] = decryptSecret(String(row.encrypted_value), key);
  }
  return output;
}

async function spawnRelease(
  runner: PlatformRunnerOptions,
  release: ReleaseRow,
  dataRoot: string,
  port: number,
  environment: Record<string, string>,
): Promise<NativeChild> {
  const childName = "node:child_process";
  const { spawn } = await import(childName) as unknown as {
    spawn(command: string, args: string[], options: Record<string, unknown>): NativeChild;
  };
  if (runner.kind === "docker") {
    const pathName = "node:path";
    const path = await import(pathName) as unknown as { resolve(...segments: string[]): string };
    const containerDatabase = `/data/${release.config.database.path}`;
    const dockerEnvironment = {
      ...environment,
      HOST: "0.0.0.0",
      CLANK_DATABASE_PATH: containerDatabase,
      CLANK_DATABASE: containerDatabase,
      PROACT_DATABASE_PATH: containerDatabase,
      PROACT_DATABASE: containerDatabase,
    };
    const args = [
      "run", "--rm",
      "--name", `clank-${release.projectId.slice(0, 12)}-${release.id.slice(0, 8)}`,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit", String(runner.pidsLimit ?? 128),
      "--memory", runner.memory ?? "512m",
      "--cpus", runner.cpus ?? "1",
      "--user", `${String((globalThis as any).process.getuid?.() ?? 65532)}:${String((globalThis as any).process.getgid?.() ?? 65532)}`,
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "-p", `127.0.0.1:${port}:${port}`,
      "-v", `${path.resolve(release.directory)}:/app:ro`,
      "-v", `${path.resolve(dataRoot)}:/data:rw`,
      "-w", "/app",
      ...Object.entries(dockerEnvironment).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
      runner.image ?? "node:22-bookworm-slim",
      "node", "--disable-warning=ExperimentalWarning", release.config.entry,
    ];
    return spawn(runner.executable ?? "docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  }
  const launcher = await writeReleaseLauncher(release.directory, release.config.entry);
  return spawn(
    (globalThis as any).process.execPath,
    ["--disable-warning=ExperimentalWarning", launcher],
    {
      cwd: release.directory,
      env: {
        PATH: (globalThis as any).process.env.PATH ?? "",
        HOME: (globalThis as any).process.env.HOME ?? "",
        ...environment,
        HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function writeReleaseLauncher(directory: string, entry: string): Promise<string> {
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    writeFile(path: string, value: string, options: { mode: number }): Promise<void>;
  };
  const path = await import(pathName) as unknown as { join(...segments: string[]): string };
  const launcher = path.join(directory, ".clank-launch.mjs");
  await fs.writeFile(
    launcher,
    `process.umask(0o077);\nawait import(${JSON.stringify(`./${entry}`)});\n`,
    { mode: 0o700 },
  );
  return launcher;
}

async function stopChild(child: NativeChild): Promise<void> {
  if (child.exitCode !== null && child.exitCode !== undefined) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000));
  if (await Promise.race([exited.then(() => "exit" as const), timeout]) === "timeout") {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  }
}

async function waitForHealth(port: number, path: string, timeoutMs: number, child: NativeChild): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Application did not respond.";
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== undefined) throw new Error("Application exited before its health check passed.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: controller.signal,
        headers: { host: `127.0.0.1:${port}` },
      });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
      lastError = `Health check returned ${response.status}.`;
    } catch (error) {
      lastError = safeError(error);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Health check timed out: ${lastError}`);
}

async function assertPortAvailable(port: number): Promise<void> {
  const netName = "node:net";
  const { createServer } = await import(netName) as unknown as {
    createServer(): {
      listen(port: number, hostname: string, callback: () => void): void;
      close(callback: (error?: Error) => void): void;
      once(event: "error", listener: (error: Error) => void): void;
    };
  };
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Application port ${port} is unavailable.`)));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

function captureOutput(stream: ActiveProcess["child"]["stdout"], write: (line: string) => void): void {
  if (!stream) return;
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) break;
        write(buffered.slice(0, newline).replace(/\r$/, ""));
        buffered = buffered.slice(newline + 1);
      }
      if (buffered.length > 16_384) {
        write(buffered.slice(0, 16_384));
        buffered = "";
      }
    }
    buffered += decoder.decode();
    if (buffered) write(buffered);
  })();
}

function redact(line: string, secrets: Record<string, string>): string {
  let output = line;
  for (const value of Object.values(secrets).filter((entry) => entry.length >= 4)) {
    output = output.split(value).join("[REDACTED]");
  }
  return output;
}

async function projectDataDirectory(projectsRoot: string, projectId: string): Promise<string> {
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  };
  const path = await import(pathName) as unknown as { join(...segments: string[]): string };
  const root = path.join(projectsRoot, projectId, "data");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

async function newReleaseDirectory(projectsRoot: string, projectId: string, releaseId: string): Promise<string> {
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  };
  const path = await import(pathName) as unknown as { join(...segments: string[]): string };
  const directory = path.join(projectsRoot, projectId, "releases", releaseId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function releaseBackupPath(projectsRoot: string, projectId: string, releaseId: string): Promise<string> {
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  };
  const path = await import(pathName) as unknown as { join(...segments: string[]): string };
  const directory = path.join(projectsRoot, projectId, "backups");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, `${releaseId}.sqlite`);
}

async function safeProjectDataPath(root: string, relative: string): Promise<string> {
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    lstat(path: string): Promise<{
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>;
    mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  };
  const path = await import(pathName) as unknown as {
    resolve(...segments: string[]): string;
    join(...segments: string[]): string;
  };
  const target = await safeChildPath(root, relative);
  const rootStats = await fs.lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Project data root must be a real directory.");
  }
  const segments = relative.split("/");
  let current = path.resolve(root);
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const stats = await fs.lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Project data path contains a non-directory or symbolic link: ${segment}`);
      }
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      await fs.mkdir(current, { recursive: false, mode: 0o700 });
    }
  }
  try {
    const stats = await fs.lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Project database path must be a regular file, not a link or special file.");
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  return target;
}

async function safeReleasePath(root: string, relative: string): Promise<string> {
  return safeChildPath(root, relative);
}

async function safeChildPath(root: string, relative: string): Promise<string> {
  const pathName = "node:path";
  const path = await import(pathName) as unknown as { resolve(...segments: string[]): string; sep: string };
  const candidate = path.resolve(root, relative);
  if (candidate === root || !candidate.startsWith(path.resolve(root) + path.sep)) throw new Error("Path escapes its deployment root.");
  return candidate;
}

async function fileExists(path: string): Promise<boolean> {
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as { stat(path: string): Promise<{ isFile(): boolean }> };
  try { return (await fs.stat(path)).isFile(); }
  catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

async function removeDatabaseFiles(path: string): Promise<void> {
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as { rm(path: string, options: { force: true }): Promise<void> };
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map((target) => fs.rm(target, { force: true })));
}

function allocatePort(internal: SQLiteInternal, start: number, end: number): number {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1024 || end > 65535 || start > end) {
    throw new Error("Invalid application port range.");
  }
  const used = new Set(internal.prepare("SELECT port FROM clank_platform_projects").all().map((row) => Number(row.port)));
  for (let port = start; port <= end; port++) if (!used.has(port)) return port;
  throw new PlatformError(503, "PORT_CAPACITY", "No application ports are available.");
}

function normalizePublicUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !isLoopbackUrl(url))) {
    throw new Error("Platform publicUrl must be HTTPS, except for loopback development.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}

function normalizeAppUrlTemplate(value: string): string {
  if (!value.includes("{port}") && !value.includes("{slug}")) {
    throw new Error("appUrlTemplate must contain {port} or {slug}.");
  }
  const sample = value.replaceAll("{port}", "443").replaceAll("{slug}", "sample");
  const url = new URL(sample);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("appUrlTemplate must be an HTTP(S) URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("appUrlTemplate cannot contain credentials, search, or fragments.");
  }
  return value.replace(/\/+$/, "");
}

function isLoopbackUrl(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

function normalizeSlug(value: unknown): string {
  const slug = String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!PROJECT_SLUG.test(slug)) throw new PlatformError(422, "INVALID_SLUG", "Project slug must use 1-48 lowercase letters, numbers, or interior hyphens.");
  return slug;
}

function validateSecretName(name: string): void {
  if (!SECRET_NAME.test(name)
    || name.startsWith("CLANK_")
    || name.startsWith("PROACT_")
    || ["PORT", "NODE_OPTIONS", "PATH", "HOME", "HOST"].includes(name)) {
    throw new PlatformError(422, "INVALID_SECRET_NAME", `Secret name ${name} is invalid or reserved.`);
  }
}

function migrateLegacyTable(internal: SQLiteInternal, legacy: string, current: string): void {
  const exists = (name: string) => Boolean(internal.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
  if (!exists(legacy)) return;
  if (exists(current)) {
    throw new Error(`Cannot migrate legacy platform table ${legacy}: ${current} already exists.`);
  }
  internal.exec(`ALTER TABLE "${legacy}" RENAME TO "${current}"`);
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new PlatformError(422, "INVALID_INPUT", "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new PlatformError(422, "INVALID_INPUT", `Unknown input field ${key}.`);
}

function boundedString(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.includes("\0")) {
    throw new PlatformError(422, "INVALID_INPUT", `${name} must be a string from ${minimum} to ${maximum} characters.`);
  }
  return value;
}

function normalizeUserCode(value: string): string {
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : value.toUpperCase();
}

function enforceDeviceRateLimit(
  limiter: Map<string, { count: number; resetAt: number }>,
  request: Request,
): void {
  const now = Date.now();
  const key = request.headers.get("x-clank-client-ip")
    ?? request.headers.get("x-proact-client-ip")
    ?? "unknown";
  const current = limiter.get(key);
  if (!current || current.resetAt <= now) {
    limiter.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }
  current.count++;
  if (current.count > 10) throw new PlatformError(429, "RATE_LIMITED", "Too many device authorization attempts.", Math.ceil((current.resetAt - now) / 1_000));
}

async function randomUserCode(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const characters = Array.from(bytes, (byte) => DEVICE_ALPHABET[byte % DEVICE_ALPHABET.length]).join("");
  return `${characters.slice(0, 4)}-${characters.slice(4)}`;
}

async function randomId(bytes: number): Promise<string> {
  return randomToken(bytes);
}

async function randomToken(bytes: number): Promise<string> {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function syncRandomToken(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hash(value: string): Promise<string> {
  return syncHash(value);
}

function syncHash(value: string): string {
  const module = (globalThis as any).process.getBuiltinModule?.("node:crypto");
  if (!module) throw new Error("Node crypto module is unavailable.");
  return module.createHash("sha256").update(value).digest("base64url");
}

function base64Url(value: Uint8Array): string {
  const binary = Array.from(value, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
