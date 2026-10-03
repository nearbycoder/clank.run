// A disposable test daemon: applications deliberately outlive their client process.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function fakeDockerDaemon(root, args = process.argv.slice(2)) {
  const directory = join(root, 'containers');
  await mkdir(directory, { recursive: true });
  const operation = args[0];
  const containerFile = id => join(directory, `${id}.json`);
  const lookup = async target => {
    for (const filename of await readdir(directory)) {
      const record = JSON.parse(await readFile(join(directory, filename), 'utf8'));
      if (record.id === target || record.name === target) return record;
    }
    return null;
  };
  if (operation === 'create') {
    const name = args[args.indexOf('--name') + 1];
    const id = createHash('sha256').update(name).digest('hex');
    await writeFile(containerFile(id), JSON.stringify({ id, name, args,
      environment: JSON.parse(Buffer.from(process.env.CLANK_RUNTIME_ENV_B64, 'base64url').toString('utf8')) }), { mode: 0o600 });
    console.log(id);
    return;
  }
  const target = args.at(-1), record = await lookup(target);
  if (operation === 'rm' || operation === 'container') {
    if (await readFile(join(root, 'fail-cleanup'), 'utf8').then(() => true, () => false)) {
      console.error('Cannot connect to Docker daemon');
      process.exitCode = 1;
      return;
    }
    if (!record) {
      console.error(`Error: No such container: ${target}`);
      process.exitCode = 1;
      return;
    }
    if (operation === 'rm') {
      if (record.pid) try { process.kill(-record.pid, 'SIGKILL'); } catch {}
      await rm(containerFile(record.id));
      return;
    }
    console.log(JSON.stringify([{ Id: record.id, State: { Running: true } }]));
    return;
  }
  if (operation !== 'start' || !record) throw new Error('Unsupported fake Docker operation');
  const mount = suffix => record.args.find(value => value.endsWith(suffix)).slice(0, -suffix.length);
  const applicationRoot = mount(':/app:ro'), dataRoot = mount(':/data:rw');
  const environment = Object.fromEntries(Object.entries(record.environment).map(([key, value]) =>
    [key, typeof value === 'string' && value.startsWith('/data/') ? join(dataRoot, value.slice(6)) : value]));
  const child = spawn(process.execPath, [record.args.at(-1)], {
    cwd: applicationRoot, detached: true, env: { ...process.env, ...environment, HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  child.unref();
  record.pid = child.pid;
  await writeFile(containerFile(record.id), JSON.stringify(record), { mode: 0o600 });
  // Killing this attachment must not kill the daemon-owned application.
  setInterval(() => {}, 1000);
}
