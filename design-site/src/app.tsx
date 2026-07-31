/* @clankImportSource ../vendor/dom.js */
import { hydrate } from "../vendor/dom.js";
import { readState } from "../vendor/ssr.js";
import { DesignStudio, type DesignStudioProps } from "./studio.js";

const boot = readState<DesignStudioProps>() ?? {
  initialView: "overview",
  initialTheme: "clank",
  frameworkVersion: "unknown",
};

const root = document.getElementById("design-root");
if (root) hydrate(root, <DesignStudio {...boot} />);
document.documentElement.dataset.designEnhanced = "true";
