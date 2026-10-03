# Release process

Clank releases are built from reviewed source, submitted through npm trusted publishing without a long-lived registry token, and approved by a maintainer with two-factor authentication.

## One-time repository configuration

1. Make the GitHub repository public before the first public package release so npm can attach public provenance.
2. Protect `main`: require pull requests, the Node runtime checks, packaged-release conformance, conversation resolution, and a non-stale approval.
3. Protect tags matching `v*`.
4. Create the GitHub Actions environment `npm` and require a maintainer approval.
5. Sign in to npm as an owner of the `clank.run` organization, enable account-level 2FA, and confirm `@clank.run/framework` is still available.
6. Bootstrap the package because npm requires it to exist before a trusted publisher can be attached:

   ```bash
   npm login
   npm run check
   npm pack --dry-run
   npm publish --access public --provenance=false
   ```

   This is the only direct, interactive publish. Inspect the tarball and package page before entering the 2FA code. The first version will not have CI provenance; every subsequent version will.
7. Configure the `@clank.run/framework` trusted publisher:
   - provider: GitHub Actions;
   - repository: `nearbycoder/clank.run`;
   - workflow: `release.yml`;
   - environment: `npm`; and
   - allowed action: stage publish only.
8. With npm 11.18 or newer, the equivalent authenticated CLI command is:

   ```bash
   npm trust github @clank.run/framework \
     --repository nearbycoder/clank.run \
     --file release.yml \
     --environment npm \
     --allow-stage-publish
   ```

9. Require two-factor authentication, disallow traditional publish tokens, and revoke any bootstrap token or saved npm session that is no longer needed.
10. Enable GitHub private vulnerability reporting.
11. Route `docs.clank.run` to the platform service and set `CLANK_DOCUMENTATION_HOST=docs.clank.run`
    on that service to opt into the documentation bundled in its Docker image. Keep the host exact;
    other hosts continue to use the platform's ordinary routing. The documentation rollout workflow
    needs no deployment token, linked project, or GitHub environment secret.

Design Studio still uses a project-scoped `CLANK_DESIGN_TOKEN` with `read,deploy,rollback`
permissions in the protected `design` environment. Its `rollback` permission allows inactive-release
pruning when artifact capacity is full. A token limited to `read,deploy` cannot reclaim old release
storage. Rotate by creating a replacement token, updating the environment secret, verifying a
successful workflow run, then revoking the old token. Never use an account-wide device token.

The release workflow uses Node 24 with npm 11.18.0 and requests `id-token: write` only in the publish job. npm exchanges that GitHub OIDC identity for a short-lived credential and automatically produces package provenance for the public package.

The `clank` npm name belongs to an unrelated project. Do not publish or document it as the framework dependency; the brand command remains `clank`, while package imports use `@clank.run/framework`.

## Release ceremony

1. Confirm `CHANGELOG.md` contains the complete version entry.
2. Update `package.json` to the intended semantic version.
3. Run `npm run check` from a clean checkout.
4. Open and merge the version pull request.
5. Create an annotated, protected `v<version>` tag from that merge.
6. Draft a GitHub release from the tag using the matching changelog entry.
7. Publish the GitHub release.
8. Approve the `npm` GitHub environment deployment after verifying the tag and workflow summary.
9. Download and inspect the staged npm tarball, then approve it with 2FA from npmjs.com or `npm stage approve <stage-id>`.
10. Verify:
   - the npm package shows provenance;
   - the attached `.tgz` verifies with `gh attestation verify`;
   - a fresh consumer can install, scaffold, build, and run; and
   - `https://docs.clank.run/healthz` reports the released framework version; and
   - the package contains no database, credential, environment, platform-state, or unrelated generated files.

The GitHub release event runs the complete gate again, packs one tarball, creates a GitHub artifact attestation for it, attaches it to the release, and submits the same source to npm's staged-publishing queue through trusted publishing.

The security gate also requires the package version, dated changelog heading, and the dependency
example in Getting Started to match exactly. A version pull request therefore cannot pass while
the published identity and installation documentation disagree.

The production Docker image includes the documentation build and canonical Markdown corpus.
With `CLANK_DOCUMENTATION_HOST=docs.clank.run`, the platform serves that immutable build for the
exact documentation host, so documentation changes roll out with the platform image. This path
does not create a hosted application release or run tenant SQLite tasks. Standalone documentation
hosting remains supported through the `docs-site` build and public Clank deployment commands.

Every successful same-repository `main` CI run starts the documentation rollout verification
workflow. It checks out the exact commit that passed CI and makes read-only requests to
`https://docs.clank.run`: the full Getting Started Markdown must match that source, and the home
page must expose its copyable setup prompt. Requests have ten-second timeouts and retries stop
after 270 seconds. A newer verification run cancels the preceding one. The workflow does not
rebuild, deploy, prune releases, or use deployment credentials. Pull requests, forks, failed CI
runs, and other branches cannot start its verification job.

## Failure handling

- Do not reuse or move a published version or tag.
- Deprecate a bad npm version and publish a new patch.
- If publication identity or source provenance is questionable, revoke obsolete tokens, disable publishing, preserve evidence, and follow `SECURITY.md`.
- A GitHub attestation proves which workflow and source produced an artifact; it does not prove the source itself is vulnerability-free.
