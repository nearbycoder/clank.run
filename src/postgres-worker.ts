// Private PostgreSQL v3 transport. SQL and credentials never leave this worker
// through an error. The public adapter sends only its own fixed SQL templates.
import { parentPort } from "node:worker_threads";
import { connect as connectTCP, isIP } from "node:net";
import { connect as connectTLS, checkServerIdentity } from "node:tls";
import { randomBytes, createHash, createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const text = (s: string) => Buffer.from(s, "utf8");
const cstring = (s: string) => Buffer.concat([text(s), Buffer.from([0])]);
const frame = (kind: string, body = Buffer.alloc(0)) => Buffer.concat([text(kind), i32(body.length + 4), body]);
class TransportError extends Error {
  declare readonly code: string;
  declare readonly sqlState?: string;
  constructor(code: string, sqlState?: string) { super(code); this.code = code; this.sqlState = sqlState; }
}
type Settings = {
  host: string; port: number; user: string; password: string; database: string;
  tls: "loopback" | { ca?: string; serverName?: string };
  timeoutMs: number; maxResponseBytes: number; maxRows: number;
};

class Input {
  declare readonly socket: any;
  declare readonly maximum: number;
  private bytes = Buffer.alloc(0);
  private waiter?: () => void;
  private failure?: TransportError;
  constructor(socket: any, maximum: number) {
    this.socket = socket; this.maximum = maximum;
    socket.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      if (this.bytes.length + chunk.length > this.maximum) { this.fail("PG_RESPONSE_LIMIT"); return; }
      this.bytes = Buffer.concat([this.bytes, chunk]); this.waiter?.();
    });
    socket.on("error", () => this.fail("PG_CONNECTION_LOST"));
    socket.on("close", () => this.fail("PG_CONNECTION_LOST"));
  }
  fail(code: string) { this.failure ??= new TransportError(code); this.socket.destroy(); this.waiter?.(); }
  async take(count: number): Promise<Buffer> {
    if (count < 0 || count > this.maximum) throw new TransportError("PG_PROTOCOL_INVALID");
    while (this.bytes.length < count) {
      if (this.failure) throw this.failure;
      await new Promise<void>(resolve => { this.waiter = resolve; }); this.waiter = undefined;
    }
    if (this.failure) throw this.failure;
    const value = this.bytes.subarray(0, count); this.bytes = this.bytes.subarray(count); return value;
  }
  async message() {
    const head = await this.take(5), length = head.readInt32BE(1);
    if (length < 4 || length > this.maximum) throw new TransportError("PG_PROTOCOL_INVALID");
    return { kind: String.fromCharCode(head[0]!), body: await this.take(length - 4) };
  }
  detach() { this.socket.removeAllListeners("data"); this.socket.removeAllListeners("error"); this.socket.removeAllListeners("close"); }
}

function fields(body: Buffer): string[] {
  const values: string[] = []; let start = 0;
  for (let n = 0; n < body.length; n++) if (body[n] === 0) { values.push(utf8.decode(body.subarray(start, n))); start = n + 1; }
  if (start !== body.length) throw new TransportError("PG_PROTOCOL_INVALID");
  return values;
}
function sqlError(body: Buffer): TransportError {
  let n = 0, sqlState: string | undefined;
  while (n < body.length && body[n] !== 0) {
    const kind = String.fromCharCode(body[n++]!); const end = body.indexOf(0, n);
    if (end < 0) throw new TransportError("PG_PROTOCOL_INVALID");
    if (kind === "C") { const value = body.subarray(n, end).toString("ascii"); if (/^[A-Z0-9]{5}$/u.test(value)) sqlState = value; }
    n = end + 1;
  }
  if (n !== body.length - 1 || !sqlState) throw new TransportError("PG_PROTOCOL_INVALID");
  return new TransportError("PG_STATEMENT_REJECTED", sqlState);
}

class Connection {
  declare readonly options: Settings;
  private socket: any;
  private input!: Input;
  private timer?: ReturnType<typeof setTimeout>;
  private authenticated = false;
  private scram?: { nonce: string; first: string; signature?: Buffer; verified?: boolean };
  constructor(options: Settings) { this.options = options; }
  private arm() { this.timer = setTimeout(() => this.input?.fail("PG_TIMEOUT"), this.options.timeoutMs); }
  private disarm() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  close() { this.disarm(); this.socket?.destroy(); }
  async open() {
    const o = this.options;
    this.socket = connectTCP({ host: o.host, port: o.port });
    this.input = new Input(this.socket, o.maxResponseBytes); this.arm();
    try {
      await new Promise<void>((resolve, reject) => { this.socket.once("connect", resolve); this.socket.once("error", () => reject(new TransportError("PG_CONNECTION_LOST"))); });
      if (o.tls !== "loopback") {
        this.socket.write(Buffer.concat([i32(8), i32(80877103)]));
        if ((await this.input.take(1))[0] !== 83) throw new TransportError("PG_TLS_REQUIRED");
        this.input.detach();
        const identity = o.tls.serverName ?? o.host;
        this.socket = connectTLS({ socket: this.socket, rejectUnauthorized: true,
          ...(o.tls.ca ? { ca: o.tls.ca } : {}),
          ...(isIP(identity) ? {} : { servername: identity }),
          checkServerIdentity: (_name: string, certificate: any) => checkServerIdentity(identity, certificate) });
        this.input = new Input(this.socket, o.maxResponseBytes);
        await new Promise<void>((resolve, reject) => { this.socket.once("secureConnect", resolve); this.socket.once("error", () => reject(new TransportError("PG_TLS_REJECTED"))); });
      }
      const body = Buffer.concat([i32(196608), cstring("user"), cstring(o.user), cstring("database"), cstring(o.database), cstring("client_encoding"), cstring("UTF8"), cstring("application_name"), cstring("clank-application"), Buffer.from([0])]);
      this.socket.write(Buffer.concat([i32(body.length + 4), body]));
      for (let count = 0; count < 100; count++) {
        const { kind, body: b } = await this.input.message();
        if (kind === "E") throw sqlError(b);
        if (kind === "R") { this.authentication(b); continue; }
        if (kind === "S") { if (!this.authenticated || fields(b).length !== 2) throw new TransportError("PG_PROTOCOL_INVALID"); continue; }
        if (kind === "K") { if (!this.authenticated || b.length !== 8) throw new TransportError("PG_PROTOCOL_INVALID"); continue; }
        if (kind === "N") continue;
        if (kind === "Z" && this.authenticated && b.length === 1 && b[0] === 73) return;
        throw new TransportError("PG_PROTOCOL_INVALID");
      }
      throw new TransportError("PG_RESPONSE_LIMIT");
    } catch (error) { this.close(); throw error; } finally { this.disarm(); }
  }
  private authentication(b: Buffer) {
    if (b.length < 4 || this.authenticated) throw new TransportError("PG_PROTOCOL_INVALID");
    const kind = b.readInt32BE(0);
    if (kind === 10 && !this.scram) {
      const mechanisms = fields(b.subarray(4));
      if (!mechanisms.includes("SCRAM-SHA-256") || mechanisms.at(-1) !== "") throw new TransportError("PG_AUTH_UNSUPPORTED");
      const nonce = randomBytes(24).toString("base64"), first = "n=,r=" + nonce;
      this.scram = { nonce, first }; const initial = text("n,," + first);
      this.socket.write(frame("p", Buffer.concat([cstring("SCRAM-SHA-256"), i32(initial.length), initial]))); return;
    }
    if (kind === 11 && this.scram && !this.scram.signature) {
      const challenge = utf8.decode(b.subarray(4));
      const match = /^r=([A-Za-z0-9+/=]{1,256}),s=([A-Za-z0-9+/]{1,1024}={0,2}),i=([1-9][0-9]{0,5})$/u.exec(challenge);
      if (!match || !match[1]!.startsWith(this.scram.nonce) || match[1]!.length < this.scram.nonce.length + 16) throw new TransportError("PG_AUTH_REJECTED");
      const salt = Buffer.from(match[2]!, "base64"), iterations = Number(match[3]);
      if (salt.toString("base64") !== match[2] || iterations < 4096 || iterations > 200000) throw new TransportError("PG_AUTH_REJECTED");
      const final = "c=biws,r=" + match[1], auth = this.scram.first + "," + challenge + "," + final;
      const salted = pbkdf2Sync(this.options.password, salt, iterations, 32, "sha256");
      const clientKey = createHmac("sha256", salted).update("Client Key").digest();
      const storedKey = createHash("sha256").update(clientKey).digest();
      const signature = createHmac("sha256", storedKey).update(auth).digest();
      const proof = Buffer.from(clientKey); for (let n = 0; n < proof.length; n++) proof[n] = proof[n]! ^ signature[n]!;
      this.scram.signature = createHmac("sha256", createHmac("sha256", salted).update("Server Key").digest()).update(auth).digest();
      this.socket.write(frame("p", text(final + ",p=" + proof.toString("base64")))); return;
    }
    if (kind === 12 && this.scram?.signature && !this.scram.verified) {
      const final = utf8.decode(b.subarray(4));
      if (!/^v=[A-Za-z0-9+/]{43}=$/u.test(final)) throw new TransportError("PG_AUTH_REJECTED");
      const signature = Buffer.from(final.slice(2), "base64");
      if (signature.length !== 32 || !timingSafeEqual(signature, this.scram.signature)) throw new TransportError("PG_AUTH_REJECTED");
      this.scram.verified = true; return;
    }
    if (kind === 0 && b.length === 4 && this.scram?.verified) { this.authenticated = true; this.scram = undefined; return; }
    throw new TransportError("PG_AUTH_UNSUPPORTED");
  }
  async query(sql: string, parameters: Array<string | null>) {
    if (!this.authenticated || sql.includes("\0") || text(sql).length > 65536 || parameters.length > 128) throw new TransportError("PG_REQUEST_LIMIT");
    const values = parameters.map(value => value === null ? i32(-1) : Buffer.concat([i32(text(value).length), text(value)]));
    const request = Buffer.concat([frame("P", Buffer.concat([cstring(""), cstring(sql), i16(0)])),
      frame("B", Buffer.concat([cstring(""), cstring(""), i16(0), i16(values.length), ...values, i16(0)])),
      frame("D", Buffer.concat([text("P"), cstring("")])), frame("E", Buffer.concat([cstring(""), i32(0)])), frame("S")]);
    if (request.length > this.options.maxResponseBytes) throw new TransportError("PG_REQUEST_LIMIT");
    this.arm();
    try {
      this.socket.write(request); let columns: string[] | undefined, error: TransportError | undefined;
      let phase = 0, command = "", bytes = 0; const rows: Array<Record<string, string | null>> = [];
      for (let count = 0; count < this.options.maxRows + 100; count++) {
        const { kind, body: b } = await this.input.message(); bytes += b.length + 5;
        if (bytes > this.options.maxResponseBytes) throw new TransportError("PG_RESPONSE_LIMIT");
        if (kind === "E") { error = sqlError(b); continue; }
        if (kind === "N") continue;
        if (kind === "S") { if (fields(b).length !== 2) throw new TransportError("PG_PROTOCOL_INVALID"); continue; }
        if (kind === "Z") {
          if (b.length !== 1 || ![73,84,69].includes(b[0]!)) throw new TransportError("PG_PROTOCOL_INVALID");
          if (error) throw error;
          if (phase !== 4) throw new TransportError("PG_PROTOCOL_INVALID");
          return { rows, command, transactionStatus: String.fromCharCode(b[0]!) };
        }
        if (error) throw new TransportError("PG_PROTOCOL_INVALID");
        if (kind === "1" && phase === 0 && b.length === 0) { phase = 1; continue; }
        if (kind === "2" && phase === 1 && b.length === 0) { phase = 2; continue; }
        if (kind === "n" && phase === 2 && b.length === 0) { columns = []; phase = 3; continue; }
        if (kind === "T" && phase === 2) {
          if (b.length < 2) throw new TransportError("PG_PROTOCOL_INVALID");
          const size = b.readInt16BE(0); if (size < 0 || size > 64) throw new TransportError("PG_RESPONSE_LIMIT");
          columns = []; let offset = 2;
          for (let n = 0; n < size; n++) {
            const end = b.indexOf(0, offset); if (end < 0 || end + 19 > b.length) throw new TransportError("PG_PROTOCOL_INVALID");
            const name = utf8.decode(b.subarray(offset, end));
            if (!name || name.length > 128 || columns.includes(name) || b.readInt16BE(end + 17) !== 0) throw new TransportError("PG_PROTOCOL_INVALID");
            columns.push(name); offset = end + 19;
          }
          if (offset !== b.length) throw new TransportError("PG_PROTOCOL_INVALID"); phase = 3; continue;
        }
        if (kind === "D" && phase === 3 && columns) {
          if (b.length < 2 || b.readInt16BE(0) !== columns.length || rows.length >= this.options.maxRows) throw new TransportError("PG_RESPONSE_LIMIT");
          const row: Record<string,string|null> = Object.create(null); let offset = 2;
          for (const name of columns) {
            if (offset + 4 > b.length) throw new TransportError("PG_PROTOCOL_INVALID");
            const length = b.readInt32BE(offset); offset += 4;
            if (length < -1 || offset + Math.max(0,length) > b.length) throw new TransportError("PG_PROTOCOL_INVALID");
            row[name] = length === -1 ? null : utf8.decode(b.subarray(offset, offset + length)); offset += Math.max(0,length);
          }
          if (offset !== b.length) throw new TransportError("PG_PROTOCOL_INVALID"); rows.push(row); continue;
        }
        if (kind === "C" && phase === 3) { const value = fields(b); if (value.length !== 1 || value[0]!.length > 96 || !/^[A-Z]+(?: [A-Z]+)*(?: [0-9]+){0,2}$/u.test(value[0]!)) throw new TransportError("PG_PROTOCOL_INVALID"); command = value[0]!; phase = 4; continue; }
        throw new TransportError("PG_PROTOCOL_INVALID");
      }
      throw new TransportError("PG_RESPONSE_LIMIT");
    } catch (error) { if (!(error instanceof TransportError) || error.code !== "PG_STATEMENT_REJECTED") this.close(); throw error; }
    finally { this.disarm(); }
  }
}

let connection: Connection | undefined;
let busy = false;
parentPort!.on("message", async message => {
  const header = new Int32Array(message.memory, 0, 4), output = new Uint8Array(message.memory, 16);
  const complete = (value: unknown) => {
    if (Atomics.load(header, 0) !== 0) { connection?.close(); return; }
    let encoded = text(JSON.stringify(value));
    if (encoded.length > output.length) { connection?.close(); encoded = text('{"error":"PG_RESPONSE_LIMIT"}'); }
    output.set(encoded); Atomics.store(header, 1, encoded.length); Atomics.store(header, 0, 1); Atomics.notify(header, 0);
  };
  if (busy) { complete({ error: "PG_CONCURRENT_OPERATION" }); return; }
  busy = true;
  try {
    if (message.kind === "connect") { if (connection) throw new TransportError("PG_PROTOCOL_INVALID"); connection = new Connection(message.options); await connection.open(); complete({ connected: true }); }
    else if (message.kind === "query" && connection) complete(await connection.query(message.sql, message.parameters));
    else throw new TransportError("PG_PROTOCOL_INVALID");
  } catch (error) {
    complete({ error: error instanceof TransportError ? error.code : "PG_PROTOCOL_INVALID", ...(error instanceof TransportError && error.sqlState ? { sqlState: error.sqlState } : {}) });
  } finally { busy = false; }
});
