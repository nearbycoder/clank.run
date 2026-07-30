# Invitations and email delivery

Clank has two intentionally different invitation scopes:

- **Workspace** grants one `admin`, `developer`, or `viewer` role in an existing workspace.
- **Personal** lets a platform administrator invite a new person to create an isolated account and
  personal workspace without joining the administrator's workspace.

Both are email-bound, single-use, expiring capabilities. An owner or administrator chooses the
scope in **Workspace → People**. When email delivery is configured, Clank sends the secure link
automatically. Otherwise the same screen shows a copy-once token for manual delivery.

## Recipient experience

An invitation email links to:

```text
https://clank.run/invite#token=clnki_…
```

The token is in the URL fragment, not the query string. Browsers do not include fragments in HTTP
requests or `Referer` headers. The console copies the token into the correct form and immediately
removes the fragment from browser history.

- A person without an account creates the exact email-bound account and joins in one transaction.
- A signed-in person sees the existing **Join another workspace** confirmation with the token
  already filled in.
- A personal invitation creates only the recipient's account and personal workspace.
- Reissuing or revoking an invitation immediately invalidates every older link.

No password or browser session is sent by email.

## Configure Resend

The production launcher talks to Resend over HTTPS directly; the framework adds no Resend SDK or
runtime dependency.

```sh
CLANK_RESEND_API_KEY=re_…
CLANK_EMAIL_FROM=noreply@example.com
CLANK_EMAIL_FROM_NAME=Clank
CLANK_EMAIL_REPLY_TO=support@example.com
```

Verify the sender domain with the provider before inviting real users. The optional request and
outbox controls are:

```sh
CLANK_EMAIL_TIMEOUT_MS=10000
CLANK_EMAIL_REQUEST_RETRIES=2
CLANK_INVITATION_DELIVERY_INTERVAL_MS=30000
CLANK_INVITATION_DELIVERY_BATCH_SIZE=20
CLANK_INVITATION_DELIVERY_CONCURRENCY=2
CLANK_INVITATION_RETRY_BASE_MS=30000
CLANK_INVITATION_MAX_ATTEMPTS=6
CLANK_INVITATION_DELIVERY_LEASE_MS=60000
```

Resend supports the `Idempotency-Key` header on `POST /emails`; Clank binds that key to the stable
invitation ID. See Resend's [send-email API](https://resend.com/docs/api-reference/emails/send-email)
and [idempotency documentation](https://resend.com/docs/dashboard/emails/idempotency-keys).

## Use any HTTPS mail gateway

Set a provider-neutral endpoint instead of a Resend key:

```sh
CLANK_EMAIL_DELIVERY_URL=https://mail-gateway.example.com/send
CLANK_EMAIL_DELIVERY_TOKEN=<gateway bearer token>
CLANK_EMAIL_FROM=noreply@example.com
CLANK_EMAIL_FROM_NAME=Clank
```

The gateway receives Clank's normalized `EmailMessage` JSON. The request includes
`Content-Type: application/json`, an optional bearer token, and the same `Idempotency-Key` value.
Return any successful HTTP status and optionally `{ "id": "provider-message-id" }`. Redirects are
not followed, the URL must be HTTPS, and only `429` and server errors are retried by the transport.

Configure either `CLANK_RESEND_API_KEY` or `CLANK_EMAIL_DELIVERY_URL`, never both. If neither is
present, Clank stays in explicit **Manual token delivery** mode.

## Programmatic self-hosting

`openPlatform` accepts any `EmailService`:

```ts
import {
  createResendEmailService,
  openPlatform,
} from "@clank.run/framework";

const platform = await openPlatform({
  dataDirectory: "/var/lib/clank",
  publicUrl: "https://deploy.example.com",
  invitations: {
    email: createResendEmailService({
      apiKey: process.env.RESEND_API_KEY!,
    }),
    from: {
      email: "noreply@example.com",
      name: "Clank",
    },
    replyTo: {
      email: "support@example.com",
    },
  },
});
```

`createHttpEmailService` is the programmatic provider-neutral alternative. `openFileEmailService`
is appropriate for local application development, but it is not real invitation delivery and
should not be used as a production mail provider.

## Delivery state

Pending invitations show one of:

| State | Meaning |
| --- | --- |
| Manual token delivery | No email driver is configured. |
| Email queued | The encrypted outbox is waiting or the first provider attempt is in progress. |
| Email retrying | A provider call failed or an old worker lease was reclaimed. |
| Email sent | The provider accepted the message. |
| Email failed | The bounded attempt limit was reached; reissue the invitation to try again. |

Creating an invitation always returns its token once as a fallback. Lists never return tokens,
hashes, ciphertext, provider error text, or provider credentials.

## Durability and security model

The invitation row stores only a SHA-256 token hash. A separate outbox temporarily stores the token
inside the same AES-256-GCM envelope used for platform secrets. This gives Clank enough information
to retry after a restart without making the ordinary invitation record reversible.

Delivery has these invariants:

- invitation creation and outbox enqueue commit in one SQLite transaction;
- multiple control planes use expiring transactional leases, so only one claims a message;
- every retry preserves one invitation-scoped idempotency key;
- a crashed worker's expired lease is reclaimed;
- successful delivery erases the encrypted token immediately;
- acceptance, replacement, revocation, and expiry cancel pending work and erase the encrypted
  token;
- a late provider response is fenced and cannot change a cancelled delivery back to sent;
- public APIs store only generic failure state while the detailed provider error goes to the
  private operator error hook; and
- terminal delivery metadata is bounded and pruned.

Email is not a revocation channel: a message already accepted by the provider cannot be recalled.
Revoking or replacing its server-side invitation makes the link unusable.

## Troubleshooting

1. Check the pending invitation's delivery state in **Workspace → People**.
2. Confirm exactly one provider variable and `CLANK_EMAIL_FROM` are present.
3. Verify the sender domain and provider account permissions.
4. Read private control-plane logs for the provider failure; Clank intentionally keeps that text
   out of tenant APIs.
5. If the state is **Email failed**, reissue the invitation. The old token is revoked atomically.
6. Keep the copy-once token only as a short-lived fallback; do not put it in tickets or application
   logs.
