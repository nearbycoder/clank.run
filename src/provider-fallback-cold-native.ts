/** Exact-role cleanup for an authenticated cold fallback STOPPED selection. */
type DockerResult = { code: number | null; stdout: string; stderr: string };
type Docker = (arguments_: readonly string[], options?: { allowFailure?: boolean }) => Promise<DockerResult>;
type ColdRole = { role: "web" | "worker" | "scheduler"; instance: number; containerId: string; configurationSha256: string };
type ColdProcessRole = ColdRole & { pid: number; birth: string; cgroup: string };
type ColdPath = { path: string; dev: number; ino: number; uid: number };
type ColdRunning = { protocol: string; owner: string; projectId: string; releaseId: string; generation: number; capsuleSha256: string; daemonId: string; imageId: string; policySha256: string; roles: ColdProcessRole[]; paths: ColdPath[] };
type ColdEvidence = { protocol: string; owner: string; projectId: string; releaseId: string; generation: number; capsuleSha256: string; daemonId: string; imageId: string; policySha256: string; roles: ColdRole[]; paths: ColdPath[] };
type ColdRecord = { projectId: string; generation: number; identity: { releaseId: string }; running?: ColdRunning };

const ID = /^[a-f0-9]{64}$/u;
const MAX_CONTAINERS = 1000;
const MAX_CONTAINER_BYTES = 64 * 1024 * 1024;
const MAX_PROCESSES = 8192;
const MAX_NATIVE_BYTES = 64 * 1024 * 1024;
const decodeMountPath = (value: string) => value.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));

/**
 * Stop and remove only the authenticated role CIDs. Success means exact-CID
 * absence, no process/cgroup tied to those IDs, and no project bind mount was
 * observed anywhere in Docker or in an accessible host process mount table.
 * Any uncertainty throws before callers may continue ordinary startup.
 */
export async function cleanupColdFallbackRoles(input: {
  readonly evidence: ColdEvidence;
  readonly record: ColdRecord;
  readonly owner: string;
  readonly root: string;
  readonly docker: Docker;
  check(): void;
  readonly stopTimeoutSeconds: number;
  readonly nativeFs: any;
  readonly path: any;
}): Promise<void> {
  const { evidence, record, owner, root, docker, check, nativeFs: fs, path } = input;
  const fail = (message: string): never => { throw new Error(message); };
  const roleRows = evidence.roles;
  if (!Array.isArray(roleRows) || !roleRows.length || roleRows.length > 34 || new Set(roleRows.map(row => row?.containerId)).size !== roleRows.length
    || roleRows.some(row => !row || !["web", "worker", "scheduler"].includes(row.role) || !Number.isSafeInteger(row.instance) || row.instance < 0 || row.instance > 32
      || typeof row.containerId !== "string" || !ID.test(row.containerId) || typeof row.configurationSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.configurationSha256)))
    fail("Cold fallback authenticated role roster is invalid.");
  const ids = roleRows.map(row => row.containerId), expected = new Set(ids);
  const running = record.running;
  let processes = new Map<string, { pid: number; birth: string; cgroup: string }>();
  if (running !== undefined) {
    const sameRoster = (rows: ColdRole[]) => JSON.stringify(rows.map(row => [row.role, row.instance, row.containerId, row.configurationSha256]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    if (!running || running.protocol !== "clank-provider-fallback-roles/1" || running.owner !== evidence.owner || running.projectId !== evidence.projectId
      || running.releaseId !== evidence.releaseId || running.generation !== evidence.generation || running.capsuleSha256 !== evidence.capsuleSha256
      || running.daemonId !== evidence.daemonId || running.imageId !== evidence.imageId || running.policySha256 !== evidence.policySha256
      || !Array.isArray(running.roles) || sameRoster(running.roles) !== sameRoster(roleRows) || JSON.stringify(running.paths) !== JSON.stringify(evidence.paths))
      fail("Cold fallback signed running evidence differs from its launch intent.");
    for (const role of running.roles) {
      if (!Number.isSafeInteger(role.pid) || role.pid < 1 || !/^[1-9][0-9]{0,19}$/u.test(String(role.birth)) || typeof role.cgroup !== "string"
        || !role.cgroup.startsWith("/sys/fs/cgroup/") || !["/docker/" + role.containerId, "/docker-" + role.containerId + ".scope"].some(suffix => role.cgroup.endsWith(suffix)))
        fail("Cold fallback signed process/cgroup roster is invalid.");
      processes.set(role.containerId, { pid: role.pid, birth: String(role.birth), cgroup: role.cgroup });
    }
  }
  const projectRoot = path.join(root, "projects", record.projectId), dataPath = path.join(projectRoot, "data");
  const releasePath = path.join(projectRoot, "generations", `g${record.generation}-${record.identity.releaseId}`);
  if (!Array.isArray(evidence.paths) || evidence.paths.length !== 2) fail("Cold fallback project path roster is invalid.");
  const paths = new Map<string, any>();
  for (const row of evidence.paths) {
    if (!row || typeof row.path !== "string" || !Number.isSafeInteger(row.dev) || !Number.isSafeInteger(row.ino) || !Number.isSafeInteger(row.uid)
      || path.resolve(row.path) !== row.path || paths.has(row.path) || fs.realpathSync(row.path) !== row.path)
      fail("Cold fallback project path identity is invalid.");
    const stat = fs.lstatSync(row.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== row.dev || stat.ino !== row.ino || stat.uid !== row.uid || (stat.mode & 0o022) !== 0)
      fail("Cold fallback project path identity changed.");
    paths.set(row.path, row);
  }
  if (!paths.has(dataPath) || !paths.has(releasePath) || paths.size !== 2) fail("Cold fallback paths do not match the exact project data and release.");
  const overlapsProjectPath = (candidate: string) => {
    if (!path.isAbsolute(candidate)) return false;
    const canonical = path.resolve(candidate);
    return [...paths.keys()].some(projectPath => canonical === projectPath || canonical.startsWith(projectPath + path.sep));
  };
  const command = async (args: string[], allowFailure = false) => {
    check(); const result = await docker(args, { allowFailure }); check(); return result;
  };
  const daemonId = async () => {
    const result = await command(["info", "--format", "{{json .ID}}"]);
    const value = JSON.parse(result.stdout);
    if (value !== evidence.daemonId) fail("Cold fallback Docker daemon identity changed.");
  };
  const inspect = async (cid: string) => {
    const result = await command(["container", "inspect", cid], true);
    if (result.code !== 0) {
      if (!/no such (?:object|container)|not found/iu.test(result.stderr)) fail("Cold fallback exact role inspect failed without proving absence.");
      return undefined;
    }
    const rows = JSON.parse(result.stdout);
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.Id !== cid) fail("Cold fallback exact role inspection is ambiguous.");
    return rows[0];
  };
  const inventory = async () => {
    const result = await command(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"]);
    const ids = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/u) : [];
    if (ids.length > MAX_CONTAINERS || new Set(ids).size !== ids.length || ids.some(cid => !ID.test(cid))) fail("Cold fallback native container inventory exceeds its bound.");
    return ids;
  };
  let containerBytes = 0;
  const validateMountsOutsideRoster = async (allIds: string[]) => {
    for (const cid of allIds) {
      if (expected.has(cid)) continue;
      const row = await inspect(cid);
      if (!row) fail("Cold fallback Docker inventory changed during inspection.");
      containerBytes += Buffer.byteLength(JSON.stringify(row));
      if (containerBytes > MAX_CONTAINER_BYTES || !Array.isArray(row.Mounts)) fail("Cold fallback Docker mount inventory exceeds its bound.");
      for (const mount of row.Mounts) if (mount.Type === "bind" && typeof mount.Source === "string") {
        const source = fs.realpathSync(mount.Source);
        if (overlapsProjectPath(source)) fail("Another Docker container still mounts the cold fallback project paths.");
      }
    }
  };
  const readBounded = (filename: string, limit: number) => {
    // procfs/cgroupfs expose kernel pseudo-files that reject O_NOFOLLOW on
    // some supported kernels; all paths here are generated from bounded PID
    // names or authenticated cgroup paths rather than caller-controlled text.
    const fd = fs.openSync(filename, fs.constants.O_RDONLY);
    try {
      const bytes = Buffer.alloc(limit + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (count > limit) fail("Cold fallback host proof exceeds its read bound.");
      return bytes.subarray(0, count).toString();
    } finally { fs.closeSync(fd); }
  };
  const statBirth = (pid: number) => {
    const text = readBounded(`/proc/${pid}/stat`, 65536), end = text.lastIndexOf(") ");
    if (end < 0) fail("Cold fallback process stat is malformed.");
    return text.slice(end + 2).trim().split(/\s+/u)[19];
  };
  const cgroupMatches = (text: string, cid: string) => text.split("\n").some(row => {
    const value = row.slice(row.indexOf(":") + 1);
    return value.endsWith("/docker/" + cid) || value.endsWith("/docker-" + cid + ".scope");
  });
  const cgroupDirectories = () => {
    const rootPath = "/sys/fs/cgroup", found: string[] = [], pending: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];
    let visited = 0;
    while (pending.length) {
      const current = pending.pop()!;
      if (current.depth > 24 || ++visited > 65_536) fail("Cold fallback cgroup inventory exceeds its bound.");
      let entries: any[];
      try { entries = fs.readdirSync(current.path, { withFileTypes: true }); }
      catch (error) { if ((error as { code?: string }).code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = path.join(current.path, entry.name);
        if (ids.some(cid => entry.name === cid || entry.name === "docker-" + cid + ".scope")) found.push(child);
        pending.push({ path: child, depth: current.depth + 1 });
      }
    }
    return found;
  };
  const inspectHostProcessesAndMounts = () => {
    const names = fs.readdirSync("/proc").filter((name: string) => /^[1-9][0-9]*$/u.test(name));
    if (names.length > MAX_PROCESSES) fail("Cold fallback process inventory exceeds its bound.");
    let bytesRead = 0;
    for (const name of names) {
      check(); const pid = Number(name), base = "/proc/" + name;
      let groups: string;
      try { groups = readBounded(base + "/cgroup", 16 * 1024); }
      catch (error) { if ((error as { code?: string }).code === "ENOENT") continue; throw error; }
      bytesRead += Buffer.byteLength(groups);
      for (const cid of ids) if (cgroupMatches(groups, cid)) fail("Cold fallback role process remains in its Docker cgroup.");
      let mountInfo: string;
      try { mountInfo = readBounded(base + "/mountinfo", 256 * 1024); }
      catch (error) { if ((error as { code?: string }).code === "ENOENT") continue; throw error; }
      bytesRead += Buffer.byteLength(mountInfo);
      if (bytesRead > MAX_NATIVE_BYTES) fail("Cold fallback host process/mount scan exceeds its aggregate bound.");
      for (const line of mountInfo.split("\n")) {
        if (!line) continue;
        const fields = line.split(" "), separator = fields.indexOf("-");
        if (separator < 6 || fields.length < separator + 3) fail("Cold fallback mount table is malformed.");
        const candidates = [fields[3], fields[4], fields[separator + 2]].map(decodeMountPath);
        if (candidates.some(overlapsProjectPath)) fail("A host process still has a project data or release mount.");
      }
      const known = [...processes.values()].find(value => value.pid === pid);
      if (known) {
        try { if (statBirth(pid) === known.birth) fail("Cold fallback original native process remains alive."); }
        catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
      }
    }
    const directories = cgroupDirectories();
    if (directories.length) fail("Cold fallback Docker cgroup directories remain after exact cleanup.");
    for (const process of processes.values()) {
      try { if (statBirth(process.pid) === process.birth) fail("Cold fallback original native process remains alive."); }
      catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
      try {
        const members = readBounded(path.join(process.cgroup, "cgroup.procs"), 64 * 1024).trim();
        if (members) fail("Cold fallback original cgroup still has processes.");
      } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
    }
  };

  check(); await daemonId();
  const imageResult = await command(["image", "inspect", evidence.imageId, "--format", "{{json .Id}}"]);
  if (JSON.parse(imageResult.stdout) !== evidence.imageId) fail("Cold fallback image identity changed.");
  const allBefore = await inventory();
  await validateMountsOutsideRoster(allBefore);
  const roleById = new Map(roleRows.map(row => [row.containerId, row]));
  const present = new Map<string, any>();
  for (const cid of ids) {
    const row = await inspect(cid);
    if (!row) {
      if (allBefore.includes(cid)) fail("Cold fallback exact role disappeared during its initial inventory.");
      continue;
    }
    const role = roleById.get(cid), labels = row.Config?.Labels, host = row.HostConfig;
    if (!role) throw new Error("Cold fallback exact role identity differs from its signed intent.");
    if (row.Image !== evidence.imageId || !host || !row.Config || !Array.isArray(row.Mounts)
      || labels?.["run.clank.managed"] !== "provider-runtime" || labels["run.clank.owner"] !== owner || labels["run.clank.project"] !== record.projectId
      || labels["run.clank.release"] !== record.identity.releaseId || labels["run.clank.generation"] !== String(record.generation)
      || labels["run.clank.role"] !== role.role || labels["run.clank.instance"] !== String(role.instance))
      fail("Cold fallback exact role identity differs from its signed intent.");
    const crypto = (globalThis as any).process.getBuiltinModule("node:crypto");
    const configurationSha256 = crypto.createHash("sha256").update(JSON.stringify({ Image: row.Image, Config: row.Config, HostConfig: { ...host, OomKillDisable: false },
      AppArmorProfile: "docker-default", Mounts: [...row.Mounts].sort((left: any, right: any) => left.Destination < right.Destination ? -1 : left.Destination > right.Destination ? 1 : 0) })).digest("hex");
    if (configurationSha256 !== role.configurationSha256 || row.Mounts.length !== 2
      || !row.Mounts.some((mount: any) => mount.Type === "bind" && mount.Source === releasePath && mount.Destination === "/app" && mount.RW === false)
      || !row.Mounts.some((mount: any) => mount.Type === "bind" && mount.Source === dataPath && mount.Destination === "/data" && mount.RW === true))
      fail("Cold fallback exact role configuration or project mount differs.");
    if (!row.State || typeof row.State.Running !== "boolean" || !["running", "created", "exited"].includes(row.State.Status) || row.RestartCount !== 0)
      fail("Cold fallback exact role state is ambiguous.");
    const process = processes.get(cid);
    if (row.State.Running) {
      if (!process) throw new Error("Cold fallback running role lacks its original signed process identity.");
      if (row.State.Pid !== process.pid || statBirth(process.pid) !== process.birth) fail("Cold fallback running role lacks its original signed process identity.");
      const groups = readBounded(`/proc/${process.pid}/cgroup`, 16 * 1024);
      if (!cgroupMatches(groups, cid) || !groups.split("\n").some(line => line.endsWith(process.cgroup.slice("/sys/fs/cgroup".length))))
        fail("Cold fallback running role cgroup differs from its signed process identity.");
    } else if (row.State.Status === "created") {
      if (row.State.Pid !== 0 || row.State.StartedAt !== "0001-01-01T00:00:00Z" || process) fail("Cold fallback never-started role state differs from its intent.");
    } else if (!process) fail("Cold fallback exited role lacks authenticated prior process evidence.");
    present.set(cid, row);
  }
  if (present.size && [...present.keys()].some(cid => !expected.has(cid))) fail("Cold fallback inspection returned an unauthenticated role.");
  const runningIds = [...present].filter(([, row]) => row.State.Running).map(([cid]) => cid);
  if (runningIds.length) {
    const stopped = await command(["container", "stop", "--time", String(input.stopTimeoutSeconds), ...runningIds], true);
    void stopped;
    for (const cid of runningIds) {
      const row = await inspect(cid);
      if (!row || row.State?.Running !== false || !["exited", "created"].includes(row.State?.Status)) fail("Cold fallback exact role did not stop cleanly.");
    }
  }
  const removeIds: string[] = [];
  for (const cid of ids) {
    if (!present.has(cid)) continue;
    const row = await inspect(cid);
    if (!row || row.State?.Running !== false || !["exited", "created"].includes(row.State?.Status)) fail("Cold fallback exact role changed before removal.");
    removeIds.push(cid);
  }
  if (removeIds.length) await command(["container", "rm", ...removeIds]);

  const proveAbsence = async () => {
    await daemonId();
    const allAfter = await inventory();
    await validateMountsOutsideRoster(allAfter);
    for (const cid of ids) {
      const row = await inspect(cid);
      if (row || allAfter.includes(cid)) fail("Cold fallback exact role CID remains after cleanup.");
      const exact = await command(["container", "ls", "--all", "--no-trunc", "--filter", "id=" + cid, "--format", "{{.ID}}"]);
      if (exact.stdout.trim()) fail("Cold fallback exact role is still in Docker inventory.");
    }
    inspectHostProcessesAndMounts();
  };
  await proveAbsence();
  await new Promise(resolve => setTimeout(resolve, 100));
  check(); await proveAbsence();
}
