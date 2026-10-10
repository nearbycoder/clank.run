import {defineDatabase,defineTable,defineBackend,openBackend,openSQLite,openPostgres,s,
  type ApplicationDatabase,type SQLiteDatabase,type PostgresDatabase,type Id} from '../src/index.ts';
const schema=defineDatabase({notes:defineTable({title:s.string(),count:s.number()})});
const pg=await openPostgres(schema,{host:'127.0.0.1',database:'app',user:'app',password:'private consumer value',tls:'loopback'});
const portable:ApplicationDatabase<typeof schema>=pg;
const storage:PostgresDatabase<typeof schema>=pg;
const id:Id<'notes'>=pg.transaction(db=>db.table('notes').insert({title:'typed',count:1}));
pg.read(db=>db.table('notes').get(id));await storage.reconnect();
const definition=defineBackend({schema}).functions(({publicQuery})=>({list:publicQuery({args:{},handler:({db})=>db.table('notes').collect()})}));
const runtime=await openBackend(definition,{database:pg});await runtime.database.reconnect();
const local=await openBackend(definition);const native:SQLiteDatabase<typeof schema>=local.database;
// @ts-expect-error PostgreSQL has no SQLite internal/native capability.
const wrong:SQLiteDatabase<typeof schema>=pg;
// @ts-expect-error A concrete default SQLite runtime has no PostgreSQL reconnect API.
local.database.reconnect();
// @ts-expect-error Invalid table names cannot become SQL identifiers.
portable.read(db=>db.table('missing').collect());
// @ts-expect-error Schema fields preserve generated-table consumer validation.
pg.transaction(db=>db.table('notes').insert({title:'wrong',count:'not numeric'}));
// @ts-expect-error TLS verification cannot be disabled with a generic TLS escape hatch.
openPostgres(schema,{host:'example.test',database:'app',user:'app',password:'private',tls:{rejectUnauthorized:false}});
// @ts-expect-error Unrecognized TLS modes are unsupported.
openPostgres(schema,{host:'example.test',database:'app',user:'app',password:'private',tls:'insecure'});
void native;void portable;void storage;void wrong;void openSQLite;
