import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../scripts/compiler.mjs';

test('compiler executes erasable constructors, TSX and module rewrites on each supported Node runtime', async () => {
  const output = compile(`class Value { declare readonly amount: number; constructor(amount: number) { this.amount = amount; } }\nexport const result = new Value(7).amount;`, { filename: 'value.ts', sourceMap: false });
  assert.equal((await import(`data:text/javascript,${encodeURIComponent(output)}`)).result, 7);
  assert.doesNotMatch(output, /sourceURL|sourceMappingURL/);
  const mapped = compile('export const value: number = 3;\nthrow new Error("mapped");', { filename: 'mapped.ts' });
  const encoded = mapped.match(/sourceMappingURL=data:application\/json[^,]*,([^\s]+)/)?.[1];
  assert.ok(encoded);
  const map = JSON.parse(Buffer.from(encoded, 'base64').toString());
  assert.equal(map.version, 3); assert.ok(map.sources.includes('mapped.ts')); assert.ok(map.mappings);
});
test('Node26 diagnoses transform-only TypeScript without silently changing its semantics', () => {
  if (Number(process.versions.node.split('.')[0]) < 26) {
    assert.doesNotThrow(() => compile('export enum Choice { One, Two }', { sourceMap: false }));
  } else {
    for (const code of ['export enum Choice { One, Two }', 'class Value { constructor(readonly value: number) {} }', 'namespace Values { export const one = 1; }']) {
      assert.throws(() => compile(code, { filename: 'legacy.ts' }), /legacy.ts:.*erasable TypeScript/);
    }
  }
});

test('module rewrites preserve import/export forms and query/hash suffixes', () => {
  const source = `import sideEffect from './side.ts';
import './setup.ts?raw#start';
export { view } from "./view.tsx#component?mode=one";
export * from './keep.js';
const dynamic = import( './lazy.tsx?source=other.ts' );
const unchanged = import('./plain.ts.extra?source=other.ts');`;
  const output = compile(source, { filename: 'imports.ts', sourceMap: false });
  for (const specifier of ['./side.js', './setup.js?raw#start', './view.js#component?mode=one',
    './keep.js', './lazy.js?source=other.ts', './plain.ts.extra?source=other.ts']) assert.ok(output.includes(specifier), specifier);
});

test('unterminated import-like comments cannot stall compilation at the editor document limit', async () => {
  // Isolate the synchronous compiler so a regression is killed instead of hanging the test runner.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const compiler = new URL('../scripts/compiler.mjs', import.meta.url).href;
  const script = `import {compile} from ${JSON.stringify(compiler)};
    const hostile = '// import "' + '!.ts#'.repeat(200000) + '\\nexport const ok = 1;';
    if (Buffer.byteLength(hostile) > 1048576) throw Error('Fixture exceeds editor limit');
    const output = compile(hostile, {filename:'hostile.ts',sourceMap:false});
    if (!output.includes('export const ok')) throw Error('Compilation changed the valid module');`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { timeout: 5000 });
});
