import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-project-reset-"));
test.after(() => rm(directory, { recursive: true, force: true }));
await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
await Promise.all([
  "platform-console", "ui-theme", "platform-console-project-sort", "platform-console-project-status",
  "platform-console-project-workspace", "platform-console-activity-search", "platform-console-activity-action",
  "platform-console-log-search", "platform-console-usage-export",
].map(async name => {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.js`), compile(source, { filename: `${name}.ts`, sourceMap: false }));
}));
const { platformConsolePage } = await import(pathToFileURL(join(directory, "platform-console.js")));
const { sortConsoleProjects } = await import(pathToFileURL(join(directory, "platform-console-project-sort.js")));
const { filterConsoleProjectStatus } = await import(pathToFileURL(join(directory, "platform-console-project-status.js")));
const { filterConsoleProjectWorkspace } = await import(pathToFileURL(join(directory, "platform-console-project-workspace.js")));
const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
const lines = html.split("\n");
const source = ["function resetProjectFilters(", "function renderProjectList(", 'q("#project-reset-filters").onclick='].map(prefix => {
  const found = lines.find(value => value.startsWith(prefix));
  assert.ok(found, `missing console fixture: ${prefix}`);
  return found;
}).join("\n");

function fixture(projects = [
  { id: "b", name: "Bravo", organizationId: "team-b", runtimeStatus: "online", requests: 12 },
  { id: "a", name: "Alpha", organizationId: "team-a", runtimeStatus: "sleeping", requests: 3 },
  { id: "c", name: "Charlie", organizationId: "team-a", runtimeStatus: "online", requests: 99 },
]) {
  const elements = new Map();
  const element = (tag, className, textContent) => ({ tag, className, textContent, children: [], dataset: {}, value: "", append(...children) { this.children.push(...children); }, focus(options) { this.focusOptions = options; this.focused = true; } });
  for (const id of ["project-list", "project-search", "project-status-filter", "project-workspace-filter", "project-sort", "project-reset-filters", "online-count"]) elements.set(`#${id}`, element("div"));
  const dashboard = {
    projects: projects.map(project => ({ ...project, slug: project.id, url: `https://${project.id}.example.test`, metrics: { requests: project.requests, p95LatencyMs: 20 } })),
    organizations: [{ id: "team-a" }, { id: "team-b" }],
    totals: { online: projects.filter(project => project.runtimeStatus === "online").length, projects: projects.length },
  };
  const state = { dashboard, projectFilter: "missing", projectStatus: "sleeping", projectWorkspace: "team-b", projectSort: "requests", workspaceId: "team-a", activitySearch: "keep activity", activityAction: "project.deploy", logSearch: "keep logs", logStream: "stderr", logWrap: true, runtimeDraft: { policy: "always-on" } };
  const q = selector => { assert.ok(elements.has(selector), `unexpected selector ${selector}`); return elements.get(selector); };
  q("#project-search").value = state.projectFilter;
  q("#project-status-filter").value = state.projectStatus;
  q("#project-workspace-filter").value = state.projectWorkspace;
  q("#project-sort").value = state.projectSort;
  const context = { state, q, clear(node) { node.children = []; }, el: element, filterConsoleProjectWorkspace, filterConsoleProjectStatus, sortConsoleProjects, projectPath: slug => `/projects/${slug}/performance`, formatNumber: String, formatLatency: value => `${value}ms` };
  runInNewContext(`${source}\nglobalThis.render = renderProjectList;`, context);
  return { state, q, render: () => context.render(state.dashboard.projects), reset: () => q("#project-reset-filters").onclick(), names: () => q("#project-list").children.map(row => row.children[0]?.children[0]?.children[0]?.textContent) };
}

test("one accessible reset action names the project list and its updated count", () => {
  assert.equal((html.match(/id="project-reset-filters"/g) || []).length, 1);
  assert.match(html, /<button[^>]*id="project-reset-filters"[^>]*type="button"[^>]*aria-controls="project-list"[^>]*aria-describedby="online-count"[^>]*>Reset filters<\/button>/);
  assert.match(html, /<span[^>]*id="online-count"[^>]*role="status"/);
  assert.match(html, /<option value="default">Default order<\/option>/);
});

test("reset clears all four combined filters and restores default server order, count, and search focus", () => {
  const f = fixture();
  f.render();
  assert.equal(f.q("#online-count").textContent, "0 of 3 shown");
  assert.equal(f.q("#project-list").children[0].children[0].textContent, "No matching projects");
  f.reset();
  assert.deepEqual([f.state.projectFilter, f.state.projectStatus, f.state.projectWorkspace, f.state.projectSort], ["", "all", "", "default"]);
  assert.deepEqual(["#project-search", "#project-status-filter", "#project-workspace-filter", "#project-sort"].map(id => f.q(id).value), ["", "all", "", "default"]);
  assert.deepEqual(f.names(), ["Bravo", "Alpha", "Charlie"]);
  assert.equal(f.q("#online-count").textContent, "2 of 3 online");
  assert.equal(f.q("#project-search").focused, true);
  assert.equal(f.q("#project-search").focusOptions.preventScroll, true);
});

test("reset preserves unrelated workspace selection, activity/log controls, runtime draft, and authorized snapshot", () => {
  const f = fixture();
  const snapshot = JSON.stringify(f.state.dashboard), reference = f.state.dashboard, draft = f.state.runtimeDraft;
  f.reset();
  assert.equal(f.state.dashboard, reference);
  assert.equal(JSON.stringify(f.state.dashboard), snapshot);
  assert.equal(f.state.workspaceId, "team-a");
  assert.equal(f.state.activitySearch, "keep activity");
  assert.equal(f.state.activityAction, "project.deploy");
  assert.equal(f.state.logSearch, "keep logs");
  assert.equal(f.state.logStream, "stderr");
  assert.equal(f.state.logWrap, true);
  assert.equal(f.state.runtimeDraft, draft);
});

test("empty dashboard reset removes filtered-empty wording and uses the empty project count", () => {
  const f = fixture([]);
  f.render();
  assert.equal(f.q("#project-list").children[0].children[0].textContent, "No matching projects");
  f.reset();
  assert.equal(f.q("#project-list").children[0].children[0].textContent, "No projects yet");
  assert.equal(f.q("#online-count").textContent, "0 of 0 online");
});

test("sort-only reset uses the latest snapshot order and stays reset across subsequent renders", () => {
  const f = fixture();
  Object.assign(f.state, { projectFilter: "", projectStatus: "all", projectWorkspace: "", projectSort: "name-asc" });
  f.render();
  assert.deepEqual(f.names(), ["Alpha", "Bravo", "Charlie"]);
  f.state.dashboard.projects.reverse();
  f.reset();
  assert.deepEqual(f.names(), ["Charlie", "Alpha", "Bravo"]);
  f.render();
  assert.deepEqual(f.names(), ["Charlie", "Alpha", "Bravo"]);
});

test("reset without a loaded dashboard clears controls locally without requesting data", () => {
  const f = fixture();
  f.state.dashboard = null;
  f.reset();
  assert.equal(f.state.projectSort, "default");
  assert.equal(f.q("#project-search").value, "");
  assert.equal(f.q("#project-list").children.length, 0);
  assert.equal(f.q("#project-search").focused, true);
});
