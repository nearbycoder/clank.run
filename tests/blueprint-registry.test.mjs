import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  BlueprintRegistryError,
  createBlueprintTrustPolicy,
  fetchBlueprintCatalog,
  generateBlueprintSigningKey,
  resolveBlueprintRelease,
  signBlueprintCatalog,
  signBlueprintRelease,
  verifyBlueprintCatalog,
  verifyBlueprintRelease,
} from "../dist/blueprint-registry.js";

const NOW = Date.now();
const execute = promisify(execFile);
const cli = new URL("../scripts/clank.mjs", import.meta.url);
const blueprint = {
  name: "Signed Tasks",
  description: "A small signed task application.",
  entities: {
    todos: {
      description: "Work to complete.",
      ownership: "user",
      realtime: true,
      displayField: "title",
      completionField: "done",
      fields: {
        title: { type: "string", min: 1, max: 200 },
        done: { type: "boolean", default: false },
      },
    },
  },
  routes: [{ path: "/", view: "Todos", entity: "todos", access: "authenticated" }],
  actions: {
    "todos.list": { description: "List todos.", entity: "todos", operation: "read", behavior: "list" },
    "todos.add": { description: "Add a todo.", entity: "todos", operation: "create" },
  },
};

async function fixture() {
  const publisher = await generateBlueprintSigningKey("Acme blueprint publisher", {
    createdAt: NOW,
    scope: { role: "publisher", namespaces: ["acme"] },
  });
  const registry = await generateBlueprintSigningKey("Acme blueprint registry", {
    createdAt: NOW,
    scope: { role: "registry", registries: ["https://blueprints.example/"] },
  });
  const trust = createBlueprintTrustPolicy({ keys: [publisher.trustKey, registry.trustKey] });
  const release = await signBlueprintRelease(blueprint, {
    name: "acme/tasks",
    version: "1.2.3",
    createdAt: NOW,
    key: publisher.privateKey,
  });
  const catalog = await signBlueprintCatalog({
    registry: "https://blueprints.example/",
    sequence: 7,
    createdAt: NOW,
    releases: [{
      name: release.name,
      version: release.version,
      description: release.description,
      releaseDigest: release.digest,
      publisherKeyId: release.publisherKeyId,
      path: "releases/acme/tasks/1.2.3.json",
    }],
    key: registry.privateKey,
  });
  return { publisher, registry, trust, release, catalog };
}

test("signed blueprint releases bind normalized data, identity, namespace, digest, and Ed25519 key", async () => {
  const { publisher, trust, release } = await fixture();
  const verified = await verifyBlueprintRelease(release, trust, { now: NOW });

  assert.equal(verified.release.name, "acme/tasks");
  assert.equal(verified.release.version, "1.2.3");
  assert.equal(verified.blueprint.protocol, "clank-app/1");
  assert.equal(verified.publisher.keyId, publisher.privateKey.keyId);
  assert.match(release.digest, /^[a-f0-9]{64}$/u);
  assert.match(release.signature, /^[A-Za-z0-9_-]{86}$/u);
  assert.equal(Object.isFrozen(verified.blueprint.entities.todos), true);

  const repeated = await signBlueprintRelease(blueprint, {
    name: "acme/tasks",
    version: "1.2.3",
    createdAt: NOW,
    key: publisher.privateKey,
  });
  assert.deepEqual(repeated, release, "the same key and canonical release must sign deterministically");

  await assert.rejects(verifyBlueprintRelease({ ...release, description: "Tampered." }, trust, { now: NOW }), (error) =>
    error instanceof BlueprintRegistryError && error.code === "RELEASE_DIGEST_MISMATCH");
  const changedSignature = `${release.signature.startsWith("A") ? "B" : "A"}${release.signature.slice(1)}`;
  await assert.rejects(verifyBlueprintRelease({ ...release, signature: changedSignature }, trust, { now: NOW }), /signature verification failed/u);
  await assert.rejects(verifyBlueprintRelease(release, createBlueprintTrustPolicy({
    keys: [publisher.trustKey],
    revokedKeyIds: [publisher.trustKey.keyId],
  }), { now: NOW }), (error) => error.code === "KEY_REVOKED");
  await assert.rejects(verifyBlueprintRelease(release, createBlueprintTrustPolicy({
    keys: [{ ...publisher.trustKey, namespaces: ["other"] }],
  }), { now: NOW }), (error) => error.code === "NAMESPACE_UNTRUSTED");
  await assert.rejects(signBlueprintRelease(blueprint, {
    name: "acme/tasks",
    version: "latest",
    createdAt: NOW,
    key: publisher.privateKey,
  }), /exact semantic version/u);
});

test("signed catalogs bind exact origins, monotonic sequences, sorted releases, and immutable entries", async () => {
  const { registry, trust, release, catalog } = await fixture();
  const verified = await verifyBlueprintCatalog(catalog, trust, { now: NOW });
  assert.equal(verified.catalog.registry, "https://blueprints.example/");
  assert.equal(verified.catalog.sequence, 7);
  assert.equal(verified.registry.keyId, registry.trustKey.keyId);

  const olderRefused = createBlueprintTrustPolicy({
    keys: trust.keys,
    minimumCatalogSequences: { "https://blueprints.example/": 8 },
  });
  await assert.rejects(verifyBlueprintCatalog(catalog, olderRefused, { now: NOW }), (error) =>
    error instanceof BlueprintRegistryError && error.code === "CATALOG_ROLLBACK");

  const tampered = structuredClone(catalog);
  tampered.releases[0].releaseDigest = "0".repeat(64);
  await assert.rejects(verifyBlueprintCatalog(tampered, trust, { now: NOW }), (error) => error.code === "CATALOG_DIGEST_MISMATCH");

  const second = await signBlueprintRelease({ ...blueprint, name: "Another" }, {
    name: "acme/another",
    version: "1.0.0",
    createdAt: NOW,
    key: (await generateBlueprintSigningKey("Second", { scope: { role: "publisher", namespaces: ["acme"] }, createdAt: NOW })).privateKey,
  });
  const sorted = await signBlueprintCatalog({
    registry: "https://blueprints.example/",
    sequence: 8,
    createdAt: NOW,
    releases: [
      { name: release.name, version: release.version, description: release.description, releaseDigest: release.digest, publisherKeyId: release.publisherKeyId, path: "z.json" },
      { name: second.name, version: second.version, description: second.description, releaseDigest: second.digest, publisherKeyId: second.publisherKeyId, path: "a.json" },
    ],
    key: registry.privateKey,
  });
  assert.deepEqual(sorted.releases.map((entry) => entry.name), ["acme/another", "acme/tasks"]);
});

test("remote resolution re-verifies catalogs and releases over bounded same-origin no-redirect JSON", async () => {
  const { trust, release, catalog } = await fixture();
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("catalog.json")) return Response.json(catalog, { headers: { "content-type": "application/json" } });
    if (String(url).endsWith("1.2.3.json")) return Response.json(release, { headers: { "content-type": "application/json" } });
    return new Response("missing", { status: 404 });
  };

  const verifiedCatalog = await fetchBlueprintCatalog("https://blueprints.example/catalog.json", trust, {
    fetch: transport,
    timeoutMs: 1_000,
  });
  const verified = await resolveBlueprintRelease(verifiedCatalog, { name: "acme/tasks", version: "1.2.3" }, trust, {
    fetch: transport,
    timeoutMs: 1_000,
  });
  assert.equal(verified.blueprint.slug, "signed-tasks");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://blueprints.example/catalog.json",
    "https://blueprints.example/releases/acme/tasks/1.2.3.json",
  ]);
  assert.equal(calls.every((call) => call.init.redirect === "manual" && call.init.cache === "no-store"), true);

  const forgedWrapper = { catalog: { ...catalog, sequence: 8 }, registry: verifiedCatalog.registry };
  await assert.rejects(resolveBlueprintRelease(forgedWrapper, { name: "acme/tasks", version: "1.2.3" }, trust, { fetch: transport }), (error) =>
    error.code === "CATALOG_DIGEST_MISMATCH");
  await assert.rejects(fetchBlueprintCatalog("https://blueprints.example/catalog.json", trust, {
    fetch: async () => new Response(JSON.stringify(catalog), { headers: { "content-type": "text/plain" } }),
  }), (error) => error.code === "CONTENT_TYPE_INVALID");
  await assert.rejects(fetchBlueprintCatalog("https://blueprints.example/catalog.json", trust, {
    maxBytes: 1_024,
    fetch: async () => new Response("x".repeat(2_000), { headers: { "content-type": "application/json" } }),
  }), (error) => error.code === "RESPONSE_TOO_LARGE");
  await assert.rejects(fetchBlueprintCatalog("https://blueprints.example/catalog.json", trust, {
    fetch: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
  }), (error) => error.code === "REDIRECT_REFUSED");
  await assert.rejects(fetchBlueprintCatalog("https://blueprints.example/catalog.json", trust, {
    timeoutMs: 100,
    fetch: async () => new Promise(() => {}),
  }), (error) => error.code === "FETCH_TIMEOUT");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchBlueprintCatalog("https://blueprints.example/catalog.json", trust, {
    signal: controller.signal,
    fetch: async () => new Promise(() => {}),
  }), (error) => error.code === "FETCH_ABORTED");
});

test("keys and trust policies reject implicit authority, mismatched material, unsafe paths, and wildcard drift", async () => {
  await assert.rejects(generateBlueprintSigningKey("Unscoped"), /explicit publisher or registry scope/u);
  const { publisher, registry, release } = await fixture();
  const mismatched = { ...publisher.privateKey, publicKey: registry.privateKey.publicKey };
  await assert.rejects(signBlueprintRelease(blueprint, {
    name: "acme/tasks",
    version: "1.0.0",
    key: mismatched,
  }), /key ID does not match/u);
  assert.throws(() => createBlueprintTrustPolicy({ keys: [{ ...publisher.trustKey, namespaces: [] }] }), /at least one namespace/u);
  await assert.rejects(signBlueprintCatalog({
    registry: "https://blueprints.example/",
    sequence: 1,
    releases: [{ name: release.name, version: release.version, description: release.description, releaseDigest: release.digest, publisherKeyId: release.publisherKeyId, path: "../release.json" }],
    key: registry.privateKey,
  }), /safe registry-relative JSON path/u);
});

test("the CLI creates scoped keys, signs, verifies, and catalogs reusable blueprints", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "clank-blueprint-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "clank.app.json");
  const publisherKey = join(root, "publisher.private.json");
  const registryKey = join(root, "registry.private.json");
  const trust = join(root, "trust.json");
  const release = join(root, "release.json");
  const catalog = join(root, "catalog.json");
  await writeFile(source, `${JSON.stringify(blueprint, null, 2)}\n`);
  const run = async (...args) => execute(process.execPath, [cli.pathname, ...args], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });

  const publisher = await run("registry", "keygen", "publisher", "acme", "--private", publisherKey, "--trust", trust, "--json");
  assert.equal(JSON.parse(publisher.stdout).role, "publisher");
  await run("registry", "keygen", "registry", "https://blueprints.example/", "--private", registryKey, "--trust", trust, "--json");
  assert.equal((await stat(publisherKey)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(trust, "utf8")).keys.length, 2);

  const signed = await run("registry", "sign", source, "acme/tasks@1.0.0", "--key", publisherKey, "--out", release, "--json");
  assert.match(JSON.parse(signed.stdout).digest, /^[a-f0-9]{64}$/u);
  const verified = await run("registry", "verify", release, "--trust", trust, "--json");
  assert.equal(JSON.parse(verified.stdout).valid, true);
  const cataloged = await run("registry", "catalog", "https://blueprints.example/", "1", release, "--key", registryKey, "--trust", trust, "--out", catalog, "--json");
  assert.equal(JSON.parse(cataloged.stdout).releases, 1);
  assert.equal(JSON.parse(await readFile(catalog, "utf8")).releases[0].path, "releases/acme/tasks/1.0.0.json");

  await assert.rejects(run("registry", "keygen", "publisher", "acme", "--private", publisherKey, "--trust", trust), (error) => {
    assert.match(error.stderr, /Refusing to overwrite/u);
    return true;
  });
});
