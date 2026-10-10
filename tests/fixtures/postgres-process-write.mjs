import {readFile} from 'node:fs/promises';
import {openPostgres,defineDatabase,defineTable,s} from '../../dist/index.js';
const settings=JSON.parse(await readFile(process.env.CLANK_POSTGRES_TEST_SETTINGS,'utf8'));
const schema=defineDatabase({records:defineTable({title:s.string()})});
const db=await openPostgres(schema,{...settings,namespace:process.env.CLANK_POSTGRES_PROCESS_NAMESPACE});
const id=db.transaction(tx=>tx.table('records').insert({title:'actual committed process'}));
process.channel.ref();process.send({kind:'committed',id,revision:db.version});await new Promise(()=>{});
