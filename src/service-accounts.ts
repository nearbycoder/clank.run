import type {AuthClient} from "./auth.ts";

export type ServiceAccountPermission = "read" | "logs" | "deploy" | "rollback" | "jobs" | "secrets" | "audit";
export interface OrganizationServiceAccount {
  readonly id: string;
  readonly organizationId: string;
  readonly ownerId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly version: number;
  readonly credentialGeneration: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface ServiceAccountCredential {
  readonly id: string;
  readonly serviceAccountId: string;
  readonly projectId: string;
  readonly permissions: readonly ServiceAccountPermission[];
  readonly generation: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastUsedAt: number | null;
  /** Authenticated requests, including requests later rejected at commit. */
  readonly authenticatedRequests: number;
  readonly status: "active" | "revoked" | "expired";
}
/** Display metadata only. Receiving this JSON does not authenticate a server caller. */
export interface ServiceAccountIdentity {
  readonly kind: "service-account";
  readonly id: string;
  readonly organizationId: string;
  readonly ownerId: string;
  readonly credentialId: string;
  readonly projectId: string;
  readonly permissions: readonly ServiceAccountPermission[];
  readonly expiresAt: number;
}
/** Trusted server result from PlatformRuntime; JSON identity metadata is insufficient. */
export interface AuthenticatedServiceAccount {
  readonly identity: ServiceAccountIdentity;
  /** Repeat before each operation, including exact budget retries. */
  assertCurrent(): void;
}
export interface CreateServiceAccountRequest { readonly name: string; readonly ownerId: string; readonly operationId: string; }
export interface ChangeServiceAccountRequest extends CreateServiceAccountRequest { readonly enabled: boolean; readonly expectedVersion: number; }
export interface IssueServiceAccountCredentialRequest {
  readonly projectId: string;
  readonly permissions: readonly ServiceAccountPermission[];
  readonly expiresAt: number;
  readonly expectedVersion: number;
  readonly operationId: string;
}
export interface IssuedServiceAccountCredential {
  /** An exact historical acknowledgement. Read current state before using a retried result. */
  readonly account: OrganizationServiceAccount;
  readonly credential: ServiceAccountCredential;
  readonly accessToken: string;
}
export interface ServiceAccountClientOptions {
  readonly url?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: () => HeadersInit;
  readonly auth?: Pick<AuthClient, "csrfHeader">;
  readonly timeoutMs?: number;
}
export interface OrganizationServiceAccountClient {
  list(organizationId: string): Promise<readonly OrganizationServiceAccount[]>;
  read(organizationId: string, accountId: string): Promise<{readonly account: OrganizationServiceAccount; readonly credentials: readonly ServiceAccountCredential[]}>;
  create(organizationId: string, input: CreateServiceAccountRequest): Promise<OrganizationServiceAccount>;
  change(organizationId: string, accountId: string, input: ChangeServiceAccountRequest): Promise<OrganizationServiceAccount>;
  issue(organizationId: string, accountId: string, input: IssueServiceAccountCredentialRequest): Promise<IssuedServiceAccountCredential>;
}

/** Explicit retries preserve the operation ID and the exact admitted intent. */
export function createOrganizationServiceAccountClient(options: ServiceAccountClientOptions = {}): OrganizationServiceAccountClient {
  const base = (options.url ?? "").replace(/\/$/u, "");
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout < 500 || timeout > 30000) throw new TypeError("Service account timeout must be 500–30000ms.");
  const identifier = (value: string) => {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(value)) throw new TypeError("Invalid organization or service account identifier.");
    return encodeURIComponent(value);
  };
  const request = async (organizationId: string, suffix: string, method = "GET", body?: unknown) => {
    const headers = new Headers(options.headers?.());
    for (const [name, value] of Object.entries(options.auth?.csrfHeader() ?? {})) headers.set(name, value);
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined && new TextEncoder().encode(text).byteLength > 16384) throw new Error("Service account request exceeds its bounded envelope.");
    if (text !== undefined) headers.set("content-type", "application/json");
    const maximum = 1024 * 1024, chunks: Uint8Array[] = [];
    let bytes = 0;
    const controller = new AbortController(), signal = controller.signal;
    let timer: ReturnType<typeof setTimeout>, response: Response, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const expiration = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      const error = new Error("Service account transport timed out. Inspect current state before retrying the same operation.");
      controller.abort(error); reject(error);
    }, timeout); });
    try {
      const fetching = Promise.resolve().then(() => (options.fetch ?? fetch)(`${base}/api/organizations/${identifier(organizationId)}/service-accounts${suffix}`, {
        method, headers, signal, credentials: "same-origin", redirect: "error", ...(text === undefined ? {} : {body: text}),
      })).then(value => {
        if (signal.aborted) { void value.body?.cancel().catch(() => {}); throw signal.reason; }
        return value;
      });
      response = await Promise.race([fetching, expiration]);
      if (response.redirected) { void response.body?.cancel().catch(() => {}); throw new Error("Service account transport refused a redirected response."); }
      reader = response.body?.getReader();
      while (reader) {
        const value = await Promise.race([reader.read(), expiration]);
        if (value.done) break;
        bytes += value.value.byteLength;
        if (bytes > maximum) { void reader.cancel().catch(() => {}); throw new Error("Service account response exceeds its bounded envelope."); }
        chunks.push(value.value);
      }
    } finally { clearTimeout(timer!); if (signal.aborted) void reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    let payload: any;
    try { payload = JSON.parse(new TextDecoder().decode(all)); } catch { throw new Error("Service account transport returned invalid JSON."); }
    if (!response.ok || payload?.ok !== true) {
      const error = new Error("Service account access changed or the operation was rejected. Refresh before retrying.") as Error & {status: number};
      error.status = response.status;
      throw error;
    }
    return payload;
  };
  return {
    list: async organizationId => (await request(organizationId, "")).accounts,
    read: async (organizationId, accountId) => (await request(organizationId, `/${identifier(accountId)}`)).detail,
    create: async (organizationId, input) => (await request(organizationId, "", "POST", input)).account,
    change: async (organizationId, accountId, input) => (await request(organizationId, `/${identifier(accountId)}/change`, "POST", input)).account,
    issue: async (organizationId, accountId, input) => (await request(organizationId, `/${identifier(accountId)}/credentials`, "POST", input)).issued,
  };
}
