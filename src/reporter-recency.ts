import type { CoverageRecord, ReporterIdentity, ReporterRecord } from "./domain.js";

function identity(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function reporterMatchesArticle(reporter: ReporterRecord, article: CoverageRecord): boolean {
  const articleParts = article.reporterName.trim().split(/\s+/).filter(Boolean);
  const articleIdentity: ReporterIdentity = {
    firstName: articleParts[0] ?? "",
    lastName: articleParts.slice(1).join(" "),
    outlet: article.outlet
  };
  const matches = (candidate: ReporterIdentity) =>
    identity(candidate.firstName) === identity(articleIdentity.firstName) &&
    identity(candidate.lastName) === identity(articleIdentity.lastName) &&
    identity(candidate.outlet) === identity(articleIdentity.outlet);
  return matches(reporter) || (reporter.identityAliases ?? []).some(matches);
}

/** Accept date-only ISO dates and valid timestamps; reject malformed calendar dates. */
export function validPublicationDate(value: string | undefined): string | null {
  const input = String(value ?? "").trim();
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (!match) return null;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (input.includes("T") && !Number.isFinite(Date.parse(input))) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function deriveMostRecentArticles(reporters: ReporterRecord[], coverage: CoverageRecord[]): ReporterRecord[] {
  const clientsById = new Map<string, string[]>();
  const dates = new Map<string, string>();
  for (const article of coverage) {
    const date = validPublicationDate(article.publicationDate);
    const reporterId = article.reporterId?.trim();
    let candidates = reporterId ? [reporterId] : [];
    if (!candidates.length) candidates = reporters.filter((reporter) => reporterMatchesArticle(reporter, article)).map((reporter) => reporter.id);
    for (const id of candidates) {
      if (!reporters.some((reporter) => reporter.id === id)) continue;
      if (article.clientName.trim()) {
        const clients = clientsById.get(id) ?? [];
        if (!clients.some((client) => identity(client) === identity(article.clientName))) clients.push(article.clientName.trim());
        clientsById.set(id, clients);
      }
      if (date && date > (dates.get(id) ?? "")) dates.set(id, date);
    }
  }
  return reporters.map((reporter) => ({
    ...reporter,
    clientsCovered: (clientsById.get(reporter.id) ?? []).join(", "),
    mostRecentArticle: dates.get(reporter.id) ?? ""
  }));
}

export function reporterCutoffDate(asOf = new Date()): string {
  const targetMonthIndex = asOf.getFullYear() * 12 + asOf.getMonth() - 18;
  const year = Math.floor(targetMonthIndex / 12);
  const month = targetMonthIndex % 12;
  const day = Math.min(asOf.getDate(), new Date(year, month + 1, 0).getDate());
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isReporterCurrent(reporter: ReporterRecord, asOf = new Date()): boolean {
  return Boolean(reporter.mostRecentArticle) && reporter.mostRecentArticle >= reporterCutoffDate(asOf);
}
