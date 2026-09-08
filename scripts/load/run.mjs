// Open-loop HTTP load generator: latency includes scheduling delay, with explicit dropped work.
import { fork } from 'node:child_process';
import { request, Agent } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const users = Number(args.users ?? 1000), seconds = Number(args.seconds ?? 10), rounds = Number(args.rounds ?? 1);
const rates = (args.rates ?? '25,100,250,500').split(',').map(Number);
const kind = args.kind ?? 'app';
if (!['mixed', 'login', 'burst'].includes(args.mode ?? 'mixed')) throw Error('Invalid load mode');
for (const [name, maximum] of [['liveLimit', 20000], ['cacheEntries', 50000], ['authConcurrency', 16], ['ingressRpm', 1000000], ['metricBuckets', 1440]]) {
  if (args[name] !== undefined && (!Number.isInteger(Number(args[name])) || Number(args[name]) < 1 || Number(args[name]) > maximum)) {
    throw Error(`Invalid ${name}`);
  }
}
if (!['app', 'platform', 'ingress'].includes(kind) || !Number.isInteger(users) || users < (kind === 'ingress' ? 3 : 1) || users > 10000 ||
    !Number.isFinite(seconds) || seconds < 1 || seconds > 120 || !Number.isInteger(rounds) || rounds < 1 || rounds > 5 ||
    rates.some(rate => !Number.isInteger(rate) || rate < 1 || rate > 5000)) throw Error('Invalid bounded load profile');
if (users * 3 * Number(args.metricBuckets ?? 0) > 2000000) throw Error('Metric fixture exceeds two million buckets');
const output = resolve(args.output ?? `/tmp/clank-load-${kind}.json`);
const candidates = [{ name: 'candidate', dist: resolve(args.candidate ?? 'dist') }];
if (args.baseline) candidates.unshift({ name: 'baseline', dist: resolve(args.baseline) });
const report = { protocol: 'clank-load/1', startedAt: new Date().toISOString(), kind, users, seconds, rates,
  settings: { mode: args.mode ?? 'mixed', authConcurrency: Number(args.authConcurrency ?? 2),
    ingressRpm: Number(args.ingressRpm ?? 3000), cacheEntries: Number(args.cacheEntries ?? 1000),
    liveLimit: Number(args.liveLimit ?? 1000), metricBuckets: Number(args.metricBuckets ?? 0) },
  machine: { node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem() },
  topology: 'One isolated Node server process and a separate generator process on the same host; loopback HTTP; local SQLite',
  recordsPerUser: kind === 'app' ? 20 : 3, samples: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : null;

async function start(candidate) {
  const root = await mkdtemp(join(tmpdir(), 'clank-load-fixture-'));
  const child = fork(fileURLToPath(new URL('./fixture.mjs', import.meta.url)), [JSON.stringify({ root, kind, users,
    dist: candidate.dist, liveLimit: args.liveLimit ? Number(args.liveLimit) : undefined,
    cacheEntries: args.cacheEntries ? Number(args.cacheEntries) : undefined,
    ingressRpm: args.ingressRpm ? Number(args.ingressRpm) : undefined,
    metricBuckets: args.metricBuckets ? Number(args.metricBuckets) : undefined,
    authConcurrency: args.authConcurrency ? Number(args.authConcurrency) : undefined })],
    { execArgv: ['--expose-gc', '--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', serial = 0;
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  const pending = new Map();
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Fixture setup timed out')), 120000);
    child.on('message', message => {
      if (message.ready) { clearTimeout(timeout); resolve(message); }
      else if (pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id); clearTimeout(timer); pending.delete(message.id);
        message.error ? reject(Error(message.error)) : resolve(message.result);
      }
    });
    child.once('exit', code => { clearTimeout(timeout); reject(Error(`Fixture exited ${code}: ${stderr}`)); });
  }).catch(async error => { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); throw error; });
  const rpc = command => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error(`IPC timeout: ${command}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); child.send({ id, command });
  });
  return { ...ready, child, root, rpc, async close() {
    try { await rpc('close'); } catch { child.kill('SIGKILL'); }
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), pause(2000).then(() => child.kill('SIGKILL'))]);
    await rm(root, { recursive: true, force: true });
  } };
}

async function load(fixture, rate, duration, mode = 'mixed') {
  const agent = new Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 100 });
  const latency = [], serviceLatency = [], scheduling = [], status = {}, failures = {}, errorExamples = {};
  const inflight = new Set(); let sent = 0, dropped = 0, bytes = 0, valid = 0;
  const started = performance.now(), count = Math.floor(rate * duration), interval = 1000 / rate;
  const target = new URL(fixture.url);
  async function send(index, due) {
    const user = fixture.users[index % fixture.users.length];
    const type = mode === 'login' ? 'login' : kind === 'ingress' ? 'ingress' : kind === 'platform' ? (index % 2 ? 'projects' : 'dashboard') :
      index % 10 === 0 ? 'ssr' : index % 10 === 1 ? 'write' : 'list';
    const path = type === 'login' ? '/__clank/auth/login' : type === 'ssr' || type === 'ingress' ? '/' :
      type === 'projects' || type === 'dashboard' ? `/api/${type}` : `/__clank/${type === 'write' ? 'mutation' : 'query'}/${type}`;
    const body = type === 'login' ? JSON.stringify({ email: user.email, password: fixture.password }) :
      type === 'list' || type === 'write' ? '{}' : undefined;
    const begin = performance.now(); scheduling.push(begin - due);
    return new Promise(resolve => {
      let settled = false;
      const finish = (code, text = '') => {
        if (settled) return; settled = true;
        latency.push(performance.now() - due); serviceLatency.push(performance.now() - begin);
        status[code] = (status[code] ?? 0) + 1;
        if (!(code >= 200 && code < 300) && errorExamples[code] === undefined) errorExamples[code] = text.slice(0, 300);
        if (code >= 200 && code < 300) {
          try {
            if (type === 'list') { const data = JSON.parse(text); if (data.value.length !== 20 || data.value.some(row => row._ownerId !== user.id)) throw Error('Tenant isolation/list size'); }
            if (type === 'write') { const data = JSON.parse(text); if (data.value._ownerId !== user.id || data.value.count < 1) throw Error('Write ownership/counter'); }
            if (type === 'projects' || type === 'dashboard') { const data = JSON.parse(text); if (data.projects.length !== 3 || data.projects.some(row => !row.id.startsWith(`load-project-${index % users}-`))) throw Error('Project isolation'); }
            if (type === 'ingress' && text !== `load-app-${index % 3}`) throw Error('Incorrect ingress destination');
            valid++;
          } catch (error) { failures[error.message] = (failures[error.message] ?? 0) + 1; }
        }
        resolve();
      };
      const req = request({ hostname: target.hostname, port: target.port, path, method: body ? 'POST' : 'GET', agent,
        // Distinct loopback source addresses give login attempts separate trusted client identities.
        ...(mode === 'login' ? { localAddress: `127.1.${Math.floor(index / 250) % 250}.${index % 250 + 1}` } : {}),
        headers: { cookie: user.cookie, origin: fixture.url,
          ...(type === 'ingress' ? { host: `load-project-${index % 3}-0.apps.example.test` } : {}),
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
          'x-clank-csrf': user.csrf } }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(Error('Oversized response')); else chunks.push(chunk); });
        response.on('end', () => { bytes += size; finish(response.statusCode, Buffer.concat(chunks).toString()); });
        response.on('error', () => finish('response-error'));
      });
      const deadline = setTimeout(() => req.destroy(Error('deadline')), 5000);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', error => finish(error.message === 'deadline' ? 'timeout' : error.code ?? 'request-error'));
      req.end(body);
    });
  }
  while (sent < count) {
    const due = started + (mode === 'burst' ? 0 : sent * interval), remaining = due - performance.now();
    if (remaining > 0) { await pause(Math.min(remaining, 10)); continue; }
    const index = sent++;
    if (inflight.size >= 1000) { dropped++; continue; }
    const promise = send(index, due); inflight.add(promise); promise.finally(() => inflight.delete(promise));
  }
  await Promise.all(inflight);
  await pause(Math.max(0, started + duration * 1000 - performance.now()));
  agent.destroy();
  for (const values of [latency, serviceLatency, scheduling]) values.sort((a, b) => a - b);
  const elapsed = (performance.now() - started) / 1000;
  return { rate, duration, mode, offered: count, completed: latency.length, dropped, valid, status, failures, errorExamples, bytes,
    elapsedSeconds: elapsed, successfulRps: valid / elapsed,
    latencyMs: { p50: percentile(latency, .5), p95: percentile(latency, .95), p99: percentile(latency, .99), max: latency.at(-1) },
    serviceP95Ms: percentile(serviceLatency, .95), generatorScheduleP99Ms: percentile(scheduling, .99),
    acceptable: dropped === 0 && valid === count && percentile(latency, .95) < 500 && percentile(latency, .99) < 1000 };
}

for (let round = 0; round < rounds; round++) {
  // Alternate A/B order to reduce warm-host bias.
  for (const candidate of round % 2 ? [...candidates].reverse() : candidates) {
    console.log(`Starting ${kind} ${candidate.name} round ${round + 1} (${users} tenants)`);
    const fixture = await start(candidate);
    try {
      await load(fixture, 25, 2);
      for (const rate of rates) {
        await fixture.rpc('reset');
        const measurement = await load(fixture, rate, seconds, args.mode ?? 'mixed');
        const metrics = await fixture.rpc('metrics');
        report.samples.push({ candidate: candidate.name, frameworkVersion: fixture.frameworkVersion, round: round + 1, ...measurement, metrics });
        console.log(JSON.stringify({ candidate: candidate.name, round: round + 1, rate, p95: measurement.latencyMs.p95,
          rps: measurement.successfulRps, status: measurement.status, acceptable: measurement.acceptable }));
        await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2));
      }
    } finally { await fixture.close(); }
  }
}
report.finishedAt = new Date().toISOString();
await writeFile(output, JSON.stringify(report, null, 2));
console.log(`Report: ${output}`);
if (args.assert === 'true' && report.samples.some(sample => !sample.acceptable)) process.exitCode = 1;
