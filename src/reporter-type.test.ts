import assert from "node:assert/strict";
import { normalizeReporterType } from "./domain.js";

assert.equal(normalizeReporterType("Reporter"), "reporter");
assert.equal(normalizeReporterType("Podcast"), "podcast");
assert.equal(normalizeReporterType("Broadcast TV"), "broadcast tv");
assert.equal(normalizeReporterType("Broadcast Radio"), "broadcast radio");
assert.equal(normalizeReporterType("Newsletter"), "newsletter");
assert.equal(normalizeReporterType("Influencer"), "influencer");

console.log("reporter type normalization tests passed");
