/** Private frozen native Docker client shared by startup validation and the launcher. */
const clients = new WeakMap<object, DockerClient>();
const genuineClients = new WeakSet<DockerClient>();
export interface DockerClient { readonly executable:string; readonly environment:Readonly<Record<string,string>> }
export function providerDockerClient(options:{executable?:string;dockerEnvironment?:Readonly<Record<string,string>>}):DockerClient {
  const previous=clients.get(options);if(previous)return previous;
  const executable=options.executable??"docker";
  if(typeof executable!=="string"||executable.length===0||executable.length>4096||executable.includes("\0"))throw new TypeError("executable is invalid.");
  const client=Object.freeze({executable,environment:trustedHostEnvironment(options.dockerEnvironment)});
  clients.set(options,client);genuineClients.add(client);return client;
}
/** Consume one captured configuration for one launcher lifetime. */
export function consumeProviderDockerClient(options:{executable?:string;dockerEnvironment?:Readonly<Record<string,string>>}):DockerClient {
  const client=providerDockerClient(options);clients.delete(options);return client;
}
export async function runProviderDockerClient(client:DockerClient,args:readonly string[],options:{timeoutMs:number;maxOutputBytes:number;signal?:AbortSignal;allowFailure?:boolean}){
  if(!genuineClients.has(client))throw new Error("A retained native Docker client is required.");
  return runCommand(client.executable,args,{...options,environment:client.environment});
}
const HOST_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const TRUSTED_DOCKER_ENVIRONMENT = Object.freeze([
  "DOCKER_API_VERSION",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CUSTOM_HEADERS",
  "DOCKER_DEFAULT_PLATFORM",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSH_AUTH_SOCK",
  "XDG_RUNTIME_DIR",
  "TMPDIR",
  "LANG",
  "LC_ALL",
] as const);

function trustedHostEnvironment(
  additional: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const source = (globalThis as any).process.env as Record<string, string | undefined>;
  const output = Object.create(null) as Record<string, string>;
  for (const name of TRUSTED_DOCKER_ENVIRONMENT) {
    if (typeof source[name] === "string") output[name] = source[name]!;
  }
  output.PATH = source.PATH ?? "";
  output.HOME = source.HOME ?? "";
  if (additional !== undefined) {
    if (!additional || typeof additional !== "object" || Array.isArray(additional)) {
      throw new TypeError("dockerEnvironment must be an object.");
    }
    const entries = Object.entries(additional);
    if (entries.length > 64) throw new RangeError("dockerEnvironment has too many entries.");
    for (const [name, value] of entries) {
      if (
        !HOST_ENVIRONMENT_NAME.test(name)
        || typeof value !== "string"
        || value.length > 16_384
        || value.includes("\0")
      ) {
        throw new TypeError("dockerEnvironment contains an invalid entry.");
      }
      output[name] = value;
    }
  }
  return Object.freeze(output);
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  options: {
    timeoutMs: number;
    maxOutputBytes: number;
    environment: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    allowFailure?: boolean;
  },
): Promise<{stdout:string;stderr:string;code:number|null}> {
  throwIfAborted(options.signal);
  const childProcessName = "node:child_process";
  const { spawn } = await import(childProcessName) as unknown as {
    spawn(
      executable: string,
      arguments_: string[],
      options: Record<string, unknown>,
    ): any;
  };
  const child = spawn(executable, [...arguments_], {
    env: { ...options.environment },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let overflow: Error | undefined;
  const collect = async (
    stream: AsyncIterable<Uint8Array> | undefined,
    assign: (value: string) => void,
  ): Promise<void> => {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        overflow = new Error("Docker command output exceeded its configured limit.");
        child.kill("SIGKILL");
        break;
      }
      assign(decoder.decode(chunk, { stream: true }));
    }
    assign(decoder.decode());
  };
  const stdoutTask = collect(child.stdout, (value) => {
    stdout += value;
  });
  const stderrTask = collect(child.stderr, (value) => {
    stderr += value;
  });
  let settled = false;
  const exit = new Promise<{ code: unknown; signal: unknown; error?: unknown }>((resolve) => {
    child.once("error", (error:unknown) => {
      if (!settled) {
        settled = true;
        resolve({ code: null, signal: null, error });
      }
    });
    child.once("exit", (code:unknown, signal:unknown) => {
      if (!settled) {
        settled = true;
        resolve({ code, signal });
      }
    });
  });
  const abort = (): void => {
    child.kill("SIGKILL");
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); child.stdout?.destroy(); child.stderr?.destroy(); }, options.timeoutMs);
  const result = await exit;
  try { await Promise.allSettled([stdoutTask, stderrTask]); } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
  throwIfAborted(options.signal);
  if (timedOut) throw new Error("Docker command deadline exceeded.");
  if (overflow) throw overflow;
  if (result.error) throw new Error(`Docker command failed: ${safeError(result.error)}`);
  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(
      `Docker command failed (${String(result.code ?? result.signal ?? "unknown")}): `
        + boundedFailure(stderr),
    );
  }
  return { stdout, stderr, code: typeof result.code === "number" ? result.code : null };
}

function throwIfAborted(signal:AbortSignal|undefined):void { if(signal?.aborted)throw signal.reason??new Error("Operation aborted."); }
function safeError(value:unknown):string {return value instanceof Error?value.message:String(value);}
function boundedFailure(value:string):string {return value.replace(/[\u0000-\u001f\u007f]+/gu," ").trim().slice(0,1024)||"no diagnostic output";}
