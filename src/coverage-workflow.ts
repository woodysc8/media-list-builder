import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import readXlsx from "read-excel-file/node";
import type { CoverageRecord, ClientRecord } from "./domain.js";
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
  sync: "pending" | "verified" | "local-only" | "failed" | "not-required";
  attempts: number;
  error?: string;
}
export interface CoverageState {
  version: 2;
  generation: string;
  paused: boolean;
  records: CoverageRecord[];
  jobs: Job[];
  destinations: Record<string, string>;
}
export const emptyCoverage = (): CoverageState => ({
  version: 2,
  generation: randomUUID(),
  paused: true,
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
    ) => Promise<void>,
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
    if (/\.xlsx$/i.test(filename)) {
      for (const sheet of await readXlsx(buffer))
        tables.push({ tab: sheet.sheet, rows: sheet.data });
    } else if (/\.csv$/i.test(filename))
      tables.push({
        tab: "",
        rows: parse(buffer, { bom: true, skip_empty_lines: false }),
      });
    else throw new Error("Only CSV and XLSX files are supported");
    const known = this.clients()
      .filter((c) =>
        [c.name, ...c.aliases].some(
          (n) => !!key(n) && key(filename).startsWith(key(n)),
        ),
      )
      .sort((a, b) => b.name.length - a.name.length)[0];
    const detected =
      explicitClient ||
      known?.name ||
      filename
        .replace(/\.[^.]+$/, "")
        .split(/\s+(?:PRCC|PR Campaign|20\d\d)\b/i)[0]
        .replace(/[ _-]+$/, "");
    const canonical =
      this.clients().find((c) =>
        [c.name, ...c.aliases].some((n) => key(n) === key(detected)),
      )?.name || detected;
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
        const url = get(
          "rawurl",
          "rawarticleurl",
          "articleurl",
          "url",
          "articlelink",
          "sourceurl",
          "coverageurl",
          "link",
        );
        if (!validUrl(url) || !canonical) {
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
        job.records.push({
          id: randomUUID(),
          clientId: key(canonical),
          clientName: canonical,
          reporterName: get("reporter", "reportername", "author"),
          outlet: get("publication", "mediaoutlet", "outlet"),
          publicationDate: normalizeDate(get("date", "publicationdate")),
          articleTitle: get("articletitle", "title", "headline", "status"),
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
    await this.save();
    return job;
  }
  async control(action: string) {
    if (action === "pause") this.state.paused = true;
    else if (action === "start" || action === "resume")
      this.state.paused = false;
    else if (action === "retry") {
      for (const j of this.state.jobs)
        if (j.state === "failed") {
          j.state = "pending";
          j.attempts = 0;
        }
      this.state.paused = false;
    } else if (action === "cancel") {
      for (const j of this.state.jobs)
        if (j.state === "pending") j.state = "cancelled";
    } else throw new Error("Unknown queue action");
    await this.save();
  }
  async tick() {
    if (this.busy || this.state.paused) return;
    this.busy = true;
    try {
      const j = this.state.jobs.find((j) => j.state === "pending");
      if (!j) return;
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
      try {
        if (key(j.client) === "conquest") j.sync = "local-only";
        else {
          await this.sync(
            j.client,
            this.state.records.filter(
              (r) => key(r.clientName) === key(j.client),
            ),
            this.state.destinations[key(j.client)],
            async (id) => {
              this.state.destinations[key(j.client)] = id;
              await this.save();
            },
          );
          j.sync = "verified";
        }
        j.state = "completed";
        j.error = undefined;
      } catch (e) {
        j.error = e instanceof Error ? e.message : String(e);
        j.sync = "failed";
        j.attempts++;
        j.state = j.attempts < 5 ? "pending" : "failed";
        await this.save();
        await new Promise((r) =>
          setTimeout(r, Math.min(30000, 1000 * 2 ** j.attempts)),
        );
      }
      await this.save();
    } finally {
      this.busy = false;
    }
  }
  verification() {
    return {
      coverageRecords: this.state.records.length,
      uploadJobs: this.state.jobs.length,
      pendingCoverageSynchronizationJobs: this.state.jobs.filter(
        (j) =>
          j.state !== "cancelled" &&
          (j.sync === "pending" || j.sync === "failed"),
      ).length,
      coverageResearchCacheEntries: 0,
      legacyCoverageMigrationsActive: false,
    };
  }
}
