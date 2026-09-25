import { StructuredStore } from "./store.js";
import { parseInput } from "./parser.js";
import { applyCoverageDefaults } from "./coverage-resolvers.js";
import { resolveCoverageUrl } from "./url-enrichment.js";
import { ingest } from "./ingestion.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const store = new StructuredStore("data/store.json");
await store.load();

const opto = store.snapshot.coverage.filter((record) => record.clientName === "Opto");
const source = opto.find((record) => record.articleTitle === "How Advisors Are Putting Private Markets to Use");
if (!source) throw new Error("Persisted Opto regression record was not found");

const rawFromStore = {
  Date: source.publicationDate,
  Title: source.articleTitle,
  Client: source.clientName,
  "Media Outlet": source.outlet,
  Reporter: source.reporterName,
  Spokesperson: source.spokesperson
};
const parsed = parseInput(JSON.stringify(rawFromStore), "derived-from-persisted-record.json").items[0];
if (!parsed || parsed.articleTitle !== source.articleTitle || parsed.articleUrl === parsed.articleTitle) {
  throw new Error("Persisted-record parser regression failed");
}

const resolved = applyCoverageDefaults(parsed, [
  { name: source.outlet, uvm: 7_400_000, link: "https://example.test" }
]);
if (resolved.coverageType !== "Earned Coverage" || resolved.sentiment !== "Positive" || resolved.status !== "Completed" || resolved.reach !== 7_400_000) {
  throw new Error("Deterministic coverage defaults failed");
}
if (applyCoverageDefaults({ ...parsed, reach: 123 }, [{ name: source.outlet, uvm: 7_400_000, link: "" }]).reach !== 123) {
  throw new Error("Explicit PRCC reach precedence failed");
}

const existingUrl = "https://existing.test/article";
const proposal = await resolveCoverageUrl({ ...source, articleUrl: existingUrl, urlSource: "prcc", urlConfidence: "verified", urlResolvedAt: source.updatedAt }, undefined);
if (proposal.articleUrl !== existingUrl || proposal.outcome !== "prcc") {
  throw new Error("Existing URL proposal protection failed");
}

const allowed = new Set([
  "Earned Coverage",
  "Contributed Content",
  "Podcast Interview",
  "Awards & Recognition",
  "Speaking Engagement",
  "Newsletter Inclusion",
  "Press Release",
  "Press Release & Earned Coverage Syndication",
  "Missed Opportunity"
]);
const invalid = store.snapshot.coverage.filter((record) =>
  !allowed.has(record.coverageType) ||
  record.sentiment !== "Positive" ||
  !["Completed", "On Hold", "Pending"].includes(record.status) ||
  Boolean(record.articleUrl && record.articleUrl === record.articleTitle)
);
if (invalid.length) throw new Error(`Invalid canonical records: ${invalid.length}`);

const tempDirectory = await mkdtemp(join(tmpdir(), "media-list-builder-verify-"));
const tempStorePath = join(tempDirectory, "store.json");
await writeFile(tempStorePath, await readFile("data/store.json", "utf8"));
const tempStore = new StructuredStore(tempStorePath);
await tempStore.load();
const tempBefore = tempStore.snapshot.coverage.length;
const importItem = {
  ...parsed,
  coverageType: "",
  sentiment: "",
  status: "",
  reach: null
};
const firstImport = await ingest([importItem], "CSV", source.sourceFile, tempStore, {
  outlets: [{ name: source.outlet, uvm: 7_400_000, link: "https://example.test" }]
});
const afterFirstImport = tempStore.snapshot.coverage;
const importedRecord = afterFirstImport.find((record) => record.id === source.id);
const secondImport = await ingest([importItem], "CSV", source.sourceFile, tempStore, {
  outlets: [{ name: source.outlet, uvm: 7_400_000, link: "https://example.test" }]
});
const afterSecondImport = tempStore.snapshot.coverage;
await rm(tempDirectory, { recursive: true, force: true });
if (afterFirstImport.length !== tempBefore || afterSecondImport.length !== tempBefore || importedRecord?.id !== source.id) {
  throw new Error("Coverage upsert/idempotency failed");
}

console.log(JSON.stringify({
  storeCount: store.snapshot.coverage.length,
  optoCount: opto.length,
  sourceId: source.id,
  parsed: {
    publicationDate: parsed.publicationDate,
    articleTitle: parsed.articleTitle,
    clientName: parsed.clientName,
    outlet: parsed.outlet,
    reporterName: parsed.reporterName,
    spokesperson: parsed.spokesperson,
    articleUrl: parsed.articleUrl
  },
  resolved: {
    coverageType: resolved.coverageType,
    sentiment: resolved.sentiment,
    status: resolved.status,
    reach: resolved.reach
  },
  invalidCanonicalRecords: invalid.length,
  upsert: {
    before: tempBefore,
    firstAdded: firstImport.records.length - firstImport.coverageUpdated,
    firstUpdated: firstImport.coverageUpdated,
    secondAdded: secondImport.records.length - secondImport.coverageUpdated,
    secondUpdated: secondImport.coverageUpdated,
    secondDuplicates: secondImport.duplicates.length,
    finalCount: afterSecondImport.length
  }
}));
