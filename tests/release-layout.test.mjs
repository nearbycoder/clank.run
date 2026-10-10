import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compile } from '../scripts/compiler.mjs';

const execute = promisify(execFile);
const fixtures = {
  ordinary: 'export function snapshot() {\n    const first = 7;\n    const second = 9;\n    return [first + second, "a  b", /a  b/u.source];\n}\n',
  literals: 'export function snapshot() {\n    const sql = `SELECT  title,  owner\n  FROM  records\n   \n\t WHERE title = \'a  b\';`;\n    const raw = String.raw`first\\n\n  second\\t\n   `;\n    const escaped = "first\\\n    second";\n    return [sql, raw, escaped, "🧪  café  Ελληνικά", /["\'`/]/u.source];\n}\n',
  nested: 'export function snapshot() {\n    const value = `outer\n   ${(() => {\n       const inner = `inner\n   ${2 + 3}\n   `;\n       return inner;\n    })()}\n    end`;\n    return [value];\n}\n',
  comments: '/*! License: keep every    byte\n    including indentation. */\nexport function snapshot() {\n    // comment    spacing stays\n    const value = 5; /* another\n      indented comment */\n    return [value];\n}\n',
  division: 'export function snapshot() {\n    const value = 48;\n    const divisor = 2;\n    const result = (value) / divisor / /2/.source.length;\n    return [result, `raw\n   preserved`];\n}\n',
  restricted: 'export function snapshot() {\n    outer: for (let i = 0; i < 2; i++) {\n      if (i === 0) continue outer\n      /["`]/.test("x");\n      break outer\n      /["`]/.test("x");\n    }\n    return [String.raw`raw\n   retained`];\n}\n',
  unicode: 'export function snapshot() {\n    const _value = 6;\n    const 𐐀 = 7;\n    const café = 8;\n    const object = {return: 9};\n    return [_value, 𐐀, café, object.return / 3];\n}\n',
  lineSeparators: 'export function snapshot() {\r\n    const value = 7;\u2028    const other = 8;\u2029    return [value + other, String.raw`raw\r\n   \r\n\t \r\nlast`];\r\n}\r\n',
  asi: 'function returned() {\n    return\n      9;\n}\nexport function snapshot() {\n    let value = 1;\n    value++\n    ;[2].forEach(item => { value += item; });\n    return [returned() ?? "undefined", value];\n}\n',
  ambiguous: 'export function snapshot() {\n    if (true) /["`]/.test("x");\n    return [String.raw`raw\n    unchanged`];\n}\n',
  divisionComment: 'export function snapshot() {\n    const value = (12) / 2 /* a comment with a `\n       and whitespace */ / 3;\n    return [value, `raw\n   unchanged`];\n}\n',
  escapedIdentifier: 'export function snapshot() {\n    const \\u0061 = 7;\n    return [a, `raw\n   unchanged`];\n}\n',
  nestedClass: 'export function snapshot() {\n    return [/[[a]--[b]]/v.source, `raw\n   unchanged`];\n}\n',
  hashbang: '#!/usr/bin/env node\nexport function snapshot() {\n    return [7, `raw\n   unchanged`];\n}\n',
  contextualOf: 'export function snapshot() {\n    const of = 12;\n    const value = of / 2 / /`/.source.length;\n    const first = `first\n   keep`;\n    const second = `second\n   keep`;\n    return [value, first, second, /`/.source];\n}\n',
  forOf: 'export function snapshot() {\n    const values = [];\n    for (const value of /["`]/.source) values.push(value);\n    return [values, `raw\n    unchanged`];\n}\n',
  privateProperty: 'class Value {\n    #return = 12;\n    read() { return this.#return / 2 / /2/.source.length; }\n}\nexport function snapshot() {\n    return [new Value().read(), `raw\n   preserved`];\n}\n',
  expressionRegex: 'export function snapshot() {\n    const value = true ? /["`]/.source : /a\\/b/.source;\n    const other = (() => /["`]/.source)();\n    return [value, other, `raw\n   preserved`];\n}\n',
  templateDivision: 'export function snapshot() {\n    return [`outer\n  ${(12) / 2 / /2/.source.length}\n  retained`];\n}\n',
  templateBraceAmbiguity: 'export function snapshot() {\n    return [`outer\n  ${(12) / ({value: 2}).value / 3}\n  unchanged`];\n}\n',
  defaultRegex: 'export default /`/.source;\nconst first = `first\n   keep`;\nconst second = `second\n   keep`;\nexport function snapshot() {\n    return [first, second, /`/.source];\n}\n',
  extendsRegex: 'class Value extends /`/.constructor {}\nconst first = `first\n   keep`;\nconst second = `second\n   keep`;\nexport function snapshot() {\n    return [new Value().source, first, second, /`/.source];\n}\n',
};
// Beyond the release scanner's stricter bound, but accepted by the minimum
// Node22 native parser. A 258-level fixture crashes that older parser before
// our build pass runs, so it cannot demonstrate scanner fallback there.
fixtures.bounded = 'export function snapshot() {\n    return [' + Array.from({length: 66}, () => '`start${').join('') + '1' + Array.from({length: 66}, () => '}end`').join('') + '];\n}\n';

async function releaseBuild(t, mapped = false) {
  const root = await mkdtemp(join(tmpdir(), 'clank-release-layout-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const name of ['scripts', 'src', 'docs', 'examples']) await mkdir(join(root, name));
  for (const name of ['build.mjs', 'compiler.mjs', 'tsx.mjs']) {
    await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
  }
  await writeFile(join(root, 'docs', 'getting-started.md'), '# Setup\n\n## Set up with an agent\n\n```text\nUse the canonical setup prompt.\n```\n');
  for (const [name, source] of Object.entries(fixtures)) await writeFile(join(root, 'src', `${name}.ts`), source);
  await writeFile(join(root, 'src', 'contract.d.ts'), 'export declare const value: number;\n');
  await writeFile(join(root, 'examples', 'ordinary.ts'), fixtures.ordinary);
  const env = {...process.env};
  if (mapped) env.CLANK_SOURCE_MAPS = '1'; else delete env.CLANK_SOURCE_MAPS;
  await execute(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'scripts', 'build.mjs')], {env, timeout: 15000});
  return root;
}

test('framework release build removes substantial code indentation while public compile and examples keep their format', async t => {
  const root = await releaseBuild(t);
  const expected = compile(fixtures.ordinary, {filename: join(root, 'src', 'ordinary.ts'), sourceMap: false});
  const built = await readFile(join(root, 'dist', 'ordinary.js'), 'utf8');
  assert.ok(Buffer.byteLength(expected) - Buffer.byteLength(built) >= 12);
  assert.equal(built.replace(/^[ \t]+/gmu, ''), expected.replace(/^[ \t]+/gmu, ''));
  assert.equal(await readFile(join(root, 'examples', 'ordinary.js'), 'utf8'), expected);
  assert.equal(await readFile(join(root, 'dist', 'contract.d.ts'), 'utf8'), 'export declare const value: number;\n');
  assert.equal(compile(fixtures.ordinary, {filename: join(root, 'src', 'ordinary.ts'), sourceMap: false}), expected);
});

test('actual built modules preserve executed literal, regex, comment, Unicode and ASI behavior', async t => {
  const root = await releaseBuild(t);
  for (const [name, source] of Object.entries(fixtures)) {
    const expected = compile(source, {filename: join(root, 'src', `${name}.ts`), sourceMap: false});
    const built = await readFile(join(root, 'dist', `${name}.js`), 'utf8');
    // Use files for hashbang modules; data URL import parses hashbang differently on older Node.
    await writeFile(join(root, `${name}-baseline.mjs`), expected);
    const baseline = await import(pathToFileURL(join(root, `${name}-baseline.mjs`)).href);
    const actual = await import(pathToFileURL(join(root, 'dist', `${name}.js`)).href);
    assert.deepEqual(actual.snapshot(), baseline.snapshot(), name);
    if (['ordinary', 'literals', 'nested', 'comments', 'division', 'unicode', 'lineSeparators', 'asi', 'privateProperty', 'expressionRegex', 'templateDivision', 'defaultRegex', 'extendsRegex'].includes(name)) {
      assert.ok(built.length < expected.length, `${name}: proof exercises an actually compacted module`);
    }
    assert.deepEqual(built.match(/\r\n|[\r\n\u2028\u2029]/gu), expected.match(/\r\n|[\r\n\u2028\u2029]/gu), `${name}: line endings`);
    if (name === 'comments') {
      assert.ok(built.includes('/*! License: keep every    byte\n    including indentation. */'));
      assert.ok(built.includes('// comment    spacing stays'));
      assert.ok(built.includes('/* another\n      indented comment */'));
    }
  }
});

test('ambiguous syntax and bounded nested scanning preserve the entire original module', async t => {
  const root = await releaseBuild(t);
  for (const name of ['ambiguous', 'divisionComment', 'escapedIdentifier', 'nestedClass', 'hashbang', 'bounded', 'restricted', 'forOf', 'templateBraceAmbiguity']) {
    const expected = compile(fixtures[name], {filename: join(root, 'src', `${name}.ts`), sourceMap: false});
    assert.equal(await readFile(join(root, 'dist', `${name}.js`), 'utf8'), expected, name);
  }
});

test('mapped framework release builds retain exact ordinary compiler output', async t => {
  const root = await releaseBuild(t, true);
  for (const [name, source] of Object.entries(fixtures)) {
    const filename = join(root, 'src', `${name}.ts`);
    assert.equal(await readFile(join(root, 'dist', `${name}.js`), 'utf8'), compile(source, {filename, jsxImportSource: './index.js', sourceMap: true}), name);
  }
});
