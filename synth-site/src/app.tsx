/* @clankImportSource ../vendor/dom.js */
import { hydrate } from "../vendor/dom.js";
import { readState } from "../vendor/ssr.js";
import { SynthView, type SynthBootState } from "./view.js";

const boot = readState<SynthBootState>() ?? { frameworkVersion: "unknown" };
const root = document.getElementById("synth-root");
if (root) hydrate(root, <SynthView {...boot} />);
