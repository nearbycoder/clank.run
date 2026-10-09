# Persistent release channels

A release channel such as `stable` or `beta` pins an exact, successfully activated upload in an
[environment family](environment-promotions.md). Its immutable entries retain source environment,
project, release ID and SHA-256. Pinning changes the channel's current target; it does not deploy
an application. Promotion and rollback are explicit actions that use the existing environment
activation, permission, migration, attestation and host-certification boundaries.

Use **Project → Environments → Release channels** or `clank channel` in a directory linked to
the family root. Names begin with a lowercase letter and contain at most 64 lowercase letters,
digits or hyphens. Each family retains at most 100 names and 1,000 immutable entries. Retirement
frees history capacity and keeps a versioned name tombstone; it does not free the name slot.

## Pin, inspect and promote

Inspect the source project's retained releases and choose the exact upload:

```sh
clank channel list --json
clank channel pin stable --from=development --release=SOURCE_RELEASE \
  --digest=EXACT_SHA256 --expected-version=0 --json
clank channel get stable --json
clank channel history stable --json
```

Version zero creates a previously unused name. An existing or retired name requires its exact
current version. A successful pin increments that version and appends an immutable entry. A
stale request fails with `CHANNEL_VERSION_STALE`; it cannot overwrite a newer pin. If a pin's
response is lost, inspect the channel before retrying or reviewing another update. A retry of
the old expected version fails rather than creating another entry.

Promotion captures both the channel version and the target environment binding version, the
expected active target release and an exact request key:

```sh
clank environment list --json
clank channel promote stable --to=staging --expected-version=1 \
  --environment-version=1 --expected-active=TARGET_RELEASE \
  --key=channel_promotion_0001 --json
clank channel actions stable --json
```

An uninitialized `apply-safe` target requires `--expected-active=none`. An initialized
`code-only` target requires its exact active release. The platform sends the original compressed
upload bytes without rebuilding, while resolving the target's current secrets, database,
namespace, quotas and migration policy. The source environment must still bind the pinned
source project. Production requires a workspace owner/admin. Provider targets must satisfy
[certified promotion admission](environment-promotions.md); a channel cannot relax it.

Signed-release installations require `--attestation=target-attestation.json`. The bounded JSON
must authorize the target project and unchanged digest. The dashboard accepts the same file
when reviewing promotion or rollback.

The dashboard's **Review channel action** captures these exact values before enabling
**Apply reviewed action**. Editing fields invalidates the review. Pending requests stay in that
browser session when navigating between projects; **Retry exact channel request** sends the
original request, including its key and attestation. Reloading requires reviewing again.
Signing out clears drafts and visible history.

## Roll back without rewriting history

Rollback selects an older immutable entry and explicitly activates it on a target environment:

```sh
clank channel history stable --version=1 --json
clank channel rollback stable --from-version=1 --to=staging \
  --expected-version=2 --environment-version=1 \
  --expected-active=TARGET_RELEASE --key=channel_rollback_0001 --json
```

Only verified target activation publishes the new current channel version. For example,
rolling back channel version 2 to entry 1 appends version 3 referencing entry 1's original
source release and digest. Entries 1 and 2 remain unchanged. Target application data stays
independent; channel rollback does not restore source data or copy source secrets. The target's
migration policy still applies, including rejection of changed or pending migrations under
`code-only`.

An accepted action's identical replay returns its original receipt and target release, even
when the channel has since advanced. It does not reactivate that old release, append history
again or reinterpret a newer pin. Changed fields under an existing action key fail with
`CHANNEL_RETRY_CHANGED` or `PROMOTION_RETRY_CHANGED`. Current permission and environment checks
still apply to replay; receipts cannot restore revoked authority.

History and action lists expose the newest 100 authorized rows. The exact history read and
numeric historical version in the dashboard can inspect any retained authorized entry,
including one outside that list. Lists omit entries whose source is no longer readable and
actions whose source or target is no longer readable.

## Failure, interruption and recovery

Failed health, migration or authority checks restore the prior target through the environment
promotion path. A failed rollback does not advance the channel. Provider compensation restores the prior active
generation’s frozen environment so newly edited secrets cannot also break its prior code. Pending, staging and
`recovery-required` actions prevent repinning or retirement until activation or verified
recovery finishes. Pending rollback also reserves its future entry slot, so another channel
cannot consume that capacity before acceptance.

Channel action history links to the target's promotion history. Inspect and recover the
underlying exact promotion key there, or use:

```sh
clank environment history staging --json
clank environment recover staging UNDERLYING_PROMOTION_KEY \
  --confirm='recover-promotion TARGET_SLUG UNDERLYING_PROMOTION_KEY' --json
```

Recovery verifies candidate cleanup before restoring or admitting the prior writer. It marks
the interrupted action failed and leaves the channel pin unchanged. Review a new action with
a new key after recovery. A new key cannot bypass an unresolved target fence.

## Retention and retirement

Every retained channel entry protects its original source upload against artifact cleanup and
source-project deletion. Older entries remain pinned after a new pin or rollback. Uploads
continue to count against the source project's existing storage limits. The Deployments tab
shows **Channel pinned** where cleanup is blocked; explicitly allowing immediate rollback loss
does not bypass a channel pin.

An owner/admin, subject to the platform's configured recent-authentication policy, may retire a channel after reviewing its current
version and exact confirmation:

```sh
clank channel retire stable --expected-version=3 \
  --confirm='retire-channel FAMILY_ROOT_SLUG stable' --json
```

Retirement clears that channel's entries, pins and channel action metadata. It retains a name
tombstone at the next version and preserves uploads, application data, running releases,
underlying promotion receipts and audit history. Retirement of version 3 leaves version 4 with
`current: null`. Its identical retry returns that tombstone. Recreating `stable` requires
`--expected-version=4` and publishes version 5; stale pin, retirement and activation requests
cannot affect the recreated channel. Other channels may still retain the same upload.

## HTTP and consumer types

All routes below are under `/api/projects/:root/channels`. Writes use the same current session
or bearer-token authority as environment promotion; browser writes also require CSRF protection.

| Method and suffix | Contract |
| --- | --- |
| `GET /` | Up to 100 currently authorized names and retired tombstones. |
| `GET /:name` | Current version, exact current entry or `current: null` when retired. |
| `PUT /:name` | `sourceEnvironment`, `releaseId`, `digest`, `expectedVersion`. |
| `GET /:name/history` | Newest 100 authorized immutable entries. |
| `GET /:name/history/:version` | One exact authorized immutable entry; absent or retired returns 404. |
| `GET /:name/actions` | Newest 100 authorized action receipts. |
| `POST /:name/promote` | `targetEnvironment`, `expectedVersion`, `expectedEnvironmentVersion`, `expectedActiveReleaseId`, `idempotencyKey`. |
| `POST /:name/rollback` | Promotion fields plus historical `fromVersion`. |
| `DELETE /:name` | `expectedVersion`, exact `confirmation`; owner/admin and the configured recent-authentication policy. |

`POST` actions accept the optional `x-clank-release-attestation` header and return the underlying
promotion, target release and channel action. A pin requires root deploy and source read
permission. Activation additionally requires current target deploy permission. Retirement
requires root token-administration permission, workspace administration and any configured
recent passkey/MFA verification policy. Retained source
uploads and current bindings are verified again during asynchronous work and at acceptance.

Import `PlatformReleaseChannelEntry`, `PlatformReleaseChannel`, `PlatformChannelPinRequest`,
`PlatformChannelActivationRequest`, `PlatformChannelRollbackRequest` and `PlatformChannelAction`
from `@clank.run/framework/platform`. Observation types are readonly. Rollback's historical
version and activation's nullable active-release expectation are required.

The additive SQLite migration does not rewrite existing releases or environment receipt
fingerprints. Channel receipt acceptance, target activation and rollback pointer publication
share one transaction. Older controllers do not enforce channel pins. Before reverting to a controller without
channel support, finish or recover pending actions and retire retained channels with the
compatible controller. Otherwise older cleanup or project deletion can remove their retained
uploads. Preserve the control store and uploads together when taking a recovery backup.

Require managed services before target activation with [deployment dependency gates](deployment-dependencies.md).
The API/CLI accept an optional exact configuration version and credential-bound check ID; dashboard
promotion and channel reviews capture these automatically. Target gates also apply to ordinary
uploads and explicit rollback, with durable interruption recovery and audited human readiness approval.
