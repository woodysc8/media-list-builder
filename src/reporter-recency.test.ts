import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StructuredStore } from "./store.js";
import type { CoverageRecord, ReporterRecord } from "./domain.js";
import { deriveMostRecentArticles, isReporterCurrent, reporterCutoffDate } from "./reporter-recency.js";
import { GoogleWorkspace, REPORTER_HEADERS } from "./google.js";

const asOf = new Date("2026-09-24T12:00:00.000Z");
const reporter = (id: string, firstName = id, outlet = "Outlet A"): ReporterRecord => ({
  id, firstName, lastName: "Reporter", outlet, email: "", clientsCovered: "", beats: "",
  reporterType: "reporter", notes: "", mostRecentArticle: "", status: "Active"
});
const reporterInput = (firstName: string, outlet: string): Omit<ReporterRecord, "id"> => ({
  firstName, lastName: "Reporter", outlet, email: "", clientsCovered: "", beats: "",
  reporterType: "reporter", notes: "", mostRecentArticle: "", status: "Active"
});
const coverage = (reporterId: string, date: string, clientName = "Client A", outlet = "Outlet A"): CoverageRecord => ({
  id: `${reporterId}-${date}-${clientName}`, clientId: `CLI-${clientName}`, clientName, reporterId,
  reporterName: `${reporterId} Reporter`, outlet, publicationDate: date, articleTitle: "Article", articleUrl: "",
  urlSource: null, urlConfidence: "unresolved", urlResolvedAt: null, spokesperson: "", originalPressType: "",
  coverageType: "Earned Coverage", sentiment: "Positive", status: "Completed", reach: null, outletType: "Trade Publication",
  rawFields: {}, topics: [], source: "CSV", createdAt: date, updatedAt: date
});

assert.equal(reporterCutoffDate(asOf), "2025-03-24");
const dates = deriveMostRecentArticles(
  [reporter("recent"), reporter("boundary"), reporter("expired"), reporter("multiple"), reporter("clients")],
  [
    coverage("recent", "2026-01-02"), coverage("boundary", "2025-03-24"), coverage("expired", "2025-03-23"),
    coverage("multiple", "2024-01-01"), coverage("multiple", "2026-02-01"),
    coverage("clients", "2025-10-01", "Client A", "Outlet A"), coverage("clients", "2026-03-01", "Client B", "Outlet B"),
    coverage("recent", "not-a-date")
  ]
);
assert.deepEqual(dates.map((item) => item.mostRecentArticle), ["2026-01-02", "2025-03-24", "2025-03-23", "2026-02-01", "2026-03-01"]);
assert.equal(isReporterCurrent(dates[0]!, asOf), true);
assert.equal(isReporterCurrent(dates[1]!, asOf), true);
assert.equal(isReporterCurrent(dates[2]!, asOf), false);
const noCoverage = deriveMostRecentArticles([reporter("no-coverage")], [])[0]!;
assert.equal(noCoverage.mostRecentArticle, "");
assert.equal(isReporterCurrent(noCoverage, asOf), false);

const directory = await mkdtemp(path.join(tmpdir(), "reporter-recency-"));
try {
  const store = new StructuredStore(path.join(directory, "store.json"));
  await store.load();
  const created = store.addReporter({ ...reporterInput("Returning", "Outlet Z"), email: "person@example.test", beats: "Markets", notes: "Keep me", status: "Needs Review" });
  store.addCoverage(coverage(created.id, "2025-03-23"));
  assert.equal((await store.prepareCurrentReporters(asOf)).length, 0);
  assert.equal(store.snapshot.coverage.length, 1, "expiration must preserve historical coverage");
  const restored = store.addReporter(reporterInput("Returning", "Outlet Z"));
  assert.equal(restored.id, created.id, "restoring an expired identity must preserve its REP id");
  assert.equal(restored.email, "person@example.test", "reactivation must preserve human-maintained fields");
  assert.equal(restored.beats, "Markets");
  assert.equal(restored.notes, "Keep me");
  assert.equal(restored.status, "Needs Review");
  store.addCoverage(coverage(restored.id, "2026-04-01", "Client B", "Outlet Z"));
  const current = await store.prepareCurrentReporters(asOf);
  assert.equal(current.length, 1);
  assert.equal(current[0]?.mostRecentArticle, "2026-04-01");
  assert.equal(store.snapshot.coverage.length, 2);
} finally {
  await rm(directory, { recursive: true, force: true });
}

// Exercise the real row projection and stale-row deletion with a small Sheets API stub.
process.env.GOOGLE_CLIENT_ID = "test";
process.env.GOOGLE_CLIENT_SECRET = "test";
const headers = ["ID", "Outlet", "Reporter First Name", "Reporter Last Name", "Email", "Reporter Type", "Clients Covered", "Beats", "Notes", "Most Recent Article", "Status"];
assert.deepEqual(REPORTER_HEADERS, headers);
const existingReporter = reporter("REP-000001", "Kept");
const existingRow = [existingReporter.id, existingReporter.outlet, existingReporter.firstName, existingReporter.lastName, "", "reporter", "", "", "", "2026-01-02", "Active"];
const staleRow = ["REP-000002", "Old Outlet", "Expired", "Reporter", "", "reporter", "", "", "", "2025-03-23", "Active"];
const unmanagedRow = ["REP-000099", "Other Outlet", "Unmanaged", "Reporter", "", "reporter", "", "", "", "2025-03-23", "Active"];
const calls: { updates?: unknown[]; layout?: unknown[]; requests?: unknown[] } = {};
const workspace = new GoogleWorkspace("root") as any;
workspace.drive = {};
workspace.sheets = {
  spreadsheets: {
    values: {
      get: async () => ({ data: { values: [headers, existingRow, staleRow, unmanagedRow] } }),
      append: async () => ({}),
      batchUpdate: async (arg: any) => { calls.updates = arg.requestBody.data; return {}; },
      update: async () => ({})
    },
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 101, title: "Sheet1", index: 0 } }, { properties: { sheetId: 42, title: "Master Directory (Cleaned)", index: 1 } }] } }),
    batchUpdate: async (arg: any) => { calls.requests = arg.requestBody.requests; return {}; }
  }
};
workspace.inspectRoot = async () => ({ name: "root", clientsFolder: undefined, reporterSheet: "reporters", outletSheet: undefined });
const syncReporter = { ...existingReporter, mostRecentArticle: "2026-01-02" };
const firstSync = await workspace.syncMasterReporterList([syncReporter], { archivedReporters: [reporter("REP-000002", "Expired", "Old Outlet")] });
assert.equal(firstSync.skippedReporterRows, 1, "unchanged rows should not be rewritten");
assert.equal(calls.requests?.length, 1, "expired rows should be deleted from the sheet");
assert.equal((calls.requests?.[0] as any).deleteDimension.range.sheetId, 42);
assert.equal(calls.updates, undefined);

// Google owns editable identity/contact fields, while the application owns
// ID, client coverage, and the date derived from Coverage history.
const sheetEditedRow = ["REP-000005", "Edited Outlet", "Sheet", "Name", "sheet@example.test", "podcast", "Old Client", "Podcasting", "Human note", "1999-01-01", "Needs Review"];
workspace.sheets.spreadsheets.values.get = async () => ({ data: { values: [headers, sheetEditedRow] } });
const mergeResult = await workspace.syncMasterReporterList([{
  ...reporter("REP-000005", "Before", "Before Outlet"), clientsCovered: "Client From Coverage", mostRecentArticle: "2026-08-01"
}]);
assert.equal(mergeResult.mergedReporters[0]?.firstName, "Sheet");
assert.equal(mergeResult.mergedReporters[0]?.identityAliases?.[0]?.firstName, "Before");
assert.equal(mergeResult.mergedReporters[0]?.clientsCovered, "Client From Coverage");
assert.equal(mergeResult.mergedReporters[0]?.mostRecentArticle, "2026-08-01");
assert.equal((calls.updates as unknown[] | undefined)?.length, 2, "only the two changed app-owned cells are written");
const mergedWrite = (calls.updates as unknown as any[])[0].values[0] as string[];
const mergedUpdates = calls.updates as unknown as any[];
assert.deepEqual(mergedUpdates.map((update: any) => update.range), ["'Master Directory (Cleaned)'!G2", "'Master Directory (Cleaned)'!J2"]);
assert.deepEqual(mergedWrite, ["Client From Coverage"]);
assert.deepEqual(mergedUpdates[1].values[0], ["2026-08-01"], "sheet-edited recency must be replaced from Coverage-derived local data");

const blankHumanFieldsRow = ["REP-000006", "Outlet", "Blank", "Reporter", "", "", "", "", "", "2026-01-01", ""];
workspace.sheets.spreadsheets.values.get = async () => ({ data: { values: [headers, blankHumanFieldsRow] } });
const blankMerge = await workspace.syncMasterReporterList([reporter("REP-000006", "Blank")]);
assert.equal(blankMerge.mergedReporters[0]?.reporterType, "", "intentional blank reporter type stays blank");
assert.equal(blankMerge.mergedReporters[0]?.status, "", "intentional blank status stays blank");

// A Google row unrelated to any archived reporter is retained. Deletion targets
// only the known expired reporter ID, never every row absent from local state.
assert.equal((calls.requests?.[0] as any).deleteDimension.range.startIndex, 2);

// Explicitly approved enrichment can change its proposed human-owned values,
// while app-owned columns still come from local derived reporter data.
workspace.sheets.spreadsheets.values.get = async () => ({ data: { values: [headers, sheetEditedRow] } });
await workspace.applyEnrichmentProposals([{
  reporterId: "REP-000005", outlet: "Approved Outlet", reporterName: "Approved Name", email: "approved@example.test",
  reporterType: "reporter", beats: ["Markets & Economy"], status: "verified", confidence: 0.9,
  rationale: "human approved"
}], [{ ...reporter("REP-000005"), clientsCovered: "Client From Coverage", mostRecentArticle: "2026-08-01" }]);
const approvedWrite = (calls.updates as unknown as any[])[0].values[0] as string[];
assert.equal(approvedWrite[1], "Approved Outlet");
assert.equal(approvedWrite[2], "Approved");
assert.equal(approvedWrite[4], "approved@example.test");
assert.equal(approvedWrite[6], "Client From Coverage");
assert.equal(approvedWrite[8], "Human note");
assert.equal(approvedWrite[9], "2026-08-01");

// A fresh empty sheet proves the new date column is projected at index 9.
workspace.sheets.spreadsheets.values.get = async () => ({ data: { values: [headers] } });
workspace.sheets.spreadsheets.values.append = async (arg: any) => { calls.updates = arg.requestBody.values; return {}; };
await workspace.syncMasterReporterList([{ ...reporter("REP-000003", "Written"), mostRecentArticle: "2026-04-01" }], { addUnlisted: true });
const writtenRows = calls.updates as unknown as string[][];
assert.equal(writtenRows[0]?.[9], "2026-04-01");
assert.equal(writtenRows[0]?.[10], "Active");

const legacyHeaders = ["ID", "Outlet", "Reporter First Name", "Reporter Last Name", "Email", "Reporter Type", "Clients Covered", "Beats", "Notes", "Status"];
workspace.sheets.spreadsheets.values.get = async () => ({ data: { values: [legacyHeaders, ["REP-000004", "Outlet A", "Migrated", "Reporter", "", "reporter", "Client X", "Markets", "Keep this note", "Active"]] } });
workspace.sheets.spreadsheets.values.update = async (arg: any) => { calls.layout = arg.requestBody.values; return {}; };
await workspace.syncMasterReporterList([{ ...reporter("REP-000004", "Migrated"), clientsCovered: "Client X", beats: "Markets", notes: "Keep this note", mostRecentArticle: "2026-02-10" }]);
const migratedRows = calls.layout as unknown as string[][];
assert.deepEqual(migratedRows[0], headers);
assert.equal(migratedRows[1]?.[8], "Keep this note");
assert.equal(migratedRows[1]?.[9], "");
assert.equal(migratedRows[1]?.[10], "Active");

// Full local sync should read global master data once and pass the same snapshots to every client.
const snapshotWorkspace = new GoogleWorkspace("root") as any;
snapshotWorkspace.drive = {};
snapshotWorkspace.sheets = {};
snapshotWorkspace.inspectRoot = async () => ({ name: "root", clientsFolder: "clients", reporterSheet: "reporters", outletSheet: "outlets" });
let reporterLoads = 0;
let outletLoads = 0;
const passedSnapshots: unknown[] = [];
snapshotWorkspace.loadReporters = async () => { reporterLoads += 1; return [existingReporter]; };
snapshotWorkspace.loadOutlets = async () => { outletLoads += 1; return [{ name: "Outlet A", uvm: null, link: "" }]; };
snapshotWorkspace.syncClientCoverage = async (_clientName: string, _records: CoverageRecord[], _folderId: string, _contacts: unknown, masterSnapshot: unknown) => {
  passedSnapshots.push(masterSnapshot);
  return { clientName: _clientName, clientFolder: { id: "folder", name: _clientName }, coverageSheet: { id: "sheet", name: "coverage" }, addedCoverageRows: 0, skippedCoverageRows: 0, reportSheets: [], createdReportSheets: [], migratedFromOneTab: false, alreadyCompliant: true, coveragePreserved: true, coverageSkipDiagnostic: null };
};
const snapshotResult = await snapshotWorkspace.syncLocalRecords([
  coverage(existingReporter.id, "2026-01-01", "Client One"),
  coverage(existingReporter.id, "2026-01-02", "Client Two")
]);
assert.equal(snapshotResult.clients.length, 2);
assert.equal(reporterLoads, 1);
assert.equal(outletLoads, 1);
assert.equal(passedSnapshots.length, 2);
assert.equal(passedSnapshots[0], passedSnapshots[1], "all clients must receive the same in-memory snapshot");

console.log("Reporter recency tests passed");
