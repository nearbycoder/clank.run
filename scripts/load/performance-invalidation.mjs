// Disposable in-memory SQLite/live-query A/B benchmark. No production endpoints.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { arch, cpus, platform } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const options = new Map(process.argv.slice(2).map((argument) => {
  const match = /^--(baseline|candidate|rounds|iterations|output)=(.+)$/u.exec(argument);
  if (!match) throw new TypeError(`Unknown argument ${argument}; expected --name=value.`);
  return [match[1], match[2]];
}));
function bounded(value, maximum, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new RangeError(`${name} must be from 1 to ${maximum}.`);
  return number;
}
const rounds = bounded(options.get("rounds") ?? 5, 20, "rounds");
const iterations = bounded(options.get("iterations") ?? 100, 500, "iterations");
const paths = { baseline: resolve(options.get("baseline") ?? "dist"), candidate: resolve(options.get("candidate") ?? "dist") };
const modules = {};
for (const [label, directory] of Object.entries(paths)) modules[label] = await import(pathToFileURL(join(directory, "index.js")).href);
const profiles = [
  { name: "single-write-no-readers", subscriptions: 0, cacheEntries: 0, batch: 1, matched: 0 },
  { name: "single-write-cached-readers", subscriptions: 100, cacheEntries: 100, batch: 1, matched: 1 },
  { name: "bulk-write-evicted-readers", subscriptions: 1000, cacheEntries: 32, batch: 64, matched: 16 },
];

async function fixture(api, profile, instrument = false) {
  const { defineBackend, defineDatabase, defineTable, openBackend, openSQLite, s } = api;
  const schema = defineDatabase({ rows: defineTable({ counter: s.number() }) });
  const definition = defineBackend({ schema }).functions(({ query }) => ({
    read: query({ args: { id: s.id("rows") }, handler: ({ db }, { id }) => db.table("rows").get(id).counter }),
  }));
  const database = await openSQLite(schema, { path: ":memory:", historyRetentionPerDocument: 4 });
  let recordReads = 0;
  const observed = instrument ? new Proxy(database, { get(target, key) {
    if (key === "subscribe") return (listener) => target.subscribe((change) => listener({ ...change,
      records: change.records.map((record) => new Proxy(record, { get(record, property) {
        if (property === "table") recordReads++;
        return Reflect.get(record, property);
      } })),
    }));
    return Reflect.get(target, key, target);
  } }) : database;
  const runtime = await openBackend(definition, { database: observed, maxCacheEntries: profile.cacheEntries, diagnostics: true, agent: false });
  const ids = database.transaction((db) => Array.from({ length: profile.subscriptions + profile.batch }, () => db.table("rows").insert({ counter: 0 })));
  const targets = [...ids.slice(0, profile.matched), ...ids.slice(profile.subscriptions, profile.subscriptions + profile.batch - profile.matched)];
  const latest = Array(profile.subscriptions).fill(undefined);
  let notifications = 0;
  const disposers = ids.slice(0, profile.subscriptions).map((id, index) => runtime.subscribe("read", { id }, (value) => { latest[index] = value; notifications++; }));
  recordReads = 0;
  return {
    write(counter) {
      database.transaction((db) => { for (const id of targets) db.table("rows").patch(id, { counter }); });
    },
    verify(counter) {
      assert.equal(notifications, profile.subscriptions + counter * profile.matched);
      assert.ok(latest.every((value, index) => value === (index < profile.matched ? counter : 0)));
      assert.ok(database.read((db) => targets.every((id) => db.table("rows").get(id).counter === counter)));
      assert.equal(runtime.inspectQueries().reduce((sum, query) => sum + query.cachedEntries, 0), Math.min(profile.cacheEntries, profile.subscriptions));
      return { notifications, recordReads };
    },
    close() { for (const dispose of disposers) dispose(); runtime.close(); },
  };
}

async function sample(api, profile) {
  const work = await fixture(api, profile);
  const warmup = 10;
  try {
    for (let counter = 1; counter <= warmup; counter++) work.write(counter);
    globalThis.gc?.();
    const cpu = process.cpuUsage(), started = performance.now();
    for (let counter = warmup + 1; counter <= warmup + iterations; counter++) work.write(counter);
    const milliseconds = performance.now() - started, used = process.cpuUsage(cpu);
    const { notifications } = work.verify(warmup + iterations);
    return { milliseconds, cpuMilliseconds: (used.user + used.system) / 1000, batchesPerSecond: iterations / milliseconds * 1000, notifications };
  } finally { work.close(); }
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b), midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}
const report = {
  protocol: "clank-invalidation-performance/1", paths, rounds, iterations,
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, gcExposed: typeof globalThis.gc === "function" },
  workload: "Alternating A/B synchronous SQLite writes plus committed query invalidation and live delivery. Independent in-memory database per sample, ten excluded warmups, four retained revisions per document. No auth, HTTP, disk persistence, production data, or network capacity measurement. Ownership is covered by separate regression tests.",
  results: [],
};
for (const profile of profiles) {
  const counts = {}, samples = { baseline: [], candidate: [] };
  for (const label of ["baseline", "candidate"]) {
    const work = await fixture(modules[label], profile, true);
    try { work.write(1); counts[label] = work.verify(1); } finally { work.close(); }
  }
  for (let round = 0; round < rounds; round++) {
    for (const label of round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) samples[label].push(await sample(modules[label], profile));
  }
  const baselineMedianMs = median(samples.baseline.map((sample) => sample.milliseconds));
  const candidateMedianMs = median(samples.candidate.map((sample) => sample.milliseconds));
  report.results.push({ ...profile, counts, samples, baselineMedianMs, candidateMedianMs, elapsedReductionPercent: (1 - candidateMedianMs / baselineMedianMs) * 100 });
}
const output = JSON.stringify(report, null, 2) + "\n";
if (options.has("output")) await writeFile(resolve(options.get("output")), output);
process.stdout.write(output);
