import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { setImmediate as immediate } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = process.env.CLANK_TEST_SHADOW_SOURCE === "1";
const { serve } = await import(source ? "../src/node.ts" : "../dist/node.js");
const { createManagedIngress } = await import(source ? "../src/data-plane.ts" : "../dist/data-plane.js");
const { exactRequest, registerRequestHandoff, takeRequestHandoff } = await import(source ? "../src/security.ts" : "../dist/security.js");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise, ms = 4000) => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error("Native HTTP fixture did not settle.")), ms); timer.unref();
})]);

function decodeWire(wire) {
  const split = wire.indexOf("\r\n\r\n"), headers = wire.slice(0, split), encoded = wire.slice(split + 4);
  if (!/transfer-encoding: chunked/i.test(headers)) return { status: Number(headers.split(" ")[1]), body: encoded };
  let body = "", cursor = 0;
  while (cursor < encoded.length) {
    const end = encoded.indexOf("\r\n", cursor), size = parseInt(encoded.slice(cursor, end), 16);
    if (!size || end < 0) break;
    body += encoded.slice(end + 2, end + 2 + size); cursor = end + 2 + size + 2;
  }
  return { status: Number(headers.split(" ")[1]), body };
}

async function raw(url, { method = "GET", target = "/catalog", headers = [], body = "", firstByte } = {}) {
  const port = Number(new URL(url).port);
  return bounded(new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }); let wire = "", first = true;
    socket.setTimeout(3000, () => socket.destroy(new Error("Raw HTTP response timed out.")));
    socket.on("error", reject);
    socket.on("data", chunk => { if (first) { first = false; firstByte?.(); } wire += chunk.toString("latin1"); });
    socket.on("end", () => resolve(decodeWire(wire)));
    socket.on("connect", () => socket.write(Buffer.from(`${method} ${target} HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n${headers.map(pair => pair.join(": ") + "\r\n").join("")}\r\n${body}`, "latin1")));
  }));
}

async function fixture(t, options = {}) {
  const requests = [], observations = [], chunks = [], finishes = [], handoffs = [], errors = [];
  const primary = createServer((request, response) => {
    requests.push({ path: request.url, headers: request.headers });
    if (options.primary) return options.primary(request, response);
    response.setHeader("content-type", "Application/JSON; charset=utf-8"); response.end("primary");
  });
  await new Promise(resolve => primary.listen(0, "127.0.0.1", resolve));
  const route = { id: "route_shadow", projectId: "project_shadow", releaseId: "release_shadow", active: true, hosts: ["app.test"], upstream: `http://127.0.0.1:${primary.address().port}` };
  const observer = options.observer ?? { observe(request, selected, metadata) {
    const exact = exactRequest(request); observations.push({ request, selected, metadata, exact });
    assert.equal(exactRequest(request.clone()), undefined);
    assert.equal(registerRequestHandoff(request, () => { handoffs.push(exact); return undefined; }) instanceof Function, true);
    return { chunk(length) { chunks.push(length); return undefined; }, finish(kind, elapsed) { finishes.push({ kind, elapsed }); return undefined; } };
  } };
  const ingress = createManagedIngress({ routes: () => [route], shadow: observer, retries: 0, ...(options.ingress ?? {}) });
  const server = await serve(request => options.handler ? options.handler(request, ingress) : ingress.handle(request), {
    port: 0, allowedHosts: ["app.test"], trustProxy: options.trustProxy ?? false, onError: error => errors.push(error),
  });
  t.after(async () => { await server.close(); primary.closeAllConnections(); await new Promise(resolve => primary.close(resolve)); });
  return { server, route, ingress, observations, requests, chunks, finishes, handoffs, errors };
}

test("native anonymous GET and HEAD supply frozen bounded metadata and one post-write handoff", async t => {
  const f = await fixture(t);
  for (const method of ["GET", "HEAD"]) {
    const response = await raw(f.server.url, { method, headers: [["Accept", "application/json"], ["User-Agent", "not-retained"], ["Referer", "https://private.example/history"]] });
    assert.equal(response.status, 200); assert.equal(response.body, method === "GET" ? "primary" : "");
  }
  await immediate(); assert.equal(f.observations.length, 2); assert.equal(f.handoffs.length, 2);
  assert.deepEqual(f.chunks, [7]); assert.deepEqual(f.finishes.map(item => item.kind), ["complete", "complete"]);
  for (const observation of f.observations) {
    assert.deepEqual(Object.keys(observation.exact).sort(), ["accept", "method", "path"]);
    assert.equal(observation.exact.path, "/catalog"); assert.equal(observation.exact.accept, "application/json");
    assert.equal(observation.metadata.statusClass, 2); assert.equal(observation.metadata.mediaType, "application/json");
    assert.ok(observation.metadata.headersElapsedMs >= 0); assert.equal(observation.metadata.bodyExpected, observation.exact.method === "GET");
    assert.ok(Object.isFrozen(observation.selected)); assert.ok(Object.isFrozen(observation.selected.hosts)); assert.ok(Object.isFrozen(observation.metadata));
    assert.equal(observation.selected.releaseId, "release_shadow"); assert.equal(observation.selected.canary, undefined);
    assert.equal(registerRequestHandoff(observation.request, () => undefined), undefined);
    assert.equal(takeRequestHandoff(observation.request), undefined);
  }
});

test("actual raw targets and framing refuse observation without changing primary results", async t => {
  const observed = await fixture(t), ordinary = await fixture(t, { observer: {} });
  const cases = [
    ...["/a/../catalog", "/./catalog", "/%63atalog", "/catalog\\next", "/catalog?", "/catalog?private=1", "/catalog#secret", "//catalog", "http://app.test/catalog", "/caf\u00e9", "/" + "a".repeat(512)].map(target => ({ target })),
    { headers: [["Content-Length", "0"]] }, { headers: [["Content-Length", "1"]], body: "x" },
    { headers: [["Transfer-Encoding", "chunked"]], body: "1\r\nx\r\n0\r\n\r\n" },
    { headers: [["Accept", "a"], ["accept", "b"]] }, { headers: [["Content-Length", "0"], ["Content-Length", "0"]] },
    ...["Authorization", "Cookie", "Origin", "Range", "If-None-Match", "X-Custom", "X-Clank-Client-Ip", "Expect", "Trailer", "Upgrade"].map(name => ({ headers: [[name, "private"]] })),
    { headers: [["Accept", "a".repeat(513)]] }, { headers: [["User-Agent", "a".repeat(2049)]] },
    { headers: [["Accept", "a\tb"]] }, { headers: [["Connection", "upgrade"]] },
    { headers: ["User-Agent", "Referer", "Sec-Ch-Ua", "Accept-Language", "Accept-Encoding"].map(name => [name, "a".repeat(1700)]) },
  ];
  for (const input of cases) {
    const expected = await raw(ordinary.server.url, input), actual = await raw(observed.server.url, input);
    assert.deepEqual(actual, expected, JSON.stringify(input));
    assert.equal(observed.observations.length, 0, JSON.stringify(input));
  }
  assert.equal(observed.handoffs.length, 0);
});

test("trusted proxy fields are proof-only and current header mutation or cloning removes eligibility", async t => {
  const forwarded = [["Forwarded", "for=192.0.2.1;proto=https"], ["X-Forwarded-For", "192.0.2.1"], ["X-Forwarded-Proto", "https"], ["X-Forwarded-Host", "app.test"], ["X-Forwarded-Port", "443"]];
  const trusted = await fixture(t, { trustProxy: true }), untrusted = await fixture(t);
  assert.equal((await raw(trusted.server.url, { headers: forwarded })).body, "primary");
  assert.equal((await raw(untrusted.server.url, { headers: forwarded })).body, "primary");
  assert.equal(trusted.observations.length, 1); assert.equal(untrusted.observations.length, 0);
  for (const kind of ["mutate", "clone", "reconstruct"]) {
    const f = await fixture(t, { handler(request, ingress) {
      assert.ok(exactRequest(request));
      if (kind === "mutate") request.headers.set("accept", "changed");
      else if (kind === "clone") request = request.clone();
      else request = new Request(request.url, { headers: request.headers });
      assert.equal(exactRequest(request), undefined); return ingress.handle(request);
    } });
    assert.equal((await raw(f.server.url)).body, "primary"); assert.equal(f.observations.length, 0);
  }
});

test("primary first bytes and completion do not wait for reservation or candidate headers/body", async t => {
  const reservation = deferred(), started = deferred(), candidateSeen = deferred(), finishCandidate = deferred(), firstByte = deferred();
  const directory = await mkdtemp(join(tmpdir(), "clank-shadow-reservation-"));
  const catalog = new DatabaseSync(join(directory, "reservations.sqlite"));
  catalog.exec("PRAGMA journal_mode=WAL; CREATE TABLE reservations(id INTEGER PRIMARY KEY)");
  const independent = new DatabaseSync(join(directory, "reservations.sqlite"), { readOnly: true });
  let candidateCalls = 0, reservationCalls = 0, work;
  const candidate = createServer(async (_request, response) => { candidateCalls++; candidateSeen.resolve(); await finishCandidate.promise; response.end("candidate"); });
  await new Promise(resolve => candidate.listen(0, "127.0.0.1", resolve));
  t.after(async () => { reservation.resolve(); finishCandidate.resolve(); await work; candidate.closeAllConnections(); await new Promise(resolve => candidate.close(resolve));
    independent.close(); catalog.close(); await rm(directory, { recursive: true, force: true }); });
  const f = await fixture(t, { observer: { observe(request) {
    assert.equal(reservationCalls, 0);
    registerRequestHandoff(request, () => {
      work = Promise.resolve().then(async () => { reservationCalls++; started.resolve(); await reservation.promise;
        catalog.exec("BEGIN IMMEDIATE; INSERT INTO reservations VALUES(1); COMMIT");
        const response = await fetch(`http://127.0.0.1:${candidate.address().port}`); await response.text(); });
      return undefined;
    });
    return { chunk() { assert.equal(reservationCalls, 0); return undefined; }, finish() { return undefined; } };
  } } });
  const primary = raw(f.server.url, { firstByte: () => firstByte.resolve() });
  await bounded(firstByte.promise); await bounded(started.promise);
  assert.equal((await primary).body, "primary"); assert.equal(candidateCalls, 0);
  assert.equal(independent.prepare("SELECT COUNT(*) AS count FROM reservations").get().count, 0);
  reservation.resolve(); await bounded(candidateSeen.promise);
  assert.equal(independent.prepare("SELECT COUNT(*) AS count FROM reservations").get().count, 1);
  assert.equal(candidateCalls, 1); // Candidate response remains held after the primary has completely settled.
  finishCandidate.resolve(); await bounded(work);
});

test("bodyless and zero-chunk upstreams hand off once after ordinary end", async t => {
  for (const status of [200, 204, 304]) {
    const f = await fixture(t, { primary(_request, response) { response.statusCode = status; response.end(); } });
    const response = await raw(f.server.url); assert.equal(response.status, status); assert.equal(response.body, "");
    await immediate(); assert.equal(f.handoffs.length, 1); assert.deepEqual(f.chunks, []); assert.deepEqual(f.finishes.map(item => item.kind), ["complete"]);
  }
});

test("oversized primary is delivered unchanged while byte-only observation detaches", async t => {
  const data = "x".repeat(160 * 1024);
  const f = await fixture(t, { primary(_request, response) { response.end(data); } });
  const response = await raw(f.server.url); assert.equal(response.body, data);
  const observedBytes = f.chunks.reduce((sum, bytes) => sum + bytes, 0);
  assert.ok(observedBytes > 64 * 1024); assert.ok(observedBytes <= data.length); assert.equal(f.finishes.length, 0);
  assert.ok(f.chunks.slice(0, -1).reduce((sum, bytes) => sum + bytes, 0) <= 64 * 1024);
  assert.ok(f.chunks.every(value => typeof value === "number"));
});

test("observation callbacks are captured once and asynchronous failures never fail primary", async t => {
  for (const failure of ["observe", "chunk", "finish", "handoff", "throw", "getter"]) {
    let reads = 0;
    const f = await fixture(t, { observer: { get observe() { reads++; return request => {
      registerRequestHandoff(request, failure === "handoff" ? async () => { throw new Error("invalid async handoff"); } : () => undefined);
      if (failure === "observe") return Promise.reject(new Error("invalid async observe"));
      if (failure === "throw") throw new Error("observer failed");
      if (failure === "getter") return { get chunk() { throw new Error("invalid tap getter"); } };
      return { chunk: failure === "chunk" ? async () => { throw new Error("invalid async chunk"); } : () => undefined,
        finish: failure === "finish" ? async () => { throw new Error("invalid async finish"); } : () => undefined };
    }; } } });
    for (let i = 0; i < 2; i++) assert.equal((await raw(f.server.url)).body, "primary");
    await immediate(); assert.equal(reads, 1); assert.equal(f.errors.length, 0);
  }
});

test("current headers changed by observer cancel its handoff without affecting primary", async t => {
  let handoffs = 0, chunks = 0;
  const f = await fixture(t, { observer: { observe(request) {
    registerRequestHandoff(request, () => { handoffs++; return undefined; }); request.headers.set("cookie", "added-after-proof");
    return { chunk() { chunks++; return undefined; }, finish() { return undefined; } };
  } } });
  assert.equal((await raw(f.server.url)).body, "primary"); await immediate(); assert.equal(chunks, 0); assert.equal(handoffs, 0);
});

test("deadline cancellation detaches a held primary tap without cancelling its stream", async t => {
  const first = deferred(), proceed = deferred(); let cancel, tapped = 0, finished = 0, primaryClosed = false;
  const f = await fixture(t, { primary(_request, response) {
    response.on("close", () => { primaryClosed = true; }); response.write("first"); first.resolve();
    void proceed.promise.then(() => response.end("last"));
  }, observer: { observe(request) {
    cancel = registerRequestHandoff(request, () => undefined);
    return { chunk() { tapped++; return undefined; }, finish() { finished++; return undefined; } };
  } } });
  t.after(() => proceed.resolve());
  const clientFirst = deferred(), response = raw(f.server.url, { firstByte: () => clientFirst.resolve() });
  await bounded(first.promise); await bounded(clientFirst.promise); assert.equal(tapped, 1); cancel(); cancel();
  assert.equal(primaryClosed, false); proceed.resolve(); assert.equal((await response).body, "firstlast");
  assert.equal(tapped, 1); assert.equal(finished, 0);
});

test("observer does not clone, tee, or pull an unread body and cancellation releases its callbacks", async t => {
  const constructed = deferred(), consume = deferred(); let pulls = 0, cancel, taps = 0;
  const payload = new TextEncoder().encode("consumer-only");
  const f = await fixture(t, { ingress: { fetch: async () => {
    const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(payload); controller.close(); } }, { highWaterMark: 0 });
    body.tee = () => { throw new Error("Observation must never tee."); };
    const response = new Response(body); response.clone = () => { throw new Error("Observation must never clone."); }; return response;
  } }, observer: { observe(request) {
    cancel = registerRequestHandoff(request, () => undefined);
    return { chunk() { taps++; return undefined; }, finish() { taps++; return undefined; } };
  } }, async handler(request, ingress) {
    const response = await ingress.handle(request); constructed.resolve(); await consume.promise; return response;
  } });
  t.after(() => consume.resolve());
  const result = raw(f.server.url); await bounded(constructed.promise); await immediate();
  assert.equal(pulls, 0); assert.equal(taps, 0); cancel(); consume.resolve();
  assert.equal((await result).body, "consumer-only"); assert.equal(pulls, 1); assert.equal(taps, 0);
});

test("cancelled and errored primary bodies report distinct incomplete outcomes at most once", async t => {
  for (const outcome of ["cancelled", "error"]) {
    const finishes = [], handoffs = []; let pulls = 0;
    const f = await fixture(t, { ingress: { fetch: async () => new Response(new ReadableStream({
      pull(controller) { if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("first")); else controller.error(new Error("primary source failed")); },
    }, { highWaterMark: 0 })) }, observer: { observe(request) {
      registerRequestHandoff(request, () => { handoffs.push(true); return undefined; });
      return { chunk: () => undefined, finish(kind) { finishes.push(kind); return undefined; } };
    } }, async handler(request, ingress) {
      const response = await ingress.handle(request), reader = response.body.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
      if (outcome === "cancelled") await reader.cancel("ordinary consumer cancellation");
      else await assert.rejects(reader.read(), /primary source failed/);
      reader.releaseLock(); return new Response("consumer-handled");
    } });
    assert.equal((await raw(f.server.url)).body, "consumer-handled"); await immediate();
    assert.deepEqual(finishes, [outcome]); assert.deepEqual(handoffs, []);
  }
});

test("actual client disconnect finishes only its primary tap as cancelled", async t => {
  const settled = deferred(), upstreamClosed = deferred(), finishes = [];
  const f = await fixture(t, { primary(_request, response) {
    response.on("close", () => upstreamClosed.resolve()); response.write("first");
  }, observer: { observe(request) {
    registerRequestHandoff(request, () => undefined);
    return { chunk: () => undefined, finish(kind) { finishes.push(kind); settled.resolve(); return undefined; } };
  } } });
  await bounded(new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: f.server.port }, () => socket.write("GET /catalog HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n\r\n"));
    socket.on("error", reject); socket.once("data", () => { socket.destroy(); resolve(); });
  }));
  await bounded(settled.promise); await bounded(upstreamClosed.promise); await immediate(); assert.deepEqual(finishes, ["cancelled"]);
});

test("candidate responses, private ingress errors, and observers without handoff proof have no tap", async t => {
  let observed = 0;
  const f = await fixture(t, { observer: { observe() { observed++; return { chunk() { throw new Error("No handoff was registered."); }, finish() { throw new Error("No handoff was registered."); } }; } } });
  assert.equal((await raw(f.server.url)).body, "primary"); assert.equal(observed, 1); assert.equal(f.errors.length, 0);
  f.route.canary = { upstream: f.route.upstream, releaseId: "release_candidate", trafficPercent: 100 };
  assert.equal((await raw(f.server.url)).body, "primary"); assert.equal(observed, 1);
  f.route.active = false; delete f.route.canary;
  assert.equal((await raw(f.server.url)).status, 404); assert.equal(observed, 1);
});

test("all optional callback getters are captured once and rejected thenables are contained", async t => {
  const reads = { option: 0, observe: 0, chunk: 0, finish: 0, then: 0 }; let handoffs = 0;
  const options = { get shadow() { reads.option++; return { get observe() { reads.observe++; return request => {
    registerRequestHandoff(request, () => { handoffs++; return undefined; });
    return { get chunk() { reads.chunk++; return () => undefined; }, get finish() { reads.finish++; return () => ({ get then() {
      reads.then++; return (_resolve, reject) => reject(new Error("Invalid async tap"));
    } }); } };
  }; } }; } };
  const f = await fixture(t, { ingress: options });
  for (let i = 0; i < 2; i++) assert.equal((await raw(f.server.url)).body, "primary");
  await immediate();
  assert.deepEqual(reads, { option: 1, observe: 1, chunk: 2, finish: 2, then: 2 }); assert.equal(handoffs, 0); assert.equal(f.errors.length, 0);
});

for (const hold of ["headers", "body"]) test(`primary streams to completion while candidate ${hold} remain held`, async t => {
  const primaryContinue = deferred(), candidateSeen = deferred(), candidateContinue = deferred(); let work;
  const candidate = createServer(async (_request, response) => {
    if (hold === "body") { response.writeHead(200); response.write("candidate-first"); }
    candidateSeen.resolve(); await candidateContinue.promise; response.end("candidate-last");
  });
  await new Promise(resolve => candidate.listen(0, "127.0.0.1", resolve));
  t.after(async () => { primaryContinue.resolve(); candidateContinue.resolve(); await work; candidate.closeAllConnections(); await new Promise(resolve => candidate.close(resolve)); });
  const f = await fixture(t, { primary(_request, response) { response.write("primary-first"); void primaryContinue.promise.then(() => response.end("primary-last")); },
    observer: { observe(request) {
      registerRequestHandoff(request, () => { work = (async () => {
        const response = await fetch(`http://127.0.0.1:${candidate.address().port}`); await response.text();
      })(); return undefined; });
      return { chunk: () => undefined, finish: () => undefined };
    } } });
  const first = deferred(), result = raw(f.server.url, { firstByte: () => first.resolve() });
  await bounded(first.promise); await bounded(candidateSeen.promise); primaryContinue.resolve();
  assert.equal((await result).body, "primary-firstprimary-last");
  candidateContinue.resolve(); await bounded(work);
});
