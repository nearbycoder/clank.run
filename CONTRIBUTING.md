# Contributing to Clank

Clank favors small public contracts, explicit security boundaries, deterministic behavior, and platform primitives over hidden dependency machinery.

## Before changing code

Open an issue for a new public API, wire protocol, persistent schema, authentication behavior, deployment state transition, or compatibility break. A short proposal should contain:

1. the human and agent workflow;
2. the smallest proposed contract;
3. authorization and data boundaries;
4. migration and rollback behavior;
5. alternatives considered; and
6. the evidence that will prove the change works.

Typographical fixes, tests for existing behavior, and narrow bug fixes do not require a proposal.

## Development

Requirements:

- Node 22.13 or newer;
- no runtime or development NPM dependencies; and
- a filesystem that supports normal SQLite locking and atomic rename semantics.

Run:

```sh
npm run check
```

That command builds the framework, enforces the zero-dependency contract, runs unit/integration tests, then installs and exercises the packed release through the complete conformance journey.

## Pull requests

- Add tests that would fail without the change.
- Update every relevant public guide and API reference.
- Preserve the zero-dependency contract.
- Keep generated files, databases, credentials, `.env` files, platform state, and local artifacts out of commits.
- Explain compatibility, migration, failure recovery, and rollback.
- Treat model output, browser input, uploaded artifacts, migrations, URLs, and persisted application data as untrusted.

Large modules may be split when the split improves a concrete change. Moving code without improving a public boundary, testability, or security property is not itself a goal.

## Commit and release policy

Maintainers use reviewed pull requests for `main`. Releases follow [the release process](docs/releases.md). By contributing, you agree that your contribution is licensed under the repository's MIT license.
