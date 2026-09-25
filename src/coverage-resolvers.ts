import type { CoverageRecord, CoverageStatus, CoverageType, ExtractedCoverage, OutletRecord, ReporterRecord } from "./domain.js";
import { normalizeName } from "./normalize.js";
import { classifyOutletType, coverageTypeFromPressType, normalizeCoverageStatus } from "./media-canonical.js";

export const COVERAGE_TYPES = [
  "Earned Coverage",
  "Contributed Content",
  "Podcast Interview",
  "Awards & Recognition",
  "Speaking Engagement",
  "Newsletter Inclusion",
  "Press Release",
  "Press Release & Earned Coverage Syndication",
  "Missed Opportunity"
] as const;

const coverageTypeSet = new Set<string>(COVERAGE_TYPES);

export function classifyCoverageType(
  input: Pick<ExtractedCoverage, "articleTitle" | "outlet" | "reporterName" | "spokesperson" | "coverageType" | "originalPressType">
): CoverageType {
  const supplied = input.coverageType.trim();
  const suppliedCoverageType = coverageTypeSet.has(supplied) ? supplied as CoverageType : undefined;
  const normalizedSupplied = COVERAGE_TYPES.find(
    (value) => normalizeName(value) === normalizeName(supplied)
  );
  const sourceFallback = suppliedCoverageType ?? normalizedSupplied ?? "Earned Coverage";
  if (input.originalPressType.trim()) {
    return coverageTypeFromPressType(input.originalPressType, sourceFallback);
  }
  if (suppliedCoverageType) return suppliedCoverageType;
  if (normalizedSupplied) return normalizedSupplied;

  const text = [
    input.articleTitle,
    input.outlet,
    input.reporterName,
    input.spokesperson,
    supplied
  ].join(" ").toLowerCase();

  if (/press release/.test(text) && /syndicat/.test(text)) {
    return "Press Release & Earned Coverage Syndication";
  }
  if (/press release/.test(text)) return "Press Release";
  if (/podcast|video series|webinar/.test(text)) return "Podcast Interview";
  if (/award|recognition|honoree|winner/.test(text)) return "Awards & Recognition";
  if (/speaking|keynote|conference|panel/.test(text)) return "Speaking Engagement";
  if (/newsletter/.test(text)) return "Newsletter Inclusion";
  if (/missed opportunity/.test(text)) return "Missed Opportunity";
  if (/contributed|op-ed|op ed|guest post/.test(text)) return "Contributed Content";
  return "Earned Coverage";
}

export function resolveSentiment(_value: string | undefined | null): "Positive" {
  return "Positive";
}

export function resolveStatus(value: string | undefined | null): CoverageStatus {
  return normalizeCoverageStatus(value);
}

export function resolveOutletReach(
  outletName: string,
  outlets: OutletRecord[]
): number | null {
  const target = normalizeName(outletName);
  if (!target) return null;
  const outlet = outlets.find((item) => normalizeName(item.name) === target);
  return outlet?.uvm ?? null;
}

export function resolveReporter(
  reporterName: string,
  outletName: string,
  reporters: ReporterRecord[]
): ReporterRecord | undefined {
  const parts = reporterName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length || /^(n\/a|na|unknown|tbd)$/i.test(reporterName.trim())) {
    return undefined;
  }
  const firstName = parts.shift() ?? "";
  const lastName = parts.join(" ");
  return reporters.find((reporter) =>
    normalizeName(reporter.firstName) === normalizeName(firstName) &&
    normalizeName(reporter.lastName) === normalizeName(lastName) &&
    normalizeName(reporter.outlet) === normalizeName(outletName)
  );
}

export function applyCoverageDefaults(
  input: ExtractedCoverage,
  outlets: OutletRecord[]
): ExtractedCoverage {
  const coverageType = classifyCoverageType(input);
  const explicitReach = input.reach !== null && String(input.reach).trim() !== "";
  const outletType = classifyOutletType(input.outlet, input.originalPressType, coverageType);
  return {
    ...input,
    coverageType,
    sentiment: resolveSentiment(input.sentiment),
    status: resolveStatus(input.status),
    reach: explicitReach ? input.reach : resolveOutletReach(input.outlet, outlets)
  };
}

export function canonicalCoverageType(value: string): CoverageType {
  return COVERAGE_TYPES.find((candidate) => normalizeName(candidate) === normalizeName(value))
    ?? "Earned Coverage";
}

export function normalizeCanonicalRecord(record: CoverageRecord): CoverageRecord {
  const originalPressType = record.originalPressType ?? record.rawFields?.["Press Type"] ?? "";
  const titleWasMisfiledAsStatus = !record.articleTitle &&
    record.status &&
    !/^(completed|on hold|pending|live|hold|passed|missed|planned|upcoming|scheduled|tbd)$/i.test(record.status);
  const coverageType = record.originalPressType || record.rawFields?.["Press Type"]
    ? coverageTypeFromPressType(originalPressType, canonicalCoverageType(record.coverageType))
    : canonicalCoverageType(record.coverageType);
  const outlet = classifyOutletType(record.outlet, originalPressType, coverageType);
  return {
    ...record,
    articleTitle: titleWasMisfiledAsStatus ? record.status : record.articleTitle,
    originalPressType,
    coverageType,
    sentiment: resolveSentiment(record.sentiment),
    status: resolveStatus(titleWasMisfiledAsStatus ? "" : record.status),
    outletType: record.outletType ?? outlet.outletType,
    outletTypeConfidence: record.outletTypeConfidence ?? outlet.confidence
  };
}
