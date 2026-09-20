import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { platformConsolePage } from "../dist/platform-console.js";
import { exportConsoleUsageCsv } from "../dist/platform-console-usage-export.js";

const sample = () => ({
  workspace: { id: "workspace-1", slug: "design-team" },
  period: { key: "2026-09", current: true, complete: true, trackingStartedAt: 1 },
  usage: { requests: 23, knownTransferBytes: 9876, rejectedRequests: 4 },
  limits: { requests: 100, knownTransferBytes: 10000, requestsPerMinutePerProject: 40 },
  resources: { projects: 1, previews: 1, members: 1, domains: 0, releases: 2, releaseStorageBytes: 30, asOf: 1 },
  projects: [
    { name: 'Docs, "guide"\nsite', slug: "docs", kind: "production", deleted: false, requests: 20, knownTransferBytes: 9876, rejectedRequests: 3, updatedAt: 1000 },
    { name: "Old preview", slug: "pull-7", kind: "preview", deleted: true, requests: 3, knownTransferBytes: 0, rejectedRequests: 1, updatedAt: null },
  ],
});

async function fixture() {
  const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
  const nodes = new Map(), timers = new Map(), events = new Map();
  const links = [], blobs = [], revoked = [], toasts = [], requests = [];
  const initial = { authenticated: true };
  const state = { dashboard: { organizations: [{ id: "workspace-1" }] }, usageWorkspaceId: "workspace-1", usageMonth: "2026-09", usageData: sample(), usageLoading: false, usageGeneration: 0 };
  const element = (tag, className, text = "") => ({
    tag, className, textContent: String(text), children: [], value: "", style: {}, hidden: false,
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
    remove() { this.removed = true; },
    click() { if (context.clickFails) throw new Error("Download blocked"); this.clicked = true; },
  });
  const context = {
    state, initial, exportConsoleUsageCsv, usageExportUrls: new Map(),
    q(selector) { if (!nodes.has(selector)) nodes.set(selector, element("div")); return nodes.get(selector); },
    el(tag, className, text) { const node = element(tag, className, text); if (tag === "a") links.push(node); return node; },
    clear(node) { node.children = []; },
    tableCell(label, text) { const node = element("td", null, text); node.label = label; return node; },
    labelTableCell(node, label) { node.label = label; return node; },
    formatExactNumber: value => String(value), formatBytes: value => `${value} B`, formatDate: value => value === null ? "—" : new Date(value).toISOString(),
    toast: (...args) => toasts.push(args),
    URL: {
      createObjectURL(blob) { if (context.blobFails) throw new Error("Blob unavailable"); blobs.push(blob); return `blob:usage-${blobs.length}`; },
      revokeObjectURL: url => revoked.push(url),
    },
    Blob,
    document: { body: element("body") },
    window: { addEventListener: (name, callback) => events.set(name, callback) },
    setTimeout(callback, delay) { const id = timers.size + 1; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    handleAuthFailure: error => { if (error.status === 401) { initial.authenticated = false; return true; } return false; },
    loadDashboard: async () => { state.usageWorkspaceId = null; },
    api: path => new Promise((resolve, reject) => requests.push({ path, resolve, reject })),
  };
  const names = ["searchConsoleRows", "compareConsoleText", "consoleTime", "consoleTimeCell", "visibleUsageProjects", "usageMonthBounds", "renderUsageMonths", "selectUsageMonth", "moveUsageMonth", "canExportUsage", "renderUsageExport", "downloadUsageCsv", "loadUsage", "clearUsageView", "setUsageProgress", "renderUsage"];
  const functions = names.map(name => html.match(new RegExp(`(?:async )?function ${name}\\([^\\n]+`))[0]).join("\n");
  const handlers = html.split("\n").filter(line => /^q\("#usage-(?:export|workspace|month)"\)\./.test(line) || line.startsWith('window.addEventListener("pagehide"')).join("\n");
  runInNewContext(`${functions}\n${handlers}`, context);
  context.renderUsage();
  return { html, context, state, initial, nodes, timers, events, links, blobs, revoked, toasts, requests,
    click: () => context.q("#usage-export").onclick(),
    load: () => context.loadUsage(false),
  };
}

test("usage export preserves displayed projects, deleted previews, exact counts, quotes, and newlines", () => {
  const data = sample(), result = exportConsoleUsageCsv(data);
  assert.equal(result.filename, "usage-design-team-2026-09.csv");
  assert.equal(result.csv,
    '"Project","Slug","Type","Deleted","Requests","Known transfer bytes","Rejected requests","Last recorded (UTC)"\r\n' +
    '"Docs, ""guide""\nsite","docs","production","no","20","9876","3","1970-01-01T00:00:01.000Z"\r\n' +
    '"Old preview","pull-7","preview","yes","3","0","1",""\r\n');
  assert.equal(data.projects.length, 2);
  assert.equal(data.projects[0].name, 'Docs, "guide"\nsite');
});

test("usage text prevents spreadsheet formulas behind whitespace and control prefixes", () => {
  for (const text of ["=1+1", "+cmd", "-7", "@SUM(A1)", " \t\u0000=1", "\u007f @cmd", "\u0085=1", "\ufeff+cmd", "\nhello", "\ttext", "\rtext", "\u00a0-1"]) {
    const data = sample();
    data.projects = [{ ...data.projects[0], name: text, slug: text, kind: text }];
    assert.ok(exportConsoleUsageCsv(data).csv.includes(`"'${text}","'${text}","'${text}"`), JSON.stringify(text));
  }
  for (const invalid of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const data = sample(); data.projects[0].requests = invalid;
    assert.throws(() => exportConsoleUsageCsv(data), /Invalid usage count/);
  }
  const data = sample(); data.projects[0].updatedAt = NaN;
  assert.throws(() => exportConsoleUsageCsv(data), RangeError);
});

test("usage filenames are deterministic, bounded, and contain no path or CSV cell content", () => {
  const data = sample(); data.workspace.slug = '../../=bad\r\n' + 'x'.repeat(200);
  const result = exportConsoleUsageCsv(data);
  assert.match(result.filename, /^usage-[A-Za-z0-9_-]{1,64}-2026-09\.csv$/);
  assert.equal(exportConsoleUsageCsv(data).filename, result.filename);
  data.workspace.slug = "";
  assert.equal(exportConsoleUsageCsv(data).filename, "usage-workspace-2026-09.csv");
  for (const month of ["2026-00", "2026-13", "../report", "2026-09\n"]) {
    data.period.key = month;
    assert.throws(() => exportConsoleUsageCsv(data), /Invalid usage month/);
  }
});

test("Usage CSV click downloads the actual rendered rows without another API call and cleans up", async () => {
  const f = await fixture();
  assert.match(f.html, /id="usage-export" type="button" disabled>Download CSV<\/button>/);
  assert.equal(f.context.q("#usage-export").disabled, false);
  assert.equal(f.context.q("#usage-projects").children.length, 2);
  assert.equal(f.context.q("#usage-projects").children[1].children[0].children[0].children[1].textContent, "pull-7 · deleted");
  f.click();
  assert.equal(f.requests.length, 0);
  assert.equal(f.links[0].download, "usage-design-team-2026-09.csv");
  assert.equal(f.links[0].clicked, true);
  assert.equal(f.links[0].removed, true);
  assert.equal(f.blobs[0].type, "text/csv;charset=utf-8");
  assert.equal(await f.blobs[0].text(), exportConsoleUsageCsv(f.state.usageData).csv);
  assert.deepEqual(f.toasts, [["CSV download started (2 project rows)."]]);
  assert.equal(f.timers.get(1).delay, 30000);
  assert.deepEqual(f.revoked, []);
  f.timers.get(1).callback();
  assert.deepEqual(f.revoked, ["blob:usage-1"]);
  assert.equal(f.context.usageExportUrls.size, 0);
  f.click();
  f.events.get("pagehide")();
  assert.deepEqual(f.revoked, ["blob:usage-1", "blob:usage-2"]);
  assert.equal(f.context.usageExportUrls.size, 0);
});

test("empty, loading, unauthorized, and mismatched selections cannot export a stale snapshot", async () => {
  for (const update of [
    f => { f.state.usageData = null; },
    f => { f.state.usageData.projects = []; },
    f => { f.state.usageLoading = true; },
    f => { f.initial.authenticated = false; },
    f => { f.state.dashboard.organizations = []; },
    f => { f.state.usageWorkspaceId = "workspace-2"; },
    f => { f.state.usageMonth = "2026-08"; },
    f => { f.context.q("#usage-workspace").value = "workspace-2"; },
    f => { f.context.q("#usage-month").value = ""; },
  ]) {
    const f = await fixture(); update(f); f.context.renderUsageExport(); f.click();
    assert.equal(f.context.q("#usage-export").disabled, true);
    assert.equal(f.links.length, 0);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.toasts, []);
  }
});

test("download setup and click failures report failure and revoke any allocated URL", async () => {
  for (const failure of ["blobFails", "clickFails", "invalidData"]) {
    const f = await fixture();
    if (failure === "invalidData") f.state.usageData.projects[0].requests = NaN;
    else f.context[failure] = true;
    f.click();
    assert.deepEqual(f.toasts, [["CSV download could not be started. Try again.", true]]);
    assert.equal(f.timers.size, 0);
    assert.equal(f.context.usageExportUrls.size, 0);
    assert.deepEqual(f.revoked, failure === "clickFails" ? ["blob:usage-1"] : []);
    if (failure === "clickFails") assert.equal(f.links[0].removed, true);
  }
});

test("loading and failed refresh disable export, while matching successful refresh restores it", async () => {
  const f = await fixture();
  const pending = f.load();
  assert.equal(f.context.q("#usage-export").disabled, true);
  f.click(); assert.equal(f.links.length, 0);
  f.requests[0].reject(new Error("Network unavailable")); await pending;
  assert.equal(f.state.usageData, null);
  assert.equal(f.context.q("#usage-export").disabled, true);
  const next = f.load(); f.requests[1].resolve(sample()); await next;
  assert.equal(f.context.q("#usage-export").disabled, false);
  assert.equal(f.state.usageLoading, false);
  f.click(); assert.equal(f.links.length, 1);
});

test("changing month invalidates an in-flight export snapshot including a cleared month input", async () => {
  const f = await fixture();
  const old = f.load();
  f.context.q("#usage-month").value = "2026-08";
  f.context.q("#usage-month").onchange();
  assert.equal(f.state.usageData, null);
  f.requests[0].resolve(sample()); await old;
  assert.equal(f.state.usageData, null);
  const selected = sample(); selected.period.key = "2026-08";
  f.requests[1].resolve(selected);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.usageData.period.key, "2026-08");
  assert.equal(f.context.q("#usage-export").disabled, false);
  const later = f.load();
  f.context.q("#usage-month").value = "";
  f.context.q("#usage-month").onchange();
  assert.equal(f.context.q("#usage-page")["aria-busy"], undefined);
  f.requests[2].resolve(selected); await later;
  assert.equal(f.state.usageData, null);
  assert.equal(f.context.q("#usage-export").disabled, true);
});

test("response scope mismatch and revoked membership cannot export data", async () => {
  const f = await fixture();
  const wrong = f.load(), data = sample(); data.workspace.id = "another-workspace";
  f.requests[0].resolve(data); await wrong;
  assert.equal(f.state.usageData, null);
  assert.equal(f.context.q("#usage-export").disabled, true);
  const removed = f.load(); f.requests[1].reject(Object.assign(new Error("Forbidden"), { status: 404 })); await removed;
  assert.equal(f.state.usageData, null);
  assert.equal(f.state.usageWorkspaceId, null);
  assert.equal(f.context.q("#usage-export").disabled, true);
  f.click(); assert.equal(f.blobs.length, 0);
});

test("workspace changes keep late responses out of the selected workspace export", async () => {
  const f = await fixture();
  f.state.dashboard.organizations.push({ id: "workspace-2" });
  const old = f.load();
  f.context.q("#usage-workspace").value = "workspace-2";
  f.context.q("#usage-workspace").onchange();
  f.requests[0].resolve(sample()); await old;
  assert.equal(f.state.usageData, null);
  assert.equal(f.context.q("#usage-export").disabled, true);
  const selected = sample(); selected.workspace = { id: "workspace-2", slug: "second-team" };
  selected.projects = [selected.projects[1]];
  f.requests[1].resolve(selected);
  await new Promise(resolve => setImmediate(resolve));
  f.click();
  assert.equal(f.links[0].download, "usage-second-team-2026-09.csv");
  const csv = await f.blobs[0].text();
  assert.ok(csv.includes('"Old preview"'));
  assert.ok(!csv.includes('"Docs'));
});
