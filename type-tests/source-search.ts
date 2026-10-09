import { defineDatabase, defineTable, s } from "../src/index.ts";
import { defineAuth } from "../src/auth.ts";
import { openSearch } from "../src/search.ts";
const schema = defineDatabase({ notes: defineTable({ title: s.string(), body: s.string(), count: s.number() }).owned(), articles: defineTable({ title: s.string(), body: s.string(), team: s.string() }) });
const auth = defineAuth({});
const common = { path: "app.sqlite", auth, schema, authorize: () => true };
async function contracts() {
  const linked = await openSearch({ ...common, source: { name: "notes", table: "notes", title: "title", body: "body", scope: "owner" } });
  const diagnostic = linked.inspect({ limit: 1 }); linked.rebuild({ batchSize: 10, ifRevision: diagnostic.revision }); linked.detach(diagnostic.generation);
  await openSearch({ ...common, source: { name: "articles", table: "articles", title: "title", body: "body", scope: { field: "team" } } });
  const manual = await openSearch(common); manual.upsert({ scope: "team", id: "one", title: "Hi", body: "Text" });
  // @ts-expect-error linked indexing cannot be forged with manual upserts
  linked.upsert({ scope: "team", id: "one", title: "Hi", body: "Text" });
  // @ts-expect-error source fields must be strings
  await openSearch({ ...common, source: { name: "notes", table: "notes", title: "count", body: "body", scope: "owner" } });
  // @ts-expect-error owned scopes are derived from the owner
  await openSearch({ ...common, source: { name: "notes", table: "notes", title: "title", body: "body", scope: { field: "title" } } });
  // @ts-expect-error public sources require a declared string scope field
  await openSearch({ ...common, source: { name: "articles", table: "articles", title: "title", body: "body", scope: "owner" } });
  // @ts-expect-error source registration requires the application schema
  await openSearch({ path: "app.sqlite", auth, authorize: () => true, source: { name: "notes", table: "notes", title: "title", body: "body", scope: "owner" } });
}
void contracts;
