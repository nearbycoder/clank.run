import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from './compiler.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export function runnableExamples(source, filename) {
  const result = [], ids = new Set();
  const pattern = /^```(ts|tsx|js) clank-run=([a-z][a-z0-9-]{0,79})\r?\n([\s\S]*?)^```\s*$/gm;
  for (const match of source.matchAll(pattern)) {
    if (ids.has(match[2])) throw new Error(`${filename}: duplicate runnable example ${match[2]}`);
    ids.add(match[2]); result.push({ id: match[2], language: match[1], source: match[3], line: source.slice(0, match.index).split('\n').length + 1, filename });
  }
  const declarations = [...source.matchAll(/^```[^\n]*clank-run[^\n]*$/gm)];
  if (declarations.length !== result.length) throw new Error(`${filename}: malformed runnable example marker.`);
  return result;
}
export async function runDocumentationExamples() {
  const examples = [];
  const walk = async directory => { for (const entry of await readdir(directory, { withFileTypes: true })) { if (entry.isSymbolicLink()) continue; const path = join(directory, entry.name); if (entry.isDirectory()) await walk(path); else if (entry.name.endsWith('.md')) examples.push(...runnableExamples(await readFile(path, 'utf8'), path)); } };
  await walk(join(root, 'docs'));
  if (!examples.length) throw new Error('No runnable documentation examples found.');
  const temporary = await mkdtemp(join(tmpdir(), 'clank-doc-examples-'));
  try {
    await mkdir(join(temporary, 'node_modules', '@clank.run'), { recursive: true });
    await symlink(root, join(temporary, 'node_modules', '@clank.run', 'framework'), 'dir');
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
    for (const [index, example] of examples.entries()) {
      const path = join(temporary, `example-${index}.mjs`);
      await writeFile(path, compile(example.source, { filename: `${example.filename}:${example.line}.${example.language}`, sourceMap: false }));
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--max-old-space-size=128', path], { cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLANK_DOC_EXAMPLE: '1' } });
        let output = '', failed = false;
        const stop = message => { failed = true; child.kill('SIGKILL'); reject(new Error(`${example.filename}:${example.line} (${example.id}): ${message}`)); };
        const timer = setTimeout(() => stop('exceeded 10 seconds'), 10000);
        const record = chunk => { output += chunk; if (output.length > 65536) stop('output exceeded 64 KiB'); };
        child.stdout.on('data', record); child.stderr.on('data', record);
        child.once('error', cause => { clearTimeout(timer); reject(cause); });
        child.once('close', code => { clearTimeout(timer); if (!failed) code === 0 ? resolve() : reject(new Error(`${example.filename}:${example.line} (${example.id}) failed:\n${output}`)); });
      });
    }
    console.log(`Runnable documentation passed: ${examples.length} examples.`);
    return examples.length;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runDocumentationExamples();
