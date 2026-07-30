# Provider runtime ingress

`@clank.run/framework/provider-runtime` is the provider-private traffic boundary between Clank
managed ingress and application runtimes. It is zero-dependency, provider-neutral, and designed to
sit beside a Docker, VM, microVM, Nomad, or Kubernetes launcher.

It solves one narrow problem completely: a request for project A, release B, and generation C can
reach only the loopback runtime explicitly published for that exact binding.

## Create the registry

```ts
import {
  createDeploymentRuntimeIngress,
} from "@clank.run/framework/provider-runtime";

const runtimeIngress = createDeploymentRuntimeIngress({
  timeoutMs: 30_000,
  maxBodyBytes: 25 * 1024 * 1024,
  maxUrlLength: 8 * 1024,
  maxBindings: 10_000,
  onError(error) {
    privateProviderLog(error);
  },
});
```

Expose `runtimeIngress.handle(request)` only through the trusted provider HTTP service used by the
managed data plane. Terminate TLS before that handler and restrict network admission to the Clank
edge whenever possible. Application listeners stay private on `127.0.0.1` or `[::1]`; the
registry rejects a remote, HTTPS, credential-bearing, path-bearing, query-bearing, or fragment
upstream.

## Activate one generation

After the provider has staged code and data, launched an isolated candidate, and checked it
directly over loopback, publish its capsule binding:

```ts
const state = await runtimeIngress.activate({
  protocol: "clank-runtime/1",
  projectId: prepared.projectId,
  releaseId: prepared.releaseId,
  generation: prepared.generation,
  path: prepared.ingress.route,
  token: prepared.ingress.token,
  upstream: candidate.url, // for example http://127.0.0.1:4617
});
```

Activation validates an exact plain object and a safe, unencoded provider path. It computes the
route token's SHA-256 digest and retains no plaintext token. `inspect()` returns only project,
release, generation, provider path, activation time, in-flight count, and whether that is the
latest accepted generation. It never returns the token digest or loopback origin.

An exact activation retry is idempotent only while that binding remains published. A conflicting
copy of the same generation, a deactivated or lower generation, a cross-project path collision, or
a capacity overflow fails closed. An activation already validating its token cannot publish after
`close()` begins. The same configured ceiling bounds both remembered project high-water marks and
the combined published/draining generation set.

After a confirmed permanent project deletion has removed its provider-owned runtime and data,
`forget(projectId, generation)` can release that inactive project's exact high-water entry. It
refuses while any generation for the project is published or draining and ignores a mismatched
generation, so a stale cleanup cannot free a live identity.

## End-to-end request binding

The public managed data plane fixes the provider origin and path, removes client-controlled
binding headers, and sends:

- `x-clank-project-id`;
- `x-clank-runtime-protocol`;
- `x-clank-runtime-generation`; and
- `x-clank-runtime-ingress`.

The provider registry selects a published path and exact project/generation before hashing the
supplied token in constant-work comparison. Missing paths, invalid headers, stale generations, and
wrong tokens all return the same generic `503 RUNTIME_UNAVAILABLE` response without calling an
application.

After successful validation, the provider:

- retains an in-flight lease before asynchronous token verification, closing the
  activation/authentication race;
- strips all binding and hop-by-hop headers before calling the application;
- builds the target from the fixed loopback origin before assigning the public path suffix;
- preserves application authorization, cookies, forwarding headers, query strings, and streaming
  responses;
- bounds URL and request-body intake, applies a request deadline, and refuses redirects; and
- strips private server and binding headers from the application response.

The route credential therefore authenticates the edge-to-provider hop. It is never forwarded into
application code, placed in a URL, returned in inspection, or included in a public failure.

## Overlap, switch, and drain

New and old generations of one project may be published together, including on the same provider
path. The trusted generation header chooses between them. This permits a code-only or
externally-stateful rollout to avoid a distributed switch gap:

1. launch and health-check generation 12;
2. `activate()` generation 12 while generation 11 remains published;
3. atomically switch managed ingress to generation 12;
4. call `deactivate(projectId, 11)`;
5. wait for its returned `drained` result, then stop generation 11.

`deactivate()` removes the exact generation from new routing before waiting for response streams
already assigned to it. A retry waits for the same in-progress drain instead of falsely reporting
success. A stale generation cannot revoke the latest one. `drain()` only waits; use it after
another boundary has stopped assigning new traffic. A timeout returns `drained: false`, but retains
the generation until its final stream ends; it cannot be forgotten or reactivated during that
interval.

SQLite restore and migration are stopped-runtime operations in the packaged
[provider data lifecycle](provider-data-lifecycle.md). Do not keep an old runtime writing the same
database merely to achieve overlap. Revoke and drain it first, accept the resulting maintenance
window, or use a data architecture that safely supports concurrent versions. Availability never
justifies corrupting project data.

## Process and data lifecycle

This registry intentionally does not:

- launch or sandbox application processes;
- persist environment values or route tokens;
- mutate provider SQLite data;
- decide placement or node ownership;
- publish the control-plane edge route; or
- issue TLS certificates.

A complete provider composes it with
`openDeploymentProviderDataStore()`, the package-supported
`openDockerDeploymentRuntimeLauncher()` or a stronger isolated launcher, the standard deployment
provider, and the runner agent. Keep the prepared environment and plaintext ingress token
memory-only. Publish traffic only after the provider data commit succeeds.

`openDockerDeploymentProviderService()` is the package-supported composition. It persists the
desired operation/fence, drains before writer shutdown, defers jobs until data commit, activates
this ingress last, and cleans a failed candidate in reverse order. Use the lower-level registry
directly only when implementing another runtime boundary.

On provider restart the in-memory registry begins empty and returns generic unavailable responses.
The Docker reference launcher likewise removes exact-owner orphan containers instead of adopting
them. The hosted activation integration must reset/reconcile the node's desired generation before
restoring traffic; it must not infer a live process from old control-plane observation alone.

## Shutdown

`close()` atomically revokes every published generation and waits up to the supplied deadline for
assigned streams. No new activation is accepted afterward. This makes a provider service shutdown
fail closed while leaving process termination policy with the launcher.

Continue with [Managed ingress and external data](data-plane.md),
[Provider data lifecycle](provider-data-lifecycle.md),
[Provider Docker runtime](provider-docker-runtime.md),
[Complete deployment provider service](provider-service.md),
[Deployment provider adapters](provider-adapters.md), and
[Remote runtime placement](runtime-placement.md).
