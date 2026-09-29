import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { addAllowedSelection, availableSelections, CANONICAL_REPORTER_TYPES, removeSelection } from "./filter-selection.js";

const options = ["Insurance", "RIA", "AI"];
assert.deepEqual(CANONICAL_REPORTER_TYPES.map((item) => item.label), ["Reporter", "Influencer", "Podcast", "Broadcast TV", "Tier 1 Media"]);
let selected = addAllowedSelection(options, [], "Insurance");
assert.deepEqual(availableSelections(options, selected), ["RIA", "AI"], "Selected values leave the available options");
selected = addAllowedSelection(options, selected, "RIA");
selected = addAllowedSelection(options, selected, "AI");
assert.deepEqual(selected, ["Insurance", "RIA", "AI"], "Single-select choices can be added one after another without modifiers");
assert.deepEqual(addAllowedSelection(options, selected, "invented topic"), selected, "Values outside the option list cannot be added");
selected = removeSelection(selected, "RIA");
assert.deepEqual(availableSelections(options, selected), ["RIA"], "Removing a chip returns its value to the available options");

const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const app = await readFile(new URL("./app.js", import.meta.url), "utf8");
assert.doesNotMatch(html, /id="(?:topic-select|similar-client-select|reporter-type-select)"[^>]*\bmultiple\b/i, "Selection controls are single-select builders, not modifier-dependent native multi-selects");
assert.match(app, /data-remove-selection=/, "Selection builders expose removable chips");
assert.match(app, /removeSelection\(config\.values, button\.dataset\.selectionValue\)/, "Removing a chip rebuilds options so the value becomes available again");
console.log("filter selection builder tests passed");
