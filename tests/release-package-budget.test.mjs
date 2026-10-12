import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { assertReleasePackageBudget } from '../scripts/release-package-budget.mjs';

const manifest = JSON.parse(await readFile(new URL('../scripts/release-package-files.json', import.meta.url), 'utf8'));
const initialMain = JSON.parse(await readFile(new URL('./fixtures/release-package-main422.json', import.meta.url), 'utf8'));
const previousComposition = JSON.parse(await readFile(new URL('./fixtures/release-package-composition449.json', import.meta.url), 'utf8'));
const pack = (paths = manifest) => ({ entryCount: paths.length, unpackedSize: paths.length,
  files: paths.map(path => ({ path, size: 1, mode: 420 })) });
const copy = value => structuredClone(value);

// The fixed initial-main fixture is never read by the production audit. These
// exact reviewed additions describe the prior composition. The wire and source
// entry modules are the separately reviewed private additions to that inventory.
const featureOutputs = ['customer-status', 'offline-attachments', 'organization-security-policy',
  'platform-incidents', 'platform-point-in-time', 'platform-project-costs', 'platform-slo',
  'platform-status-pages', 'platform-temporary-access', 'project-costs', 'project-incidents',
  'project-slo', 'temporary-access'].flatMap(name => [`dist/${name}.d.ts`, `dist/${name}.js`]);
featureOutputs.push('dist/point-in-time-source.js');
const previousWire = [...previousComposition, 'dist/provider-source-worker-wire.js'].sort();

test('current inventory adds only the reviewed private wire and entry modules to prior inventories', () => {
  assert.equal(initialMain.length, 422);
  assert.deepEqual(initialMain, [...new Set(initialMain)].sort());
  assert.ok(featureOutputs.every(path => !initialMain.includes(path)));
  assert.equal(previousComposition.length, 449);
  assert.deepEqual(previousComposition, [...initialMain, ...featureOutputs].sort());
  assert.deepEqual(previousComposition, [...new Set(previousComposition)].sort());
  assert.equal(previousWire.length, 450);
  assert.equal(manifest.length, 451);
  assert.deepEqual(manifest, [...previousWire, 'dist/provider-source-entry.js'].sort());
  assert.deepEqual(manifest, [...new Set(manifest)].sort());
  assert.ok(!manifest.some(path => path.includes('release-package-')));
  const input = pack(), before = copy(input);
  Object.freeze(manifest);
  Object.freeze(initialMain);
  Object.freeze(previousComposition);
  const result = assertReleasePackageBudget(input, manifest);
  assert.deepEqual(result, { files: 451, bytes: 451 });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(input, before);
});

test('prior 422/449/450 and current 451 inventories accept only their own exact manifests', () => {
  assert.deepEqual(assertReleasePackageBudget(pack(initialMain), initialMain), {files:422, bytes:422});
  assert.deepEqual(assertReleasePackageBudget(pack(previousComposition), previousComposition), {files:449, bytes:449});
  assert.deepEqual(assertReleasePackageBudget(pack(previousWire), previousWire), {files:450, bytes:450});
  assert.deepEqual(assertReleasePackageBudget(pack(), manifest), {files:451, bytes:451});
  assert.throws(() => assertReleasePackageBudget(pack(previousWire), manifest), /count/);
  assert.throws(() => assertReleasePackageBudget(pack(), previousWire), /count/);
  assert.throws(() => assertReleasePackageBudget(pack(previousComposition), manifest), /count/);
  assert.throws(() => assertReleasePackageBudget(pack(), previousComposition), /count/);
  assert.throws(() => assertReleasePackageBudget(pack(), initialMain), /count/);
  assert.throws(() => assertReleasePackageBudget(pack(initialMain), manifest), /count/);
  const next = [...manifest, 'dist/next-reviewed-feature.js'].sort();
  assert.throws(() => assertReleasePackageBudget(pack(next), manifest), /count/);
  // A matching hypothetical data model does not authorize another shipped path.
  assert.equal(assertReleasePackageBudget(pack(next), next).files, 452);
});

test('equal-count swapped paths cannot spend a removed path as a spare slot in every inventory', () => {
  for (const paths of [initialMain, previousComposition, previousWire, manifest]) {
    const input = pack(paths);
    input.files.find(file => file.path === 'dist/application-performance.js').path = 'dist/unreviewed-future.js';
    assert.throws(() => assertReleasePackageBudget(input, paths), /paths differ/);
  }
});

test('missing paths are refused even when reported count and bytes agree', () => {
  for (const paths of [initialMain, previousComposition, previousWire, manifest]) {
    const input = pack(paths.slice(1));
    assert.throws(() => assertReleasePackageBudget(input, paths), /count/);
  }
});

test('duplicate and malformed paths are refused in both manifest and packed entries', () => {
  assert.throws(() => assertReleasePackageBudget(pack(), [...manifest, manifest[0]]), /manifest/);
  assert.throws(() => assertReleasePackageBudget(pack(), [...manifest].reverse()), /manifest/);
  for (const bad of ['', '/absolute', '../escape', 'dist/../escape', 'dist//escape', 'dist\\escape',
    'dist/./escape', 'C:/escape', 'dist/a\u0000b', 'dist/a\nb', null, 1]) {
    assert.throws(() => assertReleasePackageBudget(pack(), [bad]), /manifest/);
    const input = pack(); input.files[0].path = bad;
    assert.throws(() => assertReleasePackageBudget(input, manifest), /canonical paths/);
  }
  const input = pack(); input.files[0].path = input.files[1].path;
  assert.throws(() => assertReleasePackageBudget(input, manifest), /unique canonical/);
});

test('missing or malformed manifests cannot become optional', () => {
  for (const bad of [undefined, null, {}, '', [], [null], [1], new Array(manifest.length)]) {
    assert.throws(() => assertReleasePackageBudget(pack(), bad), /manifest/);
  }
});

test('malformed pack and inconsistent entry counts are refused', () => {
  for (const bad of [undefined, null, [], {}, {files:null}, {files:{}}]) {
    assert.throws(() => assertReleasePackageBudget(bad, manifest), /count/);
  }
  for (const count of [undefined, null, String(manifest.length), -1, 0, manifest.length - 1, manifest.length + 1, manifest.length + 0.5, NaN, Infinity, 2 ** 53]) {
    const input = pack(); input.entryCount = count;
    assert.throws(() => assertReleasePackageBudget(input, manifest), /count/);
  }
});

test('noninteger, negative and missing totals or member sizes are refused', () => {
  for (const value of [undefined, null, '1', -1, 1.5, NaN, Infinity, 2 ** 53]) {
    const total = pack(); total.unpackedSize = value;
    assert.throws(() => assertReleasePackageBudget(total, manifest), /safe integer/);
    const member = pack(); member.files[0].size = value;
    assert.throws(() => assertReleasePackageBudget(member, manifest), /safe sizes/);
  }
  for (const bad of [null, [], 1, 'path']) {
    const input = pack(); input.files[0] = bad;
    assert.throws(() => assertReleasePackageBudget(input, manifest), /Packed files/);
  }
});

test('unpackedSize must equal safe sum of actual member sizes', () => {
  for (const adjustment of [-1, 1]) {
    const input = pack(); input.unpackedSize += adjustment;
    assert.throws(() => assertReleasePackageBudget(input, manifest), /sum/);
  }
  const overflow = pack(); overflow.files[0].size = Number.MAX_SAFE_INTEGER;
  assert.throws(() => assertReleasePackageBudget(overflow, manifest), /safe integer range/);
});

test('fixed 8 MiB limit is inclusive and cannot be overridden by a caller', () => {
  const input = pack(); input.files[0].size += 8 * 1024 * 1024 - input.unpackedSize;
  input.unpackedSize = 8 * 1024 * 1024;
  assert.equal(assertReleasePackageBudget(input, manifest).bytes, 8 * 1024 * 1024);
  input.files[0].size++; input.unpackedSize++;
  assert.throws(() => assertReleasePackageBudget(input, manifest, {maxBytes:Infinity}), /8 MiB/);
});

test('a zero-byte file is legitimate when its exact path and total agree', () => {
  const input = pack(); input.files[0].size = 0; input.unpackedSize--;
  assert.equal(assertReleasePackageBudget(input, manifest).bytes, 450);
});

test('actual audit integration requires readable valid manifest before exposing packed paths', async () => {
  const source = await readFile(new URL('../scripts/security-audit.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('let files = [];'), end = source.indexOf('\nconst secretPatterns =', start);
  assert.ok(start > 0 && end > start);
  // Execute only the real audit's inventory boundary. Full native audit/pack is
  // a separate release check; this fixture neither shells out nor fakes a pass.
  const invoke = async read => {
    const failures = [], successes = [], result = {...pack(), name:'@clank.run/framework', version:'0.24.0'};
    const value = await runInNewContext(`(async()=>{${source.slice(start,end)};return files.length;})()`, {
      read, assertReleasePackageBudget, packResult:result,
      packageJson:{name:result.name,version:result.version}, fail:x=>failures.push(x), pass:x=>successes.push(x),
    });
    return {value, failures, successes};
  };
  const valid = await invoke(async path => {assert.equal(path, 'scripts/release-package-files.json'); return JSON.stringify(manifest);});
  assert.equal(valid.value, 451); assert.equal(valid.failures.length, 0); assert.equal(valid.successes.length, 1);
  for (const read of [async()=>{throw new Error('ENOENT');}, async()=>'{', async()=>'null', async()=>JSON.stringify([...manifest,'dist/optional.js'])]) {
    const result = await invoke(read);
    assert.equal(result.value, 0); assert.equal(result.successes.length, 0);
    assert.ok(result.failures.some(failure=>failure.startsWith('Release package budget validation failed:')));
  }
});
