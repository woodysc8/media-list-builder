import assert from "node:assert/strict";
import { matchClient } from "./matching.js";
import { parseInput } from "./parser.js";
import type { ClientRecord } from "./domain.js";

const parsed = parseInput(
  [
    "Press Type,Date,Publication,UVM,Reporter,Spokesperson,Link",
    "Newsletter Inclusion,1/22/2026,InvestmentNews,N/A,Steve Randall,N/A,Newsletter mention"
  ].join("\n"),
  "Wealth PR Campaign Calendar 9.30.26.xlsx - 2026 Media Placements.csv"
);

assert.equal(parsed.items.length, 1);
assert.equal(parsed.items[0]?.clientName, "Wealth.com");

const clients: ClientRecord[] = [
  { id: "CLI-wealth", name: "Wealth.com", aliases: [] },
  { id: "CLI-falcon", name: "Falcon Wealth", aliases: [] },
  { id: "CLI-geo", name: "GeoWealth", aliases: [] },
  { id: "CLI-savvy", name: "Savvy Wealth", aliases: [] },
  { id: "CLI-reach", name: "WealthReach", aliases: [] }
];
const match = matchClient(parsed.items[0]!.clientName, clients);
assert.equal(match.ambiguous, false);
assert.equal(match.value?.id, "CLI-wealth");
assert.equal(match.value?.name, "Wealth.com");

console.log("PRCC filename client mapping tests passed");
