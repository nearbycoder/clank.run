import { openBackend, runJobProcess } from "@clank.run/framework";
import { backend } from "./backend.ts";

const environment = (globalThis as unknown as {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;
const databasePath = environment?.CLANK_DATABASE_PATH
  ?? environment?.CLANK_DATABASE
  ?? "app.sqlite";

const runtime = await openBackend(backend, {
  path: databasePath,
  changePollIntervalMs: 0,
});

if (!runtime.jobs) throw new Error("This app has no job definitions.");
try {
  await runJobProcess(runtime.jobs, {
    onReady(role, id) {
      console.log(`Clank ${role} ready: ${id}`);
    },
  });
} finally {
  runtime.close();
}
