import type {
  CoverageRecord,
  ReporterRecord,
  OutletRecord,
  ContactRecord,
} from "./domain.js";
export const WORKBOOK_VERSION = "five-tab-calibri-v2";
export const TEMPLATE_HEADERS = {
  Coverage: [
    "Date",
    "Title",
    "Client",
    "Media Outlet",
    "Reporter",
    "Spokespersons ID",
    "Coverage Type",
    "Sentiment",
    "Status",
    "Reach",
    "URL",
  ],
  Reporters: ["Name", "Outlet", "Email"],
  Outlets: ["Outlet", "Outlet Type", "Monthly Reach / UVM"],
  "Client Contact": ["Name", "Title", "Email", "Phone"],
  "Team Contact": ["Name", "Title", "Email", "Phone"],
} as const;
export type TemplateTab = keyof typeof TEMPLATE_HEADERS;
// Reference workbook: Calibri, plain bold headers, frozen Coverage row, title 33.63 Excel units (~240px).
// Other columns widened for readability; freeze all five headers as requested.
export const TEMPLATE_WIDTHS: Record<TemplateTab, number[]> = {
  Coverage: [105, 240, 125, 190, 170, 160, 115, 110, 115, 140, 360],
  Reporters: [190, 190, 260],
  Outlets: [220, 190, 125],
  "Client Contact": [190, 200, 260, 160],
  "Team Contact": [190, 200, 260, 160],
};
export interface TemplateContext {
  reporters?: ReporterRecord[];
  outlets?: (OutletRecord & { outletType?: string })[];
  clientContacts?: ContactRecord[];
  teamContacts?: ContactRecord[];
}
export const identity = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");
export function workbookRows(
  client: string,
  records: CoverageRecord[],
  context: TemplateContext = {},
) {
  const sorted = [...records].sort((a, b) =>
    b.publicationDate.localeCompare(a.publicationDate),
  );
  const reporters = new Map<string, string[]>(),
    outlets = new Map<string, (string | number)[]>();
  for (const record of sorted) {
    const name = record.reporterName.trim(),
      outlet = record.outlet.trim();
    if (name && !/^(n\/?a|unknown|tbd)$/i.test(name)) {
      const key = `${identity(name)}|${identity(outlet)}`;
      const matches = (context.reporters ?? []).filter(
        (r) =>
          identity(`${r.firstName} ${r.lastName}`) === identity(name) &&
          identity(r.outlet) === identity(outlet) &&
          r.status === "Active",
      );
      const emails = [
        ...new Set(
          matches
            .map((r) => r.email.trim())
            .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)),
        ),
      ];
      if (!reporters.has(key))
        reporters.set(key, [
          name,
          outlet,
          emails.length === 1 ? emails[0] : "",
        ]);
    }
    if (outlet && !outlets.has(identity(outlet))) {
      const verified = (context.outlets ?? []).find(
        (o) => identity(o.name) === identity(outlet),
      );
      const originalReach = sorted.find(
        (r) =>
          identity(r.outlet) === identity(outlet) &&
          r.source === "PRCC" &&
          r.reach !== null &&
          String(r.reach).trim(),
      );
      outlets.set(identity(outlet), [
        outlet,
        verified?.outletType ?? "",
        verified?.uvm ?? originalReach?.reach ?? "",
      ]);
    }
  }
  const contacts = (rows: ContactRecord[], allowGlobal = false) => {
    const unique = new Map<string, string[]>();
    for (const c of rows) {
      if (
        (!c.clientName && !allowGlobal) ||
        (c.clientName && identity(c.clientName) !== identity(client))
      )
        continue;
      const row = [c.name, c.title, c.email, c.phone];
      if (row.some(Boolean)) unique.set(row.map(identity).join("|"), row);
    }
    return [...unique.values()];
  };
  return {
    Coverage: sorted.map((r) => [
      r.publicationDate,
      r.articleTitle,
      r.clientName,
      r.outlet,
      r.reporterName,
      r.spokesperson,
      r.originalPressType || r.coverageType,
      r.sentiment,
      r.status,
      r.reach ?? "",
      r.articleUrl,
    ]),
    Reporters: [...reporters.values()],
    Outlets: [...outlets.values()],
    "Client Contact": contacts(context.clientContacts ?? []),
    "Team Contact": contacts(context.teamContacts ?? [], true),
  };
}
/** Append missing reliable contacts, never replace a manual value or existing row. */
export function mergeContactRows(
  existing: unknown[][],
  incoming: unknown[][],
): unknown[][] {
  const output = existing.map((row) => [...row]);
  const seen = new Set(
    existing.map(
      (row) =>
        `${identity(String(row[0] ?? ""))}|${identity(String(row[2] ?? ""))}`,
    ),
  );
  const names = new Set(
    existing.map((row) => identity(String(row[0] ?? ""))).filter(Boolean),
  );
  for (const row of incoming) {
    const name = identity(String(row[0] ?? ""));
    const key = `${name}|${identity(String(row[2] ?? ""))}`;
    if (!seen.has(key) && (!name || !names.has(name))) {
      output.push(row);
      seen.add(key);
      if (name) names.add(name);
    }
  }
  return output;
}
