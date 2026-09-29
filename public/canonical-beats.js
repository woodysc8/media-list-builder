export const CANONICAL_BEATS = [
  "AI",
  "Banking",
  "Market Commentary",
  "Personal Finance",
  "Corporate & Business",
  "Economy",
  "Fintech",
  "Insurance",
  "Retirement",
  "Compliance",
  "Regulation",
  "RIA",
  "Sports",
  "Law",
  "Private Equity",
  "Alternative Assets"
];

// Geographic directory values are intentionally retained as raw data but are
// not subjects and therefore never appear in the Topics / Beats selector.
export const GEOGRAPHIC_RAW_VALUES = [
  "Chicago, Illinois",
  "Cleveland, Ohio",
  "Dallas, Texas",
  "Jacksonville, Florida",
  "Los Angeles, California",
  "Miami, Florida",
  "New York, New York",
  "Philadelphia, Pennsylvania",
  "San Francisco, California",
  "St. Louis, Missouri",
  "St. Petersburg, Florida",
  "Tampa, Florida",
  "Washington, District of Columbia"
];

const RAW_TO_CANONICAL = {
  "AI": ["AI"],
  "Generative AI": ["AI"],

  "Banking": ["Banking"],
  "Private Banking": ["Banking"],
  "Brokerages": ["Banking"],
  "Loans": ["Banking"],
  "Mortgages": ["Banking"],
  "Credit Cards": ["Banking"],
  "High-Yield Savings": ["Personal Finance", "Banking"],
  "Payments": ["Banking", "Fintech"],

  "Stocks": ["Market Commentary"],
  "Bonds": ["Market Commentary"],
  "ETFs": ["Market Commentary"],
  "Investing": ["Market Commentary"],
  "Investments": ["Market Commentary"],
  "Asset Management": ["Market Commentary"],
  "Institutional Investments": ["Market Commentary"],
  "Wall Street": ["Market Commentary"],
  "Markets & Economy": ["Market Commentary"],
  "Financial Services": ["Corporate & Business", "Market Commentary"],

  "Personal Finance": ["Personal Finance"],
  "Financial Education": ["Personal Finance"],
  "Financial Planning": ["Personal Finance"],
  "Tax": ["Personal Finance"],
  "Tax Planning": ["Personal Finance"],
  "Financial Advice": ["Personal Finance"],

  "B2B": ["Corporate & Business"],
  "Business": ["Corporate & Business"],
  "Business Intelligence": ["Corporate & Business"],
  "Corporate Investigations": ["Corporate & Business", "Compliance"],
  "Economic Development": ["Corporate & Business"],
  "Entrepreneurship": ["Corporate & Business"],
  "General Business": ["Corporate & Business"],
  "Industry": ["Corporate & Business"],
  "Leadership": ["Corporate & Business"],
  "Marketing": ["Corporate & Business"],
  "Productivity": ["Corporate & Business"],
  "Small Business": ["Corporate & Business"],
  "Workforce": ["Corporate & Business"],
  "Human Resources": ["Corporate & Business"],
  "New Hires": ["Corporate & Business"],
  "People Moves": ["Corporate & Business"],
  "Startups": ["Corporate & Business"],

  "Macroeconomics": ["Economy"],
  "Federal Reserve": ["Economy"],
  "Finance and Business": ["Economy"],

  "Fintech": ["Fintech"],
  "Advisor Technology": ["Fintech"],
  "Canadian Fintech": ["Fintech"],
  "Canadian Tech": ["Fintech"],
  "Cryptocurrency": ["Fintech"],
  "Regtech": ["Fintech", "Compliance"],
  "Software": ["Fintech"],
  "Cloud": ["Fintech"],
  "Enterprise Technology": ["Fintech"],
  "IT": ["Fintech"],
  "IT Leadership": ["Fintech"],
  "Technology": ["Fintech"],
  "Wealthtech": ["Fintech"],
  "Insurtech": ["Insurance", "Fintech"],

  "Insurance": ["Insurance"],
  "Commercial Insurance": ["Insurance"],
  "Reinsurance": ["Insurance"],
  "Protection": ["Insurance"],
  "Risk Management": ["Insurance"],
  "Climate Risk": ["Insurance"],

  "Retirement": ["Retirement"],
  "Pensions": ["Retirement"],
  "Employee Benefits": ["Retirement"],

  "Regulation & Compliance": ["Compliance"],
  "Regulation": ["Regulation"],

  "RIAs": ["RIA"],
  "Financial Advisors": ["RIA"],
  "Practice Management": ["RIA"],
  "Family Offices": ["RIA"],
  "Wealth Management": ["RIA"],
  "Wealth Transfer": ["RIA"],

  "Sports": ["Sports"],
  "Private Equity": ["Private Equity"],
  "M&A": ["Private Equity"],
  "Alternative Investments": ["Alternative Assets"],
  "Venture Capital": ["Alternative Assets"],
  "Commercial Real Estate": ["Alternative Assets"],
  "Real Estate": ["Alternative Assets"]
};

export function normalizeRawBeat(value) {
  return String(value ?? "").trim().toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const MAPPING_BY_NORMALIZED_RAW = new Map(
  Object.entries(RAW_TO_CANONICAL).map(([raw, canonical]) => [normalizeRawBeat(raw), canonical])
);

function mappingForRawBeat(raw) {
  const key = normalizeRawBeat(raw);
  const directCanonical = CANONICAL_BEATS.find((beat) => beat !== "Law" && normalizeRawBeat(beat) === key);
  return directCanonical ? [directCanonical] : MAPPING_BY_NORMALIZED_RAW.get(key) ?? [];
}

export function splitRawBeats(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    let protectedValue = String(item ?? "");
    const protectedGeography = [];
    for (const place of GEOGRAPHIC_RAW_VALUES) {
      const expression = new RegExp(place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
      protectedValue = protectedValue.replace(expression, (match) => {
        const token = `__GEOGRAPHY_${protectedGeography.length}__`;
        protectedGeography.push(match);
        return token;
      });
    }
    return protectedValue.split(/[,;|\n]+/).map((beat) => beat.trim()).filter(Boolean).map((beat) => {
      const place = beat.match(/^__GEOGRAPHY_(\d+)__$/);
      return place ? protectedGeography[Number(place[1])] : beat;
    });
  });
}

export function canonicalBeatsForRaw(value) {
  const categories = new Set();
  for (const raw of splitRawBeats(value)) {
    for (const category of mappingForRawBeat(raw)) categories.add(category);
  }
  return CANONICAL_BEATS.filter((beat) => categories.has(beat));
}

export function rawBeatsForCanonical(value, selectedCanonicalBeat) {
  const selected = CANONICAL_BEATS.find((beat) => normalizeRawBeat(beat) === normalizeRawBeat(selectedCanonicalBeat));
  if (!selected) return [];
  return splitRawBeats(value).filter((raw) => MAPPING_BY_NORMALIZED_RAW.get(normalizeRawBeat(raw))?.includes(selected));
}

export function hasRawBeatMappingForCanonical(selectedCanonicalBeat) {
  const selected = CANONICAL_BEATS.find((beat) => normalizeRawBeat(beat) === normalizeRawBeat(selectedCanonicalBeat));
  return Boolean(selected && Object.values(RAW_TO_CANONICAL).some((categories) => categories.includes(selected)));
}

export function canonicalizeRawBeats(value) {
  return canonicalBeatsForRaw(value).join(", ");
}

export function planCanonicalBeatMigration(rows, header) {
  const beatsIndex = header.findIndex((item) => String(item ?? "").trim().toLowerCase() === "beats");
  const originalIndex = header.findIndex((item) => String(item ?? "").trim().toLowerCase() === "original beats");
  if (beatsIndex < 0) throw new Error("Master Directory header row does not contain a Beats column");

  const rawCounts = new Map();
  let rowsWithBeats = 0;
  let rowsWouldChange = 0;
  let rowsWithMultipleCanonicalCategories = 0;
  let rowsWithoutCanonicalMapping = 0;
  const plannedRows = [];

  rows.slice(1).forEach((row, index) => {
    const raw = String(row[beatsIndex] ?? "").trim();
    if (!raw) return;
    rowsWithBeats++;
    const tokens = splitRawBeats(raw);
    const canonical = canonicalBeatsForRaw(tokens);
    for (const token of tokens) {
      if (!mappingForRawBeat(token).length) rawCounts.set(token, (rawCounts.get(token) ?? 0) + 1);
    }
    if (!canonical.length) {
      rowsWithoutCanonicalMapping++;
      return;
    }
    if (canonical.length > 1) rowsWithMultipleCanonicalCategories++;
    const value = canonical.join(", ");
    const original = originalIndex >= 0 ? String(row[originalIndex] ?? "").trim() : "";
    const preserveOriginal = !original;
    const changeBeats = raw !== value;
    if (changeBeats) rowsWouldChange++;
    plannedRows.push({ rowNumber: index + 2, raw, canonical: value, changeBeats, preserveOriginal });
  });

  return {
    beatsIndex,
    originalIndex,
    rowsWithBeats,
    rowsWouldChange,
    rowsWithMultipleCanonicalCategories,
    rowsWithoutCanonicalMapping,
    unmappedRawBeats: [...rawCounts].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value)),
    plannedRows,
    googleRowsWouldBeWritten: plannedRows.filter((row) => row.changeBeats || row.preserveOriginal).length
  };
}
