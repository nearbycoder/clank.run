# Conversational application building

`clank compose` turns an application request and an agent-proposed blueprint into a reviewable,
deterministic Clank project. The agent proposes data; Clank remains the authority that validates,
plans, and writes the application.

## The shortest safe loop

Ask a coding agent to create a data-only `clank.app.ts`, then review it without changing any
application files:

```sh
clank compose ./my-app \
  --request="Build a private client portal with projects and tasks" \
  --proposal=./proposals/client-portal.clank.app.ts \
  --json
```

The result is a `clank-compose-result/1` review containing:

- the review ID;
- a SHA-256 digest for the exact generated plan;
- every file that would be created, updated, or left unchanged;
- blueprint counts and validation warnings; and
- the exact apply command.

Run that returned command only after inspecting the plan:

```sh
clank compose /absolute/path/to/my-app \
  --review=<review-id> \
  --approve=<plan-digest> \
  --json
```

The target path is part of the stored review. The approval is accepted only when its digest
exactly matches the reviewed plan and every destination still has the same baseline. If a person,
agent, formatter, or build changes a reviewed file first, Clank rejects the review as stale.

## Interactive use

Run `clank` and choose **Build with an agent**, or call `clank compose` directly in a terminal.
The direct command prints the proposed file changes and asks whether to apply, revise, or cancel.
Revision is available when an external agent executable is configured:

```sh
clank compose ./my-app \
  --request="Build a lightweight issue tracker for a design team" \
  --agent=./tools/my-clank-agent
```

Clank can request up to four proposals in one conversation by default. Set `--max-turns` from 1
through 10 and `--agent-timeout` from 1 through 600 seconds. Non-interactive agents and CI should
use `--json` and perform review and approval as separate commands.

## External agent protocol

`--agent` is provider-neutral. Its value must be a real executable file, not a shell command or a
symbolic link. Clank starts it without a shell, writes one JSON object to standard input, and
expects one JSON object on standard output.

The request is `clank-compose-request/1`:

```json
{
  "protocol": "clank-compose-request/1",
  "turn": 1,
  "intent": "Build a private client portal",
  "feedback": null,
  "currentBlueprint": null,
  "history": [],
  "constraints": {
    "frameworkVersion": "0.18.3",
    "approvalRequired": true,
    "dataOnlyBlueprint": true,
    "neverIncludeSecrets": true
  }
}
```

The response must be exactly a `clank-compose-proposal/1` proposal:

```json
{
  "protocol": "clank-compose-proposal/1",
  "type": "proposal",
  "message": "Added private projects, task ownership, and workspace roles.",
  "blueprint": {
    "name": "Client Portal",
    "description": "A private project and task workspace.",
    "entities": {
      "projects": {
        "description": "A customer project.",
        "ownership": "user",
        "displayField": "name",
        "fields": {
          "name": { "type": "string", "min": 1, "max": 120 }
        }
      }
    },
    "routes": [
      { "path": "/", "view": "Projects", "entity": "projects" }
    ],
    "actions": {}
  }
}
```

The blueprint must satisfy the complete [AI blueprint](blueprints.md) contract. Unknown response
fields, invalid protocols, invalid blueprints, output over 1 MiB, nonzero exits, and deadlines fail
closed. Diagnostic stderr is capped at 32 KiB.

Clank passes only a small process environment needed to start the executable; arbitrary CLI and
application environment variables are not forwarded. For an existing app, the normalized current
blueprint is sent as context but `deployment.env` is withheld and preserved if the next proposal
omits it.

The executable still runs as the current operating-system user and therefore has that user's file
and network authority. Use a program you trust, sandbox it when appropriate, and prefer
`--proposal` when a coding agent has already prepared the blueprint through its own controlled
environment.

## Mutation and rollback contract

Creating a review writes only an owner-readable file under:

```text
.clank/compose-reviews/<review-id>.json
```

Application files are not written until approval. Apply uses temporary files and atomic renames.
If any destination or parent becomes unsafe, including through a symbolic link, Clank restores
files already touched during that apply. A successful apply retains an owner-readable audit record
at:

```text
.clank/compose-sessions/<review-id>.json
```

`.clank/` is excluded from generated repositories. Reviews can contain product requirements and
public deployment configuration, so treat the directory as private local state. Never place
passwords, access tokens, private keys, or other secrets in a blueprint; provision deploy secrets
with `clank secrets`.

## Existing applications

Point compose at a generated application to evolve it:

```sh
clank compose . \
  --request="Add customer notes and a read-only auditor role" \
  --agent=./tools/my-clank-agent \
  --json
```

The current normalized blueprint becomes agent context. The review reports `update` only for files
whose generated contents change. Hand-written changes to generated destinations are visible in the
baseline and are never silently overwritten after review.

After applying, verify the product contract and deploy normally:

```sh
npm install
npm test
clank doctor
clank deploy
```

Composition does not authenticate or deploy. It produces the same ordinary, inspectable Clank
project that `clank create` and `clank generate` produce, so the existing build, migration,
security, MCP, and deployment contracts remain in force.
