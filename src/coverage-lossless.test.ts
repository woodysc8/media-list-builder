import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import writeXlsx from "write-excel-file/node";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { CoverageWorkflow, atomicJson } from "./coverage-workflow.js";
import { incompleteFields, parseCoverageSource } from "./coverage-source.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "coverage-lossless-"));
const clients = () => [{ id: "a", name: "Acme", aliases: [] }];
let calls = 0;
const sync = async (_client: string, records: any[]) => {
  calls++;
  assert.ok(records.some((r) => !r.articleUrl));
};
let queue = new CoverageWorkflow(directory, clients, sync);
await queue.load();
const csv = Buffer.from(
  'Date,Publication,Reporter,Title,Raw URL,Extra,Extra,\r\n2026-01-01,Outlet,Writer,Headline,https://example.com/a,"  untouched  ",second,\r\n2026-01-01,Outlet,Writer,Headline,https://example.com/a,other,duplicate,\r\nnot-a-date,,,Published,ftp://bad.example,raw invalid,,\r\n02/30/2026,,,,,overflow,,\r\n,,,,,,only an unmapped column,\r\n,,,,,,,\r\n2026-05-01,,Writer,No URL,,"line one\nline two",,extra,overflow value',
);
const job = await queue.enqueue(csv, "Acme PRCC.csv");
assert.equal(job.records.length, 6);
assert.equal(job.errors.length, 0);
const raw = queue.state.sourceOccurrences!;
assert.equal(raw.length, 6);
assert.equal(raw[0].values[5], "  untouched  ");
assert.deepEqual(raw[0].columns.slice(5), ["Extra", "Extra", ""]);
assert.equal(raw[2].values[0], "not-a-date");
assert.equal(raw[2].values[4], "ftp://bad.example");
assert.equal(job.records[2].publicationDate, "");
assert.equal(job.records[2].articleUrl, "");
assert.equal(job.records[2].articleTitle, "");
assert.equal(
  job.records[3].publicationDate,
  "",
  "Overflow dates must never roll into an invented valid day",
);
assert.equal(raw[5].rowNumber, 8);
assert.equal(raw[5].values[5], "line one\nline two");
assert.equal(raw[5].values[8], "overflow value");
assert.deepEqual(
  await readFile(path.join(directory, "coverage-uploads", job.id)),
  csv,
);
await queue.tick();
assert.equal(queue.state.records.length, 5);
assert.equal(queue.summary().duplicateSourceOccurrences, 1);
assert.equal(queue.summary().sourceRowsIngested, 6);
assert.equal(queue.summary().incompleteRecords, 5);
assert.equal(calls, 1);
await queue.enqueue(csv, "Acme PRCC.csv");
await queue.tick();
assert.equal(
  queue.state.records.length,
  5,
  "Identical original bytes + filename + worksheet + row are reliable repeat-upload identifiers even without URLs",
);
assert.equal(
  queue.state.sourceOccurrences!.length,
  12,
  "Every repeat source occurrence is retained",
);
assert.equal(calls, 1);
queue = new CoverageWorkflow(directory, clients, sync);
await queue.load();
await queue.tick();
assert.equal(queue.state.records.length, 5);
assert.equal(queue.state.sourceOccurrences!.length, 12);
assert.equal(calls, 1);
const separate = await queue.enqueue(
  Buffer.from("Title,Extra\nNo URL,different source"),
  "Acme PRCC other.csv",
);
await queue.tick();
assert.equal(
  separate.imported,
  1,
  "Rows without reliable identifiers are never merged by reporter/outlet/title",
);
const unheaded = await queue.enqueue(
  Buffer.from("mystery\nonly source value"),
  "Acme PRCC unheaded.csv",
);
assert.equal(
  unheaded.records.length,
  2,
  "Unknown columns and preambles survive without a recognized header",
);

const excel = await writeXlsx([
  {
    sheet: "2025 Raw",
    data: [
      ["Date", "Title", "Raw URL", "Custom"],
      ["bad date", "", "invalid", "  original whitespace  "],
      [null, null, null, 0],
    ],
  },
]).toBuffer();
const parsed = await parseCoverageSource(
  excel,
  "Acme PRCC.xlsx",
  "excel",
  "Acme",
  "a",
);
assert.equal(parsed.occurrences.length, 2);
assert.equal(parsed.occurrences[0].values[3], "  original whitespace  ");
assert.equal(parsed.occurrences[1].values[3], "0");
assert.equal(parsed.occurrences[0].worksheet, "2025 Raw");
assert.equal(parsed.occurrences[0].rowNumber, 2);
assert.ok(incompleteFields(parsed.records[0]).includes("URL"));
const archive = unzipSync(excel);
const worksheet = Object.keys(archive).find((name) =>
  /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
)!;
archive[worksheet] = strToU8(
  strFromU8(archive[worksheet]).replace(
    "</sheetData>",
    '<row r="5"><c r="D5" t="e"><v>#VALUE!</v></c></row><row r="7"><c r="A7"><f>1/0</f></c></row></sheetData>',
  ),
);
const errors = await parseCoverageSource(
  Buffer.from(zipSync(archive)),
  "Acme PRCC.xlsx",
  "error-cells",
  "Acme",
  "a",
);
assert.equal(
  errors.occurrences.length,
  4,
  "Error-only and formula-only rows must survive Excel parser suppression",
);
assert.equal(errors.occurrences[2].rowNumber, 5);
assert.equal(errors.occurrences[2].values[3], "#VALUE!");
assert.equal(errors.occurrences[3].rowNumber, 7);
assert.equal(errors.occurrences[3].cells![0].formula, "1/0");

// Upgrade the exact retained upload of an older importer. Existing records and jobs retain their identities and fields.
const recovery = await mkdtemp(
  path.join(os.tmpdir(), "coverage-lossless-recovery-"),
);
await mkdir(path.join(recovery, "coverage-uploads"));
await writeFile(path.join(recovery, "coverage-uploads", job.id), csv);
const original = queue.state.records.find((r) => r.articleUrl)!;
const historicalJob = {
  ...job,
  records: [],
  sourceRows: undefined,
  state: "completed",
  imported: 1,
  duplicates: 1,
  errors: [
    { file: job.file, tab: "", row: 4, error: "Missing URL" },
    { file: job.file, tab: "", row: 5, error: "Missing URL" },
    { file: job.file, tab: "", row: 6, error: "Missing URL" },
    { file: job.file, tab: "", row: 8, error: "Missing URL" },
  ],
};
await atomicJson(path.join(recovery, "coverage-v2.json"), {
  ...queue.state,
  records: [original],
  jobs: [historicalJob],
  sourceOccurrences: undefined,
});
const recovered = new CoverageWorkflow(recovery, clients, sync);
await recovered.load();
assert.equal(recovered.state.records.length, 5);
assert.deepEqual(
  recovered.state.records.find((r) => r.id === original.id),
  original,
);
assert.equal(recovered.state.jobs.length, 1);
assert.equal(recovered.state.jobs[0].recoveredRows, 4);
assert.equal(recovered.state.sourceOccurrences!.length, 6);
assert.equal(recovered.summary().duplicateSourceOccurrences, 1);
const again = new CoverageWorkflow(recovery, clients, sync);
await again.load();
assert.deepEqual(again.state.records, recovered.state.records);
assert.deepEqual(
  again.state.sourceOccurrences,
  recovered.state.sourceOccurrences,
);
console.log(
  "Lossless CSV/XLSX rows, ordered raw columns/values, invalid/missing metadata, duplicate history, recovery and restart idempotence passed.",
);
