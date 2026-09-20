import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { filterConsoleProjectWorkspace } from "../dist/platform-console-project-workspace.js";
import { filterConsoleProjectStatus } from "../dist/platform-console-project-status.js";
import { sortConsoleProjects } from "../dist/platform-console-project-sort.js";
import { platformConsolePage } from "../dist/platform-console.js";

const organizations = Object.freeze([
  Object.freeze({ id: "personal", name: "Personal" }),
  Object.freeze({ id: "team", name: "Team <script>untrusted</script>" }),
  Object.freeze({ id: "empty", name: "New workspace" }),
]);
const projects = Object.freeze([
  Object.freeze({ id: "a", name: "Alpha API", slug: "alpha", organizationId: "personal", runtimeStatus: "online", metrics: { requests: 10 } }),
  Object.freeze({ id: "b", name: "Beta API", slug: "beta", organizationId: "team", runtimeStatus: "online", metrics: { requests: 5 } }),
  Object.freeze({ id: "c", name: "Gamma API", slug: "gamma", organizationId: "team", runtimeStatus: "online", metrics: { requests: 20 } }),
  Object.freeze({ id: "d", name: "Delta API", slug: "delta", organizationId: "team", runtimeStatus: "sleeping", metrics: { requests: 40 } }),
  Object.freeze({ id: "e", name: "Epsilon web", slug: "epsilon", organizationId: "team", runtimeStatus: "online", metrics: { requests: 100 } }),
]);

test("workspace filtering selects exact workspace IDs without changing the dashboard snapshot", () => {
  const result = filterConsoleProjectWorkspace(projects, organizations, "team");
  assert.equal(result.workspaceId, "team");
  assert.deepEqual(result.projects.map(project => project.id), ["b", "c", "d", "e"]);
  assert.notEqual(result.projects, projects);
  assert.equal(projects.length, 5);
  assert.deepEqual(filterConsoleProjectWorkspace(projects, organizations, "empty"), { workspaceId: "empty", projects: [] });
});

test("untrusted and revoked selections return to the authorized all-workspaces snapshot", () => {
  for (const value of ["", "missing", "Team", "team ", "__proto__", "x".repeat(100_000), undefined, null, {}, ["team"]]) {
    const result = filterConsoleProjectWorkspace(projects, organizations, value);
    assert.equal(result.workspaceId, "");
    assert.deepEqual(result.projects, projects);
    assert.notEqual(result.projects, projects);
  }
  const refreshed = projects.filter(project => project.organizationId === "personal");
  assert.deepEqual(filterConsoleProjectWorkspace(refreshed, organizations.slice(0, 1), "team"), { workspaceId: "", projects: refreshed });
  assert.deepEqual(filterConsoleProjectWorkspace([], [], "team"), { workspaceId: "", projects: [] });
});

test("workspace, status, search, and ordering combine over the same authorized projects", () => {
  const workspace = filterConsoleProjectWorkspace(projects, organizations, "team");
  const status = filterConsoleProjectStatus(workspace.projects, "online");
  const searched = status.projects.filter(project => project.name.toLowerCase().includes("api"));
  assert.deepEqual(sortConsoleProjects(searched, "requests").map(project => project.id), ["c", "b"]);
  const refreshed = [...projects, { ...projects[0], id: "f", organizationId: "team" }];
  assert.equal(filterConsoleProjectWorkspace(refreshed, organizations, "team").projects.length, 5);
});

test("dashboard workspace options preserve a selection on refresh and discard it when access changes", async () => {
  const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
  const render = html.match(/function renderProjectWorkspaceOptions\(organizations\)\{[^\n]+/)[0];
  const select = { children: [], value: "", append(option) { this.children.push(option); } };
  const state = { projectWorkspace: "team" };
  const context = {
    state,
    filterConsoleProjectWorkspace,
    q: selector => { assert.equal(selector, "#project-workspace-filter"); return select; },
    clear: element => { element.children = []; },
    el: (tagName, className, textContent) => ({ tagName, className, textContent }),
    organizations,
  };
  runInNewContext(`${render}\nrenderProjectWorkspaceOptions(organizations);`, context);
  assert.equal(select.value, "team");
  assert.deepEqual(select.children.map(option => option.value), ["", "personal", "team", "empty"]);
  assert.equal(select.children[2].textContent, "Team <script>untrusted</script>");
  context.organizations = organizations.slice(0, 1);
  runInNewContext("renderProjectWorkspaceOptions(organizations);", context);
  assert.equal(state.projectWorkspace, "");
  assert.equal(select.value, "");
  assert.deepEqual(select.children.map(option => option.value), ["", "personal"]);
});

test("dashboard rows, counts, and empty states reflect all combined project controls", async () => {
  const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
  const render = html.match(/function renderProjectList\(projects\)\{[^\n]+/)[0];
  const node = (tagName, className, textContent) => ({ tagName, className, textContent, children: [], dataset: {}, append(...children) { this.children.push(...children); } });
  const list = node("div");
  const count = node("span");
  const state = { projectWorkspace: "team", projectStatus: "online", projectFilter: "api", projectSort: "requests", dashboard: { organizations, totals: { online: 4, projects: 5 } } };
  const context = {
    state, projects, filterConsoleProjectWorkspace, filterConsoleProjectStatus, sortConsoleProjects,
    q: selector => ({ "#project-list": list, "#online-count": count })[selector],
    clear: element => { element.children = []; }, el: node,
    projectPath: slug => `/projects/${slug}/performance`, formatNumber: String, formatLatency: String,
  };
  runInNewContext(`${render}\nrenderProjectList(projects);`, context);
  assert.equal(count.textContent, "2 of 5 shown");
  assert.deepEqual(list.children.map(row => row.href), ["/projects/gamma/performance", "/projects/beta/performance"]);
  state.projectWorkspace = "empty";
  runInNewContext("renderProjectList(projects);", context);
  assert.equal(count.textContent, "0 of 5 shown");
  assert.equal(list.children[0].children[0].textContent, "No matching projects");
  state.projectWorkspace = "";
  state.projectStatus = "all";
  state.projectFilter = "";
  runInNewContext("renderProjectList(projects);", context);
  assert.equal(count.textContent, "4 of 5 online");
  assert.equal(list.children.length, 5);
});
