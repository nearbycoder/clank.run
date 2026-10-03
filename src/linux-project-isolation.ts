/** Operator-owned Linux enforcement. These commands require quota/net-admin capabilities. */
export interface LinuxProjectDiskQuota {
  /** Dedicated XFS mount, already mounted with project quota accounting/enforcement. */
  mountDirectory: string;
  /** Operator-assigned, nonzero project ID, unique across this filesystem. Never recycle while files remain. */
  quotaId: number;
  /** Aggregate persistent allocation ceiling (1 KiB aligned); includes DB/WAL/journals, application data, releases and recovery. */
  hardBytes: number;
  hardFiles: number;
  executable?: string;
}

export interface DockerOutboundNetworkPolicy {
  /** Public IPv4 CIDRs; an empty list denies all outbound connections. Private/link-local/host destinations always remain blocked. */
  allowCidrs: readonly string[];
  /** Static DNS names pinned to permitted IPv4 addresses. Automatic external DNS is disabled. */
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

const PRIVATE = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"];

function integer(value: number, name: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`Invalid ${name}.`);
  return value;
}
function ipv4(input: string): number {
  if (typeof input !== "string" || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(input)) throw new TypeError("Invalid IPv4 address.");
  const values = input.split(".").map(Number);
  if (values.some((value) => value > 255)) throw new TypeError("Invalid IPv4 address.");
  return values.reduce((value, part) => value * 256 + part, 0);
}
function cidr(input: string): { value: number; bits: number; mask: number; text: string } {
  if (typeof input !== "string") throw new TypeError("Invalid outbound CIDR.");
  const parts = input.split("/");
  if (parts.length !== 2 || !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(parts[1]!)) throw new TypeError("Invalid outbound CIDR.");
  const value = ipv4(parts[0]!), bits = Number(parts[1]), mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  if ((value & mask) >>> 0 !== value) throw new TypeError("Outbound CIDR must use its canonical network address.");
  return { value, bits, mask, text: input };
}
function contains(range: ReturnType<typeof cidr>, address: number): boolean { return ((address & range.mask) >>> 0) === range.value; }

export async function createLinuxDockerNetworkPlan(owner: string, projectId: string, policy: DockerOutboundNetworkPolicy): Promise<LinuxDockerNetworkPlan> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(owner) || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new TypeError("Invalid isolation owner or project.");
  if (!Array.isArray(policy.allowCidrs) || policy.allowCidrs.length > 128) throw new TypeError("Outbound policies accept at most 128 IPv4 CIDRs.");
  const allowed = [...new Set(policy.allowCidrs)].map(cidr);
  const blocked = PRIVATE.map(cidr);
  const hosts: Record<string, string> = {};
  const entries = Object.entries(policy.hosts ?? {});
  if (entries.length > 128) throw new TypeError("Outbound policies accept at most 128 static hosts.");
  for (const [name, value] of entries) {
    if (name.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new TypeError("Invalid outbound static hostname.");
    const address = ipv4(value);
    if (blocked.some((range) => contains(range, address)) || !allowed.some((range) => contains(range, address))) throw new TypeError("Static hosts must use an allowed public IPv4 address.");
    hosts[name] = value;
  }
  const cryptoName = "node:crypto";
  const { createHash } = await import(cryptoName);
  const digest = createHash("sha256").update(`${owner}\0${projectId}`).digest("hex").slice(0, 24);
  const network = `clank-${digest}`, bridge = `clnk${digest.slice(0, 11)}`, table = `clank_${digest}`, ownership = `clank-isolation:${digest}`;
  const lines = [
    `create table inet ${table} { comment "${ownership}"; }`,
    `add chain inet ${table} forward { type filter hook forward priority -10; policy accept; }`,
    `add chain inet ${table} input { type filter hook input priority -10; policy accept; }`,
    // Replies to published ingress are necessary. New connections to host services never are.
    `add rule inet ${table} input iifname "${bridge}" ct state established,related accept`,
    `add rule inet ${table} input iifname "${bridge}" drop`,
    `add rule inet ${table} forward iifname "${bridge}" ct state established,related accept`,
    `add rule inet ${table} forward iifname "${bridge}" ip daddr { ${PRIVATE.join(", ")} } drop`,
    ...allowed.map((range) => `add rule inet ${table} forward iifname "${bridge}" ip daddr ${range.text} accept`),
    `add rule inet ${table} forward iifname "${bridge}" drop`,
  ];
  return Object.freeze({ network, bridge, table, ownership, rules: `${lines.join("\n")}\n`, hosts: Object.freeze(hosts) });
}

export async function applyLinuxDockerNetworkPolicy(plan: LinuxDockerNetworkPlan, executable = "/usr/sbin/nft", signal?: AbortSignal): Promise<void> {
  requireLinux();
  const list = JSON.parse(await command(executable, ["-j", "list", "tables"], undefined, signal));
  if (list.nftables?.some((entry: any) => entry.table?.family === "inet" && entry.table?.name === plan.table)) {
    await verifyNetworkOwnership(plan, executable, signal);
    // One atomic nft transaction replaces the complete ruleset. No empty-policy interval.
    await applyNftTransaction(executable, `delete table inet ${plan.table}\n${plan.rules}`, signal);
  } else await applyNftTransaction(executable, plan.rules, signal);
  const rules = await verifyNetworkOwnership(plan, executable, signal);
  for (const hook of ["input", "forward"]) {
    if (!rules.some((entry: any) => entry.chain?.name === hook && entry.chain?.hook === hook && entry.chain?.prio === -10)
      || !rules.some((entry: any) => entry.rule?.chain === hook && entry.rule?.expr?.some((expression: any) => expression.drop !== undefined))) {
      throw new Error("Outbound network policy could not be verified; runtime launch is refused.");
    }
  }
}

/** Older nft releases require a regular input file instead of Node's pipe/socket stdin. */
async function applyNftTransaction(executable: string, rules: string, signal?: AbortSignal): Promise<void> {
  const fsName = "node:fs/promises", pathName = "node:path", osName = "node:os";
  const [fs, path, os] = await Promise.all([import(fsName), import(pathName), import(osName)]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clank-nft-"));
  try {
    await fs.chmod(directory, 0o700);
    const filename = path.join(directory, "transaction.nft");
    await fs.writeFile(filename, rules, { flag: "wx", mode: 0o600 });
    await command(executable, ["-f", filename], undefined, signal);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function verifyNetworkOwnership(plan: LinuxDockerNetworkPlan, executable: string, signal?: AbortSignal): Promise<any[]> {
  const output = JSON.parse(await command(executable, ["-j", "list", "table", "inet", plan.table], undefined, signal));
  if (!output.nftables?.some((entry: any) => entry.table?.name === plan.table && entry.table?.comment === plan.ownership)) {
    throw new Error("Refusing to modify an nftables table without matching Clank ownership.");
  }
  return output.nftables;
}

export async function removeLinuxDockerNetworkPolicy(plan: LinuxDockerNetworkPlan, executable = "/usr/sbin/nft"): Promise<void> {
  await verifyNetworkOwnership(plan, executable);
  await command(executable, ["delete", "table", "inet", plan.table]);
}

export async function enforceLinuxProjectDiskQuota(options: LinuxProjectDiskQuota, projectDirectory: string, registryDirectory: string, projectId: string, signal?: AbortSignal): Promise<void> {
  requireLinux();
  const quotaId = integer(options.quotaId, "XFS quota ID", 1, 0xffffffff);
  const bytes = integer(options.hardBytes, "disk byte limit", 1024 * 1024);
  const files = integer(options.hardFiles, "disk inode limit", 16);
  if (bytes % 1024 !== 0) throw new TypeError("Disk byte limits must be aligned to 1 KiB.");
  const fsName = "node:fs/promises", pathName = "node:path", cryptoName = "node:crypto";
  const [fs, path, { createHash }] = await Promise.all([import(fsName), import(pathName), import(cryptoName)]);
  const mount = await fs.realpath(options.mountDirectory);
  await fs.mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  const project = await fs.realpath(projectDirectory);
  if (!/^[A-Za-z0-9_./-]+$/.test(project) || !project.startsWith(`${mount === "/" ? "" : mount}/`) || project === mount) {
    throw new TypeError("Quota project directory must be a child of its XFS mount with a portable path.");
  }
  if (Number((await fs.statfs(project)).type) !== 0x58465342 || (await fs.stat(project)).dev !== (await fs.stat(mount)).dev) {
    throw new Error("Project disk quotas require the selected XFS filesystem; runtime launch is refused.");
  }
  const executable = options.executable ?? "/usr/sbin/xfs_quota";
  // Empty mapping files prevent a global /etc/projects entry from adding another
  // tree to this explicitly scoped project command.
  const execute = (operation: string) => command(executable, ["-x", "-D", "/dev/null", "-P", "/dev/null", "-c", operation, mount], undefined, signal);
  const state = await execute("state -p");
  if (!/Accounting:\s+ON/.test(state) || !/Enforcement:\s+ON/.test(state)) throw new Error("XFS project quota accounting and enforcement must both be enabled.");
  await fs.mkdir(registryDirectory, { recursive: true, mode: 0o700 });
  const claimPath = path.join(registryDirectory, `${createHash("sha256").update(`${mount}\0${quotaId}`).digest("hex")}.json`);
  const identity = JSON.stringify({ projectId, project, mount, quotaId });
  try { await fs.writeFile(claimPath, identity, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    if (await fs.readFile(claimPath, "utf8") !== identity) throw new Error("XFS project quota ID is already assigned to a different project.");
  }
  await execute(`limit -p bsoft=0 bhard=${bytes} isoft=0 ihard=${files} ${quotaId}`);
  await execute(`project -s -p ${project} ${quotaId}`);
  const checked = await execute(`project -c -p ${project} ${quotaId}`);
  if (/does not|has project ID|is not set|failed|error/i.test(checked)) throw new Error("XFS project inheritance could not be verified.");
  for (const [kind, expected] of [["b", bytes / 1024], ["i", files]] as const) {
    const report = await execute(`report -p -n -N -${kind} -L ${quotaId} -U ${quotaId}`);
    const row = report.split("\n").map((line) => line.trim().split(/\s+/)).find((parts) => parts[0] === String(quotaId) || parts[0] === `#${quotaId}`);
    if (!row || Number(row[3]) !== expected || Number(row[1]) > expected) throw new Error("XFS quota limit verification failed or existing allocation exceeds its limit.");
  }
}

function requireLinux(): void { if ((globalThis as any).process.platform !== "linux") throw new Error("Project quota and outbound enforcement require Linux."); }
async function command(executable: string, args: string[], input?: string, signal?: AbortSignal): Promise<string> {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(executable)) throw new TypeError("Isolation executable must be an absolute portable path.");
  const name = "node:child_process";
  const { spawn } = await import(name);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" }, signal });
    let stdout = "", stderr = "", bytes = 0, failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error("Linux isolation command exceeded its deadline."); child.kill("SIGKILL"); }, 15_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    const consume = (value: string, isError: boolean) => {
      bytes += new TextEncoder().encode(value).byteLength;
      if (bytes > 1024 * 1024) { failure = new Error("Linux isolation command output exceeded its limit."); child.kill("SIGKILL"); }
      else if (isError) stderr += value; else stdout += value;
    };
    child.stdout.on("data", (value: string) => consume(value, false)); child.stderr.on("data", (value: string) => consume(value, true));
    child.on("error", (error: Error) => { failure ??= error; }); child.stdin.on("error", (error: Error) => { failure ??= error; });
    child.on("close", (code: number) => { clearTimeout(timer); if (failure) reject(failure); else if (code !== 0 || stderr.trim()) reject(new Error(`Linux isolation command failed: ${stderr.slice(0, 1024) || `exit ${code}`}`)); else resolve(stdout); });
    child.stdin.end(input);
  });
}
