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
const declarationFixture = "/** IDE documentation keeps  every byte.\n * Including indentation and `templates`. */\nexport interface Contract {\n    readonly value?: Readonly<Record<string, `key-${string}`>>;\n}\nexport declare const value: number;\n";
const declarationExpected = "/** IDE documentation keeps  every byte.\n * Including indentation and `templates`. */\nexport interface Contract{\nreadonly value?:Readonly<Record<string,`key-${string}`>>;\n}\nexport declare const value:number;\n";
const declarationFixtures = {
  // Prefix only known code lines; raw literal/comment lines below are intentional.
  syntax: {
    source: '    /// <reference lib="es2022" />\n    export declare namespace Shapes {\n        interface Item<T extends string = string> {\n            readonly key?: T;\n            [key: `field-${string}`]: unknown;\n            new (...args: unknown[]): Item<T>;\n            <U extends T>(value: U): U;\n        }\n        type Mapped<T> = { readonly [K in keyof T as `get-${string & K}`]?: T[K] };\n        type Result<T> = T extends Promise<infer U> ? U : never;\n        type Pair = [first: string, ...rest: number[]];\n        type Word = "keep  interior" | \'also  exact\';\n        const token: unique symbol;\n        function check(value: unknown): value is Item;\n        function check(value: string): boolean;\n        class Holder<T> { readonly value: T; constructor(value: T); }\n    }\n    import type { Contract as Other } from "./contract.js";\n    export type { Other };\n',
    expected: "/// <reference lib=\"es2022\" />\nexport declare namespace Shapes{\ninterface Item<T extends string = string>{\nreadonly key?:T;\n[key:`field-${string}`]:unknown;\nnew(...args:unknown[]):Item<T>;\n<U extends T>(value:U):U;\n}\ntype Mapped<T> ={readonly[K in keyof T as `get-${string & K}`]?:T[K]};\ntype Result<T> = T extends Promise<infer U> ? U:never;\ntype Pair =[first:string,...rest:number[]];\ntype Word = \"keep  interior\" | 'also  exact';\nconst token:unique symbol;\nfunction check(value:unknown):value is Item;\nfunction check(value:string):boolean;\nclass Holder<T>{readonly value:T;constructor(value:T);}\n}\nimport type{Contract as Other}from \"./contract.js\";\nexport type{Other};\n",
  },
  raw: {
    source: '    /*! License  stays\n      every byte */\n    /** IDE  hover\n     * @example\n     *     preserve indentation\n     */\n    export type Raw<T extends string> = `first\n    ${`nested-${T}`}\n      last`;\n    export type Escaped = "first\\\n        second";\n',
    expected: "/*! License  stays\n      every byte */\n/** IDE  hover\n     * @example\n     *     preserve indentation\n     */\nexport type Raw<T extends string> = `first\n    ${`nested-${T}`}\n      last`;\nexport type Escaped = \"first\\\n        second\";\n",
  },
  newlines: {
    source: '\t export interface Café {\r\n    first: string;\u2028    second: number;\u2029    readonly 𐐀?: boolean;\r\n }\n',
    expected: "export interface Café{\r\nfirst:string; second:number; readonly 𐐀?:boolean;\r\n}\n",
  },
};
// These use declaration grammar, but deliberately exceed the private scanner's
// conservative eligibility. The entire input must survive, including earlier edits.
const escapedDeclaration = '    export interface \\u0043ontract {\n        value: string;\n    }\n';
const boundedDeclaration = '    export type Nested = ' + '`start${'.repeat(66) + '"value"' + '}end`'.repeat(66) + ';\n';
declarationFixtures.escaped = {source: escapedDeclaration, expected: escapedDeclaration};
declarationFixtures.bounded = {source: boundedDeclaration, expected: boundedDeclaration};
declarationFixtures.operators = {
  source: "/** exact ( ) :  ; */\nexport type Transform<T> = { -readonly [ K in keyof T as `get-${string & K}` ] -? : T [ K ] extends ( infer U ) [ ] ? readonly [ U , ... U [ ] ] : T [ K ] } ;\nexport type Select<T> = T extends { value : infer U extends string } ? U : never ;\nexport type Values = -1 | 0x1 | 1n | -2n | \"http://  x\" ;\n",
  expected: "/** exact ( ) :  ; */\nexport type Transform<T> ={-readonly[K in keyof T as `get-${string & K}`]-?:T[K]extends(infer U)[]? readonly[U,... U[]]:T[K]};\nexport type Select<T> = T extends{value:infer U extends string}? U:never;\nexport type Values = -1 | 0x1 | 1n | -2n | \"http://  x\";\n",
};
declarationFixtures.namespace = {
  source: "/*! License  retained */\nexport declare namespace Outer { interface Shape { readonly size : number ; } namespace Inner { type Record = { [ key : string ] : Shape } ; } }\nexport declare class Holder<T> { private state ; protected readonly key : string ; constructor ( value : T ) ; get value ( ) : T ; set value ( next : T ) ; method<U extends T> ( input : U ) : U ; }\n",
  expected: "/*! License  retained */\nexport declare namespace Outer{interface Shape{readonly size:number;}namespace Inner{type Record ={[key:string]:Shape};}}\nexport declare class Holder<T>{private state;protected readonly key:string;constructor(value:T);get value():T;set value(next:T);method<U extends T>(input:U):U;}\n",
};
declarationFixtures.predicates = {
  source: "export interface Ready { value : string ; }\nexport declare function ready ( input : unknown ) : input is Ready ;\nexport declare function assertReady ( input : unknown ) : asserts input is Ready ;\nexport interface Callable { ( input : string ) : number ; new ( input : number ) : Ready ; }\n",
  expected: "export interface Ready{value:string;}\nexport declare function ready(input:unknown):input is Ready;\nexport declare function assertReady(input:unknown):asserts input is Ready;\nexport interface Callable{(input:string):number;new(input:number):Ready;}\n",
};
declarationFixtures.exportEdges = {
  source: "import type { Ready as Imported } from \"./predicates.js\" ;\nexport type { Imported as Exported } ;\nexport * as Library from \"./namespace.js\" ;\nexport { type Callable } from \"./predicates.js\" ;\n",
  expected: "import type{Ready as Imported}from \"./predicates.js\";\nexport type{Imported as Exported};\nexport * as Library from \"./namespace.js\";\nexport{type Callable}from \"./predicates.js\";\n",
};
const fixtures = {
  ordinary: 'export function snapshot() {\n    const first = 7;\n    const second = 9;\n    return [first + second, "a  b", /a  b/u.source];\n}\n',
  literals: 'export function snapshot() {\n    const sql = `SELECT  title,  owner\n  FROM  records\n   \n\t WHERE title = \'a  b\';`;\n    const raw = String.raw`first\\n\n  second\\t\n   `;\n    const escaped = "first\\\n    second";\n    return [sql, raw, escaped, "🧪  café  Ελληνικά", /["\'`/]/u.source];\n}\n',
  nested: 'export function snapshot() {\n    const value = `outer\n   ${(() => {\n       const inner = `inner\n   ${2 + 3}\n   `;\n       return inner;\n    })()}\n    end`;\n    return [value];\n}\n',
  comments: '/*! License: keep every    byte\n    including indentation. */\nexport function snapshot() {\n    // comment    spacing stays\n    const value = 5; /* another\n      indented comment */\n    return [value];\n}\n',
  division: 'export function snapshot() {\n    const value = 48;\n    const divisor = 2;\n    const result = (value) / divisor / /2/.source.length;\n    return [result, `raw\n   preserved`];\n}\n',
  singleDivision: 'export function snapshot() {\n    const value = (48) / 2;\n    return [value, String.raw`raw\n    exact`];\n}\n',
  singleDivisionAssign: 'export function snapshot() {\n    let value = 48;\n    (value) /= 2;\n    return [value, `raw\n    exact`];\n}\n',
  singleDivisionLines: 'export function snapshot() {\r\n    const first = (48) / 2;\u2028    const second = (18) / 3;\u2029    return [first, second, `raw\r\n    exact`];\r\n}\r\n',
  singleTemplateDivision: 'export function snapshot() {\n    return [String.raw`raw\n    ${(48) / 2\n    }\n    exact`];\n}\n',
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
// Separator spacing must preserve native grammar and every literal byte.
Object.assign(fixtures, {
  jobs: 'export function snapshot() {\n    const output = (context) => context.results;\n    return Function.prototype.toString.call(output);\n}\n',
  separators: "function sum ( first : number , ... rest : number [ ] ) : number { return rest.reduce ( ( total , value ) => total + value , first ) ; }\nexport function snapshot ( ) { const object = { first : 2 , second : [ 3 , 4 ] } ; const { first , second : [ ... rest ] } = object ; const nested = ( ( value ) => ( { value } ) ) ( sum ( first , ... rest ) ) ; return [ nested.value , Object.keys ( object ) ] ; }\n",
  operatorBoundaries: "export function snapshot ( ) { let first = 2 ; let second = 4 ; const plus = first + ++ second ; const minus = second - -- first ; const number = 1 .toString ( ) ; const doubleDot = 2..toString ( ) ; const fraction = true ? .1 : .2 ; const object = { method ( value ) { return value + 1 ; } } ; const nil = null ; return [ plus , minus , first , second , number , doubleDot , fraction , object ?. method ?. ( 3 ) , object ?. [ \"method\" ] ( 4 ) , nil ?? ( 9 ) , typeof first , first instanceof Number ] ; }\n",
  separatorRegex: "export function snapshot ( ) { const quotient = ( 24 ) / 2 ; const expression = /[(){}:;, ]+/u ; const comment = ( 12 ) /* comment ( : { } , ) */ / 3 ; return [ quotient , expression.source , expression.test ( \" ( ) , \" ) , comment , ( /x/ ) .test ( \"x\" ) ] ; }\n",
  keywordBoundaries: "async function resolve ( value ) { return await ( value ) ; }\nfunction * values ( ) { yield ( 2 ) ; yield * [ 3 , 4 ] ; }\nexport async function snapshot ( ) { const object = { key : 1 } ; const removed = delete ( object.key ) ; let message ; try { throw ( new Error ( \"kept\" ) ) ; } catch ( error ) { message = error.message ; } return [ await resolve ( 7 ) , [ ... values ( ) ] , removed , message , typeof ( object ) , void ( 3 ) ?? \"none\" ] ; }\n",
  separatorASI: "function returned ( ) { return\n  { value : 9 } ; }\nexport function snapshot ( ) { let value = 1\n  value ++\n  ; [ 2 ].forEach ( item => { value += item ; } )\n  const object = { method ( ) { return value ; } }\n  const result = object\n    ?. method ( )\n  return [ returned ( ) ?? \"undefined\" , value , result ]\n}\n",
  separatorLiterals: "export function snapshot ( ) { const value = 3 ; const raw = String.raw`raw ( : [ ] )\n  ${ ( value ) }\n  exact` ; const tag = ( parts , item ) => [ parts [ 0 ] , item , parts.raw [ 1 ] ] ; const tagged = tag`before\n   ${ ( value ) }\n  after` ; return [ raw , tagged , \"a ( ) : [ ]  b\" , `SELECT  ( value )\n  FROM  rows;` ] ; }\n",
});
// Beyond the release scanner's stricter bound, but accepted by the minimum
// Node22 native parser. A 258-level fixture crashes that older parser before
// our build pass runs, so it cannot demonstrate scanner fallback there.
fixtures.bounded = 'export function snapshot() {\n    return [' + Array.from({length: 66}, () => '`start${').join('') + '1' + Array.from({length: 66}, () => '}end`').join('') + '];\n}\n';

async function releaseBuild(t, mapped = false) {
  const root = await mkdtemp(join(tmpdir(), 'clank-release-layout-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const name of ['scripts', 'src', 'docs', 'examples']) await mkdir(join(root, name));
  for (const name of ['build.mjs', 'compiler.mjs', 'tsx.mjs', 'docs-audit.mjs']) {
    await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
  }
  await writeFile(join(root, 'docs', 'getting-started.md'), '# Setup\n\n## Set up with an agent\n\n```text\nUse the canonical setup prompt.\n```\n');
  for (const [name, source] of Object.entries(fixtures)) await writeFile(join(root, 'src', `${name}.ts`), source);
  await writeFile(join(root, 'src', 'contract.d.ts'), declarationFixture);
  await writeFile(join(root, 'src', 'malformed.d.ts'), Buffer.concat([Buffer.from('    export interface Malformed { value: string; } // '), Buffer.from([0x80, 0xc3, 0x28]), Buffer.from('\r\n')]));
  for (const [name, fixture] of Object.entries(declarationFixtures)) await writeFile(join(root, 'src', `${name}.d.ts`), fixture.source);
  await writeFile(join(root, 'README.md'), '# Fixture\n[Setup](docs/getting-started.md)\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({type: 'module', exports: {'.': {types: './dist/contract.d.ts', import: './dist/ordinary.js'}}}));
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
  assert.equal(built, 'export function snapshot(){\nconst first = 7;\nconst second = 9;\nreturn[first + second,"a  b",/a  b/u.source];\n}\n');
  assert.equal(await readFile(join(root, 'examples', 'ordinary.js'), 'utf8'), expected);
  assert.equal(await readFile(join(root, 'dist', 'contract.d.ts'), 'utf8'), declarationExpected);
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
    assert.deepEqual(await actual.snapshot(), await baseline.snapshot(), name);
    if (['ordinary', 'literals', 'nested', 'comments', 'division', 'singleDivision', 'singleDivisionAssign', 'singleDivisionLines', 'singleTemplateDivision', 'unicode', 'lineSeparators', 'asi', 'privateProperty', 'expressionRegex', 'templateDivision', 'defaultRegex', 'extendsRegex'].includes(name)) {
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
  assert.equal(await readFile(join(root, 'dist', 'contract.d.ts'), 'utf8'), declarationFixture);
  for (const [name, fixture] of Object.entries(declarationFixtures)) assert.equal(await readFile(join(root, 'dist', `${name}.d.ts`), 'utf8'), fixture.source, name);
  for (const [name, source] of Object.entries(fixtures)) {
    const filename = join(root, 'src', `${name}.ts`);
    assert.equal(await readFile(join(root, 'dist', `${name}.js`), 'utf8'), compile(source, {filename, jsxImportSource: './index.js', sourceMap: true}), name);
  }
});

// This assertion fails under indentation-only output, so savings cannot be
// claimed from semantic comparisons which also pass an unchanged build.
test('release output removes separator spaces while retaining hazardous operator and numeric boundaries', async t => {
  const root = await releaseBuild(t);
  const ordinary = await readFile(join(root, 'dist', 'separators.js'), 'utf8');
  assert.ok(ordinary.includes('function sum(first,... rest)'));
  assert.ok(ordinary.includes('{first:2,second:[3,4]}'));
  assert.ok(ordinary.includes('sum(first,... rest)'));
  const ambiguous = await readFile(join(root, 'dist', 'separatorRegex.js'), 'utf8');
  assert.ok(ambiguous.includes('/[(){}:;, ]+/u'));
  assert.ok(ambiguous.includes('snapshot ( )')); // Ambiguity discards earlier interior edits too.
  const boundary = await readFile(join(root, 'dist', 'operatorBoundaries.js'), 'utf8');
  for (const retained of ['first + ++ second', 'second - -- first', '1 .toString()', '2..toString()', 'true ? .1:.2', 'object ?. method ?.(', 'nil ??(9)', 'typeof first', 'first instanceof Number']) {
    assert.ok(boundary.includes(retained), retained);
  }
  for (const name of ['separators', 'operatorBoundaries', 'keywordBoundaries', 'separatorASI', 'separatorLiterals']) {
    const expected = compile(fixtures[name], {filename: join(root, 'src', `${name}.ts`), sourceMap: false});
    const built = await readFile(join(root, 'dist', `${name}.js`), 'utf8');
    assert.ok(built.length < expected.replace(/^[ \t]+/gmu, '').length, `${name}: removes interior spacing beyond indentation`);
  }
  assert.equal(await readFile(join(root, 'dist', 'contract.d.ts'), 'utf8'), declarationExpected);
});

test('framework callbacks used in persisted workflow revisions retain accepted indentation-only source', async t => {
  const root = await releaseBuild(t);
  const expected = compile(fixtures.jobs, {filename: join(root, 'src', 'jobs.ts'), sourceMap: false});
  const built = await readFile(join(root, 'dist', 'jobs.js'), 'utf8');
  assert.equal(built, expected.replace(/^[ \t]+/gmu, ''));
  assert.equal((await import(pathToFileURL(join(root, 'dist', 'jobs.js')).href)).snapshot(), '(context) => context.results');
});

test('rebuilding emitted JavaScript and declarations is idempotent', async t => {
  const root = await releaseBuild(t), first = new Map();
  for (const name of Object.keys(fixtures)) {
    const output = await readFile(join(root, 'dist', `${name}.js`), 'utf8');
    first.set(name, output);
    await writeFile(join(root, 'src', `${name}.ts`), output);
  }
  const env = {...process.env}; delete env.CLANK_SOURCE_MAPS;
  await execute(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'scripts', 'build.mjs')], {env, timeout: 15000});
  for (const [name, output] of first) assert.equal(await readFile(join(root, 'dist', `${name}.js`), 'utf8'), output, name);
  assert.equal(await readFile(join(root, 'dist', 'contract.d.ts'), 'utf8'), declarationExpected);
});


test('release declarations compact code indentation and separator spaces while preserving literal, license, JSDoc and newline bytes', async t => {
  const root = await releaseBuild(t);
  for (const [name, fixture] of Object.entries(declarationFixtures)) {
    const actual = await readFile(join(root, 'dist', `${name}.d.ts`), 'utf8');
    assert.equal(actual, fixture.expected, name);
    assert.equal(await readFile(join(root, 'src', `${name}.d.ts`), 'utf8'), fixture.source, `${name}: source is unchanged`);
    assert.deepEqual(actual.match(/\r\n|[\r\n\u2028\u2029]/gu), fixture.source.match(/\r\n|[\r\n\u2028\u2029]/gu), `${name}: newline bytes`);
    if (!['escaped', 'bounded'].includes(name)) assert.ok(actual.length < fixture.source.length, `${name}: actual savings`);
    await writeFile(join(root, 'src', `${name}.d.ts`), actual);
  }
  const env = {...process.env}; delete env.CLANK_SOURCE_MAPS;
  await execute(process.execPath, [join(root, 'scripts', 'build.mjs')], {env, timeout: 15000});
  for (const [name, fixture] of Object.entries(declarationFixtures)) assert.equal(await readFile(join(root, 'dist', `${name}.d.ts`), 'utf8'), fixture.expected, `${name}: idempotence`);
});

test('release declarations remove interior separator spacing beyond the accepted indentation-only layout', async t => {
  const root = await releaseBuild(t);
  const expected = declarationFixtures.operators.expected;
  const built = await readFile(join(root, 'dist', 'operators.d.ts'), 'utf8');
  assert.equal(built, expected);
  assert.ok(built.includes('{ -readonly') === false, 'spaces next to braces are removed');
  assert.ok(built.includes('{-readonly[K in keyof T as `get-${string & K}`]-?:T[K]'));
  assert.ok(built.includes('T[K]extends(infer U)[]? readonly[U,... U[]]:T[K]'));
  assert.ok(built.includes('= -1 | 0x1 | 1n | -2n | "http://  x"'), 'operator and literal boundaries remain');
  assert.ok(built.includes('/** exact ( ) :  ; */'), 'documentation comment remains exact');
  const indentationOnly = declarationFixtures.operators.source.replace(/^[ \t]+/gmu, '');
  assert.ok(Buffer.byteLength(indentationOnly) - Buffer.byteLength(built) >= 40, 'proof requires additional interior savings');
});

test('documentation audit requires exact selected declaration output and rejects missing, stale or changed bytes', async t => {
  for (const mapped of [false, true]) {
    const root = await releaseBuild(t, mapped), env = {...process.env};
    if (mapped) env.CLANK_SOURCE_MAPS = '1'; else delete env.CLANK_SOURCE_MAPS;
    const command = () => execute(process.execPath, [join(root, 'scripts', 'docs-audit.mjs')], {env, timeout: 15000});
    const output = join(root, 'dist', 'contract.d.ts');
    const expected = mapped ? declarationFixture : declarationExpected;
    // This supplies the actual required layout independently of build selection,
    // so the before-fix copy-only audit rejects the valid default representation.
    await writeFile(output, expected);
    assert.match((await command()).stdout, /synchronized declaration files/);
    for (const altered of [expected.replace('value?:', 'other?:'), expected.replace('every byte', 'every byte!'), expected.replace('key-', 'changed-'), expected.replaceAll('\n', '\r\n'), expected + ' ', expected.slice(0, -1), mapped ? declarationExpected : declarationFixture]) {
      await writeFile(output, altered);
      await assert.rejects(command(), error => error.code === 1 && /dist\/contract\.d\.ts does not match/.test(error.stderr));
    }
    await rm(output);
    await assert.rejects(command(), error => error.code === 1 && /dist\/contract\.d\.ts is missing/.test(error.stderr));
    await writeFile(output, expected);
    await writeFile(join(root, 'src', 'contract.d.ts'), declarationFixture.replace('value?:', 'replacement?:'));
    await assert.rejects(command(), error => error.code === 1 && /dist\/contract\.d\.ts does not match/.test(error.stderr));
  }
});


for (const mapped of [false, true]) {
  test(`declaration ${mapped ? 'mapped' : 'default'} output preserves malformed UTF-8 as exact raw bytes`, async t => {
    const root = await releaseBuild(t, mapped);
    const original = await readFile(join(root, 'src', 'malformed.d.ts'));
    assert.ok(!Buffer.from(original.toString('utf8')).equals(original), 'fixture actually has malformed UTF-8');
    assert.deepEqual(await readFile(join(root, 'dist', 'malformed.d.ts')), original);
  });

  test(`declaration ${mapped ? 'mapped' : 'default'} audit rejects changed malformed bytes with identical decoded text`, async t => {
    const root = await releaseBuild(t, mapped), env = {...process.env};
    if (mapped) env.CLANK_SOURCE_MAPS = '1'; else delete env.CLANK_SOURCE_MAPS;
    const command = () => execute(process.execPath, [join(root, 'scripts', 'docs-audit.mjs')], {env, timeout: 15000});
    const original = Buffer.concat([Buffer.from('export interface AuditBytes {} // '), Buffer.from([0x80]), Buffer.from('\n')]);
    const changed = Buffer.from(original); changed[changed.indexOf(0x80)] = 0x81;
    assert.equal(original.toString('utf8'), changed.toString('utf8'));
    await writeFile(join(root, 'src', 'audit-bytes.d.ts'), original);
    await writeFile(join(root, 'dist', 'audit-bytes.d.ts'), original);
    assert.match((await command()).stdout, /synchronized declaration files/);
    await writeFile(join(root, 'dist', 'audit-bytes.d.ts'), changed);
    await assert.rejects(command(), error => error.code === 1 && /dist\/audit-bytes\.d\.ts does not match/.test(error.stderr));
  });
}
