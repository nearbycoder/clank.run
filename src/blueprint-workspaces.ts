import type { AppBlueprint } from "./blueprint.ts";

const enabled = (app: AppBlueprint) => Object.values(app.entities).some((entity) => entity.ownership === "workspace");

export function workspaceTablesSource(app: AppBlueprint): string {
  if (!enabled(app)) return "";
  return `  clankWorkspaces: defineTable({ name: s.string({ min: 1, max: 100 }), ownerId: s.string() }),
  clankMemberships: defineTable({ workspaceId: s.string(), userId: s.string() }).index("by_user", ["userId"]).index("by_workspace", ["workspaceId"]),
  clankWorkspaceSelection: defineTable({ workspaceId: s.string() }).owned(),`;
}

export function workspaceFunctionsSource(app: AppBlueprint): string {
  if (!enabled(app)) return "";
  return `  workspaces: {
    list: query({ args: {}, agent: false, handler: ({ db, auth }) => {
      const userId = auth.user!.id;
      const ids = new Set(db.table("clankMemberships").query().where("userId", userId).collect().map((row) => row.workspaceId));
      const shared = [...ids].flatMap((id) => { const row = db.table("clankWorkspaces").get(id); return row ? [{ id: row._id, name: row.name, owner: row.ownerId === userId }] : []; });
      return { active: activeWorkspace(db, userId), userId, workspaces: [{ id: userId, name: "Personal workspace", owner: true }, ...shared] };
    } }),
    create: mutation({ args: { name: s.string({ min: 1, max: 100 }) }, agent: false, handler: ({ db, auth }, { name }) => {
      const id = db.table("clankWorkspaces").insert({ name, ownerId: auth.user!.id });
      db.table("clankMemberships").insert({ workspaceId: id, userId: auth.user!.id });
      selectWorkspace(db, auth.user!.id, id);
      return id;
    } }),
    select: mutation({ args: { id: s.string({ min: 1, max: 200 }) }, agent: false, handler: ({ db, auth }, { id }) => {
      assertWorkspace(db, auth.user!.id, id);
      selectWorkspace(db, auth.user!.id, id);
      return id;
    } }),
    addMember: mutation({ args: { workspaceId: s.string(), userId: s.string({ min: 1, max: 200 }) }, agent: false, handler: ({ db, auth }, input) => {
      requireWorkspaceOwner(db, auth.user!.id, input.workspaceId);
      if (!db.table("clankMemberships").query().where("workspaceId", input.workspaceId).where("userId", input.userId).first()) db.table("clankMemberships").insert(input);
      return true;
    } }),
    removeMember: mutation({ args: { workspaceId: s.string(), userId: s.string() }, agent: false, handler: ({ db, auth }, input) => {
      requireWorkspaceOwner(db, auth.user!.id, input.workspaceId);
      if (input.userId === auth.user!.id) throw new BackendActionError(409, "WORKSPACE_OWNER_REQUIRED", "The workspace owner cannot remove their own membership.");
      for (const member of db.table("clankMemberships").query().where("workspaceId", input.workspaceId).where("userId", input.userId).collect()) db.table("clankMemberships").delete(member._id);
      return true;
    } }),
  },`;
}

export function guardedDatabaseSource(app: AppBlueprint): string {
  const workspaceNames = Object.entries(app.entities).filter(([, entity]) => entity.ownership === "workspace").map(([name]) => name);
  const unique: Record<string, string[][]> = {};
  for (const relationship of app.relationships) {
    if (relationship.kind === "one-to-one" && relationship.reference) (unique[relationship.reference.entity] ??= []).push([relationship.reference.field]);
    if (relationship.kind === "many-to-many") (unique[relationship.join!] ??= []).push(["fromId", "toId"]);
  }
  const references = Object.fromEntries(Object.entries(app.entities).map(([name, entity]) => [name, Object.entries(entity.fields).filter(([, field]) => field.type === "reference").map(([field, definition]) => ({ field, target: definition.entity }))]));
  return `${enabled(app) ? `function assertWorkspace(db: any, userId: string, id: string): void {
  if (id === userId) return;
  if (!db.table("clankWorkspaces").get(id) || !db.table("clankMemberships").query().where("workspaceId", id).where("userId", userId).first()) throw new BackendActionError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or membership revoked.");
}
function activeWorkspace(db: any, userId: string): string {
  const id = db.table("clankWorkspaceSelection").query().first()?.workspaceId ?? userId;
  try { assertWorkspace(db, userId, id); return id; } catch { return userId; }
}
function selectWorkspace(db: any, userId: string, workspaceId: string): void {
  const current = db.table("clankWorkspaceSelection").query().first();
  if (current) db.table("clankWorkspaceSelection").patch(current._id, { workspaceId });
  else db.table("clankWorkspaceSelection").insert({ workspaceId });
}
function requireWorkspaceOwner(db: any, userId: string, id: string): void {
  assertWorkspace(db, userId, id);
  if (db.table("clankWorkspaces").get(id)?.ownerId !== userId) throw new BackendActionError(404, "WORKSPACE_NOT_FOUND", "Workspace management requires its owner.");
}
` : ""}
// Every handler obtains a fresh view inside its backend read/write transaction.
// No workspace identifier supplied by an RPC caller is trusted as a database scope.
function guardDatabase<Database>(database: Database, userId: string): Database {
  const source = database as any;
  const workspaceTables = new Set(${JSON.stringify(workspaceNames)});
  const uniqueFields: Record<string, string[][]> = ${JSON.stringify(unique)};
  const references: Record<string, Array<{ field: string; target: string }>> = ${JSON.stringify(references)};
  let workspace: string | undefined;
  const scoped = { table(name: string): any {
    const table = source.table(name);
    const owned = workspaceTables.has(name);
    const workspaceId = owned ? (workspace ??= ${enabled(app) ? "activeWorkspace(source, userId)" : "userId"}) : undefined;
    const visible = (document: any) => document && (!owned || document.workspaceId === workspaceId);
    const missing = () => { throw new BackendActionError(404, "RECORD_NOT_FOUND", "Record not found."); };
    const get = (id: string) => { const document = table.get(id); return visible(document) ? document : null; };
    const query = () => owned ? table.query().where("workspaceId", workspaceId) : table.query();
    const validate = (value: any, id?: string) => {
      for (const reference of references[name] ?? []) if (value[reference.field] != null && !scoped.table(reference.target).get(value[reference.field])) throw new BackendActionError(404, "REFERENCE_NOT_FOUND", "Referenced record is unavailable.");
      for (const fields of uniqueFields[name] ?? []) {
        if (fields.some((field) => value[field] == null)) continue;
        let duplicates = query();
        for (const field of fields) duplicates = duplicates.where(field, value[field]);
        if (duplicates.limit(2).collect().some((row: any) => row._id !== id)) throw new BackendActionError(409, "RELATIONSHIP_CARDINALITY", "This relationship already exists.");
      }
    };
    const history = (idOrOptions?: any, options?: any) => table.history(idOrOptions, options).filter((revision: any) => visible(revision.document));
    return {
      get, query, collect: () => query().collect(), history,
      insert(value: any) { const next = owned ? { ...value, workspaceId } : value; validate(next); return table.insert(next); },
      patch(id: string, value: any, options: any) { const current = get(id); if (!current) return missing(); const next = { ...current, ...value, ...(owned ? { workspaceId } : {}) }; validate(next, id); return table.patch(id, { ...value, ...(owned ? { workspaceId } : {}) }, options); },
      replace(id: string, value: any, options: any) { if (!get(id)) return missing(); const next = owned ? { ...value, workspaceId } : value; validate(next, id); return table.replace(id, next, options); },
      delete(id: string, options: any) { if (!get(id)) return missing(); return table.delete(id, options); },
      restore(id: string, cursor: any, options: any) {
        let before;
        for (let page = 0; page < 100; page++) {
          const revisions = table.history(id, { limit: 100, ...(before ? { before } : {}) });
          const revision = revisions.find((item: any) => item.cursor.revision === cursor.revision && item.cursor.sequence === cursor.sequence);
          if (revision) { if (!visible(revision.document)) return missing(); const current = table.get(id); if (current && !visible(current)) return missing(); validate(revision.document, id); return table.restore(id, cursor, options); }
          if (revisions.length < 100) break;
          before = revisions[revisions.length - 1].cursor;
        }
        return missing();
      },
    };
  } };
  return scoped as Database;
}`;
}
