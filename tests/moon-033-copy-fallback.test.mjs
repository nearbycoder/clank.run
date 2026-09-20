import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { compile } from "../scripts/compiler.mjs";

const directory = await mkdtemp(join(tmpdir(), "clank-copy-fallback-"));
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
const html = await platformConsolePage("http://localhost", { user: null, csrfToken: null }, "", false, false).text();
const lines = html.split("\n");
const line = prefix => {
  const found = lines.find(value => value.startsWith(prefix));
  assert.ok(found, `missing console fixture: ${prefix}`);
  return found;
};
const source = [
  line("async function copyRenderedText("), line("function dnsStep("), line("function clearWorkspaceView("),
  line("function invitationFallbackCopy("), line("function syncRevealedInvitation("), line("async function api("),
  line('q("#copy-invite").onclick='), line('q("#copy-runner-enrollment").onclick='), line('q("#copy-project-url").onclick='),
].join("\n");

function fixture(navigator = {}) {
  const nodes = new Map(), toasts = [], requests = [], ranges = [];
  let focused = null;
  function element(tag = "div", className, text = "") {
    const node = {
      tag, className, textContent: String(text), children: [], parentElement: null, hidden: false, rendered: true, visibility: "visible",
      isConnected: true, disabled: false, tabIndex: tag === "input" || tag === "a" ? 0 : -1, attributes: {},
      append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
      closest(selector) { assert.equal(selector, "[hidden]"); for (let current = this; current; current = current.parentElement) if (current.hidden) return current; return null; },
      getClientRects() { return this.rendered ? [{}] : []; },
      focus() { focused = this; },
    };
    if (tag === "input") Object.assign(node, {
      value: "", select() { this.selected = this.value; },
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    });
    return node;
  }
  function q(selector) {
    if (!nodes.has(selector)) nodes.set(selector, element(selector.endsWith("-token") ? "input" : selector === "#project-url" ? "a" : "div"));
    return nodes.get(selector);
  }
  const state = { revealedInvitationId: "invitation-one", workspaceData: { organization: { id: "alpha" } } };
  const initial = { authenticated: true, impersonation: null, csrfToken: "test-csrf" };
  const context = {
    navigator, q, el: element, state, initial, toast: (...args) => toasts.push(args), clear: node => { node.children = []; },
    document: {
      createTextNode: text => element("#text", null, text),
      createRange: () => ({ selectNodeContents(node) { this.node = node; } }),
    },
    window: { getComputedStyle: node => ({ visibility: node.visibility }), getSelection: () => ({ removeAllRanges() { ranges.length = 0; }, addRange(range) { ranges.push(range); } }) },
    async fetch(path, options) { requests.push({ path, options }); return { ok: true, json: async () => ({}) }; },
  };
  runInNewContext(source, context);
  q("#workspace-page").append(q("#invite-panel"));
  q("#invite-panel").append(q("#invite-secret"));
  q("#invite-secret").append(q("#invite-token"));
  q("#runner-enrollment-secret").append(q("#runner-enrollment-token"));
  q("#invite-token").value = "clnki_visible_invitation_only";
  q("#runner-enrollment-token").value = "clnkr_visible_enrollment_only";
  q("#project-url").textContent = "https://project.example.test/a?x=1&y=2";
  q("#project-url").href = "https://other.example.test/not-the-rendered-url";
  const record = { type: "TXT", name: "_clank.example.test", value: 'clank-domain=a<&" exact value' };
  const dns = context.dnsStep(1, "Verify ownership", record);
  const value = dns.children[1].children[5];
  record.value = "a-new-response-must-not-replace-the-rendered-value";
  const cases = [
    { button: q("#copy-invite"), source: q("#invite-token"), success: "Invitation token copied." },
    { button: q("#copy-runner-enrollment"), source: q("#runner-enrollment-token"), success: "Runner enrollment token copied." },
    { button: q("#copy-project-url"), source: q("#project-url"), success: "Project URL copied." },
    { button: dns.children[2], source: value, success: "DNS value copied." },
  ];
  return { q, cases, context, state, initial, navigator, toasts, requests, ranges, get focused() { return focused; } };
}

test("all four console copy actions share one clipboard boundary and tokens retain accessible inputs", () => {
  assert.equal((html.match(/navigator\.clipboard/g) || []).length, 1);
  assert.equal((html.match(/\.writeText\(/g) || []).length, 1);
  for (const [id, label] of [["invite-token", "Invitation token"], ["runner-enrollment-token", "Runner enrollment token"]]) {
    assert.match(html, new RegExp(`<input[^>]*id="${id}"[^>]*readonly[^>]*aria-label="${label}"`));
  }
});

test("every copy action writes exact rendered text and announces success only after the clipboard resolves", async () => {
  for (let index = 0; index < 4; index++) {
    let resolve;
    const writes = [];
    const clipboard = { writeText(text) { assert.equal(this, clipboard); writes.push(text); return new Promise(done => { resolve = done; }); } };
    const f = fixture({ clipboard });
    const { button, source, success } = f.cases[index];
    const pending = button.onclick();
    assert.deepEqual(writes, [source.value ?? source.textContent]);
    assert.equal(f.toasts.length, 0);
    assert.equal(f.focused, null);
    resolve();
    await pending;
    assert.deepEqual(f.toasts, [[success]]);
    assert.equal(f.requests.length, 0);
  }
});

test("absent, inaccessible, throwing and denied clipboard APIs select exact text for every action", async () => {
  const unavailable = [
    () => ({}),
    () => ({ clipboard: {} }),
    () => ({ clipboard: { writeText() { throw new Error("Clipboard blocked"); } } }),
    () => ({ clipboard: { writeText: async () => { throw new Error("Permission denied"); } } }),
    () => Object.defineProperty({}, "clipboard", { get() { throw new Error("Clipboard access denied"); } }),
  ];
  for (const navigator of unavailable) {
    for (let index = 0; index < 4; index++) {
      const f = fixture(navigator());
      const { button, source } = f.cases[index];
      await button.onclick();
      assert.equal(f.focused, source);
      if (source.tag === "input") {
        assert.equal(source.selected, source.value);
        assert.equal(source.selectionStart, 0);
        assert.equal(source.selectionEnd, source.value.length);
      } else {
        assert.equal(f.ranges.length, 1);
        assert.equal(f.ranges[0].node, source);
        assert.equal(source.tabIndex, source.tag === "a" ? 0 : -1, "URL stays keyboard reachable");
      }
      assert.deepEqual(f.toasts, [["Clipboard unavailable. Text selected; use your device's Copy command.", true]]);
      assert.equal(f.requests.length, 0);
    }
  }
});

test("empty, hidden, CSS-hidden and detached sources never reach the clipboard or manual fallback", async () => {
  for (const hide of [source => { source.hidden = true; }, source => { source.rendered = false; }, source => { source.visibility = "hidden"; }, source => { source.isConnected = false; }, source => { if (source.tag === "input") source.value = ""; else source.textContent = ""; }]) {
    for (let index = 0; index < 4; index++) {
      const writes = [];
      const f = fixture({ clipboard: { writeText: async text => writes.push(text) } });
      const { button, source } = f.cases[index];
      hide(source);
      await button.onclick();
      assert.deepEqual(writes, []);
      assert.equal(f.focused, null);
      assert.deepEqual(f.toasts, []);
    }
  }
  const f = fixture({ get clipboard() { assert.fail("hidden ancestors must prevent even clipboard access"); } });
  f.q("#invite-secret").hidden = true;
  f.q("#runner-enrollment-secret").hidden = true;
  await f.cases[0].button.onclick();
  await f.cases[1].button.onclick();
  assert.equal(f.q("#invite-token").value, "clnki_visible_invitation_only");
  assert.equal(f.toasts.length, 0);
});

test("late clipboard outcomes do not select, restore or announce replaced and hidden sources", async () => {
  for (const succeed of [false, true]) {
    for (const change of [source => { source.hidden = true; }, source => { source.visibility = "hidden"; }, source => { source.isConnected = false; }, source => { if (source.tag === "input") source.value = "replacement"; else source.textContent = "replacement"; }]) {
      for (let index = 0; index < 4; index++) {
        let resolve, reject;
        const f = fixture({ clipboard: { writeText: () => new Promise((yes, no) => { resolve = yes; reject = no; }) } });
        const { button, source } = f.cases[index];
        const pending = button.onclick();
        change(source);
        if (succeed) resolve(); else reject(new Error("Permission denied"));
        await pending;
        assert.equal(f.focused, null);
        assert.deepEqual(f.toasts, []);
        assert.equal(f.ranges.length, 0);
      }
    }
  }
});

test("invitation retirement and workspace clearing retain the existing token lifetime during copy failure", async () => {
  for (const clear of [f => f.context.syncRevealedInvitation([]), f => f.context.clearWorkspaceView()]) {
    let reject;
    const f = fixture({ clipboard: { writeText: () => new Promise((_, no) => { reject = no; }) } });
    const pending = f.q("#copy-invite").onclick();
    clear(f);
    reject(new Error("Permission denied"));
    await pending;
    assert.equal(f.state.revealedInvitationId, null);
    assert.equal(f.q("#invite-token").value, "");
    assert.equal(f.q("#invite-secret").hidden, true);
    assert.equal(f.focused, null);
    assert.equal(f.toasts.length, 0);
  }
});

test("fallback selection errors remain handled and never report a successful copy", async () => {
  const f = fixture();
  f.q("#invite-token").select = () => { throw new Error("Selection not supported"); };
  await f.q("#copy-invite").onclick();
  assert.deepEqual(f.toasts, [["Clipboard unavailable. Select the visible text and copy it manually.", true]]);
});

test("copy fallback does not weaken read-only mutation blocking or CSRF headers", async () => {
  const f = fixture();
  f.initial.impersonation = { actor: "operator" };
  await f.q("#copy-project-url").onclick();
  assert.equal(f.focused, f.q("#project-url"));
  await assert.rejects(f.context.api("/api/projects", { method: "POST", body: {} }), { code: "IMPERSONATION_READ_ONLY", status: 403 });
  assert.equal(f.requests.length, 0);
  f.initial.impersonation = null;
  await f.context.api("/api/projects", { method: "POST", body: {} });
  assert.equal(f.requests[0].options.headers["x-clank-csrf"], "test-csrf");
});
