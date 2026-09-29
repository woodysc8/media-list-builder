import type { CoverageRecord, ReporterRecord } from "./domain.js";
import { deriveMostRecentArticles, isReporterCurrent, reporterCutoffDate } from "./reporter-recency.js";
import { reporterIdentityKey } from "./reporter-fields.js";

export interface ReporterPreflightSnapshot {
  reporters: ReporterRecord[];
  archivedReporters: ReporterRecord[];
  coverage: CoverageRecord[];
}

export interface ReporterPreflightTab {
  title: string;
  sheetId: number;
  values: string[][];
}

/** Run the diagnostic using a cloned store snapshot; no store mutation API is exposed. */
export async function runReadOnlyReporterPreflight<T>(
  workspace: {
    connected: boolean;
    reporterPreflight(local: ReporterPreflightSnapshot): Promise<T>;
  },
  store: { readonly snapshot: ReporterPreflightSnapshot }
): Promise<T> {
  if (!workspace.connected) throw new Error("Google authorization is required for the read-only reporter preflight");
  return workspace.reporterPreflight(store.snapshot);
}

const HUMAN_FIELDS = [
  ["Outlet", "outlet"], ["Reporter First Name", "firstName"],
  ["Reporter Last Name", "lastName"], ["Email", "email"],
  ["Reporter Type", "reporterType"], ["Beats", "beats"],
  ["Notes", "notes"], ["Status", "status"]
] as const;

function cell(row: string[], headers: string[], name: string, fallback: number): string {
  const index = headers.findIndex((header) => header.trim().toLowerCase() === name.toLowerCase());
  return String(row[index >= 0 ? index : fallback] ?? "").trim();
}

function rowIdentity(row: string[], headers: string[]): string {
  return reporterIdentityKey({
    outlet: cell(row, headers, "Outlet", 1),
    firstName: cell(row, headers, "Reporter First Name", 2),
    lastName: cell(row, headers, "Reporter Last Name", 3)
  });
}

function reporterIdentityKeys(reporter: ReporterRecord): Set<string> {
  return new Set([reporter, ...(reporter.identityAliases ?? [])].map(reporterIdentityKey));
}

function reporterRowMatch(row: string[], headers: string[], reporters: ReporterRecord[]): ReporterRecord | undefined {
  const id = cell(row, headers, "ID", 0);
  if (id) return reporters.find((reporter) => reporter.id === id);
  const key = rowIdentity(row, headers);
  return reporters.find((reporter) => reporterIdentityKeys(reporter).has(key));
}

function person(reporter: ReporterRecord) {
  return { id: reporter.id, name: `${reporter.firstName} ${reporter.lastName}`.trim(), outlet: reporter.outlet };
}

function reporterRows(tab: ReporterPreflightTab): string[][] {
  const headers = tab.values[0] ?? [];
  return tab.values.slice(1).filter((row) =>
    cell(row, headers, "ID", 0) || cell(row, headers, "Reporter First Name", 2) || cell(row, headers, "Reporter Last Name", 3)
  );
}

export function buildReporterPreflight(
  local: ReporterPreflightSnapshot,
  rawTab: ReporterPreflightTab,
  cleanedTab: ReporterPreflightTab,
  asOf = new Date()
) {
  const allLocal = [...local.reporters, ...local.archivedReporters];
  const derivedActive = deriveMostRecentArticles(local.reporters, local.coverage);
  const derivedArchived = deriveMostRecentArticles(local.archivedReporters, local.coverage);
  const current = derivedActive.filter((reporter) => isReporterCurrent(reporter, asOf));
  const expiredActive = derivedActive.filter((reporter) => !isReporterCurrent(reporter, asOf));
  const reactivatable = derivedArchived.filter((reporter) => isReporterCurrent(reporter, asOf));
  const expiredArchived = derivedArchived.filter((reporter) => !isReporterCurrent(reporter, asOf));
  const nextArchived = [...local.archivedReporters, ...expiredActive];

  const rawHeaders = rawTab.values[0] ?? [];
  const cleanHeaders = cleanedTab.values[0] ?? [];
  const cleanRows = reporterRows(cleanedTab);
  const rawRows = reporterRows(rawTab);
  const localIds = new Set(allLocal.map((reporter) => reporter.id));
  const cleanedMatched = cleanRows.map((row) => reporterRowMatch(row, cleanHeaders, allLocal));
  const cleanMatchCount = cleanRows.filter((row) => {
    const id = cell(row, cleanHeaders, "ID", 0);
    return Boolean(id && localIds.has(id));
  }).length;
  const activeWithoutCleaned = current.filter((reporter) => !cleanRows.some((row) => reporterRowMatch(row, cleanHeaders, [reporter])));
  const cleanedWithoutLocal = cleanRows.filter((row, index) => !cleanedMatched[index]);

  const ids = cleanRows.map((row) => cell(row, cleanHeaders, "ID", 0)).filter(Boolean);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const identityGroups = new Map<string, string[][]>();
  for (const row of cleanRows) {
    const key = rowIdentity(row, cleanHeaders);
    if (!key.replaceAll("|", "")) continue;
    const group = identityGroups.get(key) ?? [];
    group.push(row);
    identityGroups.set(key, group);
  }
  const duplicateIdentities = [...identityGroups.entries()].filter(([, rows]) => rows.length > 1).map(([identity, rows]) => ({ identity, count: rows.length }));

  const humanFieldDifferences = cleanRows.flatMap((row, index) => {
    const reporter = cleanedMatched[index];
    if (!reporter) return [];
    const differingFields = HUMAN_FIELDS.filter(([header, key]) =>
      cell(row, cleanHeaders, header, -1) !== String(reporter[key] ?? "").trim()
    ).map(([header]) => header);
    return differingFields.length ? [{ reporter: person(reporter), fields: differingFields }] : [];
  });

  const appOwnedChanges = cleanRows.flatMap((row, index) => {
    const reporter = cleanedMatched[index];
    if (!reporter) return [];
    const derived = [...derivedActive, ...derivedArchived].find((candidate) => candidate.id === reporter.id);
    if (!derived) return [];
    const changedFields = [
      ...(cell(row, cleanHeaders, "Most Recent Article", 9) !== derived.mostRecentArticle ? ["Most Recent Article"] : []),
      ...(cell(row, cleanHeaders, "Clients Covered", 6) !== derived.clientsCovered ? ["Clients Covered"] : [])
    ];
    return changedFields.length ? [{ reporter: person(reporter), fields: changedFields }] : [];
  });

  const idlessMatched = cleanRows.map((row, index) => !cell(row, cleanHeaders, "ID", 0) && Boolean(cleanedMatched[index]));
  const idsToPopulate = cleanRows.flatMap((row, index) => idlessMatched[index] ? [person(cleanedMatched[index]!)] : []);

  const expiredSet = [...expiredActive, ...expiredArchived];
  const expiredCleaned = cleanRows.flatMap((row) => {
    const reporter = reporterRowMatch(row, cleanHeaders, expiredSet);
    return reporter ? [person(reporter)] : [];
  });
  const rowsDeletedNextSync = cleanRows.flatMap((row) => {
    const reporter = reporterRowMatch(row, cleanHeaders, nextArchived);
    return reporter && !current.some((item) => item.id === reporter.id) ? [person(reporter)] : [];
  });
  const cleanedActive = cleanRows.flatMap((row) => {
    const reporter = reporterRowMatch(row, cleanHeaders, current);
    return reporter ? [person(reporter)] : [];
  });

  const stagingNotCleaned = rawRows.filter((row) => {
    const rawId = cell(row, rawHeaders, "ID", 0);
    if (rawId && cleanRows.some((clean) => cell(clean, cleanHeaders, "ID", 0) === rawId)) return false;
    const key = rowIdentity(row, rawHeaders);
    return !cleanRows.some((clean) => rowIdentity(clean, cleanHeaders) === key);
  });

  return {
    asOf: asOf.toISOString().slice(0, 10),
    cutoffDate: reporterCutoffDate(asOf),
    spreadsheet: {
      sheet1: { title: rawTab.title, sheetId: rawTab.sheetId, rowCount: rawRows.length, headers: rawHeaders },
      cleaned: { title: cleanedTab.title, sheetId: cleanedTab.sheetId, rowCount: cleanRows.length, headers: cleanHeaders }
    },
    totals: {
      localActiveReporters: local.reporters.length,
      localArchivedOrExpiredReporters: local.archivedReporters.length,
      localActiveAfterRecency: current.length,
      sheet1Reporters: rawRows.length,
      cleanedDirectoryReporters: cleanRows.length,
      cleanedIdsMatchingLocal: cleanMatchCount,
      localActiveWithoutCleanedRow: activeWithoutCleaned.length,
      cleanedWithoutLocalReporter: cleanedWithoutLocal.length,
      duplicateCleanedIds: duplicateIds.length,
      duplicateCleanedIdentities: duplicateIdentities.length,
      humanFieldDifferenceRows: humanFieldDifferences.length,
      mostRecentArticleWouldChange: appOwnedChanges.filter((entry) => entry.fields.includes("Most Recent Article")).length,
      clientsCoveredWouldChange: appOwnedChanges.filter((entry) => entry.fields.includes("Clients Covered")).length,
      cleanedIdsWouldBePopulated: idsToPopulate.length,
      cleanedReportersExpired: expiredCleaned.length,
      cleanedRowsWouldBeDeleted: rowsDeletedNextSync.length,
      cleanedReportersActive: cleanedActive.length,
      archivedReportersEligibleToReactivate: reactivatable.length,
      sheet1NotInCleanedStagingCandidates: stagingNotCleaned.length
    },
    humanFieldOwnership: "These fields remain Google/Gemini-owned under the current implementation and are expected to be preserved from the cleaned directory: Outlet, Reporter First Name, Reporter Last Name, Email, Reporter Type, Beats, Notes, Status.",
    exceptions: {
      localActiveWithoutCleanedRow: activeWithoutCleaned.map(person),
      cleanedWithoutLocalReporter: cleanedWithoutLocal.map((row) => ({ id: cell(row, cleanHeaders, "ID", 0), name: `${cell(row, cleanHeaders, "Reporter First Name", 2)} ${cell(row, cleanHeaders, "Reporter Last Name", 3)}`.trim(), outlet: cell(row, cleanHeaders, "Outlet", 1) })),
      duplicateCleanedIds: duplicateIds,
      duplicateCleanedIdentities: duplicateIdentities,
      humanFieldDifferences,
      appOwnedChanges,
      idsToPopulate,
      cleanedReportersExpired: expiredCleaned,
      cleanedRowsWouldBeDeleted: rowsDeletedNextSync,
      cleanedReportersActive: cleanedActive,
      archivedReportersEligibleToReactivate: reactivatable.map(person),
      sheet1NotInCleanedStagingCandidates: stagingNotCleaned.map((row) => ({ id: cell(row, rawHeaders, "ID", 0), name: `${cell(row, rawHeaders, "Reporter First Name", 2)} ${cell(row, rawHeaders, "Reporter Last Name", 3)}`.trim(), outlet: cell(row, rawHeaders, "Outlet", 1) }))
    }
  };
}
