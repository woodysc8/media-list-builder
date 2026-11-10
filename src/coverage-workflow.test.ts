import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoverageWorkflow, atomicJson } from "./coverage-workflow.js";
import { freshStart } from "./coverage-fresh-start.js";
import { StructuredStore } from "./store.js";
import { GoogleWorkspace } from "./google.js";
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
// Remote writer is exercised against a fake transport, never live Google.
process.env.GOOGLE_CLIENT_ID = "fixture";
process.env.GOOGLE_CLIENT_SECRET = "fixture";
const google = new GoogleWorkspace("fixture", { access_token: "fixture" });
const transport = google as any;
const fakeFileGet = async (r: any) => ({
  data:
    r.fileId === "fixture"
      ? {
          id: "fixture",
          name: "Configured Folder",
          mimeType: "application/vnd.google-apps.folder",
          capabilities: { canAddChildren: true },
        }
      : {
          id: r.fileId,
          name: "Acme - Clean Coverage",
          mimeType: "application/vnd.google-apps.spreadsheet",
          parents: ["fixture"],
          capabilities: { canEdit: true },
        },
});
let written: unknown;
let creates = 0;
let saved = "";
transport.drive = {
  files: {
    list: async () => ({ data: { files: [] } }),
    get: fakeFileGet,
    create: async () => {
      creates++;
      return { data: { id: "new" } };
    },
  },
};
let resizeCalls = 0;
const batchSizes: number[] = [];
const ranges = new Map<string, any[][]>();
transport.sheets = {
  spreadsheets: {
    get: async () => ({
      data: {
        sheets: [
          {
            properties: {
              sheetId: 0,
              title: "Coverage",
              gridProperties: { rowCount: 1, columnCount: 11 },
            },
          },
        ],
      },
    }),
    batchUpdate: async () => {
      resizeCalls++;
      return {
        data: {
          replies: [
            {
              addSheet: {
                properties: {
                  sheetId: 5,
                  title: "Coverage",
                  gridProperties: { rowCount: 1000, columnCount: 11 },
                },
              },
            },
          ],
        },
      };
    },
    values: {
      update: async (r: any) => {
        written = r.requestBody.values;
        ranges.set(`${r.spreadsheetId}:${r.range}`, r.requestBody.values);
        batchSizes.push(r.requestBody.values.length);
      },
      get: async (r: any) => {
        let values = ranges.get(`${r.spreadsheetId}:${r.range}`);
        if (!values && r.range.endsWith("!A1:K1"))
          values = [...ranges.entries()]
            .find(
              ([k]) =>
                k.startsWith(`${r.spreadsheetId}:`) && k.includes("!A1:"),
            )?.[1]
            ?.slice(0, 1);
        return { data: { values: values ?? [] } };
      },
    },
  },
};
await google.syncCleanCoverage(
  "Acme",
  queue.state.records,
  "existing",
  async (id) => {
    saved = id;
  },
  "fixture",
);
assert.equal(creates, 0);
assert.equal(
  resizeCalls,
  1,
  "Destinations expand before writing beyond the grid",
);
await google.syncCleanCoverage(
  "Acme",
  queue.state.records,
  undefined,
  async (id) => {
    saved = id;
  },
  "fixture",
);
assert.equal(creates, 1);
assert.equal(saved, "new");
batchSizes.length = 0;
await google.syncCleanCoverage(
  "Acme",
  Array.from({ length: 1001 }, () => queue.state.records[0]),
  "existing",
  async () => {},
  "fixture",
);
assert.deepEqual(
  batchSizes,
  [500, 500, 2],
  "Large client sheets are expanded and written in bounded batches",
);
batchSizes.length = 0;
await google.syncCleanCoverage(
  "Acme",
  Array.from({ length: 1001 }, () => queue.state.records[0]),
  "existing",
  async () => {},
  "fixture",
);
assert.equal(
  batchSizes.length,
  0,
  "Retrying a fully written sheet verifies existing batches without rewriting",
);
transport.drive.files.list = async () => ({ data: { files: [{ id: "new" }] } });
await google.syncCleanCoverage(
  "Acme",
  queue.state.records,
  undefined,
  async (id) => {
    saved = id;
  },
  "fixture",
);
assert.equal(
  creates,
  1,
  "Destination discovery reuses the client spreadsheet after a lost create response",
);
transport.drive.files.get = async (r: any) => {
  if (r.fileId === "deleted") throw { code: 404 };
  return fakeFileGet(r);
};
await google.syncCleanCoverage(
  "Acme",
  queue.state.records,
  "deleted",
  async (id) => {
    saved = id;
  },
  "fixture",
);
assert.equal(
  saved,
  "new",
  "A deleted approved destination resolves to the existing dedicated sheet",
);
assert.equal(creates, 1);
transport.drive.files.get = fakeFileGet;
transport.sheets.spreadsheets.get = async () => ({
  data: {
    sheets: [
      {
        properties: {
          sheetId: 9,
          title: "Unrelated dashboard",
          gridProperties: { rowCount: 1000, columnCount: 11 },
        },
      },
    ],
  },
});
await google.syncCleanCoverage(
  "Acme",
  queue.state.records,
  "approved-multi-tab",
  async () => {},
  "fixture",
);
assert.ok(
  [...ranges.keys()]
    .filter((k) => k.startsWith("approved-multi-tab:"))
    .every((k) => k.includes("'Coverage'!")),
  "Approved spreadsheets use a coverage tab without touching unrelated tabs",
);
transport.sheets.spreadsheets.get = async () => ({
  data: {
    sheets: [
      {
        properties: {
          sheetId: 5,
          title: "Coverage",
          gridProperties: { rowCount: 1000, columnCount: 11 },
        },
      },
    ],
  },
});
transport.drive.files.get = async (r: any) =>
  r.fileId === "fixture"
    ? fakeFileGet(r)
    : {
        data: {
          name: "Master Reporter List",
          mimeType: "application/vnd.google-apps.spreadsheet",
        },
      };
await assert.rejects(
  google.syncCleanCoverage(
    "Acme",
    queue.state.records,
    "master",
    async () => {},
    "fixture",
  ),
  /cannot be coverage destinations/,
);
transport.drive.files.get = fakeFileGet;
transport.sheets.spreadsheets.values.get = async () => ({
  data: { values: [] },
});
await assert.rejects(
  google.syncCleanCoverage(
    "Acme",
    queue.state.records,
    "existing",
    async () => {},
    "fixture",
  ),
  /verification failed/,
);
transport.drive.files.get = async () => {
  throw { code: 403, message: "Folder access denied" };
};
const createsBeforeInvalidFolder = creates;
await assert.rejects(
  google.syncCleanCoverage(
    "Acme",
    queue.state.records,
    undefined,
    async () => {},
    "fixture",
  ),
  /Configured Google Drive folder is invalid or inaccessible/,
);
assert.equal(
  creates,
  createsBeforeInvalidFolder,
  "An inaccessible folder must never fall back to creating a sheet elsewhere",
);
const isolated = new StructuredStore(path.join(directory, "store.json"), true);
await isolated.load({ readOnly: true });
assert.equal(isolated.snapshot.coverage.length, 0);
assert.equal(isolated.snapshot.clients.length, 1);
console.log(
  "Coverage reset, mapping, validation, duplicates, restart, retries, destination reuse, verification and isolation tests passed. Fixture:",
  root,
);
