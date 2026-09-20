import test from "node:test";
import assert from "node:assert/strict";
import { filterConsoleProjectStatus } from "../dist/platform-console-project-status.js";

const projects = Object.freeze([
  Object.freeze({ id: "alpha", name: "Alpha API", runtimeStatus: "online" }),
  Object.freeze({ id: "beta", name: "Beta API", runtimeStatus: "sleeping" }),
  Object.freeze({ id: "gamma", name: "Gamma API", runtimeStatus: "suspended" }),
  Object.freeze({ id: "delta", name: "Delta API", runtimeStatus: "degraded" }),
  Object.freeze({ id: "epsilon", name: "Epsilon API", runtimeStatus: "not_deployed" }),
  Object.freeze({ id: "zeta", name: "Zeta Web", runtimeStatus: "online" }),
]);

test("console runtime status filters each supported state from the authorized snapshot", () => {
  for (const status of ["online", "sleeping", "suspended", "degraded", "not_deployed"]) {
    const result = filterConsoleProjectStatus(projects, status);
    assert.equal(result.status, status);
    assert.deepEqual(result.projects, projects.filter(project => project.runtimeStatus === status));
    assert.notEqual(result.projects, projects);
  }
  assert.equal(projects.length, 6);
});

test("console runtime filtering normalizes unknown, oversized, and non-string input to all states", () => {
  for (const status of ["all", "", "offline", "ONLINE", "online ", "x".repeat(100_000), undefined, null, {}, ["online"]]) {
    const result = filterConsoleProjectStatus(projects, status);
    assert.equal(result.status, "all");
    assert.deepEqual(result.projects, projects);
    assert.notEqual(result.projects, projects);
  }
});

test("console status filters compose with project search and handle empty or refreshed snapshots", () => {
  const searched = projects.filter(project => project.name.toLowerCase().includes("api"));
  assert.deepEqual(filterConsoleProjectStatus(searched, "online").projects.map(project => project.id), ["alpha"]);
  assert.deepEqual(filterConsoleProjectStatus([], "online"), { status: "online", projects: [] });
  const refreshed = projects.filter(project => project.runtimeStatus !== "online");
  assert.deepEqual(filterConsoleProjectStatus(refreshed, "online").projects, []);
  assert.deepEqual(filterConsoleProjectStatus(refreshed, "all").projects, refreshed);
});
