# Authenticated live todo

This example is the complete minimal Clank application shape:

- email/password registration and login;
- secure, HTTP-only sessions and CSRF-protected mutations;
- a user-owned display profile;
- user-owned SQLite todos;
- SSR followed by node-preserving hydration;
- live EventSource queries shared by every session for the same account;
- account isolation enforced by the database scope.
- optimistic `_version` checks that reject stale edits instead of overwriting them.

Profile changes and all todo operations—create, rename, complete, reopen, remove, and clear completed—are committed on the server and streamed to every connected browser. Refreshing reconstructs the same profile and todo state from SQLite.

The status badge says `synced` rather than exposing the global revision as product data. The numeric snapshot remains available to assistive text and diagnostics.

## Run locally

From the repository root:

```sh
npm run dev:auth
```

Open `http://127.0.0.1:4181`, create an account, then sign into the same account from another browser.

The default database is `examples/auth-todo/auth-todo.sqlite`. Override it with `CLANK_DATABASE`. Set `CLANK_AUTH_PEPPER` to a high-entropy server secret before using the example outside local development.

## Publish to a tailnet

Keep the application bound to loopback and let Tailscale terminate HTTPS:

```sh
PORT=4181 \
HOST=127.0.0.1 \
TRUST_PROXY=1 \
ALLOWED_HOSTS=localhost,127.0.0.1,your-machine.your-tailnet.ts.net \
npm run dev:auth

tailscale serve --bg --https 8448 http://127.0.0.1:4181
```

Then open `https://your-machine.your-tailnet.ts.net:8448`.

The health check is available at `/healthz`. The application sends a restrictive Content Security Policy, denies framing, disables camera/microphone/geolocation, and serves authenticated HTML with `cache-control: no-store`.
