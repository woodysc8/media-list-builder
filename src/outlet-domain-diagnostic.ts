import type { CoverageRecord, OutletRecord } from "./domain.js";
import { expectedOutletDomainsFor, matchMasterOutlet } from "./outlet-domain-matching.js";

export interface OutletDomainDiagnostic {
  totalUnresolved: number;
  matched: number;
  unmatched: number;
  matches: Array<{
    localOutlet: string;
    canonicalMasterOutlet: string;
    expectedDomains: string[];
  }>;
  unmatchedOutlets: string[];
}

/** Pure, read-only transformation for inspecting master-outlet domain coverage. */
export function diagnoseOptoUnresolvedOutletDomains(
  records: CoverageRecord[],
  outlets: OutletRecord[]
): OutletDomainDiagnostic {
  const unresolved = records.filter((record) =>
    record.clientName === "Opto" && record.urlConfidence === "unresolved"
  );
  const matches: OutletDomainDiagnostic["matches"] = [];
  const unmatchedOutlets = new Set<string>();

  for (const record of unresolved) {
    const canonical = matchMasterOutlet(record.outlet, outlets);
    const expectedDomains = expectedOutletDomainsFor(record.outlet, outlets);
    if (canonical && expectedDomains.length) {
      matches.push({
        localOutlet: record.outlet,
        canonicalMasterOutlet: canonical.name,
        expectedDomains
      });
    } else {
      unmatchedOutlets.add(record.outlet);
    }
  }

  return {
    totalUnresolved: unresolved.length,
    matched: matches.length,
    unmatched: unresolved.length - matches.length,
    matches,
    unmatchedOutlets: [...unmatchedOutlets].sort((left, right) => left.localeCompare(right))
  };
}
