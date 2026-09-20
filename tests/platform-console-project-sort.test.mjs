import test from "node:test";
import assert from "node:assert/strict";
import { sortConsoleProjects } from "../dist/platform-console-project-sort.js";

const projects = [
  { id: "z", name: "Zulu", slug: "zulu", metrics: { requests: 20, p95LatencyMs: 15 } },
  { id: "b", name: "beta", slug: "beta", metrics: { requests: 40, p95LatencyMs: 10 } },
  { id: "a2", name: "Alpha", slug: "alpha-two", metrics: { requests: 20, p95LatencyMs: 30 } },
  { id: "a1", name: "alpha", slug: "alpha-one", metrics: { requests: 20, p95LatencyMs: 30 } },
];
const ids = (rows) => rows.map((row) => row.id);

test("console project ordering preserves default order and its input snapshot", () => {
  const frozen = Object.freeze(projects.map((project) => Object.freeze(project)));
  const original = ids(frozen);
  for (const order of ["default", "unknown", "name-asc", "name-desc", "requests", "latency"]) {
    assert.notEqual(sortConsoleProjects(frozen, order), frozen);
    assert.deepEqual(ids(frozen), original);
  }
  assert.deepEqual(ids(sortConsoleProjects(frozen, "default")), original);
  assert.deepEqual(ids(sortConsoleProjects(frozen, "unknown")), original);
});

test("console project name and numeric sorts use deterministic ties", () => {
  assert.deepEqual(ids(sortConsoleProjects(projects, "name-asc")), ["a1", "a2", "b", "z"]);
  assert.deepEqual(ids(sortConsoleProjects(projects, "name-desc")), ["z", "b", "a1", "a2"]);
  assert.deepEqual(ids(sortConsoleProjects(projects, "requests")), ["b", "a1", "a2", "z"]);
  assert.deepEqual(ids(sortConsoleProjects(projects, "latency")), ["a1", "a2", "z", "b"]);
  const twins = [{ id: "2", name: "Same", slug: "same" }, { id: "1", name: "Same", slug: "same" }];
  assert.deepEqual(ids(sortConsoleProjects(twins, "name-asc")), ["1", "2"]);
});

test("console sorting accepts filtered lists, empty results, and missing metric samples", () => {
  const filtered = projects.filter((project) => project.name.toLowerCase().includes("alpha"));
  assert.deepEqual(ids(sortConsoleProjects(filtered, "latency")), ["a1", "a2"]);
  assert.deepEqual(sortConsoleProjects([], "requests"), []);
  const samples = [
    { id: "z", name: "Zulu", slug: "z", metrics: { requests: Infinity, p95LatencyMs: NaN } },
    { id: "b", name: "Beta", slug: "b" },
    { id: "a", name: "Alpha", slug: "a", metrics: { requests: 1, p95LatencyMs: 1 } },
  ];
  assert.deepEqual(ids(sortConsoleProjects(samples, "requests")), ["a", "b", "z"]);
  assert.deepEqual(ids(sortConsoleProjects(samples, "latency")), ["a", "b", "z"]);
});
