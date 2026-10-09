import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { reservePlatformTestPorts } from './fixtures/platform-test-ports.mjs';
import { fixture } from './fixtures/platform-environment-fixture.mjs';

test('independent platform fixtures cannot reserve the same application ports even with identical random selection', { timeout: 30000 }, async t => {
  const source = `
    import { fixture } from ${JSON.stringify(new URL('./fixtures/platform-environment-fixture.mjs', import.meta.url).href)};
    Math.random = () => 0;
    const cleanup = [], f = await fixture({ after(fn) { cleanup.push(fn); } });
    process.on('message', async message => {
      if (message !== 'close') return;
      try { for (const fn of cleanup) await fn(); process.exit(0); }
      catch (error) { console.error(error.stack); process.exit(1); }
    });
    process.send({ start: f.options.appPortStart, end: f.options.appPortEnd });
  `;
  const children = Array.from({ length: 3 }, () => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
    const closed = new Promise(resolve => child.once('close', code => resolve(code)));
    const ready = new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
      child.once('close', code => reject(new Error(`Owned fixture child closed ${code}: ${stderr}`)));
    });
    return { child, ready, closed, diagnostic: () => stderr };
  });
  t.after(async () => {
    await Promise.allSettled(children.map(entry => entry.ready));
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.send('close');
    for (const entry of children) assert.equal(await entry.closed, 0, entry.diagnostic());
  });
  const ranges = (await Promise.all(children.map(child => child.ready))).sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index++) assert.ok(ranges[index - 1].end < ranges[index].start, 'Distinct live fixtures must own disjoint port blocks.');
});

test('application fixture allocation skips an existing socket without stopping its occupant', { timeout: 15000 }, async t => {
  const first = await reservePlatformTestPorts(0);
  const server = createServer(socket => socket.end('existing occupant'));
  let next;
  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await first.release(); await next?.release();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(first.start, '127.0.0.1', resolve); });
  await first.release();
  next = await reservePlatformTestPorts((first.start - 10000) / 31);
  assert.notEqual(next.start, first.start);
  const body = await new Promise((resolve, reject) => {
    const socket = connect(first.start, '127.0.0.1'); let value = '';
    socket.on('data', bytes => { value += bytes; }); socket.once('error', reject); socket.once('end', () => resolve(value));
  });
  assert.equal(body, 'existing occupant');
});

test('unverified fixture cleanup preserves its root and port ownership', { timeout: 15000 }, async () => {
  const cleanup = [], f = await fixture({ after(fn) { cleanup.push(fn); } });
  // This synthetic marker has no runtime process; only its creator removes it
  // after proving that ordinary fixture teardown refuses to erase the fence.
  const marker = join(f.root, 'platform/runtime-guardians/owned-synthetic-fence.json');
  await writeFile(marker, '{}');
  try {
    await assert.rejects(cleanup[0](), /Unverified fixture runtime fences/);
    assert.equal((await stat(f.root)).isDirectory(), true);
    assert.equal(await readFile(marker, 'utf8'), '{}');
    const next = await reservePlatformTestPorts((f.options.appPortStart - 10000) / 31);
    try { assert.notEqual(next.start, f.options.appPortStart, 'Unverified shutdown must retain the original port block lease.'); }
    finally { await next.release(); }
  } finally {
    try { assert.equal(await readFile(marker, 'utf8'), '{}'); await rm(marker); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await cleanup[0]();
  }
});
