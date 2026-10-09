import type { LinuxHostCertificationOptions } from "./host-certification.ts";

export type LocalProviderFleetScenarioKind = "takeover" | "lease-loss" | "slow-transport" | "disk-read-only" | "coordinator-restart" | "provider-restart";
export interface LocalProviderFleetScenario {
  readonly protocol: "clank-fleet-scenario/1";
  readonly kind: LocalProviderFleetScenarioKind;
  readonly nodeTtlMs?: number;
  readonly operationLeaseMs?: number;
  readonly transportDelayMs?: number;
}
export interface LocalProviderFleetOptions {
  readonly certificate: LinuxHostCertificationOptions;
  readonly scenario: LocalProviderFleetScenario;
  readonly disposable: true;
  /** Two explicitly reserved, unused XFS project IDs. */
  readonly quotaIds: readonly [number, number];
  /** Ten unused local application ports beginning at this value. */
  readonly portStart: number;
  readonly signal?: AbortSignal;
}
export interface LocalProviderFleetEvent {
  readonly sequence: number;
  readonly elapsedMs: number;
  readonly node: "coordinator" | "node-a" | "node-b" | "fleet";
  readonly event: "started" | "claimed" | "executed" | "failed" | "desired" | "fault" | "restored" | "stale-rejected" | "stopped";
  readonly generation?: number;
  readonly fence?: number;
}
export interface LocalProviderFleetReport {
  readonly protocol: "clank-fleet-report/1";
  readonly scenario: Readonly<Required<LocalProviderFleetScenario>>;
  readonly status: "passed" | "blocked";
  readonly reason: "verified" | "certification-required" | "aborted" | "scenario-failed" | "cleanup-failed";
  readonly artifactSha256: string | null;
  readonly checks: readonly { readonly name: "host" | "processes" | "baseline" | "fault" | "recovery" | "fences" | "cleanup"; readonly status: "passed" | "blocked" }[];
  readonly timeline: readonly LocalProviderFleetEvent[];
}

const kinds: readonly LocalProviderFleetScenarioKind[] = ["takeover", "lease-loss", "slow-transport", "disk-read-only", "coordinator-restart", "provider-restart"];
const proc = (globalThis as any).process;
function ensure(value: unknown): asserts value { if (!value) throw new Error("Fleet scenario invariant failed."); }
function plain(value: any, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key) || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")))
    throw new TypeError("Fleet configuration requires plain data with declared fields.");
}
function integer(value: any, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError("Fleet value is outside its supported bound.");
  return value;
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function copy(value: any, depth = 0, budget = { remaining: 1024 }): any {
  if (--budget.remaining < 0 || depth > 12) throw new TypeError("Fleet configuration exceeds its bound.");
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "string" && value.length <= 16384) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 128 || Reflect.ownKeys(value).some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")))) throw new TypeError("Invalid fleet array.");
    return Array.from({ length: value.length }, (_, index) => { const property = Object.getOwnPropertyDescriptor(value, String(index)); if (!property || !property.enumerable) throw new TypeError("Invalid fleet array."); return copy(property.value, depth + 1, budget); });
  }
  if (value && typeof value === "object") {
    plain(value, Object.keys(value));
    const result = Object.create(null);
    for (const key of Object.keys(value)) result[key] = copy(Object.getOwnPropertyDescriptor(value, key)!.value, depth + 1, budget);
    return result;
  }
  throw new TypeError("Invalid fleet data value.");
}
/** Captures a bounded, portable scenario. No host paths or secrets belong here. */
export function parseLocalProviderFleetScenario(input: unknown): Readonly<Required<LocalProviderFleetScenario>> {
  plain(input, ["protocol", "kind", "nodeTtlMs", "operationLeaseMs", "transportDelayMs"]);
  const data = input as LocalProviderFleetScenario;
  if (data.protocol !== "clank-fleet-scenario/1" || !kinds.includes(data.kind)) throw new TypeError("Unsupported fleet scenario.");
  return frozen({ protocol: data.protocol, kind: data.kind, nodeTtlMs: integer(data.nodeTtlMs ?? 5000, 2000, 30000),
    operationLeaseMs: integer(data.operationLeaseMs ?? 3000, 1000, 30000), transportDelayMs: integer(data.transportDelayMs ?? 1500, 200, 10000) });
}
/** Deterministic scenario export; excludes operator configuration and private reports. */
export function exportLocalProviderFleetScenario(input: LocalProviderFleetScenario): string { return JSON.stringify(parseLocalProviderFleetScenario(input)); }

async function nodeModules(): Promise<any> {
  const names = ["node:fs/promises", "node:path", "node:crypto", "node:child_process", "node:url"];
  const [fs, path, crypto, child, url] = await Promise.all(names.map(name => import(name)));
  return { fs, path, crypto, child, url };
}
const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
async function command(executable: string, arguments_: readonly string[], allowFailure = false): Promise<{ code: number; output: string }> {
  const { child } = await nodeModules();
  return new Promise((resolve, reject) => {
    const process = child.spawn(executable, arguments_, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", NODE_NO_WARNINGS: "1" } });
    let output = "", bytes = 0, failure = false;
    const timer = setTimeout(() => { failure = true; process.kill("SIGKILL"); }, 15000);
    process.stdout.on("data", (value: any) => { bytes += value.length; if (bytes > 1024 * 1024) { failure = true; process.kill("SIGKILL"); } else output += value.toString(); });
    process.stderr.on("data", (value: any) => { bytes += value.length; if (bytes > 1024 * 1024) { failure = true; process.kill("SIGKILL"); } });
    process.on("error", () => { failure = true; });
    process.once("close", (code: number) => { clearTimeout(timer); if (failure || (code !== 0 && !allowFailure)) reject(new Error("Fleet infrastructure command failed.")); else resolve({ code, output }); });
  });
}
async function quota(mount: string, id: number, kind: string): Promise<number[]> {
  const { output } = await command("/usr/sbin/xfs_quota", ["-x", "-D", "/dev/null", "-P", "/dev/null", "-c", `report -p -n -N -${kind} -L ${id} -U ${id}`, mount]);
  const row = output.split("\n").map(line => line.trim().split(/\s+/)).find(parts => parts[0] === String(id) || parts[0] === `#${id}`);
  if (!row) return [0, 0, 0];
  const counts = row.slice(1, 4).map(Number); ensure(counts.length === 3 && counts.every(Number.isSafeInteger)); return counts;
}

/** Runs only fixed synthetic drills on a currently certified disposable Linux host. */
export async function runLocalProviderFleetScenario(options: LocalProviderFleetOptions): Promise<LocalProviderFleetReport> {
  plain(options, ["certificate", "scenario", "disposable", "quotaIds", "portStart", "signal"]);
  if (options.disposable !== true || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new TypeError("Explicit disposable fleet authorization and a valid signal are required.");
  const certificate = frozen(copy(options.certificate)); plain(certificate, ["directory", "profile"]);
  const scenario = parseLocalProviderFleetScenario(options.scenario), ids = copy(options.quotaIds);
  if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1]) throw new TypeError("Two distinct reserved quota IDs are required.");
  ids.forEach((id: number) => integer(id, 1, 0xffffffff));
  const portStart = integer(options.portStart, 1024, 65526), signal = options.signal;
  const { fs, path, crypto, child, url } = await nodeModules();
  const started = Date.now(), deadline = started + 180000;
  let reason: LocalProviderFleetReport["reason"] = "scenario-failed", artifactSha256: string | null = null;
  const names: LocalProviderFleetReport["checks"][number]["name"][] = ["host", "processes", "baseline", "fault", "recovery", "fences", "cleanup"];
  const passed = new Set<string>(), timeline: LocalProviderFleetEvent[] = [], workers: any[] = [];
  let root: string | undefined, lock: any, lockIdentity: number | undefined, failure = false, certificateExpiry = 0, manifest: any;
  const saveManifest = async () => {
    await lock.truncate(0);
    await lock.write(JSON.stringify({ ...manifest, phase: root ? "running" : "preflight", ...(root ? { root } : {}),
      workers: workers.filter(worker => Number.isSafeInteger(worker.process.pid)).map(worker => ({ role: worker.role, pid: worker.process.pid })) }), 0, "utf8");
    await lock.sync();
  };
  const event = (node: LocalProviderFleetEvent["node"], type: LocalProviderFleetEvent["event"], data: any = {}) => {
    if (timeline.length >= 512) { failure = true; return; }
    timeline.push({ sequence: timeline.length + 1, elapsedMs: Math.max(0, Date.now() - started), node, event: type,
      ...(Number.isSafeInteger(data.generation) && data.generation > 0 ? { generation: data.generation } : {}),
      ...(Number.isSafeInteger(data.fence) && data.fence > 0 ? { fence: data.fence } : {}) });
  };
  const active = () => { if (signal?.aborted || Date.now() > deadline || failure) throw new Error("Fleet stopped."); };
  const wait = async (check: () => Promise<any>, timeout = 30000): Promise<any> => {
    const end = Math.min(deadline, Date.now() + timeout);
    while (Date.now() < end) { active(); const value = await check(); if (value) return value; await sleep(50); }
    throw new Error("Fleet observation deadline.");
  };
  const docker = (args: string[], allowFailure = false) => command("/usr/bin/docker", ["--host", "unix:///var/run/docker.sock", ...args], allowFailure);
  const spawnWorker = async (role: string, configuration: any, port = 0): Promise<any> => {
    active();
    const executable = role.startsWith("provider") ? "/usr/bin/unshare" : proc.execPath;
    const [uid, gid] = role.startsWith("provider") ? configuration.profile.user.split(":").map(Number) : [];
    const capabilities = "sys_admin,+net_admin,+dac_override";
    const arguments_ = [...(role.startsWith("provider") ? ["--mount", "--propagation", "private", "/usr/bin/setpriv",
      `--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", `--inh-caps=+${capabilities}`, `--ambient-caps=+${capabilities}`,
      `--bounding-set=-all,+${capabilities}`, "--no-new-privs", proc.execPath] : []), url.fileURLToPath(import.meta.url), "--internal-fleet-worker"];
    const process = child.spawn(executable, arguments_, { cwd: root, stdio: ["ignore", "ignore", "ignore", "ipc"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", NODE_NO_WARNINGS: "1" } });
    let sequence = 0, closed = false, expectedExit = false;
    const pending = new Map<number, any>();
    const done = new Promise<void>(resolve => {
      process.once("close", () => { closed = true; if (!expectedExit) failure = true; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Fleet child exited.")); } pending.clear(); resolve(); });
    });
    process.on("error", () => { failure = true; });
    process.on("message", (message: any) => {
      if (message?.event) {
        if (!["claimed", "executed", "failed"].includes(message.event)) { failure = true; return; }
        event(role.endsWith("a") && role !== "coordinator" ? "node-a" : role === "coordinator" ? "coordinator" : "node-b", message.event, message); return;
      }
      const entry = pending.get(message?.id); if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.failed) entry.reject(new Error("Fleet child request failed.")); else entry.resolve(message.value);
    });
    const worker: any = { process, done, role, configuration, port, get closed() { return closed; },
      call(method: string, input?: any, timeout = 30000): Promise<any> {
        if (closed || !process.connected) return Promise.reject(new Error("Fleet child unavailable."));
        return new Promise((resolve, reject) => {
          const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error("Fleet child deadline.")); }, timeout);
          pending.set(id, { resolve, reject, timer }); process.send({ id, method, input }, (error: any) => { if (error) { pending.delete(id); clearTimeout(timer); reject(new Error("Fleet IPC unavailable.")); } });
        });
      },
      async stop(force = false) {
        if (closed) return;
        expectedExit = true;
        if (force) process.kill("SIGKILL"); else { try { await worker.call("close", undefined, 15000); } catch { process.kill("SIGKILL"); } }
        const timer = setTimeout(() => process.kill("SIGKILL"), 16000); try { await done; } finally { clearTimeout(timer); }
        event(role === "coordinator" ? "coordinator" : role.endsWith("a") ? "node-a" : "node-b", "stopped");
      },
    };
    workers.push(worker);
    await saveManifest();
    const ready = await worker.call("initialize", { ...configuration, role, port }); worker.port = ready.port ?? 0;
    event(role === "coordinator" ? "coordinator" : role.endsWith("a") ? "node-a" : "node-b", "started");
    return worker;
  };
  let coordinator: any, providerA: any, providerB: any, agentA: any, agentB: any;
  const nonce = crypto.randomBytes(12).toString("hex"), owners = [`fleet-${nonce}-a`, `fleet-${nonce}-b`];
  try {
    if (signal?.aborted) { reason = "aborted"; throw new Error("Fleet aborted."); }
    if (proc?.platform !== "linux" || proc.getuid() !== 0 || proc.geteuid() !== 0) { reason = "certification-required"; throw new Error("Fleet requires root Linux."); }
    const { requireCurrentLinuxHostCertification } = await import("./host-certification.ts");
    let report: any;
    try { report = await requireCurrentLinuxHostCertification(certificate); ensure(report.expiresAt > deadline + 120000); certificateExpiry = report.expiresAt; }
    catch { reason = "certification-required"; throw new Error("Fleet certificate unavailable."); }
    lock = await fs.open("/run/clank-host-certification.attempt", "wx", 0o600); lockIdentity = (await lock.stat()).ino;
    manifest = { protocol: "clank-fleet-attempt/1", pid: proc.pid, boot: String(await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), owners, quotaIds: ids, quotaMount: certificate.profile.diskQuota.mountDirectory, projectId: "fleet_project" };
    await saveManifest();
    for (const id of ids) for (const kind of ["b", "i"]) ensure((await quota(certificate.profile.diskQuota.mountDirectory, id, kind)).every(value => value === 0));
    root = await fs.mkdtemp(path.join(certificate.profile.diskQuota.mountDirectory, "clank-fleet-"));
    // Non-root providers and their capability-free SQLite children must traverse
    // this shared parent. Only the selected group gets search permission; root
    // coordinator/credential files remain mode 0600 and child roots mode 0700.
    await fs.chown(root, 0, Number(certificate.profile.user.split(":")[1]));
    await fs.chmod(root, 0o710);
    await saveManifest();
    passed.add("host");
    const config = { root, scenario, registrationToken: crypto.randomBytes(32).toString("hex"), ingressToken: crypto.randomBytes(32).toString("hex") };
    coordinator = await spawnWorker("coordinator", config);
    const providerConfig = (index: number) => ({ root: path.join(root!, index ? "node-b" : "node-a"), profile: certificate.profile, quotaId: ids[index], owner: owners[index], token: crypto.randomBytes(32).toString("hex"), ingressToken: config.ingressToken, portStart: portStart + index * 5 });
    providerA = await spawnWorker("provider-a", providerConfig(0)); providerB = await spawnWorker("provider-b", providerConfig(1));
    const agentConfig = (index: number, provider: any) => ({ root, scenario, registrationToken: config.registrationToken, coordinatorPort: coordinator.port, providerPort: provider.port, providerToken: provider.configuration.token, nodeId: index ? "node-b" : "node-a" });
    agentA = await spawnWorker("agent-a", agentConfig(0, providerA));
    const first = await coordinator.call("desired", { state: "running", placementMode: "portable" }); event("coordinator", "desired", first);
    const baseline = await wait(async () => { const state = await coordinator.call("inspect"); return state.desired?.observedGeneration === first.generation && state.desired.observedState === "running" && state.operation.state === "succeeded" ? state : null; });
    const initialProbe = await providerA.call("probe");
    ensure(initialProbe.generation === first.generation && initialProbe.content === "synthetic" && initialProbe.migrations === 1 && baseline.operation.state === "succeeded");
    artifactSha256 = baseline.artifactSha256; ensure(typeof artifactSha256 === "string" && /^[a-f0-9]{64}$/.test(artifactSha256)); passed.add("baseline");
    agentB = await spawnWorker("agent-b", agentConfig(1, providerB));
    ensure(new Set(workers.map(worker => worker.process.pid)).size === 5 && workers.every(worker => !worker.closed)); passed.add("processes");
    const initialFence = baseline.operation.fence;
    let replacement: any, target = providerA;
    event("fleet", "fault");
    if (scenario.kind === "takeover") {
      await agentA.call("pause", true);
      replacement = await coordinator.call("desired", { state: "running" });
      await wait(async () => (await agentA.call("inspect")).pausedClaim);
      await coordinator.call("pin");
      await agentA.stop(true); await providerA.stop();
      ensure(!(await docker(["container", "ls", "--all", "--quiet", "--filter", `label=run.clank.owner=${owners[0]}`])).output.trim());
      await coordinator.call("revoke", "node-a"); target = providerB;
    } else if (scenario.kind === "lease-loss") {
      await agentA.call("pause", true);
      await coordinator.call("fault", "renew");
      replacement = await coordinator.call("desired", { state: "running" });
      const claimed = await wait(async () => (await agentA.call("inspect")).pausedClaim);
      await wait(async () => Date.now() > claimed.leaseExpiresAt, scenario.operationLeaseMs + 10000);
      ensure(await agentA.call("stale"));
      await coordinator.call("fault", null); await agentA.call("pause", false);
    } else if (scenario.kind === "slow-transport") {
      await coordinator.call("fault", "slow"); replacement = await coordinator.call("desired", { state: "running" });
      await wait(async () => (await agentA.call("inspect")).transportTimeouts > 0);
      await coordinator.call("fault", null);
    } else if (scenario.kind === "disk-read-only") {
      await providerA.call("disk", true); replacement = await coordinator.call("desired", { state: "running" });
      await wait(async () => (await providerA.call("inspect")).diskWriteFailures > 0);
      const unaffected = await providerA.call("probe"); ensure(unaffected.generation === first.generation);
      await providerA.call("disk", false);
    } else if (scenario.kind === "coordinator-restart") {
      const port = coordinator.port; await coordinator.stop(true); coordinator = await spawnWorker("coordinator", config, port);
      const recovered = await coordinator.call("inspect"); ensure(recovered.desired.generation === first.generation && recovered.operation.fence === initialFence);
      replacement = await coordinator.call("desired", { state: "running" });
    } else {
      const port = providerA.port, configuration = providerA.configuration; await providerA.stop(true);
      ensure((await docker(["container", "ls", "--all", "--quiet", "--filter", `label=run.clank.owner=${owners[0]}`])).output.trim());
      providerA = await spawnWorker("provider-a", configuration, port); target = providerA;
      ensure(!(await docker(["container", "ls", "--all", "--quiet", "--filter", `label=run.clank.owner=${owners[0]}`])).output.trim());
      replacement = await coordinator.call("desired", { state: "running" });
    }
    if (scenario.kind !== "takeover") await coordinator.call("pin");
    passed.add("fault");
    const recovered = await wait(async () => { const state = await coordinator.call("inspect"); return state.desired?.observedGeneration === replacement.generation && state.desired.observedState === "running" && state.operation.state === "succeeded" ? state : null; }, 45000);
    const probe = await target.call("probe"); ensure(probe.generation === replacement.generation && probe.content === "synthetic" && probe.migrations === 1 && recovered.artifactSha256 === artifactSha256);
    ensure(recovered.operation.fence > initialFence);
    if (scenario.kind === "takeover") {
      ensure(recovered.desired.assignedNodeId === "node-b" && recovered.pinned.assignedNodeId === "node-a");
      // A newly started old credential cannot authenticate or resume the revoked node.
      ensure(await agentB.call("revoked", "node-a"));
    }
    ensure(await target.call("stale-fence"));
    event("fleet", "restored", { generation: replacement.generation, fence: recovered.operation.fence }); passed.add("recovery");
    event("fleet", "stale-rejected"); passed.add("fences"); reason = "verified";
  } catch { if (signal?.aborted) reason = "aborted"; event("fleet", "failed"); }
  finally {
    let cleaned = true;
    for (const role of ["agent", "provider", "coordinator"]) {
      const results = await Promise.allSettled(workers.filter(worker => worker.role.startsWith(role)).map(worker => worker.stop()));
      if (results.some(result => result.status === "rejected")) cleaned = false;
    }
    try {
      if (root) {
        const { createLinuxDockerNetworkPlan, removeLinuxDockerNetworkPolicy } = await import("./linux-project-isolation.ts");
        for (const owner of owners) {
          ensure(!(await docker(["container", "ls", "--all", "--quiet", "--filter", `label=run.clank.owner=${owner}`])).output.trim());
          const plan = await createLinuxDockerNetworkPlan(owner, "fleet_project", certificate.profile.outboundNetwork);
          const tables = JSON.parse((await command("/usr/sbin/nft", ["-j", "list", "tables"])).output);
          if (tables.nftables?.some((entry: any) => entry.table?.family === "inet" && entry.table.name === plan.table)) await removeLinuxDockerNetworkPolicy(plan);
          const listed = (await docker(["network", "ls", "--quiet", "--filter", `name=^${plan.network}$`])).output.trim();
          if (listed) {
            const network = JSON.parse((await docker(["network", "inspect", plan.network])).output)[0];
            ensure(network.Labels?.["run.clank.owner"] === owner && network.Labels?.["run.clank.project"] === "fleet_project");
            await docker(["network", "rm", plan.network]);
          }
          ensure(!(await docker(["network", "ls", "--quiet", "--filter", `name=^${plan.network}$`])).output.trim());
        }
        await fs.rm(root, { recursive: true });
        for (const id of ids) {
          for (const kind of ["b", "i"]) { let empty = false; for (let attempt = 0; attempt < 20; attempt++) { if ((await quota(certificate.profile.diskQuota.mountDirectory, id, kind))[0] === 0) { empty = true; break; } await sleep(100); } ensure(empty); }
          await command("/usr/sbin/xfs_quota", ["-x", "-D", "/dev/null", "-P", "/dev/null", "-c", `limit -p bsoft=0 bhard=0 isoft=0 ihard=0 ${id}`, certificate.profile.diskQuota.mountDirectory]);
          for (const kind of ["b", "i"]) ensure((await quota(certificate.profile.diskQuota.mountDirectory, id, kind)).every(value => value === 0));
        }
      }
    } catch { cleaned = false; }
    if (lock) {
      try { await lock.close(); ensure((await fs.lstat("/run/clank-host-certification.attempt")).ino === lockIdentity); if (cleaned) await fs.rm("/run/clank-host-certification.attempt"); }
      catch { cleaned = false; }
    }
    if (cleaned) passed.add("cleanup"); else reason = "cleanup-failed";
  }
  if (reason === "verified" && (signal?.aborted || Date.now() >= certificateExpiry || failure)) reason = signal?.aborted ? "aborted" : "scenario-failed";
  return frozen({ protocol: "clank-fleet-report/1", scenario, status: reason === "verified" && passed.size === names.length ? "passed" : "blocked", reason, artifactSha256,
    checks: names.map(name => ({ name, status: passed.has(name) ? "passed" : "blocked" })), timeline });
}

async function fleetWorker(): Promise<void> {
  proc.umask(0o077);
  const { fs, path } = await nodeModules();
  const [{ serve }, runner, provider] = await Promise.all([import("./node.ts"), import("./runner.ts"), import("./provider.ts")]);
  let configuration: any, dispatch: ((method: string, input: any) => Promise<any>) | undefined, close: () => Promise<void> = async () => {};
  let closing: Promise<void> | undefined;
  const send = (value: any) => { if (proc.connected) proc.send(value, () => {}); };
    const emit = (event: string, operation?: any) => {
      if (operation && operation.projectId !== "fleet_project") return;
      send({ event, generation: operation?.payload?.generation, fence: operation?.fence });
    };
  const shutdown = () => closing ??= close();
  const initialize = async (config: any) => {
    configuration = config;
    if (config.role === "coordinator") {
      const [{ defineDatabase, openSQLite }, { openDeploymentOrchestrator }, deploy, runtime] = await Promise.all([import("./backend.ts"), import("./orchestration.ts"), import("./deploy.ts"), import("./runtime-placement.ts")]);
      const source = path.join(config.root, "artifact"); await fs.mkdir(path.join(source, "dist"), { recursive: true, mode: 0o700 }); await fs.mkdir(path.join(source, "migrations"), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(source, "dist/server.mjs"), `const {createServer}=await import('node:http');const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(process.env.CLANK_DATABASE_PATH,{readOnly:true});createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({generation:Number(process.env.FLEET_GENERATION),content:db.prepare('SELECT content FROM sample').get().content,migrations:db.prepare('SELECT count(*) AS count FROM clank_migrations').get().count}));}).listen(Number(process.env.PORT),process.env.HOST);`, { mode: 0o600 });
      await fs.writeFile(path.join(source, "migrations/0001_sample.sql"), "CREATE TABLE sample(content TEXT NOT NULL); INSERT INTO sample VALUES('synthetic');", { mode: 0o600 });
      const artifact = await deploy.createDeploymentBundle(source, deploy.parseDeploymentConfig({ version: 1, entry: "dist/server.mjs", include: ["dist", "migrations"], database: { path: "app.sqlite", migrations: "migrations" }, health: { path: "/healthz", timeoutMs: 10000 }, env: {} }), { frameworkVersion: "fleet-simulator/1", nodeVersion: proc.versions.node });
      const artifactSha256 = await deploy.deploymentDigest(artifact), capsules = new Map<string, any>();
      const database = await openSQLite(defineDatabase({}), { path: path.join(config.root, "control.sqlite") });
      const orchestration = openDeploymentOrchestrator(database, { nodeTtlMs: config.scenario.nodeTtlMs, operationLeaseMs: config.scenario.operationLeaseMs, retryBaseMs: 1000 });
      let fault: string | null = null, transportTimeouts = 0;
      const handler = runner.createDeploymentCoordinatorHandler(orchestration, { registrationToken: config.registrationToken, maxArtifactBytes: 1024 * 1024, maxRuntimeBytes: 2 * 1024 * 1024,
        artifact: { async load({ operation }: any) { return operation.projectId === "fleet_project" ? { bytes: artifact, sha256: artifactSha256 } : null; } },
        runtime: { async load({ operation }: any) {
          if (operation.projectId !== "fleet_project") return null;
          const generation = operation.payload.generation, key = `${generation}:${operation.nodeId}`;
          if (!capsules.has(key)) capsules.set(key, await runtime.createDeploymentRuntimeCapsule({ projectId: "fleet_project", releaseId: "fleet_release", generation,
            environment: { FLEET_GENERATION: String(generation) }, database: { path: "app.sqlite", mode: generation === 1 || (config.scenario.kind === "takeover" && operation.nodeId === "node-b") ? "initialize" : "preserve" },
            ingress: { route: "/v1/clank/apps/fleet_project", token: config.ingressToken }, artifact }));
          return capsules.get(key);
        } },
      });
      const server = await serve(async request => {
        const operation = new URL(request.url).pathname.split("/").at(-1);
        if (request.headers.get("x-clank-node-id") === "node-a") {
          if (fault === "renew" && operation === "renew") await sleep(config.scenario.operationLeaseMs + 1000);
          if (fault === "slow" && operation === "runtime") { await sleep(config.scenario.transportDelayMs); if (request.signal.aborted) transportTimeouts++; }
        }
        return handler.handle(request);
      }, { hostname: "127.0.0.1", port: config.port, maxBodySize: 128 * 1024, requestTimeout: 15000 });
      const operationFor = async (desired: any) => !desired ? null : (await orchestration.enqueue({ projectId: desired.projectId, action: "reconcile",
        payload: { releaseId: desired.desiredReleaseId, state: desired.desiredState, generation: desired.generation, ...(desired.desiredState === "running" && desired.projectId === "fleet_project" ? { runtimeProtocol: "clank-runtime/1" } : {}) },
        idempotencyKey: `reconcile:${desired.projectId}:${desired.generation}` })).operation;
      dispatch = async (method, input) => {
        if (method === "desired") return orchestration.setDesired({ projectId: "fleet_project", releaseId: "fleet_release", state: "running", region: "local", runtimeProtocol: "clank-runtime/1", nodeRequirements: { labels: config.scenario.kind === "takeover" ? {} : { fleetNode: "node-a" } }, ...(input?.placementMode ? { placementMode: input.placementMode } : {}) });
        if (method === "inspect") { const desired = orchestration.desired("fleet_project"); return { desired, operation: await operationFor(desired), pinned: orchestration.desired("fleet_pinned"), artifactSha256, transportTimeouts }; }
        if (method === "pin") { await orchestration.setDesired({ projectId: "fleet_pinned", releaseId: "fleet_pinned_release", state: "running", placementMode: "stateful", region: "local", nodeRequirements: { labels: { fleetNode: "node-a" } } }); return orchestration.setDesired({ projectId: "fleet_pinned", releaseId: null, state: "stopped" }); }
        if (method === "fault") { ensure(input === null || input === "renew" || input === "slow"); fault = input; return true; }
        if (method === "revoke") return orchestration.revokeNode(input);
        throw new Error("Unsupported coordinator IPC.");
      };
      close = async () => { await server.close(); orchestration.close(); database.close(); };
      return { port: server.port };
    }
    if (config.role.startsWith("provider")) {
      const { openDockerDeploymentProviderService } = await import("./provider-service.ts");
      const [uid, gid] = config.profile.user.split(":").map(Number);
      ensure(proc.getuid() === uid && proc.geteuid() === uid && proc.getgid() === gid && proc.getegid() === gid && proc.getgroups().every((group: number) => group === gid));
      const status = String(await fs.readFile("/proc/self/status", "utf8"));
      ensure(/^Groups:[ \t]*$/m.test(status));
      for (const field of ["CapEff", "CapPrm", "CapInh", "CapBnd", "CapAmb"]) ensure(BigInt(`0x${status.match(new RegExp(`^${field}:\\s+([a-f0-9]+)$`, "m"))?.[1] ?? "0"}`) === 0x201002n);
      ensure(/^NoNewPrivs:\s+1$/m.test(status));
      await fs.mkdir(config.root, { recursive: true, mode: 0o700 }); await fs.mkdir(path.join(config.root, "docker-config"), { recursive: true, mode: 0o700 });
      // Pin roots through this mount before opening any provider descriptor.
      await command("/usr/bin/mount", ["--bind", config.root, config.root]);
      let readonly = false, service: any, server: any, lastRequest: any, diskWriteFailures = 0;
      close = async () => {
        if (readonly) await command("/usr/bin/mount", ["-o", "remount,bind,rw", config.root]);
        try { await server?.close(); await service?.close(); } finally { await command("/usr/bin/umount", [config.root]); }
      };
      service = await openDockerDeploymentProviderService({ rootDirectory: config.root, owner: config.owner, image: config.profile.image, data: { maxDatabaseBytes: 1024 * 1024 },
        docker: { executable: "/usr/bin/docker", dockerEnvironment: { DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONFIG: path.join(config.root, "docker-config") },
          user: config.profile.user, memory: config.profile.memory ?? "512m", cpus: config.profile.cpus ?? "1", pidsLimit: config.profile.pidsLimit ?? 128,
          diskQuota: { ...config.profile.diskQuota, quotaId: config.quotaId }, outboundNetwork: config.profile.outboundNetwork,
          portStart: config.portStart, portEnd: config.portStart + 4, maxRuntimes: 1, maxContainers: 1, stopTimeoutMs: 1000 },
      });
      const instrumented = { kind: service.kind, async reconcile(request: any) {
        if (request.operation.projectId === "fleet_project") lastRequest = request;
        try { await service.reconcile(request); }
        catch (error) { if (readonly && (error as any).code === "EROFS") diskWriteFailures++; throw error; }
      } };
      const handler = provider.createDeploymentProviderHandler(instrumented, { token: config.token, maxArtifactBytes: 1024 * 1024, maxRuntimeBytes: 2 * 1024 * 1024 });
      server = await serve(request => handler.paths.includes(new URL(request.url).pathname as any) ? handler.handle(request) : service.handle(request), { hostname: "127.0.0.1", port: config.port, maxBodySize: 4 * 1024 * 1024 });
      dispatch = async (method, input) => {
        if (method === "inspect") return { state: await service.inspect("fleet_project"), diskWriteFailures };
        if (method === "disk") {
          ensure(typeof input === "boolean"); await command("/usr/bin/mount", ["-o", input ? "remount,bind,ro" : "remount,bind,rw", config.root]); readonly = input;
          if (input) { let rejected = false; try { await fs.writeFile(path.join(config.root, "read-only-control"), "must fail", { flag: "wx" }); } catch (error) { rejected = (error as any).code === "EROFS"; } ensure(rejected); }
          return true;
        }
        if (method === "probe") {
          const state = await service.inspect("fleet_project"); ensure(state?.phase === "running");
          const response = await fetch(`http://127.0.0.1:${server.port}/v1/clank/apps/fleet_project/healthz`, { signal: AbortSignal.timeout(2500), redirect: "error", headers: {
            "x-clank-project-id": "fleet_project", "x-clank-runtime-protocol": "clank-runtime/1", "x-clank-runtime-generation": String(state.generation), "x-clank-runtime-ingress": config.ingressToken,
          } });
          ensure(response.status === 200); const reader = response.body!.getReader(); let text = "", bytes = 0;
          try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; ensure(bytes <= 2048); text += new TextDecoder().decode(part.value); } }
          finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          return JSON.parse(text);
        }
        if (method === "stale-fence") {
          const state = await service.inspect("fleet_project"); ensure(lastRequest && state.fence > 1);
          try { await service.reconcile({ ...lastRequest, operation: { ...lastRequest.operation, id: "stale_fleet_operation", fence: state.fence - 1 }, signal: new AbortController().signal }); }
          catch (error) { return /fence is stale/.test(String((error as Error).message)); }
          return false;
        }
        throw new Error("Unsupported provider IPC.");
      };
      return { port: server.port };
    }
    const credentials = runner.fileDeploymentNodeCredentials(path.join(config.root, `credentials-${config.nodeId}.json`));
    const client = runner.createDeploymentCoordinatorClient({ baseUrl: `http://127.0.0.1:${config.coordinatorPort}`, timeoutMs: 1000, runtimeTimeoutMs: Math.max(100, Math.floor(config.scenario.transportDelayMs / 2)), maxArtifactBytes: 1024 * 1024, maxRuntimeBytes: 2 * 1024 * 1024 });
    const bridge = provider.createHttpDeploymentProvider({ baseUrl: `http://127.0.0.1:${config.providerPort}`, token: config.providerToken, retries: 0, timeoutMs: 15000 });
    let pause = false, pausedClaim: any = null, lastClaim: any, transportTimeouts = 0;
    const agent = await runner.openDeploymentAgent({ client, node: { id: config.nodeId, region: "local", endpoint: `http://127.0.0.1:${config.providerPort}`, capacity: 2, labels: { provider: "http", isolation: "docker", fleetNode: config.nodeId } }, credentials,
      registrationToken: config.registrationToken, concurrency: 1, claimLimit: 1, pollIntervalMs: 50, heartbeatIntervalMs: 250, shutdownTimeoutMs: 1000,
      onError(error) { if ((error as any).code === "COORDINATOR_TIMEOUT") transportTimeouts++; emit("failed"); },
      async execute(operation, context) {
        lastClaim = operation; emit("claimed", operation);
        if (pause && operation.projectId === "fleet_project") {
          pausedClaim ??= operation;
          while (pause && !context.signal.aborted) await sleep(25);
        }
        if (context.signal.aborted) throw new Error("Lost fleet lease.");
        const result = await provider.executeDeploymentProvider(bridge, operation, context); emit("executed", operation); return result;
      },
    });
    close = async () => { pause = false; await agent.close(); await agent.done; };
    dispatch = async (method, input) => {
      if (method === "pause") { ensure(typeof input === "boolean"); pause = input; if (pause) pausedClaim = null; return true; }
      if (method === "inspect") return { pausedClaim: pausedClaim ? { fence: pausedClaim.fence, leaseExpiresAt: pausedClaim.leaseExpiresAt } : null, transportTimeouts };
      if (method === "stale") {
        const claim = pausedClaim ?? lastClaim, token = await credentials.load(config.nodeId); ensure(claim && token);
        const completed = await client.complete(config.nodeId, token, claim);
        let refused = false; try { await client.artifact(config.nodeId, token, claim); } catch { refused = true; }
        return completed === false && refused;
      }
      if (method === "revoked") {
        const old = await runner.fileDeploymentNodeCredentials(path.join(config.root, `credentials-${input}.json`)).load(input); ensure(old);
        let refused = 0;
        for (const action of [() => client.authenticate(input, old!), () => client.claim(input, old!), () => client.observe(input, old!, { projectId: "fleet_project", generation: 1, releaseId: "fleet_release", state: "running" })])
          try { await action(); } catch (error) { if ((error as any).status === 401) refused++; }
        return refused === 3;
      }
      throw new Error("Unsupported agent IPC.");
    };
    return {};
  };
  proc.on("message", (message: any) => {
    void (async () => {
      if (!Number.isSafeInteger(message?.id) || typeof message.method !== "string" || JSON.stringify(message).length > 65536) throw new Error("Invalid fleet IPC.");
      if (message.method === "initialize") { ensure(!configuration); return initialize(message.input); }
      if (message.method === "close") { await shutdown(); return null; }
      ensure(dispatch && !closing); return dispatch(message.method, message.input);
    })().then(value => {
      if (proc.connected) proc.send({ id: message.id, value }, () => { if (message.method === "close") proc.exit(0); });
    }, () => { send({ id: message?.id, failed: true }); });
  });
  for (const event of ["disconnect", "SIGTERM", "SIGINT"]) proc.once(event, () => {
    const timer = setTimeout(() => proc.exit(1), 30000); timer.unref(); void shutdown().then(() => proc.exit(0), () => proc.exit(1));
  });
}
if (proc?.argv?.[2] === "--internal-fleet-worker" && typeof proc.send === "function") void fleetWorker().catch(() => proc.exit(1));
