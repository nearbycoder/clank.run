import { createServer } from "node:http";
import { watch } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const example = join(root, "examples", "hello");
const port = Number(process.env.PORT ?? 4173);
let building = build({ quiet: true });
let debounce;

async function rebuild() {
  clearTimeout(debounce);
  debounce = setTimeout(async () => {
    try {
      building = build({ quiet: true });
      await building;
      console.log("Rebuilt Clank.");
    } catch (error) {
      console.error(error);
    }
  }, 50);
}

async function watchTree(directory) {
  watch(directory, (_event, filename) => {
    if (!filename || /\.tsx?$/.test(String(filename))) void rebuild();
  });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await watchTree(join(directory, entry.name));
  }
}

await building;
await Promise.all([watchTree(join(root, "src")), watchTree(join(root, "examples"))]);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
};

const resolvedRoots = new Map();
async function safePath(base, pathname) {
  let resolvedBase = resolvedRoots.get(base);
  if (!resolvedBase) {
    resolvedBase = await realpath(base);
    resolvedRoots.set(base, resolvedBase);
  }
  const candidate = resolve(resolvedBase, `.${normalize(pathname)}`);
  if (candidate !== resolvedBase && !candidate.startsWith(resolvedBase + sep)) return null;
  const resolvedCandidate = await realpath(candidate);
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(resolvedBase + sep)
    ? resolvedCandidate
    : null;
}

async function handle(request, response) {
  await building;
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
  let path = null;
  try {
    if (url.pathname === "/") path = await safePath(example, "/index.html");
    else if (url.pathname.startsWith("/dist/")) path = await safePath(root, pathname);
    else if (url.pathname.startsWith("/examples/")) path = await safePath(root, pathname);
    else if (url.pathname.startsWith("/docs/") || url.pathname === "/README.md") path = await safePath(root, pathname);
    else path = await safePath(example, pathname);
    if (!path || !(await stat(path)).isFile()) throw new Error("missing");
    const body = await readFile(path);
    response.writeHead(200, {
      "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end(`Not found: ${relative(root, path ?? root)}`);
  }
}

createServer({
  maxHeaderSize: 16 * 1024,
  headersTimeout: 15_000,
  requestTimeout: 30_000,
}, (request, response) => {
  void handle(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) {
      response.writeHead(500, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
    }
    response.end("Development server failed.");
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`Clank dev server: http://127.0.0.1:${port}`);
});
