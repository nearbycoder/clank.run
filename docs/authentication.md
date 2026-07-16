# Authentication

Clank authentication is built into the framework and uses the application SQLite database. Passwords use bounded scrypt work, session and one-time tokens are stored only as SHA-256 digests, browser sessions use `HttpOnly` and `SameSite=Strict` cookies, and every state-changing browser request requires an origin check plus a session-bound CSRF token.

```ts
import { defineAuth } from "clank.run/auth";

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

Email verification and password-recovery links are expiring and single use. Password reset revokes every existing browser session before issuing the replacement session. Recovery requests return the same response whether or not an account exists.

Required email verification is enforced by backend authorization, not only by UI. `auth.requireVerified()` is also available in custom handlers.

MFA login returns a short-lived challenge only after the password is verified. Codes are hashed, attempt-limited, expiring, and single use. Passkeys use WebAuthn `none` attestation, exact challenge and origin binding, RP ID hashes, user-presence and optional user-verification flags, ES256 or RS256 signature verification, and monotonic authenticator counters.

The browser client includes:

- `requestEmailVerification()` and `verifyEmail(token)`
- `requestPasswordReset(email)` and `resetPassword(token, password)`
- `verifyMfa(code)`
- `listPasskeys()`, `registerPasskey(name)`, `loginWithPasskey(email)`, and `deletePasskey(id)`

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

`consume` returns the retry delay in seconds when the limit is exceeded. The built-in store is safe for a single process; horizontally scaled deployments should provide a shared implementation.

## Operational rules

- Configure an HTTPS origin and an explicit RP ID before enabling production passkeys.
- Deliver tokens through a service driver; never log them.
- Keep password peppers and delivery credentials in platform secrets.
- Treat account-wide CLI credentials as interactive developer credentials. Use project-scoped tokens for CI.
- Revoke sessions after material identity or authorization changes.

