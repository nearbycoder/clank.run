/** Linux filesystem capabilities for internal SQLite workers. No application path is resolved after it is pinned. */
export interface PinnedSQLiteDirectory {
  readonly path: string;
  readonly fd: number;
  readonly anchor: string;
  close(): Promise<void>;
}

export async function pinSQLiteDirectory(input: string, create = false): Promise<PinnedSQLiteDirectory> {
  const fsName = "node:fs/promises", constantsName = "node:fs", pathName = "node:path";
  const [fs, { constants }, path] = await Promise.all([import(fsName), import(constantsName), import(pathName)]);
  const resolved = path.resolve(input);
  if (resolved.includes("\0")) throw new TypeError("SQLite directory contains a null byte.");
  let handle = await fs.open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of resolved.split("/").filter(Boolean)) {
      const child = `/proc/self/fd/${handle.fd}/${component}`;
      if (create) {
        try { await fs.mkdir(child, { mode: 0o700 }); }
        catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; }
      }
      const next = await fs.open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close();
      handle = next;
    }
    return { path: resolved, fd: handle.fd, anchor: `/proc/self/fd/${handle.fd}`, close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}

interface Mount { path: string; writable: boolean; create?: boolean; optional?: boolean }
export interface SQLiteSandbox {
  executable: string;
  arguments: string[];
  descriptors: number[];
  moduleUrl: string;
  argumentsValue: readonly unknown[];
  close(): Promise<void>;
}

/** Only fixed worker operations may request filesystem capabilities. */
export async function prepareSQLiteSandbox(module: string, operation: string, values: readonly unknown[], childArguments: string[], pinned: readonly PinnedSQLiteDirectory[] = []): Promise<SQLiteSandbox> {
  const pathName = "node:path", fsName = "node:fs/promises", urlName = "node:url";
  const [path, fs, url] = await Promise.all([import(pathName), import(fsName), import(urlName)]);
  const process = (globalThis as any).process;
  const mounts: Mount[] = [];
  const args: any[] = [...structuredClone(values)];
  const file = (value: unknown, writable: boolean, create = false): string => {
    if (value === ":memory:") return value;
    if (typeof value !== "string" || !value || value.includes("\0")) throw new TypeError("Invalid SQLite task file path.");
    const result = path.resolve(value);
    // SQLite read-only connections can still need to create WAL shared-memory
    // sidecars. The connection enforces read-only SQL; the filesystem grant
    // deliberately includes its tenant directory for locking/recovery metadata.
    mounts.push({ path: path.dirname(result), writable: true, create });
    return result;
  };
  if (module === "recovery" && ["replayJournal", "finishReplay"].includes(operation)) args[0] = file(args[0], true);
  else if (module === "migrations" && operation === "planMigrations") args[0] = file(args[0], true, true);
  else if (module === "migrations" && operation === "applyMigrations") {
    args[0].path = file(args[0].path, true, true);
    args[0].directory = path.resolve(args[0].directory);
    mounts.push({ path: args[0].directory, writable: false, optional: true });
  } else if (module === "migrations" && ["stageSQLiteBackup", "stageSQLiteRestore"].includes(operation)) {
    args[0] = file(args[0], false);
    args[1] = file(args[1], true, true);
    args[2] = file(args[2], true, true);
  } else if (module === "jobs" && ["inspectPlatformJobs", "mutatePlatformJob"].includes(operation)) {
    if (args[0].databasePath) args[0].databasePath = file(args[0].databasePath, operation === "mutatePlatformJob");
  } else if (module === "inspection" && operation === "inspectProjectBucketUsage") {
    args[0] = path.resolve(args[0]);
    if (args[1].placement === "local") {
      if (!/^[a-zA-Z0-9_-]+$/.test(args[1].id)) throw new TypeError("Invalid SQLite project identifier.");
      mounts.push({ path: path.join(args[0], args[1].id, "data"), writable: true, optional: true });
    }
  } else if (module === "inspection" && ["sanitizePreviewDatabase", "inspectFixtureManifest", "inspectSQLite", "verifySQLite", "inspectRehearsalDatabase"].includes(operation)) {
    args[0] = file(args[0], operation === "sanitizePreviewDatabase");
  } else throw new TypeError("Unknown SQLite task operation.");

  const descriptors: number[] = [];
  const handles: Array<{ close(): Promise<void> }> = [];
  const sandboxArgs = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--dir", "/usr", "--ro-bind", "/usr/bin/prlimit", "/usr/bin/prlimit",
    "--proc", "/proc", "--dev", "/dev",
    "--size", "67108864", "--tmpfs", "/tmp", "--dir", "/work", "--chdir", "/work"];
  const close = async () => { await Promise.all(handles.map((handle) => handle.close())); };
  try {
    for (const library of ["/usr/lib", "/usr/lib64", "/lib", "/lib64"]) {
      try {
        const info = await fs.lstat(library);
        if (info.isSymbolicLink()) sandboxArgs.push("--symlink", await fs.readlink(library), library);
        else sandboxArgs.push("--ro-bind", library, library);
      } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
    }
    const bindFd = (fd: number, target: string, writable: boolean) => {
      descriptors.push(fd);
      sandboxArgs.push(writable ? "--bind" : "--ro-bind", `/proc/self/fd/${descriptors.length + 2}`, target);
    };
    const node = await fs.open(await fs.realpath(process.execPath), "r");
    handles.push(node); bindFd(node.fd, "/runtime/node", false);
    const framework = await pinSQLiteDirectory(path.dirname(url.fileURLToPath(import.meta.url)));
    handles.push(framework); bindFd(framework.fd, "/runtime/framework", false);
    // Pin all sources before starting bwrap. Merge exact duplicates and mount
    // descendants last so read-only migration directories stay read-only.
    const merged = new Map<string, Mount>();
    for (const mount of mounts) {
      const prior = merged.get(mount.path);
      merged.set(mount.path, { ...mount, writable: mount.writable || !!prior?.writable,
        create: mount.create || prior?.create, optional: mount.optional && (!prior || prior.optional) });
    }
    if (process.env.NODE_V8_COVERAGE) {
      const coverage = path.resolve(process.env.NODE_V8_COVERAGE);
      merged.set(coverage, { path: coverage, writable: true, create: true });
    }
    for (const mount of [...merged.values()].sort((a, b) => a.path.length - b.path.length)) {
      if (["/", "/tmp", "/home", "/var", "/usr", "/etc", "/proc", "/dev"].includes(mount.path)
        || ["/usr/", "/etc/", "/proc/", "/dev/", "/runtime/"].some((prefix) => mount.path.startsWith(prefix))) {
        throw new Error("SQLite files require a dedicated application directory outside system paths.");
      }
      try {
        const existing = pinned.find((directory) => directory.path === mount.path);
        const directory = existing ?? await pinSQLiteDirectory(mount.path, mount.create);
        if (!existing) handles.push(directory);
        bindFd(directory.fd, mount.path, mount.writable);
      } catch (error) { if (!mount.optional || (error as { code?: string }).code !== "ENOENT") throw error; }
    }
    sandboxArgs.push("--", "/usr/bin/prlimit", "--data=268435456:268435456", "--as=1073741824:1073741824",
      "--cpu=10:10", "--core=0:0", "--", "/runtime/node", ...childArguments);
    try {
      await fs.access("/usr/bin/bwrap", 1);
      await fs.access("/usr/bin/prlimit", 1);
    } catch { throw new Error("Isolated SQLite tasks on Linux require bubblewrap (/usr/bin/bwrap) and util-linux (/usr/bin/prlimit)."); }
    return { executable: "/usr/bin/bwrap", arguments: sandboxArgs, descriptors,
      moduleUrl: `file:///runtime/framework/${module === "jobs" ? "platform-jobs" : module === "inspection" ? "sqlite-inspection" : module === "recovery" ? "point-in-time" : module}-worker.js`,
      argumentsValue: args, close };
  } catch (error) { await close(); throw error; }
}
