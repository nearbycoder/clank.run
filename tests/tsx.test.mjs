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
  assert.doesNotThrow(() => stripTypeScriptTypes(result.code, { mode: "transform" }));
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
