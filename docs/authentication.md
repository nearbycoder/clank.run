# Advanced authentication

Clank's advanced authentication features extend the framework's default email/password flow with verification, recovery, MFA, passkeys, bot protection, and distributed rate limits. Authentication uses the application SQLite database. Passwords use bounded scrypt work, session and one-time tokens are stored only as SHA-256 digests, browser sessions use `HttpOnly` and `SameSite=Lax` cookies by default, and every state-changing browser request requires an origin check plus a session-bound CSRF token. `Lax` lets a top-level MCP OAuth navigation recognize an existing application login without sending the session on a cross-site mutation; applications that never act as an authorization server can opt into `cookie.sameSite: "Strict"`.

```ts
import { defineAuth } from "@clank.run/framework/auth";

export const auth = defineAuth({
  emailVerification: {
    required: true,
    async send({ email, token, expiresAt }) {
      await mail.sendVerification({ email, token, expiresAt });
    },
  },
  passwordRecovery: {
    async send({ email, token, expiresAt }) {
      await mail.sendPasswordReset({ email, token, expiresAt });
    },
  },
  mfa: {
    required: true,
    async send({ email, code, expiresAt }) {
      await mail.sendLoginCode({ email, code, expiresAt });
    },
  },
  passkeys: {
    rpName: "Orbit Tasks",
    rpId: "tasks.example.com",
    allowedOrigins: ["https://tasks.example.com"],
    requireUserVerification: true,
  },
  botProtection: {
    async verify({ request, action, token }) {
      return antiBot.verify({ request, action, token });
    },
  },
  rateLimit: {
    store: sharedRateLimitStore,
  },
});
```

Email verification and password-recovery links are expiring and single use. Password reset revokes every existing browser session before issuing the replacement session. Recovery requests perform a fixed minimum amount of work and return the same response whether or not an account exists. Recovery delivery is dispatched after the response path so provider latency does not reveal account existence; production delivery hooks should enqueue durably before returning from their own worker boundary.

Required email verification is enforced by backend authorization, not only by UI. `auth.requireVerified()` is also available in custom handlers.

MFA login returns a short-lived challenge only after the password is verified. Codes are hashed, attempt-limited, expiring, and single use. Passkeys use required discoverable credentials, WebAuthn `none` attestation, exact challenge and origin binding, RP ID hashes, user-presence and optional user-verification flags, ES256 or RS256 signature verification, and monotonic authenticator counters. Authentication starts without an account-specific credential list, preventing the start response from becoming an account-enumeration oracle.

The browser client includes:

- `requestEmailVerification()` and `verifyEmail(token)`
- `requestPasswordReset(email)` and `resetPassword(token, password)`
- `verifyMfa(code)`
- `listPasskeys()`, `registerPasskey(name)`, `loginWithPasskey()`, and `deletePasskey(id)`

The default `AuthForm` automatically presents the MFA code step. Product-specific verification, recovery, and passkey-management screens can use the same client methods.

## Distributed rate limits

`rateLimit.store` is the process-independent boundary:

```ts
interface AuthRateLimitStore {
  consume(key: string, limit: number, windowMs: number):
    number | undefined | Promise<number | undefined>;
  clear?(key: string): void | Promise<void>;
  close?(): void | Promise<void>;
}
```

`consume` returns the retry delay in seconds when the limit is exceeded. A successful password login clears the same key after credential verification, so prior failures do not continue throttling the authenticated user. The built-in application store is safe for a single process; horizontally scaled applications should provide a shared implementation. Clank Deploy supplies its own control-database-backed shared store.

Clank's Node adapter attaches the socket or trusted-proxy address out of band. Authentication never trusts caller-supplied `x-clank-client-ip` or `x-forwarded-for` headers. A non-Node adapter can provide `rateLimit.clientKey(request)`, but that callback must return identity authenticated by the adapter or edge rather than copying an unverified request header.

Passkeys registered by releases before 0.7 used `residentKey: "preferred"`. Most platform authenticators made those credentials discoverable, but an authenticator was allowed not to. A user with a non-discoverable legacy credential must sign in through another configured method and register a new passkey before relying on account-free passkey sign-in.

## Operational rules

- Configure an HTTPS origin and an explicit RP ID before enabling production passkeys.
- Deliver tokens through a service driver; never log them.
- Keep password peppers and delivery credentials in platform secrets.
- Treat account-wide CLI credentials as interactive developer credentials. Use project-scoped tokens for CI.
- Revoke sessions after material identity or authorization changes.

## Troubleshooting origin rejection

`Cross-origin auth request rejected.` on an ordinary login, registration, or
account mutation means the browser's exact `Origin` did not match the origin
reconstructed by the application server, or Fetch Metadata identified a
cross-site request. Do not disable this check or rewrite the browser's
`Origin`; both would weaken CSRF protection.

MCP OAuth consent does not depend on extension or embedded-browser `Origin`
behavior. Each rendered consent page receives a random, one-time proof stored
only as a digest and bound to the authenticated session, registered client,
exact redirect URI, PKCE challenge, scopes, state, and MCP resource. Approval
requires that proof plus the session's CSRF token, consumes the proof
atomically, and rejects expiry, replay, parameter changes, or another session.
This preserves CSRF protection when an OAuth client supplies an opaque or
missing `Origin`.

The consent page also includes the exact validated callback origin in its
`form-action` Content Security Policy. Without that source Chromium blocks the
successful cross-origin `303` loopback navigation after the proof has already
been consumed. Clank never uses a wildcard callback source: redirect
registration, PKCE, state validation, and exact callback matching remain
required.

When an MCP authorization page is signed out, ordinary password applications
render a same-origin login form and return directly to consent after successful
authentication. Form login uses the normal credential verifier and rate
limits, retains strict Origin and Fetch Metadata checks, and accepts only a
bounded relative return path. MFA or bot-protected applications keep their
full application sign-in flow because those policies require additional UI.

For an app deployed by Clank, open the canonical URL reported by `clank status`
and reload it before retrying. Managed ingress configures the generated runtime
automatically and is covered by an end-to-end auth regression. The platform
injects `TRUST_PROXY=1` and the reserved `CLANK_MANAGED_INGRESS=1` marker into
the application process. The Node adapter uses that marker only with trusted
proxy mode, preserving the public host while leaving host admission at Clank's
loopback-only managed ingress. Applications must not set this marker themselves.

During local development, a UI and API on different ports are different
origins even when both use `localhost`. Allowlist the UI origin on the backend,
configure credentialed CORS, and give the auth client the API URL:

```ts
const uiOrigin = "http://localhost:5173";
const runtime = await openBackend(backend, {
  allowedOrigins: [uiOrigin],
});

const app = createApp()
  .use(cors({ origin: uiOrigin, credentials: true }))
  .route("*", "*", ({ request }) => runtime.handle(request));

const auth = createAuthClient({
  url: "http://localhost:3000",
});
```

`allowedOrigins` now applies consistently to both backend RPC and its mounted
auth routes. An explicit client `url` uses credentialed requests. This is for
trusted, same-site origins such as localhost ports or sibling subdomains;
Fetch Metadata still rejects genuinely cross-site auth requests. Production
Clank apps should keep the default same-origin client and need no allowlist.

For a self-hosted app behind an exclusive trusted reverse proxy:

```ts
await serve(app, {
  hostname: "127.0.0.1",
  trustProxy: true,
  allowedHosts: ["tasks.example.com"],
});
```

The proxy must replace `X-Forwarded-Host` and `X-Forwarded-Proto` with the
browser-visible host and protocol, and untrusted clients must not be able to
reach the Node listener directly. When `TRUST_PROXY` and `ALLOWED_HOSTS` are
read from environment variables, verify those variables in the running
process—not only in a local shell.
