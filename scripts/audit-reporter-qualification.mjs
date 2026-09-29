// Read-only diagnostic for the Insurance / EPIC / Galway / Sunstar workflow.
// Run from the repository root: node scripts/audit-reporter-qualification.mjs
import fs from "node:fs";
import { buildReporterCoverageIndex, filterReporters, isValidMasterReporter, reporterRelevance, topicMatches, uniqueMasterReporters } from "../public/reporter-filter.js";

const store = JSON.parse(fs.readFileSync("data/store.json", "utf8"));
const directory = uniqueMasterReporters(store.reporters ?? []);
const coverage = store.coverage ?? [];
const filters = { topics: ["Insurance"], similarClients: ["Galway", "Sunstar"], client: "EPIC" };
const actualResults = filterReporters(directory, filters, coverage);
const actualById = new Map(actualResults.map((reporter) => [String(reporter.id), reporter]));
const { index: coverageById, diagnostics: linkDiagnostics } = buildReporterCoverageIndex(directory, coverage);
const normalized = (value) => String(value ?? "").toLocaleLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const includes = (haystack, term) => (` ${normalized(haystack)} `).includes(` ${normalized(term)} `);
const insuranceTerms = ["insurance industry", "insurance market", "insurance coverage", "insurance company", "insurer", "underwriting", "reinsurance", "property casualty", "claims management", "insurance broker"];
const clientTargets = ["EPIC", "Galway", "Sunstar"];
const coverageClientMatch = (records, target) => records.filter((record) => includes(record.clientName, target));
const beatInsuranceMatch = (reporter) => topicMatches(reporter.beats, "Insurance");
const insuranceHistoryMatch = (records) => records.filter((record) => topicMatches((record.topics ?? []).join(" "), "Insurance") || insuranceTerms.some((term) => includes(`${record.articleTitle ?? ""} ${record.outlet ?? ""}`, term)));
const actualOutletMatch = (reporter) => (actualById.get(String(reporter.id))?.whyRelevant ?? []).includes("Insurance: Outlet evidence");
const actualInsuranceHistoryMatch = (reporter) => (actualById.get(String(reporter.id))?.whyRelevant ?? []).some((reason) => reason.startsWith("Insurance: historical coverage"));
const hasHistoricalMatch = (reporter, target) => coverageClientMatch(coverageById.get(String(reporter.id)) ?? [], target).length > 0;

const counts = {
  insuranceBeat: 0, insuranceHistoricalCoverage: 0, insuranceOutlet: 0,
  epicCoverage: 0, galwayCoverage: 0, sunstarCoverage: 0,
  epicDirectoryClientsCoveredOnly: 0, galwayDirectoryClientsCoveredOnly: 0, sunstarDirectoryClientsCoveredOnly: 0,
  multipleEvidencePaths: 0, noQualifyingEvidence: 0, actualQualified: actualResults.length,
  intendedHistoricalOrTopicUnion: 0
};
const excluded = [];
const nearGaps = { unlinkedNamedCoverage: [], outletCandidates: [], beatCandidates: [], clientNameCandidates: [] };
const clientsCoveredMatches = (reporter, target) => String(reporter.clientsCovered ?? "").split(/[,;|]/).filter((client) => includes(client, target)).length > 0;

for (const reporter of directory) {
  const id = String(reporter.id).trim();
  const records = coverageById.get(id) ?? [];
  const reasons = reporterRelevance(reporter, filters, coverage);
  const isActual = actualById.has(id);
  const insuranceBeat = beatInsuranceMatch(reporter);
  const insuranceCoverage = actualInsuranceHistoryMatch(reporter);
  const outlet = actualOutletMatch(reporter);
  const clientHist = Object.fromEntries(clientTargets.map((target) => [target, hasHistoricalMatch(reporter, target)]));
  const clientDirectory = Object.fromEntries(clientTargets.map((target) => [target, clientsCoveredMatches(reporter, target)]));
  const paths = [insuranceBeat, insuranceCoverage, outlet, ...clientTargets.map((target) => clientHist[target])].filter(Boolean).length;
  const intended = insuranceBeat || insuranceCoverage || outlet || Object.values(clientHist).some(Boolean);
  if (insuranceBeat) counts.insuranceBeat++;
  if (insuranceCoverage) counts.insuranceHistoricalCoverage++;
  if (outlet) counts.insuranceOutlet++;
  for (const target of clientTargets) {
    if (clientHist[target]) counts[`${target.toLocaleLowerCase()}Coverage`]++;
    else if (clientDirectory[target]) counts[`${target.toLocaleLowerCase()}DirectoryClientsCoveredOnly`]++;
  }
  if (paths > 1) counts.multipleEvidencePaths++;
  if (intended) counts.intendedHistoricalOrTopicUnion++;
  if (!isActual) {
    const reasonsMissing = [];
    if (!insuranceBeat) reasonsMissing.push("no Insurance beat match");
    if (!insuranceCoverage) reasonsMissing.push("no linked meaningful Insurance coverage");
    if (!outlet) reasonsMissing.push("outlet not in current insurance classification");
    for (const target of clientTargets) if (!clientHist[target]) reasonsMissing.push(`no linked ${target} historical coverage`);
    if (reasonsMissing.length === 6) counts.noQualifyingEvidence++;
    excluded.push({ reporter, records, reasonsMissing, clientHist, clientDirectory });
  }
}

// Compare unlinked named-client Coverage records against directory identities
// without changing the authoritative link policy. A supplied unknown ID is
// called out separately because the linker intentionally treats it as final.
const directoryByName = new Map();
for (const reporter of directory) {
  const key = normalized(`${reporter.firstName} ${reporter.lastName}`);
  if (!directoryByName.has(key)) directoryByName.set(key, []);
  directoryByName.get(key).push(reporter);
}
const directoryNames = directory.map((reporter) => ({ reporter, key: normalized(`${reporter.firstName} ${reporter.lastName}`) }));
for (const record of coverage) {
  const supplied = String(record.reporterId ?? "").trim();
  if (supplied && coverageById.has(supplied)) continue;
  const key = normalized(record.reporterName);
  let candidates = directoryByName.get(key) ?? [];
  let matchKind = candidates.length ? "normalized name equals" : "";
  if (!candidates.length && key) {
    const recordTokens = new Set(key.split(" "));
    const scored = directoryNames.map(({ reporter, key: masterKey }) => {
      const masterTokens = new Set(masterKey.split(" "));
      const shared = [...recordTokens].filter((token) => token.length > 1 && masterTokens.has(token)).length;
      return { reporter, shared, score: shared / Math.max(recordTokens.size, masterTokens.size, 1) };
    }).filter((item) => item.shared >= 2 && item.score >= 0.66).sort((a, b) => b.score - a.score);
    if (scored.length) { candidates = scored.filter((item) => item.score === scored[0].score).map((item) => item.reporter); matchKind = "similar normalized name"; }
  }
  if (candidates.length) {
    for (const reporter of candidates.slice(0, 3)) {
      nearGaps.unlinkedNamedCoverage.push({ reporter: `${reporter.firstName} ${reporter.lastName}`, outlet: reporter.outlet, reporterBeats: reporter.beats, recordReporter: record.reporterName, recordOutlet: record.outlet, recordClient: record.clientName, title: record.articleTitle, suppliedReporterId: supplied || null, matchKind, reason: supplied ? "Coverage record has an unknown reporterId; name appears to correspond to this Master Directory identity" : "Coverage record did not link by exact normalized reporter name and outlet" });
    }
  }
}

const outletTerms = /insurance|insur|reinsur|underwrit|carrier|casualty|risk|claims|brokerage/i;
for (const item of excluded) {
  const { reporter, records } = item;
  const outlet = String(reporter.outlet ?? "");
  if (outletTerms.test(outlet) && !actualOutletMatch(reporter)) nearGaps.outletCandidates.push({ reporter: `${reporter.firstName} ${reporter.lastName}`, outlet, beats: reporter.beats, clientsCovered: reporter.clientsCovered, reason: "Outlet name looks insurance-adjacent but is absent from the centralized classification" });
  if (/insur|underwrit|reinsur|casualty|commercial lines|personal lines/i.test(String(reporter.beats ?? "")) && !beatInsuranceMatch(reporter)) nearGaps.beatCandidates.push({ reporter: `${reporter.firstName} ${reporter.lastName}`, outlet, beats: reporter.beats, reason: "Beat contains an insurance-adjacent variant not matched by the current normalized topic aliases" });
  const topicHistory = insuranceHistoryMatch(records);
  if (topicHistory.length && !actualInsuranceHistoryMatch(reporter)) nearGaps.clientNameCandidates.push({ reporter: `${reporter.firstName} ${reporter.lastName}`, outlet, beats: reporter.beats, client: topicHistory[0].clientName, title: topicHistory[0].articleTitle, reason: "Linked Coverage looks insurance-relevant under the audit phrase scan but is not accepted by reporterRelevance" });
}

// Client-name normalization candidates: linked history differs from the
// target by edit-light punctuation/token variation, or stored client value is
// an alias whose canonical name is one of the selected clients.
for (const reporter of directory) {
  if (actualById.has(String(reporter.id))) continue;
  for (const record of coverageById.get(String(reporter.id)) ?? []) {
    const raw = normalized(record.clientName);
    for (const target of clientTargets) {
      const targetNorm = normalized(target);
      if (raw && raw !== targetNorm && (raw.includes(targetNorm) || targetNorm.includes(raw)) && raw.replace(/\s/g, "") === targetNorm.replace(/\s/g, "")) {
        nearGaps.clientNameCandidates.push({ reporter: `${reporter.firstName} ${reporter.lastName}`, outlet: reporter.outlet, beats: reporter.beats, recordClient: record.clientName, target, title: record.articleTitle, reason: "Client value differs only by spacing/punctuation after loose normalization" });
      }
    }
  }
}

const pathCounts = {
  "Insurance beat": counts.insuranceBeat,
  "Insurance historical coverage": counts.insuranceHistoricalCoverage,
  "Insurance outlet classification": counts.insuranceOutlet,
  "EPIC coverage": counts.epicCoverage,
  "Galway coverage": counts.galwayCoverage,
  "Sunstar coverage": counts.sunstarCoverage,
  "Multiple evidence paths": counts.multipleEvidencePaths,
  "No qualifying evidence": counts.noQualifyingEvidence,
  "Total unique qualified (current filter)": counts.actualQualified,
  "Total qualifying by stated historical/topic paths": counts.intendedHistoricalOrTopicUnion,
  "Total valid Master Directory reporters": directory.length
};
const exactIdentityUnlinked = nearGaps.unlinkedNamedCoverage.filter((row) => row.matchKind === "normalized name equals");
const outletMismatchUnlinked = exactIdentityUnlinked.filter((row) => normalized(row.recordOutlet) !== normalized(row.outlet));
const unknownIdWithExactIdentity = exactIdentityUnlinked.filter((row) => row.suppliedReporterId);
const topExclusionOutlets = new Map();
for (const { reporter } of excluded) topExclusionOutlets.set(reporter.outlet || "(blank outlet)", (topExclusionOutlets.get(reporter.outlet || "(blank outlet)") ?? 0) + 1);
const examples = (rows, limit = 6) => rows.slice(0, limit);
console.log(JSON.stringify({
  query: filters,
  summary: pathCounts,
  overlappingEvidence: "Evidence path counts overlap and must not be summed; unique qualified is the reporter union.",
  currentFilterDirectoryOnlyEvidencePaths: {
    "EPIC Clients Covered without EPIC Coverage": counts.epicDirectoryClientsCoveredOnly,
    "Galway Clients Covered without Galway Coverage": counts.galwayDirectoryClientsCoveredOnly,
    "Sunstar Clients Covered without Sunstar Coverage": counts.sunstarDirectoryClientsCoveredOnly
  },
  excludedCount: excluded.length,
  exclusionReasonCounts: {
    "no Insurance beat": excluded.filter(({ reporter }) => !beatInsuranceMatch(reporter)).length,
    "no insurance historical coverage": excluded.filter(({ reporter }) => !actualInsuranceHistoryMatch(reporter)).length,
    "outlet not classified as insurance": excluded.filter(({ reporter }) => !actualOutletMatch(reporter)).length,
    "no EPIC coverage": excluded.filter(({ clientHist }) => !clientHist.EPIC).length,
    "no Galway coverage": excluded.filter(({ clientHist }) => !clientHist.Galway).length,
    "no Sunstar coverage": excluded.filter(({ clientHist }) => !clientHist.Sunstar).length,
    "no qualifying evidence at all": counts.noQualifyingEvidence
  },
  coverageLinking: {
    ...linkDiagnostics,
    unlinkedNamedRecordsWithPossibleMasterReporterMatch: nearGaps.unlinkedNamedCoverage.length,
    exactNormalizedReporterNameMatches: exactIdentityUnlinked.length,
    exactNameButDifferentNormalizedOutlet: outletMismatchUnlinked.length,
    exactNameWithUnknownSuppliedReporterId: unknownIdWithExactIdentity.length,
    selectedClientRelevantUnlinkedRecordsThatResembleMasterReporter: nearGaps.unlinkedNamedCoverage.filter((row) => clientTargets.some((target) => includes(row.recordClient, target))).length,
    exactOutletMismatchExamples: examples(outletMismatchUnlinked),
    exactNameUnknownIdExamples: examples(unknownIdWithExactIdentity),
    selectedClientExamples: examples(nearGaps.unlinkedNamedCoverage.filter((row) => clientTargets.some((target) => includes(row.recordClient, target)))),
    generalExamples: examples(nearGaps.unlinkedNamedCoverage)
  },
  likelyDataHandlingOrClassificationGaps: {
    outletNormalizationOrClassification: { count: nearGaps.outletCandidates.length, examples: examples(nearGaps.outletCandidates) },
    insuranceBeatNormalization: { count: nearGaps.beatCandidates.length, examples: examples(nearGaps.beatCandidates) },
    insuranceHistoryEvidenceDisagreement: { count: nearGaps.clientNameCandidates.length, examples: examples(nearGaps.clientNameCandidates) },
    clientNameNormalization: { count: nearGaps.clientNameCandidates.filter((row) => row.target).length, examples: examples(nearGaps.clientNameCandidates.filter((row) => row.target)) }
  },
  largestExcludedOutlets: [...topExclusionOutlets].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([outlet, count]) => ({ outlet, count })),
  excludedReporterExamples: examples(excluded.map(({ reporter, records, reasonsMissing }) => ({
    reporter: `${reporter.firstName} ${reporter.lastName}`, outlet: reporter.outlet, beats: reporter.beats,
    clientsCovered: reporter.clientsCovered, recentLinkedCoverage: records.slice(0, 2).map(({ clientName, articleTitle, outlet }) => ({ clientName, title: articleTitle, outlet })),
    exactExclusionReason: reasonsMissing.join("; ")
  })), 8),
  invalidDirectoryIdentitiesExcluded: (store.reporters ?? []).filter((reporter) => !isValidMasterReporter(reporter)).length
}, null, 2));
