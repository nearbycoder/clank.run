import { readFile } from "node:fs/promises";
import {
  AuthError,
  defineAuth,
  openAuth,
  type AuthRequest,
  type AuthRateLimitStore,
  type AuthRuntime,
  type AuthUserId,
  type DefaultAuthProfile,
} from "./auth.ts";
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
  loadMigrations,
  planMigrations,
  restoreSQLiteBackup,
} from "./migrations.ts";
import {
  openBackupManager,
  type BackupManifest,
  type BackupObjectRepositoryOptions,
} from "./recovery.ts";
import { openDeploymentOrchestrator } from "./orchestration.ts";
import {
  createDeploymentCoordinatorHandler,
  DEPLOYMENT_COORDINATOR_PREFIX,
} from "./runner.ts";
import {
  createPlatformBackupScheduler,
  type PlatformBackupPolicy,
} from "./platform-backups.ts";
import {
  inspectPlatformStorage,
  type StorageDiagnosticProject,
} from "./platform-storage.ts";
import {
  createDomainManager,
  createManagedIngress,
  inspectDomainRouting,
  DomainVerificationError,
  type DomainChallenge,
  type DomainChallengeStore,
  type DomainDnsResolver,
  type DomainRoutingReport,
  type IngressRequestMetric,
} from "./data-plane.ts";
import { platformConsolePage } from "./platform-console.ts";
import {
  readRequestBytes,
  requestOriginAllowed,
  RequestInputError,
  readJsonRequest,
  trustedClientAddress,
} from "./security.ts";
import { SQLITE_INTERNAL, type SQLiteInternal } from "./sqlite-internal.ts";
import type { ObjectStore } from "./object-storage.ts";

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
export type PlatformHostingProfile = "trusted" | "isolated";

export interface PlatformLimits {
  /** Maximum organizations created by one account. Defaults to 5. */
  organizationsPerAccount?: number;
  /** Maximum sites created by one account across all organizations. Defaults to 10. */
  projectsPerAccount?: number;
  /** Maximum sites in one organization. Defaults to 10. */
  projectsPerOrganization?: number;
  /** Maximum custom domains attached to one site. Defaults to 5. */
  domainsPerProject?: number;
  /** Retention for minute-level ingress metrics. Defaults to 30 days. */
  metricRetentionDays?: number;
  /** Maximum retained release artifacts per project. Defaults to 50. */
  releasesPerProject?: number;
  /** Maximum retained release and pre-deploy snapshot bytes per project. Defaults to 20 GiB. */
  releaseStorageBytesPerProject?: number;
}

export interface PlatformBackupOptions {
  /** Encrypted backup cadence. Defaults to 24 hours; false disables automatic backups. */
  intervalMs?: number | false;
  /** Maximum projects claimed by one backup pass. Defaults to 5. */
  batchSize?: number;
  /** Maximum retained backups per project. Defaults to 30. */
  maxBackups?: number;
  /** Maximum backup age. Defaults to 90 days. */
  maxAgeMs?: number;
  /** Maximum source database size accepted by the backup engine. Defaults to 10 GiB. */
  maxDatabaseBytes?: number;
  /**
   * Optional off-host repository for encrypted backups. Each project receives
   * an isolated catalog and chunk namespace automatically.
   */
  objects?: Omit<BackupObjectRepositoryOptions, "repositoryId">;
}

type PlatformQuotaKey =
  | "organizationsPerAccount"
  | "projectsPerAccount"
  | "projectsPerOrganization"
  | "domainsPerProject"
  | "releasesPerProject"
  | "releaseStorageBytesPerProject"
  | "backupsPerProject";

type PlatformQuotaValues = Record<PlatformQuotaKey, number>;
type PlatformQuotaScope = "account" | "workspace";

const PLATFORM_QUOTA_KEYS = Object.freeze([
  "organizationsPerAccount",
  "projectsPerAccount",
  "projectsPerOrganization",
  "domainsPerProject",
  "releasesPerProject",
  "releaseStorageBytesPerProject",
  "backupsPerProject",
] as const satisfies readonly PlatformQuotaKey[]);

const WORKSPACE_QUOTA_KEYS = Object.freeze([
  "projectsPerOrganization",
  "domainsPerProject",
  "releasesPerProject",
  "releaseStorageBytesPerProject",
  "backupsPerProject",
] as const satisfies readonly PlatformQuotaKey[]);

const PLATFORM_QUOTA_DEFINITIONS = Object.freeze({
  organizationsPerAccount: { minimum: 1, maximum: 10_000, unit: "workspaces", label: "Workspaces per account" },
  projectsPerAccount: { minimum: 1, maximum: 100_000, unit: "projects", label: "Projects per account" },
  projectsPerOrganization: { minimum: 1, maximum: 10_000, unit: "projects", label: "Projects per workspace" },
  domainsPerProject: { minimum: 1, maximum: 1_000, unit: "domains", label: "Custom domains per project" },
  releasesPerProject: { minimum: 2, maximum: 100, unit: "releases", label: "Retained releases per project" },
  releaseStorageBytesPerProject: {
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    unit: "bytes",
    label: "Release storage per project",
  },
  backupsPerProject: { minimum: 1, maximum: 10_000, unit: "backups", label: "Retained backups per project" },
} as const satisfies Record<PlatformQuotaKey, {
  minimum: number;
  maximum: number;
  unit: string;
  label: string;
}>);

export interface ClankPlatformOptions {
  dataDirectory: string;
  publicUrl: string;
  /** Recover active application processes before returning, or concurrently after startup. Defaults to "blocking". */
  startupRecovery?: "blocking" | "background";
  /** Exact control-plane account emails granted operator-level administration. */
  platformAdminEmails?: readonly string[];
  appHostname?: string;
  /** Public application URL pattern. Supports {slug} and {port}. */
  appUrlTemplate?: string;
  appPortStart?: number;
  appPortEnd?: number;
  /** Listener or infrastructure ports that application runtimes must never use. */
  reservedAppPorts?: readonly number[];
  /**
   * Declares the application-code trust boundary. "isolated" requires the
   * Docker runner. Defaults from the selected runner for programmatic callers.
   */
  hostingProfile?: PlatformHostingProfile;
  runner?: PlatformRunnerOptions;
  /**
   * Enables the authenticated remote deployment-node coordination API.
   * Omit it to keep every runner endpoint closed.
   */
  deploymentAgents?: {
    registrationToken: string;
    maxRequestBytes?: number;
    /** Maximum content-addressed release transferred to a current node lease. */
    maxArtifactBytes?: number;
    /**
     * Optional provider-neutral repository for original release uploads.
     * Omit it to retain owner-only files under dataDirectory.
     */
    artifacts?: {
      /**
       * Stable operator-selected repository identity persisted with each release.
       * Changing it does not silently reinterpret objects from an older store.
       */
      namespace: string;
      store: ObjectStore;
    };
  };
  /** Defaults to "bootstrap": only the first platform account may self-register. */
  signup?: boolean | "bootstrap";
  masterKey?: string | Uint8Array;
  maxArtifactBytes?: number;
  /** Operator-only escape hatch for configs that request unrestricted SQLite SQL. */
  allowUnsafeMigrations?: boolean;
  deviceCodeLifetimeMs?: number;
  accessTokenLifetimeMs?: number;
  limits?: PlatformLimits;
  backups?: PlatformBackupOptions;
  ingress?: {
    enabled?: boolean;
    baseDomain?: string;
    /** CNAME target shown to custom-domain owners. Defaults to baseDomain. */
    customDomainTarget?: string;
    /** Edge IPv4/IPv6 values accepted for apex/flattened DNS. */
    customDomainAddresses?: readonly string[];
    /** Secret embedded in the private Caddy on-demand TLS permission URL. */
    tlsAskToken?: string;
    timeoutMs?: number;
    maxBodyBytes?: number;
    resolveTxt?: (hostname: string) => Promise<readonly (readonly string[])[]>;
    resolveCname?: DomainDnsResolver["resolveCname"];
    resolve4?: DomainDnsResolver["resolve4"];
    resolve6?: DomainDnsResolver["resolve6"];
    /** Refresh custom-domain routing in the background. Defaults to 5 minutes; false disables it. */
    domainRecheckIntervalMs?: number | false;
    /** Maximum domains claimed by one reconciliation pass. Defaults to 25. */
    domainRecheckBatchSize?: number;
    /** Maximum time spent on one domain before its claim is released. Defaults to 10 seconds. */
    domainRecheckTimeoutMs?: number;
  };
  /** Receives unexpected failures for private operator logging. */
  onError?: (error: unknown) => void;
}

export interface PlatformRuntime {
  readonly handle: (request: Request) => Promise<Response>;
  readonly publicUrl: string;
  readonly dataDirectory: string;
  readonly hostingProfile: PlatformHostingProfile;
  readonly runnerKind: "process" | "docker";
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
  background: ActiveBackgroundProcess[];
  expectedStop: boolean;
  backgroundFailure?: string;
}

interface ActiveBackgroundProcess {
  role: "worker" | "scheduler";
  instance: number;
  child: NativeChild;
  expectedStop: boolean;
}

interface ProjectRow {
  id: string;
  ownerId: string;
  organizationId: string | null;
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
  runtimeBytes: number;
  runnerArtifactBytes: number;
  runnerArtifactStore: string;
  runnerArtifactKey: string | null;
  snapshotBytes: number;
  storageBytes: number;
  artifactAvailable: boolean;
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
  tokenId: string | null;
  userId: string;
  email: string;
  organizationId: string | null;
  projectId: string | null;
  permissions: readonly ProjectPermission[];
  impersonation: PlatformImpersonation | null;
}

interface PlatformImpersonation {
  id: string;
  actorUserId: string;
  actorEmail: string;
  targetUserId: string;
  targetEmail: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

type OrganizationRole = "owner" | "admin" | "developer" | "viewer";
type ProjectPermission = "read" | "deploy" | "rollback" | "secrets" | "tokens" | "audit";

interface ProjectAccess {
  project: ProjectRow;
  role: OrganizationRole;
}

interface PlatformDatabase {
  database: SQLiteDatabase<ReturnType<typeof defineDatabase<{}>>>;
  internal: SQLiteInternal;
  auth: AuthRuntime<DefaultAuthProfile>;
  rateLimits: AuthRateLimitStore;
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
const METRIC_BUCKET_MS = 60_000;
const LATENCY_BOUNDS_MS = [50, 100, 250, 500, 1_000, 2_500, 5_000] as const;
const METRIC_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const METRIC_METHOD_COLUMNS = [
  "method_get",
  "method_head",
  "method_post",
  "method_put",
  "method_patch",
  "method_delete",
  "method_options",
  "method_other",
] as const;
const DEFAULT_DOMAIN_RECHECK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DOMAIN_RECHECK_BATCH_SIZE = 25;
const DEFAULT_DOMAIN_RECHECK_TIMEOUT_MS = 10_000;
const DOMAIN_RECHECK_CONCURRENCY = 4;
const DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_BACKUP_BATCH_SIZE = 5;
const DEFAULT_BACKUP_MAX_COUNT = 30;
const DEFAULT_BACKUP_MAX_AGE_MS = 90 * 24 * 60 * 60_000;
const DEFAULT_BACKUP_MAX_DATABASE_BYTES = 10 * 1024 * 1024 * 1024;
const BACKUP_CONCURRENCY = 2;
const DEFAULT_RELEASES_PER_PROJECT = 50;
const DEFAULT_RELEASE_STORAGE_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_PENDING_INVITATIONS_PER_ORGANIZATION = 100;
const MAX_PENDING_PERSONAL_INVITATIONS = 100;
const BOOTSTRAP_CLAIM_MS = 5 * 60_000;
const MAX_PLATFORM_RATE_LIMIT_KEYS = 20_000;
const PLATFORM_RATE_LIMIT_PRUNE_TARGET = 18_000;
const PLATFORM_ADMIN_ROLE = "platform_admin";
const IMPERSONATION_DURATION_MS = 15 * 60_000;
const IMPERSONATION_RECENT_AUTH_MS = 30 * 60_000;
const IMPERSONATION_COOKIE = "clank-impersonation";
const SECURE_IMPERSONATION_COOKIE = "__Host-clank-impersonation";

/** Opens Clank's self-hostable deployment control plane and release supervisor. */
export async function openPlatform(options: ClankPlatformOptions): Promise<PlatformRuntime> {
  // The platform is a dedicated control-plane process. A private umask keeps
  // SQLite journals, backups, logs, and generated launchers owner-readable only.
  (globalThis as any).process.umask?.(0o077);
  const runner: PlatformRunnerOptions = options.runner ?? { kind: "process" };
  const hostingProfile = options.hostingProfile ?? (runner.kind === "docker" ? "isolated" : "trusted");
  if (hostingProfile !== "trusted" && hostingProfile !== "isolated") {
    throw new TypeError('hostingProfile must be "trusted" or "isolated".');
  }
  if (hostingProfile === "isolated" && runner.kind !== "docker") {
    throw new TypeError('hostingProfile "isolated" requires a Docker runner.');
  }
  const platformBrandAssets = new Map<string, { bytes: Uint8Array; contentType: string }>(await Promise.all([
    ["/favicon.ico", "../brand/favicon.ico", "image/x-icon"],
    ["/apple-touch-icon.png", "../brand/apple-touch-icon.png", "image/png"],
    ["/brand/clank-mark-32.png", "../brand/clank-mark-32.png", "image/png"],
    ["/brand/clank-mark-64.png", "../brand/clank-mark-64.png", "image/png"],
  ].map(async ([path, source, contentType]) => [
    path,
    { bytes: await readFile(new URL(source, import.meta.url)), contentType },
  ] as const)));
  const publicUrl = normalizePublicUrl(options.publicUrl);
  const publicUrlObject = new URL(publicUrl);
  const publicHostname = normalizeHostname(publicUrlObject.hostname);
  const securePublicUrl = publicUrlObject.protocol === "https:";
  const platformAdminEmails = new Set(
    (options.platformAdminEmails ?? []).map(normalizePlatformAdminEmail),
  );
  const baseDomain = options.ingress?.baseDomain
    ? normalizeHostname(options.ingress.baseDomain)
    : undefined;
  const customDomainTarget = options.ingress?.customDomainTarget
    ? normalizeHostname(options.ingress.customDomainTarget)
    : baseDomain;
  const customDomainAddresses = Object.freeze(normalizeEdgeAddresses(options.ingress?.customDomainAddresses ?? []));
  const domainRecheckIntervalMs = options.ingress?.domainRecheckIntervalMs === false
    ? false
    : integerInRange(
        options.ingress?.domainRecheckIntervalMs ?? DEFAULT_DOMAIN_RECHECK_INTERVAL_MS,
        "ingress.domainRecheckIntervalMs",
        1_000,
        24 * 60 * 60_000,
      );
  const domainRecheckBatchSize = integerInRange(
    options.ingress?.domainRecheckBatchSize ?? DEFAULT_DOMAIN_RECHECK_BATCH_SIZE,
    "ingress.domainRecheckBatchSize",
    1,
    1_000,
  );
  const domainRecheckTimeoutMs = integerInRange(
    options.ingress?.domainRecheckTimeoutMs ?? DEFAULT_DOMAIN_RECHECK_TIMEOUT_MS,
    "ingress.domainRecheckTimeoutMs",
    100,
    60_000,
  );
  const backupIntervalMs = options.backups?.intervalMs === false
    ? false
    : integerInRange(
        options.backups?.intervalMs ?? DEFAULT_BACKUP_INTERVAL_MS,
        "backups.intervalMs",
        60_000,
        365 * 24 * 60 * 60_000,
      );
  const backupPolicy: PlatformBackupPolicy = Object.freeze({
    enabled: backupIntervalMs !== false,
    intervalMs: backupIntervalMs === false ? null : backupIntervalMs,
    batchSize: integerInRange(
      options.backups?.batchSize ?? DEFAULT_BACKUP_BATCH_SIZE,
      "backups.batchSize",
      1,
      100,
    ),
    concurrency: BACKUP_CONCURRENCY,
    maxBackups: integerInRange(
      options.backups?.maxBackups ?? DEFAULT_BACKUP_MAX_COUNT,
      "backups.maxBackups",
      1,
      10_000,
    ),
    maxAgeMs: integerInRange(
      options.backups?.maxAgeMs ?? DEFAULT_BACKUP_MAX_AGE_MS,
      "backups.maxAgeMs",
      60_000,
      Number.MAX_SAFE_INTEGER,
    ),
    maxDatabaseBytes: integerInRange(
      options.backups?.maxDatabaseBytes ?? DEFAULT_BACKUP_MAX_DATABASE_BYTES,
      "backups.maxDatabaseBytes",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  });
  const backupObjects = normalizePlatformBackupObjects(options.backups?.objects);
  const limits = Object.freeze({
    organizationsPerAccount: integerInRange(
      options.limits?.organizationsPerAccount ?? 5,
      "limits.organizationsPerAccount",
      1,
      10_000,
    ),
    projectsPerAccount: integerInRange(
      options.limits?.projectsPerAccount ?? 10,
      "limits.projectsPerAccount",
      1,
      100_000,
    ),
    projectsPerOrganization: integerInRange(
      options.limits?.projectsPerOrganization ?? 10,
      "limits.projectsPerOrganization",
      1,
      10_000,
    ),
    domainsPerProject: integerInRange(
      options.limits?.domainsPerProject ?? 5,
      "limits.domainsPerProject",
      1,
      1_000,
    ),
    metricRetentionDays: integerInRange(
      options.limits?.metricRetentionDays ?? 30,
      "limits.metricRetentionDays",
      1,
      365,
    ),
    releasesPerProject: integerInRange(
      options.limits?.releasesPerProject ?? DEFAULT_RELEASES_PER_PROJECT,
      "limits.releasesPerProject",
      2,
      100,
    ),
    releaseStorageBytesPerProject: integerInRange(
      options.limits?.releaseStorageBytesPerProject ?? DEFAULT_RELEASE_STORAGE_BYTES,
      "limits.releaseStorageBytesPerProject",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  });
  const quotaDefaults: PlatformQuotaValues = Object.freeze({
    organizationsPerAccount: limits.organizationsPerAccount,
    projectsPerAccount: limits.projectsPerAccount,
    projectsPerOrganization: limits.projectsPerOrganization,
    domainsPerProject: limits.domainsPerProject,
    releasesPerProject: limits.releasesPerProject,
    releaseStorageBytesPerProject: limits.releaseStorageBytesPerProject,
    backupsPerProject: backupPolicy.maxBackups,
  });
  const tlsAskToken = options.ingress?.tlsAskToken === undefined
    ? undefined
    : boundedString(options.ingress.tlsAskToken, "ingress.tlsAskToken", 16, 512);
  const customDomainRoutingConfigured = Boolean(customDomainTarget || customDomainAddresses.length);
  const appUrlTemplate = normalizeAppUrlTemplate(
    options.appUrlTemplate
      ?? (baseDomain
        ? `https://{slug}.${baseDomain}`
        : `http://${options.appHostname ?? "127.0.0.1"}:{port}`),
  );
  const appPortStart = integerInRange(options.appPortStart ?? 4300, "appPortStart", 1024, 65535);
  const appPortEnd = integerInRange(options.appPortEnd ?? 4999, "appPortEnd", 1024, 65535);
  if (appPortStart > appPortEnd) throw new TypeError("appPortStart cannot exceed appPortEnd.");
  const reservedAppPorts = normalizeReservedAppPorts(options.reservedAppPorts);
  const runnerArtifactObjects = normalizeRunnerArtifactObjects(
    options.deploymentAgents?.artifacts,
  );
  const paths = await prepareDirectories(options.dataDirectory);
  const masterKey = await resolveMasterKey(paths.root, options.masterKey);
  const signupMode = options.signup ?? "bootstrap";
  const storage = await openPlatformDatabase(paths.controlDatabase, masterKey);
  try {
    reconcileBackupObjectBinding(storage.internal, backupObjects);
  } catch (error) {
    storage.auth.close();
    storage.database.close();
    throw error;
  }
  reconcileReservedProjectPorts(storage.internal, appPortStart, appPortEnd, reservedAppPorts);
  reconcilePlatformAdminRoles(storage, platformAdminEmails);
  const finalizePlatformRegistration = (response: Response): Response => {
    if (response.status === 201) reconcilePlatformAdminRoles(storage, platformAdminEmails);
    return response;
  };
  const orchestrator = openDeploymentOrchestrator(storage.database);
  const runnerArtifactLimit = options.deploymentAgents
    ? options.deploymentAgents.maxArtifactBytes ?? 100 * 1024 * 1024
    : 0;
  const deploymentCoordinator = options.deploymentAgents
    ? createDeploymentCoordinatorHandler(orchestrator, {
        registrationToken: options.deploymentAgents.registrationToken,
        ...(options.deploymentAgents.maxRequestBytes === undefined
          ? {}
          : { maxRequestBytes: options.deploymentAgents.maxRequestBytes }),
        maxArtifactBytes: runnerArtifactLimit,
        artifact: {
          async load({ operation, signal }) {
            const payload = operation.payload;
            const releaseId = payload
              && typeof payload === "object"
              && !Array.isArray(payload)
              && typeof (payload as Record<string, unknown>).releaseId === "string"
              ? String((payload as Record<string, unknown>).releaseId)
              : null;
            if (!releaseId || signal.aborted) return null;
            const release = releaseById(storage.internal, releaseId);
            if (
              !release
              || release.projectId !== operation.projectId
              || release.runnerArtifactBytes <= 0
              || !release.artifactAvailable
            ) return null;
            return readRunnerReleaseArtifact(
              paths.projects,
              release,
              signal,
              runnerArtifactObjects,
            );
          },
        },
        onError: options.onError,
      })
    : null;
  const leaseOwner = `control-${(globalThis as any).process?.pid ?? 0}-${crypto.randomUUID()}`;
  const active = new Map<string, ActiveProcess>();
  const starting = new Set<ActiveProcess>();
  const reservedRolloutPorts = new Set<number>();
  const locks = new Map<string, Promise<unknown>>();
  let storageDiagnosticsCache: { expiresAt: number; value: Record<string, unknown> } | undefined;
  let storageDiagnosticsFlight: Promise<Record<string, unknown>> | undefined;
  const restartState = new Map<string, {
    count: number;
    windowStartedAt: number;
    cancelled: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  let bootstrapRegistrationActive = false;
  let closed = false;

  const storageDiagnostics = async (): Promise<Record<string, unknown>> => {
    const now = Date.now();
    if (storageDiagnosticsCache && storageDiagnosticsCache.expiresAt > now) {
      return storageDiagnosticsCache.value;
    }
    if (storageDiagnosticsFlight) return storageDiagnosticsFlight;
    const flight = (async () => {
      const projects = storage.internal.prepare(
        `SELECT id, name, slug, database_path
         FROM clank_platform_projects ORDER BY id`,
      ).all().map((row): StorageDiagnosticProject => ({
        id: String(row.id),
        name: String(row.name),
        slug: String(row.slug),
        databasePath: row.database_path === null ? null : String(row.database_path),
      }));
      const value = await inspectPlatformStorage(paths.root, projects, {
        releasesPerProject: limits.releasesPerProject,
        releaseStorageBytesPerProject: limits.releaseStorageBytesPerProject,
        backupEnabled: backupPolicy.enabled,
        backupIntervalMs: backupPolicy.intervalMs,
        backupMaxCount: backupPolicy.maxBackups,
        backupMaxAgeMs: backupPolicy.maxAgeMs,
      });
      storageDiagnosticsCache = { expiresAt: Date.now() + 15_000, value };
      return value;
    })();
    storageDiagnosticsFlight = flight;
    try {
      return await flight;
    } finally {
      if (storageDiagnosticsFlight === flight) storageDiagnosticsFlight = undefined;
    }
  };

  const domainStore: DomainChallengeStore = {
    save(challenge) {
      storage.internal.transaction(() => {
        const existing = storage.internal.prepare(
          "SELECT id, project_id FROM clank_platform_domains WHERE hostname = ?",
        ).get(challenge.hostname);
        if (!existing) {
          const project = projectById(storage.internal, challenge.projectId);
          if (!project) throw new PlatformError(404, "PROJECT_NOT_FOUND", "Project not found.");
          const effective = projectQuotas(storage.internal, project, quotaDefaults);
          const count = Number(storage.internal.prepare(
            "SELECT count(*) AS count FROM clank_platform_domains WHERE project_id = ?",
          ).get(challenge.projectId)?.count ?? 0);
          if (count >= effective.domainsPerProject) {
            throw new PlatformError(
              409,
              "DOMAIN_LIMIT_REACHED",
              `This site has reached its ${effective.domainsPerProject}-domain limit.`,
            );
          }
        }
        const result = storage.internal.prepare(`INSERT INTO clank_platform_domains
        (id, project_id, hostname, record_name, record_value, status, expires_at, verified_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(hostname) DO UPDATE SET id = excluded.id,
          record_name = excluded.record_name, record_value = excluded.record_value,
          status = excluded.status, expires_at = excluded.expires_at,
          verified_at = excluded.verified_at, created_at = excluded.created_at,
          routing_status = CASE WHEN clank_platform_domains.id = excluded.id THEN routing_status ELSE 'pending' END,
          certificate_status = CASE WHEN clank_platform_domains.id = excluded.id THEN certificate_status ELSE 'pending' END,
          resolved_records = CASE WHEN clank_platform_domains.id = excluded.id THEN resolved_records ELSE '{"cnames":[],"addresses":[]}' END,
          last_checked_at = CASE WHEN clank_platform_domains.id = excluded.id THEN last_checked_at ELSE NULL END,
          last_error = CASE WHEN clank_platform_domains.id = excluded.id THEN last_error ELSE NULL END,
          next_check_at = CASE WHEN clank_platform_domains.id = excluded.id THEN next_check_at ELSE NULL END,
          check_lease_token = CASE WHEN clank_platform_domains.id = excluded.id THEN check_lease_token ELSE NULL END,
          check_lease_until = CASE WHEN clank_platform_domains.id = excluded.id THEN check_lease_until ELSE NULL END
        WHERE clank_platform_domains.id = excluded.id OR (
          clank_platform_domains.project_id = excluded.project_id
          AND clank_platform_domains.status = 'pending'
          AND clank_platform_domains.expires_at <= excluded.created_at
        )`)
        .run(
          challenge.id,
          challenge.projectId,
          challenge.hostname,
          challenge.recordName,
          challenge.recordValue,
          challenge.status,
          challenge.expiresAt,
          challenge.verifiedAt ?? null,
          Date.now(),
          );
        if (Number(result.changes) !== 1) {
          throw new PlatformError(409, "DOMAIN_UNAVAILABLE", "That hostname is already assigned to another site.");
        }
      });
    },
    get(id) {
      const row = storage.internal.prepare("SELECT * FROM clank_platform_domains WHERE id = ?").get(id);
      return row ? domainChallengeFromRow(row) : undefined;
    },
    byHostname(hostname) {
      const row = storage.internal.prepare("SELECT * FROM clank_platform_domains WHERE hostname = ?").get(hostname);
      return row ? domainChallengeFromRow(row) : undefined;
    },
  };
  const domains = createDomainManager({
    store: domainStore,
    ...(options.ingress?.resolveTxt ? { resolveTxt: options.ingress.resolveTxt } : {}),
  });
  const domainDnsResolver = domainResolver(options.ingress);
  const inspectRouting = (hostname: string): Promise<DomainRoutingReport> => withTimeout(
    inspectDomainRouting(hostname, {
      ...(customDomainTarget ? { cname: customDomainTarget } : {}),
      addresses: customDomainAddresses,
    }, domainDnsResolver),
    domainRecheckTimeoutMs,
    "Domain routing lookup timed out.",
  );
  let lastMetricPrune = 0;
  const recordIngressMetric = (metric: IngressRequestMetric): void => {
    recordMetric(storage.internal, metric);
    if (metric.recordedAt - lastMetricPrune >= 60 * 60_000) {
      lastMetricPrune = metric.recordedAt;
      storage.internal.prepare("DELETE FROM clank_platform_metrics WHERE bucket_started_at < ?")
        .run(metric.recordedAt - limits.metricRetentionDays * 24 * 60 * 60_000);
    }
  };
  const ingressEnabled = options.ingress?.enabled === true || Boolean(baseDomain);
  const ingress = ingressEnabled
    ? createManagedIngress({
        routes: () => ingressRoutes(storage.internal, baseDomain, active),
        timeoutMs: options.ingress?.timeoutMs,
        maxBodyBytes: options.ingress?.maxBodyBytes,
        onRequest: recordIngressMetric,
      })
    : undefined;
  const domainReconciliation = {
    enabled: Boolean(ingress && customDomainRoutingConfigured && domainRecheckIntervalMs !== false),
    intervalMs: domainRecheckIntervalMs === false ? null : domainRecheckIntervalMs,
    batchSize: domainRecheckBatchSize,
    timeoutMs: domainRecheckTimeoutMs,
    lastStartedAt: null as number | null,
    lastCompletedAt: null as number | null,
    lastChecked: 0,
    lastFailed: 0,
  };
  let domainRecheckTimer: ReturnType<typeof setTimeout> | undefined;
  let domainRecheckFlight: Promise<boolean> | undefined;
  const nextDomainCheckAt = (): number | undefined => domainReconciliation.enabled
    ? Date.now() + (domainRecheckIntervalMs as number)
    : undefined;
  const reconcileDomain = async (
    claim: { id: string; token: string },
  ): Promise<"checked" | "failed" | "stale"> => {
    try {
      const challenge = await domainStore.get(claim.id);
      if (!challenge || closed) return "stale";
      const report = await inspectRouting(challenge.hostname);
      if (closed) return "stale";
      const saved = saveDomainRouting(storage.internal, challenge.id, report, {
        nextCheckAt: nextDomainCheckAt(),
        leaseToken: claim.token,
      });
      return saved ? "checked" : "stale";
    } catch (error) {
      if (closed) return "stale";
      const saved = saveDomainRoutingError(storage.internal, claim.id, {
        nextCheckAt: nextDomainCheckAt(),
        leaseToken: claim.token,
      });
      try { options.onError?.(error); } catch { /* Operator reporting must not break reconciliation. */ }
      return saved ? "failed" : "stale";
    }
  };
  const reconcileDomains = async (): Promise<boolean> => {
    if (!domainReconciliation.enabled || closed || domainRecheckFlight) return false;
    domainReconciliation.lastStartedAt = Date.now();
    const claims = claimDomainsForRecheck(
      storage.internal,
      domainReconciliation.lastStartedAt,
      domainRecheckBatchSize,
      Math.ceil(domainRecheckBatchSize / DOMAIN_RECHECK_CONCURRENCY) * domainRecheckTimeoutMs + 5_000,
    );
    const results = await runBounded(claims, DOMAIN_RECHECK_CONCURRENCY, reconcileDomain, () => closed);
    if (closed) return false;
    domainReconciliation.lastChecked = results.filter((result) => result !== "stale").length;
    domainReconciliation.lastFailed = results.filter((result) => result === "failed").length;
    domainReconciliation.lastCompletedAt = Date.now();
    const now = Date.now();
    return Number(storage.internal.prepare(`SELECT count(*) AS count FROM clank_platform_domains
      WHERE (status = 'verified' OR expires_at > ?)
        AND coalesce(next_check_at, 0) <= ?
        AND (check_lease_until IS NULL OR check_lease_until <= ?)`).get(now, now, now)?.count ?? 0) > 0;
  };
  const nextDomainReconciliationDelay = (): number => {
    const intervalMs = domainRecheckIntervalMs as number;
    const now = Date.now();
    const row = storage.internal.prepare(`SELECT min(coalesce(next_check_at, 0)) AS next_check_at
      FROM clank_platform_domains
      WHERE (status = 'verified' OR expires_at > ?)
        AND (check_lease_until IS NULL OR check_lease_until <= ?)`).get(now, now);
    if (row?.next_check_at === null || row?.next_check_at === undefined) return intervalMs;
    return Math.max(0, Math.min(intervalMs, Number(row.next_check_at) - now));
  };
  const scheduleDomainReconciliation = (requestedDelayMs?: number): void => {
    if (!domainReconciliation.enabled || closed || domainRecheckTimer) return;
    const delayMs = requestedDelayMs ?? nextDomainReconciliationDelay();
    domainRecheckTimer = setTimeout(() => {
      domainRecheckTimer = undefined;
      const flight = reconcileDomains().catch((error) => {
        if (!closed) {
          try { options.onError?.(error); } catch { /* Operator reporting must not break scheduling. */ }
        }
        return false;
      });
      domainRecheckFlight = flight;
      void flight.then((backlogMayRemain) => {
        if (domainRecheckFlight === flight) domainRecheckFlight = undefined;
        if (!closed) scheduleDomainReconciliation(backlogMayRemain ? 0 : undefined);
      });
    }, delayMs);
    domainRecheckTimer.unref?.();
  };

  const withProjectLock = async <Value>(projectId: string, operation: () => Promise<Value>): Promise<Value> => {
    const previous = locks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    locks.set(projectId, queued);
    await previous.catch(() => undefined);
    let distributedLease;
    try {
      const leaseDeadline = Date.now() + 30_000;
      distributedLease = await orchestrator.acquireLease(`project:${projectId}`, leaseOwner);
      while (!distributedLease && Date.now() < leaseDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 100)));
        distributedLease = await orchestrator.acquireLease(`project:${projectId}`, leaseOwner);
      }
      if (!distributedLease) {
        throw new PlatformError(409, "PROJECT_BUSY", "Another control-plane worker is changing this project.");
      }
    } catch (error) {
      release();
      if (locks.get(projectId) === queued) locks.delete(projectId);
      throw error;
    }
    let currentLease = distributedLease;
    let leaseLost = false;
    const renewer = setInterval(() => {
      void orchestrator.renewLease(currentLease).then((renewed) => {
        if (renewed) currentLease = renewed;
        else leaseLost = true;
      }).catch(() => { leaseLost = true; });
    }, 10_000);
    renewer.unref?.();
    try {
      const value = await operation();
      if (leaseLost) throw new PlatformError(409, "PROJECT_LEASE_LOST", "The project lease was lost during the operation.");
      return value;
    } finally {
      clearInterval(renewer);
      await orchestrator.releaseLease(currentLease).catch(() => false);
      release();
      if (locks.get(projectId) === queued) locks.delete(projectId);
    }
  };

  const backupScheduler = createPlatformBackupScheduler({
    internal: storage.internal,
    policy: backupPolicy,
    async createBackup(projectId) {
      return withProjectLock(projectId, async () => {
        const project = projectById(storage.internal, projectId);
        if (!project?.databasePath) throw new Error("Scheduled backup database is unavailable.");
        const effective = projectQuotas(storage.internal, project, quotaDefaults);
        const manager = await projectBackupManager(paths.projects, project, masterKey, {
          ...backupPolicy,
          maxBackups: effective.backupsPerProject,
        }, backupObjects);
        try {
          return await manager.create({ reason: "automatic scheduled backup" });
        } finally {
          manager.close();
        }
      });
    },
    onError: options.onError,
  });

  const stopBackgroundProcesses = async (running: ActiveProcess): Promise<void> => {
    const processes = running.background.splice(0);
    for (const process of processes) process.expectedStop = true;
    await Promise.allSettled(processes.map((process) => stopChild(process.child)));
  };

  const stopRunning = async (running: ActiveProcess): Promise<void> => {
    running.expectedStop = true;
    if (active.get(running.projectId) === running) active.delete(running.projectId);
    await Promise.allSettled([
      stopBackgroundProcesses(running),
      stopChild(running.child),
    ]);
  };

  const stopProject = async (projectId: string): Promise<void> => {
    const running = active.get(projectId);
    if (running) await stopRunning(running);
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

  const launchBackgroundProcesses = async (
    running: ActiveProcess,
    release: ReleaseRow,
    dataRoot: string,
    port: number,
    environment: Record<string, string>,
    secrets: Record<string, string>,
  ): Promise<void> => {
    const jobs = release.config.jobs;
    if (!jobs) return;
    running.backgroundFailure = undefined;
    const launches: Array<{ role: "worker" | "scheduler"; instance: number }> = [
      ...Array.from({ length: jobs.workers }, (_, instance) => ({
        role: "worker" as const,
        instance,
      })),
      ...(jobs.scheduler ? [{ role: "scheduler" as const, instance: 0 }] : []),
    ];
    for (const launch of launches) {
      const backgroundEnvironment = {
        ...environment,
        CLANK_PROCESS_ROLE: launch.role,
        ...(launch.role === "worker"
          ? {
              CLANK_WORKER_CONCURRENCY: String(jobs.concurrency),
              CLANK_WORKER_QUEUES: jobs.queues.join(","),
            }
          : {}),
      };
      const child = await spawnRelease(
        runner,
        release,
        dataRoot,
        port,
        backgroundEnvironment,
        {
          entry: jobs.entry,
          role: launch.role,
          instance: launch.instance,
          exposePort: false,
        },
      );
      const background: ActiveBackgroundProcess = {
        role: launch.role,
        instance: launch.instance,
        child,
        expectedStop: false,
      };
      running.background.push(background);
      const stream = `${launch.role}${launch.role === "worker" ? `[${launch.instance + 1}]` : ""}`;
      captureOutput(
        child.stdout,
        (line) => recordLog(running.projectId, release.id, `${stream}:stdout`, redact(line, secrets)),
      );
      captureOutput(
        child.stderr,
        (line) => recordLog(running.projectId, release.id, `${stream}:stderr`, redact(line, secrets)),
      );
      child.once("error", (error) => {
        recordLog(running.projectId, release.id, "platform", `${stream} process error: ${safeError(error)}`);
      });
      child.once("exit", (code, signal) => {
        const failure = `${stream} process exited (${String(code ?? signal ?? "unknown")}).`;
        recordLog(running.projectId, release.id, "platform", failure);
        if (background.expectedStop || running.expectedStop || closed) return;
        running.backgroundFailure = failure;
        if (active.get(running.projectId) === running) {
          storage.internal.prepare("UPDATE clank_platform_releases SET status = 'crashed', failure = ? WHERE id = ?")
            .run(failure, release.id);
          scheduleRestart(running.projectId, release.id);
        }
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (running.backgroundFailure || running.background.some((process) =>
      process.child.exitCode !== null && process.child.exitCode !== undefined)) {
      throw new Error(running.backgroundFailure ?? "A background process exited during startup.");
    }
    recordLog(
      running.projectId,
      release.id,
      "platform",
      `Started ${jobs.workers} worker process(es) at concurrency ${jobs.concurrency}`
        + `${jobs.scheduler ? " and one scheduler" : ""}.`,
    );
  };

  const releaseLaunchContext = async (
    project: ProjectRow,
    release: ReleaseRow,
    secrets: Record<string, string>,
    port: number,
  ): Promise<{ dataRoot: string; environment: Record<string, string> }> => {
    const dataRoot = await projectDataDirectory(paths.projects, project.id);
    const databaseHostPath = await safeProjectDataPath(dataRoot, release.config.database.path);
    return {
      dataRoot,
      environment: {
        ...release.config.env,
        ...secrets,
        NODE_ENV: "production",
        PORT: String(port),
        CLANK_DATABASE_PATH: databaseHostPath,
        CLANK_DATABASE: databaseHostPath,
        PROACT_DATABASE_PATH: databaseHostPath,
        PROACT_DATABASE: databaseHostPath,
        // Managed applications are reachable only through the loopback-bound
        // ingress. Trust its overwritten forwarding headers so auth, secure
        // cookies, passkeys, and generated URLs see the verified public origin.
        // Host admission remains at the ingress because verified custom domains
        // can be attached without restarting the application process.
        ALLOWED_HOSTS: ingressEnabled
          ? ""
          : `localhost,127.0.0.1,${options.appHostname ?? "127.0.0.1"}`,
        CLANK_MANAGED_INGRESS: ingressEnabled ? "1" : "0",
        TRUST_PROXY: ingressEnabled ? "1" : "0",
      },
    };
  };

  const launchRelease = async (
    project: ProjectRow,
    release: ReleaseRow,
    secrets: Record<string, string>,
    port: number,
  ): Promise<ActiveProcess> => {
    const { dataRoot, environment } = await releaseLaunchContext(project, release, secrets, port);
    await assertPortAvailable(port);
    const child = await spawnRelease(
      runner,
      release,
      dataRoot,
      port,
      environment,
      {
        entry: release.config.entry,
        role: "web",
        instance: 0,
        exposePort: true,
      },
    );
    const running: ActiveProcess = {
      projectId: project.id,
      releaseId: release.id,
      port,
      child,
      background: [],
      expectedStop: false,
    };
    starting.add(running);
    captureOutput(child.stdout, (line) => recordLog(project.id, release.id, "stdout", redact(line, secrets)));
    captureOutput(child.stderr, (line) => recordLog(project.id, release.id, "stderr", redact(line, secrets)));
    child.once("error", (error) => {
      recordLog(project.id, release.id, "platform", `Process error: ${safeError(error)}`);
    });
    child.once("exit", (code, signal) => {
      const wasActive = active.get(project.id) === running;
      if (wasActive) active.delete(project.id);
      recordLog(project.id, release.id, "platform", `Process exited (${String(code ?? signal ?? "unknown")}).`);
      if (wasActive && !running.expectedStop && !closed) {
        storage.internal.prepare("UPDATE clank_platform_releases SET status = 'crashed', failure = ? WHERE id = ?")
          .run(`Process exited (${String(code ?? signal ?? "unknown")}).`, release.id);
        scheduleRestart(project.id, release.id);
      }
    });
    try {
      await waitForHealth(port, release.config.health.path, release.config.health.timeoutMs, child);
      if (child.exitCode !== null && child.exitCode !== undefined) {
        throw new Error("Application exited immediately after its health check passed.");
      }
      if (closed) throw new Error("Platform closed while the application was starting.");
      await launchBackgroundProcesses(running, release, dataRoot, port, environment, secrets);
      return running;
    } catch (error) {
      await stopRunning(running);
      throw error;
    } finally {
      starting.delete(running);
    }
  };

  const startRelease = async (
    project: ProjectRow,
    release: ReleaseRow,
    secrets: Record<string, string>,
  ): Promise<ActiveProcess> => {
    const current = active.get(project.id);
    if (current) await stopRunning(current);
    const running = await launchRelease(project, release, secrets, project.port);
    active.set(project.id, running);
    return running;
  };

  const reserveRolloutPort = async (project: ProjectRow): Promise<number> => {
    const unavailable = new Set<number>([
      ...storage.internal.prepare("SELECT id, port FROM clank_platform_projects").all()
        .filter((row) => String(row.id) !== project.id)
        .map((row) => Number(row.port)),
      ...[...active.values()].map((running) => running.port),
      ...reservedRolloutPorts,
      ...reservedAppPorts,
    ]);
    for (let port = appPortStart; port <= appPortEnd; port++) {
      if (unavailable.has(port)) continue;
      reservedRolloutPorts.add(port);
      try {
        await assertPortAvailable(port);
        return port;
      } catch {
        reservedRolloutPorts.delete(port);
      }
    }
    throw new PlatformError(
      503,
      "ROLLOUT_PORT_CAPACITY",
      "No spare application port is available for a zero-downtime rollout.",
    );
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
      void withProjectLock(projectId, async () => {
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
      }).catch((error) => {
        if (state!.cancelled || closed) return;
        options.onError?.(error);
        recordLog(projectId, releaseId, "platform", `Automatic restart coordination failed: ${safeError(error)}`);
        scheduleRestart(projectId, releaseId);
      });
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
      return releasePayload(project, release!, appUrlTemplate, active.get(project.id)?.port);
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
    const bundleStorageBytes = bundle.files.reduce((total, file) => total + file.size, 0);
    const runnerArtifactBytes = options.deploymentAgents ? bytes.byteLength : 0;
    if (runnerArtifactBytes > runnerArtifactLimit) {
      throw new PlatformError(
        413,
        "RUNNER_ARTIFACT_TOO_LARGE",
        "This release exceeds the remote deployment-node artifact limit.",
      );
    }
    let databaseStorageBytes: number;
    try {
      databaseStorageBytes = await projectDatabaseFootprint(
        paths.projects,
        project,
        bundle.config.database.path,
      );
    } catch (error) {
      try { options.onError?.(error); } catch { /* Operator reporting must not change deployment validation. */ }
      throw new PlatformError(
        422,
        "INVALID_DATABASE_STORAGE",
        "Project database storage must use regular files without symbolic links.",
      );
    }
    assertReleaseCapacity(
      storage.internal,
      project.id,
      bundleStorageBytes + runnerArtifactBytes + databaseStorageBytes,
      projectQuotas(storage.internal, project, quotaDefaults),
    );
    const releaseId = await randomId(18);
    const runnerArtifactStore = runnerArtifactBytes > 0 && runnerArtifactObjects
      ? runnerArtifactObjects.namespace
      : "local";
    const runnerArtifactKey = runnerArtifactBytes > 0 && runnerArtifactObjects
      ? runnerReleaseObjectKey(project.id, releaseId, digest)
      : null;
    const releaseDirectory = await newReleaseDirectory(paths.projects, project.id, releaseId);
    const previousReleaseId = project.activeReleaseId;
    const createdAt = Date.now();
    storage.internal.prepare(`INSERT INTO clank_platform_releases
      (id, project_id, previous_release_id, status, digest, artifact_bytes, runtime_bytes, runner_artifact_bytes,
       runner_artifact_store, runner_artifact_key,
       snapshot_bytes, storage_bytes, artifact_available, framework_version, node_version,
       config, directory, backup_path, idempotency_key, created_at)
      VALUES (?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(
        releaseId,
        project.id,
        previousReleaseId,
        digest,
        bytes.byteLength,
        bundleStorageBytes,
        runnerArtifactBytes,
        runnerArtifactStore,
        runnerArtifactKey,
        bundleStorageBytes + runnerArtifactBytes + databaseStorageBytes,
        bundle.provenance.frameworkVersion,
        bundle.provenance.nodeVersion,
        JSON.stringify(bundle.config),
        releaseDirectory,
        idempotencyKey,
        createdAt,
      );
    let backupPath: string | null = null;
    let databaseExisted = false;
    let databaseChanged = false;
    let preMigrationCapacityRejection: PlatformError | null = null;
    const previousRuntime = active.get(project.id);
    let previousWasStopped = false;
    let previousBackgroundStopped = false;
    let candidateRuntime: ActiveProcess | undefined;
    let rolloutPort: number | undefined;
    let activationCommitted = false;
    let activatedResult: Record<string, unknown> | undefined;
    try {
      if (runnerArtifactBytes > 0) {
        try {
          await writeRunnerReleaseArtifact(
            paths.projects,
            {
              projectId: project.id,
              releaseId,
              digest,
              bytes: runnerArtifactBytes,
              store: runnerArtifactStore,
              key: runnerArtifactKey,
            },
            bytes,
            runnerArtifactObjects,
          );
        } catch (error) {
          try { options.onError?.(error); } catch { /* Reporting must not expose provider failures. */ }
          let cleanupSucceeded = true;
          try {
            const failedRelease = releaseById(storage.internal, releaseId);
            if (!failedRelease) throw new Error("Failed release metadata is unavailable.");
            await deleteReleaseStorage(paths.projects, failedRelease, runnerArtifactObjects);
            storage.internal.prepare(`UPDATE clank_platform_releases
              SET artifact_available = 0, runtime_bytes = 0, runner_artifact_bytes = 0,
                runner_artifact_key = NULL, snapshot_bytes = 0, storage_bytes = 0,
                backup_path = NULL
              WHERE id = ? AND project_id = ?`).run(releaseId, project.id);
          } catch (cleanupError) {
            cleanupSucceeded = false;
            try { options.onError?.(cleanupError); } catch { /* Reporting must not alter recovery. */ }
          }
          throw new PlatformError(
            502,
            cleanupSucceeded
              ? "RELEASE_ARTIFACT_STORE_FAILED"
              : "RELEASE_ARTIFACT_STORE_RECOVERY_FAILED",
            cleanupSucceeded
              ? "The original release could not be retained safely."
              : "The original release could not be retained and automatic cleanup failed.",
          );
        }
      }
      await extractDeploymentBundle(bundle, releaseDirectory);
      const dataRoot = await projectDataDirectory(paths.projects, project.id);
      const databasePath = await safeProjectDataPath(dataRoot, bundle.config.database.path);
      databaseExisted = await fileExists(databasePath);
      const migrationDirectory = await safeReleasePath(releaseDirectory, bundle.config.database.migrations);
      const migrations = await loadMigrations(migrationDirectory);
      const migrationPlan = databaseExisted
        ? await planMigrations(databasePath, migrations)
        : { applied: [], pending: migrations };
      if (databaseExisted) {
        backupPath = await releaseBackupPath(paths.projects, project.id, releaseId);
        await backupSQLite(databasePath, backupPath);
        const actualBackupBytes = await regularFileBytes(backupPath);
        storage.internal.prepare(
          `UPDATE clank_platform_releases
            SET backup_path = ?, snapshot_bytes = ?,
              storage_bytes = runtime_bytes + runner_artifact_bytes + ?
            WHERE id = ?`,
        ).run(backupPath, actualBackupBytes, actualBackupBytes, releaseId);
        try {
          assertReleaseCapacity(
            storage.internal,
            project.id,
            bundleStorageBytes + runnerArtifactBytes + actualBackupBytes,
            projectQuotas(storage.internal, project, quotaDefaults),
            releaseId,
          );
        } catch (error) {
          if (error instanceof PlatformError && error.code === "RELEASE_STORAGE_LIMIT_REACHED") {
            preMigrationCapacityRejection = error;
          }
          throw error;
        }
      }
      const requiresExclusiveDatabase = !databaseExisted || migrationPlan.pending.length > 0;
      const rolling = Boolean(previousRuntime && ingress && !requiresExclusiveDatabase);
      if (rolling) rolloutPort = await reserveRolloutPort(project);
      if (previousRuntime && !rolling) {
        await stopRunning(previousRuntime);
        previousWasStopped = true;
        recordLog(
          project.id,
          releaseId,
          "platform",
          requiresExclusiveDatabase
            ? `Stopped the prior release for ${migrationPlan.pending.length} pending database migration(s).`
            : "Stopped the prior release because managed ingress is disabled.",
        );
      }
      databaseChanged = requiresExclusiveDatabase;
      await applyMigrations({
        path: databasePath,
        directory: migrationDirectory,
        allowUnsafe: bundle.config.database.allowUnsafeMigrations,
      });
      const refreshedProject = { ...project, databasePath: bundle.config.database.path };
      const release = releaseById(storage.internal, releaseId)!;
      const secrets = decryptProjectSecrets(storage.internal, project.id, masterKey);
      rolloutPort ??= project.port;
      if (rolling && previousRuntime && previousRuntime.background.length > 0) {
        await stopBackgroundProcesses(previousRuntime);
        previousBackgroundStopped = true;
        recordLog(
          project.id,
          releaseId,
          "platform",
          "Quiesced prior worker and scheduler processes before starting the candidate release.",
        );
      }
      try {
        candidateRuntime = await launchRelease(refreshedProject, release, secrets, rolloutPort);
      } finally {
        if (rolling) reservedRolloutPorts.delete(rolloutPort);
      }
      active.set(project.id, candidateRuntime);
      if (rolling) {
        recordLog(
          project.id,
          releaseId,
          "platform",
          `Candidate passed health checks on port ${rolloutPort}; switched managed ingress.`,
        );
      }
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
      activationCommitted = true;
      activatedResult = releasePayload(
        { ...refreshedProject, activeReleaseId: releaseId, updatedAt: activatedAt },
        { ...release, status: "active", activatedAt, backupPath },
        appUrlTemplate,
        candidateRuntime.port,
      );
      if (rolling && previousRuntime) {
        try {
          const drained = await ingress!.drain(`http://127.0.0.1:${previousRuntime.port}`);
          if (!drained) {
            recordLog(
              project.id,
              releaseId,
              "platform",
              "Prior release drain reached its two-second limit; terminating remaining streams.",
            );
          }
          await stopRunning(previousRuntime);
          recordLog(project.id, releaseId, "platform", "Drained the prior release after the ingress switch.");
        } catch (drainError) {
          options.onError?.(drainError);
          recordLog(
            project.id,
            releaseId,
            "platform",
            `Prior release cleanup failed after activation: ${safeError(drainError)}`,
          );
        }
      }
      audit(storage.internal, principal.userId, principal.tokenId, project.id, "release.activate", {
        releaseId,
        digest,
        previousReleaseId,
      });
      backupScheduler.registerProject(project.id);
      return activatedResult;
    } catch (error) {
      options.onError?.(error);
      if (activationCommitted && activatedResult) return activatedResult;
      if (rolloutPort !== undefined) reservedRolloutPorts.delete(rolloutPort);
      if (candidateRuntime) {
        try {
          await stopRunning(candidateRuntime);
        } catch (stopError) {
          options.onError?.(stopError);
        }
      }
      if (
        previousRuntime
        && !previousWasStopped
        && previousRuntime.child.exitCode === null
      ) {
        active.set(project.id, previousRuntime);
        if (previousBackgroundStopped && previousReleaseId) {
          try {
            const previous = releaseById(storage.internal, previousReleaseId);
            if (previous) {
              const previousSecrets = decryptProjectSecrets(storage.internal, project.id, masterKey);
              const { dataRoot, environment } = await releaseLaunchContext(
                project,
                previous,
                previousSecrets,
                previousRuntime.port,
              );
              await launchBackgroundProcesses(
                previousRuntime,
                previous,
                dataRoot,
                previousRuntime.port,
                environment,
                previousSecrets,
              );
              recordLog(
                project.id,
                previous.id,
                "platform",
                "Resumed prior worker and scheduler processes after candidate failure.",
              );
            }
          } catch (resumeError) {
            options.onError?.(resumeError);
            recordLog(
              project.id,
              previousReleaseId,
              "platform",
              `Could not resume prior background processes: ${safeError(resumeError)}`,
            );
            scheduleRestart(project.id, previousReleaseId);
          }
        }
      }
      if (error === preMigrationCapacityRejection) {
        let cleanupSucceeded = true;
        try {
          const rejectedRelease = releaseById(storage.internal, releaseId);
          if (!rejectedRelease) throw new Error("Rejected release metadata is unavailable.");
          await deleteReleaseStorage(paths.projects, rejectedRelease, runnerArtifactObjects);
          storage.internal.prepare(
            "DELETE FROM clank_platform_releases WHERE id = ? AND project_id = ?",
          ).run(releaseId, project.id);
        } catch (cleanupError) {
          cleanupSucceeded = false;
          options.onError?.(cleanupError);
          storage.internal.prepare(
            "UPDATE clank_platform_releases SET status = 'failed', failure = ? WHERE id = ?",
          ).run("Release storage rejection cleanup failed.", releaseId);
        }
        audit(storage.internal, principal.userId, principal.tokenId, project.id, "release.reject", {
          releaseId,
          digest,
          code: preMigrationCapacityRejection.code,
          cleanupSucceeded,
          restartSucceeded: true,
        });
        if (cleanupSucceeded) throw preMigrationCapacityRejection;
        throw new PlatformError(
          422,
          "DEPLOYMENT_RECOVERY_FAILED",
          "The deployment was rejected, but automatic release cleanup failed.",
        );
      }
      try {
        if (databaseChanged) {
          const dataRoot = await projectDataDirectory(paths.projects, project.id);
          const databasePath = await safeProjectDataPath(dataRoot, bundle.config.database.path);
          if (backupPath) await restoreSQLiteBackup(backupPath, databasePath);
          else if (!databaseExisted) await removeDatabaseFiles(databasePath);
        }
        if (previousWasStopped && previousReleaseId) {
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
    if (!target.artifactAvailable) {
      throw new PlatformError(409, "RELEASE_ARTIFACT_UNAVAILABLE", "This release's runtime artifact has been removed.");
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
      backupScheduler.registerProject(project.id);
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

  const cleanupRelease = async (
    principal: TokenPrincipal,
    project: ProjectRow,
    releaseId: string,
    confirmation: string,
    allowRollbackLoss: boolean,
  ): Promise<Record<string, unknown>> => withProjectLock(project.id, async () => {
    const currentProject = projectById(storage.internal, project.id);
    const release = releaseById(storage.internal, releaseId);
    if (!currentProject || !release || release.projectId !== project.id) {
      throw new PlatformError(404, "RELEASE_NOT_FOUND", "Release not found.");
    }
    const expected = `delete-release ${project.slug} ${release.id}`;
    if (confirmation !== expected) {
      throw new PlatformError(400, "CONFIRMATION_REQUIRED", `Pass confirmation "${expected}".`);
    }
    if (!release.artifactAvailable) {
      return {
        ...publicRelease(release),
        cleanup: {
          allowed: false,
          rollbackProtected: currentProject.activeReleaseId
            ? releaseById(storage.internal, currentProject.activeReleaseId)?.previousReleaseId === release.id
            : false,
        },
      };
    }
    if (currentProject.activeReleaseId === release.id) {
      throw new PlatformError(409, "ACTIVE_RELEASE_PROTECTED", "The active release artifact cannot be removed.");
    }
    const activeRelease = currentProject.activeReleaseId
      ? releaseById(storage.internal, currentProject.activeReleaseId)
      : null;
    const rollbackProtected = activeRelease?.previousReleaseId === release.id;
    if (rollbackProtected && !allowRollbackLoss) {
      throw new PlatformError(
        409,
        "RELEASE_ROLLBACK_PROTECTED",
        "This release is the active release's immediate rollback target. Explicitly allow rollback loss to remove it.",
      );
    }
    await deleteReleaseStorage(paths.projects, release, runnerArtifactObjects);
    if (rollbackProtected && activeRelease?.backupPath) {
      await deleteReleaseSnapshot(paths.projects, project.id, activeRelease.id);
    }
    storage.internal.transaction((changes) => {
      storage.internal.prepare(`UPDATE clank_platform_releases
        SET artifact_available = 0, runtime_bytes = 0, runner_artifact_bytes = 0, snapshot_bytes = 0,
          storage_bytes = 0, backup_path = NULL
        WHERE id = ? AND project_id = ?`).run(release.id, project.id);
      if (rollbackProtected && activeRelease?.backupPath) {
        storage.internal.prepare(`UPDATE clank_platform_releases
          SET snapshot_bytes = 0,
            storage_bytes = runtime_bytes + runner_artifact_bytes,
            backup_path = NULL
          WHERE id = ? AND project_id = ?`).run(activeRelease.id, project.id);
      }
      audit(storage.internal, principal.userId, principal.tokenId, project.id, "release.cleanup", {
        releaseId: release.id,
        storageBytes: release.storageBytes,
        rollbackProtected,
        activeSnapshotBytes: rollbackProtected ? activeRelease?.snapshotBytes ?? 0 : 0,
      });
      changes.record("__platform", project.id);
    });
    const cleaned = releaseById(storage.internal, release.id)!;
    return {
      ...publicRelease(cleaned),
      cleanup: { allowed: false, rollbackProtected: false },
    };
  });

  const deleteProject = async (
    principal: TokenPrincipal,
    projectId: string,
    confirmation: string,
    acknowledgeDataLoss: boolean,
  ): Promise<Record<string, unknown>> => withProjectLock(projectId, async () => {
    const access = accessibleProject(storage.internal, projectId, principal, "tokens");
    if (principal.projectId) {
      throw new PlatformError(403, "TOKEN_SCOPE_DENIED", "Project-scoped tokens cannot delete a site.");
    }
    requireOrganizationAdministration(access.role);
    const project = access.project;
    const expected = `delete-site ${project.slug}`;
    if (confirmation !== expected) {
      throw new PlatformError(400, "CONFIRMATION_REQUIRED", `Pass confirmation "${expected}".`);
    }
    if (!acknowledgeDataLoss) {
      throw new PlatformError(
        400,
        "DATA_LOSS_ACKNOWLEDGEMENT_REQUIRED",
        "Explicitly acknowledge permanent application data loss.",
      );
    }
    const activeRelease = project.activeReleaseId
      ? releaseById(storage.internal, project.activeReleaseId)
      : null;
    const summary = projectDeletionSummary(storage.internal, project.id);
    cancelRestart(project.id);
    await stopProject(project.id);
    try {
      await deleteProjectStorage(paths.projects, project.id, async () => {
        await deleteProjectBackups(
          paths.projects,
          project,
          masterKey,
          backupPolicy,
          backupObjects,
        );
        await deleteProjectRunnerArtifacts(
          storage.internal,
          project.id,
          runnerArtifactObjects,
        );
      });
    } catch (error) {
      try { options.onError?.(error); } catch { /* Operator reporting must not alter recovery. */ }
      if (activeRelease) {
        try {
          await startRelease(project, activeRelease, decryptProjectSecrets(storage.internal, project.id, masterKey));
        } catch (restartError) {
          try { options.onError?.(restartError); } catch { /* Operator reporting must not alter recovery. */ }
          throw new PlatformError(
            500,
            "PROJECT_DELETE_RECOVERY_FAILED",
            "Site storage could not be safely removed and the prior runtime could not be restarted.",
          );
        }
      }
      throw new PlatformError(
        409,
        "PROJECT_STORAGE_UNSAFE",
        "Site storage could not be safely removed. Site metadata was preserved.",
      );
    }
    const deletedAt = Date.now();
    let revokedTokens = 0;
    try {
      storage.internal.transaction((changes) => {
        revokedTokens = Number(storage.internal.prepare(`UPDATE clank_platform_tokens
          SET revoked_at = ?
          WHERE project_id = ? AND revoked_at IS NULL`).run(deletedAt, project.id).changes);
        storage.internal.prepare("DELETE FROM clank_deployment_operations WHERE project_id = ?").run(project.id);
        storage.internal.prepare("DELETE FROM clank_deployment_placements WHERE project_id = ?").run(project.id);
        const result = storage.internal.prepare("DELETE FROM clank_platform_projects WHERE id = ?").run(project.id);
        if (Number(result.changes) !== 1) {
          throw new PlatformError(404, "PROJECT_NOT_FOUND", "Project not found.");
        }
        audit(storage.internal, principal.userId, principal.tokenId, project.id, "project.delete", {
          projectId: project.id,
          organizationId: project.organizationId,
          name: project.name,
          slug: project.slug,
          revokedTokens,
          ...summary,
        });
        changes.record("__platform", project.organizationId ?? project.id);
      });
    } catch (error) {
      try { options.onError?.(error); } catch { /* Operator reporting must not alter the API result. */ }
      throw new PlatformError(
        500,
        "PROJECT_DELETE_FINALIZATION_FAILED",
        "Site files were removed, but control metadata cleanup failed. Retry the deletion.",
      );
    }
    return {
      id: project.id,
      organizationId: project.organizationId,
      name: project.name,
      slug: project.slug,
      deletedAt,
      revokedTokens,
      ...summary,
    };
  });

  const readiness = (): Response => {
    try {
      const result = storage.internal.prepare("SELECT 1 AS ready").get();
      if (Number(result?.ready) !== 1) throw new Error("Control database readiness probe failed.");
      return api({
        ok: true,
        status: "ready",
        checks: {
          database: "ok",
        },
      });
    } catch (error) {
      options.onError?.(error);
      return api({
        ok: false,
        status: "not_ready",
        checks: {
          database: "failed",
        },
      }, 503);
    }
  };

  const handleRequest = async (request: Request): Promise<Response> => {
    if (closed) return problem(503, "PLATFORM_CLOSED", "Platform is closed.");
    try {
      const url = new URL(request.url);
      // Caddy calls this permission endpoint over loopback, so it must be
      // handled before Host-based application dispatch. The secret is still
      // required because the path can also arrive through a public listener.
      if (url.pathname === "/_clank/tls/ask" && request.method === "GET") {
        if (!tlsAskToken || !await timingSafeStringEqual(url.searchParams.get("token") ?? "", tlsAskToken)) {
          return new Response(null, { status: 404 });
        }
        let hostname: string;
        try {
          hostname = normalizeHostname(url.searchParams.get("domain") ?? "");
        } catch {
          return new Response(null, { status: 403 });
        }
        const allowed = storage.internal.prepare(`SELECT d.id FROM clank_platform_domains d
          JOIN clank_platform_projects p ON p.id = d.project_id
          WHERE d.hostname = ? AND d.status = 'verified' AND d.routing_status = 'ready'
            AND p.active_release_id IS NOT NULL`).get(hostname);
        const builtInSlug = baseDomain && hostname.endsWith(`.${baseDomain}`)
          ? hostname.slice(0, -(baseDomain.length + 1))
          : "";
        const builtInAllowed = builtInSlug && !builtInSlug.includes(".")
          ? storage.internal.prepare(`SELECT id FROM clank_platform_projects
              WHERE slug = ? AND active_release_id IS NOT NULL`).get(builtInSlug)
          : undefined;
        if (!allowed && !builtInAllowed) return new Response(null, { status: 403 });
        if (allowed) {
          storage.internal.prepare(`UPDATE clank_platform_domains SET certificate_status = 'eligible'
            WHERE id = ? AND certificate_status = 'pending'`).run(allowed.id);
        }
        return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
      }
      // Hosted load balancers commonly probe with their own Host header. Keep
      // one reserved control-plane path ahead of application-host dispatch
      // without taking /healthz or /readyz away from deployed applications.
      if (url.pathname === "/_clank/readyz" && request.method === "GET") {
        return readiness();
      }
      if (ingress && normalizeHostname(url.hostname) !== publicHostname) {
        return await ingress.handle(request);
      }
      if (url.pathname === "/livez" && request.method === "GET") {
        return api({ ok: true, status: "alive" });
      }
      const brandAsset = request.method === "GET" || request.method === "HEAD"
        ? platformBrandAssets.get(url.pathname)
        : undefined;
      if (brandAsset) {
        return new Response(request.method === "HEAD" ? null : brandAsset.bytes, {
          headers: {
            "cache-control": "public, max-age=3600, must-revalidate",
            "content-type": brandAsset.contentType,
            "x-content-type-options": "nosniff",
          },
        });
      }
      if ((url.pathname === "/healthz" || url.pathname === "/readyz") && request.method === "GET") {
        return readiness();
      }
      if (
        url.pathname === DEPLOYMENT_COORDINATOR_PREFIX
        || url.pathname.startsWith(`${DEPLOYMENT_COORDINATOR_PREFIX}/`)
      ) {
        return deploymentCoordinator
          ? deploymentCoordinator.handle(request)
          : problem(404, "NOT_FOUND", "Deployment coordinator endpoint not found.");
      }
      const consolePath = request.method === "GET"
        ? canonicalPlatformConsolePath(url.pathname)
        : null;
      if (consolePath && consolePath !== url.pathname) {
        const location = new URL(request.url);
        location.pathname = consolePath;
        return new Response(null, {
          status: 308,
          headers: {
            location: `${location.pathname}${location.search}`,
            "cache-control": "no-store",
          },
        });
      }
      if (request.method === "GET" && !consolePath && isPlatformConsoleNamespacePath(url.pathname)) {
        return problem(404, "NOT_FOUND", "Control-plane page not found.");
      }
      const authPrefix = url.pathname === "/__proact/auth" || url.pathname.startsWith("/__proact/auth/")
        ? "/__proact/auth"
        : "/__clank/auth";
      if (url.pathname === authPrefix || url.pathname.startsWith(`${authPrefix}/`)) {
        const actor = await storage.auth.resolve(request);
        if (actor.user && actor.session && resolvePlatformImpersonation(storage.internal, request, actor)) {
          throw new PlatformError(
            403,
            "IMPERSONATION_READ_ONLY",
            "Exit read-only impersonation before using authentication controls.",
          );
        }
        const authOperation = url.pathname.slice(authPrefix.length).replace(/^\/+/, "");
        const registering = request.method === "POST" && authOperation === "register";
        const invitationRegistering = request.method === "POST" && authOperation === "invited-register";
        if (invitationRegistering) {
          return finalizePlatformRegistration(await registerWithInvitation(storage, request, authPrefix));
        }
        if (registering && signupMode === false) {
          return problem(403, "SIGNUP_DISABLED", "Platform registration is closed.");
        }
        if (registering && signupMode === "bootstrap") {
          if (bootstrapRegistrationActive) return problem(409, "SIGNUP_IN_PROGRESS", "The first account is already being created.");
          const claimId = `bootstrap_${crypto.randomUUID()}`;
          const claim = claimBootstrapRegistration(storage, claimId);
          if (claim === "registered") {
            return problem(403, "SIGNUP_DISABLED", "Platform registration is closed.");
          }
          if (claim === "busy") {
            return problem(409, "SIGNUP_IN_PROGRESS", "The first account is already being created.");
          }
          bootstrapRegistrationActive = true;
          try {
            const response = await storage.auth.handle(request, authPrefix);
            return finalizePlatformRegistration(response.status === 201
              ? retainBootstrapWinner(storage, response)
              : response);
          } finally {
            bootstrapRegistrationActive = false;
            storage.internal.prepare(
              "DELETE FROM clank_platform_bootstrap_claim WHERE singleton = 1 AND claim_id = ?",
            ).run(claimId);
          }
        }
        return finalizePlatformRegistration(await storage.auth.handle(request, authPrefix));
      }
      if (consolePath) {
        const auth = await storage.auth.resolve(request);
        const impersonation = auth.user && auth.session
          ? resolvePlatformImpersonation(storage.internal, request, auth)
          : null;
        const platformRole = auth.user
          ? String(storage.internal.prepare(
            "SELECT role FROM clank_auth_users WHERE id = ? AND disabled = 0",
          ).get(auth.user.id)?.role ?? "user")
          : null;
        const userCount = Number(storage.internal.prepare("SELECT count(*) AS count FROM clank_auth_users").get()?.count ?? 0);
        return platformConsolePage(
          publicUrl,
          auth,
          url.searchParams.get("code") ?? "",
          signupMode === true || (signupMode === "bootstrap" && userCount === 0),
          signupMode === "bootstrap",
          {
            platformRole,
            impersonation: impersonation ? {
              id: impersonation.id,
              actor: {
                id: impersonation.actorUserId,
                email: impersonation.actorEmail,
              },
              target: {
                id: impersonation.targetUserId,
                email: impersonation.targetEmail,
              },
              reason: impersonation.reason,
              createdAt: impersonation.createdAt,
              expiresAt: impersonation.expiresAt,
              readOnly: true,
            } : null,
          },
          consolePath,
        );
      }
      if (url.pathname === "/api/device/start" && request.method === "POST") {
        await enforceDeviceRateLimit(storage.rateLimits, request);
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
          verificationUri: `${publicUrl}/login?code=${encodeURIComponent(userCode)}`,
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
        rejectActiveImpersonation(storage.internal, request, auth);
        const code = normalizeUserCode(url.searchParams.get("code") ?? "");
        const row = storage.internal.prepare(
          "SELECT user_code, client_name, status, expires_at FROM clank_platform_device_codes WHERE user_code = ?",
        ).get(code);
        if (!row || Number(row.expires_at) <= Date.now()) throw new PlatformError(404, "CODE_NOT_FOUND", "Device code not found or expired.");
        return api({ ok: true, code: row.user_code, clientName: row.client_name, status: row.status, user: auth.user });
      }
      if ((url.pathname === "/api/device/approve" || url.pathname === "/api/device/deny") && request.method === "POST") {
        const auth = await requireBrowserAuth(storage.auth, request);
        rejectActiveImpersonation(storage.internal, request, auth);
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
      if (url.pathname === "/api/admin/impersonation" && request.method === "POST") {
        const auth = await requirePlatformAdmin(storage, request, true);
        if (Date.now() - auth.session!.createdAt > IMPERSONATION_RECENT_AUTH_MS) {
          throw new PlatformError(
            403,
            "RECENT_AUTH_REQUIRED",
            "Sign in again before starting an impersonation session.",
          );
        }
        const input = plainObject(await readJsonRequest(request, 8 * 1024));
        exact(input, ["targetUserId", "reason", "confirmation"]);
        const targetUserId = boundedString(input.targetUserId, "targetUserId", 8, 128);
        if (!/^[A-Za-z0-9_-]+$/u.test(targetUserId)) {
          throw new PlatformError(422, "INVALID_INPUT", "targetUserId is invalid.");
        }
        const reason = boundedString(input.reason, "reason", 8, 500).trim();
        if (reason.length < 8 || /[\u0000-\u001f\u007f]/u.test(reason)) {
          throw new PlatformError(
            422,
            "INVALID_INPUT",
            "reason must contain at least 8 characters and no control characters.",
          );
        }
        const target = storage.internal.prepare(
          "SELECT id, email, role, disabled FROM clank_auth_users WHERE id = ?",
        ).get(targetUserId);
        if (!target || Number(target.disabled) !== 0) {
          throw new PlatformError(404, "USER_NOT_FOUND", "The target account is unavailable.");
        }
        if (String(target.id) === auth.user!.id) {
          throw new PlatformError(422, "INVALID_TARGET", "A platform administrator cannot impersonate their own account.");
        }
        if (String(target.role) === PLATFORM_ADMIN_ROLE) {
          throw new PlatformError(403, "ADMIN_TARGET_DENIED", "Platform administrators cannot impersonate one another.");
        }
        const confirmation = normalizeEmail(input.confirmation);
        if (confirmation !== String(target.email).trim().toLowerCase()) {
          throw new PlatformError(422, "CONFIRMATION_MISMATCH", "Type the target account email exactly.");
        }
        const rawToken = await randomToken(32);
        const id = await randomId(18);
        const now = Date.now();
        const expiresAt = now + IMPERSONATION_DURATION_MS;
        storage.internal.transaction((changes) => {
          storage.internal.prepare(`UPDATE clank_platform_impersonations SET revoked_at = ?
            WHERE actor_user_id = ? AND actor_session_id = ? AND revoked_at IS NULL`)
            .run(now, auth.user!.id, auth.session!.id);
          storage.internal.prepare(`INSERT INTO clank_platform_impersonations
            (id, token_hash, actor_user_id, actor_session_id, target_user_id, reason,
             created_at, expires_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
            .run(
              id,
              syncHash(rawToken),
              auth.user!.id,
              auth.session!.id,
              targetUserId,
              reason,
              now,
              expiresAt,
            );
          audit(storage.internal, auth.user!.id, null, null, "impersonation.start", {
            impersonationId: id,
            targetUserId,
            targetEmail: String(target.email),
            reason,
            expiresAt,
          });
          changes.record("__platform", auth.user!.id);
        });
        return apiWithCookie({
          ok: true,
          impersonation: {
            id,
            actor: { id: auth.user!.id, email: auth.user!.email },
            target: { id: targetUserId, email: String(target.email) },
            reason,
            createdAt: now,
            expiresAt,
            readOnly: true,
          },
        }, impersonationCookie(request, rawToken, IMPERSONATION_DURATION_MS));
      }
      if (url.pathname === "/api/admin/impersonation" && request.method === "DELETE") {
        const auth = await requireBrowserAuth(storage.auth, request);
        await storage.auth.verifyCsrf(request, auth);
        return stopPlatformImpersonation(storage.internal, request, auth);
      }
      if (url.pathname === "/api/admin/invitations" && request.method === "GET") {
        await requirePlatformAdmin(storage, request);
        const invitations = storage.internal.prepare(`SELECT i.id, i.email, i.expires_at, i.created_at,
            u.id AS invited_by_id, u.email AS invited_by_email
          FROM clank_platform_personal_invitations i
          JOIN clank_auth_users u ON u.id = i.invited_by
          WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
          ORDER BY i.created_at DESC`).all(Date.now());
        return api({
          ok: true,
          invitations: invitations.map((row) => ({
            id: String(row.id),
            email: String(row.email),
            scope: "personal",
            invitedBy: {
              id: String(row.invited_by_id),
              email: String(row.invited_by_email),
            },
            expiresAt: Number(row.expires_at),
            createdAt: Number(row.created_at),
          })),
          limit: MAX_PENDING_PERSONAL_INVITATIONS,
        });
      }
      if (url.pathname === "/api/admin/invitations" && request.method === "POST") {
        const auth = await requirePlatformAdmin(storage, request, true);
        const input = plainObject(await readJsonRequest(request, 16 * 1024));
        exact(input, ["email", "expiresIn"]);
        const email = normalizeEmail(input.email);
        const expiresIn = input.expiresIn === undefined
          ? 7 * 24 * 60 * 60
          : integerInRange(input.expiresIn, "expiresIn", 300, 30 * 24 * 60 * 60);
        const token = `clnkp_${await randomToken(32)}`;
        const id = await randomId(18);
        const now = Date.now();
        const expiresAt = now + expiresIn * 1_000;
        let replacedInvitationId: string | null = null;
        storage.internal.transaction((changes) => {
          const existingAccount = storage.internal.prepare(
            "SELECT 1 AS present FROM clank_auth_users WHERE email = ?",
          ).get(email);
          if (existingAccount) {
            throw new PlatformError(
              409,
              "ACCOUNT_EXISTS",
              "That email already has an account and does not need a personal invitation.",
            );
          }
          const existingInvitation = storage.internal.prepare(`SELECT id
            FROM clank_platform_personal_invitations
            WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
            ORDER BY created_at DESC LIMIT 1`).get(email, now);
          replacedInvitationId = existingInvitation ? String(existingInvitation.id) : null;
          const pendingCount = Number(storage.internal.prepare(`SELECT count(*) AS count
            FROM clank_platform_personal_invitations
            WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).get(now)?.count ?? 0);
          if (!replacedInvitationId && pendingCount >= MAX_PENDING_PERSONAL_INVITATIONS) {
            throw new PlatformError(
              409,
              "INVITATION_LIMIT_REACHED",
              `This platform has reached its ${MAX_PENDING_PERSONAL_INVITATIONS}-invitation limit.`,
            );
          }
          storage.internal.prepare(`UPDATE clank_platform_personal_invitations SET revoked_at = ?
            WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
            .run(now, email, now);
          storage.internal.prepare(`INSERT INTO clank_platform_personal_invitations
            (id, token_hash, email, invited_by, expires_at, accepted_at, revoked_at, created_at)
            VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`)
            .run(id, syncHash(token), email, auth.user!.id, expiresAt, now);
          audit(storage.internal, auth.user!.id, null, null, "personal_invitation.create", {
            invitationId: id,
            email,
            expiresAt,
            replacedInvitationId,
          });
          changes.record("__platform", auth.user!.id);
        });
        return api({
          ok: true,
          invitation: { id, token, email, scope: "personal", expiresAt },
        }, 201);
      }
      const adminInvitationMatch = /^\/api\/admin\/invitations\/([A-Za-z0-9_-]{8,128})$/
        .exec(url.pathname);
      if (adminInvitationMatch && request.method === "DELETE") {
        const auth = await requirePlatformAdmin(storage, request, true);
        const invitationId = adminInvitationMatch[1]!;
        const now = Date.now();
        storage.internal.transaction((changes) => {
          const result = storage.internal.prepare(`UPDATE clank_platform_personal_invitations
            SET revoked_at = ?
            WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
            .run(now, invitationId, now);
          if (Number(result.changes) !== 1) {
            throw new PlatformError(404, "INVITATION_NOT_FOUND", "Active personal invitation not found.");
          }
          audit(storage.internal, auth.user!.id, null, null, "personal_invitation.revoke", {
            invitationId,
          });
          changes.record("__platform", auth.user!.id);
        });
        return api({ ok: true, invitationId, revoked: true });
      }
      if (url.pathname === "/api/admin/users" && request.method === "GET") {
        await requirePlatformAdmin(storage, request);
        const limit = queryInteger(url.searchParams.get("limit"), "limit", 50, 1, 200);
        const before = queryInteger(
          url.searchParams.get("before"),
          "before",
          Number.MAX_SAFE_INTEGER,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        const search = url.searchParams.get("query")?.trim() ?? "";
        if (search.length > 120) throw new PlatformError(422, "INVALID_INPUT", "query is too long.");
        return api({
          ok: true,
          ...platformAdminUsers(storage.internal, limit, before, search),
        });
      }
      const adminQuotaMatch = /^\/api\/admin\/quotas\/(account|workspace)\/([A-Za-z0-9_-]{8,128})$/
        .exec(url.pathname);
      if (adminQuotaMatch && request.method === "GET") {
        await requirePlatformAdmin(storage, request);
        return api({
          ok: true,
          ...platformAdminQuotaScope(
            storage.internal,
            adminQuotaMatch[1] as PlatformQuotaScope,
            adminQuotaMatch[2]!,
            quotaDefaults,
          ),
        });
      }
      if (adminQuotaMatch && request.method === "PUT") {
        const auth = await requirePlatformAdmin(storage, request, true);
        const input = plainObject(await readJsonRequest(request, 32 * 1024));
        exact(input, ["overrides"]);
        const overrides = plainObject(input.overrides);
        updatePlatformQuotaScope(
          storage.internal,
          adminQuotaMatch[1] as PlatformQuotaScope,
          adminQuotaMatch[2]!,
          overrides,
          auth.user!.id,
          quotaDefaults,
        );
        return api({
          ok: true,
          ...platformAdminQuotaScope(
            storage.internal,
            adminQuotaMatch[1] as PlatformQuotaScope,
            adminQuotaMatch[2]!,
            quotaDefaults,
          ),
        });
      }
      if (url.pathname === "/api/admin/analytics" && request.method === "GET") {
        await requirePlatformAdmin(storage, request);
        return api({
          ok: true,
          ...platformAdminAnalytics(
            storage.internal,
            active,
            url.searchParams.get("range") ?? "24h",
          ),
        });
      }
      if (url.pathname === "/api/admin/diagnostics/memory" && request.method === "GET") {
        await requirePlatformAdmin(storage, request);
        return api({
          ok: true,
          ...await platformMemoryDiagnostics(
            storage.internal,
            active,
            runner.kind ?? "process",
          ),
        });
      }
      if (url.pathname === "/api/admin/diagnostics/storage" && request.method === "GET") {
        await requirePlatformAdmin(storage, request);
        return api({
          ok: true,
          ...await storageDiagnostics(),
        });
      }

      const principal = await requirePlatformPrincipal(storage, request);
      if (url.pathname === "/api/audit" && request.method === "GET") {
        const limit = queryInteger(url.searchParams.get("limit"), "limit", 100, 1, 200);
        const before = queryInteger(url.searchParams.get("before"), "before", null, 1, Number.MAX_SAFE_INTEGER);
        const organizationId = url.searchParams.get("organizationId");
        if (organizationId !== null) {
          if (!/^[A-Za-z0-9_-]{8,128}$/u.test(organizationId)) {
            throw new PlatformError(422, "INVALID_INPUT", "organizationId is invalid.");
          }
          if (principal.projectId) {
            throw new PlatformError(403, "TOKEN_SCOPE_DENIED", "Project tokens cannot select a workspace audit feed.");
          }
          const membership = organizationMembership(storage.internal, organizationId, principal.userId);
          if (!roleAllows(membership.role, "audit")) {
            throw new PlatformError(403, "ROLE_DENIED", `The ${membership.role} role cannot perform audit operations.`);
          }
        }
        const result = workspaceAuditEvents(
          storage.internal,
          principal,
          limit,
          before,
          organizationId,
        );
        return api({ ok: true, ...result });
      }
      if (url.pathname === "/api/dashboard" && request.method === "GET") {
        if (principal.projectId && !principal.permissions.includes("read")) {
          throw new PlatformError(403, "TOKEN_SCOPE_DENIED", "This token cannot read project metrics.");
        }
        if (!principal.projectId && !principal.impersonation) {
          await ensurePersonalOrganization(storage.internal, principal, quotaDefaults);
        }
        return api(dashboardPayload(
          storage.internal,
          principal,
          active,
          appUrlTemplate,
          quotaDefaults,
          limits.metricRetentionDays,
          options.maxArtifactBytes,
          customDomainTarget,
          customDomainAddresses,
          Boolean(tlsAskToken),
          domainReconciliation,
        ));
      }
      if (url.pathname === "/api/account" && request.method === "GET") {
        const account = storage.internal.prepare(
          "SELECT role FROM clank_auth_users WHERE id = ?",
        ).get(principal.userId);
        return api({
          ok: true,
          account: {
            id: principal.userId,
            email: principal.email,
            platformRole: String(account?.role ?? "user"),
          },
          actor: principal.impersonation ? {
            id: principal.impersonation.actorUserId,
            email: principal.impersonation.actorEmail,
            platformRole: PLATFORM_ADMIN_ROLE,
          } : null,
          impersonation: principal.impersonation ? {
            id: principal.impersonation.id,
            reason: principal.impersonation.reason,
            createdAt: principal.impersonation.createdAt,
            expiresAt: principal.impersonation.expiresAt,
            readOnly: true,
          } : null,
          token: principal.tokenId === null ? null : {
            id: principal.tokenId,
            organizationId: principal.organizationId,
            projectId: principal.projectId,
            permissions: principal.permissions,
          },
        });
      }
      if (url.pathname === "/api/tokens" && request.method === "GET") {
        const tokenRows = principal.projectId
          ? storage.internal.prepare(`SELECT id, name, organization_id, project_id, permissions,
              created_at, last_used_at, expires_at
            FROM clank_platform_tokens
            WHERE user_id = ? AND id = ? AND revoked_at IS NULL AND expires_at > ?
            ORDER BY created_at DESC`).all(principal.userId, principal.tokenId, Date.now())
          : storage.internal.prepare(`SELECT id, name, organization_id, project_id, permissions,
              created_at, last_used_at, expires_at
            FROM clank_platform_tokens
            WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
            ORDER BY created_at DESC`).all(principal.userId, Date.now());
        return api({ ok: true, tokens: tokenRows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          createdAt: Number(row.created_at),
          lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
          expiresAt: Number(row.expires_at),
          organizationId: row.organization_id === null ? null : String(row.organization_id),
          projectId: row.project_id === null ? null : String(row.project_id),
          permissions: parseProjectPermissions(row.permissions),
          current: String(row.id) === principal.tokenId,
        })) });
      }
      if (url.pathname === "/api/tokens/current" && request.method === "DELETE") {
        if (principal.tokenId === null) throw new PlatformError(400, "CLI_TOKEN_REQUIRED", "This endpoint revokes only the current CLI token.");
        storage.internal.prepare("UPDATE clank_platform_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?")
          .run(Date.now(), principal.tokenId, principal.userId);
        audit(storage.internal, principal.userId, principal.tokenId, null, "token.revoke", {
          tokenId: principal.tokenId,
        });
        return api({ ok: true });
      }
      const tokenMatch = /^\/api\/tokens\/([A-Za-z0-9_-]{8,128})$/.exec(url.pathname);
      if (tokenMatch && request.method === "DELETE") {
        if (principal.projectId && tokenMatch[1] !== principal.tokenId) {
          throw new PlatformError(403, "TOKEN_SCOPE_DENIED", "Project tokens can revoke only themselves.");
        }
        const result = storage.internal.prepare(
          "UPDATE clank_platform_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
        ).run(Date.now(), tokenMatch[1], principal.userId);
        if (Number(result.changes) !== 1) throw new PlatformError(404, "TOKEN_NOT_FOUND", "Token not found.");
        audit(storage.internal, principal.userId, principal.tokenId, null, "token.revoke", {
          tokenId: tokenMatch[1],
        });
        return api({ ok: true });
      }
      if (url.pathname === "/api/organizations" && request.method === "GET") {
        if (principal.projectId) throw new PlatformError(403, "TOKEN_SCOPE_DENIED", "Project tokens cannot list organizations.");
        const rows = storage.internal.prepare(`SELECT o.id, o.name, o.slug, o.created_at, o.updated_at, m.role
          FROM clank_platform_organizations o
          JOIN clank_platform_memberships m ON m.organization_id = o.id
          WHERE m.user_id = ? ORDER BY o.created_at`).all(principal.userId);
        return api({ ok: true, organizations: rows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          slug: String(row.slug),
          role: String(row.role),
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        })) });
      }
      if (url.pathname === "/api/organizations" && request.method === "POST") {
        if (principal.projectId) throw new PlatformError(403, "TOKEN_SCOPE_DENIED", "Project tokens cannot create organizations.");
        const input = plainObject(await readJsonRequest(request, 16 * 1024));
        exact(input, ["name", "slug"]);
        const name = boundedString(input.name, "name", 1, 100);
        const slug = normalizeSlug(input.slug === undefined ? name : boundedString(input.slug, "slug", 1, 50));
        const organization = await createOrganization(
          storage.internal,
          principal.userId,
          name,
          slug,
          quotaDefaults,
        );
        audit(storage.internal, principal.userId, principal.tokenId, null, "organization.create", {
          organizationId: organization.id,
          name,
          slug,
        });
        return api({ ok: true, organization }, 201);
      }
      if (url.pathname === "/api/invitations/accept" && request.method === "POST") {
        if (principal.projectId) throw new PlatformError(403, "TOKEN_SCOPE_DENIED", "Project tokens cannot accept invitations.");
        const input = plainObject(await readJsonRequest(request, 8 * 1024));
        exact(input, ["token"]);
        const token = boundedString(input.token, "token", 20, 300);
        const invitation = storage.internal.prepare(`SELECT * FROM clank_platform_invitations
          WHERE token_hash = ?`).get(syncHash(token));
        if (
          !invitation
          || invitation.accepted_at !== null
          || invitation.revoked_at !== null
          || Number(invitation.expires_at) <= Date.now()
          || String(invitation.email).toLowerCase() !== principal.email.toLowerCase()
        ) throw new PlatformError(400, "INVALID_INVITATION", "Invitation is invalid or expired.");
        const now = Date.now();
        storage.internal.transaction((changes) => {
          const accepted = storage.internal.prepare(`UPDATE clank_platform_invitations SET accepted_at = ?
            WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
            .run(now, invitation.id, now);
          if (Number(accepted.changes) !== 1) {
            throw new PlatformError(409, "INVITATION_USED", "Invitation was already handled.");
          }
          storage.internal.prepare(`INSERT INTO clank_platform_memberships
            (organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(organization_id, user_id) DO UPDATE SET
              role = CASE WHEN clank_platform_memberships.role = 'owner' THEN 'owner' ELSE excluded.role END,
              updated_at = excluded.updated_at`)
            .run(invitation.organization_id, principal.userId, invitation.role, now, now);
          changes.record("__platform", String(invitation.organization_id));
        });
        audit(storage.internal, principal.userId, principal.tokenId, null, "invitation.accept", {
          organizationId: String(invitation.organization_id),
          invitationId: String(invitation.id),
        });
        return api({ ok: true, organizationId: String(invitation.organization_id), role: String(invitation.role) });
      }
      const organizationMatch = /^\/api\/organizations\/([A-Za-z0-9_-]{8,128})(?:\/(.*))?$/.exec(url.pathname);
      if (organizationMatch) {
        if (principal.projectId) throw new PlatformError(403, "TOKEN_SCOPE_DENIED", "Project tokens cannot administer organizations.");
        const organizationId = organizationMatch[1]!;
        const membership = organizationMembership(storage.internal, organizationId, principal.userId);
        const operation = organizationMatch[2] ?? "";
        if (!operation && request.method === "GET") {
          const members = storage.internal.prepare(`SELECT u.id, u.email, m.role, m.created_at, m.updated_at
            FROM clank_platform_memberships m JOIN clank_auth_users u ON u.id = m.user_id
            WHERE m.organization_id = ? ORDER BY m.created_at`).all(organizationId);
          const canManageMembers = membership.role === "owner" || membership.role === "admin";
          const ownerCount = members.filter((row) => row.role === "owner").length;
          const invitations = canManageMembers
            ? storage.internal.prepare(`SELECT i.id, i.email, i.role, i.expires_at, i.created_at,
                u.id AS invited_by_id, u.email AS invited_by_email
              FROM clank_platform_invitations i
              JOIN clank_auth_users u ON u.id = i.invited_by
              WHERE i.organization_id = ? AND i.accepted_at IS NULL
                AND i.revoked_at IS NULL AND i.expires_at > ?
              ORDER BY i.created_at DESC`).all(organizationId, Date.now())
            : [];
          return api({
            ok: true,
            organization: {
              id: organizationId,
              name: membership.name,
              slug: membership.slug,
              role: membership.role,
              access: {
                canManageMembers,
                canGrantOwner: membership.role === "owner",
                canLeave: membership.role !== "owner" || ownerCount > 1,
              },
            },
            members: members.map((row) => ({
              id: String(row.id),
              email: String(row.email),
              role: String(row.role),
              createdAt: Number(row.created_at),
              updatedAt: Number(row.updated_at),
            })),
            invitations: invitations.map((row) => ({
              id: String(row.id),
              email: String(row.email),
              role: String(row.role),
              invitedBy: {
                id: String(row.invited_by_id),
                email: String(row.invited_by_email),
              },
              expiresAt: Number(row.expires_at),
              createdAt: Number(row.created_at),
            })),
            limits: {
              pendingInvitations: MAX_PENDING_INVITATIONS_PER_ORGANIZATION,
            },
          });
        }
        if (operation === "invitations" && request.method === "POST") {
          requireOrganizationAdministration(membership.role);
          const input = plainObject(await readJsonRequest(request, 16 * 1024));
          exact(input, ["email", "role", "expiresIn"]);
          const email = normalizeEmail(input.email);
          const role = validateOrganizationRole(String(input.role ?? "developer"), false);
          const expiresIn = input.expiresIn === undefined
            ? 7 * 24 * 60 * 60
            : integerInRange(input.expiresIn, "expiresIn", 300, 30 * 24 * 60 * 60);
          const token = `clnki_${await randomToken(32)}`;
          const id = await randomId(18);
          const expiresAt = Date.now() + expiresIn * 1_000;
          const now = Date.now();
          let replacedInvitationId: string | null = null;
          storage.internal.transaction((changes) => {
            const existingMember = storage.internal.prepare(`SELECT 1 AS present
              FROM clank_platform_memberships m
              JOIN clank_auth_users u ON u.id = m.user_id
              WHERE m.organization_id = ? AND u.email = ?`).get(organizationId, email);
            if (existingMember) {
              throw new PlatformError(409, "ALREADY_MEMBER", "That account is already a workspace member.");
            }
            const existingInvitation = storage.internal.prepare(`SELECT id
              FROM clank_platform_invitations
              WHERE organization_id = ? AND email = ? AND accepted_at IS NULL
                AND revoked_at IS NULL AND expires_at > ?
              ORDER BY created_at DESC LIMIT 1`).get(organizationId, email, now);
            replacedInvitationId = existingInvitation ? String(existingInvitation.id) : null;
            const pendingCount = Number(storage.internal.prepare(`SELECT count(*) AS count
              FROM clank_platform_invitations
              WHERE organization_id = ? AND accepted_at IS NULL
                AND revoked_at IS NULL AND expires_at > ?`).get(organizationId, now)?.count ?? 0);
            if (!replacedInvitationId && pendingCount >= MAX_PENDING_INVITATIONS_PER_ORGANIZATION) {
              throw new PlatformError(
                409,
                "INVITATION_LIMIT_REACHED",
                `This workspace has reached its ${MAX_PENDING_INVITATIONS_PER_ORGANIZATION}-invitation limit.`,
              );
            }
            storage.internal.prepare(`UPDATE clank_platform_invitations SET revoked_at = ?
              WHERE organization_id = ? AND email = ? AND accepted_at IS NULL
                AND revoked_at IS NULL AND expires_at > ?`).run(now, organizationId, email, now);
            storage.internal.prepare(`INSERT INTO clank_platform_invitations
              (id, token_hash, organization_id, email, role, invited_by, expires_at, accepted_at, revoked_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
              .run(id, syncHash(token), organizationId, email, role, principal.userId, expiresAt, now);
            changes.record("__platform", organizationId);
          });
          audit(storage.internal, principal.userId, principal.tokenId, null, "invitation.create", {
            organizationId,
            invitationId: id,
            email,
            role,
            replacedInvitationId,
          });
          return api({ ok: true, invitation: { id, token, email, role, expiresAt } }, 201);
        }
        const invitationMatch = /^invitations\/([A-Za-z0-9_-]{8,128})$/.exec(operation);
        if (invitationMatch && request.method === "DELETE") {
          requireOrganizationAdministration(membership.role);
          const invitationId = invitationMatch[1]!;
          const now = Date.now();
          storage.internal.transaction((changes) => {
            const result = storage.internal.prepare(`UPDATE clank_platform_invitations SET revoked_at = ?
              WHERE id = ? AND organization_id = ? AND accepted_at IS NULL
                AND revoked_at IS NULL AND expires_at > ?`).run(now, invitationId, organizationId, now);
            if (Number(result.changes) !== 1) {
              throw new PlatformError(404, "INVITATION_NOT_FOUND", "Active workspace invitation not found.");
            }
            changes.record("__platform", organizationId);
          });
          audit(storage.internal, principal.userId, principal.tokenId, null, "invitation.revoke", {
            organizationId,
            invitationId,
          });
          return api({ ok: true, invitationId, revoked: true });
        }
        const memberMatch = /^members\/([A-Za-z0-9_-]{8,128})$/.exec(operation);
        if (memberMatch && (request.method === "PATCH" || request.method === "DELETE")) {
          const memberId = memberMatch[1]!;
          const selfRemoval = request.method === "DELETE" && memberId === principal.userId;
          if (!selfRemoval) requireOrganizationAdministration(membership.role);
          const target = storage.internal.prepare(`SELECT role FROM clank_platform_memberships
            WHERE organization_id = ? AND user_id = ?`).get(organizationId, memberId);
          if (!target) throw new PlatformError(404, "MEMBER_NOT_FOUND", "Organization member not found.");
          const targetRole = validateOrganizationRole(String(target.role), true);
          if (targetRole === "owner" && membership.role !== "owner") {
            throw new PlatformError(403, "ROLE_DENIED", "Only an owner can change another owner.");
          }
          let nextRole: OrganizationRole | null = null;
          if (request.method === "PATCH") {
            const input = plainObject(await readJsonRequest(request, 8 * 1024));
            exact(input, ["role"]);
            nextRole = validateOrganizationRole(String(input.role), true);
            if (nextRole === "owner" && membership.role !== "owner") {
              throw new PlatformError(403, "ROLE_DENIED", "Only an owner can grant the owner role.");
            }
          }
          if (targetRole === "owner" && nextRole !== "owner") {
            const owners = Number(storage.internal.prepare(`SELECT count(*) AS count FROM clank_platform_memberships
              WHERE organization_id = ? AND role = 'owner'`).get(organizationId)?.count ?? 0);
            if (owners <= 1) throw new PlatformError(409, "LAST_OWNER", "An organization must retain at least one owner.");
          }
          const now = Date.now();
          storage.internal.transaction((changes) => {
            if (request.method === "DELETE") {
              storage.internal.prepare("DELETE FROM clank_platform_memberships WHERE organization_id = ? AND user_id = ?")
                .run(organizationId, memberId);
              storage.internal.prepare(`UPDATE clank_platform_tokens SET revoked_at = ?
                WHERE user_id = ? AND revoked_at IS NULL
                  AND (organization_id = ? OR project_id IN (
                    SELECT id FROM clank_platform_projects WHERE organization_id = ?
                  ))`).run(now, memberId, organizationId, organizationId);
            } else {
              storage.internal.prepare(`UPDATE clank_platform_memberships SET role = ?, updated_at = ?
                WHERE organization_id = ? AND user_id = ?`).run(nextRole, now, organizationId, memberId);
            }
            changes.record("__platform", organizationId);
          });
          audit(storage.internal, principal.userId, principal.tokenId, null, request.method === "DELETE"
            ? "member.remove"
            : "member.role", { organizationId, memberId, role: nextRole });
          return api({ ok: true, memberId, ...(nextRole ? { role: nextRole } : { removed: true }) });
        }
        throw new PlatformError(404, "NOT_FOUND", "Organization endpoint not found.");
      }
      if (url.pathname === "/api/projects" && request.method === "GET") {
        if (principal.projectId && !principal.permissions.includes("read")) {
          throw new PlatformError(403, "TOKEN_SCOPE_DENIED", "This token cannot read project metadata.");
        }
        const rows = principal.projectId
          ? storage.internal.prepare(`SELECT p.* FROM clank_platform_projects p
              JOIN clank_platform_memberships m ON m.organization_id = p.organization_id
              WHERE p.id = ? AND m.user_id = ?`).all(principal.projectId, principal.userId)
          : storage.internal.prepare(`SELECT DISTINCT p.* FROM clank_platform_projects p
              LEFT JOIN clank_platform_memberships m
                ON m.organization_id = p.organization_id AND m.user_id = ?
              WHERE m.user_id IS NOT NULL OR p.owner_id = ? ORDER BY p.created_at`)
              .all(principal.userId, principal.userId);
        const usageRows = storage.internal.prepare(`SELECT organization_id, count(*) AS count
          FROM clank_platform_projects WHERE organization_id IN (
            SELECT organization_id FROM clank_platform_memberships WHERE user_id = ?
          ) GROUP BY organization_id`).all(principal.userId);
        return api({
          ok: true,
          projects: rows.map((row) => projectPayload(projectRow(row))),
          limits: publicLimits(
            accountQuotas(storage.internal, principal.userId, quotaDefaults),
            options.maxArtifactBytes,
            limits.metricRetentionDays,
          ),
          usage: Object.fromEntries(usageRows.map((row) => [String(row.organization_id), Number(row.count)])),
        });
      }
      if (url.pathname === "/api/projects" && request.method === "POST") {
        if (principal.projectId) throw new PlatformError(403, "TOKEN_SCOPE_DENIED", "Project tokens cannot create projects.");
        const input = plainObject(await readJsonRequest(request, 16 * 1024));
        exact(input, ["name", "slug", "organizationId"]);
        const name = boundedString(input.name, "name", 1, 100);
        const slug = normalizeSlug(input.slug === undefined ? name : boundedString(input.slug, "slug", 1, 50));
        const organizationId = input.organizationId === undefined
          ? await ensurePersonalOrganization(storage.internal, principal, quotaDefaults)
          : boundedString(input.organizationId, "organizationId", 8, 128);
        const membership = organizationMembership(storage.internal, organizationId, principal.userId);
        requireOrganizationAdministration(membership.role);
        const id = await randomId(18);
        let port = 0;
        const now = Date.now();
        try {
          storage.internal.transaction((changes) => {
            const accountLimits = accountQuotas(storage.internal, principal.userId, quotaDefaults);
            const organizationLimits = workspaceQuotas(storage.internal, organizationId, quotaDefaults);
            const accountCount = Number(storage.internal.prepare(
              "SELECT count(*) AS count FROM clank_platform_projects WHERE owner_id = ?",
            ).get(principal.userId)?.count ?? 0);
            if (accountCount >= accountLimits.projectsPerAccount) {
              throw new PlatformError(
                409,
                "ACCOUNT_PROJECT_LIMIT_REACHED",
                `This account has reached its ${accountLimits.projectsPerAccount}-site limit.`,
              );
            }
            const count = Number(storage.internal.prepare(
              "SELECT count(*) AS count FROM clank_platform_projects WHERE organization_id = ?",
            ).get(organizationId)?.count ?? 0);
            if (count >= organizationLimits.projectsPerOrganization) {
              throw new PlatformError(
                409,
                "PROJECT_LIMIT_REACHED",
                `This organization has reached its ${organizationLimits.projectsPerOrganization}-site limit.`,
              );
            }
            port = allocatePort(storage.internal, appPortStart, appPortEnd, reservedAppPorts);
            storage.internal.prepare(`INSERT INTO clank_platform_projects
              (id, owner_id, organization_id, name, slug, port, active_release_id, database_path, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`)
              .run(id, principal.userId, organizationId, name, slug, port, now, now);
            changes.record("__platform", organizationId);
          });
        } catch (error) {
          if (error instanceof PlatformError) throw error;
          if (safeError(error).toLowerCase().includes("unique")) {
            throw new PlatformError(409, "SLUG_UNAVAILABLE", "That project slug is unavailable.");
          }
          throw error;
        }
        const project = projectById(storage.internal, id)!;
        audit(storage.internal, principal.userId, principal.tokenId, id, "project.create", {
          name,
          slug,
          port,
          organizationId,
        });
        return api({ ok: true, project: projectPayload(project) }, 201);
      }

      const matched = /^\/api\/projects\/([A-Za-z0-9_-]{8,128})(?:\/(.*))?$/.exec(url.pathname);
      if (!matched) throw new PlatformError(404, "NOT_FOUND", "Platform endpoint not found.");
      const operation = matched[2] ?? "";
      const requiredPermission: ProjectPermission = !operation && request.method === "DELETE"
        ? "tokens"
        : operation.startsWith("releases/")
        && request.method === "DELETE"
        ? "rollback"
        : operation === "releases" && request.method === "POST"
          ? "deploy"
        : operation === "rollback"
          ? "rollback"
          : operation.startsWith("backups") && request.method !== "GET"
            ? "rollback"
          : operation.startsWith("domains") && request.method !== "GET"
            ? "tokens"
          : operation === "secrets" || operation.startsWith("secrets/")
            ? "secrets"
            : operation === "tokens"
              ? "tokens"
              : operation === "audit"
                ? "audit"
                : "read";
      const access = accessibleProject(storage.internal, matched[1]!, principal, requiredPermission);
      const project = access.project;
      if (!operation && request.method === "DELETE") {
        const input = plainObject(await readJsonRequest(request, 8 * 1024));
        exact(input, ["confirmation", "acknowledgeDataLoss"]);
        const confirmation = boundedString(input.confirmation, "confirmation", 1, 300);
        return api({
          ok: true,
          project: await deleteProject(
            principal,
            project.id,
            confirmation,
            input.acknowledgeDataLoss === true,
          ),
        });
      }
      if (!operation && request.method === "GET") {
        const effective = projectQuotas(storage.internal, project, quotaDefaults);
        const release = project.activeReleaseId ? releaseById(storage.internal, project.activeReleaseId) : null;
        const domainCount = Number(storage.internal.prepare(
          "SELECT count(*) AS count FROM clank_platform_domains WHERE project_id = ?",
        ).get(project.id)?.count ?? 0);
        const releaseUsage = releaseStorageUsage(storage.internal, project.id);
        return api({
          ok: true,
          project: {
            ...projectPayload(project),
            url: appUrlTemplate.replaceAll("{slug}", project.slug)
              .replaceAll("{port}", String(active.get(project.id)?.port ?? project.port)),
            directUrl: `http://127.0.0.1:${active.get(project.id)?.port ?? project.port}`,
            runtimeStatus: active.has(project.id) ? "online" : release ? "degraded" : "not_deployed",
          },
          activeRelease: release ? publicRelease(release) : null,
          access: {
            role: access.role,
            canDelete: principal.projectId === null && (access.role === "owner" || access.role === "admin"),
          },
          limits: publicLimits(effective, options.maxArtifactBytes, limits.metricRetentionDays),
          usage: { domains: domainCount, ...releaseUsage },
        });
      }
      if (operation === "releases" && request.method === "GET") {
        const effective = projectQuotas(storage.internal, project, quotaDefaults);
        const availableRows = storage.internal.prepare(
          `SELECT * FROM clank_platform_releases
            WHERE project_id = ? AND artifact_available = 1
            ORDER BY created_at DESC LIMIT 100`,
        ).all(project.id);
        const recentRows = storage.internal.prepare(
          "SELECT * FROM clank_platform_releases WHERE project_id = ? ORDER BY created_at DESC LIMIT 100",
        ).all(project.id);
        const rows = [...new Map(
          [...availableRows, ...recentRows].map((row) => [String(row.id), row]),
        ).values()].sort((left, right) => Number(right.created_at) - Number(left.created_at));
        const activeRelease = project.activeReleaseId
          ? releaseById(storage.internal, project.activeReleaseId)
          : null;
        return api({
          ok: true,
          releases: rows.map((row) => {
            const release = releaseRow(row);
            return {
              ...publicRelease(release),
              cleanup: {
                allowed: release.artifactAvailable && release.id !== project.activeReleaseId,
                rollbackProtected: release.id === activeRelease?.previousReleaseId,
              },
            };
          }),
          usage: releaseStorageUsage(storage.internal, project.id),
          limits: {
            releases: effective.releasesPerProject,
            storageBytes: effective.releaseStorageBytesPerProject,
          },
        });
      }
      const releaseCleanupMatch = /^releases\/([A-Za-z0-9_-]{8,128})$/.exec(operation);
      if (releaseCleanupMatch && request.method === "DELETE") {
        const input = plainObject(await readJsonRequest(request, 8 * 1024));
        exact(input, ["confirmation", "allowRollbackLoss"]);
        const confirmation = boundedString(input.confirmation, "confirmation", 1, 300);
        const allowRollbackLoss = input.allowRollbackLoss === true;
        return api({
          ok: true,
          release: await cleanupRelease(
            principal,
            project,
            releaseCleanupMatch[1]!,
            confirmation,
            allowRollbackLoss,
          ),
        });
      }
      if (operation === "releases" && request.method === "POST") {
        const effective = projectQuotas(storage.internal, project, quotaDefaults);
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
        const existingRelease = storage.internal.prepare(
          "SELECT 1 AS present FROM clank_platform_releases WHERE project_id = ? AND idempotency_key = ?",
        ).get(project.id, idempotencyKey);
        if (!existingRelease
          && releaseStorageUsage(storage.internal, project.id).releases >= effective.releasesPerProject) {
          throw new PlatformError(
            409,
            "RELEASE_LIMIT_REACHED",
            `This site has reached its ${effective.releasesPerProject}-release artifact limit. Remove an inactive release before deploying again.`,
          );
        }
        const max = options.maxArtifactBytes ?? 100 * 1024 * 1024;
        let bytes: Uint8Array;
        try { bytes = await readRequestBytes(request, max); }
        catch (error) {
          if (error instanceof RequestInputError && error.status === 413) {
            throw new PlatformError(413, "ARTIFACT_TOO_LARGE", `Artifact exceeds ${max} bytes.`);
          }
          throw error;
        }
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
      if (operation === "backups" && request.method === "GET") {
        const effective = projectQuotas(storage.internal, project, quotaDefaults);
        const automation = {
          ...backupScheduler.status(project.id, Boolean(project.databasePath)),
          maxBackups: effective.backupsPerProject,
          storage: backupObjects ? "object" : "local",
        };
        if (!project.databasePath) return api({ ok: true, backups: [], automation });
        const manager = await projectBackupManager(paths.projects, project, masterKey, {
          ...backupPolicy,
          maxBackups: effective.backupsPerProject,
        }, backupObjects);
        try {
          return api({
            ok: true,
            backups: (await manager.list()).map(publicBackupManifest),
            automation,
          });
        } finally {
          manager.close();
        }
      }
      if (operation === "backups" && request.method === "POST") {
        const input = plainObject(await readJsonRequest(request, 8 * 1024));
        exact(input, ["reason"]);
        const reason = input.reason === undefined
          ? "manual"
          : boundedString(input.reason, "reason", 1, 200);
        const backup = await withProjectLock(project.id, async () => {
          const current = projectById(storage.internal, project.id);
          if (!current) throw new PlatformError(404, "PROJECT_NOT_FOUND", "Project not found.");
          const effective = projectQuotas(storage.internal, current, quotaDefaults);
          const manager = await projectBackupManager(paths.projects, current, masterKey, {
            ...backupPolicy,
            maxBackups: effective.backupsPerProject,
          }, backupObjects);
          try {
            return await manager.create({ reason });
          } finally {
            manager.close();
          }
        });
        backupScheduler.recordBackup(project.id, backup);
        audit(storage.internal, principal.userId, principal.tokenId, project.id, "backup.create", {
          backupId: backup.id,
          reason,
          databaseSha256: backup.databaseSha256,
        });
        return api({ ok: true, backup: publicBackupManifest(backup) }, 201);
      }
      const backupMatch = /^backups\/(bk_[A-Za-z0-9_-]{16,128})\/(verify|restore)$/.exec(operation);
      if (backupMatch && request.method === "POST") {
        const effective = projectQuotas(storage.internal, project, quotaDefaults);
        const manager = await projectBackupManager(paths.projects, project, masterKey, {
          ...backupPolicy,
          maxBackups: effective.backupsPerProject,
        }, backupObjects);
        try {
          if (backupMatch[2] === "verify") {
            const verification = await manager.verify(backupMatch[1]!);
            audit(storage.internal, principal.userId, principal.tokenId, project.id, "backup.verify", {
              backupId: backupMatch[1],
              durationMs: verification.durationMs,
            });
            return api({ ok: true, verification });
          }
          const input = plainObject(await readJsonRequest(request, 8 * 1024));
          exact(input, ["confirmation"]);
          const confirmation = boundedString(input.confirmation, "confirmation", 1, 300);
          const expectedConfirmation = `restore-backup ${project.slug} ${backupMatch[1]}`;
          if (confirmation !== expectedConfirmation) {
            throw new PlatformError(400, "CONFIRMATION_REQUIRED", `Pass confirmation "${expectedConfirmation}".`);
          }
          return await withProjectLock(project.id, async () => {
            cancelRestart(project.id);
            const activeRelease = project.activeReleaseId ? releaseById(storage.internal, project.activeReleaseId) : null;
            const safety = await manager.create({
              reason: `automatic safety copy before restoring ${backupMatch[1]}`,
              protectedBackupIds: [backupMatch[1]!],
            });
            await stopProject(project.id);
            try {
              const verification = await manager.restore(backupMatch[1]!, {
                confirmation: `restore ${backupMatch[1]}`,
              });
              if (activeRelease) {
                await startRelease(project, activeRelease, decryptProjectSecrets(storage.internal, project.id, masterKey));
              }
              audit(storage.internal, principal.userId, principal.tokenId, project.id, "backup.restore", {
                backupId: backupMatch[1],
                safetyBackupId: safety.id,
              });
              return api({ ok: true, verification, safetyBackupId: safety.id });
            } catch (error) {
              try {
                await manager.restore(safety.id, { confirmation: `restore ${safety.id}` });
                if (activeRelease) {
                  await startRelease(project, activeRelease, decryptProjectSecrets(storage.internal, project.id, masterKey));
                }
              } catch (recoveryError) {
                options.onError?.(recoveryError);
              }
              throw new PlatformError(422, "BACKUP_RESTORE_FAILED", safeError(error));
            }
          });
        } finally {
          manager.close();
        }
      }
      if (operation === "tokens" && request.method === "POST") {
        const input = plainObject(await readJsonRequest(request, 16 * 1024));
        exact(input, ["name", "permissions", "expiresIn"]);
        const name = boundedString(input.name ?? "Project automation", "name", 1, 100);
        const permissions = inputProjectPermissions(input.permissions);
        for (const permission of permissions) {
          if (!roleAllows(access.role, permission)) {
            throw new PlatformError(403, "ROLE_DENIED", `Your role cannot grant ${permission} permission.`);
          }
        }
        const expiresIn = input.expiresIn === undefined
          ? 30 * 24 * 60 * 60
          : integerInRange(input.expiresIn, "expiresIn", 300, 365 * 24 * 60 * 60);
        const rawToken = `${TOKEN_PREFIX}${await randomToken(32)}`;
        const tokenId = await randomId(18);
        const expiresAt = Date.now() + expiresIn * 1_000;
        storage.internal.prepare(`INSERT INTO clank_platform_tokens
          (id, token_hash, user_id, name, created_at, last_used_at, expires_at, revoked_at,
           organization_id, project_id, permissions)
          VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`)
          .run(
            tokenId,
            syncHash(rawToken),
            principal.userId,
            name,
            Date.now(),
            expiresAt,
            project.organizationId,
            project.id,
            JSON.stringify(permissions),
          );
        audit(storage.internal, principal.userId, principal.tokenId, project.id, "project-token.create", {
          tokenId,
          name,
          permissions,
          expiresAt,
        });
        return api({
          ok: true,
          token: {
            id: tokenId,
            accessToken: rawToken,
            projectId: project.id,
            organizationId: project.organizationId,
            permissions,
            expiresAt,
          },
        }, 201);
      }
      if (operation === "domains" && request.method === "GET") {
        const effective = projectQuotas(storage.internal, project, quotaDefaults);
        const rows = storage.internal.prepare(`SELECT *
          FROM clank_platform_domains WHERE project_id = ? ORDER BY created_at`).all(project.id);
        return api({
          ok: true,
          domains: rows.map((row) => publicDomain(row, customDomainTarget, customDomainAddresses)),
          limit: effective.domainsPerProject,
          automation: {
            ...domainReconciliation,
            pending: Number(storage.internal.prepare(`SELECT count(*) AS count
              FROM clank_platform_domains
              WHERE (status = 'verified' OR expires_at > ?)
                AND coalesce(next_check_at, 0) <= ?`).get(Date.now(), Date.now())?.count ?? 0),
          },
        });
      }
      if (operation === "domains" && request.method === "POST") {
        if (!ingress) throw new PlatformError(409, "INGRESS_DISABLED", "Managed ingress is not enabled.");
        if (!customDomainRoutingConfigured) {
          throw new PlatformError(503, "DOMAIN_ROUTING_UNCONFIGURED", "The operator has not configured a custom-domain target.");
        }
        const input = plainObject(await readJsonRequest(request, 8 * 1024));
        exact(input, ["hostname"]);
        const inputHostname = boundedString(input.hostname, "hostname", 1, 253);
        let hostname: string;
        try { hostname = normalizeHostname(inputHostname); }
        catch { throw new PlatformError(422, "INVALID_DOMAIN", "hostname must be a valid DNS hostname."); }
        if (
          hostname === publicHostname
          || hostname === customDomainTarget
          || hostname === baseDomain
          || (baseDomain && hostname.endsWith(`.${baseDomain}`))
        ) {
          throw new PlatformError(409, "DOMAIN_RESERVED", "That hostname belongs to the Clank platform namespace.");
        }
        const assigned = await domainStore.byHostname(hostname);
        if (assigned && assigned.projectId !== project.id) {
          throw new PlatformError(409, "DOMAIN_UNAVAILABLE", "That hostname is already assigned to another site.");
        }
        const challenge = await domains.begin(project.id, hostname);
        try {
          const report = await inspectRouting(challenge.hostname);
          saveDomainRouting(storage.internal, challenge.id, report, {
            nextCheckAt: nextDomainCheckAt(),
          });
        } catch (error) {
          if (error instanceof PlatformError) throw error;
          saveDomainRoutingError(storage.internal, challenge.id, {
            nextCheckAt: nextDomainCheckAt(),
          });
        }
        audit(storage.internal, principal.userId, principal.tokenId, project.id, "domain.begin", {
          domainId: challenge.id,
          hostname: challenge.hostname,
        });
        const row = storage.internal.prepare("SELECT * FROM clank_platform_domains WHERE id = ?").get(challenge.id)!;
        return api({ ok: true, domain: publicDomain(row, customDomainTarget, customDomainAddresses) }, 201);
      }
      const domainMatch = /^domains\/(dom_[A-Za-z0-9_-]{12,128})(?:\/(verify|check))?$/.exec(operation);
      if (domainMatch && domainMatch[2] && request.method === "POST") {
        if (!ingress) throw new PlatformError(409, "INGRESS_DISABLED", "Managed ingress is not enabled.");
        const current = await domainStore.get(domainMatch[1]!);
        if (!current || current.projectId !== project.id) {
          throw new PlatformError(404, "DOMAIN_NOT_FOUND", "Domain not found.");
        }
        let challenge = current;
        if (domainMatch[2] === "verify") {
          try {
            challenge = await domains.verify(current.id);
          } catch (error) {
            if (error instanceof DomainVerificationError) {
              throw new PlatformError(422, "DOMAIN_OWNERSHIP_PENDING", error.message);
            }
            throw error;
          }
        }
        let routingStatus = "error";
        try {
          const report = await inspectRouting(challenge.hostname);
          routingStatus = report.status;
          saveDomainRouting(storage.internal, challenge.id, report, {
            nextCheckAt: nextDomainCheckAt(),
          });
        } catch (error) {
          saveDomainRoutingError(storage.internal, challenge.id, {
            nextCheckAt: nextDomainCheckAt(),
          });
          try { options.onError?.(error); } catch { /* Operator reporting must not change the API result. */ }
        }
        audit(storage.internal, principal.userId, principal.tokenId, project.id, `domain.${domainMatch[2]}`, {
          domainId: challenge.id,
          hostname: challenge.hostname,
          routingStatus,
        });
        const row = storage.internal.prepare("SELECT * FROM clank_platform_domains WHERE id = ?").get(challenge.id)!;
        return api({ ok: true, domain: publicDomain(row, customDomainTarget, customDomainAddresses) });
      }
      if (domainMatch && !domainMatch[2] && request.method === "DELETE") {
        const result = storage.internal.prepare("DELETE FROM clank_platform_domains WHERE id = ? AND project_id = ?")
          .run(domainMatch[1], project.id);
        if (Number(result.changes) !== 1) throw new PlatformError(404, "DOMAIN_NOT_FOUND", "Domain not found.");
        audit(storage.internal, principal.userId, principal.tokenId, project.id, "domain.delete", {
          domainId: domainMatch[1],
        });
        return api({ ok: true });
      }
      if (operation === "metrics" && request.method === "GET") {
        return api({ ok: true, ...metricSeries(storage.internal, project.id, url.searchParams.get("range") ?? "24h") });
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
      if (error instanceof AuthError) return problem(error.status, error.code, error.message, error.retryAfter);
      options.onError?.(error);
      return problem(500, "PLATFORM_ERROR", "The platform operation failed.");
    }
  };

  const handle = async (request: Request): Promise<Response> => {
    const response = await handleRequest(request);
    const requestUrl = new URL(request.url);
    if (!securePublicUrl || normalizeHostname(requestUrl.hostname) !== publicHostname) return response;
    const headers = new Headers(response.headers);
    headers.set("strict-transport-security", "max-age=31536000");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  const projects = storage.internal.prepare(
    "SELECT * FROM clank_platform_projects WHERE active_release_id IS NOT NULL",
  ).all().map(projectRow);
  const startupRecovery = Promise.all(projects.map(async (project) => {
    const release = project.activeReleaseId ? releaseById(storage.internal, project.activeReleaseId) : null;
    if (!release) return;
    try {
      await startRelease(project, release, decryptProjectSecrets(storage.internal, project.id, masterKey));
    } catch (error) {
      if (closed) return;
      options.onError?.(error);
      storage.internal.prepare("UPDATE clank_platform_releases SET status = 'crashed', failure = ? WHERE id = ?")
        .run(`Startup recovery failed: ${safeError(error)}`, release.id);
    }
  }));
  if (options.startupRecovery !== "background") await startupRecovery;
  else void startupRecovery.catch((error) => options.onError?.(error));
  scheduleDomainReconciliation();
  backupScheduler.start();

  return {
    handle,
    publicUrl,
    dataDirectory: paths.root,
    hostingProfile,
    runnerKind: runner.kind ?? "process",
    async close() {
      if (closed) return;
      closed = true;
      if (domainRecheckTimer) clearTimeout(domainRecheckTimer);
      domainRecheckTimer = undefined;
      await domainRecheckFlight?.catch(() => undefined);
      await backupScheduler.close();
      for (const state of restartState.values()) {
        state.cancelled = true;
        if (state.timer) clearTimeout(state.timer);
      }
      restartState.clear();
      await Promise.all([...starting].map(stopRunning));
      await startupRecovery.catch(() => undefined);
      await Promise.all([...active.keys()].map(stopProject));
      storage.auth.close();
      orchestrator.close();
      storage.database.close();
    },
  };
}

async function openPlatformDatabase(path: string, masterKey: Uint8Array): Promise<PlatformDatabase> {
  const schema = defineDatabase({});
  const database = await openSQLite(schema, { path });
  const internal = database[SQLITE_INTERNAL];
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_rate_limits (
    key_hash TEXT PRIMARY KEY,
    attempts TEXT NOT NULL CHECK (json_valid(attempts) AND json_type(attempts) = 'array'),
    expires_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_platform_rate_limits_expiry
    ON clank_platform_rate_limits (expires_at)`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_storage_bindings (
    purpose TEXT PRIMARY KEY CHECK (purpose IN ('backups')),
    namespace TEXT NOT NULL,
    object_root TEXT NOT NULL DEFAULT 'backups',
    created_at INTEGER NOT NULL
  )`);
  const storageBindingColumns = internal.prepare(
    "PRAGMA table_info(clank_platform_storage_bindings)",
  ).all();
  if (!storageBindingColumns.some((column) => column.name === "object_root")) {
    internal.exec(
      "ALTER TABLE clank_platform_storage_bindings ADD COLUMN object_root TEXT NOT NULL DEFAULT 'backups'",
    );
  }
  const rateLimits = createPlatformRateLimitStore(internal, masterKey);
  // The platform gates public, bootstrap, and invitation-assisted registration
  // before delegating to auth. Keeping the internal primitive enabled lets a
  // valid invitation authorize one account even when public signup is closed.
  const authDefinition = defineAuth({
    signup: true,
    rateLimit: { store: rateLimits },
  });
  const auth = await openAuth(authDefinition, database);
  for (const table of [
    "tokens",
    "device_codes",
    "organizations",
    "memberships",
    "invitations",
    "domains",
    "metrics",
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
    revoked_at INTEGER,
    organization_id TEXT,
    project_id TEXT,
    permissions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(permissions))
  )`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_bootstrap_claim (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    claim_id TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
  )`);
  const tokenColumns = internal.prepare("PRAGMA table_info(clank_platform_tokens)").all();
  if (!tokenColumns.some((column) => column.name === "organization_id")) {
    internal.exec("ALTER TABLE clank_platform_tokens ADD COLUMN organization_id TEXT");
  }
  if (!tokenColumns.some((column) => column.name === "project_id")) {
    internal.exec("ALTER TABLE clank_platform_tokens ADD COLUMN project_id TEXT");
  }
  if (!tokenColumns.some((column) => column.name === "permissions")) {
    internal.exec("ALTER TABLE clank_platform_tokens ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'");
  }
  internal.exec("DROP INDEX IF EXISTS proact_platform_tokens_user");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_platform_tokens_user ON clank_platform_tokens (user_id)");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_impersonations (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    actor_user_id TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    actor_session_id TEXT NOT NULL REFERENCES clank_auth_sessions(id) ON DELETE CASCADE,
    target_user_id TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_platform_impersonations_actor
    ON clank_platform_impersonations (actor_user_id, actor_session_id, expires_at)`);
  internal.prepare(`DELETE FROM clank_platform_impersonations
    WHERE expires_at <= ? OR revoked_at IS NOT NULL`).run(Date.now());
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
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_quota_overrides (
    scope_type TEXT NOT NULL CHECK (scope_type IN ('account', 'workspace')),
    scope_id TEXT NOT NULL,
    quota_key TEXT NOT NULL CHECK (quota_key IN (
      'organizationsPerAccount',
      'projectsPerAccount',
      'projectsPerOrganization',
      'domainsPerProject',
      'releasesPerProject',
      'releaseStorageBytesPerProject',
      'backupsPerProject'
    )),
    quota_value INTEGER NOT NULL CHECK (quota_value > 0),
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope_type, scope_id, quota_key)
  )`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_platform_quota_overrides_scope
    ON clank_platform_quota_overrides (scope_type, scope_id)`);
  internal.exec(`CREATE TRIGGER IF NOT EXISTS clank_platform_quota_overrides_account_cleanup
    AFTER DELETE ON clank_auth_users
    BEGIN
      DELETE FROM clank_platform_quota_overrides
      WHERE scope_type = 'account' AND scope_id = old.id;
    END`);
  internal.exec(`CREATE TRIGGER IF NOT EXISTS clank_platform_quota_overrides_workspace_cleanup
    AFTER DELETE ON clank_platform_organizations
    BEGIN
      DELETE FROM clank_platform_quota_overrides
      WHERE scope_type = 'workspace' AND scope_id = old.id;
    END`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_memberships (
    organization_id TEXT NOT NULL REFERENCES clank_platform_organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (organization_id, user_id)
  )`);
  internal.exec("CREATE INDEX IF NOT EXISTS clank_platform_memberships_user ON clank_platform_memberships (user_id, organization_id)");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_invitations (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    organization_id TEXT NOT NULL REFERENCES clank_platform_organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'developer', 'viewer')),
    invited_by TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  internal.exec("CREATE INDEX IF NOT EXISTS clank_platform_invitations_org ON clank_platform_invitations (organization_id, created_at)");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_personal_invitations (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    invited_by TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_platform_personal_invitations_email
    ON clank_platform_personal_invitations (email, created_at)`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_projects (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES clank_auth_users(id) ON DELETE CASCADE,
    organization_id TEXT REFERENCES clank_platform_organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    port INTEGER NOT NULL UNIQUE,
    active_release_id TEXT,
    database_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const projectColumns = internal.prepare("PRAGMA table_info(clank_platform_projects)").all();
  if (!projectColumns.some((column) => column.name === "organization_id")) {
    internal.exec("ALTER TABLE clank_platform_projects ADD COLUMN organization_id TEXT");
  }
  internal.exec("CREATE INDEX IF NOT EXISTS clank_platform_projects_org ON clank_platform_projects (organization_id, created_at)");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_domains (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,
    hostname TEXT NOT NULL UNIQUE,
    record_name TEXT NOT NULL,
    record_value TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'verified')),
    routing_status TEXT NOT NULL DEFAULT 'pending' CHECK (routing_status IN ('pending', 'ready', 'misconfigured', 'error')),
    certificate_status TEXT NOT NULL DEFAULT 'pending' CHECK (certificate_status IN ('pending', 'eligible', 'active', 'error')),
    resolved_records TEXT NOT NULL DEFAULT '{"cnames":[],"addresses":[]}' CHECK (json_valid(resolved_records)),
    last_checked_at INTEGER,
    last_error TEXT,
    next_check_at INTEGER,
    check_lease_token TEXT,
    check_lease_until INTEGER,
    expires_at INTEGER NOT NULL,
    verified_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  const domainColumns = internal.prepare("PRAGMA table_info(clank_platform_domains)").all();
  const hasDomainColumn = (name: string) => domainColumns.some((column) => column.name === name);
  let upgradedRoutingStatus = false;
  if (!hasDomainColumn("routing_status")) {
    internal.exec("ALTER TABLE clank_platform_domains ADD COLUMN routing_status TEXT NOT NULL DEFAULT 'pending'");
    upgradedRoutingStatus = true;
  }
  if (!hasDomainColumn("certificate_status")) {
    internal.exec("ALTER TABLE clank_platform_domains ADD COLUMN certificate_status TEXT NOT NULL DEFAULT 'pending'");
  }
  if (!hasDomainColumn("resolved_records")) {
    internal.exec(`ALTER TABLE clank_platform_domains ADD COLUMN resolved_records TEXT NOT NULL DEFAULT '{"cnames":[],"addresses":[]}'`);
  }
  if (!hasDomainColumn("last_checked_at")) {
    internal.exec("ALTER TABLE clank_platform_domains ADD COLUMN last_checked_at INTEGER");
  }
  if (!hasDomainColumn("last_error")) {
    internal.exec("ALTER TABLE clank_platform_domains ADD COLUMN last_error TEXT");
  }
  if (!hasDomainColumn("next_check_at")) {
    internal.exec("ALTER TABLE clank_platform_domains ADD COLUMN next_check_at INTEGER");
    internal.prepare(`UPDATE clank_platform_domains
      SET next_check_at = coalesce(last_checked_at, created_at)
      WHERE status = 'verified' OR expires_at > ?`).run(Date.now());
  }
  if (!hasDomainColumn("check_lease_token")) {
    internal.exec("ALTER TABLE clank_platform_domains ADD COLUMN check_lease_token TEXT");
  }
  if (!hasDomainColumn("check_lease_until")) {
    internal.exec("ALTER TABLE clank_platform_domains ADD COLUMN check_lease_until INTEGER");
  }
  if (upgradedRoutingStatus) {
    internal.exec("UPDATE clank_platform_domains SET routing_status = 'ready', certificate_status = 'eligible' WHERE status = 'verified'");
  }
  internal.exec("CREATE INDEX IF NOT EXISTS clank_platform_domains_project ON clank_platform_domains (project_id, created_at)");
  internal.exec(`CREATE INDEX IF NOT EXISTS clank_platform_domains_recheck
    ON clank_platform_domains (next_check_at, check_lease_until)`);
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_metrics (
    project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,
    bucket_started_at INTEGER NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    status_2xx INTEGER NOT NULL DEFAULT 0,
    status_3xx INTEGER NOT NULL DEFAULT 0,
    status_4xx INTEGER NOT NULL DEFAULT 0,
    status_5xx INTEGER NOT NULL DEFAULT 0,
    duration_sum_ms REAL NOT NULL DEFAULT 0,
    duration_max_ms REAL NOT NULL DEFAULT 0,
    latency_le_50 INTEGER NOT NULL DEFAULT 0,
    latency_le_100 INTEGER NOT NULL DEFAULT 0,
    latency_le_250 INTEGER NOT NULL DEFAULT 0,
    latency_le_500 INTEGER NOT NULL DEFAULT 0,
    latency_le_1000 INTEGER NOT NULL DEFAULT 0,
    latency_le_2500 INTEGER NOT NULL DEFAULT 0,
    latency_le_5000 INTEGER NOT NULL DEFAULT 0,
    latency_inf INTEGER NOT NULL DEFAULT 0,
    request_bytes INTEGER NOT NULL DEFAULT 0,
    response_bytes INTEGER NOT NULL DEFAULT 0,
    method_get INTEGER NOT NULL DEFAULT 0,
    method_head INTEGER NOT NULL DEFAULT 0,
    method_post INTEGER NOT NULL DEFAULT 0,
    method_put INTEGER NOT NULL DEFAULT 0,
    method_patch INTEGER NOT NULL DEFAULT 0,
    method_delete INTEGER NOT NULL DEFAULT 0,
    method_options INTEGER NOT NULL DEFAULT 0,
    method_other INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, bucket_started_at)
  )`);
  const metricColumns = internal.prepare("PRAGMA table_info(clank_platform_metrics)").all();
  for (const column of METRIC_METHOD_COLUMNS) {
    if (!metricColumns.some((existing) => existing.name === column)) {
      internal.exec(`ALTER TABLE clank_platform_metrics ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
  }
  internal.exec("CREATE INDEX IF NOT EXISTS clank_platform_metrics_time ON clank_platform_metrics (bucket_started_at)");
  internal.exec(`CREATE TABLE IF NOT EXISTS clank_platform_releases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES clank_platform_projects(id) ON DELETE CASCADE,
    previous_release_id TEXT,
    status TEXT NOT NULL,
    digest TEXT NOT NULL,
    artifact_bytes INTEGER NOT NULL,
    runtime_bytes INTEGER NOT NULL DEFAULT 0,
    runner_artifact_bytes INTEGER NOT NULL DEFAULT 0,
    runner_artifact_store TEXT NOT NULL DEFAULT 'local',
    runner_artifact_key TEXT,
    snapshot_bytes INTEGER NOT NULL DEFAULT 0,
    storage_bytes INTEGER NOT NULL DEFAULT 0,
    artifact_available INTEGER NOT NULL DEFAULT 1,
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
  const releaseColumns = internal.prepare("PRAGMA table_info(clank_platform_releases)").all();
  if (!releaseColumns.some((column) => column.name === "artifact_available")) {
    internal.exec("ALTER TABLE clank_platform_releases ADD COLUMN artifact_available INTEGER NOT NULL DEFAULT 1");
  }
  if (!releaseColumns.some((column) => column.name === "storage_bytes")) {
    internal.exec("ALTER TABLE clank_platform_releases ADD COLUMN storage_bytes INTEGER NOT NULL DEFAULT 0");
    internal.exec("UPDATE clank_platform_releases SET storage_bytes = artifact_bytes");
  }
  if (!releaseColumns.some((column) => column.name === "runtime_bytes")) {
    internal.exec("ALTER TABLE clank_platform_releases ADD COLUMN runtime_bytes INTEGER NOT NULL DEFAULT 0");
    internal.exec(`UPDATE clank_platform_releases
      SET runtime_bytes = CASE WHEN artifact_available = 1 THEN artifact_bytes ELSE 0 END`);
  }
  if (!releaseColumns.some((column) => column.name === "snapshot_bytes")) {
    internal.exec("ALTER TABLE clank_platform_releases ADD COLUMN snapshot_bytes INTEGER NOT NULL DEFAULT 0");
  }
  if (!releaseColumns.some((column) => column.name === "runner_artifact_bytes")) {
    internal.exec("ALTER TABLE clank_platform_releases ADD COLUMN runner_artifact_bytes INTEGER NOT NULL DEFAULT 0");
  }
  if (!releaseColumns.some((column) => column.name === "runner_artifact_store")) {
    internal.exec("ALTER TABLE clank_platform_releases ADD COLUMN runner_artifact_store TEXT NOT NULL DEFAULT 'local'");
  }
  if (!releaseColumns.some((column) => column.name === "runner_artifact_key")) {
    internal.exec("ALTER TABLE clank_platform_releases ADD COLUMN runner_artifact_key TEXT");
  }
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
    organization_id TEXT,
    action TEXT NOT NULL,
    metadata TEXT NOT NULL CHECK (json_valid(metadata)),
    created_at INTEGER NOT NULL
  )`);
  const auditColumns = internal.prepare("PRAGMA table_info(clank_platform_audit)").all();
  if (!auditColumns.some((column) => column.name === "organization_id")) {
    internal.exec("ALTER TABLE clank_platform_audit ADD COLUMN organization_id TEXT");
    internal.exec(`UPDATE clank_platform_audit
      SET organization_id = (
        SELECT organization_id FROM clank_platform_projects
        WHERE clank_platform_projects.id = clank_platform_audit.project_id
      )
      WHERE organization_id IS NULL AND project_id IS NOT NULL`);
    internal.exec(`UPDATE clank_platform_audit AS target
      SET organization_id = (
        SELECT json_extract(source.metadata, '$.organizationId')
        FROM clank_platform_audit AS source
        WHERE source.project_id = target.project_id
          AND json_type(source.metadata, '$.organizationId') = 'text'
        ORDER BY source.id DESC
        LIMIT 1
      )
      WHERE target.organization_id IS NULL AND target.project_id IS NOT NULL`);
    internal.exec(`UPDATE clank_platform_audit
      SET organization_id = json_extract(metadata, '$.organizationId')
      WHERE organization_id IS NULL
        AND json_type(metadata, '$.organizationId') = 'text'`);
  }
  internal.exec("CREATE INDEX IF NOT EXISTS clank_platform_audit_organization ON clank_platform_audit (organization_id, id DESC)");
  internal.exec("CREATE INDEX IF NOT EXISTS clank_platform_audit_project ON clank_platform_audit (project_id, id DESC)");
  internal.prepare("DELETE FROM clank_platform_device_codes WHERE expires_at <= ?").run(Date.now());
  internal.prepare("DELETE FROM clank_platform_tokens WHERE expires_at <= ?").run(Date.now());
  internal.prepare("DELETE FROM clank_platform_invitations WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(Date.now());
  internal.prepare(
    "DELETE FROM clank_platform_personal_invitations WHERE expires_at <= ? OR revoked_at IS NOT NULL",
  ).run(Date.now());
  const legacyOwners = internal.prepare(`SELECT DISTINCT p.owner_id, u.email
    FROM clank_platform_projects p
    JOIN clank_auth_users u ON u.id = p.owner_id
    WHERE p.organization_id IS NULL`).all();
  for (const row of legacyOwners) {
    const userId = String(row.owner_id);
    let organization = internal.prepare(
      "SELECT id FROM clank_platform_organizations WHERE created_by = ? ORDER BY created_at LIMIT 1",
    ).get(userId);
    if (!organization) {
      const id = await randomId(18);
      const base = normalizeSlug(`personal-${id.slice(0, 10)}`);
      const now = Date.now();
      internal.prepare(`INSERT INTO clank_platform_organizations
        (id, name, slug, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, "Personal workspace", base, userId, now, now);
      organization = { id };
    }
    const organizationId = String(organization.id);
    internal.prepare(`INSERT OR IGNORE INTO clank_platform_memberships
      (organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)`)
      .run(organizationId, userId, Date.now(), Date.now());
    internal.prepare("UPDATE clank_platform_projects SET organization_id = ? WHERE owner_id = ? AND organization_id IS NULL")
      .run(organizationId, userId);
  }
  return { database, internal, auth, rateLimits };
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

async function requirePlatformAdmin(
  storage: PlatformDatabase,
  request: Request,
  verifyCsrf = false,
): Promise<AuthRequest<DefaultAuthProfile>> {
  if (request.headers.has("authorization")) {
    throw new PlatformError(
      403,
      "BROWSER_ADMIN_REQUIRED",
      "Platform administration requires an interactive browser session.",
    );
  }
  const auth = await requireBrowserAuth(storage.auth, request);
  if (auth.user!.role !== PLATFORM_ADMIN_ROLE) {
    throw new PlatformError(403, "PLATFORM_ADMIN_REQUIRED", "Platform administrator access is required.");
  }
  rejectActiveImpersonation(storage.internal, request, auth);
  if (verifyCsrf) await storage.auth.verifyCsrf(request, auth);
  return auth;
}

function resolvePlatformImpersonation(
  internal: SQLiteInternal,
  request: Request,
  auth: AuthRequest<DefaultAuthProfile>,
): PlatformImpersonation | null {
  if (!auth.user || !auth.session) return null;
  const token = impersonationToken(request);
  if (!token) return null;
  const row = internal.prepare(`SELECT
      i.id,
      i.actor_user_id,
      i.actor_session_id,
      i.target_user_id,
      i.reason,
      i.created_at,
      i.expires_at,
      i.revoked_at,
      actor.email AS actor_email,
      actor.role AS actor_role,
      actor.disabled AS actor_disabled,
      target.email AS target_email,
      target.role AS target_role,
      target.disabled AS target_disabled
    FROM clank_platform_impersonations i
    JOIN clank_auth_users actor ON actor.id = i.actor_user_id
    JOIN clank_auth_users target ON target.id = i.target_user_id
    WHERE i.token_hash = ?`).get(syncHash(token));
  if (
    !row
    || row.revoked_at !== null
    || Number(row.expires_at) <= Date.now()
    || String(row.actor_user_id) !== auth.user.id
    || String(row.actor_session_id) !== auth.session.id
    || String(row.actor_role) !== PLATFORM_ADMIN_ROLE
    || Number(row.actor_disabled) !== 0
    || String(row.target_role) === PLATFORM_ADMIN_ROLE
    || Number(row.target_disabled) !== 0
  ) return null;
  return {
    id: String(row.id),
    actorUserId: String(row.actor_user_id),
    actorEmail: String(row.actor_email),
    targetUserId: String(row.target_user_id),
    targetEmail: String(row.target_email),
    reason: String(row.reason),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

function rejectActiveImpersonation(
  internal: SQLiteInternal,
  request: Request,
  auth: AuthRequest<DefaultAuthProfile>,
): void {
  if (resolvePlatformImpersonation(internal, request, auth)) {
    throw new PlatformError(
      403,
      "IMPERSONATION_ACTIVE",
      "Exit impersonation before using administrator or identity controls.",
    );
  }
}

function stopPlatformImpersonation(
  internal: SQLiteInternal,
  request: Request,
  auth: AuthRequest<DefaultAuthProfile>,
): Response {
  const token = impersonationToken(request);
  const now = Date.now();
  const row = token
    ? internal.prepare(`SELECT i.id, i.target_user_id, i.reason, i.created_at, i.expires_at,
        target.email AS target_email
      FROM clank_platform_impersonations i
      JOIN clank_auth_users target ON target.id = i.target_user_id
      WHERE i.token_hash = ? AND i.actor_user_id = ? AND i.actor_session_id = ?
        AND i.revoked_at IS NULL`).get(syncHash(token), auth.user!.id, auth.session!.id)
    : undefined;
  if (row) {
    internal.transaction((changes) => {
      const result = internal.prepare(`UPDATE clank_platform_impersonations SET revoked_at = ?
        WHERE id = ? AND revoked_at IS NULL`).run(now, row.id);
      if (Number(result.changes) === 1) {
        audit(internal, auth.user!.id, null, null, "impersonation.stop", {
          impersonationId: String(row.id),
          targetUserId: String(row.target_user_id),
          targetEmail: String(row.target_email),
          reason: String(row.reason),
          createdAt: Number(row.created_at),
          expiresAt: Number(row.expires_at),
          stoppedAt: now,
        });
        changes.record("__platform", auth.user!.id);
      }
    });
  }
  return apiWithCookie({
    ok: true,
    stopped: Boolean(row),
  }, impersonationCookie(request, "", 0));
}

function impersonationToken(request: Request): string | null {
  const expectedName = new URL(request.url).protocol === "https:"
    ? SECURE_IMPERSONATION_COOKIE
    : IMPERSONATION_COOKIE;
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== expectedName) continue;
    const token = part.slice(separator + 1).trim();
    if (/^[A-Za-z0-9_-]{20,200}$/u.test(token)) return token;
  }
  return null;
}

function impersonationCookie(request: Request, value: string, lifetimeMs: number): string {
  const secure = new URL(request.url).protocol === "https:";
  const name = secure ? SECURE_IMPERSONATION_COOKIE : IMPERSONATION_COOKIE;
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(lifetimeMs / 1_000))}${secure ? "; Secure" : ""}`;
}

function reconcilePlatformAdminRoles(
  storage: PlatformDatabase,
  platformAdminEmails: ReadonlySet<string>,
): void {
  const users = storage.internal.prepare(
    "SELECT id, email, role FROM clank_auth_users ORDER BY id",
  ).all();
  for (const user of users) {
    const currentRole = String(user.role);
    const configured = platformAdminEmails.has(String(user.email).trim().toLowerCase());
    const nextRole = configured
      ? PLATFORM_ADMIN_ROLE
      : currentRole === PLATFORM_ADMIN_ROLE
        ? "user"
        : currentRole;
    if (nextRole !== currentRole) storage.auth.setRole(String(user.id) as AuthUserId, nextRole);
  }
}

async function requireToken(internal: SQLiteInternal, request: Request): Promise<TokenPrincipal> {
  const authorization = request.headers.get("authorization") ?? "";
  const matched = /^Bearer ((?:clnk|prct)_[A-Za-z0-9_-]{40,200})$/.exec(authorization);
  if (!matched) throw new PlatformError(401, "INVALID_TOKEN", "A valid CLI access token is required.");
  const row = internal.prepare(`SELECT t.id, t.user_id, t.organization_id, t.project_id, t.permissions,
      t.expires_at, t.revoked_at, u.email, u.disabled
    FROM clank_platform_tokens t
    JOIN clank_auth_users u ON u.id = t.user_id
    WHERE t.token_hash = ?`).get(syncHash(matched[1]!));
  if (!row || row.revoked_at !== null || Number(row.expires_at) <= Date.now() || Number(row.disabled) !== 0) {
    throw new PlatformError(401, "INVALID_TOKEN", "The CLI access token is invalid or expired.");
  }
  internal.prepare("UPDATE clank_platform_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return {
    tokenId: String(row.id),
    userId: String(row.user_id),
    email: String(row.email),
    organizationId: row.organization_id === null ? null : String(row.organization_id),
    projectId: row.project_id === null ? null : String(row.project_id),
    permissions: parseProjectPermissions(row.permissions),
    impersonation: null,
  };
}

async function requirePlatformPrincipal(storage: PlatformDatabase, request: Request): Promise<TokenPrincipal> {
  if (request.headers.has("authorization")) return requireToken(storage.internal, request);
  const auth = await requireBrowserAuth(storage.auth, request);
  const impersonation = resolvePlatformImpersonation(storage.internal, request, auth);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    if (impersonation) {
      throw new PlatformError(
        403,
        "IMPERSONATION_READ_ONLY",
        "This impersonation session is read-only.",
      );
    }
    await storage.auth.verifyCsrf(request, auth);
  }
  return {
    tokenId: null,
    userId: impersonation?.targetUserId ?? auth.user!.id,
    email: impersonation?.targetEmail ?? auth.user!.email,
    organizationId: null,
    projectId: null,
    permissions: [],
    impersonation,
  };
}

function projectRow(row: Record<string, unknown>): ProjectRow {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    organizationId: row.organization_id === null || row.organization_id === undefined
      ? null
      : String(row.organization_id),
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
    runtimeBytes: Number(row.runtime_bytes ?? row.artifact_bytes),
    runnerArtifactBytes: Number(row.runner_artifact_bytes ?? 0),
    runnerArtifactStore: row.runner_artifact_store === undefined
      ? "local"
      : String(row.runner_artifact_store),
    runnerArtifactKey: row.runner_artifact_key === null || row.runner_artifact_key === undefined
      ? null
      : String(row.runner_artifact_key),
    snapshotBytes: Number(row.snapshot_bytes ?? 0),
    storageBytes: Number(row.storage_bytes ?? row.artifact_bytes),
    artifactAvailable: Number(row.artifact_available ?? 1) === 1,
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

function accessibleProject(
  internal: SQLiteInternal,
  id: string,
  principal: TokenPrincipal,
  permission: ProjectPermission,
): ProjectAccess {
  if (principal.projectId && principal.projectId !== id) {
    throw new PlatformError(404, "PROJECT_NOT_FOUND", "Project not found.");
  }
  const row = internal.prepare(`SELECT p.*, COALESCE(m.role,
      CASE WHEN p.owner_id = ? THEN 'owner' ELSE NULL END) AS membership_role
    FROM clank_platform_projects p
    LEFT JOIN clank_platform_memberships m
      ON m.organization_id = p.organization_id AND m.user_id = ?
    WHERE p.id = ?`).get(principal.userId, principal.userId, id);
  if (!row || row.membership_role === null) {
    throw new PlatformError(404, "PROJECT_NOT_FOUND", "Project not found.");
  }
  const project = projectRow(row);
  const role = validateOrganizationRole(String(row.membership_role), true);
  if (principal.organizationId && project.organizationId !== principal.organizationId) {
    throw new PlatformError(404, "PROJECT_NOT_FOUND", "Project not found.");
  }
  if (principal.projectId && !principal.permissions.includes(permission)) {
    throw new PlatformError(403, "TOKEN_SCOPE_DENIED", `This token cannot perform ${permission} operations.`);
  }
  if (!roleAllows(role, permission)) {
    throw new PlatformError(403, "ROLE_DENIED", `The ${role} role cannot perform ${permission} operations.`);
  }
  return { project, role };
}

function projectPayload(project: ProjectRow): Record<string, unknown> {
  return {
    id: project.id,
    organizationId: project.organizationId,
    name: project.name,
    slug: project.slug,
    port: project.port,
    activeReleaseId: project.activeReleaseId,
    databasePath: project.databasePath,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function domainChallengeFromRow(row: Record<string, unknown>): DomainChallenge {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    hostname: String(row.hostname),
    recordName: String(row.record_name),
    recordType: "TXT",
    recordValue: String(row.record_value),
    status: String(row.status) as DomainChallenge["status"],
    expiresAt: Number(row.expires_at),
    ...(row.verified_at === null ? {} : { verifiedAt: Number(row.verified_at) }),
  };
}

function ingressRoutes(
  internal: SQLiteInternal,
  baseDomain: string | undefined,
  active: ReadonlyMap<string, ActiveProcess>,
) {
  const projects = internal.prepare(`SELECT id, slug, port FROM clank_platform_projects
    WHERE active_release_id IS NOT NULL ORDER BY id`).all();
  return projects.map((project) => {
    const hosts = internal.prepare(`SELECT hostname FROM clank_platform_domains
      WHERE project_id = ? AND status = 'verified' AND routing_status = 'ready' ORDER BY hostname`).all(project.id)
      .map((row) => String(row.hostname));
    if (baseDomain) hosts.unshift(`${String(project.slug)}.${baseDomain}`);
    return {
      id: `route_${String(project.id)}`,
      projectId: String(project.id),
      hosts,
      upstream: `http://127.0.0.1:${active.get(String(project.id))?.port ?? Number(project.port)}`,
      active: hosts.length > 0 && active.has(String(project.id)),
    };
  });
}

function recordMetric(internal: SQLiteInternal, metric: IngressRequestMetric): void {
  const bucket = Math.floor(metric.recordedAt / METRIC_BUCKET_MS) * METRIC_BUCKET_MS;
  const duration = Math.min(10 * 60_000, Math.max(0, Number(metric.durationMs) || 0));
  const requestBytes = boundedMetricBytes(metric.requestBytes);
  const responseBytes = boundedMetricBytes(metric.responseBytes);
  const status = Number.isSafeInteger(metric.statusCode) ? metric.statusCode : 500;
  const latency = LATENCY_BOUNDS_MS.map((bound) => duration <= bound ? 1 : 0);
  const methodIndex = METRIC_METHODS.indexOf(metric.method as typeof METRIC_METHODS[number]);
  const methodValues = METRIC_METHOD_COLUMNS.map((_, index) =>
    index === (methodIndex === -1 ? METRIC_METHOD_COLUMNS.length - 1 : methodIndex) ? 1 : 0);
  internal.prepare(`INSERT INTO clank_platform_metrics (
      project_id, bucket_started_at, request_count, error_count,
      status_2xx, status_3xx, status_4xx, status_5xx,
      duration_sum_ms, duration_max_ms,
      latency_le_50, latency_le_100, latency_le_250, latency_le_500,
      latency_le_1000, latency_le_2500, latency_le_5000, latency_inf,
      request_bytes, response_bytes,
      method_get, method_head, method_post, method_put,
      method_patch, method_delete, method_options, method_other
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, bucket_started_at) DO UPDATE SET
      request_count = request_count + 1,
      error_count = error_count + excluded.error_count,
      status_2xx = status_2xx + excluded.status_2xx,
      status_3xx = status_3xx + excluded.status_3xx,
      status_4xx = status_4xx + excluded.status_4xx,
      status_5xx = status_5xx + excluded.status_5xx,
      duration_sum_ms = duration_sum_ms + excluded.duration_sum_ms,
      duration_max_ms = max(duration_max_ms, excluded.duration_max_ms),
      latency_le_50 = latency_le_50 + excluded.latency_le_50,
      latency_le_100 = latency_le_100 + excluded.latency_le_100,
      latency_le_250 = latency_le_250 + excluded.latency_le_250,
      latency_le_500 = latency_le_500 + excluded.latency_le_500,
      latency_le_1000 = latency_le_1000 + excluded.latency_le_1000,
      latency_le_2500 = latency_le_2500 + excluded.latency_le_2500,
      latency_le_5000 = latency_le_5000 + excluded.latency_le_5000,
      latency_inf = latency_inf + 1,
      request_bytes = request_bytes + excluded.request_bytes,
      response_bytes = response_bytes + excluded.response_bytes,
      method_get = method_get + excluded.method_get,
      method_head = method_head + excluded.method_head,
      method_post = method_post + excluded.method_post,
      method_put = method_put + excluded.method_put,
      method_patch = method_patch + excluded.method_patch,
      method_delete = method_delete + excluded.method_delete,
      method_options = method_options + excluded.method_options,
      method_other = method_other + excluded.method_other`)
    .run(
      metric.projectId,
      bucket,
      status >= 500 ? 1 : 0,
      status >= 200 && status < 300 ? 1 : 0,
      status >= 300 && status < 400 ? 1 : 0,
      status >= 400 && status < 500 ? 1 : 0,
      status >= 500 && status < 600 ? 1 : 0,
      duration,
      duration,
      ...latency,
      requestBytes,
      responseBytes,
      ...methodValues,
    );
}

function boundedMetricBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

interface MetricRange {
  name: "15m" | "1h" | "24h" | "7d" | "30d";
  durationMs: number;
  intervalMs: number;
}

function metricRange(input: string): MetricRange {
  if (input === "15m") return { name: "15m", durationMs: 15 * 60_000, intervalMs: 60_000 };
  if (input === "1h") return { name: "1h", durationMs: 60 * 60_000, intervalMs: 60_000 };
  if (input === "7d") return { name: "7d", durationMs: 7 * 24 * 60 * 60_000, intervalMs: 60 * 60_000 };
  if (input === "30d") return { name: "30d", durationMs: 30 * 24 * 60 * 60_000, intervalMs: 6 * 60 * 60_000 };
  return { name: "24h", durationMs: 24 * 60 * 60_000, intervalMs: 15 * 60_000 };
}

function metricSeries(internal: SQLiteInternal, projectId: string, requestedRange: string): Record<string, unknown> {
  const range = metricRange(requestedRange);
  const now = Date.now();
  const start = now - range.durationMs;
  const previousStart = start - range.durationMs;
  const rows = projectMetricRows(internal, projectId, range.intervalMs, start, now + 1);
  const previousRows = projectMetricRows(internal, projectId, range.intervalMs, previousStart, start);
  const points = fillMetricPoints(rows, start, now, range.intervalMs);
  const summary = {
    ...summarizeMetricRows(rows, range.durationMs),
    ...projectMetricExtremes(internal, projectId, start, now + 1),
  };
  const previous = {
    ...summarizeMetricRows(previousRows, range.durationMs),
    ...projectMetricExtremes(internal, projectId, previousStart, start),
  };
  return {
    range: range.name,
    start,
    end: now,
    intervalMs: range.intervalMs,
    summary,
    comparison: {
      start: previousStart,
      end: start,
      previous,
      change: metricSummaryChange(summary, previous),
    },
    points,
  };
}

function projectMetricRows(
  internal: SQLiteInternal,
  projectId: string,
  intervalMs: number,
  start: number,
  end: number,
): Record<string, unknown>[] {
  return internal.prepare(`SELECT
      bucket_started_at - (bucket_started_at % ?) AS point_at,
      sum(request_count) AS request_count,
      sum(error_count) AS error_count,
      sum(status_2xx) AS status_2xx,
      sum(status_3xx) AS status_3xx,
      sum(status_4xx) AS status_4xx,
      sum(status_5xx) AS status_5xx,
      sum(duration_sum_ms) AS duration_sum_ms,
      max(duration_max_ms) AS duration_max_ms,
      sum(latency_le_50) AS latency_le_50,
      sum(latency_le_100) AS latency_le_100,
      sum(latency_le_250) AS latency_le_250,
      sum(latency_le_500) AS latency_le_500,
      sum(latency_le_1000) AS latency_le_1000,
      sum(latency_le_2500) AS latency_le_2500,
      sum(latency_le_5000) AS latency_le_5000,
      sum(latency_inf) AS latency_inf,
      sum(request_bytes) AS request_bytes,
      sum(response_bytes) AS response_bytes,
      sum(method_get) AS method_get,
      sum(method_head) AS method_head,
      sum(method_post) AS method_post,
      sum(method_put) AS method_put,
      sum(method_patch) AS method_patch,
      sum(method_delete) AS method_delete,
      sum(method_options) AS method_options,
      sum(method_other) AS method_other
    FROM clank_platform_metrics
    WHERE project_id = ? AND bucket_started_at >= ? AND bucket_started_at < ?
    GROUP BY point_at ORDER BY point_at`).all(intervalMs, projectId, start, end);
}

function fillMetricPoints(
  rows: Record<string, unknown>[],
  start: number,
  end: number,
  intervalMs: number,
): Record<string, unknown>[] {
  const byTime = new Map(rows.map((row) => [Number(row.point_at), row]));
  const points: Record<string, unknown>[] = [];
  const first = Math.ceil(start / intervalMs) * intervalMs;
  for (let at = first; at <= end; at += intervalMs) {
    points.push(publicMetricPoint(byTime.get(at) ?? { point_at: at }));
  }
  return points;
}

function projectMetricExtremes(
  internal: SQLiteInternal,
  projectId: string,
  start: number,
  end: number,
): { peakRequestsPerMinute: number; lastRequestAt: number | null } {
  const row = internal.prepare(`SELECT
      coalesce(max(request_count), 0) AS peak,
      max(bucket_started_at) AS last_request_at
    FROM clank_platform_metrics
    WHERE project_id = ? AND bucket_started_at >= ? AND bucket_started_at < ?`)
    .get(projectId, start, end);
  return {
    peakRequestsPerMinute: Number(row?.peak ?? 0),
    lastRequestAt: row?.last_request_at === null || row?.last_request_at === undefined
      ? null
      : Number(row.last_request_at),
  };
}

function metricSummaryChange(
  current: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, number | null> {
  return {
    requestsPercent: percentChange(Number(current.requests), Number(previous.requests)),
    errorRatePoints: Number(current.errorRate) - Number(previous.errorRate),
    p95LatencyPercent: percentChange(Number(current.p95LatencyMs), Number(previous.p95LatencyMs)),
    bandwidthPercent: percentChange(Number(current.bandwidthBytes), Number(previous.bandwidthBytes)),
  };
}

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / previous;
}

function platformAdminUsers(
  internal: SQLiteInternal,
  limit: number,
  before: number,
  search: string,
): { users: Record<string, unknown>[]; nextBefore: number | null } {
  const rows = internal.prepare(`SELECT
      u.rowid AS cursor,
      u.id,
      u.email,
      u.email_verified_at,
      u.role,
      json_extract(u.profile, '$.name') AS profile_name,
      u.disabled,
      u.created_at,
      u.updated_at,
      (SELECT max(s.last_seen_at) FROM clank_auth_sessions s WHERE s.user_id = u.id) AS last_seen_at,
      (SELECT count(*) FROM clank_auth_sessions s
        WHERE s.user_id = u.id AND s.expires_at > ? AND s.idle_expires_at > ?) AS active_sessions,
      (SELECT count(*) FROM clank_platform_tokens t
        WHERE t.user_id = u.id AND t.revoked_at IS NULL AND t.expires_at > ?) AS active_tokens,
      (SELECT count(*) FROM clank_platform_memberships m WHERE m.user_id = u.id) AS organizations,
      (SELECT count(*) FROM clank_platform_projects p
        WHERE p.owner_id = u.id OR EXISTS (
          SELECT 1 FROM clank_platform_memberships m
          WHERE m.user_id = u.id AND m.organization_id = p.organization_id
        )) AS projects,
      (SELECT coalesce(sum(r.storage_bytes), 0)
        FROM clank_platform_releases r
        JOIN clank_platform_projects p ON p.id = r.project_id
        WHERE p.owner_id = u.id OR EXISTS (
          SELECT 1 FROM clank_platform_memberships m
          WHERE m.user_id = u.id AND m.organization_id = p.organization_id
        )) AS accessible_storage_bytes
    FROM clank_auth_users u
    WHERE u.rowid < ?
      AND (? = '' OR instr(lower(u.email), lower(?)) > 0
        OR instr(lower(coalesce(json_extract(u.profile, '$.name'), '')), lower(?)) > 0)
    ORDER BY u.rowid DESC
    LIMIT ?`).all(
      Date.now(),
      Date.now(),
      Date.now(),
      before,
      search,
      search,
      search,
      limit,
    );
  return {
    users: rows.map((row) => ({
      id: String(row.id),
      email: String(row.email),
      name: row.profile_name === null || row.profile_name === undefined
        ? null
        : String(row.profile_name),
      platformRole: String(row.role),
      disabled: Number(row.disabled) !== 0,
      emailVerified: row.email_verified_at !== null,
      activeSessions: Number(row.active_sessions ?? 0),
      activeTokens: Number(row.active_tokens ?? 0),
      organizations: Number(row.organizations ?? 0),
      projects: Number(row.projects ?? 0),
      accessibleStorageBytes: Number(row.accessible_storage_bytes ?? 0),
      lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    })),
    nextBefore: rows.length === limit ? Number(rows.at(-1)!.cursor) : null,
  };
}

function platformAdminQuotaScope(
  internal: SQLiteInternal,
  scopeType: PlatformQuotaScope,
  scopeId: string,
  defaults: PlatformQuotaValues,
): Record<string, unknown> {
  if (scopeType === "account") {
    const account = internal.prepare(`SELECT id, email, json_extract(profile, '$.name') AS name
      FROM clank_auth_users WHERE id = ?`).get(scopeId);
    if (!account) throw new PlatformError(404, "USER_NOT_FOUND", "The target account is unavailable.");
    const overrides = quotaOverrides(internal, "account", scopeId);
    const workspaces = internal.prepare(`SELECT id, name, slug,
        (SELECT count(*) FROM clank_platform_projects p WHERE p.organization_id = o.id) AS projects
      FROM clank_platform_organizations o
      WHERE created_by = ? ORDER BY created_at`).all(scopeId).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        slug: String(row.slug),
        usage: { projects: Number(row.projects ?? 0) },
        overrides: quotaOverrides(internal, "workspace", String(row.id)),
        effective: workspaceQuotas(internal, String(row.id), defaults),
      }));
    const usage = internal.prepare(`SELECT
        (SELECT count(*) FROM clank_platform_organizations WHERE created_by = ?) AS organizations,
        (SELECT count(*) FROM clank_platform_projects WHERE owner_id = ?) AS projects`)
      .get(scopeId, scopeId);
    return {
      scope: {
        type: scopeType,
        id: String(account.id),
        email: String(account.email),
        name: account.name === null || account.name === undefined ? null : String(account.name),
      },
      definitions: publicQuotaDefinitions(),
      defaults,
      overrides,
      effective: { ...defaults, ...overrides },
      usage: {
        organizations: Number(usage?.organizations ?? 0),
        projects: Number(usage?.projects ?? 0),
      },
      workspaces,
    };
  }

  const workspace = internal.prepare(`SELECT o.id, o.name, o.slug, o.created_by,
      u.email AS owner_email,
      (SELECT count(*) FROM clank_platform_projects p WHERE p.organization_id = o.id) AS projects
    FROM clank_platform_organizations o
    JOIN clank_auth_users u ON u.id = o.created_by
    WHERE o.id = ?`).get(scopeId);
  if (!workspace) throw new PlatformError(404, "ORGANIZATION_NOT_FOUND", "Workspace not found.");
  const inherited = accountQuotas(internal, String(workspace.created_by), defaults);
  const overrides = quotaOverrides(internal, "workspace", scopeId);
  return {
    scope: {
      type: scopeType,
      id: String(workspace.id),
      name: String(workspace.name),
      slug: String(workspace.slug),
      ownerId: String(workspace.created_by),
      ownerEmail: String(workspace.owner_email),
    },
    definitions: publicQuotaDefinitions().filter((definition) =>
      (definition.scopes as string[]).includes("workspace")),
    defaults,
    inherited,
    overrides,
    effective: { ...inherited, ...overrides },
    usage: { projects: Number(workspace.projects ?? 0) },
  };
}

function updatePlatformQuotaScope(
  internal: SQLiteInternal,
  scopeType: PlatformQuotaScope,
  scopeId: string,
  input: Record<string, unknown>,
  actorUserId: string,
  defaults: PlatformQuotaValues,
): void {
  const target = scopeType === "account"
    ? internal.prepare("SELECT id FROM clank_auth_users WHERE id = ?").get(scopeId)
    : internal.prepare("SELECT id FROM clank_platform_organizations WHERE id = ?").get(scopeId);
  if (!target) {
    throw new PlatformError(
      404,
      scopeType === "account" ? "USER_NOT_FOUND" : "ORGANIZATION_NOT_FOUND",
      scopeType === "account" ? "The target account is unavailable." : "Workspace not found.",
    );
  }
  const allowed = scopeType === "account" ? PLATFORM_QUOTA_KEYS : WORKSPACE_QUOTA_KEYS;
  exact(input, [...allowed]);
  const updates = Object.entries(input) as [PlatformQuotaKey, unknown][];
  const normalized = updates.map(([key, value]) => {
    if (value === null) return [key, null] as const;
    const definition = PLATFORM_QUOTA_DEFINITIONS[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value)
      || value < definition.minimum || value > definition.maximum) {
      throw new PlatformError(
        422,
        "INVALID_QUOTA",
        `${definition.label} must be a whole number from ${definition.minimum} through ${definition.maximum}.`,
      );
    }
    return [key, value] as const;
  });
  const previous = quotaOverrides(internal, scopeType, scopeId);
  const changes: Record<string, { from: number | null; to: number | null }> = {};
  const now = Date.now();
  internal.transaction((changeLog) => {
    for (const [key, value] of normalized) {
      const from = previous[key] ?? null;
      if (from === value) continue;
      if (value === null) {
        internal.prepare(`DELETE FROM clank_platform_quota_overrides
          WHERE scope_type = ? AND scope_id = ? AND quota_key = ?`)
          .run(scopeType, scopeId, key);
      } else {
        internal.prepare(`INSERT INTO clank_platform_quota_overrides
          (scope_type, scope_id, quota_key, quota_value, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope_type, scope_id, quota_key) DO UPDATE SET
            quota_value = excluded.quota_value,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at`)
          .run(scopeType, scopeId, key, value, actorUserId, now);
      }
      changes[key] = { from, to: value };
    }
    if (!Object.keys(changes).length) return;
    audit(internal, actorUserId, null, null, "quota.update", {
      ...(scopeType === "workspace" ? { organizationId: scopeId } : {}),
      scopeType,
      scopeId,
      changes,
      effective: scopeType === "account"
        ? accountQuotas(internal, scopeId, defaults)
        : workspaceQuotas(internal, scopeId, defaults),
    });
    changeLog.record("__platform", scopeId);
  });
}

function platformAdminAnalytics(
  internal: SQLiteInternal,
  active: ReadonlyMap<string, ActiveProcess>,
  requestedRange: string,
): Record<string, unknown> {
  const range = metricRange(requestedRange);
  const now = Date.now();
  const start = now - range.durationMs;
  const rows = internal.prepare(`SELECT
      bucket_started_at - (bucket_started_at % ?) AS point_at,
      sum(request_count) AS request_count,
      sum(error_count) AS error_count,
      sum(status_2xx) AS status_2xx,
      sum(status_3xx) AS status_3xx,
      sum(status_4xx) AS status_4xx,
      sum(status_5xx) AS status_5xx,
      sum(duration_sum_ms) AS duration_sum_ms,
      max(duration_max_ms) AS duration_max_ms,
      sum(latency_le_50) AS latency_le_50,
      sum(latency_le_100) AS latency_le_100,
      sum(latency_le_250) AS latency_le_250,
      sum(latency_le_500) AS latency_le_500,
      sum(latency_le_1000) AS latency_le_1000,
      sum(latency_le_2500) AS latency_le_2500,
      sum(latency_le_5000) AS latency_le_5000,
      sum(latency_inf) AS latency_inf,
      sum(request_bytes) AS request_bytes,
      sum(response_bytes) AS response_bytes,
      sum(method_get) AS method_get,
      sum(method_head) AS method_head,
      sum(method_post) AS method_post,
      sum(method_put) AS method_put,
      sum(method_patch) AS method_patch,
      sum(method_delete) AS method_delete,
      sum(method_options) AS method_options,
      sum(method_other) AS method_other
    FROM clank_platform_metrics
    WHERE bucket_started_at >= ?
    GROUP BY point_at ORDER BY point_at`).all(range.intervalMs, start);
  const totals = internal.prepare(`SELECT
      (SELECT count(*) FROM clank_auth_users) AS users,
      (SELECT count(*) FROM clank_auth_users WHERE disabled = 0) AS enabled_users,
      (SELECT count(*) FROM clank_auth_users WHERE role = ?) AS platform_admins,
      (SELECT count(*) FROM clank_platform_organizations) AS organizations,
      (SELECT count(*) FROM clank_platform_memberships) AS memberships,
      (SELECT count(*) FROM clank_platform_projects) AS projects,
      (SELECT count(*) FROM clank_platform_projects WHERE active_release_id IS NOT NULL) AS deployed_projects,
      (SELECT count(*) FROM clank_platform_releases) AS releases,
      (SELECT count(*) FROM clank_platform_domains) AS domains,
      (SELECT count(*) FROM clank_platform_domains
        WHERE status = 'verified' AND routing_status = 'ready') AS ready_domains,
      (SELECT count(*) FROM clank_platform_tokens
        WHERE revoked_at IS NULL AND expires_at > ?) AS active_tokens,
      (SELECT coalesce(sum(storage_bytes), 0) FROM clank_platform_releases) AS retained_storage_bytes,
      (SELECT count(*) FROM clank_platform_audit WHERE created_at >= ?) AS audit_events
    `).get(PLATFORM_ADMIN_ROLE, now, start)!;
  const topRows = internal.prepare(`SELECT
      p.id,
      p.name,
      p.slug,
      o.name AS organization_name,
      sum(m.request_count) AS request_count,
      sum(m.error_count) AS error_count,
      sum(m.status_2xx) AS status_2xx,
      sum(m.status_3xx) AS status_3xx,
      sum(m.status_4xx) AS status_4xx,
      sum(m.status_5xx) AS status_5xx,
      sum(m.duration_sum_ms) AS duration_sum_ms,
      max(m.duration_max_ms) AS duration_max_ms,
      sum(m.latency_le_50) AS latency_le_50,
      sum(m.latency_le_100) AS latency_le_100,
      sum(m.latency_le_250) AS latency_le_250,
      sum(m.latency_le_500) AS latency_le_500,
      sum(m.latency_le_1000) AS latency_le_1000,
      sum(m.latency_le_2500) AS latency_le_2500,
      sum(m.latency_le_5000) AS latency_le_5000,
      sum(m.latency_inf) AS latency_inf,
      sum(m.request_bytes) AS request_bytes,
      sum(m.response_bytes) AS response_bytes,
      sum(m.method_get) AS method_get,
      sum(m.method_head) AS method_head,
      sum(m.method_post) AS method_post,
      sum(m.method_put) AS method_put,
      sum(m.method_patch) AS method_patch,
      sum(m.method_delete) AS method_delete,
      sum(m.method_options) AS method_options,
      sum(m.method_other) AS method_other
    FROM clank_platform_metrics m
    JOIN clank_platform_projects p ON p.id = m.project_id
    LEFT JOIN clank_platform_organizations o ON o.id = p.organization_id
    WHERE m.bucket_started_at >= ?
    GROUP BY p.id
    ORDER BY request_count DESC, p.id
    LIMIT 10`).all(start);
  const growthInterval = Math.max(range.intervalMs, 24 * 60 * 60_000);
  const growthRows = internal.prepare(`SELECT
      created_at - (created_at % ?) AS point_at,
      count(*) AS new_users
    FROM clank_auth_users
    WHERE created_at >= ?
    GROUP BY point_at ORDER BY point_at`).all(growthInterval, start);
  let cumulativeUsers = Number(internal.prepare(
    "SELECT count(*) AS count FROM clank_auth_users WHERE created_at < ?",
  ).get(start)?.count ?? 0);
  const supportRows = internal.prepare(`SELECT
      a.id,
      a.actor_user_id,
      a.action,
      a.metadata,
      a.created_at,
      u.email AS actor_email
    FROM clank_platform_audit a
    LEFT JOIN clank_auth_users u ON u.id = a.actor_user_id
    WHERE a.action IN ('impersonation.start', 'impersonation.stop')
    ORDER BY a.id DESC
    LIMIT 25`).all();
  return {
    range: range.name,
    start,
    end: now,
    intervalMs: range.intervalMs,
    totals: {
      users: Number(totals.users),
      enabledUsers: Number(totals.enabled_users),
      platformAdmins: Number(totals.platform_admins),
      organizations: Number(totals.organizations),
      memberships: Number(totals.memberships),
      projects: Number(totals.projects),
      deployedProjects: Number(totals.deployed_projects),
      onlineProjects: active.size,
      releases: Number(totals.releases),
      domains: Number(totals.domains),
      readyDomains: Number(totals.ready_domains),
      activeTokens: Number(totals.active_tokens),
      retainedStorageBytes: Number(totals.retained_storage_bytes),
      auditEvents: Number(totals.audit_events),
    },
    traffic: {
      summary: summarizeMetricRows(rows, range.durationMs),
      points: rows.map(publicMetricPoint),
    },
    userGrowth: growthRows.map((row) => {
      const newUsers = Number(row.new_users);
      cumulativeUsers += newUsers;
      return {
        at: Number(row.point_at),
        newUsers,
        totalUsers: cumulativeUsers,
      };
    }),
    supportAccess: supportRows.map((row) => {
      const metadata = JSON.parse(String(row.metadata)) as Record<string, unknown>;
      return {
        id: Number(row.id),
        action: String(row.action),
        createdAt: Number(row.created_at),
        actor: {
          id: String(row.actor_user_id),
          email: row.actor_email === null ? null : String(row.actor_email),
        },
        target: {
          id: String(metadata.targetUserId ?? ""),
          email: String(metadata.targetEmail ?? ""),
        },
        reason: String(metadata.reason ?? ""),
        expiresAt: Number(metadata.expiresAt ?? 0),
        stoppedAt: metadata.stoppedAt === undefined ? null : Number(metadata.stoppedAt),
      };
    }),
    topProjects: topRows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      slug: String(row.slug),
      organization: row.organization_name === null ? null : String(row.organization_name),
      ...summarizeMetricRows([row], range.durationMs),
    })),
  };
}

async function platformMemoryDiagnostics(
  internal: SQLiteInternal,
  active: ReadonlyMap<string, ActiveProcess>,
  runnerKind: "process" | "docker",
): Promise<Record<string, unknown>> {
  const processRuntime = (globalThis as any).process;
  const pid = Number(processRuntime?.pid);
  const memoryUsage = typeof processRuntime?.memoryUsage === "function"
    ? processRuntime.memoryUsage()
    : {};
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    readFile(path: string, encoding: "utf8"): Promise<string>;
  };
  const read = async (path: string): Promise<string | null> => {
    try {
      return await fs.readFile(path, "utf8");
    } catch {
      return null;
    }
  };
  const controlPlane = Number.isSafeInteger(pid) && pid > 0
    ? await linuxProcessMemory(pid, read)
    : emptyProcessMemory(null);
  const trackedApplications = [...active.values()].slice(0, 250).flatMap((running) => [
    {
      running,
      child: running.child,
      role: "web" as const,
      instance: 0,
    },
    ...running.background.map((background) => ({
      running,
      child: background.child,
      role: background.role,
      instance: background.instance,
    })),
  ]);
  const projectProcesses = await Promise.all(
    trackedApplications.slice(0, 1_000).map(async ({ running, child, role, instance }) => {
      const project = internal.prepare(
        "SELECT id, name, slug FROM clank_platform_projects WHERE id = ?",
      ).get(running.projectId);
      const childPid = Number(child.pid);
      const memory = Number.isSafeInteger(childPid) && childPid > 0
        ? await linuxProcessMemory(childPid, read)
        : emptyProcessMemory(null);
      return {
        id: running.projectId,
        name: String(project?.name ?? "Unknown project"),
        slug: String(project?.slug ?? running.projectId),
        releaseId: running.releaseId,
        port: running.port,
        scope: runnerKind === "docker" ? "docker_runner" : "application",
        role,
        instance: role === "worker" ? instance + 1 : null,
        ...memory,
      };
    }),
  );
  projectProcesses.sort((left, right) =>
    Number(right.pssBytes ?? right.rssBytes ?? 0) - Number(left.pssBytes ?? left.rssBytes ?? 0));
  const cgroup = await linuxCgroupMemory(read);
  let v8HeapLimitBytes: number | null = null;
  let v8AvailableBytes: number | null = null;
  try {
    const v8Name = "node:v8";
    const v8 = await import(v8Name) as unknown as {
      getHeapStatistics(): { heap_size_limit: number; total_available_size: number };
    };
    const heap = v8.getHeapStatistics();
    v8HeapLimitBytes = safeMemoryBytes(heap.heap_size_limit);
    v8AvailableBytes = safeMemoryBytes(heap.total_available_size);
  } catch {
    // V8 detail is optional; RSS and cgroup values remain available.
  }
  const controlAttribution = controlPlane.pssBytes ?? controlPlane.rssBytes ?? 0;
  const projectAttributionBytes = projectProcesses.reduce(
    (total, project) => total + Number(project.pssBytes ?? project.rssBytes ?? 0),
    0,
  );
  const trackedProcessBytes = controlAttribution + projectAttributionBytes;
  const currentBytes = cgroup.currentBytes;
  return {
    sampledAt: Date.now(),
    container: cgroup,
    controlPlane: {
      ...controlPlane,
      uptimeSeconds: typeof processRuntime?.uptime === "function"
        ? Math.max(0, Number(processRuntime.uptime()) || 0)
        : null,
      heapUsedBytes: safeMemoryBytes(memoryUsage.heapUsed),
      heapTotalBytes: safeMemoryBytes(memoryUsage.heapTotal),
      externalBytes: safeMemoryBytes(memoryUsage.external),
      arrayBuffersBytes: safeMemoryBytes(memoryUsage.arrayBuffers),
      v8HeapLimitBytes,
      v8AvailableBytes,
    },
    projects: projectProcesses,
    totals: {
      onlineProjects: active.size,
      trackedApplicationProcesses: projectProcesses.length,
      projectAttributedBytes: projectAttributionBytes,
      trackedProcessBytes,
      unattributedBytes: currentBytes === null
        ? null
        : Math.max(0, currentBytes - trackedProcessBytes),
      attribution: [
        controlPlane,
        ...projectProcesses,
      ].every((entry) => entry.pssBytes !== null)
        ? "proportional_set_size"
        : "resident_set_size_fallback",
    },
  };
}

interface LinuxProcessMemory {
  available: boolean;
  pid: number | null;
  rssBytes: number | null;
  peakRssBytes: number | null;
  pssBytes: number | null;
  privateBytes: number | null;
  sharedBytes: number | null;
  anonymousBytes: number | null;
  fileBytes: number | null;
  sharedMemoryBytes: number | null;
  swapBytes: number | null;
  threads: number | null;
}

function emptyProcessMemory(pid: number | null): LinuxProcessMemory {
  return {
    available: false,
    pid,
    rssBytes: null,
    peakRssBytes: null,
    pssBytes: null,
    privateBytes: null,
    sharedBytes: null,
    anonymousBytes: null,
    fileBytes: null,
    sharedMemoryBytes: null,
    swapBytes: null,
    threads: null,
  };
}

async function linuxProcessMemory(
  pid: number,
  read: (path: string) => Promise<string | null>,
): Promise<LinuxProcessMemory> {
  const [status, rollup] = await Promise.all([
    read(`/proc/${pid}/status`),
    read(`/proc/${pid}/smaps_rollup`),
  ]);
  if (!status) return emptyProcessMemory(pid);
  const privateBytes = sumMemoryValues(
    linuxKilobytes(rollup, "Private_Clean"),
    linuxKilobytes(rollup, "Private_Dirty"),
  );
  const sharedBytes = sumMemoryValues(
    linuxKilobytes(rollup, "Shared_Clean"),
    linuxKilobytes(rollup, "Shared_Dirty"),
  );
  return {
    available: true,
    pid,
    rssBytes: linuxKilobytes(status, "VmRSS"),
    peakRssBytes: linuxKilobytes(status, "VmHWM"),
    pssBytes: linuxKilobytes(rollup, "Pss"),
    privateBytes,
    sharedBytes,
    anonymousBytes: linuxKilobytes(status, "RssAnon"),
    fileBytes: linuxKilobytes(status, "RssFile"),
    sharedMemoryBytes: linuxKilobytes(status, "RssShmem"),
    swapBytes: linuxKilobytes(status, "VmSwap"),
    threads: linuxInteger(status, "Threads"),
  };
}

async function linuxCgroupMemory(
  read: (path: string) => Promise<string | null>,
): Promise<Record<string, unknown>> {
  const membership = await read("/proc/self/cgroup");
  const matched = membership?.split("\n").find((line) => line.startsWith("0::"))?.slice(3) ?? "/";
  const safePath = matched.startsWith("/")
    && !matched.split("/").includes("..")
    && /^\/[A-Za-z0-9_./-]*$/u.test(matched)
    ? matched.replace(/\/+$/u, "")
    : "";
  const root = `/sys/fs/cgroup${safePath}`;
  const [current, peak, limit, statText, eventsText] = await Promise.all([
    read(`${root}/memory.current`),
    read(`${root}/memory.peak`),
    read(`${root}/memory.max`),
    read(`${root}/memory.stat`),
    read(`${root}/memory.events`),
  ]);
  const stats = linuxKeyValues(statText);
  const events = linuxKeyValues(eventsText);
  const currentBytes = linuxByteValue(current);
  const limitBytes = limit?.trim() === "max" ? null : linuxByteValue(limit);
  return {
    available: currentBytes !== null,
    source: currentBytes === null ? "unavailable" : "cgroup_v2",
    currentBytes,
    peakBytes: linuxByteValue(peak),
    limitBytes,
    utilization: currentBytes !== null && limitBytes
      ? currentBytes / limitBytes
      : null,
    anonymousBytes: safeMemoryBytes(stats.anon),
    fileCacheBytes: safeMemoryBytes(stats.file),
    kernelBytes: safeMemoryBytes(stats.kernel),
    slabBytes: safeMemoryBytes(stats.slab),
    socketBytes: safeMemoryBytes(stats.sock),
    sharedMemoryBytes: safeMemoryBytes(stats.shmem),
    pageTablesBytes: safeMemoryBytes(stats.pagetables),
    events: {
      low: Number(events.low ?? 0),
      high: Number(events.high ?? 0),
      max: Number(events.max ?? 0),
      oom: Number(events.oom ?? 0),
      oomKill: Number(events.oom_kill ?? 0),
    },
  };
}

function linuxKilobytes(input: string | null, key: string): number | null {
  if (!input) return null;
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "mu").exec(input);
  return match ? safeMemoryBytes(Number(match[1]) * 1024) : null;
}

function linuxInteger(input: string | null, key: string): number | null {
  if (!input) return null;
  const match = new RegExp(`^${key}:\\s+(\\d+)$`, "mu").exec(input);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function linuxByteValue(input: string | null): number | null {
  if (!input) return null;
  return safeMemoryBytes(Number(input.trim()));
}

function linuxKeyValues(input: string | null): Record<string, number> {
  const output: Record<string, number> = {};
  for (const line of input?.split("\n") ?? []) {
    const match = /^([a-zA-Z0-9_]+)\s+(\d+)$/u.exec(line.trim());
    if (!match) continue;
    const value = Number(match[2]);
    if (Number.isSafeInteger(value) && value >= 0) output[match[1]!] = value;
  }
  return output;
}

function safeMemoryBytes(input: unknown): number | null {
  const value = Number(input);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sumMemoryValues(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((total, value) => total + value, 0) : null;
}

function publicMetricPoint(row: Record<string, unknown>): Record<string, unknown> {
  const requests = Number(row.request_count ?? 0);
  const durationSum = Number(row.duration_sum_ms ?? 0);
  const methods = metricMethodBreakdown(row, requests);
  return {
    at: Number(row.point_at),
    requests,
    errors: Number(row.error_count ?? 0),
    averageLatencyMs: requests ? durationSum / requests : 0,
    p95LatencyMs: histogramPercentile(row, requests, 0.95),
    maxLatencyMs: Number(row.duration_max_ms ?? 0),
    requestBytes: Number(row.request_bytes ?? 0),
    responseBytes: Number(row.response_bytes ?? 0),
    status: {
      success: Number(row.status_2xx ?? 0),
      redirect: Number(row.status_3xx ?? 0),
      clientError: Number(row.status_4xx ?? 0),
      serverError: Number(row.status_5xx ?? 0),
    },
    methods,
  };
}

function summarizeMetricRows(rows: Record<string, unknown>[], durationMs: number): Record<string, unknown> {
  const aggregate: Record<string, number> = {
    request_count: 0,
    error_count: 0,
    duration_sum_ms: 0,
    duration_max_ms: 0,
    request_bytes: 0,
    response_bytes: 0,
    status_2xx: 0,
    status_3xx: 0,
    status_4xx: 0,
    status_5xx: 0,
    latency_le_50: 0,
    latency_le_100: 0,
    latency_le_250: 0,
    latency_le_500: 0,
    latency_le_1000: 0,
    latency_le_2500: 0,
    latency_le_5000: 0,
    latency_inf: 0,
    method_get: 0,
    method_head: 0,
    method_post: 0,
    method_put: 0,
    method_patch: 0,
    method_delete: 0,
    method_options: 0,
    method_other: 0,
  };
  let activeIntervals = 0;
  let lastRequestAt = 0;
  for (const row of rows) {
    if (Number(row.request_count ?? 0) > 0) {
      activeIntervals++;
      lastRequestAt = Math.max(lastRequestAt, Number(row.point_at ?? 0));
    }
    for (const key of Object.keys(aggregate)) {
      if (key === "duration_max_ms") aggregate[key] = Math.max(aggregate[key]!, Number(row[key] ?? 0));
      else aggregate[key] = aggregate[key]! + Number(row[key] ?? 0);
    }
  }
  const requests = aggregate.request_count!;
  const status = {
    success: aggregate.status_2xx!,
    redirect: aggregate.status_3xx!,
    clientError: aggregate.status_4xx!,
    serverError: aggregate.status_5xx!,
  };
  return {
    requests,
    errors: aggregate.error_count!,
    errorRate: requests ? aggregate.error_count! / requests : 0,
    successRate: requests ? status.success / requests : 0,
    clientErrorRate: requests ? status.clientError / requests : 0,
    requestsPerMinute: requests / Math.max(1, durationMs / 60_000),
    averageLatencyMs: requests ? aggregate.duration_sum_ms! / requests : 0,
    p50LatencyMs: histogramPercentile(aggregate, requests, 0.5),
    p90LatencyMs: histogramPercentile(aggregate, requests, 0.9),
    p95LatencyMs: histogramPercentile(aggregate, requests, 0.95),
    p99LatencyMs: histogramPercentile(aggregate, requests, 0.99),
    maxLatencyMs: aggregate.duration_max_ms!,
    requestBytes: aggregate.request_bytes!,
    responseBytes: aggregate.response_bytes!,
    bandwidthBytes: aggregate.request_bytes! + aggregate.response_bytes!,
    averageResponseBytes: requests ? aggregate.response_bytes! / requests : 0,
    activeIntervals,
    lastRequestAt: lastRequestAt || null,
    status,
    statusRates: Object.fromEntries(Object.entries(status).map(([name, count]) => [
      name,
      requests ? count / requests : 0,
    ])),
    methods: metricMethodBreakdown(aggregate, requests),
    latencyDistribution: metricLatencyDistribution(aggregate, requests),
  };
}

function metricMethodBreakdown(row: Record<string, unknown>, requests: number): Record<string, number> {
  const methods = Object.fromEntries(METRIC_METHODS.map((method, index) => [
    method,
    Number(row[METRIC_METHOD_COLUMNS[index]!] ?? 0),
  ])) as Record<string, number>;
  const recorded = Object.values(methods).reduce((total, count) => total + count, 0);
  methods.OTHER = Math.max(0, requests - recorded);
  return methods;
}

function metricLatencyDistribution(
  row: Record<string, unknown>,
  requests: number,
): Record<string, number | string | null>[] {
  const columns = [
    "latency_le_50",
    "latency_le_100",
    "latency_le_250",
    "latency_le_500",
    "latency_le_1000",
    "latency_le_2500",
    "latency_le_5000",
  ];
  const output: Record<string, number | string | null>[] = [];
  let previous = 0;
  for (let index = 0; index < columns.length; index++) {
    const cumulative = Math.max(previous, Math.min(requests, Number(row[columns[index]!] ?? 0)));
    const count = cumulative - previous;
    output.push({
      label: `≤ ${formatMetricLatencyBound(LATENCY_BOUNDS_MS[index]!)}`,
      upToMs: LATENCY_BOUNDS_MS[index]!,
      requests: count,
      rate: requests ? count / requests : 0,
    });
    previous = cumulative;
  }
  const overflow = Math.max(0, requests - previous);
  output.push({
    label: "> 5 s",
    upToMs: null,
    requests: overflow,
    rate: requests ? overflow / requests : 0,
  });
  return output;
}

function formatMetricLatencyBound(value: number): string {
  return value >= 1_000 ? `${value / 1_000} s` : `${value} ms`;
}

function histogramPercentile(row: Record<string, unknown>, requests: number, percentile: number): number {
  if (requests <= 0) return 0;
  const target = requests * percentile;
  const columns = [
    "latency_le_50",
    "latency_le_100",
    "latency_le_250",
    "latency_le_500",
    "latency_le_1000",
    "latency_le_2500",
    "latency_le_5000",
  ];
  for (let index = 0; index < columns.length; index++) {
    if (Number(row[columns[index]!] ?? 0) >= target) return LATENCY_BOUNDS_MS[index]!;
  }
  return Math.max(5_000, Number(row.duration_max_ms ?? 0));
}

interface DomainRoutingWriteOptions {
  nextCheckAt?: number;
  leaseToken?: string;
}

function saveDomainRouting(
  internal: SQLiteInternal,
  id: string,
  report: DomainRoutingReport,
  options: DomainRoutingWriteOptions = {},
): boolean {
  const error = report.error
    ?? (report.status === "misconfigured" ? "DNS does not point to the configured Clank edge." : null);
  const result = internal.prepare(`UPDATE clank_platform_domains SET
      routing_status = ?, resolved_records = ?, last_checked_at = ?, last_error = ?,
      next_check_at = ?, check_lease_token = NULL, check_lease_until = NULL,
      certificate_status = CASE
        WHEN status = 'verified' AND ? = 'ready' AND certificate_status = 'active' THEN 'active'
        WHEN status = 'verified' AND ? = 'ready' THEN 'eligible'
        ELSE 'pending'
      END
    WHERE id = ?${options.leaseToken ? " AND check_lease_token = ?" : ""}`).run(
      report.status,
      JSON.stringify(report.observed),
      report.checkedAt,
      error,
      options.nextCheckAt ?? null,
      report.status,
      report.status,
      id,
      ...(options.leaseToken ? [options.leaseToken] : []),
    );
  return Number(result.changes) === 1;
}

function saveDomainRoutingError(
  internal: SQLiteInternal,
  id: string,
  options: DomainRoutingWriteOptions = {},
): boolean {
  const result = internal.prepare(`UPDATE clank_platform_domains SET routing_status = 'error', certificate_status = 'pending',
    last_checked_at = ?, last_error = ?, next_check_at = ?, check_lease_token = NULL, check_lease_until = NULL
    WHERE id = ?${options.leaseToken ? " AND check_lease_token = ?" : ""}`)
    .run(
      Date.now(),
      "DNS lookup is temporarily unavailable.",
      options.nextCheckAt ?? null,
      id,
      ...(options.leaseToken ? [options.leaseToken] : []),
    );
  return Number(result.changes) === 1;
}

function claimDomainsForRecheck(
  internal: SQLiteInternal,
  now: number,
  batchSize: number,
  leaseMs: number,
): Array<{ id: string; token: string }> {
  return internal.transaction(() => {
    const candidates = internal.prepare(`SELECT id FROM clank_platform_domains
      WHERE (status = 'verified' OR expires_at > ?)
        AND coalesce(next_check_at, 0) <= ?
        AND (check_lease_until IS NULL OR check_lease_until <= ?)
      ORDER BY coalesce(next_check_at, 0), created_at
      LIMIT ?`).all(now, now, now, batchSize);
    const claimed: Array<{ id: string; token: string }> = [];
    for (const candidate of candidates) {
      const id = String(candidate.id);
      const token = `dns_${crypto.randomUUID()}`;
      const result = internal.prepare(`UPDATE clank_platform_domains
        SET check_lease_token = ?, check_lease_until = ?
        WHERE id = ? AND (check_lease_until IS NULL OR check_lease_until <= ?)`)
        .run(token, now + leaseMs, id, now);
      if (Number(result.changes) === 1) claimed.push({ id, token });
    }
    return claimed;
  });
}

async function runBounded<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  worker: (input: Input) => Promise<Output>,
  stopped: () => boolean,
): Promise<Output[]> {
  const output: Output[] = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (!stopped()) {
      const index = cursor++;
      if (index >= inputs.length) return;
      output.push(await worker(inputs[index]!));
    }
  });
  await Promise.all(runners);
  return output;
}

async function withTimeout<Value>(operation: Promise<Value>, timeoutMs: number, message: string): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function publicDomain(
  row: Record<string, unknown>,
  customDomainTarget: string | undefined,
  customDomainAddresses: readonly string[],
): Record<string, unknown> {
  let observed: { cnames: string[]; addresses: string[] } = { cnames: [], addresses: [] };
  try {
    const parsed = JSON.parse(String(row.resolved_records ?? "{}"));
    if (parsed && typeof parsed === "object") {
      observed = {
        cnames: Array.isArray(parsed.cnames) ? parsed.cnames.map(String).slice(0, 32) : [],
        addresses: Array.isArray(parsed.addresses) ? parsed.addresses.map(String).slice(0, 32) : [],
      };
    }
  } catch { /* Preserve an empty, safe observation. */ }
  const ownershipStatus = String(row.status);
  const routingStatus = String(row.routing_status ?? "pending");
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    hostname: String(row.hostname),
    status: ownershipStatus === "verified" && routingStatus === "ready" ? "ready" : "pending",
    ownership: {
      status: ownershipStatus,
      record: { name: String(row.record_name), type: "TXT", value: String(row.record_value) },
      expiresAt: Number(row.expires_at),
      verifiedAt: row.verified_at === null ? null : Number(row.verified_at),
    },
    routing: {
      status: routingStatus,
      recommendedRecord: customDomainTarget
        ? { name: String(row.hostname), type: "CNAME", value: customDomainTarget }
        : null,
      edgeAddresses: customDomainAddresses,
      observed,
      checkedAt: row.last_checked_at === null || row.last_checked_at === undefined
        ? null
        : Number(row.last_checked_at),
      error: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    },
    certificate: { status: String(row.certificate_status ?? "pending"), mode: "edge-managed" },
    recordName: String(row.record_name),
    recordType: "TXT",
    recordValue: String(row.record_value),
    expiresAt: Number(row.expires_at),
    verifiedAt: row.verified_at === null ? null : Number(row.verified_at),
    createdAt: Number(row.created_at),
  };
}

function quotaOverrides(
  internal: SQLiteInternal,
  scopeType: PlatformQuotaScope,
  scopeId: string,
): Partial<PlatformQuotaValues> {
  const result: Partial<PlatformQuotaValues> = {};
  const rows = internal.prepare(`SELECT quota_key, quota_value
    FROM clank_platform_quota_overrides
    WHERE scope_type = ? AND scope_id = ?`).all(scopeType, scopeId);
  for (const row of rows) {
    const key = String(row.quota_key) as PlatformQuotaKey;
    if (!PLATFORM_QUOTA_KEYS.includes(key)) continue;
    const value = Number(row.quota_value);
    const definition = PLATFORM_QUOTA_DEFINITIONS[key];
    if (Number.isSafeInteger(value)
      && value >= definition.minimum
      && value <= definition.maximum) {
      result[key] = value;
    }
  }
  return result;
}

function accountQuotas(
  internal: SQLiteInternal,
  accountId: string,
  defaults: PlatformQuotaValues,
): PlatformQuotaValues {
  return { ...defaults, ...quotaOverrides(internal, "account", accountId) };
}

function workspaceQuotas(
  internal: SQLiteInternal,
  workspaceId: string,
  defaults: PlatformQuotaValues,
): PlatformQuotaValues {
  const workspace = internal.prepare(
    "SELECT created_by FROM clank_platform_organizations WHERE id = ?",
  ).get(workspaceId);
  if (!workspace) throw new PlatformError(404, "ORGANIZATION_NOT_FOUND", "Workspace not found.");
  return {
    ...accountQuotas(internal, String(workspace.created_by), defaults),
    ...quotaOverrides(internal, "workspace", workspaceId),
  };
}

function projectQuotas(
  internal: SQLiteInternal,
  project: ProjectRow,
  defaults: PlatformQuotaValues,
): PlatformQuotaValues {
  return project.organizationId
    ? workspaceQuotas(internal, project.organizationId, defaults)
    : accountQuotas(internal, project.ownerId, defaults);
}

function publicQuotaDefinitions(): Record<string, unknown>[] {
  return PLATFORM_QUOTA_KEYS.map((key) => ({
    key,
    ...PLATFORM_QUOTA_DEFINITIONS[key],
    scopes: WORKSPACE_QUOTA_KEYS.includes(key as typeof WORKSPACE_QUOTA_KEYS[number])
      ? ["account", "workspace"]
      : ["account"],
  }));
}

function publicLimits(
  limits: PlatformQuotaValues,
  maxArtifactBytes?: number,
  metricRetentionDays?: number,
): Record<string, number> {
  return {
    organizationsPerAccount: limits.organizationsPerAccount,
    projectsPerAccount: limits.projectsPerAccount,
    projectsPerOrganization: limits.projectsPerOrganization,
    domainsPerProject: limits.domainsPerProject,
    metricRetentionDays: metricRetentionDays ?? 30,
    releasesPerProject: limits.releasesPerProject,
    releaseStorageBytesPerProject: limits.releaseStorageBytesPerProject,
    backupsPerProject: limits.backupsPerProject,
    maxArtifactBytes: maxArtifactBytes ?? 100 * 1024 * 1024,
  };
}

function dashboardPayload(
  internal: SQLiteInternal,
  principal: TokenPrincipal,
  active: ReadonlyMap<string, ActiveProcess>,
  appUrlTemplate: string,
  defaults: PlatformQuotaValues,
  metricRetentionDays: number,
  maxArtifactBytes: number | undefined,
  customDomainTarget: string | undefined,
  customDomainAddresses: readonly string[],
  automaticTls: boolean,
  domainAutomation: Readonly<{
    enabled: boolean;
    intervalMs: number | null;
    batchSize: number;
    timeoutMs: number;
    lastStartedAt: number | null;
    lastCompletedAt: number | null;
    lastChecked: number;
    lastFailed: number;
  }>,
): Record<string, unknown> {
  const accountLimits = accountQuotas(internal, principal.userId, defaults);
  const organizationRows = principal.organizationId
    ? internal.prepare(`SELECT o.id, o.name, o.slug, o.created_at, o.updated_at, m.role,
        (SELECT count(*) FROM clank_platform_projects p WHERE p.organization_id = o.id) AS project_count
      FROM clank_platform_organizations o
      JOIN clank_platform_memberships m ON m.organization_id = o.id
      WHERE m.user_id = ? AND o.id = ? ORDER BY o.created_at`).all(principal.userId, principal.organizationId)
    : internal.prepare(`SELECT o.id, o.name, o.slug, o.created_at, o.updated_at, m.role,
        (SELECT count(*) FROM clank_platform_projects p WHERE p.organization_id = o.id) AS project_count
      FROM clank_platform_organizations o
      JOIN clank_platform_memberships m ON m.organization_id = o.id
      WHERE m.user_id = ? ORDER BY o.created_at`).all(principal.userId);
  const organizations = organizationRows.map((row) => {
    const effective = workspaceQuotas(internal, String(row.id), defaults);
    return {
      id: String(row.id),
      name: String(row.name),
      slug: String(row.slug),
      role: String(row.role),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      usage: { projects: Number(row.project_count), limit: effective.projectsPerOrganization },
    };
  });
  const projectRows = principal.projectId
    ? internal.prepare(`SELECT p.* FROM clank_platform_projects p
        JOIN clank_platform_memberships m ON m.organization_id = p.organization_id
        WHERE p.id = ? AND m.user_id = ?`).all(principal.projectId, principal.userId)
    : internal.prepare(`SELECT DISTINCT p.* FROM clank_platform_projects p
        LEFT JOIN clank_platform_memberships m
          ON m.organization_id = p.organization_id AND m.user_id = ?
        WHERE m.user_id IS NOT NULL OR p.owner_id = ? ORDER BY p.created_at`).all(principal.userId, principal.userId);
  const projects = projectRows.map((source) => {
    const project = projectRow(source);
    const effective = projectQuotas(internal, project, defaults);
    const release = project.activeReleaseId ? releaseById(internal, project.activeReleaseId) : null;
    const domainUsage = internal.prepare(`SELECT count(*) AS count,
      sum(CASE WHEN status = 'verified' AND routing_status = 'ready' THEN 1 ELSE 0 END) AS ready
      FROM clank_platform_domains WHERE project_id = ?`).get(project.id);
    const releases = releaseStorageUsage(internal, project.id);
    const metrics = metricSeries(internal, project.id, "24h").summary as Record<string, number>;
    return {
      ...projectPayload(project),
      url: appUrlTemplate.replaceAll("{slug}", project.slug)
        .replaceAll("{port}", String(active.get(project.id)?.port ?? project.port)),
      directUrl: `http://127.0.0.1:${active.get(project.id)?.port ?? project.port}`,
      runtimeStatus: active.has(project.id) ? "online" : release ? "degraded" : "not_deployed",
      activeRelease: release ? publicRelease(release) : null,
      domains: { count: Number(domainUsage?.count ?? 0), ready: Number(domainUsage?.ready ?? 0), limit: effective.domainsPerProject },
      releases: {
        ...releases,
        limit: effective.releasesPerProject,
        storageLimitBytes: effective.releaseStorageBytesPerProject,
      },
      metrics,
    };
  });
  const metricTotals = projects.reduce((total, project) => {
    const metrics = project.metrics as Record<string, number>;
    total.requests += metrics.requests ?? 0;
    total.errors += metrics.errors ?? 0;
    total.bandwidthBytes += metrics.bandwidthBytes ?? 0;
    return total;
  }, { requests: 0, errors: 0, bandwidthBytes: 0 });
  const ownedUsage = internal.prepare(`SELECT
      (SELECT count(*) FROM clank_platform_organizations WHERE created_by = ?) AS organizations,
      (SELECT count(*) FROM clank_platform_projects WHERE owner_id = ?) AS projects`)
    .get(principal.userId, principal.userId);
  const platformAccount = internal.prepare(
    "SELECT role FROM clank_auth_users WHERE id = ? AND disabled = 0",
  ).get(principal.userId);
  return {
    ok: true,
    account: {
      id: principal.userId,
      email: principal.email,
      platformRole: String(platformAccount?.role ?? "user"),
      impersonation: principal.impersonation ? {
        id: principal.impersonation.id,
        actor: {
          id: principal.impersonation.actorUserId,
          email: principal.impersonation.actorEmail,
        },
        reason: principal.impersonation.reason,
        createdAt: principal.impersonation.createdAt,
        expiresAt: principal.impersonation.expiresAt,
        readOnly: true,
      } : null,
      usage: {
        organizations: Number(ownedUsage?.organizations ?? 0),
        projects: Number(ownedUsage?.projects ?? 0),
      },
    },
    limits: publicLimits(accountLimits, maxArtifactBytes, metricRetentionDays),
    organizations,
    projects,
    totals: {
      projects: projects.length,
      online: projects.filter((project) => project.runtimeStatus === "online").length,
      requests: metricTotals.requests,
      errors: metricTotals.errors,
      errorRate: metricTotals.requests ? metricTotals.errors / metricTotals.requests : 0,
      bandwidthBytes: metricTotals.bandwidthBytes,
    },
    domains: {
      cnameTarget: customDomainTarget ?? null,
      addresses: customDomainAddresses,
      automaticTls,
      automation: { ...domainAutomation },
    },
  };
}

function publicRelease(release: ReleaseRow): Record<string, unknown> {
  return {
    id: release.id,
    previousReleaseId: release.previousReleaseId,
    status: release.status,
    digest: release.digest,
    artifactBytes: release.artifactBytes,
    storageBytes: release.storageBytes,
    artifactAvailable: release.artifactAvailable,
    runnerArtifact: {
      bytes: release.runnerArtifactBytes,
      storage: release.runnerArtifactBytes === 0
        ? "none"
        : release.runnerArtifactStore === "local"
          ? "local"
          : "object",
    },
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
  directPort = project.port,
): Record<string, unknown> {
  return {
    ...publicRelease(release),
    project: projectPayload(project),
    url: appUrlTemplate.replaceAll("{slug}", project.slug).replaceAll("{port}", String(directPort)),
    directUrl: `http://127.0.0.1:${directPort}`,
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
  const projectOrganization = projectId === null
    ? null
    : internal.prepare("SELECT organization_id FROM clank_platform_projects WHERE id = ?").get(projectId);
  const organizationId = projectOrganization?.organization_id === null
    || projectOrganization?.organization_id === undefined
    ? typeof metadata.organizationId === "string"
      ? metadata.organizationId
      : null
    : String(projectOrganization.organization_id);
  internal.prepare(`INSERT INTO clank_platform_audit
    (actor_user_id, actor_token_id, project_id, organization_id, action, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, tokenId, projectId, organizationId, action, JSON.stringify(metadata), Date.now());
}

function workspaceAuditEvents(
  internal: SQLiteInternal,
  principal: TokenPrincipal,
  limit: number,
  before: number | null,
  organizationId: string | null,
): { events: Record<string, unknown>[]; nextBefore: number | null } {
  let rows: Record<string, unknown>[];
  if (principal.projectId) {
    accessibleProject(internal, principal.projectId, principal, "audit");
    rows = internal.prepare(`SELECT a.id, a.organization_id, a.project_id, a.action, a.metadata,
      a.created_at, a.actor_user_id, a.actor_token_id, u.email AS actor_email,
        NULL AS reader_role,
        o.name AS organization_name, o.slug AS organization_slug,
        p.id AS live_project_id,
        COALESCE(p.name, (
          SELECT json_extract(history.metadata, '$.name')
          FROM clank_platform_audit history
          WHERE history.project_id = a.project_id
            AND json_type(history.metadata, '$.name') = 'text'
          ORDER BY history.id DESC LIMIT 1
        )) AS project_name,
        COALESCE(p.slug, (
          SELECT json_extract(history.metadata, '$.slug')
          FROM clank_platform_audit history
          WHERE history.project_id = a.project_id
            AND json_type(history.metadata, '$.slug') = 'text'
          ORDER BY history.id DESC LIMIT 1
        )) AS project_slug
      FROM clank_platform_audit a
      LEFT JOIN clank_auth_users u ON u.id = a.actor_user_id
      LEFT JOIN clank_platform_organizations o ON o.id = a.organization_id
      LEFT JOIN clank_platform_projects p ON p.id = a.project_id
      WHERE a.project_id = ? AND (? IS NULL OR a.id < ?)
      ORDER BY a.id DESC LIMIT ?`)
      .all(principal.projectId, before, before, limit);
  } else {
    rows = internal.prepare(`SELECT a.id, a.organization_id, a.project_id, a.action, a.metadata,
      a.created_at, a.actor_user_id, a.actor_token_id, u.email AS actor_email,
        m.role AS reader_role,
        o.name AS organization_name, o.slug AS organization_slug,
        p.id AS live_project_id,
        COALESCE(p.name, (
          SELECT json_extract(history.metadata, '$.name')
          FROM clank_platform_audit history
          WHERE history.project_id = a.project_id
            AND json_type(history.metadata, '$.name') = 'text'
          ORDER BY history.id DESC LIMIT 1
        )) AS project_name,
        COALESCE(p.slug, (
          SELECT json_extract(history.metadata, '$.slug')
          FROM clank_platform_audit history
          WHERE history.project_id = a.project_id
            AND json_type(history.metadata, '$.slug') = 'text'
          ORDER BY history.id DESC LIMIT 1
        )) AS project_slug
      FROM clank_platform_audit a
      JOIN clank_platform_memberships m
        ON m.organization_id = a.organization_id AND m.user_id = ?
      LEFT JOIN clank_auth_users u ON u.id = a.actor_user_id
      LEFT JOIN clank_platform_organizations o ON o.id = a.organization_id
      LEFT JOIN clank_platform_projects p ON p.id = a.project_id
      WHERE m.role IN ('owner', 'admin', 'developer')
        AND (? IS NULL OR a.organization_id = ?)
        AND (? IS NULL OR a.id < ?)
      ORDER BY a.id DESC LIMIT ?`)
      .all(principal.userId, organizationId, organizationId, before, before, limit);
  }
  const events = rows.map((row) => {
    const metadata = JSON.parse(String(row.metadata)) as Record<string, unknown>;
    const action = String(row.action);
    if (row.reader_role === "developer" && action.startsWith("invitation.")) {
      delete metadata.email;
    }
    const projectId = row.project_id === null ? null : String(row.project_id);
    const projectName = row.project_name === null || row.project_name === undefined
      ? typeof metadata.name === "string"
        ? metadata.name
        : typeof metadata.slug === "string"
          ? metadata.slug
          : projectId
      : String(row.project_name);
    return {
      id: Number(row.id),
      organization: row.organization_id === null ? null : {
        id: String(row.organization_id),
        name: row.organization_name === null ? String(row.organization_id) : String(row.organization_name),
        slug: row.organization_slug === null ? null : String(row.organization_slug),
      },
      project: projectId === null ? null : {
        id: projectId,
        name: projectName,
        slug: row.project_slug === null || row.project_slug === undefined
          ? typeof metadata.slug === "string" ? metadata.slug : null
          : String(row.project_slug),
        deleted: row.live_project_id === null || row.live_project_id === undefined,
      },
      action,
      metadata,
      createdAt: Number(row.created_at),
      actor: {
        id: String(row.actor_user_id),
        email: row.actor_email === null ? null : String(row.actor_email),
        tokenId: row.actor_token_id === null ? null : String(row.actor_token_id),
      },
    };
  });
  return {
    events,
    nextBefore: events.length === limit ? Number(events.at(-1)!.id) : null,
  };
}

async function registerWithInvitation(
  storage: PlatformDatabase,
  request: Request,
  authPrefix: string,
): Promise<Response> {
  if (!requestOriginAllowed(request)) {
    throw new PlatformError(403, "ORIGIN_MISMATCH", "Cross-origin auth request rejected.");
  }
  const input = plainObject(await readJsonRequest(request, 24 * 1024));
  exact(input, ["token", "email", "password", "profile"]);
  const token = boundedString(input.token, "token", 20, 300);
  const email = normalizeEmail(input.email);
  const now = Date.now();
  const workspaceInvitation = storage.internal.prepare(`SELECT id, organization_id, email, role
    FROM clank_platform_invitations
    WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
    .get(syncHash(token), now);
  const personalInvitation = workspaceInvitation
    ? undefined
    : storage.internal.prepare(`SELECT id, email
        FROM clank_platform_personal_invitations
        WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
      .get(syncHash(token), now);
  const invitation = workspaceInvitation ?? personalInvitation;
  if (!invitation || String(invitation.email).toLowerCase() !== email) {
    throw new PlatformError(400, "INVALID_INVITATION", "Invitation is invalid or expired.");
  }
  const invitationScope = workspaceInvitation ? "workspace" : "personal";
  const role = workspaceInvitation
    ? validateOrganizationRole(String(workspaceInvitation.role), false)
    : null;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  const registerUrl = new URL(request.url);
  registerUrl.pathname = `${authPrefix}/register`;
  registerUrl.search = "";
  const registration = await storage.auth.handle(new Request(registerUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email,
      password: input.password,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
    }),
  }), authPrefix);
  if (registration.status !== 201) return registration;
  const payload = plainObject(await registration.clone().json());
  const user = plainObject(payload.user);
  const userId = boundedString(user.id, "registered user id", 8, 128);
  if (normalizeEmail(user.email) !== email) {
    removeNewPlatformAccount(storage, userId);
    throw new Error("Invitation registration returned an unexpected account.");
  }
  try {
    storage.internal.transaction((changes) => {
      const accepted = workspaceInvitation
        ? storage.internal.prepare(`UPDATE clank_platform_invitations SET accepted_at = ?
            WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
          .run(Date.now(), workspaceInvitation.id, Date.now())
        : storage.internal.prepare(`UPDATE clank_platform_personal_invitations SET accepted_at = ?
            WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
          .run(Date.now(), personalInvitation!.id, Date.now());
      if (Number(accepted.changes) !== 1) {
        throw new PlatformError(409, "INVITATION_USED", "Invitation was already handled.");
      }
      if (workspaceInvitation) {
        storage.internal.prepare(`INSERT INTO clank_platform_memberships
          (organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
          .run(workspaceInvitation.organization_id, userId, role, now, now);
        changes.record("__platform", String(workspaceInvitation.organization_id));
      } else {
        changes.record("__platform", userId);
      }
    });
  } catch (error) {
    removeNewPlatformAccount(storage, userId);
    if (error instanceof PlatformError) return problem(error.status, error.code, error.message);
    throw error;
  }
  audit(
    storage.internal,
    userId,
    null,
    null,
    workspaceInvitation ? "invitation.accept" : "personal_invitation.accept",
    {
      ...(workspaceInvitation
        ? { organizationId: String(workspaceInvitation.organization_id) }
        : { scope: "personal" }),
      invitationId: String(invitation.id),
    },
  );
  return new Response(JSON.stringify({
    ...payload,
    invitationScope,
    organizationId: workspaceInvitation ? String(workspaceInvitation.organization_id) : null,
    role,
  }), {
    status: 201,
    headers: registration.headers,
  });
}

function claimBootstrapRegistration(
  storage: PlatformDatabase,
  claimId: string,
): "acquired" | "registered" | "busy" {
  return storage.internal.transaction(() => {
    const userCount = Number(storage.internal.prepare(
      "SELECT count(*) AS count FROM clank_auth_users",
    ).get()?.count ?? 0);
    if (userCount > 0) return "registered";
    const now = Date.now();
    storage.internal.prepare(
      "DELETE FROM clank_platform_bootstrap_claim WHERE singleton = 1 AND expires_at <= ?",
    ).run(now);
    const inserted = storage.internal.prepare(`INSERT INTO clank_platform_bootstrap_claim
      (singleton, claim_id, expires_at) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO NOTHING`)
      .run(claimId, now + BOOTSTRAP_CLAIM_MS);
    return Number(inserted.changes) === 1 ? "acquired" : "busy";
  });
}

async function retainBootstrapWinner(
  storage: PlatformDatabase,
  response: Response,
): Promise<Response> {
  const payload = plainObject(await response.clone().json());
  const user = plainObject(payload.user);
  const userId = boundedString(user.id, "registered user id", 8, 128);
  const winner = storage.internal.prepare(
    "SELECT id FROM clank_auth_users ORDER BY rowid LIMIT 1",
  ).get();
  if (winner && String(winner.id) === userId) return response;
  removeNewPlatformAccount(storage, userId);
  return problem(409, "SIGNUP_IN_PROGRESS", "Another account completed bootstrap registration.");
}

function removeNewPlatformAccount(storage: PlatformDatabase, userId: string): void {
  storage.internal.transaction((changes) => {
    const removed = storage.internal.prepare("DELETE FROM clank_auth_users WHERE id = ?").run(userId);
    if (Number(removed.changes) === 1) changes.record("__auth", userId, userId);
  });
  storage.auth.notifyUserChange(userId as AuthUserId);
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

function apiWithCookie(value: unknown, cookie: string, status = 200): Response {
  const response = api(value, status);
  response.headers.append("set-cookie", cookie);
  return response;
}

function problem(status: number, code: string, message: string, retryAfter?: number): Response {
  return api({ ok: false, error: { code, message, ...(retryAfter ? { retryAfter } : {}) } }, status);
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
  launch: {
    entry: string;
    role: "web" | "worker" | "scheduler";
    instance: number;
    exposePort: boolean;
  },
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
      "--name", `clank-${release.projectId.slice(0, 12)}-${release.id.slice(0, 8)}-${launch.role}-${launch.instance}`,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit", String(runner.pidsLimit ?? 128),
      "--memory", runner.memory ?? "512m",
      "--cpus", runner.cpus ?? "1",
      "--user", `${String((globalThis as any).process.getuid?.() ?? 65532)}:${String((globalThis as any).process.getgid?.() ?? 65532)}`,
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      ...(launch.exposePort ? ["-p", `127.0.0.1:${port}:${port}`] : []),
      "-v", `${path.resolve(release.directory)}:/app:ro`,
      "-v", `${path.resolve(dataRoot)}:/data:rw`,
      "-w", "/app",
      ...Object.keys(dockerEnvironment).flatMap((name) => ["-e", name]),
      runner.image ?? "node:22-bookworm-slim",
      "node", "--disable-warning=ExperimentalWarning", launch.entry,
    ];
    return spawn(runner.executable ?? "docker", args, {
      env: {
        ...(globalThis as any).process.env,
        ...dockerEnvironment,
        PATH: (globalThis as any).process.env.PATH ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const launcher = await writeReleaseLauncher(
    release.directory,
    launch.entry,
    `${launch.role}-${launch.instance}`,
  );
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

async function writeReleaseLauncher(directory: string, entry: string, suffix = "web-0"): Promise<string> {
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    writeFile(path: string, value: string, options: { mode: number }): Promise<void>;
  };
  const path = await import(pathName) as unknown as { join(...segments: string[]): string };
  const launcher = path.join(directory, `.clank-launch-${suffix}.mjs`);
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
  for (const value of Object.values(secrets).filter(Boolean).sort((left, right) => right.length - left.length)) {
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

function releaseStorageUsage(
  internal: SQLiteInternal,
  projectId: string,
  excludeReleaseId?: string,
): { releases: number; storageBytes: number } {
  const row = excludeReleaseId
    ? internal.prepare(`SELECT
        sum(CASE WHEN artifact_available = 1 THEN 1 ELSE 0 END) AS releases,
        sum(CASE WHEN artifact_available = 1 THEN storage_bytes ELSE 0 END) AS storage_bytes
      FROM clank_platform_releases WHERE project_id = ? AND id <> ?`).get(projectId, excludeReleaseId)
    : internal.prepare(`SELECT
        sum(CASE WHEN artifact_available = 1 THEN 1 ELSE 0 END) AS releases,
        sum(CASE WHEN artifact_available = 1 THEN storage_bytes ELSE 0 END) AS storage_bytes
      FROM clank_platform_releases WHERE project_id = ?`).get(projectId);
  return {
    releases: Number(row?.releases ?? 0),
    storageBytes: Number(row?.storage_bytes ?? 0),
  };
}

function projectDeletionSummary(
  internal: SQLiteInternal,
  projectId: string,
): {
  domains: number;
  releases: number;
  secrets: number;
  logs: number;
  metrics: number;
  backupSchedules: number;
} {
  const row = internal.prepare(`SELECT
      (SELECT count(*) FROM clank_platform_domains WHERE project_id = ?) AS domains,
      (SELECT count(*) FROM clank_platform_releases WHERE project_id = ?) AS releases,
      (SELECT count(*) FROM clank_platform_secrets WHERE project_id = ?) AS secrets,
      (SELECT count(*) FROM clank_platform_logs WHERE project_id = ?) AS logs,
      (SELECT count(*) FROM clank_platform_metrics WHERE project_id = ?) AS metrics,
      (SELECT count(*) FROM clank_platform_backup_schedules WHERE project_id = ?) AS backup_schedules`)
    .get(projectId, projectId, projectId, projectId, projectId, projectId);
  return {
    domains: Number(row?.domains ?? 0),
    releases: Number(row?.releases ?? 0),
    secrets: Number(row?.secrets ?? 0),
    logs: Number(row?.logs ?? 0),
    metrics: Number(row?.metrics ?? 0),
    backupSchedules: Number(row?.backup_schedules ?? 0),
  };
}

function assertReleaseCapacity(
  internal: SQLiteInternal,
  projectId: string,
  nextStorageBytes: number,
  limits: Pick<PlatformQuotaValues, "releasesPerProject" | "releaseStorageBytesPerProject">,
  excludeReleaseId?: string,
): void {
  const usage = releaseStorageUsage(internal, projectId, excludeReleaseId);
  if (usage.releases + 1 > limits.releasesPerProject) {
    throw new PlatformError(
      409,
      "RELEASE_LIMIT_REACHED",
      `This site has reached its ${limits.releasesPerProject}-release artifact limit. Remove an inactive release before deploying again.`,
    );
  }
  if (usage.storageBytes + nextStorageBytes > limits.releaseStorageBytesPerProject) {
    throw new PlatformError(
      409,
      "RELEASE_STORAGE_LIMIT_REACHED",
      `This deployment would exceed the site's ${limits.releaseStorageBytesPerProject}-byte release storage limit. Remove an inactive release before deploying again.`,
    );
  }
}

async function projectDatabaseFootprint(
  projectsRoot: string,
  project: ProjectRow,
  configuredPath: string,
): Promise<number> {
  const dataRoot = await projectDataDirectory(projectsRoot, project.id);
  const databasePath = await safeProjectDataPath(dataRoot, project.databasePath ?? configuredPath);
  return await regularFileBytes(databasePath, true)
    + await regularFileBytes(`${databasePath}-wal`, true)
    + await regularFileBytes(`${databasePath}-shm`, true);
}

async function regularFileBytes(path: string, missingAllowed = false): Promise<number> {
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    lstat(path: string): Promise<{ size: number; isFile(): boolean; isSymbolicLink(): boolean }>;
  };
  try {
    const stats = await fs.lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Release storage input must be a regular file.");
    }
    if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
      throw new Error("Release storage input has an invalid size.");
    }
    return stats.size;
  } catch (error) {
    if (missingAllowed && (error as { code?: string }).code === "ENOENT") return 0;
    throw error;
  }
}

async function projectBackupManager(
  projectsRoot: string,
  project: ProjectRow,
  masterKey: Uint8Array,
  policy: PlatformBackupPolicy,
  objects: PlatformBackupObjects | null,
) {
  if (!project.databasePath) {
    throw new PlatformError(409, "DATABASE_UNAVAILABLE", "Deploy the project before creating a database backup.");
  }
  const pathName = "node:path";
  const path = await import(pathName) as unknown as { join(...segments: string[]): string };
  const dataRoot = await projectDataDirectory(projectsRoot, project.id);
  const databasePath = await safeProjectDataPath(dataRoot, project.databasePath);
  const material = new Uint8Array(masterKey.byteLength + project.id.length);
  material.set(masterKey);
  material.set(new TextEncoder().encode(project.id), masterKey.byteLength);
  const encryptionKey = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  return openBackupManager({
    databasePath,
    repositoryDirectory: path.join(projectsRoot, project.id, "recovery"),
    encryptionKey,
    keyId: `project-${project.id.slice(0, 12)}`,
    maxBackups: policy.maxBackups,
    maxAgeMs: policy.maxAgeMs,
    maxDatabaseBytes: policy.maxDatabaseBytes,
    verifyAfterCreate: true,
    ...(objects
      ? {
          objects: {
            ...objects,
            repositoryId: project.id,
          },
        }
      : {}),
  });
}

function publicBackupManifest(backup: BackupManifest): Omit<BackupManifest, "source"> {
  const { source: _privateDatabasePath, ...manifest } = backup;
  return manifest;
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

interface RunnerArtifactObjects {
  namespace: string;
  store: ObjectStore;
}

type PlatformBackupObjects = Omit<BackupObjectRepositoryOptions, "repositoryId">;

function normalizePlatformBackupObjects(
  configured: Omit<BackupObjectRepositoryOptions, "repositoryId"> | undefined,
): PlatformBackupObjects | null {
  if (!configured) return null;
  const namespace = boundedString(configured.namespace, "backups.objects.namespace", 1, 128);
  if (
    namespace === "local"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(namespace)
  ) {
    throw new TypeError(
      "backups.objects.namespace must be a portable non-local identifier.",
    );
  }
  const store = configured.store;
  if (
    !store
    || typeof store !== "object"
    || typeof store.put !== "function"
    || typeof store.get !== "function"
    || typeof store.stat !== "function"
    || typeof store.delete !== "function"
  ) {
    throw new TypeError("backups.objects.store must implement ObjectStore.");
  }
  const prefix = configured.prefix === undefined
    ? undefined
    : boundedString(configured.prefix, "backups.objects.prefix", 1, 384);
  if (prefix !== undefined) {
    const segments = prefix.split("/");
    if (segments.some((segment) =>
      segment.length < 1
      || segment.length > 100
      || segment === "."
      || segment === ".."
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment))) {
      throw new TypeError("backups.objects.prefix must contain portable path segments.");
    }
  }
  const chunkBytes = configured.chunkBytes === undefined
    ? undefined
    : integerInRange(
        configured.chunkBytes,
        "backups.objects.chunkBytes",
        64 * 1024,
        64 * 1024 * 1024,
      );
  return Object.freeze({
    store,
    namespace,
    ...(prefix === undefined ? {} : { prefix }),
    ...(chunkBytes === undefined ? {} : { chunkBytes }),
  });
}

function reconcileBackupObjectBinding(
  internal: SQLiteInternal,
  objects: PlatformBackupObjects | null,
): void {
  const row = internal.prepare(
    "SELECT namespace, object_root FROM clank_platform_storage_bindings WHERE purpose = 'backups'",
  ).get();
  const existing = row?.namespace === undefined ? null : String(row.namespace);
  const existingRoot = row?.object_root === undefined ? null : String(row.object_root);
  const configuredRoot = objects?.prefix ?? "backups";
  if (!objects) {
    if (existing) {
      throw new TypeError(
        `Encrypted backups are bound to object repository "${existing}". `
        + "Restore the matching backups.objects configuration before starting the platform.",
      );
    }
    return;
  }
  if (existing && existing !== objects.namespace) {
    throw new TypeError(
      `Encrypted backups are bound to object repository "${existing}", not "${objects.namespace}".`,
    );
  }
  if (existingRoot && existingRoot !== configuredRoot) {
    throw new TypeError(
      `Encrypted backups are bound to object root "${existingRoot}", not "${configuredRoot}".`,
    );
  }
  if (!existing) {
    internal.prepare(`INSERT INTO clank_platform_storage_bindings
      (purpose, namespace, object_root, created_at) VALUES ('backups', ?, ?, ?)`)
      .run(objects.namespace, configuredRoot, Date.now());
  }
}

interface RunnerArtifactDescriptor {
  projectId: string;
  releaseId: string;
  digest: string;
  bytes: number;
  store: string;
  key: string | null;
}

function normalizeRunnerArtifactObjects(
  configured: { namespace: string; store: ObjectStore } | undefined,
): RunnerArtifactObjects | null {
  if (!configured) return null;
  const namespace = boundedString(configured.namespace, "deploymentAgents.artifacts.namespace", 1, 128);
  if (
    namespace === "local"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(namespace)
  ) {
    throw new TypeError(
      "deploymentAgents.artifacts.namespace must be a portable non-local identifier.",
    );
  }
  const store = configured.store;
  if (
    !store
    || typeof store !== "object"
    || typeof store.put !== "function"
    || typeof store.get !== "function"
    || typeof store.stat !== "function"
    || typeof store.delete !== "function"
  ) {
    throw new TypeError("deploymentAgents.artifacts.store must implement ObjectStore.");
  }
  return Object.freeze({ namespace, store });
}

function runnerReleaseObjectKey(projectId: string, releaseId: string, digest: string): string {
  assertReleaseStorageIdentifiers(projectId, releaseId);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Release artifact digest is invalid.");
  return `runner-artifacts/${projectId}/${releaseId}/${digest}.clank.gz`;
}

async function writeRunnerReleaseArtifact(
  projectsRoot: string,
  artifact: RunnerArtifactDescriptor,
  bytes: Uint8Array,
  objects: RunnerArtifactObjects | null,
): Promise<void> {
  assertReleaseStorageIdentifiers(artifact.projectId, artifact.releaseId);
  if (artifact.store !== "local") {
    if (
      !objects
      || artifact.store !== objects.namespace
      || artifact.key !== runnerReleaseObjectKey(
        artifact.projectId,
        artifact.releaseId,
        artifact.digest,
      )
    ) {
      throw new Error("Release artifact object repository does not match its metadata.");
    }
    const metadata = await objects.store.put(artifact.key, bytes, {
      contentType: "application/vnd.clank.deploy+gzip",
    });
    if (
      metadata.key !== artifact.key
      || metadata.size !== artifact.bytes
      || metadata.sha256 !== artifact.digest
      || metadata.contentType !== "application/vnd.clank.deploy+gzip"
    ) {
      throw new Error("Release artifact object repository returned inconsistent metadata.");
    }
    return;
  }
  if (artifact.key !== null) {
    throw new Error("Local release artifact metadata contains an unexpected object key.");
  }
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const [fs, path] = await Promise.all([
    import(fsName) as unknown as Promise<{
      chmod(path: string, mode: number): Promise<void>;
      mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
      rename(source: string, destination: string): Promise<void>;
      rm(path: string, options: { force: true }): Promise<void>;
      writeFile(
        path: string,
        value: Uint8Array,
        options: { flag: "wx"; mode: number },
      ): Promise<void>;
    }>,
    import(pathName) as unknown as Promise<{ join(...segments: string[]): string }>,
  ]);
  const projectRoot = await safeChildPath(projectsRoot, artifact.projectId);
  await requireRealDirectory(projectsRoot);
  await requireRealDirectory(projectRoot);
  const directory = path.join(projectRoot, "artifacts");
  try {
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    await requireRealDirectory(directory);
  }
  const target = await safeChildPath(
    projectsRoot,
    `${artifact.projectId}/artifacts/${artifact.releaseId}.clank.gz`,
  );
  const temporary = await safeChildPath(
    projectsRoot,
    `${artifact.projectId}/artifacts/.${artifact.releaseId}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readRunnerReleaseArtifact(
  projectsRoot: string,
  release: ReleaseRow,
  signal: AbortSignal,
  objects: RunnerArtifactObjects | null,
): Promise<{ bytes: Uint8Array; sha256: string } | null> {
  assertReleaseStorageIdentifiers(release.projectId, release.id);
  if (signal.aborted) return null;
  if (release.runnerArtifactStore !== "local") {
    const expectedKey = runnerReleaseObjectKey(release.projectId, release.id, release.digest);
    if (
      !objects
      || objects.namespace !== release.runnerArtifactStore
      || release.runnerArtifactKey !== expectedKey
    ) return null;
    const stored = await objects.store.get(expectedKey);
    if (!stored || signal.aborted) return null;
    if (
      stored.metadata.key !== expectedKey
      || stored.metadata.size !== release.runnerArtifactBytes
      || stored.metadata.size !== release.artifactBytes
      || stored.metadata.sha256 !== release.digest
      || stored.metadata.contentType !== "application/vnd.clank.deploy+gzip"
      || stored.bytes.byteLength !== stored.metadata.size
      || await deploymentDigest(stored.bytes) !== release.digest
    ) {
      throw new Error("Stored deployment runner object failed integrity verification.");
    }
    return { bytes: stored.bytes, sha256: release.digest };
  }
  if (release.runnerArtifactKey !== null) {
    throw new Error("Stored local deployment artifact metadata is inconsistent.");
  }
  const parents = await releaseStorageParents(projectsRoot, release.projectId);
  if (!parents.artifacts) return null;
  const target = await safeChildPath(
    projectsRoot,
    `${release.projectId}/artifacts/${release.id}.clank.gz`,
  );
  const fsName = "node:fs/promises";
  const nodeFsName = "node:fs";
  const [fs, nodeFs] = await Promise.all([
    import(fsName) as unknown as Promise<{
      lstat(path: string): Promise<{
        dev: number;
        ino: number;
        isSymbolicLink(): boolean;
      }>;
      open(path: string, flags: number): Promise<{
        stat(): Promise<{
          dev: number;
          ino: number;
          mode: number;
          size: number;
          uid: number;
          isFile(): boolean;
        }>;
        readFile(): Promise<Uint8Array>;
        close(): Promise<void>;
      }>;
    }>,
    import(nodeFsName) as unknown as Promise<{
      constants: { O_RDONLY: number; O_NOFOLLOW?: number };
    }>,
  ]);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      target,
      nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  try {
    const [stats, pathStats] = await Promise.all([handle.stat(), fs.lstat(target)]);
    const getUid = (globalThis as any).process?.getuid;
    const currentUid = typeof getUid === "function"
      ? Number(getUid.call((globalThis as any).process))
      : null;
    if (
      pathStats.isSymbolicLink()
      || pathStats.dev !== stats.dev
      || pathStats.ino !== stats.ino
      || !stats.isFile()
      || stats.size !== release.runnerArtifactBytes
      || stats.size !== release.artifactBytes
      || (stats.mode & 0o077) !== 0
      || (currentUid !== null && stats.uid !== currentUid)
    ) {
      throw new Error("Stored deployment runner artifact is unsafe or inconsistent.");
    }
    const bytes = await handle.readFile();
    if (signal.aborted) return null;
    if (bytes.byteLength !== stats.size || await deploymentDigest(bytes) !== release.digest) {
      throw new Error("Stored deployment runner artifact failed integrity verification.");
    }
    return { bytes, sha256: release.digest };
  } finally {
    await handle.close();
  }
}

async function deleteReleaseStorage(
  projectsRoot: string,
  release: ReleaseRow,
  objects: RunnerArtifactObjects | null,
): Promise<void> {
  assertReleaseStorageIdentifiers(release.projectId, release.id);
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    rm(path: string, options: { recursive?: boolean; force: true }): Promise<void>;
  };
  const parents = await releaseStorageParents(projectsRoot, release.projectId);
  const targets: Array<{ path: string; recursive?: boolean }> = [];
  if (parents.releases) {
    targets.push({
      path: await safeChildPath(
        projectsRoot,
        `${release.projectId}/releases/${release.id}`,
      ),
      recursive: true,
    });
  }
  if (parents.artifacts) {
    targets.push({
      path: await safeChildPath(
        projectsRoot,
        `${release.projectId}/artifacts/${release.id}.clank.gz`,
      ),
    });
  }
  if (parents.backups) {
    const backupPath = await safeChildPath(
      projectsRoot,
      `${release.projectId}/backups/${release.id}.sqlite`,
    );
    targets.push(
      { path: backupPath },
      { path: `${backupPath}-wal` },
      { path: `${backupPath}-shm` },
    );
  }
  await deleteRunnerReleaseObject(release, objects);
  await Promise.all(targets.map((target) =>
    fs.rm(target.path, { ...(target.recursive ? { recursive: true } : {}), force: true })));
}

function assertReleaseStorageIdentifiers(projectId: string, releaseId: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(projectId) || !/^[A-Za-z0-9_-]{8,128}$/u.test(releaseId)) {
    throw new Error("Release storage identifier is invalid.");
  }
}

async function deleteProjectStorage(
  projectsRoot: string,
  projectId: string,
  beforeRemove?: () => Promise<void>,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(projectId)) {
    throw new Error("Project storage identifier is invalid.");
  }
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  };
  await requireRealDirectory(projectsRoot);
  const projectRoot = await safeChildPath(projectsRoot, projectId);
  const projectExists = await requireRealDirectory(projectRoot, true);
  await beforeRemove?.();
  if (!projectExists) return;
  await fs.rm(projectRoot, { recursive: true, force: true });
}

async function deleteRunnerReleaseObject(
  release: ReleaseRow,
  objects: RunnerArtifactObjects | null,
): Promise<void> {
  if (release.runnerArtifactBytes <= 0 || release.runnerArtifactStore === "local") return;
  const expectedKey = runnerReleaseObjectKey(release.projectId, release.id, release.digest);
  if (
    !objects
    || objects.namespace !== release.runnerArtifactStore
    || release.runnerArtifactKey !== expectedKey
  ) {
    throw new Error(
      "Release artifact belongs to an unavailable object repository; storage metadata was preserved.",
    );
  }
  await objects.store.delete(expectedKey);
}

async function deleteProjectRunnerArtifacts(
  internal: SQLiteInternal,
  projectId: string,
  objects: RunnerArtifactObjects | null,
): Promise<void> {
  const releases = internal.prepare(
    `SELECT * FROM clank_platform_releases
      WHERE project_id = ? AND runner_artifact_bytes > 0 AND runner_artifact_store <> 'local'
      ORDER BY created_at`,
  ).all(projectId).map(releaseRow);
  for (const release of releases) await deleteRunnerReleaseObject(release, objects);
}

async function deleteProjectBackups(
  projectsRoot: string,
  project: ProjectRow,
  masterKey: Uint8Array,
  policy: PlatformBackupPolicy,
  objects: PlatformBackupObjects | null,
): Promise<void> {
  if (!project.databasePath || !objects) return;
  const manager = await projectBackupManager(
    projectsRoot,
    project,
    masterKey,
    policy,
    objects,
  );
  try {
    await manager.purge({ confirmation: "delete all backups" });
  } finally {
    manager.close();
  }
}

async function deleteReleaseSnapshot(
  projectsRoot: string,
  projectId: string,
  releaseId: string,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(projectId) || !/^[A-Za-z0-9_-]{8,128}$/u.test(releaseId)) {
    throw new Error("Release storage identifier is invalid.");
  }
  const parents = await releaseStorageParents(projectsRoot, projectId);
  if (parents.backups) await deleteReleaseSnapshotFiles(projectsRoot, projectId, releaseId);
}

async function deleteReleaseSnapshotFiles(
  projectsRoot: string,
  projectId: string,
  releaseId: string,
): Promise<void> {
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    rm(path: string, options: { force: true }): Promise<void>;
  };
  const backupPath = await safeChildPath(
    projectsRoot,
    `${projectId}/backups/${releaseId}.sqlite`,
  );
  await Promise.all(
    [backupPath, `${backupPath}-wal`, `${backupPath}-shm`]
      .map((target) => fs.rm(target, { force: true })),
  );
}

async function releaseStorageParents(
  projectsRoot: string,
  projectId: string,
): Promise<{ releases: boolean; artifacts: boolean; backups: boolean }> {
  const pathName = "node:path";
  const path = await import(pathName) as unknown as { join(...segments: string[]): string };
  const projectRoot = await safeChildPath(projectsRoot, projectId);
  await requireRealDirectory(projectsRoot);
  await requireRealDirectory(projectRoot);
  return {
    releases: await requireRealDirectory(path.join(projectRoot, "releases"), true),
    artifacts: await requireRealDirectory(path.join(projectRoot, "artifacts"), true),
    backups: await requireRealDirectory(path.join(projectRoot, "backups"), true),
  };
}

async function requireRealDirectory(path: string, missingAllowed = false): Promise<boolean> {
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  };
  try {
    const stats = await fs.lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Release storage parent must be a real directory.");
    }
    return true;
  } catch (error) {
    if (missingAllowed && (error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
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

const NO_RESERVED_PORTS: ReadonlySet<number> = new Set();

function normalizeReservedAppPorts(input: readonly number[] | undefined): ReadonlySet<number> {
  if (input === undefined) return NO_RESERVED_PORTS;
  if (!Array.isArray(input) || input.length > 1_024) {
    throw new TypeError("reservedAppPorts must be an array containing at most 1024 ports.");
  }
  const ports = new Set<number>();
  for (const port of input) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError("reservedAppPorts must contain valid TCP ports.");
    }
    ports.add(port);
  }
  return ports;
}

function reconcileReservedProjectPorts(
  internal: SQLiteInternal,
  start: number,
  end: number,
  reserved: ReadonlySet<number>,
): void {
  if (reserved.size === 0) return;
  internal.transaction((changes) => {
    const conflicts = internal.prepare(
      "SELECT id, port FROM clank_platform_projects ORDER BY created_at, id",
    ).all().filter((row) => reserved.has(Number(row.port)));
    for (const row of conflicts) {
      const id = String(row.id);
      const port = allocatePort(internal, start, end, reserved);
      internal.prepare("UPDATE clank_platform_projects SET port = ?, updated_at = ? WHERE id = ?")
        .run(port, Date.now(), id);
      changes.record("__platform", id);
    }
  });
}

function allocatePort(
  internal: SQLiteInternal,
  start: number,
  end: number,
  reserved: ReadonlySet<number> = NO_RESERVED_PORTS,
): number {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1024 || end > 65535 || start > end) {
    throw new Error("Invalid application port range.");
  }
  const used = new Set(internal.prepare("SELECT port FROM clank_platform_projects").all().map((row) => Number(row.port)));
  for (let port = start; port <= end; port++) {
    if (!used.has(port) && !reserved.has(port)) return port;
  }
  throw new PlatformError(503, "PORT_CAPACITY", "No application ports are available.");
}

function normalizePublicUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !isLoopbackUrl(url))) {
    throw new Error("Platform publicUrl must be HTTPS, except for loopback development.");
  }
  url.pathname = trimTrailingSlashes(url.pathname);
  return trimTrailingSlashes(url.href);
}

const PLATFORM_CONSOLE_STATIC_PATHS = new Set([
  "/",
  "/login",
  "/signup",
  "/invite",
  "/overview",
  "/projects",
  "/workspaces",
  "/activity",
  "/admin",
]);
const PLATFORM_CONSOLE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/u;
const PLATFORM_PROJECT_SECTIONS = new Set([
  "performance",
  "domains",
  "deployments",
  "backups",
  "logs",
  "settings",
]);

function canonicalPlatformConsolePath(pathname: string): string | null {
  const canonical = pathname !== "/" && pathname.endsWith("/")
    ? pathname.replace(/\/+$/u, "")
    : pathname;
  if (PLATFORM_CONSOLE_STATIC_PATHS.has(canonical)) return canonical;
  const segments = canonical.slice(1).split("/");
  if (segments.length === 3
    && segments[0] === "workspaces"
    && PLATFORM_CONSOLE_SLUG.test(segments[1]!)
    && segments[2] === "people") {
    return canonical;
  }
  if (segments[0] !== "projects"
    || !PLATFORM_CONSOLE_SLUG.test(segments[1] ?? "")
    || segments.length > 3) {
    return null;
  }
  if (segments.length === 2) return canonical;
  return PLATFORM_PROJECT_SECTIONS.has(segments[2]!) ? canonical : null;
}

function isPlatformConsoleNamespacePath(pathname: string): boolean {
  const firstSegment = pathname.split("/", 3)[1] ?? "";
  return firstSegment === "login"
    || firstSegment === "signup"
    || firstSegment === "invite"
    || firstSegment === "overview"
    || firstSegment === "projects"
    || firstSegment === "workspaces"
    || firstSegment === "activity"
    || firstSegment === "admin";
}

function domainResolver(options: ClankPlatformOptions["ingress"]): DomainDnsResolver | undefined {
  if (!options?.resolveCname && !options?.resolve4 && !options?.resolve6) return undefined;
  return {
    resolveCname: options.resolveCname ?? ((hostname) => nativeDnsLookup("resolveCname", hostname)),
    resolve4: options.resolve4 ?? ((hostname) => nativeDnsLookup("resolve4", hostname)),
    resolve6: options.resolve6 ?? ((hostname) => nativeDnsLookup("resolve6", hostname)),
  };
}

async function nativeDnsLookup(kind: "resolveCname" | "resolve4" | "resolve6", hostname: string): Promise<string[]> {
  const moduleName = "node:dns/promises";
  const dns = await import(moduleName) as unknown as Record<typeof kind, (name: string) => Promise<string[]>>;
  return dns[kind](hostname);
}

function normalizeEdgeAddresses(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 32) {
    throw new PlatformError(422, "INVALID_INPUT", "ingress.customDomainAddresses must contain at most 32 IP addresses.");
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const input of values) {
    const raw = boundedString(input, "ingress.customDomainAddresses entry", 2, 64).trim().toLowerCase();
    let address: string;
    if (raw.includes(":")) {
      if (!/^[0-9a-f:]+$/u.test(raw) || !raw.includes(":")) {
        throw new PlatformError(422, "INVALID_INPUT", `Invalid edge IP address: ${raw}`);
      }
      address = raw;
    } else {
      const segments = raw.split(".");
      if (segments.length !== 4 || segments.some((segment) => !/^\d{1,3}$/u.test(segment) || Number(segment) > 255)) {
        throw new PlatformError(422, "INVALID_INPUT", `Invalid edge IP address: ${raw}`);
      }
      address = segments.map(Number).join(".");
    }
    if (!seen.has(address)) {
      seen.add(address);
      output.push(address);
    }
  }
  return output;
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
  return trimTrailingSlashes(value);
}

function isLoopbackUrl(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

function normalizeSlug(value: unknown): string {
  const slug = trimBoundaryHyphens(String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  if (!PROJECT_SLUG.test(slug)) throw new PlatformError(422, "INVALID_SLUG", "Project slug must use 1-48 lowercase letters, numbers, or interior hyphens.");
  return slug;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function trimBoundaryHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 45) start++;
  while (end > start && value.charCodeAt(end - 1) === 45) end--;
  return value.slice(start, end);
}

function normalizeHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
  if (
    hostname.length < 1
    || hostname.length > 253
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)
  ) throw new PlatformError(422, "INVALID_HOSTNAME", "Hostname is invalid.");
  return hostname;
}

const PROJECT_PERMISSIONS: readonly ProjectPermission[] = [
  "read",
  "deploy",
  "rollback",
  "secrets",
  "tokens",
  "audit",
];

function parseProjectPermissions(value: unknown): ProjectPermission[] {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new PlatformError(500, "INVALID_TOKEN_SCOPE", "Stored token scope is invalid."); }
  if (!Array.isArray(parsed)) throw new PlatformError(500, "INVALID_TOKEN_SCOPE", "Stored token scope is invalid.");
  const permissions = [...new Set(parsed.map((entry) => String(entry)))];
  if (permissions.some((entry) => !PROJECT_PERMISSIONS.includes(entry as ProjectPermission))) {
    throw new PlatformError(500, "INVALID_TOKEN_SCOPE", "Stored token scope is invalid.");
  }
  return permissions as ProjectPermission[];
}

function inputProjectPermissions(value: unknown): ProjectPermission[] {
  if (value === undefined) return ["read", "deploy"];
  if (!Array.isArray(value) || value.length === 0 || value.length > PROJECT_PERMISSIONS.length) {
    throw new PlatformError(422, "INVALID_PERMISSIONS", "permissions must be a non-empty array of project permissions.");
  }
  const permissions = [...new Set(value.map((entry) => boundedString(entry, "permission", 1, 32)))] as ProjectPermission[];
  if (permissions.some((permission) => !PROJECT_PERMISSIONS.includes(permission))) {
    throw new PlatformError(422, "INVALID_PERMISSIONS", `Valid permissions: ${PROJECT_PERMISSIONS.join(", ")}.`);
  }
  return permissions;
}

function validateOrganizationRole(value: string, allowOwner: boolean): OrganizationRole {
  const roles: OrganizationRole[] = allowOwner
    ? ["owner", "admin", "developer", "viewer"]
    : ["admin", "developer", "viewer"];
  if (!roles.includes(value as OrganizationRole)) {
    throw new PlatformError(422, "INVALID_ROLE", `Role must be one of ${roles.join(", ")}.`);
  }
  return value as OrganizationRole;
}

function roleAllows(role: OrganizationRole, permission: ProjectPermission): boolean {
  if (role === "owner" || role === "admin") return true;
  if (role === "developer") return ["read", "deploy", "rollback", "audit"].includes(permission);
  return permission === "read";
}

function organizationMembership(
  internal: SQLiteInternal,
  organizationId: string,
  userId: string,
): { role: OrganizationRole; name: string; slug: string } {
  const row = internal.prepare(`SELECT m.role, o.name, o.slug
    FROM clank_platform_memberships m
    JOIN clank_platform_organizations o ON o.id = m.organization_id
    WHERE m.organization_id = ? AND m.user_id = ?`).get(organizationId, userId);
  if (!row) throw new PlatformError(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
  return {
    role: validateOrganizationRole(String(row.role), true),
    name: String(row.name),
    slug: String(row.slug),
  };
}

function requireOrganizationAdministration(role: OrganizationRole): void {
  if (role !== "owner" && role !== "admin") {
    throw new PlatformError(403, "ROLE_DENIED", "Organization administration requires the owner or admin role.");
  }
}

async function createOrganization(
  internal: SQLiteInternal,
  userId: string,
  name: string,
  slug: string,
  defaults: PlatformQuotaValues,
): Promise<Record<string, unknown>> {
  const id = await randomId(18);
  const now = Date.now();
  try {
    internal.transaction((changes) => {
      const organizationsPerAccount = accountQuotas(
        internal,
        userId,
        defaults,
      ).organizationsPerAccount;
      const count = Number(internal.prepare(
        "SELECT count(*) AS count FROM clank_platform_organizations WHERE created_by = ?",
      ).get(userId)?.count ?? 0);
      if (count >= organizationsPerAccount) {
        throw new PlatformError(
          409,
          "ORGANIZATION_LIMIT_REACHED",
          `This account has reached its ${organizationsPerAccount}-organization limit.`,
        );
      }
      internal.prepare(`INSERT INTO clank_platform_organizations
        (id, name, slug, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, name, slug, userId, now, now);
      internal.prepare(`INSERT INTO clank_platform_memberships
        (organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)`)
        .run(id, userId, now, now);
      changes.record("__platform", id);
    });
  } catch (error) {
    if (safeError(error).toLowerCase().includes("unique")) {
      throw new PlatformError(409, "SLUG_UNAVAILABLE", "That organization slug is unavailable.");
    }
    throw error;
  }
  return { id, name, slug, role: "owner", createdAt: now, updatedAt: now };
}

async function ensurePersonalOrganization(
  internal: SQLiteInternal,
  principal: TokenPrincipal,
  defaults: PlatformQuotaValues,
): Promise<string> {
  const existing = internal.prepare(`SELECT o.id
    FROM clank_platform_organizations o
    JOIN clank_platform_memberships m ON m.organization_id = o.id
    WHERE m.user_id = ? AND m.role = 'owner'
    ORDER BY o.created_at LIMIT 1`).get(principal.userId);
  if (existing) return String(existing.id);
  const id = await randomId(18);
  const baseName = principal.email.split("@")[0]?.replace(/[^A-Za-z0-9 ]+/g, " ").trim() || "Personal";
  const slug = normalizeSlug(`personal-${id.slice(0, 10)}`);
  await createOrganization(internal, principal.userId, `${baseName}'s workspace`, slug, defaults);
  const created = internal.prepare("SELECT id FROM clank_platform_organizations WHERE slug = ?").get(slug);
  return String(created!.id);
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

function normalizeEmail(value: unknown): string {
  const email = boundedString(value, "email", 3, 254).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new PlatformError(422, "INVALID_INPUT", "email must be a valid email address.");
  }
  return email;
}

function normalizePlatformAdminEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (
    email.length < 3
    || email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    throw new TypeError("platformAdminEmails entries must be valid email addresses.");
  }
  return email;
}

function integerInRange(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new PlatformError(422, "INVALID_INPUT", `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function queryInteger(
  value: string | null,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number;
function queryInteger(
  value: string | null,
  name: string,
  fallback: null,
  minimum: number,
  maximum: number,
): number | null;
function queryInteger(
  value: string | null,
  name: string,
  fallback: number | null,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new PlatformError(422, "INVALID_INPUT", `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return integerInRange(Number(value), name, minimum, maximum);
}

function normalizeUserCode(value: string): string {
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : value.toUpperCase();
}

function createPlatformRateLimitStore(
  internal: SQLiteInternal,
  masterKey: Uint8Array,
): AuthRateLimitStore {
  const digest = (key: string): string => {
    const module = (globalThis as any).process.getBuiltinModule?.("node:crypto");
    if (!module) throw new Error("Node crypto module is unavailable.");
    return module.createHmac("sha256", masterKey)
      .update("clank-platform-rate-limit\0")
      .update(key)
      .digest("base64url");
  };
  const attemptsFrom = (value: unknown): number[] => {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)
      || parsed.length > 10_000
      || parsed.some((entry) => !Number.isSafeInteger(entry) || entry <= 0)) {
      throw new Error("Platform rate-limit state is invalid.");
    }
    return parsed;
  };
  return {
    consume(key, limit, windowMs) {
      const keyHash = digest(key);
      const now = Date.now();
      return internal.transaction(() => {
        internal.prepare("DELETE FROM clank_platform_rate_limits WHERE expires_at <= ?").run(now);
        const row = internal.prepare(
          "SELECT attempts FROM clank_platform_rate_limits WHERE key_hash = ?",
        ).get(keyHash);
        const recent = row
          ? attemptsFrom(row.attempts)
              .filter((attempt) => attempt > now - windowMs)
              .map((attempt) => Math.min(attempt, now))
              .sort((left, right) => left - right)
          : [];
        if (recent.length >= limit) {
          return Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1_000));
        }
        recent.push(now);
        internal.prepare(`INSERT INTO clank_platform_rate_limits
          (key_hash, attempts, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(key_hash) DO UPDATE SET
            attempts = excluded.attempts,
            expires_at = excluded.expires_at`)
          .run(keyHash, JSON.stringify(recent), now + windowMs);
        if (!row) {
          const count = Number(internal.prepare(
            "SELECT count(*) AS count FROM clank_platform_rate_limits",
          ).get()?.count ?? 0);
          if (count > MAX_PLATFORM_RATE_LIMIT_KEYS) {
            internal.prepare(`DELETE FROM clank_platform_rate_limits WHERE key_hash IN (
              SELECT key_hash FROM clank_platform_rate_limits
              ORDER BY expires_at, rowid LIMIT ?
            )`).run(count - PLATFORM_RATE_LIMIT_PRUNE_TARGET);
          }
        }
        return undefined;
      });
    },
    clear(key) {
      internal.prepare("DELETE FROM clank_platform_rate_limits WHERE key_hash = ?").run(digest(key));
    },
    close() {
      // The platform database owns the shared limiter lifecycle.
    },
  };
}

async function enforceDeviceRateLimit(
  limiter: AuthRateLimitStore,
  request: Request,
): Promise<void> {
  const key = trustedClientAddress(request) ?? "unknown";
  const retryAfter = await limiter.consume(`device\n${key}`, 10, 60_000);
  if (retryAfter !== undefined) {
    throw new PlatformError(
      429,
      "RATE_LIMITED",
      "Too many device authorization attempts.",
      retryAfter,
    );
  }
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

async function hash(value: string): Promise<string> {
  return syncHash(value);
}

function syncHash(value: string): string {
  const module = (globalThis as any).process.getBuiltinModule?.("node:crypto");
  if (!module) throw new Error("Node crypto module is unavailable.");
  return module.createHash("sha256").update(value).digest("base64url");
}

async function timingSafeStringEqual(left: string, right: string): Promise<boolean> {
  const cryptoName = "node:crypto";
  const nodeCrypto = await import(cryptoName) as unknown as {
    timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  };
  const leftDigest = new TextEncoder().encode(syncHash(left));
  const rightDigest = new TextEncoder().encode(syncHash(right));
  return nodeCrypto.timingSafeEqual(leftDigest, rightDigest);
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
