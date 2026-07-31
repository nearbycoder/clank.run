import { defineApp, type AppBlueprint, type AppBlueprintInput } from "./blueprint.ts";

export type BlueprintRegistryKeyRole = "publisher" | "registry";

export interface BlueprintPrivateKey {
  readonly protocol: "clank-blueprint-private-key/1";
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly label: string;
  readonly publicKey: string;
  readonly privateKey: string;
  readonly createdAt: number;
}

export interface BlueprintTrustKey {
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly label: string;
  readonly publicKey: string;
  readonly roles: readonly BlueprintRegistryKeyRole[];
  /** Exact owner namespaces this publisher may sign, or `*`. */
  readonly namespaces?: readonly string[];
  /** Exact HTTPS registry origins this registry key may sign, or `*`. */
  readonly registries?: readonly string[];
}

export interface BlueprintTrustPolicy {
  readonly protocol: "clank-blueprint-trust/1";
  readonly keys: readonly BlueprintTrustKey[];
  readonly revokedKeyIds?: readonly string[];
  readonly revokedReleaseDigests?: readonly string[];
  /** Refuse signed catalogs older than the remembered sequence for an origin. */
  readonly minimumCatalogSequences?: Readonly<Record<string, number>>;
}

export interface SignedBlueprintRelease {
  readonly protocol: "clank-blueprint-release/1";
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly createdAt: number;
  readonly blueprint: AppBlueprint;
  readonly blueprintDigest: string;
  readonly publisherKeyId: string;
  readonly digest: string;
  readonly signature: string;
}

export interface BlueprintCatalogEntry {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly releaseDigest: string;
  readonly publisherKeyId: string;
  /** Registry-relative JSON path. */
  readonly path: string;
}

export interface SignedBlueprintCatalog {
  readonly protocol: "clank-blueprint-catalog/1";
  readonly registry: string;
  readonly sequence: number;
  readonly createdAt: number;
  readonly releases: readonly BlueprintCatalogEntry[];
  readonly registryKeyId: string;
  readonly digest: string;
  readonly signature: string;
}

export interface VerifiedBlueprintRelease {
  readonly release: SignedBlueprintRelease;
  readonly blueprint: AppBlueprint;
  readonly publisher: BlueprintTrustKey;
}

export interface VerifiedBlueprintCatalog {
  readonly catalog: SignedBlueprintCatalog;
  readonly registry: BlueprintTrustKey;
}

export interface BlueprintRegistryFetchOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

export async function generateBlueprintSigningKey(
  label: string,
  options: {
    createdAt?: number;
    scope: { role: "publisher"; namespaces: readonly string[] }
      | { role: "registry"; registries: readonly string[] };
  },
): Promise<{ privateKey: BlueprintPrivateKey; trustKey: BlueprintTrustKey }> {
  const safeLabel = text(label, "key label", 1, 100);
  if (!options?.scope) throw new TypeError("Blueprint signing keys require an explicit publisher or registry scope.");
  const createdAt = timestamp(options.createdAt ?? Date.now(), "createdAt");
  const scope = options.scope.role === "publisher"
    ? { roles: ["publisher"] as const, namespaces: uniqueStrings(options.scope.namespaces, namespace, "namespaces", 100) }
    : options.scope.role === "registry"
      ? { roles: ["registry"] as const, registries: uniqueStrings(options.scope.registries, (entry) => entry === "*" ? "*" : registryOrigin(entry), "registries", 100) }
      : (() => { throw new TypeError("Blueprint signing key scope role must be publisher or registry."); })();
  if (("namespaces" in scope && scope.namespaces.length === 0) || ("registries" in scope && scope.registries.length === 0)) {
    throw new TypeError("Blueprint signing key scope must contain at least one namespace or registry origin.");
  }
  const crypto = await nodeCrypto();
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" });
  const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" });
  const publicEncoded = base64Url(publicKey);
  const keyId = `ed25519:${await sha256Bytes(publicKey)}`;
  return deepFreeze({
    privateKey: {
      protocol: "clank-blueprint-private-key/1",
      algorithm: "Ed25519",
      keyId,
      label: safeLabel,
      publicKey: publicEncoded,
      privateKey: base64Url(privateKey),
      createdAt,
    },
    trustKey: {
      keyId,
      algorithm: "Ed25519",
      label: safeLabel,
      publicKey: publicEncoded,
      ...scope,
    },
  });
}

export async function signBlueprintRelease(
  blueprintInput: AppBlueprintInput | AppBlueprint,
  input: {
    name: string;
    version: string;
    description?: string;
    createdAt?: number;
    key: BlueprintPrivateKey;
  },
): Promise<SignedBlueprintRelease> {
  const key = await validatePrivateKey(input.key);
  const blueprint = defineApp(blueprintInput);
  const name = packageName(input.name);
  const version = semver(input.version);
  const description = text(input.description ?? blueprint.description, "release description", 1, 500);
  const createdAt = timestamp(input.createdAt ?? Date.now(), "createdAt");
  const blueprintDigest = await sha256(canonical(blueprint));
  const unsigned = {
    protocol: "clank-blueprint-release/1" as const,
    name,
    version,
    description,
    createdAt,
    blueprint,
    blueprintDigest,
    publisherKeyId: key.keyId,
  };
  const digest = await sha256(canonical(unsigned));
  const signature = await signPayload(RELEASE_DOMAIN, canonical({ ...unsigned, digest }), key);
  return deepFreeze({ ...unsigned, digest, signature });
}

export async function verifyBlueprintRelease(
  value: unknown,
  trustInput: BlueprintTrustPolicy,
  options: { now?: number; minimumCreatedAt?: number } = {},
): Promise<VerifiedBlueprintRelease> {
  const release = normalizeRelease(value);
  const trust = await normalizeTrustPolicy(trustInput);
  const current = timestamp(options.now ?? Date.now(), "now");
  if (release.createdAt > current + MAX_CLOCK_SKEW) throw new BlueprintRegistryError("RELEASE_FROM_FUTURE", "Blueprint release creation time is in the future.");
  if (options.minimumCreatedAt !== undefined && release.createdAt < timestamp(options.minimumCreatedAt, "minimumCreatedAt")) {
    throw new BlueprintRegistryError("RELEASE_TOO_OLD", "Blueprint release predates the required trust window.");
  }
  if (trust.revokedKeyIds.includes(release.publisherKeyId)) {
    throw new BlueprintRegistryError("KEY_REVOKED", `Blueprint publisher key ${release.publisherKeyId} is revoked.`);
  }
  if (trust.revokedReleaseDigests.includes(release.digest)) {
    throw new BlueprintRegistryError("RELEASE_REVOKED", `Blueprint release ${release.digest} is revoked.`);
  }
  const publisher = trust.keys.get(release.publisherKeyId);
  if (!publisher || !publisher.roles.includes("publisher")) {
    throw new BlueprintRegistryError("PUBLISHER_UNTRUSTED", `Blueprint publisher key ${release.publisherKeyId} is not trusted.`);
  }
  const namespace = release.name.slice(0, release.name.indexOf("/"));
  if (!publisher.namespaces?.includes("*") && !publisher.namespaces?.includes(namespace)) {
    throw new BlueprintRegistryError("NAMESPACE_UNTRUSTED", `Publisher ${publisher.keyId} is not trusted for ${namespace}.`);
  }
  const blueprint = defineApp(release.blueprint);
  if (canonical(blueprint) !== canonical(release.blueprint)) {
    throw new BlueprintRegistryError("BLUEPRINT_NONCANONICAL", "Signed blueprint must contain the complete normalized data contract.");
  }
  const blueprintDigest = await sha256(canonical(blueprint));
  if (blueprintDigest !== release.blueprintDigest) {
    throw new BlueprintRegistryError("BLUEPRINT_DIGEST_MISMATCH", "Signed blueprint digest does not match its data.");
  }
  const { digest: claimedDigest, signature, ...unsigned } = release;
  const digest = await sha256(canonical(unsigned));
  if (digest !== claimedDigest) throw new BlueprintRegistryError("RELEASE_DIGEST_MISMATCH", "Blueprint release digest does not match its metadata.");
  await verifyPayload(RELEASE_DOMAIN, canonical({ ...unsigned, digest }), signature, publisher);
  return deepFreeze({ release, blueprint, publisher });
}

export async function signBlueprintCatalog(
  input: {
    registry: string;
    sequence: number;
    createdAt?: number;
    releases: readonly BlueprintCatalogEntry[];
    key: BlueprintPrivateKey;
  },
): Promise<SignedBlueprintCatalog> {
  const key = await validatePrivateKey(input.key);
  const registry = registryOrigin(input.registry);
  const sequence = positiveInteger(input.sequence, "catalog sequence", 1, Number.MAX_SAFE_INTEGER);
  const createdAt = timestamp(input.createdAt ?? Date.now(), "createdAt");
  const releases = normalizeCatalogEntries([...input.releases].sort((left, right) =>
    `${String(left.name)}@${String(left.version)}`.localeCompare(`${String(right.name)}@${String(right.version)}`)));
  const unsigned = {
    protocol: "clank-blueprint-catalog/1" as const,
    registry,
    sequence,
    createdAt,
    releases,
    registryKeyId: key.keyId,
  };
  const digest = await sha256(canonical(unsigned));
  const signature = await signPayload(CATALOG_DOMAIN, canonical({ ...unsigned, digest }), key);
  return deepFreeze({ ...unsigned, digest, signature });
}

export async function verifyBlueprintCatalog(
  value: unknown,
  trustInput: BlueprintTrustPolicy,
  options: { now?: number } = {},
): Promise<VerifiedBlueprintCatalog> {
  const catalog = normalizeCatalog(value);
  const trust = await normalizeTrustPolicy(trustInput);
  const current = timestamp(options.now ?? Date.now(), "now");
  if (catalog.createdAt > current + MAX_CLOCK_SKEW) throw new BlueprintRegistryError("CATALOG_FROM_FUTURE", "Blueprint catalog creation time is in the future.");
  if (trust.revokedKeyIds.includes(catalog.registryKeyId)) {
    throw new BlueprintRegistryError("KEY_REVOKED", `Blueprint registry key ${catalog.registryKeyId} is revoked.`);
  }
  const registryKey = trust.keys.get(catalog.registryKeyId);
  if (!registryKey || !registryKey.roles.includes("registry")) {
    throw new BlueprintRegistryError("REGISTRY_UNTRUSTED", `Blueprint registry key ${catalog.registryKeyId} is not trusted.`);
  }
  if (!registryKey.registries?.includes("*") && !registryKey.registries?.includes(catalog.registry)) {
    throw new BlueprintRegistryError("REGISTRY_ORIGIN_UNTRUSTED", `Registry key ${registryKey.keyId} is not trusted for ${catalog.registry}.`);
  }
  const minimum = trust.minimumCatalogSequences[catalog.registry] ?? 0;
  if (catalog.sequence < minimum) {
    throw new BlueprintRegistryError("CATALOG_ROLLBACK", `Blueprint catalog sequence ${catalog.sequence} is older than trusted sequence ${minimum}.`);
  }
  const { digest: claimedDigest, signature, ...unsigned } = catalog;
  const digest = await sha256(canonical(unsigned));
  if (digest !== claimedDigest) throw new BlueprintRegistryError("CATALOG_DIGEST_MISMATCH", "Blueprint catalog digest does not match its metadata.");
  await verifyPayload(CATALOG_DOMAIN, canonical({ ...unsigned, digest }), signature, registryKey);
  return deepFreeze({ catalog, registry: registryKey });
}

export async function fetchBlueprintCatalog(
  urlInput: string | URL,
  trust: BlueprintTrustPolicy,
  options: BlueprintRegistryFetchOptions = {},
): Promise<VerifiedBlueprintCatalog> {
  const url = httpsUrl(urlInput, "catalog URL");
  if (url.hash) throw new TypeError("Blueprint catalog URL cannot contain a fragment.");
  const value = await fetchJson(url, options);
  const verified = await verifyBlueprintCatalog(value, trust);
  if (new URL(verified.catalog.registry).origin !== url.origin) {
    throw new BlueprintRegistryError("CATALOG_ORIGIN_MISMATCH", "Catalog registry origin does not match the fetched origin.");
  }
  return verified;
}

export async function resolveBlueprintRelease(
  catalogInput: SignedBlueprintCatalog | VerifiedBlueprintCatalog,
  input: { name: string; version: string },
  trust: BlueprintTrustPolicy,
  options: BlueprintRegistryFetchOptions = {},
): Promise<VerifiedBlueprintRelease> {
  const verifiedCatalog = await verifyBlueprintCatalog("catalog" in catalogInput ? catalogInput.catalog : catalogInput, trust);
  const name = packageName(input.name);
  const version = semver(input.version);
  const entry = verifiedCatalog.catalog.releases.find((candidate) => candidate.name === name && candidate.version === version);
  if (!entry) throw new BlueprintRegistryError("RELEASE_NOT_FOUND", `Blueprint ${name}@${version} is not in the signed catalog.`);
  const url = new URL(entry.path, verifiedCatalog.catalog.registry);
  if (url.origin !== new URL(verifiedCatalog.catalog.registry).origin) {
    throw new BlueprintRegistryError("RELEASE_ORIGIN_MISMATCH", "Blueprint release path escapes its registry origin.");
  }
  const value = await fetchJson(url, options);
  const verified = await verifyBlueprintRelease(value, trust);
  if (verified.release.name !== name || verified.release.version !== version) {
    throw new BlueprintRegistryError("RELEASE_IDENTITY_MISMATCH", "Fetched blueprint release has the wrong name or version.");
  }
  if (verified.release.digest !== entry.releaseDigest || verified.release.publisherKeyId !== entry.publisherKeyId) {
    throw new BlueprintRegistryError("RELEASE_CATALOG_MISMATCH", "Fetched blueprint release does not match the signed catalog entry.");
  }
  if (verified.release.description !== entry.description) {
    throw new BlueprintRegistryError("RELEASE_CATALOG_MISMATCH", "Fetched blueprint release description does not match the signed catalog entry.");
  }
  return verified;
}

export function createBlueprintTrustPolicy(input: {
  keys: readonly BlueprintTrustKey[];
  revokedKeyIds?: readonly string[];
  revokedReleaseDigests?: readonly string[];
  minimumCatalogSequences?: Readonly<Record<string, number>>;
}): BlueprintTrustPolicy {
  if (!input || !Array.isArray(input.keys)) throw new TypeError("Blueprint trust policy keys are required.");
  const keyIds = input.keys.map((key) => keyIdentifier(key?.keyId));
  if (new Set(keyIds).size !== keyIds.length) throw new TypeError("Blueprint trust policy key IDs must be unique.");
  const revokedKeyIds = uniqueStrings(input.revokedKeyIds ?? [], keyIdentifier, "revokedKeyIds", MAX_TRUST_KEYS);
  const revokedReleaseDigests = uniqueStrings(input.revokedReleaseDigests ?? [], (entry) => hexDigest(entry, "revoked release digest"), "revokedReleaseDigests", MAX_RELEASES);
  const minimumCatalogSequences: Record<string, number> = {};
  for (const [origin, sequence] of Object.entries(input.minimumCatalogSequences ?? {})) {
    const normalized = registryOrigin(origin);
    if (normalized !== origin) throw new TypeError(`minimumCatalogSequences key must be a canonical origin ending in /: ${origin}`);
    minimumCatalogSequences[normalized] = positiveInteger(sequence, "minimum catalog sequence", 1, Number.MAX_SAFE_INTEGER);
  }
  const value = {
    protocol: "clank-blueprint-trust/1" as const,
    keys: input.keys,
    revokedKeyIds,
    revokedReleaseDigests,
    minimumCatalogSequences,
  };
  normalizeTrustPolicyShape(value);
  return deepFreeze(structuredClone(value));
}

export class BlueprintRegistryError extends Error {
  readonly name = "BlueprintRegistryError";
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function validatePrivateKey(value: BlueprintPrivateKey): Promise<BlueprintPrivateKey> {
  const source = record(value, "private key");
  exactKeys(source, ["protocol", "algorithm", "keyId", "label", "publicKey", "privateKey", "createdAt"], "private key");
  if (source.protocol !== "clank-blueprint-private-key/1" || source.algorithm !== "Ed25519") throw new TypeError("Unsupported blueprint private key protocol or algorithm.");
  const publicBytes = decodeBase64Url(source.publicKey, "publicKey", MAX_KEY_BYTES);
  const privateBytes = decodeBase64Url(source.privateKey, "privateKey", MAX_KEY_BYTES);
  const keyId = keyIdentifier(source.keyId);
  if (`ed25519:${await sha256Bytes(publicBytes)}` !== keyId) throw new TypeError("Blueprint private key ID does not match its public key.");
  const crypto = await nodeCrypto();
  const privateObject = crypto.createPrivateKey({ key: privateBytes, format: "der", type: "pkcs8" });
  const derived = crypto.createPublicKey(privateObject).export({ format: "der", type: "spki" });
  if (!constantTimeEqual(publicBytes, derived)) throw new TypeError("Blueprint private and public keys do not match.");
  return deepFreeze({
    protocol: "clank-blueprint-private-key/1",
    algorithm: "Ed25519",
    keyId,
    label: text(source.label, "key label", 1, 100),
    publicKey: base64Url(publicBytes),
    privateKey: base64Url(privateBytes),
    createdAt: timestamp(source.createdAt, "createdAt"),
  });
}

function normalizeRelease(value: unknown): SignedBlueprintRelease {
  const source = record(value, "blueprint release");
  exactKeys(source, ["protocol", "name", "version", "description", "createdAt", "blueprint", "blueprintDigest", "publisherKeyId", "digest", "signature"], "blueprint release");
  if (source.protocol !== "clank-blueprint-release/1") throw new TypeError("Unsupported blueprint release protocol.");
  const blueprint = structuredClone(record(source.blueprint, "blueprint")) as unknown as AppBlueprint;
  return deepFreeze({
    protocol: "clank-blueprint-release/1",
    name: packageName(source.name),
    version: semver(source.version),
    description: text(source.description, "release description", 1, 500),
    createdAt: timestamp(source.createdAt, "createdAt"),
    blueprint,
    blueprintDigest: hexDigest(source.blueprintDigest, "blueprintDigest"),
    publisherKeyId: keyIdentifier(source.publisherKeyId),
    digest: hexDigest(source.digest, "release digest"),
    signature: signature(source.signature),
  });
}

function normalizeCatalog(value: unknown): SignedBlueprintCatalog {
  const source = record(value, "blueprint catalog");
  exactKeys(source, ["protocol", "registry", "sequence", "createdAt", "releases", "registryKeyId", "digest", "signature"], "blueprint catalog");
  if (source.protocol !== "clank-blueprint-catalog/1") throw new TypeError("Unsupported blueprint catalog protocol.");
  return deepFreeze({
    protocol: "clank-blueprint-catalog/1",
    registry: registryOrigin(source.registry),
    sequence: positiveInteger(source.sequence, "catalog sequence", 1, Number.MAX_SAFE_INTEGER),
    createdAt: timestamp(source.createdAt, "createdAt"),
    releases: normalizeCatalogEntries(source.releases),
    registryKeyId: keyIdentifier(source.registryKeyId),
    digest: hexDigest(source.digest, "catalog digest"),
    signature: signature(source.signature),
  });
}

function normalizeCatalogEntries(value: unknown): readonly BlueprintCatalogEntry[] {
  if (!Array.isArray(value) || value.length > MAX_RELEASES) throw new TypeError(`Catalog releases must be an array of at most ${MAX_RELEASES} entries.`);
  const entries = value.map((entry, index) => {
    const source = record(entry, `catalog release ${index}`);
    exactKeys(source, ["name", "version", "description", "releaseDigest", "publisherKeyId", "path"], `catalog release ${index}`);
    return Object.freeze({
      name: packageName(source.name),
      version: semver(source.version),
      description: text(source.description, "release description", 1, 500),
      releaseDigest: hexDigest(source.releaseDigest, "releaseDigest"),
      publisherKeyId: keyIdentifier(source.publisherKeyId),
      path: releasePath(source.path),
    });
  });
  const identities = entries.map((entry) => `${entry.name}@${entry.version}`);
  if (new Set(identities).size !== identities.length) throw new TypeError("Catalog cannot contain duplicate blueprint name and version entries.");
  const sorted = [...entries].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
  if (canonical(entries) !== canonical(sorted)) throw new TypeError("Catalog releases must be sorted by name and version.");
  return Object.freeze(entries);
}

interface NormalizedTrust {
  keys: Map<string, BlueprintTrustKey>;
  revokedKeyIds: readonly string[];
  revokedReleaseDigests: readonly string[];
  minimumCatalogSequences: Readonly<Record<string, number>>;
}

async function normalizeTrustPolicy(value: BlueprintTrustPolicy): Promise<NormalizedTrust> {
  normalizeTrustPolicyShape(value);
  const keys = new Map<string, BlueprintTrustKey>();
  for (const entry of value.keys) {
    const key = normalizeTrustKey(entry);
    const publicBytes = decodeBase64Url(key.publicKey, "publicKey", MAX_KEY_BYTES);
    if (`ed25519:${await sha256Bytes(publicBytes)}` !== key.keyId) throw new TypeError(`Trust key ${key.keyId} does not match its public key.`);
    if (keys.has(key.keyId)) throw new TypeError(`Duplicate blueprint trust key: ${key.keyId}`);
    keys.set(key.keyId, key);
  }
  const revokedKeyIds = uniqueStrings(value.revokedKeyIds ?? [], keyIdentifier, "revokedKeyIds", MAX_TRUST_KEYS);
  const revokedReleaseDigests = uniqueStrings(value.revokedReleaseDigests ?? [], (entry) => hexDigest(entry, "revoked release digest"), "revokedReleaseDigests", MAX_RELEASES);
  const minimumCatalogSequences: Record<string, number> = {};
  for (const [origin, sequence] of Object.entries(value.minimumCatalogSequences ?? {})) {
    const normalized = registryOrigin(origin);
    if (normalized !== origin) throw new TypeError(`minimumCatalogSequences key must be a canonical origin ending in /: ${origin}`);
    minimumCatalogSequences[normalized] = positiveInteger(sequence, "minimum catalog sequence", 1, Number.MAX_SAFE_INTEGER);
  }
  return { keys, revokedKeyIds, revokedReleaseDigests, minimumCatalogSequences: Object.freeze(minimumCatalogSequences) };
}

function normalizeTrustPolicyShape(value: BlueprintTrustPolicy): void {
  const source = record(value, "blueprint trust policy");
  exactKeys(source, ["protocol", "keys", "revokedKeyIds", "revokedReleaseDigests", "minimumCatalogSequences"], "blueprint trust policy", true);
  if (source.protocol !== "clank-blueprint-trust/1") throw new TypeError("Unsupported blueprint trust policy protocol.");
  if (!Array.isArray(source.keys) || source.keys.length === 0 || source.keys.length > MAX_TRUST_KEYS) {
    throw new TypeError(`Blueprint trust policy must contain 1-${MAX_TRUST_KEYS} keys.`);
  }
  for (const key of source.keys) normalizeTrustKey(key);
  if (source.minimumCatalogSequences !== undefined) record(source.minimumCatalogSequences, "minimumCatalogSequences");
}

function normalizeTrustKey(value: unknown): BlueprintTrustKey {
  const source = record(value, "blueprint trust key");
  exactKeys(source, ["keyId", "algorithm", "label", "publicKey", "roles", "namespaces", "registries"], "blueprint trust key", true);
  if (source.algorithm !== "Ed25519") throw new TypeError("Blueprint trust keys must use Ed25519.");
  if (!Array.isArray(source.roles) || source.roles.length === 0 || source.roles.length > 2) throw new TypeError("Blueprint trust key roles are required.");
  const roles = uniqueStrings(source.roles, (entry) => {
    if (entry !== "publisher" && entry !== "registry") throw new TypeError("Blueprint trust key role must be publisher or registry.");
    return entry;
  }, "roles", 2) as BlueprintRegistryKeyRole[];
  const namespaces = source.namespaces === undefined ? undefined : uniqueStrings(source.namespaces, namespace, "namespaces", 100);
  const registries = source.registries === undefined ? undefined : uniqueStrings(source.registries, (entry) => entry === "*" ? "*" : registryOrigin(entry), "registries", 100);
  if (roles.includes("publisher") && !namespaces?.length) throw new TypeError("Publisher trust keys require at least one namespace or *.");
  if (roles.includes("registry") && !registries?.length) throw new TypeError("Registry trust keys require at least one registry origin or *.");
  return deepFreeze({
    keyId: keyIdentifier(source.keyId),
    algorithm: "Ed25519",
    label: text(source.label, "key label", 1, 100),
    publicKey: base64Url(decodeBase64Url(source.publicKey, "publicKey", MAX_KEY_BYTES)),
    roles: Object.freeze(roles),
    ...(namespaces === undefined ? {} : { namespaces: Object.freeze(namespaces) }),
    ...(registries === undefined ? {} : { registries: Object.freeze(registries) }),
  });
}

async function signPayload(domain: string, canonicalValue: string, key: BlueprintPrivateKey): Promise<string> {
  const crypto = await nodeCrypto();
  const privateObject = crypto.createPrivateKey({ key: decodeBase64Url(key.privateKey, "privateKey", MAX_KEY_BYTES), format: "der", type: "pkcs8" });
  return base64Url(crypto.sign(null, Buffer.from(`${domain}\u0000${canonicalValue}`), privateObject));
}

async function verifyPayload(domain: string, canonicalValue: string, encoded: string, key: BlueprintTrustKey): Promise<void> {
  const crypto = await nodeCrypto();
  const publicObject = crypto.createPublicKey({ key: decodeBase64Url(key.publicKey, "publicKey", MAX_KEY_BYTES), format: "der", type: "spki" });
  const valid = crypto.verify(null, Buffer.from(`${domain}\u0000${canonicalValue}`), publicObject, decodeBase64Url(encoded, "signature", MAX_SIGNATURE_BYTES));
  if (!valid) throw new BlueprintRegistryError("SIGNATURE_INVALID", "Blueprint signature verification failed.");
}

async function fetchJson(url: URL, options: BlueprintRegistryFetchOptions): Promise<unknown> {
  const timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, "registry timeoutMs", 100, 60_000);
  const maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_FETCH_BYTES, "registry maxBytes", 1_024, MAX_FETCH_BYTES);
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Blueprint registry request timed out."));
  }, timeoutMs);
  try {
    const response = await Promise.race([
      Promise.resolve((options.fetch ?? fetch)(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
      })),
      new Promise<never>((_resolve, reject) => {
        const aborted = () => reject(controller.signal.reason ?? new Error("Blueprint registry request aborted."));
        if (controller.signal.aborted) aborted();
        else controller.signal.addEventListener("abort", aborted, { once: true });
      }),
    ]);
    if (response.status >= 300 && response.status < 400) throw new BlueprintRegistryError("REDIRECT_REFUSED", "Blueprint registry redirects are refused.");
    if (!response.ok) throw new BlueprintRegistryError("FETCH_FAILED", `Blueprint registry returned HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") throw new BlueprintRegistryError("CONTENT_TYPE_INVALID", "Blueprint registry responses must use application/json.");
    const bytes = await boundedResponseBytes(response, maxBytes);
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new BlueprintRegistryError("JSON_INVALID", "Blueprint registry returned invalid JSON."); }
  } catch (error) {
    if (error instanceof BlueprintRegistryError) throw error;
    if (timedOut) throw new BlueprintRegistryError("FETCH_TIMEOUT", "Blueprint registry request timed out.");
    if (options.signal?.aborted) throw new BlueprintRegistryError("FETCH_ABORTED", "Blueprint registry request was aborted.");
    throw new BlueprintRegistryError("FETCH_FAILED", "Blueprint registry request failed.");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function boundedResponseBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) throw new BlueprintRegistryError("RESPONSE_TOO_LARGE", "Blueprint registry response exceeds its byte limit.");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximum) throw new BlueprintRegistryError("RESPONSE_TOO_LARGE", "Blueprint registry response exceeds its byte limit.");
      chunks.push(result.value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original bounded read failure. */ }
    throw error;
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function record(value: unknown, path: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain object.`);
  return value as Record<string, any>;
}

function exactKeys(source: Record<string, unknown>, required: readonly string[], path: string, optional = false): void {
  const allowed = new Set(required);
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw new TypeError(`${path} contains unknown property ${key}.`);
  if (!optional) for (const key of required) if (!Object.hasOwn(source, key)) throw new TypeError(`${path} is missing ${key}.`);
}

function packageName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(value)) {
    throw new TypeError("Blueprint package name must be owner/name with lowercase letters, digits, and internal hyphens.");
  }
  return value;
}

function namespace(value: unknown): string {
  if (value === "*") return value;
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(value)) throw new TypeError(`Invalid blueprint namespace: ${String(value)}.`);
  return value;
}

function semver(value: unknown): string {
  if (typeof value !== "string" || value.length > 100 || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(value)) {
    throw new TypeError("Blueprint version must be an exact semantic version without build metadata.");
  }
  return value;
}

function registryOrigin(value: unknown): string {
  const url = httpsUrl(value as string, "registry origin");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new TypeError("Blueprint registry must be a canonical HTTPS origin ending in /.");
  return `${url.origin}/`;
}

function httpsUrl(value: string | URL, path: string): URL {
  let url: URL;
  try { url = value instanceof URL ? new URL(value.href) : new URL(value); }
  catch { throw new TypeError(`${path} must be an absolute HTTPS URL.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new TypeError(`${path} must use a credential-free default-port HTTPS URL.`);
  return url;
}

function releasePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 500 || value.startsWith("/") || value.includes("\\") || value.includes("//") || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/u.test(value)) throw new TypeError("Blueprint release path must be a safe registry-relative JSON path.");
  if (value.split("/").some((part) => part === "." || part === ".." || !part)) throw new TypeError("Blueprint release path cannot contain traversal segments.");
  return value;
}

function keyIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^ed25519:[a-f0-9]{64}$/u.test(value)) throw new TypeError("Blueprint key ID must be an Ed25519 SHA-256 fingerprint.");
  return value;
}

function hexDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${path} must be a lowercase SHA-256 digest.`);
  return value;
}

function signature(value: unknown): string {
  const bytes = decodeBase64Url(value, "signature", MAX_SIGNATURE_BYTES);
  if (bytes.byteLength !== 64) throw new TypeError("Ed25519 signatures must contain 64 bytes.");
  return base64Url(bytes);
}

function decodeBase64Url(value: unknown, path: string, maximum: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError(`${path} must be unpadded base64url.`);
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)); }
  catch { throw new TypeError(`${path} must be valid base64url.`); }
  if (bytes.byteLength > maximum || base64Url(bytes) !== value) throw new TypeError(`${path} is invalid or exceeds its byte limit.`);
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function text(value: unknown, path: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new TypeError(`${path} must be ${minimum}-${maximum} safe text characters.`);
  return value;
}

function timestamp(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${path} must be a non-negative millisecond timestamp.`);
  return value;
}

function positiveInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${path} must be an integer from ${minimum} through ${maximum}.`);
  return value;
}

function uniqueStrings<Value extends string>(value: unknown, normalize: (entry: unknown) => Value, path: string, maximum: number): Value[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${path} must be an array of at most ${maximum} entries.`);
  const output = value.map(normalize);
  if (new Set(output).size !== output.length) throw new TypeError(`${path} entries must be unique.`);
  return output;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || !Number.isFinite(value as number) && typeof value === "number") throw new TypeError("Signed blueprint values must be finite JSON data.");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const source = record(value, "signed value");
  return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

let cryptoPromise: Promise<any> | undefined;
function nodeCrypto(): Promise<any> {
  const moduleName = "node:crypto";
  return cryptoPromise ??= import(moduleName);
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

const RELEASE_DOMAIN = "clank-blueprint-release/1";
const CATALOG_DOMAIN = "clank-blueprint-catalog/1";
const MAX_CLOCK_SKEW = 5 * 60 * 1_000;
const MAX_RELEASES = 10_000;
const MAX_TRUST_KEYS = 1_000;
const MAX_KEY_BYTES = 512;
const MAX_SIGNATURE_BYTES = 128;
const DEFAULT_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_FETCH_BYTES = 8 * 1024 * 1024;
