import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const blockSize = 31, blockCount = 645;
const owner = process.getuid?.() ?? createHash('sha256').update(userInfo().username).digest('hex').slice(0, 12);
const directory = join(tmpdir(), `clank-test-app-port-leases-${owner}`);

// A socket probe alone cannot reserve ports between independent test workers.
// Keep an atomic, aligned block lease through verified fixture shutdown. Use
// ports below the usual Linux/Windows outbound ephemeral ranges as well.
export async function reservePlatformTestPorts(firstBlock = Math.floor(Math.random() * blockCount)) {
  if (!Number.isInteger(firstBlock) || firstBlock < 0 || firstBlock >= blockCount) throw new TypeError('Invalid test port block.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < blockCount; attempt++) {
    const block = (firstBlock + attempt) % blockCount, lease = join(directory, `block-${block}`);
    try { await mkdir(lease, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    const start = 10000 + block * blockSize, end = start + blockSize - 1, probes = [];
    let accepted = false;
    try {
      for (let port = start; port <= end; port++) {
        const probe = createServer(); probes.push(probe);
        await new Promise((resolve, reject) => {
          probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve);
        });
      }
      accepted = true;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    finally {
      await Promise.all(probes.filter(probe => probe.listening).map(probe => new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))));
      if (!accepted) await rm(lease, { recursive: true });
    }
    if (accepted) {
      let released = false;
      return { start, end, async release() {
        if (!released) { await rm(lease, { recursive: true }); released = true; }
      } };
    }
  }
  throw new Error('No owned application test port block is available.');
}
