import { DatabaseSync } from 'node:sqlite';

const database = new DatabaseSync(process.argv[2]);
// Force dirty pages to spill before notifying the parent. SIGKILL then leaves a
// real hot DELETE journal, rather than depending on interrupting a short commit.
database.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA cache_size = 2; BEGIN IMMEDIATE; UPDATE writer_events SET payload = zeroblob(262144); INSERT INTO writer_events VALUES(2, zeroblob(262144));');
process.send({ ready: true });
setInterval(() => {}, 1000);
