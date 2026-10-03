export interface ReleaseSigningKey { keyId: string; publicKey: string; privateKey: string; }
export interface ReleaseTrustKey { keyId: string; publicKey: string; projects: readonly string[]; builders: readonly string[]; notAfter?: number; }
export interface ReleaseAttestationPolicy { keys: readonly ReleaseTrustKey[]; required?: boolean; maxAgeMs?: number; }
export interface ReleaseAttestation {
  protocol: "clank-release-attestation/1"; keyId: string;
  statement: { artifactSha256: string; schemaSha256: string; projectId: string; builder: string; buildId: string; sourceRevision: string | null; capabilities: readonly string[]; issuedAt: number; expiresAt: number };
  signature: string;
}
export declare function generateReleaseSigningKey(keyId: string): Promise<ReleaseSigningKey>;
export declare function signReleaseAttestation(artifact: Uint8Array, key: ReleaseSigningKey, identity: { projectId: string; builder: string; buildId: string; now?: number; lifetimeMs?: number }): Promise<ReleaseAttestation>;
export declare function encodeReleaseAttestation(attestation: ReleaseAttestation): string;
export declare function decodeReleaseAttestation(header: string): ReleaseAttestation;
export declare function verifyReleaseAttestation(artifact: Uint8Array, input: unknown, policy: ReleaseAttestationPolicy, projectId: string, now?: number): Promise<ReleaseAttestation>;
