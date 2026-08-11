# Interactive MCP Apps

Clank can render an application's typed server actions as interactive views inside MCP hosts.
An MCP App is still an ordinary tool with a useful text and structured-data result. It additionally
points to an immutable `ui://` HTML resource that a compatible host renders in a sandboxed iframe.
Clients without MCP Apps support keep the normal text fallback.

Clank implements the [stable `2026-01-26` MCP Apps extension](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
without adding a package dependency.
It provides:

- `defineMcpApp()` for validated immutable HTML resources;
- `createMcpAppDocument()` for a standalone HTML5 view with the bridge runtime inlined;
- `agent.app` for binding one shared view to backend queries and mutations;
- negotiated `_meta.ui.resourceUri` and visibility metadata in `tools/list`;
- exact `text/html;profile=mcp-app` resources through `resources/list` and `resources/read`;
- CSP, browser-permission, dedicated-domain, and border-preference declarations; and
- `createMcpAppClient()` for tool calls, resource reads, host context, theming, display modes,
  sizing, messages, downloads, and teardown over the standard iframe JSON-RPC channel.

There is no second API. Calls made by the embedded view go through the MCP host to the same Clank
query or mutation used by the browser and model.

## Build a view

Define the view once, outside the backend function tree:

```ts
import {
  createMcpAppDocument,
  defineMcpApp,
} from "@clank.run/framework";

export const todoBoard = defineMcpApp({
  uri: "ui://todos/board",
  name: "todo_board",
  title: "Todo board",
  description: "Interactive todos for the signed-in user.",
  prefersBorder: true,

  // Omit CSP domains when the view uses only its inline code and host-proxied
  // MCP calls. The host then applies the restrictive specification default.
  csp: {
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  },

  html: createMcpAppDocument({
    title: "Todo board",
    body: `
      <main>
        <header><h1>Todos</h1><span id="status">Connecting…</span></header>
        <form id="add-form">
          <input id="title" maxlength="160" aria-label="New todo" required>
          <button>Add</button>
        </form>
        <ul id="todos"></ul>
      </main>
    `,
    styles: `
      :root { color-scheme: light dark; font-family: var(--font-sans, system-ui); }
      body { margin: 0; color: var(--color-text-primary, CanvasText); background: transparent; }
      main { display: grid; gap: 12px; padding: 16px; }
      header, form, li { display: flex; align-items: center; gap: 8px; }
      header { justify-content: space-between; }
      h1 { margin: 0; font-size: var(--font-heading-md-size, 20px); }
      input { min-width: 0; flex: 1; }
      ul { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
      li { padding: 10px; border: 1px solid var(--color-border-secondary, #8885); border-radius: var(--border-radius-md, 8px); }
      li span { flex: 1; }
    `,
    script: `
      const api = globalThis.ClankMcpApp;
      const status = document.querySelector("#status");
      const list = document.querySelector("#todos");

      const render = (value) => {
        list.replaceChildren();
        for (const todo of value ?? []) {
          const item = document.createElement("li");
          const label = document.createElement("span");
          label.textContent = todo.title;
          const toggle = document.createElement("button");
          toggle.textContent = todo.done ? "Reopen" : "Complete";
          toggle.addEventListener("click", async () => {
            const result = await client.callTool("todos_toggle", {
              id: todo._id,
              version: todo._version,
            });
            render(result.structuredContent?.value);
          });
          item.append(label, toggle);
          list.append(item);
        }
      };

      const client = api.createMcpAppClient({
        name: "todo-board",
        availableDisplayModes: ["inline", "fullscreen"],
        onHostContext(context) {
          api.applyMcpAppTheme(context);
        },
        onToolResult(result) {
          render(result.structuredContent?.value);
        },
      });

      document.querySelector("#add-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const input = document.querySelector("#title");
        const result = await client.callTool("todos_add", { title: input.value });
        input.value = "";
        render(result.structuredContent?.value);
      });

      client.connect().then(async () => {
        status.textContent = "Connected";
        const result = await client.callTool("todos_list", {});
        render(result.structuredContent?.value);
      }).catch(() => {
        status.textContent = "Could not connect";
      });
    `,
  }),
});
```

`createMcpAppDocument()` embeds the Clank bridge directly. The resource does not import a CDN
module and does not depend on a regular web route remaining online. `body`, `styles`, and `script`
are trusted application source—not user input. Dynamic labels use `textContent` in the example so
server data never becomes executable markup.

## Bind it to backend actions

Attach the same view to every action whose result should update it:

```ts
export const backend = defineBackend({ schema, auth }).functions(
  ({ query, mutation }) => ({
    todos: {
      list: query({
        description: "List the signed-in user's todos.",
        args: {},
        agent: { app: todoBoard },
        handler: ({ db }) => db.table("todos").collect(),
      }),

      add: mutation({
        description: "Create a todo and return the current list.",
        args: { title: s.string({ min: 1, max: 160 }) },
        agent: { app: todoBoard, destructive: false },
        handler: ({ db }, { title }) => {
          db.table("todos").insert({ title, done: false });
          return db.table("todos").collect();
        },
      }),

      toggle: mutation({
        description: "Change completion state and return the current list.",
        args: {
          id: s.id("todos"),
          version: s.number({ integer: true, min: 1 }),
        },
        agent: { app: todoBoard, destructive: false },
        handler: ({ db }, { id, version }) => {
          const todo = db.table("todos").get(id);
          if (todo) db.table("todos").patch(id, { done: !todo.done }, { ifVersion: version });
          return db.table("todos").collect();
        },
      }),
    },
  }),
);
```

Clank collects and deduplicates the referenced view automatically. Deploying the backend publishes:

```text
tools/list
  todos_list._meta.ui.resourceUri = ui://todos/board
  todos_add._meta.ui.resourceUri = ui://todos/board
  todos_toggle._meta.ui.resourceUri = ui://todos/board

resources/list
  ui://todos/board · text/html;profile=mcp-app

resources/read { uri: "ui://todos/board" }
  one HTML content item plus _meta.ui security policy
```

Changing the HTML, policy, resource metadata, binding, or visibility changes the deterministic MCP
contract revision. Hosts therefore do not retain a stale view while backend actions move forward.

## App-only actions

An embedded view sometimes needs an implementation action that should not enter the model's tool
list. Bind it with app-only visibility:

```ts
refresh: query({
  description: "Refresh the interactive board.",
  args: {},
  agent: {
    app: {
      resource: todoBoard,
      visibility: ["app"],
    },
  },
  handler: ({ db }) => db.table("todos").collect(),
}),
```

MCP Apps hosts can proxy this action for the view. Clients that did not negotiate the UI extension
do not see app-only tools. Ordinary tools default to both model and app visibility.

Visibility controls discovery and host presentation; it is not an authorization boundary. Keep
sensitive operations behind normal Clank authentication and `agent:read` or `agent:write` scope
checks, regardless of whether a tool is visible to the model, the app, or both.

## Host context and actions

The inlined `globalThis.ClankMcpApp` object exposes the same runtime as the
`@clank.run/framework/mcp-app` module:

| Method | Purpose |
| --- | --- |
| `createMcpAppClient(options)` | Initialize the iframe connection and receive lifecycle events |
| `client.callTool(name, args)` | Invoke a tool through the host's authenticated MCP connection |
| `client.readResource(uri)` | Ask the host to read another server resource |
| `client.openLink(url)` | Request a host-mediated HTTP(S) link open |
| `client.downloadFile(contents)` | Request a host-mediated file download |
| `client.sendMessage(content)` | Send user content to the host conversation |
| `client.updateModelContext(value)` | Replace the view's deferred model context |
| `client.requestDisplayMode(mode)` | Request `inline`, `fullscreen`, or `pip` |
| `client.sendSizeChanged(size)` | Report responsive content dimensions |
| `client.requestTeardown()` | Ask the host to remove the view |
| `applyMcpAppTheme(context)` | Apply safe MCP host CSS variables and the light/dark marker |

Callbacks cover complete and partial tool input, tool results, cancellation, host-context updates,
and graceful teardown. The bridge accepts messages only from its configured parent window, uses
bounded request timeouts, and rejects unsupported initialization versions.

## Security policy

Declare the least authority the view needs:

```ts
defineMcpApp({
  // ...
  csp: {
    connectDomains: ["https://api.example.com"],
    resourceDomains: ["https://cdn.example.com"],
    frameDomains: ["https://player.example.com"],
    baseUriDomains: [],
  },
  permissions: {
    clipboardWrite: {},
  },
  prefersBorder: true,
});
```

External origins must be secure, except explicit loopback origins used during development. Each
permission uses the MCP Apps empty-object shape. Clank rejects unknown policy keys, duplicate or
path-bearing origins, malformed `ui://` URIs, unsupported permission values, incomplete HTML
documents, missing resources, and conflicting definitions with the same URI.

The host—not the view—owns OAuth credentials. Prefer `client.callTool()` over direct authenticated
fetches. A view receives only the tool data and host capabilities required to render. Application
authorization, owned-row isolation, validation, optimistic concurrency, and write scopes still run
on every action.

## Low-level MCP servers

Custom servers can register the same resources directly:

```ts
const server = createMcpServer({
  name: "reports",
  apps: [reportDashboard],
  tools: [{
    name: "reports.summary",
    description: "Summarize the current report.",
    inputSchema: { type: "object", additionalProperties: false },
    app: {
      resourceUri: reportDashboard.uri,
      visibility: ["model", "app"],
    },
    invoke: () => ({ total: 42 }),
  }],
});
```

The low-level property names intentionally mirror the wire contract. Normal Clank backends should
prefer `agent: { app: view }` so resource collection and revision tracking remain automatic.

## Verify with MCPJam

Authenticate first, save the credentials, then reuse them for protocol and MCP Apps checks:

```sh
npx -y @mcpjam/cli@latest oauth conformance \
  --url https://my-app.apps.clank.run/__clank/mcp \
  --protocol-version 2025-11-25 \
  --registration dcr \
  --auth-mode interactive \
  --verify-tools \
  --credentials-out .mcpjam.json

npx -y @mcpjam/cli@latest apps conformance \
  --url https://my-app.apps.clank.run/__clank/mcp \
  --protocol-version 2026-07-28 \
  --credentials-file .mcpjam.json
```

Do not run the second command anonymously against a protected app: the correct OAuth `401` occurs
before JSON-RPC and prevents the UI checks from discovering tools or resources.

Continue with [The MCP server built into every app](per-app-mcp.md) for OAuth and action parity,
and [Agent protocol](agent-protocol.md) for transport and revision details.
