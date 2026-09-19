import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { h, matchRoutes, renderToString, staticFiles } from "../dist/index.js";

test("SSR validates coerced URLs and object resource URLs", async () => {
  for (const [tag, name, value] of [
    ["a", "href", ["javascript:alert(1)"]],
    ["a", "href", { toString: () => "java\nscript:alert(1)" }],
    ["iframe", "src", ["data:text/html,<script>alert(1)</script>"]],
    ["form", "action", ["javascript:alert(1)"]],
    ["object", "data", "data:text/html,<script>alert(1)</script>"],
    ["object", "data", "javascript:alert(1)"],
  ]) {
    await assert.rejects(renderToString(h(tag, { [name]: value })), /Unsafe (?:data URL|URL scheme)/);
  }
  assert.match(await renderToString(h("a", { href: new URL("https://example.test/safe") })), /href="https:\/\/example.test\/safe"/);
  assert.match(await renderToString(h("img", { src: "data:image/png;base64,AA==" })), /data:image\/png/);
});

test("static dotfile denial applies to symlink targets and directory indexes", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-static-security-"));
  try {
    await mkdir(join(root, ".private"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, ".env"), "synthetic private configuration");
    await writeFile(join(root, ".private", "index.html"), "synthetic private index");
    await writeFile(join(root, "safe.txt"), "public content");
    await symlink(".env", join(root, "public.txt"));
    await symlink(".private", join(root, "public"));
    await symlink("../.env", join(root, "docs", "index.html"));
    await symlink("safe.txt", join(root, "alias.txt"));
    const files = staticFiles(root);
    for (const path of ["/.env", "/public.txt", "/public/index.html", "/public/", "/docs/"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await files.handle(new Request(`https://example.test${path}`, { method }));
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.doesNotMatch(await response.text(), /synthetic private/);
      }
    }
    assert.equal(await (await files.handle(new Request("https://example.test/alias.txt"))).text(), "public content");
    const allowed = staticFiles(root, { dotfiles: "allow" });
    assert.equal((await allowed.handle(new Request("https://example.test/public.txt"))).status, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("query keys remain own data properties without changing the result prototype", () => {
  const result = matchRoutes([{ path: "/", component: () => null }],
    "https://example.test/?__proto__=first&__proto__=second&constructor=own&toString=text");
  assert.equal(Object.getPrototypeOf(result.query), Object.prototype);
  assert.equal(Object.hasOwn(result.query, "__proto__"), true);
  assert.deepEqual(result.query.__proto__, ["first", "second"]);
  assert.equal(result.query.constructor, "own");
  assert.equal(result.query.toString, "text");
  assert.equal(result.query[0], undefined);
});
