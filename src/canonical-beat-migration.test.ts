import assert from "node:assert/strict";
import { GoogleWorkspace, REPORTER_HEADERS } from "./google.js";

process.env.GOOGLE_CLIENT_ID ??= "test-client";
process.env.GOOGLE_CLIENT_SECRET ??= "test-secret";

const header = [...REPORTER_HEADERS, "Duplicate Status"];
const rows = [
  header,
  ["REP-1", "Outlet A", "Ari", "Reporter", "", "reporter", "", "Payments", "Keep note", "", "Active"],
  ["REP-2", "Outlet B", "Bea", "Reporter", "", "podcast", "", "Corporate Investigations", "Keep note", "", "Active"],
  ["REP-3", "Outlet C", "Cal", "Reporter", "", "reporter", "", "Chicago, Illinois", "Keep note", "", "Active"],
  ["REP-4", "Outlet D", "Dee", "Reporter", "", "reporter", "", "Wealth Management", "Keep note", "", "Active"]
];
const batchWrites: Array<{ data: Array<{ range: string; values: string[][] }> }> = [];
const workspace = new GoogleWorkspace("root") as any;
workspace.drive = {};
workspace.sheets = { spreadsheets: {
  values: {
    get: async () => ({ data: { values: rows } }),
    batchUpdate: async (request: any) => { batchWrites.push(request.requestBody); return {}; }
  },
  get: async () => ({ data: { properties: { title: "Reporter Directory" }, sheets: [{ properties: { title: "Master Directory (Cleaned)", sheetId: 42 } }] } })
} };
workspace.inspectRoot = async () => ({ name: "root", reporterSheet: "verified-spreadsheet-id" });

const preview = await workspace.migrateCanonicalBeats({ dryRun: true });
assert.equal(preview.spreadsheetId, "verified-spreadsheet-id");
assert.equal(preview.tabTitle, "Master Directory (Cleaned)");
assert.equal(preview.headerRow, 1);
assert.equal(preview.beatsColumn, "H");
assert.equal(preview.originalBeatsColumn, "M");
assert.equal(preview.totalMasterDirectoryRowsInspected, 4);
assert.equal(preview.rowsWithBeats, 4);
assert.equal(preview.rowsWhoseCanonicalBeatsWouldChange, 3);
assert.equal(preview.rowsWithMultipleCanonicalCategories, 2);
assert.equal(preview.rowsWithNoCanonicalMapping, 1);
assert.deepEqual(preview.unmappedRawBeats, [{ value: "Chicago, Illinois", count: 1 }]);
assert.equal(preview.googleRowsThatWouldBeWritten, 3);
assert.equal(batchWrites.length, 0, "Dry run never writes to Google Sheets");

const result = await workspace.migrateCanonicalBeats({ dryRun: false, expectedSnapshotFingerprint: preview.snapshotFingerprint });
assert.equal(result.googleRowsWritten, 3);
assert.equal(batchWrites.length, 2, "Raw backups are written before canonical beat cells");
assert.deepEqual(batchWrites[0]?.data.map((entry) => [entry.range, entry.values]), [
  ["'Master Directory (Cleaned)'!M1", [["Original Beats"]]],
  ["'Master Directory (Cleaned)'!M2", [["Payments"]]],
  ["'Master Directory (Cleaned)'!M3", [["Corporate Investigations"]]],
  ["'Master Directory (Cleaned)'!M5", [["Wealth Management"]]]
]);
assert.deepEqual(batchWrites[1]?.data.map((entry) => [entry.range, entry.values]), [
  ["'Master Directory (Cleaned)'!H2", [["Banking, Fintech"]]],
  ["'Master Directory (Cleaned)'!H3", [["Corporate & Business, Compliance"]]],
  ["'Master Directory (Cleaned)'!H5", [["RIA"]]]
]);
assert.equal(batchWrites.flatMap((request) => request.data).every(({ range }) => /![HM]\d+$/.test(range)), true, "Migration writes only the Beats and Original Beats columns");
console.log("canonical beat migration tests passed");
