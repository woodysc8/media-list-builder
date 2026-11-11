import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CoverageWorkflow, atomicJson } from "./coverage-workflow.js";
import { extractArticleTitle, usableTitle } from "./coverage-titles.js";
import writeXlsx from "write-excel-file/node";
const dir = await mkdtemp(path.join(os.tmpdir(), "coverage-titles-"));
const queue = new CoverageWorkflow(
  dir,
  () => [],
  async () => {},
);
await queue.load();
// Actual queued Orion and Conquest header layouts; synthetic headlines/URLs only.
const orion = Buffer.from(
  "Press Type,Date ,Publication,UVM,Reporter ,Spokesperson,Sentiment,Coverage Link,Raw URL\nMedia Commentary,1/2/26,Example,524K+,A Reporter,CEO,Neutral,Orion source headline,https://example.com/orion",
);
const conquest = Buffer.from(
  "Press Type,Date ,Publication,UVM,Reporter ,Spokesperson,Status,Raw URL\nFirm or Spokesperson Mention,1/12/26,Example,72K+,A Reporter,CEO,Conquest source headline,https://example.com/conquest",
);
const a = await queue.enqueue(
    orion,
    "Orion PR Campaign Calendar - 2026 Press Coverage.csv",
  ),
  b = await queue.enqueue(
    conquest,
    "Conquest PR Campaign Calendar - 2026 Media Activity.csv",
  );
assert.equal(a.records[0].articleTitle, "Orion source headline");
assert.equal(b.records[0].articleTitle, "Conquest source headline");
assert.equal(a.records[0].reach, "524K+");
for (const status of [
  "Completed",
  "Published",
  "Secured",
  "https://example.com/article",
])
  assert.equal(usableTitle(status), "");
assert.equal(
  extractArticleTitle({
    title: "Published",
    headline: "Explicit headline",
    status: "Completed",
  }),
  "Explicit headline",
);
assert.equal(
  extractArticleTitle({
    coveragelink: {
      displayText: "Excel hyperlink headline",
      url: "https://example.com/x",
    },
  }),
  "Excel hyperlink headline",
);
assert.equal(
  extractArticleTitle({
    link: '=HYPERLINK("https://example.com/x","Formula headline")',
  }),
  "Formula headline",
);
const excel = await writeXlsx([
  ["Coverage Link", "Raw URL"],
  ["Excel displayed headline", "https://example.com/excel"],
]).toBuffer();
assert.equal(
  (await queue.enqueue(excel, "Excel Client PRCC.xlsx")).records[0]
    .articleTitle,
  "Excel displayed headline",
);
const missing = await queue.enqueue(
  Buffer.from("Status,Raw URL\nCompleted,https://example.com/no-title"),
  "Other PRCC.csv",
);
assert.equal(missing.records[0].articleTitle, "");
assert.equal(missing.records[0].titleNeedsReview, true);
const conflict = await queue.enqueue(
  Buffer.from(
    "Coverage Link,Raw URL\nOriginal row headline,https://example.com/conflict\nDifferent duplicate-row headline,https://example.com/conflict",
  ),
  "Orion PRCC duplicate-source.csv",
);
// Simulate the old Orion parser and retain the original source location for repair.
queue.state.records = [
  a.records[0],
  b.records[0],
  missing.records[0],
  conflict.records[0],
];
queue.state.records[0].articleTitle = "";
queue.state.records[3].articleTitle = "";
for (const job of queue.state.jobs) {
  job.state = "completed";
  job.records = [];
}
queue.state.titleRepairVersion = undefined;
const original = structuredClone(queue.state.records),
  jobs = structuredClone(queue.state.jobs);
await queue.save();
const restarted = new CoverageWorkflow(
  dir,
  () => [],
  async () => {},
);
await restarted.load();
assert.equal(restarted.state.records.length, 4);
assert.equal(
  restarted.state.records[3].articleTitle,
  "Original row headline",
  "Saved source-row evidence resolves conflicting duplicate-URL headline variants",
);
assert.equal(restarted.state.records[0].articleTitle, "Orion source headline");
assert.deepEqual(restarted.state.records[1], original[1]);
assert.deepEqual(restarted.state.jobs, jobs);
for (const [i, record] of restarted.state.records.entries()) {
  const { articleTitle, titleNeedsReview, titleReviewReason, ...rest } = record;
  const {
    articleTitle: oldTitle,
    titleNeedsReview: oldNeeds,
    titleReviewReason: oldReason,
    ...oldRest
  } = original[i];
  assert.deepEqual(rest, oldRest);
}
assert.equal(restarted.state.records[2].titleNeedsReview, true);
console.log(
  "Actual Orion/Conquest source formats, generic status rejection, Excel display text and evidence-only title repair passed.",
);
