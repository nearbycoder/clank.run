import { openDockerDeploymentRuntimeLauncher } from "./provider-docker.ts";
import { createLinuxDockerNetworkPlan, enforceLinuxProjectDiskQuota, type DockerOutboundNetworkPolicy } from "./linux-project-isolation.ts";
import { applyMigrations } from "./migrations.ts";
import { pinSQLiteDirectory } from "./sqlite-sandbox.ts";
import { parseDeploymentConfig } from "./deploy.ts";

/** V1 certifies bounded static policies on an explicitly disposable Linux host. */
export interface LinuxHostCertificationProfile {
  readonly mode: "docker-isolated";
  readonly image: string;
  readonly user: string;
  readonly memory?: string;
  readonly cpus?: string;
  readonly pidsLimit?: number;
  readonly diskQuota: { readonly mountDirectory: string; readonly hardBytes: number; readonly hardFiles: number };
  readonly outboundNetwork: Pick<DockerOutboundNetworkPolicy, "allowCidrs" | "hosts">;
  /** Controlled public test addresses, never real external endpoints. */
  readonly networkProbe: { readonly allowedAddress?: string; readonly deniedAddress: string };
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

const CAPABILITIES: readonly LinuxHostCapability[] = ["namespaces", "migrations", "sqlite-worker", "disk-quota", "runner", "egress", "cleanup"];
const PROTOCOL = "clank-linux-host-certification/1" as const;
const MAX_REPORT = 16 * 1024;
const MB = 1024 * 1024;
const process = (globalThis as any).process;
const ensure = (value: unknown, message: string): void => { if (!value) throw new Error(message); };
function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid certification ${name}.`);
  return value;
}
async function modules(): Promise<any> {
  const fsName = "node:fs/promises", pathName = "node:path", cryptoName = "node:crypto", osName = "node:os";
  const [fs, path, crypto, os] = await Promise.all([import(fsName), import(pathName), import(cryptoName), import(osName)]);
  return { fs, path, crypto, os };
}
function object(value: any, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key) || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) {
    throw new TypeError("Certification policies require plain data with declared fields.");
  }
}
function address(value: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) throw new TypeError("Invalid certification probe address.");
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 255)) throw new TypeError("Invalid certification probe address.");
  return parts.reduce((n, part) => n * 256 + part, 0);
}
function publicAddress(value: string): number {
  const n = address(value);
  const plan = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"];
  if (plan.some((range) => inRange(n, range))) throw new TypeError("Certification controlled addresses must be public IPv4 addresses.");
  return n;
}
function inRange(n: number, range: string): boolean {
  const [start, bits] = range.split("/"), mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return ((n & mask) >>> 0) === address(start!);
}
async function captureProfile(input: LinuxHostCertificationProfile): Promise<LinuxHostCertificationProfile> {
  object(input, ["mode", "image", "user", "memory", "cpus", "pidsLimit", "diskQuota", "outboundNetwork", "networkProbe"]);
  object(input.diskQuota, ["mountDirectory", "hardBytes", "hardFiles"]);
  object(input.outboundNetwork, ["allowCidrs", "hosts"]);
  object(input.networkProbe, ["allowedAddress", "deniedAddress"]);
  if (input.outboundNetwork.hosts) object(input.outboundNetwork.hosts, Object.keys(input.outboundNetwork.hosts));
  if (input.mode !== "docker-isolated" || typeof input.image !== "string" || input.image.length > 512 || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(input.image)) throw new TypeError("Certification requires an immutable Docker image digest.");
  if (typeof input.user !== "string" || !/^[1-9]\d{0,8}:(?:0|[1-9]\d{0,8})$/.test(input.user)) throw new TypeError("Certification requires an explicit non-root uid:gid.");
  if (typeof input.diskQuota.mountDirectory !== "string" || !/^\/[A-Za-z0-9_./-]+$/.test(input.diskQuota.mountDirectory)) throw new TypeError("Certification requires an absolute portable quota mount path.");
  integer(input.diskQuota.hardBytes, 4 * MB, 64 * MB, "disk byte limit");
  if (input.diskQuota.hardBytes % 1024) throw new TypeError("Certification disk limits must align to 1 KiB.");
  integer(input.diskQuota.hardFiles, 32, 128, "disk inode limit");
  memoryBytes(input.memory ?? "512m");
  const cpus = input.cpus ?? "1";
  if (typeof cpus !== "string" || !/^(?:0\.[0-9]{1,3}|[1-4](?:\.[0-9]{1,3})?)$/.test(cpus) || Number(cpus) < 0.1 || Number(cpus) > 4) throw new TypeError("Certification CPU limits must be 0.1–4 with at most three decimal places.");
  integer(input.pidsLimit ?? 128, 16, 32768, "PID limit");
  await createLinuxDockerNetworkPlan("certification", "validation", input.outboundNetwork);
  const allowed = input.networkProbe.allowedAddress;
  if (input.outboundNetwork.allowCidrs.length && !allowed) throw new TypeError("A controlled allowed address is required for a nonempty outbound policy.");
  if (allowed && (!input.outboundNetwork.allowCidrs.length || !input.outboundNetwork.allowCidrs.some((range) => inRange(publicAddress(allowed), range)))) throw new TypeError("Controlled allowed address must match the selected outbound policy.");
  const denied = publicAddress(input.networkProbe.deniedAddress);
  if (input.outboundNetwork.allowCidrs.some((range) => inRange(denied, range))) throw new TypeError("Controlled denied address must be outside the selected outbound policy.");
  const { path } = await modules();
  return freeze({ mode: input.mode, image: input.image, user: input.user, memory: input.memory ?? "512m", cpus: input.cpus ?? "1", pidsLimit: input.pidsLimit ?? 128,
    diskQuota: { ...input.diskQuota, mountDirectory: path.resolve(input.diskQuota.mountDirectory) },
    outboundNetwork: { allowCidrs: [...input.outboundNetwork.allowCidrs].sort(), hosts: Object.fromEntries(Object.entries(input.outboundNetwork.hosts ?? {}).sort(([a], [b]) => a.localeCompare(b))) },
    networkProbe: { ...(allowed ? { allowedAddress: allowed } : {}), deniedAddress: input.networkProbe.deniedAddress } });
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function memoryBytes(value: string): number {
  if (typeof value !== "string" || !/^[1-9]\d{0,3}[mg]$/.test(value)) throw new TypeError("Certification memory requires an explicit m/g limit.");
  return integer(Number(value.slice(0, -1)) * (value.endsWith("g") ? 1024 * MB : MB), 128 * MB, 2 * 1024 * MB, "container memory");
}
async function digest(value: unknown): Promise<string> { const { crypto } = await modules(); return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function fileBytes(path: string, limit: number): Promise<any> {
  const { fs } = await modules(); const constantsName = "node:fs"; const { constants } = await import(constantsName);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); ensure(stat.isFile() && stat.size <= limit, "Certification file exceeds its bound."); return await handle.readFile(); }
  finally { await handle.close(); }
}
async function command(executable: string, args: readonly string[], signal?: AbortSignal, timeout = 15000): Promise<string> {
  const name = "node:child_process", { spawn } = await import(name);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, executable === "/usr/bin/docker" ? ["--host", "unix:///var/run/docker.sock", ...args] : args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", NODE_NO_WARNINGS: "1" }, signal });
    let output = "", bytes = 0, stderrBytes = 0, failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error("Certification command deadline."); child.kill("SIGKILL"); }, timeout);
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (part: string) => { bytes += new TextEncoder().encode(part).byteLength; if (bytes > MB) { failure = new Error("Certification command output bound."); child.kill("SIGKILL"); } else output += part; });
    child.stderr.on("data", (value: any) => { stderrBytes += value.byteLength; if (stderrBytes > MB) { failure = new Error("Certification command output bound."); child.kill("SIGKILL"); } }); child.on("error", (error: Error) => { failure ??= error; });
    child.once("close", (code: number | null) => { clearTimeout(timer); if (failure) reject(failure); else if (code !== 0 || stderrBytes) reject(new Error("Certification command denied or failed.")); else resolve(output); });
  });
}
async function binding(profile: LinuxHostCertificationProfile): Promise<string> {
  const { fs, path, crypto, os } = await modules();
  const hash = crypto.createHash("sha256");
  const urlName = "node:url";
  const directory = path.dirname((await import(urlName)).fileURLToPath(import.meta.url));
  const files = (await fs.readdir(directory)).filter((name: string) => name.endsWith(".js")).sort();
  let total = 0;
  for (const name of files) { const data = await fileBytes(path.join(directory, name), 8 * MB); total += data.byteLength; ensure(total <= 16 * MB, "Certification framework exceeds its bound."); hash.update(name).update(data); }
  const runtime = await fileBytes(await fs.realpath(process.execPath), 256 * MB);
  const tools: unknown[] = [];
  let toolBytes = 0;
  for (const executable of ["/usr/bin/bwrap", "/usr/bin/prlimit", "/usr/bin/unshare", "/usr/bin/nsenter", "/usr/bin/setpriv", "/usr/bin/mount", "/usr/bin/umount", "/usr/sbin/ip", "/usr/sbin/nft", "/usr/sbin/xfs_quota", "/usr/bin/docker", "/usr/sbin/sysctl"]) {
    try {
      const resolved = await fs.realpath(executable), stat = await fs.stat(resolved), bytes = await fileBytes(resolved, 64 * MB); toolBytes += bytes.byteLength;
      ensure(toolBytes <= 128 * MB, "Certification tool bytes exceed their bound.");
      tools.push([resolved, stat.mode, stat.uid, stat.gid, crypto.createHash("sha256").update(bytes).digest("hex")]);
    } catch (error) { if (["ENOENT", "EACCES"].includes((error as any).code)) tools.push("unavailable"); else throw error; }
  }
  let docker: unknown = null, image: unknown = null;
  try { const info = JSON.parse(await command("/usr/bin/docker", ["info", "--format", "{{json .}}"])); docker = [info.ID, info.ServerVersion, info.Driver, info.DockerRootDir, info.SecurityOptions, info.CgroupDriver, info.CgroupVersion]; }
  catch { /* A denied daemon remains a blocked runner, never a green certificate. */ }
  try { const info = JSON.parse(await command("/usr/bin/docker", ["image", "inspect", profile.image]))[0]; image = [info.Id, info.RepoDigests, info.Architecture, info.Os]; }
  catch { /* No implicit pull. */ }
  const policies: string[] = [];
  for (const filename of ["/proc/sys/kernel/unprivileged_userns_clone", "/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "/proc/sys/user/max_user_namespaces", "/proc/sys/net/ipv4/ip_forward", "/sys/fs/cgroup/cgroup.controllers"]) {
    try { policies.push(String(await fs.readFile(filename, "utf8"))); } catch { policies.push("unavailable"); }
  }
  const status = await fs.readFile("/proc/self/status", "utf8");
  const mount = await fs.lstat(profile.diskQuota.mountDirectory);
  ensure(mount.isDirectory() && !mount.isSymbolicLink(), "Certification quota mount cannot be a symlink.");
  const mountInfo = await fs.readFile("/proc/self/mountinfo", "utf8");
  const selectedMount = mountInfo.split("\n").find((line: string) => line.split(" ")[4] === profile.diskQuota.mountDirectory) ?? "not-a-dedicated-mount";
  return digest([os.platform(), os.arch(), os.release(), await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"), process.version, crypto.createHash("sha256").update(runtime).digest("hex"), hash.digest("hex"), tools, process.getuid(), process.getgid(), process.getgroups(), status.match(/^CapEff:.*$/m)?.[0], status.match(/^NoNewPrivs:.*$/m)?.[0], policies, [mount.dev, mount.ino], selectedMount, docker, image]);
}
async function store(directory: string, create: boolean): Promise<any> {
  if (process.platform !== "linux") throw new Error("Linux host certification requires Linux.");
  const pinned = await pinSQLiteDirectory(directory, create), { fs } = await modules();
  try { const stat = await fs.stat(pinned.anchor); ensure(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, "Certification storage must be private and operator-owned."); return pinned; }
  catch (error) { await pinned.close(); throw error; }
}
async function authenticationKey(root: string, create: boolean): Promise<any> {
  const { fs, crypto } = await modules(); const filename = `${root}/key`;
  if (create) { try { const handle = await fs.open(filename, "wx", 0o600); try { await handle.writeFile(crypto.randomBytes(32)); await handle.sync(); } finally { await handle.close(); } } catch (error) { if ((error as any).code !== "EEXIST") throw error; } }
  const stat = await fs.lstat(filename); ensure(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, "Certification key must be private and operator-owned.");
  const value = await fileBytes(filename, 32); ensure(value.byteLength === 32, "Invalid certification key."); return value;
}

/** Runs fixed real probes; every denied, incomplete or failed capability prevents a green report. */
export async function certifyLinuxHost(options: CertifyLinuxHostOptions): Promise<LinuxHostCertificationReport> {
  if (options.disposable !== true) throw new TypeError("Certification requires an explicitly disposable host with its own Docker daemon.");
  integer(options.quotaId, 1, 0xffffffff, "reserved quota ID");
  const ttl = integer(options.ttlMs ?? 3600000, 60000, 86400000, "report lifetime"), profile = await captureProfile(options.profile);
  const { fs, crypto, os } = await modules(), pinned = await store(options.directory, true), root = pinned.anchor;
  let lock: any, hostLock: any, scratch: string | undefined, quotaClaimed = false, runnerCleanup = true, probeStarted = false;
  const checks: LinuxHostCertificationCheck[] = [];
  const check = async (capability: LinuxHostCapability, run: () => Promise<void>): Promise<boolean> => {
    try { if (options.signal?.aborted) throw new Error("aborted"); await run(); checks.push({ capability, status: "passed", reason: "verified" }); return true; }
    catch { checks.push({ capability, status: "blocked", reason: options.signal?.aborted ? "aborted" : capability === "cleanup" ? "cleanup-failed" : capability === "namespaces" ? "host-policy-denied" : "probe-failed" }); return false; }
  };
  try {
    lock = await fs.open(`${root}/attempt`, "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, boot: await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8") }));
    // Invalidate the prior result before any privileged work. A killed attempt stays blocked.
    await fs.rm(`${root}/report.json`, { force: true });
    if (process.getuid() === 0) hostLock = await fs.open("/run/clank-host-certification.attempt", "wx", 0o600);
    const key = await authenticationKey(root, true), policyDigest = await digest(profile), hostDigest = await binding(profile);
    const mount = await pinSQLiteDirectory(profile.diskQuota.mountDirectory);
    try { const created: string = await fs.mkdtemp(`${mount.anchor}/clank-host-proof-`); scratch = `${mount.path}/${created.split("/").at(-1)}`; }
    finally { await mount.close(); }
    probeStarted = true;
    const projectId = `proof_${crypto.randomBytes(12).toString("hex")}`;
    const attempt = JSON.stringify({ protocol: PROTOCOL, pid: process.pid, boot: await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"), scratch, quotaId: options.quotaId, quotaMount: profile.diskQuota.mountDirectory, projectId,
      owner: `certification-${projectId}`, link: `ch${projectId.slice(-10)}`, endpointTag: projectId, forwarding: (await fs.readFile("/proc/sys/net/ipv4/ip_forward", "utf8")).trim(), routes: [profile.networkProbe.allowedAddress, profile.networkProbe.deniedAddress, "10.99.0.3", "169.254.169.254"].filter(Boolean), policyDigest });
    await lock.truncate(0); await lock.write(attempt, 0, "utf8"); await lock.sync();
    if (hostLock) { await hostLock.writeFile(attempt); await hostLock.sync(); }
    const namespace = await check("namespaces", async () => {
      const probe = "const f=require('node:fs');if(f.readlinkSync('/proc/self/ns/net')===process.argv[1]||process.getuid()!==0)throw Error('namespace');process.stdout.write('isolated');";
      const outer = await fs.readlink("/proc/self/ns/net");
      ensure(await command("/usr/bin/unshare", ["--user", "--map-root-user", "--mount", "--net", process.execPath, "--eval", probe, outer], options.signal) === "isolated", "Namespace isolation failed.");
    });
    if (namespace) {
      await check("migrations", () => migrationProbe(scratch!, false));
      await check("sqlite-worker", () => migrationProbe(scratch!, true));
    } else for (const capability of ["migrations", "sqlite-worker"] as const) checks.push({ capability, status: "blocked", reason: "prerequisite-blocked" });
    const quota = await check("disk-quota", async () => {
      // V1 green profiles use the root-owned host-wide lock; delegated capability profiles are unsupported.
      ensure(process.getuid() === 0 && process.geteuid() === 0, "V1 privileged certification requires root.");
      await verifyUnusedQuota(profile, options.quotaId);
      quotaClaimed = true;
      await quotaProbe(scratch!, profile, options.quotaId, projectId, options.signal);
    });
    if (quota && namespace && !options.signal?.aborted) {
      runnerCleanup = await runnerProbe(scratch!, profile, projectId, options.quotaId, checks, options.signal);
    } else for (const capability of ["runner", "egress"] as const) checks.push({ capability, status: "blocked", reason: "prerequisite-blocked" });
    await check("cleanup", async () => {
      await fs.rm(scratch, { recursive: true, force: true }); scratch = undefined;
      if (quotaClaimed) { await releaseQuota(profile, options.quotaId); quotaClaimed = false; }
      ensure(runnerCleanup, "Runner resource cleanup was not verified.");
    });
    const createdAt = Date.now();
    // Probe cleanup must restore the same host identity; no green certificate for drift.
    if (await binding(profile) !== hostDigest) {
      const cleanup = checks.find((item) => item.capability === "cleanup")!;
      checks[checks.indexOf(cleanup)] = { capability: "cleanup", status: "blocked", reason: "cleanup-failed" };
    }
    const report: LinuxHostCertificationReport = freeze({ protocol: PROTOCOL, id: crypto.randomUUID(), status: checks.length === CAPABILITIES.length && checks.every((item) => item.status === "passed") ? "passed" : "blocked", createdAt, expiresAt: createdAt + ttl, bootUptimeMs: Math.floor(os.uptime() * 1000), policyDigest, hostDigest, checks });
    const serialized = JSON.stringify(report), signature = crypto.createHmac("sha256", key).update(serialized).digest("hex");
    const temporary = `${root}/report-${report.id}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ report, signature })); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, `${root}/report.json`);
      const directory = await fs.open(root, "r"); try { await directory.sync(); } finally { await directory.close(); }
    }
    finally { await fs.rm(temporary, { force: true }); }
    return report;
  } finally {
    let unlock = !probeStarted;
    try { if (scratch) await fs.rm(scratch, { recursive: true, force: true }); if (quotaClaimed) await releaseQuota(profile, options.quotaId); unlock = runnerCleanup; }
    finally {
      try { if (hostLock) { await hostLock.close(); if (unlock) await fs.rm("/run/clank-host-certification.attempt"); } }
      finally { try { if (lock) { await lock.close(); if (unlock) await fs.rm(`${root}/attempt`); } } finally { await pinned.close(); } }
    }
  }
}

/** Reads only locally authenticated reports and rechecks policy, expiry and current host identity. */
export async function inspectLinuxHostCertification(options: LinuxHostCertificationOptions): Promise<LinuxHostCertificationInspection> {
  const profile = await captureProfile(options.profile), { fs, crypto, os } = await modules();
  let pinned: any;
  try { pinned = await store(options.directory, false); } catch (error) { if ((error as any).code === "ENOENT") return freeze({ current: false, reason: "missing", report: null }); throw error; }
  const result = (reason: LinuxHostCertificationInspection["reason"], report: LinuxHostCertificationReport | null = null): LinuxHostCertificationInspection => freeze({ current: reason === "current", reason, report });
  const running = async (): Promise<boolean> => {
    for (const filename of [`${pinned.anchor}/attempt`, ...(process.getuid() === 0 ? ["/run/clank-host-certification.attempt"] : [])]) {
      try { await fs.lstat(filename); return true; } catch (error) { if ((error as any).code !== "ENOENT") throw error; }
    }
    return false;
  };
  try {
    if (await running()) return result("attempt-in-progress");
    let report: LinuxHostCertificationReport, snapshot: string | undefined;
    try {
      snapshot = String(await fileBytes(`${pinned.anchor}/report.json`, MAX_REPORT));
      const value = JSON.parse(snapshot);
      object(value, ["report", "signature"]);
      const expected = crypto.createHmac("sha256", await authenticationKey(pinned.anchor, false)).update(JSON.stringify(value.report)).digest("hex");
      if (typeof value.signature !== "string" || !/^[a-f0-9]{64}$/.test(value.signature) || !crypto.timingSafeEqual(new TextEncoder().encode(value.signature), new TextEncoder().encode(expected))) return result("invalid-report");
      report = value.report;
      object(report, ["protocol", "id", "status", "createdAt", "expiresAt", "bootUptimeMs", "policyDigest", "hostDigest", "checks"]);
      ensure(typeof report.id === "string" && /^[a-f0-9-]{36}$/.test(report.id) && /^[a-f0-9]{64}$/.test(report.policyDigest) && /^[a-f0-9]{64}$/.test(report.hostDigest), "Invalid certification identity.");
      ensure(report.protocol === PROTOCOL && ["passed", "blocked"].includes(report.status) && Array.isArray(report.checks) && report.checks.length === CAPABILITIES.length && CAPABILITIES.every((name, i) => report.checks[i]?.capability === name && ["passed", "blocked"].includes(report.checks[i]!.status)), "Invalid certification report.");
      for (const check of report.checks) { object(check, ["capability", "status", "reason"]); ensure(["verified", "host-policy-denied", "probe-failed", "prerequisite-blocked", "aborted", "cleanup-failed"].includes(check.reason), "Invalid certification check."); }
      ensure(Number.isSafeInteger(report.createdAt) && Number.isSafeInteger(report.expiresAt) && report.expiresAt - report.createdAt >= 60000 && report.expiresAt - report.createdAt <= 86400000 && Number.isSafeInteger(report.bootUptimeMs), "Invalid certification lifetime.");
    } catch (error) { return result((error as any).code === "ENOENT" && snapshot === undefined ? "missing" : "invalid-report"); }
    if (await digest(profile) !== report.policyDigest) return result("policy-changed", report);
    if (Date.now() < report.createdAt || Date.now() >= report.expiresAt || os.uptime() * 1000 < report.bootUptimeMs || os.uptime() * 1000 - report.bootUptimeMs >= report.expiresAt - report.createdAt) return result("expired", report);
    if (await binding(profile) !== report.hostDigest) return result("host-changed", report);
    if (await running()) return result("attempt-in-progress");
    let latest: string;
    try { latest = String(await fileBytes(`${pinned.anchor}/report.json`, MAX_REPORT)); } catch { return result("invalid-report"); }
    if (latest !== snapshot) return result("invalid-report");
    if (Date.now() < report.createdAt || Date.now() >= report.expiresAt || os.uptime() * 1000 < report.bootUptimeMs || os.uptime() * 1000 - report.bootUptimeMs >= report.expiresAt - report.createdAt) return result("expired", report);
    if (report.status !== "passed" || report.checks.some((check) => check.status !== "passed" || check.reason !== "verified")) return result("blocked", report);
    return result("current", report);
  } finally { await pinned.close(); }
}
export async function requireCurrentLinuxHostCertification(options: LinuxHostCertificationOptions): Promise<LinuxHostCertificationReport> {
  const inspection = await inspectLinuxHostCertification(options);
  if (!inspection.current) throw Object.assign(new Error(`Linux host certification is unavailable: ${inspection.reason}.`), { code: "LINUX_HOST_CERTIFICATION_REQUIRED", reason: inspection.reason });
  return inspection.report!;
}

async function migrationProbe(root: string, bounded: boolean): Promise<void> {
  const { fs, path } = await modules(), directory = path.join(root, bounded ? "worker-migrations" : "migrations"), filename = path.join(root, bounded ? "worker.sqlite" : "migration.sqlite");
  await fs.mkdir(directory, { mode: 0o700 });
  const input = { path: filename, directory, restrictToDatabase: true };
  await fs.writeFile(path.join(directory, "0001_initial.sql"), "CREATE TABLE proof(value INTEGER); INSERT INTO proof VALUES(1);");
  const applied = await applyMigrations(input); ensure(applied.applied.length === 1, "Migration positive control failed.");
  await fs.writeFile(path.join(directory, "0002_rejected.sql"), bounded
    ? "INSERT INTO proof VALUES(2); WITH RECURSIVE endless(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM endless) SELECT sum(x) FROM endless;"
    : "INSERT INTO proof VALUES(2); INSERT INTO nonexistent VALUES(3);");
  let denied = false;
  let ticks = 0; const timer = setInterval(() => ticks++, 25);
  try { await applyMigrations(input); } catch (error) { denied = !bounded || /deadline|resource limit/.test(String((error as Error).message)); }
  finally { clearInterval(timer); }
  ensure(denied && (!bounded || ticks >= 5), "Rejected worker did not enforce its deadline.");
  const sqliteName = "node:sqlite", { DatabaseSync } = await import(sqliteName); const database = new DatabaseSync(filename);
  try { ensure(database.prepare("SELECT count(*) AS n FROM proof").get().n === 1 && database.prepare("SELECT count(*) AS n FROM clank_migrations").get().n === 1, "Rejected migration committed partial work."); }
  finally { database.close(); }
  await fs.rm(path.join(directory, "0002_rejected.sql"));
  ensure((await applyMigrations(input)).applied.length === 1, "Worker did not recover after rejection.");
}

async function quotaProbe(root: string, profile: LinuxHostCertificationProfile, quotaId: number, projectId: string, signal?: AbortSignal): Promise<void> {
  const { fs, path } = await modules(), project = path.join(root, "quota-project"), registry = path.join(root, "quota-registry"), bytes = profile.diskQuota.hardBytes;
  await fs.mkdir(project);
  const stat = await fs.statfs(profile.diskQuota.mountDirectory);
  ensure(Number(stat.bavail) * Number(stat.bsize) > bytes * 3, "Quota proof needs outside-quota capacity.");
  await enforceLinuxProjectDiskQuota({ ...profile.diskQuota, quotaId }, project, registry, projectId, signal);
  const outside = path.join(root, "outside-quota"), inside = path.join(project, "inside-quota");
  const allocation = new Uint8Array(bytes + MB);
  await fs.writeFile(outside, allocation);
  let denied = false; try { await fs.writeFile(inside, allocation); } catch (error) { denied = ["EDQUOT", "ENOSPC"].includes((error as any).code); }
  ensure(denied, "Disk byte quota did not deny an oversized allocation.");
  await fs.rm(outside); await fs.rm(inside, { force: true });
  const sqliteName = "node:sqlite", { DatabaseSync } = await import(sqliteName), database = new DatabaseSync(path.join(project, "quota.sqlite"));
  try {
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE proof(value BLOB)");
    let rejected = false; try { database.exec(`INSERT INTO proof VALUES(randomblob(${bytes + MB}))`); } catch (error) { rejected = /full|quota/i.test(String((error as Error).message)); }
    ensure(rejected && database.prepare("SELECT count(*) AS n FROM proof").get().n === 0, "SQLite/WAL quota failure did not roll back.");
  } finally { database.close(); }
  for (const file of await fs.readdir(project)) await fs.rm(path.join(project, file));
  // Use the selected byte/inode limits together; no lowered substitute quota.
  let created = 0, rejected = false;
  for (; created < profile.diskQuota.hardFiles + 8; created++) {
    try { await fs.writeFile(path.join(project, `inode-${created}`), ""); } catch (error) { rejected = ["EDQUOT", "ENOSPC"].includes((error as any).code); break; }
  }
  ensure(rejected && created > 0 && created < profile.diskQuota.hardFiles, "Disk inode quota did not deny an allocation.");
  await fs.writeFile(path.join(root, "outside-inode-quota"), "positive control");
  await fs.rm(project, { recursive: true });
}

async function verifyUnusedQuota(profile: LinuxHostCertificationProfile, quotaId: number): Promise<void> {
  const { fs } = await modules(); ensure(Number((await fs.statfs(profile.diskQuota.mountDirectory)).type) === 0x58465342, "Certification requires XFS.");
  for (const kind of ["b", "i"]) {
    const output = await command("/usr/sbin/xfs_quota", ["-x", "-D", "/dev/null", "-P", "/dev/null", "-c", `report -p -n -N -${kind} -L ${quotaId} -U ${quotaId}`, profile.diskQuota.mountDirectory]);
    const row = output.split("\n").map((line) => line.trim().split(/\s+/)).find((parts) => parts[0] === String(quotaId) || parts[0] === `#${quotaId}`);
    ensure(!row || (Number(row[1]) === 0 && Number(row[2]) === 0 && Number(row[3]) === 0), "Certification quota ID is already allocated.");
  }
}
async function releaseQuota(profile: LinuxHostCertificationProfile, quotaId: number): Promise<void> {
  for (const kind of ["b", "i"]) {
    let empty = false;
    // XFS may settle delayed deallocation shortly after the last owned mount/file closes.
    for (let attempt = 0; attempt < 20; attempt++) {
      const output = await command("/usr/sbin/xfs_quota", ["-x", "-D", "/dev/null", "-P", "/dev/null", "-c", `report -p -n -N -${kind} -L ${quotaId} -U ${quotaId}`, profile.diskQuota.mountDirectory]);
      const row = output.split("\n").map((line) => line.trim().split(/\s+/)).find((parts) => parts[0] === String(quotaId) || parts[0] === `#${quotaId}`);
      if (row && Number(row[1]) === 0) { empty = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    ensure(empty, "Certification quota cleanup left allocated data.");
  }
  await command("/usr/sbin/xfs_quota", ["-x", "-D", "/dev/null", "-P", "/dev/null", "-c", `limit -p bsoft=0 bhard=0 isoft=0 ihard=0 ${quotaId}`, profile.diskQuota.mountDirectory]);
  await verifyUnusedQuota(profile, quotaId);
}

const RUNNER_SOURCE = `
const {createServer}=await import('node:http');const {readFile,writeFile,rm}=await import('node:fs/promises');
const attempt=async(fn)=>{try{await fn();return 'ok'}catch(e){return e.code??e.name}};
createServer(async(q,s)=>{const u=new URL(q.url,'http://localhost');let value='ok';
if(u.pathname==='/probe'){try{value={ok:true,body:await fetch(u.searchParams.get('url'),{signal:AbortSignal.timeout(700)}).then(r=>r.text())}}catch{value={ok:false}}}
if(u.pathname==='/isolation'){value={uid:process.getuid(),status:await readFile('/proc/self/status','utf8'),
app:await attempt(()=>writeFile('/app/denied','bad')),root:await attempt(()=>writeFile('/etc/denied','bad')),
data:await attempt(()=>writeFile('/data/allowed','ok')),host:await attempt(()=>readFile(process.env.PROOF_SECRET_PATH)),
tmp:await attempt(()=>writeFile('/tmp/oversized',Buffer.alloc(80*1024*1024)))};await rm('/tmp/oversized',{force:true})}
s.setHeader('content-type','application/json');s.end(JSON.stringify(value))}).listen(Number(process.env.PORT),process.env.HOST);
`;
async function runnerProbe(root: string, profile: LinuxHostCertificationProfile, projectId: string, quotaId: number, checks: LinuxHostCertificationCheck[], signal?: AbortSignal): Promise<boolean> {
  const { fs, path, crypto } = await modules(), childName = "node:child_process", httpName = "node:http";
  const [{ spawn }, { createServer }] = await Promise.all([import(childName), import(httpName)]);
  const owner = `certification-${projectId}`, suffix = projectId.slice(-10), hostLink = `ch${suffix}`, peerLink = `cp${suffix}`;
  const plan = await createLinuxDockerNetworkPlan(owner, projectId, profile.outboundNetwork);
  const addresses = [...new Set([profile.networkProbe.allowedAddress, profile.networkProbe.deniedAddress, "10.99.0.3", "169.254.169.254"].filter((value): value is string => !!value))];
  const docker = (args: string[], activeSignal?: AbortSignal) => command("/usr/bin/docker", args, activeSignal);
  const ip = (args: string[], activeSignal?: AbortSignal) => command("/usr/sbin/ip", args, activeSignal);
  const routes: string[] = [];
  let remote: any, remoteClosed: Promise<void> | undefined, host: any, launcher: any, link = false, forwarding: string | undefined;
  let runner = false, egress = false, cleanup = true;
  try {
    if (signal?.aborted) throw new Error("aborted");
    await docker(["image", "inspect", profile.image], signal);
    host = createServer((_request: any, response: any) => response.end("host"));
    await new Promise<void>((resolve, reject) => { host.once("error", reject); host.listen(0, "0.0.0.0", resolve); });
    const port = host.address().port;
    remote = spawn("/usr/bin/unshare", ["--net", process.execPath, "--eval", `/* ${projectId} */require('node:http').createServer((q,s)=>s.end('endpoint')).listen(${port},'0.0.0.0',()=>console.log('ready'));`], { stdio: ["ignore", "pipe", "pipe"], env: { NODE_NO_WARNINGS: "1" } });
    remoteClosed = new Promise<void>((resolve) => remote.once("close", resolve)); remote.stderr.on("data", () => {});
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { remote.kill("SIGKILL"); reject(new Error("Certification endpoint deadline.")); }, 5000);
      remote.once("error", (error: Error) => { clearTimeout(timer); reject(error); }); remote.once("close", () => { clearTimeout(timer); reject(new Error("Certification endpoint exited.")); });
      remote.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    });
    remote.stdout.on("data", () => {});
    const inside = (args: string[]) => command("/usr/bin/nsenter", ["--target", String(remote.pid), "--net", "/usr/sbin/ip", ...args], signal);
    await ip(["link", "add", hostLink, "type", "veth", "peer", "name", peerLink], signal); link = true;
    await ip(["addr", "add", "10.201.0.1/24", "dev", hostLink], signal); await ip(["link", "set", hostLink, "up"], signal);
    await ip(["link", "set", peerLink, "netns", String(remote.pid)], signal);
    await inside(["addr", "add", "10.201.0.2/24", "dev", peerLink]); await inside(["link", "set", peerLink, "up"]); await inside(["link", "set", "lo", "up"]); await inside(["route", "add", "default", "via", "10.201.0.1"]);
    for (const address of addresses) { await inside(["addr", "add", `${address}/32`, "dev", "lo"]); await ip(["route", "add", `${address}/32`, "via", "10.201.0.2"], signal); routes.push(address); }
    forwarding = (await fs.readFile("/proc/sys/net/ipv4/ip_forward", "utf8")).trim();
    if (forwarding !== "1") await command("/usr/sbin/sysctl", ["-w", "net.ipv4.ip_forward=1"], signal);
    const baselineGateway = JSON.parse(await docker(["network", "inspect", "bridge"], signal))[0].IPAM.Config[0].Gateway;
    const baselineName = `clank-proof-${suffix}`;
    try {
      const before = await docker(["run", "--name", baselineName, "--label", `run.clank.owner=${owner}`, "--rm", "--pull", "never", "--network", "bridge", profile.image, "node", "--input-type=module", "--eval",
        `for(const host of ${JSON.stringify(addresses)}){const value=await fetch('http://'+host+':${port}',{signal:AbortSignal.timeout(2000)}).then(r=>r.text());if(value!=='endpoint')throw Error('positive control');console.log(host)};if(await fetch('http://${baselineGateway}:${port}',{signal:AbortSignal.timeout(2000)}).then(r=>r.text())!=='host')throw Error('host control');console.log('host')`], signal);
      ensure(before.trim().split("\n").length === addresses.length + 1, "Egress positive controls failed.");
    } finally {
      // An aborted CLI cannot leave the exact baseline container alive.
      const ids = (await docker(["container", "ls", "--all", "--quiet", "--filter", `name=^/${baselineName}$`, "--filter", `label=run.clank.owner=${owner}`])).trim();
      if (ids) await docker(["container", "rm", "--force", ...ids.split("\n")]);
    }
    const provider = path.join(root, "provider"), project = path.join(provider, "projects", projectId), releaseId = "proof_release", release = path.join(project, "generations", `g1-${releaseId}`), data = path.join(project, "data");
    await fs.mkdir(path.join(release, "dist"), { recursive: true, mode: 0o700 }); await fs.mkdir(path.join(release, "migrations"), { mode: 0o700 }); await fs.mkdir(data, { mode: 0o700 });
    await fs.writeFile(path.join(release, "dist", "server.mjs"), RUNNER_SOURCE, { mode: 0o600 }); await fs.writeFile(path.join(data, "app.sqlite"), "", { mode: 0o600 }); await fs.writeFile(path.join(root, "secret"), "not mounted", { mode: 0o600 });
    const [uid, gid] = profile.user.split(":").map(Number);
    const own = async (directory: string): Promise<void> => { await fs.chown(directory, uid, gid); for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const filename = path.join(directory, entry.name); if (entry.isDirectory()) await own(filename); else await fs.chown(filename, uid, gid); } };
    await own(release); await own(data);
    const config = parseDeploymentConfig({ version: 1, entry: "dist/server.mjs", include: ["dist", "migrations"], database: { path: "app.sqlite", migrations: "migrations" }, health: { path: "/healthz", timeoutMs: 10000 }, env: {} });
    const dockerConfig = path.join(root, "docker-config"); await fs.mkdir(dockerConfig, { mode: 0o700 });
    launcher = await openDockerDeploymentRuntimeLauncher({ rootDirectory: provider, owner, image: profile.image, executable: "/usr/bin/docker", dockerEnvironment: { DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "", DOCKER_CONFIG: dockerConfig, DOCKER_TLS_VERIFY: "", DOCKER_CERT_PATH: "", PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, user: profile.user, memory: profile.memory, cpus: profile.cpus, pidsLimit: profile.pidsLimit, portStart: 25310, portEnd: 25330, stopTimeoutMs: 1000,
      diskQuota: { ...profile.diskQuota, quotaId }, outboundNetwork: profile.outboundNetwork });
    const candidate = await launcher.launch({ signal: signal ?? new AbortController().signal, prepared: { projectId, releaseId, generation: 1, fence: 1, capsuleSha256: "a".repeat(64), releaseDirectory: release, databasePath: path.join(data, "app.sqlite"), config,
      environment: { PROOF_SECRET_PATH: path.join(root, "secret") }, ingress: { route: `/v1/clank/apps/${projectId}`, token: crypto.randomBytes(24).toString("hex") }, migrationCount: 0, previous: null, alreadyCommitted: false } });
    launcher.commit(candidate);
    const value = await fetch(`${candidate.upstream}/isolation`, { signal: AbortSignal.timeout(15000) }).then((response) => response.json());
    ensure(value.uid === uid && /^CapEff:\s+0+$/m.test(value.status) && /^NoNewPrivs:\s+1$/m.test(value.status) && value.app === "EROFS" && value.root === "EROFS" && value.data === "ok" && value.host === "ENOENT" && value.tmp === "ENOSPC", "Docker runtime isolation failed.");
    const ids = (await docker(["container", "ls", "--all", "--quiet", "--filter", `label=run.clank.owner=${owner}`], signal)).trim().split("\n").filter(Boolean);
    ensure(ids.length === 1, "Unexpected certification containers.");
    const container = JSON.parse(await docker(["container", "inspect", ids[0]!], signal))[0];
    ensure(container.HostConfig.ReadonlyRootfs === true && JSON.stringify(container.HostConfig.CapDrop) === '["ALL"]' && container.HostConfig.PidsLimit === profile.pidsLimit && container.HostConfig.Memory === memoryBytes(profile.memory!) && container.HostConfig.MemorySwap === container.HostConfig.Memory && container.HostConfig.NanoCpus === Math.round(Number(profile.cpus) * 1e9), "Docker resource contract failed.");
    runner = true;
    const network = JSON.parse(await docker(["network", "inspect", plan.network], signal))[0]; ensure(network.EnableIPv6 === false, "Docker egress IPv6 must be disabled.");
    const gateway = network.IPAM.Config[0].Gateway;
    const probe = (address: string) => fetch(`${candidate.upstream}/probe?url=${encodeURIComponent(`http://${address}:${port}`)}`, { signal: AbortSignal.timeout(5000) }).then((response) => response.json());
    for (const address of [...addresses, gateway]) {
      const result = await probe(address), allowed = address === profile.networkProbe.allowedAddress;
      ensure(allowed ? result.ok === true && result.body === "endpoint" : result.ok === false, "Docker egress did not match its configured policy.");
    }
    for (const [name, address] of Object.entries(profile.outboundNetwork.hosts ?? {})) {
      if (address === profile.networkProbe.allowedAddress) { const result = await probe(name); ensure(result.ok === true && result.body === "endpoint", "Pinned static hostname failed."); }
    }
    egress = true;
  } catch { /* Report fixed capability failures without exposing private paths or command output. */ }
  finally {
    const clean = async (run: () => Promise<unknown>): Promise<void> => { try { await run(); } catch { cleanup = false; } };
    await clean(async () => { await launcher?.close(); });
    await clean(async () => { const ids = (await docker(["container", "ls", "--all", "--quiet", "--filter", `label=run.clank.owner=${owner}`])).trim(); ensure(!ids, "Owned containers remain."); });
    await clean(async () => { const networks = (await docker(["network", "ls", "--format", "{{.Name}}"])).trim().split("\n"); ensure(!networks.includes(plan.network), "Owned network remains."); });
    await clean(async () => { const tables = JSON.parse(await command("/usr/sbin/nft", ["-j", "list", "tables"])); ensure(!tables.nftables.some((entry: any) => entry.table?.name === plan.table && entry.table?.family === "inet"), "Owned firewall remains."); });
    for (const address of routes) await clean(() => ip(["route", "del", `${address}/32`, "via", "10.201.0.2"]));
    if (link) await clean(() => ip(["link", "del", hostLink]));
    await clean(async () => {
      for (const address of addresses) {
        const remaining = JSON.parse(await ip(["-j", "route", "show", "exact", `${address}/32`]));
        ensure(!remaining.some((route: any) => route.gateway === "10.201.0.2"), "Uncertain controlled routing cleanup remains.");
      }
      const links = JSON.parse(await ip(["-j", "link", "show"])); ensure(!links.some((entry: any) => entry.ifname === hostLink), "Owned link remains.");
    });
    if (forwarding !== undefined && forwarding !== "1") await clean(() => command("/usr/sbin/sysctl", ["-w", `net.ipv4.ip_forward=${forwarding}`]));
    if (host) await clean(() => new Promise<void>((resolve, reject) => { host.closeAllConnections(); host.close((error: Error) => error ? reject(error) : resolve()); }));
    if (remote) { remote.kill("SIGKILL"); await clean(async () => { await remoteClosed; }); }
  }
  checks.push({ capability: "runner", status: runner ? "passed" : "blocked", reason: runner ? "verified" : signal?.aborted ? "aborted" : "probe-failed" });
  checks.push({ capability: "egress", status: egress ? "passed" : "blocked", reason: egress ? "verified" : signal?.aborted ? "aborted" : "probe-failed" });
  return cleanup;
}
