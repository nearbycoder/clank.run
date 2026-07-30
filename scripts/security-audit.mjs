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
const escapedPackageVersion = packageJson.version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const [changelog, gettingStarted] = await Promise.all([
  read("CHANGELOG.md"),
  read("docs/getting-started.md"),
]);
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageJson.version)) {
  fail("The package version must be a valid release semantic version.");
}
if (!new RegExp(`^## ${escapedPackageVersion} - \\d{4}-\\d{2}-\\d{2}$`, "mu").test(changelog)) {
  fail(`CHANGELOG.md must contain a dated ${packageJson.version} release heading.`);
}
if (!gettingStarted.includes(`"@clank.run/framework": "^${packageJson.version}"`)) {
  fail("The Getting Started dependency example must match the package version.");
}
pass("release identity is synchronized across package metadata, changelog, and installation docs");
for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  if (packageJson[field] && Object.keys(packageJson[field]).length > 0) {
    fail(`package.json contains ${field}; Clank's runtime and release gate must remain dependency-free.`);
  }
}
if (packageJson.name !== "@clank.run/framework") {
  fail("The official published package name must be @clank.run/framework.");
}
if (packageJson.homepage !== "https://docs.clank.run") fail("The npm homepage must point to the documentation site.");
if (packageJson.repository?.url !== "git+https://github.com/nearbycoder/clank.run.git") {
  fail("The npm repository must match the public GitHub source exactly.");
}
if (packageJson.license !== "MIT") fail("The npm package must declare its MIT license.");
if (packageJson.publishConfig?.access !== "public") fail("npm publishing must be explicitly public.");
if (packageJson.publishConfig?.registry !== "https://registry.npmjs.org/") {
  fail("npm publishing must be pinned to the public npm registry.");
}
if (packageJson.publishConfig?.provenance !== true) {
  fail("npm publishing must request provenance.");
}
if (packageJson.bin?.clank !== "scripts/clank.mjs") fail("The clank CLI entry point is missing or unexpected.");
if (packageJson.bin?.["clank-platform"] !== "scripts/clank-platform.mjs") {
  fail("The clank-platform CLI entry point is missing or unexpected.");
}
if (packageJson.engines?.node !== ">=22.16") fail("The minimum supported Node release must remain exactly >=22.16.");
if (packageJson.packageManager !== "npm@11.18.0") fail("The release npm version must remain pinned to 11.18.0.");
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
  ".github/workflows/docs-deploy.yml",
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
  ".github/workflows/docs-deploy.yml",
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
const docsDeploy = workflows.find(([relative]) => relative.endsWith("/docs-deploy.yml"))?.[1] ?? "";
const release = workflows.find(([relative]) => relative.endsWith("/release.yml"))?.[1] ?? "";
if (!/permissions:\s*\n\s*contents:\s*read/u.test(ci)) fail("CI must use read-only repository contents permission.");
if (!/security-events:\s*write/u.test(codeql)) fail("CodeQL must be able to upload security results.");
if (!/permissions:\s*\n\s*contents:\s*read/u.test(docsDeploy)
  || !/workflow_run\.conclusion == 'success'/u.test(docsDeploy)
  || !/workflow_run\.event == 'push'/u.test(docsDeploy)
  || !/workflow_run\.head_branch == 'main'/u.test(docsDeploy)
  || !/workflow_run\.head_repository\.full_name == github\.repository/u.test(docsDeploy)
  || !/ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u.test(docsDeploy)) {
  fail("Documentation deployment must use the exact successful, same-repository main CI revision.");
}
if (!/environment:\s*\n\s*name:\s*docs/u.test(docsDeploy)
  || !/\$\{\{ secrets\.CLANK_DOCS_TOKEN \}\}/u.test(docsDeploy)
  || !/\$\{\{ vars\.CLANK_DOCS_PROJECT_ID \}\}/u.test(docsDeploy)) {
  fail("Documentation deployment must isolate its project-scoped identity in the docs environment.");
}
if (!/id-token:\s*write/u.test(release) || !/npm stage publish --access public/u.test(release)) {
  fail("The release workflow must use public npm staged publishing through GitHub OIDC.");
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
if (packResult?.name !== packageJson.name) fail("npm pack changed the scoped package identity.");
if (packResult?.version !== packageJson.version) fail("npm pack changed the package version.");
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
  ["Google API key", new RegExp(`AI${"za"}[0-9A-Za-z_-]{35}`, "u")],
  ["Stripe live secret", new RegExp(`sk_${"live"}_[0-9A-Za-z]{20,}`, "u")],
  ["SendGrid API key", new RegExp(`S${"G"}\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}`, "u")],
  ["GitLab access token", new RegExp(`gl${"pat"}-[A-Za-z0-9_-]{20,}`, "u")],
  ["OpenAI project key", new RegExp(`sk-${"proj"}-[A-Za-z0-9_-]{20,}`, "u")],
];
const textFile = /(?:^|\/)(?:Dockerfile|Caddyfile|Makefile)$|\.(?:c?js|mjs|ts|tsx|json|jsonc|md|html|css|sql|txt|d\.mts|ya?ml|toml|ini|conf|sh|ps1|xml)$/iu;
for (const file of files) {
  if (!textFile.test(file.path)) continue;
  const source = await read(file.path);
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(source)) fail(`Published file ${file.path} contains a high-confidence ${label} pattern.`);
  }
}
pass("published text files contain no high-confidence credential material");

const repositoryListing = await command("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
const repositoryFiles = repositoryListing.stdout.split("\0").filter(Boolean);
for (const relative of repositoryFiles) {
  if (!textFile.test(relative)) continue;
  let source;
  try { source = await read(relative); }
  catch { continue; }
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(source)) fail(`Repository file ${relative} contains a high-confidence ${label} pattern.`);
  }
}
pass(`current repository files contain no high-confidence credential material`);

const history = await command("git", ["log", "--all", "--format=fuller", "-p", "--no-ext-diff", "--text"]);
for (const [label, pattern] of secretPatterns) {
  if (pattern.test(history.stdout)) fail(`Git history contains a high-confidence ${label} pattern.`);
}
pass("complete reachable Git history contains no high-confidence credential material");

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
