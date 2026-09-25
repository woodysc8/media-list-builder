import { parse } from "csv-parse/sync";
import type { ExtractedCoverage, IngestionSource } from "./domain.js";
import { clean, normalizeCoverage } from "./normalize.js";

type InputRow = Record<string, unknown>;

interface LinkedCell {
  displayText: string;
  url: string;
  isLink: boolean;
}

function rawValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\uFEFF]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function valueFromFields(
  fields: Record<string, unknown>,
  names: string[]
): string {
  for (const name of names) {
    const value = fields[normalizeHeader(name)];

    if (value !== undefined && value !== null) {
      const cleaned = clean(String(value));

      if (cleaned) {
        return cleaned;
      }
    }
  }

  return "";
}

function reachFromFields(
  fields: Record<string, unknown>,
  names: string[]
): string | number | null {
  const value = valueFromFields(fields, names);
  if (!value) return null;

  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : value;
}

function mapRow(row: InputRow): ExtractedCoverage {
  const fields: Record<string, unknown> = {};
  const rawFields: Record<string, string> = {};

  for (const [key, value] of Object.entries(row)) {
    fields[normalizeHeader(key)] = value;
    rawFields[key] = rawValue(value);
  }

  const clientName = valueFromFields(fields, [
    "client",
    "client name",
    "clientname",
    "company",
    "client company",
    "clientcompany"
  ]);

  const reporterName = valueFromFields(fields, [
    "reporter",
    "reporter name",
    "reportername",
    "author",
    "journalist",
    "writer",
    "contact"
  ]);

  const outlet = valueFromFields(fields, [
    "outlet",
    "publication",
    "publication name",
    "publicationname",
    "media outlet",
    "mediaoutlet",
    "source",
    "media",
    "publication/outlet"
  ]);

  const publicationDate = valueFromFields(fields, [
    "date",
    "publication date",
    "publicationdate",
    "publish date",
    "publishdate",
    "coverage date",
    "coveragedate",
    "published",
    "published date",
    "publisheddate"
  ]);

  const explicitArticleTitle = valueFromFields(fields, [
    "article title",
    "article title/name",
    "article",
    "title",
    "headline",
    "story title",
    "storytitle",
    "coverage",
    "story"
  ]);

  const genericLink = valueFromFields(fields, ["link"]);
  const linkCell = linkedCell(fields[normalizeHeader("link")]);
  const statusCell = linkedCell(fields[normalizeHeader("status")]);
  const articleTitle = explicitArticleTitle ||
    (linkCell.displayText && !linkCell.url ? linkCell.displayText : "") ||
    (linkCell.isLink ? linkCell.displayText : "") ||
    (statusCell.isLink ? statusCell.displayText : "") ||
    (genericLink && !/^https?:\/\/\S+$/i.test(genericLink) ? genericLink : "");

  const explicitArticleUrl = valueFromFields(fields, [
    "article url",
    "articleurl",
    "source url",
    "sourceurl",
    "article link",
    "articlelink",
    "url",
    "coverage url",
    "coverageurl"
  ]);
  const articleUrl = explicitArticleUrl || linkCell.url || statusCell.url;

  const spokesperson = valueFromFields(fields, [
    "spokesperson",
    "spokespersons id",
    "spokespersonsid"
  ]);

  const originalPressType = valueFromFields(fields, ["press type", "presstype"]);
  const coverageType = valueFromFields(fields, [
    "coverage type",
    "coveragetype",
    "type",
    "coverage classification",
    "coverageclassification"
  ]);

  const sentiment = valueFromFields(fields, ["sentiment", "coverage sentiment"]);
  const status = statusCell.isLink ? "" : valueFromFields(fields, ["coverage status", "status"]);
  const reach = reachFromFields(fields, [
    "reach",
    "media reach",
    "uvm",
    "estimated reach",
    "estimatedreach"
  ]);

  const topicValue = valueFromFields(fields, [
    "topics",
    "topic",
    "beat",
    "beats"
  ]);

  return normalizeCoverage({
    clientName,
    reporterName,
    outlet,
    publicationDate,
    articleTitle,
    articleUrl,
    spokesperson,
    originalPressType,
    coverageType,
    sentiment,
    status,
    reach,
    rawFields,
    topics: topicValue
      ? topicValue
          .split(",")
          .map((value) => clean(value))
          .filter(Boolean)
      : []
  });
}

function clientFromFilename(filename: string): string {
  const baseName = filename
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[^.]+$/, "")
    .trim() ?? "";

  /*
   * Handles:
   *
   * Angeles PR Campaign Calendar...
  * Client PR Campaign...
   * Angeles - 2026 Media Activity...
   *
   * The first segment before "PR Campaign" is preferred.
   */

  const prCampaignMatch = baseName.match(
    /^(.+?)\s+pr\s+campaign\b/i
  );

  if (prCampaignMatch?.[1]) {
    return clean(prCampaignMatch[1]);
  }

  /*
   * Fallback for exports where the filename is:
   *
   * Angeles - 2026 Media Activity
   */
  const dashMatch = baseName.match(
    /^(.+?)\s*[-–—]\s*\d{4}\s+media\s+activity/i
  );

  if (dashMatch?.[1]) {
    return clean(dashMatch[1]);
  }

  return "";
}

function parseCsv(content: string): InputRow[] {
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true
  }) as InputRow[];
}

export function parseInput(
  content: string,
  filename: string
): {
  source: IngestionSource;
  items: ExtractedCoverage[];
} {
  const extension = filename
    .toLowerCase()
    .split(".")
    .pop();

  // ============================================================
  // JSON
  // ============================================================

  if (extension === "json") {
    const parsed = JSON.parse(content) as
      | InputRow
      | InputRow[]
      | { records?: InputRow[] };

    const rows: InputRow[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { records?: InputRow[] }).records)
        ? (parsed as { records: InputRow[] }).records
        : [parsed as InputRow];

    return {
      source: "JSON",
      items: rows
        .map(mapRow)
        .filter(
          (item) =>
            item.clientName ||
            item.articleTitle ||
            item.articleUrl ||
            item.reporterName ||
            item.outlet
        )
    };
  }

  // ============================================================
  // CSV
  // ============================================================

  if (extension === "csv") {
    const rows = parseCsv(content);
    const filenameClient = clientFromFilename(filename);

    console.log(
      `[PARSER] CSV rows detected: ${rows.length}`
    );

    console.log(
      `[PARSER] Filename client: ${filenameClient || "(none)"}`
    );

    if (rows.length > 0) {
      console.log(
        `[PARSER] CSV headers: ${Object.keys(rows[0]).join(" | ")}`
      );

      console.log(
        `[PARSER] First CSV row:`,
        rows[0]
      );
    }

    const items = rows
      .map((row) => {
        const item = mapRow(row);

        /*
         * If the CSV does not contain a client column,
         * use the client encoded in the filename.
         */
        if (!item.clientName && filenameClient) {
          return {
            ...item,
            clientName: filenameClient
          };
        }

        return item;
      })
      .filter(
        (item) =>
          item.clientName ||
          item.articleTitle ||
          item.articleUrl ||
          item.reporterName ||
          item.outlet
      );

    console.log(
      `[PARSER] Coverage items produced: ${items.length}`
    );

    if (items.length > 0) {
      console.log(
        `[PARSER] First normalized item:`,
        items[0]
      );
    }

    return {
      source: "CSV",
      items
    };
  }

  // ============================================================
  // PLAIN TEXT
  // ============================================================

  const items = content
    .split(/\n\s*\n/)
    .map((block) => {
      const fields: InputRow = {};

      for (const line of block.split(/\r?\n/)) {
        const match = line.match(
          /^\s*([^:]+):\s*(.*)$/
        );

        if (match) {
          fields[match[1]] = match[2];
        }
      }

      return mapRow(fields);
    })
    .filter(
      (item) =>
        item.clientName ||
        item.articleTitle ||
        item.articleUrl ||
        item.reporterName ||
        item.outlet
    );

  return {
    source: "Text",
    items
  };
}

/** Extracts title + target when a source format preserves hyperlink metadata. */
function linkedCell(value: unknown): LinkedCell {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const cell = value as Record<string, unknown>;
    const displayText = clean(String(cell.displayText ?? cell.text ?? cell.value ?? cell.title ?? ""));
    const url = clean(String(cell.hyperlink ?? cell.url ?? cell.href ?? cell.link ?? ""));
    if (url) return { displayText, url, isLink: true };
  }

  const text = clean(String(value ?? ""));
  const formula = text.match(/^=HYPERLINK\(\s*"([^"]+)"\s*[;,]\s*"([^"]*)"\s*\)$/i);
  if (formula) return { displayText: clean(formula[2]), url: clean(formula[1]), isLink: true };
  const markdown = text.match(/^\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/i);
  if (markdown) return { displayText: clean(markdown[1]), url: clean(markdown[2]), isLink: true };
  const html = text.match(/^<a\s+[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>(.*?)<\/a>$/i);
  if (html) return { displayText: clean(html[2].replace(/<[^>]+>/g, "")), url: clean(html[1]), isLink: true };
  const isUrl = /^https?:\/\/\S+$/i.test(text);
  return { displayText: text, url: isUrl ? text : "", isLink: isUrl };
}
