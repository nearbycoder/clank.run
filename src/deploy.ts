export interface DeployHealthConfig {
  path: string;
  timeoutMs: number;
}

export interface DeployDatabaseConfig {
  path: string;
  migrations: string;
  allowUnsafeMigrations: boolean;
}

export interface DeployBuildConfig {
  command: readonly string[];
}

export interface DeploymentConfig {
  version: 1;
  entry: string;
  include: readonly string[];
  build?: DeployBuildConfig;
  database: DeployDatabaseConfig;
  health: DeployHealthConfig;
  env: Record<string, string>;
}

export interface DeploymentFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly mode: 0o600 | 0o644 | 0o700 | 0o755;
  readonly content: string;
}

export interface DeploymentBundle {
  readonly protocol: "clank-deploy/1";
  readonly config: DeploymentConfig;
  readonly provenance: {
    readonly builder: "clank-cli/1";
    readonly frameworkVersion: string;
    readonly nodeVersion: string;
  };
  readonly files: DeploymentFile[];
}

export interface BundleLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface CreateDeploymentBundleOptions extends BundleLimits {
  frameworkRoot?: string;
  frameworkVersion?: string;
  nodeVersion?: string;
}

const SENSITIVE_SEGMENTS = new Set([
  ".env",
  ".git",
  ".hg",
  ".clank",
  ".proact",
  ".svn",
  "id_rsa",
  "id_ed25519",
]);
const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** Reads and strictly validates the transparent deployment contract. */
export async function readDeploymentConfig(
  root: string,
  filename = "clank.deploy.json",
): Promise<DeploymentConfig> {
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    readFile(path: string, encoding: "utf8"): Promise<string>;
    stat(path: string): Promise<{ size: number }>;
  };
  const path = await import(pathName) as unknown as { resolve(...segments: string[]): string };
  let target = path.resolve(root, filename);
  let displayName = filename;
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(target);
  } catch (error) {
    if (filename !== "clank.deploy.json" || (error as { code?: string }).code !== "ENOENT") throw error;
    displayName = "proact.deploy.json";
    target = path.resolve(root, displayName);
    stats = await fs.stat(target);
  }
  if (stats.size > 64 * 1024) throw new Error(`${displayName} exceeds 64 KiB.`);
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    throw new Error(`${displayName} must contain valid JSON.`);
  }
  return parseDeploymentConfig(value);
}

export function parseDeploymentConfig(value: unknown): DeploymentConfig {
  const source = object(value, "Deployment config");
  exactKeys(source, ["version", "entry", "include", "build", "database", "health", "env"], "Deployment config");
  if (source.version !== 1) throw new Error("Deployment config version must be 1.");
  const entry = safeRelativePath(string(source.entry, "entry"), "entry");
  if (!entry.endsWith(".js") && !entry.endsWith(".mjs")) {
    throw new Error("Deployment entry must be a compiled .js or .mjs module.");
  }
  const include = array(source.include, "include").map((item, index) =>
    safeRelativePath(string(item, `include[${index}]`), `include[${index}]`));
  if (include.length === 0 || include.length > 64) throw new Error("include must contain between 1 and 64 paths.");
  if (!include.some((path) => entry === path || entry.startsWith(`${path}/`))) {
    throw new Error("Deployment entry must be contained by an include path.");
  }
  let build: DeployBuildConfig | undefined;
  if (source.build !== undefined) {
    const raw = object(source.build, "build");
    exactKeys(raw, ["command"], "build");
    const command = array(raw.command, "build.command").map((item, index) =>
      string(item, `build.command[${index}]`));
    if (command.length === 0 || command.length > 32 || command.some((part) => part.length > 4_096 || part.includes("\0"))) {
      throw new Error("build.command must contain 1-32 safe arguments.");
    }
    build = { command };
  }
  const rawDatabase = source.database === undefined ? {} : object(source.database, "database");
  exactKeys(rawDatabase, ["path", "migrations", "allowUnsafeMigrations"], "database");
  const database: DeployDatabaseConfig = {
    path: safeDataPath(rawDatabase.path === undefined ? "app.sqlite" : string(rawDatabase.path, "database.path")),
    migrations: safeRelativePath(
      rawDatabase.migrations === undefined ? "migrations" : string(rawDatabase.migrations, "database.migrations"),
      "database.migrations",
    ),
    allowUnsafeMigrations: rawDatabase.allowUnsafeMigrations === true,
  };
  if (!include.some((path) =>
    database.migrations === path || database.migrations.startsWith(`${path}/`))) {
    throw new Error("database.migrations must be contained by an include path.");
  }
  const rawHealth = source.health === undefined ? {} : object(source.health, "health");
  exactKeys(rawHealth, ["path", "timeoutMs"], "health");
  const healthPath = rawHealth.path === undefined ? "/" : string(rawHealth.path, "health.path");
  if (!healthPath.startsWith("/") || healthPath.startsWith("//") || healthPath.includes("\0")) {
    throw new Error("health.path must be an absolute application path.");
  }
  const health: DeployHealthConfig = {
    path: healthPath,
    timeoutMs: integer(rawHealth.timeoutMs ?? 15_000, "health.timeoutMs", 1_000, 120_000),
  };
  const rawEnv = source.env === undefined ? {} : object(source.env, "env");
  const env = Object.create(null) as Record<string, string>;
  for (const [name, raw] of Object.entries(rawEnv)) {
    if (!SAFE_ENV_NAME.test(name)
      || name.startsWith("CLANK_")
      || name.startsWith("PROACT_")
      || name === "PORT"
      || name === "NODE_OPTIONS") {
      throw new Error(`Environment name ${name} is reserved or invalid.`);
    }
    const value = string(raw, `env.${name}`);
    if (value.length > 16_384 || value.includes("\0")) throw new Error(`Environment value ${name} is too large or invalid.`);
    env[name] = value;
  }
  return Object.freeze({
    version: 1,
    entry,
    include: Object.freeze([...new Set(include)]),
    ...(build ? { build: Object.freeze({ command: Object.freeze([...build.command]) as unknown as string[] }) } : {}),
    database: Object.freeze(database),
    health: Object.freeze(health),
    env: Object.freeze(env),
  });
}

/** Creates a deterministic gzip artifact whose files are individually checksummed. */
export async function createDeploymentBundle(
  root: string,
  config: DeploymentConfig,
  options: CreateDeploymentBundleOptions = {},
): Promise<Uint8Array> {
  const pathName = "node:path";
  const path = await import(pathName) as unknown as {
    resolve(...segments: string[]): string;
    join(...segments: string[]): string;
    relative(from: string, to: string): string;
    sep: string;
  };
  const base = path.resolve(root);
  const files = new Map<string, DeploymentFile>();
  for (const included of config.include) {
    await collectPath(base, path.resolve(base, included), files, options, path);
  }
  if (options.frameworkRoot) {
    const framework = path.resolve(options.frameworkRoot);
    for (const included of ["dist", "package.json", "LICENSE"]) {
      await collectPath(
        framework,
        path.join(framework, included),
        files,
        options,
        path,
        "node_modules/clank.run",
      );
    }
  }
  if (!files.has(config.entry)) throw new Error(`Deployment entry ${config.entry} was not packaged.`);
  const bundle: DeploymentBundle = {
    protocol: "clank-deploy/1",
    config,
    provenance: {
      builder: "clank-cli/1",
      frameworkVersion: options.frameworkVersion ?? "unknown",
      nodeVersion: options.nodeVersion ?? "unknown",
    },
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
  const json = new TextEncoder().encode(JSON.stringify(bundle));
  const zlibName = "node:zlib";
  const { gzipSync } = await import(zlibName) as unknown as {
    gzipSync(value: Uint8Array, options: { level: number; mtime: number }): Uint8Array;
  };
  return gzipSync(json, { level: 9, mtime: 0 });
}

/** Validates a deployment artifact before any file is written or code is executed. */
export async function decodeDeploymentBundle(
  bytes: Uint8Array,
  limits: BundleLimits = {},
): Promise<DeploymentBundle> {
  const maxTotal = limits.maxTotalBytes ?? 100 * 1024 * 1024;
  if (bytes.byteLength > maxTotal) throw new Error(`Compressed deployment exceeds ${maxTotal} bytes.`);
  const zlibName = "node:zlib";
  const { gunzipSync } = await import(zlibName) as unknown as {
    gunzipSync(value: Uint8Array, options: { maxOutputLength: number }): Uint8Array;
  };
  let decoded: Uint8Array;
  try {
    decoded = gunzipSync(bytes, { maxOutputLength: maxTotal * 2 });
  } catch {
    throw new Error("Deployment artifact is not valid bounded gzip data.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch {
    throw new Error("Deployment artifact payload is not valid UTF-8 JSON.");
  }
  const source = object(raw, "Deployment artifact");
  exactKeys(source, ["protocol", "config", "provenance", "files"], "Deployment artifact");
  if (source.protocol !== "clank-deploy/1" && source.protocol !== "proact-deploy/1") {
    throw new Error("Unsupported deployment artifact protocol.");
  }
  const config = parseDeploymentConfig(source.config);
  const provenanceSource = object(source.provenance, "provenance");
  exactKeys(provenanceSource, ["builder", "frameworkVersion", "nodeVersion"], "provenance");
  if (provenanceSource.builder !== "clank-cli/1" && provenanceSource.builder !== "proact-cli/1") {
    throw new Error("Unsupported deployment artifact builder.");
  }
  const provenance = {
    builder: "clank-cli/1" as const,
    frameworkVersion: string(provenanceSource.frameworkVersion, "provenance.frameworkVersion"),
    nodeVersion: string(provenanceSource.nodeVersion, "provenance.nodeVersion"),
  };
  const rawFiles = array(source.files, "files");
  const maxFiles = limits.maxFiles ?? 20_000;
  if (rawFiles.length === 0 || rawFiles.length > maxFiles) throw new Error(`Deployment file count must be 1-${maxFiles}.`);
  const files: DeploymentFile[] = [];
  const names = new Set<string>();
  let total = 0;
  for (let index = 0; index < rawFiles.length; index++) {
    const file = object(rawFiles[index], `files[${index}]`);
    exactKeys(file, ["path", "size", "sha256", "mode", "content"], `files[${index}]`);
    const name = safeRelativePath(string(file.path, `files[${index}].path`), `files[${index}].path`);
    if (names.has(name)) throw new Error(`Duplicate deployment path: ${name}`);
    names.add(name);
    const size = integer(file.size, `files[${index}].size`, 0, limits.maxFileBytes ?? 20 * 1024 * 1024);
    const digest = string(file.sha256, `files[${index}].sha256`);
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid file checksum for ${name}.`);
    const mode = file.mode;
    if (mode !== 0o600 && mode !== 0o644 && mode !== 0o700 && mode !== 0o755) {
      throw new Error(`Invalid file mode for ${name}.`);
    }
    const content = string(file.content, `files[${index}].content`);
    const bytes = base64Bytes(content, name);
    if (bytes.byteLength !== size) throw new Error(`File size mismatch for ${name}.`);
    if (await sha256(bytes) !== digest) throw new Error(`File checksum mismatch for ${name}.`);
    total += size;
    if (total > maxTotal) throw new Error(`Unpacked deployment exceeds ${maxTotal} bytes.`);
    files.push({ path: name, size, sha256: digest, mode, content });
  }
  if (!names.has(config.entry)) throw new Error("Deployment entry is missing from the artifact.");
  return Object.freeze({
    protocol: "clank-deploy/1",
    config,
    provenance: Object.freeze(provenance),
    files: Object.freeze(files) as unknown as DeploymentFile[],
  });
}

/** Extracts an already validated bundle into a new release directory. */
export async function extractDeploymentBundle(bundle: DeploymentBundle, directory: string): Promise<void> {
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    mkdir(path: string, options: { recursive: boolean; mode?: number }): Promise<void>;
    writeFile(path: string, data: Uint8Array, options: { flag: "wx"; mode: number }): Promise<void>;
  };
  const path = await import(pathName) as unknown as {
    resolve(...segments: string[]): string;
    dirname(value: string): string;
    sep: string;
  };
  const root = path.resolve(directory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of bundle.files) {
    const target = path.resolve(root, file.path);
    if (target === root || !target.startsWith(root + path.sep)) throw new Error(`Unsafe deployment path: ${file.path}`);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, base64Bytes(file.content, file.path), { flag: "wx", mode: file.mode });
  }
}

export async function deploymentDigest(bytes: Uint8Array): Promise<string> {
  return sha256(bytes);
}

async function collectPath(
  root: string,
  target: string,
  files: Map<string, DeploymentFile>,
  limits: BundleLimits,
  path: {
    resolve(...segments: string[]): string;
    join(...segments: string[]): string;
    relative(from: string, to: string): string;
    sep: string;
  },
  prefix = "",
): Promise<void> {
  const fsName = "node:fs/promises";
  const fs = await import(fsName) as unknown as {
    lstat(path: string): Promise<{
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
      size: number;
      mode: number;
    }>;
    readFile(path: string): Promise<Uint8Array>;
    readdir(path: string, options: { withFileTypes: true }): Promise<Array<{ name: string }>>;
  };
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("Included paths must stay inside the project.");
  const stats = await fs.lstat(resolved);
  if (stats.isSymbolicLink()) throw new Error(`Deployment symbolic links are not allowed: ${resolved}`);
  if (stats.isDirectory()) {
    for (const entry of (await fs.readdir(resolved, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      await collectPath(root, path.join(resolved, entry.name), files, limits, path, prefix);
    }
    return;
  }
  if (!stats.isFile()) throw new Error(`Deployment includes a special file: ${resolved}`);
  const relative = safeRelativePath(path.relative(root, resolved).replaceAll(path.sep, "/"), "file path");
  assertNotSensitive(relative);
  const name = prefix ? `${prefix}/${relative}` : relative;
  if (files.has(name)) throw new Error(`Duplicate deployment path: ${name}`);
  const maxFile = limits.maxFileBytes ?? 20 * 1024 * 1024;
  if (stats.size > maxFile) throw new Error(`Deployment file ${name} exceeds ${maxFile} bytes.`);
  if (files.size >= (limits.maxFiles ?? 20_000)) throw new Error("Deployment has too many files.");
  const bytes = await fs.readFile(resolved);
  const total = [...files.values()].reduce((sum, file) => sum + file.size, 0) + bytes.byteLength;
  if (total > (limits.maxTotalBytes ?? 100 * 1024 * 1024)) throw new Error("Deployment is too large.");
  files.set(name, Object.freeze({
    path: name,
    size: bytes.byteLength,
    sha256: await sha256(bytes),
    mode: stats.mode & 0o111 ? 0o755 : 0o644,
    content: bytesToBase64(bytes),
  }));
}

function safeRelativePath(value: string, label: string): string {
  if (!value || value.length > 1_024 || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw new Error(`${label} must be a safe relative POSIX path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain empty, dot, or parent segments.`);
  }
  return value;
}

function safeDataPath(value: string): string {
  const path = safeRelativePath(value, "database.path");
  assertNotSensitive(path);
  if (!path.endsWith(".sqlite") && !path.endsWith(".db")) {
    throw new Error("database.path must end in .sqlite or .db.");
  }
  return path;
}

function assertNotSensitive(path: string): void {
  for (const segment of path.toLowerCase().split("/")) {
    if (SENSITIVE_SEGMENTS.has(segment) || segment.startsWith(".env.")) {
      throw new Error(`Sensitive path ${path} cannot be deployed. Use platform secrets.`);
    }
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const cryptoName = "node:crypto";
  const { createHash } = await import(cryptoName) as unknown as {
    createHash(name: string): { update(value: Uint8Array): { digest(encoding: "hex"): string } };
  };
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesToBase64(bytes: Uint8Array): string {
  const Buffer = (globalThis as any).process?.getBuiltinModule?.("node:buffer")?.Buffer;
  if (Buffer) return Buffer.from(bytes).toString("base64");
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary);
}

function base64Bytes(value: string, name: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Invalid base64 content for ${name}.`);
  }
  const Buffer = (globalThis as any).process?.getBuiltinModule?.("node:buffer")?.Buffer;
  if (Buffer) return new Uint8Array(Buffer.from(value, "base64"));
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) throw new Error(`${label} contains unknown key ${key}.`);
}
