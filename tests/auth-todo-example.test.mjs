import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseConflictError, openBackend } from "../dist/index.js";
import { backend } from "../examples/auth-todo/backend.js";

const origin = "https://todo.example.test";
const password = "correct horse battery staple";

function request(path, { body, cookie } = {}) {
  return new Request(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : {
        "content-type": "application/json",
        "origin": origin,
        "x-clank-client-ip": "127.0.0.1",
      }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

async function createSession(runtime, operation, body) {
  const response = await runtime.handle(request(`/__clank/auth/${operation}`, { body }));
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return cookieFrom(response);
}

test("authenticated todo example synchronizes profile and every todo mutation across sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-auth-todo-example-"));
  const runtime = await openBackend(backend, {
    path: join(directory, "app.sqlite"),
    wal: false,
  });

  try {
    const firstCookie = await createSession(runtime, "register", {
      email: "sync@example.test",
      password,
      profile: { name: "Initial name" },
    });
    const secondCookie = await createSession(runtime, "login", {
      email: "sync@example.test",
      password,
    });
    const first = await runtime.caller(request("/", { cookie: firstCookie }));
    const second = await runtime.caller(request("/", { cookie: secondCookie }));

    const firstTodos = [];
    const secondTodos = [];
    const firstProfiles = [];
    const secondProfiles = [];
    const dispose = [
      first.subscribe("todos.list", {}, (value) => firstTodos.push(value)),
      second.subscribe("todos.list", {}, (value) => secondTodos.push(value)),
      first.subscribe("profile.get", {}, (value) => firstProfiles.push(value)),
      second.subscribe("profile.get", {}, (value) => secondProfiles.push(value)),
    ];

    assert.deepEqual(firstTodos.at(-1), []);
    assert.deepEqual(secondTodos.at(-1), []);
    assert.equal(firstProfiles.at(-1), null);
    assert.equal(secondProfiles.at(-1), null);

    first.mutation("profile.update", { displayName: "Synced from one", version: null });
    assert.equal(secondProfiles.at(-1).displayName, "Synced from one");

    const id = first.mutation("todos.add", { title: "Draft in one" }).value;
    assert.equal(secondTodos.at(-1)[0].title, "Draft in one");
    assert.equal(secondTodos.at(-1)[0].done, false);

    const initialTodoVersion = firstTodos.at(-1)[0]._version;
    first.mutation("todos.rename", { id, title: "Renamed in one", version: initialTodoVersion });
    assert.equal(secondTodos.at(-1)[0].title, "Renamed in one");

    const renamedTodoVersion = firstTodos.at(-1)[0]._version;
    first.mutation("todos.setDone", { id, done: true, version: renamedTodoVersion });
    assert.equal(secondTodos.at(-1)[0].done, true);

    first.mutation("todos.clearCompleted", {});
    assert.deepEqual(secondTodos.at(-1), []);

    const reverseId = second.mutation("todos.add", { title: "Created in two" }).value;
    assert.equal(firstTodos.at(-1)[0].title, "Created in two");

    second.mutation("profile.update", {
      displayName: "Synced from two",
      version: secondProfiles.at(-1)._version,
    });
    assert.equal(firstProfiles.at(-1).displayName, "Synced from two");

    second.mutation("todos.remove", {
      id: reverseId,
      version: secondTodos.at(-1)[0]._version,
    });
    assert.deepEqual(firstTodos.at(-1), []);

    const otherCookie = await createSession(runtime, "register", {
      email: "isolated@example.test",
      password,
      profile: { name: "Other account" },
    });
    const other = await runtime.caller(request("/", { cookie: otherCookie }));
    assert.deepEqual(other.query("todos.list", {}).value, []);
    assert.equal(other.query("profile.get", {}).value, null);

    assert.throws(
      () => first.mutation("profile.update", {
        displayName: "   ",
        version: firstProfiles.at(-1)._version,
      }),
      /Display names cannot be empty/,
    );
    assert.throws(
      () => first.mutation("todos.add", { title: "   " }),
      /Todo titles cannot be empty/,
    );

    for (const stop of dispose) stop();
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("authenticated todo example rejects stale document and singleton-profile writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clank-auth-todo-conflicts-"));
  const runtime = await openBackend(backend, {
    path: join(directory, "app.sqlite"),
    wal: false,
  });

  try {
    const cookie = await createSession(runtime, "register", {
      email: "conflicts@example.test",
      password,
      profile: { name: "Conflict test" },
    });
    const caller = await runtime.caller(request("/", { cookie }));
    const id = caller.mutation("todos.add", { title: "Original" }).value;
    const original = caller.query("todos.list", {}).value[0];

    caller.mutation("todos.rename", {
      id,
      title: "Current",
      version: original._version,
    });
    const committedRevision = runtime.version;
    assert.throws(
      () => caller.mutation("todos.setDone", {
        id,
        done: true,
        version: original._version,
      }),
      (error) => error instanceof DatabaseConflictError
        && error.expectedVersion === original._version
        && error.actualVersion === original._version + 1,
    );
    assert.equal(runtime.version, committedRevision);
    assert.deepEqual(
      caller.query("todos.list", {}).value.map(({ title, done }) => ({ title, done })),
      [{ title: "Current", done: false }],
    );

    caller.mutation("profile.update", { displayName: "Created", version: null });
    const profileRevision = runtime.version;
    assert.throws(
      () => caller.mutation("profile.update", { displayName: "Duplicate", version: null }),
      (error) => error instanceof DatabaseConflictError
        && error.expectedVersion === null
        && error.actualVersion === 1,
    );
    assert.equal(runtime.version, profileRevision);
    assert.equal(caller.query("profile.get", {}).value.displayName, "Created");
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
