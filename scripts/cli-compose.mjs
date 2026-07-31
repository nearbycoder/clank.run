import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createAppPlan,
  defineApp,
  generateAppFiles,
  parseAppBlueprint,
} from "../dist/blueprint.js";

const MAX_BLUEPRINT_BYTES = 1024 * 1024;
const MAX_AGENT_OUTPUT_BYTES = 1024 * 1024;
const MAX_AGENT_ERROR_BYTES = 32 * 1024;
const MAX_REQUEST_LENGTH = 20_000;
const MAX_MESSAGE_LENGTH = 20_000;
const MAX_EXISTING_FILE_BYTES = 8 * 1024 * 1024;
const REVIEW_ID = /^[a-f0-9-]{36}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

export class ComposeError extends Error {
  constructor(message, code = "COMPOSE_ERROR") {
    super(message);
    this.code = code;
  }
}

/**
 * Runs the provider-neutral conversational application review loop. An agent
 * proposes data, Clank validates and freezes it, and only the exact approved
 * digest can mutate the target directory.
 */
export async function composeApp(options) {
  const target = resolve(options.target ?? ".");
  const json = options.json === true;
  const interactive = options.interactive
    ?? (!json && process.stdin.isTTY === true && process.stdout.isTTY === true);
  await ensureTarget(target);

  let review;
  if (options.reviewId) {
    rejectCombination(options, ["request", "proposalPath", "agentPath"], "--review");
    review = await loadReview(target, options.reviewId);
  } else {
    const request = await resolveRequest(options.request, interactive, options.ask);
    const currentBlueprint = await readCurrentBlueprint(target);
    const turns = [];
    let feedback = null;
    const maximumTurns = boundedInteger(options.maxTurns ?? 4, 1, 10, "--max-turns");

    for (let turn = 1; turn <= maximumTurns; turn++) {
      const proposal = options.proposalPath
        ? await proposalFromFile(options.proposalPath)
        : options.agentPath
          ? await proposalFromAgent({
              executable: options.agentPath,
              request,
              feedback,
              currentBlueprint,
              history: turns,
              turn,
              timeoutMs: boundedInteger(
                (options.agentTimeoutSeconds ?? 120) * 1_000,
                1_000,
                600_000,
                "--agent-timeout",
              ),
              target,
              frameworkVersion: options.frameworkVersion,
            })
          : null;
      if (!proposal) {
        throw new ComposeError(
          "clank compose needs --proposal <clank.app.ts> or --agent <executable>. The agent receives a bounded JSON protocol on stdin.",
          "COMPOSE_PROPOSAL_REQUIRED",
        );
      }

      const blueprint = validateBlueprint(preservePrivateBlueprintValues(
        proposal.blueprint,
        options.agentPath ? currentBlueprint : null,
      ), "COMPOSE_PROPOSAL_INVALID");
      const plan = await createAppPlan(blueprint, options.generation);
      const changes = await inspectChanges(target, generateAppFiles(blueprint, options.generation));
      const turnRecord = {
        turn,
        message: proposal.message,
        planDigest: plan.digest,
        summary: plan.summary,
        changes: summarizeChanges(changes),
        ...(feedback ? { feedback } : {}),
      };
      turns.push(turnRecord);
      review = await saveReview(target, {
        request,
        blueprint,
        message: proposal.message,
        plan,
        changes,
        turns,
        generation: options.generation,
      });

      if (!interactive || options.approvalDigest) break;
      printReview(review);
      const decision = (await ask(
        options.ask,
        "\nApply this exact plan, revise it, or cancel? [a/r/C]: ",
      )).trim().toLowerCase();
      if (decision === "a" || decision === "apply" || decision === "yes" || decision === "y") {
        options.approvalDigest = review.planDigest;
        break;
      }
      if (decision !== "r" && decision !== "revise") {
        printCancelled(json, review);
        return;
      }
      if (!options.agentPath) {
        throw new ComposeError(
          "A file proposal cannot revise itself. Edit the proposal, then run clank compose again.",
          "COMPOSE_REVISION_REQUIRES_AGENT",
        );
      }
      feedback = (await ask(options.ask, "What should the agent change? ")).trim();
      if (!feedback) {
        throw new ComposeError("Revision feedback cannot be empty.", "COMPOSE_FEEDBACK_REQUIRED");
      }
      if (feedback.length > MAX_REQUEST_LENGTH) {
        throw new ComposeError("Revision feedback is too long.", "COMPOSE_FEEDBACK_TOO_LARGE");
      }
    }
  }

  if (!review) throw new ComposeError("No composition review was produced.");
  if (!options.approvalDigest) {
    if (json) console.log(JSON.stringify(reviewResult(review), null, 2));
    else printReview(review);
    return;
  }
  if (!DIGEST.test(options.approvalDigest) || options.approvalDigest !== review.planDigest) {
    throw new ComposeError(
      `Approval digest does not match the reviewed plan. Expected ${review.planDigest}.`,
      "COMPOSE_APPROVAL_MISMATCH",
    );
  }

  const result = await applyReview(target, review);
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Applied ${result.name}: ${result.changes.created} created, ${result.changes.updated} updated, ${result.changes.unchanged} unchanged.`);
    console.log(`Approved plan ${result.planDigest}`);
    console.log(`Session ${result.sessionId}`);
    console.log(`Next: cd ${target} && npm install && npm test && npm run dev`);
  }
}

async function resolveRequest(value, interactive, askFunction) {
  let request = value?.trim();
  if (!request && interactive) request = (await ask(askFunction, "Describe the application you want to build: ")).trim();
  if (!request) throw new ComposeError("--request is required outside an interactive terminal.", "COMPOSE_REQUEST_REQUIRED");
  if (request.length > MAX_REQUEST_LENGTH || /\u0000/u.test(request)) {
    throw new ComposeError("The application request is invalid or too long.", "COMPOSE_REQUEST_INVALID");
  }
  return request;
}

async function proposalFromFile(path) {
  const sourcePath = resolve(path);
  const metadata = await safeRegularFile(sourcePath, "Proposal");
  if (metadata.size > MAX_BLUEPRINT_BYTES) {
    throw new ComposeError("The proposal exceeds the 1 MiB blueprint limit.", "COMPOSE_PROPOSAL_TOO_LARGE");
  }
  const source = await readFile(sourcePath, "utf8");
  return {
    message: `Reviewed proposal from ${sourcePath}.`,
    blueprint: parseBlueprint(source, sourcePath, "COMPOSE_PROPOSAL_INVALID"),
  };
}

async function proposalFromAgent(context) {
  const executable = resolve(context.executable);
  await safeRegularFile(executable, "Agent executable");
  const request = {
    protocol: "clank-compose-request/1",
    turn: context.turn,
    intent: context.request,
    feedback: context.feedback,
    currentBlueprint: publicBlueprintForAgent(context.currentBlueprint),
    history: context.history.map((entry) => ({
      turn: entry.turn,
      message: entry.message,
      planDigest: entry.planDigest,
      ...(entry.feedback ? { feedback: entry.feedback } : {}),
    })),
    constraints: {
      frameworkVersion: context.frameworkVersion,
      approvalRequired: true,
      dataOnlyBlueprint: true,
      neverIncludeSecrets: true,
    },
  };
  const response = await runAgent(executable, request, context.timeoutMs);
  if (!plainRecord(response)) {
    throw new ComposeError("The agent response must be a JSON object.", "COMPOSE_AGENT_INVALID");
  }
  const allowed = new Set(["protocol", "type", "message", "blueprint"]);
  for (const key of Object.keys(response)) {
    if (!allowed.has(key)) throw new ComposeError(`The agent response contains an unsupported field: ${key}.`, "COMPOSE_AGENT_INVALID");
  }
  if (response.protocol !== "clank-compose-proposal/1" || response.type !== "proposal") {
    throw new ComposeError("The agent must return a clank-compose-proposal/1 proposal.", "COMPOSE_AGENT_INVALID");
  }
  if (typeof response.message !== "string" || !response.message.trim() || response.message.length > MAX_MESSAGE_LENGTH) {
    throw new ComposeError("The agent proposal message is missing or too long.", "COMPOSE_AGENT_INVALID");
  }
  if (!plainRecord(response.blueprint)) {
    throw new ComposeError("The agent proposal must contain a blueprint object.", "COMPOSE_AGENT_INVALID");
  }
  return { message: response.message.trim(), blueprint: response.blueprint };
}

function runAgent(executable, request, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [], {
      cwd: process.cwd(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: safeAgentEnvironment(),
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new ComposeError("The configured agent timed out.", "COMPOSE_AGENT_TIMEOUT")));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_AGENT_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new ComposeError("The agent response exceeded 1 MiB.", "COMPOSE_AGENT_TOO_LARGE")));
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= MAX_AGENT_ERROR_BYTES) return;
      stderrBytes += chunk.length;
      stderr.push(chunk.subarray(0, Math.max(0, MAX_AGENT_ERROR_BYTES - (stderrBytes - chunk.length))));
    });
    child.once("error", (error) => finish(() => reject(new ComposeError(
      `The configured agent could not start: ${error.message}`,
      "COMPOSE_AGENT_START_FAILED",
    ))));
    child.once("exit", (code, signal) => finish(() => {
      if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        reject(new ComposeError(
          `The configured agent exited with ${code ?? signal}.${diagnostic ? ` ${diagnostic}` : ""}`,
          "COMPOSE_AGENT_FAILED",
        ));
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        reject(new ComposeError("The configured agent did not return valid JSON.", "COMPOSE_AGENT_INVALID_JSON"));
      }
    }));
    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function safeAgentEnvironment() {
  const names = process.platform === "win32"
    ? ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]
    : ["PATH", "TMPDIR", "LANG", "LC_ALL"];
  return Object.fromEntries(names.flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]]));
}

async function inspectChanges(target, files) {
  const changes = [];
  for (const file of files) {
    const destination = destinationFor(target, file.path);
    let existing;
    try {
      const metadata = await lstat(destination);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new ComposeError(`Generated destination is not a regular file: ${file.path}`, "COMPOSE_UNSAFE_TARGET");
      }
      if (metadata.size > MAX_EXISTING_FILE_BYTES) {
        throw new ComposeError(`Existing generated destination is unexpectedly large: ${file.path}`, "COMPOSE_EXISTING_FILE_TOO_LARGE");
      }
      existing = await readFile(destination);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const next = Buffer.from(file.contents);
    changes.push({
      path: file.path,
      status: existing === undefined ? "create" : existing.equals(next) ? "unchanged" : "update",
      beforeSha256: existing === undefined ? null : digest(existing),
      afterSha256: digest(next),
      bytes: next.length,
    });
  }
  return changes;
}

async function saveReview(target, input) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const targetDigest = digest(resolve(target));
  const requestDigest = digest(input.request);
  const messageDigest = digest(input.message);
  const turnsDigest = digest(input.turns);
  const planDigest = composePlanDigest({
    targetDigest,
    requestDigest,
    messageDigest,
    turnsDigest,
    generatedPlanDigest: input.plan.digest,
    changes: input.changes,
  });
  const review = {
    protocol: "clank-compose-review/1",
    id,
    createdAt: now,
    directory: target,
    targetDigest,
    request: input.request,
    requestDigest,
    message: input.message,
    messageDigest,
    blueprint: input.blueprint,
    planDigest,
    generatedPlanDigest: input.plan.digest,
    summary: input.plan.summary,
    warnings: input.plan.warnings,
    files: input.plan.files,
    changes: input.changes,
    turns: input.turns,
    turnsDigest,
    generation: input.generation,
  };
  await writePrivateJson(target, reviewPath(target, id), review);
  return review;
}

async function loadReview(target, id) {
  if (!REVIEW_ID.test(id)) throw new ComposeError("--review must be a valid Clank review ID.", "COMPOSE_REVIEW_INVALID");
  let parsed;
  try {
    const metadata = await safeRegularFile(reviewPath(target, id), "Composition review");
    if (metadata.size > MAX_BLUEPRINT_BYTES * 2) throw new ComposeError("The composition review is too large.", "COMPOSE_REVIEW_INVALID");
    parsed = JSON.parse(await readFile(reviewPath(target, id), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new ComposeError(`Composition review ${id} was not found.`, "COMPOSE_REVIEW_NOT_FOUND");
    if (error instanceof SyntaxError) {
      throw new ComposeError("The stored composition review is not valid JSON.", "COMPOSE_REVIEW_INVALID");
    }
    throw error;
  }
  if (!plainRecord(parsed) || parsed.protocol !== "clank-compose-review/1" || parsed.id !== id) {
    throw new ComposeError("The stored composition review is malformed.", "COMPOSE_REVIEW_INVALID");
  }
  if (
    typeof parsed.request !== "string"
    || parsed.requestDigest !== digest(parsed.request)
    || typeof parsed.message !== "string"
    || parsed.messageDigest !== digest(parsed.message)
    || !Array.isArray(parsed.turns)
    || parsed.turnsDigest !== digest(parsed.turns)
    || !Array.isArray(parsed.changes)
  ) {
    throw new ComposeError("The stored composition review has invalid integrity metadata.", "COMPOSE_REVIEW_STALE");
  }
  if (parsed.targetDigest !== digest(resolve(target))) {
    throw new ComposeError("The composition review belongs to another target directory.", "COMPOSE_REVIEW_TARGET_MISMATCH");
  }
  if (parsed.directory !== target || !plainRecord(parsed.generation)) {
    throw new ComposeError("The stored composition review has an invalid target or generation.", "COMPOSE_REVIEW_INVALID");
  }
  const blueprint = validateBlueprint(parsed.blueprint, "COMPOSE_REVIEW_INVALID");
  const plan = await createAppPlan(blueprint, parsed.generation);
  if (plan.digest !== parsed.generatedPlanDigest) {
    throw new ComposeError("The stored composition review no longer matches this framework configuration.", "COMPOSE_REVIEW_STALE");
  }
  if (composePlanDigest(parsed) !== parsed.planDigest) {
    throw new ComposeError("The stored composition review no longer matches its approved scope.", "COMPOSE_REVIEW_STALE");
  }
  const changes = await inspectChanges(target, generateAppFiles(blueprint, parsed.generation));
  assertChangeBaseline(parsed.changes, changes);
  return {
    ...parsed,
    blueprint,
    summary: plan.summary,
    warnings: plan.warnings,
    files: plan.files,
    changes,
  };
}

async function applyReview(target, review) {
  const blueprint = defineApp(review.blueprint);
  const files = generateAppFiles(blueprint, review.generation);
  const currentChanges = await inspectChanges(target, files);
  assertChangeBaseline(review.changes, currentChanges);
  const appliedAt = new Date().toISOString();
  const session = {
    protocol: "clank-compose-session/1",
    id: review.id,
    createdAt: review.createdAt,
    appliedAt,
    request: review.request,
    requestDigest: review.requestDigest,
    message: review.message,
    planDigest: review.planDigest,
    generatedPlanDigest: review.generatedPlanDigest,
    directory: target,
    turns: review.turns,
    changes: summarizeChanges(currentChanges),
  };
  const writes = files.map((file) => ({
    path: file.path,
    contents: Buffer.from(file.contents),
    mode: file.mode ?? 0o600,
  }));
  writes.push(
    {
      path: ".clank/plan.json",
      contents: Buffer.from(`${JSON.stringify({
        protocol: "clank-plan/1",
        blueprint,
        summary: review.summary,
        warnings: review.warnings,
        files: review.files,
        digest: review.generatedPlanDigest,
      }, null, 2)}\n`),
      mode: 0o600,
    },
    {
      path: `.clank/compose-sessions/${review.id}.json`,
      contents: Buffer.from(`${JSON.stringify(session, null, 2)}\n`),
      mode: 0o600,
    },
  );
  await transactionalWrite(target, writes);
  return {
    protocol: "clank-compose-result/1",
    ok: true,
    status: "applied",
    name: blueprint.name,
    directory: target,
    sessionId: review.id,
    planDigest: review.planDigest,
    generatedPlanDigest: review.generatedPlanDigest,
    changes: summarizeChanges(currentChanges),
    commands: {
      install: "npm install",
      test: "npm test",
      dev: "npm run dev",
      doctor: "npm run doctor",
      deploy: "npm run deploy",
    },
  };
}

async function transactionalWrite(target, writes) {
  const backups = [];
  try {
    for (const write of writes) {
      const destination = destinationFor(target, write.path);
      await ensureSafeParent(target, dirname(destination));
      let previous = null;
      try {
        const metadata = await lstat(destination);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new ComposeError(`Refusing unsafe generated destination: ${write.path}`, "COMPOSE_UNSAFE_TARGET");
        }
        previous = { contents: await readFile(destination), mode: metadata.mode & 0o777 };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const temporary = `${destination}.clank-compose-${process.pid}-${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, write.contents, { mode: write.mode });
        await chmod(temporary, write.mode);
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
      backups.push({ destination, previous });
    }
  } catch (error) {
    for (const backup of backups.reverse()) {
      if (!backup.previous) {
        await rm(backup.destination, { force: true });
        continue;
      }
      const temporary = `${backup.destination}.clank-rollback-${process.pid}-${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, backup.previous.contents, { mode: backup.previous.mode });
        await chmod(temporary, backup.previous.mode);
        await rename(temporary, backup.destination);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    throw error;
  }
}

function assertChangeBaseline(reviewed, current) {
  if (!Array.isArray(reviewed) || reviewed.length !== current.length) {
    throw new ComposeError("The reviewed file set changed before approval.", "COMPOSE_REVIEW_STALE");
  }
  for (let index = 0; index < current.length; index++) {
    const left = reviewed[index];
    const right = current[index];
    if (
      left?.path !== right.path
      || left?.beforeSha256 !== right.beforeSha256
      || left?.afterSha256 !== right.afterSha256
      || left?.status !== right.status
    ) {
      throw new ComposeError(`The reviewed baseline changed before approval: ${right.path}`, "COMPOSE_REVIEW_STALE");
    }
  }
}

async function readCurrentBlueprint(target) {
  const path = join(target, "clank.app.ts");
  try {
    const metadata = await safeRegularFile(path, "Current blueprint");
    if (metadata.size > MAX_BLUEPRINT_BYTES) throw new ComposeError("The current blueprint is too large.", "COMPOSE_BLUEPRINT_TOO_LARGE");
    return parseBlueprint(
      await readFile(path, "utf8"),
      path,
      "COMPOSE_CURRENT_BLUEPRINT_INVALID",
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureTarget(target) {
  let metadata;
  try { metadata = await lstat(target); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (metadata && (metadata.isSymbolicLink() || !metadata.isDirectory())) {
    throw new ComposeError(`Composition target must be a real directory: ${target}`, "COMPOSE_UNSAFE_TARGET");
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ComposeError(`Composition target must be a real directory: ${target}`, "COMPOSE_UNSAFE_TARGET");
  }
}

async function ensureSafeParent(root, directory) {
  const path = relative(root, directory);
  if (path.startsWith("..") || isAbsolute(path)) throw new ComposeError("Generated path escaped the target.", "COMPOSE_UNSAFE_TARGET");
  let current = root;
  for (const segment of path.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new ComposeError(`Generated parent is unsafe: ${relative(root, current)}`, "COMPOSE_UNSAFE_TARGET");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

function destinationFor(target, path) {
  const destination = resolve(target, path);
  const child = relative(target, destination);
  if (child.startsWith("..") || isAbsolute(child)) {
    throw new ComposeError(`Generated path escaped the target: ${path}`, "COMPOSE_UNSAFE_TARGET");
  }
  return destination;
}

async function safeRegularFile(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ComposeError(`${label} must be a regular file, not a symbolic link: ${path}`, "COMPOSE_UNSAFE_FILE");
  }
  return metadata;
}

function reviewPath(target, id) {
  return join(target, ".clank", "compose-reviews", `${id}.json`);
}

async function writePrivateJson(target, path, value) {
  await ensureSafeParent(target, dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function reviewResult(review) {
  return {
    protocol: "clank-compose-result/1",
    ok: true,
    status: "review",
    reviewId: review.id,
    directory: review.directory,
    planDigest: review.planDigest,
    generatedPlanDigest: review.generatedPlanDigest,
    requestDigest: review.requestDigest,
    message: review.message,
    summary: review.summary,
    warnings: review.warnings,
    changes: review.changes,
    apply: `clank compose ${JSON.stringify(review.directory)} --review=${review.id} --approve=${review.planDigest} --json`,
  };
}

function printReview(review) {
  const counts = summarizeChanges(review.changes);
  console.log(`\n${review.message}`);
  console.log(`Plan ${review.planDigest}`);
  console.log(`${review.summary.entities} entities · ${review.summary.routes} routes · ${review.summary.actions} actions · ${review.summary.services} services`);
  console.log(`${counts.created} files to create · ${counts.updated} to update · ${counts.unchanged} unchanged`);
  for (const warning of review.warnings) console.log(`Warning: ${warning}`);
  for (const change of review.changes.filter((entry) => entry.status !== "unchanged")) {
    console.log(`  ${change.status.padEnd(6)} ${change.path}`);
  }
  console.log(`Review ID ${review.id}`);
  console.log(`Apply exactly: clank compose ${JSON.stringify(review.directory)} --review=${review.id} --approve=${review.planDigest}`);
}

function printCancelled(json, review) {
  if (json) console.log(JSON.stringify({
    protocol: "clank-compose-result/1",
    ok: true,
    status: "cancelled",
    reviewId: review.id,
    planDigest: review.planDigest,
  }, null, 2));
  else console.log("Composition cancelled. No application files were changed.");
}

function summarizeChanges(changes) {
  return {
    created: changes.filter((entry) => entry.status === "create").length,
    updated: changes.filter((entry) => entry.status === "update").length,
    unchanged: changes.filter((entry) => entry.status === "unchanged").length,
  };
}

function rejectCombination(options, names, optionName) {
  const conflicting = names.find((name) => options[name] !== undefined);
  if (conflicting) throw new ComposeError(`${optionName} cannot be combined with a new proposal.`, "COMPOSE_OPTION_CONFLICT");
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ComposeError(`${name} must be an integer from ${minimum} to ${maximum}.`, "COMPOSE_OPTION_INVALID");
  }
  return value;
}

async function ask(askFunction, prompt) {
  if (askFunction) return await askFunction(prompt);
  const { createInterface } = await import("node:readline/promises");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return await terminal.question(prompt); }
  finally { terminal.close(); }
}

function safeHashInput(value) {
  return typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value);
}

function publicBlueprintForAgent(blueprint) {
  if (!blueprint) return null;
  const copy = structuredClone(blueprint);
  if (copy.deployment) delete copy.deployment.env;
  return copy;
}

function preservePrivateBlueprintValues(proposal, current) {
  if (!current?.deployment?.env || Object.keys(current.deployment.env).length === 0) return proposal;
  if (plainRecord(proposal.deployment) && Object.hasOwn(proposal.deployment, "env")) return proposal;
  const copy = structuredClone(proposal);
  copy.deployment = {
    ...(plainRecord(copy.deployment) ? copy.deployment : {}),
    env: structuredClone(current.deployment.env),
  };
  return copy;
}

function digest(value) {
  return createHash("sha256").update(safeHashInput(value)).digest("hex");
}

function composePlanDigest(input) {
  return digest({
    protocol: "clank-compose-approval/1",
    targetDigest: input.targetDigest,
    requestDigest: input.requestDigest,
    messageDigest: input.messageDigest,
    turnsDigest: input.turnsDigest,
    generatedPlanDigest: input.generatedPlanDigest,
    changes: input.changes,
  });
}

function parseBlueprint(source, path, code) {
  try {
    return parseAppBlueprint(source, path);
  } catch (error) {
    throw new ComposeError(`Invalid application blueprint: ${error.message}`, code);
  }
}

function validateBlueprint(input, code) {
  try {
    return defineApp(input);
  } catch (error) {
    if (error instanceof ComposeError) throw error;
    throw new ComposeError(`Invalid application blueprint: ${error.message}`, code);
  }
}

function plainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
