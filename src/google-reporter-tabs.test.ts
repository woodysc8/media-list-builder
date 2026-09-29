import assert from "node:assert/strict";
import { GoogleWorkspace, REPORTER_HEADERS } from "./google.js";
import type { ReporterRecord } from "./domain.js";

process.env.GOOGLE_CLIENT_ID = "test";
process.env.GOOGLE_CLIENT_SECRET = "test";

const reporter = (id: string, firstName: string): ReporterRecord => ({
  id, firstName, lastName: "Reporter", outlet: "Outlet A", email: "local@example.test",
  clientsCovered: "Local Client", beats: "Local Beat", notes: "Local note", mostRecentArticle: "2026-08-10",
  reporterType: "reporter", status: "Active"
});
const cleanRow = (record: ReporterRecord): string[] => [
  record.id, record.outlet, record.firstName, record.lastName, record.email, record.reporterType,
  record.clientsCovered, record.beats, record.notes, record.mostRecentArticle, record.status
];

const geminiEdited = ["REP-CANON", "Outlet A", "Human Name", "Reporter", "gemini@example.test", "Journalist", "Old Client", "Gemini Beat", "Gemini Note", "1999-01-01", "Needs Review"];
const expired = ["REP-EXPIRED", "Old Outlet", "Expired", "Reporter", "", "reporter", "", "", "", "2020-01-01", "Active"];
const unmanaged = ["REP-UNMANAGED", "Another Outlet", "Keep", "Row", "", "reporter", "", "", "", "2020-01-01", "Active"];
const identityPromoted = ["", "Old Outlet", "Former", "Name", "curated@example.test", "reporter", "", "Curated Beat", "Curated Note", "", "Active"];
const rawHeaders = REPORTER_HEADERS.slice(0, 9).concat("Status");
const rawRows = [rawHeaders, ["REP-RAW-OLD", "Old Outlet", "Raw", "Reporter", "", "reporter", "", "", "", "Active"]];
const calls: { ranges: string[]; appends: Array<{ range: string; values: string[][] }>; updates: Array<{ range: string; values: string[][] }>; requests: any[]; layoutUpdates: string[] } = {
  ranges: [], appends: [], updates: [], requests: [], layoutUpdates: []
};

const workspace = new GoogleWorkspace("root") as any;
workspace.drive = {};
workspace.sheets = { spreadsheets: {
  values: {
    get: async (arg: any) => {
      calls.ranges.push(arg.range);
      return { data: { values: arg.range.startsWith("'Sheet1'") ? rawRows : [REPORTER_HEADERS, geminiEdited, expired, unmanaged, identityPromoted] } };
    },
    append: async (arg: any) => { calls.appends.push({ range: arg.range, values: arg.requestBody.values }); return {}; },
    update: async (arg: any) => { calls.layoutUpdates.push(arg.range); return {}; },
    batchUpdate: async (arg: any) => { calls.updates.push(...arg.requestBody.data); return {}; }
  },
  get: async () => ({ data: { sheets: [
    { properties: { title: "Sheet1", sheetId: 101, index: 0 } },
    { properties: { title: "Master Directory (Cleaned)", sheetId: 202, index: 1 } }
  ] } }),
  batchUpdate: async (arg: any) => { calls.requests.push(...arg.requestBody.requests); return {}; }
} };
workspace.inspectRoot = async () => ({ name: "root", clientsFolder: undefined, reporterSheet: "reporter-spreadsheet", outletSheet: undefined });

const loadedReporters = await workspace.loadReporters("reporter-spreadsheet");
assert.equal(calls.ranges[0], "'Master Directory (Cleaned)'!A:Z", "reporter reference loads use the curated tab explicitly");
assert.equal(loadedReporters.find((item: ReporterRecord) => item.id === "REP-CANON")?.reporterType, "Journalist", "Master Directory Reporter Type source value is preserved for review");

const canonicalReporter = reporter("REP-CANON", "Local Name");
const aliasReporter = {
  ...reporter("REP-ALIAS", "Current"),
  identityAliases: [{ firstName: "Former", lastName: "Name", outlet: "Old Outlet" }]
};
const result = await workspace.syncMasterReporterList(
  [canonicalReporter, aliasReporter, reporter("REP-NEW", "Unlisted")],
  { archivedReporters: [reporter("REP-EXPIRED", "Expired")] }
);

assert.equal(calls.ranges[1], "'Master Directory (Cleaned)'!A:Z", "canonical reconciliation reads the curated tab explicitly");
assert.equal(result.addedReporterRows, 0, "unlisted discoveries are not automatically promoted into the cleaned directory");
assert.equal(result.updatedReporterRows, 2, "matched canonical rows receive app-owned updates");
assert.equal(result.mergedReporters.find((item: ReporterRecord) => item.id === "REP-CANON")?.email, "gemini@example.test");
assert.equal(result.mergedReporters.find((item: ReporterRecord) => item.id === "REP-CANON")?.status, "Needs Review");
assert.deepEqual(calls.updates.map((update) => update.range), [
  "'Master Directory (Cleaned)'!G2", "'Master Directory (Cleaned)'!J2",
  "'Master Directory (Cleaned)'!A5", "'Master Directory (Cleaned)'!G5", "'Master Directory (Cleaned)'!J5"
]);
assert.equal(calls.updates[0]?.values[0]?.[0], "Local Client", "Clients Covered is recalculated local data");
assert.equal(calls.updates[1]?.values[0]?.[0], "2026-08-10", "Most Recent Article is recalculated local data");
assert.equal(calls.updates[2]?.values[0]?.[0], "REP-ALIAS", "identity-matched promoted rows receive the existing reporter ID");
assert.equal(calls.updates[3]?.values[0]?.[0], "Local Client");
assert.equal(calls.updates[4]?.values[0]?.[0], "2026-08-10");
assert.equal(calls.updates.some((update) => /!([B-FH-I]|K)\d/.test(update.range)), false, "Sync Local writes only app-owned directory cells");
assert.equal(calls.requests.length, 1);
assert.deepEqual(calls.requests[0]?.deleteDimension.range, { sheetId: 202, dimension: "ROWS", startIndex: 2, endIndex: 3 }, "expiration deletion targets cleaned tab ID, not Sheet1 or tab index 0");
assert.equal(calls.layoutUpdates.length, 0, "canonical tab with current schema is not migrated or reordered");

const beforeRawAppendCount = calls.appends.length;
const beforeRawUpdateCount = calls.updates.length;
await workspace.syncRawReporterStaging([reporter("REP-RAW-NEW", "New Raw")]);
assert.equal(calls.ranges[2], "'Sheet1'!A:Z", "staging reads only the explicitly named raw tab");
assert.equal(calls.appends[beforeRawAppendCount]?.range, "'Sheet1'!A:J");
assert.equal(calls.appends[beforeRawAppendCount]?.values[0]?.[2], "New Raw");
assert.equal(calls.layoutUpdates.length, 0, "raw staging does not run canonical migration");
assert.equal(calls.requests.length, 1, "raw staging does not delete rows or touch the cleaned tab");
assert.equal(calls.updates.length, beforeRawUpdateCount, "raw staging does not write cleaned directory values");

console.log("Google reporter tab separation tests passed");
