import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentActionParityError,
  agentActionPath,
  assertAgentActionParity,
  checkAgentActionParity,
  createApi,
  h,
  inspectAgentActions,
  renderToString,
  signal,
  verifyAgentActionParity,
} from "../dist/index.js";

const revision = "mcp-0123456789abcdef0123456789abcdef";

function manifest(functions = [
  {
    name: "todos.add",
    kind: "mutation",
    agent: true,
    description: "Create a todo.",
  },
  {
    name: "todos.remove",
    kind: "mutation",
    agent: true,
    description: "Permanently delete a todo.",
  },
]) {
  return {
    protocol: "clank-live/1",
    contractRevision: revision,
    auth: true,
    functions,
    jobs: [],
  };
}

test("typed backend references serialize as exact reactive DOM and SSR action paths", async () => {
  const api = createApi();
  assert.equal(agentActionPath(api.todos.add), "todos.add");
  assert.throws(() => agentActionPath("not an action path!"), /valid backend function reference/u);

  const direct = await renderToString(
    h("button", { agentId: "todo-add", agentAction: api.todos.add }, "Add"),
  );
  assert.match(direct, /data-clank-action="todos\.add"/u);
  assert.deepEqual(inspectAgentActions(direct), [{
    path: "todos.add",
    id: "todo-add",
    tag: "button",
  }]);

  const selected = signal(api.todos.remove);
  const reactive = await renderToString(
    h("button", {
      agentId: "todo-remove",
      agentLabel: "Remove todo",
      agentAction: selected,
    }, "Remove"),
  );
  assert.deepEqual(inspectAgentActions(reactive), [{
    path: "todos.remove",
    id: "todo-remove",
    label: "Remove todo",
    tag: "button",
  }]);
});

test("action parity reports stale, internal, ambiguous, undocumented, and missing UI contracts", () => {
  const html = [
    '<button data-clank-id="shared" data-clank-action="todos.add">Add</button>',
    '<button data-clank-id="shared" data-clank-action="todos.remove">Remove</button>',
    '<button data-clank-action="todos.internal">Internal</button>',
    '<button data-clank-id="old" data-clank-action="todos.old">Old</button>',
  ].join("");
  const report = checkAgentActionParity(html, manifest([
    {
      name: "todos.add",
      kind: "mutation",
      agent: true,
      description: "Create a todo.",
    },
    {
      name: "todos.remove",
      kind: "mutation",
      agent: true,
    },
    {
      name: "todos.internal",
      kind: "mutation",
      agent: false,
      description: "Internal mutation.",
    },
    {
      name: "todos.rename",
      kind: "mutation",
      agent: true,
      description: "Rename a todo.",
    },
  ]), {
    expectedRevision: "mcp-ffffffffffffffffffffffffffffffff",
    requiredActions: ["todos.rename"],
  });
  assert.equal(report.ok, false);
  assert.equal(Object.isFrozen(report), true);
  assert.deepEqual(
    new Set(report.issues.map((issue) => issue.code)),
    new Set([
      "REVISION_MISMATCH",
      "DUPLICATE_CONTROL_ID",
      "MISSING_DESCRIPTION",
      "MISSING_CONTROL_ID",
      "INTERNAL_ACTION",
      "UNKNOWN_ACTION",
      "MISSING_UI_ACTION",
    ]),
  );
  assert.throws(
    () => assertAgentActionParity(html, manifest(), { requiredActions: ["todos.rename"] }),
    (error) =>
      error instanceof AgentActionParityError
      && error.report.issues.some((issue) => issue.code === "MISSING_UI_ACTION"),
  );

  const duplicateSameAction = checkAgentActionParity([
    '<button data-clank-id="same" data-clank-action="todos.add">First</button>',
    '<button data-clank-id="same" data-clank-action="todos.add">Second</button>',
  ].join(""), manifest());
  assert.equal(
    duplicateSameAction.issues.some((issue) => issue.code === "DUPLICATE_CONTROL_ID"),
    true,
  );
});

test("valid action parity is deterministic and distinguishes optional MCP-only tools", () => {
  const html = [
    '<button data-clank-id="todo-add" data-clank-action="todos.add">Add</button>',
    '<button data-clank-id="todo-remove" data-clank-label="Remove todo" data-clank-action="todos.remove">Remove</button>',
  ].join("");
  const report = assertAgentActionParity(html, manifest(), {
    expectedRevision: revision,
    requiredActions: [createApi().todos.add, "todos.remove"],
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.uiActions, ["todos.add", "todos.remove"]);
  assert.deepEqual(report.agentActions, ["todos.add", "todos.remove"]);
  assert.deepEqual(report.requiredActions, ["todos.add", "todos.remove"]);

  const withMcpOnly = assertAgentActionParity(html, manifest([
    ...manifest().functions,
    {
      name: "todos.export",
      kind: "query",
      agent: true,
      description: "Export todos for an authenticated agent.",
    },
  ]));
  assert.equal(withMcpOnly.ok, true);
  assert.deepEqual(withMcpOnly.agentActions, ["todos.add", "todos.export", "todos.remove"]);

  const disabled = checkAgentActionParity(html, {
    ...manifest(),
    contractRevision: null,
  });
  assert.equal(disabled.issues[0].code, "MCP_DISABLED");
});

test("DOM root controls and pre-inspected controls share the same normalized contract", () => {
  const attributes = new Map([
    ["data-clank-action", "todos.add"],
    ["data-clank-id", "todo-add"],
    ["aria-label", "Create todo"],
  ]);
  const rootControl = {
    localName: "button",
    getAttribute: (name) => attributes.get(name) ?? null,
    querySelectorAll: () => [],
  };
  assert.deepEqual(inspectAgentActions(rootControl), [{
    path: "todos.add",
    id: "todo-add",
    label: "Create todo",
    tag: "button",
  }]);

  const report = assertAgentActionParity([{
    path: createApi().todos.add.path,
    id: "todo-add",
    label: "Create todo",
    tag: "button",
  }], manifest());
  assert.equal(report.ok, true);
  assert.equal(Object.isFrozen(report.controls[0]), true);
});

test("remote parity verification bypasses caches, binds the revision header, and bounds input", async () => {
  const html = '<button data-clank-id="todo-add" data-clank-action="todos.add">Add</button>';
  let observed;
  const report = await verifyAgentActionParity(html, {
    requiredActions: [createApi().todos.add],
    fetch: async (url, options) => {
      observed = { url, options };
      return Response.json(manifest(), {
        headers: { "x-clank-contract-revision": revision },
      });
    },
  });
  assert.equal(report.ok, true);
  assert.equal(observed.url, "/__clank/manifest");
  assert.equal(observed.options.cache, "no-store");
  assert.equal(observed.options.credentials, "same-origin");

  await assert.rejects(
    verifyAgentActionParity(html, {
      fetch: async () => Response.json(manifest(), {
        headers: {
          "x-clank-contract-revision": "mcp-ffffffffffffffffffffffffffffffff",
        },
      }),
    }),
    (error) =>
      error instanceof AgentActionParityError
      && error.report.issues[0].code === "REVISION_MISMATCH",
  );

  await assert.rejects(
    verifyAgentActionParity(html, {
      maxManifestBytes: 8,
      fetch: async () => new Response(JSON.stringify(manifest()), {
        headers: { "content-length": "999" },
      }),
    }),
    /exceeds 8 bytes/u,
  );

  await assert.rejects(
    verifyAgentActionParity(html, {
      fetch: async () => new Response("Unavailable", { status: 503 }),
    }),
    /failed with 503/u,
  );

  await assert.rejects(
    verifyAgentActionParity(html, {
      maxManifestBytes: 8,
      fetch: async () => new Response("x".repeat(9)),
    }),
    /exceeds 8 bytes/u,
  );

  await assert.rejects(
    verifyAgentActionParity(html, {
      maxManifestBytes: 0,
      fetch: async () => Response.json(manifest()),
    }),
    /positive integer/u,
  );
});

test("manifest and surface parsers reject malformed or excessive contracts", () => {
  assert.throws(
    () => checkAgentActionParity("", {
      protocol: "clank-live/1",
      contractRevision: revision,
      functions: [
        {
          name: "todos.add",
          kind: "mutation",
          agent: true,
          description: "One.",
        },
        {
          name: "todos.add",
          kind: "mutation",
          agent: true,
          description: "Two.",
        },
      ],
    }),
    /repeats todos\.add/u,
  );
  assert.throws(
    () => inspectAgentActions(`<button data-clank-action="todos.add">${"x".repeat(8 * 1024 * 1024)}</button>`),
    /may not exceed/u,
  );
  assert.throws(
    () => checkAgentActionParity(
      Array.from({ length: 10_001 }, () => ({
        path: "todos.add",
        id: "todo-add",
        tag: "button",
      })),
      manifest(),
    ),
    /at most 10000 controls/u,
  );
  assert.throws(
    () => checkAgentActionParity("", manifest(), {
      requiredActions: Array.from({ length: 2_049 }, () => "todos.add"),
    }),
    /at most 2048 actions/u,
  );
});
