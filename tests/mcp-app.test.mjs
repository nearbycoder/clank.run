import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMcpAppTheme,
  createMcpAppDocument,
  createMcpAppClient,
  mcpAppClientScript,
  MCP_APPS_PROTOCOL_VERSION,
} from "../dist/index.js";

function messageHarness() {
  const listeners = new Set();
  const sent = [];
  const target = {
    postMessage(message, origin) {
      sent.push({ message, origin });
    },
  };
  return {
    sent,
    target,
    environment: {
      target,
      source: {
        addEventListener(type, listener) {
          assert.equal(type, "message");
          listeners.add(listener);
        },
        removeEventListener(type, listener) {
          assert.equal(type, "message");
          listeners.delete(listener);
        },
      },
    },
    emit(data, source = target) {
      for (const listener of [...listeners]) listener({ data, source });
    },
    respond(request, result) {
      this.emit({ jsonrpc: "2.0", id: request.id, result });
    },
    get listeners() { return listeners.size; },
  };
}

test("dependency-free MCP App clients initialize and use host capabilities", async () => {
  const harness = messageHarness();
  const events = [];
  const client = createMcpAppClient({
    name: "todo-board",
    version: "2.0.0",
    availableDisplayModes: ["inline", "fullscreen"],
    onToolInput: (input, partial) => events.push(["input", input, partial]),
    onToolResult: (result) => events.push(["result", result]),
    onToolCancelled: (reason) => events.push(["cancelled", reason]),
    onHostContext: (context) => events.push(["context", context.theme]),
  }, harness.environment);

  const connecting = client.connect();
  const initialize = harness.sent.at(-1).message;
  assert.equal(initialize.method, "ui/initialize");
  assert.equal(initialize.params.protocolVersion, MCP_APPS_PROTOCOL_VERSION);
  assert.deepEqual(initialize.params.appCapabilities.availableDisplayModes, ["inline", "fullscreen"]);
  harness.respond(initialize, {
    protocolVersion: MCP_APPS_PROTOCOL_VERSION,
    hostInfo: { name: "mcpjam", version: "1.0.0" },
    hostCapabilities: { serverTools: {}, serverResources: {}, openLinks: {} },
    hostContext: {
      theme: "dark",
      platform: "web",
      availableDisplayModes: ["inline", "fullscreen"],
    },
  });
  const host = await connecting;
  assert.equal(host.hostInfo.name, "mcpjam");
  assert.equal(client.connected, true);
  assert.equal(client.hostContext.theme, "dark");
  assert.equal(harness.sent.at(-1).message.method, "ui/notifications/initialized");

  const calling = client.callTool("todos_add", { title: "From UI" });
  const toolCall = harness.sent.at(-1).message;
  assert.deepEqual(toolCall.params, { name: "todos_add", arguments: { title: "From UI" } });
  harness.respond(toolCall, { structuredContent: { id: "todo-1" } });
  assert.deepEqual(await calling, { structuredContent: { id: "todo-1" } });

  const reading = client.readResource("clank://actions");
  const read = harness.sent.at(-1).message;
  harness.respond(read, { contents: [] });
  assert.deepEqual(await reading, { contents: [] });

  const display = client.requestDisplayMode("fullscreen");
  const displayRequest = harness.sent.at(-1).message;
  harness.respond(displayRequest, { mode: "fullscreen" });
  assert.equal(await display, "fullscreen");
  await assert.rejects(client.requestDisplayMode("pip"), /not declared/u);

  harness.emit({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-input-partial",
    params: { arguments: { title: "Par" } },
  });
  harness.emit({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-input",
    params: { arguments: { title: "Party" } },
  });
  harness.emit({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { ok: true } },
  });
  harness.emit({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-cancelled",
    params: { reason: "user action" },
  });
  harness.emit({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { theme: "light" },
  });
  assert.deepEqual(events.slice(-5), [
    ["input", { title: "Par" }, true],
    ["input", { title: "Party" }, false],
    ["result", { structuredContent: { ok: true } }],
    ["cancelled", "user action"],
    ["context", "light"],
  ]);
  assert.equal(client.hostContext.platform, "web");
  assert.equal(client.hostContext.theme, "light");
  harness.emit({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { availableDisplayModes: ["inline"] },
  });
  await assert.rejects(client.requestDisplayMode("fullscreen"), /not available/u);

  client.sendSizeChanged({ width: 420, height: 240 });
  assert.equal(harness.sent.at(-1).message.method, "ui/notifications/size-changed");
  client.requestTeardown();
  assert.equal(harness.sent.at(-1).message.method, "ui/notifications/request-teardown");
  client.close();
  assert.equal(client.connected, false);
  assert.equal(harness.listeners, 0);
});

test("MCP App clients reject untrusted messages and honor host teardown", async () => {
  const harness = messageHarness();
  let tornDown = false;
  const client = createMcpAppClient({
    name: "secure-view",
    onTeardown: () => { tornDown = true; },
  }, harness.environment);
  const connecting = client.connect();
  const initialize = harness.sent.at(-1).message;
  harness.emit({
    jsonrpc: "2.0",
    id: initialize.id,
    result: {
      protocolVersion: MCP_APPS_PROTOCOL_VERSION,
      hostInfo: { name: "attacker", version: "1" },
      hostCapabilities: {},
      hostContext: {},
    },
  }, { postMessage() {} });
  assert.equal(client.connected, false);
  harness.respond(initialize, {
    protocolVersion: MCP_APPS_PROTOCOL_VERSION,
    hostInfo: { name: "trusted", version: "1" },
    hostCapabilities: {},
    hostContext: {},
  });
  await connecting;

  harness.emit({ jsonrpc: "2.0", id: "ping-1", method: "ping", params: {} });
  assert.deepEqual(harness.sent.at(-1).message, { jsonrpc: "2.0", id: "ping-1", result: {} });
  harness.emit({ jsonrpc: "2.0", id: 91, method: "unknown/method", params: {} });
  assert.equal(harness.sent.at(-1).message.error.code, -32601);
  harness.emit({ jsonrpc: "2.0", id: 92, method: "ui/resource-teardown", params: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(tornDown, true);
  assert.equal(harness.sent.at(-1).message.id, 92);
  assert.equal(client.connected, false);
});

test("MCP App helpers validate outbound requests and apply safe host tokens", async () => {
  const harness = messageHarness();
  assert.throws(() => createMcpAppClient({ name: "x", requestTimeoutMs: 20 }, harness.environment), /requestTimeoutMs/u);
  const client = createMcpAppClient({ name: "validation" }, harness.environment);
  await assert.rejects(client.callTool("todos_list"), /Connect/u);
  const connecting = client.connect();
  const initialize = harness.sent.at(-1).message;
  harness.respond(initialize, {
    protocolVersion: MCP_APPS_PROTOCOL_VERSION,
    hostInfo: { name: "host", version: "1" },
    hostCapabilities: {},
    hostContext: {},
  });
  await connecting;
  await assert.rejects(client.openLink("javascript:alert(1)"), /http or https/u);
  await assert.rejects(client.downloadFile([]), /at least one/u);
  await assert.rejects(client.sendMessage([]), /content blocks/u);
  assert.throws(() => client.sendSizeChanged({ width: -1 }), /non-negative/u);

  const values = new Map();
  const root = {
    dataset: {},
    style: {
      setProperty(name, value) { values.set(name, value); },
      removeProperty(name) { values.delete(name); },
    },
  };
  applyMcpAppTheme({
    theme: "dark",
    styles: { variables: {
      "--color-background-primary": "#000",
      "--unsafe-property": "url(https://evil.test)",
    } },
  }, root);
  assert.equal(root.dataset.mcpTheme, "dark");
  assert.equal(values.get("--color-background-primary"), "#000");
  assert.equal(values.has("--unsafe-property"), false);
  client.close();
});

test("MCP App documents inline a usable runtime without external assets", async () => {
  const runtime = mcpAppClientScript();
  const sandbox = {};
  Function("globalThis", runtime)(sandbox);
  assert.equal(typeof sandbox.ClankMcpApp.createMcpAppClient, "function");
  assert.equal(sandbox.ClankMcpApp.MCP_APPS_PROTOCOL_VERSION, MCP_APPS_PROTOCOL_VERSION);

  const document = createMcpAppDocument({
    title: "Todos <Board>",
    body: "<main id=app>\n  <h1>Todos</h1>\n</main>",
    styles: "body {\n  margin: 0;\n}</style><p>not markup</p>",
    script: "globalThis.started = true;\n</script><p>not markup</p>",
    language: "en-US",
  });
  assert.match(document, /^<!doctype html><html lang="en-US">/u);
  assert.match(document, /<title>Todos &lt;Board&gt;<\/title>/u);
  assert.equal(document.includes("https://"), false);
  assert.equal(document.includes("</style><p>not markup</p>"), false);
  assert.equal(document.includes("</script><p>not markup</p>"), false);
  assert.match(document, /globalThis\.ClankMcpApp/u);
  assert.throws(() => createMcpAppDocument({ title: "Bad", body: "ok", language: "not_a_tag" }), /language/u);
  assert.throws(() => createMcpAppDocument({ title: "Bad", body: "<main>\u0000</main>" }), /source text/u);
});
