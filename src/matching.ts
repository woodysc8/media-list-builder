import type { ClientRecord, ReporterRecord } from "./domain.js";
import { normalizeName } from "./normalize.js";

export interface Match<T> {
  value?: T;
  ambiguous: boolean;
}

export function matchClient(name: string, clients: ClientRecord[]): Match<ClientRecord> {
  const target = normalizeName(name);
  if (!target) return { value: undefined, ambiguous: false };
  const matches = clients.filter((client) => [client.name, ...client.aliases].some((alias) => {
    const normalized = normalizeName(alias);
    if (!normalized) return false;
    return normalized === target || normalized.includes(target) || target.includes(normalized);
  }));
  return { value: matches.length === 1 ? matches[0] : undefined, ambiguous: matches.length > 1 };
}

export function matchReporter(firstName: string, lastName: string, outlet: string, reporters: ReporterRecord[]): Match<ReporterRecord> {
  const first = normalizeName(firstName);
  const last = normalizeName(lastName);
  const publication = normalizeName(outlet);
  const exact = reporters.filter((reporter) => normalizeName(reporter.firstName) === first && normalizeName(reporter.lastName) === last);
  const withOutlet = exact.filter((reporter) => normalizeName(reporter.outlet) === publication);
  if (withOutlet.length === 1) return { value: withOutlet[0], ambiguous: false };
  if (exact.length === 1) return { value: exact[0], ambiguous: false };
  return { value: undefined, ambiguous: exact.length > 1 };
}

export function splitReporterName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts.shift() ?? "", lastName: parts.join(" ") };
}