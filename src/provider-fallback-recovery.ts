/** Native cleanup driven only by the original platform's authenticated phase journal. */
import { providerFallbackRecoveryContext, providerFallbackRecoveryFinalizationContext } from "./provider-fallback-coordinator.ts";
import { assertProviderServiceOwnership, type ProviderServiceOwnership } from "./provider-handoff.ts";
import { runProviderDockerClient, type DockerClient } from "./provider-docker-client.ts";
const proofs = new WeakMap<object, { check(): void; verifyStopped(): Promise<void>; finalize(permit: object): Promise<void>; close(): void }>();
const fail = (message: string): never => { throw new Error(message); };
const CID = /^[a-f0-9]{64}$/u;
export function providerFallbackNativeRecoveryContext(proof: object) {
  const held = proofs.get(proof); if (!held) throw new Error("A genuine authenticated fallback cleanup proof is required."); held.check(); return Object.freeze({ ...held });
}
export async function verifyProviderFallbackRecovery(authority: object, sourceOwnerInput: object, targetOwnerInput: object, clientInput: object): Promise<object> {
  const authorized = providerFallbackRecoveryContext(authority), input = authorized.input;
  const sourceOwner = sourceOwnerInput as ProviderServiceOwnership, targetOwner = targetOwnerInput as ProviderServiceOwnership;
  assertProviderServiceOwnership(sourceOwner); assertProviderServiceOwnership(targetOwner);
  const process = (globalThis as any).process, fs = process.getBuiltinModule("node:fs"), crypto = process.getBuiltinModule("node:crypto");
  const client = clientInput as DockerClient, deadline: bigint = (process.hrtime.bigint() as bigint) + 30000000000n;
  const early = input.phase === "stopping" || input.phase === "stopped";
  if (input.protocol !== "clank-provider-fallback/1" || !["stopping", "stopped", "launching", "prepared"].includes(input.phase) || !input.source || !input.endpointBindings || sourceOwner === targetOwner || sourceOwner.root === targetOwner.root) fail("Fallback cleanup requires its exact authenticated native phase.");
  const source = input.source, target = early ? undefined : input.phase === "prepared" ? input.target : input.launchIntent, identity = input.identity;
  if (!early && !target) fail("Fallback cleanup has no authenticated target role intent.");
  const pins: Array<{ path: string; fd: number; dev: number; ino: number; uid: number; mode?: number }> = [];
  const observed = new Map<string, { pid: number; birth: string; cgroup: string }>();
  let closed = false;
  const exists = (path: string) => { try { fs.lstatSync(path); return true; } catch (error) { if ((error as { code?: string }).code === "ENOENT") return false; throw error; } };
  const read = (path: string, limit = 65536) => { const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); try { const bytes = Buffer.alloc(limit + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0); if (count > limit) fail("Fallback cleanup native observation exceeds its bound."); return bytes.subarray(0, count).toString(); } finally { fs.closeSync(fd); } };
  const check = () => {
    authorized.check(); assertProviderServiceOwnership(sourceOwner); assertProviderServiceOwnership(targetOwner);
    if (closed || process.hrtime.bigint() >= deadline) fail("Fallback cleanup authority expired.");
    for (const pin of pins) for (const stat of [fs.fstatSync(pin.fd), fs.lstatSync(pin.path)]) if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== pin.dev || stat.ino !== pin.ino || stat.uid !== pin.uid || stat.mode & 0o022 || pin.mode !== undefined && stat.mode !== pin.mode) fail("Fallback cleanup native path identity changed.");
  };
  const close = () => { if (closed) return; closed = true; for (const pin of pins.splice(0)) fs.closeSync(pin.fd); };
  const command = async (args: string[]) => { check(); const result = await runProviderDockerClient(client, args, { timeoutMs: Math.max(1, Math.min(15000, Number((deadline - (process.hrtime.bigint() as bigint)) / 1000000n))), maxOutputBytes: 1024 * 1024 }); check(); return result.stdout; };
  const pin = (value: any) => {
    if (typeof value.path !== "string" || fs.realpathSync(value.path) !== value.path || !Number.isSafeInteger(value.dev) || !Number.isSafeInteger(value.ino) || !Number.isSafeInteger(value.uid) || pins.some(pin => pin.path === value.path)) fail("Fallback authenticated native path is invalid.");
    const fd = fs.openSync(value.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); pins.push({ path: value.path, fd, dev: value.dev, ino: value.ino, uid: value.uid, ...(value.mode !== undefined ? { mode: value.mode } : {}) });
  };
  const endpoint = (binding: any, owner: ProviderServiceOwnership) => {
    if (!binding || binding.protocol !== "clank-provider-fallback-endpoint/1" || binding.root !== owner.root || binding.serviceDirectory !== owner.serviceDirectory || typeof binding.owner !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(binding.owner) || typeof binding.daemonId !== "string" || !Array.isArray(binding.paths) || binding.paths.length !== 2 || binding.paths[0].path !== owner.root || binding.paths[1].path !== owner.serviceDirectory) fail("Fallback endpoint native identity differs.");
    for (const value of binding.paths) { if (!Number.isSafeInteger(value.mode)) fail("Fallback endpoint mode is missing."); pin(value); }
  };
  const validateRecord = (record: any, owner: ProviderServiceOwnership, binding: any, generation: number, created: boolean) => {
    if (record.protocol !== (created ? "clank-provider-fallback-launch-intent/1" : "clank-provider-fallback-roles/1") || record.projectId !== identity.projectId || record.releaseId !== identity.releaseId || record.generation !== generation || record.owner !== binding.owner || record.daemonId !== binding.daemonId || !CID.test(record.capsuleSha256) || !CID.test(record.policySha256) || !/^sha256:[a-f0-9]{64}$/u.test(record.imageId) || !Array.isArray(record.roles) || !record.roles.length || record.roles.length > 34 || !Array.isArray(record.paths) || record.paths.length !== 2) fail("Fallback authenticated native record is invalid.");
    const roles = new Set<string>(), ids = new Set<string>();
    for (const role of record.roles) {
      if (!["web", "worker", "scheduler"].includes(role.role) || !Number.isSafeInteger(role.instance) || role.instance < 0 || role.instance > 31 || role.role !== "worker" && role.instance !== 0 || !CID.test(role.containerId) || !CID.test(role.configurationSha256) || ids.has(role.containerId) || roles.has(role.role + ":" + role.instance)) fail("Fallback authenticated role identity is invalid.");
      if (created) { if (role.pid !== undefined || role.birth !== undefined || role.cgroup !== undefined) fail("Fallback launch intent cannot synthesize process identity."); }
      else { if (!Number.isSafeInteger(role.pid) || role.pid < 1 || !/^[1-9][0-9]{0,19}$/u.test(role.birth) || typeof role.cgroup !== "string" || !role.cgroup.startsWith("/sys/fs/cgroup/") || role.cgroup.includes("/../") || !["/docker/" + role.containerId, "/docker-" + role.containerId + ".scope"].some(suffix => role.cgroup.endsWith(suffix))) fail("Fallback authenticated process identity is invalid."); observed.set(role.containerId, { pid: role.pid, birth: role.birth, cgroup: role.cgroup }); }
      ids.add(role.containerId); roles.add(role.role + ":" + role.instance);
    }
    if (!roles.has("web:0") || record.roles.filter((role: any) => role.role === "web").length !== 1) fail("Fallback cleanup requires its exact web role.");
    for (const value of record.paths) { if (typeof value.path !== "string" || !value.path.startsWith(owner.root + "/projects/" + identity.projectId + "/")) fail("Fallback authenticated data path differs."); pin(value); }
  };
  const configuration = (row: any) => {
    if (!["", "docker-default"].includes(row.AppArmorProfile) || ![null, false].includes(row.HostConfig?.OomKillDisable) || row.State?.Running === true && row.AppArmorProfile !== "docker-default") fail("Fallback cleanup security transition differs.");
    return crypto.createHash("sha256").update(JSON.stringify({ Image: row.Image, Config: row.Config, HostConfig: { ...row.HostConfig, OomKillDisable: false }, AppArmorProfile: "docker-default", Mounts: [...row.Mounts].sort((a: any, b: any) => a.Destination.localeCompare(b.Destination)) })).digest("hex");
  };
  const retainProcess = (cid: string, row: any) => {
    const pid = row.State?.Pid;
    if (!Number.isSafeInteger(pid) || pid < 0 || row.State.Running === true && pid < 1) fail("Fallback cleanup running process is missing.");
    if (!pid) return;
    const stat = read("/proc/" + pid + "/stat"), birth = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/u)[19], group = read("/proc/" + pid + "/cgroup", 4096).trim();
    if (!/^[1-9][0-9]{0,19}$/u.test(birth) || !group.startsWith("0::/") || group.includes("\n") || group.includes("/../") || !["/docker/" + cid, "/docker-" + cid + ".scope"].some(suffix => group.endsWith(suffix))) fail("Fallback cleanup native process differs.");
    const value = { pid, birth, cgroup: "/sys/fs/cgroup" + group.slice(3) }, previous = observed.get(cid);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) fail("Fallback authenticated native process was replaced.");
    const status = read("/proc/" + pid + "/status"), field = (name: string) => new RegExp("^" + name + ":\\s*(.+)$", "mu").exec(status)?.[1]?.trim();
    if (read("/proc/" + pid + "/attr/current", 4096).trim() !== "docker-default (enforce)" || field("NoNewPrivs") !== "1" || field("Seccomp") !== "2" || ["CapEff", "CapPrm", "CapBnd"].some(name => !/^0+$/u.test(field(name) ?? ""))) fail("Fallback cleanup native process security changed.");
    observed.set(cid, value);
  };
  const sourceIds = new Map<string, any>(source.roles.map((role: any) => [role.containerId, role]));
  const targetIds = new Map<string, any>((target?.roles ?? []).map((role: any) => [role.containerId, role]));
  const absentProcesses = () => {
    for (const role of observed.values()) {
      const path = "/proc/" + role.pid + "/stat";
      if (exists(path)) { const text = read(path); if (text.slice(text.lastIndexOf(") ") + 2).trim().split(/\s+/u)[19] === role.birth) fail("Fallback original role process remains alive."); }
      if (exists(role.cgroup + "/cgroup.procs") && read(role.cgroup + "/cgroup.procs", 4096).trim()) fail("Fallback original role cgroup still contains processes.");
    }
    // A launch intent predates process creation. Inspect the real native process
    // namespace as well, so an already-removed CID cannot hide a live cgroup.
    if (input.phase === "launching") {
      const processes = fs.readdirSync("/proc").filter((name: string) => /^[1-9][0-9]*$/u.test(name)); if (processes.length > 65536) fail("Fallback native process inventory exceeds its bound.");
      for (const pid of processes) { check(); let groups: string; try { groups = read("/proc/" + pid + "/cgroup", 4096); } catch (error) { if ((error as {code?: string}).code === "ENOENT") continue; throw error; } for (const cid of targetIds.keys()) if (groups.split("\n").some(group => group.endsWith("/docker/" + cid) || group.endsWith("/docker-" + cid + ".scope"))) fail("Fallback intended role retains a native process."); }
    }
  };
  const inventory = async (cleanup: boolean) => {
    check(); const daemon = JSON.parse(await command(["info", "--format", "{{json .ID}}"]));
    if (daemon !== input.endpointBindings.source.daemonId || daemon !== input.endpointBindings.target.daemonId) fail("Fallback cleanup cannot establish both original native Docker domains.");
    const raw = (await command(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"])).trim(), ids = raw ? raw.split("\n") : [];
    if (ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(cid => !CID.test(cid))) fail("Fallback cleanup Docker inventory is invalid.");
    const removal: string[] = [];
    for (const cid of ids) {
      const rows = JSON.parse(await command(["container", "inspect", cid])); if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.Id !== cid || !Array.isArray(rows[0].Mounts)) fail("Fallback cleanup container observation differs.");
      const row = rows[0], role = sourceIds.get(cid) ?? targetIds.get(cid), sourceRole = sourceIds.has(cid);
      if (role) {
        if (!cleanup || sourceRole && !early) fail("Fallback retained role remains present.");
        const record = sourceRole ? source : target;
        if (configuration(row) !== role.configurationSha256 || row.Image !== record.imageId || row.RestartCount !== 0 || row.State?.Paused || row.State?.Restarting || row.State?.Dead) fail("Fallback cleanup role configuration changed.");
        retainProcess(cid, row); removal.push(cid); continue;
      }
      if ([input.endpointBindings.source, input.endpointBindings.target].some(binding => row.Config?.Labels?.["run.clank.owner"] === binding.owner && row.Config.Labels["run.clank.project"] === identity.projectId)) fail("Fallback cleanup found an unretained project role; original watchdog cleanup must finish first.");
      for (const mount of row.Mounts) if (mount.RW === true) { if (typeof mount.Source !== "string" || !mount.Source.startsWith("/")) fail("Fallback cleanup cannot verify a competing writable mount."); const path = fs.realpathSync(mount.Source), stat = fs.statSync(path); if ([sourceOwner, targetOwner].some(owner => { const project = owner.root + "/projects/" + identity.projectId; return path === project || path.startsWith(project + "/") || project.startsWith(path + "/"); }) || pins.filter(pin => pin.path.includes("/projects/" + identity.projectId + "/")).some(pin => stat.dev === pin.dev && stat.ino === pin.ino)) fail("Fallback cleanup found a competing native writer."); }
    }
    check(); if (removal.length) await command(["container", "rm", "--force", ...removal]);
    if (!cleanup) absentProcesses();
    if (JSON.parse(await command(["info", "--format", "{{json .ID}}"] )) !== daemon) fail("Fallback cleanup Docker daemon changed."); check();
  };
  try {
    await command(["info", "--format", "{{json .ID}}"]);
    if (process.platform !== "linux" || client.environment.DOCKER_CONTEXT !== undefined || client.environment.DOCKER_HOST !== undefined && client.environment.DOCKER_HOST !== "unix:///var/run/docker.sock") fail("Fallback cleanup requires the original local native Docker client.");
    endpoint(input.endpointBindings.source, sourceOwner); endpoint(input.endpointBindings.target, targetOwner);
    validateRecord(source, sourceOwner, input.endpointBindings.source, identity.sourceGeneration, false);
    if (target) validateRecord(target, targetOwner, input.endpointBindings.target, identity.targetGeneration, input.phase === "launching");
    if (source.roles.some((role: any) => targetIds.has(role.containerId))) fail("Fallback source and target native roles overlap.");
    check(); await inventory(true); await inventory(false);
    const proof = Object.freeze({});
    const finalize = async (permit: object) => {
      const approval = providerFallbackRecoveryFinalizationContext(permit);
      const valid = () => { approval.check(); check(); if (approval.proof !== proof || approval.journal !== authorized.journal || approval.authentication !== authorized.authentication || approval.selected !== (early ? "source" : "target")) fail("Fallback recovery barrier release authority differs."); };
      valid(); await inventory(false); valid();
      const owner = early ? sourceOwner : targetOwner, generation = early ? identity.sourceGeneration : identity.targetGeneration;
      const retiring: string[] = [], barrier = owner.serviceDirectory + "/" + identity.projectId + ".evacuation.json";
      if (exists(barrier)) {
        const stat = fs.lstatSync(barrier); if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== fs.lstatSync(owner.serviceDirectory).uid) fail("Fallback recovery barrier is not private.");
        const held = JSON.parse(read(barrier)); if (held.id !== identity.operationId || held.projectId !== identity.projectId || held.releaseId !== identity.releaseId || held.generation !== generation || held.nativeFallback !== true) fail("Fallback recovery cannot release another operation's barrier.");
        retiring.push(barrier);
      }
      if (early) {
        const pendingPath = owner.serviceDirectory + "/" + identity.projectId + ".fallback-source.json";
        if (exists(pendingPath)) {
          const stat = fs.lstatSync(pendingPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== fs.lstatSync(owner.serviceDirectory).uid) fail("Fallback source pending marker is not private.");
          const pending = JSON.parse(read(pendingPath)), state = pending.serviceState;
          if (pending.protocol !== "clank-provider-fallback-source-pending/1" || pending.operationId !== identity.operationId || JSON.stringify(pending.evidence) !== JSON.stringify(source) || state?.projectId !== identity.projectId || state.releaseId !== identity.releaseId || state.generation !== identity.sourceGeneration || state.capsuleSha256 !== source.capsuleSha256) fail("Fallback recovery cannot retire another source operation's pending marker.");
          retiring.push(pendingPath);
        }
      }
      valid(); for (const path of retiring) fs.unlinkSync(path);
      const directory = fs.openSync(owner.serviceDirectory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      valid();
    };
    proofs.set(proof, { check, verifyStopped: () => inventory(false), finalize, close }); return proof;
  } catch (error) { close(); throw error; }
}

/** Close is deliberately available after the observation deadline or catalog lease expires. */
export function closeProviderFallbackNativeRecovery(proof: object): void {
  const held = proofs.get(proof); if (!held) throw new Error("A genuine authenticated fallback cleanup proof is required."); held.close();
}
const cancellations = new WeakMap<object, { check(): void; verifyRunning(): Promise<void>; close(): void }>();
export function providerFallbackNativeCancellationContext(proof: object) {
  const held = cancellations.get(proof); if (!held) throw new Error("A genuine authenticated fallback cancellation proof is required."); held.check(); return Object.freeze({ ...held });
}
export function closeProviderFallbackNativeCancellation(proof: object): void {
  const held = cancellations.get(proof); if (!held) throw new Error("A genuine authenticated fallback cancellation proof is required."); held.close();
}
/** A lost initial reservation can be cancelled only while the exact source still runs and stop never began. */
export async function verifyProviderFallbackReservationCancellation(authority: object, sourceOwnerInput: object, clientInput: object): Promise<object> {
  const authorized = providerFallbackRecoveryContext(authority), input = authorized.input, sourceOwner = sourceOwnerInput as ProviderServiceOwnership;
  assertProviderServiceOwnership(sourceOwner);
  const process = (globalThis as any).process, fs = process.getBuiltinModule("node:fs"), crypto = process.getBuiltinModule("node:crypto"), client = clientInput as DockerClient;
  const record = input.source, deadline: bigint = (process.hrtime.bigint() as bigint) + 30000000000n;
  if (input.protocol !== "clank-provider-fallback/1" || input.phase !== "reserved" || input.target !== null || !record || record.protocol !== "clank-provider-fallback-roles/1" || record.projectId !== input.identity.projectId || record.releaseId !== input.identity.releaseId || record.generation !== input.identity.sourceGeneration || !Array.isArray(record.roles) || !record.roles.length || record.roles.length > 34 || !Array.isArray(record.paths) || record.paths.length !== 2) fail("Fallback cancellation requires its authenticated initial running source.");
  const pins: Array<{ path: string; fd: number; dev: number; ino: number; uid: number }> = [];
  const roles = new Map<string, any>(); let closed = false;
  const exists = (path: string) => { try { fs.lstatSync(path); return true; } catch (error) { if ((error as { code?: string }).code === "ENOENT") return false; throw error; } };
  const check = () => {
    authorized.check(); assertProviderServiceOwnership(sourceOwner);
    if (closed || process.hrtime.bigint() >= deadline) fail("Fallback cancellation observation expired.");
    if (exists(sourceOwner.serviceDirectory + "/" + record.projectId + ".evacuation.json") || exists(sourceOwner.serviceDirectory + "/" + record.projectId + ".fallback-source.json")) fail("Fallback source stop may have begun; reservation cannot be cancelled.");
    for (const pin of pins) for (const stat of [fs.fstatSync(pin.fd), fs.lstatSync(pin.path)]) if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== pin.dev || stat.ino !== pin.ino || stat.uid !== pin.uid || stat.mode & 0o022) fail("Fallback cancellation path identity changed.");
  };
  const close = () => { if (closed) return; closed = true; for (const pin of pins.splice(0)) fs.closeSync(pin.fd); };
  const read = (path: string) => { const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); try { const bytes = Buffer.alloc(65537), count = fs.readSync(fd, bytes, 0, bytes.length, 0); if (count > 65536) fail("Fallback cancellation native observation exceeds its bound."); return bytes.subarray(0, count).toString(); } finally { fs.closeSync(fd); } };
  const command = async (args: string[]) => { check(); const result = await runProviderDockerClient(client, args, { timeoutMs: Math.max(1, Math.min(15000, Number((deadline - (process.hrtime.bigint() as bigint)) / 1000000n))), maxOutputBytes: 1024 * 1024 }); check(); return result.stdout; };
  const verifyRunning = async () => {
    check(); if (JSON.parse(await command(["info", "--format", "{{json .ID}}"] )) !== record.daemonId) fail("Fallback cancellation native daemon differs.");
    const raw = (await command(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"])).trim(), ids = raw ? raw.split("\n") : [];
    if (ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(cid => !CID.test(cid))) fail("Fallback cancellation inventory exceeds its bound.");
    const seen = new Set<string>();
    for (const cid of ids) {
      const rows = JSON.parse(await command(["container", "inspect", cid])); if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.Id !== cid || !Array.isArray(rows[0].Mounts)) fail("Fallback cancellation native container differs.");
      const row = rows[0], role = roles.get(cid);
      if (role) {
        if (![null, false].includes(row.HostConfig?.OomKillDisable) || row.AppArmorProfile !== "docker-default") fail("Fallback cancellation native security differs.");
        const signature = crypto.createHash("sha256").update(JSON.stringify({ Image: row.Image, Config: row.Config, HostConfig: { ...row.HostConfig, OomKillDisable: false }, AppArmorProfile: "docker-default", Mounts: [...row.Mounts].sort((a: any, b: any) => a.Destination.localeCompare(b.Destination)) })).digest("hex");
        if (signature !== role.configurationSha256 || row.Image !== record.imageId || row.State?.Running !== true || row.State.Status !== "running" || row.State.Pid !== role.pid || row.State.Paused || row.State.Restarting || row.State.Dead || row.RestartCount !== 0) fail("Fallback cancellation original role changed.");
        const stat = read("/proc/" + role.pid + "/stat"), birth = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/u)[19];
        if (birth !== role.birth || read("/proc/" + role.pid + "/cgroup").trim() !== "0::" + role.cgroup.slice("/sys/fs/cgroup".length) || read("/proc/" + role.pid + "/attr/current").trim() !== "docker-default (enforce)") fail("Fallback cancellation original process changed.");
        const status = read("/proc/" + role.pid + "/status"), field = (name: string) => new RegExp("^" + name + ":\\s*(.+)$", "mu").exec(status)?.[1]?.trim();
        if (field("NoNewPrivs") !== "1" || field("Seccomp") !== "2" || ["CapEff", "CapPrm", "CapBnd"].some(name => !/^0+$/u.test(field(name) ?? ""))) fail("Fallback cancellation native security changed.");
        seen.add(cid); continue;
      }
      if (row.Config?.Labels?.["run.clank.owner"] === record.owner && row.Config.Labels["run.clank.project"] === record.projectId) fail("Fallback cancellation has an unretained role.");
      for (const mount of row.Mounts) if (mount.RW === true) { if (typeof mount.Source !== "string" || !mount.Source.startsWith("/")) fail("Fallback cancellation competing mount is unverifiable."); const path = fs.realpathSync(mount.Source), stat = fs.statSync(path); if (pins.some(pin => path === pin.path || path.startsWith(pin.path + "/") || pin.path.startsWith(path + "/") || stat.dev === pin.dev && stat.ino === pin.ino)) fail("Fallback cancellation has a competing writer."); }
    }
    if (seen.size !== roles.size || JSON.parse(await command(["info", "--format", "{{json .ID}}"] )) !== record.daemonId) fail("Fallback cancellation source roster or daemon changed."); check();
  };
  try {
    for (const role of record.roles) {
      if (!CID.test(role.containerId) || roles.has(role.containerId) || !CID.test(role.configurationSha256) || !Number.isSafeInteger(role.pid) || role.pid < 1 || !/^[1-9][0-9]{0,19}$/u.test(role.birth) || typeof role.cgroup !== "string" || !role.cgroup.startsWith("/sys/fs/cgroup/") || role.cgroup.includes("/../") || !["/docker/" + role.containerId, "/docker-" + role.containerId + ".scope"].some(suffix => role.cgroup.endsWith(suffix))) fail("Fallback cancellation role identity is invalid."); roles.set(role.containerId, role);
    }
    for (const pin of record.paths) { if (typeof pin.path !== "string" || !pin.path.startsWith(sourceOwner.root + "/projects/" + record.projectId + "/") || fs.realpathSync(pin.path) !== pin.path || !Number.isSafeInteger(pin.dev) || !Number.isSafeInteger(pin.ino) || !Number.isSafeInteger(pin.uid) || pins.some(item => item.path === pin.path)) fail("Fallback cancellation path is invalid."); const fd = fs.openSync(pin.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); pins.push({ path: pin.path, fd, dev: pin.dev, ino: pin.ino, uid: pin.uid }); }
    await command(["info", "--format", "{{json .ID}}"]);
    if (process.platform !== "linux" || client.environment.DOCKER_CONTEXT !== undefined || client.environment.DOCKER_HOST !== undefined && client.environment.DOCKER_HOST !== "unix:///var/run/docker.sock") fail("Fallback cancellation requires its original local Docker client.");
    await verifyRunning(); const proof = Object.freeze({}); cancellations.set(proof, { check, verifyRunning, close }); return proof;
  } catch (error) { close(); throw error; }
}
