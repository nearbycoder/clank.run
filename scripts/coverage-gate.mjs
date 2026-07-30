import { spawn } from "node:child_process";

const OUTPUT_TAIL_LIMIT = 256 * 1024;

export const coverageArguments = Object.freeze([
  "--disable-warning=ExperimentalWarning",
  "--test",
  "--experimental-test-coverage",
  "--test-coverage-include=dist/**/*.js",
  "--test-coverage-lines=80",
  "--test-coverage-branches=65",
  "--test-coverage-functions=80",
]);

function appendTail(current, chunk) {
  const combined = current + String(chunk);
  return combined.length <= OUTPUT_TAIL_LIMIT
    ? combined
    : combined.slice(-OUTPUT_TAIL_LIMIT);
}

async function executeCoverageRun() {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, coverageArguments, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputTail = "";
    const forward = (destination) => (chunk) => {
      outputTail = appendTail(outputTail, chunk);
      destination.write(chunk);
    };
    child.stdout.on("data", forward(process.stdout));
    child.stderr.on("data", forward(process.stderr));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code: typeof code === "number" ? code : 1,
      outputTail,
    }));
  });
}

export function isRetryableCoverageArtifactFailure(result) {
  if (result?.code !== 1 || typeof result.outputTail !== "string") return false;
  const output = result.outputTail;
  const tests = Number(output.match(/# tests (\d+)(?:\r?\n|$)/u)?.[1] ?? -1);
  const passed = Number(output.match(/# pass (\d+)(?:\r?\n|$)/u)?.[1] ?? -1);
  const failed = Number(output.match(/# fail (\d+)(?:\r?\n|$)/u)?.[1] ?? -1);
  const cancelled = Number(output.match(/# cancelled (\d+)(?:\r?\n|$)/u)?.[1] ?? -1);
  const skipped = Number(output.match(/# skipped (\d+)(?:\r?\n|$)/u)?.[1] ?? -1);
  const todo = Number(output.match(/# todo (\d+)(?:\r?\n|$)/u)?.[1] ?? -1);
  return /# Warning: Could not report code coverage\. SyntaxError: Unexpected end of JSON input/u.test(output)
    && tests > 0
    && passed > 0
    && failed === 0
    && cancelled === 0
    && skipped >= 0
    && todo >= 0
    && tests === passed + skipped + todo
    && !/(?:^|\n)not ok \d+/u.test(output);
}

export async function runCoverageGate(options = {}) {
  const execute = options.execute ?? executeCoverageRun;
  const writeDiagnostic = options.writeDiagnostic
    ?? ((message) => process.stderr.write(message));
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await execute();
    if (result.code === 0) return;
    if (attempt === 1 && isRetryableCoverageArtifactFailure(result)) {
      writeDiagnostic(
        "\nNode produced a truncated experimental coverage artifact after every test passed; "
        + "retrying the isolated coverage run once.\n\n",
      );
      continue;
    }
    const suffix = attempt === 2 && isRetryableCoverageArtifactFailure(result)
      ? " after the single coverage-artifact retry"
      : "";
    throw new Error(`Tests exited with ${result.code}${suffix}.`);
  }
}
