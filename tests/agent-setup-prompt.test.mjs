import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { agentSetupPrompt } from "../dist/agent-setup-prompt.js";
import { platformMarketingPage } from "../dist/platform-marketing.js";

test("marketing publishes the complete canonical setup prompt with a working copy action", async () => {
  const guide = await readFile(new URL("../docs/getting-started.md", import.meta.url), "utf8");
  const canonical = guide.split("\n## Set up with an agent\n")[1].match(/```text\n([\s\S]*?)\n```/u)[1];
  assert.equal(agentSetupPrompt, canonical);
  const response = await platformMarketingPage("https://clank.run");
  const html = await response.text();
  const rendered = html.match(/<code id="agent-setup-prompt-text">([\s\S]*?)<\/code>/u)[1]
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
  assert.equal(rendered, canonical);
  const script = html.match(/<script>([\s\S]*?)<\/script>/iu)[1];

  for (const clipboardAvailable of [true, false]) {
    let click;
    let written;
    let selected;
    let focused = false;
    const button = { textContent: "Copy setup prompt", isConnected: true, setAttribute() {}, removeAttribute() {}, addEventListener(_, handler) { click = handler; } };
    const source = { textContent: rendered, closest: () => ({ focus() { focused = true; } }) };
    const status = { textContent: "" };
    const selection = { removeAllRanges() {}, addRange(range) { selected = range.source.textContent; }, toString() { return selected; } };
    runInNewContext(script, {
      document: {
        getElementById: (id) => id === "agent-setup-prompt-text" ? source : status,
        querySelectorAll: () => [button],
        getSelection: () => selection,
        createRange: () => ({ selectNodeContents(element) { this.source = element; } }),
      },
      navigator: { clipboard: { async writeText(value) { if (!clipboardAvailable) throw new Error("denied"); written = value; } } },
      setTimeout() {}, clearTimeout() {},
    });
    await click();
    if (clipboardAvailable) {
      assert.equal(written, canonical);
      assert.equal(button.textContent, "Copied");
      assert.match(status.textContent, /Setup prompt copied/);
      assert.equal(focused, false);
    } else {
      assert.equal(selected, canonical);
      assert.equal(button.textContent, "Prompt selected");
      assert.match(status.textContent, /browser’s Copy command/);
      assert.equal(focused, true);
    }
  }
});
