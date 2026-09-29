import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run") || !apply;
if (apply && process.argv.includes("--dry-run")) {
  throw new Error("Choose either --dry-run or --apply, not both");
}

const baseUrl = (process.env.MEDIA_LIST_BUILDER_URL ?? "http://localhost:3001").replace(/\/$/, "");
async function runMigration(request: { dryRun: boolean; expectedSnapshotFingerprint?: string }) {
  const response = await fetch(`${baseUrl}/api/migrations/canonical-beats`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? `Migration endpoint returned HTTP ${response.status}`));
  return body;
}

function printSummary(summary: Record<string, any>) {
  console.log(JSON.stringify({
    spreadsheetId: summary.spreadsheetId,
    spreadsheetTitle: summary.spreadsheetTitle,
    tabTitle: summary.tabTitle,
    tabSheetId: summary.tabSheetId,
    headerRow: summary.headerRow,
    beatsColumn: summary.beatsColumn,
    originalBeatsColumn: summary.originalBeatsColumn,
    originalBeatsHeaderAdded: summary.originalBeatsHeaderAdded,
    totalMasterDirectoryRowsInspected: summary.totalMasterDirectoryRowsInspected,
    rowsWithBeats: summary.rowsWithBeats,
    rowsWhoseCanonicalBeatsWouldChange: summary.rowsWhoseCanonicalBeatsWouldChange,
    rowsWithMultipleCanonicalCategories: summary.rowsWithMultipleCanonicalCategories,
    rowsWithNoCanonicalMapping: summary.rowsWithNoCanonicalMapping,
    unmappedRawBeats: summary.unmappedRawBeats,
    googleRowsThatWouldBeWritten: summary.googleRowsThatWouldBeWritten
  }, null, 2));
}

try {
  const preview = await runMigration({ dryRun: true });
  printSummary(preview);
  if (dryRun) {
    console.log("Dry run only. To preserve raw values and write canonical Beats, run with --apply.");
  } else {
    const input = createInterface({ input: stdin, output: stdout });
    const answer = await input.question("Type APPLY to write only the Beats and Original Beats cells: ");
    input.close();
    if (answer.trim() !== "APPLY") {
      console.log("Migration cancelled; Google Sheets was not changed.");
      process.exitCode = 1;
    } else {
      const applied = await runMigration({ dryRun: false, expectedSnapshotFingerprint: String(preview.snapshotFingerprint) });
      printSummary(applied);
      console.log(`Migration complete. ${applied.googleRowsWritten} Master Directory rows written.`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Canonical-beat migration failed");
  process.exitCode = 1;
}
