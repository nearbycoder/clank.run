import type { DeploymentBundle } from "./deploy.js";

export declare const DEPLOYMENT_RUNTIME_PROTOCOL: "clank-runtime/1";
export declare const DEPLOYMENT_RUNTIME_MEDIA_TYPE: "application/vnd.clank.runtime";

export interface DeploymentRuntimeDatabaseManifest {
  readonly path: string;
  readonly mode: "initialize" | "preserve" | "replace";
  readonly snapshot: {
    readonly bytes: number;
    readonly sha256: string;
  } | null;
}

export interface DeploymentRuntimeIngressManifest {
  readonly route: string;
  readonly token: string;
}

export interface DeploymentRuntimeManifest {
  readonly protocol: typeof DEPLOYMENT_RUNTIME_PROTOCOL;
  readonly projectId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly database: DeploymentRuntimeDatabaseManifest;
  readonly ingress: DeploymentRuntimeIngressManifest;
  readonly artifact: {
    readonly bytes: number;
    readonly sha256: string;
  };
}

export interface DeploymentRuntimeCapsule {
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
  };
  artifact: Uint8Array;
}

export interface DeploymentRuntimeCapsuleLimits {
  maxManifestBytes?: number;
  maxArtifactBytes?: number;
  maxDatabaseBytes?: number;
  maxCapsuleBytes?: number;
}

export declare function createDeploymentRuntimeCapsule(
  input: CreateDeploymentRuntimeCapsuleInput,
  limits?: DeploymentRuntimeCapsuleLimits,
): Promise<DeploymentRuntimeCapsule>;

export declare function decodeDeploymentRuntimeCapsule(
  input: Uint8Array,
  limits?: DeploymentRuntimeCapsuleLimits,
): Promise<DeploymentRuntimeCapsule>;

export declare function deploymentRuntimeDigest(bytes: Uint8Array): Promise<string>;
