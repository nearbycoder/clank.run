import {
  defineDatabase,
  openDurableObjects,
  openSQLite,
} from "@clank.run/framework";
import { Counter } from "./objects.ts";

const environment = (globalThis as unknown as {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;
const database = await openSQLite(defineDatabase({}), {
  path: environment?.CLANK_DATABASE ?? new URL("./durable-counter.sqlite", import.meta.url).pathname,
});
const objects = openDurableObjects({ counter: Counter }, { database });

try {
  const counter = objects.get(Counter, "demo");
  const result = await counter.invoke(Counter.methods.add, { amount: 1 }, {
    idempotencyKey: globalThis.crypto.randomUUID(),
  });
  console.log({
    ...result,
    snapshot: counter.inspect(),
    diagnostics: objects.diagnostics(),
  });
} finally {
  await objects.close();
  database.close();
}
