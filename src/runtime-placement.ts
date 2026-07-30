import {
  decodeDeploymentBundle,
  deploymentDigest,
  type DeploymentBundle,
} from "./deploy.ts";

export const DEPLOYMENT_RUNTIME_PROTOCOL = "clank-runtime/1";
export const DEPLOYMENT_RUNTIME_MEDIA_TYPE = "application/vnd.clank.runtime";

export interface DeploymentRuntimeDatabaseManifest {
  readonly path: string;
  readonly mode: "initialize" | "preserve" | "replace";
  readonly snapshot: {
    readonly bytes: number;
    readonly sha256: string;
  } | null;
}

export interface DeploymentRuntimeIngressManifest {
  /** Provider-local route dedicated to this project. */
  readonly route: string;
  /** Secret sent only by Clank managed ingress when proxying this project. */
  readonly token: string;
  /** Separate secret for provider control operations; never sent with public traffic. */
  readonly controlToken?: string;
}

export interface DeploymentRuntimeManifest {
  readonly protocol: typeof DEPLOYMENT_RUNTIME_PROTOCOL;
  readonly projectId: string;
  readonly releaseId: string;
  readonly generation: number;
  /** Final process environment. Values can contain application secrets. */
  readonly environment: Readonly<Record<string, string>>;
  readonly database: DeploymentRuntimeDatabaseManifest;
  readonly ingress: DeploymentRuntimeIngressManifest;
  readonly artifact: {
    readonly bytes: number;
    readonly sha256: string;
  };
}

export interface DeploymentRuntimeCapsule {
  /** Exact capsule bytes, suitable for forwarding without re-encoding secrets. */
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly manifest: DeploymentRuntimeManifest;
  readonly artifact: {
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly bundle: DeploymentBundle;
  };
  readonly databaseSnapshot: Uint8Array | null;
}

export interface CreateDeploymentRuntimeCapsuleInput {
  projectId: string;
  releaseId: string;
  generation: number;
  environment: Record<string, string>;
  database: {
    path: string;
    mode: "initialize" | "preserve" | "replace";
    snapshot?: Uint8Array | null;
  };
  ingress: {
    route: string;
    token: string;
    controlToken?: string;
  };
  artifact: Uint8Array;
}

export interface DeploymentRuntimeCapsuleLimits {
  /** Defaults to 2 MiB. */
  maxManifestBytes?: number;
  /** Defaults to 100 MiB. */
  maxArtifactBytes?: number;
  /** Defaults to 512 MiB. */
  maxDatabaseBytes?: number;
  /** Defaults to the sum of the three section limits plus the fixed header. */
  maxCapsuleBytes?: number;
}

const MAGIC = Uint8Array.from([0x43, 0x4c, 0x4e, 0x4b, 0x52, 0x54, 0x30, 0x31]);
const HEADER_BYTES = 32;
const SQLITE_HEADER = Uint8Array.from([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

/**
 * Creates the exact binary passed from the control plane to a deployment
 * runner and then to its trusted runtime provider. The capsule is not an
 * archive: fixed lengths are validated before any section is interpreted.
 */
export async function createDeploymentRuntimeCapsule(
  input: CreateDeploymentRuntimeCapsuleInput,
  limits: DeploymentRuntimeCapsuleLimits = {},
): Promise<DeploymentRuntimeCapsule> {
  const resolved = capsuleLimits(limits);
  const projectId = identifier(input.projectId, "projectId");
  const releaseId = identifier(input.releaseId, "releaseId");
  const generation = positiveInteger(input.generation, "generation");
  const environment = runtimeEnvironment(input.environment);
  const artifact = bytes(input.artifact, "artifact");
  if (artifact.byteLength > resolved.maxArtifactBytes) {
    throw new RangeError(`Runtime artifact exceeds ${resolved.maxArtifactBytes} bytes.`);
  }
  const artifactSha256 = await deploymentDigest(artifact);
  const bundle = await decodeDeploymentBundle(artifact, {
    maxTotalBytes: resolved.maxArtifactBytes,
  });
  const databasePath = dataPath(input.database.path);
  if (databasePath !== bundle.config.database.path) {
    throw new TypeError("Runtime database path does not match the deployment artifact.");
  }
  const mode = databaseMode(input.database.mode);
  const snapshot = input.database.snapshot === undefined || input.database.snapshot === null
    ? null
    : bytes(input.database.snapshot, "database snapshot");
  validateSnapshotMode(mode, snapshot);
  if (snapshot && snapshot.byteLength > resolved.maxDatabaseBytes) {
    throw new RangeError(`Runtime database snapshot exceeds ${resolved.maxDatabaseBytes} bytes.`);
  }
  if (snapshot) assertSQLite(snapshot);
  const snapshotSha256 = snapshot ? await digest(snapshot) : null;
  const manifest = runtimeManifest({
    protocol: DEPLOYMENT_RUNTIME_PROTOCOL,
    projectId,
    releaseId,
    generation,
    environment,
    database: {
      path: databasePath,
      mode,
      snapshot: snapshot
        ? { bytes: snapshot.byteLength, sha256: snapshotSha256! }
        : null,
    },
    ingress: {
      route: ingressRoute(input.ingress.route),
      token: ingressToken(input.ingress.token),
      ...(input.ingress.controlToken === undefined
        ? {}
        : { controlToken: ingressToken(input.ingress.controlToken) }),
    },
    artifact: {
      bytes: artifact.byteLength,
      sha256: artifactSha256,
    },
  });
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (manifestBytes.byteLength > resolved.maxManifestBytes) {
    throw new RangeError(`Runtime manifest exceeds ${resolved.maxManifestBytes} bytes.`);
  }
  const total = checkedTotal(
    manifestBytes.byteLength,
    artifact.byteLength,
    snapshot?.byteLength ?? 0,
    resolved.maxCapsuleBytes,
  );
  const output = new Uint8Array(total);
  output.set(MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint32(8, manifestBytes.byteLength);
  view.setUint32(12, 0);
  view.setBigUint64(16, BigInt(artifact.byteLength));
  view.setBigUint64(24, BigInt(snapshot?.byteLength ?? 0));
  let offset = HEADER_BYTES;
  output.set(manifestBytes, offset);
  offset += manifestBytes.byteLength;
  output.set(artifact, offset);
  offset += artifact.byteLength;
  if (snapshot) output.set(snapshot, offset);
  const capsuleSha256 = await digest(output);
  return Object.freeze({
    bytes: output,
    sha256: capsuleSha256,
    manifest,
    artifact: Object.freeze({
      bytes: output.subarray(
        HEADER_BYTES + manifestBytes.byteLength,
        HEADER_BYTES + manifestBytes.byteLength + artifact.byteLength,
      ),
      sha256: artifactSha256,
      bundle,
    }),
    databaseSnapshot: snapshot
      ? output.subarray(total - snapshot.byteLength)
      : null,
  });
}

/** Decodes and independently re-verifies every capsule section. */
export async function decodeDeploymentRuntimeCapsule(
  input: Uint8Array,
  limits: DeploymentRuntimeCapsuleLimits = {},
): Promise<DeploymentRuntimeCapsule> {
  const resolved = capsuleLimits(limits);
  const source = bytes(input, "runtime capsule");
  if (source.byteLength < HEADER_BYTES || source.byteLength > resolved.maxCapsuleBytes) {
    throw new RangeError("Runtime capsule size is invalid.");
  }
  for (let index = 0; index < MAGIC.byteLength; index++) {
    if (source[index] !== MAGIC[index]) throw new TypeError("Runtime capsule protocol is invalid.");
  }
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const manifestLength = view.getUint32(8);
  if (view.getUint32(12) !== 0) throw new TypeError("Runtime capsule reserved header is invalid.");
  const artifactLength = safeLength(view.getBigUint64(16), "artifact");
  const databaseLength = safeLength(view.getBigUint64(24), "database snapshot");
  if (manifestLength > resolved.maxManifestBytes
    || artifactLength > resolved.maxArtifactBytes
    || databaseLength > resolved.maxDatabaseBytes) {
    throw new RangeError("Runtime capsule section exceeds its configured limit.");
  }
  const total = checkedTotal(
    manifestLength,
    artifactLength,
    databaseLength,
    resolved.maxCapsuleBytes,
  );
  if (source.byteLength !== total) throw new TypeError("Runtime capsule length is inconsistent.");
  const manifestStart = HEADER_BYTES;
  const artifactStart = manifestStart + manifestLength;
  const databaseStart = artifactStart + artifactLength;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      source.subarray(manifestStart, artifactStart),
    ));
  } catch {
    throw new TypeError("Runtime manifest is not valid UTF-8 JSON.");
  }
  const manifest = runtimeManifest(raw);
  if (manifest.artifact.bytes !== artifactLength) {
    throw new TypeError("Runtime artifact length does not match its manifest.");
  }
  const artifactBytes = source.subarray(artifactStart, databaseStart);
  if (await deploymentDigest(artifactBytes) !== manifest.artifact.sha256) {
    throw new TypeError("Runtime artifact failed integrity verification.");
  }
  const bundle = await decodeDeploymentBundle(artifactBytes, {
    maxTotalBytes: resolved.maxArtifactBytes,
  });
  if (bundle.config.database.path !== manifest.database.path) {
    throw new TypeError("Runtime database path does not match the deployment artifact.");
  }
  const databaseSnapshot = databaseLength === 0
    ? null
    : source.subarray(databaseStart);
  validateSnapshotMode(manifest.database.mode, databaseSnapshot);
  if (databaseSnapshot) {
    assertSQLite(databaseSnapshot);
    if (
      !manifest.database.snapshot
      || manifest.database.snapshot.bytes !== databaseSnapshot.byteLength
      || await digest(databaseSnapshot) !== manifest.database.snapshot.sha256
    ) {
      throw new TypeError("Runtime database snapshot failed integrity verification.");
    }
  } else if (manifest.database.snapshot !== null) {
    throw new TypeError("Runtime database snapshot metadata is inconsistent.");
  }
  return Object.freeze({
    bytes: source,
    sha256: await digest(source),
    manifest,
    artifact: Object.freeze({
      bytes: artifactBytes,
      sha256: manifest.artifact.sha256,
      bundle,
    }),
    databaseSnapshot,
  });
}

export async function deploymentRuntimeDigest(bytes: Uint8Array): Promise<string> {
  return digest(bytes);
}

function runtimeManifest(value: unknown): DeploymentRuntimeManifest {
  const input = plainObject(value, "runtime manifest");
  exact(input, [
    "protocol",
    "projectId",
    "releaseId",
    "generation",
    "environment",
    "database",
    "ingress",
    "artifact",
  ]);
  if (input.protocol !== DEPLOYMENT_RUNTIME_PROTOCOL) {
    throw new TypeError("Runtime manifest protocol is unsupported.");
  }
  const database = plainObject(input.database, "runtime database");
  exact(database, ["path", "mode", "snapshot"]);
  const snapshot = database.snapshot === null
    ? null
    : digestMetadata(database.snapshot, "runtime database snapshot");
  const artifact = digestMetadata(input.artifact, "runtime artifact");
  const ingress = plainObject(input.ingress, "runtime ingress");
  const hasControlToken = Object.hasOwn(ingress, "controlToken");
  exact(ingress, hasControlToken ? ["route", "token", "controlToken"] : ["route", "token"]);
  return Object.freeze({
    protocol: DEPLOYMENT_RUNTIME_PROTOCOL,
    projectId: identifier(input.projectId, "projectId"),
    releaseId: identifier(input.releaseId, "releaseId"),
    generation: positiveInteger(input.generation, "generation"),
    environment: runtimeEnvironment(input.environment),
    database: Object.freeze({
      path: dataPath(database.path),
      mode: databaseMode(database.mode),
      snapshot,
    }),
    ingress: Object.freeze({
      route: ingressRoute(ingress.route),
      token: ingressToken(ingress.token),
      ...(hasControlToken
        ? { controlToken: ingressToken(ingress.controlToken) }
        : {}),
    }),
    artifact,
  });
}

function runtimeEnvironment(value: unknown): Readonly<Record<string, string>> {
  const input = plainObject(value, "runtime environment");
  const entries = Object.entries(input);
  if (entries.length > 256) throw new RangeError("Runtime environment has too many entries.");
  const output: Record<string, string> = Object.create(null);
  for (const [name, raw] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!ENVIRONMENT_NAME.test(name) || ["__PROTO__", "CONSTRUCTOR", "PROTOTYPE"].includes(name)) {
      throw new TypeError(`Runtime environment name ${name} is invalid.`);
    }
    if (typeof raw !== "string" || raw.length > 65_536 || raw.includes("\0")) {
      throw new TypeError(`Runtime environment value for ${name} is invalid.`);
    }
    output[name] = raw;
  }
  return Object.freeze(output);
}

function digestMetadata(value: unknown, name: string): Readonly<{ bytes: number; sha256: string }> {
  const input = plainObject(value, name);
  exact(input, ["bytes", "sha256"]);
  if (typeof input.bytes !== "number"
    || !Number.isSafeInteger(input.bytes)
    || input.bytes < 0) {
    throw new TypeError(`${name} byte length is invalid.`);
  }
  if (typeof input.sha256 !== "string" || !DIGEST.test(input.sha256)) {
    throw new TypeError(`${name} digest is invalid.`);
  }
  return Object.freeze({ bytes: input.bytes, sha256: input.sha256 });
}

function validateSnapshotMode(
  mode: DeploymentRuntimeDatabaseManifest["mode"],
  snapshot: Uint8Array | null,
): void {
  if (mode === "preserve" && snapshot) {
    throw new TypeError("Preserved runtime data cannot include a replacement snapshot.");
  }
  if (mode === "replace" && !snapshot) {
    throw new TypeError("Replacing runtime data requires a database snapshot.");
  }
}

function assertSQLite(value: Uint8Array): void {
  if (value.byteLength < SQLITE_HEADER.byteLength) {
    throw new TypeError("Runtime database snapshot is not a SQLite database.");
  }
  for (let index = 0; index < SQLITE_HEADER.byteLength; index++) {
    if (value[index] !== SQLITE_HEADER[index]) {
      throw new TypeError("Runtime database snapshot is not a SQLite database.");
    }
  }
}

function capsuleLimits(limits: DeploymentRuntimeCapsuleLimits): {
  maxManifestBytes: number;
  maxArtifactBytes: number;
  maxDatabaseBytes: number;
  maxCapsuleBytes: number;
} {
  const maxManifestBytes = limit(limits.maxManifestBytes ?? 2 * 1024 * 1024, "maxManifestBytes");
  const maxArtifactBytes = limit(limits.maxArtifactBytes ?? 100 * 1024 * 1024, "maxArtifactBytes");
  const maxDatabaseBytes = limit(limits.maxDatabaseBytes ?? 512 * 1024 * 1024, "maxDatabaseBytes");
  const maximum = HEADER_BYTES + maxManifestBytes + maxArtifactBytes + maxDatabaseBytes;
  const maxCapsuleBytes = limit(limits.maxCapsuleBytes ?? maximum, "maxCapsuleBytes");
  return { maxManifestBytes, maxArtifactBytes, maxDatabaseBytes, maxCapsuleBytes };
}

function checkedTotal(
  manifest: number,
  artifact: number,
  database: number,
  maximum: number,
): number {
  const total = HEADER_BYTES + manifest + artifact + database;
  if (!Number.isSafeInteger(total) || total > maximum) {
    throw new RangeError(`Runtime capsule exceeds ${maximum} bytes.`);
  }
  return total;
}

function safeLength(value: bigint, name: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Runtime ${name} length is invalid.`);
  }
  return Number(value);
}

function limit(value: unknown, name: string): number {
  if (typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1_024
    || value > 2 * 1024 * 1024 * 1024) {
    throw new TypeError(`${name} must be an integer between 1024 and 2147483648.`);
  }
  return value;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`Runtime ${name} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`Runtime ${name} is invalid.`);
  }
  return value;
}

function databaseMode(value: unknown): DeploymentRuntimeDatabaseManifest["mode"] {
  if (value !== "initialize" && value !== "preserve" && value !== "replace") {
    throw new TypeError("Runtime database mode is invalid.");
  }
  return value;
}

function dataPath(value: unknown): string {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > 512
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("\0")
    || value.split("/").some((segment) =>
      !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new TypeError("Runtime database path is invalid.");
  }
  return value;
}

function ingressRoute(value: unknown): string {
  if (typeof value !== "string"
    || value.length < 2
    || value.length > 512
    || !value.startsWith("/")
    || value.startsWith("//")
    || value.includes("?")
    || value.includes("#")
    || value.includes("\0")
    || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/u.test(value)
    || value.split("/").some((segment, index) =>
      index > 0 && (!segment || segment === "." || segment === ".."))) {
    throw new TypeError("Runtime ingress route is invalid.");
  }
  return value;
}

function ingressToken(value: unknown): string {
  if (typeof value !== "string"
    || value.length < 32
    || value.length > 512
    || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new TypeError("Runtime ingress token is invalid.");
  }
  return value;
}

function bytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`Runtime ${name} bytes are invalid.`);
  return value;
}

function plainObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  const expected = new Set(allowed);
  if (Object.keys(value).some((key) => !expected.has(key))) {
    throw new TypeError("Runtime manifest contains an unknown field.");
  }
  if (allowed.some((key) => !(key in value))) {
    throw new TypeError("Runtime manifest is missing a required field.");
  }
}

async function digest(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...bytes].map((part) => part.toString(16).padStart(2, "0")).join("");
}
