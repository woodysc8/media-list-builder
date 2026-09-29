import type { ReporterIdentity, ReporterRecord } from "./domain.js";
import { normalizeName } from "./normalize.js";

export const REPORTER_SHEET_OWNED_FIELDS = [
  "outlet",
  "firstName",
  "lastName",
  "email",
  "reporterType",
  "beats",
  "notes",
  "status"
] as const;

export function reporterIdentityKey(identity: ReporterIdentity): string {
  return [identity.firstName, identity.lastName, identity.outlet].map(normalizeName).join("|");
}

export function hasReporterId(id: string | undefined): boolean {
  return Boolean(String(id ?? "").trim());
}

/** Merge an existing Google row's human-owned values without trusting its system-owned cells. */
export function mergeSheetOwnedReporter(
  local: ReporterRecord,
  sheet: ReporterRecord
): ReporterRecord {
  const previousIdentity: ReporterIdentity = {
    firstName: local.firstName,
    lastName: local.lastName,
    outlet: local.outlet
  };
  const sheetIdentity: ReporterIdentity = {
    firstName: sheet.firstName,
    lastName: sheet.lastName,
    outlet: sheet.outlet
  };
  const aliases = [...(local.identityAliases ?? [])];
  if (reporterIdentityKey(previousIdentity) !== reporterIdentityKey(sheetIdentity) &&
      !aliases.some((alias) => reporterIdentityKey(alias) === reporterIdentityKey(previousIdentity))) {
    aliases.push(previousIdentity);
  }

  return {
    ...local,
    outlet: sheet.outlet,
    firstName: sheet.firstName,
    lastName: sheet.lastName,
    email: sheet.email,
    reporterType: sheet.reporterType,
    beats: sheet.beats,
    notes: sheet.notes,
    status: sheet.status,
    identityAliases: aliases
  };
}
