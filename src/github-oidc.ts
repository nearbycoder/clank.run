import { readResponseBytes } from "./security.ts";

export const GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_ACTIONS_OIDC_JWKS =
  "https://token.actions.githubusercontent.com/.well-known/jwks";

const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_JWKS_BYTES = 256 * 1024;
const KEY_CACHE_MS = 5 * 60_000;
const KEY_REFRESH_FLOOR_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LIFETIME_SECONDS = 10 * 60;

export interface GithubActionsOidcPolicy {
  audience: string;
  repository: string;
  repositoryId: string;
  workflowPath: string;
  eventName: "pull_request" | "pull_request_target";
  operation: "deploy" | "remove";
  previewName?: string;
  ref?: string;
}

export interface GithubActionsOidcIdentity {
  readonly issuer: typeof GITHUB_ACTIONS_OIDC_ISSUER;
  readonly subject: string;
  readonly jti: string;
  readonly expiresAt: number;
  readonly repository: string;
  readonly repositoryId: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly eventName: "pull_request" | "pull_request_target";
  readonly ref: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly previewName: string;
}

export interface GithubActionsOidcVerifierOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

export interface GithubActionsOidcVerifier {
  verify(token: string, policy: GithubActionsOidcPolicy): Promise<GithubActionsOidcIdentity>;
}

export class GithubActionsOidcError extends Error {
  readonly code = "INVALID_GITHUB_IDENTITY";

  constructor(cause?: unknown) {
    super("The GitHub Actions identity is invalid or expired.", { cause });
    this.name = "GithubActionsOidcError";
  }
}

interface CachedKeys {
  readonly expiresAt: number;
  readonly refreshedAt: number;
  readonly values: ReadonlyMap<string, JsonWebKey>;
}

export function createGithubActionsOidcVerifier(
  options: GithubActionsOidcVerifierOptions = {},
): GithubActionsOidcVerifier {
  const fetcher = options.fetch ?? fetch;
  const clock = options.now ?? Date.now;
  let cache: CachedKeys | undefined;
  let flight: Promise<CachedKeys> | undefined;

  const loadKeys = async (force = false): Promise<CachedKeys> => {
    const now = clock();
    if (
      cache
      && cache.expiresAt > now
      && (!force || now - cache.refreshedAt < KEY_REFRESH_FLOOR_MS)
    ) {
      return cache;
    }
    if (flight) return flight;
    const pending = fetchGithubKeys(fetcher, now);
    flight = pending;
    try {
      cache = await pending;
      return cache;
    } finally {
      if (flight === pending) flight = undefined;
    }
  };

  return Object.freeze({
    async verify(token, policy) {
      try {
        const normalizedPolicy = normalizePolicy(policy);
        const parsed = parseToken(token, normalizedPolicy, clock());
        let keys = await loadKeys();
        let jwk = keys.values.get(parsed.kid);
        if (!jwk) {
          keys = await loadKeys(true);
          jwk = keys.values.get(parsed.kid);
        }
        if (!jwk) throw new Error("Unknown GitHub signing key.");
        const key = await crypto.subtle.importKey(
          "jwk",
          jwk,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        const valid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key,
          parsed.signature,
          new TextEncoder().encode(parsed.signingInput),
        );
        if (!valid) throw new Error("Invalid GitHub token signature.");
        return Object.freeze(parsed.identity);
      } catch (error) {
        throw new GithubActionsOidcError(error);
      }
    },
  });
}

async function fetchGithubKeys(fetcher: typeof fetch, now: number): Promise<CachedKeys> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(GITHUB_ACTIONS_OIDC_JWKS, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
      },
    });
  } finally {
    clearTimeout(timer);
  }
  if (
    response.status !== 200
    || response.redirected
    || response.url !== GITHUB_ACTIONS_OIDC_JWKS
    || response.headers.has("content-encoding")
    || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
  ) {
    await response.body?.cancel();
    throw new Error("GitHub signing-key response is invalid.");
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    await readResponseBytes(response, MAX_JWKS_BYTES),
  ));
  if (!plain(value) || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 20) {
    throw new Error("GitHub signing keys are invalid.");
  }
  const keys = new Map<string, JsonWebKey>();
  for (const candidate of value.keys) {
    if (
      !plain(candidate)
      || candidate.kty !== "RSA"
      || candidate.use !== "sig"
      || candidate.alg !== "RS256"
      || typeof candidate.kid !== "string"
      || !/^[A-Za-z0-9_-]{8,200}$/u.test(candidate.kid)
      || typeof candidate.n !== "string"
      || !/^[A-Za-z0-9_-]{100,2048}$/u.test(candidate.n)
      || typeof candidate.e !== "string"
      || !/^[A-Za-z0-9_-]{2,16}$/u.test(candidate.e)
      || keys.has(candidate.kid)
    ) {
      throw new Error("GitHub signing key is invalid.");
    }
    keys.set(candidate.kid, Object.freeze({
      kty: "RSA",
      use: "sig",
      alg: "RS256",
      kid: candidate.kid,
      n: candidate.n,
      e: candidate.e,
    }));
  }
  return Object.freeze({
    refreshedAt: now,
    expiresAt: now + KEY_CACHE_MS,
    values: keys,
  });
}

function parseToken(
  token: string,
  policy: GithubActionsOidcPolicy,
  nowMs: number,
): {
  kid: string;
  signature: Uint8Array;
  signingInput: string;
  identity: GithubActionsOidcIdentity;
} {
  if (
    typeof token !== "string"
    || token.length < 100
    || new TextEncoder().encode(token).byteLength > MAX_TOKEN_BYTES
    || /[^A-Za-z0-9_.-]/u.test(token)
  ) {
    throw new Error("GitHub token is invalid.");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length < 1)) {
    throw new Error("GitHub token is invalid.");
  }
  const header = jsonSegment(parts[0]!, 4 * 1024);
  const claims = jsonSegment(parts[1]!, 12 * 1024);
  if (
    !plain(header)
    || header.alg !== "RS256"
    || header.typ !== "JWT"
    || typeof header.kid !== "string"
    || !/^[A-Za-z0-9_-]{8,200}$/u.test(header.kid)
    || !plain(claims)
  ) {
    throw new Error("GitHub token metadata is invalid.");
  }
  const now = Math.floor(nowMs / 1_000);
  const issuedAt = claimInteger(claims.iat, 0, Number.MAX_SAFE_INTEGER);
  const notBefore = claimInteger(claims.nbf, 0, Number.MAX_SAFE_INTEGER);
  const expiresAt = claimInteger(claims.exp, 0, Number.MAX_SAFE_INTEGER);
  if (
    issuedAt > now + CLOCK_SKEW_SECONDS
    || notBefore > now + CLOCK_SKEW_SECONDS
    || expiresAt <= now
    || expiresAt - issuedAt > MAX_TOKEN_LIFETIME_SECONDS
    || now - issuedAt > MAX_TOKEN_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS
  ) {
    throw new Error("GitHub token time window is invalid.");
  }
  const repository = claimString(claims.repository, 3, 201);
  const repositoryId = claimDigits(claims.repository_id, 1, 20);
  const workflowRef = claimString(claims.workflow_ref, 10, 600);
  const workflowSha = claimHex(claims.workflow_sha, 40);
  const eventName = claimString(claims.event_name, 1, 64);
  const ref = claimString(claims.ref, 1, 600);
  const workflowSuffix = `/${policy.workflowPath}@${ref}`;
  const workflowRepository = workflowRef.endsWith(workflowSuffix)
    ? workflowRef.slice(0, -workflowSuffix.length)
    : "";
  if (
    claims.iss !== GITHUB_ACTIONS_OIDC_ISSUER
    || claims.aud !== policy.audience
    || repository.toLowerCase() !== policy.repository.toLowerCase()
    || repositoryId !== policy.repositoryId
    || workflowRepository.toLowerCase() !== repository.toLowerCase()
    || eventName !== policy.eventName
    || (policy.ref !== undefined && ref !== policy.ref)
  ) {
    throw new Error("GitHub token claims do not match the binding.");
  }
  let previewName: string;
  if (policy.operation === "deploy") {
    const pull = /^refs\/pull\/([1-9][0-9]{0,9})\/merge$/u.exec(ref);
    if (!pull || policy.eventName !== "pull_request") {
      throw new Error("GitHub deploy identity is not a pull request.");
    }
    previewName = `pull-${pull[1]}`;
    if (policy.previewName !== undefined && policy.previewName !== previewName) {
      throw new Error("GitHub pull request does not match the preview.");
    }
  } else {
    if (
      policy.eventName !== "pull_request_target"
      || !policy.previewName
      || !/^pull-[1-9][0-9]{0,9}$/u.test(policy.previewName)
    ) {
      throw new Error("GitHub cleanup identity is invalid.");
    }
    previewName = policy.previewName;
  }
  return {
    kid: header.kid,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: base64Url(parts[2]!, 1024),
    identity: {
      issuer: GITHUB_ACTIONS_OIDC_ISSUER,
      subject: claimString(claims.sub, 1, 800),
      jti: claimString(claims.jti, 8, 300),
      expiresAt: expiresAt * 1_000,
      repository,
      repositoryId,
      workflowRef,
      workflowSha,
      eventName: eventName as GithubActionsOidcIdentity["eventName"],
      ref,
      runId: claimDigits(claims.run_id, 1, 30),
      runAttempt: claimInteger(claims.run_attempt, 1, 1_000_000),
      previewName,
    },
  };
}

function normalizePolicy(policy: GithubActionsOidcPolicy): GithubActionsOidcPolicy {
  if (!plain(policy)) throw new TypeError("GitHub OIDC policy is invalid.");
  const audience = secureAudience(policy.audience);
  const repository = repositoryName(policy.repository);
  const repositoryId = claimDigits(policy.repositoryId, 1, 20);
  const workflowPath = workflowPathName(policy.workflowPath);
  if (
    policy.eventName !== "pull_request"
    && policy.eventName !== "pull_request_target"
  ) throw new TypeError("GitHub OIDC event is invalid.");
  if (policy.operation !== "deploy" && policy.operation !== "remove") {
    throw new TypeError("GitHub OIDC operation is invalid.");
  }
  return Object.freeze({
    audience,
    repository,
    repositoryId,
    workflowPath,
    eventName: policy.eventName,
    operation: policy.operation,
    ...(policy.previewName === undefined
      ? {}
      : { previewName: previewName(policy.previewName) }),
    ...(policy.ref === undefined ? {} : { ref: branchRef(policy.ref) }),
  });
}

export function repositoryName(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 201
    || !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u
      .test(value)
  ) throw new TypeError("GitHub repository must use owner/name.");
  return value.toLowerCase();
}

export function workflowPathName(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 200
    || !/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\.ya?ml$/u.test(value)
  ) throw new TypeError("GitHub workflow path is invalid.");
  return value;
}

export function branchRef(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 300
    || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    || value.includes("..")
    || value.includes("//")
    || value.includes("@{")
    || value.includes("/.")
    || value.endsWith("/")
    || value.endsWith(".")
    || value.endsWith(".lock")
  ) throw new TypeError("GitHub branch ref is invalid.");
  return value;
}

function previewName(value: unknown): string {
  if (typeof value !== "string" || !/^pull-[1-9][0-9]{0,9}$/u.test(value)) {
    throw new TypeError("GitHub preview name is invalid.");
  }
  return value;
}

function secureAudience(value: unknown): string {
  if (typeof value !== "string" || value.length > 500) {
    throw new TypeError("GitHub OIDC audience is invalid.");
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) throw new TypeError("GitHub OIDC audience must be an HTTPS origin.");
  return url.origin;
}

function jsonSegment(value: string, maximum: number): unknown {
  const bytes = base64Url(value, maximum);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function base64Url(value: string, maximum: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > Math.ceil(maximum * 4 / 3)) {
    throw new TypeError("JWT segment is invalid.");
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  if (binary.length > maximum) throw new TypeError("JWT segment exceeds its bound.");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function claimString(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new TypeError("GitHub OIDC claim is invalid.");
  return value;
}

function claimDigits(value: unknown, minimum: number, maximum: number): string {
  const text = claimString(value, minimum, maximum);
  if (!/^[1-9][0-9]*$/u.test(text)) throw new TypeError("GitHub OIDC claim is invalid.");
  return text;
}

function claimHex(value: unknown, length: number): string {
  const text = claimString(value, length, length);
  if (!new RegExp(`^[a-f0-9]{${length}}$`, "u").test(text)) {
    throw new TypeError("GitHub OIDC claim is invalid.");
  }
  return text;
}

function claimInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) throw new TypeError("GitHub OIDC claim is invalid.");
  return value;
}

function plain(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
