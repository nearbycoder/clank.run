import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";
import { runCoverageGate } from "./coverage-gate.mjs";

await build();

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  if (packageJson[field] && Object.keys(packageJson[field]).length > 0) {
    throw new Error(`Clank's zero-dependency contract was violated by ${field}.`);
  }
}

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("../docs-site/build.mjs", import.meta.url)),
  ], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0
    ? resolve()
    : reject(new Error(`Documentation site build exited with ${code}.`)));
});

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("../design-site/build.mjs", import.meta.url)),
  ], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0
    ? resolve()
    : reject(new Error(`Design Studio build exited with ${code}.`)));
});

await runCoverageGate();

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("./docs-audit.mjs", import.meta.url)),
  ], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0
    ? resolve()
    : reject(new Error(`Documentation audit exited with ${code}.`)));
});

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("./conformance.mjs", import.meta.url)),
  ], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0
    ? resolve()
    : reject(new Error(`Conformance exited with ${code}.`)));
});

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("./security-audit.mjs", import.meta.url)),
  ], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0
    ? resolve()
    : reject(new Error(`Security audit exited with ${code}.`)));
});

console.log("Check complete: framework, documentation, and Design Studio builds, dependency contract, coverage, documentation, packaged-release conformance, and security audit passed.");
