import assert from "node:assert/strict";
import { buildMediaListRows, buildReporterCoverageIndex, filterReporters, formatReporterSearchSummary, MEDIA_LIST_HEADERS, qualificationDiagnostics, reporterQualifies, sanitizeMediaList, uniqueMasterReporters } from "./reporter-filter.js";

const directory = [
  { id: "ai", firstName: "Ari", lastName: "Reporter", outlet: "One", clientsCovered: "Wealth.com, Orion", reporterType: "reporter", status: "Active", beats: "Generative AI", notes: "" },
  { id: "wealth", firstName: "Bea", lastName: "Writer", outlet: "Two", clientsCovered: "Envestnet", reporterType: "podcast", status: "Active", beats: "Financial advisors", notes: "" },
  { id: "private", firstName: "Cal", lastName: "Press", outlet: "Three", clientsCovered: "Addepar", reporterType: "broadcast tv", status: "Inactive", beats: "Private Equity", notes: "" },
  { id: "radio", firstName: "Dee", lastName: "Radio", outlet: "Four", clientsCovered: "", reporterType: "broadcast radio", status: "Active", beats: "Markets", notes: "" },
  { id: "newsletter", firstName: "Eli", lastName: "Letter", outlet: "Five", clientsCovered: "", reporterType: "newsletter", status: "Active", beats: "Investing", notes: "" },
  { id: "unrelated", firstName: "Fran", lastName: "Source", outlet: "Six", clientsCovered: "Other Client", reporterType: "Influencer", status: "Needs Review", beats: "Food and travel", notes: "" }
];
const ids = (filters) => filterReporters(directory, filters).map((item) => item.id);

assert.deepEqual(ids({ topics: ["AI"] }), ["ai"], "A: one topic match includes reporter");
assert.deepEqual(ids({ topics: ["AI", "RIA", "Private Equity"] }), ["ai", "wealth", "private"], "B: any selected canonical topic can qualify");
assert.deepEqual(ids({ topics: ["AI", "RIA"] }).includes("private"), false, "C: no topic match excludes reporter");
assert.deepEqual(ids({ similarClients: ["Orion", "Envestnet", "Addepar"] }), ["ai", "wealth", "private"], "D: any similar client can qualify");
assert.deepEqual(ids({ similarClients: ["Orion", "Envestnet"] }).includes("private"), false, "E: no similar-client match excludes reporter");
assert.deepEqual(ids({ reporterTypes: ["podcast"] }), ["wealth"], "F: specific reporter type excludes other types");
assert.deepEqual(ids({ reporterTypes: ["reporter", "podcast"] }), ["ai", "wealth"], "Reporter Type multi-select uses OR logic");
assert.deepEqual(ids({ reporterTypes: ["reporter", "influencer"] }), ["ai", "unrelated"], "Canonical Reporter Type selections use OR logic");
assert.deepEqual(ids({ reporterTypes: ["reporter"] }), ["ai"], "Reporter selection matches the reporter type");
const legacyJournalist = { ...directory[0], id: "legacy-journalist", reporterType: "Journalist" };
assert.deepEqual(filterReporters([legacyJournalist], { reporterTypes: ["reporter"] }), [], "Unexpected legacy Reporter Type values are not silently mapped to a canonical type");
assert.deepEqual(filterReporters([legacyJournalist], { topics: ["AI"] })[0]?.reporterType, "Journalist", "Unexpected source Reporter Type value is preserved when no type filter is selected");
const tierOne = { ...directory[0], id: "tier-one", reporterType: "Tier 1 Media" };
assert.deepEqual(filterReporters([tierOne], { reporterTypes: ["tier 1 media"] }).map((reporter) => reporter.id), ["tier-one"], "Tier 1 Media remains a canonical Reporter Type selection");
assert.deepEqual(ids({ reporterTypes: [] }), directory.map((item) => item.id), "G: no selected type applies no type filter");
const generativeAiReporter = { ...directory[0], id: "generative-ai", beats: "Generative AI" };
const aiResult = filterReporters([generativeAiReporter], { topics: ["AI"] })[0];
assert.equal(aiResult?.whyRelevant?.some((reason) => reason === "AI: Master Directory Beats (Generative AI)"), true, "Canonical AI match includes its raw beat in existing relevance evidence");
const paymentsReporter = { ...directory[0], id: "payments", beats: "Payments" };
assert.deepEqual(filterReporters([paymentsReporter], { topics: ["Banking"] }).map((item) => item.id), ["payments"], "Payments qualifies for Banking");
assert.deepEqual(filterReporters([paymentsReporter], { topics: ["Fintech"] }).map((item) => item.id), ["payments"], "Payments qualifies for Fintech");
const regtechReporter = { ...directory[0], id: "regtech", beats: "Regtech" };
assert.deepEqual(filterReporters([regtechReporter], { topics: ["Fintech"] }).map((item) => item.id), ["regtech"]);
assert.deepEqual(filterReporters([regtechReporter], { topics: ["Compliance"] }).map((item) => item.id), ["regtech"]);
const investigationReporter = { ...directory[0], id: "investigations", beats: "Corporate Investigations" };
assert.deepEqual(filterReporters([investigationReporter], { topics: ["Corporate & Business"] }).map((item) => item.id), ["investigations"]);
assert.deepEqual(filterReporters([investigationReporter], { topics: ["Compliance"] }).map((item) => item.id), ["investigations"]);
const commercialPropertyReporter = { ...directory[0], id: "commercial-property", beats: "Commercial Real Estate" };
assert.deepEqual(filterReporters([commercialPropertyReporter], { topics: ["Alternative Assets"] }).map((item) => item.id), ["commercial-property"]);
const broadWealthReporter = { ...directory[0], id: "broad-wealth", beats: "Wealth Management" };
assert.deepEqual(filterReporters([broadWealthReporter], { topics: ["RIA"] }).map((item) => item.id), ["broad-wealth"], "Explicit Wealth Management to RIA mapping participates in filtering");
const lawMentionReporter = { ...directory[0], id: "law-mention", beats: "Local Business", notes: "Covers law firms" };
assert.deepEqual(filterReporters([lawMentionReporter], { topics: ["Law"] }), [], "Law has no invented beat, notes, or coverage mapping");
const typeHardFilter = filterReporters([generativeAiReporter], { topics: ["AI"], reporterTypes: ["reporter"] })[0];
assert.equal(typeHardFilter?.whyRelevant?.some((reason) => /Reporter Type/i.test(reason)), false, "Reporter Type narrows eligibility but is not evidence");
assert.deepEqual(ids({ status: "Active" }), ["ai", "wealth", "radio", "newsletter"], "H: selected status is a hard filter");
assert.deepEqual(ids({ status: "All" }), directory.map((item) => item.id), "Blank or All status imposes no status filter");
assert.equal(reporterQualifies({ id: "synonym", firstName: "Mina", lastName: "Writer", outlet: "Example", beats: "Generative AI", clientsCovered: "", reporterType: "reporter", status: "Active" }, { topics: ["AI"] }), true, "I: canonical AI mapping qualifies");
assert.deepEqual(ids({}), directory.map((item) => item.id), "J: no filters include all directory reporters");

const neverCoveredClient = { id: "discovery", firstName: "Drew", lastName: "Reporter", outlet: "Example", clientsCovered: "", reporterType: "reporter", status: "Active", beats: "Generative AI", notes: "" };
assert.equal(reporterQualifies(neverCoveredClient, { client: "Wealth.com", topics: ["AI"] }), true, "Regression: pitch Client never blocks a reporter with relevant topic evidence");
assert.deepEqual(filterReporters([neverCoveredClient], { client: "Wealth.com", topics: ["AI"], similarClients: ["Orion", "Envestnet", "Addepar"] }).map((item) => item.id), ["discovery"], "Client context is ignored when the reporter has relevant topic evidence");
assert.deepEqual(filterReporters([neverCoveredClient], { client: "Wealth.com", similarClients: ["Orion"] }, [{ reporterId: "discovery", reporterName: "Drew Reporter", outlet: "Example", clientName: "Orion", articleTitle: "Advisor technology trends", topics: [] }]).map((item) => item.id), ["discovery"], "Historical coverage of a similar client qualifies even without Client history");
assert.equal(reporterQualifies({ ...neverCoveredClient, clientsCovered: "Orion Advisor Solutions" }, { similarClients: ["Orion"] }), true, "Similar-client field match recognizes a selected client contained in a directory name");
assert.deepEqual(filterReporters([neverCoveredClient], { topics: ["AI"], similarClients: ["No Match"] }).map((item) => item.id), ["discovery"], "Topic evidence OR similar-client evidence qualifies");
assert.deepEqual(filterReporters([{ ...neverCoveredClient, beats: "", notes: "" }], { topics: ["AI"] }, [{ reporterId: "discovery", reporterName: "Drew Reporter", outlet: "Example", clientName: "Other", articleTitle: "Machine Learning for advisors", topics: [] }]).map((item) => item.id), ["discovery"], "Relevant topic in historical coverage qualifies");
assert.deepEqual(filterReporters([neverCoveredClient], { client: "Wealth.com", topics: ["AI"] })[0]?.whyRelevant, ["AI: Master Directory Beats (Generative AI)"], "Pool entry exposes canonical relevance and its raw beat evidence");
const largePool = Array.from({ length: 500 }, (_, index) => ({ ...neverCoveredClient, id: `pool-${index}`, beats: "Generative AI" }));
assert.equal(filterReporters(largePool, { topics: ["AI"] }).length, 500, "complete qualifying population is returned without a target-count cap");
assert.deepEqual(ids({ topics: ["RIA"] }).includes("wealth"), true, "Canonical RIA classification recognizes Financial Advisors");

const cleanCoverageReporter = { ...directory[0], id: "clean", firstName: "Mela", lastName: "Seyoum", outlet: "Financial Advisor IQ", beats: "", notes: "" };
const coverageExamples = [
  { reporterName: "n/a", outlet: "BusinessWire", clientName: "Orion", articleTitle: "AI announcement" },
  { reporterName: "Elias 协调eight", outlet: "The Wall Street Journal", clientName: "Orion", articleTitle: "AI announcement" }
];
const linked = buildReporterCoverageIndex([cleanCoverageReporter], coverageExamples);
assert.deepEqual([...linked.index.keys()], ["clean"], "Coverage-only identities never create reporter identities");
assert.equal(linked.index.get("clean").length, 0, "Coverage with n/a or malformed reporter names is not attached by fallback");
assert.equal(linked.diagnostics.coverageWithoutReporterIdentity, 2, "Missing and malformed coverage identities are counted");
assert.deepEqual(filterReporters([cleanCoverageReporter], { topics: ["AI"] }, coverageExamples), [], "Coverage-only n/a and malformed records cannot qualify a directory reporter through fallback");

const sameIdDuplicate = { ...cleanCoverageReporter, firstName: "Mela", lastName: "Seyoum" };
const distinctSameName = { ...cleanCoverageReporter, id: "clean-2" };
const identityPool = uniqueMasterReporters([cleanCoverageReporter, sameIdDuplicate, distinctSameName]);
assert.deepEqual(identityPool.map((item) => item.id), ["clean", "clean-2"], "Same Master ID appears once while distinct IDs are preserved");
const historyForMaster = [{ reporterId: "clean", reporterName: "Mela Seyoum", outlet: "Financial Advisor IQ", clientName: "Orion", articleTitle: "AI coverage" }];
assert.equal(filterReporters([cleanCoverageReporter, sameIdDuplicate], { similarClients: ["Orion"] }, historyForMaster).length, 1, "A directory reporter with historical coverage appears once");
assert.deepEqual(filterReporters([{ ...cleanCoverageReporter, beats: "Financial Advisors", clientsCovered: "Orion" }], { topics: ["RIA"] }).map((item) => item.id), ["clean"], "Master reporter with no history qualifies through canonical directory beat classification");
assert.equal(sanitizeMediaList([{ id: "coverage-only", firstName: "n/a", lastName: "", outlet: "BusinessWire" }, { id: "clean" }], [cleanCoverageReporter]).length, 1, "Current Media List rejects Coverage-only identities");
const exportRows = buildMediaListRows([{ ...cleanCoverageReporter, clientsCovered: "tampered", notes: "generated explanation", ownerDatePitched: "Sam / today", profile: "Profile" }, { id: "coverage-only" }], [cleanCoverageReporter]);
assert.deepEqual(exportRows, [["Sam / today", "Financial Advisor IQ", "Mela", "Seyoum", "", "reporter", "Wealth.com, Orion", "Profile", ""]], "Export includes only directory reporters, exact nine fields, and directory Clients Covered/Notes");
assert.equal(exportRows[0].length, 9, "Export schema has exactly nine columns");
assert.deepEqual(MEDIA_LIST_HEADERS, ["Owner/Date Pitched", "Outlet", "Reporter First Name", "Reporter Last Name", "Email", "Reporter Type", "Clients Covered", "Profile", "Notes"], "Google Sheet projection has the exact requested nine columns");
assert.equal(buildReporterCoverageIndex([cleanCoverageReporter], historyForMaster).diagnostics.coverageLinkedToMasterReporters, 1, "Coverage with valid Master reporter ID attaches as enrichment");

const malformedMaster = { ...cleanCoverageReporter, id: "bad", firstName: "Elias", lastName: "协调eight" };
assert.equal(filterReporters([malformedMaster], {}).length, 0, "Malformed directory identity is not exposed as a reporter candidate");
assert.equal(filterReporters([cleanCoverageReporter], { topics: ["AI"] }).length, 0, "Unrelated reporter is excluded by selected topic");
assert.equal(filterReporters([{ ...cleanCoverageReporter, beats: "AI" }], { topics: ["AI"] }).length, 1, "Broad selected topic includes its full qualifying pool");
assert.equal(filterReporters(Array.from({ length: 500 }, (_, i) => ({ ...cleanCoverageReporter, id: `wide-${i}`, beats: "AI" })), { topics: ["AI"] }).length, 500, "Broad search is not ranked or truncated");

const verifiedUniverse = Array.from({ length: 592 }, (_, index) => ({
  id: `master-${index}`,
  firstName: `Reporter${index}`,
  lastName: "Writer",
  outlet: `Outlet ${index}`,
  reporterType: "reporter",
  status: "Active",
  beats: index < 37 ? "AI" : "Hospitality",
  notes: "",
  clientsCovered: ""
}));
const directorySnapshot = [
  ...verifiedUniverse,
  ...verifiedUniverse.slice(0, 8),
  ...Array.from({ length: 21 }, (_, index) => ({ ...verifiedUniverse[0], id: `invalid-${index}`, firstName: "n/a", lastName: "" }))
];
const noFilterPool = filterReporters(directorySnapshot, {});
assert.equal(noFilterPool.length, 592, "No-filter state is the full unique valid Master Directory universe");
const selectedFilters = { reporterTypes: ["reporter", "podcast"], status: "Active", topics: ["AI", "RIA"], similarClients: ["Osaic", "Savvy Wealth"] };
const filteredSnapshot = filterReporters(directorySnapshot, selectedFilters);
assert.equal(filteredSnapshot.length, 37, "Test filtered search returns every qualifying reporter");
const noFilterSummary = formatReporterSearchSummary(592, {}, noFilterPool.length);
assert.equal(noFilterSummary, "Master Directory: 592 reporters\nFilters: None\nRelevant reporters: 592", "No-filter displayed diagnostic shows the full directory count");
const activeSummary = formatReporterSearchSummary(592, selectedFilters, filteredSnapshot.length);
assert.equal(activeSummary, "Master Directory: 592 reporters\nReporter Type: Reporter, Podcast\nStatus: Active\nTopics: AI, RIA\nSimilar Clients: Osaic, Savvy Wealth\nRelevant reporters: 37", "Displayed diagnostic reflects only selected filters and exact result count");
assert.match(activeSummary, /relevant reporters/i);
assert.doesNotMatch(activeSummary, /candidate/i, "Result wording does not describe reporters as candidates");
assert.equal(filterReporters(directorySnapshot, { topics: ["AI"], targetCount: 10 }).length, 37, "A stale target-count input cannot truncate results");

// Additive EPIC / Galway / Sunstar workflow. Each evidence path is sufficient.
const insuranceWorkflow = [
  { id: "beat-ins", firstName: "Ivy", lastName: "Beat", outlet: "General News", beats: "Insurance", reporterType: "reporter", status: "Active" },
  { id: "epic", firstName: "Evan", lastName: "Epic", outlet: "General News", beats: "Business", reporterType: "reporter", status: "Active" },
  { id: "galway", firstName: "Gail", lastName: "Galway", outlet: "General News", beats: "Business", reporterType: "reporter", status: "Active" },
  { id: "sunstar", firstName: "Sunny", lastName: "Star", outlet: "General News", beats: "Business", reporterType: "reporter", status: "Inactive" },
  { id: "outlet", firstName: "Olive", lastName: "Outlet", outlet: "Insurance Business", beats: "Business", reporterType: "reporter", status: "Active" },
  { id: "miss", firstName: "Moe", lastName: "Miss", outlet: "General News", beats: "Food", reporterType: "reporter", status: "Active" },
  { id: "bad", firstName: "n/a", lastName: "", outlet: "Insurance Times", beats: "Insurance", reporterType: "reporter", status: "Active" }
];
const workflowHistory = [
  { reporterId: "epic", reporterName: "Evan Epic", outlet: "General News", clientName: "EPIC", articleTitle: "EPIC update" },
  { reporterId: "galway", reporterName: "Gail Galway", outlet: "General News", clientName: "Galway", articleTitle: "Galway update" },
  { reporterId: "sunstar", reporterName: "Sunny Star", outlet: "General News", clientName: "Sunstar", articleTitle: "Sunstar update" }
];
const workflowFilters = { topics: ["Insurance"], similarClients: ["Galway", "Sunstar"], client: "EPIC" };
assert.deepEqual(filterReporters(insuranceWorkflow, workflowFilters, workflowHistory).map((r) => r.id), ["beat-ins", "epic", "galway", "sunstar", "outlet"], "Insurance OR EPIC OR Galway OR Sunstar includes every additive evidence path and excludes nonmatches");
assert.deepEqual(filterReporters([insuranceWorkflow[0]], workflowFilters).map((r) => r.id), ["beat-ins"], "Insurance beat qualifies with no client history");
const insuranceHistorian = { ...insuranceWorkflow[5], id: "insurance-history", firstName: "Harper", lastName: "History" };
assert.deepEqual(filterReporters([insuranceHistorian], { topics: ["Insurance"] }, [{ reporterId: insuranceHistorian.id, reporterName: "Harper History", outlet: "General News", articleTitle: "How reinsurance underwriting is changing", topics: [] }]).map((r) => r.id), ["insurance-history"], "Meaningful historical insurance coverage qualifies");
assert.deepEqual(filterReporters([insuranceHistorian], { topics: ["Insurance"] }, [{ reporterId: insuranceHistorian.id, reporterName: "Harper History", outlet: "General News", articleTitle: "A policy change affects residents", topics: [] }]), [], "Insurance word absence from structured topics and meaningful coverage phrases does not qualify");
for (const [id, name] of [["epic", "Evan Epic"], ["galway", "Gail Galway"], ["sunstar", "Sunny Star"]]) {
  assert.deepEqual(filterReporters(insuranceWorkflow.filter((r) => r.id === id), workflowFilters, workflowHistory).map((r) => r.id), [id], `${name} qualifies through historical coverage alone`);
}
assert.deepEqual(filterReporters(insuranceWorkflow.filter((r) => r.id === "miss"), workflowFilters, workflowHistory), [], "Reporter matching none of the paths is excluded");
assert.deepEqual(filterReporters([directory[0], directory[1]], { topics: ["AI", "RIA"] }).map((r) => r.id), ["ai", "wealth"], "Multiple canonical topics use OR");
assert.deepEqual(filterReporters([directory[0], directory[1]], { similarClients: ["Orion", "Envestnet"] }).map((r) => r.id), ["ai", "wealth"], "Multiple similar clients use OR");
assert.deepEqual(filterReporters([insuranceWorkflow[0], directory[5]], { topics: ["Insurance"], similarClients: ["Other Client"] }).map((r) => r.id), ["beat-ins", "unrelated"], "Topic match OR similar-client match qualifies");
assert.deepEqual(filterReporters(insuranceWorkflow, { ...workflowFilters, reporterTypes: ["podcast"] }, workflowHistory), [], "Reporter Type remains an independent narrowing filter");
assert.deepEqual(filterReporters(insuranceWorkflow, { ...workflowFilters, status: "Active" }, workflowHistory).map((r) => r.id), ["beat-ins", "epic", "galway", "outlet"], "Selected Status remains an independent hard filter");
assert.deepEqual(filterReporters(insuranceWorkflow, workflowFilters, [...workflowHistory, { reporterId: "coverage-only", reporterName: "Coverage Only", outlet: "General News", clientName: "EPIC" }, { reporterName: "n/a", outlet: "General News", clientName: "EPIC" }]).map((r) => r.id), ["beat-ins", "epic", "galway", "sunstar", "outlet"], "Coverage enriches only supplied Master Directory reporters; Coverage-only and n/a identities are excluded");
const workflowResults = filterReporters(insuranceWorkflow, workflowFilters, workflowHistory);
assert.equal(qualificationDiagnostics(workflowResults).uniqueQualifiedReporters, 5, "Qualification diagnostics count unique valid Master Directory identities");

console.log("reporter filter semantics passed");
