# Signed blueprint registry

Clank's blueprint registry is a dependency-free protocol and CLI for reusing application
blueprints without trusting mutable tags, registry-hosted code, redirects, or install hooks. A
publisher signs one normalized `clank-app/1` data contract as an exact semantic version. A registry
signs a monotonic catalog that binds that release's digest, publisher key, and same-origin path.
The installer verifies both signatures and then runs the ordinary deterministic generator.

The registry can be any static HTTPS origin. It needs no custom server and never receives a private
key. A catalog is discovery, not trust: trust begins in a small local `clank-blueprint-trust/1`
policy distributed through a separate reviewed channel.

## Protocol at a glance

| Artifact | Protocol | Authority |
| --- | --- | --- |
| Publisher private key | `clank-blueprint-private-key/1` | Signs releases in explicit owner namespaces |
| Trust policy | `clank-blueprint-trust/1` | Pins Ed25519 keys, roles, namespaces, registry origins, revocations, and minimum catalog sequences |
| Release | `clank-blueprint-release/1` | Binds exact `owner/name@version`, normalized blueprint, SHA-256 digests, publisher key, and signature |
| Catalog | `clank-blueprint-catalog/1` | Binds an HTTPS origin, monotonic sequence, exact release digests, publisher keys, and relative paths |

All signed values use canonical JSON and domain-separated Ed25519 signatures. Key IDs are the
lowercase SHA-256 fingerprint of the public SPKI bytes. Release and catalog signatures are
deterministic for identical canonical input. Exact semantic versions may include a prerelease but
not build metadata; `latest`, ranges, and mutable channels are intentionally unsupported.

## Create narrowly scoped keys

Create a publisher key that can sign only one owner namespace:

```sh
clank registry keygen publisher acme \
  --private ./keys/acme-publisher.private.json \
  --trust ./clank-blueprint.trust.json
```

Create a separate key for one registry origin. The command appends its public trust record to the
same trust policy:

```sh
clank registry keygen registry https://blueprints.example/ \
  --private ./keys/registry.private.json \
  --trust ./clank-blueprint.trust.json
```

Private files are written mode `0600`; public trust files are `0644`. Existing private or output
files are not replaced without `--force`, and symbolic-link destinations are refused. Keep private
keys outside the app, source control, artifacts, npm packages, logs, and the static registry. Use
separate publisher and registry keys so compromising one authority does not silently grant the
other role.

The generated public key has an exact role and scope. A wildcard `*` is supported by the protocol
for controlled private deployments, but the CLI never creates one implicitly.

## Sign an exact blueprint release

```sh
clank registry sign ./clank.app.ts acme/tasks@1.0.0 \
  --key ./keys/acme-publisher.private.json \
  --out ./publish/tasks-1.0.0.release.json

clank registry verify ./publish/tasks-1.0.0.release.json \
  --trust ./clank-blueprint.trust.json
```

Signing first passes the blueprint through the same static parser and complete normalizer as
`clank plan`; TypeScript modules are never executed. The release contains the complete normalized
blueprint, its independent digest, signed release metadata, release digest, and signature.
Verification rejects unknown envelope properties, malformed keys/signatures, noncanonical
blueprints, digest mismatch, wrong namespaces, untrusted/revoked keys, revoked releases, future
timestamps, and optional caller-defined minimum creation times.

`--json` returns `clank-registry-result/1` with the exact name, version, digest, publisher key, and
written path. It never prints private key bytes.

## Build a static signed catalog

The registry owner verifies every publisher release against the trust policy before cataloging it:

```sh
clank registry catalog https://blueprints.example/ 42 \
  ./publish/tasks-1.0.0.release.json \
  --key ./keys/registry.private.json \
  --trust ./clank-blueprint.trust.json \
  --out ./static/catalog.json
```

Catalog entries are sorted by exact name/version. With the default path prefix, place the exact
release bytes at:

```text
./static/releases/acme/tasks/1.0.0.json
```

Then serve `./static` from `https://blueprints.example/` as immutable static JSON. A different safe
relative prefix can be selected with `--path-prefix`. The command does not upload, move, or mutate
release files; this keeps hosting deployment explicit and reviewable. Increment `sequence` for
every catalog change, including a removal or revocation response. Never reuse a sequence for
different bytes.

The trust policy can remember:

```json
{
  "minimumCatalogSequences": {
    "https://blueprints.example/": 42
  }
}
```

Clients then reject a validly signed older catalog. Store the highest accepted sequence in trusted
configuration when rollback protection across runs matters.

## Install an exact verified release

```sh
clank registry install \
  https://blueprints.example/catalog.json \
  acme/tasks@1.0.0 \
  ./my-tasks \
  --trust ./clank-blueprint.trust.json
```

Install performs this fixed chain:

1. fetch the catalog as bounded `application/json` over credential-free default-port HTTPS;
2. refuse redirects and require the catalog's declared registry to match the fetched origin;
3. verify its registry key role, exact origin scope, digest, signature, and minimum sequence;
4. resolve only the requested exact name and version—never a tag or range;
5. fetch the signed registry-relative release from the same origin;
6. re-verify publisher role, namespace, release identity, digest, signature, revocation, and its
   binding to the catalog entry; and
7. generate the app with the ordinary reviewed-file overwrite rules and write `.clank/plan.json`.

Catalog and release responses are time- and byte-bounded, decompressed bytes are counted, response
content type is exact, caches are bypassed, cross-origin paths and traversal are impossible, and
even a caller-supplied `VerifiedBlueprintCatalog` wrapper is cryptographically rechecked. The
default response limit is 2 MiB and the hard maximum is 8 MiB.

`--framework=local`, an exact version, or another explicit dependency spec has the same meaning as
ordinary `clank generate`. Generation does not install dependencies, execute the blueprint,
contact the registry again, or run build/install hooks.

## Programmatic API

```ts
import {
  fetchBlueprintCatalog,
  resolveBlueprintRelease,
} from "@clank.run/framework/blueprint-registry";

const catalog = await fetchBlueprintCatalog(
  "https://blueprints.example/catalog.json",
  trustPolicy,
);

const verified = await resolveBlueprintRelease(
  catalog,
  { name: "acme/tasks", version: "1.0.0" },
  trustPolicy,
);

// verified.blueprint is normalized, frozen, data-only AppBlueprint.
```

Publishing APIs are `generateBlueprintSigningKey`, `signBlueprintRelease`, and
`signBlueprintCatalog`. Verification APIs are `createBlueprintTrustPolicy`,
`verifyBlueprintRelease`, `verifyBlueprintCatalog`, `fetchBlueprintCatalog`, and
`resolveBlueprintRelease`. Machine-readable failures use `BlueprintRegistryError.code` for trust,
digest, signature, rollback, origin, identity, response, and lookup failures.

## Rotation, revocation, and honest boundaries

- Add a replacement public key to trust before publishing releases or catalogs signed by it.
- Remove or add the old key ID to `revokedKeyIds` after the transition. Revoked keys fail closed
  for all releases, including releases claiming an earlier timestamp.
- Add a compromised release digest to `revokedReleaseDigests`, increment the catalog sequence, and
  remove its entry. Clients must receive the updated trust policy to learn release revocations.
- A signed blueprint proves publisher authorization and byte integrity, not product correctness.
  Review the blueprint, generated plan warnings, migrations, roles, actions, services, and source.
- Static hosting availability, TLS, DNS, private-key custody, trust-policy distribution, and
  durable highest-sequence storage remain operator responsibilities.
- The registry transports data-only application contracts. It is not a package manager and never
  distributes framework executables, arbitrary generators, plugins, scripts, secrets, database
  snapshots, compiled applications, or npm dependencies.
