import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openBackend, renderToString } from "@clank.run/framework";
import { backend } from "../dist/backend.js";
import { TodoView } from "../dist/view.js";

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/default.json", import.meta.url), "utf8"),
);

test("Todo backend matches its agent contract and keeps fixture data private", async () => {
  const runtime = await openBackend(backend, { path: ":memory:", wal: false });
  try {
    const manifestResponse = await runtime.handle(
      new Request("https://fixture.test/__clank/manifest"),
    );
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.deepEqual(
      manifest.functions.filter((entry) => entry.agent).map((entry) => entry.name).sort(),
      ["todos.add", "todos.list", "todos.remove", "todos.setDone"],
    );

    const primary = await register(runtime, fixture.users.primary);
    const definition = fixture.records.todos.first;
    const caller = await runtime.caller(authRequest("/", primary.cookie));
    const id = caller.mutation("todos.add", {
      title: definition.values.title,
    }).value;
    const visible = caller.query("todos.list", {}).value;
    assert.equal(visible.length, 1);
    assert.equal(visible[0]._id, id);
    assert.equal(visible[0].title, definition.values.title);
    assert.equal(visible[0].done, definition.values.done);

    const outsider = await register(runtime, {
      email: "outsider@example.invalid",
      profile: { name: "Outsider" },
    });
    const outsiderCaller = await runtime.caller(authRequest("/", outsider.cookie));
    assert.deepEqual(outsiderCaller.query("todos.list", {}).value, []);

    const html = await renderToString(TodoView({
      user: primary.user,
      todos: visible,
      version: runtime.version,
      connected: true,
      add: () => {},
      setDone: () => {},
      remove: () => {},
      logout: () => {},
    }));
    assert.match(html, /Verify the generated app/u);
    assert.match(html, /Live sync connected/u);
  } finally {
    runtime.close();
  }
});

function authRequest(path, cookie, body) {
  return new Request(`https://fixture.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : {
        "content-type": "application/json",
        origin: "https://fixture.test",
      }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function register(runtime, definition) {
  const response = await runtime.handle(authRequest("/__clank/auth/register", undefined, {
    email: definition.email,
    password: "fixture-password-123",
    profile: definition.profile,
  }));
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  return {
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
    user: payload.user,
  };
}
