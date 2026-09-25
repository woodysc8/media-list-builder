import type { CoverageStatus, CoverageType, OutletType } from "./domain.js";
import { normalizeName } from "./normalize.js";

/** PRCC Press Type is authoritative whenever it is present. */
const PRESS_TYPE_TO_COVERAGE_TYPE: Record<string, CoverageType> = {
  mediaquote: "Earned Coverage",
  mediafeature: "Earned Coverage",
  mediamention: "Earned Coverage",
  mediacommentary: "Earned Coverage",
  mediathoughtleadership: "Earned Coverage",
  mediainterview: "Earned Coverage",
  broadcast: "Earned Coverage",
  podcast: "Podcast Interview",
  podcastinterview: "Podcast Interview",
  pressrelease: "Press Release",
  pressreleasesyndication: "Press Release & Earned Coverage Syndication",
  contributedbylinearticle: "Contributed Content",
  thoughtleadership: "Contributed Content",
  missedopportunity: "Missed Opportunity",
  passed: "Missed Opportunity",
  passedopportunity: "Missed Opportunity"
};

const OUTLET_TYPE_BY_NAME: Record<string, OutletType> = {
  businesswire: "Trade Publication",
  prnewswire: "Trade Publication",
  globenewswire: "Trade Publication",
  bloomberg: "Broadcast Network",
  cnbc: "Broadcast Network",
  foxbusiness: "Broadcast Network",
  yahoo: "Consumer Publication"
};

function lookupKey(value: string): string {
  return normalizeName(value).replaceAll(" ", "");
}

export function coverageTypeFromPressType(
  pressType: string,
  fallbackCoverageType: CoverageType = "Earned Coverage"
): CoverageType {
  return PRESS_TYPE_TO_COVERAGE_TYPE[lookupKey(pressType)] ?? fallbackCoverageType;
}

/** Maps explicit workflow labels; all absent/non-workflow PRCC values are completed coverage. */
export function normalizeCoverageStatus(value: string | undefined | null): CoverageStatus {
  const normalized = normalizeName(String(value ?? ""));
  if (/hold|passed|missed/.test(normalized)) return "On Hold";
  if (/pending|planned|upcoming|scheduled|tbd/.test(normalized)) return "Pending";
  return "Completed";
}

export function classifyOutletType(
  outletName: string,
  pressType = "",
  coverageType: CoverageType = "Earned Coverage"
): { outletType: OutletType; confidence: "mapped" | "fallback" } {
  const outlet = lookupKey(outletName);
  const press = lookupKey(pressType);
  if (OUTLET_TYPE_BY_NAME[outlet]) return { outletType: OUTLET_TYPE_BY_NAME[outlet], confidence: "mapped" };
  if (/podcast/.test(press) || coverageType === "Podcast Interview" || /podcast/.test(outlet)) return { outletType: "Podcast", confidence: "mapped" };
  if (/conference|event|summit|forum|webinar/.test(press) || /conference|event|summit|forum/.test(outlet)) return { outletType: "Conference or Event", confidence: "mapped" };
  if (/broadcast|radio|television|tv/.test(press) || /radio|television|network|news/.test(outlet)) return { outletType: "Broadcast Network", confidence: "mapped" };
  if (/association|institute|council|society|federation/.test(outlet)) return { outletType: "Industry Association", confidence: "mapped" };
  if (/newsletter|digest|briefing|dailyupside/.test(outlet)) return { outletType: "Newsletter", confidence: "mapped" };
  return { outletType: "Trade Publication", confidence: "fallback" };
}

export { PRESS_TYPE_TO_COVERAGE_TYPE };
