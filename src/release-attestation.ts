import { decodeDeploymentBundle, deploymentDigest, type DeploymentBundle } from "./deploy.ts";
export interface ReleaseSigningKey { keyId: string; publicKey: string; privateKey: string; }
export interface ReleaseTrustKey { keyId: string; publicKey: string; projects: readonly string[]; builders: readonly string[]; notAfter?: number; }
export interface ReleaseAttestationPolicy { keys: readonly ReleaseTrustKey[]; required?: boolean; maxAgeMs?: number; }
export interface ReleaseAttestation {
  protocol: "clank-release-attestation/1"; keyId: string;
  statement: { artifactSha256: string; schemaSha256: string; projectId: string; builder: string; buildId: string; sourceRevision: string | null; capabilities: readonly string[]; issuedAt: number; expiresAt: number };
  signature: string;
}
const bytes = (value: string, maximum: number) => { if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > maximum * 2) throw new TypeError("Invalid signing key or signature."); const raw = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0)); if (raw.byteLength > maximum || encode(raw) !== value) throw new TypeError("Invalid signing encoding."); return raw; };
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const text = (value: unknown, maximum = 200) => { if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError("Invalid release identity."); return value; };
const exact = (value: any, keys: string[]) => { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError("Invalid release attestation shape."); };
async function facts(bundle: DeploymentBundle): Promise<{ schemaSha256: string; capabilities: string[] }> {
  const migrations = bundle.files.filter(file => file.path.startsWith(`${bundle.config.database.migrations}/`) && file.path.endsWith(".sql")).map(file => [file.path, file.sha256]).sort((a,b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
  const schemaSha256 = await deploymentDigest(new TextEncoder().encode(JSON.stringify({ database: bundle.config.database, migrations })));
  return { schemaSha256, capabilities: ["database:sqlite", ...(bundle.config.database.allowUnsafeMigrations ? ["migrations:unsafe"] : []), ...(bundle.config.jobs ? ["jobs:worker", ...(bundle.config.jobs.scheduler ? ["jobs:scheduler"] : [])] : []), ...(bundle.config.database.previewData ? ["preview:data"] : [])].sort() };
}
function canonical(value: ReleaseAttestation): string {
  return JSON.stringify({ protocol: value.protocol, keyId: value.keyId, statement: { artifactSha256: value.statement.artifactSha256, schemaSha256: value.statement.schemaSha256, projectId: value.statement.projectId, builder: value.statement.builder, buildId: value.statement.buildId, sourceRevision: value.statement.sourceRevision, capabilities: value.statement.capabilities, issuedAt: value.statement.issuedAt, expiresAt: value.statement.expiresAt } });
}
export async function generateReleaseSigningKey(keyId: string): Promise<ReleaseSigningKey> {
  text(keyId, 80); const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { keyId, publicKey: encode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))), privateKey: encode(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))) };
}
export async function signReleaseAttestation(artifact: Uint8Array, key: ReleaseSigningKey, identity: { projectId: string; builder: string; buildId: string; now?: number; lifetimeMs?: number }): Promise<ReleaseAttestation> {
  const now = identity.now ?? Date.now(), ttl = identity.lifetimeMs ?? 3600000;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 604800000) throw new TypeError("Invalid attestation lifetime.");
  const bundle = await decodeDeploymentBundle(artifact), bound = await facts(bundle);
  const result: ReleaseAttestation = { protocol: "clank-release-attestation/1", keyId: text(key.keyId, 80), statement: { artifactSha256: await deploymentDigest(artifact), ...bound, projectId: text(identity.projectId), builder: text(identity.builder), buildId: text(identity.buildId), sourceRevision: bundle.provenance.sourceRevision ?? null, issuedAt: now, expiresAt: now + ttl }, signature: "" };
  const privateKey = await crypto.subtle.importKey("pkcs8", bytes(key.privateKey, 128), { name: "Ed25519" }, false, ["sign"]);
  result.signature = encode(new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(canonical(result)))));
  return result;
}
export function encodeReleaseAttestation(attestation: ReleaseAttestation): string {
  const json = JSON.stringify(attestation); if (json.length > 8192) throw new TypeError("Release attestation exceeds 8 KiB."); return encode(new TextEncoder().encode(json));
}
export function decodeReleaseAttestation(header: string): ReleaseAttestation {
  if (typeof header !== "string" || header.length > 12000) throw new TypeError("Release attestation header exceeds its bound.");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(header, 8192)));
}
/** Verifies artifact bytes, migration/configuration digest, exact project and current signing policy. */
export async function verifyReleaseAttestation(artifact: Uint8Array, input: unknown, policy: ReleaseAttestationPolicy, projectId: string, now = Date.now()): Promise<ReleaseAttestation> {
  if (!Number.isSafeInteger(now) || now < 0 || !policy || !Array.isArray(policy.keys) || !policy.keys.length || policy.keys.length > 100) throw new TypeError("Invalid release trust policy.");
  const maximumAge = policy.maxAgeMs ?? 86400000;
  if (!Number.isSafeInteger(maximumAge) || maximumAge < 1000 || maximumAge > 604800000) throw new TypeError("Invalid attestation maximum age.");
  const value = input as ReleaseAttestation;
  exact(value, ["protocol", "keyId", "statement", "signature"]);
  exact(value.statement, ["artifactSha256", "schemaSha256", "projectId", "builder", "buildId", "sourceRevision", "capabilities", "issuedAt", "expiresAt"]);
  const claim = value.statement;
  if (value.protocol !== "clank-release-attestation/1" || !/^[a-f0-9]{64}$/.test(claim.artifactSha256) || !/^[a-f0-9]{64}$/.test(claim.schemaSha256)) throw new TypeError("Unsupported release attestation.");
  text(value.keyId, 80); text(claim.projectId); text(claim.builder); text(claim.buildId);
  if (claim.sourceRevision !== null) text(claim.sourceRevision, 256);
  if (!Array.isArray(claim.capabilities) || claim.capabilities.length > 32 || claim.capabilities.some(value => typeof value !== "string" || value.length > 80)) throw new TypeError("Invalid attested capabilities.");
  if (claim.projectId !== projectId || !Number.isSafeInteger(claim.issuedAt) || !Number.isSafeInteger(claim.expiresAt) || claim.issuedAt > now + 30000 || claim.issuedAt < now - maximumAge || claim.expiresAt <= now || claim.expiresAt <= claim.issuedAt || claim.expiresAt - claim.issuedAt > 604800000) throw new Error("Release attestation is expired, premature, or belongs to a different project.");
  const keys = policy.keys.filter(key => key.keyId === value.keyId);
  const trusted = keys.length === 1 ? keys[0] : undefined;
  if (!trusted || !Array.isArray(trusted.projects) || !trusted.projects.includes(projectId) || !Array.isArray(trusted.builders) || !trusted.builders.includes(claim.builder) || trusted.notAfter !== undefined && (!Number.isSafeInteger(trusted.notAfter) || trusted.notAfter <= now)) throw new Error("Release signing key is not authorized for this project and builder.");
  const publicKey = await crypto.subtle.importKey("raw", bytes(trusted.publicKey, 32), "Ed25519", false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", publicKey, bytes(value.signature, 64), new TextEncoder().encode(canonical(value)))) throw new Error("Invalid release signature.");
  if (await deploymentDigest(artifact) !== claim.artifactSha256) throw new Error("Attested artifact digest does not match.");
  const bundle = await decodeDeploymentBundle(artifact), bound = await facts(bundle);
  if (bound.schemaSha256 !== claim.schemaSha256 || JSON.stringify(bound.capabilities) !== JSON.stringify(claim.capabilities) || (bundle.provenance.sourceRevision ?? null) !== claim.sourceRevision) throw new Error("Attested release schema, capabilities or source revision do not match.");
  return Object.freeze({ ...value, statement: Object.freeze({ ...claim, capabilities: Object.freeze([...claim.capabilities]) }) });
}
