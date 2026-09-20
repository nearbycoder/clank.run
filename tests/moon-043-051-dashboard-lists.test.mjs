import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext, Script } from "node:vm";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-final-lists-"));
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
// This is the exact trusted fixture emitted by platformConsolePage, not arbitrary HTML.
const scriptStart = html.indexOf(">const initial=");
const scriptEnd = html.indexOf("</script>", scriptStart);
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "Generated console script is present");
new Script(html.slice(scriptStart + 1, scriptEnd));
const names = ["searchConsoleRows", "compareConsoleText", "formatDate", "titleConsoleTime", "consoleTime", "consoleTimeCell", "operationalId", "operationalIdCell", "renderReleaseStatusOptions", "previewExpiryCell", "renderMembers", "renderInvitations", "clearWorkspaceView", "renderReleases", "renderPreviews", "renderBackups", "renderJobs", "visibleUsageProjects", "usageMonthBounds", "renderUsageMonths", "selectUsageMonth", "moveUsageMonth", "renderUsage", "clearUsageView", "setUsageProgress", "canExportUsage", "renderUsageExport", "downloadUsageCsv"];
const source = names.map(name => {
  const found = lines.find(value => value.startsWith(`function ${name}(`));
  assert.ok(found, `missing function ${name}`); return found;
}).join("\n");
const handlers = lines.filter(line => /^q\("#(?:member-search|invitation-search|invitation-status-filter|invitation-scope-filter|release-search|release-status-filter|release-artifact-filter|preview-sort|backup-search|backup-sort|usage-project-search|usage-project-sort|usage-month|usage-previous|usage-next|usage-current)"\)\./.test(line)).join("\n");
const fixedNow = Date.parse("2026-01-15T12:00:00.000Z");
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [fixedNow])); } static now() { return fixedNow; } }
function fixture() {
  const nodes = new Map(), actions = [], copies = [], loads = [], blobs = [];
  const element = (tag, className, text = "") => ({ tag, className, textContent: String(text), children: [], dataset: {}, attributes: {}, style: {}, value: "", hidden: false, disabled: false, isConnected: true,
    append(...children) { this.children.push(...children); }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; }, click() {}, remove() {}, focus() {},
    set innerHTML(value) { throw new Error("Unsafe HTML write"); },
  });
  const q = selector => { if (!nodes.has(selector)) nodes.set(selector, element("div")); return nodes.get(selector); };
  const state = { memberSearch: "", invitationSearch: "", invitationStatus: "", invitationScope: "", workspaceId: "w1", workspaceData: null, dashboard: { account: { id: "self" }, organizations: [{ id: "w1" }] }, currentProject: "p1", projectData: { detail: { project: { id: "p1", placement: "local" }, access: { role: "owner" } } }, releaseSearch: "", releaseStatus: "", releaseArtifacts: "all", previewSort: "expiry", backupSearch: "", backupSort: "newest", usageSearch: "", usageSort: "default", usageFilterWorkspace: "w1", usageMonth: "2026-01", usageWorkspaceId: "w1", usageRetentionMonths: 12, usageLoading: false };
  const initial = { authenticated: true, impersonation: null, platformAdmin: false };
  const context = { state, initial, q, el: element, Date: Clock, Blob, usageExportUrls: new Map(),
    clear(node) { node.children = []; node.textContent = ""; }, labelTableCell(node, label) { node.dataset.label = label; return node; },
    tableCell(label, text, className) { const node = element("td", className, text); node.dataset.label = label; return node; },
    formatNumber: String, formatExactNumber: String, formatBytes: value => `${value} B`, duration: String, roleLabel: value => value,
    changeMemberRole: (...args) => actions.push(["role", ...args]), removeMember: (...args) => actions.push(["remove", ...args]), revokeInvitation: (...args) => actions.push(["revoke", ...args]),
    cleanupRelease: value => actions.push(["cleanup", value]), removePreview: value => actions.push(["preview", value]), verifyBackup: (...args) => actions.push(["verify", ...args]), openProviderFailover: value => actions.push(["recover", value]), operateJob: (...args) => actions.push(["job", ...args]),
    syncRevealedInvitation: values => { context.revealedSnapshot = values; }, renderReleaseComparison: value => { context.comparison = value; },
    copyRenderedText: (node, message) => copies.push([node.textContent, message, node]),
    loadUsage: async silent => loads.push([state.usageWorkspaceId, state.usageMonth, silent]),
    toast: (...args) => actions.push(["toast", ...args]), document: { body: element("body") },
    URL: { createObjectURL(blob) { blobs.push(blob); return "blob:csv"; }, revokeObjectURL() {} }, setTimeout() { return 1; }, clearTimeout() {},
  };
  runInNewContext(`${source}\n${handlers}`, context);
  return { state, initial, q, context, actions, copies, loads, blobs,
    input(id, value) { q(`#${id}`).value = value; q(`#${id}`).oninput({ target: q(`#${id}`) }); },
    change(id, value) { q(`#${id}`).value = value; q(`#${id}`).onchange({ target: q(`#${id}`) }); },
  };
}
const text = node => [node.textContent, ...node.children.map(text)].join(" ");
const workspace = () => ({ organization: { id: "w1", access: { canManageMembers: true, canGrantOwner: true, canLeave: true } }, members: [
  { id: "self", email: "owner@example.test", role: "owner", createdAt: 0 }, { id: "acct-other", email: "Other@example.test", role: "developer", createdAt: 1234567890123 },
], invitations: [{ id: "i1", email: "alice@example.test", role: "viewer", invitedBy: { email: "owner@example.test" }, delivery: { status: "failed" }, expiresAt: fixedNow + 1000 }], personalInvitations: [{ id: "i2", email: "alice-personal@example.test", scope: "personal", invitedBy: { email: "owner@example.test" }, delivery: { status: "sent", sentAt: 1234567890123 }, expiresAt: fixedNow + 2000 }] });
const release = (id, status, available) => ({ id, status, artifactAvailable: available, frameworkVersion: "1", storageBytes: 10, createdAt: 1234567890123, cleanup: { allowed: available, rollbackProtected: false } });
const usage = () => ({ workspace: { id: "w1", slug: "team" }, period: { key: "2026-01", current: true, complete: true, trackingStartedAt: 0 }, retentionMonths: 12,
  usage: { requests: 40, knownTransferBytes: 60, rejectedRequests: 5 }, limits: { requests: 100, knownTransferBytes: 100, requestsPerMinutePerProject: 20 },
  resources: { projects: 2, previews: 1, members: 1, domains: 0, releases: 2, releaseStorageBytes: 3, asOf: fixedNow },
  projects: [{ id: "z", name: "Zulu", slug: "zulu", requests: 30, knownTransferBytes: 10, rejectedRequests: 1, updatedAt: 0, kind: "production", deleted: false }, { id: "a", name: "Alpha", slug: "alpha", requests: 10, knownTransferBytes: 50, rejectedRequests: 4, updatedAt: fixedNow, kind: "preview", deleted: true }],
});

test("043: member search matches email or full ID and retains the original authorized workspace in row handlers", () => {
  const f = fixture(), data = workspace(); f.state.workspaceData = data;
  f.input("member-search", "OTHER@EXAMPLE");
  assert.equal(f.q("#member-count").textContent, "1 of 2 members shown");
  const row = f.q("#member-list").children[0];
  row.children[1].children[0].onchange(); row.children[3].children[0].onclick();
  assert.equal(f.actions[0][3], data); assert.equal(f.actions[1][3], data);
  assert.equal(f.actions[0][1], data.members[1]);
  f.input("member-search", "acct-other"); assert.equal(f.q("#member-list").children.length, 1);
  f.input("member-search", "[literal]"); assert.match(text(f.q("#member-list")), /No members match/);
  assert.equal(data.members.length, 2);
});

test("043: read-only search is available in support sessions; stale workspace snapshots do not render", () => {
  const f = fixture(), data = workspace(); f.state.workspaceData = data; f.initial.impersonation = {};
  f.input("member-search", "other"); const row = f.q("#member-list").children[0];
  assert.equal(row.children[1].children[0].disabled, true); assert.equal(row.children[3].children[0].disabled, true);
  f.state.workspaceId = "w2"; const previous = f.q("#member-list").children;
  f.input("member-search", "owner"); assert.equal(f.q("#member-list").children, previous);
  f.context.clearWorkspaceView(); assert.equal(f.state.memberSearch, ""); assert.equal(f.q("#member-list").children.length, 0);
});

test("044: recipient, delivery and scope filters compose over accessible invitations without retiring filtered tokens", () => {
  const f = fixture(), data = workspace(); f.state.workspaceData = data; f.initial.platformAdmin = true;
  f.context.renderInvitations(data, true);
  const authoritative = f.context.revealedSnapshot;
  f.input("invitation-search", "alice"); f.change("invitation-status-filter", "sent"); f.change("invitation-scope-filter", "personal");
  assert.equal(f.q("#invitation-count").textContent, "1 of 2 accessible invitations shown");
  assert.match(text(f.q("#invitation-list")), /alice-personal/); assert.equal(f.context.revealedSnapshot.length, 2);
  f.q("#invitation-list").children[0].children[4].onclick(); assert.equal(f.actions[0][3], data);
  f.change("invitation-status-filter", "failed"); assert.match(text(f.q("#invitation-list")), /No invitations match/);
  assert.equal(f.context.revealedSnapshot, authoritative, "Filter-only renders never retire tokens from a cached snapshot");
  f.context.clearWorkspaceView(); assert.equal(f.state.invitationSearch, ""); assert.equal(f.state.invitationStatus, ""); assert.equal(f.state.invitationScope, "");
});

test("044: invitation filters and reads predating creation preserve the new one-time token until an authoritative refresh retires it", async () => {
  const f = fixture(), data = workspace(); data.invitations = []; f.state.workspaceData = data;
  Object.assign(f.state, { workspaceLoading: false, workspaceLoadingId: null, workspaceGeneration: 0, revealedInvitationId: null });
  const pending = [];
  Object.assign(f.context, {
    api: (path, options) => new Promise((resolve, reject) => pending.push({ path, options, resolve, reject })),
    handleAuthFailure: () => false,
    renderWorkspace: () => f.context.renderInvitations(f.state.workspaceData, true),
    loadDashboard: async () => {},
  });
  const actual = ["invitationFallbackCopy", "syncRevealedInvitation", "currentWorkspaceSnapshot", "loadWorkspace"].map(name =>
    lines.find(line => new RegExp(`^(?:async )?function ${name}\\(`).test(line)));
  actual.push(lines.find(line => line.startsWith('q("#invite-form").onsubmit=')));
  runInNewContext(actual.join("\n"), f.context);
  assert.match(lines.find(line => line.startsWith("function renderWorkspace(")), /renderInvitations\(data,true\)/u);
  const beforeCreation = f.context.loadWorkspace(true);
  f.q("#invite-scope").value = "workspace";
  f.q("#invite-email").value = "new@example.test";
  f.q("#invite-role").value = "viewer";
  const creating = f.q("#invite-form").onsubmit({ preventDefault() {} });
  const invitation = { ...workspace().invitations[0], id: "new-invitation", email: "new@example.test", delivery: { status: "manual" } };
  pending[1].resolve({ invitation: { ...invitation, token: "one-time-token" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 3, "Creation starts a new read instead of reusing the pre-creation read");
  assert.equal(f.q("#invite-token").value, "one-time-token");
  assert.equal(f.q("#invite-secret").hidden, false);
  f.input("invitation-search", "missing");
  f.change("invitation-status-filter", "sent");
  f.change("invitation-scope-filter", "personal");
  assert.equal(f.q("#invite-token").value, "one-time-token");
  pending[0].resolve(data); await beforeCreation;
  assert.equal(f.q("#invite-token").value, "one-time-token", "A stale response cannot retire a token created after that read started");
  assert.equal(f.state.workspaceLoading, true);
  pending[2].resolve({ ...data, invitations: [{ ...invitation, delivery: { status: "sent" } }] });
  await creating;
  assert.equal(f.q("#invite-token").value, "one-time-token");
  assert.match(f.q("#invite-secret-copy").textContent, /Email was sent/u);
  const revokedOrExpired = f.context.loadWorkspace(true);
  pending[3].resolve({ ...data, invitations: [] }); await revokedOrExpired;
  assert.equal(f.q("#invite-token").value, "");
  assert.equal(f.q("#invite-secret").hidden, true);
  assert.equal(f.state.revealedInvitationId, null);
});

test("044: non-admin views do not search or disclose private personal/workspace invitations", () => {
  const f = fixture(), data = workspace(); data.organization.access.canManageMembers = false; f.state.workspaceData = data;
  f.input("invitation-search", "alice");
  assert.equal(f.q("#invitation-count").textContent, "0 of 0 accessible invitations shown");
  assert.match(text(f.q("#invitation-list")), /Invitation details are private/);
  assert.doesNotMatch(text(f.q("#invitation-list")), /alice/);
});

test("045: deployment search, exact status and artifact availability compose without changing quota/comparison or action objects", () => {
  const f = fixture(), releases = [release("rel-active-long-id", "active", true), release("rel-old-long-id", "failed", false), release("rel-ready-long-id", "ready", true)];
  Object.assign(f.state.projectData, { releases, releaseUsage: { releases: 2, storageBytes: 20 }, releaseLimits: { releases: 10, storageBytes: 100 }, releaseComparison: { message: "same" } });
  f.input("release-search", "REL"); f.change("release-status-filter", "ready"); f.change("release-artifact-filter", "available");
  assert.equal(f.q("#release-count").textContent, "1 of 3 deployments shown");
  assert.equal(f.q("#release-quota").textContent, "2 of 10 artifacts · 20 B of 100 B");
  f.q("#release-list").children[0].children[5].children[0].onclick(); assert.equal(f.actions[0][1], releases[2]);
  f.change("release-artifact-filter", "removed"); assert.match(text(f.q("#release-list")), /No deployments match/);
  assert.equal(f.context.comparison, f.state.projectData.releaseComparison);
  assert.deepEqual(releases.map(item => item.status), ["active", "failed", "ready"]);
});

test("046: preview expiry/name ordering is deterministic and labels expired and soon values at the 24-hour boundary", () => {
  const f = fixture(); const preview = (id, name, expires) => ({ id, previewName: name, previewExpiresAt: expires, url: `https://${id}.example.test`, runtimeStatus: "online", dataBranch: null, activeRelease: null });
  const previews = [preview("c", "Charlie", null), preview("b", "Bravo", fixedNow + 86400000), preview("a", "Alpha", fixedNow), preview("d", "Delta", fixedNow + 86400001)];
  Object.assign(f.state.projectData, { previews }); f.change("preview-sort", "expiry");
  assert.deepEqual(f.q("#preview-list").children.map(row => row.children[0].children[0].textContent), ["Alpha", "Bravo", "Delta", "Charlie"]);
  assert.match(text(f.q("#preview-list").children[0]), /Expired/); assert.match(text(f.q("#preview-list").children[1]), /Expires within 24 hours/);
  assert.doesNotMatch(text(f.q("#preview-list").children[2]), /Expires within/);
  f.change("preview-sort", "expiry-desc"); assert.equal(f.q("#preview-list").children[0].children[0].children[0].textContent, "Delta");
  f.change("preview-sort", "name"); assert.deepEqual(f.q("#preview-list").children.map(row => row.children[0].children[0].textContent), ["Alpha", "Bravo", "Charlie", "Delta"]);
  assert.deepEqual(previews.map(item => item.id), ["c", "b", "a", "d"]);
});

test("047: backup ID/reason search and newest/oldest order preserve authorized verify/recovery targets and schedule", () => {
  const f = fixture(), backups = [{ id: "backup-b", reason: "manual", createdAt: 20 }, { id: "backup-a", reason: "before-deploy", createdAt: 10 }, { id: "backup-c", reason: "manual", createdAt: 30 }].map(item => ({ ...item, databaseBytes: 5, databaseRevision: 0 }));
  Object.assign(f.state.projectData, { backups, backupAutomation: { available: true, enabled: true, intervalMs: 60000, nextBackupAt: 50 } });
  f.input("backup-search", "MANUAL"); f.change("backup-sort", "oldest");
  assert.equal(f.q("#backup-count").textContent, "2 of 3 backups shown");
  assert.match(text(f.q("#backup-list").children[0]), /backup-b/);
  f.q("#backup-list").children[0].children[5].children[0].children[0].onclick(); assert.equal(f.actions[0][1], backups[0]);
  f.change("backup-sort", "newest"); assert.match(text(f.q("#backup-list").children[0]), /backup-c/);
  f.input("backup-search", "backup-a"); assert.equal(f.q("#backup-list").children.length, 1);
  f.input("backup-search", "none"); assert.match(text(f.q("#backup-list")), /No backups match/);
  assert.match(f.q("#backup-schedule").textContent, /Every 60000/);
});

test("048: usage search and metric sorting change rows only, preserving whole-month totals and CSV", async () => {
  const f = fixture(), data = usage(); f.state.usageData = data; f.context.renderUsage();
  f.change("usage-project-sort", "transfer"); assert.equal(f.q("#usage-projects").children[0].children[0].children[0].children[0].textContent, "Alpha");
  f.change("usage-project-sort", "requests"); assert.equal(f.q("#usage-projects").children[0].children[0].children[0].children[0].textContent, "Zulu");
  f.input("usage-project-search", "ALPHA"); assert.equal(f.q("#usage-project-count").textContent, "1 of 2 monthly project rows shown");
  assert.equal(f.q("#usage-requests").textContent, "40"); assert.equal(f.q("#usage-transfer").textContent, "60 B"); assert.equal(f.q("#usage-rejected").textContent, "5");
  let exported; f.context.exportConsoleUsageCsv = value => { exported = value; return { csv: "all month", filename: "usage.csv" }; };
  f.context.downloadUsageCsv(); assert.equal(exported, data); assert.equal(exported.projects.length, 2); assert.equal(await f.blobs[0].text(), "all month");
  f.input("usage-project-search", "missing"); assert.match(text(f.q("#usage-projects")), /Monthly totals and CSV are unchanged/); assert.equal(f.q("#usage-export").disabled, false);
  assert.deepEqual(data.projects.map(item => item.id), ["z", "a"]);
});

test("049: month controls use UTC year boundaries, retention bounds and no future month requests", async () => {
  const f = fixture(); f.context.renderUsageMonths();
  assert.equal(f.q("#usage-next").disabled, true); assert.equal(f.q("#usage-current").disabled, true);
  await f.q("#usage-previous").onclick(); assert.equal(f.state.usageMonth, "2025-12");
  await f.q("#usage-next").onclick(); assert.equal(f.state.usageMonth, "2026-01");
  const count = f.loads.length; await f.q("#usage-next").onclick(); assert.equal(f.loads.length, count);
  await f.context.selectUsageMonth("2099-12"); assert.equal(f.loads.at(-1)[1], "2026-01");
  await f.context.selectUsageMonth("2020-01"); assert.equal(f.state.usageMonth, "2025-02"); assert.equal(f.q("#usage-previous").disabled, true);
  const oldestCount = f.loads.length; await f.q("#usage-previous").onclick(); assert.equal(f.loads.length, oldestCount);
  await f.q("#usage-current").onclick(); assert.equal(f.state.usageMonth, "2026-01");
  await f.context.selectUsageMonth(""); assert.equal(f.state.usageMonth, ""); assert.equal(f.q("#usage-next").disabled, true);
});

test("050: native full-ID disclosures and copy actions retain exact release, backup and job IDs as text", () => {
  const f = fixture(), full = "prefix-shared-<literal>-complete-id";
  for (const kind of ["Release", "Backup", "Job"]) {
    const detail = f.context.operationalId(kind, full, 12); assert.equal(detail.tag, "details");
    assert.equal(detail.children[0].tag, "summary"); assert.match(detail.children[0].attributes["aria-label"], /Show full/);
    assert.equal(detail.children[1].textContent, full); detail.children[2].onclick();
    assert.equal(f.copies.at(-1)[0], full); assert.equal(f.copies.at(-1)[1], `${kind} ID copied.`);
    assert.equal(detail.children[2].dataset.mutation, undefined);
  }
  assert.match(lines.find(line => line.startsWith("function renderReleases(")), /operationalIdCell\("Release",release.id,12\)/);
  assert.match(lines.find(line => line.startsWith("function renderBackups(")), /operationalIdCell\("Backup",backup.id\)/);
  assert.match(lines.find(line => line.startsWith("function renderJobs(")), /operationalId\("Job",job.id\)/);
});

test("051: timestamp labels expose exact UTC milliseconds, including epoch zero, and invalid/missing values remain absent", () => {
  const f = fixture();
  for (const value of [0, 1234567890123, fixedNow]) {
    const node = f.context.consoleTime(value); assert.equal(node.tag, "time"); assert.equal(node.dateTime, new Date(value).toISOString()); assert.equal(node.title, node.dateTime); assert.notEqual(node.textContent, "—");
  }
  for (const value of [null, undefined, "", "invalid", NaN]) { const node = f.context.consoleTime(value); assert.equal(node.tag, "span"); assert.equal(node.textContent, "—"); assert.equal(node.dateTime, undefined); }
  const node = {}; f.context.titleConsoleTime(node, [0, fixedNow]); assert.equal(node.title, `1970-01-01T00:00:00.000Z – ${new Date(fixedNow).toISOString()}`);
  assert.match(lines.find(line => line.startsWith("function renderLogs(")), /time.dateTime=new Date\(log.createdAt\).toISOString\(\);time.title=time.dateTime/);
  assert.match(lines.find(line => line.startsWith("function renderActivity(")), /time.title=time.dateTime/);
});

test("043–049: controls have visible native labels, status counts and mobile layout; project changes clear only their loaded-list controls", () => {
  for (const id of ["member-search", "invitation-search", "invitation-status-filter", "invitation-scope-filter", "release-search", "release-status-filter", "release-artifact-filter", "preview-sort", "backup-search", "backup-sort", "usage-project-search", "usage-project-sort"]) assert.match(html, new RegExp(`<label>[^<]+<(?:input|select)[^>]*id="${id}"`));
  for (const id of ["member-count", "invitation-count", "release-count", "preview-count", "backup-count", "usage-project-count"]) assert.match(html, new RegExp(`id="${id}" role="status"`));
  assert.match(html, /Filters affect rows only. Totals and CSV include every project/);
  assert.match(html, /\.operational-id code\{[^}]*overflow-wrap:anywhere/);
  assert.match(lines.find(line => line.startsWith("async function openProject(")), /if\(state.currentProject!==id\)\{state.releaseSearch="";state.releaseStatus="";state.releaseArtifacts="all";state.previewSort="expiry";state.backupSearch="";state.backupSort="newest"/);
});


test("043–048: search is bounded and literal, and filters never mutate authorized input arrays", () => {
  const f = fixture(), rows = [{ id: "a", name: "<script>[literal]</script>" }, { id: "b", name: "x".repeat(200) }];
  assert.equal(f.context.searchConsoleRows(rows, "[literal]", ["name"])[0], rows[0]);
  assert.equal(f.context.searchConsoleRows(rows, "x".repeat(200) + "ignored", ["name"])[0], rows[1]);
  assert.equal(f.context.searchConsoleRows(rows, ".*", ["name"]).length, 0);
  const copy = f.context.searchConsoleRows(rows, "", ["name"]); assert.notEqual(copy, rows); assert.equal(rows.length, 2);
});

test("048: rejection ordering is numeric with deterministic ties and a new workspace clears the previous search", () => {
  const f = fixture(), data = usage(); f.state.usageData = data;
  f.change("usage-project-sort", "rejected"); assert.equal(f.q("#usage-projects").children[0].children[0].children[0].children[0].textContent, "Alpha");
  f.input("usage-project-search", "Alpha");
  f.state.usageData = { ...data, workspace: { id: "w2", slug: "other" } }; f.context.renderUsage();
  assert.equal(f.state.usageSearch, ""); assert.equal(f.state.usageSort, "default");
  assert.equal(f.q("#usage-project-search").value, ""); assert.equal(f.q("#usage-project-count").textContent, "2 of 2 monthly project rows shown");
});

test("050/051: rendered jobs disclose only operational IDs and exact timestamps while read-only actions remain disabled", () => {
  const f = fixture(); f.initial.impersonation = {};
  const job = { id: "job-complete-identifier-123456789", name: "Send mail", queue: "mail", state: "running", attempt: 1, maxAttempts: 3, leaseUntil: fixedNow, arguments: "must-not-render", result: "must-not-render", error: "must-not-render" };
  const data = { compatibility: "ready", jobs: [job], schedules: [{ name: "daily", job: "Send mail", expression: "0 0 * * *", timezone: "UTC", concurrency: "skip", enabled: true, nextRunAt: fixedNow + 1000 }], scheduleCount: 1, alertDueAfterMs: 1000 };
  f.context.renderJobs(data, true); const row = f.q("#job-list").children[0];
  assert.equal(row.children[0].children[1].children[1].textContent, job.id);
  assert.equal(row.children[4].children[1].dateTime, new Date(fixedNow).toISOString());
  assert.equal(row.children[5].children[0].disabled, true);
  assert.doesNotMatch(text(f.q("#job-list")), /must-not-render/);
  assert.equal(f.q("#schedule-list").children[0].children[3].children[0].dateTime, new Date(fixedNow + 1000).toISOString());
});
