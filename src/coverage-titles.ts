import readXlsx from "read-excel-file/node";
import { parse } from "csv-parse/sync";
export const headerKey = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
export function linkCell(value: unknown): { text: string; url: string } {
  if (value && typeof value === "object") {
    const cell = value as any;
    return {
      text: String(cell.displayText ?? cell.text ?? cell.value ?? ""),
      url: String(cell.hyperlink ?? cell.url ?? cell.href ?? ""),
    };
  }
  const text = String(value ?? "").trim();
  const formula = text.match(
    /^=HYPERLINK\(\s*"([^"]+)"\s*[,;]\s*"([^"]*)"\s*\)$/i,
  );
  if (formula)
    return { text: formula[2].replaceAll('""', '"'), url: formula[1] };
  const markdown = text.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/i);
  if (markdown) return { text: markdown[1], url: markdown[2] };
  const html = text.match(/^<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>$/i);
  if (html) return { text: html[2].replace(/<[^>]*>/g, ""), url: html[1] };
  return { text, url: /^https?:\/\//i.test(text) ? text : "" };
}
export function usableTitle(value: unknown): string {
  const text = linkCell(value).text.trim();
  if (
    !text ||
    /^(?:https?:\/\/|www\.)/i.test(text) ||
    /^(completed?|published|secured|pending|on hold|in progress|live|confirmed|n\/?a|unknown|tbd|yes|no|link|coverage link|click here)[.!]?$/i.test(
      text,
    )
  )
    return "";
  return text;
}
export function extractArticleTitle(fields: Record<string, unknown>) {
  for (const name of [
    "articletitle",
    "articletitlename",
    "title",
    "headline",
    "storytitle",
    "coveragelink",
    "coverageheadline",
    "articlelink",
    "storylink",
    "titlelink",
    "link",
    "status",
  ]) {
    const title = usableTitle(fields[name]);
    if (title) return title;
  }
  return "";
}
export async function coverageTables(
  buffer: Buffer,
  filename: string,
): Promise<{ tab: string; rows: unknown[][] }[]> {
  if (/\.xlsx$/i.test(filename))
    return (await readXlsx(buffer)).map((sheet) => ({
      tab: sheet.sheet,
      rows: sheet.data,
    }));
  if (/\.csv$/i.test(filename))
    return [
      { tab: "", rows: parse(buffer, { bom: true, skip_empty_lines: false }) },
    ];
  throw new Error("Only CSV and XLSX files are supported");
}
