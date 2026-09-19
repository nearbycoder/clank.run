import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { request } from 'node:http';
import { request as requestTls, Agent as TlsAgent } from 'node:https';
import { connectStaging } from './staging-client.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')),
);
const users = Number(args.users ?? 1000),
  connections = Number(args.connections ?? users);
const liveLimit = args.liveLimit ? Number(args.liveLimit) : undefined;
const batches = Number(args.batches ?? 20),
  readRate = Number(args.readRate ?? 0);
const connectBatch = Number(args.connectBatch ?? (args.staging ? 10 : 50));
if (![users, connections].every((n) => Number.isInteger(n) && n > 0 && n <= 10000))
  throw Error('Invalid fixture size');
if (
  !Number.isInteger(batches) ||
  batches < 1 ||
  batches > 1800 ||
  (liveLimit !== undefined && (!Number.isInteger(liveLimit) || liveLimit < 1 || liveLimit > 20000))
)
  throw Error('Invalid reliability profile');
if (!Number.isInteger(readRate) || readRate < 0 || readRate > 5000)
  throw Error('Invalid read load');
if (!Number.isInteger(connectBatch) || connectBatch < 1 || connectBatch > 100)
  throw Error('Invalid connection ramp');
const root = await mkdtemp(join(tmpdir(), 'clank-reliability-'));
const config = { root, kind: 'app', users, liveLimit, dist: resolve(args.dist ?? 'dist') };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  protocol: 'clank-load-reliability/1',
  startedAt: new Date().toISOString(),
  node: process.version,
  users,
  connections,
  liveLimit: liveLimit ?? 1000,
  readRate,
  scenarios: [],
};
let current,
  streams = [],
  backgroundTimer;
const background = new Set();
const readErrors = {};
let progress;
const businessAgent = new TlsAgent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 128 });

async function businessFetch(url, options) {
  if (!current.remote) return fetch(url, options);
  return new Promise((resolve, reject) => {
    const req = requestTls(
      url,
      { method: options.method, headers: options.headers, agent: businessAgent },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) req.destroy(Error('Response too large'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString();
          resolve({
            status: response.statusCode,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    const timer = setTimeout(() => req.destroy(Error('Business request deadline exceeded')), 10000);
    req.on('error', (error) => {
      clearTimeout(timer);
      error.message += ` (reused socket: ${req.reusedSocket})`;
      reject(error);
    });
    req.end(options.body);
  });
}

async function boot(resume = false) {
  if (args.staging) {
    const fixture = await connectStaging(args.staging, 'app');
    if (fixture.users.length !== users) throw Error('Staging tenant count mismatch');
    return fixture;
  }
  const child = fork(
    fileURLToPath(new URL('./fixture.mjs', import.meta.url)),
    [JSON.stringify({ ...config, resume })],
    {
      execArgv: ['--expose-gc', '--disable-warning=ExperimentalWarning'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '',
    sequence = 0;
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const pending = new Map();
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('Boot timeout'));
    }, 120000);
    child.on('message', (message) => {
      if (message.ready) {
        clearTimeout(timer);
        resolve(message);
      } else if (pending.has(message.id)) {
        const done = pending.get(message.id);
        pending.delete(message.id);
        done(message);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(Error(`Fixture exit ${code}: ${stderr}`));
    });
  });
  return {
    ...ready,
    child,
    rpc(command) {
      return new Promise((resolve, reject) => {
        const id = ++sequence,
          timer = setTimeout(() => {
            pending.delete(id);
            reject(Error('IPC timeout'));
          }, 15000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          message.error ? reject(Error(message.error)) : resolve(message.result);
        });
        child.send({ id, command });
      });
    },
  };
}

async function call(index, mutation = false, key) {
  const user = current.users[index];
  const response = await businessFetch(
    `${current.url}/__clank/${mutation ? 'mutation/write' : 'query/list'}`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: {
        ...current.headers,
        'content-type': 'application/json',
        origin: current.url,
        cookie: user.cookie,
        'x-clank-csrf': user.csrf,
        ...(key ? { 'x-clank-mutation-key': key, 'x-clank-offline-user': user.id } : {}),
      },
      body: '{}',
    },
  );
  assert.equal(
    response.status,
    200,
    `Business request: ${response.status}${response.status !== 200 ? ` ${await response.text()}` : ''}`,
  );
  const data = await response.json();
  const rows = Array.isArray(data.value) ? data.value : [data.value];
  assert.ok(
    rows.every((row) => row._ownerId === user.id),
    'Tenant isolation',
  );
  return data.value;
}

async function openStream(index) {
  const user = current.users[index % users],
    target = new URL(current.url);
  const stream = { index: index % users, user, frames: 0, closed: false, value: null };
  streams.push(stream);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.req.destroy();
      reject(Error('Live connection timeout'));
    }, 15000);
    stream.req = (current.remote ? requestTls : request)(
      {
        hostname: target.hostname,
        port: target.port || undefined,
        path: (current.remote ? target.pathname : '') + '/__clank/live/list?args=%7B%7D',
        agent: false,
        headers: { ...current.headers, cookie: user.cookie },
      },
      (response) => {
        stream.status = response.statusCode;
        if (response.statusCode !== 200) {
          response.resume();
          clearTimeout(timer);
          resolve(stream);
          return;
        }
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          buffer += chunk;
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame.match(/^data: (.+)$/m);
            if (data) {
              stream.value = JSON.parse(data[1]).value;
              stream.frames++;
              stream.lastAt = performance.now();
              if (
                !Array.isArray(stream.value) ||
                stream.value.some((row) => row._ownerId !== user.id)
              )
                stream.invalid = true;
              clearTimeout(timer);
              resolve(stream);
            }
          }
        });
        response.on('close', () => {
          stream.closed = true;
        });
        response.on('error', () => {
          stream.closed = true;
        });
      },
    );
    stream.req.on('error', (error) => {
      clearTimeout(timer);
      if (!stream.frames) reject(error);
      stream.closed = true;
    });
    stream.req.end();
  });
}

async function until(predicate, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline) throw Error('Recovery deadline exceeded');
    await pause(10);
  }
}

try {
  current = await boot();
  report.frameworkVersion = current.frameworkVersion;
  if (current.remote) {
    report.serverNode = current.node;
    report.serverProfile = current.profile ?? null;
    report.topology =
      'External generator through Railway TLS and authenticated streaming proxy; persistent-volume fixture';
  }
  await current.rpc('reset');
  const empty = await current.rpc('metrics');
  const start = performance.now();
  for (let i = 0; i < connections; i += connectBatch) {
    await Promise.all(
      Array.from({ length: Math.min(connectBatch, connections - i) }, (_, n) => openStream(i + n)),
    );
    if ((i + connectBatch) % 500 === 0)
      console.log(`Live ramp: ${Math.min(connections, i + connectBatch)} connections`);
  }
  const accepted = streams.filter((stream) => stream.status === 200).length;
  assert.equal(accepted, Math.min(connections, liveLimit ?? 1000));
  assert.ok(streams.every((stream) => stream.status === 200 || stream.status === 503));
  if (accepted === (liveLimit ?? 1000)) {
    const extra = await openStream(connections);
    assert.equal(extra.status, 503);
  }
  await pause(5000);
  report.scenarios.push({
    name: 'Live connection admission and idle residency',
    accepted,
    attempted: streams.length,
    rejected: streams.filter((stream) => stream.status !== 200).length,
    connectMs: performance.now() - start,
    emptyRss: empty.rss,
    metrics: await current.rpc('metrics'),
  });
  console.log(`Live streams: ${accepted} accepted; limits enforced`);

  // Hold all connections open while applying owned writes and checking delivery to every matching tab.
  const delivery = [],
    writeLatency = [],
    checkpoints = [];
  const readTimes = [];
  let readSequence = 0,
    readFailures = 0,
    readDropped = 0;
  if (current.remote) {
    await Promise.all(Array.from({ length: 100 }, (_, index) => call(index % users)));
    console.log('Business connection pool warmed');
  }
  const readStarted = performance.now();
  if (readRate)
    backgroundTimer = setInterval(() => {
      const target = Math.floor(((performance.now() - readStarted) * readRate) / 1000);
      while (readSequence < target) {
        const sequence = readSequence++,
          due = readStarted + (sequence * 1000) / readRate;
        if (background.size >= 200) {
          readDropped++;
          continue;
        }
        const promise = call(sequence % users).then(
          () => readTimes.push(performance.now() - due),
          (error) => {
            readFailures++;
            readErrors[error.message] = (readErrors[error.message] ?? 0) + 1;
          },
        );
        background.add(promise);
        promise.finally(() => background.delete(promise));
      }
    }, 20);
  progress = () => ({
    completedReads: readTimes.length,
    readFailures,
    readDropped,
    readErrors,
    writes: delivery.length,
    checkpoints,
    prematureClosures: streams.filter((stream) => stream.status === 200 && stream.closed).length,
  });
  for (let batch = 0; batch < batches; batch++) {
    const begin = performance.now();
    await Promise.all(
      Array.from({ length: Math.min(20, users, accepted) }, async (_, offset) => {
        const index = (batch * 20 + offset) % Math.min(users, accepted),
          before = performance.now();
        const result = await call(index, true);
        writeLatency.push(performance.now() - before);
        const targets = streams.filter((stream) => stream.status === 200 && stream.index === index);
        await until(() =>
          targets.every((stream) =>
            stream.value?.some((row) => row._id === result._id && row.count === result.count),
          ),
        );
        delivery.push(Math.max(...targets.map((stream) => stream.lastAt)) - before);
      }),
    );
    assert.ok(
      streams.every((stream) => !stream.invalid),
      'Live tenant isolation',
    );
    await pause(Math.max(0, begin + 1000 - performance.now()));
    if ((batch + 1) % 60 === 0) {
      checkpoints.push({ elapsedSeconds: batch + 1, metrics: await current.rpc('metrics') });
      console.log(
        `Live soak: ${batch + 1} seconds, ${delivery.length} writes, ${readTimes.length} reads, ${readFailures} failures, ${readDropped} dropped`,
      );
      report.progress = progress();
      await writeFile(
        resolve(args.output ?? '/tmp/clank-load-reliability.json'),
        JSON.stringify(report, null, 2),
      );
    }
  }
  delivery.sort((a, b) => a - b);
  writeLatency.sort((a, b) => a - b);
  clearInterval(backgroundTimer);
  await Promise.all(background);
  readTimes.sort((a, b) => a - b);
  report.scenarios.push({
    name: 'Live update soak',
    seconds: batches,
    writes: delivery.length,
    deliveryP95Ms: delivery[Math.ceil(delivery.length * 0.95) - 1],
    writeP95Ms: writeLatency[Math.ceil(writeLatency.length * 0.95) - 1],
    prematureClosures: streams.filter((stream) => stream.status === 200 && stream.closed).length,
    concurrentReads: {
      targetRps: readRate,
      completed: readTimes.length,
      failures: readFailures,
      dropped: readDropped,
      p95Ms: readTimes[Math.ceil(readTimes.length * 0.95) - 1] ?? null,
    },
    checkpoints,
    metrics: await current.rpc('metrics'),
  });
  assert.equal(readFailures, 0);
  assert.equal(readDropped, 0);
  assert.equal(report.scenarios.at(-1).prematureClosures, 0);
  console.log('Live delivery and tenant isolation passed');

  const index = Math.min(2, users - 1),
    before = (await call(index))[0].count;
  const retryKey = `${Date.now()}.${randomUUID()}`;
  await Promise.all(Array.from({ length: 50 }, () => call(index, true, retryKey)));
  assert.equal((await call(index))[0].count, before + 1);
  report.scenarios.push({ name: '50 simultaneous retries commit exactly once', passed: true });

  // Send unique idempotent writes, kill only this disposable child, then replay all ambiguous outcomes.
  for (const stream of streams) stream.req.destroy();
  streams = [];
  await pause(1000);
  await current.rpc('reset');
  report.scenarios.push({
    name: 'Disconnected live subscriptions released',
    metrics: await current.rpc('metrics'),
  });
  assert.ok(report.scenarios.at(-1).metrics.queries.every((query) => query.subscriptions === 0));
  const crashBefore = (await call(index))[0].count;
  const crashKeys = Array.from({ length: 50 }, () => `${Date.now()}.${randomUUID()}`);
  const pendingWrites = crashKeys.map((key) => call(index, true, key));
  const outcomes = Promise.allSettled(pendingWrites);
  await pause(10);
  let recoveryAt;
  if (current.remote) {
    recoveryAt = performance.now();
    await current.rpc('restart');
  } else {
    const exited = once(current.child, 'exit');
    current.child.kill('SIGKILL');
    await exited;
  }
  const acknowledged = (await outcomes).filter((result) => result.status === 'fulfilled').length;
  recoveryAt ??= performance.now();
  current = await boot(true);
  await Promise.all(crashKeys.map((key) => call(index, true, key)));
  assert.equal((await call(index))[0].count, crashBefore + 50);
  report.scenarios.push({
    name: 'Crash, restart, and ambiguous-write replay',
    acknowledgedBeforeCrash: acknowledged,
    replayed: 50,
    committed: 50,
    recoveryMs: performance.now() - recoveryAt,
    passed: true,
  });

  const revoked = await openStream(0);
  assert.equal(revoked.status, 200);
  await current.rpc('revoke');
  await until(() => revoked.closed);
  const response = await businessFetch(`${current.url}/__clank/query/list`, {
    method: 'POST',
    headers: {
      ...current.headers,
      cookie: current.users[0].cookie,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(response.status, 401);
  report.scenarios.push({
    name: 'Session revocation closes live stream and rejects reads',
    passed: true,
  });
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.failure = error.stack;
  if (progress) report.progress = progress();
  process.exitCode = 1;
} finally {
  clearInterval(backgroundTimer);
  await Promise.allSettled(background);
  for (const stream of streams) stream.req.destroy();
  businessAgent.destroy();
  if (current?.child?.connected) {
    try {
      await current.rpc('close');
    } catch {
      current.child.kill('SIGKILL');
    }
  }
  if (current?.child?.exitCode === null)
    await Promise.race([
      once(current.child, 'exit'),
      pause(2000).then(() => current.child.kill('SIGKILL')),
    ]);
  await rm(root, { recursive: true, force: true });
  const output = resolve(args.output ?? '/tmp/clank-load-reliability.json');
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(`Reliability ${report.ok ? 'passed' : 'FAILED'}: ${output}`);
}
