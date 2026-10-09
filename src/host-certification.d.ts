import { type DockerOutboundNetworkPolicy } from "./linux-project-isolation.js";
/** V1 certifies bounded static policies on an explicitly disposable Linux host. */
export interface LinuxHostCertificationProfile {
    readonly mode: "docker-isolated";
    readonly image: string;
    readonly user: string;
    readonly memory?: string;
    readonly cpus?: string;
    readonly pidsLimit?: number;
    readonly diskQuota: {
        readonly mountDirectory: string;
        readonly hardBytes: number;
        readonly hardFiles: number;
    };
    readonly outboundNetwork: Pick<DockerOutboundNetworkPolicy, "allowCidrs" | "hosts">;
    /** Controlled public test addresses, never real external endpoints. */
    readonly networkProbe: {
        readonly allowedAddress?: string;
        readonly deniedAddress: string;
    };
}
export type LinuxHostCapability = "namespaces" | "migrations" | "sqlite-worker" | "disk-quota" | "runner" | "egress" | "cleanup";
export interface LinuxHostCertificationCheck {
    readonly capability: LinuxHostCapability;
    readonly status: "passed" | "blocked";
    readonly reason: "verified" | "host-policy-denied" | "probe-failed" | "prerequisite-blocked" | "aborted" | "cleanup-failed";
}
export interface LinuxHostCertificationReport {
    readonly protocol: "clank-linux-host-certification/1";
    readonly id: string;
    readonly status: "passed" | "blocked";
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly bootUptimeMs: number;
    readonly policyDigest: string;
    readonly hostDigest: string;
    readonly checks: readonly LinuxHostCertificationCheck[];
}
export interface LinuxHostCertificationOptions {
    /** Private operator-owned report directory, separate from any live provider root. */
    readonly directory: string;
    readonly profile: LinuxHostCertificationProfile;
}
export interface CertifyLinuxHostOptions extends LinuxHostCertificationOptions {
    /** Explicit declaration: this host and its Docker daemon may be used for privileged disposable probes. */
    readonly disposable: true;
    /** Operator-reserved unused XFS project ID. Never use a live project's ID. */
    readonly quotaId: number;
    readonly ttlMs?: number;
    readonly signal?: AbortSignal;
}
export interface LinuxHostCertificationInspection {
    readonly current: boolean;
    readonly reason: "current" | "missing" | "attempt-in-progress" | "invalid-report" | "expired" | "policy-changed" | "host-changed" | "blocked";
    readonly report: LinuxHostCertificationReport | null;
}
/** Runs fixed real probes; every denied, incomplete or failed capability prevents a green report. */
export declare function certifyLinuxHost(options: CertifyLinuxHostOptions): Promise<LinuxHostCertificationReport>;
/** Reads only locally authenticated reports and rechecks policy, expiry and current host identity. */
export declare function inspectLinuxHostCertification(options: LinuxHostCertificationOptions): Promise<LinuxHostCertificationInspection>;
export declare function requireCurrentLinuxHostCertification(options: LinuxHostCertificationOptions): Promise<LinuxHostCertificationReport>;
