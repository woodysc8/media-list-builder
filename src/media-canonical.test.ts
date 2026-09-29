import assert from "node:assert/strict";
import { applyCoverageDefaults } from "./coverage-resolvers.js";
import { coverageTypeFromPressType, normalizeCoverageStatus } from "./media-canonical.js";
import { parseInput } from "./parser.js";
import {
  COVERAGE_REPORT_HEADERS,
  OUTLET_REPORT_HEADERS,
  REPORTER_REPORT_HEADERS,
  canonicalCoverageRowsFromLegacy,
  coverageReportRow,
  contactReportRow,
  outletReportRow,
  reporterReportKey,
  reporterReportRow,
  uniqueContactReportRows
} from "./report-projections.js";
import type { CoverageRecord, OutletRecord, ReporterRecord } from "./domain.js";
import { resolveCoverageUrl, selectCoverageUrlResolutionRecords } from "./url-enrichment.js";
import { coverageUrlReviewNeedsUpdate, urlReviewNote } from "./google.js";
import { expectedOutletDomainsFor, matchMasterOutlet } from "./outlet-domain-matching.js";
import { diagnoseOptoUnresolvedOutletDomains } from "./outlet-domain-diagnostic.js";
import { buildReporterPreflight, runReadOnlyReporterPreflight } from "./reporter-preflight.js";

const parsed = parseInput(JSON.stringify({
  Client: "Example Client",
  "Press Type": "Media-Feature",
  Date: "1/6/2026",
  Publication: "Wealth Solutions Report",
  Reporter: "Thomas Lee",
  Spokesperson: "Colin Falls",
  Status: { text: "Deals & Recruiting Roundup", hyperlink: "https://example.test/deals" }
}), "example.json").items[0];

assert.equal(parsed.articleTitle, "Deals & Recruiting Roundup");
assert.equal(parsed.articleUrl, "https://example.test/deals");
assert.equal(parsed.status, "");
assert.equal(parsed.originalPressType, "Media-Feature");

const canonical = applyCoverageDefaults(parsed, []);
assert.equal(canonical.coverageType, "Earned Coverage");
assert.equal(canonical.status, "Completed");
assert.equal(coverageTypeFromPressType("Podcast"), "Podcast Interview");
assert.equal(coverageTypeFromPressType("Press Release Syndication"), "Press Release & Earned Coverage Syndication");
assert.equal(coverageTypeFromPressType("Contributed Byline Article"), "Contributed Content");
assert.equal(normalizeCoverageStatus("passed"), "On Hold");
assert.equal(normalizeCoverageStatus("scheduled"), "Pending");
assert.equal(normalizeCoverageStatus("Live"), "Completed");

const record: CoverageRecord = {
  id: "COV-test",
  clientId: "CLI-test",
  clientName: "Example Client",
  reporterName: "Thomas Lee",
  outlet: "Wealth Solutions Report",
  publicationDate: "2026-01-06",
  articleTitle: "Deals & Recruiting Roundup",
  articleUrl: "https://example.test/deals",
  urlSource: "resolved",
  urlConfidence: "verified",
  urlResolvedAt: "2026-01-06T00:00:00.000Z",
  spokesperson: "Colin Falls",
  originalPressType: "Media-Feature",
  coverageType: "Earned Coverage",
  sentiment: "Positive",
  status: "Completed",
  reach: null,
  reachSource: null,
  outletType: "Trade Publication",
  outletTypeConfidence: "fallback",
  rawFields: { "Press Type": "Media-Feature" },
  topics: [],
  source: "CSV",
  createdAt: "2026-01-06T00:00:00.000Z",
  updatedAt: "2026-01-06T00:00:00.000Z"
};
const reporter: ReporterRecord = {
  id: "REP-test", firstName: "Thomas", lastName: "Lee", outlet: "Wealth Solutions Report",
  email: "ignored@example.test", reporterType: "reporter", clientsCovered: "Example Client",
  beats: "", notes: "", mostRecentArticle: "", status: "Active"
};
const masterOutlets: OutletRecord[] = [
  { name: "PitchBook", uvm: null, link: "https://pitchbook.com" },
  { name: "Advisorpedia", uvm: null, link: "https://advisorpedia.com" },
  { name: "Citywire", uvm: null, link: "https://citywire.com" },
  { name: "Wealth Management", uvm: null, link: "https://wealthmanagement.com" },
  { name: "Alts Go Mainstream", uvm: null, link: "https://altsgomainstream.com" },
  { name: "VCWire", uvm: null, link: "https://vcwire.com" },
  { name: "Bloomberg", uvm: null, link: "https://bloomberg.com" },
  { name: "Insurance Business", uvm: null, link: "https://insurancebusinessmag.com" }
];
assert.equal(matchMasterOutlet("PitchBook", masterOutlets)?.name, "PitchBook");
assert.equal(matchMasterOutlet("Pitchbook", masterOutlets)?.name, "PitchBook");
assert.equal(matchMasterOutlet("Advisorpedia Power Your Advice", masterOutlets)?.name, "Advisorpedia");
assert.equal(matchMasterOutlet("Citywire RIA", masterOutlets)?.name, "Citywire");
assert.equal(matchMasterOutlet("Citywire Pro Buyer", masterOutlets)?.name, "Citywire");
assert.equal(matchMasterOutlet("WealthManagement.com", masterOutlets)?.name, "Wealth Management");
assert.equal(matchMasterOutlet("Alt Goes Mainstream", masterOutlets)?.name, "Alts Go Mainstream");
assert.equal(matchMasterOutlet("VC Wire", masterOutlets)?.name, "VCWire");
assert.equal(matchMasterOutlet("Bloomberg News", masterOutlets)?.name, "Bloomberg");
assert.equal(matchMasterOutlet("Insurance Business Magazine", masterOutlets)?.name, "Insurance Business");
assert.deepEqual(expectedOutletDomainsFor("Citywire RIA", masterOutlets), ["citywire.com"]);
assert.equal(expectedOutletDomainsFor("Citywire RIA", masterOutlets)[0]?.includes("/"), false);
assert.deepEqual(expectedOutletDomainsFor("Unrelated Outlet", masterOutlets), []);
assert.deepEqual(expectedOutletDomainsFor("Citywire RIA", [
  { name: "Citywire", uvm: null, link: "https://citywire.com" },
  { name: "Citywire", uvm: null, link: "https://citywiremagazine.com" }
]), []);

assert.deepEqual(COVERAGE_REPORT_HEADERS, ["Date", "Title", "Client", "Media Outlet", "Reporter", "Spokespersons ID", "Coverage Type", "Sentiment", "Status", "Reach", "URL"]);
assert.deepEqual(coverageReportRow(record, undefined, reporter), ["2026-01-06", "Deals & Recruiting Roundup", "Example Client", "Wealth Solutions Report", "Thomas Lee", "Colin Falls", "Earned Coverage", "Positive", "Completed", "", "https://example.test/deals"]);
assert.deepEqual(REPORTER_REPORT_HEADERS, ["Name", "Outlet", "Email"]);
assert.deepEqual(reporterReportRow(reporter), ["Thomas Lee", "Wealth Solutions Report", "ignored@example.test"]);
assert.deepEqual(OUTLET_REPORT_HEADERS, ["Outlet", "Outlet Type"]);
assert.deepEqual(outletReportRow(record, undefined), ["Wealth Solutions Report", "Trade Publication"]);
assert.equal(reporterReportKey(reporter), reporterReportKey({ firstName: reporter.firstName, lastName: reporter.lastName, outlet: reporter.outlet }));
assert.notEqual(reporterReportKey(reporter), reporterReportKey({ ...reporter, outlet: "Another Outlet" }));
const contact = { id: "CON-test", clientName: "Example Client", name: "Casey Smith", title: "Director", email: "casey@example.test", phone: "555-0100", notes: "" };
assert.deepEqual(contactReportRow(contact), ["Casey Smith", "Director", "casey@example.test", "555-0100"]);
assert.deepEqual(uniqueContactReportRows([contact, { ...contact, id: "CON-duplicate" }, { ...contact, id: "CON-other", clientName: "Other Client" }], "Example Client"), [contactReportRow(contact)]);
assert.deepEqual(canonicalCoverageRowsFromLegacy([
  ["Publication", "Date", "Reporter", "Link", "URL", "Press Type", "Status"],
  ["Wealth Solutions Report", "2026-01-06", "Thomas Lee", "Deals & Recruiting Roundup", "https://example.test/deals", "Media-Feature", "Live"]
]), [["2026-01-06", "Deals & Recruiting Roundup", "", "Wealth Solutions Report", "Thomas Lee", "", "Earned Coverage", "Positive", "Completed", "", "https://example.test/deals"]]);

const missingUrlRecord: CoverageRecord = {
  ...record,
  id: "COV-resolve",
  articleUrl: "",
  urlSource: null,
  urlConfidence: "unresolved",
  urlResolvedAt: null
};
const outletDiagnostic = diagnoseOptoUnresolvedOutletDomains([
  { ...missingUrlRecord, clientName: "Opto", outlet: "Citywire RIA" },
  { ...missingUrlRecord, id: "COV-unmatched", clientName: "Opto", outlet: "Unknown Outlet" },
  { ...missingUrlRecord, id: "COV-other-client", clientName: "Other Client", outlet: "Citywire RIA" },
  { ...missingUrlRecord, id: "COV-verified", clientName: "Opto", outlet: "Citywire RIA", articleUrl: "https://example.test/article", urlConfidence: "verified", urlSource: "resolved", urlResolvedAt: "2026-01-06T00:00:00.000Z" }
], masterOutlets);
assert.deepEqual(outletDiagnostic, {
  totalUnresolved: 2,
  matched: 1,
  unmatched: 1,
  matches: [{ localOutlet: "Citywire RIA", canonicalMasterOutlet: "Citywire", expectedDomains: ["citywire.com"] }],
  unmatchedOutlets: ["Unknown Outlet"]
});

const preflightReporter: ReporterRecord = {
  ...reporter, id: "REP-preflight", firstName: "Taylor", lastName: "Green",
  mostRecentArticle: "", clientsCovered: "", status: "Active", notes: "Local note"
};
const preflightCoverage: CoverageRecord = {
  ...record, id: "COV-preflight", reporterId: "REP-preflight", clientName: "Client B",
  publicationDate: "2025-03-24"
};
const preflight = buildReporterPreflight(
  { reporters: [preflightReporter], archivedReporters: [], coverage: [preflightCoverage] },
  { title: "Sheet1", sheetId: 10, values: [["ID", "Outlet", "Reporter First Name", "Reporter Last Name", "Email", "Reporter Type", "Clients Covered", "Beats", "Notes", "Most Recent Article", "Status"]] },
  { title: "Master Directory (Cleaned)", sheetId: 20, values: [
    ["ID", "Outlet", "Reporter First Name", "Reporter Last Name", "Email", "Reporter Type", "Clients Covered", "Beats", "Notes", "Most Recent Article", "Status"],
    ["REP-preflight", "Wealth Solutions Report", "Taylor", "Green", "", "reporter", "Old Client", "", "Gemini note", "2024-01-01", "Active"]
  ] },
  new Date("2026-09-24T12:00:00.000Z")
);
assert.equal(preflight.spreadsheet.sheet1.sheetId, 10);
assert.equal(preflight.spreadsheet.cleaned.sheetId, 20);
assert.equal(preflight.totals.localActiveAfterRecency, 1, "18-month boundary is retained");
assert.equal(preflight.totals.cleanedIdsMatchingLocal, 1);
assert.equal(preflight.totals.mostRecentArticleWouldChange, 1);
assert.equal(preflight.totals.clientsCoveredWouldChange, 1);
assert.equal(preflight.totals.humanFieldDifferenceRows, 1);
assert.match(preflight.humanFieldOwnership, /Google\/Gemini-owned/);
assert.equal(preflight.totals.cleanedRowsWouldBeDeleted, 0);
let preflightStoreMutations = 0;
const preflightStore = {
  get snapshot() { return { reporters: [preflightReporter], archivedReporters: [], coverage: [preflightCoverage] }; },
  save: () => { preflightStoreMutations += 1; },
  updateReporter: () => { preflightStoreMutations += 1; },
  updateCoverage: () => { preflightStoreMutations += 1; }
};
let preflightWorkspaceReads = 0;
await runReadOnlyReporterPreflight({
  connected: true,
  reporterPreflight: async (snapshot) => {
    preflightWorkspaceReads += 1;
    assert.equal(snapshot.coverage.length, 1);
    return { readOnly: true };
  }
}, preflightStore);
assert.equal(preflightWorkspaceReads, 1);
assert.equal(preflightStoreMutations, 0, "read-only preflight never calls store mutation methods");
const verified = await resolveCoverageUrl(missingUrlRecord, {
  search: async () => [{
    title: "Deals & Recruiting Roundup",
    url: "https://wealthsolutionsreport.com/deals-roundup",
    snippet: "By Thomas Lee for Wealth Solutions Report",
    publishedDate: "2026-01-06"
  }]
}, ["wealthsolutionsreport.com"]);
assert.equal(verified.outcome, "verified");
assert.equal(verified.articleUrl, "https://wealthsolutionsreport.com/deals-roundup");
assert.equal(urlReviewNote({ ...missingUrlRecord, articleUrl: verified.articleUrl, urlSource: "resolved", urlConfidence: "verified", urlResolvedAt: "2026-01-06T00:00:00.000Z" }), null);

const aliasDomain = await resolveCoverageUrl({ ...missingUrlRecord, outlet: "The Wall Street Journal" }, {
  search: async () => [{
    title: "Deals & Recruiting Roundup",
    url: "https://www.wsj.com/articles/deals-roundup",
    snippet: "By a different author",
    publishedDate: "2026-01-06"
  }]
});
assert.equal(aliasDomain.outcome, "verified");
assert.equal(aliasDomain.evidence.outletDomainMatch, true);

const faAliasDomain = await resolveCoverageUrl({ ...missingUrlRecord, outlet: "FA Magazine" }, {
  search: async () => [{
    title: "Deals & Recruiting Roundup",
    url: "https://www.fa-mag.com/news/deals-roundup",
    publishedDate: "2026-01-06"
  }]
});
assert.equal(faAliasDomain.outcome, "verified");
assert.equal(faAliasDomain.evidence.outletDomainMatch, true);

const missingDateCandidate = await resolveCoverageUrl(missingUrlRecord, {
  search: async () => [{
    title: "Deals Recruiting Roundup Advisor",
    url: "https://wealthsolutionsreport.com/advisor-roundup-no-date",
    snippet: "By another author"
  }]
}, ["wealthsolutionsreport.com"]);
assert.equal(missingDateCandidate.outcome, "candidate");
assert.equal(missingDateCandidate.articleUrl, "https://wealthsolutionsreport.com/advisor-roundup-no-date");

const podcastCandidate = await resolveCoverageUrl({
  ...missingUrlRecord,
  coverageType: "Podcast Interview",
  outlet: "YouTube",
  articleTitle: "Private Markets Discussion"
}, {
  search: async () => [{
    title: "Private Markets with Example Client",
    url: "https://www.youtube.com/watch?v=example",
    snippet: "Example Client joins the show"
  }]
}, ["youtube.com"]);
assert.equal(podcastCandidate.outcome, "candidate");
assert.equal(podcastCandidate.articleUrl, "https://www.youtube.com/watch?v=example");

const homepage = await resolveCoverageUrl(missingUrlRecord, {
  search: async () => [{
    title: "Deals & Recruiting Roundup",
    url: "https://wealthsolutionsreport.com/",
    snippet: "By Thomas Lee",
    publishedDate: "2026-01-06"
  }]
}, ["wealthsolutionsreport.com"]);
assert.equal(homepage.outcome, "unresolved");
assert.equal(homepage.articleUrl, "");

// Historical resolved URLs without a saved resolver response must retain their
// URL state but must not receive invented search evidence during later reads/projection.
const legacyResolvedWithoutEvidence: CoverageRecord = {
  ...record,
  id: "COV-legacy-resolved",
  articleUrl: "https://wealthsolutionsreport.com/historical-article",
  urlSource: "resolved",
  urlConfidence: "verified",
  urlResolvedAt: "2026-01-05T00:00:00.000Z",
  urlResolutionEvidence: null
};
assert.equal(legacyResolvedWithoutEvidence.urlResolutionEvidence, null);
assert.equal(coverageReportRow(legacyResolvedWithoutEvidence, undefined, reporter)[10], legacyResolvedWithoutEvidence.articleUrl);

const candidate = await resolveCoverageUrl(missingUrlRecord, {
  search: async () => [{
    title: "Deals Recruiting Roundup Advisor",
    url: "https://wealthsolutionsreport.com/advisor-roundup",
    snippet: "By Thomas Lee",
    publishedDate: "2026-01-20"
  }]
}, ["wealthsolutionsreport.com"]);
assert.equal(candidate.outcome, "candidate");
assert.equal(candidate.confidence, "candidate");
assert.equal(candidate.articleUrl, "https://wealthsolutionsreport.com/advisor-roundup");
assert.match(urlReviewNote({ ...missingUrlRecord, articleUrl: candidate.articleUrl, urlSource: "resolved", urlConfidence: "candidate", urlResolvedAt: "2026-01-06T00:00:00.000Z", urlResolutionEvidence: candidate.evidence }) ?? "", /URL needs review/);
const candidateRecord = { ...missingUrlRecord, articleUrl: candidate.articleUrl, urlSource: "resolved" as const, urlConfidence: "candidate" as const, urlResolvedAt: "2026-01-06T00:00:00.000Z", urlResolutionEvidence: candidate.evidence };
assert.equal(coverageUrlReviewNeedsUpdate(candidateRecord, { note: urlReviewNote(candidateRecord) ?? "", bold: true, backgroundColor: { red: 1, green: 0.95, blue: 0.6 } }), false);
assert.equal(coverageReportRow({ ...missingUrlRecord, articleUrl: candidate.articleUrl, urlSource: "resolved", urlConfidence: "candidate", urlResolvedAt: "2026-01-06T00:00:00.000Z" }, undefined, reporter)[10], candidate.articleUrl);
let candidateSearchCalled = false;
await resolveCoverageUrl({ ...missingUrlRecord, articleUrl: candidate.articleUrl, urlSource: "resolved", urlConfidence: "candidate", urlResolvedAt: "2026-01-20T00:00:00.000Z" }, {
  search: async () => { candidateSearchCalled = true; return []; }
}, ["wealthsolutionsreport.com"]);
assert.equal(candidateSearchCalled, true);

const unresolved = await resolveCoverageUrl(missingUrlRecord, {
  search: async () => [{
    title: "Different story",
    url: "https://unrelated.example/story",
    publishedDate: "2026-01-06"
  }]
}, ["wealthsolutionsreport.com"]);
assert.equal(unresolved.outcome, "unresolved");
assert.equal(unresolved.articleUrl, "");
assert.match(urlReviewNote({ ...missingUrlRecord, urlResolutionEvidence: unresolved.evidence }) ?? "", /No plausible URL/);

const contradictoryWeakMatch = await resolveCoverageUrl(missingUrlRecord, {
  search: async () => [{
    title: "Different Recruiting Story",
    url: "https://wealthsolutionsreport.com/other-story",
    publishedDate: "2025-01-01"
  }]
}, ["wealthsolutionsreport.com"]);
assert.equal(contradictoryWeakMatch.outcome, "unresolved");
assert.equal(contradictoryWeakMatch.articleUrl, "");

const noMasterMatch = await resolveCoverageUrl({ ...missingUrlRecord, outlet: "Unknown Registry Outlet" }, {
  search: async () => [{
    title: "Different unrelated story",
    url: "https://unrelated.example/deals-roundup",
    snippet: "By Thomas Lee",
    publishedDate: "2026-01-06"
  }]
});
assert.equal(noMasterMatch.outcome, "unresolved");
assert.equal(noMasterMatch.articleUrl, "");

const ambiguous = await resolveCoverageUrl(missingUrlRecord, {
  search: async () => [
    { title: "Deals Recruiting Roundup Advisor", url: "https://wealthsolutionsreport.com/a", snippet: "By Thomas Lee", publishedDate: "2026-01-20" },
    { title: "Deals Recruiting Roundup Advisor", url: "https://wealthsolutionsreport.com/b", snippet: "By Thomas Lee", publishedDate: "2026-01-20" }
  ]
}, ["wealthsolutionsreport.com"]);
assert.equal(ambiguous.outcome, "unresolved");
assert.equal(ambiguous.articleUrl, "");

let manualSearchCalled = false;
const manual = await resolveCoverageUrl({
  ...missingUrlRecord,
  articleUrl: "https://manual.example/article",
  urlSource: "manual",
  urlConfidence: "verified",
  urlResolvedAt: "2026-01-06T00:00:00.000Z"
}, { search: async () => { manualSearchCalled = true; return []; } });
assert.equal(manual.outcome, "manual");
assert.equal(manual.articleUrl, "https://manual.example/article");
assert.equal(manualSearchCalled, false);

let prccSearchCalled = false;
const prcc = await resolveCoverageUrl({
  ...missingUrlRecord,
  articleUrl: "https://wealthsolutionsreport.com/prcc-provided",
  urlSource: "prcc",
  urlConfidence: "verified",
  urlResolvedAt: "2026-01-06T00:00:00.000Z"
}, { search: async () => { prccSearchCalled = true; return []; } });
assert.equal(prcc.outcome, "prcc");
assert.equal(prccSearchCalled, false);

const boundedRecords = Array.from({ length: 30 }, (_, index) => ({
  ...missingUrlRecord,
  id: `COV-bounded-${index}`
}));
assert.equal(selectCoverageUrlResolutionRecords(boundedRecords, [], ["example client"], 99).length, 25);

// Google projections read the persisted URL only; they accept no search provider.
assert.equal(coverageReportRow({ ...missingUrlRecord, articleUrl: verified.articleUrl, urlSource: "resolved", urlConfidence: "verified", urlResolvedAt: "2026-01-06T00:00:00.000Z" }, undefined, reporter)[10], verified.articleUrl);

console.log("media canonical tests passed");
