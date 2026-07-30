import test from "node:test";
import assert from "node:assert/strict";
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
  const results = [truncatedCoverage, { code: 0, outputTail: "" }];
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
