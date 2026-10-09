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

test('unmapped erasable output compacts native padding on every supported runtime', async () => {
  const declaration = Array.from({ length: 120 }, (_, index) => `  property${index}: Readonly<Record<string, readonly [number, string]>>;`).join('\n');
  const source = `interface LargeDeclaration {\n${declaration}\n}\nfunction value<T>(){}\nexport const isFunction=value<string>instanceof Function;\nexport const exists='x'!in {x:true};\nexport const result=7;`;
  const output = compile(source, { filename: 'padding.ts', sourceMap: false });
  const result = await import(`data:text/javascript,${encodeURIComponent(output)}`);
  assert.equal(result.isFunction, true); assert.equal(result.exists, true); assert.equal(result.result, 7);
  const { stripTypeScriptTypes } = await import('node:module');
  const native = stripTypeScriptTypes(source, { mode: 'strip' });
  assert.ok(native.length - output.length > 4000, 'release output must remove substantial erased padding');
  assert.equal(output.split('\n').length, native.split('\n').length);
});

test('padding compaction preserves SQL, raw templates, tabs, unicode, regex and runtime comments', async () => {
  const source = `type Ignored = Readonly<Record<string, readonly [number, string]>>;
// runtime    comment   stays
export const sql: string = \`SELECT  title,  owner\n  FROM  records\n  WHERE  title = 'a  b';\`;
export const raw: string = String.raw\`first  line\\nsecond   line\`;
export const tabs: string = "A\t\tB";
export const unicode: string = "🧪  café  Ελληνικά";
export const regex: string = /a  b/u.source;`;
  const output = compile(source, { filename: 'literals.ts', sourceMap: false });
  assert.ok(output.includes('// runtime    comment   stays'));
  const result = await import(`data:text/javascript,${encodeURIComponent(output)}`);
  assert.equal(result.sql, "SELECT  title,  owner\n  FROM  records\n  WHERE  title = 'a  b';");
  assert.equal(result.raw, 'first  line\\nsecond   line'); assert.equal(result.tabs, 'A\t\tB');
  assert.equal(result.unicode, '🧪  café  Ελληνικά'); assert.equal(result.regex, 'a  b');
});

test('erased lines lose padding while whitespace-only literal lines and ASI stay intact', async () => {
  const declaration = Array.from({length:80}, (_, index) => `\t  property${index} : Readonly < Record < string , readonly [ number , string ] > > ;`).join('\r\n');
  const source = `interface Padding {\r\n${declaration}\r\n}\r\nexport const raw = String.raw\`first\r\n   \r\n\t \r\nlast\`;\r\nfunction identity<T>(value:T):T {return value;}\r\nexport const value=identity<\r\n   number\r\n>(7);\r\nexport function returned():number|undefined {return\r\n   identity<number>(8);\r\n}\r\nexport const tokens=identity< number >instanceof Function;`;
  const output = compile(source, {filename:'line-padding.ts',sourceMap:false});
  const mapped = compile(source, {filename:'line-padding.ts'});
  assert.equal(output.split('\r\n').length, source.split('\r\n').length);
  assert.ok(output.includes('first\r\n   \r\n\t \r\nlast'));
  assert.ok(mapped.length > output.length);
  assert.ok(output.length < 600, 'fully erased declaration lines must not consume package space');
  const result = await import(`data:text/javascript,${encodeURIComponent(output)}`);
  assert.equal(result.raw, 'first\n   \n\t \nlast');
  assert.equal(result.value,7);assert.equal(result.returned(),undefined);assert.equal(result.tokens,true);
});

test('Node 22/24 unmapped fallback executes enums, parameter properties and runtime namespaces', async () => {
  const legacy = [
    ['export enum Choice { One, Two = 7 }; export const result = Choice.Two;', 7],
    ['class Value { constructor(readonly value: number) {} }; export const result = new Value(8).value;', 8],
    ['namespace Values { export const one = 9; }; export const result = Values.one;', 9],
  ];
  for (const [source, expected] of legacy) {
    if (Number(process.versions.node.split('.')[0]) >= 26) {
      assert.throws(() => compile(source, { filename: 'legacy.ts', sourceMap: false }), /legacy.ts:.*erasable TypeScript/);
    } else {
      const output = compile(source, { filename: 'legacy.ts', sourceMap: false });
      assert.doesNotMatch(output, /sourceURL|sourceMappingURL/);
      assert.equal((await import(`data:text/javascript,${encodeURIComponent(output)}`)).result, expected);
    }
  }
});

test('mapped Node 22/24 output stays identical to native transform and syntax failures remain errors', async () => {
  const source = 'interface Value { readonly amount: number; }\nexport const value: number = 3;';
  if (Number(process.versions.node.split('.')[0]) < 26) {
    const { stripTypeScriptTypes } = await import('node:module');
    assert.equal(compile(source, { filename: 'mapped-parity.ts' }),
      stripTypeScriptTypes(source, { mode: 'transform', sourceMap: true, sourceUrl: 'mapped-parity.ts' }));
  }
  assert.throws(() => compile('export const broken: number = ;', { sourceMap: false }), SyntaxError);
});

test('generic calls and return ASI retain their newline semantics after erasure', async () => {
  const source = `function identity<T>(value:T):T { return value; }
export const value=identity<
  number
>(7);
export function returned(): number | undefined { return
  identity<number>(100);
}
export const array = [1, 2] as const;
;[3, 4].forEach(() => undefined);`;
  const output = compile(source, { filename: 'asi.ts', sourceMap: false });
  const result = await import(`data:text/javascript,${encodeURIComponent(output)}`);
  assert.equal(result.value, 7); assert.equal(result.returned(), undefined); assert.deepEqual(result.array, [1, 2]);
});

test('mapped Node26 output retains native padding and the original source content', async () => {
  const source = 'interface Padding { readonly field: Readonly<Record<string, number>>; }\nexport const value: number = 3;';
  const mapped = compile(source, { filename: 'mapped-padding.ts' });
  const encoded = mapped.match(/sourceMappingURL=data:application\/json[^,]*,([^\s]+)/)?.[1];
  assert.ok(encoded); const map = JSON.parse(Buffer.from(encoded, 'base64').toString());
  if (Number(process.versions.node.split('.')[0]) >= 26) {
    assert.deepEqual(map.sourcesContent, [source]);
    const { stripTypeScriptTypes } = await import('node:module');
    assert.equal(mapped.split('\n//# sourceMappingURL=')[0], stripTypeScriptTypes(source, { mode: 'strip' }));
    assert.ok(mapped.split('\n//# sourceMappingURL=')[0].length > compile(source, { sourceMap: false }).length);
  }
});
