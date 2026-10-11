import fs from 'node:fs';

const [mode, statePath] = process.argv.slice(2);
if (!['ordinary', 'deadline', 'stdout-overflow', 'stderr-overflow', 'combined-overflow'].includes(mode) || !statePath) {
  throw new Error('Expected an owned Docker-client fixture mode and state path.');
}
fs.writeFileSync(statePath + '.tmp', JSON.stringify({ pid: process.pid, mode }), { mode: 0o600 });
fs.renameSync(statePath + '.tmp', statePath);
if (mode === 'ordinary') {
  process.stdout.write('ordinary output\n');
  process.stderr.write('ordinary diagnostic\n');
} else {
  // Keep the actual native child alive until the client's deadline/output bound.
  setInterval(() => {}, 1000);
  if (mode === 'stdout-overflow') process.stdout.write('x'.repeat(4096));
  if (mode === 'stderr-overflow') process.stderr.write('x'.repeat(4096));
  if (mode === 'combined-overflow') {
    process.stdout.write('x'.repeat(768));
    process.stderr.write('x'.repeat(768));
  }
}
