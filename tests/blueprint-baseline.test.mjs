import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatedBaseline, readGeneratedBaseline } from '../scripts/blueprint-regeneration.mjs';

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'clank-baseline-read-'));
  await fs.mkdir(join(root, '.clank'));
  const path = join(root, '.clank/generated-baseline.json');
  await fs.writeFile(path, generatedBaseline([{ path: 'src/app.ts', contents: 'original' }]));
  return { root, path };
}

test('generated baselines accept regular files and reject final or parent symlinks', async () => {
  const { root, path } = await fixture();
  try {
    assert.deepEqual(await readGeneratedBaseline(root), { 'src/app.ts': 'original' });
    await fs.rename(path, join(root, 'outside.json'));
    await fs.symlink(join(root, 'outside.json'), path);
    await assert.rejects(readGeneratedBaseline(root), /symbolic link|bounded regular file/);
    await fs.rm(join(root, '.clank'), { recursive: true });
    await fs.mkdir(join(root, 'other'));
    await fs.symlink(join(root, 'other'), join(root, '.clank'), 'dir');
    await assert.rejects(readGeneratedBaseline(root), /parent must be a regular directory/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('baseline reads stay bounded when the opened file grows after its size check', async t => {
  const { root, path } = await fixture(), originalOpen = fs.open;
  let requested = 0, modified = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === path) {
      const stat = handle.stat.bind(handle), read = handle.read.bind(handle);
      handle.stat = async (...statArgs) => { const result = await stat(...statArgs); if (!modified) {
        modified = true; await fs.truncate(path, 16 * 1024 * 1024 + 1);
      } return result; };
      handle.read = async (...readArgs) => { requested += readArgs[2]; return read(...readArgs); };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(readGeneratedBaseline(root), /bounded regular file/);
    assert.equal(modified, true);
    assert.ok(requested <= 16 * 1024 * 1024 + 1, 'the read must not consume beyond the bounded sentinel byte');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); }
});

test('baseline inode replacement during an opened-handle read is rejected', async t => {
  const { root, path } = await fixture(), originalOpen = fs.open;
  let replaced = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === path) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!replaced) {
          replaced = true; await fs.rename(path, join(root, 'old.json'));
          await fs.writeFile(path, generatedBaseline([{ path: 'src/app.ts', contents: 'replacement' }]));
        }
        return result;
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(readGeneratedBaseline(root), /changed while being read/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); }
});
