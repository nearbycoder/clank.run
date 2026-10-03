import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { runEditor } from '../scripts/editor.mjs';
import { runnableExamples } from '../scripts/docs-examples.mjs';
const wire = value => { const text = JSON.stringify(value); return `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`; };
async function session(messages, raw) {
  const chunks = raw ?? messages.map(wire), replies = []; let buffer = '';
  const output = new Writable({ write(chunk, _encoding, next) { buffer += chunk; next(); } });
  await runEditor({ input: Readable.from(chunks), output });
  while (buffer) { const index = buffer.indexOf('\r\n\r\n'), size = Number(/Content-Length: (\d+)/.exec(buffer.slice(0, index))[1]); const bytes = Buffer.from(buffer.slice(index + 4)); replies.push(JSON.parse(bytes.subarray(0, size))); buffer = bytes.subarray(size).toString(); }
  return replies;
}
test('LSP initialization, live TSX diagnostics, stale edits, completion and shutdown use framed stdio', async () => {
  const uri = pathToFileURL(`${process.cwd()}/editor-fixture.tsx`).href;
  const replies = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, version: 1, text: 'const view = <a></b>;' } } },
    { jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'signal' }] } },
    { jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: 1 }, contentChanges: [{ text: 'const invalid = ;' }] } },
    { jsonrpc: '2.0', id: 2, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 0, character: 3 } } },
    { jsonrpc: '2.0', id: 3, method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 0, character: 3 } } },
    { jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } },
    { jsonrpc: '2.0', id: 4, method: 'shutdown' }, { jsonrpc: '2.0', method: 'exit' },
  ]);
  assert.equal(replies[0].result.capabilities.textDocumentSync.change, 1);
  const diagnostics = replies.filter(row => row.method === 'textDocument/publishDiagnostics');
  assert.equal(diagnostics.length, 3); assert.equal(diagnostics[0].params.diagnostics[0].severity, 1); assert.deepEqual(diagnostics[1].params.diagnostics, []);
  assert.ok(replies.find(row => row.id === 2).result.items.some(row => row.label === 'signal'));
  assert.match(replies.find(row => row.id === 3).result.contents.value, /signal/);
});
test('editor rejects oversized framing and keeps documents outside its workspace out of analysis', async () => {
  await assert.rejects(session([], ['Content-Length: 99999999\r\n\r\n']), /content length/);
  await assert.rejects(session([], ['x'.repeat(8193)]), /header/);
  await assert.rejects(session([], ['X-Padding: '+ 'x'.repeat(8200) + '\r\nContent-Length: 2\r\n\r\n{}']), /header/);
  const replies = await session([{ jsonrpc: '2.0', id: 1, method: 'initialize' }, { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///outside.ts', version: 1, text: 'invalid{' } } }]);
  assert.equal(replies.length, 1);
});
test('runnable documentation markers require unique explicit identities and standalone code fences', () => {
  const code = '```ts clank-run=one\nconst x: number = 1;\n```\n';
  assert.equal(runnableExamples(code, 'guide.md')[0].line, 2);
  assert.throws(() => runnableExamples(code + code, 'guide.md'), /duplicate/);
  assert.throws(() => runnableExamples('```ts clank-run\nconst x=1;\n```', 'guide.md'), /malformed/);
});
