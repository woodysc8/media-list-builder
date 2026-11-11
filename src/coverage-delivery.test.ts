import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CoverageWorkflow,
  emptyCoverage,
  atomicJson,
  coverageSignature,
} from "./coverage-workflow.js";
import type { CoverageRecord } from "./domain.js";
const directory = await mkdtemp(path.join(os.tmpdir(), "coverage-delivery-"));
const state = emptyCoverage();
function record(client: string, n: number): CoverageRecord {
  return {
    id: `${client}-${n}`,
    clientId: client.toLowerCase(),
    clientName: client,
    articleUrl: `https://example.com/${client}/${n}`,
    articleTitle: `Original article ${n}`,
    publicationDate: n % 2 ? "2026-02-01" : "2026-03-01",
    reporterName: "Reporter",
    outlet: "Publication",
    spokesperson: "",
    originalPressType: "Earned Coverage",
    coverageType: "Earned Coverage",
    sentiment: "",
    status: "Completed",
    reach: 100,
    outletType: "Trade Publication",
    rawFields: {},
    topics: [],
    source: "PRCC",
    urlSource: "prcc",
    urlConfidence: "verified",
    urlResolvedAt: "2026-03-01",
    createdAt: "2026-03-01",
    updatedAt: "2026-03-01",
  };
}
state.records = [
  ...Array.from({ length: 107 }, (_, i) => record("Conquest", i)),
  ...Array.from({ length: 279 }, (_, i) => record("Orion", i)),
];
state.jobs = [
  {
    id: "conquest",
    file: "Conquest PRCC.csv",
    client: "Conquest",
    year: "2026",
    state: "completed",
    records: [],
    errors: [],
    sourceRows: 0,
    imported: 107,
    duplicates: 0,
    sync: "local-only",
    attempts: 0,
  },
  {
    id: "conquest-duplicate",
    sourceRows: 0,
    file: "Conquest PRCC.csv",
    client: "Conquest",
    year: "2026",
    state: "completed",
    records: [],
    errors: [],
    imported: 0,
    duplicates: 107,
    sync: "local-only",
    attempts: 0,
  },
  {
    id: "orion",
    file: "Orion PRCC.csv",
    client: "Orion",
    year: "2026",
    state: "completed",
    records: [],
    errors: [],
    sourceRows: 0,
    imported: 279,
    duplicates: 0,
    sync: "verified",
    attempts: 0,
  },
];
state.destinations.orion = "existing-orion";
state.syncedSignatures = {
  orion: coverageSignature(
    state.records
      .filter((r) => r.clientName === "Orion")
      .sort((a, b) => b.publicationDate.localeCompare(a.publicationDate)),
  ),
};
const originalRecords = structuredClone(state.records),
  originalJobs = structuredClone(state.jobs);
await atomicJson(path.join(directory, "coverage-v2.json"), state);
const calls: string[] = [];
const sync = async (
  client: string,
  records: CoverageRecord[],
  destination: string | undefined,
  persist: (id: string) => Promise<void>,
) => {
  calls.push(client);
  assert.ok(
    records.every(
      (record, i) =>
        !i || records[i - 1].publicationDate >= record.publicationDate,
    ),
    "Backfill is newest-first without mutating the local library",
  );
  if (client === "Orion")
    assert.equal(
      destination,
      "existing-orion",
      "Orion must reuse its stored ID",
    );
  const id = destination || "new-conquest";
  await persist(id);
  return {
    spreadsheetId: id,
    spreadsheetName: `${client} - Clean Coverage`,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
    parents: [
      {
        id: "configured-folder",
        name: "Media List Builder",
        url: "https://drive.google.com/drive/folders/configured-folder",
      },
    ],
    verifiedRecords: records.length,
    verifiedAt: "2026-11-10T23:00:00Z",
    writtenBatches: client === "Orion" ? 0 : 1,
  };
};
let queue = new CoverageWorkflow(directory, () => [], sync);
await queue.load();
assert.equal(queue.summary().pendingClientDeliveries, 2);
await queue.tick();
await queue.tick();
assert.deepEqual(calls, ["Conquest", "Orion"]);
assert.deepEqual(
  queue.state.records,
  originalRecords,
  "All 386 local records are unchanged",
);
assert.deepEqual(
  queue.state.jobs,
  originalJobs,
  "All three upload jobs and their import counters are unchanged",
);
assert.equal(queue.state.destinations.orion, "existing-orion");
assert.equal(
  queue.state.deliveries?.conquest.destination?.verifiedRecords,
  107,
);
assert.equal(queue.state.deliveries?.orion.destination?.verifiedRecords, 279);
assert.equal(
  queue.state.deliveries?.orion.destination?.writtenBatches,
  0,
  "Existing Orion data is verified without requiring another write",
);
assert.equal(
  queue.state.deliveries?.orion.destination?.spreadsheetUrl,
  "https://docs.google.com/spreadsheets/d/existing-orion/edit",
);
assert.equal(
  queue.state.deliveries?.conquest.destination?.parents[0].name,
  "Media List Builder",
);
assert.equal(queue.summary().verifiedCoverageRecords, 386);
assert.equal(queue.summary().status, "Completed");
queue = new CoverageWorkflow(directory, () => [], sync);
await queue.load();
await queue.tick();
assert.equal(calls.length, 2, "Restart does not repeat a completed delivery");
const orphanDirectory = path.join(directory, "library-without-jobs");
await atomicJson(path.join(orphanDirectory, "coverage-v2.json"), {
  ...emptyCoverage(),
  records: originalRecords.filter((r) => r.clientName === "Conquest"),
});
const orphan = new CoverageWorkflow(orphanDirectory, () => [], sync);
await orphan.load();
assert.equal(orphan.summary().status, "Running");
await orphan.tick();
assert.equal(orphan.summary().status, "Completed");
assert.equal(
  orphan.state.jobs.length,
  0,
  "Backfill works without creating synthetic upload jobs",
);
console.log(
  "386-record backfill, Conquest delivery, Orion ID reuse, exact destination metadata, upload-job preservation and restart idempotency passed.",
);
