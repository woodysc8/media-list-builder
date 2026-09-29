import assert from "node:assert/strict";
import { loadReporterDirectorySnapshot } from "./reporter-directory-source.js";

const local = [{ id: "local-1", firstName: "Local", lastName: "Reporter" }];
const google = [
  { id: "google-1", firstName: "Google", lastName: "Reporter" },
  { id: "google-1", firstName: "Duplicate", lastName: "ID" },
  { id: "google-2", firstName: "Second", lastName: "Reporter" },
  { id: "", firstName: "Invalid", lastName: "Identity" }
];

let googleReads = 0;
const localSnapshot = await loadReporterDirectorySnapshot(false, local, async () => {
  googleReads++;
  return google;
}, "2026-09-29T12:00:00.000Z");
assert.deepEqual(localSnapshot.reporters, local, "disconnected fallback uses local reporters only");
assert.equal(localSnapshot.reporterSource.kind, "local");
assert.equal(localSnapshot.reporterSource.label, "Local fallback");
assert.equal(localSnapshot.reporterSource.authoritative, false);
assert.equal(localSnapshot.reporterSource.rawReporterRowCount, 1);
assert.equal(googleReads, 0, "disconnected mode does not load Google or union the sources");

const googleSnapshot = await loadReporterDirectorySnapshot(true, local, async () => {
  googleReads++;
  return google;
}, "2026-09-29T12:01:00.000Z");
assert.deepEqual(googleSnapshot.reporters, google, "connected mode uses the Google snapshot only");
assert.equal(googleSnapshot.reporterSource.kind, "google");
assert.equal(googleSnapshot.reporterSource.label, "Master Directory (Cleaned)");
assert.equal(googleSnapshot.reporterSource.authoritative, true);
assert.equal(googleSnapshot.reporterSource.rawReporterRowCount, 4);
assert.equal(googleSnapshot.reporterSource.validReporterCount, 3);
assert.equal(googleSnapshot.reporterSource.uniqueValidReporterCount, 2);
assert.equal(googleSnapshot.reporterSource.fetchedAt, "2026-09-29T12:01:00.000Z");

await assert.rejects(
  loadReporterDirectorySnapshot(true, local, async () => { throw new Error("Google sheet unavailable"); }),
  /Google sheet unavailable/,
  "a failed connected Google read propagates instead of falling back locally"
);
assert.equal(googleReads, 1);

console.log("reporter directory source tests passed");
