import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { defineJourney, runJourney } from "../dist/journey.js";

const MAX_JOURNEY_FILE_BYTES = 1024 * 1024;
const MAX_JOURNEYS = 50;

export async function runJourneyCommand(args) {
  if (flag(args, "help")) {
    console.log(`Replay semantic browser journeys in an isolated real Chrome profile.

Usage:
  clank journey [journey.json|journey.mjs] [--url http://127.0.0.1:3000]
    [--browser <chrome-executable> | --cdp http://127.0.0.1:9222]
    [--headed] [--output <report.json>] [--json]

Journey steps use stable agentId/native IDs, not CSS selectors. Chrome is launched without
--no-sandbox; --cdp accepts loopback endpoints only. JavaScript journey modules execute as local
code, so use JSON for data-only untrusted proposals.`);
    return;
  }
  const values = positionalArguments(args);
  if (values.length > 1) throw new Error("Usage: clank journey [journey.json|journey.mjs] [options]");
  const sourcePath = resolve(values[0] ?? "journey.json");
  const baseUrl = applicationUrl(option(args, "url") ?? "http://127.0.0.1:3000");
  if (option(args, "browser") && option(args, "cdp")) {
    throw new Error("Choose either --browser or --cdp, not both.");
  }
  const journeys = await loadJourneys(sourcePath);
  const outputPath = option(args, "output") ? resolve(option(args, "output")) : null;
  const json = flag(args, "json");
  const browser = await openBrowser({
    executable: option(args, "browser") ?? process.env.CLANK_CHROME_EXECUTABLE,
    cdp: option(args, "cdp"),
    headed: flag(args, "headed"),
    viewport: journeys[0]?.viewport,
  });
  const reports = [];
  let screenshot;
  try {
    for (const journey of journeys) {
      const beforeExceptions = browser.exceptions.length;
      let report = await runJourney(journey, browser.driver, {
        baseUrl,
        timeoutMs: positiveInteger(option(args, "timeout") ?? 120, "--timeout", 1, 600) * 1_000,
        resolveSecret(name) {
          const value = process.env[name];
          if (value !== undefined) browser.addSecret(value);
          return value;
        },
        ...(!json ? {
          onStep(step) {
            const detail = step.target ?? step.label ?? step.kind;
            console.log(`${step.status === "passed" ? "✓" : "✗"} ${step.index + 1}. ${step.kind} ${detail}`);
          },
        } : {}),
      });
      const exception = browser.exceptions.slice(beforeExceptions)[0];
      if (report.ok && exception) {
        report = Object.freeze({
          ...report,
          ok: false,
          error: `Unhandled page exception: ${exception}`,
        });
      }
      reports.push(report);
      if (!report.ok) {
        if (outputPath && !browser.hasSecrets()) {
          try {
            screenshot = screenshotPath(outputPath);
            await writeBinaryAtomically(screenshot, Buffer.from(await browser.screenshot(), "base64"));
          } catch {
            screenshot = undefined;
          }
        }
        break;
      }
    }
  } finally {
    await browser.close();
  }
  const suite = Object.freeze({
    protocol: "clank-journey-suite/1",
    ok: reports.length === journeys.length && reports.every((report) => report.ok),
    baseOrigin: new URL(baseUrl).origin,
    reports: Object.freeze(reports),
    ...(screenshot ? { screenshot } : {}),
  });
  if (outputPath) await writeTextAtomically(outputPath, `${JSON.stringify(suite, null, 2)}\n`);
  if (json) console.log(JSON.stringify(suite));
  else {
    console.log(suite.ok
      ? `Passed ${reports.length} browser journey${reports.length === 1 ? "" : "s"}.`
      : `Browser journey failed: ${reports.at(-1)?.error ?? "Unknown failure."}`);
    if (outputPath) console.log(`Report: ${outputPath}`);
    if (screenshot) console.log(`Failure screenshot: ${screenshot}`);
  }
  if (!suite.ok) process.exitCode = 1;
  return suite;
}

async function loadJourneys(path) {
  const extension = extname(path).toLowerCase();
  let value;
  if (extension === ".json") {
    const source = await boundedRead(path);
    try { value = JSON.parse(source); } catch { throw new Error(`Journey JSON is invalid: ${path}`); }
  } else if (extension === ".mjs" || extension === ".js") {
    await boundedRead(path);
    const module = await import(`${pathToFileURL(path).href}?clank-journey=${Date.now()}`);
    value = module.default ?? module.journeys;
  } else {
    throw new Error("Journey files must use .json, .mjs, or .js. Use JSON for data-only agent proposals.");
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.journeys)) {
    value = value.journeys;
  }
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0 || entries.length > MAX_JOURNEYS) {
    throw new Error(`A journey suite must contain from 1 through ${MAX_JOURNEYS} journeys.`);
  }
  return entries.map((entry) => defineJourney(entry));
}

async function boundedRead(path) {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_JOURNEY_FILE_BYTES) throw new Error("Journey file exceeds 1 MiB.");
  return bytes.toString("utf8");
}

async function openBrowser(options) {
  let processHandle;
  let profile;
  let endpoint;
  if (options.cdp) {
    endpoint = loopbackEndpoint(options.cdp);
  } else {
    profile = await mkdtemp(resolve(tmpdir(), "clank-journey-"));
    try {
      processHandle = await launchChrome(options.executable, profile, options.headed, options.viewport);
      endpoint = await devtoolsEndpoint(profile, processHandle);
    } catch (error) {
      if (processHandle) processHandle.kill("SIGKILL");
      await rm(profile, { recursive: true, force: true });
      throw error;
    }
  }
  let target;
  let cdp;
  try {
    target = await createTarget(endpoint);
    cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
  } catch (error) {
    if (processHandle) {
      processHandle.kill("SIGTERM");
      await Promise.race([onceExit(processHandle), wait(2_000)]);
      if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
    }
    if (profile) await rm(profile, { recursive: true, force: true });
    throw error;
  }
  const exceptions = [];
  const secrets = new Set();
  cdp.on("Runtime.exceptionThrown", (event) => {
    const message = event?.exceptionDetails?.exception?.description
      ?? event?.exceptionDetails?.text
      ?? "Unknown browser exception.";
    exceptions.push(safeBrowserError(message, secrets));
    if (exceptions.length > 100) exceptions.shift();
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const driver = createCdpDriver(cdp);
  return {
    driver,
    exceptions,
    addSecret(value) {
      if (typeof value === "string" && value.length) secrets.add(value);
    },
    hasSecrets: () => secrets.size > 0,
    screenshot: async () => (await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    })).data,
    async close() {
      await Promise.race([
        cdp.send("Target.closeTarget", { targetId: target.id }).catch(() => undefined),
        wait(500),
      ]);
      cdp.close();
      if (processHandle) {
        processHandle.kill("SIGTERM");
        await Promise.race([onceExit(processHandle), wait(2_000)]);
        if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
      }
      if (profile) await rm(profile, { recursive: true, force: true });
    },
  };
}

function createCdpDriver(cdp) {
  const evaluate = async (expression, awaitPromise = false) => {
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Browser evaluation failed.");
    }
    return response.result?.value;
  };
  const settle = async () => {
    const deadline = Date.now() + 15_000;
    let lastError;
    while (Date.now() <= deadline) {
      try {
        const ready = await evaluate("document.readyState");
        if (ready === "interactive" || ready === "complete") {
          await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true);
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await wait(50);
    }
    throw lastError ?? new Error("Browser page did not settle within 15 seconds.");
  };
  return Object.freeze({
    async navigate(url) {
      const result = await cdp.send("Page.navigate", { url });
      if (result.errorText) throw new Error(`Browser navigation failed: ${result.errorText}`);
      await settle();
    },
    currentUrl: () => evaluate("location.href"),
    inspect: () => evaluate(SEMANTIC_INSPECTION_SOURCE),
    activate: (id) => evaluate(`(${ACTIVATE_SOURCE})(${JSON.stringify(id)})`),
    input: (id, value, options) => evaluate(
      `(${INPUT_SOURCE})(${JSON.stringify(id)}, ${JSON.stringify(value)}, ${Boolean(options?.secret)})`,
    ),
    visibleText: () => evaluate("(document.body?.innerText ?? '').slice(0, 1048576)"),
    settle,
    setViewport: (viewport) => cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.width < 640,
    }),
  });
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(`Chrome DevTools ${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Chrome DevTools connection closed."));
      }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        try { socket.close(); } catch { /* Connection never opened. */ }
        reject(new Error("Chrome DevTools WebSocket did not connect within 5 seconds."));
      }, 5_000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolvePromise();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Could not connect to Chrome DevTools."));
      }, { once: true });
    });
    return new CdpConnection(socket);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }
  close() {
    try { this.socket.close(); } catch { /* Already closed. */ }
  }
}

async function launchChrome(explicit, profile, headed, viewport) {
  const candidates = explicit ? [explicit] : chromeCandidates();
  const size = viewport ?? { width: 1280, height: 800 };
  const args = [
    ...(headed ? [] : ["--headless=new"]),
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    `--window-size=${size.width},${size.height}`,
    "about:blank",
  ];
  let lastError;
  for (const executable of candidates) {
    try {
      return await spawnExecutable(executable, args);
    } catch (error) {
      lastError = error;
      if (explicit) break;
    }
  }
  throw new Error(
    `Chrome or Chromium was not found. Set --browser or CLANK_CHROME_EXECUTABLE.${lastError ? ` ${lastError.message}` : ""}`,
  );
}

function spawnExecutable(executable, args) {
  if (typeof executable !== "string" || executable.includes("\0")) throw new Error("Chrome executable is invalid.");
  const child = spawn(executable, args, {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false,
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4_096); });
  child.clankStderr = () => stderr;
  return new Promise((resolvePromise, reject) => {
    child.once("spawn", () => resolvePromise(child));
    child.once("error", reject);
  });
}

async function devtoolsEndpoint(profile, child) {
  const path = resolve(profile, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() <= deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before DevTools started. ${child.clankStderr?.() ?? ""}`.trim());
    }
    try {
      const [port] = (await readFile(path, "utf8")).trim().split(/\r?\n/u);
      if (/^\d+$/u.test(port)) return `http://127.0.0.1:${port}`;
    } catch { /* Profile is still starting. */ }
    await wait(50);
  }
  throw new Error("Chrome did not publish its DevTools port within 15 seconds.");
}

async function createTarget(endpoint) {
  const response = await fetch(`${endpoint}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Chrome DevTools target creation failed with HTTP ${response.status}.`);
  const payload = JSON.parse(await boundedResponseText(response, 64 * 1024, "Chrome DevTools target"));
  if (typeof payload.webSocketDebuggerUrl !== "string") throw new Error("Chrome DevTools omitted its page WebSocket URL.");
  return { ...payload, webSocketDebuggerUrl: cdpWebSocketUrl(payload.webSocketDebuggerUrl, endpoint) };
}

function chromeCandidates() {
  const common = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : process.platform === "win32"
      ? [
          resolve(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
          resolve(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
        ]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  return common;
}

function loopbackEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("--cdp must be an HTTP loopback endpoint.");
  }
  return url.origin;
}

function applicationUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--url must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("--url cannot contain credentials.");
  return url.href;
}

function option(args, name) {
  const inline = args.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function flag(args, name) {
  return args.includes(`--${name}`) || args.includes(`-${name[0]}`);
}

function positionalArguments(args) {
  const values = [];
  const options = new Set(["url", "browser", "cdp", "output", "timeout"]);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value.startsWith("--")) {
      const name = value.slice(2).split("=", 1)[0];
      if (options.has(name) && !value.includes("=")) index++;
      continue;
    }
    if (value.startsWith("-")) continue;
    values.push(value);
  }
  return values;
}

function positiveInteger(value, label, minimum, maximum) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function safeBrowserError(value, secrets = []) {
  let safe = String(value);
  for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
  return safe
    .replace(/([?&](?:token|code|state|key|secret|password)=)[^\s&#]*/giu, "$1[redacted]")
    .replace(/[\u0000-\u001f]/gu, " ")
    .slice(0, 2_048);
}

function cdpWebSocketUrl(value, endpoint) {
  const websocket = new URL(value);
  const control = new URL(endpoint);
  if (
    websocket.protocol !== "ws:"
    || websocket.username
    || websocket.password
    || websocket.hash
    || !["127.0.0.1", "localhost", "[::1]"].includes(websocket.hostname)
    || websocket.port !== control.port
  ) throw new Error("Chrome DevTools returned a WebSocket outside the loopback control endpoint.");
  return websocket.href;
}

async function boundedResponseText(response, maximum, label) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`${label} response is too large.`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new Error(`${label} response is too large.`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function screenshotPath(reportPath) {
  return reportPath.toLowerCase().endsWith(".json") ? `${reportPath.slice(0, -5)}.png` : `${reportPath}.png`;
}

async function writeTextAtomically(path, contents) {
  await writeBinaryAtomically(path, Buffer.from(contents));
}

async function writeBinaryAtomically(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.clank-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function onceExit(child) {
  return child.exitCode !== null ? Promise.resolve() : new Promise((resolvePromise) => child.once("exit", resolvePromise));
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

const FIND_SOURCE = `(id) => {
  for (const element of document.querySelectorAll('[data-clank-id], [id]')) {
    if (element.getAttribute('data-clank-id') === id || element.id === id) return element;
  }
  return null;
}`;

const ACTIVATE_SOURCE = `(id) => {
  const element = (${FIND_SOURCE})(id);
  if (!element || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
  const style = getComputedStyle(element);
  if (element.getClientRects().length === 0 || style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.click();
  return true;
}`;

const INPUT_SOURCE = `(id, value, secret) => {
  const element = (${FIND_SOURCE})(id);
  if (!element || element.disabled || element.readOnly || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('aria-readonly') === 'true') return false;
  const style = getComputedStyle(element);
  if (element.getClientRects().length === 0 || style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
  const tag = element.tagName.toLowerCase();
  const type = tag === 'input' ? (element.type || 'text').toLowerCase() : '';
  if ((type === 'password' && !secret) || type === 'file' || type === 'hidden') return false;
  if (type === 'checkbox' || type === 'radio') {
    if (typeof value !== 'boolean') return false;
    element.checked = value;
  } else if (tag === 'select' && element.multiple) {
    if (!Array.isArray(value)) return false;
    const selected = new Set(value.map(String));
    for (const option of element.options) option.selected = selected.has(option.value);
  } else if (element.isContentEditable) {
    if (typeof value === 'boolean' || Array.isArray(value)) return false;
    element.textContent = String(value);
  } else {
    if (!('value' in element) || typeof value === 'boolean' || Array.isArray(value)) return false;
    element.value = String(value);
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

const SEMANTIC_INSPECTION_SOURCE = `(() => {
  const root = document.body;
  if (!root) return [];
  let remaining = 1000;
  const roleFor = (element, tag, type) => element.getAttribute('role') || ({
    a: element.hasAttribute('href') ? 'link' : undefined,
    button: 'button',
    select: element.multiple ? 'listbox' : 'combobox',
    textarea: 'textbox',
    summary: 'button',
  }[tag]) || (tag === 'input' ? ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', submit: 'button', button: 'button' }[type] || 'textbox') : undefined);
  const labelFor = (element) => element.getAttribute('aria-label')
    || element.labels?.[0]?.textContent?.trim()
    || element.getAttribute('placeholder')
    || element.getAttribute('title')
    || (['button', 'a', 'summary'].includes(element.tagName.toLowerCase()) ? element.textContent?.trim() : undefined)
    || undefined;
  const visit = (element) => {
    if (remaining-- <= 0) return null;
    const tag = element.tagName.toLowerCase();
    const type = tag === 'input' ? (element.getAttribute('type') || 'text').toLowerCase() : undefined;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true' || type === 'hidden') return null;
    const children = [...element.children].map(visit).filter(Boolean);
    const id = element.getAttribute('data-clank-id') || element.id || undefined;
    const role = roleFor(element, tag, type);
    const semantic = id || role || element.hasAttribute('data-clank-intent') || element.hasAttribute('data-clank-action');
    if (!semantic && children.length === 0) return null;
    const node = { tag };
    if (id) node.id = id;
    if (role) node.role = role;
    const label = labelFor(element);
    if (label) node.label = label.slice(0, 512);
    for (const [attribute, key] of [['data-clank-description','description'],['data-clank-intent','intent'],['data-clank-action','action']]) {
      const value = element.getAttribute(attribute); if (value) node[key] = value.slice(0, 1024);
    }
    if (element.disabled || element.getAttribute('aria-disabled') === 'true') node.disabled = true;
    if (element.readOnly || element.getAttribute('aria-readonly') === 'true') node.readonly = true;
    if (element.required || element.getAttribute('aria-required') === 'true') node.required = true;
    if (element.getAttribute('aria-invalid') === 'true') node.invalid = true;
    const expanded = element.getAttribute('aria-expanded');
    if (expanded === 'true' || expanded === 'false') node.expanded = expanded === 'true';
    if (type === 'checkbox' || type === 'radio') node.checked = Boolean(element.checked);
    if (tag === 'select' && element.multiple) node.value = [...element.selectedOptions].map(option => option.value);
    else if (!['password','file','hidden'].includes(type) && 'value' in element) node.value = String(element.value).slice(0, 1024);
    if (tag === 'a' && element.href) node.href = element.href;
    if (children.length) node.children = children;
    return node;
  };
  return [...root.children].map(visit).filter(Boolean);
})()`;
