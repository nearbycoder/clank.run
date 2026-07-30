import { spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, platform as operatingSystem } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDeploymentBundle,
  decodeDeploymentBundle,
  deploymentDigest,
  readDeploymentConfig,
} from "../dist/deploy.js";
import {
  createAppPlan,
  explainApp,
  generateAppFiles,
  parseAppBlueprint,
} from "../dist/blueprint.js";
import { applyMigrations, loadMigrations, planMigrations } from "../dist/migrations.js";
import { readResponseBytes, ResponseBodyLimitError } from "../dist/security.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const MAX_LOCAL_CONFIG_BYTES = 1024 * 1024;
const MAX_PLATFORM_RESPONSE_BYTES = 4 * 1024 * 1024;
const PLATFORM_REQUEST_TIMEOUT_MS = 30_000;
const PLATFORM_DEPLOY_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_PLATFORM_SERVER = "https://clank.run";
const PROJECT_TEMPLATES = Object.freeze([
  Object.freeze({
    id: "auth-todo",
    title: "Authenticated Todo",
    summary: "Auth, private SQLite data, SSR, hydration, Tailwind, and live sync.",
    recommended: true,
    features: Object.freeze([
      "authentication",
      "private-sqlite",
      "durable-jobs",
      "ssr",
      "hydration",
      "live-sync",
      "tailwind",
      "mcp-oauth",
      "ui-mcp-parity",
      "deterministic-fixture",
      "app-contract-tests",
      "migrations",
      "deployment",
    ]),
  }),
  Object.freeze({
    id: "minimal",
    title: "Minimal full-stack",
    summary: "A small SSR and hydrated TypeScript app with Tailwind and deployment.",
    recommended: false,
    features: Object.freeze([
      "reactivity",
      "ssr",
      "hydration",
      "tailwind",
      "app-contract-tests",
      "health-check",
      "deployment",
    ]),
  }),
]);
const COMMANDS = Object.freeze({
  templates: {
    usage: "clank templates [--json]",
    summary: "List built-in app starters and their exact capabilities.",
  },
  create: {
    usage: "clank create <directory> [--template <auth-todo|minimal>] [--name <name>] [--framework <version|local|spec>] [--json]",
    summary: "Create a deploy-ready full-stack app from a built-in template.",
  },
  dev: {
    usage: "clank dev [directory] [--host <host>] [--port <port>] [--no-reload] [--json]",
    summary: "Build, supervise, restart, and live-reload a local application.",
  },
  plan: {
    usage: "clank plan [clank.app.ts] [--output <file>] [--framework <version|local|spec>]",
    summary: "Print a deterministic generated-file plan.",
  },
  explain: {
    usage: "clank explain [clank.app.ts]",
    summary: "Explain an app blueprint in plain language.",
  },
  generate: {
    usage: "clank generate [directory] [--blueprint <file>] [--framework <version|local|spec>] [--force]",
    summary: "Generate an app from a data-only blueprint.",
  },
  build: {
    usage: "clank build [input=src] [output=dist] [--jsx-import-source=@clank.run/framework] [--tailwind=src/styles.css]",
    summary: "Compile TypeScript/TSX, copy static files, and optionally build Tailwind CSS.",
  },
  watch: {
    usage: "clank watch [input=src] [output=dist] [--jsx-import-source=@clank.run/framework] [--tailwind=src/styles.css]",
    summary: "Rebuild source and optional Tailwind CSS when files change.",
  },
  jobs: {
    usage: "clank jobs <worker|scheduler|status|list|cancel|retry> [directory|job-id] [--state <state>] [--queue <name>] [--limit <count>] [--json]",
    summary: "Run job processes or inspect and operate a linked project's private queue.",
  },
  doctor: {
    usage: "clank doctor [directory] [--json]",
    summary: "Check whether an app is ready to build and deploy.",
  },
  login: {
    usage: "clank login [--server <https-url>]",
    summary: "Authorize the CLI in a browser; defaults to https://clank.run.",
  },
  logout: {
    usage: "clank logout [--server <url>] [--local]",
    summary: "Revoke and remove the active CLI token.",
  },
  whoami: {
    usage: "clank whoami",
    summary: "Show the active platform account.",
  },
  org: {
    usage: "clank org <list|create|invite|accept|members|invitations|role|remove|revoke-invite>",
    summary: "Manage workspaces, invitations, members, and roles.",
  },
  project: {
    usage: "clank project <create|list|link|delete> [--placement <local|provider>]",
    summary: "Manage and link deployment projects.",
  },
  activity: {
    usage: "clank activity [--org <id>] [--limit <count>] [--before <cursor>] [--json]",
    summary: "Read the workspace audit feed.",
  },
  usage: {
    usage: "clank usage [directory] [--org <id>] [--month YYYY-MM] [--json]",
    summary: "Inspect transparent monthly workspace usage and enforced traffic limits.",
  },
  token: {
    usage: "clank token <create|list|revoke>",
    summary: "Manage scoped automation tokens.",
  },
  domain: {
    usage: "clank domain <add|list|verify|remove>",
    summary: "Manage custom domains and DNS verification.",
  },
  deploy: {
    usage: "clank deploy [directory] [--name <name>] [--slug <slug>] [--org <id>] [--placement <local|provider>] [--dry-run] [--output <file>] [--json]",
    summary: "Build, package, migrate, and atomically deploy in one command.",
  },
  preview: {
    usage: "clank preview <deploy|list|remove> [name] [directory] [--ttl <hours>] [--json]",
    summary: "Deploy isolated, expiring environments without copying production data or secrets.",
  },
  status: {
    usage: "clank status",
    summary: "Show the linked project and active release.",
  },
  releases: {
    usage: "clank releases [delete <release-id> --confirm <phrase> [--allow-rollback-loss]]",
    summary: "List releases or remove inactive artifact storage.",
  },
  logs: {
    usage: "clank logs [--limit <count>]",
    summary: "Read bounded application logs.",
  },
  rollback: {
    usage: "clank rollback <release-id> [--restore-data --confirm <phrase>]",
    summary: "Health-check and activate an earlier release.",
  },
  backup: {
    usage: "clank backup <create|list|verify|restore>",
    summary: "Create, verify, list, or restore encrypted backups.",
  },
  secrets: {
    usage: "clank secrets <list|set|delete>",
    summary: "Manage write-only runtime secrets.",
  },
  migrate: {
    usage: "clank migrate <plan|apply> [directory]",
    summary: "Inspect or apply local SQLite migrations.",
  },
  inspect: {
    usage: "clank inspect <artifact>",
    summary: "Verify and print a deployment artifact manifest.",
  },
  version: {
    usage: "clank version",
    summary: "Print the installed Clank version.",
  },
});
const COMMAND_ALIASES = Object.freeze({
  organization: "org",
  audit: "activity",
});
const VALUE_OPTIONS = Object.freeze({
  create: ["name", "framework", "template"],
  plan: ["blueprint", "output", "framework"],
  explain: ["blueprint"],
  generate: ["blueprint", "framework"],
  login: ["server"],
  logout: ["server"],
  org: ["slug", "role"],
  organization: ["slug", "role"],
  project: ["slug", "org", "placement", "confirm"],
  activity: ["org", "limit", "before"],
  audit: ["org", "limit", "before"],
  usage: ["org", "month"],
  token: ["permissions", "expires-in", "name"],
  deploy: ["name", "slug", "org", "placement", "output"],
  preview: ["ttl", "confirm"],
  jobs: ["concurrency", "queues", "state", "queue", "limit"],
  releases: ["confirm"],
  logs: ["limit"],
  rollback: ["confirm"],
  backup: ["reason", "confirm"],
  secrets: ["from-env"],
});
const BOOLEAN_OPTIONS = Object.freeze({
  help: ["json"],
  templates: ["json"],
  create: ["json"],
  generate: ["force"],
  logout: ["local"],
  project: ["acknowledge-data-loss"],
  activity: ["json"],
  audit: ["json"],
  usage: ["json"],
  deploy: ["dry-run", "json"],
  preview: ["json", "acknowledge-data-loss"],
  releases: ["allow-rollback-loss"],
  rollback: ["restore-data"],
  doctor: ["json"],
  jobs: ["json"],
});

export async function run(command, args) {
  const json = flag(args, "json");
  try {
    validateOptions(command, args);
    switch (command) {
      case "help": return help(args);
      case "version": return version();
      case "templates": return templates(args);
      case "create": return await createProject(args);
      case "plan": return await blueprintPlan(args);
      case "generate": return await generateProject(args);
      case "explain": return await explainBlueprint(args);
      case "doctor": return await doctor(args);
      case "jobs": return await jobsCommand(args);
      case "login": return await login(args);
      case "logout": return await logout(args);
      case "whoami": return await whoami(args);
      case "org":
      case "organization": return await organizationCommand(args);
      case "project": return await projectCommand(args);
      case "activity":
      case "audit": return await activity(args);
      case "usage": return await usageCommand(args);
      case "token": return await tokenCommand(args);
      case "domain": return await domainCommand(args);
      case "deploy": return await deploy(args);
      case "preview": return await previewCommand(args);
      case "status": return await status(args);
      case "releases": return await releases(args);
      case "logs": return await logs(args);
      case "rollback": return await rollback(args);
      case "backup": return await backupCommand(args);
      case "secrets": return await secrets(args);
      case "migrate": return await migrate(args);
      case "inspect": return await inspectArtifact(args);
      default: {
        const suggestion = closestCommand(command);
        throw new CliError(
          `Unknown command: ${command}.${suggestion ? ` Did you mean "clank ${suggestion}"?` : " Run clank help."}`,
          "UNKNOWN_COMMAND",
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      console.error(JSON.stringify({
        ok: false,
        error: {
          code: error instanceof ApiError ? error.code : error instanceof CliError ? error.code : "CLANK_ERROR",
          message,
        },
      }));
    } else {
      console.error(`clank: ${message}`);
    }
    process.exitCode = 1;
  }
}

export async function runInteractive(options = {}) {
  const output = options.write ?? ((value) => process.stdout.write(value));
  const execute = options.execute ?? run;
  let terminal;
  let ask = options.ask;
  if (!ask) {
    const { createInterface } = await import("node:readline/promises");
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    ask = (question) => terminal.question(question);
  }

  const choose = async (prompt, entries, fallback = 0) => {
    while (true) {
      const raw = (await ask(prompt)).trim().toLowerCase();
      if (!raw) return entries[fallback];
      const numeric = Number(raw);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= entries.length) {
        return entries[numeric - 1];
      }
      const match = entries.find((entry) =>
        entry.id === raw || entry.title.toLowerCase() === raw);
      if (match) return match;
      output(`Choose a number from 1 to ${entries.length}.\n`);
    }
  };

  try {
    output(`\nClank ${packageJson.version}\n`);
    output("Build and deploy a TypeScript app with one package.\n\n");
    const actions = [
      { id: "create", title: "Create a new app", summary: "Choose a starter and scaffold a deploy-ready project." },
      { id: "doctor", title: "Check this app", summary: "Validate the current project before deploying." },
      { id: "login", title: "Log in", summary: `Authorize this CLI with ${DEFAULT_PLATFORM_SERVER}.` },
      { id: "deploy", title: "Deploy this app", summary: "Build, migrate, health-check, and activate this project." },
      { id: "help", title: "View every command", summary: "Print the complete CLI reference." },
    ];
    output("What would you like to do?\n");
    actions.forEach((entry, index) => output(`  ${index + 1}) ${entry.title}\n     ${entry.summary}\n`));
    const action = await choose("\nSelect [1]: ", actions);

    if (action.id === "create") {
      output("\nChoose a template:\n");
      PROJECT_TEMPLATES.forEach((entry, index) =>
        output(`  ${index + 1}) ${entry.title}${entry.recommended ? " (recommended)" : ""}\n     ${entry.summary}\n`));
      const template = await choose("\nTemplate [1]: ", PROJECT_TEMPLATES);
      let target;
      while (!target) {
        const candidate = (await ask("Project directory [my-clank-app]: ")).trim() || "my-clank-app";
        if (!candidate.startsWith("-") && !candidate.includes("\0")) {
          target = candidate;
        } else {
          output("Enter a normal filesystem path that does not start with a dash.\n");
        }
      }
      output("\n");
      return await execute("create", [target, `--template=${template.id}`]);
    }

    if (action.id === "deploy") {
      const confirmation = (await ask("Deploy the current directory to Clank? [y/N]: ")).trim().toLowerCase();
      if (confirmation !== "y" && confirmation !== "yes") {
        output("Deployment cancelled.\n");
        return;
      }
      output("\n");
    }
    return await execute(action.id, []);
  } finally {
    terminal?.close();
  }
}

function version() {
  console.log(packageJson.version);
}

function help(args = []) {
  const topic = positionals(args)[0];
  if (topic) {
    const canonical = COMMAND_ALIASES[topic] ?? topic;
    const entry = COMMANDS[canonical];
    if (!entry) {
      const suggestion = closestCommand(topic);
      throw new CliError(
        `Unknown help topic: ${topic}.${suggestion ? ` Did you mean "clank help ${suggestion}"?` : ""}`,
        "UNKNOWN_COMMAND",
      );
    }
    if (flag(args, "json")) {
      console.log(JSON.stringify({
        protocol: "clank-cli-help/1",
        version: packageJson.version,
        command: canonical,
        ...entry,
      }, null, 2));
      return;
    }
    console.log(`${entry.summary}

Usage:
  ${entry.usage}

Run clank help for the complete command list.`);
    return;
  }
  if (flag(args, "json")) {
    console.log(JSON.stringify({
      protocol: "clank-cli-help/1",
      version: packageJson.version,
      commands: Object.entries(COMMANDS).map(([name, entry]) => ({ name, ...entry })),
      aliases: COMMAND_ALIASES,
    }, null, 2));
    return;
  }
  console.log(`Clank ${packageJson.version}

Start:
  clank templates                      List built-in app starters
  clank create <directory>             Create a deploy-ready full-stack app
  clank dev [directory]                Build, run, and live-reload an app
  clank doctor [directory]             Check build and deployment readiness
  clank deploy [directory]             Create, link, and deploy a project

Build and agents:
  clank dev [directory]                Build, supervise, and live-reload locally
  clank plan [clank.app.ts]            Print a deterministic generated-file plan
  clank explain [clank.app.ts]         Explain an app blueprint in plain language
  clank generate [directory]           Generate from clank.app.ts without executing it
  clank build [src] [dist]             Compile TypeScript and TSX
  clank watch [src] [dist]             Rebuild when source files change
  clank jobs worker [directory]        Run durable jobs outside the web process
  clank jobs scheduler [directory]     Run the leased cron scheduler
  clank jobs status                    Show linked-project queue health
  clank jobs list [--state=dead] [--queue=email]
                                        List safe operational job metadata
  clank jobs cancel <job-id>           Request cancellation
  clank jobs retry <job-id>            Retry a dead or cancelled job

Platform:
  clank login                          Authorize with https://clank.run
  clank login --server <url>           Use a self-hosted Clank platform
  clank logout [--server <url>]        Revoke and remove the CLI token
  clank whoami                          Show the active platform account
  clank org list                        List organizations and roles
  clank org create <name>               Create an organization
  clank org invite <org> <email>        Create a single-use invitation
  clank org accept <token>              Accept an invitation
  clank org members <org>               List organization membership
  clank org invitations <org>           List active invitations
  clank org role <org> <user> <role>    Change a member role
  clank org remove <org> <user>         Remove a member and revoke scoped tokens
  clank org revoke-invite <org> <id>    Revoke an active invitation
  clank project create <name>          Create and link a local project
  clank project create <name> --placement=provider
                                        Create on configured provider capacity
  clank project list                   List projects
  clank project link <project-id>      Link this directory
  clank project delete [project-id] --confirm="delete-site <slug>" --acknowledge-data-loss
  clank activity [--org=<id>] [--limit=100] [--before=<cursor>] [--json]
  clank usage [directory] [--org=<id>] [--month=YYYY-MM] [--json]
  clank token create                    Create a scoped token for the linked project
  clank token list                      List active CLI and project tokens
  clank token revoke <token-id>         Revoke a token
  clank domain add <hostname>           Begin DNS ownership verification
  clank domain list                     List custom domains
  clank domain verify <domain-id>       Verify the published TXT record
  clank domain remove <domain-id>       Remove a custom domain
  clank status                         Show the linked project and active release
  clank releases                       List release history
  clank releases delete <release-id> --confirm="delete-release <slug> <id>"
  clank logs [--limit=200]             Read application logs
  clank rollback <release-id>          Roll back code after a health check
  clank rollback <id> --restore-data --confirm="restore <slug>"
  clank backup create [--reason <text>]
  clank backup list
  clank backup verify <backup-id>
  clank backup restore <backup-id> --confirm="restore-backup <slug> <id>"
  clank secrets list
  clank secrets set NAME               Read a secret value from stdin
  clank secrets delete NAME
  clank migrate plan [directory]       Inspect local SQLite migration state
  clank migrate apply [directory]      Apply local migrations
  clank inspect <artifact>             Verify and print an artifact manifest

Run clank help <command> or clank <command> --help for focused usage.
Use clank help --json and clank doctor --json for agent-readable output.

Deployment configuration is explicit in clank.deploy.json. No server-side
package hooks are run, and no secrets are read from the project directory.`);
}

function templates(args) {
  if (positionals(args).length > 0) {
    throw new CliError(
      "clank templates does not accept positional arguments.",
      "TOO_MANY_ARGUMENTS",
    );
  }
  const catalog = {
    protocol: "clank-template-catalog/1",
    version: packageJson.version,
    defaultTemplate: PROJECT_TEMPLATES.find((entry) => entry.recommended)?.id
      ?? PROJECT_TEMPLATES[0]?.id
      ?? null,
    templates: PROJECT_TEMPLATES.map((entry) => ({ ...entry })),
  };
  if (flag(args, "json")) {
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }
  console.log(`Clank ${packageJson.version} built-in templates`);
  for (const template of catalog.templates) {
    console.log(
      `\n${template.id}${template.recommended ? " (recommended)" : ""}\n`
      + `  ${template.title} — ${template.summary}\n`
      + `  Includes: ${template.features.join(", ")}\n`
      + `  Create: clank create my-app --template=${template.id}`,
    );
  }
  console.log("\nUse clank templates --json for the stable agent-readable catalog.");
}

async function blueprintPlan(args) {
  const path = await blueprintPath(positionals(args)[0] ?? option(args, "blueprint"));
  const blueprint = parseAppBlueprint(await readFile(path, "utf8"), path);
  const plan = await createAppPlan(blueprint, generationOptions(args));
  const output = `${JSON.stringify(plan, null, 2)}\n`;
  const outputPath = option(args, "output");
  if (outputPath) {
    const target = resolve(outputPath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, output, { mode: 0o600 });
    console.log(target);
  } else {
    process.stdout.write(output);
  }
}

async function explainBlueprint(args) {
  const path = await blueprintPath(positionals(args)[0] ?? option(args, "blueprint"));
  const blueprint = parseAppBlueprint(await readFile(path, "utf8"), path);
  process.stdout.write(explainApp(blueprint));
}

async function generateProject(args) {
  const target = resolve(positionals(args)[0] ?? ".");
  const path = await blueprintPath(option(args, "blueprint"));
  const blueprint = parseAppBlueprint(await readFile(path, "utf8"), path);
  const generation = generationOptions(args);
  const files = generateAppFiles(blueprint, generation);
  const force = flag(args, "force");
  let created = 0;
  let unchanged = 0;
  await mkdir(target, { recursive: true });
  for (const file of files) {
    const destination = resolve(target, file.path);
    if (!inside(target, destination)) throw new CliError(`Generated path escaped the target: ${file.path}`);
    let existing;
    try { existing = await readFile(destination, "utf8"); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing === file.contents) {
      unchanged++;
      continue;
    }
    const isSourceBlueprint = resolve(path) === destination;
    if (existing !== undefined && !force && !isSourceBlueprint) {
      throw new CliError(`Refusing to overwrite ${destination}. Re-run with --force after reviewing the plan.`);
    }
    if (isSourceBlueprint && existing !== undefined && !force) {
      unchanged++;
      continue;
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.clank-generate-${process.pid}`;
    await writeFile(temporary, file.contents, { mode: file.mode ?? 0o600 });
    await rename(temporary, destination);
    created++;
  }
  const plan = await createAppPlan(blueprint, generation);
  const planPath = join(target, ".clank", "plan.json");
  await mkdir(dirname(planPath), { recursive: true, mode: 0o700 });
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  console.log(`Generated ${blueprint.name}: ${created} files written, ${unchanged} unchanged.`);
  console.log(`Plan ${plan.digest}`);
  console.log(`Next: cd ${target} && npm install && npm run dev`);
  console.log("Test: npm test");
  console.log("Check: npm run doctor");
}

async function blueprintPath(value) {
  if (value) return resolve(value);
  for (const name of ["clank.app.ts", "clank.app.json"]) {
    const path = resolve(name);
    try {
      await stat(path);
      return path;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new CliError("No app blueprint found. Create clank.app.ts or pass --blueprint <path>.");
}

async function createProject(args) {
  const positional = positionals(args);
  if (positional.length > 1) {
    throw new CliError(
      "clank create accepts exactly one project directory.",
      "TOO_MANY_ARGUMENTS",
    );
  }
  const target = resolve(positional[0] ?? ".");
  const requestedName = option(args, "name");
  const title = displayName(requestedName ?? basename(target), requestedName !== undefined);
  const dependency = frameworkDependency(args);
  const template = option(args, "template") ?? "auth-todo";
  const templateDefinition = PROJECT_TEMPLATES.find((entry) =>
    entry.id === template);
  if (!templateDefinition) {
    throw new CliError(
      `Unknown template: ${template}. Choose ${PROJECT_TEMPLATES.map((entry) => entry.id).join(" or ")}.`,
      "UNKNOWN_TEMPLATE",
    );
  }
  let targetStats;
  try {
    targetStats = await lstat(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (targetStats && (targetStats.isSymbolicLink() || !targetStats.isDirectory())) {
    throw new CliError(
      `Target must be a real directory, not a file or symbolic link: ${target}`,
      "UNSAFE_TARGET",
    );
  }
  await mkdir(target, { recursive: true });
  targetStats = await lstat(target);
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
    throw new CliError(
      `Target must be a real directory, not a file or symbolic link: ${target}`,
      "UNSAFE_TARGET",
    );
  }
  const entries = await readdir(target);
  if (entries.length) {
    throw new CliError(
      `Target directory is not empty: ${target}`,
      "TARGET_NOT_EMPTY",
    );
  }
  await cp(join(packageRoot, "templates", template), target, { recursive: true });
  await rename(join(target, "gitignore.txt"), join(target, ".gitignore"));
  await replaceInFile(join(target, "package.json"), "__PROJECT_NAME__", packageName(title));
  await replaceInFile(
    join(target, "package.json"),
    '"__CLANK_DEPENDENCY__"',
    JSON.stringify(dependency),
  );
  await replaceInFile(
    join(target, "src", "server.tsx"),
    "__PROJECT_TITLE_JSON__",
    JSON.stringify(title),
  );
  await replaceInFile(
    join(target, "src", "view.tsx"),
    "__PROJECT_TITLE_JSON__",
    JSON.stringify(title),
  );
  await replaceInFile(
    join(target, "README.md"),
    "__PROJECT_TITLE__",
    markdownText(title),
  );
  const result = {
    protocol: "clank-create-result/1",
    ok: true,
    project: {
      name: title,
      packageName: packageName(title),
      directory: target,
      frameworkDependency: dependency,
    },
    template: { ...templateDefinition },
    files: await scaffoldFiles(target),
    commands: {
      install: "npm install",
      dev: "npm run dev",
      test: "npm test",
      doctor: "npm run doctor",
      login: "clank login",
      deploy: "npm run deploy",
    },
  };
  if (flag(args, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Created ${title} in ${target}`);
  console.log(`Next: cd ${positional[0] ?? "."} && npm install && npm run dev`);
  console.log("Test: npm test");
  console.log("Check: npm run doctor");
  console.log("Deploy: clank login && npm run deploy");
}

async function doctor(args) {
  const root = resolve(positionals(args)[0] ?? ".");
  const checks = [];
  const check = (id, status, message, fix) => {
    checks.push({ id, status, message, ...(fix ? { fix } : {}) });
  };

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 16)) {
    check("node", "pass", `Node ${process.versions.node} satisfies >=22.16.`);
  } else {
    check("node", "fail", `Node ${process.versions.node} is too old.`, "Install Node 22.16 or newer.");
  }

  let config;
  try {
    config = await readDeploymentConfig(root);
    check("config", "pass", "clank.deploy.json is valid.");
  } catch (error) {
    const missing = error?.code === "ENOENT";
    check(
      "config",
      "fail",
      missing ? "clank.deploy.json was not found." : `Deployment config is invalid: ${errorMessage(error)}`,
      missing ? "Run clank create or add clank.deploy.json." : "Fix the deployment config before deploying.",
    );
  }

  if (config) {
    try {
      const entry = await lstat(resolve(root, config.entry));
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("the configured entry is not a real regular file");
      }
      check("build", "pass", `${config.entry} is built.`);
    } catch (error) {
      if (config.build) {
        check(
          "build",
          "warn",
          `${config.entry} is not built yet; deploy will run ${formatCommand(config.build.command)}.`,
          "Run npm run build for a local compile check.",
        );
      } else {
        check(
          "build",
          "fail",
          `${config.entry} is unavailable and no build command is configured.`,
          "Build the entry or add build.command to clank.deploy.json.",
        );
      }
    }
    if (config.jobs) {
      try {
        const jobsEntry = await lstat(resolve(root, config.jobs.entry));
        if (!jobsEntry.isFile() || jobsEntry.isSymbolicLink()) {
          throw new Error("the configured jobs entry is not a real regular file");
        }
        check(
          "jobs",
          "pass",
          `${config.jobs.entry} is built for ${config.jobs.workers} worker process`
            + `${config.jobs.workers === 1 ? "" : "es"}`
            + `${config.jobs.scheduler ? " and one scheduler" : ""}.`,
        );
      } catch {
        check(
          "jobs",
          config.build ? "warn" : "fail",
          `${config.jobs.entry} is not built yet.`,
          config.build
            ? "Deploy or run npm run build before starting a local worker."
            : "Build jobs.entry or add build.command to clank.deploy.json.",
        );
      }
    }

    try {
      const migrations = await loadMigrations(resolve(root, config.database.migrations));
      check(
        "migrations",
        migrations.length ? "pass" : "warn",
        `${migrations.length} immutable SQL migration${migrations.length === 1 ? "" : "s"} validated.`,
        migrations.length ? undefined : "Add an ordered migration such as migrations/0001_initial.sql.",
      );
    } catch (error) {
      check("migrations", "fail", `Migrations are invalid: ${errorMessage(error)}`, "Fix migration names or SQL history.");
    }
  }

  try {
    const packageValue = await readLocalJson(join(root, "package.json"));
    const scripts = plainRecord(packageValue.scripts) ? packageValue.scripts : {};
    if (typeof scripts.build === "string" && typeof scripts.dev === "string") {
      check("scripts", "pass", "package.json exposes build and dev commands.");
    } else {
      check("scripts", "warn", "package.json does not expose both build and dev commands.", "Add build and dev scripts.");
    }
  } catch (error) {
    check(
      "scripts",
      error?.code === "ENOENT" ? "warn" : "fail",
      error?.code === "ENOENT" ? "package.json was not found." : "package.json is invalid.",
      "Add a valid package.json with build and dev scripts.",
    );
  }

  let profile;
  try {
    profile = await activeProfile();
    if (!profile) {
      check("login", "warn", "The CLI is not logged in.", "Run clank login.");
    } else if (profile.expiresAt <= Date.now()) {
      check("login", "warn", `The CLI token for ${profile.server} has expired.`, "Run clank login again.");
    } else {
      check("login", "pass", `CLI credentials for ${profile.server} are available.`);
    }
  } catch (error) {
    check("login", "fail", errorMessage(error), "Repair or remove the invalid CLI configuration.");
  }

  try {
    const link = await readLink(root);
    if (!link) {
      check("project", "warn", "This directory is not linked; the first deploy will create a project.");
    } else if (profile && link.server !== profile.server) {
      check(
        "project",
        "fail",
        `The project is linked to ${link.server}, but the active login is for ${profile.server}.`,
        "Log in to the linked platform or explicitly relink the project.",
      );
    } else {
      check("project", "pass", `Project ${link.projectId} is linked to ${link.server}.`);
    }
  } catch (error) {
    check("project", "fail", errorMessage(error), "Repair or remove .clank/project.json.");
  }

  const summary = {
    pass: checks.filter((entry) => entry.status === "pass").length,
    warn: checks.filter((entry) => entry.status === "warn").length,
    fail: checks.filter((entry) => entry.status === "fail").length,
  };
  const report = {
    protocol: "clank-doctor/1",
    ok: summary.fail === 0,
    root,
    summary,
    checks,
  };
  if (flag(args, "json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Clank doctor · ${root}`);
    for (const entry of checks) {
      const marker = entry.status === "pass" ? "✓" : entry.status === "warn" ? "!" : "✗";
      console.log(`${marker} ${entry.id.padEnd(10)} ${entry.message}`);
      if (entry.fix) console.log(`  Next: ${entry.fix}`);
    }
    console.log(`${summary.pass} passed, ${summary.warn} warnings, ${summary.fail} failed.`);
  }
  if (!report.ok) process.exitCode = 1;
}

async function jobsCommand(args) {
  const [role, directory = ".", ...extra] = positionals(args);
  if (["status", "list", "cancel", "retry"].includes(role)) {
    return platformJobsCommand(role, positionals(args).slice(1), args);
  }
  if (role !== "worker" && role !== "scheduler") {
    throw new CliError("Usage: clank jobs <worker|scheduler|status|list|cancel|retry>");
  }
  if (
    option(args, "state") !== undefined
    || option(args, "queue") !== undefined
    || option(args, "limit") !== undefined
    || flag(args, "json")
  ) {
    throw new CliError("--state, --queue, --limit, and --json apply only to hosted job operations.");
  }
  if (extra.length > 0) {
    throw new CliError("clank jobs accepts at most a role and directory.");
  }
  if (role === "scheduler" && (option(args, "concurrency") || option(args, "queues"))) {
    throw new CliError("--concurrency and --queues apply only to clank jobs worker.");
  }
  const root = resolve(directory);
  const config = await readDeploymentConfig(root);
  if (!config.jobs) {
    throw new CliError("clank.deploy.json does not define jobs.entry.");
  }
  if (config.build) await runBuild(config.build.command, root);
  const entry = resolve(root, config.jobs.entry);
  if (!inside(root, entry)) throw new CliError("jobs.entry escapes the project directory.");
  const entryStats = await lstat(entry).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new CliError(`${config.jobs.entry} is not built. Run clank build or configure build.command.`);
    }
    throw error;
  });
  if (!entryStats.isFile() || entryStats.isSymbolicLink()) {
    throw new CliError("jobs.entry must be a regular file, not a symbolic link.");
  }
  const concurrency = role === "worker"
    ? positiveIntegerOption(args, "concurrency", config.jobs.concurrency, 64)
    : 1;
  const queueValue = role === "worker" ? option(args, "queues") : undefined;
  const queues = queueValue === undefined ? config.jobs.queues.join(",") : queueValue;
  if (queues.includes("\0") || queues.length > 8_256) {
    throw new CliError("--queues must be a comma-separated list no longer than 8 KiB.");
  }
  console.log(
    role === "worker"
      ? `Starting worker · concurrency ${concurrency}${queues ? ` · queues ${queues}` : " · all queues"}`
      : "Starting cron scheduler",
  );
  const signal = await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", entry],
      {
        cwd: root,
        stdio: "inherit",
        shell: false,
        env: {
          ...process.env,
          CLANK_PROCESS_ROLE: role,
          ...(role === "worker"
            ? {
                CLANK_WORKER_CONCURRENCY: String(concurrency),
                CLANK_WORKER_QUEUES: queues,
              }
            : {}),
        },
      },
    );
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => {
      if (code === 0) resolvePromise(null);
      else reject(new CliError(`${role} exited with ${code ?? exitSignal}.`));
    });
  });
  return signal;
}

async function platformJobsCommand(command, values, args) {
  const { profile, link } = await linkedContext(process.cwd());
  const base = `/api/projects/${encodeURIComponent(link.projectId)}/jobs`;
  if (command === "status" || command === "list") {
    if (values.length > 0) {
      throw new CliError(
        `Usage: clank jobs ${command}`
        + (command === "list" ? " [--state <state>] [--queue <name>] [--limit <count>]" : ""),
      );
    }
    const state = option(args, "state");
    const validStates = ["queued", "running", "retry", "succeeded", "dead", "cancelled"];
    if (state !== undefined && !validStates.includes(state)) {
      throw new CliError(`--state must be one of ${validStates.join(", ")}.`);
    }
    if (command === "status" && state !== undefined) {
      throw new CliError("--state applies only to clank jobs list.");
    }
    const queue = option(args, "queue");
    if (
      queue !== undefined
      && (
        queue.length < 1
        || queue.length > 128
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(queue)
      )
    ) {
      throw new CliError("--queue must be a portable queue name no longer than 128 characters.");
    }
    if (command === "status" && queue !== undefined) {
      throw new CliError("--queue applies only to clank jobs list.");
    }
    if (command === "status" && option(args, "limit") !== undefined) {
      throw new CliError("--limit applies only to clank jobs list.");
    }
    const limit = positiveIntegerOption(args, "limit", command === "status" ? 1 : 100, 100);
    const search = new URLSearchParams({ limit: String(limit) });
    if (state) search.set("state", state);
    if (queue) search.set("queue", queue);
    const payload = await platformRequest(profile.server, `${base}?${search}`, {
      token: profile.token,
    });
    if (flag(args, "json")) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (command === "status") {
      console.log(`Job health: ${payload.health}`);
      console.log(`Compatibility: ${payload.compatibility}`);
      console.log(`Queued: ${payload.stats.queued} · retrying: ${payload.stats.retry} · running: ${payload.stats.running}`);
      console.log(`Dead: ${payload.stats.dead} · overdue: ${payload.stats.overdue} · expired leases: ${payload.stats.expiredLeases}`);
      console.log(`Schedules: ${payload.scheduleCount} · errors recorded: ${payload.stats.scheduleErrors}`);
      return;
    }
    if (payload.compatibility !== "ready") {
      console.log(
        payload.compatibility === "not_deployed"
          ? "Jobs are unavailable until the first deployment."
          : payload.compatibility === "not_configured"
            ? "This deployment has not configured durable jobs."
            : "Redeploy with the current Clank framework before inspecting jobs.",
      );
      return;
    }
    if (!payload.jobs.length) {
      console.log(state ? `No ${state} jobs.` : "No retained jobs.");
      return;
    }
    for (const job of payload.jobs) {
      const timing = job.completedAt ?? job.runAt;
      console.log(
        `${job.id}  ${job.state.padEnd(9)}  ${job.queue.padEnd(12)}  `
        + `${String(job.attempt).padStart(2)}/${job.maxAttempts}  `
        + `${new Date(timing).toISOString()}  ${job.name}`,
      );
    }
    console.log("Payloads, results, error text, and identities are intentionally hidden.");
    return;
  }
  if (
    option(args, "state") !== undefined
    || option(args, "queue") !== undefined
    || option(args, "limit") !== undefined
  ) {
    throw new CliError("--state, --queue, and --limit apply only to clank jobs list.");
  }
  if (values.length !== 1) throw new CliError(`Usage: clank jobs ${command} <job-id>`);
  const id = values[0];
  if (!/^job_[a-f0-9]{32}$/u.test(id)) throw new CliError("Job ID is invalid.");
  const payload = await platformRequest(
    profile.server,
    `${base}/${encodeURIComponent(id)}/${command}`,
    {
      method: "POST",
      token: profile.token,
      body: {},
    },
  );
  if (flag(args, "json")) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(command === "cancel"
      ? `Cancellation requested for ${id}. Current state: ${payload.job.state}.`
      : `Queued ${id} for retry.`);
  }
}

async function login(args) {
  const server = normalizeServer(
    option(args, "server") ?? (await activeProfile())?.server ?? DEFAULT_PLATFORM_SERVER,
  );
  const started = await platformRequest(server, "/api/device/start", {
    method: "POST",
    body: { clientName: `${hostname()} · ${operatingSystem()} CLI` },
    authenticate: false,
  });
  console.log(`Open ${started.verificationUri}`);
  console.log(`Enter code: ${started.userCode}`);
  const deadline = Date.now() + started.expiresIn * 1000;
  let interval = Math.max(3, Number(started.interval) || 3);
  while (Date.now() < deadline) {
    await delay(interval * 1000);
    try {
      const token = await platformRequest(server, "/api/device/token", {
        method: "POST",
        body: { deviceCode: started.deviceCode },
        authenticate: false,
      });
      await saveProfile(server, token.accessToken, token.expiresAt);
      console.log(`Authenticated with ${server}`);
      return;
    } catch (error) {
      if (error instanceof ApiError && error.code === "AUTHORIZATION_PENDING") continue;
      if (error instanceof ApiError && error.code === "SLOW_DOWN") {
        interval = Math.max(interval + 2, Number(error.retryAfter) || 5);
        continue;
      }
      throw error;
    }
  }
  throw new CliError("Device authorization expired.");
}

async function logout(args) {
  const config = await readCliConfig();
  const server = normalizeServer(option(args, "server") ?? config.current);
  if (!server || !config.profiles[server]) {
    console.log("No active login.");
    return;
  }
  if (!flag(args, "local")) {
    try {
      await platformRequest(server, "/api/tokens/current", {
        method: "DELETE",
        token: config.profiles[server].token,
      });
    } catch (error) {
      throw new CliError(`Token was not removed locally because server revocation failed: ${error.message}`);
    }
  }
  delete config.profiles[server];
  if (config.current === server) config.current = Object.keys(config.profiles)[0] ?? null;
  await writeCliConfig(config);
  console.log(`Removed local credentials for ${server}`);
}

async function whoami() {
  const profile = await requireProfile();
  const payload = await platformRequest(profile.server, "/api/account", { token: profile.token });
  console.log(`${payload.account.email} (${payload.account.id})`);
  console.log(profile.server);
}

async function organizationCommand(args) {
  const subcommand = args.shift();
  const profile = await requireProfile();
  if (subcommand === "list") {
    const payload = await platformRequest(profile.server, "/api/organizations", { token: profile.token });
    if (!payload.organizations.length) return console.log("No organizations.");
    for (const organization of payload.organizations) {
      console.log(`${organization.id}  ${organization.slug}  ${organization.role}`);
    }
    return;
  }
  if (subcommand === "create") {
    const name = positionals(args)[0];
    if (!name) throw new CliError("Usage: clank org create <name> [--slug <slug>]");
    const payload = await platformRequest(profile.server, "/api/organizations", {
      method: "POST",
      token: profile.token,
      body: { name, ...(option(args, "slug") ? { slug: option(args, "slug") } : {}) },
    });
    console.log(`Created ${payload.organization.slug} (${payload.organization.id})`);
    return;
  }
  if (subcommand === "invite") {
    const [organizationId, email] = positionals(args);
    if (!organizationId || !email) {
      throw new CliError("Usage: clank org invite <organization-id> <email> [--role developer]");
    }
    const payload = await platformRequest(
      profile.server,
      `/api/organizations/${encodeURIComponent(organizationId)}/invitations`,
      {
        method: "POST",
        token: profile.token,
        body: { email, role: option(args, "role") ?? "developer" },
      },
    );
    console.log(`Invitation for ${payload.invitation.email} (${payload.invitation.role})`);
    console.log(payload.invitation.token);
    console.log(`Expires: ${new Date(payload.invitation.expiresAt).toISOString()}`);
    return;
  }
  if (subcommand === "accept") {
    const invitationToken = positionals(args)[0];
    if (!invitationToken) throw new CliError("Usage: clank org accept <invitation-token>");
    const payload = await platformRequest(profile.server, "/api/invitations/accept", {
      method: "POST",
      token: profile.token,
      body: { token: invitationToken },
    });
    console.log(`Joined ${payload.organizationId} as ${payload.role}.`);
    return;
  }
  if (subcommand === "members") {
    const organizationId = positionals(args)[0];
    if (!organizationId) throw new CliError("Usage: clank org members <organization-id>");
    const payload = await platformRequest(
      profile.server,
      `/api/organizations/${encodeURIComponent(organizationId)}`,
      { token: profile.token },
    );
    for (const member of payload.members) console.log(`${member.id}  ${member.email}  ${member.role}`);
    return;
  }
  if (subcommand === "invitations") {
    const organizationId = positionals(args)[0];
    if (!organizationId) throw new CliError("Usage: clank org invitations <organization-id>");
    const payload = await platformRequest(
      profile.server,
      `/api/organizations/${encodeURIComponent(organizationId)}`,
      { token: profile.token },
    );
    if (!payload.invitations.length) return console.log("No pending invitations.");
    for (const invitation of payload.invitations) {
      console.log(
        `${invitation.id}  ${invitation.email}  ${invitation.role}  expires ${new Date(invitation.expiresAt).toISOString()}`,
      );
    }
    return;
  }
  if (subcommand === "role") {
    const [organizationId, userId, role] = positionals(args);
    if (!organizationId || !userId || !role) {
      throw new CliError("Usage: clank org role <organization-id> <user-id> <owner|admin|developer|viewer>");
    }
    await platformRequest(
      profile.server,
      `/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", token: profile.token, body: { role } },
    );
    console.log(`Changed ${userId} to ${role}.`);
    return;
  }
  if (subcommand === "remove") {
    const [organizationId, userId] = positionals(args);
    if (!organizationId || !userId) throw new CliError("Usage: clank org remove <organization-id> <user-id>");
    await platformRequest(
      profile.server,
      `/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE", token: profile.token },
    );
    console.log(`Removed ${userId} and revoked its project-scoped tokens.`);
    return;
  }
  if (subcommand === "revoke-invite") {
    const [organizationId, invitationId] = positionals(args);
    if (!organizationId || !invitationId) {
      throw new CliError("Usage: clank org revoke-invite <organization-id> <invitation-id>");
    }
    await platformRequest(
      profile.server,
      `/api/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE", token: profile.token },
    );
    console.log(`Revoked invitation ${invitationId}.`);
    return;
  }
  throw new CliError(
    "Usage: clank org <list|create|invite|accept|members|invitations|role|remove|revoke-invite>",
  );
}

async function projectCommand(args) {
  const subcommand = args.shift();
  const profile = await requireProfile();
  if (subcommand === "list") {
    const payload = await platformRequest(profile.server, "/api/projects", { token: profile.token });
    if (!payload.projects.length) return console.log("No projects.");
    for (const project of payload.projects) {
      console.log(
        `${project.id}  ${project.slug}  ${project.placement ?? "local"}  `
          + `${project.activeReleaseId ?? "not deployed"}`,
      );
    }
    return;
  }
  if (subcommand === "create") {
    const name = positionals(args)[0] ?? basename(process.cwd());
    const placement = placementOption(args);
    const payload = await platformRequest(profile.server, "/api/projects", {
      method: "POST",
      token: profile.token,
      body: {
        name,
        ...(option(args, "slug") ? { slug: option(args, "slug") } : {}),
        ...(option(args, "org") ? { organizationId: option(args, "org") } : {}),
        ...(placement ? { placement } : {}),
      },
    });
    await saveLink(process.cwd(), profile.server, payload.project.id);
    console.log(
      `Created and linked ${payload.project.slug} (${payload.project.id}) `
        + `[${payload.project.placement ?? "local"}]`,
    );
    return;
  }
  if (subcommand === "link") {
    const id = positionals(args)[0];
    if (!id) throw new CliError("Usage: clank project link <project-id>");
    const payload = await platformRequest(profile.server, `/api/projects/${encodeURIComponent(id)}`, { token: profile.token });
    await saveLink(process.cwd(), profile.server, payload.project.id);
    console.log(`Linked ${payload.project.slug} (${payload.project.id})`);
    return;
  }
  if (subcommand === "delete") {
    const currentLink = await readLink(process.cwd());
    const id = positionals(args)[0] ?? currentLink?.projectId;
    const confirmation = option(args, "confirm");
    if (!id || !confirmation || !flag(args, "acknowledge-data-loss")) {
      throw new CliError(
        'Usage: clank project delete [project-id] --confirm="delete-site <slug>" --acknowledge-data-loss',
      );
    }
    const payload = await platformRequest(
      profile.server,
      `/api/projects/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        token: profile.token,
        body: { confirmation, acknowledgeDataLoss: true },
      },
    );
    if (currentLink?.server === profile.server && currentLink.projectId === id) {
      await rm(join(process.cwd(), ".clank", "project.json"), { force: true });
    }
    console.log(`Deleted ${payload.project.slug} (${payload.project.id}) and its application data.`);
    return;
  }
  throw new CliError("Usage: clank project <create|list|link|delete>");
}

async function activity(args) {
  const profile = await requireProfile();
  const limit = positiveIntegerOption(args, "limit", 100, 200);
  const before = optionalPositiveIntegerOption(args, "before");
  const organizationId = option(args, "org");
  const search = new URLSearchParams({ limit: String(limit) });
  if (before !== null) search.set("before", String(before));
  if (organizationId) search.set("organizationId", organizationId);
  const payload = await platformRequest(profile.server, `/api/audit?${search}`, {
    token: profile.token,
  });
  if (flag(args, "json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (!payload.events.length) {
    console.log("No auditable workspace events.");
    return;
  }
  for (const event of payload.events) {
    const target = event.project?.name ?? event.organization?.name ?? "Account";
    const deleted = event.project?.deleted ? " (deleted)" : "";
    const actor = event.actor?.email ?? event.actor?.id ?? "unknown";
    console.log(
      `${event.id}  ${new Date(event.createdAt).toISOString()}  ${event.action}  ${target}${deleted}  ${actor}`,
    );
  }
  if (payload.nextBefore) {
    console.log(`More events: clank activity --before=${payload.nextBefore}`);
  }
}

async function usageCommand(args) {
  const directories = positionals(args);
  if (directories.length > 1) {
    throw new CliError("Usage: clank usage [directory] [--org <id>] [--month YYYY-MM] [--json]");
  }
  const root = resolve(directories[0] ?? ".");
  const profile = await requireProfile();
  let organizationId = option(args, "org");
  if (!organizationId) {
    const link = await readLink(root);
    if (link) {
      if (link.server !== profile.server) {
        throw new CliError(`This directory is linked to ${link.server}; log in there or pass --org explicitly.`);
      }
      const detail = await platformRequest(
        profile.server,
        `/api/projects/${encodeURIComponent(link.projectId)}`,
        { token: profile.token },
      );
      organizationId = detail.project.organizationId;
    } else {
      const dashboard = await platformRequest(profile.server, "/api/dashboard", {
        token: profile.token,
      });
      if (dashboard.organizations.length !== 1) {
        throw new CliError(
          "Pass --org <workspace-id>, or run this command in a linked project directory.",
          "WORKSPACE_REQUIRED",
        );
      }
      organizationId = dashboard.organizations[0].id;
    }
  }
  if (!organizationId) {
    throw new CliError("The selected project does not belong to a workspace.", "WORKSPACE_REQUIRED");
  }
  const search = new URLSearchParams({ organizationId });
  const month = option(args, "month");
  if (month && !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) {
    throw new CliError("--month must use YYYY-MM.", "INVALID_USAGE_MONTH");
  }
  if (month) search.set("month", month);
  const payload = await platformRequest(profile.server, `/api/usage?${search}`, {
    token: profile.token,
  });
  if (flag(args, "json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const completeness = payload.period.complete
    ? payload.period.current ? "current partial month" : "complete month"
    : "partial history";
  console.log(`${payload.workspace.name} · ${payload.period.key} UTC · ${completeness}`);
  console.log(
    `Requests: ${formatCliNumber(payload.usage.requests)} / ${formatCliNumber(payload.limits.requests)}`
    + ` · ${formatCliNumber(payload.usage.rejectedRequests)} rejected`,
  );
  console.log(
    `Known transfer: ${formatCliBytes(payload.usage.knownTransferBytes)}`
    + ` / ${formatCliBytes(payload.limits.knownTransferBytes)}`,
  );
  console.log(
    `Project rate ceiling: ${formatCliNumber(payload.limits.requestsPerMinutePerProject)} requests/minute`,
  );
  console.log(
    `Current resources: ${formatCliNumber(payload.resources.projects)} projects`
    + ` · ${formatCliNumber(payload.resources.previews)} previews`
    + ` · ${formatCliNumber(payload.resources.domains)} domains`
    + ` · ${formatCliBytes(payload.resources.releaseStorageBytes)} release storage`,
  );
  for (const project of payload.projects) {
    console.log(
      `${project.slug}${project.deleted ? " (deleted)" : ""}`
      + `  ${formatCliNumber(project.requests)} requests`
      + `  ${formatCliBytes(project.knownTransferBytes)} known transfer`
      + `  ${formatCliNumber(project.rejectedRequests)} rejected`,
    );
  }
  if (!payload.period.complete) {
    console.log(`History before ${new Date(payload.period.trackingStartedAt).toISOString()} may be incomplete.`);
  }
  console.log("Known transfer counts request bodies and responses that declare Content-Length; no prices or invoices are calculated.");
}

async function tokenCommand(args) {
  const subcommand = args.shift();
  const profile = await requireProfile();
  if (subcommand === "list") {
    const payload = await platformRequest(profile.server, "/api/tokens", { token: profile.token });
    for (const token of payload.tokens) {
      const scope = token.projectId ? `project:${token.projectId}` : "account";
      console.log(`${token.id}  ${scope}  ${token.permissions.join(",") || "all accessible"}  ${token.current ? "(current)" : ""}`);
    }
    return;
  }
  if (subcommand === "create") {
    const link = await readLink(process.cwd());
    if (!link) throw new CliError("This directory is not linked to a project.");
    if (link.server !== profile.server) throw new CliError(`This directory is linked to ${link.server}.`);
    const permissions = (option(args, "permissions") ?? "read,deploy")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean);
    const expiresIn = option(args, "expires-in");
    const payload = await platformRequest(
      profile.server,
      `/api/projects/${encodeURIComponent(link.projectId)}/tokens`,
      {
        method: "POST",
        token: profile.token,
        body: {
          name: option(args, "name") ?? `${hostname()} project automation`,
          permissions,
          ...(expiresIn ? { expiresIn: Number(expiresIn) } : {}),
        },
      },
    );
    console.log(`Created project token ${payload.token.id}. This secret is shown once:`);
    console.log(payload.token.accessToken);
    console.log(`Expires: ${new Date(payload.token.expiresAt).toISOString()}`);
    return;
  }
  if (subcommand === "revoke") {
    const id = positionals(args)[0];
    if (!id) throw new CliError("Usage: clank token revoke <token-id>");
    await platformRequest(profile.server, `/api/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
      token: profile.token,
    });
    console.log(`Revoked ${id}.`);
    return;
  }
  throw new CliError("Usage: clank token <create|list|revoke>");
}

async function domainCommand(args) {
  const subcommand = args.shift();
  const { profile, link } = await linkedContext(process.cwd());
  const base = `/api/projects/${encodeURIComponent(link.projectId)}/domains`;
  if (subcommand === "list") {
    const payload = await platformRequest(profile.server, base, { token: profile.token });
    if (!payload.domains.length) return console.log("No custom domains.");
    for (const domain of payload.domains) {
      console.log(`${domain.id}  ${domain.hostname}  ${domain.status}`);
    }
    return;
  }
  if (subcommand === "add") {
    const hostname = positionals(args)[0];
    if (!hostname) throw new CliError("Usage: clank domain add <hostname>");
    const payload = await platformRequest(profile.server, base, {
      method: "POST",
      token: profile.token,
      body: { hostname },
    });
    console.log(`Add this DNS record, then run clank domain verify ${payload.domain.id}:`);
    console.log(`${payload.domain.recordType} ${payload.domain.recordName} ${payload.domain.recordValue}`);
    return;
  }
  if (subcommand === "verify") {
    const id = positionals(args)[0];
    if (!id) throw new CliError("Usage: clank domain verify <domain-id>");
    const payload = await platformRequest(profile.server, `${base}/${encodeURIComponent(id)}/verify`, {
      method: "POST",
      token: profile.token,
      body: {},
    });
    console.log(`Verified ${payload.domain.hostname}.`);
    return;
  }
  if (subcommand === "remove") {
    const id = positionals(args)[0];
    if (!id) throw new CliError("Usage: clank domain remove <domain-id>");
    await platformRequest(profile.server, `${base}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      token: profile.token,
    });
    console.log(`Removed ${id}.`);
    return;
  }
  throw new CliError("Usage: clank domain <add|list|verify|remove>");
}

async function deploy(args) {
  const root = resolve(positionals(args)[0] ?? ".");
  const startedAt = performance.now();
  const json = flag(args, "json");
  const config = await readDeploymentConfig(root);
  const buildStartedAt = performance.now();
  if (config.build) await runBuild(config.build.command, root, { quiet: json });
  const buildMs = performance.now() - buildStartedAt;
  const packageStartedAt = performance.now();
  const artifact = await createDeploymentBundle(root, config, {
    frameworkRoot: packageRoot,
    frameworkVersion: packageJson.version,
    nodeVersion: process.version,
  });
  const digest = await deploymentDigest(artifact);
  const packageMs = performance.now() - packageStartedAt;
  let artifactPath;
  if (flag(args, "dry-run") || option(args, "output")) {
    const output = resolve(option(args, "output") ?? join(root, ".clank", "artifacts", `${digest}.clank.gz`));
    await writePrivateFile(output, artifact);
    artifactPath = output;
    if (flag(args, "dry-run")) {
      const result = {
        protocol: "clank-deploy-result/1",
        ok: true,
        dryRun: true,
        artifact: { digest, bytes: artifact.byteLength, path: output },
        timing: {
          buildMs: roundedMilliseconds(buildMs),
          packageMs: roundedMilliseconds(packageMs),
          totalMs: roundedMilliseconds(performance.now() - startedAt),
        },
      };
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Verified artifact ${digest}`);
        console.log(output);
        console.log(`Ready in ${formatDuration(result.timing.totalMs)}; nothing was uploaded.`);
      }
      return;
    }
  }
  if (!json) console.log(`Packaged ${artifact.byteLength} bytes · ${digest.slice(0, 12)}`);

  const profile = await requireProfile();
  let link = await readLink(root);
  if (!link) {
    const name = option(args, "name") ?? basename(root);
    const placement = placementOption(args);
    const payload = await platformRequest(profile.server, "/api/projects", {
      method: "POST",
      token: profile.token,
      body: {
        name,
        ...(option(args, "slug") ? { slug: option(args, "slug") } : {}),
        ...(option(args, "org") ? { organizationId: option(args, "org") } : {}),
        ...(placement ? { placement } : {}),
      },
    });
    await saveLink(root, profile.server, payload.project.id);
    link = { version: 1, server: profile.server, projectId: payload.project.id };
    if (!json) console.log(`Created and linked project ${payload.project.slug}.`);
  } else if (
    (
      option(args, "name")
      || option(args, "slug")
      || option(args, "org")
      || option(args, "placement")
    )
    && !json
  ) {
    console.log(
      "Project already linked; --name, --slug, --org, and --placement are only used on the first deploy.",
    );
  }
  if (link.server !== profile.server) {
    throw new CliError(`This directory is linked to ${link.server}; log in there or relink it.`);
  }
  const idempotencyKey = await deploymentAttempt(root, {
    server: profile.server,
    projectId: link.projectId,
    digest,
  });
  const uploadStartedAt = performance.now();
  const { response, payload } = await fetchPlatformJson(
    `${profile.server}/api/projects/${encodeURIComponent(link.projectId)}/releases`,
    {
    method: "POST",
    headers: {
      authorization: `Bearer ${profile.token}`,
      "content-type": "application/vnd.clank.deploy+gzip",
      "content-length": String(artifact.byteLength),
      "x-clank-content-sha256": digest,
      "x-clank-idempotency-key": idempotencyKey,
    },
    body: artifact,
    },
    PLATFORM_DEPLOY_TIMEOUT_MS,
  );
  if (!response.ok) {
    const error = ApiError.from(payload, response.status);
    if (!retryableDeploymentError(error)) {
      await rm(deploymentAttemptPath(root), { force: true });
    }
    throw error;
  }
  await rm(deploymentAttemptPath(root), { force: true });
  const result = {
    protocol: "clank-deploy-result/1",
    ok: true,
    dryRun: false,
    project: {
      id: link.projectId,
      server: profile.server,
      placement: payload.release.project?.placement ?? "local",
    },
    release: {
      id: payload.release.id,
      digest: payload.release.digest,
      url: payload.release.url ?? payload.release.directUrl,
    },
    artifact: {
      digest,
      bytes: artifact.byteLength,
      ...(artifactPath ? { path: artifactPath } : {}),
    },
    timing: {
      buildMs: roundedMilliseconds(buildMs),
      packageMs: roundedMilliseconds(packageMs),
      uploadAndActivateMs: roundedMilliseconds(performance.now() - uploadStartedAt),
      totalMs: roundedMilliseconds(performance.now() - startedAt),
    },
  };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Deployed release ${result.release.id} in ${formatDuration(result.timing.totalMs)}`);
    console.log(`Digest: ${result.release.digest}`);
    console.log(`URL: ${result.release.url}`);
  }
}

async function previewCommand(args) {
  const subcommand = args.shift();
  const values = positionals(args);
  if (subcommand === "list") {
    const root = resolve(values[0] ?? ".");
    const { profile, link } = await linkedContext(root);
    const payload = await platformRequest(
      profile.server,
      `/api/projects/${encodeURIComponent(link.projectId)}/previews`,
      { token: profile.token },
    );
    if (flag(args, "json")) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (!payload.previews.length) {
      console.log("No active preview environments.");
      return;
    }
    for (const preview of payload.previews) {
      console.log(
        `${preview.previewName}  ${preview.runtimeStatus}  ${preview.url}  expires ${new Date(preview.previewExpiresAt).toISOString()}`,
      );
    }
    return;
  }
  if (subcommand === "deploy") {
    const name = values[0];
    const root = resolve(values[1] ?? ".");
    if (!name) throw new CliError("Usage: clank preview deploy <name> [directory] [--ttl <hours>] [--json]");
    const json = flag(args, "json");
    const startedAt = performance.now();
    const config = await readDeploymentConfig(root);
    const buildStartedAt = performance.now();
    if (config.build) await runBuild(config.build.command, root, { quiet: json });
    const buildMs = performance.now() - buildStartedAt;
    const packageStartedAt = performance.now();
    const artifact = await createDeploymentBundle(root, config, {
      frameworkRoot: packageRoot,
      frameworkVersion: packageJson.version,
      nodeVersion: process.version,
    });
    const digest = await deploymentDigest(artifact);
    const packageMs = performance.now() - packageStartedAt;
    if (!json) console.log(`Packaged ${artifact.byteLength} bytes · ${digest.slice(0, 12)}`);

    const { profile, link } = await linkedContext(root);
    const ttl = option(args, "ttl");
    const created = await platformRequest(
      profile.server,
      `/api/projects/${encodeURIComponent(link.projectId)}/previews`,
      {
        method: "POST",
        token: profile.token,
        body: {
          name,
          ...(ttl === undefined
            ? {}
            : { ttlHours: positiveIntegerOption(args, "ttl", 168, 24 * 365) }),
        },
      },
    );
    const preview = created.preview;
    const idempotencyKey = await deploymentAttempt(root, {
      server: profile.server,
      projectId: preview.id,
      digest,
    });
    const uploadStartedAt = performance.now();
    const { response, payload } = await fetchPlatformJson(
      `${profile.server}/api/projects/${encodeURIComponent(preview.id)}/releases`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${profile.token}`,
          "content-type": "application/vnd.clank.deploy+gzip",
          "content-length": String(artifact.byteLength),
          "x-clank-content-sha256": digest,
          "x-clank-idempotency-key": idempotencyKey,
        },
        body: artifact,
      },
      PLATFORM_DEPLOY_TIMEOUT_MS,
    );
    if (!response.ok) {
      const error = ApiError.from(payload, response.status);
      if (!retryableDeploymentError(error)) {
        await rm(deploymentAttemptPath(root), { force: true });
      }
      throw error;
    }
    await rm(deploymentAttemptPath(root), { force: true });
    const result = {
      protocol: "clank-preview-result/1",
      ok: true,
      preview: {
        id: preview.id,
        name: preview.previewName,
        parentProjectId: link.projectId,
        expiresAt: preview.previewExpiresAt,
        created: created.created,
      },
      release: {
        id: payload.release.id,
        digest: payload.release.digest,
        url: payload.release.url ?? payload.release.directUrl,
      },
      artifact: { digest, bytes: artifact.byteLength },
      timing: {
        buildMs: roundedMilliseconds(buildMs),
        packageMs: roundedMilliseconds(packageMs),
        uploadAndActivateMs: roundedMilliseconds(performance.now() - uploadStartedAt),
        totalMs: roundedMilliseconds(performance.now() - startedAt),
      },
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${created.created ? "Created" : "Refreshed"} preview ${result.preview.name}.`);
      console.log(`Deployed release ${result.release.id} in ${formatDuration(result.timing.totalMs)}`);
      console.log(`URL: ${result.release.url}`);
      console.log(`Expires: ${new Date(result.preview.expiresAt).toISOString()}`);
    }
    return;
  }
  if (subcommand === "remove") {
    const name = values[0];
    const root = resolve(values[1] ?? ".");
    const confirmation = option(args, "confirm");
    if (!name || !confirmation || !flag(args, "acknowledge-data-loss")) {
      throw new CliError(
        'Usage: clank preview remove <name> [directory] --confirm="delete-preview <name>" --acknowledge-data-loss',
      );
    }
    const { profile, link } = await linkedContext(root);
    const listed = await platformRequest(
      profile.server,
      `/api/projects/${encodeURIComponent(link.projectId)}/previews`,
      { token: profile.token },
    );
    const preview = listed.previews.find((candidate) => candidate.previewName === name);
    if (!preview) throw new CliError(`Preview not found: ${name}`);
    const payload = await platformRequest(
      profile.server,
      `/api/projects/${encodeURIComponent(link.projectId)}/previews/${encodeURIComponent(preview.id)}`,
      {
        method: "DELETE",
        token: profile.token,
        body: { confirmation, acknowledgeDataLoss: true },
      },
    );
    if (flag(args, "json")) console.log(JSON.stringify(payload, null, 2));
    else console.log(`Deleted preview ${name} (${preview.id}) and its isolated data.`);
    return;
  }
  throw new CliError("Usage: clank preview <deploy|list|remove>");
}

async function status() {
  const { profile, link } = await linkedContext(process.cwd());
  const payload = await platformRequest(profile.server, `/api/projects/${link.projectId}`, { token: profile.token });
  console.log(`${payload.project.slug} (${payload.project.id})`);
  console.log(`Active release: ${payload.activeRelease?.id ?? "none"}`);
  console.log(`Status: ${payload.activeRelease?.status ?? "not deployed"}`);
  console.log(`Port: ${payload.project.port}`);
}

async function releases(args) {
  const { profile, link } = await linkedContext(process.cwd());
  const values = positionals(args);
  if (values[0] === "delete") {
    const releaseId = values[1];
    const confirmation = option(args, "confirm");
    if (!releaseId || !confirmation) {
      throw new CliError('Usage: clank releases delete <release-id> --confirm="delete-release <slug> <release-id>"');
    }
    await platformRequest(
      profile.server,
      `/api/projects/${link.projectId}/releases/${encodeURIComponent(releaseId)}`,
      {
        method: "DELETE",
        token: profile.token,
        body: {
          confirmation,
          allowRollbackLoss: flag(args, "allow-rollback-loss"),
        },
      },
    );
    console.log(`Removed release storage ${releaseId}.`);
    return;
  }
  if (values.length) throw new CliError("Usage: clank releases");
  const payload = await platformRequest(profile.server, `/api/projects/${link.projectId}/releases`, { token: profile.token });
  for (const release of payload.releases) {
    console.log(`${release.id}  ${release.status.padEnd(8)}  ${release.artifactAvailable ? `${release.storageBytes} bytes` : "removed"}  ${release.digest.slice(0, 12)}  ${new Date(release.createdAt).toISOString()}`);
  }
  console.log(`Usage: ${payload.usage.releases}/${payload.limits.releases} artifacts, ${payload.usage.storageBytes}/${payload.limits.storageBytes} bytes.`);
}

async function logs(args) {
  const { profile, link } = await linkedContext(process.cwd());
  const limit = option(args, "limit") ?? "200";
  const payload = await platformRequest(profile.server, `/api/projects/${link.projectId}/logs?limit=${encodeURIComponent(limit)}`, { token: profile.token });
  for (const entry of payload.logs) {
    console.log(`${new Date(entry.createdAt).toISOString()} ${entry.stream.padEnd(8)} ${entry.message}`);
  }
}

async function rollback(args) {
  const releaseId = positionals(args)[0];
  if (!releaseId) throw new CliError("Usage: clank rollback <release-id>");
  const { profile, link } = await linkedContext(process.cwd());
  const payload = await platformRequest(profile.server, `/api/projects/${link.projectId}/rollback`, {
    method: "POST",
    token: profile.token,
    body: {
      releaseId,
      restoreData: flag(args, "restore-data"),
      ...(option(args, "confirm") ? { confirmation: option(args, "confirm") } : {}),
    },
  });
  console.log(`Active release: ${payload.release.id}`);
}

async function backupCommand(args) {
  const subcommand = args.shift();
  const { profile, link } = await linkedContext(process.cwd());
  const base = `/api/projects/${encodeURIComponent(link.projectId)}/backups`;
  if (subcommand === "list") {
    const payload = await platformRequest(profile.server, base, { token: profile.token });
    if (!payload.backups.length) return console.log("No backups.");
    for (const backup of payload.backups) {
      console.log(`${backup.id}  ${new Date(backup.createdAt).toISOString()}  ${backup.databaseBytes} bytes  ${backup.reason}`);
    }
    return;
  }
  if (subcommand === "create") {
    const payload = await platformRequest(profile.server, base, {
      method: "POST",
      token: profile.token,
      body: { ...(option(args, "reason") ? { reason: option(args, "reason") } : {}) },
    });
    console.log(`Created and verified ${payload.backup.id}`);
    console.log(`SHA-256: ${payload.backup.databaseSha256}`);
    return;
  }
  if (subcommand === "verify") {
    const id = positionals(args)[0];
    if (!id) throw new CliError("Usage: clank backup verify <backup-id>");
    const payload = await platformRequest(profile.server, `${base}/${encodeURIComponent(id)}/verify`, {
      method: "POST",
      token: profile.token,
      body: {},
    });
    console.log(`Verified ${payload.verification.id} in ${payload.verification.durationMs}ms`);
    return;
  }
  if (subcommand === "restore") {
    const id = positionals(args)[0];
    const confirmation = option(args, "confirm");
    if (!id || !confirmation) {
      throw new CliError("Usage: clank backup restore <backup-id> --confirm=\"restore-backup <slug> <backup-id>\"");
    }
    const payload = await platformRequest(profile.server, `${base}/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      token: profile.token,
      body: { confirmation },
    });
    console.log(`Restored ${payload.verification.id}`);
    console.log(`Safety backup: ${payload.safetyBackupId}`);
    if (Number.isSafeInteger(payload.generation)) {
      console.log(`Provider generation: ${payload.generation}`);
    }
    return;
  }
  throw new CliError("Usage: clank backup <create|list|verify|restore>");
}

async function secrets(args) {
  const subcommand = args.shift();
  const { profile, link } = await linkedContext(process.cwd());
  const path = `/api/projects/${link.projectId}/secrets`;
  if (subcommand === "list") {
    const payload = await platformRequest(profile.server, path, { token: profile.token });
    for (const secret of payload.secrets) console.log(`${secret.name}  ${new Date(secret.updatedAt).toISOString()}`);
    return;
  }
  if (subcommand === "set") {
    const name = positionals(args)[0];
    if (!name) throw new CliError("Usage: clank secrets set NAME (value is read from stdin)");
    const value = option(args, "from-env")
      ? process.env[option(args, "from-env")]
      : await readStandardInput();
    if (value === undefined) throw new CliError("Secret value was not provided.");
    await platformRequest(profile.server, path, {
      method: "PUT",
      token: profile.token,
      body: { values: { [name]: value.replace(/\r?\n$/, "") } },
    });
    console.log(`Stored ${name}. It will be injected on the next release or restart; values are never returned.`);
    return;
  }
  if (subcommand === "delete") {
    const name = positionals(args)[0];
    if (!name) throw new CliError("Usage: clank secrets delete NAME");
    await platformRequest(profile.server, `${path}/${encodeURIComponent(name)}`, {
      method: "DELETE",
      token: profile.token,
    });
    console.log(`Deleted ${name}.`);
    return;
  }
  throw new CliError("Usage: clank secrets <list|set|delete>");
}

async function migrate(args) {
  const subcommand = args.shift();
  const root = resolve(positionals(args)[0] ?? ".");
  const config = await readDeploymentConfig(root);
  const database = resolve(root, config.database.path);
  const directory = resolve(root, config.database.migrations);
  const migrations = await loadMigrations(directory);
  if (subcommand === "plan") {
    const plan = await planMigrations(database, migrations);
    console.log(`${plan.applied.length} applied, ${plan.pending.length} pending`);
    for (const migration of plan.pending) console.log(`pending ${migration.id}_${migration.name}`);
    return;
  }
  if (subcommand === "apply") {
    const result = await applyMigrations({
      path: database,
      directory,
      allowUnsafe: config.database.allowUnsafeMigrations,
    });
    console.log(`Applied ${result.pending.length} migration(s).`);
    return;
  }
  throw new CliError("Usage: clank migrate <plan|apply> [directory]");
}

async function inspectArtifact(args) {
  const filename = positionals(args)[0];
  if (!filename) throw new CliError("Usage: clank inspect <artifact>");
  const bytes = await readFile(resolve(filename));
  const bundle = await decodeDeploymentBundle(bytes);
  console.log(JSON.stringify({
    protocol: bundle.protocol,
    config: bundle.config,
    provenance: bundle.provenance,
    files: bundle.files.map(({ path, size, sha256, mode }) => ({ path, size, sha256, mode })),
    digest: await deploymentDigest(bytes),
  }, null, 2));
}

async function runBuild(command, cwd, options = {}) {
  const [rawExecutable, ...rawArguments] = command;
  const frameworkCommand = rawExecutable === "clank" || rawExecutable === "proact";
  const executable = frameworkCommand ? process.execPath : rawExecutable;
  const arguments_ = frameworkCommand
    ? [resolve(process.argv[1]), ...rawArguments]
    : rawArguments;
  await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      stdio: options.quiet ? ["ignore", "ignore", "ignore"] : "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new CliError(`Build exited with ${code ?? signal}.`)));
  });
}

async function platformRequest(server, path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  const { response, payload } = await fetchPlatformJson(`${server}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }, PLATFORM_REQUEST_TIMEOUT_MS);
  if (!response.ok) throw ApiError.from(payload, response.status);
  return payload;
}

async function fetchPlatformJson(url, init, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      ...init,
      signal,
    });
  } catch (error) {
    if (signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new CliError(`Platform request timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.`);
    }
    throw new CliError(`Could not reach the platform: ${error instanceof Error ? error.message : String(error)}`);
  }

  let bytes;
  try {
    bytes = await readResponseBytes(response, MAX_PLATFORM_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof ResponseBodyLimitError) {
      throw new CliError(`Platform response exceeds ${MAX_PLATFORM_RESPONSE_BYTES} bytes.`);
    }
    if (signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new CliError(`Platform response timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.`);
    }
    throw error;
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CliError(`Platform returned invalid UTF-8 (${response.status}).`);
  }

  try {
    return { response, payload: JSON.parse(text) };
  } catch {
    throw new CliError(`Platform returned a non-JSON response (${response.status}).`);
  }
}

async function linkedContext(root) {
  const profile = await requireProfile();
  const link = await readLink(root);
  if (!link) throw new CliError("This directory is not linked. Run clank project create <name> or clank deploy.");
  if (link.server !== profile.server) throw new CliError(`This directory is linked to ${link.server}.`);
  return { profile, link };
}

async function requireProfile() {
  const profile = await activeProfile();
  if (!profile?.token) throw new CliError("Not authenticated. Run clank login.");
  if (profile.expiresAt <= Date.now()) throw new CliError("CLI token expired. Run clank login again.");
  return profile;
}

async function activeProfile() {
  const config = await readCliConfig();
  if (!config.current) return null;
  const profile = config.profiles[config.current];
  return profile ? { server: config.current, ...profile } : null;
}

async function saveProfile(server, token, expiresAt) {
  const config = await readCliConfig();
  config.current = server;
  config.profiles[server] = { token, expiresAt };
  await writeCliConfig(config);
}

async function readCliConfig() {
  const path = cliConfigPath();
  try {
    return await parseCliConfig(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      const legacy = legacyCliConfigPath();
      try {
        const migrated = await parseCliConfig(legacy);
        await writeCliConfig(migrated);
        return migrated;
      } catch (legacyError) {
        if (legacyError.code === "ENOENT") return { version: 1, current: null, profiles: {} };
        throw new CliError(`Invalid legacy CLI configuration at ${legacy}.`);
      }
    }
    throw new CliError(`Invalid CLI configuration at ${path}.`);
  }
}

async function parseCliConfig(path) {
  const parsed = await readLocalJson(path);
  if (!plainRecord(parsed) || parsed.version !== 1 || !plainRecord(parsed.profiles)) {
    throw new Error("invalid");
  }
  const entries = Object.entries(parsed.profiles);
  if (entries.length > 100) throw new Error("invalid");
  const profiles = Object.create(null);
  for (const [rawServer, rawProfile] of entries) {
    if (!plainRecord(rawProfile)
      || typeof rawProfile.token !== "string"
      || !/^[\x21-\x7e]{1,16384}$/u.test(rawProfile.token)
      || !Number.isSafeInteger(rawProfile.expiresAt)
      || rawProfile.expiresAt <= 0) {
      throw new Error("invalid");
    }
    const server = normalizeServer(rawServer);
    if (profiles[server]) throw new Error("invalid");
    profiles[server] = { token: rawProfile.token, expiresAt: rawProfile.expiresAt };
  }
  const current = parsed.current === null
    ? null
    : typeof parsed.current === "string"
      ? normalizeServer(parsed.current)
      : undefined;
  if (current === undefined || (current !== null && !profiles[current])) throw new Error("invalid");
  return { version: 1, current, profiles };
}

async function writeCliConfig(config) {
  const path = cliConfigPath();
  await writePrivateJson(path, config);
}

function cliConfigPath() {
  return resolve(process.env.CLANK_HOME ?? join(homedir(), ".clank"), "config.json");
}

function legacyCliConfigPath() {
  return resolve(process.env.PROACT_HOME ?? join(homedir(), ".proact"), "config.json");
}

async function readLink(root) {
  const path = join(root, ".clank", "project.json");
  try {
    return parseProjectLink(await readLocalJson(path));
  } catch (error) {
    if (error.code === "ENOENT") {
      const legacyPath = join(root, ".proact", "project.json");
      try {
        const value = parseProjectLink(await readLocalJson(legacyPath));
        await saveLink(root, value.server, value.projectId);
        return value;
      } catch (legacyError) {
        if (legacyError.code === "ENOENT") return null;
        throw new CliError("Invalid legacy .proact/project.json.");
      }
    }
    throw new CliError("Invalid .clank/project.json.");
  }
}

async function saveLink(root, server, projectId) {
  const directory = join(root, ".clank");
  await writePrivateJson(join(directory, "project.json"), parseProjectLink({
    version: 1,
    server,
    projectId,
  }));
}

function deploymentAttemptPath(root) {
  return join(root, ".clank", "deploy-attempt.json");
}

function retryableDeploymentError(error) {
  return error.status === 429
    || error.status >= 500
    || [
      "PROVIDER_DEPLOYMENT_PENDING",
      "PROVIDER_DEPLOYMENT_IN_PROGRESS",
      "PROVIDER_ENDPOINT_UNAVAILABLE",
      "PLATFORM_CLOSING",
    ].includes(error.code);
}

async function deploymentAttempt(root, expected) {
  const path = deploymentAttemptPath(root);
  try {
    const saved = await readLocalJson(path);
    const valid = plainRecord(saved)
      && saved.version === 1
      && typeof saved.server === "string"
      && typeof saved.projectId === "string"
      && typeof saved.digest === "string"
      && typeof saved.idempotencyKey === "string"
      && Number.isSafeInteger(saved.createdAt)
      && saved.createdAt > 0
      && /^[a-f0-9]{64}$/u.test(saved.digest)
      && /^[A-Za-z0-9_-]{16,128}$/u.test(saved.idempotencyKey);
    if (!valid) throw new Error("invalid");
    if (saved.server === expected.server
      && saved.projectId === expected.projectId
      && saved.digest === expected.digest
      && Date.now() - saved.createdAt <= 24 * 60 * 60 * 1_000) {
      return saved.idempotencyKey;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new CliError(
        "Invalid .clank/deploy-attempt.json. Remove it after confirming no deployment is still running.",
        "INVALID_DEPLOY_ATTEMPT",
      );
    }
  }
  const idempotencyKey = randomToken();
  await writePrivateJson(path, {
    version: 1,
    ...expected,
    idempotencyKey,
    createdAt: Date.now(),
  });
  return idempotencyKey;
}

function normalizeServer(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))) {
    throw new CliError("Platform URL must use HTTPS, except for loopback development.");
  }
  url.pathname = trimTrailingSlashes(url.pathname);
  return trimTrailingSlashes(url.href);
}

function parseProjectLink(value) {
  if (!plainRecord(value)
    || value.version !== 1
    || typeof value.server !== "string"
    || typeof value.projectId !== "string"
    || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.projectId)) {
    throw new Error("invalid");
  }
  return {
    version: 1,
    server: normalizeServer(value.server),
    projectId: value.projectId,
  };
}

async function readLocalJson(path) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_LOCAL_CONFIG_BYTES) throw new Error("invalid");
  return JSON.parse(await readFile(path, "utf8"));
}

async function writePrivateJson(path, value) {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePrivateFile(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function plainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function option(args, name) {
  const exactIndex = args.indexOf(`--${name}`);
  if (exactIndex !== -1) return args[exactIndex + 1];
  return args.find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function placementOption(args) {
  const placement = option(args, "placement");
  if (placement === undefined) return undefined;
  if (placement !== "local" && placement !== "provider") {
    throw new CliError(
      '--placement must be "local" or "provider".',
      "INVALID_PLACEMENT",
    );
  }
  return placement;
}

function validateOptions(command, args) {
  const valueOptions = new Set(VALUE_OPTIONS[command] ?? []);
  const booleanOptions = new Set(BOOLEAN_OPTIONS[command] ?? []);
  const knownOptions = [...valueOptions, ...booleanOptions];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("--")) continue;
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (booleanOptions.has(name)) {
      if (separator !== -1) {
        throw new CliError(`--${name} is a flag and does not take a value.`, "INVALID_OPTION");
      }
      continue;
    }
    if (!valueOptions.has(name)) {
      const suggestion = closestValue(name, knownOptions);
      throw new CliError(
        `Unknown option --${name} for clank ${command}.${suggestion ? ` Did you mean --${suggestion}?` : ""}`,
        "UNKNOWN_OPTION",
      );
    }
    if (separator !== -1) {
      if (argument.slice(separator + 1) === "") {
        throw new CliError(`--${name} requires a value.`, "MISSING_OPTION_VALUE");
      }
      continue;
    }
    if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
      throw new CliError(`--${name} requires a value.`, "MISSING_OPTION_VALUE");
    }
    index++;
  }
}

function flag(args, name) {
  return args.includes(`--${name}`);
}

function positionals(args) {
  const output = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument.startsWith("--")) {
      if (!argument.includes("=") && ![
        "--dry-run",
        "--restore-data",
        "--local",
        "--force",
        "--allow-rollback-loss",
        "--acknowledge-data-loss",
        "--json",
      ].includes(argument)) index++;
      continue;
    }
    output.push(argument);
  }
  return output;
}

function positiveIntegerOption(args, name, fallback, maximum) {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new CliError(`--${name} must be an integer from 1 to ${maximum}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new CliError(`--${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function optionalPositiveIntegerOption(args, name) {
  const raw = option(args, name);
  if (raw === undefined) return null;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new CliError(`--${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new CliError(`--${name} must be a positive integer.`);
  }
  return value;
}

function generationOptions(args) {
  return {
    frameworkVersion: packageJson.version,
    frameworkDependency: frameworkDependency(args),
  };
}

function frameworkDependency(args) {
  const value = option(args, "framework");
  if (value === undefined) return `^${packageJson.version}`;
  if (value === "local") return `file:${packageRoot}`;
  if (value.length > 2_048 || /[\u0000-\u001f"\\]/u.test(value)) {
    throw new CliError("--framework must be a safe npm dependency spec or the word local.", "INVALID_FRAMEWORK");
  }
  return value;
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function scaffoldFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new CliError(
        `Generated template contains a symbolic link: ${relative(root, path)}`,
        "UNSAFE_TEMPLATE",
      );
    }
    if (entry.isDirectory()) {
      files.push(...await scaffoldFiles(root, path));
      continue;
    }
    if (!entry.isFile()) {
      throw new CliError(
        `Generated template contains an unsupported entry: ${relative(root, path)}`,
        "UNSAFE_TEMPLATE",
      );
    }
    const bytes = await readFile(path);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes),
    );
    files.push({
      path: relative(root, path).replaceAll("\\", "/"),
      bytes: bytes.byteLength,
      sha256: [...digest]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join(""),
    });
  }
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function replaceInFile(path, search, replacement) {
  await writeFile(path, (await readFile(path, "utf8")).replaceAll(search, replacement));
}

function packageName(value) {
  return trimBoundaryHyphens(value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")) || "clank-app";
}

function trimTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function trimBoundaryHyphens(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 45) start++;
  while (end > start && value.charCodeAt(end - 1) === 45) end--;
  return value.slice(start, end);
}

function displayName(value, preserveCase = false) {
  if (
    typeof value !== "string"
    || value.length > 512
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new CliError(
      "Project name must be ordinary text with at most 100 characters.",
      "INVALID_PROJECT_NAME",
    );
  }
  const normalized = value
    .trim()
    .replace(/[-_]+/gu, " ")
    .replace(/\s+/gu, " ");
  if (!normalized || [...normalized].length > 100) {
    throw new CliError(
      "Project name must contain from 1 to 100 visible characters.",
      "INVALID_PROJECT_NAME",
    );
  }
  return preserveCase
    ? normalized
    : normalized.replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function markdownText(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function randomToken() {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

function roundedMilliseconds(value) {
  return Math.round(value * 10) / 10;
}

function formatDuration(milliseconds) {
  return milliseconds < 1_000
    ? `${Math.round(milliseconds)}ms`
    : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function formatCliNumber(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

function formatCliBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1_000 && unit < units.length - 1) {
    amount /= 1_000;
    unit++;
  }
  return `${amount.toFixed(unit === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatCommand(command) {
  return command.map((argument) => JSON.stringify(argument)).join(" ");
}

function closestCommand(value) {
  return closestValue(value, [...Object.keys(COMMANDS), ...Object.keys(COMMAND_ALIASES)]);
}

function closestValue(value, choices) {
  let best;
  let distance = Infinity;
  for (const choice of choices) {
    const current = editDistance(value, choice);
    if (current < distance) {
      best = choice;
      distance = current;
    }
  }
  return distance <= Math.max(2, Math.floor(value.length / 3)) ? best : undefined;
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

class CliError extends Error {
  constructor(message, code = "CLI_ERROR") {
    super(message);
    this.code = code;
  }
}

class ApiError extends Error {
  constructor(message, code, status, retryAfter) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
  static from(payload, status) {
    return new ApiError(
      payload?.error?.message ?? `Platform request failed (${status}).`,
      payload?.error?.code ?? "PLATFORM_ERROR",
      status,
      payload?.error?.retryAfter,
    );
  }
}
