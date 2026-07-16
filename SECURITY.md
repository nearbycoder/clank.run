# Security policy

## Supported versions

Security fixes are made for the latest published minor release. A fix may require upgrading when preserving an older contract would leave users exposed.

## Reporting a vulnerability

Do not open a public issue for an undisclosed vulnerability.

Use GitHub's private vulnerability-reporting flow for this repository. Include:

- the affected Clank version and Node version;
- the smallest reproducible request, artifact, migration, application, or configuration;
- the security boundary crossed and realistic impact;
- whether the issue has been exploited or disclosed elsewhere; and
- any suggested mitigation.

Do not send real credentials, access tokens, session cookies, master keys, customer data, or production databases. Replace sensitive values with a minimal synthetic reproduction.

Maintainers should acknowledge a complete report within three business days, establish an initial severity and response owner within seven days, and coordinate disclosure after a fix or mitigation is available. Those targets are operational goals, not a guarantee or bug-bounty offer.

## Scope

High-value boundaries include:

- authentication, session, CSRF, role, ownership, and CLI-token enforcement;
- path traversal, symlink substitution, static-file access, and artifact extraction;
- migration validation, backup, restore, release activation, and rollback;
- secret encryption, key handling, logging, and process/container isolation;
- SSR/DOM injection, executable URLs, agent action authorization, and confirmation; and
- cross-project or cross-user data access.

The trusted process runner is not a public-code sandbox. Reports that only demonstrate that trusted process-mode application code can access its own Unix user's authority are out of scope unless they cross a documented isolation boundary. Docker and stronger isolation still depend on correct host configuration.

## Disclosure

Security releases will describe affected versions, impact, mitigation, and upgrade instructions without publishing exploit details that would unnecessarily endanger users. Credit is offered when requested and safe.
