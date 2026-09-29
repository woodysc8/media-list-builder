import { randomUUID } from "node:crypto";
import type {
  ExtractedCoverage,
  IngestionResult,
  IngestionSource,
  ReporterRecord
} from "./domain.js";
import { matchClient, splitReporterName } from "./matching.js";
import { normalizeCoverage, normalizeName } from "./normalize.js";
import { StructuredStore } from "./store.js";
import { applyCoverageDefaults, canonicalCoverageType, resolveReporter, resolveStatus } from "./coverage-resolvers.js";
import { classifyOutletType } from "./media-canonical.js";
import type { OutletRecord } from "./domain.js";

const PLACEHOLDER_REPORTER = /^(n\/a|na|unknown|tbd)$/i;

function mergeClientIntoReporter(
  reporter: ReporterRecord,
  clientName: string,
  store: StructuredStore
): void {
  const existingClients = reporter.clientsCovered
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const alreadyCovered = existingClients.some(
    (existingClient) =>
      normalizeName(existingClient) ===
      normalizeName(clientName)
  );

  if (alreadyCovered) {
    return;
  }

  reporter.clientsCovered = [
    ...existingClients,
    clientName
  ].join(", ");

  store.updateReporter(reporter);
}

export async function ingest(
  items: ExtractedCoverage[],
  source: IngestionSource,
  sourceFile: string | undefined,
  store: StructuredStore,
  options: { outlets?: OutletRecord[]; urlSource?: "prcc" | "manual" } = {}
): Promise<IngestionResult> {
  const result: IngestionResult = {
    records: [],
    duplicates: [],
    reviewRequired: [],
    reportersDiscovered: 0,
    reportersAdded: 0,
    reportersSkipped: 0,
    discoveredReporterIds: [],
    coverageUpdated: 0
  };

  const seenReporterIdentities = new Set<string>();
  const discoveredReporterIds = new Set<string>();

  for (const rawItem of items) {
    const rawItemNormalized = normalizeCoverage(rawItem);
    const item = applyCoverageDefaults(
      rawItemNormalized,
      options.outlets ?? []
    );

    // ============================================================
    // CLIENT
    // ============================================================

    const snapshot = store.snapshot;

    const clientMatch = matchClient(
      item.clientName,
      snapshot.clients
    );

    if (clientMatch.ambiguous) {
      result.reviewRequired.push(
        `Ambiguous client: ${item.clientName}`
      );
      continue;
    }

    const client =
      clientMatch.value ??
      store.ensureClient(item.clientName);

    // ============================================================
    // REPORTER
    // ============================================================

    let reporter: ReporterRecord | undefined = resolveReporter(
      item.reporterName,
      item.outlet,
      snapshot.reporters
    );

    const reporterName = item.reporterName.trim();

    const isPlaceholderReporter =
      !reporterName ||
      PLACEHOLDER_REPORTER.test(reporterName);

    if (!isPlaceholderReporter && !reporter) {
      const reporterParts = splitReporterName(reporterName);
      const reporterIdentity = [
        normalizeName(item.outlet),
        normalizeName(reporterParts.firstName),
        normalizeName(reporterParts.lastName)
      ].join("|");

      const identityIsUsable =
        Boolean(normalizeName(item.outlet)) &&
        Boolean(normalizeName(reporterParts.firstName)) &&
        Boolean(normalizeName(reporterParts.lastName));

      if (identityIsUsable) {
        const firstSeen =
          !seenReporterIdentities.has(reporterIdentity);

        if (firstSeen) {
          seenReporterIdentities.add(reporterIdentity);
          result.reportersDiscovered += 1;
        }

        reporter = store.findReporterByIdentity(
          reporterParts.firstName,
          reporterParts.lastName,
          item.outlet
        );

        if (!reporter) {
          reporter = store.addReporter({
            outlet: item.outlet,
            firstName: reporterParts.firstName,
            lastName: reporterParts.lastName,
            email: "",
            clientsCovered: client.name,
            beats: "",
            notes: "",
            mostRecentArticle: "",
            status: "Active",
            reporterType: "reporter"
          });

          if (firstSeen) {
            result.reportersAdded += 1;
          }
        } else if (firstSeen) {
          result.reportersSkipped += 1;
        }

        if (reporter) {
          discoveredReporterIds.add(reporter.id);
          mergeClientIntoReporter(
            reporter,
            client.name,
            store
          );
        }
      } else {
        result.reportersSkipped += 1;
      }
    } else {
      result.reportersSkipped += 1;
    }

    // ============================================================
    // COVERAGE DUPLICATE CHECK
    // ============================================================

    const candidate = {
      clientName: item.clientName,
      articleUrl: item.articleUrl,
      articleTitle: item.articleTitle,
      reporterName: item.reporterName,
      outlet: item.outlet,
      publicationDate: item.publicationDate
    };

    const existing = store.findCoverageMatch(candidate);

    // ============================================================
    // COVERAGE RECORD
    // ============================================================

    const now = new Date().toISOString();
    const coverageType = canonicalCoverageType(rawItemNormalized.originalPressType.trim() ? item.coverageType : existing?.coverageType || item.coverageType);
    const outletType = classifyOutletType(item.outlet, rawItemNormalized.originalPressType, coverageType);
    const preserveManualUrl = existing?.urlSource === "manual" && Boolean(existing.articleUrl);
    const articleUrl = preserveManualUrl
      ? existing.articleUrl
      : rawItemNormalized.articleUrl || existing?.articleUrl || item.articleUrl;
    const record = {
      ...item,
      id: existing?.id ?? `COV-${randomUUID().slice(0, 8)}`,
      clientId: client.id,
      clientName: rawItemNormalized.clientName,
      reporterId: reporter?.id ?? existing?.reporterId,
      reporterName: rawItemNormalized.reporterName || existing?.reporterName || item.reporterName,
      outlet: rawItemNormalized.outlet || existing?.outlet || item.outlet,
      publicationDate: rawItemNormalized.publicationDate || existing?.publicationDate || item.publicationDate,
      articleTitle: rawItemNormalized.articleTitle || existing?.articleTitle || item.articleTitle,
      articleUrl,
      urlSource: preserveManualUrl
        ? "manual" as const
        : rawItemNormalized.articleUrl
        ? options.urlSource ?? "prcc"
        : existing?.urlSource ?? null,
      urlConfidence: rawItemNormalized.articleUrl || preserveManualUrl
        ? "verified" as const
        : existing?.urlConfidence ?? "unresolved" as const,
      urlResolvedAt: rawItemNormalized.articleUrl && !preserveManualUrl
        ? now
        : existing?.urlResolvedAt ?? null,
      urlResolutionEvidence: rawItemNormalized.articleUrl || preserveManualUrl
        ? null
        : existing?.urlResolutionEvidence ?? null,
      spokesperson: rawItemNormalized.spokesperson || existing?.spokesperson || item.spokesperson,
      originalPressType: rawItemNormalized.originalPressType || existing?.originalPressType || "",
      coverageType,
      sentiment: "Positive" as const,
      status: resolveStatus(item.status),
      reach: rawItemNormalized.reach !== null && String(rawItemNormalized.reach).trim() !== ""
        ? rawItemNormalized.reach
        : item.reach !== null ? item.reach : existing?.reach ?? null,
      reachSource: rawItemNormalized.reach !== null && String(rawItemNormalized.reach).trim() !== ""
        ? "prcc" as const
        : item.reach !== null ? "outlet" as const : existing?.reachSource ?? null,
      outletType: outletType.outletType,
      outletTypeConfidence: outletType.confidence,
      rawFields: { ...(existing?.rawFields ?? {}), ...(rawItemNormalized.rawFields ?? {}) },
      topics: [...new Set([...(existing?.topics ?? []), ...(item.topics ?? [])])],
      source,
      sourceFile: sourceFile ?? existing?.sourceFile,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    if (existing) {
      const comparableExisting = { ...existing, updatedAt: "", source: "", sourceFile: undefined };
      const comparableIncoming = { ...record, updatedAt: "", source: "", sourceFile: undefined };
      if (JSON.stringify(comparableExisting) === JSON.stringify(comparableIncoming)) {
        result.duplicates.push(item);
        continue;
      }
      store.updateCoverage(record);
      result.coverageUpdated += 1;
    } else {
      store.addCoverage(record);
    }
    result.records.push(record);
  }

  result.discoveredReporterIds = [...discoveredReporterIds];
  await store.save();
  return result;
}
