import type { ExtractedCoverage } from "./domain.js";

export function clean(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function normalizeName(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|co|company)\.?\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeUrl(value: string): string {
  return clean(value);
}

export function normalizeDate(value: string): string {
  const input = clean(value);
  if (!input) return "";
  const parsed = new Date(input);
  if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString().slice(0, 10);
  const match = input.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!match) return input;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

export function normalizeCoverage(input: ExtractedCoverage): ExtractedCoverage {
  return {
    clientName: clean(input.clientName),
    reporterName: clean(input.reporterName),
    outlet: clean(input.outlet),
    publicationDate: normalizeDate(input.publicationDate),
    articleTitle: clean(input.articleTitle),
    articleUrl: normalizeUrl(input.articleUrl),
    spokesperson: clean(input.spokesperson),
    originalPressType: clean(input.originalPressType),
    coverageType: clean(input.coverageType),
    sentiment: clean(input.sentiment),
    status: clean(input.status),
    reach: typeof input.reach === "number" && Number.isFinite(input.reach)
      ? input.reach
      : typeof input.reach === "string"
        ? clean(input.reach)
        : null,
      rawFields: { ...(input.rawFields ?? {}) },
    topics: (input.topics ?? []).map(clean).filter(Boolean)
  };
}

export function slug(value: string): string {
  return normalizeName(value).replace(/\s+/g, "-") || "unknown";
}
