import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, access, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = new URL("../scripts/clank.mjs", import.meta.url);

async function command(args) {
  try {
    const result = await execute(process.execPath, [cli.pathname, ...args], {
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 1024 * 1024,
    });
    return { status: 0, ...result };
  } catch (error) {
    return {
      status: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

test("journey CLI help is focused and agent-readable", async () => {
  const human = await command(["journey", "--help"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /semantic acceptance journeys/u);
  assert.match(human.stdout, /--cdp <loopback-url>/u);

  const agent = await command(["help", "journey", "--json"]);
  assert.equal(agent.status, 0, agent.stderr);
  const payload = JSON.parse(agent.stdout);
  assert.equal(payload.protocol, "clank-cli-help/1");
  assert.equal(payload.command, "journey");
  assert.match(payload.usage, /journey\.json/u);
});

test("journey CLI validates data and browser boundaries before connecting", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-journey-cli-"));
  const path = join(root, "journey.json");
  await writeFile(path, JSON.stringify({
    name: "CLI boundary",
    steps: [{ expect: { text: "Ready" } }],
  }));
  try {
    const external = await command(["journey", path, "--cdp=https://browser.example", "--json"]);
    assert.equal(external.status, 1);
    const externalError = JSON.parse(external.stderr.trim());
    assert.match(externalError.error.message, /HTTP loopback endpoint/);

    const conflict = await command([
      "journey",
      path,
      "--browser=/missing/chrome",
      "--cdp=http://127.0.0.1:9222",
      "--json",
    ]);
    assert.equal(conflict.status, 1);
    assert.match(JSON.parse(conflict.stderr.trim()).error.message, /either --browser or --cdp/);

    const missing = await command(["journey", path, "--browser=/definitely/missing/chrome", "--json"]);
    assert.equal(missing.status, 1);
    assert.match(JSON.parse(missing.stderr.trim()).error.message, /Chrome or Chromium was not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journey CLI refuses a loopback endpoint that returns a network WebSocket", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-journey-cdp-"));
  const path = join(root, "journey.json");
  await writeFile(path, JSON.stringify({ name: "CDP confinement", steps: [{ expect: { text: "Ready" } }] }));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "target",
      webSocketDebuggerUrl: "ws://browser.attacker.example/devtools/page/target",
    }));
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  try {
    const address = server.address();
    const result = await command(["journey", path, `--cdp=http://127.0.0.1:${address.port}`, "--json"]);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stderr.trim()).error.message, /WebSocket outside the loopback control endpoint/);
  } finally {
    await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(root, { recursive: true, force: true });
  }
});

test('journey CLI detects terminated startup and removes its own profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clank-journey-startup-')), browser = join(root, 'browser.mjs'), journal = join(root, 'profile.txt'), journey = join(root, 'journey.json');
  await writeFile(journey, JSON.stringify({ name: 'Startup failure', steps: [{ expect: { text: 'Ready' } }] }));
  await writeFile(browser, '#!'+process.execPath+'\nimport { writeFileSync } from "node:fs";\nconst profile = process.argv.find(value => value.startsWith("--user-data-dir=")).slice(16);\nwriteFileSync('+JSON.stringify(journal)+', profile);\nprocess.kill(process.pid, "SIGTERM");\n');
  await chmod(browser, 0o700);
  try {
    const started = Date.now(), result = await command(['journey', journey, '--browser='+(process.platform === 'win32' ? process.execPath : browser), '--json']);
    const message = JSON.parse(result.stderr.trim()).error.message;
    assert.equal(result.status, 1); assert.match(message, /Chrome exited before DevTools started/);
    assert.ok(Date.now() - started < 8000, 'signal termination must be noticed before the 15-second startup timeout');
    const profile = process.platform === 'win32' ? message.match(/--user-data-dir=([^\r\n]+)/)?.[1] : await readFile(journal, 'utf8'); assert.match(profile, /clank-journey-/);
    await assert.rejects(access(profile), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
