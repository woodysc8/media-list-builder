import { randomUUID } from "node:crypto";
import { readPersistentFile, writePersistentFile } from "./persistent-files.js";
import path from "node:path";
import {
  CANONICAL_BEATS,
  normalizeBeat,
  normalizeBeats,
  normalizeReporterType,
  type Beat,
  type CoverageRecord,
  type EnrichmentAudit,
  type EnrichmentProposal,
  type EnrichmentStatus,
  type OutletStatus,
  type ReporterRecord,
  type ReporterType,
  type RelationshipEvidenceType,
  type ResearchSource
} from "./domain.js";
import { normalizeName } from "./normalize.js";
import { resolveCoverageUrl, type CoverageUrlResolution } from "./url-enrichment.js";

const BEATS: Beat[] = CANONICAL_BEATS;
const PLACEHOLDER = /^(n\/a|na|unknown|tbd|staff|editorial staff|editorial|press release|wire|company|anonymous)$/i;
const AUTHORITATIVE = new Set(["publication", "author_profile"]);

const ENRICHMENT_DAILY_LIMIT = 31;
const ENRICHMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PROCESSING_LEASE_MS = 10 * 60 * 1000;

type EnrichmentQueueStatus =
  | "pending"
  | "processing"
  | "completed"
  | "needs_review"
  | "failed";

interface EnrichmentQueueEntry {
  key: string;
  reporterName: string;
  outlet: string;
  status: EnrichmentQueueStatus;
  lastAttemptAt: string | null;
  completedAt: string | null;
  processingStartedAt?: string;
  proposalId?: string;
  error?: string;
}

interface EnrichmentQueueState {
  version: 1;
  entries: Record<string, EnrichmentQueueEntry>;
}

interface EnrichmentRateLimit {
  requestsUsed: number;
  windowStartedAt: string;
  nextAvailableAt: string | null;
  /** Individual pair attempts retained to enforce a rolling 24-hour quota. */
  attemptedAt?: string[];
}

interface EnrichmentQueueReport {
  totalPairs: number;
  queued: number;
  processed: number;
  processedThisRun: number;
  remaining: number;
  quotaUsed: number;
  quotaRemaining: number;
  nextEnrichmentAvailableAt: string | null;
  proposalsGenerated: number;
  failed: number;
  providerDailyLimitReached: boolean;
  message: string;
}

class ProviderDailyLimitError extends Error {}

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  sourceType?: ResearchSource["sourceType"];
}

export interface SearchProvider {
  searchWeb(query: string): Promise<SearchResult[]>;
}

export interface AiProvider {
  enrich(input: {
    reporterName: string;
    outlet: string;
    evidence: SearchResult[];
  }): Promise<Partial<EnrichmentProposal> | null>;
}

class NoopSearchProvider implements SearchProvider {
  async searchWeb(): Promise<SearchResult[]> {
    return [];
  }
}

class ConfiguredSearchProvider implements SearchProvider {
  constructor(
    private readonly provider: string,
    private readonly apiKey: string
  ) {}

  async searchWeb(query: string): Promise<SearchResult[]> {
    if (this.provider === "tavily") {
      const response = await requestWithRetry(
        "search:tavily",
        "https://api.tavily.com/search",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            api_key: this.apiKey,
            query,
            max_results: 5
          })
        }
      );

      const data = (await response.json()) as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
        }>;
      };

      return (data.results ?? []).map((item) => ({
        title: item.title ?? "",
        url: item.url ?? "",
        snippet: item.content
      }));
    }

    if (this.provider === "serper") {
      const response = await requestWithRetry(
        "search:serper",
        "https://google.serper.dev/search",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-API-KEY": this.apiKey
          },
          body: JSON.stringify({
            q: query,
            num: 5
          })
        }
      );

      const data = (await response.json()) as {
        organic?: Array<{
          title?: string;
          link?: string;
          snippet?: string;
        }>;
      };

      return (data.organic ?? []).map((item) => ({
        title: item.title ?? "",
        url: item.link ?? "",
        snippet: item.snippet
      }));
    }

    return [];
  }
}

class ConfiguredAiProvider implements AiProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly endpoint: string
  ) {}

  async enrich(input: {
    reporterName: string;
    outlet: string;
    evidence: SearchResult[];
  }): Promise<Partial<EnrichmentProposal> | null> {
    const response = await requestWithRetry(
      "ai",
      this.endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          stream: false,
          response_format: {
            type: "json_object"
          },
          messages: [
            {
              role: "system",
              content:
                `Return JSON only. Never invent facts or email addresses. ` +
                `Use only evidence. ` +
                `Use this beat list exactly and do not invent new beat names: ${BEATS.join(", ")}. ` +
                `reporterType must be one of: reporter, podcast, influencer, broadcast. ` +
                `Classify reporterType as reporter only for a current publication journalist/reporter/writer/editor; ` +
                `podcast for a current host/co-host/producer or other clear show role; influencer for an independent creator/personality; ` +
                `and broadcast for a current on-air journalist, host, correspondent, or similar TV/radio role. ` +
                `Return outletStatus as active, inactive, or unknown. ` +
                `Return relationshipEvidenceUrl and relationshipEvidenceType only when a supplied source directly establishes a CURRENT working relationship. ` +
                `relationshipEvidenceType must be publication_profile, staff_page, professional_profile, podcast_show_page, or broadcast_profile. ` +
                `Use verified only when that direct current-affiliation page also shows the outlet/show/network is active. ` +
                `A search result, article byline, archive, or any result that merely mentions the person is never sufficient. ` +
                `If the publication exists but the relationship is uncertain, use needs_review with outletStatus active or unknown; ` +
                `if the outlet appears dead, use needs_review with outletStatus inactive. ` +
                `Do not include a notes field in the response. ` +
                `Status must be verified, needs_review, or placeholder.`
            },
            {
              role: "user",
              content: JSON.stringify(input)
            }
          ]
        })
      }
    );

    const contentTypeHeader = response.headers.get("content-type") ?? "";
    const contentType = contentTypeHeader.toLowerCase();
    const responseFormat = contentType.includes("text/event-stream")
      ? "SSE"
      : "JSON";

    const responseBody = await response.text();

    console.error(
      `[enrichment:ai] response diagnostic`,
      JSON.stringify({
        url: this.endpoint,
        status: response.status,
        contentType: contentTypeHeader || "unknown",
        body: sanitizeDiagnosticBody(responseBody).slice(0, 500)
      })
    );

    try {
      const data = await readAiResponse(
        responseBody,
        responseFormat === "SSE"
      );

      const content = data.choices?.[0]?.message?.content;

      if (!content) return null;

      return parseAiProposal(content);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "invalid JSON";

      throw new Error(
        `[enrichment:ai] invalid proposal response: ${message}; ` +
          `output=${sanitizeDiagnosticBody(responseBody).slice(0, 500)}`
      );
    }
  }
}

export interface EnrichmentRun {
  proposals: EnrichmentProposal[];
  audits: EnrichmentAudit[];
  summary: {
    reportersFound: number;
    placeholdersFound: number;
    reportersResearched: number;
    highConfidence: number;
    needsReview: number;
  } & EnrichmentQueueReport;
}

export class ReporterEnrichmentService {
  private readonly cacheFile: string;
  private readonly auditFile: string;
  private readonly proposalsFile: string;
  private readonly rateLimitFile: string;
  private readonly queueFile: string;
  private readonly search: SearchProvider;
  private readonly ai?: AiProvider;
  private readonly model: string;
  private readonly concurrency: number;

  constructor(private readonly dataDirectory: string) {
    this.cacheFile = path.join(
      dataDirectory,
      "enrichment-cache.json"
    );

    this.auditFile = path.join(
      dataDirectory,
      "enrichment-audit.json"
    );

    this.proposalsFile = path.join(
      dataDirectory,
      "enrichment-proposals.json"
    );

    this.rateLimitFile = path.join(
      dataDirectory,
      "enrichment-rate-limit.json"
    );

    this.queueFile = path.join(
      dataDirectory,
      "enrichment-queue.json"
    );

    this.model =
      process.env.AI_MODEL?.trim() || "unconfigured";

    this.concurrency = Math.max(
      1,
      Number(process.env.ENRICHMENT_CONCURRENCY ?? 1)
    );

    const searchKey = process.env.SEARCH_API_KEY?.trim();

    this.search = searchKey
      ? new ConfiguredSearchProvider(
          (process.env.SEARCH_PROVIDER ?? "")
            .trim()
            .toLowerCase(),
          searchKey
        )
      : new NoopSearchProvider();

    const aiKey = process.env.AI_API_KEY?.trim();

    if (aiKey) {
      this.ai = new ConfiguredAiProvider(
        aiKey,
        this.model,
        process.env.AI_BASE_URL?.trim() ||
          "https://api.openai.com/v1/chat/completions"
      );
    }
  }

  get canResolveCoverageUrls(): boolean {
    return Boolean(process.env.SEARCH_API_KEY?.trim());
  }

  async resolveCoverageUrls(
    records: CoverageRecord[],
    outletDomainsByName: Map<string, string[]> = new Map()
  ): Promise<CoverageUrlResolution[]> {
    const resolutions: CoverageUrlResolution[] = [];
    for (const record of records) {
      resolutions.push(await resolveCoverageUrl(record, {
        search: (query) => this.search.searchWeb(query)
      }, outletDomainsByName.get(normalizeName(record.outlet)) ?? []));
    }
    return resolutions;
  }

  async run(
    records: CoverageRecord[],
    existingReporters: ReporterRecord[]
  ): Promise<EnrichmentRun> {
    const now = Date.now();
    const items = uniqueCoverageRecords(records);
    const scopeKeys = new Set(items.map(enrichmentKey));
    const proposals = await this.loadProposals();
    const queue = await this.loadQueue();
    const rateLimit = await this.loadRateLimit(now);

    initializeQueueEntries(queue, items, proposals, now);
    await this.saveQueue(queue);

    const cache = await readJson<Record<string, SearchResult[]>>(
      this.cacheFile,
      {}
    );
    const existingAudits = await readJson<EnrichmentAudit[]>(
      this.auditFile,
      []
    );
    const newProposals: EnrichmentProposal[] = [];
    const audits: EnrichmentAudit[] = [];
    let failed = 0;
    let providerDailyLimitReached = false;
    let persistence = Promise.resolve();

    const eligible = items.filter((record) =>
      isEligibleQueueEntry(queue.entries[enrichmentKey(record)], now)
    );
    const quotaRemaining = Math.max(
      0,
      ENRICHMENT_DAILY_LIMIT - rateLimit.attemptedAt!.length
    );
    const itemsToProcess = eligible.slice(0, quotaRemaining);

    console.error(
      `[enrichment:queue] ${eligible.length} eligible reporters, ` +
        `${quotaRemaining} quota slots available, ` +
        `processing ${itemsToProcess.length} now.`
    );

    const tasks: Promise<void>[] = [];
    for (const record of itemsToProcess) {
      const key = enrichmentKey(record);
      const attemptedAt = new Date().toISOString();
      const entry = queue.entries[key];
      entry.status = "processing";
      entry.lastAttemptAt = attemptedAt;
      entry.processingStartedAt = attemptedAt;
      delete entry.error;
      await this.saveQueue(queue);

      rateLimit.attemptedAt!.push(attemptedAt);
      updateRateLimitWindow(rateLimit, Date.now());
      await writeJson(this.rateLimitFile, rateLimit);

      tasks.push(
        this.enrichOne(record, existingReporters, cache)
          .then((proposal) => {
            persistence = persistence.then(async () => {
              proposals.push(proposal);
              newProposals.push(proposal);
              const audit = createAudit(proposal, existingReporters);
              audits.push(audit);
              existingAudits.push(audit);
              await this.saveProposals(proposals);
              await writeJson(this.auditFile, existingAudits);
              await writeJson(this.cacheFile, cache);
              const completed = queue.entries[key];
              completed.status = "completed";
              completed.completedAt = new Date().toISOString();
              completed.proposalId = proposal.proposalId;
              delete completed.processingStartedAt;
              delete completed.error;
              await this.saveQueue(queue);
            });
            return persistence;
          })
          .catch((error) => {
            persistence = persistence.then(async () => {
              const failedEntry = queue.entries[key];
              failedEntry.status = "failed";
              delete failedEntry.processingStartedAt;
              failedEntry.error = errorMessage(error);
              await this.saveQueue(queue);
              failed += 1;
              providerDailyLimitReached ||= error instanceof ProviderDailyLimitError;
            });
            return persistence;
          })
      );

      if (tasks.length >= this.concurrency) {
        await Promise.all(tasks.splice(0));
        if (providerDailyLimitReached) break;
      }
    }

    await Promise.all(tasks);
    await persistence;
    updateRateLimitWindow(rateLimit, Date.now());
    await writeJson(this.rateLimitFile, rateLimit);

    const queueReport = buildQueueReport(
      queue,
      scopeKeys,
      rateLimit,
      newProposals.length,
      failed,
      providerDailyLimitReached
    );

    return {
      proposals,
      audits,
      summary: buildSummary(proposals, queueReport)
    };
  }

  private async loadQueue(): Promise<EnrichmentQueueState> {
    return readJson<EnrichmentQueueState>(this.queueFile, {
      version: 1,
      entries: {}
    });
  }

  private async saveQueue(queue: EnrichmentQueueState): Promise<void> {
    await writeJson(this.queueFile, queue);
  }

  private async loadRateLimit(now: number): Promise<EnrichmentRateLimit> {
    const fallback: EnrichmentRateLimit = {
      requestsUsed: 0,
      windowStartedAt: new Date(now).toISOString(),
      nextAvailableAt: null,
      attemptedAt: []
    };

    let existing: EnrichmentRateLimit;
    try {
      existing = JSON.parse(
        await readPersistentFile(this.rateLimitFile, "utf8")
      ) as EnrichmentRateLimit;
    } catch {
      return fallback;
    }

    const isLegacy = !Array.isArray(existing.attemptedAt);
    const rateLimit = normalizeRateLimit(existing, now);

    if (isLegacy) {
      const backupFile = path.join(
        this.dataDirectory,
        "enrichment-rate-limit.pre-queue-migration.json"
      );

      try {
        await readPersistentFile(backupFile, "utf8");
      } catch {
        await writePersistentFile(
          backupFile,
          `${JSON.stringify(existing, null, 2)}\n`,
          "utf8"
        );
      }

      await writeJson(this.rateLimitFile, rateLimit);
    }

    return rateLimit;
  }

  async loadProposals(): Promise<
    EnrichmentProposal[]
  > {
    return readJson(
      this.proposalsFile,
      []
    );
  }

  async saveProposals(
    proposals: EnrichmentProposal[]
  ): Promise<void> {
    await writeJson(
      this.proposalsFile,
      proposals
    );
  }

  async updateApprovals(
    updates: Array<{
      proposalId: string;
      approvalStatus:
        EnrichmentProposal["approvalStatus"];
      patch?: Partial<
        Pick<
          EnrichmentProposal,
          | "reporterName"
          | "outlet"
          | "email"
          | "beats"
          | "beatDescription"
        >
      >;
    }>
  ): Promise<EnrichmentProposal[]> {
    const proposals =
      await this.loadProposals();

    const changes = new Map(
      updates.map((update) => [
        update.proposalId,
        update
      ])
    );

    const updated = proposals.map(
      (proposal) => {
        const change = changes.get(
          proposal.proposalId
        );

        if (!change) return proposal;

        return {
          ...proposal,
          ...change.patch,
          approvalStatus:
            change.approvalStatus
        };
      }
    );

    await writeJson(
      this.proposalsFile,
      updated
    );

    return updated;
  }

  private async enrichOne(
    record: CoverageRecord,
    existingReporters: ReporterRecord[],
    cache: Record<string, SearchResult[]>
  ): Promise<EnrichmentProposal> {
    const now =
      new Date().toISOString();

    const base: EnrichmentProposal = {
      proposalId:
        `ENR-${randomUUID().slice(0, 8)}`,

      currentName:
        record.reporterName,

      currentOutlet:
        record.outlet,

      reporterName:
        record.reporterName,

      outlet:
        record.outlet,

      email: null,

      beats: [],

      beatDescription: "",

      reporterType:
        "reporter",

      outletStatus:
        "unknown",

      confidence: 0,

      status:
        "needs_review",

      sources: [],

      reasoningSummary: "",

      approvalStatus:
        "pending",

      authoritativeSource:
        false,

      model:
        this.model,

      createdAt:
        now
    };

    if (
      PLACEHOLDER.test(
        record.reporterName.trim()
      )
    ) {
      return {
        ...base,
        reporterType:
          "reporter",
        status:
          "placeholder",
        reasoningSummary:
          "The coverage record contains a placeholder reporter value and will not become an individual reporter."
      };
    }

    const existing =
      existingReporters.find(
        (reporter) =>
          normalizeName(
            `${reporter.firstName} ${reporter.lastName}`
          ) ===
            normalizeName(
              record.reporterName
            ) &&
          normalizeName(
            reporter.outlet
          ) ===
            normalizeName(
              record.outlet
            )
      );

    const currentReporterType =
      existing?.reporterType ??
      "reporter";

    const currentBeats =
      existing?.beats ?? "";

    /*
     * IMPORTANT:
     * Notes are read but never sent to the AI.
     * Management notes therefore remain completely
     * invisible to enrichment.
     */
    const currentNotes =
      existing?.notes ?? "";

    const key =
      `${normalizeName(record.reporterName)}|` +
      `${normalizeName(record.outlet)}`;

    let evidence = cache[key];

    if (!evidence) {
      const queries = [
        `"${record.reporterName}" "${record.outlet}"`,
        `"${record.reporterName}" "${record.outlet}" author profile staff contributor`,
        `"${record.reporterName}" "${record.outlet}" LinkedIn`,
        `"${record.reporterName}" "${record.outlet}" podcast host broadcast correspondent`
      ];

      console.error(
        `[enrichment] SEARCH START ` +
          `reporter=${record.reporterName} ` +
          `queries=${queries.length}`
      );

      evidence = (
        await Promise.all(
          queries.map((query) =>
            this.search.searchWeb(query)
          )
        )
      )
        .flat()
        .filter(
          (
            result,
            resultIndex,
            all
          ) =>
            result.url &&
            all.findIndex(
              (item) =>
                item.url ===
                result.url
            ) === resultIndex
        );

      console.error(
        `[enrichment] SEARCH COMPLETE ` +
          `reporter=${record.reporterName} ` +
          `results=${evidence.length}`
      );

      cache[key] = evidence;
    }

    const ai = this.ai
      ? await this.ai.enrich({
          reporterName:
            record.reporterName,
          outlet:
            record.outlet,
          evidence
        })
      : null;

    const sanitized =
      normalizeAiProposal(ai);

    const sources =
      normalizeSources(
        sanitized?.sources ??
          evidence.map(
            (item) => ({
              url: item.url,
              title: item.title,
              sourceType:
                item.sourceType ??
                inferSourceType(
                  item.url,
                  record.outlet
                )
            })
          )
      );

    const confidence =
      clamp(
        Number(
          sanitized?.confidence ??
            (existing &&
            sources.length
              ? 0.9
              : 0)
        )
      );

    const outletStatus = normalizeOutletStatus(
      sanitized?.outletStatus
    );

    const relationshipEvidenceUrl =
      validRelationshipEvidenceUrl(
        sanitized?.relationshipEvidenceUrl,
        sanitized?.relationshipEvidenceType,
        sources,
        evidence
      );

    const status: EnrichmentStatus =
      sanitized?.status ===
        "verified" &&
      confidence >= 0.9 &&
      outletStatus === "active" &&
      Boolean(relationshipEvidenceUrl)
        ? "verified"
        : "needs_review";

    const existingName =
      existing
        ? `${existing.firstName} ${existing.lastName}`.trim()
        : record.reporterName;

    return {
      ...base,

      reporterId:
        existing?.id,

      reporterName:
        String(
          sanitized?.reporterName ||
            existingName
        ),

      outlet:
        String(
          sanitized?.outlet ||
            record.outlet
        ),

      email:
        typeof sanitized?.email ===
        "string"
          ? sanitized.email
          : null,

      beats:
        validBeats(
          sanitized?.beats
        ),

      beatDescription:
        String(
          sanitized?.beatDescription ??
            ""
        ),

      reporterType:
        normalizeReporterType(
          sanitized?.reporterType
        ),

      outletStatus,

      relationshipEvidenceUrl:
        relationshipEvidenceUrl ?? undefined,

      relationshipEvidenceType:
        relationshipEvidenceUrl
          ? normalizeRelationshipEvidenceType(
              sanitized?.relationshipEvidenceType
            )
          : undefined,

      currentReporterType,

      currentBeats,

      currentNotes,

      confidence,

      status,

      sources,

      authoritativeSource:
        sources.some(
          (source) =>
            AUTHORITATIVE.has(
              source.sourceType
            )
        ),

      reasoningSummary:
        String(
          sanitized?.reasoningSummary ??
            (
              evidence.length
                ? "Research evidence was collected, but an AI provider is not configured to verify identity and beats."
                : "No research provider evidence is available."
            )
        )
    };
  }
}

function buildSummary(
  proposals: EnrichmentProposal[],
  queueReport: EnrichmentQueueReport
) {
  return {
    reportersFound:
      proposals.length,

    placeholdersFound:
      proposals.filter(
        (proposal) =>
          proposal.status ===
          "placeholder"
      ).length,

    reportersResearched:
      proposals.filter(
        (proposal) =>
          proposal.sources.length > 0
      ).length,

    highConfidence:
      proposals.filter(
        (proposal) =>
          proposal.confidence >= 0.9 &&
          proposal.authoritativeSource
      ).length,

    needsReview:
      proposals.filter(
        (proposal) =>
          proposal.status ===
          "needs_review"
      ).length,
    ...queueReport
  };
}

function enrichmentKey(record: {
  reporterName: string;
  outlet: string;
}): string {
  return `${normalizeName(record.reporterName)}|${normalizeName(record.outlet)}`;
}

function uniqueCoverageRecords(records: CoverageRecord[]): CoverageRecord[] {
  const unique = new Map<string, CoverageRecord>();
  for (const record of records) {
    const key = enrichmentKey(record);
    if (!unique.has(key)) unique.set(key, record);
  }

  return [...unique.values()].sort((left, right) =>
    enrichmentKey(left).localeCompare(enrichmentKey(right))
  );
}

function initializeQueueEntries(
  queue: EnrichmentQueueState,
  records: CoverageRecord[],
  proposals: EnrichmentProposal[],
  now: number
): void {
  const proposalsByKey = new Map(
    proposals.map((proposal) => [enrichmentKey(proposal), proposal])
  );

  for (const record of records) {
    const key = enrichmentKey(record);
    const proposal = proposalsByKey.get(key);
    const entry = queue.entries[key];

    if (proposal) {
      queue.entries[key] = {
        key,
        reporterName: record.reporterName,
        outlet: record.outlet,
        status: "completed",
        lastAttemptAt: entry?.lastAttemptAt ?? proposal.createdAt,
        completedAt: entry?.completedAt ?? proposal.createdAt,
        proposalId: proposal.proposalId
      };
      continue;
    }

    if (!entry) {
      queue.entries[key] = {
        key,
        reporterName: record.reporterName,
        outlet: record.outlet,
        status: "pending",
        lastAttemptAt: null,
        completedAt: null
      };
      continue;
    }

    if (
      entry.status === "processing" &&
      (!entry.processingStartedAt ||
        now - Date.parse(entry.processingStartedAt) > PROCESSING_LEASE_MS)
    ) {
      entry.status = "failed";
      entry.error = "A previous enrichment process did not finish.";
      delete entry.processingStartedAt;
    }
  }
}

function isEligibleQueueEntry(
  entry: EnrichmentQueueEntry | undefined,
  now: number
): boolean {
  if (!entry) return false;
  if (entry.status === "pending" || entry.status === "failed") return true;

  return entry.status === "processing" &&
    Boolean(entry.processingStartedAt) &&
    now - Date.parse(entry.processingStartedAt!) > PROCESSING_LEASE_MS;
}

function normalizeRateLimit(
  existing: EnrichmentRateLimit,
  now: number
): EnrichmentRateLimit {
  const cutoff = now - ENRICHMENT_COOLDOWN_MS;
  let attemptedAt = Array.isArray(existing.attemptedAt)
    ? existing.attemptedAt.filter(
        (timestamp) => Number.isFinite(Date.parse(timestamp)) && Date.parse(timestamp) > cutoff
      )
    : [];

  if (!attemptedAt.length && existing.requestsUsed > 0) {
    const legacyTimestamp = existing.nextAvailableAt &&
      Date.parse(existing.nextAvailableAt) > now
      ? new Date(Date.parse(existing.nextAvailableAt) - ENRICHMENT_COOLDOWN_MS).toISOString()
      : existing.windowStartedAt;
    attemptedAt = Array.from(
      { length: Math.min(existing.requestsUsed, ENRICHMENT_DAILY_LIMIT) },
      () => legacyTimestamp
    );
  }

  const rateLimit: EnrichmentRateLimit = {
    requestsUsed: attemptedAt.length,
    windowStartedAt: attemptedAt[0] ?? new Date(now).toISOString(),
    nextAvailableAt: null,
    attemptedAt
  };
  updateRateLimitWindow(rateLimit, now);
  return rateLimit;
}

function updateRateLimitWindow(rateLimit: EnrichmentRateLimit, now: number): void {
  const cutoff = now - ENRICHMENT_COOLDOWN_MS;
  rateLimit.attemptedAt = (rateLimit.attemptedAt ?? []).filter(
    (timestamp) => Number.isFinite(Date.parse(timestamp)) && Date.parse(timestamp) > cutoff
  );
  rateLimit.requestsUsed = rateLimit.attemptedAt.length;
  rateLimit.windowStartedAt = rateLimit.attemptedAt[0] ?? new Date(now).toISOString();
  rateLimit.nextAvailableAt = rateLimit.attemptedAt.length >= ENRICHMENT_DAILY_LIMIT
    ? new Date(Date.parse(rateLimit.attemptedAt[0]) + ENRICHMENT_COOLDOWN_MS).toISOString()
    : null;
}

function createAudit(
  proposal: EnrichmentProposal,
  existingReporters: ReporterRecord[]
): EnrichmentAudit {
  return {
    proposalId: proposal.proposalId,
    reporterId: proposal.reporterId,
    oldValues: existingReporters.find((reporter) => reporter.id === proposal.reporterId) ?? {},
    proposedValues: proposalToReporter(proposal),
    sources: proposal.sources,
    model: proposal.model,
    timestamp: proposal.createdAt,
    confidence: proposal.confidence,
    approvalStatus: proposal.approvalStatus
  };
}

function buildQueueReport(
  queue: EnrichmentQueueState,
  scopeKeys: Set<string>,
  rateLimit: EnrichmentRateLimit,
  proposalsGenerated: number,
  failed: number,
  providerDailyLimitReached: boolean
): EnrichmentQueueReport {
  const entries = [...scopeKeys]
    .map((key) => queue.entries[key])
    .filter((entry): entry is EnrichmentQueueEntry => Boolean(entry));
  const processed = entries.filter((entry) => entry.status === "completed").length;
  const remaining = entries.length - processed;
  const quotaUsed = rateLimit.attemptedAt?.length ?? 0;
  const quotaRemaining = Math.max(0, ENRICHMENT_DAILY_LIMIT - quotaUsed);
  const nextEnrichmentAvailableAt = rateLimit.nextAvailableAt;
  const message = providerDailyLimitReached
    ? "The provider daily limit was reached; remaining jobs will retry on a future run."
    : remaining === 0
    ? "All eligible reporters have been processed."
    : quotaRemaining === 0 && nextEnrichmentAvailableAt
      ? `Enrichment is paused until ${nextEnrichmentAvailableAt}.`
      : `Processed ${processed} of ${entries.length}; ${remaining} remain.`;

  return {
    totalPairs: entries.length,
    queued: remaining,
    processed,
    processedThisRun: proposalsGenerated,
    remaining,
    quotaUsed,
    quotaRemaining,
    nextEnrichmentAvailableAt,
    proposalsGenerated,
    failed,
    providerDailyLimitReached,
    message
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Enrichment request failed.";
}

function normalizeAiProposal(
  value:
    | Partial<EnrichmentProposal>
    | null
    | undefined
): Partial<EnrichmentProposal> | null {
  if (
    !value ||
    typeof value !== "object"
  ) {
    return null;
  }

  const proposal:
    Partial<EnrichmentProposal> = {
    ...value
  };

  proposal.reporterType =
    normalizeReporterType(
      String(
        value.reporterType ?? ""
      )
    );

  proposal.outletStatus =
    normalizeOutletStatus(value.outletStatus);

  proposal.relationshipEvidenceType =
    normalizeRelationshipEvidenceType(
      value.relationshipEvidenceType
    );

  if (
    typeof value.relationshipEvidenceUrl !== "string" ||
    !value.relationshipEvidenceUrl.trim()
  ) {
    delete proposal.relationshipEvidenceUrl;
  }

  proposal.beats =
    normalizeBeats(
      value.beats
    );

  proposal.sources =
    normalizeSources(
      value.sources
    );

  if (
    typeof value.email ===
      "string" &&
    !value.email.trim()
  ) {
    proposal.email = null;
  }

  /*
   * Never allow AI to write management notes.
   */
  if ("notes" in value) {
    delete (
      proposal as Record<
        string,
        unknown
      >
    ).notes;
  }

  return proposal;
}

function proposalToReporter(
  proposal: EnrichmentProposal
): Partial<ReporterRecord> {
  const parts =
    proposal.reporterName
      .trim()
      .split(/\s+/);

  return {
    id:
      proposal.reporterId,

    outlet:
      proposal.outlet,

    firstName:
      parts.shift() ?? "",

    lastName:
      parts.join(" "),

    email:
      proposal.email ?? "",

    clientsCovered:
      "",

    beats:
      proposal.beats.join(", "),

    status:
      proposal.status ===
      "verified"
        ? "Active"
        : "Needs Review",

    reporterType:
      normalizeReporterType(
        proposal.reporterType
      ),

    notes:
      proposal.currentNotes ?? ""
  };
}

function validBeats(
  values: unknown
): Beat[] {
  return normalizeBeats(values);
}

function normalizeOutletStatus(
  value: unknown
): OutletStatus {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "active":
      return "active";
    case "inactive":
      return "inactive";
    default:
      return "unknown";
  }
}

function normalizeRelationshipEvidenceType(
  value: unknown
): RelationshipEvidenceType | undefined {
  switch (String(value ?? "").trim()) {
    case "publication_profile":
    case "staff_page":
    case "professional_profile":
    case "podcast_show_page":
    case "broadcast_profile":
      return value as RelationshipEvidenceType;
    default:
      return undefined;
  }
}

/**
 * A model may not turn a generic search mention into affiliation proof. The
 * chosen page must be one of the sources actually returned for this research
 * run and must be labelled as a current-profile source by the model.
 */
function validRelationshipEvidenceUrl(
  value: unknown,
  evidenceType: unknown,
  sources: ResearchSource[],
  evidence: SearchResult[]
): string | null {
  const url =
    typeof value === "string"
      ? value.trim()
      : "";

  if (!url || !normalizeRelationshipEvidenceType(evidenceType)) {
    return null;
  }

  const sourceWasCollected = evidence.some(
    (item) => item.url === url
  );
  const sourceWasCited = sources.some(
    (source) => source.url === url
  );

  return sourceWasCollected && sourceWasCited
    ? url
    : null;
}

function normalizeSources(
  values: unknown
): ResearchSource[] {
  return Array.isArray(values)
    ? values.filter(
        (
          value
        ): value is ResearchSource =>
          Boolean(
            value &&
              typeof value ===
                "object" &&
              typeof (
                value as ResearchSource
              ).url ===
                "string" &&
              typeof (
                value as ResearchSource
              ).title ===
                "string" &&
              typeof (
                value as ResearchSource
              ).sourceType ===
                "string"
          )
      )
    : [];
}

function inferSourceType(
  url: string,
  outlet: string
): ResearchSource["sourceType"] {
  const host =
    new URL(url)
      .hostname
      .toLowerCase();

  return host.includes(
    normalizeName(outlet)
      .replaceAll(" ", "")
  )
    ? "publication"
    : host.includes("linkedin")
      ? "linkedin"
      : "other";
}

function clamp(
  value: number
): number {
  return Number.isFinite(value)
    ? Math.min(
        1,
        Math.max(0, value)
      )
    : 0;
}

async function requestWithRetry(
  kind:
    | "ai"
    | "search:tavily"
    | "search:serper",
  url: string,
  options: RequestInit,
  attempts = 3
): Promise<Response> {
  let lastError: unknown;

  for (
    let attempt = 0;
    attempt < attempts;
    attempt += 1
  ) {
    console.error(
      `[enrichment:${kind}] request`,
      JSON.stringify({
        url,
        method:
          options.method ??
          "GET",
        attempt:
          attempt + 1
      })
    );

    try {
      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () =>
            controller.abort(),
          120000
        );

      let response: Response;

      try {
        response =
          await fetch(
            url,
            {
              ...options,
              signal:
                controller.signal
            }
          );
      } finally {
        clearTimeout(
          timeout
        );
      }

      const sanitizedBody =
        await response
          .clone()
          .text()
          .then(
            sanitizeDiagnosticBody
          )
          .catch(
            () =>
              "<response body unavailable>"
          );

      console.error(
        `[enrichment:${kind}] response`,
        JSON.stringify({
          url,
          status:
            response.status,
          ok:
            response.ok,
          body:
            sanitizedBody
        })
      );

      if (response.ok) {
        return response;
      }

      if (
        response.status === 429 &&
        /(?:daily|free[- ]?model|quota).{0,80}(?:limit|exceed)|(?:limit|exceed).{0,80}(?:daily|free[- ]?model|quota)/i.test(sanitizedBody)
      ) {
        throw new ProviderDailyLimitError(
          `${kind} provider daily limit reached`
        );
      }

      if (
        ![
          429,
          500,
          502,
          503,
          504
        ].includes(
          response.status
        )
      ) {
        throw new Error(
          `${kind} provider returned HTTP ${response.status}`
        );
      }

      lastError =
        new Error(
          `${kind} provider returned HTTP ${response.status}`
        );
    } catch (error) {
      lastError = error;

      if (error instanceof ProviderDailyLimitError) {
        throw error;
      }

      console.error(
        `[enrichment:${kind}] error`,
        JSON.stringify({
          url,
          message:
            error instanceof Error
              ? error.message
              : "request failed"
        })
      );
    }

    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          250 *
            2 **
              attempt
        )
    );
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        "Research provider request failed"
      );
}

function sanitizeDiagnosticBody(
  body: string
): string {
  return body
    .replace(
      /("?(?:api[_-]?key|authorization|token|secret|password)"?\s*[:=]\s*")([^"\\]+)(")/gi,
      "$1[REDACTED]$3"
    )
    .replace(
      /((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|credentials?)s?\s*[:=]\s*)("[^"]*"|'[^']*'|[^,\s}]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /Bearer\s+[^\s"']+/gi,
      "Bearer [REDACTED]"
    )
    .slice(0, 1000);
}

async function readAiResponse(
  responseBody: string,
  isSse: boolean
): Promise<{
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}> {
  if (!isSse) {
    return JSON.parse(
      responseBody
    ) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
  }

  const contentChunks: string[] =
    [];

  for (const line of responseBody.split(
    /\r?\n/
  )) {
    if (
      !line.startsWith(
        "data:"
      )
    ) {
      continue;
    }

    const payload =
      line
        .slice(
          "data:".length
        )
        .trim();

    if (
      !payload ||
      payload === "[DONE]"
    ) {
      continue;
    }

    const chunk =
      JSON.parse(payload) as {
        choices?: Array<{
          delta?: {
            content?: string;
          };
        }>;
      };

    const content =
      chunk.choices?.[0]?.delta
        ?.content;

    if (content) {
      contentChunks.push(
        content
      );
    }
  }

  return {
    choices: [
      {
        message: {
          content:
            contentChunks.join("")
        }
      }
    ]
  };
}

function parseAiProposal(
  content: string
): Partial<EnrichmentProposal> {
  const fencedMatch =
    content
      .trim()
      .match(
        /^```(?:json)?\s*([\s\S]*?)\s*```$/i
      );

  const extracted =
    fencedMatch?.[1] ??
    content.trim();

  const parsed =
    JSON.parse(
      extracted
    ) as unknown;

  const proposal =
    typeof parsed ===
    "string"
      ? (JSON.parse(
          parsed
        ) as unknown)
      : parsed;

  if (
    !proposal ||
    typeof proposal !==
      "object" ||
    Array.isArray(
      proposal
    )
  ) {
    throw new Error(
      "expected a JSON object"
    );
  }

  return proposal as Partial<EnrichmentProposal>;
}

async function readJson<T>(
  filePath: string,
  fallback: T
): Promise<T> {
  try {
    return JSON.parse(
      await readPersistentFile(
        filePath,
        "utf8"
      )
    ) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(
  filePath: string,
  value: unknown
): Promise<void> {
  await writePersistentFile(
    filePath,
    `${JSON.stringify(
      value,
      null,
      2
    )}\n`,
    "utf8"
  );
}


