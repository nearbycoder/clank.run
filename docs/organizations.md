# Organizations and deployment RBAC

The Clank platform isolates projects through organizations. A project belongs to one organization, and every request checks current membership before reading project metadata, logs, releases, secrets, or deployment state.

Roles are intentionally small:

| Role | Access |
| --- | --- |
| `owner` | Full organization and project administration |
| `admin` | Project administration and membership administration, except changing owners |
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
clank org remove <org-id> <user-id>

clank project create "Todo" --org <org-id>
clank token create --name github-actions --permissions read,deploy
clank token list
clank token revoke <token-id>
```

Invitation tokens are hashed at rest, expire, are bound to the invited email address, and can be accepted once. The token is returned once so a self-hosted operator can deliver it through their chosen email service.

## Project-scoped tokens

Project tokens contain an organization ID, project ID, explicit permission set, expiry, issuer, and revocation state. Every project request checks all of:

1. the token is active and unexpired;
2. the requested project matches the token;
3. the issuing user is still an organization member;
4. the current organization role permits the operation; and
5. the token permission set permits the operation.

Available permissions are `read`, `deploy`, `rollback`, `secrets`, `tokens`, and `audit`. The default CI scope is `read,deploy`.

A stolen project token cannot list organizations, create projects, administer membership, read another project, or expand its own scope. Account-wide device tokens remain appropriate for the interactive CLI, but should not be copied into CI.

