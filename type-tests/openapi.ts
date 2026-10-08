import { defineAuth, defineBackend, defineDatabase, defineTable, s, exportBackendOpenAPI, type OpenAPIDocument } from "@clank.run/framework";
const schema = defineDatabase({ records: defineTable({ value: s.number() }).owned() });
const backend = defineBackend({ schema, auth: defineAuth() }).functions(({ query }) => ({
  values: query({ args: {}, returns: s.array(s.number()), handler: ({ db }) => db.table("records").collect().map(row => row.value) }),
}));
const document: OpenAPIDocument = exportBackendOpenAPI(backend, { title: "Records", version: "1", serverUrl: "https://example.test" });
// @ts-expect-error The supported document version is fixed.
const invalidVersion: "3.0.0" = document.openapi;
// @ts-expect-error A deployment URL is required to resolve the auth contract.
exportBackendOpenAPI(backend, { title: "Records", version: "1" });
void invalidVersion;
