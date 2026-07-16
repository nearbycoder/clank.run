# Release process

Clank releases are built from reviewed source and published without a long-lived registry token.

## One-time repository configuration

1. Make the GitHub repository public before the first public package release so npm can attach public provenance.
2. Protect `main`: require pull requests, the Node runtime checks, packaged-release conformance, conversation resolution, and a non-stale approval.
3. Protect tags matching `v*`.
4. Create the GitHub Actions environment `npm` and require a maintainer approval.
5. Reserve and configure the `clank.run` package's trusted publisher:
   - provider: GitHub Actions;
   - repository: `nearbycoder/clank.run`;
   - workflow: `release.yml`;
   - environment: `npm`; and
   - allowed action: publish, or stage-only when npm staged publishing is used.
6. After the trusted publisher succeeds, require two-factor authentication and disallow traditional publish tokens.
7. Enable GitHub private vulnerability reporting.

The release workflow uses Node 24 with npm 11.5.1 or newer and requests `id-token: write` only in the publish job. npm exchanges that GitHub OIDC identity for a short-lived publish credential and automatically produces package provenance for eligible public packages.

The `clank` npm name belongs to an unrelated project. Do not publish or document it as the framework dependency; the brand command remains `clank`, while package imports use `clank.run`.

## Release ceremony

1. Confirm `CHANGELOG.md` contains the complete version entry.
2. Update `package.json` to the intended semantic version.
3. Run `npm run check` from a clean checkout.
4. Open and merge the version pull request.
5. Create an annotated, protected `v<version>` tag from that merge.
6. Draft a GitHub release from the tag using the matching changelog entry.
7. Publish the GitHub release.
8. Approve the `npm` environment deployment after verifying the tag and workflow summary.
9. Verify:
   - the npm package shows provenance;
   - the attached `.tgz` verifies with `gh attestation verify`;
   - a fresh consumer can install, scaffold, build, and run; and
   - the package contains no database, credential, environment, platform-state, or unrelated generated files.

The GitHub release event runs the complete gate again, packs one tarball, creates a GitHub artifact attestation for it, attaches it to the release, and publishes the same source through npm trusted publishing.

## Failure handling

- Do not reuse or move a published version or tag.
- Deprecate a bad npm version and publish a new patch.
- If publication identity or source provenance is questionable, revoke obsolete tokens, disable publishing, preserve evidence, and follow `SECURITY.md`.
- A GitHub attestation proves which workflow and source produced an artifact; it does not prove the source itself is vulnerability-free.
