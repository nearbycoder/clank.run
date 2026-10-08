import test from "node:test";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import { transformTSX } from "../scripts/tsx.mjs";
import { compile } from "../scripts/compiler.mjs";

test("TSX compiles elements, components, fragments, spreads, and reactive sites", () => {
  const source = `
    const state = signal({ ready: true, name: "Ada" });
    const shared = { title: "Profile" };
    function App() {
      return <>
        <button {...shared} class={state.value.ready ? "on" : "off"} onClick={() => state.value.ready = false}>
          Hello {state.value.name}
        </button>
        <Show when={state.value.ready}><strong>Ready</strong></Show>
      </>;
    }
  `;
  const result = transformTSX(source, { importSource: "/dist/index.js" });
  assert.equal(result.transformed, true);
  assert.match(result.code, /from "\/dist\/index\.js"/);
  assert.match(result.code, /__clankJSX\("button"/);
  assert.match(result.code, /__clankExpression\(\(\) => \(state\.value\.ready/);
  assert.match(result.code, /"onClick": \(\) => state\.value\.ready = false/);
  assert.match(result.code, /__clankFragment/);
  assert.doesNotThrow(() => compile(result.code, { sourceMap: false }));
});

test("TSX transform leaves generic arrow syntax intact", () => {
  const source = `const identity = <T,>(value: T): T => value; const view = <div>{identity(1)}</div>;`;
  const { code } = transformTSX(source);
  assert.match(code, /<T,>/);
  assert.match(code, /__clankJSX\("div"/);
});

test("TSX reports mismatched tags with source coordinates", () => {
  assert.throws(() => transformTSX(`const view = <main><span /></div>;`), /Expected <\/main>.*1:/);
});

test("compiler rewrites static, re-exported, and dynamic TypeScript module specifiers", () => {
  const source = `
    import "./setup.ts";
    export { value } from "./value.ts";
    export * from "./all.tsx?raw";
    const lazy = import("./lazy.ts#module");
  `;
  const output = compile(source, { filename: "entry.ts", sourceMap: false });
  assert.match(output, /import "\.\/setup\.js"/);
  assert.match(output, /from "\.\/value\.js"/);
  assert.match(output, /from "\.\/all\.js\?raw"/);
  assert.match(output, /import\("\.\/lazy\.js#module"\)/);
});

test("Clank import pragma overrides the generated TSX runtime source", () => {
  const { code } = transformTSX(`/* @clankImportSource /vendor/clank.js */\nconst view = <p>Hi</p>;`);
  assert.match(code, /from "\/vendor\/clank\.js"/);
});

test("expressions containing nested arrow callbacks remain reactive", () => {
  const { code } = transformTSX(`
    const view = <footer>
      <span>{todos.filter((todo) => !todo.done).length} open</span>
      <button disabled={todos.some((todo) => todo.done)}>Clear</button>
    </footer>;
  `);
  assert.match(code, /__clankExpression\(\(\) => \(todos\.filter/);
  assert.match(code, /"disabled": __clankExpression\(\(\) => \(todos\.some/);
});

test("numeric literal detection remains linear on long invalid expressions", () => {
  const expression = `${"00".repeat(100_000)}x`;
  const { code } = transformTSX(`const view = <span>{${expression}}</span>;`);
  assert.match(code, /__clankExpression/);
  assert.match(code, /x\)\)/);
});

test('opt-in TSX hydration locations refer to original source coordinates and exclude directories', async () => {
  const runtime = new URL('../dist/index.js', import.meta.url).href;
  const source = `export function Greeting() {\n  return <section>\n    <button>Private rendered label</button>\n  </section>;\n}\nexport const view = <Greeting />;`;
  const plain = compile(source, { filename: '/private/project/Greeting.tsx', jsxImportSource: runtime, sourceMap: false });
  const annotated = compile(source, { filename: '/private/project/Greeting.tsx', jsxImportSource: runtime, sourceMap: false, hydrationDiagnostics: true });
  assert.doesNotMatch(plain, /__clankSource/); assert.doesNotMatch(annotated, /private\/project/);
  const module = await import(`data:text/javascript,${encodeURIComponent(annotated)}`), view = module.view, section = view.type(view.props);
  assert.deepEqual(view.source, { file: 'Greeting.tsx', line: 6, column: 21 });
  assert.deepEqual(section.source, { file: 'Greeting.tsx', line: 2, column: 10 });
  assert.deepEqual(section.props.children[0].source, { file: 'Greeting.tsx', line: 3, column: 5 });
  const original = await import(`data:text/javascript,${encodeURIComponent(plain)}`);
  const { renderToString } = await import('../dist/ssr.js');
  assert.equal(await renderToString(view), await renderToString(original.view), 'annotations do not become props, HTML or IDs');
  assert.throws(() => transformTSX('const v = <p/>', { hydrationDiagnostics: 'true' }), /boolean/);
  assert.throws(() => transformTSX('const v = <p/>', { hydrationDiagnostics: true, filename: 'bad?token=secret.tsx' }), /basename/);
});
