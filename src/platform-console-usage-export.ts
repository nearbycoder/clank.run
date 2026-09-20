type ConsoleUsageExport = {
  workspace: { slug: string };
  period: { key: string };
  projects: readonly {
    name: string; slug: string; kind: string; deleted: boolean;
    requests: number; knownTransferBytes: number; rejectedRequests: number; updatedAt: number | null;
  }[];
};

/** Internal local export of the console's already-authorized monthly project rows. */
export function exportConsoleUsageCsv(data: ConsoleUsageExport): { filename: string; csv: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(data.period.key)) throw new TypeError("Invalid usage month.");
  const cell = (value: string | number): string => {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError("Invalid usage count.");
    let text = String(value);
    if (typeof value === "string" && (/^[\s\u0000-\u001f\u007f-\u009f]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const rows: (string | number)[][] = [["Project", "Slug", "Type", "Deleted", "Requests", "Known transfer bytes", "Rejected requests", "Last recorded (UTC)"]];
  for (const project of data.projects) rows.push([
    project.name, project.slug, project.kind, project.deleted ? "yes" : "no",
    project.requests, project.knownTransferBytes, project.rejectedRequests,
    project.updatedAt === null ? "" : new Date(project.updatedAt).toISOString(),
  ]);
  const slug = data.workspace.slug.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "workspace";
  return { filename: "usage-" + slug + "-" + data.period.key + ".csv", csv: rows.map(row => row.map(cell).join(",") + "\r\n").join("") };
}
