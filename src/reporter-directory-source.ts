import { isValidMasterReporter, uniqueMasterReporters } from "../public/reporter-identity.js";

export type ReporterSourceKind = "google" | "local";

export interface ReporterSourceDiagnostics {
  kind: ReporterSourceKind;
  label: "Master Directory (Cleaned)" | "Local fallback";
  authoritative: boolean;
  rawReporterRowCount: number;
  validReporterCount: number;
  uniqueValidReporterCount: number;
  fetchedAt: string;
}

export interface ReporterDirectorySnapshot<T> {
  reporters: T[];
  reporterSource: ReporterSourceDiagnostics;
}

export function describeReporterSource<T extends { id?: unknown; firstName?: unknown; lastName?: unknown }>(
  kind: ReporterSourceKind,
  reporters: T[],
  fetchedAt = new Date().toISOString()
): ReporterSourceDiagnostics {
  const valid = reporters.filter(isValidMasterReporter);
  return {
    kind,
    label: kind === "google" ? "Master Directory (Cleaned)" : "Local fallback",
    authoritative: kind === "google",
    rawReporterRowCount: reporters.length,
    validReporterCount: valid.length,
    uniqueValidReporterCount: uniqueMasterReporters(reporters).length,
    fetchedAt
  };
}

/** Select exactly one reporter source. A failed connected Google read propagates; it never falls back silently. */
export async function loadReporterDirectorySnapshot<T extends { id?: unknown; firstName?: unknown; lastName?: unknown }>(
  googleConnected: boolean,
  localReporters: T[],
  loadGoogleReporters: () => Promise<T[]>,
  fetchedAt = new Date().toISOString()
): Promise<ReporterDirectorySnapshot<T>> {
  const kind: ReporterSourceKind = googleConnected ? "google" : "local";
  const reporters = googleConnected ? await loadGoogleReporters() : localReporters;
  return { reporters, reporterSource: describeReporterSource(kind, reporters, fetchedAt) };
}
