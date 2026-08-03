# Durable counter

This smallest runnable durable-object example defines one typed namespace, opens it over a Clank
SQLite database, and performs an idempotent mutation against the stable `demo` ID.

From the framework checkout:

```sh
npm run build
node examples/durable-counter/run.js
```

Run it repeatedly to see the same object continue from its persisted state. Set `CLANK_DATABASE`
to choose another database path. The example is deliberately a trusted server script; use a typed
backend action or `durableObjectMcpTools(..., { authorize })` before exposing an object to a browser
or agent.

Read the complete [durable object guide](../../docs/durable-objects.md) for alarms, migrations,
subscriptions, authorization, failure semantics, and placement requirements.
