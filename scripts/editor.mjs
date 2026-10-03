import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from './compiler.mjs';

/** A dependency-free Language Server Protocol endpoint for Clank-specific editor support. */
export async function runEditor({ input = process.stdin, output = process.stdout, root = process.cwd() } = {}) {
  const documents = new Map(), symbols = new Map();
  const distribution = new URL('../dist/', import.meta.url);
  for (const file of await readdir(distribution)) if (file.endsWith('.d.ts')) {
    const source = await readFile(new URL(file, distribution), 'utf8');
    for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(function|class|interface|type|const)\s+([\w$]+)/g)) {
      if (!symbols.has(match[2])) symbols.set(match[2], { label: match[2], kind: match[1] === 'function' ? 3 : match[1] === 'class' ? 7 : 8, detail: `Clank · ${file}`, documentation: `https://docs.clank.run/docs/${file.slice(0, -5)}` });
    }
  }
  const send = value => { const payload = JSON.stringify(value); output.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`); };
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const validUri = uri => {
    try { const path = fileURLToPath(uri), rel = relative(resolve(root), path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && /\.(?:ts|tsx|mts)$/.test(path); } catch { return false; }
  };
  const diagnostics = (uri, document) => {
    let found = [];
    try { compile(document.text, { filename: fileURLToPath(uri), sourceMap: false }); }
    catch (cause) {
      const message = String(cause.message).slice(0, 4000), position = /(?:at |\b)(\d+):(\d+)\b/.exec(message);
      const line = position ? Math.max(0, Number(position[1]) - 1) : 0, character = position ? Math.max(0, Number(position[2]) - 1) : 0;
      found = [{ range: { start: { line, character }, end: { line, character: character + 1 } }, severity: 1, source: 'clank', message }];
    }
    notify('textDocument/publishDiagnostics', { uri, version: document.version, diagnostics: found });
  };
  let initialized = false, shutdown = false, exited = false;
  const handle = message => {
    const { id, method, params = {} } = message;
    if (message.jsonrpc !== '2.0' || typeof method !== 'string') { if (id !== undefined) error(id, -32600, 'Invalid JSON-RPC request.'); return; }
    if (method === 'initialize') { if (initialized) { error(id, -32600, 'Already initialized.'); return; } initialized = true; reply(id, { capabilities: { textDocumentSync: { openClose: true, change: 1 }, completionProvider: { triggerCharacters: ['.'] }, hoverProvider: true }, serverInfo: { name: 'Clank editor', version: '1' } }); return; }
    if (method === 'exit') { exited = true; return; }
    if (!initialized || shutdown) { if (id !== undefined) error(id, -32002, 'Editor server is not initialized.'); return; }
    if (method === 'shutdown') { shutdown = true; reply(id, null); return; }
    const uri = params.textDocument?.uri;
    if (method === 'textDocument/didOpen' || method === 'textDocument/didChange') {
      const text = method.endsWith('didOpen') ? params.textDocument.text : params.contentChanges?.length === 1 && params.contentChanges[0].range === undefined ? params.contentChanges[0].text : undefined;
      const version = params.textDocument?.version;
      if (!validUri(uri) || typeof text !== 'string' || Buffer.byteLength(text) > 1048576 || !Number.isSafeInteger(version) || documents.size >= 100 && !documents.has(uri) || documents.has(uri) && version <= documents.get(uri).version) return;
      const document = { text, version }; documents.set(uri, document); diagnostics(uri, document); return;
    }
    if (method === 'textDocument/didClose') { if (documents.delete(uri)) notify('textDocument/publishDiagnostics', { uri, diagnostics: [] }); return; }
    if (method === 'textDocument/completion' || method === 'textDocument/hover') {
      const document = documents.get(uri), line = params.position?.line, character = params.position?.character;
      if (!document || !Number.isSafeInteger(line) || !Number.isSafeInteger(character) || line < 0 || character < 0) { reply(id, method.endsWith('completion') ? [] : null); return; }
      const text = document.text.split('\n')[line] ?? '', before = text.slice(0, character), prefix = /[\w$]*$/.exec(before)[0];
      if (method.endsWith('completion')) { const items = [...symbols.values()].filter(item => item.label.startsWith(prefix)); reply(id, { isIncomplete: items.length > 200, items: items.slice(0, 200) }); }
      else { const word = prefix + (/^[\w$]*/.exec(text.slice(character))[0]), symbol = symbols.get(word); reply(id, symbol ? { contents: { kind: 'markdown', value: `**${symbol.label}** — ${symbol.detail}\n\nClank framework API. See [documentation](https://docs.clank.run).` } } : null); }
      return;
    }
    if (id !== undefined) error(id, -32601, 'Method not supported.');
  };
  let buffer = Buffer.alloc(0), expected = null;
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (buffer.byteLength > 4194304 + 8192) throw new Error('Editor message exceeds 4 MiB.');
    while (true) {
      if (expected === null) {
        const index = buffer.indexOf('\r\n\r\n'); if (index < 0) { if (buffer.length > 8192) throw new Error('Editor header exceeds 8 KiB.'); break; }
        if (index > 8192) throw new Error('Editor header exceeds 8 KiB.');
        const matches = [...buffer.subarray(0, index).toString().matchAll(/^Content-Length: (\d+)\r?$/gim)];
        if (matches.length !== 1 || Number(matches[0][1]) > 4194304) throw new Error('Invalid editor content length.');
        expected = Number(matches[0][1]); buffer = buffer.subarray(index + 4);
      }
      if (buffer.length < expected) break;
      const payload = buffer.subarray(0, expected).toString(); buffer = buffer.subarray(expected); expected = null;
      try { const value = JSON.parse(payload); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); handle(value); } catch { error(null, -32700, 'Malformed editor message.'); }
      if (exited) return;
    }
  }
}
