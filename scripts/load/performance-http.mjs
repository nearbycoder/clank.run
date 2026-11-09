// Closed-loop A/B HTTP throughput through the real Node adapter, one server process per build.
// node scripts/load/performance-http.mjs BASELINE_DIST CANDIDATE_DIST [PATHS] [SECONDS=2] [CONNECTIONS=32] [ROUNDS=3]
// PATHS is a comma list of /text, /json, /api/resource19/abc, /page (SSR) and query (backend POST).
import { fork } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
const [basePath, candPath, pathsIn = "/text,/json,/api/resource19/abc,/page,query", secIn = "2", connIn = "32", roundsIn = "3"] = process.argv.slice(2);
const seconds = Number(secIn), connections = Number(connIn), rounds = Number(roundsIn);
if (!basePath || !candPath) throw new Error("Provide baseline and candidate dist directories.");
if (![seconds, connections, rounds].every((value) => Number.isFinite(value) && value >= 1) || seconds > 60 || connections > 512 || rounds > 20) throw new Error("Invalid bounded load profile.");
const serverScript = fileURLToPath(new URL("./performance-http-fixture.mjs", import.meta.url));
const nodeBin = process.env.SERVER_NODE ?? process.execPath;
function start(dist, port) {
  return new Promise((resolve, reject) => {
    const child = fork(serverScript, [dist, String(port)], { execPath: nodeBin, execArgv: ["--disable-warning=ExperimentalWarning"], stdio: ["ignore", "inherit", "inherit", "ipc"], env: process.env });
    child.once("message", () => resolve(child)); child.once("error", reject); child.once("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
}
function requestBytes(path) {
  if (path === "query") { const body = "{}"; return Buffer.from(`POST /__clank/query/list HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`); }
  return Buffer.from(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept-Encoding: ${process.env.COMPRESS ? "br" : "identity"}\r\n\r\n`);
}
function drive(port, path, ms) {
  const payload = requestBytes(path);
  let done = 0, errors = 0, stop = false;
  const latencies = [];
  const sockets = [];
  return new Promise((resolve) => {
    let open = connections;
    for (let i = 0; i < connections; i++) {
      const socket = connect(port, "127.0.0.1"); sockets.push(socket);
      socket.setNoDelay(true);
      let buffer = Buffer.alloc(0), started = 0;
      const send = () => { started = performance.now(); socket.write(payload); };
      socket.on("connect", send);
      socket.on("data", (chunk) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        while (true) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const head = buffer.subarray(0, headerEnd).toString("latin1");
          let total;
          const length = /\r\ncontent-length: (\d+)/i.exec(head);
          if (length) total = headerEnd + 4 + Number(length[1]);
          else { const end = buffer.indexOf("0\r\n\r\n", headerEnd + 4); if (end === -1) return; total = end + 5; }
          if (buffer.length < total) return;
          if (!head.startsWith("HTTP/1.1 200")) errors++;
          buffer = buffer.subarray(total);
          done++; if (done % 16 === 0) latencies.push(performance.now() - started);
          if (stop) { socket.end(); return; }
          send();
        }
      });
      socket.on("error", () => { errors++; });
      socket.on("close", () => { if (--open === 0) resolve({ rps: done / (ms / 1000), errors, p50: quantile(latencies, 0.5), p99: quantile(latencies, 0.99) }); });
    }
    setTimeout(() => { stop = true; setTimeout(() => sockets.forEach((s) => s.destroy()), 300); }, ms);
  });
}
const quantile = (v, q) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0; };
const median = (v) => quantile(v, 0.5);
const servers = { baseline: await start(basePath, 34101), candidate: await start(candPath, 34102) };
const ports = { baseline: 34101, candidate: 34102 };
try {
  for (const path of pathsIn.split(",")) {
    for (const label of ["baseline", "candidate"]) await drive(ports[label], path, 700);
    const samples = { baseline: [], candidate: [] };
    let errors = 0;
    for (let round = 0; round < rounds; round++) for (const label of round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) { const r = await drive(ports[label], path, seconds * 1000); samples[label].push(r); errors += r.errors; }
    const b = median(samples.baseline.map((r) => r.rps)), c = median(samples.candidate.map((r) => r.rps));
    console.log(`${path.padEnd(24)} base ${b.toFixed(0).padStart(7)} rps (p99 ${median(samples.baseline.map((r) => r.p99)).toFixed(2)}ms)  cand ${c.toFixed(0).padStart(7)} rps (p99 ${median(samples.candidate.map((r) => r.p99)).toFixed(2)}ms)  ${(c / b).toFixed(2)}x${errors ? `  ERRORS ${errors}` : ""}`);
  }
} finally { for (const child of Object.values(servers)) { child.removeAllListeners("exit"); child.send("stop"); setTimeout(() => child.kill("SIGKILL"), 1500).unref(); } }
