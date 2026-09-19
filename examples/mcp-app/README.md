# Clank MCP App example

This public, read-only example exposes one interactive status tool and one immutable `ui://`
resource without dependencies, a CDN, or a separate UI bundle.

From the repository root:

```sh
npm run build
node examples/mcp-app/server.js
```

Connect an MCP Apps host to `http://127.0.0.1:4182/mcp`. The hosted MCPJam application requires
HTTPS, so use its local CLI or desktop client for this loopback example.

Run the server-side UI conformance suite:

```sh
npx -y @mcpjam/cli@latest apps conformance \
  --url http://127.0.0.1:4182/mcp \
  --protocol-version 2026-07-28
```

Production Clank apps normally bind `defineMcpApp()` resources to authenticated backend actions
with `agent: { app: view }`; see `docs/mcp-apps.md`.
