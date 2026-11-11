import { createHash } from "node:crypto";
import type { CoverageRecord } from "./domain.js";
import {
  coverageTables,
  extractArticleTitle,
  headerKey,
  linkCell,
} from "./coverage-titles.js";
import type { OriginalCell } from "./coverage-xlsx-source.js";

export function validArticleUrl(value: string) {
  try {
    const u = new URL(value);
    return /^https?:$/.test(u.protocol) && !!u.hostname && !/\s/.test(value);
  } catch {
    return false;
  }
}
export function validCoverageDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
function sourceDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value))
    return validCoverageDate(value) ? value : "";
  const parts = value.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (parts) {
    const iso = `${parts[3].length === 2 ? "20" + parts[3] : parts[3]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
    return validCoverageDate(iso) ? iso : "";
  }
  // Do not turn numbers, arbitrary text, or overflowing dates into inferred dates.
  return "";
}
export function incompleteFields(record: CoverageRecord) {
  return [
    !record.clientName && "client",
    !validArticleUrl(record.articleUrl) && "URL",
    !record.articleTitle && "title",
    !validCoverageDate(record.publicationDate) && "date",
    !record.reporterName && "reporter",
    !record.outlet && "publication",
    !record.spokesperson && "spokespersons",
    !(record.originalPressType || record.coverageType) && "coverage type",
    !record.sentiment && "sentiment",
    !record.status && "status",
    (record.reach === null || record.reach === "") && "reach",
  ].filter(Boolean) as string[];
}
export interface SourceOccurrence {
  id: string;
  jobId: string;
  filename: string;
  worksheet: string;
  rowNumber: number;
  /** Ordered arrays preserve duplicate/blank headers and columns beyond the header width. */
  columns: unknown[];
  values: unknown[];
  valueTypes: string[];
  cells?: OriginalCell[];
  sourceSha256: string;
  recordId: string;
  duplicate: boolean;
  incomplete: string[];
  recovered: boolean;
}
export async function parseCoverageSource(
  buffer: Buffer,
  filename: string,
  jobId: string,
  client: string,
  clientId: string,
) {
  const records: CoverageRecord[] = [],
    occurrences: SourceOccurrence[] = [];
  const sourceSha256 = createHash("sha256").update(buffer).digest("hex");
  for (const { tab, rows, originalRows, cells } of await coverageTables(
    buffer,
    filename,
  )) {
    const known = new Set([
      "date",
      "publicationdate",
      "publication",
      "mediaoutlet",
      "outlet",
      "reporter",
      "reportername",
      "author",
      "rawurl",
      "url",
      "rawarticleurl",
      "articleurl",
      "coveragelink",
      "title",
      "headline",
      "articletitle",
      "presstype",
      "status",
      "uvm",
      "reach",
    ]);
    const header = rows.findIndex((row) =>
      row.some((c) => known.has(headerKey(c))),
    );
    const columns = header >= 0 ? (originalRows ?? rows)[header] : [];
    const names = columns.map(headerKey);
    for (const [offset, row] of rows.entries()) {
      if (
        offset === header ||
        !row.some((c) => c !== null && c !== undefined && c !== "")
      )
        continue;
      const get = (...aliases: string[]) => {
        for (const alias of aliases) {
          const value = row[names.indexOf(alias)];
          if (value !== null && value !== undefined && value !== "")
            return value instanceof Date
              ? Number.isFinite(value.valueOf())
                ? value.toISOString().slice(0, 10)
                : ""
              : String(value);
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
      const url = validArticleUrl(candidate)
        ? candidate
        : ["coveragelink", "articlelink", "link", "status"]
            .map((name) => linkCell(row[names.indexOf(name)]).url)
            .find(validArticleUrl) || "";
      const date = sourceDate(get("date", "publicationdate"));
      const title = extractArticleTitle(
        Object.fromEntries(names.map((name, index) => [name, row[index]])),
      );
      const id = createHash("sha256")
        .update(`${jobId}\0${tab}\0${offset + 1}`)
        .digest("hex");
      const now = new Date().toISOString();
      const record: CoverageRecord = {
        id,
        clientId,
        clientName: client,
        reporterName: get("reporter", "reportername", "author"),
        outlet: get("publication", "mediaoutlet", "outlet"),
        publicationDate: validCoverageDate(date) ? date : "",
        articleTitle: title,
        articleUrl: url,
        spokesperson: get("spokesperson", "spokespersons", "spokespersonsid"),
        originalPressType: get("presstype", "coveragetype"),
        coverageType: get(
          "presstype",
          "coveragetype",
        ) as CoverageRecord["coverageType"],
        sentiment: get("sentiment"),
        status: (["Completed", "On Hold", "Pending"].includes(get("status"))
          ? get("status")
          : "") as CoverageRecord["status"],
        reach: get("uvm", "reach") || null,
        outletType: "" as CoverageRecord["outletType"],
        rawFields: {
          sourceTab: tab,
          sourceRow: String(offset + 1),
          sourceSha256,
          sourceOccurrenceId: id,
        },
        topics: [],
        source: "PRCC",
        sourceFile: filename,
        createdAt: now,
        updatedAt: now,
        urlSource: url ? "prcc" : null,
        urlConfidence: url ? "verified" : "unresolved",
        urlResolvedAt: url ? now : null,
        ...(!title
          ? {
              titleNeedsReview: true,
              titleReviewReason: "Original source has no usable headline",
            }
          : {}),
      };
      records.push(record);
      const original = originalRows?.[offset] ?? row;
      occurrences.push({
        id,
        jobId,
        filename,
        worksheet: tab,
        rowNumber: offset + 1,
        columns,
        values: original,
        valueTypes: original.map((value) =>
          value instanceof Date
            ? "Date"
            : value === null
              ? "null"
              : typeof value,
        ),
        ...(cells ? { cells: cells[offset] ?? [] } : {}),
        sourceSha256,
        recordId: id,
        duplicate: false,
        incomplete: incompleteFields(record),
        recovered: false,
      });
    }
  }
  return { records, occurrences };
}
