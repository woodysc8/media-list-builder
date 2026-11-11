import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  coverageTables,
  extractArticleTitle,
  headerKey,
  usableTitle,
} from "./coverage-titles.js";
import { WORKBOOK_VERSION } from "./coverage-template.js";
import type {
  CoverageRecord,
  ClientRecord,
  CoverageDestination,
} from "./domain.js";
import {
  parseCoverageSource,
  incompleteFields,
  validArticleUrl,
  type SourceOccurrence,
} from "./coverage-source.js";

export async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
}
export function validUrl(value: string) {
  try {
    const u = new URL(value);
    return /^https?:$/.test(u.protocol) && !!u.hostname && !/\s/.test(value);
  } catch {
    return false;
  }
}
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export function identifyClient(
  filename: string,
  clients: ClientRecord[],
  explicit = "",
) {
  const stem = path.basename(filename).replace(/\.[^.]+$/, "");
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const convention = stem.match(
    /^(.+?)[\s_-]+(?:PRCC\b|PR[\s_-]+Campaign\b|20\d\d\b)/i,
  );
  const detected = convention?.[1]?.replace(/[\s_-]+$/, "").trim();
  const exact = detected
    ? clients.filter((c) =>
        [c.name, ...c.aliases].some((n) => key(n) === key(detected)),
      )
    : [];
  const name = normalize(detected || stem);
  const matches = clients.filter((c) =>
    [c.name, ...c.aliases].some((alias) => {
      const normalized = normalize(alias);
      return !!normalized && ` ${name} `.includes(` ${normalized} `);
    }),
  );
  if (explicit) {
    const exact = clients.filter((c) =>
      [c.name, ...c.aliases].some((n) => key(n) === key(explicit)),
    );
    if (exact.length > 1)
      return { client: "", error: "Ambiguous client identity" };
    return { client: exact[0]?.name || explicit.trim() };
  }
  if (exact.length === 1) return { client: exact[0].name };
  if (exact.length > 1)
    return { client: "", error: "Ambiguous client identity" };
  if (matches.length === 1) return { client: matches[0].name };
  if (matches.length > 1)
    return {
      client: "",
      error:
        "Ambiguous client: filename matches multiple saved identities or aliases",
    };
  if (
    !detected ||
    /^(unknown|untitled|export|copy|coverage|report|data)$/i.test(detected)
  )
    return {
      client: "",
      error: "Client could not be reliably identified from the filename",
    };
  return { client: key(detected) === "wealth" ? "Wealth.com" : detected };
}
export function coverageSignature(records: CoverageRecord[]) {
  return createHash("sha256")
    .update(
      WORKBOOK_VERSION +
        JSON.stringify(
          records.map((r) => [
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
        ),
    )
    .digest("hex");
}
function coverageIdentity(record: CoverageRecord) {
  if (!validArticleUrl(record.articleUrl) || !record.clientName)
    return `source|${key(record.clientName)}|${record.sourceFile}|${record.rawFields?.sourceSha256 || record.id}|${record.rawFields?.sourceTab || ""}|${record.rawFields?.sourceRow || record.id}`;
  const url = new URL(record.articleUrl);
  url.hash = "";
  url.searchParams.sort();
  return `${key(record.clientName)}|${url.href}`;
}
export interface RowError {
  file: string;
  tab: string;
  row: number;
  error: string;
}
export interface Job {
  id: string;
  file: string;
  client: string;
  year: string;
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
  records: CoverageRecord[];
  errors: RowError[];
  imported: number;
  duplicates: number;
  // Retain old tags in upload history only; deliveries are authoritative for every client.
  sync: "pending" | "verified" | "local-only" | "failed" | "not-required";
  attempts: number;
  error?: string;
  needsAttention?: boolean;
  nextAttemptAt?: number;
  sourceRows?: number;
  recoveredRows?: number;
  recoveryError?: string;
}
export interface CoverageState {
  version: 2;
  generation: string;
  paused: boolean;
  records: CoverageRecord[];
  jobs: Job[];
  destinations: Record<string, string>;
  syncedSignatures?: Record<string, string>;
  automatic?: boolean;
  deliveries?: Record<string, CoverageDelivery>;
  titleRepairVersion?: number;
  sourceOccurrences?: SourceOccurrence[];
  losslessVersion?: number;
  folders?: Record<string, { clientsFolderId: string; clientFolderId: string }>;
}
export interface CoverageDelivery {
  client: string;
  state: "pending" | "running" | "verified" | "failed";
  signature: string;
  attempts: number;
  nextAttemptAt?: number;
  error?: string;
  destination?: CoverageDestination;
}
export const emptyCoverage = (): CoverageState => ({
  version: 2,
  generation: randomUUID(),
  paused: false,
  automatic: true,
  records: [],
  jobs: [],
  destinations: {},
});
export class CoverageWorkflow {
  state = emptyCoverage();
  private busy = false;
  private writes = Promise.resolve();
  constructor(
    readonly directory: string,
    private clients: () => ClientRecord[],
    private sync: (
      client: string,
      records: CoverageRecord[],
      destination: string | undefined,
      save: (id: string) => Promise<void>,
    ) => Promise<void | CoverageDestination>,
  ) {}
  get file() {
    return path.join(this.directory, "coverage-v2.json");
  }
  async load(options: { readOnly?: boolean } = {}) {
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8"));
      if (
        this.state.version !== 2 ||
        !this.state.generation ||
        !Array.isArray(this.state.records) ||
        !Array.isArray(this.state.jobs)
      )
        throw new Error(
          "Unsupported coverage state; refusing historical recovery",
        );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    for (const job of this.state.jobs)
      if (job.state === "running") job.state = "pending";
    // Upgrade only the queue policy; never reset coverage, destinations or completed jobs.
    if (!this.state.automatic) {
      this.state.paused = false;
      this.state.automatic = true;
    }
    if (!options.readOnly) {
      await this.repairTitlesFromUploads();
      await this.recoverSourceRows();
      if (!this.state.deliveries) this.state.paused = false;
      for (const delivery of Object.values(this.state.deliveries ?? {}))
        if (delivery.state === "running") delivery.state = "pending";
      this.scheduleDeliveries();
    }
    if (!options.readOnly) await this.save();
  }
  save() {
    const snapshot = structuredClone(this.state);
    const next = this.writes.then(() => atomicJson(this.file, snapshot));
    this.writes = next.catch(() => {});
    return next;
  }
  async enqueue(buffer: Buffer, filename: string, explicitClient = "") {
    const identity = identifyClient(filename, this.clients(), explicitClient);
    let occurrences: SourceOccurrence[] = [];
    const job: Job = {
      id: randomUUID(),
      file: path.basename(filename),
      client: identity.client,
      year: filename.match(/20\d\d/)?.[0] || "",
      state: "pending",
      records: [],
      errors: [],
      imported: 0,
      duplicates: 0,
      sync: "pending",
      attempts: 0,
    };
    try {
      const parsed = await parseCoverageSource(
        buffer,
        job.file,
        job.id,
        job.client,
        this.clients().find((c) => key(c.name) === key(job.client))?.id ||
          key(job.client),
      );
      job.records = parsed.records;
      job.year ||=
        parsed.occurrences
          .map((o) => o.worksheet.match(/20\d\d/)?.[0])
          .find(Boolean) || "";
      job.sourceRows = parsed.occurrences.length;
      occurrences = parsed.occurrences;
    } catch (error) {
      job.state = "failed";
      job.needsAttention = true;
      job.sync = "not-required";
      job.error =
        "Unable to parse " +
        job.file +
        ": " +
        (error instanceof Error ? error.message : String(error));
    }
    if (identity.error) {
      job.needsAttention = true;
      job.error = identity.error;
    }
    await mkdir(path.join(this.directory, "coverage-uploads"), {
      recursive: true,
    });
    await writeFile(
      path.join(this.directory, "coverage-uploads", job.id),
      buffer,
    );
    (this.state.sourceOccurrences ??= []).push(...occurrences);
    this.state.jobs.push(job);
    this.state.paused = false;
    await this.save();
    return job;
  }
  async control(action: string) {
    if (action === "pause") this.state.paused = true;
    else if (action === "start" || action === "resume")
      this.state.paused = false;
    else if (action === "retry") {
      for (const j of this.state.jobs)
        if (
          j.state === "failed" &&
          !j.needsAttention &&
          j.sync !== "not-required"
        ) {
          j.state = "pending";
          j.attempts = 0;
          j.nextAttemptAt = undefined;
        }
      this.state.paused = false;
      for (const delivery of Object.values(this.state.deliveries ?? {}))
        if (delivery.state === "failed") {
          delivery.state = "pending";
          delivery.attempts = 0;
          delivery.nextAttemptAt = undefined;
        }
    } else if (action === "cancel") {
      for (const j of this.state.jobs)
        if (j.state === "pending") j.state = "cancelled";
      for (const delivery of Object.values(this.state.deliveries ?? {}))
        if (delivery.state === "pending") {
          delivery.state = "failed";
          delivery.error = "Delivery cancelled by user";
          delivery.nextAttemptAt = undefined;
        }
    } else throw new Error("Unknown queue action");
    await this.save();
  }
  /** Recover only retained uploads referenced by this installation's jobs, never backups or legacy data. */
  private async recoverSourceRows() {
    const occurrences = (this.state.sourceOccurrences ??= []);
    const complete = new Set(occurrences.map((o) => o.jobId));
    const records = new Map(
      this.state.records.map((r) => [coverageIdentity(r), r]),
    );
    for (const job of this.state.jobs) {
      if (complete.has(job.id) || job.sourceRows === 0) continue;
      if (path.basename(job.id) !== job.id)
        throw Error("Unsafe queued source path");
      try {
        const parsed = await parseCoverageSource(
          await readFile(path.join(this.directory, "coverage-uploads", job.id)),
          job.file,
          job.id,
          job.client,
          this.clients().find((c) => key(c.name) === key(job.client))?.id ||
            key(job.client),
        );
        job.sourceRows = parsed.occurrences.length;
        // Pending jobs are ingested by the worker; completed and failed jobs need only previously omitted rows recovered.
        if (job.records.length) {
          job.records = parsed.records;
          occurrences.push(...parsed.occurrences);
          continue;
        }
        let recovered = 0;
        for (const [index, occurrence] of parsed.occurrences.entries()) {
          const candidate = parsed.records[index];
          const existing = records.get(coverageIdentity(candidate));
          if (existing) {
            occurrence.recordId = existing.id;
            occurrence.duplicate = true;
          } else {
            this.state.records.push(candidate);
            records.set(coverageIdentity(candidate), candidate);
            occurrence.recovered = true;
          }
          occurrence.recovered ||= job.errors.some(
            (error) =>
              error.tab === occurrence.worksheet &&
              error.row === occurrence.rowNumber,
          );
          if (occurrence.recovered) recovered++;
          occurrences.push(occurrence);
        }
        job.recoveredRows = recovered;
        job.recoveryError = undefined;
      } catch (error) {
        job.recoveryError =
          error instanceof Error ? error.message : String(error);
      }
    }
    this.state.losslessVersion = 1;
    // The first occurrence is not a duplicate even when it links an existing normalized record.
    const seen = new Set<string>();
    const byId = new Map(
      this.state.records.map((record) => [record.id, record]),
    );
    for (const occurrence of occurrences) {
      occurrence.duplicate = seen.has(occurrence.recordId);
      seen.add(occurrence.recordId);
      const record = byId.get(occurrence.recordId);
      if (record) occurrence.incomplete = incompleteFields(record);
    }
  }
  private async repairTitlesFromUploads() {
    if (this.state.titleRepairVersion === 1) return;
    const evidence = new Map<string, Set<string>>();
    const directEvidence = new Map<string, Set<string>>();
    for (const job of this.state.jobs) {
      if (path.basename(job.id) !== job.id)
        throw new Error("Unsafe queued source path");
      try {
        for (const { tab, rows } of await coverageTables(
          await readFile(path.join(this.directory, "coverage-uploads", job.id)),
          job.file,
        )) {
          const header = rows.findIndex((row) =>
            row.some((cell) =>
              ["rawurl", "articleurl", "url"].includes(headerKey(cell)),
            ),
          );
          if (header < 0) continue;
          const names = rows[header].map(headerKey);
          for (const [offset, row] of rows.slice(header + 1).entries()) {
            const fields = Object.fromEntries(
              names.map((name, index) => [name, row[index]]),
            );
            const url = String(
              fields.rawurl ?? fields.articleurl ?? fields.url ?? "",
            );
            if (!validUrl(url)) continue;
            const title = extractArticleTitle(fields);
            if (!title) continue;
            const identity = coverageIdentity({
              clientName:
                this.clients().find((c) =>
                  [c.name, ...c.aliases].some(
                    (n) => key(n) === key(job.client),
                  ),
                )?.name || job.client,
              articleUrl: url,
            } as CoverageRecord);
            const titles = evidence.get(identity) ?? new Set<string>();
            titles.add(title);
            evidence.set(identity, titles);
            const location = [
              job.file,
              tab,
              String(header + offset + 2),
              identity,
            ].join("|");
            const direct = directEvidence.get(location) ?? new Set<string>();
            direct.add(title);
            directEvidence.set(location, direct);
          }
        }
      } catch (error: any) {
        if (error.code !== "ENOENT")
          console.warn("[COVERAGE] Title source could not be read:", job.id);
      }
    }
    for (const record of [
      ...this.state.records,
      ...this.state.jobs.flatMap((j) => j.records),
    ]) {
      if (usableTitle(record.articleTitle)) continue;
      const titles =
        directEvidence.get(
          [
            record.sourceFile,
            record.rawFields.sourceTab ?? "",
            record.rawFields.sourceRow,
            coverageIdentity(record),
          ].join("|"),
        ) ?? evidence.get(coverageIdentity(record));
      if (titles?.size === 1) {
        record.articleTitle = [...titles][0];
        delete record.titleNeedsReview;
        delete record.titleReviewReason;
      } else {
        record.articleTitle = "";
        record.titleNeedsReview = true;
        record.titleReviewReason = titles?.size
          ? "Conflicting headlines in original uploads"
          : "Original queued source has no recoverable headline";
      }
    }
    this.state.titleRepairVersion = 1;
  }
  async tick() {
    if (this.busy || this.state.paused) return;
    this.busy = true;
    try {
      const j = this.state.jobs.find(
        (j) =>
          j.state === "pending" &&
          (!j.nextAttemptAt || j.nextAttemptAt <= Date.now()),
      );
      if (!j) {
        const delivery = Object.values(this.state.deliveries ?? {}).find(
          (d) =>
            d.state === "pending" &&
            (!d.nextAttemptAt || d.nextAttemptAt <= Date.now()),
        );
        if (delivery) await this.deliverClient(delivery.client);
        return;
      }
      j.state = "running";
      await this.save();
      if (!j.records.length && !j.imported && !j.duplicates) {
        j.state = "failed";
        j.sync = "not-required";
        j.error = "The source contains no nonempty data rows.";
        await this.save();
        return;
      }
      const seen = new Set(this.state.records.map(coverageIdentity));
      for (const r of j.records) {
        const occurrence = this.state.sourceOccurrences?.find(
          (o) => o.id === r.rawFields.sourceOccurrenceId,
        );
        if (!seen.has(coverageIdentity(r))) {
          seen.add(coverageIdentity(r));
          this.state.records.push(r);
          j.imported++;
        } else {
          j.duplicates++;
          if (occurrence) {
            occurrence.duplicate = true;
            occurrence.recordId = this.state.records.find(
              (existing) => coverageIdentity(existing) === coverageIdentity(r),
            )!.id;
          }
        }
      }
      // Local commit and counters are durable before any remote operation.
      j.records = [];
      this.state.records.sort((a, b) =>
        b.publicationDate.localeCompare(a.publicationDate),
      );
      await this.save();
      if (!j.client) {
        j.state = "failed";
        j.sync = "not-required";
        j.needsAttention = true;
        await this.save();
        return;
      }
      const delivery = await this.deliverClient(j.client);
      if (delivery.state === "verified") {
        j.sync = "verified";
        j.state = "completed";
        j.error = undefined;
      } else {
        j.error = delivery.error;
        j.sync = "failed";
        j.attempts = delivery.attempts;
        j.state = delivery.state === "failed" ? "failed" : "pending";
        j.nextAttemptAt = delivery.nextAttemptAt;
      }
      await this.save();
    } finally {
      this.busy = false;
    }
  }
  private clientRecords(client: string) {
    return this.state.records
      .filter((r) => key(r.clientName) === key(client))
      .sort((a, b) => b.publicationDate.localeCompare(a.publicationDate));
  }
  private scheduleDeliveries() {
    const deliveries = (this.state.deliveries ??= {});
    for (const client of new Set(
      this.state.records.map((r) => r.clientName).filter(Boolean),
    )) {
      const signature = coverageSignature(this.clientRecords(client));
      const previous = deliveries[key(client)];
      if (!previous || previous.signature !== signature)
        deliveries[key(client)] = {
          client,
          signature,
          state: "pending",
          attempts: 0,
          destination: previous?.destination,
        };
    }
  }
  private async deliverClient(client: string) {
    this.scheduleDeliveries();
    const delivery = this.state.deliveries![key(client)];
    if (delivery.state === "verified") return delivery;
    delivery.state = "running";
    await this.save();
    try {
      const destination = await this.sync(
        client,
        this.clientRecords(client),
        this.state.destinations[key(client)],
        async (id) => {
          this.state.destinations[key(client)] = id;
          await this.save();
        },
      );
      if (destination) delivery.destination = destination;
      if (destination?.clientsFolderId && destination.clientFolderId)
        (this.state.folders ??= {})[key(client)] = {
          clientsFolderId: destination.clientsFolderId,
          clientFolderId: destination.clientFolderId,
        };
      delivery.state = "verified";
      delivery.error = undefined;
      delivery.nextAttemptAt = undefined;
      (this.state.syncedSignatures ??= {})[key(client)] = delivery.signature;
      for (const job of this.state.jobs)
        if (
          key(job.client) === key(client) &&
          !job.records.length &&
          job.state !== "cancelled" &&
          !job.needsAttention &&
          (job.sync === "failed" || job.sync === "pending")
        ) {
          job.sync = "verified";
          job.state = "completed";
          job.error = undefined;
          job.nextAttemptAt = undefined;
        }
    } catch (error: any) {
      delivery.error = error instanceof Error ? error.message : String(error);
      delivery.attempts++;
      const status = Number(error.response?.status || error.code);
      const temporary =
        !status || [408, 429, 500, 502, 503, 504].includes(status);
      delivery.state =
        temporary && delivery.attempts < 5 ? "pending" : "failed";
      delivery.nextAttemptAt =
        Date.now() + Math.min(30000, 1000 * 2 ** delivery.attempts);
    }
    await this.save();
    return delivery;
  }
  verification() {
    return {
      coverageRecords: this.state.records.length,
      uploadJobs: this.state.jobs.length,
      pendingCoverageSynchronizationJobs:
        this.state.jobs.filter(
          (j) =>
            j.state !== "cancelled" &&
            (j.sync === "pending" || j.sync === "failed"),
        ).length +
        Object.values(this.state.deliveries ?? {}).filter(
          (d) => d.state === "pending" || d.state === "running",
        ).length,
      coverageResearchCacheEntries: 0,
      legacyCoverageMigrationsActive: false,
    };
  }
  summary() {
    const jobs = this.state.jobs,
      pending =
        jobs.some((j) => j.state === "pending" || j.state === "running") ||
        Object.values(this.state.deliveries ?? {}).some(
          (d) => d.state === "pending" || d.state === "running",
        );
    return {
      status:
        !jobs.length && !this.state.records.length
          ? "Idle"
          : !pending
            ? "Completed"
            : this.state.paused
              ? "Paused"
              : "Running",
      totalFiles: jobs.length,
      completedFiles: jobs.filter((j) => j.state === "completed").length,
      failedFiles: jobs.filter((j) => j.state === "failed").length,
      cancelledFiles: jobs.filter((j) => j.state === "cancelled").length,
      pendingFiles: jobs.filter(
        (j) => j.state === "pending" || j.state === "running",
      ).length,
      importedRecords: this.state.records.length,
      rejectedRecords: 0,
      sourceRowsIngested: this.state.sourceOccurrences?.length ?? 0,
      uniqueCoverageRecords: this.state.records.length,
      duplicateSourceOccurrences:
        this.state.sourceOccurrences?.filter((o) => o.duplicate).length ?? 0,
      incompleteRecords: this.state.records.filter(
        (r) => incompleteFields(r).length > 0,
      ).length,
      actualImportFailures: jobs.filter(
        (j) =>
          j.state === "failed" && j.sync === "not-required" && !j.sourceRows,
      ).length,
      recoveredSourceRows: jobs.reduce((n, j) => n + (j.recoveredRows ?? 0), 0),
      googleVerifiedFiles: jobs.filter(
        (j) =>
          j.sync === "verified" ||
          (j.state === "completed" &&
            this.state.deliveries?.[key(j.client)]?.state === "verified"),
      ).length,
      googleFailedFiles: jobs.filter((j) => j.sync === "failed").length,
      pendingClientDeliveries: Object.values(
        this.state.deliveries ?? {},
      ).filter((d) => d.state === "pending" || d.state === "running").length,
      failedClientDeliveries: Object.values(this.state.deliveries ?? {}).filter(
        (d) => d.state === "failed",
      ).length,
      verifiedCoverageRecords: Object.values(
        this.state.deliveries ?? {},
      ).reduce(
        (n, d) =>
          n +
          (d.state === "verified" ? (d.destination?.verifiedRecords ?? 0) : 0),
        0,
      ),
    };
  }
}
