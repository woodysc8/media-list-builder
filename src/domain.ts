export type IngestionSource =
  | "PRCC"
  | "Slack"
  | "Manual PDF"
  | "CSV"
  | "JSON"
  | "Text";

export type ReporterType =
  | "reporter"
  | "podcast"
  | "influencer"
  | "broadcast";

export type ReporterStatus =
  | "Active"
  | "Inactive"
  | "Needs Review";

export type CoverageType =
  | "Earned Coverage"
  | "Contributed Content"
  | "Podcast Interview"
  | "Awards & Recognition"
  | "Speaking Engagement"
  | "Newsletter Inclusion"
  | "Press Release"
  | "Press Release & Earned Coverage Syndication"
  | "Missed Opportunity";

export type Beat =
  | "Wealth Management"
  | "Financial Advisors"
  | "RIAs"
  | "Asset Management"
  | "Investments"
  | "Financial Planning"
  | "Retirement"
  | "Fintech"
  | "Wealthtech"
  | "Advisor Technology"
  | "M&A"
  | "Private Equity"
  | "Venture Capital"
  | "Banking"
  | "Insurance"
  | "Regulation & Compliance"
  | "Practice Management"
  | "Personal Finance"
  | "Family Offices"
  | "Markets & Economy"
  | "Cryptocurrency"
  | "Alternative Investments"
  | "General Business";

export const CANONICAL_BEATS: Beat[] = [
  "Wealth Management",
  "Financial Advisors",
  "RIAs",
  "Asset Management",
  "Investments",
  "Financial Planning",
  "Retirement",
  "Fintech",
  "Wealthtech",
  "Advisor Technology",
  "M&A",
  "Private Equity",
  "Venture Capital",
  "Banking",
  "Insurance",
  "Regulation & Compliance",
  "Practice Management",
  "Personal Finance",
  "Family Offices",
  "Markets & Economy",
  "Cryptocurrency",
  "Alternative Investments",
  "General Business"
];

export function normalizeReporterType(value: string | undefined | null): ReporterType {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "journalist":
    case "reporter":
      return "reporter";
    case "podcast":
      return "podcast";
    case "influencer":
      return "influencer";
    case "broadcast":
      return "broadcast";
    default:
      return "reporter";
  }
}

export function normalizeBeat(value: string | undefined | null): Beat | null {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) return null;

  const exact = CANONICAL_BEATS.find((beat) => beat.toLowerCase() === cleaned.toLowerCase());
  if (exact) return exact;

  const normalizedKey = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9& ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const match = CANONICAL_BEATS.find((beat) => {
    const beatKey = beat
      .toLowerCase()
      .replace(/[^a-z0-9& ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return beatKey === normalizedKey;
  });

  return match ?? null;
}

export function normalizeBeats(value: unknown): Beat[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: Beat[] = [];

  for (const item of value) {
    const beat = normalizeBeat(String(item));
    if (!beat) continue;
    const key = beat.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(beat);
  }

  return normalized;
}

/**
 * A client is a company/account we manage.
 *
 * Clients are the top-level organizational entity in the database.
 * Coverage and reporters are associated with clients through their
 * respective records.
 */
export interface ClientRecord {
  id: string;
  name: string;
  aliases: string[];
}

/**
 * A reporter is a canonical person/entity in the reporter database.
 *
 * The reporter record should represent the person, not an individual
 * article or PRCC.
 *
 * Coverage records reference reporters by reporterId.
 */
export interface ReporterRecord {
  id: string;

  firstName: string;
  lastName: string;

  /**
   * Primary outlet currently associated with the reporter.
   */
  outlet: string;

  /**
   * Optional alternate names/outlet names that can help identify
   * the same reporter during future ingestion.
   */
  aliases?: string[];

  email: string;

  /**
   * Comma-separated client names for compatibility with the
   * existing Master Reporter List.
   */
  clientsCovered: string;

  /**
   * Comma-separated beats for compatibility with the
   * existing Master Reporter List.
   *
   * This will eventually be populated primarily by enrichment.
   */
  beats: string;

  reporterType: ReporterType;

  /**
   * Human-managed notes that must be preserved independently of AI enrichment.
   */
  notes: string;

  status: ReporterStatus;
}

/**
 * A single piece of media coverage.
 *
 * Coverage is intentionally separate from the reporter database.
 * A reporter can have many coverage records.
 */
export interface CoverageRecord {
  id: string;

  clientId: string;
  clientName: string;

  /**
   * References the canonical ReporterRecord when one exists.
   */
  reporterId?: string;

  /**
   * Original reporter name extracted from the source.
   */
  reporterName: string;

  outlet: string;

  publicationDate: string;

  articleTitle: string;

  articleUrl: string;
  urlSource: "prcc" | "resolved" | "manual" | null;
  urlConfidence: "verified" | "candidate" | "unresolved";
  urlResolvedAt: string | null;
  /** Evidence from the most recent automatic URL lookup; manual and PRCC URLs do not need it. */
  urlResolutionEvidence?: UrlResolutionEvidence | null;

  spokesperson: string;
  /** Original PRCC Press Type, retained independently from its normalized classification. */
  originalPressType: string;
  coverageType: CoverageType;
  sentiment: string;
  status: CoverageStatus;
  reach: string | number | null;
  reachSource?: "prcc" | "outlet" | null;
  outletType: OutletType;
  outletTypeConfidence?: "mapped" | "fallback";

  rawFields: Record<string, string>;
  proposedUrl?: string;
  urlProposalStatus?: "proposed" | "verified" | null;
  urlProposalSource?: "search" | "prcc" | null;


  topics: string[];

  source: IngestionSource;

  sourceFile?: string;

  createdAt: string;
  updatedAt: string;
}

/**
 * Raw coverage extracted from a PRCC or other input source.
 *
 * This is intentionally not a database record.
 */
export interface ExtractedCoverage {
  clientName: string;
  reporterName: string;
  outlet: string;
  publicationDate: string;
  articleTitle: string;
  articleUrl: string;
  spokesperson: string;
  originalPressType: string;
  coverageType: string;
  sentiment: string;
  status: string;
  reach: string | number | null;
  rawFields: Record<string, string>;
  topics?: string[];
}

export interface UrlResolutionEvidence {
  selectedUrl: string;
  query: string;
  outletDomainMatch: boolean;
  titleSimilarity: number;
  reporterMatch: boolean | null;
  publicationDateDistanceDays: number | null;
  score: number;
}

export const COVERAGE_STATUSES = ["Completed", "On Hold", "Pending"] as const;
export type CoverageStatus = typeof COVERAGE_STATUSES[number];

export const OUTLET_TYPES = [
  "Newsletter",
  "Consumer Publication",
  "Podcast",
  "Trade Publication",
  "Conference or Event",
  "Broadcast Network",
  "Industry Association"
] as const;
export type OutletType = typeof OUTLET_TYPES[number];

export interface OutletRecord {
  name: string;
  uvm: number | null;
  link: string;
}

export interface ContactRecord {
  id: string;
  clientName?: string;
  name: string;
  title: string;
  email: string;
  phone: string;
  notes: string;
}

export interface IngestionResult {
  records: CoverageRecord[];
  duplicates: ExtractedCoverage[];
  reviewRequired: string[];
  reportersDiscovered: number;
  reportersAdded: number;
  reportersSkipped: number;
  discoveredReporterIds: string[];
  coverageUpdated: number;
}

/* ------------------------------------------------------------------ */
/* Enrichment                                                         */
/* ------------------------------------------------------------------ */

/**
 * These types are retained for compatibility with the current
 * enrichment system.
 *
 * We will rework this layer after the core Client / Reporter /
 * Coverage database is stable.
 */

export type EnrichmentStatus =
  | "verified"
  | "needs_review"
  | "placeholder";

export type OutletStatus =
  | "active"
  | "inactive"
  | "unknown";

export type RelationshipEvidenceType =
  | "publication_profile"
  | "staff_page"
  | "professional_profile"
  | "podcast_show_page"
  | "broadcast_profile";

export interface ResearchSource {
  url: string;
  title: string;
  sourceType:
    | "publication"
    | "author_profile"
    | "linkedin"
    | "other";
}

export interface EnrichmentProposal {
  proposalId: string;

  reporterId?: string;

  currentName: string;
  currentOutlet: string;

  reporterName: string;
  outlet: string;

  email: string | null;

  beats: Beat[];

  beatDescription: string;

  reporterType: ReporterType;
  /** Whether the outlet itself appears to be a current working media entity. */
  outletStatus?: OutletStatus;
  /** The current-affiliation source that supports verification, if one exists. */
  relationshipEvidenceUrl?: string;
  relationshipEvidenceType?: RelationshipEvidenceType;
  currentReporterType?: ReporterType;
  currentBeats?: string;
  currentNotes?: string;

  confidence: number;

  status: EnrichmentStatus;

  sources: ResearchSource[];

  reasoningSummary: string;

  approvalStatus:
    | "pending"
    | "approved"
    | "rejected"
    | "edited";

  authoritativeSource: boolean;

  model: string;

  createdAt: string;
}

export interface EnrichmentAudit {
  proposalId: string;

  reporterId?: string;

  oldValues: Partial<ReporterRecord>;

  proposedValues: Partial<ReporterRecord>;

  sources: ResearchSource[];

  model: string;

  timestamp: string;

  confidence: number;

  approvalStatus: EnrichmentProposal["approvalStatus"];
}
