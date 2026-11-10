import dotenv from "dotenv";
import path from "node:path";
import { readFile } from "node:fs/promises";
dotenv.config();
const file = path.join(
  path.dirname(path.resolve(process.env.DATA_FILE ?? "data/store.json")),
  "coverage-v2.json",
);
const state = JSON.parse(await readFile(file, "utf8"));
const counts = {
  coverageRecords: state.records.length,
  uploadJobs: state.jobs.length,
  pendingCoverageSynchronizationJobs: state.jobs.filter(
    (j: any) =>
      j.state !== "cancelled" && (j.sync === "pending" || j.sync === "failed"),
  ).length,
  coverageResearchCacheEntries: 0,
  legacyCoverageMigrationsActive: false,
};
console.log(JSON.stringify(counts, null, 2));
if (
  state.version !== 2 ||
  Object.values(counts).some((value) => value !== 0 && value !== false)
)
  process.exitCode = 1;
