// Synthetic, in-memory SQLite A/B benchmark. Never opens application databases.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const argumentsMap = new Map(process.argv.slice(2).map((argument) => {
  const match = /^--([a-z]+)=(.+)$/u.exec(argument);
  if (!match) throw new TypeError(`Expected --name=value, received ${argument}`);
  return [match[1], match[2]];
}));
for (const name of argumentsMap.keys()) {
  if (!["baseline", "candidate", "rounds", "iterations", "sizes", "output"].includes(name)) {
    throw new TypeError(`Unknown argument --${name}`);
  }
}
function integer(value, minimum, maximum, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}
const rounds = integer(argumentsMap.get("rounds") ?? 5, 1, 20, "rounds");
const maximumIterations = integer(argumentsMap.get("iterations") ?? 200, 1, 2_000, "iterations");
const sizes = (argumentsMap.get("sizes") ?? "4096,65536,262144")
  .split(",").map((size) => integer(size, 128, 1024 * 1024, "sizes"));
if (sizes.length > 8) throw new RangeError("At most eight payload sizes are supported.");
const paths = {
  baseline: resolve(argumentsMap.get("baseline") ?? "dist"),
  candidate: resolve(argumentsMap.get("candidate") ?? "dist"),
};
const modules = {};
for (const [label, directory] of Object.entries(paths)) {
  modules[label] = await import(pathToFileURL(join(directory, "index.js")).href);
}
const scope = { userId: "synthetic-benchmark-owner" };

async function fixture(api, payloadBytes) {
  const { defineDatabase, defineTable, openSQLite, s } = api;
  const schema = defineDatabase({
    documents: defineTable({ marker: s.string(), counter: s.number(), payload: s.string(), tags: s.record(s.string()) }).owned(),
  });
  const database = await openSQLite(schema, { path: ":memory:", historyRetentionPerDocument: 4 });
  const value = {
    marker: "backend-encoding-benchmark", counter: 0, payload: "x".repeat(payloadBytes),
    tags: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`field_${15 - index}`, `value_${index}`])),
  };
  let lastId = database.transaction((db) => db.table("documents").insert(value), scope);
  return {
    database,
    write(operation, counter) {
      return database.transaction((db) => {
        const table = db.table("documents");
        if (operation === "insert") {
          lastId = table.insert({ ...value, counter });
          return lastId.length;
        }
        const document = operation === "patch"
          ? table.patch(lastId, { counter })
          : table.replace(lastId, { ...value, counter });
        return document.counter;
      }, scope);
    },
    verify(expectedCounter) {
      const current = database.read((db) => db.table("documents").get(lastId), scope);
      const history = database.read((db) => db.table("documents").history(lastId), scope);
      assert.equal(current.counter, expectedCounter);
      assert.equal(current.payload.length, payloadBytes);
      assert.equal(current._ownerId, scope.userId);
      assert.equal(history[0].document.counter, expectedCounter);
      assert.equal(history[0].document.payload, current.payload);
      assert.equal(database.read((db) => db.table("documents").get(lastId), { userId: "other-owner" }), null);
    },
  };
}

async function encodingCounts(api) {
  const work = await fixture(api, 128);
  const stringify = JSON.stringify;
  const counts = {};
  let calls = 0;
  try {
    JSON.stringify = (value, ...options) => {
      if (value?.marker === "backend-encoding-benchmark") calls++;
      return stringify(value, ...options);
    };
    for (const [index, operation] of ["insert", "patch", "replace"].entries()) {
      calls = 0;
      work.write(operation, index + 1);
      counts[operation] = calls;
    }
    work.verify(3);
    return counts;
  } finally {
    JSON.stringify = stringify;
    work.database.close();
  }
}

async function sample(api, operation, payloadBytes, iterations) {
  const work = await fixture(api, payloadBytes);
  const warmup = 10;
  try {
    for (let index = 1; index <= warmup; index++) work.write(operation, index);
    globalThis.gc?.();
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    let checksum = 0;
    for (let index = 1; index <= iterations; index++) checksum += work.write(operation, warmup + index);
    const milliseconds = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    assert.ok(checksum > 0);
    work.verify(warmup + iterations);
    return { milliseconds, operationsPerSecond: iterations / milliseconds * 1000, cpuMilliseconds: (cpu.user + cpu.system) / 1000, checksum };
  } finally {
    work.database.close();
  }
}
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const report = {
  protocol: "clank-backend-write-performance/1",
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, gcExposed: typeof globalThis.gc === "function" },
  paths, rounds,
  workload: "Owned SQLite document insert/patch/replace, canonical JSON plus revision history; independent in-memory database per sample; ten excluded warmup writes; retained history four versions per document; correctness checked after timing.",
  encodingCounts: {},
  results: [],
};
for (const label of ["baseline", "candidate"]) report.encodingCounts[label] = await encodingCounts(modules[label]);
for (const payloadBytes of sizes) {
  // Keep inserted payload data under 16 MiB per sample before SQLite/history overhead.
  const iterations = Math.min(maximumIterations, Math.max(1, Math.floor(16 * 1024 * 1024 / payloadBytes)));
  for (const operation of ["insert", "patch", "replace"]) {
    const samples = { baseline: [], candidate: [] };
    for (let round = 0; round < rounds; round++) {
      for (const label of round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
        samples[label].push(await sample(modules[label], operation, payloadBytes, iterations));
      }
    }
    const baselineMedianMs = median(samples.baseline.map((result) => result.milliseconds));
    const candidateMedianMs = median(samples.candidate.map((result) => result.milliseconds));
    report.results.push({
      operation, payloadBytes, iterations, samples, baselineMedianMs, candidateMedianMs,
      elapsedReductionPercent: (1 - candidateMedianMs / baselineMedianMs) * 100,
    });
  }
}
const output = `${JSON.stringify(report, null, 2)}\n`;
if (argumentsMap.has("output")) await writeFile(resolve(argumentsMap.get("output")), output);
process.stdout.write(output);
