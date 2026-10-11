import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createManagedIngress } = await import(process.env.CLANK_TEST_DATA_PLANE_SOURCE === "1"
  ? "../src/data-plane.ts" : "../dist/data-plane.js");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, kind = "provider") {
  const root = await mkdtemp(join(tmpdir(), "clank-canary-ingress-authority-"));
  const owner = new DatabaseSync(join(root, "authority.sqlite"));
  owner.exec("PRAGMA journal_mode=WAL; CREATE TABLE current_owner(id INTEGER PRIMARY KEY, active INTEGER NOT NULL); INSERT INTO current_owner VALUES(1,1)");
  const revoker = new DatabaseSync(join(root, "authority.sqlite"));
  const received = deferred(), disconnected = deferred(), metrics = [], checks = [], requests = [];
  let mode = "normal", held, candidateRequests = 0;
  const servers = [];
  t.after(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    revoker.close(); owner.close(); await rm(root, { recursive: true, force: true });
  });
  const revoke = () => revoker.prepare("UPDATE current_owner SET active=0 WHERE id=1").run();
  const listen = async candidateOnly => {
    const server = createServer((request, response) => {
      const candidate = candidateOnly || request.url.startsWith("/v1/clank/apps/project_candidate/");
      requests.push({ candidate, headers: request.headers, path: request.url });
      if (!candidate) return response.end("primary");
      candidateRequests++;
      if (mode === "disconnect") { revoke(); request.socket.destroy(); return; }
      if (mode === "headers") { held = response; received.resolve(); return; }
      if (mode === "body") {
        held = response; response.on("close", () => disconnected.resolve());
        response.writeHead(200); response.write("first"); received.resolve(); return;
      }
      if (mode === "retry" && candidateRequests === 1) {
        response.on("close", () => { revoke(); disconnected.resolve(); });
        response.writeHead(503); response.write("retry"); return;
      }
      response.end("candidate");
    });
    servers.push(server);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const upstream = await listen(false), candidateUpstream = kind === "local" ? await listen(true) : upstream;
  const runtime = (project, generation) => ({ protocol: "clank-runtime/1", generation, path: `/v1/clank/apps/${project}`, token: `${project}-private-ingress-token-12345678901234567890` });
  const route = { id: "canary_route", projectId: "project_primary", hosts: ["app.example.test"], upstream, active: true, releaseId: "release_primary",
    ...(kind === "provider" ? { runtime: runtime("project_primary", 5) } : {}),
    canary: { upstream: candidateUpstream, releaseId: "release_candidate", trafficPercent: 100,
      ...(kind === "provider" ? { runtime: runtime("project_candidate", 8), projectId: "project_candidate", readPaths: ["/catalog"] } : {}) } };
  const current = selected => {
    checks.push(selected);
    assert.equal(selected.projectId, "project_primary"); assert.equal(selected.releaseId, "release_primary");
    assert.equal(selected.canary.releaseId, "release_candidate");
    if (kind === "provider") { assert.equal(selected.runtime.generation, 5); assert.equal(selected.canary.runtime.generation, 8); }
    if (owner.prepare("SELECT active FROM current_owner WHERE id=1").get().active !== 1) throw new Error("Native canary ownership lost.");
  };
  return { route, checks, requests, metrics, received, disconnected, revoke, current,
    get candidateRequests() { return candidateRequests; }, get held() { return held; },
    set mode(value) { mode = value; },
    ingress(extra = {}) { return createManagedIngress({ routes: () => [route], retries: 1, assertCanaryCurrent: current, onRequest: metric => metrics.push(metric), ...extra }); },
    request(path = "/catalog", init) { return new Request(`https://app.example.test${path}`, init); } };
}

for (const kind of ["local", "provider"]) test(`native ${kind} canary authority is checked before fetch with the frozen primary identity`, { timeout: 10000 }, async t => {
  const f = await fixture(t, kind), ingress = f.ingress(); f.revoke();
  const response = await ingress.handle(f.request());
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "CANARY_UNAVAILABLE");
  assert.equal(f.candidateRequests, 0); assert.ok(f.checks.length > 0); assert.equal(Object.isFrozen(f.checks[0]), true);
  assert.equal(f.metrics.length, 1); assert.equal(f.metrics[0].projectId, "project_primary"); assert.equal(f.metrics[0].releaseId, "release_candidate");
  assert.equal(ingress.activeRequests(f.route.canary.upstream), 0);
});

test("native ownership loss while real candidate response headers are pending cancels without retry", { timeout: 10000 }, async t => {
  const f = await fixture(t), ingress = f.ingress(); f.mode = "headers";
  const pending = ingress.handle(f.request()); await f.received.promise;
  f.revoke(); f.held.end("must not be returned");
  const response = await pending;
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "CANARY_UNAVAILABLE");
  assert.equal(f.candidateRequests, 1); assert.equal(f.metrics.length, 1); assert.equal(ingress.activeRequests(f.route.upstream), 0);
});

test("native ownership lost during actual retry-body cancellation prevents the next candidate fetch", { timeout: 10000 }, async t => {
  const f = await fixture(t), ingress = f.ingress(); f.mode = "retry";
  const response = await ingress.handle(f.request()); await f.disconnected.promise;
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "CANARY_UNAVAILABLE");
  assert.equal(f.candidateRequests, 1); assert.equal(f.metrics.length, 1); assert.equal(ingress.activeRequests(f.route.upstream), 0);
});

test("native authority is rechecked when the last candidate fetch rejects after a socket closes", { timeout: 10000 }, async t => {
  const f = await fixture(t), ingress = f.ingress({ retries: 0 }); f.mode = "disconnect";
  const response = await ingress.handle(f.request());
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "CANARY_UNAVAILABLE");
  assert.equal(f.candidateRequests, 1); assert.equal(f.metrics.length, 1); assert.equal(ingress.activeRequests(f.route.upstream), 0);
});

for (const when of ["before read", "during read"]) test(`streaming candidate ownership loss ${when} preserves delivered-byte attribution and drains`, { timeout: 10000 }, async t => {
  const f = await fixture(t), ingress = f.ingress(); f.mode = "body";
  const response = await ingress.handle(f.request()), reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  let reading;
  if (when === "during read") reading = reader.read();
  f.revoke();
  reading ??= reader.read();
  if (when === "during read") f.held.write("stale");
  await assert.rejects(reading, /Native canary ownership lost/);
  await f.disconnected.promise;
  assert.equal(f.metrics.length, 1); assert.equal(f.metrics[0].responseOutcome, "error"); assert.equal(f.metrics[0].responseBytes, 5);
  assert.equal(f.metrics[0].projectId, "project_primary"); assert.equal(f.metrics[0].releaseId, "release_candidate");
  assert.equal(await ingress.drain(f.route.upstream, 100), true); assert.equal(ingress.activeRequests(f.route.upstream), 0);
});

test("current canary streams complete while primary and ineligible requests bypass the canary assertion", { timeout: 10000 }, async t => {
  const f = await fixture(t), ingress = f.ingress();
  const response = await ingress.handle(f.request()); assert.equal(await response.text(), "candidate"); assert.ok(f.checks.length >= 3);
  assert.equal(f.metrics.at(-1).responseOutcome, "complete"); assert.equal(f.metrics.at(-1).responseBytes, 9);
  const before = f.checks.length; f.revoke();
  for (const [path, init] of [["/other", {}], ["/catalog?private=1", {}], ["/catalog", { headers: { cookie: "private=1" } }], ["/catalog", { method: "POST", body: "private write" }]]) {
    assert.equal(await (await ingress.handle(f.request(path, init))).text(), "primary");
  }
  f.route.canary.trafficPercent = 0;
  assert.equal(await (await ingress.handle(f.request())).text(), "primary"); assert.equal(f.checks.length, before);
  assert.equal(f.metrics.at(-1).releaseId, "release_primary");
});

for (const [name, invalid] of [["non-undefined", () => true], ["asynchronous", async () => { throw new Error("Async authority cannot be awaited."); }]]) test(`canary authority rejects ${name} results before candidate effects`, { timeout: 10000 }, async t => {
  const f = await fixture(t), ingress = f.ingress({ assertCanaryCurrent: invalid });
  const response = await ingress.handle(f.request()); assert.equal(response.status, 503); await response.text(); assert.equal(f.candidateRequests, 0);
});

test("the canary authority callback is captured before caller options can change", { timeout: 10000 }, async t => {
  const f = await fixture(t), options = { routes: () => [f.route], assertCanaryCurrent: f.current };
  const ingress = createManagedIngress(options); options.assertCanaryCurrent = () => undefined; f.revoke();
  const response = await ingress.handle(f.request()); assert.equal(response.status, 503); await response.text(); assert.equal(f.candidateRequests, 0);
});
