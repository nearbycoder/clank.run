import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { platformConsolePage } from "../dist/platform-console.js";

const workspace = id => ({ organization: { id }, members: [], invitations: [] });
const failure = status => Object.assign(new Error(`Request failed: ${status}`), { status });

async function fixture(platformAdmin = false) {
  const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
  const names = ["searchConsoleRows", "consoleTime", "consoleTimeCell", "clearWorkspaceView", "currentWorkspaceSnapshot", "loadWorkspace", "roleLabel", "renderMembers", "changeMemberRole", "removeMember", "revokeInvitation"];
  const source = names.map(name => html.match(new RegExp(`(?:async )?function ${name}\\([^\\n]+`))[0]).join("\n");
  const requests = [], renders = [], toasts = [], authFailures = [];
  const state = { workspaceId: "alpha", workspaceData: null, workspaceLoading: false, workspaceLoadingId: null, workspaceGeneration: 0, dashboard: { account: { id: "self" } } };
  const initial = { authenticated: true, platformAdmin };
  const element = (tag = "div", className, textContent = "") => ({
    tag, className, textContent, children: [], dataset: {}, value: "", hidden: false, disabled: false,
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this[name] = value; },
  });
  const page = element();
  const nodes = new Map([["#workspace-page", page]]);
  let dashboardLoads = 0;
  const context = {
    state, initial,
    api: (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })),
    renderWorkspace: () => renders.push(state.workspaceData),
    el: element,
    labelTableCell(node, label) { node.dataset.label = label; return node; },
    clear: node => { node.children = []; },
    formatDate: String,
    confirm: () => true,
    toast: (...values) => toasts.push(values),
    handleAuthFailure(error) {
      authFailures.push(error.status);
      if (error.status !== 401) return false;
      initial.authenticated = false;
      return true;
    },
    async loadDashboard() { dashboardLoads++; await context.refreshDashboard?.(); },
    q: selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
  };
  const inviteSubmit = html.split("\n").find(line => line.startsWith('q("#invite-form").onsubmit='));
  runInNewContext(`${source}\n${inviteSubmit}`, context);
  return { state, initial, requests, renders, toasts, authFailures, context, page,
    load: silent => context.loadWorkspace(silent),
    select(id) { state.workspaceId = id; state.workspaceData = null; return context.loadWorkspace(false); },
    get dashboardLoads() { return dashboardLoads; },
  };
}

function renderMemberFixture(f) {
  const data = workspace("alpha");
  data.organization.access = { canManageMembers: true, canGrantOwner: true, canLeave: true };
  const member = { id: "member-one", email: "person@example.test", role: "developer", createdAt: 1 };
  data.members.push(member);
  f.state.workspaceData = data;
  f.context.renderMembers(data);
  const row = f.context.q("#member-list").children[0];
  return { data, member, select: row.children[1].children[0], remove: row.children[3].children[0] };
}

test("workspace switching starts the new read immediately and ignores an earlier completion", async () => {
  const f = await fixture();
  const first = f.load();
  const second = f.select("beta");
  assert.deepEqual(f.requests.map(request => request.path), ["/api/organizations/alpha", "/api/organizations/beta"]);
  f.requests[0].resolve(workspace("alpha"));
  await first;
  assert.equal(f.state.workspaceLoading, true, "old finally cannot clear the new request's loading state");
  assert.equal(f.state.workspaceLoadingId, "beta");
  assert.equal(f.renders.length, 0);
  f.requests[1].resolve(workspace("beta"));
  await second;
  assert.equal(f.renders.length, 1);
  assert.equal(f.renders[0].organization.id, "beta");
  assert.equal(f.state.workspaceLoading, false);
  assert.equal(f.state.workspaceLoadingId, null);
});

test("a late old response cannot replace the selected workspace and same-workspace reads coalesce", async () => {
  const f = await fixture();
  const first = f.load();
  await f.load();
  assert.equal(f.requests.length, 1);
  const second = f.select("beta");
  f.requests[1].resolve(workspace("beta"));
  await second;
  f.requests[0].resolve(workspace("alpha"));
  await first;
  assert.deepEqual(f.renders.map(data => data.organization.id), ["beta"]);
  assert.equal(f.state.workspaceData.organization.id, "beta");
});

test("returning to a workspace rejects its earlier request generation", async () => {
  const f = await fixture();
  const first = f.load();
  const second = f.select("beta");
  const third = f.select("alpha");
  const current = workspace("alpha");
  current.members = [{ email: "current@example.test" }];
  f.requests[2].resolve(current);
  await third;
  f.requests[0].resolve(workspace("alpha"));
  f.requests[1].resolve(workspace("beta"));
  await Promise.all([first, second]);
  assert.equal(f.renders.length, 1);
  assert.equal(f.state.workspaceData.members[0].email, "current@example.test");
});

test("stale workspace errors do not sign out, show a toast, or trigger membership recovery", async () => {
  for (const status of [401, 404, 500]) {
    const f = await fixture();
    const first = f.load();
    const second = f.select("beta");
    f.requests[0].reject(failure(status));
    await first;
    assert.equal(f.initial.authenticated, true);
    assert.equal(f.authFailures.length, 0);
    assert.equal(f.toasts.length, 0);
    assert.equal(f.dashboardLoads, 0);
    assert.equal(f.state.workspaceLoading, true);
    f.requests[1].resolve(workspace("beta"));
    await second;
  }
});

test("the current request retains authentication failure handling and validates workspace identity", async () => {
  const f = await fixture();
  const current = f.load();
  f.requests[0].reject(failure(401));
  await current;
  assert.equal(f.initial.authenticated, false);
  assert.deepEqual(f.authFailures, [401]);
  assert.equal(f.toasts.length, 0);
  assert.equal(f.state.workspaceLoading, false);

  const mismatched = await fixture();
  const pending = mismatched.load();
  mismatched.requests[0].resolve(workspace("other"));
  await pending;
  assert.equal(mismatched.renders.length, 0);
  assert.equal(mismatched.state.workspaceData, null);
  assert.match(mismatched.toasts[0][0], /did not match/);
});

test("current membership loss recovers the next authorized workspace", async () => {
  const f = await fixture();
  f.context.refreshDashboard = async () => { f.state.workspaceId = "beta"; };
  const pending = f.load();
  f.requests[0].reject(failure(404));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.dashboardLoads, 1);
  assert.equal(f.requests[1].path, "/api/organizations/beta");
  f.requests[1].resolve(workspace("beta"));
  await pending;
  assert.equal(f.state.workspaceData.organization.id, "beta");
  assert.deepEqual(f.toasts, [["Your workspace access changed.", true]]);
});

test("membership recovery does not clear or reload a newer selected workspace", async () => {
  const f = await fixture();
  let resumeDashboard;
  f.context.refreshDashboard = () => new Promise(resolve => { resumeDashboard = resolve; });
  const first = f.load();
  f.requests[0].reject(failure(404));
  await new Promise(resolve => setImmediate(resolve));
  const second = f.select("beta");
  f.requests[1].resolve(workspace("beta"));
  await second;
  resumeDashboard();
  await first;
  assert.equal(f.requests.length, 2);
  assert.equal(f.state.workspaceData.organization.id, "beta");
});

test("admin invitation reads and cleared selections obey the same workspace generation", async () => {
  const f = await fixture(true);
  const first = f.load();
  const second = f.select("beta");
  assert.deepEqual(f.requests.map(request => request.path), ["/api/organizations/alpha", "/api/admin/invitations", "/api/organizations/beta", "/api/admin/invitations"]);
  f.requests[2].resolve(workspace("beta"));
  f.requests[3].resolve({ invitations: [{ id: "current-invitation" }], limit: 20 });
  await second;
  f.requests[0].resolve(workspace("alpha"));
  f.requests[1].resolve({ invitations: [{ id: "old-invitation" }], limit: 10 });
  await first;
  assert.equal(f.state.workspaceData.personalInvitations[0].id, "current-invitation");
  assert.equal(f.state.workspaceData.personalInvitationLimit, 20);

  const third = f.select("alpha");
  await f.select(null);
  f.requests[4].resolve(workspace("alpha"));
  f.requests[5].resolve({ invitations: [], limit: 20 });
  await third;
  assert.equal(f.state.workspaceData, null);
  assert.equal(f.renders.length, 1);
  assert.equal(f.state.workspaceLoading, false);
  f.initial.authenticated = false;
  await f.select("beta");
  assert.equal(f.requests.length, 6);
});

test("a pending workspace switch clears old rows and secrets while rejecting old member actions", async () => {
  const f = await fixture();
  const old = renderMemberFixture(f);
  f.context.q("#invitation-list").children.push({ textContent: "Old invitation" });
  f.context.q("#invite-token").value = "old-token";
  f.context.q("#invite-secret").hidden = false;
  f.context.q("#workspace-select").value = "beta";
  f.state.workspaceId = "beta";
  const pending = f.load();
  assert.equal(f.context.q("#member-list").children.length, 0);
  assert.equal(f.context.q("#invitation-list").children.length, 0);
  assert.equal(f.context.q("#invite-token").value, "");
  assert.equal(f.context.q("#invite-secret").hidden, true);
  assert.equal(f.context.q("#invite-panel").hidden, true);
  assert.equal(f.context.q("#invite-submit").disabled, true);
  assert.equal(f.context.q("#workspace-select").disabled, false);
  assert.equal(f.context.q("#workspace-select").value, "beta");
  old.select.value = "admin";
  await old.select.onchange();
  await old.remove.onclick();
  assert.equal(f.requests.length, 1, "old row callbacks cannot issue any mutations during loading");
  assert.equal(old.select.disabled, true);
  assert.equal(old.remove.disabled, true);
  const next = workspace("beta");
  next.members.push(old.member);
  f.requests[0].resolve(next);
  await pending;
  await old.select.onchange();
  await old.remove.onclick();
  assert.equal(f.requests.length, 1, "even the same member ID in the new workspace cannot authorize the old row");
});

test("same-workspace background refresh keeps current member actions available and correctly scoped", async () => {
  const f = await fixture();
  const current = renderMemberFixture(f);
  f.context.q("#invite-panel").hidden = false;
  const refresh = f.load(true);
  assert.equal(f.context.q("#member-list").children.length, 1);
  assert.equal(f.context.q("#invite-panel").hidden, false);
  assert.equal(current.select.disabled, false);
  current.select.value = "admin";
  const update = current.select.onchange();
  assert.equal(f.requests[1].path, "/api/organizations/alpha/members/member-one");
  assert.equal(f.requests[1].options.method, "PATCH");
  assert.equal(f.requests[1].options.body.role, "admin");
  f.requests[1].resolve({});
  await update;
  f.requests[0].resolve(workspace("alpha"));
  await refresh;
  await current.select.onchange();
  assert.equal(f.requests.length, 2, "a row from a replaced snapshot is no longer actionable");
});

test("a completed old-workspace removal cannot clear or redirect the newly selected workspace", async () => {
  const f = await fixture();
  const old = renderMemberFixture(f);
  const remove = old.remove.onclick();
  assert.equal(f.requests[0].path, "/api/organizations/alpha/members/member-one");
  assert.equal(f.requests[0].options.method, "DELETE");
  const next = f.select("beta");
  f.requests[1].resolve(workspace("beta"));
  await next;
  f.requests[0].resolve({});
  await remove;
  assert.equal(f.state.workspaceId, "beta");
  assert.equal(f.state.workspaceData.organization.id, "beta");
  assert.equal(f.dashboardLoads, 0);
  assert.equal(f.toasts.length, 0);
  assert.equal(old.remove.disabled, true);
});

test("current member removal invalidates a pre-mutation background snapshot before reloading", async () => {
  const f = await fixture();
  const current = renderMemberFixture(f);
  const refresh = f.load(true);
  const remove = current.remove.onclick();
  f.requests[1].resolve({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 3, "removal starts a fresh workspace read");
  f.requests[0].resolve(current.data);
  await refresh;
  assert.equal(f.state.workspaceData, null);
  assert.equal(f.state.workspaceLoading, true);
  f.requests[2].resolve(workspace("alpha"));
  await remove;
  assert.equal(f.state.workspaceData.members.length, 0);
  assert.equal(f.renders.length, 1);
});

test("an invitation revoke callback cannot cross a workspace switch", async () => {
  const f = await fixture();
  const old = renderMemberFixture(f);
  f.state.workspaceId = "beta";
  const pending = f.load();
  const button = { disabled: false };
  await f.context.revokeInvitation({ id: "invite-one", email: "person@example.test", scope: "workspace" }, button, old.data);
  await f.context.q("#invite-form").onsubmit({ preventDefault() {} });
  assert.equal(f.requests.length, 1);
  assert.equal(button.disabled, true);
  f.requests[0].resolve(workspace("beta"));
  await pending;
});
