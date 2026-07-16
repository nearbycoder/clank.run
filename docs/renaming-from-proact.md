# Renaming from Proact

Proact was renamed to Clank in version 0.7.0. The framework, deployment platform, package, CLI, generated applications, and public protocol names now use Clank.

## New names

| Before | Now |
| --- | --- |
| `proact` package | `clank.run` |
| `proact` command | `clank` |
| `proact-platform` | `clank-platform` |
| `proact.deploy.json` | `clank.deploy.json` |
| `.proact/` | `.clank/` |
| `.proact-platform/` | `.clank-platform/` |
| `PROACT_*` environment variables | `CLANK_*` |
| `/__proact/auth/*` | `/__clank/auth/*` |
| `x-proact-*` headers | `x-clank-*` |
| `proact-deploy/1` | `clank-deploy/1` |
| `application/vnd.proact.deploy+gzip` | `application/vnd.clank.deploy+gzip` |

New projects should use only the Clank names.

## Automatic migration

Clank performs these migrations in place:

- the default platform launcher renames `.proact-platform/` to `.clank-platform/` when the new directory does not already exist;
- SQLite framework, authentication, migration-ledger, and deployment-platform tables are renamed transactionally while preserving rows;
- the CLI reads an existing `~/.proact/config.json` or `.proact/project.json`, then writes the equivalent Clank file;
- legacy session cookies remain valid, and the next authentication response uses the new cookie name;
- old deployment artifacts, headers, configuration filenames, token prefixes, and selected environment variables remain readable during the transition.

If both an old and a new database table exist, startup stops instead of guessing which copy is authoritative. Back up platform and application data before the first 0.7.0 startup.

## Source changes

Application source must update package imports and public Clank-specific names. For example:

```ts
import { signal } from "clank.run";
import { createAuth } from "clank.run/auth";
```

Rename custom integrations that reference `ClankContext`, `ClankClientOptions`, `ClankPlatformOptions`, `data-clank-*`, or `clank-*` SSR markers. These TypeScript and DOM names are not dual-exported because doing so would permanently expand the public API.

## Compatibility policy

Legacy compatibility is read-side and transitional. Clank always writes new names. Operators should update scripts, secrets, service definitions, proxy rules, and checked-in deployment configuration to use `CLANK_*`, `/__clank/*`, and `clank.deploy.json`.
