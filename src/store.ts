import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  normalizeReporterType,
  type ClientRecord,
  type ContactRecord,
  type CoverageRecord,
  type ReporterRecord
} from "./domain.js";
import { normalizeCanonicalRecord } from "./coverage-resolvers.js";

interface StoreData {
  clients: ClientRecord[];
  reporters: ReporterRecord[];
  coverage: CoverageRecord[];
  clientContacts: ContactRecord[];
  teamContacts: ContactRecord[];
}

const emptyStore: StoreData = {
  clients: [],
  reporters: [],
  coverage: [],
  clientContacts: [],
  teamContacts: []
};

function normalize(value: string | undefined | null): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeOutlet(value: string | undefined | null): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function clean(value: string | undefined | null): string {
  return String(value ?? "").trim();
}

function isRealUrl(value: string | undefined | null): boolean {
  const cleaned = clean(value);

  return (
    cleaned.length > 0 &&
    /^https?:\/\/.+/i.test(cleaned)
  );
}

function normalizedReporter(value: string | undefined | null): string {
  const cleaned = clean(value);
  return /^(n\/a|na|unknown|tbd)$/i.test(cleaned) ? "" : normalize(cleaned);
}

function coverageIdentity(
  record: Pick<CoverageRecord, "clientName" | "publicationDate" | "outlet" | "articleTitle" | "reporterName" | "articleUrl">
): string {
  const url = clean(record.articleUrl);
  if (isRealUrl(url)) return `url:${url}`;
  return [
    normalize(record.clientName),
    clean(record.publicationDate),
    normalizeOutlet(record.outlet),
    normalize(record.articleTitle),
    normalizedReporter(record.reporterName)
  ].join("|");
}

function coverageRichness(record: CoverageRecord): number {
  return [
    record.publicationDate,
    record.articleTitle,
    record.clientName,
    record.outlet,
    record.reporterName,
    record.spokesperson,
    record.coverageType,
    record.sentiment,
    record.status,
    record.reach,
    record.articleUrl,
    Object.keys(record.rawFields ?? {}).length
  ].filter((value) => value !== null && value !== undefined && String(value).trim() !== "").length;
}

export class StructuredStore {
  private data: StoreData = structuredClone(emptyStore);

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      this.data = JSON.parse(
        await readFile(this.filePath, "utf8")
      ) as StoreData;
      const originalCoverage = JSON.stringify(this.data.coverage ?? []);

      this.data.reporters = (this.data.reporters ?? []).map((reporter) => ({
        ...reporter,
        reporterType: normalizeReporterType(reporter.reporterType),
        notes: reporter.notes ?? "",
        beats: reporter.beats ?? ""
      }));
      this.data.clients = this.data.clients ?? [];
      this.data.coverage = (this.data.coverage ?? []).map((record) => {
        const normalizedRecord = normalizeCanonicalRecord({
          ...record,
          ...(record.articleTitle === "" && record.articleUrl && Object.keys(record.rawFields ?? {}).length === 0 && !isRealUrl(record.articleUrl)
            ? { articleTitle: record.articleUrl, articleUrl: "" }
            : {}),
          coverageType: record.coverageType as CoverageRecord["coverageType"]
        });
        return {
          ...normalizedRecord,
          spokesperson: record.spokesperson ?? "",
          reach:
            typeof record.reach === "number" || typeof record.reach === "string"
              ? record.reach
              : null,
          reachSource: record.reachSource ?? null,
          rawFields: record.rawFields ?? {},
          proposedUrl: record.proposedUrl ?? "",
          urlProposalStatus: record.urlProposalStatus ?? null,
          urlProposalSource: record.urlProposalSource ?? null,
          urlSource: record.urlSource ?? (record.articleUrl ? "prcc" : null),
          urlConfidence: record.urlConfidence ?? (record.articleUrl ? "verified" : "unresolved"),
          urlResolvedAt: record.urlResolvedAt ?? (record.articleUrl ? record.updatedAt ?? record.createdAt ?? null : null),
          urlResolutionEvidence: record.urlResolutionEvidence ?? null
        };
      });
      this.data.clientContacts = this.data.clientContacts ?? [];
      this.data.teamContacts = this.data.teamContacts ?? [];
      this.data.clientContacts = this.data.clientContacts.map((contact) => ({
        ...contact,
        title: contact.title ?? (contact as ContactRecord & { role?: string }).role ?? ""
      }));
      this.data.teamContacts = this.data.teamContacts.map((contact) => ({
        ...contact,
        title: contact.title ?? (contact as ContactRecord & { role?: string }).role ?? ""
      }));

      console.log(
        `[STORE] Loaded ${this.data.coverage.length} coverage records, ${this.data.reporters.length} reporters, ${this.data.clients.length} clients`
      );
      if (JSON.stringify(this.data.coverage) !== originalCoverage) {
        await this.save();
      }
    } catch {
      console.log("[STORE] No existing store found. Creating empty store.");
      await this.save();
    }
  }

  get snapshot(): StoreData {
    return structuredClone(this.data);
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    await writeFile(
      this.filePath,
      JSON.stringify(this.data, null, 2)
    );

    console.log(
      `[STORE] Saved ${this.data.coverage.length} coverage records, ${this.data.reporters.length} reporters`
    );
  }

  // ============================================================
  // CLIENTS
  // ============================================================

  findClient(name: string): ClientRecord | undefined {
    const target = normalize(name);

    if (!target) {
      return undefined;
    }

    return this.data.clients.find(
      (client) =>
        normalize(client.name) === target ||
        client.aliases.some(
          (alias) => normalize(alias) === target
        )
    );
  }

  ensureClient(name: string): ClientRecord {
    const cleanedName = clean(name);

    if (!cleanedName) {
      throw new Error("Client name cannot be empty");
    }

    const existing = this.findClient(cleanedName);

    if (existing) {
      return existing;
    }

    const client: ClientRecord = {
      id: `CLI-${randomUUID().slice(0, 8)}`,
      name: cleanedName,
      aliases: []
    };

    this.data.clients.push(client);

    return client;
  }

  addClientAlias(
    client: ClientRecord,
    alias: string
  ): ClientRecord {
    const cleanedAlias = clean(alias);

    if (!cleanedAlias) {
      return client;
    }

    const exists = client.aliases.some(
      (existing) =>
        normalize(existing) === normalize(cleanedAlias)
    );

    if (!exists) {
      client.aliases.push(cleanedAlias);

      const index = this.data.clients.findIndex(
        (item) => item.id === client.id
      );

      if (index >= 0) {
        this.data.clients[index] = client;
      }
    }

    return client;
  }

  // ============================================================
  // REPORTERS
  // ============================================================

  findReporter(
    firstName: string,
    lastName: string,
    outlet?: string
  ): ReporterRecord | undefined {
    const targetFirst = normalize(firstName);
    const targetLast = normalize(lastName);

    if (!targetFirst || !targetLast) {
      return undefined;
    }

    const matches = this.data.reporters.filter(
      (reporter) =>
        normalize(reporter.firstName) === targetFirst &&
        normalize(reporter.lastName) === targetLast
    );

    if (matches.length === 0) {
      return undefined;
    }

    if (matches.length === 1) {
      return matches[0];
    }

    if (outlet) {
      const targetOutlet = normalizeOutlet(outlet);

      return matches.find(
        (reporter) =>
          normalizeOutlet(reporter.outlet) === targetOutlet
      );
    }

    return undefined;
  }

  findReporterByName(
    firstName: string,
    lastName: string
  ): ReporterRecord | undefined {
    return this.findReporter(firstName, lastName);
  }

  findReporterByIdentity(
    firstName: string,
    lastName: string,
    outlet: string
  ): ReporterRecord | undefined {
    return this.findReporter(
      firstName,
      lastName,
      outlet
    );
  }

  addReporter(
    reporter: Omit<ReporterRecord, "id">
  ): ReporterRecord {
    const existing = this.findReporterByIdentity(
      reporter.firstName,
      reporter.lastName,
      reporter.outlet
    );

    if (existing) {
      return existing;
    }

    const created: ReporterRecord = {
      ...reporter,
      id: `REP-${String(this.nextReporterNumber()).padStart(
        6,
        "0"
      )}`
    };

    this.data.reporters.push(created);

    return created;
  }

  private nextReporterNumber(): number {
    let highest = 0;

    for (const reporter of this.data.reporters) {
      const match = reporter.id.match(/^REP-(\d+)$/);

      if (match) {
        highest = Math.max(
          highest,
          Number(match[1])
        );
      }
    }

    return highest + 1;
  }

  upsertReporter(reporter: ReporterRecord): void {
    const index = this.data.reporters.findIndex(
      (item) => item.id === reporter.id
    );

    if (index >= 0) {
      this.data.reporters[index] = reporter;
      return;
    }

    const existing = this.findReporterByIdentity(
      reporter.firstName,
      reporter.lastName,
      reporter.outlet
    );

    if (existing) {
      return;
    }

    this.data.reporters.push(reporter);
  }

  updateReporter(reporter: ReporterRecord): void {
    const index = this.data.reporters.findIndex(
      (item) => item.id === reporter.id
    );

    if (index >= 0) {
      this.data.reporters[index] = reporter;
    }
  }

  // ============================================================
  // COVERAGE
  // ============================================================

  hasDuplicate(
    candidate: Pick<
      CoverageRecord,
      | "clientId"
      | "articleUrl"
      | "articleTitle"
      | "reporterName"
      | "outlet"
      | "publicationDate"
    >
  ): boolean {

    const candidateUrl = clean(candidate.articleUrl);
    const candidateTitle = clean(candidate.articleTitle);
    const candidateReporter = clean(candidate.reporterName);
    const candidateOutlet = clean(candidate.outlet);
    const candidateDate = clean(candidate.publicationDate);

    // ----------------------------------------------------------
    // RULE 1:
    // A real article URL is the strongest duplicate signal.
    // ----------------------------------------------------------

    if (isRealUrl(candidateUrl)) {
      const duplicate = this.data.coverage.find((record) => {
        const recordUrl = clean(record.articleUrl);

        return (
          isRealUrl(recordUrl) &&
          recordUrl === candidateUrl
        );
      });

      if (duplicate) {
        console.log(
          `[STORE] Duplicate by URL: ${candidateUrl}`
        );

        return true;
      }

      return false;
    }

    // ----------------------------------------------------------
    // RULE 2:
    // Without a real URL, we need enough identifying data
    // before we consider something a duplicate.
    //
    // This prevents rows with blank URLs from all collapsing
    // into one another.
    // ----------------------------------------------------------

    const normalizedTitle = normalize(candidateTitle);
    const normalizedReporter = normalize(candidateReporter);
    const normalizedOutlet = normalizeOutlet(candidateOutlet);
    const normalizedDate = candidateDate;

    if (
      !candidateTitle ||
      !candidateOutlet ||
      !candidateDate
    ) {
      return false;
    }

    const duplicate = this.data.coverage.find((record) => {
      return (
        record.clientId === candidate.clientId &&
        normalize(record.articleTitle) === normalizedTitle &&
        normalize(record.reporterName) === normalizedReporter &&
        normalizeOutlet(record.outlet) === normalizedOutlet &&
        clean(record.publicationDate) === normalizedDate
      );
    });

    if (duplicate) {
      console.log(
        `[STORE] Duplicate by metadata: ${candidateTitle} | ${candidateOutlet} | ${candidateDate}`
      );

      return true;
    }

    return false;
  }

  addCoverage(record: CoverageRecord): void {
    this.data.coverage.push(record);

    console.log(
      `[STORE] Added coverage: ${record.articleTitle || "(untitled)"}`
    );
  }

  updateCoverage(record: CoverageRecord): void {
    const index = this.data.coverage.findIndex((item) => item.id === record.id);
    if (index >= 0) this.data.coverage[index] = record;
  }

  findCoverageMatch(
    candidate: Pick<CoverageRecord, "clientName" | "publicationDate" | "outlet" | "articleTitle" | "reporterName" | "articleUrl">
  ): CoverageRecord | undefined {
    const candidateUrl = clean(candidate.articleUrl);
    if (isRealUrl(candidateUrl)) {
      return this.data.coverage.find((record) => clean(record.articleUrl) === candidateUrl);
    }
    const candidateKey = coverageIdentity(candidate);
    return this.data.coverage.find((record) => coverageIdentity(record) === candidateKey);
  }

  async deduplicateCoverage(): Promise<{ before: number; after: number; removed: number }> {
    const before = this.data.coverage.length;
    const byIdentity = new Map<string, CoverageRecord>();

    for (const record of this.data.coverage) {
      const key = coverageIdentity(record);
      const existing = byIdentity.get(key);
      if (!existing) {
        byIdentity.set(key, record);
        continue;
      }

      const [winner, other] = coverageRichness(record) > coverageRichness(existing)
        ? [record, existing]
        : [existing, record];
      byIdentity.set(key, {
        ...winner,
        clientName: winner.clientName || other.clientName,
        reporterName: winner.reporterName || other.reporterName,
        outlet: winner.outlet || other.outlet,
        publicationDate: winner.publicationDate || other.publicationDate,
        articleTitle: winner.articleTitle || other.articleTitle,
        articleUrl: winner.articleUrl || other.articleUrl,
        urlSource: winner.urlSource ?? other.urlSource ?? (winner.articleUrl || other.articleUrl ? "prcc" : null),
        urlConfidence: winner.articleUrl ? winner.urlConfidence : other.articleUrl ? other.urlConfidence : "unresolved",
        urlResolvedAt: winner.urlResolvedAt ?? other.urlResolvedAt ?? null,
        urlResolutionEvidence: winner.urlResolutionEvidence ?? other.urlResolutionEvidence ?? null,
        spokesperson: winner.spokesperson || other.spokesperson,
        coverageType: winner.coverageType || other.coverageType,
        sentiment: winner.sentiment || other.sentiment,
        status: winner.status || other.status,
        reach: winner.reach !== null && String(winner.reach).trim() !== "" ? winner.reach : other.reach,
        reporterId: winner.reporterId || other.reporterId,
        topics: [...new Set([...(winner.topics ?? []), ...(other.topics ?? [])])],
        rawFields: { ...(other.rawFields ?? {}), ...(winner.rawFields ?? {}) },
        reachSource: winner.reachSource || other.reachSource || null,
        proposedUrl: winner.proposedUrl || other.proposedUrl || "",
        urlProposalStatus: winner.urlProposalStatus || other.urlProposalStatus || null,
        urlProposalSource: winner.urlProposalSource || other.urlProposalSource || null,
        createdAt: [winner.createdAt, other.createdAt].filter(Boolean).sort()[0] ?? winner.createdAt,
        updatedAt: [winner.updatedAt, other.updatedAt].filter(Boolean).sort().at(-1) ?? winner.updatedAt
      });
    }

    this.data.coverage = [...byIdentity.values()];
    if (this.data.coverage.length !== before) await this.save();
    return { before, after: this.data.coverage.length, removed: before - this.data.coverage.length };
  }

  async replaceContacts(
    collection: "clientContacts" | "teamContacts",
    contacts: ContactRecord[]
  ): Promise<void> {
    this.data[collection] = contacts;
    await this.save();
  }
}
