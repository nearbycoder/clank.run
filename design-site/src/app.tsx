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
document.documentElement.dataset.designEnhanced = "loading";
try {
  if (root) hydrate(root, <DesignStudio {...boot} />);
  document.documentElement.dataset.designEnhanced = "true";
} catch (error) {
  document.documentElement.dataset.designEnhanced = "failed";
  document.documentElement.dataset.designEnhancementError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  throw error;
}
