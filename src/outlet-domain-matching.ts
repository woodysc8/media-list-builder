import type { OutletRecord } from "./domain.js";
import { normalizeName } from "./normalize.js";

const KNOWN_OUTLET_ALIASES = new Map<string, string[]>([
  ["alt goes mainstream", ["alts go mainstream"]]
]);

function compactKey(value: string): string {
  return normalizeName(value).replaceAll(" ", "");
}

function hostFor(link: string): string | null {
  try {
    return new URL(link).hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function variantKeys(outletName: string): string[] {
  const exact = normalizeName(outletName);
  const variants = new Set<string>();
  const add = (value: string) => {
    const key = normalizeName(value);
    if (key && key !== exact) variants.add(key);
  };

  // These are identity-only transformations. They never yield an article URL.
  if (/\.com\s*$/i.test(outletName)) add(outletName.replace(/\.com\s*$/i, ""));
  for (const suffix of ["power your advice", "pro buyer", "magazine", "news", "ria"]) {
    const pattern = new RegExp(`(?:\\s|[-–—])${suffix.replaceAll(" ", "\\s+")}\\s*$`, "i");
    if (pattern.test(outletName)) add(outletName.replace(pattern, ""));
  }
  for (const alias of KNOWN_OUTLET_ALIASES.get(exact) ?? []) add(alias);
  return [...variants];
}

/**
 * Returns only an unambiguous master outlet. Exact normalized identity wins;
 * explicit aliases and suffix variants are considered only when no exact match exists.
 */
export function matchMasterOutlet(outletName: string, outlets: OutletRecord[]): OutletRecord | undefined {
  const byKey = new Map<string, OutletRecord[]>();
  const byCompactKey = new Map<string, OutletRecord[]>();
  for (const outlet of outlets) {
    const key = normalizeName(outlet.name);
    if (!key) continue;
    const matches = byKey.get(key) ?? [];
    matches.push(outlet);
    byKey.set(key, matches);
    const compactMatches = byCompactKey.get(compactKey(outlet.name)) ?? [];
    compactMatches.push(outlet);
    byCompactKey.set(compactKey(outlet.name), compactMatches);
  }
  const exact = byKey.get(normalizeName(outletName)) ?? [];
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;

  const compactExact = byCompactKey.get(compactKey(outletName)) ?? [];
  if (compactExact.length === 1) return compactExact[0];
  if (compactExact.length > 1) return undefined;

  const matches = new Map<string, OutletRecord>();
  for (const key of variantKeys(outletName)) {
    for (const outlet of byKey.get(key) ?? []) matches.set(`${outlet.name}\u0000${outlet.link}`, outlet);
    for (const outlet of byCompactKey.get(compactKey(key)) ?? []) matches.set(`${outlet.name}\u0000${outlet.link}`, outlet);
  }
  return matches.size === 1 ? [...matches.values()][0] : undefined;
}

/** Provides existing resolver domain evidence only; it never constructs an article URL. */
export function expectedOutletDomainsFor(outletName: string, outlets: OutletRecord[]): string[] {
  const outlet = matchMasterOutlet(outletName, outlets);
  const host = outlet ? hostFor(outlet.link) : null;
  return host ? [host] : [];
}
