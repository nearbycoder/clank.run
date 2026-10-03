// Public-package consumer fixture: run against copied/published declarations as
// well as the normal source typecheck. This file is never executed.
import { defineAuth } from "@clank.run/framework/auth";
import { defineDatabase, defineTable } from "@clank.run/framework/backend";
import { s } from "@clank.run/framework/ai";
import { openBulkEditor, type BulkEditOptions } from "@clank.run/framework/bulk-edit";
import { openDurableImport } from "@clank.run/framework/durable-import";
import { openCollaborativeDocuments } from "@clank.run/framework/collaborative-documents";
import { openSearch } from "@clank.run/framework/search";
import { openSharedSavedViews } from "@clank.run/framework/saved-views";

const auth = defineAuth();
const schema = defineDatabase({
  records: defineTable({ title: s.string(), workspaceId: s.string() }),
  memberships: defineTable({ workspaceId: s.string(), userId: s.string(), role: s.enum(["reader", "editor"] as const) })
    .index("byWorkspaceUser", ["workspaceId", "userId"]),
});

const bulkOptions: BulkEditOptions<typeof schema> = {
  path: "app.sqlite", auth, schema, table: "records", fields: ["title"],
  authorize({ auth, db }, record) {
    if (typeof record.workspaceId !== "string") return false;
    const member = db.table("memberships").query()
      .where("workspaceId", record.workspaceId).where("userId", auth.requireUser().id).first();
    return member?.role === "editor";
  },
};
void openBulkEditor(bulkOptions);
void openDurableImport({
  path: "app.sqlite", auth, schema, table: "records", fields: ["title", "workspaceId"],
  authorize({ auth, db }, record) {
    if (typeof record.workspaceId !== "string") return false;
    const member = db.table("memberships").query()
      .where("workspaceId", record.workspaceId).where("userId", auth.requireUser().id).first();
    return member?.role === "editor";
  },
});
void openCollaborativeDocuments({
  path: "app.sqlite", auth, schema,
  authorize({ db }, documentId) {
    const record = db.table("records").get(s.id("records").parse(documentId));
    return record !== null && record.title.length > 0;
  },
});
void openSearch({
  path: "app.sqlite", auth, schema,
  authorize: ({ auth }, scope) => scope === auth.requireUser().id,
  authorizeRecord({ db }, indexed) {
    const record = db.table("records").get(s.id("records").parse(indexed.id));
    // @ts-expect-error Schema-aware records do not expose undeclared fields.
    record?.missingField;
    return record !== null;
  },
});
void openSharedSavedViews({
  path: "app.sqlite", auth, schema, fields: ["title"],
  authorize({ auth, db }, workspaceId, operation) {
    const members = db.table("memberships");
    // @ts-expect-error Schema-aware queries reject undeclared fields.
    members.query().where("missingField", "value");
    const member = members.query().where("workspaceId", workspaceId)
      .where("userId", auth.requireUser().id).first();
    return Boolean(member && (operation === "read" || member.role === "editor"));
  },
});
