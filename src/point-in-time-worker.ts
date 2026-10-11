import { sealPointInTimeState } from "./point-in-time-state.ts";
/** Called only inside the bounded SQLite namespace. Never publishes its working database. */
export async function replayJournal(databasePath: string, envelopes: string[], keyBytes: number[], epoch: string, through?: number, asOf?: number) {
  const sqliteName = "node:sqlite", cryptoName = "node:crypto";
  const [{ DatabaseSync }, crypto] = await Promise.all([import(sqliteName), import(cryptoName)]);
  const database = new DatabaseSync(databasePath);
  const buffer = (globalThis as any).Buffer;
  try {
    database.enableLoadExtension(false);
    database.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=1000");
    let state = database.prepare("SELECT * FROM clank_pitr_state WHERE id=1").get();
    if (!state || state.epoch !== epoch) throw new Error("Recovery base epoch does not match the repository.");
    if (sealPointInTimeState(database, crypto.createHash, 128 * 1024 * 1024) !== state.state_hash) throw new Error("Recovery base seal does not match its committed state.");
    if ((through != null && Number(state.sequence) > through) || (asOf != null && Number(state.committed_at) > asOf)) throw new Error("Requested recovery boundary predates the base snapshot.");
    for (const encoded of envelopes) {
      const entry = JSON.parse(encoded);
      const { digest, ...content } = entry;
      if (entry.protocol !== "clank-pitr/1" || entry.epoch !== epoch || entry.keyId !== state.key_id || entry.schemaHash !== state.schema_hash
        || !Number.isSafeInteger(entry.sequence) || !Number.isSafeInteger(entry.committedAt)
        || crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex") !== digest) throw new Error("Invalid recovery journal envelope.");
      const { iv, body, tag, ...header } = content;
      const decipher = crypto.createDecipheriv("aes-256-gcm", new Uint8Array(keyBytes), buffer.from(iv, "base64"));
      decipher.setAAD(buffer.from(JSON.stringify(header))); decipher.setAuthTag(buffer.from(tag, "base64"));
      const plaintext = JSON.parse(buffer.concat([decipher.update(buffer.from(body, "base64")), decipher.final()]).toString("utf8"));
      // Envelopes already represented by the base are still authenticated before skipping.
      if (entry.sequence <= Number(state.sequence)) continue;
      if (entry.sequence !== Number(state.sequence) + 1 || entry.previousDigest !== state.digest || entry.committedAt <= Number(state.committed_at)) throw new Error("Recovery journal is missing or reorders a committed transaction.");
      database.exec("BEGIN IMMEDIATE");
      try {
        // Changesets already contain trigger/cascade effects. Re-running either
        // would duplicate writes or incorrectly conflict with captured deletes.
        const triggers = database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
        for (const trigger of triggers) database.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`);
        for (const change of plaintext.changes) {
          if (typeof change.table !== "string" || change.table.startsWith("clank_pitr_") || (change.table !== "*" && !database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(change.table))) throw new Error("Recovery changeset names an unsupported table.");
          if (!database.applyChangeset(buffer.from(change.bytes, "base64"), { filter: (table: string) => (change.table === "*" ? !table.startsWith("clank_pitr_") : table === change.table) })) throw new Error("Recovery changeset conflicts with its base.");
        }
        if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) {
          database.exec("DELETE FROM sqlite_sequence");
          for (const sequence of plaintext.sequences) database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)").run(sequence.name, sequence.seq);
        }
        for (const trigger of triggers) database.exec(String(trigger.sql));
        if (database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Recovery changeset violates foreign keys.");
        if (sealPointInTimeState(database, crypto.createHash, 128 * 1024 * 1024) !== plaintext.stateHash) throw new Error("Recovered state does not match its committed recovery seal.");
        database.prepare("UPDATE clank_pitr_state SET sequence=?,digest=?,committed_at=?,state_hash=? WHERE id=1")
          .run(entry.sequence, digest, entry.committedAt, plaintext.stateHash);
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      state = database.prepare("SELECT * FROM clank_pitr_state WHERE id=1").get();
    }
    return { epoch, sequence: Number(state.sequence), committedAt: Number(state.committed_at), databasePath };
  } finally { database.close(); }
}
export async function finishReplay(databasePath: string): Promise<void> {
  const sqliteName = "node:sqlite";
  const { DatabaseSync } = await import(sqliteName);
  const database = new DatabaseSync(databasePath);
  try {
    database.enableLoadExtension(false); database.exec("PRAGMA trusted_schema=OFF");
    if (String(database.prepare("PRAGMA integrity_check").get()?.integrity_check) !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Recovered SQLite database failed integrity checks.");
    database.exec("BEGIN IMMEDIATE");
    try {
      // Source export receipts belong to the old epoch. Retaining their table
      // would make enrolling the restored database fail as a partial protocol.
      database.exec("DROP TABLE IF EXISTS clank_pitr_remote_exports; DROP TABLE clank_pitr_journal; DROP TABLE clank_pitr_state; COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { database.close(); }
}

async function transferDatabase(databasePath:string,work:(database:any,crypto:any)=>unknown){
  const sqliteName="node:sqlite",cryptoName="node:crypto",fsName="node:fs/promises";
  const [{DatabaseSync},crypto,fs]=await Promise.all([import(sqliteName),import(cryptoName),import(fsName)]);
  const stat=await fs.lstat(databasePath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>512*1024*1024)throw new Error("Transfer destination is not a bounded private regular file.");
  const database=new DatabaseSync(databasePath);
  try{database.enableLoadExtension(false);database.exec("PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=OFF;PRAGMA busy_timeout=1000");return work(database,crypto);}finally{database.close();}
}
function capturedState(database:any,crypto:any){
  const state=database.prepare("SELECT * FROM clank_pitr_state WHERE id=1").get();
  if(!state||!Number.isSafeInteger(state.sequence)||state.sequence<0||!/^[0-9a-f]{64}$/u.test(state.digest)
    ||sealPointInTimeState(database,crypto.createHash,128*1024*1024)!==state.state_hash)throw new Error("Transfer destination differs from its native capture seal.");
  const schema=JSON.stringify(database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB 'clank_pitr_*' ORDER BY type,name").all());
  if(crypto.createHash("sha256").update(schema).digest("hex")!==state.schema_hash)throw new Error("Transfer destination schema changed.");
  return state;
}
function cursorOf(state:any){return {epoch:String(state.epoch),sequence:Number(state.sequence),digest:String(state.digest)};}
function transferState(database:any,crypto:any,binding:any){
  const row=database.prepare("SELECT * FROM clank_pitr_transfer_state WHERE id=1").get();
  if(!row||row.protocol!==1||row.identity!==JSON.stringify(binding.identity)||binding.archiveSha256!==undefined&&row.archive_sha256!==binding.archiveSha256
    ||binding.initialCursor!==undefined&&row.initial_cursor!==JSON.stringify(binding.initialCursor))throw new Error("Transfer destination identity or base differs from its reservation.");
  const state=capturedState(database,crypto);
  if(row.cursor!==JSON.stringify(cursorOf(state))||row.base_id!==state.base_id)throw new Error("Transfer cursor differs from its native capture state.");
  return {row,state};
}
function transferInspection(database:any,crypto:any,binding:any,request?:any){
  const {row,state}=transferState(database,crypto,binding),cursor=cursorOf(state);
  if(request){
    if(request.batch.baseBackupId!==row.base_id||request.batch.keyId!==state.key_id||request.batch.through.epoch!==state.epoch)throw new Error("Transfer batch base or epoch changed.");
    const receipt=database.prepare("SELECT fingerprint,after_cursor,through_cursor FROM clank_pitr_transfer_receipts WHERE sequence=?").get(request.batch.through.sequence);
    if(receipt){
      if(receipt.fingerprint!==request.batchSha256||receipt.after_cursor!==JSON.stringify(request.expectedCursor)||receipt.through_cursor!==JSON.stringify(request.batch.through)
        ||state.sequence<request.batch.through.sequence)throw new Error("Transfer receipt diverged or its cursor was rolled back.");
      return {cursor,baseBackupId:row.base_id,appliedEntries:0,replayed:true};
    }
    if(row.cursor!==JSON.stringify(request.expectedCursor))throw new Error("Transfer predecessor does not match the retained destination cursor.");
  }
  return {cursor,baseBackupId:row.base_id,appliedEntries:0,replayed:false};
}
/** Native metadata remains with the stopped replica until a future reviewed promotion. */
export async function initializeTransfer(databasePath:string,identity:any,baseBackupId:string,archiveSha256:string){
  return transferDatabase(databasePath,(database,crypto)=>{
    database.exec("BEGIN IMMEDIATE");
    try{
      const state=capturedState(database,crypto);
      if(state.base_id!==""&&state.base_id!==baseBackupId||database.prepare("SELECT 1 FROM sqlite_schema WHERE name GLOB 'clank_pitr_transfer_*' LIMIT 1").get())throw new Error("Transfer base is already enrolled or changed.");
      database.exec(`CREATE TABLE clank_pitr_transfer_state(id INTEGER PRIMARY KEY CHECK(id=1),protocol INTEGER NOT NULL,identity TEXT NOT NULL,base_id TEXT NOT NULL,archive_sha256 TEXT NOT NULL,initial_cursor TEXT NOT NULL,cursor TEXT NOT NULL) STRICT;
        CREATE TABLE clank_pitr_transfer_receipts(sequence INTEGER PRIMARY KEY,fingerprint TEXT NOT NULL,after_cursor TEXT NOT NULL,through_cursor TEXT NOT NULL) STRICT;`);
      database.prepare("UPDATE clank_pitr_state SET base_id=? WHERE id=1").run(baseBackupId);
      const cursor=JSON.stringify(cursorOf(state));
      const inserted=database.prepare("INSERT INTO clank_pitr_transfer_state VALUES(1,1,?,?,?,?,?)").run(JSON.stringify(identity),baseBackupId,archiveSha256,cursor,cursor);
      if(Number(inserted.changes)!==1)throw new Error("Transfer enrollment was not retained.");
      const result=transferInspection(database,crypto,{identity,archiveSha256,initialCursor:cursorOf(state)});
      database.exec("COMMIT");return result;
    }catch(error){database.exec("ROLLBACK");throw error;}
  });
}
export async function inspectTransfer(databasePath:string,binding:any,request?:any){
  return transferDatabase(databasePath,(database,crypto)=>{
    database.exec("BEGIN");try{const result=transferInspection(database,crypto,binding,request);database.exec("COMMIT");return result;}catch(error){database.exec("ROLLBACK");throw error;}
  });
}
/** One native transaction contains all application effects, its exact cursor and acknowledgment. */
export async function applyTransfer(databasePath:string,request:any,keyBytes:number[]){
  return transferDatabase(databasePath,(database,crypto)=>{
    const buffer=(globalThis as any).Buffer,batch=request.batch,{authentication,...content}=batch;
    if(authentication!==crypto.createHmac("sha256",new Uint8Array(keyBytes)).update(JSON.stringify(content)).digest("hex"))throw new Error("Transfer batch authentication failed.");
    database.exec("BEGIN IMMEDIATE");
    try{
      const original=transferInspection(database,crypto,{identity:request.identity},request);
      if(original.replayed){database.exec("COMMIT");return original;}
      if(Number(database.prepare("SELECT count(*) AS n FROM clank_pitr_transfer_receipts").get().n)>=10000)throw new Error("Transfer receipt capacity is exhausted.");
      let state=capturedState(database,crypto);
      for(const encoded of batch.envelopes){
        const {digest,...entry}=JSON.parse(encoded);
        if(entry.protocol!=="clank-pitr/1"||entry.epoch!==state.epoch||entry.keyId!==state.key_id||entry.schemaHash!==state.schema_hash
          ||entry.sequence!==state.sequence+1||entry.previousDigest!==state.digest||!Number.isSafeInteger(entry.committedAt)||entry.committedAt<=state.committed_at
          ||crypto.createHash("sha256").update(JSON.stringify(entry)).digest("hex")!==digest)throw new Error("Transfer journal gap, divergence or invalid envelope.");
        const {iv,body,tag,...header}=entry,decipher=crypto.createDecipheriv("aes-256-gcm",new Uint8Array(keyBytes),buffer.from(iv,"base64"));
        decipher.setAAD(buffer.from(JSON.stringify(header)));decipher.setAuthTag(buffer.from(tag,"base64"));
        const plaintext=JSON.parse(buffer.concat([decipher.update(buffer.from(body,"base64")),decipher.final()]).toString("utf8"));
        const triggers=database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name NOT GLOB 'clank_pitr_*' ORDER BY name").all();
        for(const trigger of triggers)database.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"','""')}"`);
        for(const change of plaintext.changes){
          if(typeof change.table!=="string"||change.table.startsWith("clank_pitr_")||(change.table!=="*"&&!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(change.table)))throw new Error("Transfer changeset names an unsupported table.");
          if(!database.applyChangeset(buffer.from(change.bytes,"base64"),{filter:(table:string)=>change.table==="*"?!table.startsWith("clank_pitr_"):table===change.table}))throw new Error("Transfer changeset conflicts with its base.");
        }
        if(database.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()){
          database.exec("DELETE FROM sqlite_sequence");for(const sequence of plaintext.sequences)database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)").run(sequence.name,sequence.seq);
        }
        for(const trigger of triggers)database.exec(String(trigger.sql));
        if(database.prepare("PRAGMA foreign_key_check").all().length||sealPointInTimeState(database,crypto.createHash,128*1024*1024)!==plaintext.stateHash)throw new Error("Transfer application effects fail their committed seal.");
        const updated=database.prepare("UPDATE clank_pitr_state SET sequence=?,digest=?,committed_at=?,state_hash=? WHERE id=1").run(entry.sequence,digest,entry.committedAt,plaintext.stateHash);
        state=database.prepare("SELECT * FROM clank_pitr_state WHERE id=1").get();
        if(Number(updated.changes)!==1||state.sequence!==entry.sequence||state.digest!==digest||state.committed_at!==entry.committedAt||state.state_hash!==plaintext.stateHash)throw new Error("Transfer capture cursor was not retained.");
      }
      if(JSON.stringify(cursorOf(state))!==JSON.stringify(batch.through))throw new Error("Transfer batch does not reach its authenticated horizon.");
      const cursor=JSON.stringify(cursorOf(state)),updated=database.prepare("UPDATE clank_pitr_transfer_state SET cursor=? WHERE id=1 AND cursor=?").run(cursor,JSON.stringify(request.expectedCursor));
      const receipt=database.prepare("INSERT INTO clank_pitr_transfer_receipts VALUES(?,?,?,?)").run(batch.through.sequence,request.batchSha256,JSON.stringify(request.expectedCursor),cursor);
      if(Number(updated.changes)!==1||Number(receipt.changes)!==1)throw new Error("Transfer cursor or receipt was not durably retained.");
      const accepted=transferInspection(database,crypto,{identity:request.identity},request);
      if(!accepted.replayed||String(database.prepare("PRAGMA integrity_check").get()?.integrity_check)!=="ok")throw new Error("Transfer acknowledgment or integrity check failed.");
      database.exec("COMMIT");return {...accepted,appliedEntries:batch.envelopes.length,replayed:false};
    }catch(error){database.exec("ROLLBACK");throw error;}
  });
}

/** Decrypt the already authenticated archive base only inside the pinned private worker directory. */
export async function prepareTransferBase(databasePath:string,envelopePath:string,signed:any,keyBytes:number[],baseId:string):Promise<void>{
  const fsName="node:fs/promises",nativeName="node:fs",cryptoName="node:crypto",streamsName="node:stream/promises";
  const [fs,native,crypto,streams]=await Promise.all([import(fsName),import(nativeName),import(cryptoName),import(streamsName)]);
  const buffer=(globalThis as any).Buffer,key=crypto.createHash("sha256").update(new Uint8Array(keyBytes)).digest(),manifest=signed?.manifest,magic=buffer.from("CLNKBK1\n"),header=buffer.alloc(magic.length+12),tag=buffer.alloc(16);
  if(manifest?.protocol!=="clank-backup/1"||manifest.id!==baseId||manifest.encryption?.algorithm!=="AES-256-GCM"||!Number.isSafeInteger(manifest.databaseBytes)||manifest.databaseBytes<1||manifest.databaseBytes>512*1024*1024
    ||!/^[0-9a-f]{64}$/u.test(manifest.databaseSha256)||signed.mac!==crypto.createHmac("sha256",key).update(JSON.stringify(manifest)).digest("base64url"))throw new Error("Transfer backup manifest authentication failed.");
  const handle=await fs.open(envelopePath,native.constants.O_RDONLY|native.constants.O_NOFOLLOW|native.constants.O_NONBLOCK);
  try{
    const stats=await handle.stat();
    if(!stats.isFile()||stats.nlink!==1||stats.size!==manifest.databaseBytes+header.length+tag.length)throw new Error("Transfer encrypted base has an invalid bound.");
    if((await handle.read(header,0,header.length,0)).bytesRead!==header.length||(await handle.read(tag,0,tag.length,stats.size-tag.length)).bytesRead!==tag.length||!header.subarray(0,magic.length).equals(magic))throw new Error("Transfer encrypted base header is invalid.");
    const decipher=crypto.createDecipheriv("aes-256-gcm",key,header.subarray(magic.length));decipher.setAAD(buffer.from(JSON.stringify(manifest)));decipher.setAuthTag(tag);
    await streams.pipeline(handle.createReadStream({start:header.length,end:stats.size-tag.length-1,autoClose:false}),decipher,native.createWriteStream(databasePath,{flags:"wx",mode:0o600}));
    const digest=crypto.createHash("sha256");let bytes=0;
    for await(const chunk of native.createReadStream(databasePath)){bytes+=chunk.length;if(bytes>manifest.databaseBytes)throw new Error("Transfer plaintext exceeds its bound.");digest.update(chunk);}
    if(bytes!==manifest.databaseBytes||digest.digest("hex")!==manifest.databaseSha256)throw new Error("Transfer plaintext checksum failed.");
    await transferDatabase(databasePath,(database,crypto)=>{capturedState(database,crypto);if(String(database.prepare("PRAGMA integrity_check").get()?.integrity_check)!=="ok"||database.prepare("PRAGMA foreign_key_check").all().length)throw new Error("Transfer base integrity failed.");});
  }finally{key.fill(0);await handle.close();}
}
