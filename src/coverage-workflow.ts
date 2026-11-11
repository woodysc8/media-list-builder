import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  coverageTables,
  extractArticleTitle,
  headerKey,
  usableTitle,
  linkCell,
} from "./coverage-titles.js";
import { WORKBOOK_VERSION } from "./coverage-template.js";
import type {
  CoverageRecord,
  ClientRecord,
  CoverageDestination,
} from "./domain.js";
import { normalizeDate } from "./normalize.js";

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
    const tables: { tab: string; rows: unknown[][] }[] = [];
    let parsingError = "";
    try {
      tables.push(...(await coverageTables(buffer, filename)));
    } catch (error) {
      parsingError = error instanceof Error ? error.message : String(error);
    }
    const identity = identifyClient(filename, this.clients(), explicitClient);
    const canonical = identity.client;
    const job: Job = {
      id: randomUUID(),
      file: path.basename(filename),
      client: canonical,
      year: filename.match(/20\d\d/)?.[0] || "",
      state: "pending",
      records: [],
      errors: [],
      imported: 0,
      duplicates: 0,
      sync: "pending",
      attempts: 0,
    };
    if (identity.error) {
      job.state = "failed";
      job.needsAttention = true;
      job.error = identity.error;
      job.sync = "not-required";
    }
    if (parsingError) {
      job.state = "failed";
      job.needsAttention = true;
      job.sync = "not-required";
      job.error = `Unable to parse ${job.file}: ${parsingError}`;
    }
    for (const { tab, rows } of tables) {
      job.year ||= tab.match(/20\d\d/)?.[0] || "";
      const header = rows.findIndex(
        (r) =>
          r.some((c) =>
            [
              "rawurl",
              "url",
              "articleurl",
              "sourceurl",
              "coverageurl",
              "articlelink",
              "rawarticleurl",
              "link",
            ].includes(key(String(c ?? ""))),
          ) ||
          (r.some((c) =>
            ["date", "publicationdate"].includes(key(String(c ?? ""))),
          ) &&
            r.some((c) =>
              ["publication", "outlet", "mediaoutlet"].includes(
                key(String(c ?? "")),
              ),
            )),
      );
      if (header < 0) {
        job.errors.push({
          file: job.file,
          tab,
          row: 1,
          error: "Missing URL column",
        });
        continue;
      }
      const headers = rows[header].map((c) => key(String(c ?? "")));
      for (let i = header + 1; i < rows.length; i++) {
        if (!rows[i].some((c) => c !== null && c !== "")) continue;
        const get = (...names: string[]) => {
          for (const n of names) {
            const v = rows[i][headers.indexOf(n)];
            if (v !== null && v !== undefined && v !== "")
              return v instanceof Date
                ? v.toISOString().slice(0, 10)
                : String(v);
          }
          return "";
        };
        const candidate = get(
          "rawurl",
          "rawarticleurl",
          "articleurl",
          "url",
          "articlelink",
          "sourceurl",
          "coverageurl",
        );
        const url = validUrl(candidate)
          ? candidate
          : ["coveragelink", "articlelink", "link", "status"]
              .map((name) => linkCell(rows[i][headers.indexOf(name)]).url)
              .find((value) => validUrl(value)) || candidate;
        if (!canonical) continue;
        if (!validUrl(url)) {
          job.errors.push({
            file: job.file,
            tab,
            row: i + 1,
            error: !canonical
              ? "Client is required"
              : "Missing or invalid HTTP/HTTPS article URL",
          });
          continue;
        }
        const now = new Date().toISOString();
        const title = extractArticleTitle(
          Object.fromEntries(
            headers.map((name, index) => [name, rows[i][index]]),
          ),
        );
        job.records.push({
          id: randomUUID(),
          clientId:
            this.clients().find((c) => key(c.name) === key(canonical))?.id ||
            key(canonical),
          clientName: canonical,
          reporterName: get("reporter", "reportername", "author"),
          outlet: get("publication", "mediaoutlet", "outlet"),
          publicationDate: normalizeDate(get("date", "publicationdate")),
          articleTitle: title,
          ...(!title
            ? {
                titleNeedsReview: true,
                titleReviewReason: "Original source has no usable headline",
              }
            : {}),
          articleUrl: url,
          spokesperson: get("spokesperson", "spokespersons", "spokespersonsid"),
          originalPressType: get("presstype", "coveragetype"),
          coverageType: (get("presstype", "coveragetype") ||
            "Earned Coverage") as CoverageRecord["coverageType"],
          sentiment: get("sentiment"),
          status: "Completed",
          reach: get("uvm", "reach") || null,
          outletType: "Trade Publication",
          rawFields: { sourceTab: tab, sourceRow: String(i + 1) },
          topics: [],
          source: "PRCC",
          sourceFile: job.file,
          createdAt: now,
          updatedAt: now,
          urlSource: "prcc",
          urlConfidence: "verified",
          urlResolvedAt: now,
        });
      }
    }
    await mkdir(path.join(this.directory, "coverage-uploads"), {
      recursive: true,
    });
    await writeFile(
      path.join(this.directory, "coverage-uploads", job.id),
      buffer,
    );
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
        j.error =
          "No valid coverage rows; correct the listed validation errors and upload again.";
        await this.save();
        return;
      }
      const seen = new Set(this.state.records.map(coverageIdentity));
      for (const r of j.records)
        if (!seen.has(coverageIdentity(r))) {
          seen.add(coverageIdentity(r));
          this.state.records.push(r);
          j.imported++;
        } else j.duplicates++;
      // Local commit and counters are durable before any remote operation.
      j.records = [];
      this.state.records.sort((a, b) =>
        b.publicationDate.localeCompare(a.publicationDate),
      );
      await this.save();
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
    for (const client of new Set(this.state.records.map((r) => r.clientName))) {
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
      rejectedRecords: jobs.reduce((n, j) => n + j.errors.length, 0),
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
      ).reduce((n, d) => n + (d.destination?.verifiedRecords ?? 0), 0),
    };
  }
}
