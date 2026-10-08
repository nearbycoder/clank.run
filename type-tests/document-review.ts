import { createCollaborativeDocumentsClient, mountDocumentBranchReview, mountDocumentCursorPresence, type DocumentBranch, type DocumentCursor } from "../src/collaborative-documents.ts";
const client = createCollaborativeDocumentsClient();
const cursor: Promise<DocumentCursor> = client.setCursor("shared", { revision: 1, anchor: 0, head: 3 });
const branch: Promise<DocumentBranch> = client.createBranch("shared", "proposal", "Change title", 1);
void cursor; void branch;
client.decideBranch("shared", "proposal", 2, "accept", 3);
// @ts-expect-error Decisions are explicit, not arbitrary strings.
client.decideBranch("shared", "proposal", 2, "merge", 3);
// @ts-expect-error Revision is mandatory for a selection.
client.setCursor("shared", { anchor: 0, head: 3 });
client.branches("shared").then(rows => {
  // @ts-expect-error Summaries omit source/proposed text.
  rows[0].text;
});
mountDocumentBranchReview(document.body, client, "shared", "proposal");
mountDocumentCursorPresence(document.body, client, "shared", () => ({ revision: 1, anchor: 0, head: 0 }));
import { defineAuth, defineDatabase, defineTable, s } from "../src/index.ts";
import { openCollaborativeDocuments } from "../src/collaborative-documents.ts";
const schema = defineDatabase({ memberships: defineTable({ role: s.string() }).owned() });
openCollaborativeDocuments({ path: "app.sqlite", auth: defineAuth(), schema, authorize: ({ db }) => db.table("memberships").collect().length > 0, authorizeBranchDecision: ({ db, auth }, proposal) => {
  // @ts-expect-error Reviewed branch snapshots are immutable.
  proposal.status = "accepted";
  return db.table("memberships").collect().some(row => row.role === "reviewer") && proposal.authorId !== auth.requireUser().id;
} });
