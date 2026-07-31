import { type AppBlueprint, type AppBlueprintInput } from "./blueprint.js";

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

export declare function generateBlueprintSigningKey(label: string, options: {
    createdAt?: number;
    scope: {
        role: "publisher";
        namespaces: readonly string[];
    } | {
        role: "registry";
        registries: readonly string[];
    };
}): Promise<{
    privateKey: BlueprintPrivateKey;
    trustKey: BlueprintTrustKey;
}>;

export declare function signBlueprintRelease(blueprintInput: AppBlueprintInput | AppBlueprint, input: {
    name: string;
    version: string;
    description?: string;
    createdAt?: number;
    key: BlueprintPrivateKey;
}): Promise<SignedBlueprintRelease>;

export declare function verifyBlueprintRelease(value: unknown, trustInput: BlueprintTrustPolicy, options?: {
    now?: number;
    minimumCreatedAt?: number;
}): Promise<VerifiedBlueprintRelease>;

export declare function signBlueprintCatalog(input: {
    registry: string;
    sequence: number;
    createdAt?: number;
    releases: readonly BlueprintCatalogEntry[];
    key: BlueprintPrivateKey;
}): Promise<SignedBlueprintCatalog>;

export declare function verifyBlueprintCatalog(value: unknown, trustInput: BlueprintTrustPolicy, options?: {
    now?: number;
}): Promise<VerifiedBlueprintCatalog>;

export declare function fetchBlueprintCatalog(urlInput: string | URL, trust: BlueprintTrustPolicy, options?: BlueprintRegistryFetchOptions): Promise<VerifiedBlueprintCatalog>;

export declare function resolveBlueprintRelease(catalogInput: SignedBlueprintCatalog | VerifiedBlueprintCatalog, input: {
    name: string;
    version: string;
}, trust: BlueprintTrustPolicy, options?: BlueprintRegistryFetchOptions): Promise<VerifiedBlueprintRelease>;

export declare function createBlueprintTrustPolicy(input: {
    keys: readonly BlueprintTrustKey[];
    revokedKeyIds?: readonly string[];
    revokedReleaseDigests?: readonly string[];
    minimumCatalogSequences?: Readonly<Record<string, number>>;
}): BlueprintTrustPolicy;

export declare class BlueprintRegistryError extends Error {
    readonly code: string;
    readonly name = "BlueprintRegistryError";
    constructor(code: string, message: string);
}
