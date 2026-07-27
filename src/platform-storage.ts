export interface StorageDiagnosticProject {
  id: string;
  name: string;
  slug: string;
  databasePath: string | null;
}

export interface StorageDiagnosticRetention {
  releasesPerProject: number;
  releaseStorageBytesPerProject: number;
  backupEnabled: boolean;
  backupIntervalMs: number | null;
  backupMaxCount: number;
  backupMaxAgeMs: number;
}

interface StorageStats {
  size: number;
  blocks?: number;
  dev?: number;
  ino?: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface Footprint {
  apparentBytes: number;
  allocatedBytes: number;
  files: number;
  directories: number;
  symlinks: number;
  otherEntries: number;
}

interface ProjectFootprints {
  id: string;
  name: string;
  slug: string;
  registered: boolean;
  databasePath: string | null;
  total: Footprint;
  database: Footprint;
  releases: Footprint;
  migrationSnapshots: Footprint;
  recoveryBackups: Footprint;
  other: Footprint;
  sqlite: {
    mainBytes: number;
    walBytes: number;
    sharedMemoryBytes: number;
    otherBytes: number;
  };
}

interface ClassifiedFootprint {
  footprint: Footprint;
  sqliteRole?: "mainBytes" | "walBytes" | "sharedMemoryBytes" | "otherBytes";
  project?: ProjectFootprints;
}

const DEFAULT_ENTRY_LIMIT = 100_000;
const DEFAULT_DEPTH_LIMIT = 24;

/** Samples a platform data directory without following links or returning private host paths. */
export async function inspectPlatformStorage(
  root: string,
  projects: readonly StorageDiagnosticProject[],
  retention: StorageDiagnosticRetention,
  options: { entryLimit?: number; depthLimit?: number } = {},
): Promise<Record<string, unknown>> {
  const fsName = "node:fs/promises";
  const pathName = "node:path";
  const fs = await import(fsName) as unknown as {
    lstat(path: string): Promise<StorageStats>;
    readdir(path: string, options: { withFileTypes: true }): Promise<Array<{ name: string }>>;
    statfs?(path: string): Promise<{
      bsize: number;
      blocks: number;
      bfree: number;
      bavail: number;
    }>;
  };
  const path = await import(pathName) as unknown as { join(...segments: string[]): string };
  const entryLimit = boundedInteger(options.entryLimit ?? DEFAULT_ENTRY_LIMIT, 1, 1_000_000);
  const depthLimit = boundedInteger(options.depthLimit ?? DEFAULT_DEPTH_LIMIT, 1, 100);
  const projectMap = new Map<string, ProjectFootprints>(
    projects.map((project) => [project.id, newProjectFootprints(project, true)]),
  );
  const rootOther = emptyFootprint();
  const controlDatabase = emptyFootprint();
  const controlSQLite = {
    mainBytes: 0,
    walBytes: 0,
    sharedMemoryBytes: 0,
    otherBytes: 0,
  };
  const accounted = emptyFootprint();
  const seenFiles = new Set<string>();
  const stack: Array<{ absolute: string; segments: string[] }> = [{ absolute: root, segments: [] }];
  let scannedEntries = 0;
  let errorCount = 0;
  let truncated = false;
  let allocatedBlocksAvailable = true;

  const projectFor = (id: string): ProjectFootprints => {
    let project = projectMap.get(id);
    if (!project) {
      project = newProjectFootprints({
        id,
        name: "Unregistered project data",
        slug: id,
        databasePath: null,
      }, false);
      projectMap.set(id, project);
    }
    return project;
  };

  const classify = (segments: string[]): ClassifiedFootprint => {
    if (segments.length === 1 && segments[0]!.startsWith("control.sqlite")) {
      const name = segments[0]!;
      return {
        footprint: controlDatabase,
        sqliteRole: name === "control.sqlite"
          ? "mainBytes"
          : name === "control.sqlite-wal"
            ? "walBytes"
            : name === "control.sqlite-shm"
              ? "sharedMemoryBytes"
              : "otherBytes",
      };
    }
    if (segments[0] !== "projects" || segments.length < 2) return { footprint: rootOther };
    const project = projectFor(segments[1]!);
    const section = segments[2];
    if (section === "data") {
      const relative = segments.slice(3).join("/");
      const databasePath = project.databasePath;
      return {
        footprint: project.database,
        project,
        sqliteRole: databasePath && relative === databasePath
          ? "mainBytes"
          : databasePath && relative === `${databasePath}-wal`
            ? "walBytes"
            : databasePath && relative === `${databasePath}-shm`
              ? "sharedMemoryBytes"
              : "otherBytes",
      };
    }
    if (section === "releases") return { footprint: project.releases, project };
    if (section === "backups") return { footprint: project.migrationSnapshots, project };
    if (section === "recovery") return { footprint: project.recoveryBackups, project };
    return { footprint: project.other, project };
  };

  while (stack.length && scannedEntries < entryLimit) {
    const current = stack.pop()!;
    let stats: StorageStats;
    try {
      stats = await fs.lstat(current.absolute);
    } catch {
      errorCount++;
      continue;
    }
    scannedEntries++;
    const classified = classify(current.segments);
    const inode = regularFileInode(stats);
    const includeFileBytes = !inode || !seenFiles.has(inode);
    if (inode) seenFiles.add(inode);
    const size = storageSize(stats, includeFileBytes);
    if (stats.blocks === undefined || !Number.isSafeInteger(stats.blocks)) {
      allocatedBlocksAvailable = false;
    }
    addStats(accounted, stats, size);
    addStats(classified.footprint, stats, size);
    if (classified.project) addStats(classified.project.total, stats, size);
    if (classified.sqliteRole && stats.isFile()) {
      if (classified.project) classified.project.sqlite[classified.sqliteRole] += size.allocatedBytes;
      else controlSQLite[classified.sqliteRole] += size.allocatedBytes;
    }
    if (!stats.isDirectory()) continue;
    if (current.segments.length >= depthLimit) {
      truncated = true;
      continue;
    }
    let entries: Array<{ name: string }>;
    try {
      entries = await fs.readdir(current.absolute, { withFileTypes: true });
    } catch {
      errorCount++;
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (let index = entries.length - 1; index >= 0; index--) {
      if (scannedEntries + stack.length >= entryLimit) {
        truncated = true;
        break;
      }
      const entry = entries[index]!;
      stack.push({
        absolute: path.join(current.absolute, entry.name),
        segments: [...current.segments, entry.name],
      });
    }
  }
  if (stack.length) truncated = true;

  const filesystem = await filesystemFootprint(fs, root);
  const projectResults = [...projectMap.values()]
    .filter((project) => project.total.files > 0
      || project.total.directories > 0
      || project.total.symlinks > 0
      || project.total.otherEntries > 0)
    .sort((left, right) =>
      right.total.allocatedBytes - left.total.allocatedBytes || left.slug.localeCompare(right.slug))
    .map(publicProjectFootprints);
  const totals = {
    controlDatabaseBytes: controlDatabase.allocatedBytes,
    projectDatabaseBytes: sumProjects(projectResults, "database"),
    releaseBytes: sumProjects(projectResults, "releases"),
    migrationSnapshotBytes: sumProjects(projectResults, "migrationSnapshots"),
    recoveryBackupBytes: sumProjects(projectResults, "recoveryBackups"),
    projectOtherBytes: sumProjects(projectResults, "other"),
    rootOtherBytes: rootOther.allocatedBytes,
    accountedAllocatedBytes: accounted.allocatedBytes,
    accountedApparentBytes: accounted.apparentBytes,
    unattributedFilesystemBytes: filesystem.usedBytes === null
      ? null
      : Math.max(0, filesystem.usedBytes - accounted.allocatedBytes),
  };
  return {
    sampledAt: Date.now(),
    filesystem,
    scan: {
      complete: !truncated && errorCount === 0,
      truncated,
      errorCount,
      entries: scannedEntries,
      entryLimit,
      depthLimit,
      allocationSource: allocatedBlocksAvailable ? "filesystem_blocks" : "apparent_size_fallback",
    },
    controlDatabase: {
      ...copyFootprint(controlDatabase),
      sqlite: controlSQLite,
    },
    projects: projectResults,
    rootOther: copyFootprint(rootOther),
    totals: {
      ...totals,
      retainedCopyBytes: totals.releaseBytes
        + totals.migrationSnapshotBytes
        + totals.recoveryBackupBytes,
    },
    retention: {
      ...retention,
    },
  };
}

function newProjectFootprints(
  project: StorageDiagnosticProject,
  registered: boolean,
): ProjectFootprints {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    registered,
    databasePath: normalizedRelativePath(project.databasePath),
    total: emptyFootprint(),
    database: emptyFootprint(),
    releases: emptyFootprint(),
    migrationSnapshots: emptyFootprint(),
    recoveryBackups: emptyFootprint(),
    other: emptyFootprint(),
    sqlite: {
      mainBytes: 0,
      walBytes: 0,
      sharedMemoryBytes: 0,
      otherBytes: 0,
    },
  };
}

function publicProjectFootprints(project: ProjectFootprints): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    registered: project.registered,
    total: copyFootprint(project.total),
    database: {
      ...copyFootprint(project.database),
      sqlite: { ...project.sqlite },
    },
    releases: copyFootprint(project.releases),
    migrationSnapshots: copyFootprint(project.migrationSnapshots),
    recoveryBackups: copyFootprint(project.recoveryBackups),
    other: copyFootprint(project.other),
  };
}

function emptyFootprint(): Footprint {
  return {
    apparentBytes: 0,
    allocatedBytes: 0,
    files: 0,
    directories: 0,
    symlinks: 0,
    otherEntries: 0,
  };
}

function copyFootprint(footprint: Footprint): Footprint {
  return { ...footprint };
}

function addStats(
  footprint: Footprint,
  stats: StorageStats,
  size: { apparentBytes: number; allocatedBytes: number },
): void {
  footprint.apparentBytes += size.apparentBytes;
  footprint.allocatedBytes += size.allocatedBytes;
  if (stats.isSymbolicLink()) footprint.symlinks++;
  else if (stats.isFile()) footprint.files++;
  else if (stats.isDirectory()) footprint.directories++;
  else footprint.otherEntries++;
}

function storageSize(
  stats: StorageStats,
  includeFileBytes: boolean,
): { apparentBytes: number; allocatedBytes: number } {
  if (stats.isFile() && !includeFileBytes) return { apparentBytes: 0, allocatedBytes: 0 };
  const apparentBytes = safeNonNegativeInteger(stats.size);
  const blocks = safeNonNegativeInteger(stats.blocks);
  return {
    apparentBytes,
    allocatedBytes: blocks === 0 && stats.blocks !== 0
      ? apparentBytes
      : safeProduct(blocks, 512),
  };
}

function regularFileInode(stats: StorageStats): string | null {
  if (!stats.isFile()) return null;
  const device = safeNonNegativeInteger(stats.dev);
  const inode = safeNonNegativeInteger(stats.ino);
  return device || inode ? `${device}:${inode}` : null;
}

async function filesystemFootprint(
  fs: { statfs?(path: string): Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }> },
  root: string,
): Promise<Record<string, unknown>> {
  if (typeof fs.statfs !== "function") {
    return {
      available: false,
      capacityBytes: null,
      usedBytes: null,
      freeBytes: null,
      availableBytes: null,
      utilization: null,
    };
  }
  try {
    const stats = await fs.statfs(root);
    const blockSize = safeNonNegativeInteger(stats.bsize);
    const capacityBytes = safeProduct(safeNonNegativeInteger(stats.blocks), blockSize);
    const freeBytes = safeProduct(safeNonNegativeInteger(stats.bfree), blockSize);
    const availableBytes = safeProduct(safeNonNegativeInteger(stats.bavail), blockSize);
    const usedBytes = Math.max(0, capacityBytes - freeBytes);
    return {
      available: capacityBytes > 0,
      capacityBytes,
      usedBytes,
      freeBytes,
      availableBytes,
      utilization: capacityBytes ? usedBytes / capacityBytes : null,
    };
  } catch {
    return {
      available: false,
      capacityBytes: null,
      usedBytes: null,
      freeBytes: null,
      availableBytes: null,
      utilization: null,
    };
  }
}

function sumProjects(
  projects: Array<Record<string, unknown>>,
  category: "database" | "releases" | "migrationSnapshots" | "recoveryBackups" | "other",
): number {
  return projects.reduce((total, project) => {
    const footprint = project[category] as Footprint;
    return total + footprint.allocatedBytes;
  }, 0);
}

function normalizedRelativePath(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/u, "").replace(/\/+/gu, "/");
  return normalized && !normalized.startsWith("/") && !normalized.split("/").includes("..")
    ? normalized
    : null;
}

function safeNonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function safeProduct(left: number, right: number): number {
  const value = left * right;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Storage diagnostic limit must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}
