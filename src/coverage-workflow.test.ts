import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoverageWorkflow, atomicJson } from "./coverage-workflow.js";
import { freshStart } from "./coverage-fresh-start.js";
import { StructuredStore } from "./store.js";
import writeXlsx from "write-excel-file/node";

const root = await mkdtemp(path.join(os.tmpdir(), "coverage-fixture-"));
const directory = path.join(root, "data");
await mkdir(directory);
const original = {
  coverage: [{ articleUrl: "https://old.example/history" }],
  reporters: [],
  clients: [{ id: "a", name: "Acme", aliases: ["AC"] }],
  settings: { theme: "dark" },
};
await atomicJson(path.join(directory, "store.json"), original);
await atomicJson(path.join(directory, "google-auth.json"), {
  refresh_token: "fixture-not-a-secret",
});
await atomicJson(path.join(directory, "app-config.json"), {
  rootFolderId: "fixture",
  coverageSync: { pending: [1] },
});
await atomicJson(path.join(directory, "coverage-url-cache.json"), { old: 1 });
await mkdir(path.join(directory, "coverage-uploads"));
await writeFile(path.join(directory, "coverage-uploads", "old"), "old");
await assert.rejects(
  freshStart(path.join(directory, "store.json"), false),
  /--confirm/,
);
assert.deepEqual(
  JSON.parse(await readFile(path.join(directory, "store.json"), "utf8")),
  original,
);
const reset = await freshStart(path.join(directory, "store.json"), true);
assert.deepEqual(
  JSON.parse(
    await readFile(path.join(reset.backup, "data", "store.json"), "utf8"),
  ),
  original,
);
assert.deepEqual(
  JSON.parse(await readFile(path.join(directory, "store.json"), "utf8")),
  { ...original, coverage: [] },
);
assert.equal(
  JSON.parse(await readFile(path.join(directory, "google-auth.json"), "utf8"))
    .refresh_token,
  "fixture-not-a-secret",
);
assert.deepEqual(
  JSON.parse(await readFile(path.join(directory, "app-config.json"), "utf8")),
  { rootFolderId: "fixture" },
);
await assert.rejects(
  readFile(path.join(directory, "coverage-uploads", "old")),
  { code: "ENOENT" },
);
await assert.rejects(
  readFile(path.join(directory, "coverage-url-cache.json")),
  { code: "ENOENT" },
);
const clients = () => original.clients;
let syncCalls = 0;
const sync = async (
  _client: string,
  _records: unknown[],
  destination: string | undefined,
  save: (id: string) => Promise<void>,
) => {
  syncCalls++;
  if (!destination) await save("destination");
};
let queue = new CoverageWorkflow(directory, clients, sync);
await queue.load();
assert.deepEqual(queue.verification(), {
  coverageRecords: 0,
  uploadJobs: 0,
  pendingCoverageSynchronizationJobs: 0,
  coverageResearchCacheEntries: 0,
  legacyCoverageMigrationsActive: false,
});
// A legacy source appearing after reset is never consulted, including after reconnection.
await atomicJson(path.join(directory, "store.backup.json"), original);
queue = new CoverageWorkflow(directory, clients, sync);
await queue.load();
assert.equal(queue.state.records.length, 0);
await atomicJson(path.join(root, "invalid", "coverage-v2.json"), {
  version: 1,
  records: original.coverage,
});
await assert.rejects(
  new CoverageWorkflow(path.join(root, "invalid"), clients, sync).load(),
  /refusing historical recovery/,
);
const csv = Buffer.from(
  "Press Type,Date,Publication,UVM,Reporter,Spokesperson,Status,Raw URL\r\nEarned Coverage,2026-01-01,Example,12345,A Writer,CEO,Original headline,https://example.com/a?x=1&y=2\r\nEarned Coverage,2026-03-01,Example,555,A Writer,CEO,Second headline,https://example.com/b\r\nEarned Coverage,2026-02-01,Example,999,A Writer,CEO,Rejected,ftp://example.com/c",
);
const j = await queue.enqueue(csv, "AC PRCC 2026.csv");
assert.equal(j.client, "Acme");
assert.equal(j.records[0].articleTitle, "Original headline");
assert.equal(j.records[0].reach, "12345");
assert.equal(j.records[0].articleUrl, "https://example.com/a?x=1&y=2");
assert.equal(j.errors[0].row, 4);
await queue.enqueue(csv, "Acme PRCC duplicate.csv");
await queue.control("start");
await queue.tick();
queue = new CoverageWorkflow(directory, clients, sync);
await queue.load();
await queue.tick();
assert.equal(queue.state.records.length, 2);
assert.equal(queue.state.records[0].articleTitle, "Second headline");
assert.equal(queue.state.jobs[0].imported, 2);
assert.equal(queue.state.jobs[1].duplicates, 2);
assert.equal(queue.state.jobs[1].imported, 0);
assert.equal(queue.state.jobs[0].state, "completed");
assert.equal(queue.state.destinations.acme, "destination");
await queue.tick();
assert.equal(
  syncCalls,
  1,
  "Identical files reuse the verified client dataset without another Google write",
);
const workbook = await writeXlsx([
  {
    sheet: "2025 Coverage",
    data: [
      [
        "Press Type",
        "Date",
        "Publication",
        "UVM",
        "Reporter",
        "Spokesperson",
        "Status",
        "Raw URL",
      ],
      [
        "Earned Coverage",
        "2025-01-01",
        "Example",
        123,
        "Writer",
        "CEO",
        "XLSX headline",
        "https://example.com/xlsx",
      ],
    ],
  },
]).toBuffer();
const xlsxJob = await queue.enqueue(workbook, "Acme PRCC.xlsx");
assert.equal(xlsxJob.records[0].articleTitle, "XLSX headline");
assert.equal(xlsxJob.records[0].rawFields.sourceTab, "2025 Coverage");
await queue.control("cancel");
const fail = new CoverageWorkflow(directory, clients, async () => {
  throw Error("temporary");
});
await fail.load();
fail.state.syncedSignatures = {};
fail.state.deliveries!.acme.state = "pending";
await fail.enqueue(csv, "Acme PRCC retry.csv");
await fail.tick();
assert.equal(fail.state.jobs.at(-1)?.state, "pending");
assert.equal(fail.state.records.length, 2);
fail.state.jobs.at(-1)!.nextAttemptAt = 0;
await fail.save();
queue = new CoverageWorkflow(directory, clients, sync);
await queue.load();
await queue.tick();
assert.equal(queue.state.jobs.at(-1)?.sync, "verified");
assert.equal(queue.state.records.length, 2);
await queue.enqueue(csv, "Conquest PRCC.csv", "Conquest");
await queue.tick();
assert.equal(queue.state.jobs.at(-1)?.sync, "verified");
await queue.enqueue(csv, "Acme PRCC pending.csv");
await queue.control("cancel");
assert.equal(queue.state.jobs.at(-1)?.state, "cancelled");
const isolated = new StructuredStore(path.join(directory, "store.json"), true);
await isolated.load({ readOnly: true });
assert.equal(isolated.snapshot.coverage.length, 0);
assert.equal(isolated.snapshot.clients.length, 1);
console.log(
  "Coverage reset, mapping, validation, duplicates, restart, retries, destination reuse, verification and isolation tests passed. Fixture:",
  root,
);
