import { createApi, createSyncClient, type FunctionReference } from "../dist/index.js";

const client = createSyncClient();
// Explicitly erased APIs retain their escape hatch for dynamic service paths.
const untyped = createApi<any>();
const dynamic: Promise<string> = client.query(untyped.service.read, { id: "record" });
void dynamic;

// The escape hatch must not weaken references with a known contract.
declare const typed: FunctionReference<"query", { id: string }, number>;
const numeric: Promise<number> = client.query(typed, { id: "record" });
// @ts-expect-error Typed results remain numeric.
const wrongOutput: Promise<string> = client.query(typed, { id: "record" });
// @ts-expect-error Typed arguments remain required and checked.
client.query(typed, { id: 42 });
void numeric;
void wrongOutput;
