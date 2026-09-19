/* @clankImportSource @clank.run/framework */
import { AuthGate, createClient, hydrate, onCleanup, readState, signal, type AuthState, type DefaultAuthProfile } from "@clank.run/framework";
import type { backend, RecipeRecord } from "./backend.ts";
import { RecipeView } from "./view.tsx";
const boot = readState<{ auth: AuthState<DefaultAuthProfile>; records: RecipeRecord[]; version: number }>() ?? { auth: { user: null, session: null }, records: [], version: 0 };
const client = createClient<typeof backend>({ initialAuth: boot.auth });
client.seed(client.api.records.list, {}, boot.records, boot.version);
function Records() {
  const rows = client.live(client.api.records.list), error = signal("");
  onCleanup(() => rows.dispose());
  const run = async (operation: () => Promise<unknown>) => { error.value = ""; try { await operation(); return true; } catch (reason) { error.value = reason instanceof Error ? reason.message : "Unable to save. Refresh and retry."; return false; } };
  return <RecipeView user={client.auth.user.value!} records={rows.data.value ?? []} error={error.value || (rows.error.value ? "Live connection interrupted." : "")}
    create={(title, detail) => run(() => client.mutate(client.api.records.create, { title, detail }))}
    update={(row, status, note) => run(() => client.mutate(client.api.records.update, { id: row._id, version: row._version, status, ...(note === undefined ? {} : { note }) }))}
    logout={() => client.auth.logout()} />;
}
hydrate(document.getElementById("app")!, <AuthGate auth={client.auth}><Records /></AuthGate>);
