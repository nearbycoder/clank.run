import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
// Observe the actual separately running provider catalog without becoming a writer.
export function pointInTimeReceiptCount(node){const observer=new DatabaseSync(join(node,'source.sqlite'),{readOnly:true});try{observer.exec('PRAGMA busy_timeout=5000');return observer.prepare('SELECT count(*) AS n FROM clank_pitr_remote_exports').get().n;}finally{observer.close();}}
