import { isValidMasterReporter, uniqueMasterReporters } from "./reporter-identity.js";
import { hasRawBeatMappingForCanonical, rawBeatsForCanonical } from "./canonical-beats.js";
export { isValidMasterReporter, uniqueMasterReporters } from "./reporter-identity.js";

const TOPIC_SYNONYMS = {
  insurance: ["insurance", "insurer", "insurers", "reinsurance", "underwriting", "property casualty", "casualty insurance", "life insurance", "health insurance", "commercial lines", "personal lines"],
  ai: ["AI", "artificial intelligence", "generative AI", "gen AI", "GenAI", "machine learning", "ML", "large language model", "LLM", "deep learning", "neural network", "natural language processing", "NLP"],
  "wealth management": ["wealth management", "wealth manager", "financial advisor", "financial advisors", "financial adviser", "financial advisers", "RIA", "RIAs", "registered investment adviser", "registered investment advisers", "registered investment advisor", "registered investment advisors", "investment advisory", "asset management", "financial planning"],
  "financial advisors": ["financial advisor", "financial advisors", "financial adviser", "financial advisers", "wealth manager", "wealth management", "RIA", "RIAs", "registered investment adviser", "registered investment advisor"],
  ria: ["RIA", "RIAs", "registered investment adviser", "registered investment advisers", "registered investment advisor", "registered investment advisors", "independent financial advisor", "independent financial advisors", "independent financial adviser", "independent financial advisers", "financial advisor", "financial advisors", "financial adviser", "financial advisers"],
  rias: ["RIA", "RIAs", "registered investment adviser", "registered investment advisers", "registered investment advisor", "registered investment advisors", "independent financial advisor", "independent financial advisors", "independent financial adviser", "independent financial advisers", "financial advisor", "financial advisors", "financial adviser", "financial advisers"],
  investments: ["investment", "investments", "investing", "investor", "investors", "portfolio management", "asset management", "securities", "capital markets"],
  investment: ["investment", "investments", "investing", "investor", "investors", "portfolio management", "asset management", "securities", "capital markets"],
  "private markets": ["private markets", "private equity", "private credit", "venture capital", "growth equity", "buyout", "alternative investments", "alternatives", "institutional investing"]
};

// Centralized outlet classification used when the directory has no explicit beat.
const INSURANCE_OUTLETS = ["business insurance", "insurance business", "insurance times", "the insurer", "reinsurance news", "propertycasualty360", "coverager", "carrier management", "insurance journal"];
const INSURANCE_COVERAGE_TERMS = ["insurance industry", "insurance market", "insurance coverage", "insurance company", "insurer", "underwriting", "reinsurance", "property casualty", "claims management", "insurance broker"];
function insuranceOutlet(reporter) {
  const outlet = normalized(reporter.outlet);
  return INSURANCE_OUTLETS.some((name) => outlet === normalized(name) || outlet.includes(normalized(name)));
}

export const MEDIA_LIST_HEADERS = ["Owner/Date Pitched", "Outlet", "Reporter First Name", "Reporter Last Name", "Email", "Reporter Type", "Clients Covered", "Profile", "Notes"];

export function formatReporterSearchSummary(masterCount, filters = {}, resultCount = 0) {
  const active = [];
  const reporterTypes = filters.reporterTypes ?? [];
  if (reporterTypes.length) {
    const labels = { reporter: "Reporter", influencer: "Influencer", podcast: "Podcast", "broadcast tv": "Broadcast TV", "tier 1 media": "Tier 1 Media" };
    active.push(`Reporter Type: ${reporterTypes.map((type) => labels[type] ?? type).join(", ")}`);
  }
  const status = String(filters.status ?? "").trim();
  if (status && status.toLocaleLowerCase() !== "all") active.push(`Status: ${status}`);
  if ((filters.topics ?? []).length) active.push(`Topics: ${filters.topics.join(", ")}`);
  if ((filters.similarClients ?? []).length) active.push(`Similar Clients: ${filters.similarClients.join(", ")}`);
  return [
    `Master Directory: ${masterCount} reporters`,
    ...(active.length ? active : ["Filters: None"]),
    `Relevant reporters: ${resultCount}`
  ].join("\n");
}

function normalized(value) {
  return String(value ?? "").toLocaleLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function normalizedClientName(value) { return String(value ?? "").toLocaleLowerCase().trim().replace(/\s+/g, " "); }
function normalizedReporterType(value) {
  return String(value ?? "").toLocaleLowerCase().trim().replace(/\s+/g, " ");
}
function includesTerm(haystack, term) {
  const normalizedHaystack = ` ${normalized(haystack)} `;
  const normalizedTerm = ` ${normalized(term)} `;
  return normalizedTerm.trim() !== "" && normalizedHaystack.includes(normalizedTerm);
}
function isPlaceholder(value) {
  const cleaned = String(value ?? "").trim().toLocaleLowerCase().replace(/[.]/g, "");
  return !cleaned || ["n/a", "na", "not available", "unknown", "unassigned", "null", "none", "tbd", "-"].includes(cleaned);
}
function hasMalformedMixedScriptToken(value) {
  return String(value ?? "").split(/\s+/).some((token) => /\p{Script=Latin}/u.test(token) && /\p{Script=Han}/u.test(token));
}
function validCoverageIdentity(record) {
  const name = String(record?.reporterName ?? "").trim();
  return !isPlaceholder(name) && /\p{L}/u.test(name) && !hasMalformedMixedScriptToken(name);
}
function reporterIdentity(reporter) {
  return normalized(`${reporter.firstName ?? ""} ${reporter.lastName ?? ""}`);
}

// Attach coverage to existing directory IDs. A supplied but unknown ID is
// authoritative and is never re-associated by name. Name/outlet fallback is
// allowed only for records with no reporter ID and an unambiguous valid identity.
export function buildReporterCoverageIndex(directory, coverageRecords = []) {
  const reporters = uniqueMasterReporters(directory);
  const byId = new Map(reporters.map((reporter) => [String(reporter.id).trim(), reporter]));
  const byIdentity = new Map();
  for (const reporter of reporters) {
    const key = `${reporterIdentity(reporter)}|${normalized(reporter.outlet)}`;
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(reporter);
  }
  const index = new Map(reporters.map((reporter) => [String(reporter.id).trim(), []]));
  let linked = 0;
  let withoutIdentity = 0;
  let unlinked = 0;
  for (const record of coverageRecords) {
    const suppliedId = String(record?.reporterId ?? "").trim();
    let target = suppliedId ? byId.get(suppliedId) : null;
    if (!suppliedId && validCoverageIdentity(record)) {
      const matches = byIdentity.get(`${normalized(record.reporterName)}|${normalized(record.outlet)}`) ?? [];
      if (matches.length === 1) target = matches[0];
    }
    if (!validCoverageIdentity(record)) withoutIdentity++;
    if (target) {
      index.get(String(target.id).trim()).push(record);
      linked++;
    } else unlinked++;
  }
  return {
    index,
    diagnostics: {
      masterDirectory: directory.length,
      validMasterIdentities: reporters.length,
      invalidMasterIdentities: directory.filter((reporter) => !isValidMasterReporter(reporter)).length,
      duplicateMasterIds: Math.max(0, directory.filter(isValidMasterReporter).length - reporters.length),
      coverageRecords: coverageRecords.length,
      coverageLinkedToMasterReporters: linked,
      coverageWithoutReporterIdentity: withoutIdentity,
      coverageUnlinkedOrAmbiguous: unlinked
    }
  };
}

export function topicMatches(evidence, selectedTopic) {
  const canonical = normalized(selectedTopic);
  if (!canonical) return false;
  const aliases = TOPIC_SYNONYMS[canonical] ?? [selectedTopic];
  return aliases.some((alias) => includesTerm(evidence, alias));
}

function reporterCoverage(reporter, coverageRecords) {
  const directory = [reporter];
  return buildReporterCoverageIndex(directory, coverageRecords).index.get(String(reporter.id).trim()) ?? [];
}

export function reporterRelevance(reporter, filters = {}, coverageRecords = []) {
  if (!isValidMasterReporter(reporter)) return [];
  const topics = (filters.topics ?? []).filter((topic) => normalized(topic));
  const similarClients = (filters.similarClients ?? []).map(normalizedClientName).filter(Boolean);
  const history = reporterCoverage(reporter, coverageRecords);
  const reasons = new Set();
  const pitchClient = normalizedClientName(filters.client);
  for (const topic of topics) {
    if (!hasRawBeatMappingForCanonical(topic)) continue;
    const rawBeatEvidence = rawBeatsForCanonical(reporter.beats, topic);
    if (rawBeatEvidence.length) reasons.add(`${topic}: Master Directory Beats (${rawBeatEvidence.join(", ")})`);
    if (topicMatches(reporter.notes, topic)) reasons.add(`${topic}: Notes`);
    const topicHistory = history.filter((record) => {
      const structured = (record.topics ?? []).join(" ");
      if (topicMatches(structured, topic)) return true;
      const evidence = `${record.articleTitle ?? ""} ${record.outlet ?? ""}`.toLocaleLowerCase();
      if (normalized(topic) !== "insurance") return topicMatches(`${structured} ${record.articleTitle ?? ""}`, topic);
      return INSURANCE_COVERAGE_TERMS.some((term) => includesTerm(evidence, term));
    });
    if (topicHistory.length) {
      const examples = topicHistory.slice(0, 2).map((record) => record.articleTitle).filter(Boolean).join("; ");
      reasons.add(`${topic}: historical coverage (${topicHistory.length} ${topicHistory.length === 1 ? "match" : "matches"}${examples ? `; e.g. ${examples}` : ""})`);
    }
  }
  const clientsCovered = String(reporter.clientsCovered ?? "").split(/[,;|]/);
  for (const similarClient of similarClients) {
    const label = (filters.similarClients ?? []).find((client) => normalizedClientName(client) === similarClient) ?? similarClient;
    if (clientsCovered.some((covered) => includesTerm(covered, similarClient))) reasons.add(`Similar client: ${label} (Clients Covered)`);
    const clientHistory = history.filter((record) => includesTerm(record.clientName, similarClient));
    if (clientHistory.length) {
      const examples = clientHistory.slice(0, 2).map((record) => record.articleTitle).filter(Boolean).join("; ");
      reasons.add(`Similar client: ${label} (historical coverage, ${clientHistory.length} ${clientHistory.length === 1 ? "record" : "records"}${examples ? `; e.g. ${examples}` : ""})`);
    }
  }
  if (pitchClient) {
    const label = String(filters.client).trim();
    if (String(reporter.clientsCovered ?? "").split(/[,;|]/).some((name) => includesTerm(name, pitchClient))) reasons.add(`Pitch client: ${label} (Clients Covered)`);
    const matches = history.filter((record) => includesTerm(record.clientName, pitchClient));
    if (matches.length) reasons.add(`Pitch client: ${label} (historical coverage, ${matches.length} ${matches.length === 1 ? "record" : "records"})`);
  }
  if (topics.some((topic) => normalized(topic) === "insurance") && insuranceOutlet(reporter)) reasons.add("Insurance: Outlet evidence");
  if (!topics.length && !similarClients.length) reasons.add("No relevance filters selected");
  return [...reasons];
}

export function reporterQualifies(reporter, filters = {}, coverageRecords = []) {
  if (!isValidMasterReporter(reporter)) return false;
  const reporterTypes = (filters.reporterTypes ?? []).map(normalizedReporterType);
  if (reporterTypes.length && !reporterTypes.includes(normalizedReporterType(reporter.reporterType))) return false;
  const selectedStatus = normalized(filters.status);
  if (selectedStatus && selectedStatus !== "all" && normalized(reporter.status) !== selectedStatus) return false;
  return reporterRelevance(reporter, filters, coverageRecords).length > 0;
}

export function filterReporters(reporters, filters = {}, coverageRecords = []) {
  return uniqueMasterReporters(reporters).flatMap((reporter) => {
    const reporterTypes = (filters.reporterTypes ?? []).map(normalizedReporterType);
    if (reporterTypes.length && !reporterTypes.includes(normalizedReporterType(reporter.reporterType))) return [];
    const selectedStatus = normalized(filters.status);
    if (selectedStatus && selectedStatus !== "all" && normalized(reporter.status) !== selectedStatus) return [];
    const whyRelevant = reporterRelevance(reporter, filters, coverageRecords);
    return whyRelevant.length ? [{ ...reporter, whyRelevant }] : [];
  });
}

export function qualificationDiagnostics(results = []) {
  const counts = { "Insurance beat": 0, "Insurance coverage": 0, "Insurance outlet": 0 };
  let multiplePaths = 0;
  for (const reporter of uniqueMasterReporters(results)) {
    const evidence = reporter.whyRelevant ?? [];
    const matched = new Set();
    for (const reason of evidence) {
      if (/^Insurance: Master Directory Beats|^Insurance: Beats/i.test(reason)) matched.add("Insurance beat");
      if (/^Insurance: historical coverage/i.test(reason)) matched.add("Insurance coverage");
      if (/^Pitch client:/i.test(reason)) matched.add(reason.match(/^Pitch client: ([^(]+)/i)?.[1].trim() + " coverage");
      if (/^Similar client:/i.test(reason)) matched.add(reason.match(/^Similar client: ([^(]+)/i)?.[1].trim() + " coverage");
      if (/^Insurance: Outlet evidence/i.test(reason)) matched.add("Insurance outlet");
    }
    for (const path of matched) counts[path] = (counts[path] ?? 0) + 1;
    if (matched.size > 1) multiplePaths++;
  }
  return { uniqueQualifiedReporters: uniqueMasterReporters(results).length, counts, multiplePaths };
}

// Rehydrate editable list rows from Master Directory records, dropping any
// unknown/Coverage-only IDs and preserving authoritative directory fields.
export function sanitizeMediaList(items = [], directory = []) {
  const masters = uniqueMasterReporters(directory);
  const byId = new Map(masters.map((reporter) => [String(reporter.id).trim(), reporter]));
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const id = String(item?.id ?? "").trim();
    const master = byId.get(id);
    if (!master || seen.has(id)) continue;
    seen.add(id);
    result.push({ ...item, ...master, id, ownerDatePitched: item.ownerDatePitched ?? "", profile: item.profile ?? "" });
  }
  return result;
}

export function buildMediaListRows(items = [], directory = []) {
  const sanitized = sanitizeMediaList(items, directory);
  return sanitized.map((person) => [person.ownerDatePitched, person.outlet, person.firstName, person.lastName, person.email, person.reporterType, person.clientsCovered, person.profile, person.notes].map((value) => String(value ?? "")));
}
