import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const pass = (message) => console.log(`security: ${message}`);
const fail = (message) => failures.push(message);
const read = (relative) => readFile(path.join(root, relative), "utf8");

const packageJson = JSON.parse(await read("package.json"));
for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  if (packageJson[field] && Object.keys(packageJson[field]).length > 0) {
    fail(`package.json contains ${field}; Clank's runtime and release gate must remain dependency-free.`);
  }
}
if (packageJson.name !== "clank.run") fail("The official published package name must be clank.run.");
if (packageJson.publishConfig?.access !== "public") fail("npm publishing must be explicitly public.");
if (packageJson.bin?.clank !== "./scripts/clank.mjs") fail("The clank CLI entry point is missing or unexpected.");
if (packageJson.engines?.node !== ">=22.16") fail("The minimum supported Node release must remain exactly >=22.16.");
pass("zero-dependency package metadata is constrained");

const required = [
  "SECURITY.md",
  "LICENSE",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/release.yml",
  "docs/security-asvs.md",
  "docs/threat-model.md",
  "docs/chaos-testing.md",
  "docs/public-beta.md",
];
for (const relative of required) {
  try { await read(relative); }
  catch { fail(`Required security or governance file is missing: ${relative}`); }
}
pass("security policy, ownership, static analysis, and readiness evidence are present");

const workflows = await Promise.all([
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/release.yml",
].map(async (relative) => [relative, await read(relative)]));
for (const [relative, source] of workflows) {
  for (const match of source.matchAll(/uses:\s*([^\s@]+)@([^\s#]+)/gu)) {
    if (!/^[a-f0-9]{40}$/u.test(match[2])) {
      fail(`${relative} does not pin ${match[1]} to an immutable commit SHA.`);
    }
  }
  if (/uses:\s*actions\/checkout@/u.test(source) && !/persist-credentials:\s*false/u.test(source)) {
    fail(`${relative} must disable persisted checkout credentials.`);
  }
}
const ci = workflows.find(([relative]) => relative.endsWith("/ci.yml"))?.[1] ?? "";
const codeql = workflows.find(([relative]) => relative.endsWith("/codeql.yml"))?.[1] ?? "";
const release = workflows.find(([relative]) => relative.endsWith("/release.yml"))?.[1] ?? "";
if (!/permissions:\s*\n\s*contents:\s*read/u.test(ci)) fail("CI must use read-only repository contents permission.");
if (!/security-events:\s*write/u.test(codeql)) fail("CodeQL must be able to upload security results.");
if (!/id-token:\s*write/u.test(release) || !/npm publish/u.test(release)) {
  fail("The release workflow must use npm trusted publishing through GitHub OIDC.");
}
if (/NODE_AUTH_TOKEN|NPM_TOKEN/u.test(release)) {
  fail("The release workflow must not depend on a long-lived npm token.");
}
pass("GitHub Actions are immutable and least-privilege oriented");

const packed = await command(process.platform === "win32" ? "npm.cmd" : "npm", [
  "pack",
  "--dry-run",
  "--json",
  "--ignore-scripts",
]);
let packResult;
try {
  const start = packed.stdout.indexOf("[");
  const end = packed.stdout.lastIndexOf("]");
  packResult = JSON.parse(packed.stdout.slice(start, end + 1))[0];
} catch {
  fail(`npm pack did not return valid JSON: ${packed.stderr || packed.stdout}`);
}
const files = packResult?.files ?? [];
const forbiddenPackagePath = /(?:^|\/)(?:node_modules|\.clank|\.clank-platform|\.proact|\.proact-platform)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:sqlite(?:-(?:shm|wal))?|db|pem|p12|pfx|key)$/iu;
for (const file of files) {
  if (forbiddenPackagePath.test(file.path)) fail(`Sensitive or stateful file would be published: ${file.path}`);
}
for (const expected of ["README.md", "SECURITY.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) {
  if (!files.some((file) => file.path === expected)) fail(`Published package is missing ${expected}.`);
}
if ((packResult?.entryCount ?? 0) > 250) fail("Published package unexpectedly exceeds 250 files.");
if ((packResult?.unpackedSize ?? 0) > 5 * 1024 * 1024) fail("Published package unexpectedly exceeds 5 MiB unpacked.");
pass(`publish allowlist contains ${packResult?.entryCount ?? 0} bounded files`);

const secretPatterns = [
  ["private key", new RegExp(`-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE ${"KEY"}-----`, "u")],
  ["GitHub token", new RegExp(`gh[opusr]_[A-Za-z0-9]{36,}`, "u")],
  ["npm token", new RegExp(`${"npm"}_[A-Za-z0-9]{36,}`, "u")],
  ["AWS access key", new RegExp(`AKIA[0-9A-Z]{16}`, "u")],
  ["Slack token", new RegExp(`xox[baprs]-[A-Za-z0-9-]{20,}`, "u")],
];
const textFile = /\.(?:c?js|mjs|ts|tsx|json|md|html|css|sql|txt|d\.mts)$/iu;
for (const file of files) {
  if (!textFile.test(file.path)) continue;
  const source = await read(file.path);
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(source)) fail(`Published file ${file.path} contains a high-confidence ${label} pattern.`);
  }
}
pass("published text files contain no high-confidence credential material");

if (failures.length > 0) {
  for (const failure of failures) console.error(`security audit failed: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Security audit passed.");
}

function command(executable, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: root,
      env: { ...process.env, npm_config_loglevel: "silent" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${executable} exited with ${code}: ${stderr || stdout}`)));
  });
}
