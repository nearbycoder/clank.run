import { spawn } from "node:child_process";
import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

export async function run(command, args) {
  try {
    switch (command) {
      case "help": return help();
      case "version": return version();
      case "create": return createProject(args);
      case "plan": return blueprintPlan(args);
      case "generate": return generateProject(args);
      case "explain": return explainBlueprint(args);
      case "login": return login(args);
      case "logout": return logout(args);
      case "whoami": return whoami(args);
      case "org":
      case "organization": return organizationCommand(args);
      case "project": return projectCommand(args);
      case "token": return tokenCommand(args);
      case "domain": return domainCommand(args);
      case "deploy": return deploy(args);
      case "status": return status(args);
      case "releases": return releases(args);
      case "logs": return logs(args);
      case "rollback": return rollback(args);
      case "backup": return backupCommand(args);
      case "secrets": return secrets(args);
      case "migrate": return migrate(args);
      case "inspect": return inspectArtifact(args);
      default: throw new CliError(`Unknown command: ${command}. Run clank help.`);
    }
  } catch (error) {
    console.error(`clank: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function version() {
  console.log(packageJson.version);
}

function help() {
  console.log(`Clank ${packageJson.version}

Build:
  clank create <directory>             Create a deploy-ready authenticated app
  clank plan [clank.app.ts]            Print a deterministic generated-file plan
  clank explain [clank.app.ts]         Explain an app blueprint in plain language
  clank generate [directory]           Generate from clank.app.ts without executing it
  clank build [src] [dist]             Compile TypeScript and TSX
  clank watch [src] [dist]             Rebuild when source files change

Platform:
  clank login --server <url>           Authorize this CLI in your browser
  clank logout [--server <url>]        Revoke and remove the CLI token
  clank whoami                          Show the active platform account
  clank org list                        List organizations and roles
  clank org create <name>               Create an organization
  clank org invite <org> <email>        Create a single-use invitation
  clank org accept <token>              Accept an invitation
  clank org members <org>               List organization membership
  clank org remove <org> <user>         Remove a member and revoke scoped tokens
  clank project create <name>          Create and link a project
  clank project list                   List projects
  clank project link <project-id>      Link this directory
  clank token create                    Create a scoped token for the linked project
  clank token list                      List active CLI and project tokens
  clank token revoke <token-id>         Revoke a token
  clank domain add <hostname>           Begin DNS ownership verification
  clank domain list                     List custom domains
  clank domain verify <domain-id>       Verify the published TXT record
  clank domain remove <domain-id>       Remove a custom domain
  clank deploy [directory]             Build, package, migrate, and atomically deploy
  clank status                         Show the linked project and active release
  clank releases                       List release history
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

Deployment configuration is explicit in clank.deploy.json. No server-side
package hooks are run, and no secrets are read from the project directory.`);
}

async function blueprintPlan(args) {
  const path = await blueprintPath(positionals(args)[0] ?? option(args, "blueprint"));
  const blueprint = parseAppBlueprint(await readFile(path, "utf8"), path);
  const plan = await createAppPlan(blueprint, { frameworkVersion: packageJson.version });
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
  const files = generateAppFiles(blueprint, { frameworkVersion: packageJson.version });
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
  const plan = await createAppPlan(blueprint, { frameworkVersion: packageJson.version });
  const planPath = join(target, ".clank", "plan.json");
  await mkdir(dirname(planPath), { recursive: true, mode: 0o700 });
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  console.log(`Generated ${blueprint.name}: ${created} files written, ${unchanged} unchanged.`);
  console.log(`Plan ${plan.digest}`);
  console.log(`Next: cd ${target} && npm install && npm run dev`);
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
  const target = resolve(positional[0] ?? ".");
  const name = option(args, "name") ?? basename(target);
  await mkdir(target, { recursive: true });
  const entries = await import("node:fs/promises").then(({ readdir }) => readdir(target));
  if (entries.length) throw new CliError(`Target directory is not empty: ${target}`);
  await cp(join(packageRoot, "templates", "auth-todo"), target, { recursive: true });
  await rename(join(target, "gitignore.txt"), join(target, ".gitignore"));
  await replaceInFile(join(target, "package.json"), "__PROJECT_NAME__", packageName(name));
  await replaceInFile(join(target, "package.json"), "__CLANK_VERSION__", packageJson.version);
  await replaceInFile(join(target, "src", "server.tsx"), "__PROJECT_TITLE__", displayName(name));
  await replaceInFile(join(target, "src", "view.tsx"), "__PROJECT_TITLE__", displayName(name));
  console.log(`Created ${displayName(name)} in ${target}`);
  console.log(`Next: cd ${positional[0] ?? "."} && npm install && npm run dev`);
  console.log("Deploy: clank login --server <platform-url> && clank deploy");
}

async function login(args) {
  const server = normalizeServer(option(args, "server") ?? (await activeProfile())?.server);
  if (!server) throw new CliError("Pass --server <url> the first time you log in.");
  const started = await platformRequest(server, "/api/device/start", {
    method: "POST",
    body: { clientName: `${hostname()} · ${operatingSystem()} CLI` },
    authenticate: false,
  });
  console.log(`Open ${started.verificationUri}`);
  console.log(`Enter code: ${started.userCode}`);
  if (!flag(args, "no-open")) openBrowser(started.verificationUri);
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
  throw new CliError("Usage: clank org <list|create|invite|accept|members|remove>");
}

async function projectCommand(args) {
  const subcommand = args.shift();
  const profile = await requireProfile();
  if (subcommand === "list") {
    const payload = await platformRequest(profile.server, "/api/projects", { token: profile.token });
    if (!payload.projects.length) return console.log("No projects.");
    for (const project of payload.projects) {
      console.log(`${project.id}  ${project.slug}  ${project.activeReleaseId ?? "not deployed"}`);
    }
    return;
  }
  if (subcommand === "create") {
    const name = positionals(args)[0] ?? basename(process.cwd());
    const payload = await platformRequest(profile.server, "/api/projects", {
      method: "POST",
      token: profile.token,
      body: {
        name,
        ...(option(args, "slug") ? { slug: option(args, "slug") } : {}),
        ...(option(args, "org") ? { organizationId: option(args, "org") } : {}),
      },
    });
    await saveLink(process.cwd(), profile.server, payload.project.id);
    console.log(`Created and linked ${payload.project.slug} (${payload.project.id})`);
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
  throw new CliError("Usage: clank project <create|list|link>");
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
  const profile = await requireProfile();
  const config = await readDeploymentConfig(root);
  if (config.build) await runBuild(config.build.command, root);
  const artifact = await createDeploymentBundle(root, config, {
    frameworkRoot: packageRoot,
    frameworkVersion: packageJson.version,
    nodeVersion: process.version,
  });
  const digest = await deploymentDigest(artifact);
  if (flag(args, "dry-run") || option(args, "output")) {
    const output = resolve(option(args, "output") ?? join(root, ".clank", "artifacts", `${digest}.clank.gz`));
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, artifact, { mode: 0o600 });
    console.log(`Verified artifact ${digest}`);
    console.log(output);
    if (flag(args, "dry-run")) return;
  }
  let link = await readLink(root);
  if (!link) {
    const name = basename(root);
    const payload = await platformRequest(profile.server, "/api/projects", {
      method: "POST",
      token: profile.token,
      body: { name },
    });
    await saveLink(root, profile.server, payload.project.id);
    link = { version: 1, server: profile.server, projectId: payload.project.id };
    console.log(`Created project ${payload.project.slug}.`);
  }
  if (link.server !== profile.server) {
    throw new CliError(`This directory is linked to ${link.server}; log in there or relink it.`);
  }
  const response = await fetch(`${profile.server}/api/projects/${encodeURIComponent(link.projectId)}/releases`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${profile.token}`,
      "content-type": "application/vnd.clank.deploy+gzip",
      "content-length": String(artifact.byteLength),
      "x-clank-content-sha256": digest,
      "x-clank-idempotency-key": randomToken(),
    },
    body: artifact,
  });
  const payload = await response.json();
  if (!response.ok) throw ApiError.from(payload, response.status);
  console.log(`Deployed release ${payload.release.id}`);
  console.log(`Digest: ${payload.release.digest}`);
  console.log(`URL: ${payload.release.directUrl ?? payload.release.url}`);
}

async function status() {
  const { profile, link } = await linkedContext(process.cwd());
  const payload = await platformRequest(profile.server, `/api/projects/${link.projectId}`, { token: profile.token });
  console.log(`${payload.project.slug} (${payload.project.id})`);
  console.log(`Active release: ${payload.activeRelease?.id ?? "none"}`);
  console.log(`Status: ${payload.activeRelease?.status ?? "not deployed"}`);
  console.log(`Port: ${payload.project.port}`);
}

async function releases() {
  const { profile, link } = await linkedContext(process.cwd());
  const payload = await platformRequest(profile.server, `/api/projects/${link.projectId}/releases`, { token: profile.token });
  for (const release of payload.releases) {
    console.log(`${release.id}  ${release.status.padEnd(8)}  ${release.digest.slice(0, 12)}  ${new Date(release.createdAt).toISOString()}`);
  }
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

async function runBuild(command, cwd) {
  const [rawExecutable, ...rawArguments] = command;
  const frameworkCommand = rawExecutable === "clank" || rawExecutable === "proact";
  const executable = frameworkCommand ? process.execPath : rawExecutable;
  const arguments_ = frameworkCommand
    ? [resolve(process.argv[1]), ...rawArguments]
    : rawArguments;
  await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, { cwd, stdio: "inherit", shell: false });
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
  const response = await fetch(`${server}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw new CliError(`Platform returned a non-JSON response (${response.status}).`); }
  if (!response.ok) throw ApiError.from(payload, response.status);
  return payload;
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
  if (!profile?.token) throw new CliError("Not authenticated. Run clank login --server <url>.");
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
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (parsed.version !== 1 || typeof parsed.profiles !== "object") throw new Error("invalid");
  return parsed;
}

async function writeCliConfig(config) {
  const path = cliConfigPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
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
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.version !== 1 || typeof value.server !== "string" || typeof value.projectId !== "string") throw new Error("invalid");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") {
      const legacyPath = join(root, ".proact", "project.json");
      try {
        const value = JSON.parse(await readFile(legacyPath, "utf8"));
        if (value.version !== 1 || typeof value.server !== "string" || typeof value.projectId !== "string") throw new Error("invalid");
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
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "project.json"), `${JSON.stringify({ version: 1, server, projectId }, null, 2)}\n`, { mode: 0o600 });
}

function normalizeServer(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))) {
    throw new CliError("Platform URL must use HTTPS, except for loopback development.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}

function openBrowser(url) {
  const command = operatingSystem() === "darwin"
    ? ["open", [url]]
    : operatingSystem() === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: "ignore", shell: false });
    child.unref();
  } catch { /* Printing the URL is the reliable fallback. */ }
}

function option(args, name) {
  const exactIndex = args.indexOf(`--${name}`);
  if (exactIndex !== -1) return args[exactIndex + 1];
  return args.find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function flag(args, name) {
  return args.includes(`--${name}`);
}

function positionals(args) {
  const output = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument.startsWith("--")) {
      if (!argument.includes("=") && !["--dry-run", "--no-open", "--restore-data", "--local", "--force"].includes(argument)) index++;
      continue;
    }
    output.push(argument);
  }
  return output;
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function replaceInFile(path, search, replacement) {
  await writeFile(path, (await readFile(path, "utf8")).replaceAll(search, replacement));
}

function packageName(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "clank-app";
}

function displayName(value) {
  return value.trim().replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Clank App";
}

function randomToken() {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

class CliError extends Error {}

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
