export const CANONICAL_REPORTER_TYPES = [
  { label: "Reporter", value: "reporter" },
  { label: "Influencer", value: "influencer" },
  { label: "Podcast", value: "podcast" },
  { label: "Broadcast TV", value: "broadcast tv" },
  { label: "Tier 1 Media", value: "tier 1 media" }
];

export function addAllowedSelection(options, selected, value) {
  const option = options.find((item) => String(item).toLocaleLowerCase() === String(value ?? "").toLocaleLowerCase());
  if (option === undefined || selected.some((item) => String(item).toLocaleLowerCase() === String(option).toLocaleLowerCase())) return [...selected];
  return [...selected, option];
}

export function removeSelection(selected, value) {
  return selected.filter((item) => String(item).toLocaleLowerCase() !== String(value ?? "").toLocaleLowerCase());
}

export function availableSelections(options, selected) {
  const selectedKeys = new Set(selected.map((item) => String(item).toLocaleLowerCase()));
  return options.filter((option) => !selectedKeys.has(String(option).toLocaleLowerCase()));
}
