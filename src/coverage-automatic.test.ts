import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  CoverageWorkflow,
  emptyCoverage,
  atomicJson,
  identifyClient,
} from "./coverage-workflow.js";
import type { CoverageRecord } from "./domain.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "coverage-auto-"));
const clients = [
  { id: "a", name: "Acme", aliases: ["AC"] },
  { id: "b", name: "Beta", aliases: ["Shared"] },
  { id: "c", name: "Gamma", aliases: ["Shared"] },
];
const csv = (url: string) =>
  Buffer.from(
    `Date,Publication,UVM,Reporter,Status,Raw URL\n2026-11-01,Example,107,Test Writer,Original headline,${url}\n2026-11-02,Example,999,Test Writer,Rejected row,invalid`,
  );
const initial = emptyCoverage();
initial.automatic = undefined;
initial.paused = true;
initial.records = Array.from(
  { length: 107 },
  (_, i) =>
    ({
      id: `existing-${i}`,
      clientId: "conquest",
      clientName: "Conquest",
      articleUrl: `https://example.com/preserved/${i}`,
      publicationDate: "2026-10-01",
      articleTitle: `Preserved ${i}`,
      outlet: "Example",
      reporterName: "Writer",
      spokesperson: "",
      originalPressType: "Earned Coverage",
      coverageType: "Earned Coverage",
      sentiment: "",
      status: "Completed",
      reach: 107,
      outletType: "Trade Publication",
      rawFields: {},
      topics: [],
      source: "PRCC",
      createdAt: "2026-10-01",
      updatedAt: "2026-10-01",
      urlSource: "prcc",
      urlConfidence: "verified",
      urlResolvedAt: "2026-10-01",
    }) as CoverageRecord,
);
initial.jobs = [
  {
    id: "existing-completed",
    file: "Conquest PRCC.csv",
    client: "Conquest",
    year: "2026",
    state: "completed",
    records: [],
    errors: [],
    imported: 107,
    duplicates: 0,
    sync: "local-only",
    attempts: 0,
  },
];
initial.destinations = { acme: "approved" };
const originalRecords = structuredClone(initial.records),
  originalJob = structuredClone(initial.jobs[0]);
await atomicJson(path.join(directory, "coverage-v2.json"), initial);
let calls = 0;
const sync = async (
  client: string,
  _records: CoverageRecord[],
  destination: string | undefined,
  save: (id: string) => Promise<void>,
) => {
  calls++;
  if (client === "Acme") assert.equal(destination, "approved");
  if (client === "Beta")
    throw Object.assign(new Error("temporary Google failure"), { code: 503 });
  if (!destination) await save("created");
};
let queue = new CoverageWorkflow(directory, () => clients, sync);
await queue.load();
assert.equal(
  queue.state.paused,
  false,
  "Old manual queues upgrade automatically without resetting data",
);
assert.equal(identifyClient("AC_PRCC_2026.csv", clients).client, "Acme");
assert.equal(
  identifyClient("New Company PR Campaign 2026.xlsx", clients).client,
  "New Company",
);
assert.ok(identifyClient("Shared PRCC.csv", clients).error);
assert.ok(
  identifyClient("Acme and Beta PRCC.csv", clients).error,
  "Multiple clients in a filename must never be guessed",
);
assert.ok(identifyClient("unidentified.csv", clients).error);
await queue.enqueue(csv("https://example.com/acme"), "AC PRCC.csv");
assert.equal(
  queue.state.paused,
  false,
  "Uploading enables processing without a start command",
);
await queue.tick();
assert.equal(queue.state.jobs.at(-1)?.state, "completed");
assert.equal(queue.state.jobs.at(-1)?.sync, "verified");
assert.equal(
  queue.state.jobs.at(-1)?.errors[0].row,
  3,
  "Rejected rows never hold valid coverage for review",
);
const callsAfterImport = calls;
await queue.enqueue(csv("https://example.com/acme"), "Acme PRCC identical.csv");
await queue.tick();
assert.equal(
  calls,
  callsAfterImport,
  "Already verified identical uploads cause no additional Google writes",
);
await queue.enqueue(csv("https://example.com/ambiguous"), "Shared PRCC.csv");
assert.equal(queue.state.jobs.at(-1)?.needsAttention, true);
assert.equal(queue.state.jobs.at(-1)?.records.length, 0);
await queue.enqueue(Buffer.from("not a workbook"), "Beta PRCC.xlsx");
assert.equal(
  queue.state.jobs.at(-1)?.state,
  "failed",
  "Unparseable files remain visible as failures",
);
await queue.enqueue(csv("https://example.com/retry"), "Beta PRCC.csv");
await queue.tick();
assert.equal(queue.state.jobs.at(-1)?.state, "pending");
await queue.enqueue(csv("https://example.com/gamma"), "Gamma PRCC.csv");
await queue.tick();
assert.equal(
  queue.state.jobs.at(-1)?.state,
  "completed",
  "A backoff job does not block later clients",
);
assert.equal(queue.state.destinations.gamma, "created");
const failed = queue.state.jobs.find(
  (j) => j.client === "Beta" && j.state === "pending",
)!;
failed.nextAttemptAt = 0;
await queue.save();
queue = new CoverageWorkflow(
  directory,
  () => clients,
  async () => {},
);
await queue.load();
await queue.tick();
assert.equal(
  queue.state.jobs.find((j) => j.id === failed.id)?.sync,
  "verified",
  "Interrupted automatic synchronization resumes",
);
assert.equal(queue.summary().status, "Completed");
assert.equal(queue.summary().failedFiles, 2);
assert.equal(queue.summary().importedRecords, 110);
assert.deepEqual(
  queue.state.records.filter((r) => r.clientName === "Conquest"),
  originalRecords,
  "All 107 existing Conquest records remain intact",
);
assert.deepEqual(
  queue.state.jobs[0],
  originalJob,
  "Completed jobs are never reimported or reprocessed",
);
await queue.enqueue(csv("https://example.com/new"), "Conquest PRCC new.csv");
await queue.tick();
assert.equal(queue.state.jobs.at(-1)?.sync, "local-only");
console.log(
  "Automatic imports, ambiguous clients, approved destinations, failure continuation, retry/restart, terminal status and preservation of 107 Conquest records passed.",
);
