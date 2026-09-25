import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReporterEnrichmentService } from "./enrichment.js";
import { StructuredStore } from "./store.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(projectRoot, ".env"), override: true });
delete process.env.AI_API_KEY;
delete process.env.SEARCH_API_KEY;
const store = new StructuredStore(path.resolve(process.env.DATA_FILE ?? path.join(projectRoot, "data", "store.json")));
await store.load();
const snapshot = store.snapshot;
const records = snapshot.coverage;
const result = await new ReporterEnrichmentService(path.dirname(process.env.DATA_FILE ?? path.join(projectRoot, "data", "store.json"))).run(records, snapshot.reporters);
console.log(JSON.stringify({ localRecords: records.length, uniqueProposals: result.proposals.length, summary: result.summary }, null, 2));