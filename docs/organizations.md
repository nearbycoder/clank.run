# Organizations and deployment RBAC

The Clank platform isolates projects through organizations. A project belongs to one organization, and every request checks current membership before reading project metadata, logs, releases, secrets, or deployment state.

Roles are intentionally small:

| Role | Access |
| --- | --- |
| `owner` | Full organization and project administration, including permanent site deletion |
| `admin` | Project administration, permanent site deletion, and membership administration, except changing owners |
| `developer` | Read, deploy, rollback, and audit access |
| `viewer` | Read-only project metadata, releases, and logs |

An organization must always retain an owner. Only owners can grant or change the owner role. Removing a member immediately removes project access and revokes every organization- or project-scoped token issued to that member.

## CLI workflow

```sh
clank org list
clank org create "Acme Engineering" --slug acme
clank org invite <org-id> person@example.com --role developer
clank org accept <single-use-token>
clank org members <org-id>
clank org invitations <org-id>
clank org role <org-id> <user-id> <owner|admin|developer|viewer>
clank org remove <org-id> <user-id>
clank org revoke-invite <org-id> <invitation-id>

clank project create "Todo" --org <org-id>
clank project delete <project-id> --confirm="delete-site todo" --acknowledge-data-loss
clank token create --name github-actions --permissions read,deploy
clank token list
clank token revoke <token-id>
```

Invitation tokens are hashed at rest, expire after seven days by default, are bound to the invited email address, and can be accepted once. The token is returned only by the create response, so copy it immediately and deliver it through the operator's trusted channel. Listing pending invitations never returns a token or hash, and only owners and administrators receive pending-invitation metadata. Historical invitation events remain auditable, but developer activity feeds redact recipient email fields.

Reissuing an invitation for the same workspace and normalized email atomically revokes every older active token. Existing members cannot be reinvited; change their role directly instead. A workspace can retain at most 100 active invitations, and owners or administrators can revoke one before it is accepted. These mutations are recorded in workspace activity.

The browser console exposes the complete flow under **People**. An account below its owned-workspace quota can create and immediately select a workspace there. A signed-in recipient can paste a token into **Join another workspace**; the server requires the token's normalized email to match that account. A recipient without an account chooses **Use invitation** on the sign-in screen and supplies the invited email, a new password, and the token. Clank creates the account, consumes the invitation, and joins the workspace in one flow even when public signup is closed. The page also shows the current role and site usage, lets authorized users update roles or remove members, and reveals a newly created token only in the current page state. Member removal immediately revokes the removed account's organization- and project-scoped tokens. The last owner cannot leave or be demoted, and an administrator cannot grant, change, or remove an owner.

## Organization API

- `GET /api/organizations/:id` returns the organization, access capabilities, members, active invitation limit, and active invitations when the caller may administer them.
- `POST /api/organizations` creates an owned workspace with `{ "name": "...", "slug": "..." }` under the account quota.
- `POST /api/organizations/:id/invitations` creates or replaces an email-bound invitation with `{ "email": "...", "role": "developer" }`.
- `DELETE /api/organizations/:id/invitations/:invitationId` revokes an active invitation.
- `PATCH /api/organizations/:id/members/:userId` changes a role with `{ "role": "admin" }`.
- `DELETE /api/organizations/:id/members/:userId` lets a member leave or an administrator remove them, then revokes workspace-scoped credentials.
- `POST /api/invitations/accept` accepts a single-use token for the currently authenticated account.
- `POST /__clank/auth/invited-register` creates the invitation-bound account and accepts its membership without opening public registration.

Authenticated browser mutations require the session CSRF token. Invitation-assisted registration requires an allowed request origin, the exact invited email, and the single-use secret. Project-scoped tokens cannot call organization endpoints.

## Project-scoped tokens

Project tokens contain an organization ID, project ID, explicit permission set, expiry, issuer, and revocation state. Every project request checks all of:

1. the token is active and unexpired;
2. the requested project matches the token;
3. the issuing user is still an organization member;
4. the current organization role permits the operation; and
5. the token permission set permits the operation.

Available permissions are `read`, `deploy`, `rollback`, `secrets`, `tokens`, and `audit`. The default CI scope is `read,deploy`.

A stolen project token cannot list organizations, create or permanently delete projects, administer membership, read another project, or expand its own scope. With `audit`, it can read only its own project's history; current membership and role are still re-evaluated. The workspace activity feed is available to owners, administrators, and developers, while viewers receive no workspace events and cannot select an organization feed. Permanent deletion requires an account-wide token and a current owner/admin role even when a project token contains `tokens`. Account-wide device tokens remain appropriate for the interactive CLI, but should not be copied into CI.
