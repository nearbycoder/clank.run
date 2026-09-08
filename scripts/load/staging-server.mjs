// Opt-in, token-protected synthetic staging fixture. Never deploy beside customer data.
import { createServer, request as forward, Agent } from 'node:http';
import { fork } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const token = process.env.CLANK_CAPACITY_TOKEN;
if (
  process.env.CLANK_CAPACITY_ENABLED !== 'synthetic-only' ||
  !/^[a-f0-9]{64}$/.test(token ?? '')
) {
  throw Error('Explicit synthetic-only staging configuration and a 256-bit token are required');
}
const root = resolve(process.env.CLANK_CAPACITY_ROOT ?? '/data/clank-capacity');
if (root === '/data' || !root.endsWith('/clank-capacity'))
  throw Error('Dedicated capacity directory required');
await mkdir(root, { recursive: true, mode: 0o700 });
const version = randomUUID(),
  entries = new Map();
let serial = 0;
const businessAgent = new Agent({
  keepAlive: true,
  maxSockets: 128,
  maxTotalSockets: 256,
  maxFreeSockets: 128,
});
const liveAgent = new Agent({
  keepAlive: true,
  maxSockets: 6000,
  maxTotalSockets: 6000,
  maxFreeSockets: 0,
});
const socketCount = (collection) =>
  Object.values(collection).reduce((sum, values) => sum + values.length, 0);
const configs = {
  app: {
    kind: 'app',
    users: 5000,
    liveLimit: 6000,
    authConcurrency: 8,
    authQueue: 32,
    dist: 'dist',
  },
  platform: { kind: 'platform', users: 100, metricBuckets: 1440, authConcurrency: 8, dist: 'dist' },
  baseline: { kind: 'platform', users: 100, metricBuckets: 1440, dist: 'baseline/dist' },
};
async function boot(name) {
  const config = { ...configs[name], root: join(root, name), dist: resolve(configs[name].dist) };
  try {
    await access(join(config.root, 'sessions.json'));
    config.resume = true;
  } catch {}
  const child = fork(new URL('./fixture.mjs', import.meta.url), [JSON.stringify(config)], {
    execArgv: ['--expose-gc', '--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const pending = new Map();
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('Fixture setup deadline'));
    }, 180000);
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
      reject(Error('Fixture exited ' + code));
    });
  });
  const entry = {
    child,
    ready,
    rpc(command) {
      return new Promise((resolve, reject) => {
        const id = ++serial,
          timer = setTimeout(() => {
            pending.delete(id);
            reject(Error('IPC deadline'));
          }, 20000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          message.error ? reject(Error(message.error)) : resolve(message.result);
        });
        child.send({ id, command });
      });
    },
  };
  entries.set(name, entry);
  return entry;
}
for (const name of Object.keys(configs)) await boot(name);
let stopping = false;
const server = createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(stopping ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: !stopping }));
    return;
  }
  const supplied = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, '')),
    expected = Buffer.from(token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    res.writeHead(401);
    res.end();
    return;
  }
  const path = new URL(req.url, 'http://fixture').pathname.split('/'),
    name = path[2],
    entry = entries.get(name);
  if (path[1] === 'control' && entry) {
    try {
      const command = path[3];
      let result;
      if (command === 'ready' && req.method === 'GET')
        result = {
          ...entry.ready,
          protocol: 'clank-capacity-staging/1',
          version,
          node: process.version,
          profile: { ...configs[name], threadPoolSize: process.env.UV_THREADPOOL_SIZE },
        };
      else if (req.method === 'POST' && ['metrics', 'reset', 'revoke'].includes(command)) {
        result = await entry.rpc(command);
        if (command === 'metrics')
          result.proxy = {
            rss: process.memoryUsage().rss,
            businessSockets: socketCount(businessAgent.sockets),
            freeBusinessSockets: socketCount(businessAgent.freeSockets),
            liveSockets: socketCount(liveAgent.sockets),
            portRange: (await readFile('/proc/sys/net/ipv4/ip_local_port_range', 'utf8')).trim(),
          };
      } else if (req.method === 'POST' && command === 'restart') {
        const exited = once(entry.child, 'exit');
        entry.child.kill('SIGKILL');
        await exited;
        await boot(name);
        result = { restarted: true };
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Synthetic control operation failed', error);
      res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'Synthetic control operation failed' }));
    }
    return;
  }
  const fixture = entries.get(path[1]);
  if (!fixture || stopping) {
    res.writeHead(404);
    res.end();
    return;
  }
  const target = new URL(fixture.ready.url),
    headers = { ...req.headers, host: target.host, origin: target.origin };
  delete headers.authorization;
  delete headers['x-forwarded-for'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  // Synthetic identities are accepted only behind the staging token, never by production auth.
  const identity =
    headers['x-clank-load-client'] === undefined
      ? undefined
      : Number(headers['x-clank-load-client']);
  delete headers['x-clank-load-client'];
  const localAddress =
    Number.isInteger(identity) && identity >= 0
      ? `127.2.${Math.floor(identity / 250) % 250}.${(identity % 250) + 1}`
      : undefined;
  let upstreamResponse;
  const upstream = forward(
    {
      hostname: target.hostname,
      port: target.port,
      path: req.url.slice(path[1].length + 1) || '/',
      method: req.method,
      headers,
      ...(localAddress ? { localAddress } : {}),
      agent: req.url.includes('/__clank/live/') ? liveAgent : businessAgent,
    },
    (reply) => {
      upstreamResponse = reply;
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    console.error('Synthetic upstream error', error.code ?? error.name);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  res.on('close', () => {
    if (!upstreamResponse?.complete) upstream.destroy();
  });
  req.pipe(upstream);
});
server.requestTimeout = 15000;
server.keepAliveTimeout = 60000;
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () =>
  console.log('Synthetic staging ready'),
);
async function close() {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  businessAgent.destroy();
  liveAgent.destroy();
  await Promise.allSettled([...entries.values()].map((entry) => entry.rpc('close')));
  for (const entry of entries.values()) entry.child.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGTERM', () => void close());
// A forgotten fixture cannot remain an active, authenticated test endpoint indefinitely.
setTimeout(() => void close(), 2 * 60 * 60 * 1000).unref();
