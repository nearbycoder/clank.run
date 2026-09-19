import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { compile } from "../scripts/compiler.mjs";
import {
  coverageArguments,
  isRetryableCoverageArtifactFailure,
  runCoverageGate,
} from "../scripts/coverage-gate.mjs";

const truncatedCoverage = {
  code: 1,
  outputTail: [
    "1..372",
    "# Warning: Could not report code coverage. SyntaxError: Unexpected end of JSON input",
    "# tests 372",
    "# pass 372",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "",
  ].join("\n"),
};

const measuredCoverage = {
  code: 0,
  outputTail: [
    "# start of coverage report",
    "# file | line % | branch % | funcs % | uncovered lines",
    "# dist | | | |",
    "#  framework.js | 90.00 | 75.00 | 85.00 | 5-10",
    "# all files | 90.00 | 75.00 | 85.00 |",
    "# end of coverage report",
  ].join("\n"),
};

test("coverage gate retries only a truncated artifact after every test passed", async () => {
  assert.equal(isRetryableCoverageArtifactFailure(truncatedCoverage), true);
  assert.equal(isRetryableCoverageArtifactFailure({
    ...truncatedCoverage,
    outputTail: `${truncatedCoverage.outputTail}not ok 12 - failed test\n`,
  }), false);
  assert.equal(isRetryableCoverageArtifactFailure({
    code: 1,
    outputTail: "# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n",
  }), false);
  assert.equal(isRetryableCoverageArtifactFailure({
    code: 1,
    outputTail: "# tests 372\n# pass 372\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\nERROR: Coverage for lines (79%) does not meet global threshold (80%)\n",
  }), false);
  assert.equal(isRetryableCoverageArtifactFailure({
    ...truncatedCoverage,
    outputTail: truncatedCoverage.outputTail.replace("# cancelled 0", "# cancelled 1"),
  }), false);
  assert.equal(isRetryableCoverageArtifactFailure({
    ...truncatedCoverage,
    outputTail: truncatedCoverage.outputTail.replace("# tests 372", "# tests 373"),
  }), false);
  assert.equal(isRetryableCoverageArtifactFailure({
    ...truncatedCoverage,
    code: 2,
  }), false);
});

test("coverage gate performs one bounded retry without masking persistent failures", async () => {
  const results = [truncatedCoverage, measuredCoverage];
  const diagnostics = [];
  let calls = 0;
  await runCoverageGate({
    execute: async () => {
      calls++;
      return results.shift();
    },
    writeDiagnostic: (message) => diagnostics.push(message),
  });
  assert.equal(calls, 2);
  assert.match(diagnostics.join(""), /retrying the isolated coverage run once/u);

  calls = 0;
  await assert.rejects(
    runCoverageGate({
      execute: async () => {
        calls++;
        return { code: 1, outputTail: "# tests 2\n# pass 1\n# fail 1\n" };
      },
      writeDiagnostic: () => assert.fail("A real test failure must not be retried."),
    }),
    /Tests exited with 1\./u,
  );
  assert.equal(calls, 1);

  await assert.rejects(
    runCoverageGate({
      execute: async () => truncatedCoverage,
      writeDiagnostic: () => {},
    }),
    /single coverage-artifact retry/u,
  );
});

test("coverage gate keeps the release thresholds explicit", () => {
  assert.deepEqual(coverageArguments.slice(-4), [
    "--test-coverage-include=dist/**/*.js",
    "--test-coverage-lines=80",
    "--test-coverage-branches=65",
    "--test-coverage-functions=80",
  ]);
  assert.equal(Object.isFrozen(coverageArguments), true);
});


test("coverage gate fails closed when successful tests measure no JavaScript files", async () => {
  for (const outputTail of ["", "# tests 2\n# pass 2\n", measuredCoverage.outputTail.replace(/^#  framework\.js.*\n/mu, "")]) {
    let calls = 0;
    await assert.rejects(runCoverageGate({
      execute: async () => { calls++; return { code: 0, outputTail }; },
      writeDiagnostic: () => assert.fail("Empty coverage must not be retried."),
    }), /no measured JavaScript files/u);
    assert.equal(calls, 1);
  }
  await runCoverageGate({ execute: async () => measuredCoverage });
});

test("unmapped compiler output remains measurable under its emitted dist path", async () => {
  const root = await mkdtemp(join(tmpdir(), "clank-coverage-regression-"));
  try {
    await mkdir(join(root, "dist"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const source = `export function add(left: number, right: number): number { return left + right; }
export function unused(): number {
  return 42;
}`;
    const javascript = compile(source, { filename: join(root, "src", "example.ts"), sourceMap: false });
    assert.doesNotMatch(javascript, /source(?:Mapping)?URL=/u);
    assert.match(compile(source, { filename: "example.ts", sourceMap: true }), /sourceMappingURL=/u);
    await writeFile(join(root, "dist", "example.js"), javascript);
    await writeFile(join(root, "tests", "example.test.mjs"), `import test from "node:test";
import assert from "node:assert/strict";
import { add } from "../dist/example.js";
test("addition", () => assert.equal(add(2, 3), 5));`);
    const env = { ...process.env };
    delete env.NODE_V8_COVERAGE;
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      "--test", "--test-reporter=tap", "--experimental-test-coverage", "--test-coverage-include=dist/**/*.js",
    ], { cwd: root, env, encoding: "utf8", timeout: 30000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const row = result.stdout.match(/^#\s+example\.js\s+\|\s+([0-9.]+)\s+\|\s+([0-9.]+)\s+\|\s+([0-9.]+)\s+\|/mu);
    assert.ok(row, `Expected coverage for emitted dist/example.js:\n${result.stdout}`);
    assert.ok(Number(row[3]) < 100, "The uncalled exported function must be included in coverage.");
    await runCoverageGate({ execute: async () => ({ code: result.status, outputTail: result.stdout }) });
  } finally { await rm(root, { recursive: true, force: true }); }
});
