import type { CoverageRecord, UrlResolutionEvidence } from "./domain.js";
import { normalizeDate, normalizeName } from "./normalize.js";

export interface UrlSearchResult { title?: string; url?: string; snippet?: string; publishedDate?: string; }
export interface UrlSearchProvider { search(query: string): Promise<UrlSearchResult[]>; }
export interface CoverageUrlResolution {
  coverageId: string; query: string; articleUrl: string;
  confidence: "verified" | "candidate" | "unresolved";
  outcome: "verified" | "candidate" | "unresolved" | "manual" | "prcc";
  evidence: UrlResolutionEvidence;
}

/** Keeps explicit repair requests bounded without ever selecting manual or PRCC URLs. */
export function selectCoverageUrlResolutionRecords(
  records: CoverageRecord[], ids: string[], clients: string[], limit: number
): CoverageRecord[] {
  return records.filter((record) =>
    record.urlSource !== "manual" && record.urlSource !== "prcc" &&
    (!record.articleUrl || record.urlConfidence === "candidate") &&
    (ids.includes(record.id) || clients.includes(normalizeName(record.clientName)))
  ).slice(0, Math.min(Math.max(limit, 1), 25));
}

function isHttpUrl(value: string | undefined): value is string { return Boolean(value && /^https?:\/\/\S+$/i.test(value)); }
function words(value: string): Set<string> { return new Set(normalizeName(value).split(" ").filter((word) => word.length > 1)); }
function compact(value: string): string { return normalizeName(value).replaceAll(" ", ""); }
function titleSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeName(left); const normalizedRight = normalizeName(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  const leftWords = words(left); const rightWords = words(right);
  return [...leftWords].filter((word) => rightWords.has(word)).length / Math.max(leftWords.size, rightWords.size);
}
function dateDistanceDays(left: string, right: string | undefined): number | null {
  if (!right) return null;
  const leftDate = Date.parse(normalizeDate(left)); const rightDate = Date.parse(normalizeDate(right));
  return Number.isNaN(leftDate) || Number.isNaN(rightDate) ? null : Math.round(Math.abs(leftDate - rightDate) / 86_400_000);
}
const OUTLET_ALIAS_GROUPS = [
  ["barrons"],
  ["wsj", "wallstreetjournal", "thewallstreetjournal"],
  ["bloomberg", "bloombergnews"],
  ["fa", "famag", "famagazine", "financialadvisormagazine", "financialadvisor"],
  ["marketsgroup"],
  ["businesswire"],
  ["realassetsadviser", "institutionalrealestate", "irei"],
  ["cnbc"],
  ["reuters"],
  ["latimes", "losangelestimes"],
  ["wealthmanagement", "wealthmanagementcom"]
];
function outletIdentityKeys(outlet: string): string[] {
  const raw = compact(outlet);
  const base = compact(outlet.replace(/\b(the|news|magazine|com)\b/gi, " "));
  const group = OUTLET_ALIAS_GROUPS.find((aliases) => aliases.includes(raw) || aliases.includes(base));
  return group ?? (base ? [base] : []);
}
function hostMatchesOutlet(url: string, outlet: string, expectedDomains: string[]): boolean {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  if (expectedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return true;
  const hostKey = host.replaceAll(/[^a-z0-9]/g, "");
  return outletIdentityKeys(outlet).some((key) => key.length >= 3 && hostKey.includes(key));
}
function isSpecificContentUrl(url: string): boolean {
  const parsed = new URL(url);
  return Boolean(parsed.pathname.replace(/\/+$/, "") || parsed.search || parsed.hash);
}
function isFlexibleContentType(record: CoverageRecord): boolean {
  const type = normalizeName(record.coverageType);
  const outlet = normalizeName(record.outlet);
  return /podcast|video|radio|broadcast/.test(type) || /bloomberg surveillance/.test(type) || /bloomberg surveillance/.test(outlet);
}
function queryFor(record: CoverageRecord): string {
  return [`"${record.articleTitle}"`, record.outlet, record.reporterName, record.publicationDate, record.clientName, record.coverageType].filter(Boolean).join(" ");
}

/** Accepts only a strongly evidenced result; it never constructs URLs or replaces manual/PRCC URLs. */
export async function resolveCoverageUrl(record: CoverageRecord, provider: UrlSearchProvider | undefined, expectedOutletDomains: string[] = []): Promise<CoverageUrlResolution> {
  const query = queryFor(record);
  const emptyEvidence: UrlResolutionEvidence = { selectedUrl: "", query, outletDomainMatch: false, titleSimilarity: 0, reporterMatch: null, publicationDateDistanceDays: null, score: 0 };
  if (record.urlSource === "manual") return { coverageId: record.id, query, articleUrl: record.articleUrl, confidence: "verified", outcome: "manual", evidence: emptyEvidence };
  if (isHttpUrl(record.articleUrl) && record.urlSource !== "resolved") return { coverageId: record.id, query, articleUrl: record.articleUrl, confidence: "verified", outcome: "prcc", evidence: emptyEvidence };
  if (!provider || !record.articleTitle.trim()) return { coverageId: record.id, query, articleUrl: "", confidence: "unresolved", outcome: "unresolved", evidence: emptyEvidence };

  const reporterKey = normalizeName(record.reporterName);
  const reporterRequired = Boolean(reporterKey && !/^(n a|na|unknown|tbd)$/.test(reporterKey));
  const candidates = (await provider.search(query)).filter((result): result is UrlSearchResult & { url: string } => isHttpUrl(result.url)).map((result) => {
    const text = `${result.title ?? ""} ${result.snippet ?? ""}`;
    const similarity = titleSimilarity(record.articleTitle, result.title ?? result.snippet ?? "");
    const outletDomainMatch = hostMatchesOutlet(result.url, record.outlet, expectedOutletDomains);
    const reporterMatch = reporterRequired ? normalizeName(text).includes(reporterKey) : null;
    const clientKey = normalizeName(record.clientName);
    const clientMatch = Boolean(clientKey && normalizeName(text).includes(clientKey));
    const publicationDateDistanceDays = dateDistanceDays(record.publicationDate, result.publishedDate);
    const dateVerifiedCompatible = publicationDateDistanceDays === null || publicationDateDistanceDays <= 14;
    const dateContradictory = publicationDateDistanceDays !== null && publicationDateDistanceDays > 45;
    const specificContentUrl = isSpecificContentUrl(result.url);
    const contentContextMatch = Boolean(reporterMatch || clientMatch);
    const score = similarity * 6 + (outletDomainMatch ? 3 : 0) + (reporterMatch ? 0.75 : 0) +
      (clientMatch ? 0.75 : 0) + (publicationDateDistanceDays !== null && publicationDateDistanceDays <= 14 ? 0.75 : 0) +
      (specificContentUrl ? 0.5 : -6) + (dateContradictory ? -3 : 0);
    return { result, similarity, outletDomainMatch, reporterMatch, publicationDateDistanceDays, dateVerifiedCompatible, dateContradictory, specificContentUrl, contentContextMatch, score };
  }).sort((left, right) => right.score - left.score);

  const best = candidates[0]; const second = candidates[1];
  const accepted = Boolean(best && best.similarity >= 0.85 && best.outletDomainMatch && best.dateVerifiedCompatible && best.specificContentUrl && best.score >= 8 && (!second || best.score - second.score >= 1));
  if (!best) return { coverageId: record.id, query, articleUrl: "", confidence: "unresolved", outcome: "unresolved", evidence: emptyEvidence };
  const evidence: UrlResolutionEvidence = { selectedUrl: best.result.url, query, outletDomainMatch: best.outletDomainMatch, titleSimilarity: best.similarity, reporterMatch: best.reporterMatch, publicationDateDistanceDays: best.publicationDateDistanceDays, score: best.score };
  if (accepted) return { coverageId: record.id, query, articleUrl: best.result.url, confidence: "verified", outcome: "verified", evidence };

  // Missing date/reporter metadata is neutral. Candidates need strong title evidence, or
  // outlet/platform evidence plus contextual support for flexible broadcast content.
  const strongTitleWithOutlet = best.outletDomainMatch && best.similarity >= 0.65;
  const veryStrongTitle = best.similarity >= 0.85;
  const flexibleContentCandidate = isFlexibleContentType(record) && best.outletDomainMatch &&
    best.similarity >= 0.4 && best.contentContextMatch;
  const candidateAccepted = best.specificContentUrl && !best.dateContradictory &&
    (strongTitleWithOutlet || veryStrongTitle || flexibleContentCandidate) && best.score >= 5.5 &&
    (!second || best.score - second.score >= 0.75);
  if (!candidateAccepted) return { coverageId: record.id, query, articleUrl: "", confidence: "unresolved", outcome: "unresolved", evidence };
  return { coverageId: record.id, query, articleUrl: best.result.url, confidence: "candidate", outcome: "candidate", evidence };
}
