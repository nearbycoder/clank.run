/** Native observations for the ordinary provider's bounded-downtime transfer.
 * These observations are not capabilities. Only the original launcher can retain
 * them behind its private role-lease registry. */
import { runProviderDockerClient, type DockerClient } from "./provider-docker-client.ts";

type Role = "web" | "worker" | "scheduler";
export interface ProviderFallbackRole { readonly role: Role; readonly instance: number; readonly containerId: string; }
export interface ProviderFallbackNativeInput {
  readonly client: DockerClient; readonly owner: string; readonly projectId: string;
  readonly releaseId: string; readonly generation: number; readonly capsuleSha256: string;
  readonly image: string; readonly user: string; readonly network: string;
  readonly memory: string; readonly cpus: string; readonly pidsLimit: number;
  readonly releaseDirectory: string; readonly dataDirectory: string;
  readonly roles: readonly (ProviderFallbackRole & { readonly command: readonly string[] })[];
  readonly deadline: bigint; readonly created?: boolean;
}
const fail = (message: string): never => { throw new Error(message); };
const ID = /^[a-f0-9]{64}$/u;
const memoryBytes = (value: string): number => {
  const match = /^(\d+(?:\.\d+)?)([bkmg])?$/iu.exec(value);
  if (!match) return fail("Fallback memory policy cannot be normalized exactly.");
  const result = Number(match[1]) * 1024 ** ["b", "k", "m", "g"].indexOf(match[2]?.toLowerCase() ?? "b");
  if (!Number.isSafeInteger(result) || result < 1) fail("Fallback memory policy is invalid.");
  return result;
};
export async function observeProviderFallbackRoles(input: ProviderFallbackNativeInput) {
  const fsName = "node:fs", cryptoName = "node:crypto";
  const [fs, crypto] = await Promise.all([import(fsName), import(cryptoName)]);
  const process = (globalThis as any).process;
  if (process.platform !== "linux" || input.client.environment.DOCKER_CONTEXT !== undefined
    || input.client.environment.DOCKER_HOST !== undefined && input.client.environment.DOCKER_HOST !== "unix:///var/run/docker.sock") fail("Fallback native evidence requires the original local Docker domain.");
  const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  const expected = new Map(input.roles.map(role => [role.containerId, role]));
  if (!expected.size || expected.size > 34 || expected.size !== input.roles.length || input.roles.some(role => !ID.test(role.containerId))) fail("Fallback role roster is invalid.");
  let closed = false;
  const pins: Array<{ path: string; fd: number; dev: number; ino: number; uid: number }> = [];
  const processes = new Map<string, { pid: number; birth: string; cgroup: string; containerId: string }>();
  const configurations = new Map<string, string>();
  const check = (deadline = input.deadline) => {
    if (closed) fail("Fallback native evidence is closed.");
    if (process.hrtime.bigint() >= deadline) fail("Fallback interruption deadline expired.");
    for (const pin of pins) for (const stat of [fs.fstatSync(pin.fd), fs.lstatSync(pin.path)]) {
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== pin.dev || stat.ino !== pin.ino || stat.uid !== pin.uid || (stat.mode & 0o022) !== 0) fail("Fallback data or release identity changed.");
    }
  };
  const close = () => { if (closed) return; closed = true; const failures: unknown[] = []; for (const pin of pins.splice(0).reverse()) try { fs.closeSync(pin.fd); } catch (error) { failures.push(error); } if (failures.length) throw new AggregateError(failures, "Fallback native pins failed to close."); };
  const command = async (args: string[], deadline = input.deadline) => {
    check(deadline); const remaining = Math.max(1, Math.min(15000, Number((deadline - process.hrtime.bigint()) / 1000000n)));
    const result = await runProviderDockerClient(input.client, args, { timeoutMs: remaining, maxOutputBytes: 1024 * 1024 }); check(deadline); return result.stdout;
  };
  const proc = (path: string, limit = 65536): string => {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try { const bytes = Buffer.alloc(limit + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0); if (count > limit) fail("Fallback native process observation exceeds its bound."); return bytes.subarray(0, count).toString(); } finally { fs.closeSync(fd); }
  };
  const absent = (path: string) => { try { fs.lstatSync(path); return false; } catch (error) { if ((error as { code?: string }).code === "ENOENT") return true; throw error; } };
  const retainProcess = (row: any, cid: string) => {
    const pid = row.State?.Pid;
    if (!Number.isSafeInteger(pid) || pid < 1) fail("Fallback role lacks an original running process.");
    const stat = proc(`/proc/${pid}/stat`), birth = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/u)[19];
    const groups = proc(`/proc/${pid}/cgroup`, 4096).trim().split("\n");
    if (!birth || !/^[1-9][0-9]{0,19}$/u.test(birth) || groups.length !== 1 || !groups[0].startsWith("0::/") || groups[0].includes("/../") || !["/docker/" + cid, "/docker-" + cid + ".scope"].some(suffix => groups[0].endsWith(suffix))) fail("Fallback role native cgroup identity differs.");
    const status = proc(`/proc/${pid}/status`), field = (name: string) => new RegExp("^" + name + ":\\s*(.+)$", "mu").exec(status)?.[1]?.trim();
    const [uid, gid] = input.user.split(":");
    if (proc(`/proc/${pid}/attr/current`, 4096).trim() !== "docker-default (enforce)" || field("NoNewPrivs") !== "1" || field("Seccomp") !== "2" || ["CapEff", "CapPrm", "CapBnd"].some(name => !/^0+$/u.test(field(name) ?? "")) || ["Uid", "Gid"].some((name, index) => { const ids = field(name)?.split(/\s+/u); return ids?.length !== 4 || ids.some(id => id !== [uid, gid][index]); })) fail("Fallback role native security policy differs.");
    const value = { pid, birth, cgroup: "/sys/fs/cgroup" + groups[0].slice(3), containerId: cid };
    const old = processes.get(cid); if (old && JSON.stringify(old) !== JSON.stringify(value)) fail("Fallback role process was replaced.");
    processes.set(cid, value);
  };
  const configuration = (row: any, role: ProviderFallbackNativeInput["roles"][number]) => {
    const labels = row.Config?.Labels, host = row.HostConfig;
    // Docker reports its enabled OOM default as false before start and null afterward.
    if (![null, false].includes(host?.OomKillDisable)) fail("Fallback native OOM policy differs.");
    if (row.Id !== role.containerId || typeof row.Image !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(row.Image)
      || labels?.["run.clank.managed"] !== "provider-runtime" || labels["run.clank.owner"] !== input.owner || labels["run.clank.project"] !== input.projectId
      || labels["run.clank.release"] !== input.releaseId || labels["run.clank.generation"] !== String(input.generation) || labels["run.clank.role"] !== role.role || labels["run.clank.instance"] !== String(role.instance)
      || !["", "docker-default"].includes(row.AppArmorProfile) || row.State?.Running === true && row.AppArmorProfile !== "docker-default" || row.Config.User !== input.user || row.Config.WorkingDir !== "/app" || JSON.stringify(row.Config.Cmd) !== JSON.stringify(role.command)
      || !host || host.ReadonlyRootfs !== true || host.Privileged !== false || host.Init !== true || host.RestartPolicy?.Name !== "no"
      || JSON.stringify(host.CapDrop) !== '["ALL"]' || host.CapAdd !== null || !['["no-new-privileges=true"]', '["no-new-privileges"]'].includes(JSON.stringify(host.SecurityOpt))
      || host.Memory !== memoryBytes(input.memory) || host.MemorySwap !== memoryBytes(input.memory) || host.NanoCpus !== Number(input.cpus) * 1000000000 || host.PidsLimit !== input.pidsLimit || host.NetworkMode !== input.network
      || !Array.isArray(row.Mounts) || row.Mounts.length !== 2
      || !row.Mounts.some((m: any) => m.Type === "bind" && m.Source === input.releaseDirectory && m.Destination === "/app" && m.RW === false)
      || !row.Mounts.some((m: any) => m.Type === "bind" && m.Source === input.dataDirectory && m.Destination === "/data" && m.RW === true)) fail("Fallback role differs from its original launch policy.");
    return digest(JSON.stringify({ Image: row.Image, Config: row.Config, HostConfig: { ...host, OomKillDisable: false }, AppArmorProfile: "docker-default", Mounts: [...row.Mounts].sort((a: any, b: any) => a.Destination.localeCompare(b.Destination)) }));
  };
  let daemonId: string, imageId: string;
  const domain = async (deadline = input.deadline) => { const actual = JSON.parse(await command(["info", "--format", "{{json .ID}}"], deadline)); if (typeof actual !== "string" || !actual || daemonId !== undefined && actual !== daemonId) fail("Fallback Docker daemon changed."); daemonId = actual; };
  const inventory = async (phase: "created" | "running" | "remaining" | "configuration" | "stopped", deadline = input.deadline) => {
    await domain(deadline);
    const raw = (await command(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"], deadline)).trim();
    const ids = raw ? raw.split("\n") : [];
    if (ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(id => !ID.test(id))) fail("Fallback container inventory exceeds its bound.");
    const seen = new Set<string>();
    for (const cid of ids) {
      const rows = JSON.parse(await command(["container", "inspect", cid], deadline));
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.Id !== cid || !Array.isArray(rows[0].Mounts)) fail("Fallback container native observation differs.");
      const row = rows[0], role = expected.get(cid);
      if (role) {
        if (phase === "stopped") fail("Fallback source role remains present.");
        const signature = configuration(row, role), previous = configurations.get(cid);
        if (row.Image !== imageId || previous !== undefined && previous !== signature || phase === "running" && (row.State?.Status !== "running" || row.State.Running !== true) || row.State?.Paused || row.State?.Restarting || row.State?.Dead || row.RestartCount !== 0) fail("Fallback role changed or is not running.");
        if (phase === "created" && (row.State?.Status !== "created" || row.State.Running !== false || row.State.Pid !== 0 || row.State.StartedAt !== "0001-01-01T00:00:00Z")) fail("Fallback staged role has already started.");
        configurations.set(cid, signature); if (phase !== "configuration" && (phase === "running" || row.State.Pid > 0)) retainProcess(row, cid); seen.add(cid); continue;
      }
      if (row.Config?.Labels?.["run.clank.owner"] === input.owner && row.Config.Labels["run.clank.project"] === input.projectId) fail("Fallback project has an unowned role.");
      for (const mount of row.Mounts) if (mount.RW === true) {
        if (typeof mount.Source !== "string" || !mount.Source.startsWith("/")) fail("Fallback competing mount cannot be verified.");
        const real = fs.realpathSync(mount.Source), stat = fs.statSync(real);
        if (pins.some(pin => real === pin.path || real.startsWith(pin.path + "/") || pin.path.startsWith(real + "/") || stat.dev === pin.dev && stat.ino === pin.ino)) fail("Fallback source has a competing writable mount.");
      }
    }
    if ((phase === "running" || phase === "created") && seen.size !== expected.size) fail("Fallback source role is missing.");
    if (phase === "stopped") for (const value of processes.values()) {
      const path = `/proc/${value.pid}/stat`;
      if (!absent(path)) { const text = proc(path); if (text.slice(text.lastIndexOf(") ") + 2).trim().split(/\s+/u)[19] === value.birth) fail("Fallback original process still exists."); }
      if (!absent(value.cgroup + "/cgroup.procs") && proc(value.cgroup + "/cgroup.procs", 4096).trim()) fail("Fallback original cgroup still contains processes.");
    }
    await domain(deadline); check(deadline);
  };
  try {
    for (const path of [input.dataDirectory, input.releaseDirectory]) {
      if (fs.realpathSync(path) !== path) fail("Fallback source directory is not canonical.");
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW), stat = fs.fstatSync(fd);
      pins.push({ path, fd, dev: stat.dev, ino: stat.ino, uid: stat.uid });
    }
    check(); imageId = JSON.parse(await command(["image", "inspect", input.image, "--format", "{{json .Id}}"]));
    if (typeof imageId !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(imageId)) fail("Fallback immutable image is unavailable.");
    await inventory(input.created ? "created" : "running");
    if (!input.created && (processes.size !== expected.size || input.roles.some(role => !processes.has(role.containerId)))) fail("Fallback lacks a complete native process roster.");
    const evidence = Object.freeze({ protocol: input.created ? "clank-provider-fallback-launch-intent/1" : "clank-provider-fallback-roles/1", owner: input.owner, projectId: input.projectId, releaseId: input.releaseId, generation: input.generation, capsuleSha256: input.capsuleSha256, daemonId: daemonId!, imageId,
      policySha256: digest(JSON.stringify({ user: input.user, network: input.network, memory: input.memory, cpus: input.cpus, pidsLimit: input.pidsLimit })),
      roles: Object.freeze(input.roles.map(role => Object.freeze({ role: role.role, instance: role.instance, containerId: role.containerId, configurationSha256: configurations.get(role.containerId), ...processes.get(role.containerId) }))),
      paths: Object.freeze(pins.map(pin => Object.freeze({ path: pin.path, dev: pin.dev, ino: pin.ino, uid: pin.uid }))) });
    let cleanupDeadline: bigint | undefined;
    const cleanupBound = () => cleanupDeadline ??= process.hrtime.bigint() + 30000000000n;
    return Object.freeze({ evidence, check: () => check(), cleanupDeadline: cleanupBound, cleanupVerifyRunning: () => inventory("running", cleanupBound()), cleanupVerifyRemaining: () => inventory("remaining", cleanupBound()), cleanupVerifyConfiguration: () => inventory("configuration", cleanupBound()), cleanupVerifyStopped: () => inventory("stopped", cleanupBound()), verifyCreated: () => inventory("created"), verifyRunning: () => inventory("running"), verifyRemaining: () => inventory("remaining"), verifyStopped: () => inventory("stopped"), close });
  } catch (error) { close(); throw error; }
}
