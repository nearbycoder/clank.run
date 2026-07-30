import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createNetServer, isIP } from "node:net";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { readDeploymentConfig } from "../dist/deploy.js";

const DEV_EVENT_PROTOCOL = "clank-dev-event/1";
const DEV_CLIENT_PATH = "/_clank/dev-client.js";
const DEV_EVENTS_PATH = "/_clank/dev-events";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const MAX_BROWSER_CLIENTS = 64;
const MAX_INJECTABLE_HTML_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const REBUILD_DEBOUNCE_MS = 75;
const CHILD_SHUTDOWN_MS = 3_000;
const CRASH_WINDOW_MS = 10_000;
const MAX_CRASH_RESTARTS = 3;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const DEV_CLIENT_SOURCE = `const events = new EventSource(${JSON.stringify(DEV_EVENTS_PATH)});
events.addEventListener("reload", () => globalThis.location.reload());
`;

export async function runDev(rawArguments) {
  const options = parseArguments(rawArguments);
  const root = resolve(options.directory);
  const json = options.json;
  const emit = (type, details = {}) => {
    if (json) {
      console.log(JSON.stringify({ protocol: DEV_EVENT_PROTOCOL, type, ...details }));
      return;
    }
    if (type === "building") console.log(`Clank dev: building ${root}`);
    else if (type === "build_failed") console.error(`Clank dev: build failed; keeping the current server.\n${details.message}`);
    else if (type === "candidate_failed") console.error(`Clank dev: replacement failed its health check; keeping the current server.\n${details.message}`);
    else if (type === "ready") console.log(`Clank dev: ${details.url}`);
    else if (type === "restarted") console.log(`Clank dev: rebuilt and restarted (revision ${details.revision}).`);
    else if (type === "server_exited") console.error(`Clank dev: application exited unexpectedly (${details.code ?? details.signal ?? "unknown"}); restarting.`);
    else if (type === "stopping") console.log("Clank dev: stopping.");
  };
  const abort = new AbortController();
  const browserClients = new Set();
  const crashes = [];
  let config;
  let active;
  let candidate;
  let currentPort;
  let revision = 0;
  let stopping = false;
  let pending = false;
  let pendingCause = "change";
  let rebuilding = false;
  let debounce;
  let drainPromise = Promise.resolve();
  let fatalError;

  const proxy = createServer({
    maxHeaderSize: 16 * 1024,
    headersTimeout: 15_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 5_000,
  }, (incoming, outgoing) => {
    void handleRequest(incoming, outgoing, {
      activePort: () => currentPort,
      browserClients,
      reload: options.reload,
    }).catch(() => {
      if (!outgoing.headersSent) respond(outgoing, 500, "Development proxy failed.");
      else outgoing.destroy();
    });
  });
  const publicAddress = await listen(proxy, options.host, options.port);
  const publicUrl = formatUrl(options.host, publicAddress.port);
  const publicHost = new URL(publicUrl).host;
  const keepAlive = setInterval(() => {
    for (const response of browserClients) response.write(": keepalive\n\n");
  }, 15_000);
  keepAlive.unref();

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    emit("stopping", { signal });
    clearTimeout(debounce);
    abort.abort(new Error(`Development server stopped by ${signal}.`));
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const runCycle = async ({ initial = false, cause = "change" } = {}) => {
    let nextConfig;
    try {
      nextConfig = await readDeploymentConfig(root);
      emit("building", { cause });
      await runBuild(nextConfig, root, { json, signal: abort.signal });
    } catch (error) {
      if (stopping && abort.signal.aborted) return false;
      if (initial || !active) throw error;
      emit("build_failed", { cause, message: errorMessage(error) });
      return false;
    }
    if (stopping) return false;

    try {
      const internalPort = await reservePort();
      const launched = launchApplication(nextConfig, root, internalPort, {
        json,
        publicUrl,
        publicHostname: options.host,
        signal: abort.signal,
      });
      candidate = launched;
      await waitForHealthy(launched, nextConfig.health, publicHost);
      const previous = active;
      active = launched;
      candidate = undefined;
      config = nextConfig;
      currentPort = internalPort;
      revision++;
      if (initial) emit("ready", { url: publicUrl, revision, pid: launched.child.pid });
      else {
        emit("restarted", { url: publicUrl, revision, pid: launched.child.pid, cause });
        broadcastReload(browserClients, revision);
      }
      if (previous) await terminate(previous.child);
      observeActiveExit(launched);
      return true;
    } catch (error) {
      const failed = candidate;
      candidate = undefined;
      if (failed) await terminate(failed.child);
      if (stopping && abort.signal.aborted) return false;
      if (initial || !active) throw error;
      emit("candidate_failed", { cause, message: errorMessage(error) });
      return false;
    }
  };

  const drain = async () => {
    if (rebuilding || stopping) return;
    rebuilding = true;
    try {
      while (pending && !stopping) {
        pending = false;
        const cause = pendingCause;
        pendingCause = "change";
        await runCycle({ cause });
      }
    } finally {
      rebuilding = false;
    }
  };

  const queueCycle = (cause = "change") => {
    if (stopping) return;
    pending = true;
    pendingCause = cause;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      drainPromise = drainPromise.then(() => drain()).catch((error) => {
        fatalError = error;
        stop("failure");
      });
    }, cause === "crash" ? 10 : REBUILD_DEBOUNCE_MS);
  };

  function observeActiveExit(launched) {
    void launched.exited.then(({ code, signal }) => {
      if (stopping || active !== launched) return;
      currentPort = undefined;
      active = undefined;
      const now = Date.now();
      crashes.push(now);
      while (crashes.length && crashes[0] < now - CRASH_WINDOW_MS) crashes.shift();
      emit("server_exited", { code, signal, restarts: crashes.length });
      if (crashes.length > MAX_CRASH_RESTARTS) {
        fatalError = new Error(`Application exited more than ${MAX_CRASH_RESTARTS} times in ${CRASH_WINDOW_MS / 1_000} seconds.`);
        stop("crash-loop");
        return;
      }
      queueCycle("crash");
    });
  }

  try {
    await runCycle({ initial: true, cause: "initial" });
    const watcher = watch(root, { recursive: true, signal: abort.signal });
    try {
      for await (const event of watcher) {
        if (stopping) break;
        if (!shouldRebuild(event.filename, config)) continue;
        queueCycle(event.filename ? String(event.filename) : "change");
      }
    } catch (error) {
      if (!stopping && error?.name !== "AbortError") throw error;
    }
    await drainPromise;
    if (fatalError) throw fatalError;
  } finally {
    stopping = true;
    clearTimeout(debounce);
    clearInterval(keepAlive);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    for (const response of browserClients) response.end();
    browserClients.clear();
    await Promise.allSettled([
      closeServer(proxy),
      candidate ? terminate(candidate.child) : Promise.resolve(),
      active ? terminate(active.child) : Promise.resolve(),
    ]);
  }
}

function parseArguments(arguments_) {
  const positionals = [];
  let host = process.env.HOST ?? DEFAULT_HOST;
  let portValue = process.env.PORT ?? String(DEFAULT_PORT);
  let json = false;
  let reload = true;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--no-reload") {
      reload = false;
      continue;
    }
    if (argument === "--host" || argument === "--port") {
      const value = arguments_[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      if (argument === "--host") host = value;
      else portValue = value;
      continue;
    }
    if (argument.startsWith("--host=")) {
      host = argument.slice("--host=".length);
      continue;
    }
    if (argument.startsWith("--port=")) {
      portValue = argument.slice("--port=".length);
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown option ${argument} for clank dev.`);
    positionals.push(argument);
  }
  if (positionals.length > 1) throw new Error("Usage: clank dev [directory] [--host <host>] [--port <port>] [--no-reload] [--json]");
  if (!validHost(host)) throw new Error("Development host must be an IPv4 address, IPv6 address, or DNS hostname.");
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Development port must be an integer from 0 through 65535.");
  return {
    directory: positionals[0] ?? ".",
    host,
    port,
    json,
    reload,
  };
}

async function runBuild(config, root, { json, signal }) {
  if (!config.build) return;
  const [rawExecutable, ...rawArguments] = config.build.command;
  const frameworkCommand = rawExecutable === "clank" || rawExecutable === "proact";
  const executable = frameworkCommand ? process.execPath : rawExecutable;
  const arguments_ = frameworkCommand
    ? [resolve(process.argv[1]), ...rawArguments]
    : rawArguments;
  const child = spawn(executable, arguments_, {
    cwd: root,
    shell: false,
    signal,
    stdio: json ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  let diagnostics = "";
  if (json) {
    child.stdout.on("data", (chunk) => {
      process.stderr.write(chunk);
      diagnostics = boundedAppend(diagnostics, chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      diagnostics = boundedAppend(diagnostics, chunk);
    });
  }
  const result = await childResult(child);
  if (result.code !== 0) {
    const detail = diagnostics.trim();
    throw new Error(`Build exited with ${result.code ?? result.signal}.${detail ? `\n${detail}` : ""}`);
  }
}

function launchApplication(config, root, port, { json, publicUrl, publicHostname, signal }) {
  const entry = resolve(root, config.entry);
  if (!isInside(root, entry)) throw new Error("Development entry escaped the project root.");
  const allowedHosts = new Set([
    ...(process.env.ALLOWED_HOSTS ?? "").split(","),
    ...(config.env.ALLOWED_HOSTS ?? "").split(","),
    publicHostname,
    DEFAULT_HOST,
    "localhost",
    "::1",
  ].map((host) => host.trim()).filter(Boolean));
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--enable-source-maps",
    entry,
  ], {
    cwd: root,
    env: {
      ...process.env,
      ...config.env,
      HOST: DEFAULT_HOST,
      PORT: String(port),
      ALLOWED_HOSTS: [...allowedHosts].join(","),
      CLANK_DEV: "1",
      CLANK_DEV_PUBLIC_URL: publicUrl,
    },
    shell: false,
    signal,
    stdio: json ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (json) {
    child.stdout.on("data", (chunk) => process.stderr.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }
  const application = {
    child,
    port,
    exitResult: undefined,
    exited: undefined,
  };
  application.exited = childResult(child).then((result) => {
    application.exitResult = result;
    return result;
  });
  return application;
}

async function waitForHealthy(application, health, host) {
  const deadline = Date.now() + health.timeoutMs;
  let lastError = "No health response.";
  while (Date.now() < deadline) {
    if (application.exitResult || application.child.exitCode !== null) {
      const result = application.exitResult ?? await application.exited;
      throw new Error(`Application exited before becoming healthy (${result.code ?? result.signal ?? "unknown"}).`);
    }
    try {
      const status = await probeHealth(application.port, health.path, host);
      if (status >= 200 && status < 300) return;
      lastError = `Health check returned ${status}.`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await delay(100);
  }
  throw new Error(`Health check timed out after ${health.timeoutMs}ms. ${lastError}`);
}

function probeHealth(port, path, host) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({
      hostname: DEFAULT_HOST,
      port,
      path,
      method: "GET",
      headers: {
        host,
        connection: "close",
      },
      timeout: 1_000,
    }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise(response.statusCode ?? 0));
    });
    request.once("timeout", () => request.destroy(new Error("Health check timed out.")));
    request.once("error", reject);
    request.end();
  });
}

async function handleRequest(incoming, outgoing, state) {
  const rawUrl = incoming.url ?? "/";
  if (!rawUrl.startsWith("/")) {
    respond(outgoing, 400, "Invalid request target.");
    return;
  }
  const url = new URL(rawUrl, "http://localhost");
  if (url.pathname === DEV_CLIENT_PATH) {
    if (!state.reload) {
      respond(outgoing, 404, "Not found.");
      return;
    }
    if (incoming.method !== "GET" && incoming.method !== "HEAD") {
      outgoing.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
      outgoing.end("Method not allowed.");
      return;
    }
    outgoing.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    outgoing.end(incoming.method === "HEAD" ? undefined : DEV_CLIENT_SOURCE);
    return;
  }
  if (url.pathname === DEV_EVENTS_PATH) {
    if (!state.reload) {
      respond(outgoing, 404, "Not found.");
      return;
    }
    if (incoming.method !== "GET") {
      outgoing.writeHead(405, { allow: "GET", "content-type": "text/plain; charset=utf-8" });
      outgoing.end("Method not allowed.");
      return;
    }
    if (state.browserClients.size >= MAX_BROWSER_CLIENTS) {
      respond(outgoing, 503, "Too many development browser connections.");
      return;
    }
    outgoing.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    outgoing.write(": connected\n\n");
    state.browserClients.add(outgoing);
    outgoing.once("close", () => state.browserClients.delete(outgoing));
    return;
  }
  const activePort = state.activePort();
  if (!activePort) {
    respond(outgoing, 503, "Application is restarting.");
    return;
  }
  proxyRequest(incoming, outgoing, activePort, state.reload);
}

function proxyRequest(incoming, outgoing, port, injectReload) {
  const requestHeaders = filterHeaders(incoming.headers);
  const upstream = httpRequest({
    hostname: DEFAULT_HOST,
    port,
    method: incoming.method,
    path: incoming.url,
    headers: requestHeaders,
  }, (response) => {
    const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
    const contentEncoding = response.headers["content-encoding"];
    const shouldInject = injectReload
      && incoming.method !== "HEAD"
      && contentType.startsWith("text/html")
      && (!contentType.includes("charset=") || contentType.includes("charset=utf-8"))
      && !contentEncoding;
    if (!shouldInject) {
      outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, developmentResponseHeaders(response.headers));
      response.pipe(outgoing);
      return;
    }
    injectHtmlResponse(response, outgoing);
  });
  upstream.once("error", () => {
    if (!outgoing.headersSent) respond(outgoing, 503, "Application is unavailable.");
    else outgoing.destroy();
  });
  incoming.once("aborted", () => upstream.destroy());
  outgoing.once("close", () => upstream.destroy());
  incoming.pipe(upstream);
}

function injectHtmlResponse(response, outgoing) {
  const chunks = [];
  let total = 0;
  let passthrough = false;
  const originalHeaders = developmentResponseHeaders(response.headers);
  response.on("data", (chunk) => {
    if (passthrough) {
      outgoing.write(chunk);
      return;
    }
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total <= MAX_INJECTABLE_HTML_BYTES) return;
    passthrough = true;
    outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, originalHeaders);
    for (const buffered of chunks) outgoing.write(buffered);
    chunks.length = 0;
  });
  response.once("end", () => {
    if (passthrough) {
      outgoing.end();
      return;
    }
    const source = Buffer.concat(chunks).toString("utf8");
    const marker = devClientMarker(source);
    const output = source.includes(DEV_CLIENT_PATH)
      ? source
      : injectBeforeBody(source, marker);
    const headers = {
      ...originalHeaders,
      "content-length": String(Buffer.byteLength(output)),
      "cache-control": "no-store",
    };
    delete headers.etag;
    delete headers["last-modified"];
    outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, headers);
    outgoing.end(output);
  });
  response.once("error", () => outgoing.destroy());
}

function injectBeforeBody(source, marker) {
  const match = /<\/body\s*>/iu.exec(source);
  if (!match || match.index === undefined) return `${source}${marker}`;
  return `${source.slice(0, match.index)}${marker}${source.slice(match.index)}`;
}

function devClientMarker(source) {
  const match = /<script\b[^>]*\bnonce=(["'])([A-Za-z0-9+/_=-]{16,256})\1/iu.exec(source);
  const nonce = match?.[2] ? ` nonce="${match[2]}"` : "";
  return `<script type="module"${nonce} src="${DEV_CLIENT_PATH}"></script>`;
}

function filterHeaders(headers) {
  const result = {};
  const connectionHeaders = new Set(String(headers.connection ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean));
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(normalized) || connectionHeaders.has(normalized)) continue;
    result[name] = value;
  }
  return result;
}

function developmentResponseHeaders(headers) {
  const result = filterHeaders(headers);
  result["cache-control"] = "no-store";
  delete result.etag;
  delete result["last-modified"];
  return result;
}

function shouldRebuild(filename, config) {
  if (!filename) return true;
  const normalized = String(filename).replaceAll("\\", "/").replace(/^\.\/+/u, "");
  if (!normalized || normalized.startsWith("../") || isAbsolute(normalized)) return false;
  const first = normalized.split("/")[0];
  if ([".clank", ".git", ".hg", ".svn", "node_modules"].includes(first)) return false;
  if (/\.clank-build-\d+-\d+$/u.test(normalized)) return false;
  const database = config.database.path.replaceAll("\\", "/");
  if (normalized === database || normalized === `${database}-shm` || normalized === `${database}-wal`) return false;
  const outputDirectory = dirname(config.entry).replaceAll("\\", "/");
  if (outputDirectory !== "." && (normalized === outputDirectory || normalized.startsWith(`${outputDirectory}/`))) {
    return false;
  }
  return true;
}

function broadcastReload(clients, revision) {
  const payload = `event: reload\ndata: ${JSON.stringify({ revision })}\n\n`;
  for (const response of clients) response.write(payload);
}

function listen(server, hostname, port) {
  return new Promise((resolvePromise, reject) => {
    const failed = (error) => reject(error);
    server.once("error", failed);
    server.listen(port, hostname, () => {
      server.removeListener("error", failed);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Development server did not expose a TCP address."));
      else resolvePromise(address);
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  });
}

function reservePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, DEFAULT_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a development application port."));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(CHILD_SHUTDOWN_MS)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
}

function childResult(child) {
  return new Promise((resolvePromise) => {
    child.once("error", (error) => resolvePromise({ code: null, signal: error.code ?? error.message }));
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

function respond(response, status, message) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(message);
}

function formatUrl(hostname, port) {
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
}

function validHost(value) {
  if (!value || value.length > 253 || /[\s/\\,[\]@?#]/u.test(value)) return false;
  if (isIP(value)) return true;
  return value.split(".").every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
}

function isInside(root, target) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path) && !path.split(sep).includes(".."));
}

function boundedAppend(current, chunk) {
  const next = current + String(chunk);
  return next.length <= MAX_DIAGNOSTIC_BYTES ? next : next.slice(next.length - MAX_DIAGNOSTIC_BYTES);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
