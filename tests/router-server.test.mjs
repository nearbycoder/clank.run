import test from "node:test";
import assert from "node:assert/strict";
import { createRouter, matchPath, matchRoutes, redirect } from "../dist/router.js";
import { cors, createApp, json, securityHeaders } from "../dist/server.js";

test("route matching supports parameters, optional segments, queries, and wildcards", () => {
  assert.deepEqual(matchPath("/teams/:team/users/:id", "/teams/core/users/42"), { team: "core", id: "42" });
  assert.deepEqual(matchPath("/docs/:page?", "/docs"), {});
  assert.deepEqual(matchPath("*", "/anything/here"), { wildcard: "/anything/here" });
  const component = () => null;
  const matched = matchRoutes([{ path: "/search", component }], "https://example.test/search?q=one&q=two");
  assert.deepEqual(matched.query, { q: ["one", "two"] });
});

test("router navigation rejects executable protocols", async () => {
  const router = createRouter({ routes: [] });
  await assert.rejects(() => router.navigate("javascript:alert(1)"), /Unsafe navigation protocol/);
  assert.throws(() => redirect("data:text/html,unsafe"), /Unsafe navigation protocol/);
});

test("request app composes middleware, route parameters, and errors", async () => {
  const events = [];
  const app = createApp()
    .use(async (context, next) => {
      events.push("before");
      context.state.requestId = "abc";
      const response = await next();
      events.push("after");
      return response;
    })
    .get("/users/:id", ({ params, state }) => json({ id: params.id, requestId: state.requestId }));
  const response = await app.handle(new Request("https://example.test/users/7"));
  assert.deepEqual(await response.json(), { id: "7", requestId: "abc" });
  assert.deepEqual(events, ["before", "after"]);
  assert.equal((await app.handle(new Request("https://example.test/missing"))).status, 404);
});

test("server defaults redact failures and security middleware applies safe headers", async () => {
  const errors = [];
  const app = createApp({ onError: (error) => errors.push(error) })
    .use(securityHeaders())
    .get("/fail", () => {
      throw new Error("database-password-was-here");
    });
  const response = await app.handle(new Request("https://example.test/fail"));
  const body = await response.text();
  assert.equal(response.status, 500);
  assert.doesNotMatch(body, /database-password/);
  assert.match(body, /internal server error/i);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(errors.length, 1);
  assert.throws(() => cors({ origin: "*", credentials: true }), /explicit origin/);
});
