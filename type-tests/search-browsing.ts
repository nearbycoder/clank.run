import { defineDatabase, defineTable, s } from '../src/index.ts';
import { defineAuth } from '../src/auth.ts';
import { openSearch, createSearchBrowsingClient, mountSearchBrowsing, type SearchClient, type SearchDefinition } from '../src/search.ts';
const schema = defineDatabase({ notes: defineTable({ title: s.string(), body: s.string(), category: s.string(), count: s.number(), flag: s.boolean(), optional: s.optional(s.string()), nested: s.array(s.string()) }).owned() });
const common = { path: 'app.sqlite', auth: defineAuth({}), schema, authorize: () => true };
const definition: SearchDefinition = { text: '', filters: [{ field: 'category', value: 'a' }], sort: 'title' };
async function contracts() {
  const service = await openSearch({ ...common, source: { name: 'notes', table: 'notes', title: 'title', body: 'body', scope: 'owner', facets: ['category', 'count', 'flag', 'optional'] }, browsing: { policyRevision: 'policy/1' } });
  service.rebuild();
  const client = createSearchBrowsingClient();
  const legacy: SearchClient = client; await legacy.search('scope', 'words');
  const page = await client.browse('scope', definition, { limit: 5 }); const next: string | null = page.nextCursor; void next;
  const saved = await client.save('scope', { key: 'mine', expectedRevision: 0, name: 'Mine', definition });
  if (saved.definition) await client.browse('scope', saved.definition); await client.removeSaved('scope', saved.key, saved.revision);
  mountSearchBrowsing(document.body, { client, currentUser: () => 'one', scope: () => 'scope', fields: ['category'], open: () => {} });
  // @ts-expect-error facets cannot project arrays
  await openSearch({ ...common, source: { name: 'notes', table: 'notes', title: 'title', body: 'body', scope: 'owner', facets: ['nested'] }, browsing: { policyRevision: '1' } });
  // @ts-expect-error unknown application field
  await openSearch({ ...common, source: { name: 'notes', table: 'notes', title: 'title', body: 'body', scope: 'owner', facets: ['unknown'] }, browsing: { policyRevision: '1' } });
  // @ts-expect-error manual search has no source browsing
  await openSearch({ ...common, browsing: { policyRevision: '1' } });
  // @ts-expect-error equality filter values must be scalar
  await client.browse('scope', { ...definition, filters: [{ field: 'category', value: [] }] });
  // @ts-expect-error saved edits require a version fence
  await client.save('scope', { key: 'mine', name: 'Mine', definition });
  // @ts-expect-error browser isolation requires current account getter
  mountSearchBrowsing(document.body, { client, scope: () => 'scope', fields: [], open: () => {} });
}
void contracts;
