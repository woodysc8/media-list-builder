import { access, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { CoverageRecord } from "./domain.js";
import { parseInput } from "./parser.js";
import { normalizeDate, normalizeName } from "./normalize.js";
import { canonicalCoverageType, resolveStatus } from "./coverage-resolvers.js";
import { StructuredStore } from "./store.js";

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const filePath of paths) {
    try {
      await access(filePath);
      return filePath;
    } catch {
      // Try the next known source location.
    }
  }
  return undefined;
}

function sameRecord(record: CoverageRecord, item: CoverageRecord): boolean {
  if (record.articleUrl && item.articleUrl && record.articleUrl === item.articleUrl) return true;
  return record.clientName === item.clientName &&
    normalizeDate(record.publicationDate) === normalizeDate(item.publicationDate) &&
    normalizeName(record.outlet) === normalizeName(item.outlet) &&
    normalizeName(record.articleTitle) === normalizeName(item.articleTitle) &&
    normalizeName(record.reporterName) === normalizeName(item.reporterName);
}

export async function migrateCoverageFromSources(
  store: StructuredStore,
  storePath: string
): Promise<{ filesRead: number; recordsUpdated: number }> {
  const snapshot = store.snapshot;
  const sourceFiles = new Set(
    snapshot.coverage
      .map((record) => record.sourceFile?.trim())
      .filter((value): value is string => Boolean(value))
  );
  let filesRead = 0;
  let recordsUpdated = 0;

  for (const sourceFile of sourceFiles) {
    const name = basename(sourceFile);
    const path = await firstExisting([
      resolve(dirname(storePath), sourceFile),
      resolve(dirname(storePath), name),
      resolve(process.cwd(), sourceFile),
      resolve(process.cwd(), name)
    ]);
    if (!path) continue;

    const parsed = parseInput(await readFile(path, "utf8"), name);
    filesRead += 1;

    for (const record of store.snapshot.coverage.filter((item) => item.sourceFile === sourceFile)) {
      const match = parsed.items.find((item) => sameRecord(record, {
        ...record,
        clientName: item.clientName,
        publicationDate: item.publicationDate,
        outlet: item.outlet,
        articleTitle: item.articleTitle,
        articleUrl: item.articleUrl,
        reporterName: item.reporterName
      }));
      if (!match) continue;

      const updated = {
        ...record,
        spokesperson: match.spokesperson || record.spokesperson,
        coverageType: canonicalCoverageType(match.coverageType || record.coverageType),
        sentiment: match.sentiment || record.sentiment,
        status: resolveStatus(match.status || record.status),
        reach: match.reach !== null && match.reach !== "" ? match.reach : record.reach,
        articleUrl: match.articleUrl || record.articleUrl
      };
      const changed = JSON.stringify(updated) !== JSON.stringify(record);
      if (changed) {
        store.updateCoverage(updated);
        recordsUpdated += 1;
      }
    }
  }

  if (recordsUpdated) await store.save();
  return { filesRead, recordsUpdated };
}
