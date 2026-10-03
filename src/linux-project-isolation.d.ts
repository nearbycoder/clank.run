/** Operator-owned Linux enforcement; privileged kernel capabilities are required. */
export interface LinuxProjectDiskQuota {
  mountDirectory: string;
  /** Nonzero operator-assigned ID, unique across the filesystem. */
  quotaId: number;
  /** Persistent allocation ceiling, aligned to 1 KiB; includes data, WAL, journals, releases, and recovery files. */
  hardBytes: number;
  hardFiles: number;
  executable?: string;
}
export interface DockerOutboundNetworkPolicy {
  /** Public IPv4 CIDRs. Private/link-local/host destinations remain blocked. Empty denies all. */
  allowCidrs: readonly string[];
  /** Static names pinned to permitted public IPv4 addresses. External DNS is disabled. */
  hosts?: Readonly<Record<string, string>>;
  nftExecutable?: string;
}
export interface LinuxDockerNetworkPlan {
  readonly network: string;
  readonly bridge: string;
  readonly table: string;
  readonly ownership: string;
  readonly rules: string;
  readonly hosts: Readonly<Record<string, string>>;
}
export declare function createLinuxDockerNetworkPlan(owner: string, projectId: string, policy: DockerOutboundNetworkPolicy): Promise<LinuxDockerNetworkPlan>;
export declare function applyLinuxDockerNetworkPolicy(plan: LinuxDockerNetworkPlan, executable?: string, signal?: AbortSignal): Promise<void>;
export declare function removeLinuxDockerNetworkPolicy(plan: LinuxDockerNetworkPlan, executable?: string): Promise<void>;
export declare function enforceLinuxProjectDiskQuota(options: LinuxProjectDiskQuota, projectDirectory: string, registryDirectory: string, projectId: string, signal?: AbortSignal): Promise<void>;
