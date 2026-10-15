/** Detached cleanup authority, enrolled while each exact target CID is never-started. */
import { providerDockerClient, runProviderDockerClient, type DockerClient } from "./provider-docker-client.ts";
export type ProviderFallbackWatchdog = { check(): void; create(args: string[]): Promise<string>; retain(cid: string): Promise<void>; commit(): Promise<void>; close(): Promise<void> };
export async function openProviderFallbackWatchdog(client: DockerClient, input: { owner: string; projectId: string; releaseId: string; generation: number; deadline: bigint }): Promise<ProviderFallbackWatchdog> {
  const process = (globalThis as any).process, cp = process.getBuiltinModule("node:child_process"), nonce = crypto.randomUUID();
  const remaining = input.deadline - (process.hrtime.bigint() as bigint);
  if (remaining <= 0n) throw new Error("Fallback watchdog deadline expired before enrollment.");
  const cleanupReserve = remaining / 3n < 10000000000n ? remaining / 3n : 10000000000n, stopAt = input.deadline - cleanupReserve;
  const daemonId = JSON.parse((await runProviderDockerClient(client, ["info", "--format", "{{json .ID}}"], { timeoutMs: Math.max(1, Math.min(15000, Number((input.deadline - process.hrtime.bigint()) / 1000000n))), maxOutputBytes: 65536 })).stdout);
  const program = `import {runProviderFallbackWatchdogWorker} from ${JSON.stringify(new URL("./provider-fallback-watchdog.js", import.meta.url).href)};runProviderFallbackWatchdogWorker();`;
  const child = cp.spawn(process.execPath, ["--input-type=module", "--eval", program], { detached: true, stdio: ["pipe", "pipe", "pipe"], shell: false, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  let failure: Error | undefined, ended = false, committed = false, text = "", sequence = 0;
  const pending = new Map<number, { resolve(value?: any): void; reject(error: Error): void }>();
  const fail = (error: Error) => { failure ??= error; for (const waiter of pending.values()) waiter.reject(failure); pending.clear(); };
  const closed = new Promise<void>((resolve, reject) => { child.once("error", (error: Error) => { fail(error); reject(error); }); child.once("close", (code: number) => { ended = true; if (code !== 0) { const error = new Error("Fallback detached cleanup did not verify absence."); fail(error); reject(error); } else { if (!committed) fail(new Error("Fallback watchdog fenced its exact target roles.")); resolve(); } }); }); void closed.catch(() => {});
  child.stdin.on("error", fail); child.stdout.setEncoding("utf8"); child.stderr.resume();
  child.stdout.on("data", (chunk: string) => { text += chunk; if (text.length > 65536) { fail(new Error("Fallback watchdog response exceeds its bound.")); return; } for (;;) { const at = text.indexOf("\n"); if (at < 0) break; const line = text.slice(0, at); text = text.slice(at + 1); try { const row = JSON.parse(line); if (row.nonce !== nonce || !Number.isSafeInteger(row.sequence)) throw new Error("Fallback watchdog response differs."); if (row.event === "committed") committed = true; if (!["ready", "retained", "created", "committed"].includes(row.event)) throw new Error("Fallback watchdog refused native enrollment."); pending.get(row.sequence)?.resolve(row); pending.delete(row.sequence); } catch (error) { fail(error as Error); } } });
  const check = () => { if (failure || ended && !committed || process.hrtime.bigint() >= stopAt && !committed) throw failure ?? new Error("Fallback watchdog admission expired."); };
  const send = (frame: object) => { check(); const id = ++sequence; const result = new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject })); child.stdin.write(JSON.stringify({ ...frame, sequence: id, nonce }) + "\n"); return result; };
  await send({ action: "initialize", ...input, deadline: String(input.deadline), stopAt: String(stopAt), daemonId, executable: client.executable, environment: client.environment });
  return Object.freeze({ check, async create(args: string[]) { const result = await send({ action: "create", args }); check(); if (!/^[a-f0-9]{64}$/u.test(result.cid)) throw new Error("Fallback watchdog created CID differs."); return result.cid; }, async retain(cid: string) { await send({ action: "retain", cid }); check(); }, async commit() { await send({ action: "commit" }); await closed; }, async close() { if (!ended && !committed) child.stdin.end(); await closed; } });
}

/** Worker entrypoint; only its private parent pipe can enroll or release CIDs. */
export function runProviderFallbackWatchdogWorker(): void {
  const process = (globalThis as any).process, fs = process.getBuiltinModule("node:fs"), crypto = process.getBuiltinModule("node:crypto");
  let frame: any, client: DockerClient, input = "", ending = false, committed = false, timer: ReturnType<typeof setTimeout>, cleanupDeadline: bigint | undefined;
  const ordinaryAbort = new AbortController();
  let activeCreate: Promise<string> | undefined;
  let creating: { name: string; sequence: number } | undefined;
  const records = new Map<string, { configuration: string; process?: { pid: number; birth: string; cgroup: string } }>();
  const now = () => process.hrtime.bigint() as bigint, deadline = () => cleanupDeadline ?? BigInt(frame.stopAt);
  const check = () => { if (now() >= deadline()) throw new Error("Fallback watchdog deadline expired."); };
  const command = async (args: string[], allowFailure = false) => { check(); return (await runProviderDockerClient(client, args, { timeoutMs: Math.max(1, Math.min(15000, Number((deadline() - now()) / 1000000n))), maxOutputBytes: 1024 * 1024, allowFailure, ...(ending ? {} : { signal: ordinaryAbort.signal }) })).stdout; };
  const domain = async () => { if (JSON.parse(await command(["info", "--format", "{{json .ID}}"] )) !== frame.daemonId) throw new Error("Fallback watchdog daemon changed."); };
  const proc = (path: string) => { const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); try { const bytes = Buffer.alloc(65537), count = fs.readSync(fd, bytes, 0, bytes.length, 0); if (count > 65536) throw new Error("Fallback watchdog process observation exceeds its bound."); return bytes.subarray(0, count).toString(); } finally { fs.closeSync(fd); } };
  const exists = (path: string) => { try { fs.lstatSync(path); return true; } catch (error) { if ((error as { code?: string }).code === "ENOENT") return false; throw error; } };
  const configuration = (row: any) => {
    if (!["", "docker-default"].includes(row.AppArmorProfile) || ![null, false].includes(row.HostConfig?.OomKillDisable) || row.State?.Running === true && row.AppArmorProfile !== "docker-default") throw new Error("Fallback watchdog native security transition differs.");
    return crypto.createHash("sha256").update(JSON.stringify({ Image: row.Image, Config: row.Config, HostConfig: { ...row.HostConfig, OomKillDisable: false }, AppArmorProfile: "docker-default", Mounts: [...row.Mounts].sort((a: any, b: any) => a.Destination.localeCompare(b.Destination)) })).digest("hex");
  };
  const inspect = async (cid: string) => { const ids = (await command(["container", "ls", "--all", "--no-trunc", "--filter", "id=" + cid, "--format", "{{.ID}}"])).trim(); if (!ids) return undefined; if (ids !== cid) throw new Error("Fallback watchdog exact CID inventory differs."); const rows = JSON.parse(await command(["container", "inspect", cid])); if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.Id !== cid || !Array.isArray(rows[0].Mounts)) throw new Error("Fallback watchdog CID differs."); return rows[0]; };
  const retainProcess = (cid: string, row: any, held: { process?: { pid: number; birth: string; cgroup: string } }) => {
    const pid = row.State?.Pid; if (!Number.isSafeInteger(pid) || pid < 1) { if (row.State?.Running) throw new Error("Fallback watchdog running PID is missing."); return; }
    const text = proc("/proc/" + pid + "/stat"), birth = text.slice(text.lastIndexOf(") ") + 2).trim().split(/\s+/u)[19], cgroup = proc("/proc/" + pid + "/cgroup").trim();
    if (!/^[1-9][0-9]{0,19}$/u.test(birth) || !cgroup.startsWith("0::/") || cgroup.includes("\n") || cgroup.includes("/../") || !["/docker/" + cid, "/docker-" + cid + ".scope"].some(suffix => cgroup.endsWith(suffix))) throw new Error("Fallback watchdog process identity differs.");
    const value = { pid, birth, cgroup: "/sys/fs/cgroup" + cgroup.slice(3) }; if (held.process && JSON.stringify(held.process) !== JSON.stringify(value)) throw new Error("Fallback watchdog process was replaced."); held.process = value;
  };
  const absent = () => {
    for (const held of records.values()) if (held.process) { const row = held.process, path = "/proc/" + row.pid + "/stat"; if (exists(path)) { const text = proc(path); if (text.slice(text.lastIndexOf(") ") + 2).trim().split(/\s+/u)[19] === row.birth) return false; } if (exists(row.cgroup + "/cgroup.procs") && proc(row.cgroup + "/cgroup.procs").trim()) return false; }
    const processes = fs.readdirSync("/proc").filter((name: string) => /^[1-9][0-9]*$/u.test(name)); if (processes.length > 65536) throw new Error("Fallback watchdog process inventory exceeds its bound.");
    for (const pid of processes) { check(); let groups: string; try { groups = proc("/proc/" + pid + "/cgroup"); } catch (error) { if ((error as {code?: string}).code === "ENOENT") continue; throw error; } for (const cid of records.keys()) if (groups.split("\n").some(group => group.endsWith("/docker/" + cid) || group.endsWith("/docker-" + cid + ".scope"))) return false; }
    return true;
  };
  const enroll = (cid: string, native: any) => {
    const labels = native?.Config?.Labels;
    if (!/^[a-f0-9]{64}$/u.test(cid) || !native || native.Id !== cid || native.State?.Status !== "created" || native.State.Running !== false || native.State.Pid !== 0 || native.State.StartedAt !== "0001-01-01T00:00:00Z" || labels?.["run.clank.managed"] !== "provider-runtime" || labels["run.clank.owner"] !== frame.owner || labels["run.clank.project"] !== frame.projectId || labels["run.clank.release"] !== frame.releaseId || labels["run.clank.generation"] !== String(frame.generation) || !["web", "worker", "scheduler"].includes(labels["run.clank.role"])) throw new Error("Fallback watchdog requires its original never-started role.");
    records.set(cid, { configuration: configuration(native) });
  };
  const retainUncertainCreate = async () => {
    if (!creating) return;
    const rows = JSON.parse(await command(["container", "inspect", creating.name]));
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.Name !== "/" + creating.name) throw new Error("Fallback watchdog uncertain create differs.");
    enroll(rows[0].Id, rows[0]); creating = undefined;
  };
  const currentRetained = async () => {
    const raw = (await command(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"])).trim(), ids = raw ? raw.split("\n") : [];
    if (ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(cid => !/^[a-f0-9]{64}$/u.test(cid))) throw new Error("Fallback watchdog cleanup inventory differs.");
    return ids.filter(cid => records.has(cid));
  };
  const removeRetained = async () => {
    const ids = await currentRetained(); if (!ids.length) return;
    const rows = JSON.parse(await command(["container", "inspect", ...ids], true));
    if (!Array.isArray(rows) || rows.length > ids.length || new Set(rows.map(row => row?.Id)).size !== rows.length || rows.some(row => !ids.includes(row?.Id) || !Array.isArray(row.Mounts))) throw new Error("Fallback watchdog retained inspection differs.");
    const verified: string[] = [], errors: unknown[] = [];
    for (const row of rows) {
      const held = records.get(row.Id)!;
      try { if (configuration(row) !== held.configuration) throw new Error("Fallback watchdog retained configuration changed."); } catch (error) { errors.push(error); continue; }
      verified.push(row.Id);
      try { retainProcess(row.Id, row, held); } catch (error) { if ((error as {code?: string}).code !== "ENOENT") errors.push(error); }
    }
    // Observation races never suppress cleanup of the other verified CIDs.
    if (verified.length) await command(["container", "rm", "--force", ...verified], true);
    if (errors.length) throw new AggregateError(errors, "Fallback watchdog native observation did not converge.");
    if ((await currentRetained()).length) throw new Error("Fallback watchdog retained roles remain after cleanup.");
  };
  const cleanup = async () => {
    if (ending || committed) return; ending = true; clearTimeout(timer); ordinaryAbort.abort(new Error("Fallback target cleanup reserve began."));
    try {
      if (frame && client) {
        // This is a reserve inside the original deadline, never a new lifetime.
        cleanupDeadline = BigInt(frame.deadline); await domain(); await removeRetained();
        // A create awaiting acknowledgment cannot be started by the parent.
        // Remove acknowledged writers first; then resolve this unstarted orphan.
        if (creating) { await activeCreate?.catch(() => {}); await retainUncertainCreate(); await removeRetained(); }
        if ((await currentRetained()).length) throw new Error("Fallback watchdog target remains.");
        while (!absent()) { check(); await new Promise(resolve => setTimeout(resolve, 10)); }
        await domain(); check();
      }
      process.exit(0);
    } catch { process.exit(1); }
  };
  process.stdout.on("error", () => {}); process.stderr.on("error", () => {});
  let tail = Promise.resolve();
  process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk: string) => { input += chunk; if (input.length > 2097152) { void cleanup(); return; } for (;;) { const at = input.indexOf("\n"); if (at < 0) break; const line = input.slice(0, at); input = input.slice(at + 1); tail = tail.then(async () => {
    if (ending || committed) return; const row = JSON.parse(line);
    if (!frame) {
      frame = row; if (row.action !== "initialize" || typeof row.deadline !== "string" || !/^\d{1,24}$/u.test(row.deadline) || BigInt(row.deadline) <= now() || BigInt(row.deadline) > now() + 30000000000n || typeof row.stopAt !== "string" || !/^\d{1,24}$/u.test(row.stopAt) || BigInt(row.stopAt) <= now() || BigInt(row.stopAt) >= BigInt(row.deadline) || typeof row.daemonId !== "string" || typeof row.nonce !== "string" || typeof row.executable !== "string" || !row.environment || typeof row.environment !== "object" || Object.keys(row.environment).length > 128) throw new Error("Fallback watchdog initialization differs.");
      for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, row.environment); client = providerDockerClient({ executable: row.executable, dockerEnvironment: row.environment });
      timer = setTimeout(() => { void cleanup(); }, Math.max(1, Number((BigInt(row.stopAt) - now()) / 1000000n))); await domain();
      if (!ending) process.stdout.write(JSON.stringify({ nonce: frame.nonce, sequence: row.sequence, event: "ready" }) + "\n"); return;
    }
    check(); if (row.nonce !== frame.nonce) throw new Error("Fallback watchdog parent changed.");
    if (row.action === "create") {
      if (!Array.isArray(row.args) || row.args.length > 256 || row.args.some((arg: unknown) => typeof arg !== "string" || arg.length > 1048576) || row.args[0] !== "container" || row.args[1] !== "create" || row.args.includes("--name") || records.size >= 34 || creating) throw new Error("Fallback watchdog create contract differs.");
      await domain(); const name = "clank-fallback-" + frame.nonce.replaceAll("-", "") + "-" + row.sequence; creating = { name, sequence: row.sequence };
      activeCreate = command(["container", "create", "--name", name, ...row.args.slice(2)]); const cid = (await activeCreate).trim();
      if (ending) return;
      if (!/^[a-f0-9]{64}$/u.test(cid)) throw new Error("Fallback watchdog create identity differs.");
      const native = await inspect(cid); if (native?.Name !== "/" + name) throw new Error("Fallback watchdog created name differs."); enroll(cid, native); creating = undefined; check();
      if (!ending) process.stdout.write(JSON.stringify({ nonce: frame.nonce, sequence: row.sequence, event: "created", cid }) + "\n"); return;
    }
    if (row.action === "retain") {
      if (!/^[a-f0-9]{64}$/u.test(row.cid) || records.has(row.cid) || records.size >= 34) throw new Error("Fallback watchdog role roster differs.");
      await domain(); const native = await inspect(row.cid), labels = native?.Config?.Labels;
      if (!native || native.State?.Status !== "created" || native.State.Pid !== 0 || labels?.["run.clank.managed"] !== "provider-runtime" || labels["run.clank.owner"] !== frame.owner || labels["run.clank.project"] !== frame.projectId || labels["run.clank.release"] !== frame.releaseId || labels["run.clank.generation"] !== String(frame.generation) || !["web", "worker", "scheduler"].includes(labels["run.clank.role"])) throw new Error("Fallback watchdog requires its original never-started role.");
      records.set(row.cid, { configuration: configuration(native) }); check(); if (!ending) process.stdout.write(JSON.stringify({ nonce: frame.nonce, sequence: row.sequence, event: "retained" }) + "\n"); return;
    }
    if (row.action !== "commit" || !records.size) throw new Error("Fallback watchdog cannot release an empty role roster.");
    check(); committed = true; clearTimeout(timer); process.stdin.pause(); process.stdout.write(JSON.stringify({ nonce: frame.nonce, sequence: row.sequence, event: "committed" }) + "\n", () => process.exit(0));
  }).catch(() => cleanup()); } });
  process.stdin.on("end", () => { void cleanup(); }); process.stdin.on("error", () => { void cleanup(); });
  setTimeout(() => { if (!frame) process.exit(1); }, 2000).unref();
}
