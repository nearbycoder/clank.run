import { createDurableImportClient, mountReviewableImporter, type DurableImportClient, type DurableImportColumn, type DurableImportPreview } from "../src/durable-import.ts";
type Values = { title: string; score: number; active: boolean };
const columns: DurableImportColumn<Values>[] = [{ source: "name", target: "title", type: "text", required: true }, { source: "points", target: "score", type: "integer" }];
const client = createDurableImportClient<Values>({ currentUser: () => "owner" });
async function contracts() {
  const job = await client.uploadReviewableCsv(new Blob(), columns);
  const window = await client.sourceWindow(job.id, { limit: 10 });
  const corrected: number | undefined = window.rows[0]?.corrections.score;
  await client.correctRows(job.id, 0, [{ row: 2, values: { score: 4 } }], "correction");
  await client.correctMapping(job.id, 0, columns, "mapping");
  const preview: DurableImportPreview<Values> = await client.preview(job.id);
  const score: number | undefined = preview.effects[0]?.after?.score;
  await client.apply(preview, "accept");
  mountReviewableImporter(document.body, client, { columns, currentUser: () => "owner" });
  // @ts-expect-error corrections preserve target value types
  await client.correctRows(job.id, 0, [{ row: 2, values: { score: "4" } }], "bad");
  // @ts-expect-error corrections cannot invent target fields
  await client.correctRows(job.id, 0, [{ row: 2, values: { secret: true } }], "bad");
  // @ts-expect-error column targets come from declared values
  await client.uploadReviewableCsv(new Blob(), [{ source: "raw", target: "secret", type: "text" }]);
  // @ts-expect-error accepting a preview requires a stable operation ID
  await client.apply(preview);
  // @ts-expect-error the widget requires an account getter
  mountReviewableImporter(document.body, client, { columns });
  void [corrected, score];
}
void contracts;

// Existing structurally implemented streaming clients remain valid.
const legacy: DurableImportClient = {
  create: async () => { throw new Error("not mounted"); }, inspect: async () => { throw new Error("not mounted"); },
  append: async () => { throw new Error("not mounted"); }, seal: async () => { throw new Error("not mounted"); },
  step: async () => { throw new Error("not mounted"); }, retry: async () => { throw new Error("not mounted"); },
  cancel: async () => { throw new Error("not mounted"); }, run: async () => { throw new Error("not mounted"); },
  uploadCsv: async () => { throw new Error("not mounted"); },
};
void legacy;
