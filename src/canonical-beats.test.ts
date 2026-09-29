import assert from "node:assert/strict";
import {
  CANONICAL_BEATS,
  GEOGRAPHIC_RAW_VALUES,
  canonicalBeatsForRaw,
  canonicalizeRawBeats,
  hasRawBeatMappingForCanonical,
  planCanonicalBeatMigration,
  rawBeatsForCanonical
} from "../public/canonical-beats.js";

const expected = [
  "AI", "Banking", "Market Commentary", "Personal Finance", "Corporate & Business", "Economy", "Fintech", "Insurance",
  "Retirement", "Compliance", "Regulation", "RIA", "Sports", "Law", "Private Equity", "Alternative Assets"
];
assert.deepEqual(CANONICAL_BEATS, expected, "The selector vocabulary is the requested exact 16 canonical values");
for (const place of GEOGRAPHIC_RAW_VALUES) assert.equal(CANONICAL_BEATS.includes(place), false, `${place} is not a subject beat`);
assert.deepEqual(canonicalBeatsForRaw("Chicago, Illinois"), [], "Geographic raw values remain unmapped as subjects");
assert.deepEqual(canonicalBeatsForRaw("Local Business"), [], "Local Business is not part of the canonical subject taxonomy");

for (const raw of ["AI", "Generative AI"]) assert.deepEqual(canonicalBeatsForRaw(raw), ["AI"]);
assert.deepEqual(canonicalBeatsForRaw("Payments"), ["Banking", "Fintech"]);
assert.deepEqual(canonicalBeatsForRaw("Regtech"), ["Fintech", "Compliance"]);
assert.deepEqual(canonicalBeatsForRaw("Corporate Investigations"), ["Corporate & Business", "Compliance"]);
assert.deepEqual(canonicalBeatsForRaw("Commercial Real Estate"), ["Alternative Assets"]);
const addedMappings: Array<[string, string[]]> = [
  ["Advisor Technology", ["Fintech"]],
  ["Canadian Tech", ["Fintech"]],
  ["Cryptocurrency", ["Fintech"]],
  ["Family Offices", ["RIA"]],
  ["Financial Services", ["Market Commentary", "Corporate & Business"]],
  ["High-Yield Savings", ["Banking", "Personal Finance"]],
  ["Insurtech", ["Fintech", "Insurance"]],
  ["Startups", ["Corporate & Business"]],
  ["Wealth Management", ["RIA"]],
  ["Wealth Transfer", ["RIA"]]
];
for (const [rawBeat, expectedCategories] of addedMappings) {
  const actual = canonicalBeatsForRaw(rawBeat);
  assert.deepEqual(actual, expectedCategories, `${rawBeat} uses its explicit canonical mapping`);
  assert.equal(new Set(actual).size, actual.length, `${rawBeat} does not produce duplicate categories`);
}
assert.deepEqual(canonicalBeatsForRaw(["RIAs", "Financial Advisors", "Practice Management"]), ["RIA"]);
assert.deepEqual(canonicalBeatsForRaw(["Wealth Management", "Family Offices", "Wealth Transfer"]), ["RIA"]);
assert.deepEqual(canonicalBeatsForRaw(["Consumer", "Coaching"]), [], "Consumer and Coaching remain unmapped");
for (const place of GEOGRAPHIC_RAW_VALUES) assert.deepEqual(canonicalBeatsForRaw(place), [], `${place} remains unmapped`);
assert.deepEqual(canonicalBeatsForRaw("Law"), [], "Law remains selectable but has no invented raw mappings");
assert.equal(hasRawBeatMappingForCanonical("Law"), false);
assert.deepEqual(rawBeatsForCanonical("Generative AI, Insurance", "AI"), ["Generative AI"], "Classification can retain the raw beat explaining a canonical match");

const raw = "Payments, Chicago, Illinois";
assert.equal(canonicalizeRawBeats(raw), "Banking, Fintech");
assert.equal(raw, "Payments, Chicago, Illinois", "Classification never mutates the source value");

const header = ["ID", "Outlet", "Reporter First Name", "Reporter Last Name", "Email", "Reporter Type", "Clients Covered", "Beats", "Notes", "Most Recent Article", "Status"];
const plan = planCanonicalBeatMigration([header, ["1", "Outlet", "A", "B", "", "reporter", "", "Payments", "", "", "Active"], ["2", "Outlet", "C", "D", "", "reporter", "", "Chicago, Illinois", "", "", "Active"]], header);
assert.equal(plan.rowsWouldChange, 1);
assert.equal(plan.rowsWithMultipleCanonicalCategories, 1);
assert.deepEqual(plan.unmappedRawBeats, [{ value: "Chicago, Illinois", count: 1 }]);
assert.equal(plan.plannedRows[0]?.canonical, "Banking, Fintech");
console.log("canonical beat classification tests passed");
