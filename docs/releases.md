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
   - the package contains no database, credential, environment, platform-state, or unrelated generated files.

The GitHub release event runs the complete gate again, packs one tarball, creates a GitHub artifact attestation for it, attaches it to the release, and submits the same source to npm's staged-publishing queue through trusted publishing.

## Failure handling

- Do not reuse or move a published version or tag.
- Deprecate a bad npm version and publish a new patch.
- If publication identity or source provenance is questionable, revoke obsolete tokens, disable publishing, preserve evidence, and follow `SECURITY.md`.
- A GitHub attestation proves which workflow and source produced an artifact; it does not prove the source itself is vulnerability-free.
