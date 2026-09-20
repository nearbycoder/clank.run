import { createClankThemeStylesheet, getClankTheme } from "../../vendor/ui.js";

export type ThemeExportFormat = "css" | "json";
export interface ThemeExportFile {
  filename: string;
  mediaType: string;
  contents: string;
}

/** Only canonical presets can supply export values, metadata, or filenames. */
export function createThemeExport(themeId: string, format: ThemeExportFormat): ThemeExportFile {
  const theme = typeof themeId === "string" ? getClankTheme(themeId) : undefined;
  if (!theme) throw new TypeError("Select an existing theme preset to export.");
  if (format !== "css" && format !== "json") throw new TypeError("Choose CSS or JSON to export.");
  return {
    filename: `clank-theme-${theme.id}.${format}`,
    mediaType: format === "css" ? "text/css;charset=utf-8" : "application/json;charset=utf-8",
    contents: format === "css" ? createClankThemeStylesheet([theme]) : `${JSON.stringify(theme, null, 2)}\n`,
  };
}

export async function copyThemeExport(file: ThemeExportFile, clipboard?: Pick<Clipboard, "writeText">): Promise<string> {
  if (!clipboard) return "Copy is unavailable. Select the preview text and copy it manually, or download the file.";
  try {
    await clipboard.writeText(file.contents);
    return `Copied ${file.filename}.`;
  } catch {
    return "Could not copy. Select the preview text and copy it manually, or download the file.";
  }
}

export function downloadThemeExport(file: ThemeExportFile): void {
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([file.contents], { type: file.mediaType }));
  try {
    link.href = url;
    link.download = file.filename;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // Give the browser time to consume the download before releasing its URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
