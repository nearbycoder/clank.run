# Packaged-release conformance

`npm run conformance` proves the complete Clank golden path using a clean temporary installation of the package produced by `npm pack`.

The runner does not import framework source from the repository. It:

1. packs Clank and installs the tarball into a clean tool consumer;
2. statically parses the packaged Todoist-style AI blueprint and generates an authenticated application using that installed CLI;
3. installs the same tarball into the generated application and builds it;
4. starts the packaged deployment platform;
5. creates a browser account and completes the real CLI device-authorization flow;
6. deploys the generated application through the packaged CLI;
7. creates two independent authenticated sessions and proves live SSE synchronization;
8. proves a separate account cannot read the first account's owned rows;
9. deploys an immutable second migration and verifies the resulting SQLite history;
10. forces a failed health activation and proves the prior application and data remain available;
11. rolls back code and restores the pre-migration snapshot; and
12. verifies both application rows and migration schema returned to the expected state.

The test uses loopback HTTP, temporary owner-only directories, isolated CLI credentials, a one-port application range, and no registry downloads beyond the local tarball.

`npm run check` runs this suite after the build, zero-dependency check, and unit/integration tests. A release is not acceptable if conformance fails.
