import type { ContactRecord, CoverageRecord, OutletRecord, ReporterRecord } from "./domain.js";
import { classifyOutletType } from "./media-canonical.js";
import { normalizeName } from "./normalize.js";
import { canonicalCoverageType, resolveSentiment, resolveStatus } from "./coverage-resolvers.js";

export const COVERAGE_REPORT_HEADERS: string[] = [
  "Date", "Title", "Client", "Media Outlet", "Reporter", "Spokespersons ID",
  "Coverage Type", "Sentiment", "Status", "Reach", "URL"
];
export const REPORTER_REPORT_HEADERS: string[] = ["Name", "Outlet", "Email"];
export const OUTLET_REPORT_HEADERS: string[] = ["Outlet", "Outlet Type"];
export const CONTACT_REPORT_HEADERS: string[] = ["Name", "Title", "Email", "Phone"];

export function coverageReportRow(
  record: CoverageRecord,
  outlet: OutletRecord | undefined,
  reporter: ReporterRecord | undefined
): string[] {
  return [
    record.publicationDate,
    record.articleTitle,
    record.clientName,
    outlet?.name ?? record.outlet,
    reporter ? `${reporter.firstName} ${reporter.lastName}`.trim() : record.reporterName,
    record.spokesperson,
    record.coverageType,
    record.sentiment,
    record.status,
    record.reachSource === "prcc" && record.reach !== null && String(record.reach).trim() !== ""
      ? String(record.reach)
      : outlet?.uvm == null ? "" : String(outlet.uvm),
    record.articleUrl
  ];
}

export function reporterReportRow(reporter: ReporterRecord): string[] {
  return [`${reporter.firstName} ${reporter.lastName}`.trim(), reporter.outlet, reporter.email];
}

export function outletReportRow(record: CoverageRecord, outlet: OutletRecord | undefined): string[] {
  const outletType = record.outletType || classifyOutletType(record.outlet, record.originalPressType, record.coverageType).outletType;
  return [outlet?.name ?? record.outlet, outletType];
}

/** A report reporter is unique by the fields represented in its tab. */
export function reporterReportKey(reporter: Pick<ReporterRecord, "firstName" | "lastName" | "outlet">): string {
  return [reporter.firstName, reporter.lastName, reporter.outlet].map(normalizeName).join("|");
}

export function contactReportRow(contact: ContactRecord): string[] {
  return [contact.name, contact.title, contact.email, contact.phone];
}

/**
 * Contacts are client-scoped. Keep the first stored record for an identical
 * canonical contact row so generating a report never emits duplicate rows.
 */
export function uniqueContactReportRows(contacts: ContactRecord[], clientName: string): string[][] {
  const rows = new Map<string, string[]>();
  for (const contact of contacts) {
    if (normalizeName(contact.clientName ?? "") !== normalizeName(clientName)) continue;
    const row = contactReportRow(contact);
    const key = row.map(normalizeName).join("|");
    if (!key.replaceAll("|", "")) continue;
    if (!rows.has(key)) rows.set(key, row);
  }
  return [...rows.values()];
}

function legacyField(row: unknown[], indexByHeader: Map<string, number>, names: string[], fallbackIndex?: number): string {
  for (const name of names) {
    const index = indexByHeader.get(normalizeName(name));
    if (index !== undefined) return String(row[index] ?? "").trim();
  }
  return fallbackIndex === undefined ? "" : String(row[fallbackIndex] ?? "").trim();
}

/**
 * Converts an older Coverage worksheet into the canonical eleven report
 * columns using header names first. The positional fallback only supports the
 * prior five-column layout: Date, Outlet, Reporter, Title, URL.
 */
export function canonicalCoverageRowsFromLegacy(rows: unknown[][]): string[][] {
  const headers = (rows[0] ?? []).map((value) => String(value ?? ""));
  const indexByHeader = new Map(headers.map((header, index) => [normalizeName(header), index]));
  return rows.slice(1).map((row) => {
    const date = legacyField(row, indexByHeader, ["Date", "Publication Date"], 0);
    const outlet = legacyField(row, indexByHeader, ["Media Outlet", "Outlet", "Publication"], 1);
    const reporter = legacyField(row, indexByHeader, ["Reporter"], 2);
    const link = legacyField(row, indexByHeader, ["Link"], 3);
    const explicitTitle = legacyField(row, indexByHeader, ["Title", "Article Title"]);
    const explicitUrl = legacyField(row, indexByHeader, ["URL", "Article URL"], 4);
    const title = explicitTitle || (/^https?:\/\//i.test(link) ? "" : link);
    const url = explicitUrl || (/^https?:\/\//i.test(link) ? link : "");
    const coverageType = canonicalCoverageType(legacyField(row, indexByHeader, ["Coverage Type", "Press Type"]));
    return [
      date,
      title,
      legacyField(row, indexByHeader, ["Client"]),
      outlet,
      reporter,
      legacyField(row, indexByHeader, ["Spokespersons ID", "Spokesperson"]),
      coverageType,
      resolveSentiment(legacyField(row, indexByHeader, ["Sentiment"])),
      resolveStatus(legacyField(row, indexByHeader, ["Status", "Coverage Status"])),
      legacyField(row, indexByHeader, ["Reach", "UVM"]),
      url
    ];
  });
}
